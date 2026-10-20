/**
 * "Hot stocks" ranking.
 *
 * Input is the compact scan signal produced by `scanSymbols()` — quality score,
 * alert action, buy zone, targets and stop. We keep actionable long setups plus
 * quality names that are still in an uptrend but have no entry trigger yet
 * (the "watch" bucket), decide whether price is already inside the entry band,
 * and score the opportunity so the page can answer two questions per name:
 *
 *   - where do I buy?  (buy zone + the price to wait for)
 *   - where do I sell? (T1/T2/T3 with upside and estimated probability)
 */
import { growthBand, growthProbability } from './growth.js';

export const HOT_ACTIONS = ['buy', 'accumulate'];

/**
 * A hold is still worth showing when the chart is constructive: price above
 * the 50-day, a quality score in the bullish half, and a real long plan. Those
 * are the "good stocks with a chance to go up" that have not triggered yet;
 * dropping them left the board looking empty on quiet days.
 */
export const WATCH_MIN_SCORE = 56;

const isWatchCandidate = (signal = {}) =>
  signal.action === 'hold' &&
  signal.trend === 'up' &&
  Number.isFinite(Number(signal.score)) &&
  Number(signal.score) >= WATCH_MIN_SCORE;

const round = (value, digits = 2) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const BUY_NOW_TOLERANCE_PCT = 0.5; // inside, or within half a percent of, the zone ceiling

