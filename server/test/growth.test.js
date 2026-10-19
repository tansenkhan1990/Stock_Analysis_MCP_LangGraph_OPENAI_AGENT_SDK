import test from 'node:test';
import assert from 'node:assert/strict';
import { GROWTH_WEIGHTS, growthBand, growthProbability } from '../src/analytics/growth.js';

test('a name with every component blends the weighted evidence', () => {
  const probability = growthProbability({
    targetProbability: 70,
    conviction: 80,
    quality: 90,
    trend: 'up',
    hitRate: 60,
  });
  // (70*.45 + 80*.30 + 90*.15 + 100*.10 + 60*.10) / (weights, 1.10) = 85/1.10
  const expected = Math.round(
    (70 * GROWTH_WEIGHTS.target +
      80 * GROWTH_WEIGHTS.conviction +
      90 * GROWTH_WEIGHTS.quality +
      100 * GROWTH_WEIGHTS.trend +
      60 * GROWTH_WEIGHTS.hitRate) /
      (GROWTH_WEIGHTS.target + GROWTH_WEIGHTS.conviction + GROWTH_WEIGHTS.quality + GROWTH_WEIGHTS.trend + GROWTH_WEIGHTS.hitRate),
  );
  assert.equal(probability, expected);
  assert.equal(probability, 77);
});

test('missing components are renormalized instead of dragging the score down', () => {
  // Only conviction and quality are known; both are strong.
  const probability = growthProbability({ conviction: 90, quality: 90 });
  assert.equal(probability, 90);

  // One strong blocker should pull the blend down.
  const blocked = growthProbability({ conviction: 90, quality: 90, targetProbability: 20 });
  assert.ok(blocked < probability, `${blocked} should be below ${probability}`);
});

test('a broken trend scores below an uptrend with the same other evidence', () => {
  const base = { targetProbability: 70, conviction: 70, quality: 80 };
  const up = growthProbability({ ...base, trend: 'up' });
  const flat = growthProbability({ ...base, trend: 'flat' });
  const down = growthProbability({ ...base, trend: 'down' });
  assert.ok(up > flat && flat > down, `expected up > flat > down, got ${up}/${flat}/${down}`);
});

test('a bearish plan flips: a working short is not a growth candidate', () => {
  const long = growthProbability({ targetProbability: 80, conviction: 80, quality: 80, trend: 'up' });
  const short = growthProbability({ targetProbability: 80, conviction: 80, quality: 80, trend: 'down', direction: 'short' });
  assert.ok(short < 45, `a bearish plan must not read as a riser, got ${short}`);
  assert.ok(long > 70, `a strong long should read high, got ${long}`);
});

test('no usable component returns null and the score stays inside 1-99', () => {
  assert.equal(growthProbability({}), null);
  assert.equal(growthProbability({ conviction: null, quality: 'nonsense' }), null);
  assert.equal(growthProbability({ targetProbability: 100, conviction: 100, quality: 100, trend: 'up', hitRate: 100 }), 99);
  assert.equal(growthProbability({ targetProbability: 0, conviction: 0, quality: 0, trend: 'down', hitRate: 0 }), 1);
});

test('growthBand maps the probability into the UI bands', () => {
  assert.equal(growthBand(85), 'high');
  assert.equal(growthBand(70), 'high');
  assert.equal(growthBand(65), 'good');
  assert.equal(growthBand(55), 'moderate');
  assert.equal(growthBand(30), 'low');
  assert.equal(growthBand(null), null);
  assert.equal(growthBand('nope'), null);
});
