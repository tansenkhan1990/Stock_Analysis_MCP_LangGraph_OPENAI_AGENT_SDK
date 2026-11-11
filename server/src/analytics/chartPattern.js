/**
 * Deep read of the 1-month (21-session) daily chart.
 *
 * The composite setup score in forecast.js answers "how strong is the tape".
 * This module answers "what is the chart actually doing": swing structure
 * (higher highs / higher lows), the fitted channel, where the close sits in the
 * range, whether the session broke support or resistance on volume, RSI and
 * MACD momentum including divergence, the volatility regime, and the last
 * candle's shape. The forecast desk reads it beside the full news set, the
 * business deals, the earnings report and the geopolitical backdrop.
 *
 * Pure and deterministic: no IO, so every rule below is unit-tested.
 */
import { atr, bollinger, last, macd, normalizedSlope, rsi } from './indicators.js';

export const CHART_PATTERN_WINDOW = 21;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(digits));
  return rounded === 0 ? 0 : rounded;
};
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const f = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

/** Last finite value `offsetFromEnd` steps back in a nullable series. */
function valueAt(series, offsetFromEnd) {
  let seen = 0;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(series[i])) {
      if (seen === offsetFromEnd) return series[i];
      seen += 1;
    }
  }
  return null;
}

/** Local swing highs/lows: a bar that is the extreme of its neighbourhood. */
function findSwings(bars, left = 2, right = 2) {
  const highs = [];
  const lows = [];
  for (let i = left; i < bars.length - right; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j += 1) {
      if (j === i) continue;
      if (bars[j].high > bars[i].high) isHigh = false;
      if (bars[j].low < bars[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: bars[i].high, date: bars[i].date ?? null });
    if (isLow) lows.push({ index: i, price: bars[i].low, date: bars[i].date ?? null });
  }
  return { highs, lows };
}

/** A dead-flat tape is "no change", not a lower high or a higher low. */
function compareSwing(current, prior) {
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return null;
  if (current > prior * 1.0005) return true;
  if (current < prior * 0.9995) return false;
  return null;
}

function describeStructure(highs, lows, bars = []) {
  const highsSeq = highs.slice(-3);
  const lowsSeq = lows.slice(-3);
  let higherHighs = highsSeq.length >= 2 ? compareSwing(highsSeq.at(-1).price, highsSeq.at(-2).price) : null;
  let higherLows = lowsSeq.length >= 2 ? compareSwing(lowsSeq.at(-1).price, lowsSeq.at(-2).price) : null;
  // A monotonic advance or decline has no local pivots at all, so compare the
  // extremes of the first and last thirds of the window instead of reporting
  // "no structure" for the strongest trends.
  if ((higherHighs === null || higherLows === null) && bars.length >= 6) {
    const third = Math.max(2, Math.floor(bars.length / 3));
    const first = bars.slice(0, third);
    const last = bars.slice(-third);
    if (higherHighs === null) {
      higherHighs = compareSwing(
        Math.max(...last.map((bar) => bar.high)),
        Math.max(...first.map((bar) => bar.high)),
      );
    }
    if (higherLows === null) {
      higherLows = compareSwing(
        Math.min(...last.map((bar) => bar.low)),
        Math.min(...first.map((bar) => bar.low)),
      );
    }
  }
  const label =
    higherHighs === true && higherLows === true
      ? 'higher highs and higher lows'
      : higherHighs === false && higherLows === false
        ? 'lower highs and lower lows'
        : higherHighs === true && higherLows === false
          ? 'higher highs with lower lows (expanding range)'
          : higherHighs === false && higherLows === true
            ? 'lower highs with higher lows (compressing range)'
            : 'no clear swing structure';
  return {
    higherHighs,
    higherLows,
    label,
    highs: highsSeq.map((point) => ({ price: round(point.price), date: point.date })),
    lows: lowsSeq.map((point) => ({ price: round(point.price), date: point.date })),
  };
}

/** Least-squares fit plus residual deviation for the channel read. */
function fitLine(values) {
  const n = values.length;
  if (n < 2) return null;
  const meanX = (n - 1) / 2;
  const meanY = mean(values);
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < n; i += 1) {
    covariance += (i - meanX) * (values[i] - meanY);
    variance += (i - meanX) ** 2;
  }
  const slope = variance ? covariance / variance : 0;
  const intercept = meanY - slope * meanX;
  const residuals = values.map((value, index) => value - (intercept + slope * index));
  const sd = Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / n);
  return { slope, intercept, sd };
}

