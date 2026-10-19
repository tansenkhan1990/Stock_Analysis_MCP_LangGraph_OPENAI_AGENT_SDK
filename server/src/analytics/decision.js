import { ALERT_LABELS, buildAlert } from './alert.js';
import { applyHistoryToDecision, archiveTrend } from './history.js';

/**
 * Decision layer: fuses the technical plan with news flow, business deals,
 * Street actions and event risk into one BUY / ACCUMULATE / HOLD / REDUCE /
 * SELL call. Runs with no LLM (deterministic) and is also used as the
 * fallback and cross-check when an LLM provider is configured.
 *
 * The action itself comes from the measured regime rule in alert.js; the fused
 * score below is a quality/context number and deliberately does not map onto
 * an action any more — the score bands were tested and showed no forward edge.
 */
const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/** Earnings event risk from the fundamentals payload. */
export function eventRisk(fundamentals) {
  const earningsDate = fundamentals?.earningsDate ? new Date(fundamentals.earningsDate) : null;
  if (!earningsDate || Number.isNaN(earningsDate.getTime())) {
    return { hasEarnings: false, daysUntil: null, date: null, label: 'No scheduled earnings on file' };
  }
  const daysUntil = Math.ceil((earningsDate.getTime() - Date.now()) / 86_400_000);
  const upcoming = daysUntil >= 0 && daysUntil <= 14;
  return {
    hasEarnings: upcoming,
    daysUntil,
    date: earningsDate.toISOString().slice(0, 10),
    label:
      daysUntil < 0
        ? `Last reported ${Math.abs(daysUntil)} days ago`
        : upcoming
          ? `Earnings in ${daysUntil} day${daysUntil === 1 ? '' : 's'} (${earningsDate.toISOString().slice(0, 10)})`
          : `Next earnings ${earningsDate.toISOString().slice(0, 10)}`,
  };
}

/**
 * Explicit two-sided triggers. Traders want both sides of the tape even when the
 * headline call is "hold": the price that confirms a long, and the price that
 * says get out / flip short.
 */
