/**
 * One-month short-horizon forecast.
 *
 * The rest of the app answers "is this a good business and how do I structure
 * the trade". This module answers a narrower question: given the last month of
 * daily bars (21 trading sessions), what is the next session and the next week
 * more likely to do?
 *
 * It is deliberately transparent and pure:
 *   1. Each session gets a composite setup score from six weighted technical
 *      readings (10-day slope, price vs its averages, RSI, MACD histogram,
 *      up/down volume, range position) minus a mean-reversion penalty for a
 *      price stretched far from its 20-day mean.
 *   2. The score is mapped to a probability with a logistic curve, separately
 *      for one session and five sessions.
 *   3. The 21-session window is replayed: every day whose setup looked like
 *      today's contributes its actual next-1 and next-5 session return, so the
 *      model probability is blended with a measured analog hit rate instead of
 *      being trusted on its own.
 *
 * The forecast desk (agent/forecastAnalyst.js) makes the published call from
 * this 1-month chart plus the newest headlines; this module supplies the
 * evidence and the deterministic fallback.
 *
 * Everything here is a statistical read, not a price target. Mixed signals
 * return an explicit `flat` direction rather than a forced arrow.
 */
import { atr, last, macd, normalizedSlope, rsi, sma } from './indicators.js';

/**
 * One month of trading sessions. A calendar month holds about 21 weekdays, so
 * this is the window a 1M candle chart shows.
 */
export const FORECAST_WINDOW = 21;
export const FORECAST_HORIZONS = { day: 1, week: 5 };
/** A day only counts as an analog when its setup score clears this band. */
export const ANALOG_MIN_SCORE = 12;
/** Below this |score| (and the matching probability band) the read is flat. */
export const NO_EDGE_SCORE = 5;

export const SETUP_WEIGHTS = {
  slope: 0.26,
  mean: 0.2,
  rsi: 0.14,
  macd: 0.16,
  volume: 0.1,
  range: 0.14,
};

export const FORECAST_DISCLAIMER =
  'A short-horizon read from the 1-month daily chart and recent headlines — not investment advice and not a ' +
  'price target. One-week forecasts compound five sessions of news and market noise, so treat the typical range as the realistic outcome.';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(digits));
  // A signed zero survives toFixed for tiny negatives but JSON turns it into 0,
  // so normalise it here instead of shipping two representations of the same
  // number to the API and the Q&A dossier.
  return rounded === 0 ? 0 : rounded;
};
const pctBetween = (from, to) => (from ? ((to - from) / from) * 100 : null);

