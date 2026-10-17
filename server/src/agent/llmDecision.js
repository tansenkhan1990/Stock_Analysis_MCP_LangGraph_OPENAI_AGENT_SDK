import { builtinDecision, tradeTriggers } from '../analytics/decision.js';
import { chatWithLLM } from './providers.js';

/**
 * The "desk call": an LLM reads a compact dossier (technicals + news + deals +
 * Street actions + event risk + options pricing) and returns a validated
 * BUY/ACCUMULATE/HOLD/REDUCE/SELL decision as strict JSON.
 */

const SYSTEM_PROMPT = `You are MarketPilot's senior research analyst covering AI/semiconductor mega-caps, mega-cap software and index ETFs. You make a single, decisive swing-trade call (roughly 1-8 weeks) for each dossier you receive.

How to weigh the evidence, in order:
1. PRICE STRUCTURE — the mechanical plan (score, buy zone, targets, stop, reward:risk). This is the backbone; never contradict it without a strong reason.
2. NEWS FLOW AND BUSINESS DEALS — mergers, partnerships, supply contracts, capacity expansion, regulatory/legal events, guidance. Judge whether each item changes earnings power or just sentiment. When newsHistory is present, compare the archived 7-day sentiment with the prior week: a deteriorating trend matters more than one bad headline, and an improving one can offset a soft tape.
3. STREET ACTIVITY — upgrades/downgrades, coverage changes, institutional flow.
4. EVENT RISK — an earnings date inside the horizon means smaller size and lower conviction.
5. OPTIONS PRICING — rich implied volatility favours premium selling (credit spreads); cheap IV favours debits.
6. MECHANICAL ALERT — a regime rule validated on five years of this universe. Treat it as the base case: deviate only when the news, deals or Street data give a specific, quotable reason, and say what that reason is.

Rules:
- Use ONLY numbers present in the dossier. Never invent prices, dates or figures.
- Be decisive but calibrated: mixed evidence means a middle action (accumulate/hold) with lower conviction.
- If the technical score and the news flow disagree, say so explicitly in the thesis and split the difference.
- Conviction must reflect evidence quality: 75+ only when technicals, news and Street all align.
- Prefer defined-risk option structures; never propose naked short options.
- Always return BOTH sides of the tape in triggers: the price that confirms a long and the price that invalidates it. A hold call still needs a sell trigger.
- Output MUST be a single minified JSON object and nothing else. No markdown, no commentary.

Exact schema:
{"action":"buy|accumulate|hold|reduce|sell","conviction":0-100,"horizon":"string","thesis":"2-4 sentences citing specific numbers from the dossier","upsideDrivers":["..."],"downsideRisks":["..."],"catalysts":[{"type":"news|deal|analyst|event","direction":"bullish|bearish|neutral","detail":"..."}],"newsSentiment":-100,"keyLevels":{"entry":0,"target":0,"stop":0},"triggers":{"buyAbove":0,"sellBelow":0},"optionsIdea":{"name":"string","legs":["Buy call 200 @ 5.10"],"maxLoss":0,"probabilityOfProfit":0,"reasoning":"string"},"invalidations":["..."],"whatWouldChangeMyMind":"string"}`;

const clampNumber = (value, min, max, fallback = null) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

/** Prices must be positive and finite — anything else falls back to the plan. */
const priceOr = (value, fallback = null) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0.01) return fallback;
  return Number(number.toFixed(2));
};

const asStringArray = (value, limit = 6) =>
  Array.isArray(value)
    ? value
        .map((item) => (typeof item === 'string' ? item : item?.detail ?? item?.title ?? ''))
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, limit)
    : [];

const ACTIONS = ['buy', 'accumulate', 'hold', 'reduce', 'sell'];

export function normalizeAction(value) {
  const raw = String(value || '').toLowerCase();
  if (ACTIONS.includes(raw)) return raw;
  if (/strong\s*buy|aggressive\s*buy/.test(raw)) return 'buy';
  if (/\bbuy\b|long|overweight/.test(raw)) return 'accumulate';

  return /sell|short|avoid|exit|underweight/.test(raw) ? 'sell' : /reduce|trim|take profit/.test(raw) ? 'reduce' : 'hold';
}

