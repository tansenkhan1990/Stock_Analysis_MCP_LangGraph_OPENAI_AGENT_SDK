import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDayTradeRow, rankDayTrades, tradeabilityScore } from '../src/analytics/dayTradeBoard.js';

const trade = (overrides = {}) => ({
  symbol: 'AAA',
  name: 'Alpha Corp.',
  quoteType: 'EQUITY',
  price: 100,
  changePercent: 1.8,
  interval: '5m',
  session: { date: '2026-10-30' },
  action: 'buy',
  score: 6,
  confidence: 78,
  levels: {
    vwap: 99,
    ema9: 99.6,
    ema20: 99.1,
    openingRangeHigh: 99.5,
    openingRangeLow: 98.2,
    priorClose: 98,
  },
  triggers: { buyAbove: 99.5, sellBelow: 98.2 },
  indicators: {
    rsi14: 61.4,
    atrPct: 1.8,
    volumeRatio: 1.4,
    vwapDistancePct: 1.01,
    aboveVwap: true,
    ema9Above20: true,
  },
  plan: {
    direction: 'long',
    entry: 100,
    stopLoss: 98.9,
    riskPerShare: 1.1,
    riskReward: 2.5,
    targets: [
      { label: 'T1', price: 101.65, rMultiple: 1.5, movePct: 1.65 },
      { label: 'T2', price: 102.75, rMultiple: 2.5, movePct: 2.75 },
      { label: 'T3', price: 104.4, rMultiple: 4, movePct: 4.4 },
    ],
  },
  reasons: ['Price is holding above session VWAP', 'Price is above the 30-minute opening range', 'RSI 61.4 — momentum with the long side'],
  relativeVolume: 2,
  ...overrides,
});

test('a long read becomes a BUY row with the plan, levels and opening-range setup', () => {
  const row = buildDayTradeRow(trade());

  assert.equal(row.action, 'buy');
  assert.equal(row.bucket, 'buy');
  assert.equal(row.openingRangePosition, 'above');
  assert.equal(row.setup, 'Opening-range breakout long');
  assert.equal(row.plan.direction, 'long');
  assert.equal(row.plan.stopLoss, 98.9);
  assert.deepEqual(
    row.plan.targets.map((target) => target.label),
    ['T1', 'T2', 'T3'],
  );
  assert.equal(row.levels.vwap, 99);
  assert.equal(row.triggers.buyAbove, 99.5);
  assert.equal(row.triggers.sellBelow, 98.2);
  assert.equal(row.relativeVolume, 2);
  assert.equal(row.rsi, 61.4);
  assert.ok(row.tradeability > 0 && row.tradeability <= 100);
});

test('a short read is bucketed as a sell with a downside plan', () => {
  const row = buildDayTradeRow(
    trade({
      action: 'sell',
      score: -7,
      plan: {
        direction: 'short',
        entry: 95,
        stopLoss: 96.2,
        riskPerShare: 1.2,
        riskReward: 2.5,
        targets: [{ label: 'T1', price: 93.2, rMultiple: 1.5, movePct: -1.89 }],
      },
    }),
  );

  assert.equal(row.action, 'sell');
  assert.equal(row.bucket, 'sell');
  assert.equal(row.plan.direction, 'short');
  assert.ok(row.plan.targets[0].price < row.plan.entry);
});

test('a no-trade read carries the breakout triggers instead of a plan', () => {
  const row = buildDayTradeRow(trade({ action: 'wait', score: 1, plan: null, confidence: 48 }));

  assert.equal(row.action, 'wait');
  assert.equal(row.bucket, 'wait');
  assert.equal(row.plan, null);
  assert.equal(row.setup, 'Inside the opening range — wait for the break');
  assert.equal(row.triggers.buyAbove, 99.5);
  assert.equal(row.triggers.sellBelow, 98.2);
});

test('tradeability rewards movement and participation and stays bounded', () => {
  const quiet = tradeabilityScore({ atrPct: 0.3, relativeVolume: 0.4, score: 6, price: 100 });
  const movers = tradeabilityScore({ atrPct: 2.6, relativeVolume: 2.4, score: 6, price: 100 });
  assert.ok(movers > quiet, `expected the mover (${movers}) to outrank the quiet name (${quiet})`);

  assert.ok(tradeabilityScore({ atrPct: 40, relativeVolume: 900, score: 99, price: 500 }) <= 100);
  assert.ok(tradeabilityScore({ atrPct: 0, relativeVolume: 0, score: 0, price: 0 }) >= 0);
  // A sub-$5 price loses the liquidity points but never scores zero on its own.
  assert.ok(tradeabilityScore({ atrPct: 2, relativeVolume: 1, score: 5, price: 1 }) > 0);
});

test('the board puts actionable BUY and SELL reads ahead of WAIT, then ranks by tradeability', () => {
  const ranked = rankDayTrades([
    trade({ symbol: 'WAIT', action: 'wait', score: 1, plan: null, indicators: { atrPct: 3, rsi14: 50 }, relativeVolume: 3 }),
    trade({ symbol: 'QUIET', action: 'buy', score: 5, indicators: { atrPct: 0.4, rsi14: 58 }, relativeVolume: 0.5 }),
    trade({ symbol: 'SHORT', action: 'sell', score: -7, indicators: { atrPct: 2.4, rsi14: 38 }, relativeVolume: 2.5 }),
    trade({ symbol: 'LOUD', action: 'buy', score: 7, indicators: { atrPct: 2.6, rsi14: 62 }, relativeVolume: 2.4 }),
  ]);

  assert.equal(ranked.rows.length, 4);
  assert.equal(ranked.rows[ranked.rows.length - 1].symbol, 'WAIT', 'a no-trade read always ranks last');
  assert.equal(ranked.rows[0].symbol, 'LOUD', 'the strongest, most active actionable read comes first');
  assert.deepEqual(
    ranked.rows.slice(0, 3).map((row) => row.symbol).sort(),
    ['LOUD', 'QUIET', 'SHORT'],
  );
  assert.deepEqual(
    ranked.rows.map((row) => row.rank),
    [1, 2, 3, 4],
  );
  assert.equal(ranked.buyCount, 2);
  assert.equal(ranked.sellCount, 1);
  assert.equal(ranked.waitCount, 1);
  assert.equal(ranked.buy.length, 2);
  assert.equal(ranked.sell[0].symbol, 'SHORT');
});

test('rows without a symbol or price are dropped rather than ranked', () => {
  const ranked = rankDayTrades([
    trade({ symbol: 'OK' }),
    trade({ symbol: '', price: 100 }),
    trade({ symbol: undefined, price: 100 }),
    trade({ symbol: 'NOPRICE', price: null }),
  ]);

  assert.deepEqual(
    ranked.rows.map((row) => row.symbol),
    ['OK'],
  );
});
