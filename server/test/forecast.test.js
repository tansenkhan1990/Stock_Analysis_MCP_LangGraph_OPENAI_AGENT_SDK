import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALOG_MIN_SCORE,
  FORECAST_WINDOW,
  computeSetup,
  forecastSymbol,
  probabilityFor,
  summarizeAnalog,
} from '../src/analytics/forecast.js';

const series = (length, fn) => Array.from({ length }, (_, index) => fn(index));

function makeBars(closes, { spread = 0.01, volume = 1_000_000 } = {}) {
  return closes.map((close, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    open: index ? closes[index - 1] : close,
    high: close * (1 + spread),
    low: close * (1 - spread),
    close,
    volume,
  }));
}

const uptrend = () => makeBars(series(120, (index) => 100 * (1 + 0.004 * index)));
const downtrend = () => makeBars(series(120, (index) => 160 * (1 - 0.004 * index)));

test('the forecast learns from one month of sessions', () => {
  assert.equal(FORECAST_WINDOW, 21);
});

test('an uptrend forecasts a rise on both horizons', () => {
  const bars = uptrend();
  const forecast = forecastSymbol({ symbol: 'TEST', bars, window: FORECAST_WINDOW, price: bars.at(-1).close });

  assert.ok(forecast);
  assert.equal(forecast.window.sessions, FORECAST_WINDOW);
  assert.equal(forecast.series.length, FORECAST_WINDOW);
  assert.equal(forecast.analog.samples, FORECAST_WINDOW - 1);

  for (const horizon of [forecast.horizons.day, forecast.horizons.week]) {
    assert.equal(horizon.direction, 'rise', `${horizon.label} should rise, got ${horizon.direction}`);
    assert.ok(horizon.probability > 60, `${horizon.label} probability ${horizon.probability}`);
    assert.equal(horizon.probability, horizon.riseProbability);
    assert.ok(horizon.expectedPct > 0);
    assert.ok(horizon.expectedPrice > forecast.price);
    assert.ok(horizon.confidence >= 25 && horizon.confidence <= 92);
    assert.equal(horizon.dropProbability, 100 - horizon.probability);
    assert.ok(horizon.drivers.length > 0);
  }
});

test('a downtrend forecasts a drop on both horizons', () => {
  const bars = downtrend();
  const forecast = forecastSymbol({ symbol: 'TEST', bars, window: 30, price: bars.at(-1).close });

  assert.ok(forecast.technicals.score < 0);
  for (const horizon of [forecast.horizons.day, forecast.horizons.week]) {
    assert.equal(horizon.direction, 'drop', `${horizon.label} should drop, got ${horizon.direction}`);
    assert.ok(horizon.probability > 60, `${horizon.label} probability ${horizon.probability}`);
    // A drop call reads as the chance of a drop, not the chance of a rise.
    assert.equal(horizon.probability, horizon.dropProbability);
    assert.ok(horizon.riseProbability < 40);
    assert.ok(horizon.expectedPct < 0);
    assert.ok(horizon.expectedPrice < forecast.price);
  }
});

test('a flat tape is reported as no edge instead of a forced direction', () => {
  const bars = makeBars(series(90, () => 100), { spread: 0.01 });
  const forecast = forecastSymbol({ symbol: 'FLAT', bars, window: 30, price: 100 });

  assert.ok(forecast);
  assert.equal(forecast.horizons.day.direction, 'flat');
  assert.equal(forecast.horizons.day.directionLabel, 'No edge');
  assert.ok(forecast.horizons.day.probability >= 45 && forecast.horizons.day.probability <= 55);
  assert.ok(forecast.horizons.day.confidence <= 45);
  assert.ok(Math.abs(forecast.technicals.score) < 5);
});

test('the weekly horizon carries a wider typical range than one session', () => {
  const bars = uptrend();
  const forecast = forecastSymbol({ symbol: 'TEST', bars, window: 30, price: bars.at(-1).close });
  assert.ok(forecast.horizons.week.rangePct > forecast.horizons.day.rangePct);
  assert.ok(forecast.horizons.week.highPrice > forecast.horizons.day.highPrice);
  assert.ok(forecast.horizons.week.lowPrice < forecast.horizons.day.lowPrice);
});

test('expected price is the live price compounded by the expected move', () => {
  const bars = uptrend();
  const forecast = forecastSymbol({ symbol: 'TEST', bars, window: 30, price: 123.45 });
  for (const horizon of [forecast.horizons.day, forecast.horizons.week]) {
    const expected = 123.45 * (1 + horizon.expectedPct / 100);
    assert.ok(Math.abs(horizon.expectedPrice - expected) < 0.02);
  }
});

test('probabilityFor is monotone, centred and bounded', () => {
  assert.equal(probabilityFor(0, 1), 50);
  assert.ok(probabilityFor(50, 1) > probabilityFor(30, 1));
  assert.ok(probabilityFor(30, 1) > 50);
  assert.ok(probabilityFor(-30, 1) < 50);
  assert.ok(probabilityFor(-50, 1) < probabilityFor(-30, 1));
  assert.equal(probabilityFor(500, 1), 95);
  assert.equal(probabilityFor(-500, 5), 5);
});

test('a thin analog sample is not allowed to drive the read', () => {
  const rows = [
    { score: 30, next1: 1.2, next5: 2.1 },
    { score: 25, next1: -0.8, next5: -1.4 },
  ];
  const summary = summarizeAnalog(rows, { score: 40, horizon: 1 });
  assert.equal(summary.matched.samples, 0);
  assert.equal(summary.matched.hitRate, null);
  assert.equal(summary.baseline.samples, 2);
  assert.equal(summary.baseline.hitRate, 50);
});

test('analogs only compare setups on the same side of the threshold', () => {
  const rows = [
    { score: 40, next1: 1, next5: 2 },
    { score: 20, next1: -1, next5: -2 },
    { score: 35, next1: 0.5, next5: 1 },
    { score: -30, next1: 3, next5: 4 },
    { score: 25, next1: 0.2, next5: 0.4 },
    { score: 18, next1: -0.4, next5: -0.6 },
  ];
  const summary = summarizeAnalog(rows, { score: 22, horizon: 1 });
  assert.equal(summary.matched.samples, 5);
  assert.equal(summary.matched.hitRate, 60);
  assert.equal(summary.baseline.samples, 6);
  // Four of the six window sessions rose (1, 0.5, 3 and 0.2 vs -1 and -0.4).
  assert.equal(summary.baseline.hitRate, 67);
  assert.equal(summary.threshold, ANALOG_MIN_SCORE);
});

test('insufficient history returns null instead of a fabricated forecast', () => {
  const bars = makeBars(series(20, (index) => 100 + index));
  assert.equal(forecastSymbol({ symbol: 'SHORT', bars }), null);
  assert.equal(computeSetup(bars, 9), null);
});

test('the forecast carries the metadata the UI reads', () => {
  const bars = uptrend();
  const forecast = forecastSymbol({ symbol: 'TEST', bars, window: 45, price: bars.at(-1).close });
  assert.equal(forecast.window.sessions, 45);
  assert.equal(forecast.model.windowSessions, 45);
  assert.equal(forecast.symbol, 'TEST');
  assert.ok(forecast.summary.length >= 3);
  assert.ok(forecast.disclaimer.includes('not investment advice'));
  assert.equal(forecast.series.length, 45);
  assert.ok(forecast.series.every((bar) => Number.isFinite(bar.sma20) && Number.isFinite(bar.rsi14)));
});
