import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChartPattern } from '../src/analytics/chartPattern.js';

const series = (length, fn) => Array.from({ length }, (_, index) => fn(index));

const makeBars = (closes, { spread = 0.005 } = {}) =>
  closes.map((close, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    open: index ? closes[index - 1] : close,
    high: close * (1 + spread),
    low: close * (1 - spread),
    close,
    volume: 1_000_000,
  }));

test('an uptrend is read as higher highs and higher lows', () => {
  const pattern = analyzeChartPattern(makeBars(series(60, (index) => 100 * (1 + 0.004 * index))), { window: 21 });

  assert.ok(pattern);
  assert.equal(pattern.window.sessions, 21);
  assert.equal(pattern.structure.higherHighs, true);
  assert.equal(pattern.structure.higherLows, true);
  assert.match(pattern.label, /uptrend|breakout/i);
  assert.equal(pattern.direction, 'bullish');
  assert.ok(pattern.score > 20);
  assert.ok(pattern.levels.support < pattern.window.high);
  assert.ok(pattern.levels.resistance > pattern.levels.support);
  assert.ok(pattern.drivers.length >= 3);
  assert.ok(pattern.range.positionPct >= 0 && pattern.range.positionPct <= 100);
});

test('a downtrend is read as lower highs and lower lows', () => {
  const pattern = analyzeChartPattern(makeBars(series(60, (index) => 160 * (1 - 0.004 * index))), { window: 21 });

  assert.equal(pattern.structure.higherHighs, false);
  assert.equal(pattern.structure.higherLows, false);
  assert.equal(pattern.direction, 'bearish');
  assert.ok(pattern.score < -20);
  assert.ok(pattern.levels.support < pattern.levels.resistance);
});

test('a flat tape is a tight consolidation, not a fake trend', () => {
  const pattern = analyzeChartPattern(makeBars(series(60, () => 100)), { window: 21 });

  assert.equal(pattern.range.tight, true);
  assert.match(pattern.label, /consolidat|range/i);
  assert.equal(pattern.direction, 'neutral');
  assert.ok(Math.abs(pattern.score) < 25);
});

test('too little history returns null instead of a fabricated pattern', () => {
  assert.equal(analyzeChartPattern(makeBars(series(20, (index) => 100 + index))), null);
  assert.equal(analyzeChartPattern([]), null);
});
