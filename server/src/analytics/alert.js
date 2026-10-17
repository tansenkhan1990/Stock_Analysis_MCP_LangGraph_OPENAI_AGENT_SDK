/**
 * The alert layer: a regime-aware buy/sell call that is deliberately narrower
 * than the 0–100 quality score.
 *
 * Why it exists: replaying the score bands over five years of the focus
 * universe (see scripts/validate-signals.js) showed that the weighted score
 * has no forward edge — high scores and low scores both drifted with the
 * market. What did survive out-of-sample was one setup:
 *
 *   price above the 200-day, 50-day above the 200-day, RSI at or below 45
 *   → +2.28% over 10 days vs a +1.65% baseline across five years (+1.09pp in
 *     the train half, +0.12pp out-of-sample — thin, but repeatable in 3/4
 *     calendar years).
 *
 * Nothing on the sell side predicted declines in that sample, so a "sell"
 * here is a capital-protection exit (trend break), not a short signal — and it
 * says so in the payload.
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export const ALERT_LABELS = {
  buy: 'Buy',
  accumulate: 'Accumulate',
  hold: 'Hold',
  reduce: 'Reduce',
  sell: 'Sell',
};

const SETUPS = {
  pullback: {
    label: 'Uptrend pullback',
    note: 'Price above the 200-day with the 50-day above it, and RSI washed out — the only setup with a repeatable edge in the five-year replay.',
  },
  continuation: {
    label: 'Trend continuation',
    note: 'Uptrend intact and momentum neutral — a staged entry, not a chase.',
  },
  extended: {
    label: 'Extended uptrend',
    note: 'Uptrend intact but momentum is hot. Hold what you own; wait for a reset instead of adding here.',
  },
  transition: {
    label: 'Mixed / transition',
    note: 'The 50-day and 200-day disagree about the trend. No edge either way — keep size small and honour the stop.',
  },
  breakdown: {
    label: 'Trend break',
    note: 'Price and the 50-day are both below the 200-day. This is an exit for capital protection, not a forecast of further declines.',
  },
};

const STEPS = ['sell', 'reduce', 'hold', 'accumulate', 'buy'];

/** Sort key for the action ladder — buy first, sell last. */
export const ACTION_RANK = { buy: 0, accumulate: 1, hold: 2, reduce: 3, sell: 4 };

/**
 * Classify one symbol. `analysis` is the output of buildAnalysis; news,
 * newsHistory, analyst and event are optional and only ever modulate the call.
 */
