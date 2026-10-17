/**
 * Pure technical-analysis primitives. Every function returns an array aligned
 * to the input length with `null` during warm-up, which keeps chart overlays
 * and the latest-value reads trivially consistent.
 */

export const last = (arr) => {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i] !== null && arr[i] !== undefined && Number.isFinite(arr[i])) return arr[i];
  }
  return null;
};

export const lastIndex = (arr) => {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(arr[i])) return i;
  }
  return -1;
};

export function sma(values, period) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i += 1) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes, period = 14) {
  const out = Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const toRsi = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) =>
    fastEma[i] !== null && slowEma[i] !== null ? fastEma[i] - slowEma[i] : null,
  );
  const compact = line.filter((value) => value !== null);
  const signalCompact = ema(compact, signalPeriod);
  const signal = Array(closes.length).fill(null);
  const offset = closes.length - compact.length;
  for (let i = 0; i < signalCompact.length; i += 1) {
    signal[offset + i] = signalCompact[i];
  }
  const histogram = closes.map((_, i) =>
    line[i] !== null && signal[i] !== null ? line[i] - signal[i] : null,
  );
  return { line, signal, histogram };
}

export function trueRange(bars) {
  return bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = bars[i - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose),
    );
  });
}

export function atr(bars, period = 14) {
  const tr = trueRange(bars);
  const out = Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < tr.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = Array(closes.length).fill(null);
  const lower = Array(closes.length).fill(null);
  const width = Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i += 1) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = window.reduce((acc, value) => acc + (value - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
    width[i] = mean ? ((upper[i] - lower[i]) / mean) * 100 : null;
  }
  return { mid, upper, lower, width };
}

export function stochastic(bars, kPeriod = 14, kSmooth = 3, dPeriod = 3) {
  const raw = bars.map((bar, i) => {
    if (i < kPeriod - 1) return null;
    const window = bars.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...window.map((b) => b.high));
    const lowest = Math.min(...window.map((b) => b.low));
    if (highest === lowest) return 50;
    return ((bar.close - lowest) / (highest - lowest)) * 100;
  });
  const compact = raw.filter((value) => value !== null);
  const smoothed = sma(compact, kSmooth);
  const k = Array(bars.length).fill(null);
  const offset = bars.length - compact.length;
  for (let i = 0; i < smoothed.length; i += 1) k[offset + i] = smoothed[i];
  const kCompact = k.filter((value) => value !== null);
  const dCompact = sma(kCompact, dPeriod);
  const d = Array(bars.length).fill(null);
  const dOffset = bars.length - dCompact.length;
  for (let i = 0; i < dCompact.length; i += 1) d[dOffset + i] = dCompact[i];
  return { k, d };
}

/** Wilder ADX / +DI / -DI. */
export function adx(bars, period = 14) {
  const out = { adx: Array(bars.length).fill(null), plusDI: Array(bars.length).fill(null), minusDI: Array(bars.length).fill(null) };
  if (bars.length < period * 2) return out;

  const plusDM = Array(bars.length).fill(0);
  const minusDM = Array(bars.length).fill(0);
  const tr = trueRange(bars);

  for (let i = 1; i < bars.length; i += 1) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  let trSum = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let plusSum = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let minusSum = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);

  const dx = Array(bars.length).fill(null);
  const plusDI = out.plusDI;
  const minusDI = out.minusDI;

  for (let i = period; i < bars.length; i += 1) {
    if (i > period) {
      trSum = trSum - trSum / period + tr[i];
      plusSum = plusSum - plusSum / period + plusDM[i];
      minusSum = minusSum - minusSum / period + minusDM[i];
    }
    plusDI[i] = trSum ? (plusSum / trSum) * 100 : 0;
    minusDI[i] = trSum ? (minusSum / trSum) * 100 : 0;
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum ? (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100 : 0;
  }

  let adxValue = null;
  for (let i = period * 2 - 1; i < bars.length; i += 1) {
    if (i === period * 2 - 1) {
      const seed = dx.slice(period, i + 1).filter((v) => v !== null);
      adxValue = seed.reduce((a, b) => a + b, 0) / seed.length;
    } else {
      adxValue = (adxValue * (period - 1) + dx[i]) / period;
    }
    out.adx[i] = adxValue;
  }
  return out;
}

export function obv(bars) {
  const out = Array(bars.length).fill(null);
  let running = 0;
  for (let i = 0; i < bars.length; i += 1) {
    if (i > 0) {
      if (bars[i].close > bars[i - 1].close) running += bars[i].volume;
      else if (bars[i].close < bars[i - 1].close) running -= bars[i].volume;
    }
    out[i] = running;
  }
  return out;
}

/** Least-squares slope normalised as % of the mean level. */
export function normalizedSlope(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 3) return 0;
  const n = clean.length;
  const meanX = (n - 1) / 2;
  const meanY = clean.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (clean[i] - meanY);
    den += (i - meanX) ** 2;
  }
  if (!den || !meanY) return 0;
  return ((num / den) / Math.abs(meanY)) * 100;
}

export function annualizedVolatility(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const returns = [];
  for (let i = closes.length - period; i < closes.length; i += 1) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** Max drawdown of the window as a percentage. */
export function maxDrawdown(closes) {
  let peak = closes[0] ?? 0;
  let worst = 0;
  for (const value of closes) {
    peak = Math.max(peak, value);
    if (peak) worst = Math.min(worst, (value - peak) / peak);
  }
  return worst * 100;
}

export function pctChange(closes, days) {
  if (closes.length <= days) return null;
  const from = closes[closes.length - 1 - days];
  const to = closes[closes.length - 1];
  if (!from) return null;
  return ((to - from) / from) * 100;
}

/** Cluster pivot highs/lows into support/resistance zones. */
export function pivotLevels(bars, { left = 5, right = 5, tolerancePct = 1.2 } = {}) {
  const highs = [];
  const lows = [];
  for (let i = left; i < bars.length - right; i += 1) {
    const window = bars.slice(i - left, i + right + 1);
    const high = bars[i].high;
    const low = bars[i].low;
    if (window.every((bar, offset) => offset === left || bar.high <= high)) highs.push(high);
    if (window.every((bar, offset) => offset === left || bar.low >= low)) lows.push(low);
  }

  const cluster = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const groups = [];
    for (const value of sorted) {
      const group = groups[groups.length - 1];
      if (group && Math.abs(value - group.level) / group.level <= tolerancePct / 100) {
        group.values.push(value);
        group.level = group.values.reduce((a, b) => a + b, 0) / group.values.length;
        group.touches += 1;
      } else {
        groups.push({ level: value, values: [value], touches: 1 });
      }
    }
    return groups
      .filter((group) => group.touches >= 1)
      .map((group) => ({ level: Number(group.level.toFixed(2)), touches: group.touches }))
      .sort((a, b) => b.touches - a.touches || b.level - a.level);
  };

  return { highs: cluster(highs), lows: cluster(lows) };
}
