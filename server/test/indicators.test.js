import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adx,
  atr,
  bollinger,
  ema,
  normalizedSlope,
  pivotLevels,
  rsi,
  sma,
  stochastic,
} from '../src/analytics/indicators.js';

test('SMA aligns warm-up nulls and averages correctly', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('EMA seeds with the SMA and converges toward price', () => {
  const out = ema([1, 2, 3, 4, 5, 6], 3);
  assert.equal(out[0], null);
  assert.equal(out[2], 2);
  assert.ok(out[5] > out[4]);
});

test('RSI saturates on monotonic series', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const down = Array.from({ length: 40 }, (_, i) => 140 - i);
  assert.equal(rsi(up, 14).at(-1), 100);
  assert.equal(rsi(down, 14).at(-1), 0);
});

test('ATR of constant-range bars equals the true range', () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({
    open: 100,
    high: 105,
    low: 95,
    close: 100 + (i % 2),
    volume: 1000,
  }));
  const value = atr(bars, 14).at(-1);
  assert.ok(value >= 10 && value <= 12);
});

test('Bollinger mid equals SMA and bands bracket price', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5);
  const bb = bollinger(closes, 20, 2);
  const mid = sma(closes, 20).at(-1);
  assert.equal(bb.mid.at(-1), mid);
  assert.ok(bb.upper.at(-1) > mid);
  assert.ok(bb.lower.at(-1) < mid);
});

test('stochastic, ADX and slope produce bounded/valid values', () => {
  const bars = Array.from({ length: 120 }, (_, i) => {
    const close = 100 + i * 0.4 + Math.sin(i / 5) * 3;
    return { open: close - 0.5, high: close + 2, low: close - 2, close, volume: 10_000 };
  });
  const k = stochastic(bars).k.at(-1);
  assert.ok(k >= 0 && k <= 100);
  const adxValue = adx(bars).adx.at(-1);
  assert.ok(adxValue >= 0 && adxValue <= 100);
  assert.ok(normalizedSlope(bars.map((bar) => bar.close)) > 0);
});

test('pivot levels find repeated highs and lows', () => {
  const bars = Array.from({ length: 80 }, (_, i) => {
    const close = 100 + Math.sin(i / 3) * 5;
    return { open: close, high: close + 1, low: close - 1, close, volume: 1000 };
  });
  const levels = pivotLevels(bars, { left: 3, right: 3 });
  assert.ok(levels.highs.length > 0);
  assert.ok(levels.lows.length > 0);
  assert.ok(levels.highs[0].level > 0);
});