/** Compact, token-efficient research dossier handed to the model. */
export function buildDossier({ symbol, meta, analysis, news, analyst, event, options, newsHistory = null, alert = null }) {
  const plan = analysis.plan;
  return {
    symbol,
    name: meta?.name || analysis.name,
    theme: meta?.theme || analysis.assetClass,
    assetClass: analysis.assetClass,
    price: analysis.price,
    changePercent: analysis.changePercent,
    technical: {
      score: analysis.score.total,
      verdict: analysis.signalLabel,
      confidence: analysis.score.confidence,
      direction: plan.direction,
      entry: plan.entryRef,
      buyZone: plan.buyZone,
      shortZone: plan.shortZone,
      targets: plan.targets.map((target) => ({
        label: target.label,
        price: target.price,
        upsidePct: target.upsidePct,
        source: target.source,
        probability: target.probability,
      })),
      stopLoss: plan.stopLoss,
      riskReward: plan.riskReward,
      horizon: plan.horizon,
      invalidation: plan.invalidation,
      triggers: tradeTriggers({ analysis }),
      checklist: analysis.checklist.map((item) => ({ item: item.label, pass: item.passed })),
      scoreComponents: analysis.score.components.map((component) => ({
        area: component.label,
        score: Math.round(component.score),
      })),
    },
    indicators: {
      rsi14: analysis.indicators.rsi14,
      macdHistogram: analysis.indicators.macdHistogram,
      adx14: analysis.indicators.adx14,
      atrPct: analysis.indicators.atrPct,
      volumeRatio: analysis.indicators.volumeRatio,
      annualizedVolatility: analysis.indicators.annualizedVolatility,
      maxDrawdown: analysis.indicators.maxDrawdown,
      rangePosition: analysis.levels.rangePosition,
    },
    performance: analysis.performance,
    valuation: analysis.fundamentals
      ? {
          sector: analysis.fundamentals.sector,
          trailingPE: analysis.fundamentals.trailingPE,
          forwardPE: analysis.fundamentals.forwardPE,
          pegRatio: analysis.fundamentals.pegRatio,
          revenueGrowth: analysis.fundamentals.revenueGrowth,
          earningsGrowth: analysis.fundamentals.earningsGrowth,
          profitMargin: analysis.fundamentals.profitMargin,
          analystTarget: analysis.fundamentals.analystTarget,
          recommendationMean: analysis.fundamentals.recommendationMean,
          expenseRatio: analysis.fundamentals.expenseRatio ?? null,
        }
      : null,
    street: analyst
      ? {
          window: analyst.window,
          tilt: analyst.tilt,
          upgrades: analyst.upgrades,
          downgrades: analyst.downgrades,
          latest: analyst.latest.slice(0, 5),
          coverage: analysis.fundamentals?.recommendationTrend || null,
        }
      : null,
    event: event || null,
    mechanicalAlert: alert
      ? {
          action: alert.action,
          setup: alert.setup,
          setupLabel: alert.setupLabel,
          confidence: alert.confidence,
          reason: alert.reason,
          invalidations: alert.invalidations,
          evidence: alert.evidence,
        }
      : null,
    newsHistory: newsHistory
      ? {
          coverageDays: newsHistory.coverageDays,
          sentiment7: newsHistory.sentiment7,
          sentimentPrior7: newsHistory.sentimentPrior7,
          delta7: newsHistory.delta7,
          direction: newsHistory.direction,
          deals30d: newsHistory.deals30d,
          headlines30d: newsHistory.headlines30d,
        }
      : null,
    news: news
      ? {
          sentiment: news.sentiment,
          label: news.label,
          headlineCount: news.headlineCount,
          counts: news.counts,
          catalysts: news.catalysts.slice(0, 6),
          deals: news.deals.slice(0, 4),
          bearishItems: news.risks.slice(0, 3),
          headlines: news.headlines.slice(0, 8).map((item) => ({
            title: item.title,
            direction: item.direction,
            tags: item.tags,
            publishedAt: item.publishedAt,
          })),
          articleExcerpts: (news.excerpts || []).map((item) => ({
            title: item.title,
            text: item.content.slice(0, 1200),
          })),
        }
      : null,
    options: options?.summary
      ? {
          expiration: options.expiration,
          dte: options.summary.dte,
          atmIv: options.summary.atmIv,
          ivState: options.summary.ivState,
          ivPremium: options.summary.ivPremium,
          expectedMovePct: options.summary.expectedMovePct,
          maxPain: options.summary.maxPain,
          pcrOi: options.summary.pcrOi,
          plans: (options.plans || []).map((optionPlan) => ({
            name: optionPlan.name,
            legs: optionPlan.legs.map((leg) => `${leg.action} ${leg.kind} ${leg.strike} @ ${leg.premium}`),
            isCredit: optionPlan.metrics.isCredit,
            maxProfit: optionPlan.metrics.maxProfitUnbounded ? 'unbounded' : optionPlan.metrics.maxProfit,
            maxLoss: Math.abs(optionPlan.metrics.maxLoss),
            breakevens: optionPlan.metrics.breakevens,
            probabilityOfProfit: optionPlan.metrics.probabilityOfProfit,
          })),
        }
      : null,
    flow: analysis.fundamentals?.institutionTop?.slice(0, 3) || null,
  };
}

