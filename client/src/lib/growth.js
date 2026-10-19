/**
 * Client mirror of `server/src/analytics/growth.js`.
 *
 * The API already sends `growthProbability` on every board row; this copy exists
 * so a client-side desk pass — which replaces conviction without a round trip —
 * can re-rank instantly. Keep the weights and the short-side flip in sync with
 * the server module.
 */
export const GROWTH_WEIGHTS = {
  target: 0.45,
  conviction: 0.3,
  quality: 0.15,
  trend: 0.1,
  hitRate: 0.1,
};

const TREND_VALUE = { up: 100, flat: 55, down: 15 };

// Number(null) is 0, so an explicitly absent component must be rejected first.
const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function growthProbability({
  targetProbability = null,
  conviction = null,
  quality = null,
  trend = null,
  hitRate = null,
  direction = 'long',
} = {}) {
  const parts = [];

  const target = num(targetProbability);
  if (target !== null) parts.push([GROWTH_WEIGHTS.target, clamp(target, 0, 100)]);

  const signal = num(conviction);
  if (signal !== null) parts.push([GROWTH_WEIGHTS.conviction, clamp(signal, 0, 100)]);

  const score = num(quality);
  if (score !== null) parts.push([GROWTH_WEIGHTS.quality, clamp(score, 0, 100)]);

  const trendValue = TREND_VALUE[trend];
  if (trendValue !== undefined) parts.push([GROWTH_WEIGHTS.trend, trendValue]);

  const hits = num(hitRate);
  if (hits !== null) parts.push([GROWTH_WEIGHTS.hitRate, clamp(hits, 0, 100)]);

  if (!parts.length) return null;

  const totalWeight = parts.reduce((sum, [weight]) => sum + weight, 0);
  const blended = parts.reduce((sum, [weight, value]) => sum + value * weight, 0) / totalWeight;
  const probability = direction === 'short' ? 100 - blended : blended;
  return Math.round(clamp(probability, 1, 99));
}

export function growthBand(probability) {
  const value = num(probability);
  if (value === null) return null;
  if (value >= 70) return 'high';
  if (value >= 60) return 'good';
  if (value >= 50) return 'moderate';
  return 'low';
}

/**
 * Chance-to-rise for a Hot Stocks row, with the same graceful fallback: the
 * board always sends the field, but a stale cached payload should still rank
 * and filter by a real number instead of treating every name as 0%.
 */
export function chanceOfHotRow(stock) {
  const fromServer = num(stock?.growthProbability);
  if (fromServer !== null) return fromServer;
  return growthProbability({
    targetProbability: stock?.primaryTarget?.probability ?? null,
    conviction: stock?.conviction,
    quality: stock?.score,
    trend: stock?.trend ?? null,
  });
}

/** Options for the "minimum chance" filters on the Focus and Hot Stocks pages. */
export const CHANCE_FILTERS = [
  { value: 0, label: 'Any chance' },
  { value: 50, label: '≥ 50% chance' },
  { value: 60, label: '≥ 60% chance' },
  { value: 70, label: '≥ 70% chance' },
];

/**
 * Chance-to-rise for a board row, falling back to a local computation when a
 * payload does not carry the field (e.g. an older cached response). Pass
 * `preferServer: false` after a desk pass has replaced conviction in place, so
 * the number reflects the model's call instead of the last server response.
 */
export function chanceOfFocusRow(row, { preferServer = true } = {}) {
  const fromServer = preferServer ? num(row?.growthProbability) : null;
  if (fromServer !== null) return fromServer;
  const targets = row?.technical?.targets || [];
  const direction = row?.technical?.direction ?? null;
  return growthProbability({
    targetProbability: targets[1]?.probability ?? targets[0]?.probability ?? null,
    conviction: row?.decision?.conviction,
    quality: row?.technical?.score,
    // Same rule as the server: the live SMA50 trend when present (identical to
    // the Hot Stocks row), otherwise the plan's side. A short plan is flipped
    // to a low chance to rise.
    trend: row?.technical?.trend ?? (direction === 'long' ? 'up' : direction === 'short' ? 'down' : null),
    direction,
    hitRate: row?.archive?.hitRate ?? null,
  });
}