export function buildAlert({ analysis, news = null, newsHistory = null, analyst = null, event = null }) {
  const ind = analysis?.indicators || {};
  const price = analysis?.price;
  const sma50 = ind.sma50 ?? null;
  const sma200 = ind.sma200 ?? null;
  const rsi = ind.rsi14 ?? null;
  const adx = ind.adx14 ?? null;
  const volumeRatio = ind.volumeRatio ?? null;

  if (!Number.isFinite(price)) return null;

  const above200 = sma200 !== null ? price > sma200 : null;
  const trendUp = above200 === true && sma50 !== null && sma50 > sma200;
  const trendDown = above200 === false && sma50 !== null && sma50 < sma200;
  const rsiValue = rsi ?? 50;

  // ---- base action from the regime + oscillator -------------------------
  let setup;
  if (trendUp && rsiValue <= 45) setup = 'pullback';
  else if (trendUp && rsiValue <= 58) setup = 'continuation';
  else if (trendUp) setup = 'extended';
  else if (trendDown) setup = 'breakdown';
  else setup = 'transition';

  let action = {
    pullback: 'buy',
    continuation: 'accumulate',
    extended: 'hold',
    transition: 'reduce',
    breakdown: 'sell',
  }[setup];

  const notes = [];
  const earningsDays = Number.isFinite(event?.daysUntil) ? event.daysUntil : null;
  const earningsImminent = earningsDays !== null && earningsDays >= 0 && earningsDays <= 3;
  const newsShock = Boolean(news && news.headlineCount >= 4 && news.sentiment <= -35);
  const newsTailwind = Boolean(
    (news && news.headlineCount >= 4 && news.sentiment >= 35) ||
      (newsHistory && newsHistory.delta7 !== null && newsHistory.delta7 >= 8),
  );

  // ---- guardrails: never open a new long into a known event or a shock ---
  const blockers = [];
  if (earningsImminent) {
    blockers.push(`Earnings in ${earningsDays} day${earningsDays === 1 ? '' : 's'} — wait for the print before sizing in.`);
  }
  if (newsShock) {
    blockers.push(
      `News flow is sharply negative (${news.sentiment} across ${news.headlineCount} headlines) — wait for it to stabilise.`,
    );
  }
  if (blockers.length && (action === 'buy' || action === 'accumulate')) {
    // Each blocker costs a step, but an entry guardrail never manufactures a
    // sell on its own — only a trend break can do that.
    const target = Math.max(2, STEPS.indexOf(action) - blockers.length);
    action = STEPS[target];
    notes.push(...blockers);
  }

  // ---- confidence -------------------------------------------------------
  let confidence = {
    pullback: 64,
    continuation: 55,
    extended: 50,
    transition: 42,
    breakdown: 58,
  }[setup];

  const riskReward = analysis?.plan?.riskReward ?? null;
  if (adx !== null && adx >= 25) confidence += 6;
  if (volumeRatio !== null && volumeRatio >= 1.1) confidence += 4;
  if (riskReward !== null && riskReward >= 2) confidence += 5;
  if (riskReward !== null && riskReward < 1.5) confidence -= 6;
  if (newsTailwind) confidence += 5;
  if (newsShock) confidence -= 10;
  if (earningsImminent) confidence -= 8;
  if (analyst && Math.abs(analyst.tilt || 0) >= 0.4) confidence += analyst.tilt > 0 ? 3 : -4;

  confidence = clamp(Math.round(confidence), 25, 92);

  // ---- narrative --------------------------------------------------------
  const parts = [];
  if (setup === 'pullback') {
    parts.push(
      `Uptrend pullback: price ${round(price)} is above the 200-day (${round(sma200)}) with the 50-day above it, while RSI ${round(rsiValue, 1)} has reset into the buy zone.`,
    );
  } else if (setup === 'continuation') {
    parts.push(
      `Uptrend continuation: price ${round(price)} holds above the 200-day (${round(sma200)}) and RSI ${round(rsiValue, 1)} is neutral. The edge is smaller than a pullback, so scale in.`,
    );
  } else if (setup === 'extended') {
    parts.push(
      `Extended uptrend: price ${round(price)} is above the 200-day but RSI ${round(rsiValue, 1)} is hot. Do not chase — hold and wait for the next reset.`,
    );
  } else if (setup === 'breakdown') {
    parts.push(
      `Trend break: price ${round(price)} and the 50-day (${round(sma50)}) are both below the 200-day (${round(sma200)}). Exit longs on strength; this is risk control, not a short forecast.`,
    );
  } else {
    parts.push(
      `Mixed structure: price ${round(price)} versus the 200-day (${round(sma200)}) and 50-day (${round(sma50)}) disagree. No regime edge — keep size small.`,
    );
  }
  if (news && news.headlineCount) {
    parts.push(`News flow reads ${news.label} (${news.sentiment > 0 ? '+' : ''}${news.sentiment} across ${news.headlineCount} headlines).`);
  }
  if (newsHistory && newsHistory.delta7 !== null) {
    parts.push(`The archived 7-day trend is ${newsHistory.direction} (${newsHistory.delta7 > 0 ? '+' : ''}${newsHistory.delta7} vs the prior week).`);
  }
  parts.push(...notes);

  const invalidations = [];
  if (action === 'buy' || action === 'accumulate') {
    invalidations.push(`A daily close below the stop at ${round(analysis?.plan?.stopLoss)} invalidates the setup.`);
    invalidations.push('Earnings inside the holding window, or two consecutive distribution days, argue for smaller size.');
  } else if (action === 'hold') {
    invalidations.push('A close back above the 20-day average with volume would re-open the entry case.');
    invalidations.push(`Losing ${round(analysis?.plan?.stopLoss)} turns this into an exit.`);
  } else if (action === 'sell' || action === 'reduce') {
    invalidations.push(`A reclaim of the 200-day at ${round(sma200)} on volume would neutralise the exit signal.`);
    invalidations.push('This is a risk rule: in the five-year replay, trend breaks were followed by average returns close to the market, not by systematic declines.');
  }

  return {
    action,
    actionLabel: ALERT_LABELS[action],
    setup,
    setupLabel: SETUPS[setup].label,
    setupNote: SETUPS[setup].note,
    confidence,
    reason: parts.join(' '),
    riskControl: action === 'sell' || action === 'reduce',
    evidence: {
      price: round(price),
      sma50: round(sma50),
      sma200: round(sma200),
      rsi14: round(rsiValue, 1),
      adx14: round(adx, 1),
      volumeRatio: round(volumeRatio, 2),
      riskReward,
      earningsInDays: earningsDays,
      newsSentiment: news?.sentiment ?? null,
      newsTrend: newsHistory?.direction ?? null,
    },
    invalidations,
  };
}