/** Standard deviation of daily log returns, in percent (not annualised). */
function returnsVolatility(closes, period = 20) {
  const slice = closes.slice(-(period + 1));
  if (slice.length < 3) return null;
  const returns = [];
  for (let i = 1; i < slice.length; i += 1) returns.push(Math.log(slice[i] / slice[i - 1]));
  if (returns.some((value) => !Number.isFinite(value))) return null;
  const mean = returns.reduce((acc, value) => acc + value, 0) / returns.length;
  const variance = returns.reduce((acc, value) => acc + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * 100;
}

export function scoreLabel(score) {
  if (score >= 40) return 'strong bullish';
  if (score >= 15) return 'bullish tilt';
  if (score > -15) return 'neutral';
  if (score > -40) return 'bearish tilt';
  return 'strong bearish';
}

/** Logistic score → probability (percent), bounded so the UI never prints 0/100. */
export function probabilityFor(score, horizon = 1) {
  // One session is noisier than a week, so its curve is flatter.
  const scale = horizon <= 1 ? 34 : 40;
  const logistic = 1 / (1 + Math.exp(-score / scale));
  return clamp(50 + (logistic - 0.5) * 100, 5, 95);
}

/**
 * Technical setup as it stood at `endIndex` (inclusive). Needs 20 bars so every
 * component has a reading; returns null before that.
 */
export function computeSetup(bars, endIndex = bars.length - 1, { rangeLookback = 20 } = {}) {
  if (!Array.isArray(bars) || endIndex < 19 || endIndex >= bars.length) return null;
  const slice = bars.slice(0, endIndex + 1);
  const closes = slice.map((bar) => bar.close);
  if (closes.some((value) => !Number.isFinite(value))) return null;

  const price = closes[closes.length - 1];
  const ma10 = last(sma(closes, 10));
  const ma20 = last(sma(closes, 20));
  const slopePct = normalizedSlope(closes.slice(-10));
  const rsi14 = last(rsi(closes, 14));
  const macdSeries = macd(closes);
  const histogram = last(macdSeries.histogram);
  const macdHistPct = histogram !== null && price ? (histogram / price) * 100 : null;
  const atr14 = last(atr(slice, 14));
  const atrPct = atr14 !== null && price ? (atr14 / price) * 100 : null;
  const volatilityPct = returnsVolatility(closes, 20);

  const lookback = Math.max(1, Math.min(rangeLookback, slice.length - 1));
  const windowBars = slice.slice(-lookback);
  const priorBars = slice.slice(-(lookback + 1), -1);
  const highOf = (bar) => (Number.isFinite(bar.high) ? bar.high : bar.close);
  const lowOf = (bar) => (Number.isFinite(bar.low) ? bar.low : bar.close);
  const rangeHigh = Math.max(...windowBars.map(highOf));
  const rangeLow = Math.min(...windowBars.map(lowOf));
  const rangePosition = rangeHigh > rangeLow ? (price - rangeLow) / (rangeHigh - rangeLow) : 0.5;
  const priorHigh = priorBars.length ? Math.max(...priorBars.map(highOf)) : null;
  const priorLow = priorBars.length ? Math.min(...priorBars.map(lowOf)) : null;
  const breakout = priorHigh !== null && price > priorHigh ? 1 : priorLow !== null && price < priorLow ? -1 : 0;

  // Consecutive up (+) / down (−) closes, capped by construction at ±length.
  let streak = 0;
  for (let i = closes.length - 1; i > 0; i -= 1) {
    const sign = Math.sign(closes[i] - closes[i - 1]);
    if (sign === 0) break;
    if (streak === 0) streak = sign;
    else if (sign === Math.sign(streak)) streak += sign;
    else break;
  }

  const recent = slice.slice(-10);
  let upVolume = 0;
  let downVolume = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const volume = Number.isFinite(recent[i].volume) ? recent[i].volume : 0;
    if (recent[i].close > recent[i - 1].close) upVolume += volume;
    else if (recent[i].close < recent[i - 1].close) downVolume += volume;
  }
  const volumeBias = upVolume + downVolume ? (upVolume - downVolume) / (upVolume + downVolume) : 0;

  const vsMa20 = ma20 ? ((price - ma20) / ma20) * 100 : 0;
  const vsMa10 = ma10 ? ((price - ma10) / ma10) * 100 : 0;

  const slopeScore = clamp(slopePct / 0.4, -1, 1);
  const meanScore = clamp(vsMa20 / 3.5, -1, 1) * 0.6 + clamp(vsMa10 / 1.8, -1, 1) * 0.4;

  // RSI's absolute level lies when price has barely moved (an unchanged tape
  // reads as 100 because there were no losses). Weight it by the actual move.
  const reference = closes[Math.max(0, closes.length - 15)];
  const net14Pct = reference ? ((price - reference) / reference) * 100 : 0;
  const rsiReliability = clamp(Math.abs(net14Pct) / 1, 0, 1);
  let rsiScore = rsi14 === null ? 0 : clamp((rsi14 - 50) / 20, -1, 1);
  if (rsi14 !== null && (rsi14 >= 75 || rsi14 <= 25)) rsiScore *= 0.5; // exhaustion
  rsiScore *= 0.25 + 0.75 * rsiReliability;

  const macdScore = macdHistPct === null ? 0 : clamp(macdHistPct / 0.8, -1, 1);
  const volumeScore = clamp(volumeBias * 1.2, -1, 1);
  const rangeScore = clamp((rangePosition - 0.5) * 2, -1, 1) * 0.6 + breakout * 0.4;

  const stretchAtr = atr14 && atr14 > 0 && ma20 ? (price - ma20) / atr14 : 0;

  const weighted =
    SETUP_WEIGHTS.slope * slopeScore +
    SETUP_WEIGHTS.mean * meanScore +
    SETUP_WEIGHTS.rsi * rsiScore +
    SETUP_WEIGHTS.macd * macdScore +
    SETUP_WEIGHTS.volume * volumeScore +
    SETUP_WEIGHTS.range * rangeScore;

  // Price stretched far above its mean gives some of the trend back; stretched
  // below it cushions the downside. The penalty is bounded at ±15 points.
  const score = clamp(weighted * 100 - stretchAtr * 5, -100, 100);

  const parts = [
    {
      key: 'slope',
      label: '10-session trend',
      score: round(slopeScore, 2),
      detail: `${slopePct >= 0 ? '+' : ''}${slopePct.toFixed(2)}% per session`,
    },
    {
      key: 'mean',
      label: 'Price vs averages',
      score: round(meanScore, 2),
      detail: `${vsMa20 >= 0 ? '+' : ''}${vsMa20.toFixed(1)}% vs the 20-day mean`,
    },
    {
      key: 'rsi',
      label: 'RSI(14)',
      score: round(rsiScore, 2),
      detail: rsi14 === null ? 'not enough history' : `RSI(14) ${rsi14.toFixed(1)}`,
    },
    {
      key: 'macd',
      label: 'MACD histogram',
      score: round(macdScore, 2),
      detail:
        macdHistPct === null
          ? 'not enough history'
          : `${macdHistPct >= 0 ? '+' : ''}${macdHistPct.toFixed(2)}% of price`,
    },
    {
      key: 'volume',
      label: 'Up/down volume',
      score: round(volumeScore, 2),
      detail: `${Math.round(((volumeBias + 1) / 2) * 100)}% of the last 10 sessions' volume traded on up days`,
    },
    {
      key: 'range',
      label: 'Range position',
      score: round(rangeScore, 2),
      detail: `${Math.round(rangePosition * 100)}% of the 20-session range${
        breakout > 0 ? ' · broke above it' : breakout < 0 ? ' · broke below it' : ''
      }`,
    },
    {
      key: 'stretch',
      label: 'Distance from mean (reversion)',
      score: round(clamp(-stretchAtr / 2.5, -1, 1), 2),
      detail: `${stretchAtr.toFixed(1)} ATR from the 20-day mean`,
    },
  ];

  return {
    score: round(score, 1),
    price,
    slopePct,
    ma10,
    ma20,
    rsi14,
    macdHistPct,
    atr14,
    atrPct,
    volatilityPct,
    rangeHigh,
    rangeLow,
    rangePosition,
    breakout,
    streak,
    volumeBias,
    stretchAtr,
    parts,
  };
}

