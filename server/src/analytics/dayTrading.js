import { adx, atr, ema, last, normalizedSlope, rsi } from './indicators.js';
import { HttpError } from '../lib/errors.js';

/**
 * Day-trading read on an intraday chart (default 1-hour bars).
 *
 * The model is deliberately simple and explainable: session VWAP, EMA9 vs
 * EMA20, RSI(14), ADX(14) trend strength, the first-hour range and relative
 * volume. It answers: long, short, or no trade — and if there is a trade, the
 * entry, stop and R-multiple targets.
 *
 * Three filters exist because a bare checklist over-calls:
 *  - a trendless tape (ADX below 18) damps every directional signal, so a
 *    range-bound day cannot publish a confident BUY / SELL;
 *  - structure tests are ATR-scaled, so a few cents around VWAP is not a trend;
 *  - the first-hour range has to be closed before an entry is published.
 */
const NY_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const NY_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const round = (value, digits = 2) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const f = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

const BAR_MINUTES = { '1m': 1, '2m': 2, '5m': 5, '15m': 15, '30m': 30, '60m': 60 };

/** The opening range is the first hour of the session, whatever the bar size. */
const OPENING_RANGE_MINUTES = 60;
/** Below this ADX the tape is range-bound, not trending. */
export const CHOP_ADX = 18;
const MIN_BARS = 30;

export const barMinutesFor = (interval) => BAR_MINUTES[String(interval)] ?? 5;

/** How many bars make up the first-hour range at this bar size (5m → 12, 1h → 1). */
export const openingRangeBars = (interval) =>
  clamp(Math.round(OPENING_RANGE_MINUTES / barMinutesFor(interval)), 1, 12);

const sessionKey = (iso) => NY_DATE.format(new Date(iso));

const minutesOfDay = (iso) => {
  const [hours, minutes] = NY_TIME.format(new Date(iso)).split(':').map(Number);
  return hours * 60 + minutes;
};

/** Regular US session only (09:30–16:00 New York), whatever the feed sends. */
const inRegularSession = (iso) => {
  const minutes = minutesOfDay(iso);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
};

function groupSessions(bars) {
  const groups = [];
  let current = null;
  for (const bar of bars) {
    const date = sessionKey(bar.date);
    if (!current || current.date !== date) {
      current = { date, bars: [] };
      groups.push(current);
    }
    current.bars.push(bar);
  }
  return groups;
}

/** VWAP, reset at the start of every session. Falls back to typical price. */
function buildVwap(bars) {
  let session = null;
  let priceVolume = 0;
  let volume = 0;
  return bars.map((bar) => {
    const key = sessionKey(bar.date);
    if (key !== session) {
      session = key;
      priceVolume = 0;
      volume = 0;
    }
    const typical = (bar.high + bar.low + bar.close) / 3;
    const barVolume = Math.max(0, Number(bar.volume) || 0);
    priceVolume += typical * barVolume;
    volume += barVolume;
    return volume > 0 ? priceVolume / volume : typical;
  });
}

const average = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

/**
 * Whole-day pattern read: the shape of the session, not just the latest bar.
 *
 * Day traders need to know what kind of day it is before the last hour means
 * anything: did it gap and go, trend all session, reverse, fail a breakout, or
 * stay in a range? The read covers the gap vs the prior close, the opening
 * drive, where the day's high and low printed (early / midday / late), how much
 * of the session traded above or below VWAP, the first-half vs second-half
 * move and where the close sits in the day range.
 *
 * This is evidence for the LLM desk, not a signal of its own: `bias` exists to
 * describe the day's lean, while the model still makes the BUY / SELL / WAIT
 * call. Pure and deterministic, so every branch is unit-tested.
 */
