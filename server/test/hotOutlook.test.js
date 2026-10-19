import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutlookRows,
  chunkRows,
  engineOutlook,
  mergeOutlook,
  normalizeDirection,
  normalizeOutlookPicks,
  parseOutlookJson,
  rankOutlookPicks,
} from '../src/agent/hotOutlook.js';

const signal = {
  symbol: 'NVDA',
  name: 'NVIDIA Corporation',
  price: 182.4,
  changePercent: 2.1,
  score: 78,
  conviction: 71,
  action: 'buy',
  actionLabel: 'Buy',
  setupLabel: 'Uptrend pullback',
  trend: 'up',
  rsi: 48.3,
  buyZone: { low: 176, high: 180 },
  targets: [
    { label: 'T1', price: 191, upsidePct: 4.7 },
    { label: 'T2', price: 205, upsidePct: 12.4 },
    { label: 'T3', price: 214, upsidePct: 17.3 },
  ],
  stopLoss: 169,
  riskReward: 2.3,
};

test('buildOutlookRows maps the compact signal into a token-efficient candidate row', () => {
  const [row] = buildOutlookRows([signal]);
  assert.equal(row.symbol, 'NVDA');
  assert.equal(row.quality, 78);
  assert.equal(row.engineCall, 'Buy');
  assert.equal(row.trend, 'up');
  assert.equal(row.rsi, 48.3);
  assert.deepEqual(row.buyZone, { low: 176, high: 180 });
  // T2 is the app's primary target.
  assert.deepEqual(row.primaryTarget, { price: 205, upsidePct: 12.4 });
  assert.equal(row.riskReward, 2.3);
});

test('buildOutlookRows drops rows without a symbol and tolerates a missing plan', () => {
  const rows = buildOutlookRows([{ ...signal, symbol: null }, { symbol: 'AMD' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'AMD');
  assert.equal(rows[0].buyZone, null);
  assert.equal(rows[0].primaryTarget, null);
});

test('chunkRows splits candidates into bounded batches', () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ symbol: `S${index}` }));
  assert.deepEqual(
    chunkRows(rows, 3).map((batch) => batch.length),
    [3, 3, 1],
  );
  assert.equal(chunkRows([], 3).length, 0);
});

test('parseOutlookJson reads a fenced object, a bare array and a picks wrapper', () => {
  const fenced = parseOutlookJson('```json\n{"picks":[{"symbol":"NVDA","direction":"up","confidence":80}]}\n```');
  assert.equal(fenced.picks.length, 1);

  const prose = parseOutlookJson('Here is the read: {"picks":[{"symbol":"AMD"}]} — hope that helps.');
  assert.equal(prose.picks[0].symbol, 'AMD');

  const array = parseOutlookJson('[{"symbol":"SPY"}]');
  assert.deepEqual(array.picks, [{ symbol: 'SPY' }]);

  assert.equal(parseOutlookJson('no json here'), null);
  assert.equal(parseOutlookJson(''), null);
});

test('normalizeDirection accepts synonyms and rejects noise', () => {
  assert.equal(normalizeDirection('bullish'), 'up');
  assert.equal(normalizeDirection('HIGHER'), 'up');
  assert.equal(normalizeDirection('sideways'), 'flat');
  assert.equal(normalizeDirection('bearish'), 'down');
  assert.equal(normalizeDirection('maybe later'), null);
});

test('normalizeOutlookPicks keeps known symbols, clamps and de-duplicates', () => {
  const rows = buildOutlookRows([
    signal,
    { ...signal, symbol: 'AMD', conviction: 60 },
    { ...signal, symbol: 'SPY', conviction: 55 },
  ]);
  const picks = normalizeOutlookPicks(
    {
      picks: [
        { symbol: 'nvda', direction: 'bullish', confidence: 140, expectedMovePct: 500, reason: ' uptrend ' },
        { symbol: 'NVDA', direction: 'up', confidence: 62, reason: 'weaker duplicate' },
        { symbol: 'UNKNOWN', direction: 'up', confidence: 90 },
        { symbol: 'AMD', direction: 'sideways' },
        { symbol: 'SPY', direction: 'nonsense' },
      ],
    },
    rows,
  );
  assert.deepEqual(
    picks.map((pick) => pick.symbol),
    ['NVDA', 'AMD'],
  );
  assert.equal(picks[0].direction, 'up');
  assert.equal(picks[0].confidence, 100, 'confidence is clamped to 100');
  assert.equal(picks[0].expectedMovePct, 300, 'expected move is clamped');
  assert.equal(picks[0].reason, 'uptrend');
  assert.equal(picks[0].source, 'llm');
  assert.equal(picks[1].direction, 'flat');
});

