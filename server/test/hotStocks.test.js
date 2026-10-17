import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHotStock, rankHotStocks } from '../src/analytics/hotStocks.js';

const baseSignal = {
  symbol: 'NVDA',
  name: 'NVIDIA Corporation',
  quoteType: 'EQUITY',
  price: 100,
  changePercent: -1.2,
  score: 72,
  conviction: 68,
  action: 'buy',
  actionLabel: 'Buy',
  setup: 'buy_pullback',
  setupLabel: 'Uptrend pullback',
  rsi: 41.2,
  trend: 'up',
  riskReward: 2.4,
  buyZone: { low: 96, high: 101 },
  targets: [
    { label: 'T1', price: 108, upsidePct: 8, probability: 74, source: 'resistance' },
    { label: 'T2', price: 114, upsidePct: 14, probability: 61, source: '52w high' },
    { label: 'T3', price: 120, upsidePct: 20, probability: 48, source: 'ATR extension' },
  ],
  stopLoss: 92,
  sparkline: [96, 98, 100],
};

test('a buy signal inside its zone is marked buy-now and scored with a timing bonus', () => {
  const stock = buildHotStock(baseSignal);
  assert.equal(stock.buyNow, true);
  assert.equal(stock.waitFor, null);
  assert.equal(stock.hotScore, 75); // 72*0.6 + 68*0.25 + 15 timing bonus
  assert.equal(stock.entryRef, 98.5);
  assert.equal(stock.primaryTarget.price, 114); // T2 is the plan's primary target
  assert.equal(stock.primaryTarget.label, 'T2');
  assert.equal(stock.sellPlan.length, 3);
  assert.equal(stock.sellPlan[0].probability, 74);
  assert.match(stock.why, /Uptrend pullback/);
  assert.match(stock.why, /RSI 41\.2/);
  assert.match(stock.why, /14% to T2/);
});

test('a signal above its zone waits for the pullback instead of buying now', () => {
  const stock = buildHotStock({ ...baseSignal, price: 110 });
  assert.equal(stock.buyNow, false);
  assert.equal(stock.waitFor, 101);
  assert.equal(stock.distanceToZonePct, 8.91);
  assert.equal(stock.hotScore, 60); // no timing bonus
});

test('only actionable long setups are ranked', () => {
  const ranked = rankHotStocks([
    baseSignal,
    { ...baseSignal, symbol: 'MSFT', action: 'hold' },
    { ...baseSignal, symbol: 'TSLA', action: 'sell' },
    { ...baseSignal, symbol: 'AMD', action: 'accumulate' },
  ]);
  assert.deepEqual(
    ranked.stocks.map((stock) => stock.symbol),
    ['AMD', 'NVDA'], // equal hot scores fall back to symbol order
  );
  assert.equal(ranked.buyNow.length, 2);
  assert.equal(ranked.waiting.length, 0);
});

test('signals without a usable buy zone or price are dropped', () => {
  const ranked = rankHotStocks([
    { ...baseSignal, buyZone: null },
    { ...baseSignal, symbol: 'AMZN', price: 0 },
    { ...baseSignal, symbol: 'GOOGL', buyZone: { low: 0, high: 0 } },
  ]);
  assert.equal(ranked.stocks.length, 0);
});

test('buy-now names sort ahead of pullback waits, then by hot score', () => {
  const ranked = rankHotStocks([
    { ...baseSignal, symbol: 'STRONG', price: 110, score: 95, conviction: 90 }, // waiting, high quality
    { ...baseSignal, symbol: 'READY', price: 100, score: 60, conviction: 55 }, // in zone
    { ...baseSignal, symbol: 'BETTER', price: 100, score: 68, conviction: 60 }, // in zone, better score
  ]);
  assert.deepEqual(
    ranked.stocks.map((stock) => stock.symbol),
    ['BETTER', 'READY', 'STRONG'],
  );
  assert.deepEqual(
    ranked.stocks.map((stock) => stock.rank),
    [1, 2, 3],
  );
});

test('sell ladder caps at three valid targets and tolerates missing data', () => {
  const stock = buildHotStock({
    ...baseSignal,
    targets: [
      { label: 'T1', price: 108, upsidePct: 8, probability: 74 },
      { label: 'T2', price: null, upsidePct: null, probability: null },
      { label: 'T3', price: 120, upsidePct: 20, probability: 48 },
      { label: 'T4', price: 130, upsidePct: 30, probability: 33 },
    ],
  });
  assert.deepEqual(
    stock.sellPlan.map((target) => target.label),
    ['T1', 'T3', 'T4'], // invalid T2 dropped, ladder capped at three
  );
  assert.equal(stock.sellPlan[1].probability, 48);
  assert.equal(stock.sellPlan.length, 3);

  const bare = buildHotStock({ ...baseSignal, targets: [] });
  assert.equal(bare.primaryTarget, null);
  assert.equal(bare.sellPlan.length, 0);

  const single = buildHotStock({ ...baseSignal, targets: [{ label: 'T1', price: 108, upsidePct: 8, probability: 74 }] });
  assert.equal(single.primaryTarget.label, 'T1');
});
