/**
 * Risers board: one ranked list of names that could rise over the next session
 * and the next week, using every evidence source the Forecast lab has.
 *
 * The 1-month pattern is the anchor (it already contains the technical score
 * and the in-window analog replay), then news sentiment, the engine's quality
 * score and 3-month relative strength vs SPY are blended in. Weights are
 * renormalised over whichever components are actually available, so a name with
 * no headlines is not punished for missing data — it simply falls back to the
 * evidence it does have.
 */
import { growthBand } from './growth.js';

export const BOARD_WEIGHTS = {
  /** 1-month technical pattern + analog replay (rise probability). */
  pattern: 0.5,
  /** Yahoo headline sentiment, mapped onto a 0-100 probability scale. */
  news: 0.25,
  /** Engine quality score (0-100): trend, momentum, volume, risk, valuation, Street. */
  quality: 0.15,
  /** 3-month relative strength vs SPY, in percentage points. */
  relativeStrength: 0.1,
};

export const BOARD_RISE_THRESHOLD = 55;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
// Number(null) is 0, which would turn an absent reading into a real (terrible)
// one. Missing evidence must be rejected before the numeric coercion.
const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Sentiment (-100..100) → probability of a rise (10..90), neutral at 50. */
export function newsToProbability(sentiment) {
  const value = num(sentiment);
  if (value === null) return null;
  return clamp(50 + value * 0.35, 10, 90);
}

/** Out/under-performance vs SPY in pp → probability (5..95), neutral at 50. */
export function relativeStrengthToProbability(spreadPct) {
  const value = num(spreadPct);
  if (value === null) return null;
  return clamp(50 + value * 2.5, 5, 95);
}

/**
 * Weighted chance to rise (1-99). Missing components are dropped and the
 * remaining weights renormalised rather than counted as neutral evidence.
 */
export function blendRiseChance({
  patternProbability = null,
  newsSentiment = null,
  qualityScore = null,
  relativeStrengthSpread = null,
} = {}) {
  const parts = [];
  const pattern = num(patternProbability);
  if (pattern !== null) {
    parts.push({ key: 'pattern', weight: BOARD_WEIGHTS.pattern, value: clamp(pattern, 1, 99) });
  }
  const news = newsToProbability(newsSentiment);
  if (news !== null) parts.push({ key: 'news', weight: BOARD_WEIGHTS.news, value: news });
  const quality = num(qualityScore);
  if (quality !== null) {
    parts.push({ key: 'quality', weight: BOARD_WEIGHTS.quality, value: clamp(quality, 1, 99) });
  }
  const rs = relativeStrengthToProbability(relativeStrengthSpread);
  if (rs !== null) parts.push({ key: 'relativeStrength', weight: BOARD_WEIGHTS.relativeStrength, value: rs });

  if (!parts.length) return null;
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const blended = parts.reduce((sum, part) => sum + part.weight * part.value, 0) / totalWeight;
  return Math.round(clamp(blended, 1, 99));
}

const lean = (chance) => (chance === null ? 'flat' : chance >= 55 ? 'rise' : chance <= 45 ? 'drop' : 'flat');
const LEAN_LABEL = { rise: 'Rise', drop: 'Drop', flat: 'No edge' };

/** One horizon of the blended board row. */
function horizonFor(forecast, horizon, chance) {
  return {
    chance,
    band: growthBand(chance),
    direction: lean(chance),
    directionLabel: LEAN_LABEL[lean(chance)],
    patternProbability: horizon.riseProbability,
    patternDirection: horizon.direction,
    expectedPct: horizon.expectedPct,
    expectedPrice: horizon.expectedPrice,
    confidence: horizon.confidence,
    analog: horizon.analog?.matched ?? null,
  };
}

/**
 * Build one board row from a forecast, the analysed headline set and the engine
 * analysis. Pure: the service layer does the IO.
 */