export function analyzeSessionPattern({ bars = [], priorBars = [], vwapSeries = [], atr: atrValue = null } = {}) {
  const clean = (Array.isArray(bars) ? bars : []).filter((bar) => bar && Number.isFinite(bar.close));
  if (clean.length < 2) return null;

  const open = Number.isFinite(clean[0].open) ? clean[0].open : clean[0].close;
  const close = clean[clean.length - 1].close;
  const high = Math.max(...clean.map((bar) => (Number.isFinite(bar.high) ? bar.high : bar.close)));
  const low = Math.min(...clean.map((bar) => (Number.isFinite(bar.low) ? bar.low : bar.close)));
  const prior = priorBars.filter((bar) => bar && Number.isFinite(bar.close));
  const priorClose = prior.length ? prior[prior.length - 1].close : null;

  const rangePct = open ? ((high - low) / open) * 100 : null;
  const changePct = open ? ((close - open) / open) * 100 : null;
  const gapPct = Number.isFinite(priorClose) && priorClose ? ((open - priorClose) / priorClose) * 100 : null;
  const closePositionPct = high > low ? clamp((close - low) / (high - low), 0, 1) * 100 : 50;

  const vwapPairs = clean
    .map((bar, index) => ({ close: bar.close, vwap: vwapSeries[index] }))
    .filter((pair) => Number.isFinite(pair.vwap) && pair.vwap > 0);
  const vwapTimeAbovePct = vwapPairs.length
    ? Math.round((vwapPairs.filter((pair) => pair.close >= pair.vwap).length / vwapPairs.length) * 100)
    : null;
  const vwapSide =
    vwapTimeAbovePct === null ? null : vwapTimeAbovePct >= 60 ? 'above' : vwapTimeAbovePct <= 40 ? 'below' : 'crossed';

  const midIndex = Math.floor((clean.length - 1) / 2);
  const midPrice = clean[midIndex].close;
  const firstHalfPct = open ? ((midPrice - open) / open) * 100 : null;
  const secondHalfPct = midPrice ? ((close - midPrice) / midPrice) * 100 : null;
  const slopePct = normalizedSlope(clean.map((bar) => bar.close));

  const highIndex = clean.findIndex((bar) => (Number.isFinite(bar.high) ? bar.high : bar.close) === high);
  const lowIndex = clean.findIndex((bar) => (Number.isFinite(bar.low) ? bar.low : bar.close) === low);
  const progressPct = (index) => (clean.length > 1 ? Math.round((Math.max(index, 0) / (clean.length - 1)) * 100) : 0);
  const highProgressPct = progressPct(highIndex);
  const lowProgressPct = progressPct(lowIndex);
  const timing = (progress) => (progress <= 35 ? 'early' : progress >= 65 ? 'late' : 'midday');
  const highTiming = timing(highProgressPct);
  const lowTiming = timing(lowProgressPct);

  const strongClose = closePositionPct >= 66;
  const weakClose = closePositionPct <= 34;
  const greenDay = close >= open;
  const gapUp = gapPct !== null && gapPct >= 0.3;
  const gapDown = gapPct !== null && gapPct <= -0.3;
  // Compare the day's range with what the bar size can deliver over a whole
  // session: n bars of typical range (ATR) sum to roughly ATR × √n, so a day
  // that stays inside ~80% of that never left a tight band. Comparing a 7-hour
  // session to a single hourly ATR would almost never call a range day.
  const expectedSessionRange =
    Number.isFinite(atrValue) && atrValue > 0 ? atrValue * Math.sqrt(clean.length) * 0.8 : null;
  const tightRange = expectedSessionRange !== null && high - low <= expectedSessionRange;

  let dayType = 'two-way';
  let label = 'Two-way day — neither side controlled the session';
  if (
    firstHalfPct !== null &&
    secondHalfPct !== null &&
    firstHalfPct <= -0.2 &&
    secondHalfPct >= 0.2 &&
    strongClose
  ) {
    dayType = 'reversal-up';
    label = 'Reversal day — sold off early, then bought back into the close';
  } else if (
    firstHalfPct !== null &&
    secondHalfPct !== null &&
    firstHalfPct >= 0.2 &&
    secondHalfPct <= -0.2 &&
    weakClose
  ) {
    dayType = 'reversal-down';
    label = 'Reversal day — rallied early, then sold into the close';
  } else if (strongClose && greenDay && (gapUp || slopePct > 0.01)) {
    dayType = gapUp ? 'gap-and-go-up' : 'trend-up';
    label = gapUp
      ? 'Gap-and-go day up — opened strong and held the highs'
      : 'Trend day up — buyers controlled the session';
  } else if (weakClose && !greenDay && (gapDown || slopePct < -0.01)) {
    dayType = gapDown ? 'gap-and-go-down' : 'trend-down';
    label = gapDown
      ? 'Gap-and-go day down — opened weak and kept the lows'
      : 'Trend day down — sellers controlled the session';
  } else if (strongClose && highTiming === 'late') {
    dayType = 'late-breakout-up';
    label = 'Late breakout — the day high printed into the close';
  } else if (weakClose && lowTiming === 'late') {
    dayType = 'late-breakdown';
    label = 'Late breakdown — the day low printed into the close';
  } else if (tightRange) {
    dayType = 'range-day';
    label = 'Range day — price never escaped a tight band';
  } else if (highTiming === 'early' && closePositionPct < 55) {
    dayType = 'failed-breakout';
    label = 'Failed breakout — the early high was sold all session';
  } else if (lowTiming === 'early' && closePositionPct > 45) {
    dayType = 'failed-breakdown';
    label = 'Failed breakdown — the early low was bought all session';
  }

  const biasScore = Math.round(
    clamp(
      0.45 * ((closePositionPct - 50) / 50) +
        0.25 * clamp(slopePct / 0.3, -1, 1) +
        0.2 * (((vwapTimeAbovePct ?? 50) - 50) / 50) +
        0.1 * clamp((secondHalfPct ?? 0) / 0.5, -1, 1),
      -1,
      1,
    ) * 100,
  );
  const bias = biasScore >= 30 ? 'bullish' : biasScore <= -30 ? 'bearish' : 'neutral';

  const summary =
    `${label}. Open ${f(open)}, range ${f(low)}–${f(high)} (${f(rangePct, 1)}% wide), close ${f(close)} at ` +
    `${Math.round(closePositionPct)}% of the day range` +
    (Number.isFinite(gapPct) ? `, ${gapPct >= 0 ? 'gap up' : 'gap down'} ${f(Math.abs(gapPct), 1)}% vs the prior close` : '') +
    `. First half ${firstHalfPct >= 0 ? '+' : ''}${f(firstHalfPct, 1)}%, second half ` +
    `${secondHalfPct >= 0 ? '+' : ''}${f(secondHalfPct, 1)}%; ` +
    (vwapTimeAbovePct === null
      ? 'session VWAP unavailable'
      : `price held above VWAP ${vwapTimeAbovePct}% of the session`) +
    `. The high printed ${highTiming} (${highProgressPct}% in), the low ${lowTiming} (${lowProgressPct}% in).`;

  const drivers = [];
  if (Number.isFinite(gapPct)) drivers.push(`${gapPct >= 0 ? 'Gap up' : 'Gap down'} ${f(Math.abs(gapPct), 1)}% vs the prior close.`);
  drivers.push(`Close sits at ${Math.round(closePositionPct)}% of the day range (${f(rangePct, 1)}% wide).`);
  if (vwapTimeAbovePct !== null) {
    drivers.push(`Price traded above session VWAP ${vwapTimeAbovePct}% of the day (${vwapSide}).`);
  }
  drivers.push(`High printed ${highTiming}, low printed ${lowTiming}; second half ${secondHalfPct >= 0 ? '+' : ''}${f(secondHalfPct, 1)}%.`);

  return {
    label,
    dayType,
    bias,
    biasScore,
    summary,
    drivers,
    open: round(open),
    high: round(high),
    low: round(low),
    close: round(close),
    changePct: round(changePct),
    gapPct: round(gapPct),
    rangePct: round(rangePct),
    closePositionPct: Math.round(closePositionPct),
    vwapSide,
    vwapTimeAbovePct,
    slopePct: round(slopePct, 3),
    firstHalfPct: round(firstHalfPct),
    secondHalfPct: round(secondHalfPct),
    highTiming,
    lowTiming,
    highProgressPct,
    lowProgressPct,
  };
}

