import { atr, ema, last, rsi } from './indicators.js';
import { HttpError } from '../lib/errors.js';

/**
 * Day-trading read on an intraday chart (default 5-minute bars).
 *
 * The model is deliberately simple and explainable, because intraday signals
 * are noisy: session VWAP, EMA9 vs EMA20, RSI(14), the 30-minute opening range
 * and relative volume. It answers: long, short, or no trade — and if there is a
 * trade, the entry, stop and R-multiple targets.
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

const OPENING_RANGE_BARS = 6; // 6 × 5m = the first 30 minutes

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
} = {}) {
  let score = 0;
  const reasons = [];
  const aboveVwap = price >= vwap;
  const abovePriorClose = Number.isFinite(priorClose) ? price >= priorClose : null;

  score += aboveVwap ? 2 : -2;
  reasons.push(aboveVwap ? 'Price is holding above session VWAP' : 'Price is trading below session VWAP');

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
    reasons.push('Price is above the 30-minute opening range');
  } else if (price < openingRangeLow) {
    score -= 2;
    reasons.push('Price is below the 30-minute opening range');
  } else {
    reasons.push('Price is still inside the 30-minute opening range');
  }

  if (volumeRatio !== null && volumeRatio >= 1.25) {
    reasons.push(`Recent volume is ${volumeRatio}× the session average`);
    if (score > 0) score += 1;
    else if (score < 0) score -= 1;
  }

  if (abovePriorClose !== null) {
    score += abovePriorClose ? 1 : -1;
    reasons.push(abovePriorClose ? 'Price is above the previous session close' : 'Price is below the previous session close');
  }

  return { score, reasons };
}

/**
 * Confidence is deliberately asymmetric: a no-trade read stays below 60 so
 * noise is never dressed up as a 70% call, while actionable setups scale with
 * score strength and volume confirmation.
 */
export function dayTradeConfidence({ action, score, volumeRatio = null } = {}) {
  if (action === 'wait') return clamp(Math.round(45 + Math.abs(score) * 3), 40, 60);
  return clamp(Math.round(50 + Math.abs(score) * 5 + (volumeRatio !== null && volumeRatio >= 1.25 ? 4 : 0)), 55, 92);
}

export function buildDayTrade({ quote = {}, history = {}, interval = '5m' } = {}) {
  const bars = (history.bars || []).filter((bar) => Number.isFinite(bar.close) && inRegularSession(bar.date));
  if (bars.length < 30) {
    throw new HttpError(422, `Not enough intraday data for ${quote.symbol || 'this symbol'} yet — try again during the session.`);
  }

  const groups = groupSessions(bars);
  const latest = groups[groups.length - 1];
  const prior = groups.length > 1 ? groups[groups.length - 2] : null;
  if (!latest || latest.bars.length < 3) {
    throw new HttpError(422, 'The current session has only just opened — give it a few minutes.');
  }

  const closes = bars.map((bar) => bar.close);
  const ema9Series = ema(closes, 9);
  const ema20Series = ema(closes, 20);
  const rsiSeries = rsi(closes, 14);
  const atrSeries = atr(bars, 14);
  const vwapSeries = buildVwap(bars);

  const price = Number(quote.price) || latest.bars[latest.bars.length - 1].close;
  const vwap = vwapSeries[vwapSeries.length - 1];
  const ema9Value = last(ema9Series) ?? price;
  const ema20Value = last(ema20Series) ?? price;
  const rsiValue = last(rsiSeries) ?? 50;
  const atrValue = last(atrSeries) ?? price * 0.01;

  const openingBars = latest.bars.slice(0, OPENING_RANGE_BARS);
  const openingRangeHigh = Math.max(...openingBars.map((bar) => bar.high));
  const openingRangeLow = Math.min(...openingBars.map((bar) => bar.low));
  const openingRangeComplete = latest.bars.length >= OPENING_RANGE_BARS;

  const sessionHigh = Math.max(...latest.bars.map((bar) => bar.high));
  const sessionLow = Math.min(...latest.bars.map((bar) => bar.low));
  const priorHigh = prior ? Math.max(...prior.bars.map((bar) => bar.high)) : null;
  const priorLow = prior ? Math.min(...prior.bars.map((bar) => bar.low)) : null;
  const priorClose = prior ? prior.bars[prior.bars.length - 1].close : quote.previousClose ?? null;

  const recentVolume = average(latest.bars.slice(-3).map((bar) => bar.volume || 0));
  const sessionVolume = average(latest.bars.map((bar) => bar.volume || 0));
  const volumeRatio = sessionVolume > 0 ? round(recentVolume / sessionVolume, 2) : null;

  const aboveVwap = price >= vwap;
  const emaUptrend = ema9Value >= ema20Value;
  const { score, reasons } = scoreSetup({
    price,
    vwap,
    ema9: ema9Value,
    ema20: ema20Value,
    rsi: rsiValue,
    openingRangeHigh,
    openingRangeLow,
    volumeRatio,
    priorClose,
  });

  let action = 'wait';
  if (score >= 4) action = 'buy';
  else if (score <= -4) action = 'sell';

  const confidence = dayTradeConfidence({ action, score, volumeRatio });

  // ---------- Trade plan ----------
  const atrFloor = Math.max(atrValue * 0.8, price * 0.0025);
  let plan = null;

  if (action !== 'wait') {
    const direction = action === 'buy' ? 'long' : 'short';
    let stopLoss = direction === 'long' ? price - atrFloor : price + atrFloor;

    if (direction === 'long') {
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

    stopLoss = round(stopLoss);
    const riskPerShare = round(Math.abs(price - stopLoss));
    const targets = [1.5, 2.5, 4].map((multiple, index) => {
      const target = direction === 'long' ? price + riskPerShare * multiple : price - riskPerShare * multiple;
      return {
        label: `T${index + 1}`,
        price: round(target),
        rMultiple: multiple,
        movePct: round(((target - price) / price) * 100, 2),
      };
    });

    plan = {
      direction,
      entry: round(price),
      stopLoss,
      riskPerShare,
      targets,
      riskReward: 2.5,
      invalidation:
        direction === 'long'
          ? 'A close back below VWAP or the stop ends the long read.'
          : 'A close back above VWAP or the stop ends the short read.',
    };
  }

  const triggers = {
    buyAbove: round(openingRangeHigh),
    sellBelow: round(openingRangeLow),
    note: 'Opening-range breakout levels; wait for a candle close, not just a wick.',
  };

  // ---------- Chart payload: last two sessions, aligned overlays ----------
  const chartGroups = groups.slice(-2);
  const chartBarCount = chartGroups.reduce((sum, group) => sum + group.bars.length, 0);
  const offset = bars.length - chartBarCount;
  const sessionStarts = [0];
  if (chartGroups.length === 2) sessionStarts.push(chartGroups[0].bars.length);

  const risks = [
    'Intraday signals are noisy; the stop is part of the trade, not optional.',
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
      atr14: round(atrValue),
      atrPct: round((atrValue / price) * 100, 2),
      volumeRatio,
      vwapDistancePct: vwap ? round(((price - vwap) / vwap) * 100, 2) : null,
      aboveVwap,
      ema9Above20: emaUptrend,
    },
    action,
    actionLabel: action === 'buy' ? 'Buy' : action === 'sell' ? 'Sell' : 'Wait',
    score,
    confidence,
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
