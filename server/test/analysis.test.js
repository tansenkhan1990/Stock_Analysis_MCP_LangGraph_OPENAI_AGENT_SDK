import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysis } from '../src/analytics/analysis.js';

function makeBars(n, { start = 100, drift = 0.22, wave = 3.5, waveLength = 18 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i * drift + Math.sin(i / waveLength) * wave + Math.cos(i / 7) * 1.2;
    const open = close - Math.cos(i / 7) * 0.7;
    const high = Math.max(open, close) + 0.9 + (i % 3) * 0.3;
    const low = Math.min(open, close) - 0.9 - (i % 2) * 0.3;
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