/**
 * Transparent setup score: + is long, − is short. Exported so the rules can be
 * unit-tested without fabricating a whole intraday session.
 */
export function scoreSetup({
  price,
  vwap,
  ema9,
  ema20,
  rsi: rsiValue,
  openingRangeHigh,
  openingRangeLow,
  volumeRatio = null,
  priorClose = null,
  priorHigh = null,
  priorLow = null,
  adx: adxValue = null,
  atr: atrValue = null,
} = {}) {
  let score = 0;
  const reasons = [];

  // A fraction of an ATR around VWAP is noise, not a trend. Without an ATR the
  // raw side of the price still counts, so the rule stays usable on thin data.
  const atrUnit = Number.isFinite(atrValue) && atrValue > 0 ? atrValue : null;
  const vwapDistance = price - vwap;
  const vwapMeaningful = atrUnit ? Math.abs(vwapDistance) >= atrUnit * 0.15 : vwapDistance !== 0;
  const aboveVwap = vwapDistance >= 0;

  if (vwapMeaningful) {
    score += aboveVwap ? 2 : -2;
    reasons.push(aboveVwap ? 'Price is holding above session VWAP' : 'Price is trading below session VWAP');
  } else {
    reasons.push('Price is hugging VWAP — neither side controls the session');
  }

  const emaUptrend = ema9 >= ema20;
  score += emaUptrend ? 2 : -2;
  reasons.push(emaUptrend ? 'EMA9 is above EMA20 (short-term trend up)' : 'EMA9 is below EMA20 (short-term trend down)');

  if (rsiValue >= 55) {
    score += 1;
    reasons.push(`RSI ${round(rsiValue, 1)} — momentum with the long side`);
  } else if (rsiValue <= 45) {
    score -= 1;
    reasons.push(`RSI ${round(rsiValue, 1)} — momentum with the short side`);
  } else {
    reasons.push(`RSI ${round(rsiValue, 1)} — neutral momentum`);
  }
  if (rsiValue >= 78) score -= 1;
  if (rsiValue <= 22) score += 1;

  if (price > openingRangeHigh) {
    score += 2;
    reasons.push('Price is above the first-hour range');
  } else if (price < openingRangeLow) {
    score -= 2;
    reasons.push('Price is below the first-hour range');
  } else {
    reasons.push('Price is still inside the first-hour range');
  }

  if (volumeRatio !== null && volumeRatio >= 1.25) {
    reasons.push(`Recent volume is ${volumeRatio}× the recent average`);
    if (score > 0) score += 1;
    else if (score < 0) score -= 1;
  } else if (volumeRatio !== null && volumeRatio < 0.8) {
    // A breakout without participation is the classic false signal: fade it
    // instead of confirming it.
    if (score > 0) score -= 1;
    else if (score < 0) score += 1;
    reasons.push(`Volume is only ${volumeRatio}× the recent average — thin participation`);
  }

  const abovePriorClose = Number.isFinite(priorClose) ? price >= priorClose : null;
  if (abovePriorClose !== null) {
    score += abovePriorClose ? 1 : -1;
    reasons.push(abovePriorClose ? 'Price is above the previous session close' : 'Price is below the previous session close');
  }

  if (Number.isFinite(priorHigh) && price > priorHigh) {
    score += 1;
    reasons.push('Price is above the prior session high');
  } else if (Number.isFinite(priorLow) && price < priorLow) {
    score -= 1;
    reasons.push('Price is below the prior session low');
  }

  const trendless = Number.isFinite(adxValue) && adxValue < CHOP_ADX;
  if (Number.isFinite(adxValue)) {
    if (trendless) {
      // ADX under 18: ranges, not trends. Halve the directional read so a
      // range-bound tape cannot publish a confident BUY / SELL.
      score = Math.floor(score * 0.5);
      reasons.push(`ADX ${round(adxValue, 1)} — trendless, range-bound tape`);
    } else {
      reasons.push(`ADX ${round(adxValue, 1)} — ${adxValue >= 25 ? 'established trend' : 'trend building'}`);
    }
  }

  return { score, reasons, trendless };
}

