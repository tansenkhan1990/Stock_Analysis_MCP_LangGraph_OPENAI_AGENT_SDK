import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysis } from '../src/analytics/analysis.js';

function makeBars(n, { start = 100, drift = 0.22, wave = 3.5, waveLength = 18, range = null } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i * drift + Math.sin(i / waveLength) * wave + Math.cos(i / 7) * 1.2;
    const open = close - Math.cos(i / 7) * 0.7;
    const high = Math.max(open, close) + (range ?? 0.9 + (i % 3) * 0.3);
    const low = Math.min(open, close) - (range ?? 0.9 + (i % 2) * 0.3);
    const volume = 1_000_000 * (1 + 0.25 * Math.sin(i / 5));
    return { date: new Date(Date.now() - (n - i) * 86_400_000).toISOString(), open, high, low, close, adjClose: close, volume };
  });
}

const quoteFor = (bars, extra = {}) => ({
  symbol: 'TEST',
  name: 'Test Corp',
  quoteType: 'EQUITY',
  currency: 'USD',
  price: Number(bars.at(-1).close.toFixed(2)),
  change: 1.2,
  changePercent: 0.8,
  beta: 1.1,
  ...extra,
});

test('uptrend produces a constructive score and a coherent long plan', () => {
  const bars = makeBars(300);
  const quote = quoteFor(bars);
  const analysis = buildAnalysis({ quote, history: { bars } });

  assert.equal(analysis.symbol, 'TEST');
  assert.ok(analysis.score.total >= 55, `score ${analysis.score.total}`);
  assert.equal(analysis.plan.direction, 'long');
  assert.ok(analysis.plan.buyZone);
  assert.ok(analysis.plan.buyZone.low < analysis.plan.buyZone.high);
  assert.equal(analysis.plan.targets.length, 3);

  const [t1, t2, t3] = analysis.plan.targets;
  assert.ok(t1.price > quote.price);
  assert.ok(t2.price > t1.price);
  assert.ok(t3.price > t2.price);
  assert.ok(analysis.plan.stopLoss < quote.price);
  assert.ok(analysis.plan.riskReward > 0);
  assert.ok(analysis.score.confidence >= 35 && analysis.score.confidence <= 94);
  assert.equal(analysis.chart.bars.length, 180);
  assert.equal(analysis.chart.rsi.length, 180);
  assert.ok(analysis.checklist.length >= 6);
});

test('every plan number reconciles with the reference entry it is measured from', () => {
  const bars = makeBars(300);
  const quote = quoteFor(bars);
  const analysis = buildAnalysis({ quote, history: { bars } });
  const { plan } = analysis;
  const t2 = plan.targets[1].price;

  assert.ok(plan.buyZone, 'uptrend carries an accumulation range');
  assert.ok(
    plan.entryRef >= plan.buyZone.low && plan.entryRef <= plan.buyZone.high,
    `reference entry ${plan.entryRef} sits inside the ${plan.buyZone.low}–${plan.buyZone.high} band it names`,
  );
  // The published R:R has to be checkable against the prices on the card:
  // (main target - entry) / (entry - stop).
  assert.ok(
    Math.abs(plan.riskReward - (t2 - plan.entryRef) / (plan.entryRef - plan.stopLoss)) < 0.02,
    `${plan.riskReward}:1 must be the ratio at the ${plan.entryRef} reference entry`,
  );
  assert.ok(plan.riskRewardAtSpot !== null, 'the same ratio is quoted at the live price');
  assert.ok(
    Math.abs(plan.riskRewardAtSpot - (t2 - analysis.price) / (analysis.price - plan.stopLoss)) < 0.02,
    `${plan.riskRewardAtSpot}:1 must be the ratio at spot`,
  );
});

test('a fill at the top of the buy zone cannot claim the reference-entry reward/risk', () => {
  const bars = makeBars(300, { drift: 0.1, wave: 6 });
  const analysis = buildAnalysis({ quote: quoteFor(bars), history: { bars } });
  const { plan } = analysis;

  assert.ok(plan.buyZone);
  assert.ok(
    analysis.price >= plan.buyZone.low && analysis.price <= plan.buyZone.high,
    'price is parked inside the accumulation range',
  );
  assert.ok(plan.riskRewardAtSpot < plan.riskReward, 'spot earns less than the reference entry');
  assert.ok(
    analysis.risks.some(
      (risk) => risk.includes(`only ${plan.riskRewardAtSpot}:1`) && risk.includes(`${plan.entryRef} reference entry`),
    ),
    'the risk list names the gap instead of hiding it',
  );
});

test('the stop never sits inside the buy zone, even when ATR is extreme', () => {
  // Huge daily ranges push ATR to ~37% of spot, which used to place the stop
  // above the bottom of the buy zone (a zero or negative risk entry).
  const bars = makeBars(300, { drift: 0.18, wave: 2, range: 18 });
  const quote = quoteFor(bars);
  const analysis = buildAnalysis({ quote, history: { bars } });
  const { plan } = analysis;

  assert.equal(plan.direction, 'long');
  assert.ok(plan.buyZone);
  assert.ok(
    plan.stopLoss < plan.buyZone.low,
    `stop ${plan.stopLoss} must sit below the ${plan.buyZone.low}–${plan.buyZone.high} buy zone`,
  );
  assert.ok(plan.riskPerShare > 0);
  assert.ok(plan.entryRef >= plan.buyZone.low && plan.entryRef <= plan.buyZone.high);
});

