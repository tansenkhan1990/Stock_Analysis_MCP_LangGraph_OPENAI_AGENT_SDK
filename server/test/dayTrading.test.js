import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDayTrade, dayTradeConfidence, scoreSetup } from '../src/analytics/dayTrading.js';
import { isUsVenue } from '../src/services/dayTradeService.js';

const BARS_PER_SESSION = 78; // 09:30–15:55 New York in 5-minute bars

function makeSession(date, startPrice, step, { bars = BARS_PER_SESSION, volume = 100_000, startOffsetMinutes = 0 } = {}) {
  const start = new Date(`${date}T13:30:00.000Z`).getTime() + startOffsetMinutes * 60_000; // 09:30 New York (EDT)
  return Array.from({ length: bars }, (_, index) => {
    const close = startPrice + step * index;
    const open = startPrice + step * (index - 0.3);
    return {
      date: new Date(start + index * 5 * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + Math.abs(step) * 0.8 + 0.02,
      low: Math.min(open, close) - Math.abs(step) * 0.8 - 0.02,
      close,
      volume,
    };
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
  const bars = [...makeSession('2026-10-15', 100, 0.05), ...makeSession('2026-10-16', 103.9, 0.06)];
  const result = buildDayTrade({ quote: quoteFor(bars), history: { bars } });

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
  assert.equal(result.session.openingRangeComplete, true);
  assert.equal(result.chart.sessionStarts.length, 2);
  assert.ok(result.chart.bars.length <= bars.length);
});

test('a downtrend below VWAP produces a short plan with downside targets', () => {
  const bars = [...makeSession('2026-10-15', 120, -0.05), ...makeSession('2026-10-16', 116, -0.06)];
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

test('VWAP and the opening range come from the latest session only', () => {
  const prior = makeSession('2026-10-15', 50, 0.01);
  const firstSix = Array.from({ length: 6 }, (_, index) => ({
    date: new Date(new Date('2026-10-16T13:30:00.000Z').getTime() + index * 5 * 60_000).toISOString(),
    open: 100,
    high: 102,
    low: 99,
    close: 100.5,
    volume: 100_000,
  }));
  const rest = makeSession('2026-10-16', 110, 0.01, { bars: 72, startOffsetMinutes: 30 });
  const bars = [...prior, ...firstSix, ...rest];
  const result = buildDayTrade({ quote: quoteFor(bars), history: { bars } });

  assert.ok(result.levels.vwap > 100, 'VWAP must reset at the new session, not average the prior day');
  assert.ok(result.levels.openingRangeHigh <= 102.01);
  assert.ok(result.levels.openingRangeLow >= 98.99);
});

test('pre-market bars are ignored', () => {
  const bars = [...makeSession('2026-10-15', 100, 0.02), ...makeSession('2026-10-16', 101, 0.02)];
  bars.push({
    date: '2026-10-16T12:00:00.000Z', // 08:00 New York
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
});

test('only US venues are eligible for the US-session intraday model', () => {
  assert.equal(isUsVenue('NasdaqGS'), true);
  assert.equal(isUsVenue('NYSEArca'), true);
  assert.equal(isUsVenue('NYSE'), true);
  assert.equal(isUsVenue('LSE'), false);
  assert.equal(isUsVenue('XETRA'), false);
  assert.equal(isUsVenue(null), false);
});

test('not enough intraday bars returns a 422 instead of a bogus signal', () => {
  const bars = makeSession('2026-10-16', 100, 0.05).slice(0, 10);
  assert.throws(
    () => buildDayTrade({ quote: { symbol: 'TEST' }, history: { bars } }),
    (error) => error.status === 422,
  );
});