/** Every setup inside the window that has a next-session / next-week outcome. */
function buildAnalogRows(bars, windowStart) {
  const rows = [];
  for (let index = windowStart; index < bars.length - 1; index += 1) {
    const setup = computeSetup(bars, index);
    if (!setup) continue;
    const close = bars[index].close;
    rows.push({
      date: bars[index].date,
      score: setup.score,
      next1: bars[index + 1] ? pctBetween(close, bars[index + 1].close) : null,
      next5: bars[index + 5] ? pctBetween(close, bars[index + 5].close) : null,
    });
  }
  return rows;
}

/**
 * Replay comparable setups in the window. `matched` needs at least four
 * samples; `baseline` is every usable session, so the UI can show whether the
 * setup actually beat the window's ordinary hit rate.
 */
export function summarizeAnalog(rows = [], { score = 0, horizon = 1 } = {}) {
  const key = horizon <= 1 ? 'next1' : 'next5';
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  const usable = rows.filter((row) => Number.isFinite(row?.[key]));
  const empty = { samples: 0, hitRate: null, avgPct: null };

  const summarize = (list) => {
    if (!list.length) return { ...empty };
    const avgPct = list.reduce((sum, row) => sum + row[key], 0) / list.length;
    if (!sign) return { samples: list.length, hitRate: null, avgPct: round(avgPct, 2) };
    const hits = list.filter((row) => Math.sign(row[key]) === sign && row[key] !== 0).length;
    return { samples: list.length, hitRate: round((hits / list.length) * 100, 0), avgPct: round(avgPct, 2) };
  };

  const candidates =
    sign && Math.abs(score) >= ANALOG_MIN_SCORE ? usable.filter((row) => Math.sign(row.score) === sign) : [];
  const matched = candidates.length >= 4 ? summarize(candidates) : { ...empty };

  return {
    horizon,
    threshold: ANALOG_MIN_SCORE,
    direction: sign > 0 ? 'rise' : sign < 0 ? 'drop' : 'flat',
    matched,
    baseline: summarize(usable),
  };
}