export function tradeTriggers({ analysis }) {
  const price = analysis?.price;
  const plan = analysis?.plan;
  if (!Number.isFinite(price) || !plan) return null;

  const atr = analysis.indicators?.atr14 || price * 0.02;
  const supports = (analysis.levels?.supports || []).map((item) => item.price).filter(Number.isFinite);
  const resistances = (analysis.levels?.resistances || []).map((item) => item.price).filter(Number.isFinite);

  const supportBelow = supports.filter((level) => level < price * 0.999).sort((a, b) => b - a)[0] ?? null;
  const resistanceAbove = resistances.filter((level) => level > price * 1.001).sort((a, b) => a - b)[0] ?? null;

  // A long confirms ABOVE spot. Inside the zone that is the ceiling; when price
  // has run away from the zone the trigger is a breakout, capped at ~1.5 ATR so
  // it stays actionable instead of miles away at some stale resistance.
  const inBuyZone = Boolean(plan.buyZone && price >= plan.buyZone.low && price <= plan.buyZone.high);
  const extendedAboveZone = Boolean(plan.buyZone && price > plan.buyZone.high);
  const breakout = Math.min(resistanceAbove ?? price + atr * 0.6, price + atr * 1.5);
  const buyAbove = round(
    inBuyZone ? Math.max(plan.buyZone.high, price * 1.0005) : Math.max(breakout, price * 1.001),
  );

  const side = plan.direction || 'long';

  // The lower trigger has two different jobs, and conflating them printed a
  // losing trade on the card:
  //  - on a long it is the EXIT (a protective stop below the buy band), so a
  //    long card legitimately shows a "sell" price under its buy price;
  //  - on a short it is the ENTRY (a breakdown trigger), and that entry must
  //    sit ABOVE the first profit target — otherwise the card says "short at
  //    374.69" next to "target 376.24", i.e. sell below your own target.
  const hardStop = plan.stopLoss < price ? plan.stopLoss : price - atr * 1.2;
  // On the long side the exit must also sit clear of the whole accumulation
  // range. A support break at or inside that range is not an exit: it would
  // print "sell below" at a price the card still tells you to buy (the range
  // floor is itself built from the nearest support), which reads as selling
  // under your own entry. In that case the planned stop — always below the
  // range — is the exit level.
  const zoneFloor = Number.isFinite(plan.buyZone?.low) ? plan.buyZone.low : null;
  const supportUsable =
    supportBelow !== null && supportBelow > price * 0.9 && (zoneFloor === null || supportBelow < zoneFloor);
  const supportTrigger = supportUsable ? supportBelow : hardStop;
  const exitLevel = Math.min(price * 0.999, Math.max(supportTrigger, hardStop));

  // The nearest short target (T1) is the highest of the downside targets. A
  // breakdown entry halfway between spot and T1 leaves room to T1 while staying
  // close enough to be actionable; the buffer stops the two from converging.
  const firstTarget = (plan.targets || [])
    .map((target) => target?.price)
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] ?? null;
  const buffer = Math.max(atr * 0.15, price * 0.002);
  const targetRoom = firstTarget !== null && firstTarget < price ? price - firstTarget : null;
  const shortEntry =
    targetRoom !== null ? Math.max(firstTarget + buffer, price - targetRoom * 0.5) : price * 0.999;

  const sellBelow = round(side === 'short' ? Math.min(price * 0.999, shortEntry) : exitLevel);
  const exitIsStop = side !== 'short' && sellBelow === round(plan.stopLoss);
  const sellSource =
    side === 'short'
      ? firstTarget !== null && sellBelow > firstTarget
        ? ' (above T1)'
        : ''
      : exitIsStop
        ? ' (the planned stop)'
        : supportUsable && sellBelow === round(supportBelow)
          ? ' (support break)'
          : '';

  const inSellZone = Boolean(plan.shortZone && price >= plan.shortZone.low && price <= plan.shortZone.high);
  const trimAbove = plan.shortZone && plan.shortZone.low > price ? round(plan.shortZone.low) : null;

  // Labels are part of the contract, not cosmetics. Printing a long's
  // protective stop as "sell below" made the card read as "buy here, sell
  // lower" — a guaranteed loss — when the number is the exit that caps the
  // loss. The two sides are named by what they do to the position.
  // The call matters too: on a Reduce/Sell card the upper level is not an
  // entry, it is the price that would cancel the exit call.
  const callAction = analysis?.alert?.action ?? null;
  const exitCall = callAction === 'reduce' || callAction === 'sell';
  const buyLabel = side === 'short' ? 'STOP ABOVE' : exitCall ? 'RECLAIM ABOVE' : 'BUY ABOVE';
  const sellLabel = side === 'short' ? 'BREAKDOWN BELOW' : 'EXIT BELOW';
  const buyHint =
    side === 'short'
      ? `A close above this level cancels the bearish setup — an early stop, not a target (hard stop ${round(plan.stopLoss)})`
      : exitCall
        ? 'A close back above this level would cancel the exit call — it is not a buy signal today'
        : inBuyZone
          ? 'Breakout confirmation above the buy zone'
          : 'Long confirmation: this price must print before the long is triggered';
  const sellHint =
    side === 'short'
      ? `A close below this confirms the downtrend; the call is an exit, not a short recommendation. Profit targets (T1 ${round(firstTarget)}) sit below it, stop above ${round(plan.stopLoss)}`
      : exitIsStop
        ? 'Protective stop-loss exit, not a sell target — the profit targets are above spot'
        : 'Exit on weakness, not a sell target — the profit targets are above spot';

  return {
    buyAbove,
    sellBelow,
    buyLabel,
    sellLabel,
    buyHint,
    sellHint,
    trimAbove,
    side,
    // The nearest downside target. Only a short has one below spot, and there
    // it also bounds the entry: the breakdown level must sit above it or the
    // trade has no reward left.
    firstTarget: side === 'short' ? round(firstTarget) : null,
    stop: round(plan.stopLoss),
    inBuyZone,
    extendedAboveZone,
    inSellZone,
    // True when the exit level IS the planned stop (no earlier support break),
    // so surfaces can word the line as a stop rather than a signal.
    exitIsStop,
    // The note must describe the level actually returned: while price sits
    // inside the zone, `buyAbove` is the breakout confirmation (not the zone
    // floor), so buying at spot is valid and no breakout is required.
    buyNote: inBuyZone
      ? `Price is already inside the ${round(plan.buyZone.low)}–${round(plan.buyZone.high)} buy zone — accumulate here; a break above ${buyAbove} would confirm strength`
      : extendedAboveZone
        ? `Extended above the ${round(plan.buyZone.low)}–${round(plan.buyZone.high)} buy zone — break above ${buyAbove} or wait for a pullback into the zone`
        : `Long trigger: reclaim / break above ${buyAbove}${resistanceAbove ? ' (nearest resistance)' : ' (ATR breakout)'}`,
    sellNote: inSellZone
      ? side === 'short'
        ? `Price is inside the ${round(plan.shortZone.low)}–${round(plan.shortZone.high)} supply zone — trim into strength; a close below ${sellBelow} confirms the weakness, and a close above ${round(plan.stopLoss)} cancels the bearish read`
        : `Trim into ${round(plan.shortZone.low)}–${round(plan.shortZone.high)}; exit on a close below ${sellBelow} — hard stop ${round(plan.stopLoss)}`
      : side === 'short'
        ? `A close below ${sellBelow}${sellSource} confirms the breakdown — first downside level ${round(firstTarget)}, and a close above ${round(plan.stopLoss)} cancels the bearish read`
        : `Exit trigger: a close below ${sellBelow}${sellSource}${exitIsStop ? '' : ` — hard stop ${round(plan.stopLoss)}`}`,
    // True when the "sell" side is the exit for a long (below the entry band),
    // not a breakdown entry for a short — the two read very differently, so
    // every surface labels them apart.
    exitSide: side !== 'short',
    distanceToBuyPct: round(((buyAbove - price) / price) * 100, 2),
    distanceToSellPct: round(((sellBelow - price) / price) * 100, 2),
  };
}