/**
 * Confidence is deliberately asymmetric: a no-trade read stays below 60 so
 * noise is never dressed up as a 70% call, while actionable setups scale with
 * score strength, volume confirmation, trend strength and how many independent
 * factors agree.
 */
export function dayTradeConfidence({
  action,
  score,
  volumeRatio = null,
  adx: adxValue = null,
  confirmations = 0,
} = {}) {
  const strength = Math.abs(Number(score) || 0);
  if (action === 'wait') return clamp(Math.round(42 + strength * 2.5), 35, 60);
  const volumeBonus = Number.isFinite(Number(volumeRatio)) && Number(volumeRatio) >= 1.25 ? 5 : 0;
  const trendBonus = Number.isFinite(adxValue) ? (adxValue >= 25 ? 6 : adxValue >= CHOP_ADX ? 3 : 0) : 0;
  const confirmationBonus = clamp(Math.round(Number(confirmations) || 0), 0, 7);
  return clamp(Math.round(48 + strength * 4 + volumeBonus + trendBonus + confirmationBonus), 50, 90);
}

export function buildDayTrade({ quote = {}, history = {}, interval = '60m' } = {}) {
  const barMinutes = barMinutesFor(interval);
  const bars = (history.bars || []).filter((bar) => Number.isFinite(bar.close) && inRegularSession(bar.date));
  if (bars.length < MIN_BARS) {
    throw new HttpError(
      422,
      `Not enough ${interval} data for ${quote.symbol || 'this symbol'} yet — try again during the session.`,
    );
  }

  const groups = groupSessions(bars);
  const latest = groups[groups.length - 1];
  const prior = groups.length > 1 ? groups[groups.length - 2] : null;
  if (!latest || latest.bars.length < 2) {
    throw new HttpError(422, 'The current session has only just opened — wait for a few more bars.');
  }

  const closes = bars.map((bar) => bar.close);
  const ema9Series = ema(closes, 9);
  const ema20Series = ema(closes, 20);
  const rsiSeries = rsi(closes, 14);
  const atrSeries = atr(bars, 14);
  const adxSeries = adx(bars, 14);
  const vwapSeries = buildVwap(bars);

  const price = Number(quote.price) || latest.bars[latest.bars.length - 1].close;
  const vwap = vwapSeries[vwapSeries.length - 1];
  const latestOffset = bars.length - latest.bars.length;
  const ema9Value = last(ema9Series) ?? price;
  const ema20Value = last(ema20Series) ?? price;
  const rsiValue = last(rsiSeries) ?? 50;
  const atrValue = last(atrSeries) ?? price * 0.01;
  const adxValue = last(adxSeries.adx);

  const orBars = openingRangeBars(interval);
  const openingBars = latest.bars.slice(0, orBars);
  const openingRangeHigh = Math.max(...openingBars.map((bar) => bar.high));
  const openingRangeLow = Math.min(...openingBars.map((bar) => bar.low));
  // The range is only usable once the first hour has closed and price has
  // traded after it; during the first hour the range is still forming.
  const openingRangeComplete = latest.bars.length > orBars;

  const sessionHigh = Math.max(...latest.bars.map((bar) => bar.high));
  const sessionLow = Math.min(...latest.bars.map((bar) => bar.low));
  const priorHigh = prior ? Math.max(...prior.bars.map((bar) => bar.high)) : null;
  const priorLow = prior ? Math.min(...prior.bars.map((bar) => bar.low)) : null;
  const priorClose = prior ? prior.bars[prior.bars.length - 1].close : quote.previousClose ?? null;

  // Relative volume compares the last two bars with the 20 before them, so an
  // early-session read is not diluted by a whole prior session's average.
  const recentBars = latest.bars.slice(-2);
  const recentVolume = average(recentBars.map((bar) => bar.volume || 0));
  const baselineEnd = Math.max(bars.length - 2, 0);
  const baselineBars = bars.slice(Math.max(0, baselineEnd - 20), baselineEnd);
  const baselineVolume = average(baselineBars.map((bar) => bar.volume || 0));
  const volumeRatio = baselineVolume > 0 ? round(recentVolume / baselineVolume, 2) : null;

  const aboveVwap = price >= vwap;
  const emaUptrend = ema9Value >= ema20Value;
  const { score, reasons, trendless } = scoreSetup({
    price,
    vwap,
    ema9: ema9Value,
    ema20: ema20Value,
    rsi: rsiValue,
    openingRangeHigh,
    openingRangeLow,
    volumeRatio,
    priorClose,
    priorHigh,
    priorLow,
    adx: adxValue,
    atr: atrValue,
  });

  // A range-bound tape needs more agreement before it is allowed to trade.
  const threshold = trendless ? 5 : 4;
  let action = 'wait';
  if (score >= threshold) action = 'buy';
  else if (score <= -threshold) action = 'sell';

  if (!openingRangeComplete && action !== 'wait') {
    action = 'wait';
    reasons.push('The first-hour range is still forming — no entries until it closes');
  }

  const direction = action === 'buy' ? 1 : action === 'sell' ? -1 : 0;
  const volumeConfirmed = Number.isFinite(Number(volumeRatio)) && Number(volumeRatio) >= 1.25;
  const confirmations =
    direction === 0
      ? 0
      : [
          direction > 0 ? aboveVwap : !aboveVwap,
          direction > 0 ? emaUptrend : !emaUptrend,
          direction > 0 ? rsiValue >= 55 : rsiValue <= 45,
          direction > 0 ? price > openingRangeHigh : price < openingRangeLow,
          volumeConfirmed,
          Number.isFinite(priorClose) ? (direction > 0 ? price >= priorClose : price < priorClose) : false,
          Number.isFinite(adxValue) && adxValue >= CHOP_ADX,
        ].filter(Boolean).length;

  const confidence = dayTradeConfidence({ action, score, volumeRatio, adx: adxValue, confirmations });

  // ---------- Trade plan ----------
  const atrFloor = Math.max(atrValue * 0.8, price * 0.0025);
  let plan = null;

  if (action !== 'wait') {
    const planDirection = action === 'buy' ? 'long' : 'short';
    let stopLoss = planDirection === 'long' ? price - atrFloor : price + atrFloor;

    if (planDirection === 'long') {
      if (vwap < price) stopLoss = Math.min(stopLoss, vwap - atrValue * 0.15);
      if (openingRangeLow < price && price - openingRangeLow < atrValue * 1.6) {
        stopLoss = Math.min(stopLoss, openingRangeLow - atrValue * 0.1);
      }
      // A day-trade stop should never be wider than 2% from entry.
      stopLoss = Math.max(stopLoss, price * 0.98);
    } else {
      if (vwap > price) stopLoss = Math.max(stopLoss, vwap + atrValue * 0.15);
      if (openingRangeHigh > price && openingRangeHigh - price < atrValue * 1.6) {
        stopLoss = Math.max(stopLoss, openingRangeHigh + atrValue * 0.1);
      }
      stopLoss = Math.min(stopLoss, price * 1.02);
    }

    // Rounding to cents can collapse the stop onto the entry on low-priced
    // names, publishing a "0R" plan whose targets all equal the entry. Keep at
    // least one cent (or 0.1% on larger prices) of distance.
    const minRisk = Math.max(price * 0.001, 0.01);
    stopLoss =
      planDirection === 'long' ? Math.min(stopLoss, price - minRisk) : Math.max(stopLoss, price + minRisk);
    stopLoss = round(stopLoss);
    const riskPerShare = round(Math.abs(price - stopLoss));
    const targets = [1.5, 2.5, 4].map((multiple, index) => {
      const target = planDirection === 'long' ? price + riskPerShare * multiple : price - riskPerShare * multiple;
      return {
        label: `T${index + 1}`,
        price: round(target),
        rMultiple: multiple,
        movePct: round(((target - price) / price) * 100, 2),
      };
    });

    plan = {
      direction: planDirection,
      entry: round(price),
      stopLoss,
      riskPerShare,
      targets,
      riskReward: 2.5,
      invalidation:
        planDirection === 'long'
          ? 'An hourly close back below VWAP or the stop ends the long read.'
          : 'An hourly close back above VWAP or the stop ends the short read.',
    };
  }

  const triggers = {
    buyAbove: round(openingRangeHigh),
    sellBelow: round(openingRangeLow),
    note: 'First-hour range breakout levels — wait for an hourly candle to close beyond the level, not just a wick.',
  };

  // Whole-day shape: what kind of session is this, where did the extremes
  // print and which side held VWAP. The LLM desk reads it before the last bar.
  const sessionPattern = analyzeSessionPattern({
    bars: latest.bars,
    priorBars: prior ? prior.bars : [],
    vwapSeries: vwapSeries.slice(latestOffset),
    atr: atrValue,
  });

  // ---------- Chart payload: recent sessions, aligned overlays ----------
  const chartSessionCount = barMinutes >= 60 ? 5 : 2;
  const chartGroups = groups.slice(-chartSessionCount);
  const chartBarCount = chartGroups.reduce((sum, group) => sum + group.bars.length, 0);
  const offset = bars.length - chartBarCount;
  const sessionStarts = [0];
  if (chartGroups.length === 2) sessionStarts.push(chartGroups[0].bars.length);
  if (chartGroups.length > 2) {
    let running = 0;
    for (let index = 0; index < chartGroups.length - 1; index += 1) {
      running += chartGroups[index].bars.length;
      sessionStarts.push(running);
    }
  }

  const risks = [
    'Hourly bars smooth the noise but still lag a fast reversal; the stop is part of the trade, not optional.',
    'News, halts or a gap can invalidate the read between candles.',
    'This model reads price and volume only — it does not know your position or risk budget.',
  ];

  return {
    symbol: quote.symbol,
    name: quote.name || quote.symbol,
    quoteType: quote.quoteType || 'EQUITY',
    exchange: quote.exchange || null,
    marketState: quote.marketState || null,
    price: round(price),
    changePercent: quote.changePercent ?? null,
    previousClose: round(priorClose),
    interval,
    generatedAt: new Date().toISOString(),
    session: {
      date: latest.date,
      bars: latest.bars.length,
      barMinutes,
      openingRangeMinutes: orBars * barMinutes,
      open: round(latest.bars[0].open),
      high: round(sessionHigh),
      low: round(sessionLow),
      vwap: round(vwap),
      openingRangeComplete,
      lastBarAt: latest.bars[latest.bars.length - 1].date,
    },
    levels: {
      vwap: round(vwap),
      ema9: round(ema9Value),
      ema20: round(ema20Value),
      openingRangeHigh: round(openingRangeHigh),
      openingRangeLow: round(openingRangeLow),
      sessionHigh: round(sessionHigh),
      sessionLow: round(sessionLow),
      priorHigh: round(priorHigh),
      priorLow: round(priorLow),
      priorClose: round(priorClose),
    },
    indicators: {
      rsi14: round(rsiValue, 1),
      adx14: round(adxValue, 1),
      chop: trendless,
      atr14: round(atrValue),
      atrPct: round((atrValue / price) * 100, 2),
      volumeRatio,
      vwapDistancePct: vwap ? round(((price - vwap) / vwap) * 100, 2) : null,
      aboveVwap,
      ema9Above20: emaUptrend,
    },
    sessionPattern,
    action,
    actionLabel: action === 'buy' ? 'Buy' : action === 'sell' ? 'Sell' : 'Wait',
    score,
    confidence,
    confirmations,
    reasons,
    risks,
    plan,
    triggers,
    chart: {
      interval,
      bars: bars.slice(offset),
      overlays: {
        vwap: vwapSeries.slice(offset),
        ema9: ema9Series.slice(offset),
        ema20: ema20Series.slice(offset),
      },
      rsi: rsiSeries.slice(offset),
      sessionStarts,
    },
  };
}