export function analyzeChartPattern(bars = [], { window = CHART_PATTERN_WINDOW } = {}) {
  const clean = (Array.isArray(bars) ? bars : [])
    .filter((bar) => bar && Number.isFinite(bar.close))
    .map((bar) => ({
      date: bar.date ?? null,
      open: Number.isFinite(bar.open) ? bar.open : bar.close,
      high: Number.isFinite(bar.high) ? bar.high : bar.close,
      low: Number.isFinite(bar.low) ? bar.low : bar.close,
      close: bar.close,
      volume: Number.isFinite(bar.volume) ? bar.volume : 0,
    }));
  if (clean.length < 25) return null;

  const sessions = Math.min(Math.max(Math.round(Number(window) || CHART_PATTERN_WINDOW), 10), clean.length - 4);
  const windowBars = clean.slice(-sessions);
  const closes = clean.map((bar) => bar.close);
  const price = closes.at(-1);
  const offset = clean.length - sessions;
  const lastBar = windowBars.at(-1);

  const high = Math.max(...windowBars.map((bar) => bar.high));
  const low = Math.min(...windowBars.map((bar) => bar.low));
  const rangeWidthPct = low ? ((high - low) / low) * 100 : null;
  const rangePosition = high > low ? clamp((price - low) / (high - low), 0, 1) : 0.5;

  const swings = findSwings(windowBars);
  const structure = describeStructure(swings.highs, swings.lows, windowBars);
  const slopePct = normalizedSlope(windowBars.map((bar) => bar.close));

  const fit = fitLine(windowBars.map((bar) => bar.close));
  const fitLast = fit ? fit.intercept + fit.slope * (sessions - 1) : null;
  const channelUpper = fitLast !== null ? fitLast + fit.sd * 2 : null;
  const channelLower = fitLast !== null ? fitLast - fit.sd * 2 : null;
  const channelPosition =
    channelUpper !== null && channelLower !== null && channelUpper > channelLower
      ? clamp((price - channelLower) / (channelUpper - channelLower), 0, 1)
      : 0.5;
  const channelSlopePct = fit && fitLast ? (fit.slope / fitLast) * 100 : null;

  const priorBars = windowBars.slice(0, -1);
  const priorHigh = priorBars.length ? Math.max(...priorBars.map((bar) => bar.high)) : high;
  const priorLow = priorBars.length ? Math.min(...priorBars.map((bar) => bar.low)) : low;
  const breakoutUp = price > priorHigh;
  const breakoutDown = price < priorLow;
  const averageVolume = mean(windowBars.map((bar) => bar.volume).filter((value) => value > 0));
  const volumeRatio = averageVolume ? lastBar.volume / averageVolume : null;
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= 1.15;

  const rsiSeries = rsi(closes, 14);
  const histogram = macd(closes).histogram;
  const atrSeries = atr(clean, 14);
  const boll = bollinger(closes, 20, 2);

  const rsiNow = last(rsiSeries);
  const rsiPrior = valueAt(rsiSeries, 5);
  const rsiChange = rsiNow !== null && rsiPrior !== null ? rsiNow - rsiPrior : null;
  const histNow = last(histogram);
  const histPrior = valueAt(histogram, 3);
  const macdRising = histNow !== null && histPrior !== null ? histNow > histPrior : null;
  const histPct = histNow !== null && price ? (histNow / price) * 100 : null;

  const atrNow = last(atrSeries);
  const atrPct = atrNow !== null && price ? (atrNow / price) * 100 : null;
  const atrAverage = mean(atrSeries.slice(-20).filter(Number.isFinite));
  const atrPctAverage = atrAverage !== null && price ? (atrAverage / price) * 100 : null;
  const volatilityRegime =
    atrPct === null || atrPctAverage === null
      ? null
      : atrPct >= atrPctAverage * 1.15
        ? 'expanding'
        : atrPct <= atrPctAverage * 0.85
          ? 'contracting'
          : 'steady';
  const widthNow = last(boll.width);
  const widthPrior = valueAt(boll.width, 10);
  const squeeze = widthNow !== null && widthPrior !== null && widthPrior > 0 ? widthNow < widthPrior * 0.75 : null;

  const rsiAt = (index) => rsiSeries[offset + index] ?? null;
  let divergence = null;
  const lastHighs = swings.highs.slice(-2);
  const lastLows = swings.lows.slice(-2);
  if (lastHighs.length === 2) {
    const [prior, current] = lastHighs;
    const priorRsi = rsiAt(prior.index);
    const currentRsi = rsiAt(current.index);
    if (current.price > prior.price && priorRsi !== null && currentRsi !== null && currentRsi < priorRsi - 2) {
      divergence = 'bearish';
    }
  }
  if (!divergence && lastLows.length === 2) {
    const [prior, current] = lastLows;
    const priorRsi = rsiAt(prior.index);
    const currentRsi = rsiAt(current.index);
    if (current.price < prior.price && priorRsi !== null && currentRsi !== null && currentRsi > priorRsi + 2) {
      divergence = 'bullish';
    }
  }

  const candleRange = lastBar.high - lastBar.low || price * 0.0001;
  const bodyPct = ((lastBar.close - lastBar.open) / candleRange) * 100;
  const upperWickPct = ((lastBar.high - Math.max(lastBar.open, lastBar.close)) / candleRange) * 100;
  const lowerWickPct = ((Math.min(lastBar.open, lastBar.close) - lastBar.low) / candleRange) * 100;
  const previous = windowBars.at(-2);
  const candlePatterns = [];
  if (Math.abs(bodyPct) <= 12 && upperWickPct >= 25 && lowerWickPct >= 25) candlePatterns.push('doji indecision');
  if (bodyPct >= 60) candlePatterns.push('strong bullish close');
  if (bodyPct <= -60) candlePatterns.push('strong bearish close');
  if (previous) {
    const previousBody = previous.close - previous.open;
    if (previousBody < 0 && bodyPct > 0 && lastBar.close >= previous.open && lastBar.open <= previous.close) {
      candlePatterns.push('bullish engulfing');
    }
    if (previousBody > 0 && bodyPct < 0 && lastBar.close <= previous.open && lastBar.open >= previous.close) {
      candlePatterns.push('bearish engulfing');
    }
  }
  const gap = previous
    ? lastBar.open > previous.high
      ? 'gap up'
      : lastBar.open < previous.low
        ? 'gap down'
        : null
    : null;

  const swingHighPrices = swings.highs
    .map((point) => point.price)
    .filter((value) => value > price * 1.001)
    .sort((a, b) => a - b);
  const swingLowPrices = swings.lows
    .map((point) => point.price)
    .filter((value) => value < price * 0.999)
    .sort((a, b) => b - a);
  const support = swingLowPrices[0] ?? (low < price ? low : null);
  const resistance = swingHighPrices[0] ?? (high > price ? high : null);
  const supportDistancePct = support ? ((price - support) / price) * 100 : null;
  const resistanceDistancePct = resistance ? ((resistance - price) / price) * 100 : null;

  const tight = rangeWidthPct !== null && atrPct ? rangeWidthPct <= atrPct * 3.2 : false;

  const structureSign =
    structure.higherHighs === true && structure.higherLows === true
      ? 1
      : structure.higherHighs === false && structure.higherLows === false
        ? -1
        : structure.higherHighs === true
          ? 0.4
          : structure.higherHighs === false
            ? -0.4
            : 0;
  const momentumSign =
    clamp(((rsiNow ?? 50) - 50) / 20, -1, 1) * 0.4 +
    (macdRising === true ? 0.3 : macdRising === false ? -0.3 : 0) +
    clamp((histPct ?? 0) / 0.8, -1, 1) * 0.3;
  const rawScore =
    0.3 * clamp(slopePct / 0.5, -1, 1) +
    0.28 * structureSign +
    0.2 * ((rangePosition - 0.5) * 2) +
    0.22 * clamp(momentumSign / 0.8, -1, 1) +
    0.12 * (breakoutUp ? 0.6 : breakoutDown ? -0.6 : 0);
  const score = Math.round(clamp(rawScore * 100, -100, 100));
  const direction = score > 12 ? 'bullish' : score < -12 ? 'bearish' : 'neutral';

  const label = breakoutUp
    ? 'Breakout above resistance'
    : breakoutDown
      ? 'Breakdown below support'
      : structure.higherHighs === true && structure.higherLows === true && slopePct > 0.02
        ? 'Higher highs and higher lows (uptrend)'
        : structure.higherHighs === false && structure.higherLows === false && slopePct < -0.02
          ? 'Lower highs and lower lows (downtrend)'
          : tight
            ? 'Tight consolidation (coiling)'
            : structure.higherHighs === false && structure.higherLows === true
              ? 'Compressing range (lower highs, higher lows)'
              : structure.higherHighs === true && structure.higherLows === false
                ? 'Expanding range (higher highs, lower lows)'
                : 'Choppy range';

  const drivers = [
    `${structure.label} over ${sessions} sessions (${slopePct >= 0 ? '+' : ''}${f(slopePct)}% per session).`,
    `Close at ${Math.round(rangePosition * 100)}% of the ${sessions}-session range` +
      (supportDistancePct !== null ? `, ${f(supportDistancePct, 1)}% above support ${f(support)}` : '') +
      (resistanceDistancePct !== null ? `, ${f(resistanceDistancePct, 1)}% below resistance ${f(resistance)}` : '') +
      '.',
    `RSI(14) ${f(rsiNow, 1)}${rsiChange === null ? '' : rsiChange >= 0 ? ' and rising' : ' and falling'}; MACD histogram ${f(histPct, 2)}% of price and ${macdRising === true ? 'expanding' : macdRising === false ? 'fading' : 'flat'}.`,
  ];
  if (candlePatterns.length || gap) drivers.push(`Last candle: ${[...candlePatterns, gap].filter(Boolean).join(', ')}.`);

  const caveats = [];
  if (atrPct !== null && atrPct >= 4) caveats.push(`ATR is ${f(atrPct, 1)}% of price — the daily range can overwhelm a one-session call.`);
  if (divergence === 'bearish') caveats.push('Bearish divergence: price printed a higher high while RSI did not, so momentum is lagging the advance.');
  if (divergence === 'bullish') caveats.push('Bullish divergence: price printed a lower low while RSI did not, so selling pressure is fading.');
  if (breakoutUp && !volumeConfirmed) caveats.push('The breakout above resistance is not confirmed by above-average volume.');
  if (breakoutDown && !volumeConfirmed) caveats.push('The breakdown below support is not confirmed by above-average volume.');
  if (tight && direction === 'neutral') caveats.push('Tight range: little directional edge until price closes outside it.');
  if (squeeze && direction === 'neutral') caveats.push('Bollinger width is contracting — a volatility expansion is likely, direction undecided.');

  const summary =
    `${sessions}-session structure: ${structure.label}, closing at ${Math.round(rangePosition * 100)}% of the range ` +
    `(${f(low)} to ${f(high)}) with a ${slopePct >= 0 ? '+' : ''}${f(slopePct)}% per-session slope. ` +
    (support !== null || resistance !== null
      ? `Nearest support ${support !== null ? f(support) : '—'}, resistance ${resistance !== null ? f(resistance) : '—'}. `
      : '') +
    `Momentum: RSI(14) ${f(rsiNow, 1)}, MACD histogram ${histPct === null ? '—' : `${f(histPct, 2)}% of price`}. Volatility is ${volatilityRegime ?? 'unread'} (ATR ${f(atrPct, 1)}% of price).`;

  return {
    label,
    direction,
    score,
    strength: Math.abs(score),
    summary,
    window: {
      sessions,
      from: windowBars[0]?.date ?? null,
      to: lastBar.date ?? null,
      high: round(high),
      low: round(low),
    },
    structure,
    trend: { slopePct: round(slopePct), direction: slopePct > 0.05 ? 'up' : slopePct < -0.05 ? 'down' : 'flat' },
    channel: {
      slopePct: round(channelSlopePct),
      positionPct: Math.round(channelPosition * 100),
      upper: round(channelUpper),
      lower: round(channelLower),
    },
    range: {
      high: round(high),
      low: round(low),
      widthPct: round(rangeWidthPct),
      positionPct: Math.round(rangePosition * 100),
      tight,
    },
    breakout: {
      up: breakoutUp,
      down: breakoutDown,
      level: round(breakoutUp ? priorHigh : breakoutDown ? priorLow : null),
      volumeConfirmed,
      volumeRatio: round(volumeRatio),
    },
    momentum: {
      rsi14: round(rsiNow, 1),
      rsiChange: round(rsiChange, 1),
      rsiTrend: rsiChange === null ? null : rsiChange > 0.5 ? 'rising' : rsiChange < -0.5 ? 'falling' : 'flat',
      macdHistogramPct: round(histPct, 3),
      macdRising,
      divergence,
    },
    volatility: { atrPct: round(atrPct), regime: volatilityRegime, squeeze },
    candle: {
      open: round(lastBar.open),
      close: round(lastBar.close),
      bodyPct: round(bodyPct, 0),
      upperWickPct: round(upperWickPct, 0),
      lowerWickPct: round(lowerWickPct, 0),
      patterns: candlePatterns,
      gap,
    },
    levels: {
      support: round(support),
      resistance: round(resistance),
      supportDistancePct: round(supportDistancePct, 1),
      resistanceDistancePct: round(resistanceDistancePct, 1),
    },
    volume: {
      ratio: round(volumeRatio),
      confirmed: volumeConfirmed,
      average: round(averageVolume, 0),
    },
    drivers,
    caveats,
  };
}

export const _internals = { findSwings, describeStructure, fitLine, valueAt };