test('the short stop stays above the short zone at extreme ATR', () => {
  const bars = makeBars(300, { drift: -0.28, wave: 4, range: 4 });
  const quote = quoteFor(bars);
  const analysis = buildAnalysis({ quote, history: { bars } });
  const { plan } = analysis;

  assert.equal(plan.direction, 'short');
  assert.ok(plan.shortZone);
  assert.ok(
    plan.stopLoss > plan.shortZone.high,
    `stop ${plan.stopLoss} must sit above the ${plan.shortZone.low}–${plan.shortZone.high} short zone`,
  );
  assert.ok(plan.riskPerShare > 0);
});

test('downtrend flips the plan to short-side levels', () => {
  const bars = makeBars(300, { drift: -0.28, wave: 4 });
  const quote = quoteFor(bars);
  const analysis = buildAnalysis({ quote, history: { bars } });

  assert.ok(analysis.score.total < 50, `score ${analysis.score.total}`);
  assert.equal(analysis.plan.direction, 'short');
  assert.ok(analysis.plan.stopLoss > quote.price);
  for (const target of analysis.plan.targets) {
    assert.ok(target.price < quote.price);
  }
  assert.equal(analysis.plan.buyZone, null);
});

test('a Sell call never carries an upside plan, even when the score rounds above 45', () => {
  // A long advance followed by a sharp break: the regime is a confirmed
  // downtrend (price and 50-day below the 200-day) while enough of the quality
  // score survives for the old `score < 45` rule to keep the plan long. That
  // produced a Sell card with "profit targets" above spot and a "buy above"
  // trigger — two halves of the card contradicting each other.
  const bars = [];
  let close = 100;
  const up = 240;
  const down = 70;
  const fall = ((100 + up * 0.3) * 0.2) / down;
  for (let i = 0; i < up + down; i += 1) {
    close = Math.max(1, close + (i >= up ? -fall : 0.3) + Math.sin(i / 9) * 1.5);
    const open = close - 0.4;
    bars.push({
      date: new Date(Date.now() - (up + down - i) * 86_400_000).toISOString(),
      open,
      high: Math.max(open, close) + 0.8,
      low: Math.min(open, close) - 0.8,
      close,
      adjClose: close,
      volume: 1_000_000 * (1 + 0.2 * Math.sin(i / 5)),
    });
  }
  const quote = quoteFor(bars);
  const analysis = buildAnalysis({ quote, history: { bars } });

  assert.equal(analysis.alert.action, 'sell', 'fixture is a trend break');
  assert.ok(analysis.score.total >= 45, `score ${analysis.score.total} sits above the old 45 cutoff`);
  assert.equal(analysis.plan.direction, 'short');
  assert.equal(analysis.plan.buyZone, null, 'an exit call never advertises a buy zone');
  assert.ok(analysis.plan.stopLoss > quote.price, 'the invalidation sits above spot');
  for (const target of analysis.plan.targets) {
    assert.ok(target.price < quote.price, `target ${target.price} sits below spot on a Sell call`);
  }
  assert.match(analysis.plan.invalidation, /above/);
});

test('a loss-making company is not rewarded as a cheap valuation', () => {
  const bars = makeBars(300);
  const analysis = buildAnalysis({
    quote: quoteFor(bars),
    history: { bars },
    fundamentals: {
      trailingPE: -8,
      forwardPE: -10,
      pegRatio: -1.2,
      profitMargin: 0.1,
      revenueGrowth: 0.1,
      analystTarget: null,
    },
  });

  const valuation = analysis.score.components.find((component) => component.key === 'valuation');
  assert.ok(valuation, 'equity with fundamentals gets a valuation component');
  // Negative P/E and PEG used to take the two best valuation buckets (26 + 16).
  assert.ok(valuation.score < 60, `negative PE/PEG scored ${valuation.score}/100`);
});

test('ETF analysis gracefully handles missing fundamentals', () => {
  const bars = makeBars(220);
  const analysis = buildAnalysis({
    quote: { ...quoteFor(bars), quoteType: 'ETF', name: 'Test ETF' },
    history: { bars },
    fundamentals: null,
  });
  assert.equal(analysis.assetClass, 'ETF');
  assert.ok(analysis.score.components.some((component) => component.key === 'fund'));
  assert.ok(analysis.risks.some((risk) => /technical-only/i.test(risk)));
  assert.equal(analysis.plan.targets.length, 3);
});

test('insufficient history still returns a plan without crashing', () => {
  const bars = makeBars(40);
  const analysis = buildAnalysis({ quote: quoteFor(bars), history: { bars } });
  assert.ok(Number.isFinite(analysis.score.total));
  assert.equal(analysis.chart.bars.length, 40);
  assert.ok(analysis.plan.targets.length >= 2);
});