/** Pull the JSON object out of a model response, tolerating fences/prose. */
export function parseDecisionJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Force the model output into the contract, filling gaps from the rule engine. */
export function normalizeDecision(parsed, fallback, context = {}) {
  const round = (value, digits = 2) =>
    typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
  const price = Number(context.price);
  const hasPrice = Number.isFinite(price) && price > 0;
  const action = normalizeAction(parsed.action);
  const label = fallback?.actionLabel && action === fallback.action ? fallback.actionLabel : action.charAt(0).toUpperCase() + action.slice(1);
  const levels = parsed.keyLevels || {};

  return {
    action,
    actionLabel: label,
    conviction: clampNumber(parsed.conviction, 20, 99, fallback?.conviction ?? 50),
    horizon: typeof parsed.horizon === 'string' && parsed.horizon.trim() ? parsed.horizon.trim().slice(0, 80) : fallback?.horizon,
    thesis:
      typeof parsed.thesis === 'string' && parsed.thesis.trim().length > 40
        ? parsed.thesis.trim().slice(0, 1200)
        : fallback?.thesis,
    upsideDrivers: asStringArray(parsed.upsideDrivers, 5).length
      ? asStringArray(parsed.upsideDrivers, 5)
      : fallback?.upsideDrivers ?? [],
    downsideRisks: asStringArray(parsed.downsideRisks, 5).length
      ? asStringArray(parsed.downsideRisks, 5)
      : fallback?.downsideRisks ?? [],
    catalysts: Array.isArray(parsed.catalysts) && parsed.catalysts.length
      ? parsed.catalysts
          .map((item) => ({
            type: ['news', 'deal', 'analyst', 'event'].includes(item?.type) ? item.type : 'news',
            direction: ['bullish', 'bearish', 'neutral'].includes(item?.direction) ? item.direction : 'neutral',
            detail: String(item?.detail || '').trim().slice(0, 300),
          }))
          .filter((item) => item.detail)
          .slice(0, 8)
      : fallback?.catalysts ?? [],
    newsSentiment: clampNumber(parsed.newsSentiment, -100, 100, fallback?.newsSentiment ?? 0),
    keyLevels: {
      entry: priceOr(levels.entry, fallback?.keyLevels?.entry ?? null),
      target: priceOr(levels.target, fallback?.keyLevels?.target ?? null),
      stop: priceOr(levels.stop, fallback?.keyLevels?.stop ?? null),
    },
    triggers: buildTriggers(parsed, fallback, {
      price: hasPrice ? price : null,
      round,
      buyZone: context.buyZone ?? null,
    }),
    optionsIdea: parsed.optionsIdea
      ? {
          name: String(parsed.optionsIdea.name || 'Defined-risk structure').slice(0, 120),
          expiration: parsed.optionsIdea.expiration || fallback?.optionsIdea?.expiration || null,
          legs: asStringArray(parsed.optionsIdea.legs, 6),
          maxLoss: clampNumber(parsed.optionsIdea.maxLoss, 0, 1e9, null),
          probabilityOfProfit: clampNumber(parsed.optionsIdea.probabilityOfProfit, 0, 100, null),
          reasoning: String(parsed.optionsIdea.reasoning || '').slice(0, 500),
        }
      : fallback?.optionsIdea ?? null,
    invalidations: asStringArray(parsed.invalidations, 4).length
      ? asStringArray(parsed.invalidations, 4)
      : fallback?.invalidations ?? [],
    whatWouldChangeMyMind:
      typeof parsed.whatWouldChangeMyMind === 'string' && parsed.whatWouldChangeMyMind.trim()
        ? parsed.whatWouldChangeMyMind.trim().slice(0, 600)
        : fallback?.whatWouldChangeMyMind,
    newsSentimentLabel: fallback?.newsSentimentLabel ?? null,
    generatedBy: 'llm',
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Merge the model's trigger prices into the rule-engine triggers, but only when
 * they land on the correct side of spot: a "buy above" level belongs at or
 * above spot, and an exit cannot sit inside the accumulation range — either one
 * would print a level that contradicts its own label. Stale notes and distances
 * are rebuilt so the card never shows a level and a description that disagree.
 */
function buildTriggers(parsed, fallback, { price, round, buyZone = null }) {
  const base = fallback?.triggers ? { ...fallback.triggers } : null;
  if (!base) return null;

  const buyOverride = priceOr(parsed.triggers?.buyAbove);
  const sellOverride = priceOr(parsed.triggers?.sellBelow);
  const zoneFloor = Number.isFinite(buyZone?.low) ? buyZone.low : null;
  const targetBelow = Number.isFinite(base.firstTarget) ? base.firstTarget : null;
  const buyValid = buyOverride !== null && (!price || buyOverride >= price);
  // A long's lower level is an exit (must clear the buy band); a short's is the
  // breakdown entry, which must stay above the first target it plans to take.
  const sellValid =
    sellOverride !== null &&
    (!price || sellOverride < price) &&
    (base.side === 'short'
      ? targetBelow === null || sellOverride > targetBelow
      : zoneFloor === null || sellOverride <= zoneFloor);

  if (buyValid) {
    base.buyAbove = buyOverride;
    base.buyNote = base.inBuyZone
      ? `LLM trigger: hold above ${buyOverride} (price is already in the buy zone)`
      : `LLM trigger: long above ${buyOverride}`;
  }
  if (sellValid) {
    base.sellBelow = sellOverride;
    // A moved exit level can stop being the planned stop, so the "this is a
    // protective stop, not a target" wording is re-derived instead of inherited.
    base.exitIsStop = round(base.sellBelow) === round(base.stop);
    base.sellLabel = base.side === 'short' ? 'BREAKDOWN BELOW' : 'EXIT BELOW';
    base.sellHint =
      base.side === 'short'
        ? `A close below this confirms the downtrend; the call is an exit, not a short recommendation. Profit targets (T1 ${base.firstTarget ?? '—'}) sit below it, stop above ${base.stop}`
        : base.exitIsStop
          ? 'Protective stop-loss exit, not a sell target — the profit targets are above spot'
          : 'Exit on weakness, not a sell target — the profit targets are above spot';
    base.sellNote =
      base.side === 'short'
        ? `LLM trigger: breakdown below ${sellOverride} — a close above ${base.stop} cancels the bearish read`
        : base.exitIsStop
          ? `LLM trigger: exit below ${sellOverride} (the planned stop)`
          : `LLM trigger: exit below ${sellOverride} — hard stop ${base.stop}`;
  }
  if (price) {
    base.distanceToBuyPct = round(((base.buyAbove - price) / price) * 100, 2);
    base.distanceToSellPct = round(((base.sellBelow - price) / price) * 100, 2);
  }
  return base;
}

/**
 * Ask the configured LLM for a decision. Throws on provider failure or
 * unparseable output so the caller can fall back to the rule engine.
 */
export async function decideWithLLM({ dossier, fallback }) {
  const started = Date.now();
  const result = await chatWithLLM({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Research dossier:\n${JSON.stringify(dossier)}` },
    ],
    tools: [],
  });
  const parsed = parseDecisionJson(result.content);
  if (!parsed) throw new Error('The model did not return parseable JSON');
  const decision = normalizeDecision(parsed, fallback, {
    price: Number(dossier?.price),
    buyZone: dossier?.technical?.buyZone ?? null,
  });
  decision.alertAction = fallback?.alert?.action ?? null;
  decision.alertActionLabel = fallback?.actionLabel ?? null;
  decision.alertSetup = fallback?.alert?.setupLabel ?? null;
  decision.alertDisagrees = Boolean(decision.alertAction && decision.action !== decision.alertAction);
  return {
    decision,
    latencyMs: Date.now() - started,
    usage: result.usage,
  };
}

export function ruleBasedDecision(input) {
  return builtinDecision(input);
}

export const _internals = { SYSTEM_PROMPT, asStringArray, clampNumber };
