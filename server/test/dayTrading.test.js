import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSessionPattern,
  buildDayTrade,
  dayTradeConfidence,
  scoreSetup,
} from '../src/analytics/dayTrading.js';
import {
  DAY_TRADE_UNIVERSE,
  boardCandidateScore,
  isReputableInstrument,
  isUsVenue,
} from '../src/services/dayTradeService.js';

const BARS_PER_SESSION = 7; // 09:30–15:30 New York in 1-hour bars
const SESSION_DATES = ['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'];

function makeSession(date, startPrice, step, { bars = BARS_PER_SESSION, volume = 100_000, startOffsetMinutes = 0, wick = 0.02 } = {}) {
  const start = new Date(`${date}T13:30:00.000Z`).getTime() + startOffsetMinutes * 60_000; // 09:30 New York (EDT)
  return Array.from({ length: bars }, (_, index) => {
    const close = startPrice + step * index;
    const open = startPrice + step * (index - 0.3);
    return {
      date: new Date(start + index * 60 * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + Math.abs(step) * 0.8 + wick,
      low: Math.min(open, close) - Math.abs(step) * 0.8 - wick,
      close,
      volume,
    };
  });
}

const makeSessions = (dates, startPrice, step, options = {}) =>
  dates.flatMap((date, index) => makeSession(date, startPrice + index * step * BARS_PER_SESSION, step, options));

/** Alternating bars: directional movement flips every hour, so ADX stays low. */
function makeChopSessions(dates, base, amplitude) {
  return dates.flatMap((date) => {
    const start = new Date(`${date}T13:30:00.000Z`).getTime();
    return Array.from({ length: BARS_PER_SESSION }, (_, index) => {
      const up = index % 2 === 0;
      const close = base + (up ? amplitude : -amplitude);
      const open = base + (up ? -amplitude : amplitude);
      return {
        date: new Date(start + index * 60 * 60_000).toISOString(),
        open,
        high: Math.max(open, close) + amplitude * 0.5,
        low: Math.min(open, close) - amplitude * 0.5,
        close,
        volume: 100_000,
      };
    });
  });
}

const quoteFor = (bars, symbol = 'TEST') => ({
  symbol,
  name: 'Test Corp.',
  quoteType: 'EQUITY',
  exchange: 'NasdaqGS',
  marketState: 'REGULAR',
  price: bars[bars.length - 1].close,
  previousClose: bars[BARS_PER_SESSION - 1].close,
  changePercent: 1.1,
});

test('an uptrend above VWAP produces a long plan with R-multiple targets', () => {
  const bars = makeSessions(SESSION_DATES, 100, 0.05);
  const result = buildDayTrade({ quote: quoteFor(bars), history: { bars } });

  assert.equal(result.interval, '60m');
  assert.equal(result.action, 'buy');
  assert.equal(result.plan.direction, 'long');
  assert.ok(result.plan.entry > 0);
  assert.ok(result.plan.stopLoss < result.plan.entry);
  assert.ok(result.plan.riskPerShare > 0);
  assert.equal(result.plan.targets.length, 3);
  for (const target of result.plan.targets) {
    assert.ok(target.price > result.plan.entry, `${target.label} above entry`);
    assert.ok(target.movePct > 0);
  }
  assert.deepEqual(
    result.plan.targets.map((target) => target.rMultiple),
    [1.5, 2.5, 4],
  );
  assert.ok(result.plan.riskReward >= 1);
  assert.ok(result.confidence >= 60);
  assert.ok(result.reasons.length >= 5);
  assert.ok(result.levels.vwap > 100);
  assert.equal(result.session.barMinutes, 60);
  assert.equal(result.session.openingRangeComplete, true);
  assert.ok(result.sessionPattern, 'the read must describe the whole session');
  assert.equal(result.sessionPattern.dayType, 'trend-up');
  assert.equal(result.sessionPattern.vwapSide, 'above');
  // Five hourly sessions of context, so the chart is not a 14-candle stub.
  assert.equal(result.chart.sessionStarts.length, 5);
  assert.equal(result.chart.sessionStarts[0], 0);
  assert.ok(result.chart.bars.length <= bars.length);
});

test('a downtrend below VWAP produces a short plan with downside targets', () => {
  const bars = makeSessions(SESSION_DATES, 120, -0.05);
  const result = buildDayTrade({ quote: quoteFor(bars), history: { bars } });

  assert.equal(result.action, 'sell');
  assert.equal(result.plan.direction, 'short');
  assert.ok(result.plan.stopLoss > result.plan.entry);
  assert.ok(result.plan.riskPerShare > 0);
  for (const target of result.plan.targets) {
    assert.ok(target.price < result.plan.entry, `${target.label} below entry`);
    assert.ok(target.movePct < 0);
  }
});

test('a low-priced name still gets a non-zero risk plan', () => {
  // At ~$0.80, rounding the stop to cents used to land it on the entry price
  // and publish a plan with 0 risk and three identical targets.
  const bars = makeSessions(SESSION_DATES, 0.78, 0.001, { wick: 0.0005 });
  const result = buildDayTrade({ quote: quoteFor(bars), history: { bars } });

  assert.ok(result.plan, 'expected an actionable plan');
  assert.ok(result.plan.riskPerShare > 0, `risk/share was ${result.plan.riskPerShare}`);
  for (const target of result.plan.targets) {
    assert.ok(target.price > result.plan.entry, `${target.label} must sit above the entry`);
  }
});

test('scoreSetup separates long, short and no-trade conditions', () => {
  const bullish = scoreSetup({
    price: 108,
    vwap: 106,
    ema9: 107.2,
    ema20: 106.5,
    rsi: 62,
    openingRangeHigh: 104,
    openingRangeLow: 103,
    volumeRatio: 1.6,
    priorClose: 103,
  });
  assert.ok(bullish.score >= 7, `expected a strong long score, got ${bullish.score}`);

  const bearish = scoreSetup({
    price: 92,
    vwap: 95,
    ema9: 93,
    ema20: 94,
    rsi: 38,
    openingRangeHigh: 98,
    openingRangeLow: 96,
    volumeRatio: 1.5,
    priorClose: 97,
  });
  assert.ok(bearish.score <= -7, `expected a strong short score, got ${bearish.score}`);

  const neutral = scoreSetup({
    price: 99.9,
    vwap: 100,
    ema9: 100.1,
    ema20: 100,
    rsi: 50,
    openingRangeHigh: 101,
    openingRangeLow: 99,
    volumeRatio: 1,
    priorClose: 100.5,
  });
  assert.ok(Math.abs(neutral.score) < 4, `expected no trade, got ${neutral.score}`);
});

test('the whole-day pattern names the session shape, the gap and the VWAP side', () => {
  const closes = [100, 99.4, 98.8, 98, 99.2, 100.8, 102];
  const reversalBars = closes.map((close, index) => ({
    date: `2026-10-15T${String(13 + index).padStart(2, '0')}:30:00.000Z`,
    open: index ? closes[index - 1] : 100,
    high: Math.max(close, index ? closes[index - 1] : 100) + 0.05,
    low: Math.min(close, index ? closes[index - 1] : 100) - 0.05,
    close,
    volume: 100_000,
  }));
  const reversal = analyzeSessionPattern({
    bars: reversalBars,
    priorBars: [{ close: 95 }],
    vwapSeries: reversalBars.map(() => 99.4),
  });
  assert.equal(reversal.dayType, 'reversal-up');
  assert.equal(reversal.bias, 'bullish');
  assert.ok(reversal.gapPct > 5, `expected a gap up, got ${reversal.gapPct}`);
  assert.ok(reversal.closePositionPct >= 66);
  assert.ok(reversal.secondHalfPct > 0);
  assert.ok(reversal.summary.includes('Reversal day'));

  // A tight, directionless tape is a range day, not a "failed breakout".
  const flatBars = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-10-16T${String(13 + index).padStart(2, '0')}:30:00.000Z`,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100 + (index % 2 ? 0.1 : -0.1),
    volume: 100_000,
  }));
  const range = analyzeSessionPattern({
    bars: flatBars,
    vwapSeries: flatBars.map(() => 100),
    atr: 1.5,
  });
  assert.equal(range.dayType, 'range-day');
  assert.equal(range.bias, 'neutral');
});

test('a range-bound tape is damped and cannot publish a forecast', () => {
  const base = {
    price: 108,
    vwap: 106,
    ema9: 107.2,
    ema20: 106.5,
    rsi: 62,
    openingRangeHigh: 104,
    openingRangeLow: 103,
    volumeRatio: 1.6,
    priorClose: 103,
  };
  const trending = scoreSetup({ ...base, adx: 30 });
  const chopping = scoreSetup({ ...base, adx: 11 });

  assert.equal(trending.trendless, false);
  assert.equal(chopping.trendless, true);
  assert.ok(chopping.score < trending.score, 'chop must score below a real trend');
  assert.ok(chopping.score < 5, `a chop read must stay below the entry threshold, got ${chopping.score}`);

  const bars = makeChopSessions(SESSION_DATES, 100, 0.4);
  const result = buildDayTrade({ quote: quoteFor(bars), history: { bars } });
  assert.equal(result.indicators.chop, true, 'alternating bars are a trendless tape');
  assert.equal(result.action, 'wait');
  assert.equal(result.plan, null);
});

test('overbought RSI is penalised rather than chased', () => {
  const base = {
    price: 108,
    vwap: 106,
    ema9: 107.2,
    ema20: 106.5,
    openingRangeHigh: 104,
    openingRangeLow: 103,
    volumeRatio: 1.6,
    priorClose: 103,
  };
  const healthy = scoreSetup({ ...base, rsi: 62 });
  const overbought = scoreSetup({ ...base, rsi: 84 });
  assert.ok(overbought.score < healthy.score);
});

test('thin volume fades a breakout instead of confirming it', () => {
  const base = {
    price: 108,
    vwap: 106,
    ema9: 107.2,
    ema20: 106.5,
    rsi: 62,
    openingRangeHigh: 104,
    openingRangeLow: 103,
    priorClose: 103,
  };
  const confirmed = scoreSetup({ ...base, volumeRatio: 1.8 });
  const thin = scoreSetup({ ...base, volumeRatio: 0.5 });
  assert.ok(thin.score < confirmed.score);
});

test('VWAP and the first-hour range come from the latest session only', () => {
  const prior = makeSessions(['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13'], 50, 0.01);
  const firstHour = {
    date: '2026-10-14T13:30:00.000Z',
    open: 100,
    high: 102,
    low: 99,
    close: 100.5,
    volume: 100_000,
  };
  const rest = makeSession('2026-10-14', 110, 0.01, { bars: 6, startOffsetMinutes: 60 });
  const bars = [...prior, firstHour, ...rest];
  const result = buildDayTrade({ quote: quoteFor(bars), history: { bars } });

  assert.ok(result.levels.vwap > 100, 'VWAP must reset at the new session, not average the prior day');
  assert.ok(result.levels.openingRangeHigh <= 102.01);
  assert.ok(result.levels.openingRangeLow >= 98.99);
});

test('pre-market bars are ignored', () => {
  const bars = makeSessions(SESSION_DATES, 100, 0.02);
  bars.push({
    date: '2026-10-15T12:00:00.000Z', // 08:00 New York
    open: 500,
    high: 999,
    low: 1,
    close: 500,
    volume: 1,
  });
  const result = buildDayTrade({ quote: quoteFor(bars), history: { bars } });
  assert.ok(result.session.high < 999, 'pre-market spike must not set the session high');
  assert.ok(result.chart.bars.every((bar) => new Date(bar.date).getUTCHours() >= 13));
});

test('confidence stays low for no-trade reads and high for confirmed setups', () => {
  assert.ok(dayTradeConfidence({ action: 'wait', score: 0 }) <= 60);
  assert.ok(dayTradeConfidence({ action: 'wait', score: 3 }) <= 60);
  assert.ok(dayTradeConfidence({ action: 'buy', score: 7, volumeRatio: 1.6 }) >= 80);
  assert.ok(dayTradeConfidence({ action: 'sell', score: -7 }) >= 75);
  // An established trend with every factor aligned is the only 90% read.
  assert.ok(dayTradeConfidence({ action: 'buy', score: 10, volumeRatio: 2, adx: 30, confirmations: 7 }) <= 90);
});

test('only US venues are eligible for the US-session intraday model', () => {
  assert.equal(isUsVenue('NasdaqGS'), true);
  assert.equal(isUsVenue('NYSEArca'), true);
  assert.equal(isUsVenue('NYSE'), true);
  assert.equal(isUsVenue('LSE'), false);
  assert.equal(isUsVenue('XETRA'), false);
  assert.equal(isUsVenue(null), false);
});

test('the board universe is curated stocks and ETFs, not screener junk', () => {
  assert.ok(DAY_TRADE_UNIVERSE.length >= 30, 'the curated universe should be a real shortlist');
  assert.ok(DAY_TRADE_UNIVERSE.every((item) => item.kind === 'stock' || item.kind === 'etf'));
  assert.ok(DAY_TRADE_UNIVERSE.some((item) => item.symbol === 'SPY' && item.kind === 'etf'));
  assert.ok(DAY_TRADE_UNIVERSE.some((item) => item.symbol === 'NVDA' && item.kind === 'stock'));
});

test('the quality gate rejects penny stocks, thin names and non-US listings', () => {
  const good = { symbol: 'NVDA', quoteType: 'EQUITY', exchange: 'NasdaqGS', price: 120, averageVolume: 200_000_000 };
  assert.equal(isReputableInstrument(good), true);
  assert.equal(
    isReputableInstrument({ ...good, symbol: 'SPY', quoteType: 'ETF', exchange: 'NYSEArca', price: 600, averageVolume: 70_000_000 }),
    true,
  );
  assert.equal(isReputableInstrument({ ...good, price: 2.4 }), false, 'sub-$5 names are not day-trade vehicles');
  assert.equal(isReputableInstrument({ ...good, averageVolume: 100_000 }), false, 'thin names are rejected');
  assert.equal(isReputableInstrument({ ...good, exchange: 'LSE' }), false, 'non-US venue');
  assert.equal(isReputableInstrument({ ...good, quoteType: 'CRYPTOCURRENCY' }), false, 'not a stock or ETF');
  assert.equal(isReputableInstrument({ ...good, averageVolume: null }), false, 'unknown liquidity is not trusted');
});

test('the candidate ranking prefers deep liquidity over a thin mover', () => {
  const mega = boardCandidateScore({ price: 120, averageVolume: 200_000_000, volume: 150_000_000, changePercent: 1 });
  const thin = boardCandidateScore({ price: 8, averageVolume: 1_500_000, volume: 6_000_000, changePercent: 9 });
  assert.ok(mega > thin, `mega cap ${mega} should outrank the thin mover ${thin}`);
});

test('not enough intraday bars returns a 422 instead of a bogus signal', () => {
  const bars = makeSession('2026-10-16', 100, 0.05).slice(0, 10);
  assert.throws(
    () => buildDayTrade({ quote: { symbol: 'TEST' }, history: { bars } }),
    (error) => error.status === 422,
  );
});
