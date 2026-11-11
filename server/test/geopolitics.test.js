import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGeopolitics } from '../src/analytics/geopolitics.js';

const headline = (title) => ({ title, publisher: 'Reuters', publishedAt: new Date().toISOString() });

test('a hostile macro tape and trade headlines read risk-off', () => {
  const geo = analyzeGeopolitics({
    headlines: [
      headline('U.S. imposes new tariffs on Chinese imports as trade war widens'),
      headline('Oil surges as Middle East conflict threatens shipping lanes'),
    ],
    market: {
      vix: { price: 31, changePercent: 8 },
      spy: { price: 520, changePercent: -1.6 },
      oil: { price: 92, changePercent: 4.5 },
      gold: { price: 2450, changePercent: 1.8 },
      dollar: { price: 105, changePercent: 0.9 },
    },
  });

  assert.ok(geo);
  assert.equal(geo.riskTone, 'risk-off');
  assert.equal(geo.label, 'hostile');
  assert.ok(geo.tilt < 0);
  assert.ok(geo.themes.some((theme) => theme.key === 'trade' || theme.key === 'conflict'));
  assert.match(geo.summary, /hostile/);
});

test('a calm tape with supportive headlines reads supportive', () => {
  const geo = analyzeGeopolitics({
    headlines: [headline('Stocks rally as ceasefire holds and oil eases')],
    market: {
      vix: { price: 13, changePercent: -3 },
      spy: { price: 520, changePercent: 1.1 },
      oil: { price: 70, changePercent: -2 },
      gold: { price: 2300, changePercent: -0.5 },
      dollar: { price: 101, changePercent: -0.8 },
    },
  });

  assert.equal(geo.riskTone, 'risk-on');
  assert.equal(geo.label, 'supportive');
  assert.ok(geo.tilt > 0);
});

test('no macro evidence and no themes returns null', () => {
  assert.equal(analyzeGeopolitics({}), null);
  assert.equal(analyzeGeopolitics({ headlines: [{ title: 'Company launches a new product' }] }), null);
});