export function buildForecastBoardRow({ forecast, news = null, analysis = null } = {}) {
  if (!forecast?.horizons) return null;

  const qualityScore = num(analysis?.score?.total);
  const relativeStrength = round(num(analysis?.performance?.relativeStrength), 1);
  const cleanNews =
    news && Number(news.headlineCount) > 0
      ? {
          sentiment: round(news.sentiment, 0),
          label: news.label ?? null,
          headlineCount: news.headlineCount,
          bullish: news.counts?.bullish ?? null,
          bearish: news.counts?.bearish ?? null,
          topHeadline: news.headlines?.[0]?.title ?? null,
        }
      : null;

  const chanceFor = (horizon) =>
    blendRiseChance({
      patternProbability: horizon.riseProbability,
      newsSentiment: cleanNews?.sentiment ?? null,
      qualityScore,
      relativeStrengthSpread: relativeStrength,
    });

  const day = horizonFor(forecast, forecast.horizons.day, chanceFor(forecast.horizons.day));
  const week = horizonFor(forecast, forecast.horizons.week, chanceFor(forecast.horizons.week));

  const whyParts = [];
  if (forecast.horizons.day.drivers?.length) whyParts.push(forecast.horizons.day.drivers[0]);
  if (cleanNews) {
    whyParts.push(`news ${cleanNews.label} (${cleanNews.sentiment > 0 ? '+' : ''}${cleanNews.sentiment})`);
  }
  if (relativeStrength !== null) {
    whyParts.push(`RS ${relativeStrength > 0 ? '+' : ''}${relativeStrength}pp vs SPY`);
  }

  return {
    symbol: forecast.symbol,
    name: forecast.name || forecast.symbol,
    quoteType: forecast.quoteType || 'EQUITY',
    currency: forecast.currency || 'USD',
    price: forecast.price,
    changePercent: forecast.changePercent,
    asOf: forecast.asOf ?? null,

    day,
    week,

    pattern: {
      score: forecast.score?.value ?? null,
      label: forecast.score?.label ?? null,
      direction: forecast.score?.direction ?? null,
      analogDay: forecast.horizons.day.analog?.matched ?? null,
      analogWeek: forecast.horizons.week.analog?.matched ?? null,
    },
    technical: {
      qualityScore,
      qualityLabel: analysis?.score?.label ?? null,
      signalLabel: analysis?.signalLabel ?? null,
      rsi14: forecast.technicals?.rsi14 ?? null,
      atrPct: forecast.technicals?.atrPct ?? null,
      volatilityPct: forecast.technicals?.volatilityPct ?? null,
      aboveSma20: forecast.technicals?.aboveSma20 ?? null,
      trend: forecast.technicals?.aboveSma20 === null ? null : forecast.technicals?.aboveSma20 ? 'up' : 'down',
    },
    action: analysis?.alert?.action ?? null,
    actionLabel: analysis?.alert?.actionLabel ?? null,
    news: cleanNews,
    relativeStrength,
    components: [
      { key: 'pattern', weight: BOARD_WEIGHTS.pattern, value: round(forecast.horizons.day.riseProbability, 0) },
      { key: 'news', weight: BOARD_WEIGHTS.news, value: round(newsToProbability(cleanNews?.sentiment), 0) },
      { key: 'quality', weight: BOARD_WEIGHTS.quality, value: qualityScore },
      { key: 'relativeStrength', weight: BOARD_WEIGHTS.relativeStrength, value: round(relativeStrengthToProbability(relativeStrength), 0) },
    ].filter((component) => component.value !== null && component.value !== undefined),
    why: whyParts.join(' · ').slice(0, 220),
  };
}

/** Best week first, then best day; ties keep the input order stable. */
export function rankForecastRows(rows = []) {
  return [...rows]
    .filter(Boolean)
    .sort((a, b) => (b.week?.chance ?? 0) - (a.week?.chance ?? 0) || (b.day?.chance ?? 0) - (a.day?.chance ?? 0))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export const _internals = { lean, horizonFor };