test('engineOutlook flags actionable longs and constructive holds, never broken charts', () => {
  const picks = engineOutlook([
    signal,
    { ...signal, symbol: 'AMD', action: 'accumulate', actionLabel: 'Accumulate' },
    { ...signal, symbol: 'HOLDUP', action: 'hold', trend: 'up', score: 65 },
    { ...signal, symbol: 'HOLDDOWN', action: 'hold', trend: 'down', score: 70 },
    { ...signal, symbol: 'WEAK', action: 'hold', trend: 'up', score: 40 },
    { ...signal, symbol: 'SELL', action: 'sell', trend: 'up', score: 80 },
  ]);
  assert.deepEqual(
    picks.map((pick) => pick.symbol),
    ['NVDA', 'AMD', 'HOLDUP'],
  );
  for (const pick of picks) {
    assert.equal(pick.direction, 'up');
    assert.equal(pick.source, 'engine');
    assert.ok(pick.confidence > 0 && pick.confidence <= 99);
    assert.match(pick.reason, /^Engine:/);
  }
  assert.equal(picks[0].expectedMovePct, 12.4);
});

test('rankOutlookPicks puts model verdicts ahead of engine fallbacks, then by confidence', () => {
  const ranked = rankOutlookPicks([
    { symbol: 'ENGINE', source: 'engine', confidence: 95, expectedMovePct: 20 },
    { symbol: 'WEAK', source: 'llm', confidence: 55, expectedMovePct: 4 },
    { symbol: 'STRONG', source: 'llm', confidence: 88, expectedMovePct: 15 },
  ]);
  assert.deepEqual(
    ranked.map((pick) => pick.symbol),
    ['STRONG', 'WEAK', 'ENGINE'],
  );
});

test('mergeOutlook keeps model verdicts, fills uncovered names from the engine and counts risers', () => {
  const rows = buildOutlookRows([
    signal,
    { ...signal, symbol: 'AMD' },
    { ...signal, symbol: 'TSLA' },
  ]);
  const merged = mergeOutlook({
    rows,
    enginePicks: [
      { symbol: 'AMD', name: 'AMD', direction: 'up', confidence: 70, expectedMovePct: 6, horizon: '1–4 weeks', reason: 'Engine: setup', source: 'engine' },
      { symbol: 'TSLA', name: 'Tesla', direction: 'down', confidence: 45, expectedMovePct: -3, horizon: '1–4 weeks', reason: 'Engine: broken trend', source: 'engine' },
    ],
    modelPicks: [
      { symbol: 'NVDA', name: 'NVIDIA', direction: 'up', confidence: 84, expectedMovePct: 9.5, horizon: '2 weeks', reason: 'clean pullback', source: 'llm' },
      { symbol: 'AMD', name: 'AMD', direction: 'flat', confidence: 60, expectedMovePct: 1, horizon: '2 weeks', reason: 'no trigger yet', source: 'llm' },
      { symbol: 'UNKNOWN', name: 'Nope', direction: 'up', confidence: 99, source: 'llm' },
    ],
  });

  assert.deepEqual(
    merged.rising.map((pick) => pick.symbol),
    ['NVDA'],
  );
  assert.equal(merged.risingCount, 1);
  assert.equal(merged.modelRising, 1);
  assert.equal(merged.engineRising, 0);
  assert.equal(merged.rising[0].source, 'llm');
  assert.equal(merged.rising[0].confidence, 84);
  // The model covered AMD (as flat) and TSLA fell back to the engine, so only
  // TSLA is "uncovered"; the unknown symbol is dropped entirely.
  assert.deepEqual(merged.uncovered, ['TSLA']);
  assert.equal(merged.picks.find((pick) => pick.symbol === 'AMD').direction, 'flat');
  assert.equal(merged.picks.find((pick) => pick.symbol === 'AMD').source, 'llm');
  assert.equal(merged.picks.find((pick) => pick.symbol === 'TSLA').source, 'engine');
  assert.equal(merged.picks.find((pick) => pick.symbol === 'NVDA').reason, 'clean pullback');
});