/**
 * Fuse every evidence stream into a single 0–100 quality score.
 * Weights: technical 50%, news flow 20%, Street activity 15%, catalysts 15%.
 * Quality ranks candidates; it never sets the action (see alert.js).
 */
export function combinedSignal({ analysis, news, analyst, event }) {
  const technical = analysis?.score?.total ?? 50;
  const newsSentiment = news?.sentiment ?? 0;
  const analystTilt = analyst?.tilt ?? 0;

  const dealScores = (news?.deals || []).map((deal) => deal.score ?? 0);
  const catalystScores = (news?.catalysts || []).map((item) => item.score ?? 0);
  const dealEffect = clamp(dealScores.reduce((acc, value) => acc + value, 0) / 20, -25, 25);
  const catalystEffect = clamp(
    catalystScores.reduce((acc, value) => acc + value, 0) / (catalystScores.length || 1) / 4,
    -18,
    18,
  );
  const catalystScore = clamp(50 + dealEffect + catalystEffect);
  // Shrink the news read toward neutral when only a couple of headlines exist:
  // one dramatic word should not carry 20% of the signal on its own.
  const headlineCount = news?.headlineCount ?? 0;
  const newsConfidence = headlineCount ? headlineCount / (headlineCount + 3) : 0;
  const newsScore = clamp(50 + (newsSentiment / 2) * newsConfidence);
  const streetScore = clamp(50 + analystTilt * 40);

  const components = [
    {
      key: 'technical',
      label: 'Price structure & plan',
      weight: 0.5,
      score: technical,
      detail: `${analysis?.signalLabel ?? 'n/a'} · score ${technical}/100`,
    },
    {
      key: 'news',
      label: 'News flow',
      weight: 0.2,
      score: newsScore,
      detail:
        headlineCount > 0
          ? `${news.label} (${newsSentiment > 0 ? '+' : ''}${newsSentiment}) across ${headlineCount} headlines${headlineCount < 4 ? ' — thin sample, damped' : ''}`
          : 'No recent headlines',
    },
    {
      key: 'street',
      label: 'Street activity',
      weight: 0.15,
      score: streetScore,
      detail: analyst?.total
        ? `${analyst.upgrades} upgrades / ${analyst.downgrades} downgrades in ${analyst.window}`
        : 'No analyst actions in window',
    },
    {
      key: 'catalysts',
      label: 'Deals & catalysts',
      weight: 0.15,
      score: catalystScore,
      detail: news?.deals?.length
        ? `${news.deals.length} business-deal headline${news.deals.length === 1 ? '' : 's'} tracked`
        : 'No deal headlines tracked',
    },
  ];

  const score = Math.round(components.reduce((acc, item) => acc + item.score * item.weight, 0));

  const headlineBonus = (news?.headlineCount ?? 0) >= 6 ? 5 : 0;
  const eventPenalty = event?.hasEarnings ? 8 : 0;
  const conviction = clamp(
    Math.round(30 + Math.abs(score - 50) * 1.15 + headlineBonus + Math.abs(analystTilt) * 8 - eventPenalty),
    30,
    95,
  );

  return {
    score,
    conviction,
    version: 'rules',
    components,
    newsSentiment,
    analystTilt: round(analystTilt, 2),
    headlineCount: news?.headlineCount ?? 0,
    dealCount: news?.deals?.length ?? 0,
    event: event || null,
  };
}