const DIRECTION_LABELS = { rise: 'Rise', drop: 'Drop', flat: 'No edge' };

function blendProbability(modelProbability, analog) {
  const samples = analog?.matched?.samples || 0;
  const hitRate = analog?.matched?.hitRate;
  if (!samples || !Number.isFinite(hitRate)) return modelProbability;
  // The analog hit rate is measured in the forecast direction; everything here
  // works on the "chance of a rise" scale, so a bearish analog has to be
  // flipped before it can be blended.
  const riseHitRate = analog.direction === 'drop' ? 100 - hitRate : hitRate;
  // A thin sample earns little weight; never more than 35% of the blend.
  const weight = Math.min(0.35, samples / 40);
  return clamp(modelProbability * (1 - weight) + riseHitRate * weight, 5, 95);
}

/**
 * Build the full forecast payload for one symbol.
 * Returns null when there is not enough daily history to learn from.
 */
export function forecastSymbol({
  symbol,
  name = null,
  quoteType = 'EQUITY',
  currency = 'USD',
  exchange = null,
  bars = [],
  window = FORECAST_WINDOW,
  price = null,
  change = null,
  changePercent = null,
} = {}) {
  const clean = (Array.isArray(bars) ? bars : [])
    .filter((bar) => bar && Number.isFinite(bar.close))
    .map((bar) => ({
      date: bar.date,
      open: Number.isFinite(bar.open) ? bar.open : bar.close,
      high: Number.isFinite(bar.high) ? bar.high : bar.close,
      low: Number.isFinite(bar.low) ? bar.low : bar.close,
      close: bar.close,
      volume: Number.isFinite(bar.volume) ? bar.volume : 0,
    }));

  if (clean.length < 40) return null;
  // Keep six sessions free so the five-session analog returns always exist.
  const sessions = Math.min(clamp(Math.round(Number(window) || FORECAST_WINDOW), 10, 60), clean.length - 6);

  const current = computeSetup(clean, clean.length - 1);
  if (!current) return null;

  const lastBar = clean[clean.length - 1];
  const spot = Number.isFinite(price) ? price : lastBar.close;
  const windowStart = clean.length - sessions;
  const windowBars = clean.slice(windowStart);
  const windowFirstClose = windowBars[0].close;
  const analogRows = buildAnalogRows(clean, windowStart);

  const horizons = {};
  for (const [key, days] of Object.entries(FORECAST_HORIZONS)) {
    const analog = summarizeAnalog(analogRows, { score: current.score, horizon: days });
    const riseProbability = Math.round(blendProbability(probabilityFor(current.score, days), analog));
    const edge = riseProbability / 100 - 0.5;
    const dailyMove = current.atrPct ?? current.volatilityPct ?? 1;
    // Expected move shrinks with the coin-flip edge and scales with the
    // horizon's own noise; it never promises a large directional jump.
    const magnitude = days <= 1 ? dailyMove * 0.55 : dailyMove * Math.sqrt(days) * 0.6;
    const expectedPct = round(edge * 2 * magnitude, 2);
    const uncertainty = (current.volatilityPct ?? dailyMove) * Math.sqrt(days);
    const direction =
      Math.abs(current.score) < NO_EDGE_SCORE || Math.abs(edge) < 0.02 ? 'flat' : edge > 0 ? 'rise' : 'drop';
    const directionSign = direction === 'drop' ? -1 : direction === 'rise' ? 1 : 0;
    // `probability` is always the chance of the named direction, so a 60% drop
    // call reads as 60% — never as a 40% "chance of a drop".
    const probability =
      direction === 'drop' ? 100 - riseProbability : direction === 'rise' ? riseProbability : 50;

    const drivers = [...current.parts]
      .filter((part) => part.score !== null)
      .sort((a, b) => Math.abs(b.score) * (SETUP_WEIGHTS[b.key] ?? 0.08) - Math.abs(a.score) * (SETUP_WEIGHTS[a.key] ?? 0.08))
      .filter((part) => Math.abs(part.score) >= 0.15)
      .slice(0, 3)
      .map((part) => `${part.label}: ${part.detail}`);

    const caveats = [];
    if (!analog.matched.samples) {
      caveats.push(
        `No comparable setups in the ${sessions}-session window (needs a score beyond ±${ANALOG_MIN_SCORE}); this read is model-only.`,
      );
    } else if (analog.matched.samples < 6) {
      caveats.push(`Only ${analog.matched.samples} comparable setups — the analog sample is thin.`);
    }
    if (current.atrPct !== null && current.atrPct >= 4) {
      caveats.push(`Daily range is ${current.atrPct.toFixed(1)}% of price — a one-session call has wide error bars.`);
    }
    if (current.rsi14 !== null && (current.rsi14 >= 75 || current.rsi14 <= 25)) {
      caveats.push(`RSI(14) at ${current.rsi14.toFixed(1)} is stretched; mean reversion can override the trend.`);
    }
    if (direction === 'flat') caveats.push('Signals are mixed — the model sees no directional edge over this horizon.');
    if (days > 1) caveats.push('A one-week read compounds five sessions of news and market noise.');

    const supportive = current.parts.filter(
      (part) => directionSign !== 0 && part.score !== null && Math.sign(part.score) === directionSign && Math.abs(part.score) >= 0.15,
    ).length;
    const agreement = supportive / current.parts.length;
    const sampleFactor = Math.min(analog.matched.samples, 10) / 10;
    const strength = Math.min(Math.abs(current.score), 40) / 40;
    const confidence =
      direction === 'flat'
        ? Math.round(clamp(30 + agreement * 15, 20, 45))
        : Math.round(clamp(32 + agreement * 26 + sampleFactor * 14 + strength * 16, 25, 92));

    horizons[key] = {
      horizon: days,
      label: days <= 1 ? 'Next session' : 'Next week',
      direction,
      directionLabel: DIRECTION_LABELS[direction],
      probability,
      riseProbability,
      dropProbability: 100 - riseProbability,
      expectedPct,
      expectedPrice: round(spot * (1 + expectedPct / 100)),
      rangePct: round(uncertainty, 2),
      lowPct: round(-uncertainty, 2),
      highPct: round(uncertainty, 2),
      lowPrice: round(spot * (1 - uncertainty / 100)),
      highPrice: round(spot * (1 + uncertainty / 100)),
      confidence,
      drivers,
      caveats,
      analog,
    };
  }

  const closes = clean.map((bar) => bar.close);
  const sma20Series = sma(closes, 20);
  const rsiSeries = rsi(closes, 14);
  const series = clean
    .map((bar, index) => ({
      date: bar.date,
      open: round(bar.open),
      high: round(bar.high),
      low: round(bar.low),
      close: round(bar.close),
      volume: bar.volume,
      sma20: round(sma20Series[index]),
      rsi14: round(rsiSeries[index], 1),
    }))
    .slice(-sessions);

  const technicals = {
    score: current.score,
    scoreLabel: scoreLabel(current.score),
    rsi14: round(current.rsi14, 1),
    atrPct: round(current.atrPct, 2),
    volatilityPct: round(current.volatilityPct, 2),
    slopePct: round(current.slopePct, 2),
    sma10: round(current.ma10),
    sma20: round(current.ma20),
    rangePosition: round(current.rangePosition * 100, 0),
    streak: current.streak,
    volumeBias: round(current.volumeBias * 100, 0),
    macdHistogramPct: round(current.macdHistPct, 3),
    stretchAtr: round(current.stretchAtr, 1),
    aboveSma20: current.ma20 === null ? null : spot >= current.ma20,
    parts: current.parts,
  };

  const windowChangePct = windowFirstClose ? round(((spot - windowFirstClose) / windowFirstClose) * 100, 2) : null;
  const analogNote = analogRows.length
    ? `${analogRows.length} sessions inside the window were scored and their actual next-1 and next-5 session returns replayed.`
    : 'The window is too short to replay any setups.';

  const summary = [
    `${symbol} at ${round(spot)} after a ${windowChangePct >= 0 ? '+' : ''}${windowChangePct}% ${sessions}-session move; composite setup score ${current.score >= 0 ? '+' : ''}${current.score}/100 (${scoreLabel(current.score)}).`,
    `Next session — ${horizons.day.directionLabel.toLowerCase()} ${horizons.day.probability}% (expected ${horizons.day.expectedPct >= 0 ? '+' : ''}${horizons.day.expectedPct}%, typical range ${horizons.day.lowPct}% to +${horizons.day.highPct}%).`,
    `Next week — ${horizons.week.directionLabel.toLowerCase()} ${horizons.week.probability}% (expected ${horizons.week.expectedPct >= 0 ? '+' : ''}${horizons.week.expectedPct}%, typical range ${horizons.week.lowPct}% to +${horizons.week.highPct}%).`,
    horizons.day.analog.matched.samples
      ? `Analog check — ${horizons.day.analog.matched.samples} similar setups hit ${horizons.day.analog.matched.hitRate}% for the next session versus a ${horizons.day.analog.baseline.hitRate}% window baseline.`
      : 'Analog check — no comparable setups in the window, so the probability is model-only.',
  ];

  return {
    symbol,
    name: name || symbol,
    quoteType,
    currency,
    exchange,
    price: round(spot),
    change: round(change),
    changePercent: round(changePercent),
    asOf: lastBar.date ?? null,
    generatedAt: new Date().toISOString(),
    window: {
      sessions,
      from: windowBars[0].date ?? null,
      to: lastBar.date ?? null,
      changePct: windowChangePct,
      high: round(Math.max(...windowBars.map((bar) => bar.high))),
      low: round(Math.min(...windowBars.map((bar) => bar.low))),
    },
    score: {
      value: current.score,
      label: scoreLabel(current.score),
      direction: current.score >= NO_EDGE_SCORE ? 'rise' : current.score <= -NO_EDGE_SCORE ? 'drop' : 'flat',
    },
    horizons,
    technicals,
    analog: {
      windowSessions: sessions,
      threshold: ANALOG_MIN_SCORE,
      samples: analogRows.length,
      day: horizons.day.analog,
      week: horizons.week.analog,
      note: analogNote,
    },
    series,
    summary,
    model: {
      name: '1-month technical analog',
      version: 1,
      windowSessions: sessions,
      horizons: FORECAST_HORIZONS,
      weights: SETUP_WEIGHTS,
      analogThreshold: ANALOG_MIN_SCORE,
      method:
        'Six weighted technical readings plus a mean-reversion penalty form a composite score; a logistic curve turns it into a probability, which is blended with the measured hit rate of similar setups inside the 1-month (21-session) window. The published day and week calls are made by the forecast desk from this chart and its deep pattern read, the full news set with the tagged business deals, the earnings report and the geopolitical backdrop.',
    },
    disclaimer: FORECAST_DISCLAIMER,
  };
}

export const _internals = { returnsVolatility, buildAnalogRows, blendProbability };
