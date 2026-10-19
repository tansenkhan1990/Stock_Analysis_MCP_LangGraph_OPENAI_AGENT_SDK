/**
 * "Chance to rise" — one comparable 1-99 number for every scored name.
 *
 * The board surfaces each carry different evidence (target probability,
 * conviction, quality score, trend, archive follow-through). Ranking by any
 * single field is misleading: a high quality score with a broken trend is not a
 * better riser than a 78-quality name sitting in its buy band. This scorer
 * blends what is available, renormalizes over the components that are present,
 * and flips for short-side plans so a working bearish call never reads as a
 * growth candidate.
 *
 * The client mirrors this formula in `client/src/lib/growth.js` so a desk pass
 * can re-sort instantly; keep the two in sync.
 */
export const GROWTH_WEIGHTS = {
  /** Probability the plan's primary target is reached. */
  target: 0.45,
  /** Fused signal conviction (0-100). */
  conviction: 0.3,
  /** Technical quality score (0-100). */
  quality: 0.15,
  /** Trend direction, folded in as a 0-100 value. */
  trend: 0.1,
  /** How often this name's previous calls followed through (archive). */
  hitRate: 0.1,
};

const TREND_VALUE = { up: 100, flat: 55, down: 15 };

// Number(null) is 0, so an explicitly absent component must be rejected before
// the numeric coercion or it would count as a real, terrible reading.
const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Weighted chance the name rises over the plan's horizon.
 * Returns null when no component is available, and 1-99 otherwise so the UI
 * never prints a meaningless 0% or 100%.
 */
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

  // Missing components must not silently drag the number down: renormalize.
  const totalWeight = parts.reduce((sum, [weight]) => sum + weight, 0);
  const blended = parts.reduce((sum, [weight, value]) => sum + value * weight, 0) / totalWeight;
  const probability = direction === 'short' ? 100 - blended : blended;
  return Math.round(clamp(probability, 1, 99));
}

/** Coarse band the UI colours and filters on. */
export function growthBand(probability) {
  const value = num(probability);
  if (value === null) return null;
  if (value >= 70) return 'high';
  if (value >= 60) return 'good';
  if (value >= 50) return 'moderate';
  return 'low';
}

export const GROWTH_BANDS = ['low', 'moderate', 'good', 'high'];