export function buildHotStock(signal = {}) {
  const action = signal.action;
  const actionable = HOT_ACTIONS.includes(action);
  if (!actionable && !isWatchCandidate(signal)) return null;

  const price = Number(signal.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const zone = signal.buyZone;
  const zoneLow = Number(zone?.low);
  const zoneHigh = Number(zone?.high);
  if (!Number.isFinite(zoneLow) || !Number.isFinite(zoneHigh) || zoneLow <= 0 || zoneHigh <= 0) return null;

  const distanceToZonePct = round(((price - zoneHigh) / zoneHigh) * 100, 2);
  const belowZone = price < zoneLow;
  // "Buy now" means the price is inside the accumulation band (or within half
  // a percent of its ceiling) AND the engine has an actionable long call. A
  // price far BELOW the band used to pass the old `distance <= tolerance` test,
  // so a name that had fallen through the zone — often through the stop as
  // well — was still advertised as buy-now.
  const inBand = price >= zoneLow && price <= zoneHigh * (1 + BUY_NOW_TOLERANCE_PCT / 100);
  const buyNow = actionable && inBand;

  // Timing matters more than raw quality for a "buy now" board: full marks in
  // the band, partial credit just above it, none once price has fallen out of
  // it (that is a broken setup, not an early entry).
  const timingBonus = buyNow
    ? 15
    : belowZone
      ? 0
      : distanceToZonePct !== null && distanceToZonePct <= 2
        ? 8
        : distanceToZonePct !== null && distanceToZonePct <= 5
          ? 3
          : 0;

  const quality = clamp(Number(signal.score) || 0, 0, 100);
  const conviction = clamp(Number(signal.conviction) || 0, 0, 100);
  const hotScore = clamp(Math.round(quality * 0.6 + conviction * 0.25 + timingBonus), 0, 100);

  const sellPlan = (signal.targets || [])
    .filter((target) => target && target.price !== null && target.price !== undefined && Number(target.price) > 0)
    .slice(0, 3)
    .map((target) => ({
      label: target.label || null,
      price: round(target.price),
      upsidePct: round(target.upsidePct),
      probability:
        target.probability !== null && target.probability !== undefined && Number.isFinite(Number(target.probability))
          ? Math.round(Number(target.probability))
          : null,
      source: target.source || null,
    }));

  // The app's plan engine calls T2 the primary target (R:R is measured to it);
  // T1 is the first trim. Fall back to T1 when only one tier exists.
  const primaryTarget = sellPlan[1] || sellPlan[0] || null;

  // A watch name has no entry signal yet: an in-band price still needs a
  // trigger, and an extended price still waits for the pullback it always did.
  const watch = !actionable;
  const bucket = watch ? 'watch' : buyNow ? 'buy-now' : 'waiting';
  // One comparable "chance to rise" for every row, so the page can rank and
  // filter across the buckets instead of pitting hot scores against each other.
  // A symbol the Focus board already scored carries that exact number, so the
  // same stock never shows two different chances on the two boards.
  const sharedGrowth = signal.growthProbability;
  const sharedValue = sharedGrowth === null || sharedGrowth === undefined || sharedGrowth === '' ? NaN : Number(sharedGrowth);
  const growth = Number.isFinite(sharedValue)
    ? clamp(Math.round(sharedValue), 1, 99)
    : growthProbability({
        targetProbability: primaryTarget?.probability ?? null,
        conviction,
        quality,
        trend: signal.trend ?? null,
      });

  return {
    symbol: signal.symbol,
    name: signal.name,
    quoteType: signal.quoteType,
    price,
    change: signal.change ?? null,
    changePercent: signal.changePercent ?? null,
    score: quality,
    conviction,
    hotScore,
    action,
    actionLabel: signal.actionLabel ?? (action === 'buy' ? 'Buy' : action === 'accumulate' ? 'Accumulate' : 'Hold'),
    setup: signal.setup ?? null,
    setupLabel: signal.setupLabel ?? null,
    rsi: signal.rsi ?? null,
    trend: signal.trend ?? null,
    riskReward: signal.riskReward ?? null,
    sparkline: signal.sparkline || [],
    buyZone: { low: round(zoneLow), high: round(zoneHigh) },
    entryRef: round((zoneLow + zoneHigh) / 2),
    buyNow,
    belowZone,
    watch,
    bucket,
    growthProbability: Number.isFinite(growth) ? growth : null,
    growthBand: signal.growthBand || growthBand(growth),
    // Above the band you wait for the pullback into its ceiling; below it the
    // level to reclaim is the floor, not a ceiling that sits even higher.
    waitFor: buyNow || inBand ? null : belowZone ? round(zoneLow) : round(zoneHigh),
    distanceToZonePct,
    sellPlan,
    primaryTarget,
    stopLoss: round(signal.stopLoss),
    why: buildWhy({ signal, sellPlan }),
  };
}

function buildWhy({ signal, sellPlan }) {
  const parts = [];
  if (signal.setupLabel) parts.push(signal.setupLabel);
  if (Number.isFinite(Number(signal.rsi))) parts.push(`RSI ${round(signal.rsi, 1)}`);
  const headline = sellPlan[1] || sellPlan[0];
  const upside = headline ? round(headline.upsidePct, 1) : null;
  if (headline && upside !== null) parts.push(`${upside}% to ${headline.label || 'primary target'}`);
  return parts.join(' · ');
}

/**
 * Keep actionable longs plus constructive watch names; buy-now names first,
 * then pullback waits, then the watch bucket, each by hot score.
 * Returns every ranked row plus the buckets the page renders.
 */
const BUCKET_RANK = { 'buy-now': 0, waiting: 1, watch: 2 };

export function rankHotStocks(signals = []) {
  const stocks = signals
    .map(buildHotStock)
    .filter(Boolean)
    .sort(
      (a, b) =>
        (BUCKET_RANK[a.bucket] ?? 3) - (BUCKET_RANK[b.bucket] ?? 3) ||
        b.hotScore - a.hotScore ||
        b.score - a.score ||
        String(a.symbol).localeCompare(String(b.symbol)),
    )
    .map((stock, index) => ({ ...stock, rank: index + 1 }));

  return {
    stocks,
    buyNow: stocks.filter((stock) => stock.bucket === 'buy-now'),
    waiting: stocks.filter((stock) => stock.bucket === 'waiting'),
    watch: stocks.filter((stock) => stock.bucket === 'watch'),
  };
}