/**
 * The options expression must agree with the alert: never hand a "sell" name
 * a bull put spread just because the mechanical plan still points long.
 */
export function pickPlanForAction(plans = [], action = 'hold') {
  const wanted = action === 'sell' || action === 'reduce' ? 'bearish' : 'bullish';
  return (plans || []).find((plan) => plan.bias === wanted) || null;
}

const actionPhrase = {
  buy: 'a full-size long',
  accumulate: 'a staged long',
  hold: 'no new exposure',
  reduce: 'trimming into strength',
  sell: 'exiting long exposure',
};

/** Deterministic decision used when no LLM is configured (and as a safety net). */
export function builtinDecision({
  symbol,
  meta,
  analysis,
  news,
  newsHistory = null,
  marketHistory = null,
  analyst,
  event,
  options,
  signal,
}) {
  const combined = signal || combinedSignal({ analysis, news, analyst, event });
  const alert = buildAlert({ analysis, news, newsHistory, analyst, event });
  const plan = analysis.plan;
  const levels = analysis.indicators;
  // No alert means no usable price/structure, so there is nothing to act on.
  const action = alert?.action ?? 'hold';

  // The archive (daily MongoDB snapshots) does not move the levels — live data
  // owns those — it decides how much conviction the live call deserves: a
  // confirmed streak earns, a first-day flip or a history of failed calls costs.
  const archive = applyHistoryToDecision({
    action,
    conviction: alert?.confidence ?? combined.conviction,
    history: marketHistory,
  });

  const bullishCatalysts = (news?.catalysts || []).filter((item) => item.direction === 'bullish').slice(0, 3);
  const bearishCatalysts = (news?.catalysts || []).filter((item) => item.direction === 'bearish').slice(0, 3);

  const upsideDrivers = [
    `Technical structure: score ${analysis.score.total}/100 with ${analysis.score.confidence}% confidence (RSI ${levels.rsi14 ?? '—'}, ADX ${levels.adx14 ?? '—'}).`,
    ...bullishCatalysts.map((item) => `${item.title}${item.tags?.length ? ` [${item.tags.join(', ')}]` : ''}`),
    ...(news?.deals || []).slice(0, 2).map((deal) => `Business deal: ${deal.title}`),
    ...(analyst?.latest || [])
      .filter((entry) => entry.score > 0)
      .slice(0, 1)
      .map((entry) => `${entry.firm} ${entry.action || 'moved'} to ${entry.toGrade} (${entry.date})`),
  ].slice(0, 5);

  const downsideRisks = [
    ...analysis.risks,
    ...archive.risks,
    ...bearishCatalysts.map((item) => `${item.title}${item.tags?.length ? ` [${item.tags.join(', ')}]` : ''}`),
    ...(analyst?.latest || [])
      .filter((entry) => entry.score < 0)
      .slice(0, 1)
      .map((entry) => `${entry.firm} cut to ${entry.toGrade} (${entry.date})`),
    combined.event?.hasEarnings ? `${combined.event.label} — event risk can invalidate technical levels` : null,
  ]
    .filter(Boolean)
    .slice(0, 5);

  const catalysts = [
    ...(news?.catalysts || []).slice(0, 4).map((item) => ({
      type: item.tags?.includes('Business deal') ? 'deal' : 'news',
      direction: item.direction,
      detail: item.title,
    })),
    ...(analyst?.latest || []).slice(0, 2).map((entry) => ({
      type: 'analyst',
      direction: entry.score > 0 ? 'bullish' : entry.score < 0 ? 'bearish' : 'neutral',
      detail: `${entry.firm} ${entry.action || ''} ${entry.fromGrade || ''} → ${entry.toGrade || ''} (${entry.date})`.replace(/\s+/g, ' '),
    })),
    combined.event?.hasEarnings
      ? { type: 'event', direction: 'neutral', detail: combined.event.label }
      : null,
  ].filter(Boolean);

  const entry = plan.entryRef ?? analysis.price;
  const target = plan.targets?.[1]?.price ?? plan.targets?.[0]?.price ?? null;
  const triggers = tradeTriggers({ analysis });
  const bestPlan = pickPlanForAction(options?.plans, action);
  // The level that would flip a bearish call is above spot (the short stop),
  // not one of its downside targets.
  const reversalLevel =
    plan.direction === 'short' ? plan.stopLoss : plan.targets?.[0]?.price ?? analysis.price;

  return {
    action,
    actionLabel: alert?.actionLabel ?? ALERT_LABELS.hold,
    conviction: archive.conviction,
    engineConviction: alert?.confidence ?? combined.conviction,
    convictionDelta: archive.delta,
    history: archive.summary,
    historyNotes: archive.notes,
    archive: marketHistory ? archiveTrend(marketHistory, { action }) : null,
    dataSources: { live: 'yahoo-finance', archive: archive.summary ? 'mongodb-daily-snapshots' : null },
    setup: alert?.setup ?? null,
    setupLabel: alert?.setupLabel ?? null,
    setupNote: alert?.setupNote ?? null,
    alert,
    horizon: plan.horizon,
    thesis: `${alert?.reason ? `${alert.reason} ` : ''}Fused quality is ${combined.score}/100 with a Street tilt of ${combined.analystTilt} from ${analyst?.upgrades ?? 0} upgrades / ${analyst?.downgrades ?? 0} downgrades. That mix supports ${actionPhrase[action]} around ${round(entry)} with a ${round(plan.stopLoss)} stop${target ? ` and ${round(target)} as the main target (T2)` : ''}.${archive.notes.length ? ` ${archive.notes.join(' ')}` : ''}`,
    upsideDrivers,
    downsideRisks,
    catalysts,
    newsSentiment: combined.newsSentiment,
    keyLevels: { entry: round(entry), target: round(target), stop: round(plan.stopLoss) },
    triggers,
    optionsIdea: bestPlan
      ? {
          name: bestPlan.name,
          expiration: bestPlan.expiration,
          legs: bestPlan.legs.map((leg) =>
            `${leg.action === 'buy' ? 'Buy' : 'Sell'} ${leg.kind} ${leg.strike} @ ${leg.premium}`.trim(),
          ),
          maxLoss: Math.abs(bestPlan.metrics.maxLoss),
          probabilityOfProfit: bestPlan.metrics.probabilityOfProfit,
          reasoning: bestPlan.thesis,
        }
      : null,
    invalidations: [
      plan.invalidation,
      'Headline flow flipping decisively negative (lawsuits, guidance cuts, downgrades) would downgrade the call.',
      combined.event?.hasEarnings
        ? `A pre-earnings run-up followed by a guidance miss would break the thesis (${combined.event.label}).`
        : null,
    ].filter(Boolean),
    whatWouldChangeMyMind:
      action === 'buy' || action === 'accumulate'
        ? `Two consecutive closes below ${round(plan.stopLoss)} or a bearish guidance update would move this to Hold/Reduce.`
        : `A close above ${round(reversalLevel)} on expanding volume with positive news flow would upgrade this to Accumulate.`,
    newsSentimentLabel: news?.label || 'no data',
    engineUsedArchive: Boolean(archive.summary),
    generatedBy: 'rule-engine',
    generatedAt: new Date().toISOString(),
  };
}
