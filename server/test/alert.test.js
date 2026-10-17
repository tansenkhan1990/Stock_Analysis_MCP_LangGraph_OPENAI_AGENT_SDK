import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlert } from '../src/analytics/alert.js';

/** Minimal analysis-shaped fixture: price 100, 200-day 80, 50-day 90. */
const analysis = ({ indicators = {}, ...rest } = {}) => ({
  price: 100,
  plan: { stopLoss: 92, riskReward: 2.4, targets: [{ price: 112 }] },
  ...rest,
  indicators: {
    sma50: 90,
    sma200: 80,
    rsi14: 38,
    adx14: 26,
    volumeRatio: 1.2,
    ...indicators,
  },
});

const news = (sentiment, headlineCount = 6) => ({
  sentiment,
  headlineCount,
  label: sentiment > 10 ? 'positive' : sentiment < -10 ? 'negative' : 'mixed',
});

test('uptrend pullback is the buy setup', () => {
  const alert = buildAlert({ analysis: analysis() });
  assert.equal(alert.action, 'buy');
  assert.equal(alert.setup, 'pullback');
  assert.equal(alert.setupLabel, 'Uptrend pullback');
  assert.ok(alert.confidence >= 60);
  assert.match(alert.reason, /Uptrend pullback/);
  assert.ok(alert.invalidations.length);
  assert.equal(alert.riskControl, false);
});

test('uptrend with neutral momentum is accumulate, hot momentum is hold', () => {
  assert.equal(buildAlert({ analysis: analysis({ indicators: { rsi14: 52 } }) }).action, 'accumulate');
  assert.equal(buildAlert({ analysis: analysis({ indicators: { rsi14: 74 } }) }).action, 'hold');
  assert.match(buildAlert({ analysis: analysis({ indicators: { rsi14: 74 } }) }).reason, /Do not chase/);
});

test('a broken trend is a risk exit, not a short forecast', () => {
  const alert = buildAlert({
    analysis: analysis({ price: 70, indicators: { sma50: 78, sma200: 80, rsi14: 40 } }),
  });
  assert.equal(alert.action, 'sell');
  assert.equal(alert.setup, 'breakdown');
  assert.equal(alert.riskControl, true);
  assert.match(alert.reason, /risk control, not a short forecast/);
  assert.ok(alert.invalidations.some((item) => /no predictive edge|risk rule/i.test(item)));
});

test('conflicting 50/200-day structure is reduce', () => {
  const alert = buildAlert({
    analysis: analysis({ price: 85, indicators: { sma50: 78, sma200: 80, rsi14: 50 } }),
  });
  assert.equal(alert.action, 'reduce');
  assert.equal(alert.setup, 'transition');
});

test('a hold is invalidated by the stop, not by a break above the 20-day it already cleared', () => {
  const alert = buildAlert({ analysis: analysis({ indicators: { rsi14: 74 } }) });
  assert.equal(alert.action, 'hold');
  assert.ok(alert.invalidations.some((item) => /daily close below the stop at 92 turns this into an exit/i.test(item)));
  assert.ok(alert.invalidations.some((item) => /momentum reset/i.test(item)));
  assert.ok(!alert.invalidations.some((item) => /above the 20-day/i.test(item)));

  const withZone = buildAlert({
    analysis: { ...analysis({ indicators: { rsi14: 74 } }), plan: { stopLoss: 92, riskReward: 2.4, buyZone: { low: 94, high: 97 } } },
  });
  assert.ok(withZone.invalidations.some((item) => /pullback into 94–97/i.test(item)));
});

test('the caution is cancelled at the level that actually matters for the trend state', () => {
  // Price above the 200-day but the 50-day below it: the 200-day reclaim is
  // already true, so the invalidation has to be the 50-day, not the 200-day.
  const above = buildAlert({
    analysis: analysis({ price: 85, indicators: { sma50: 78, sma200: 80, rsi14: 50 } }),
  });
  assert.ok(above.invalidations.some((item) => /above the 50-day at 78/i.test(item)));
  assert.ok(!above.invalidations.some((item) => /reclaim of the 200-day/i.test(item)));

  // Price below the 200-day: reclaiming it is what neutralises the exit.
  const below = buildAlert({
    analysis: analysis({ price: 70, indicators: { sma50: 78, sma200: 80, rsi14: 40 } }),
  });
  assert.ok(below.invalidations.some((item) => /reclaim of the 200-day at 80/i.test(item)));
});

test('an imminent earnings date blocks a fresh buy', () => {
  const alert = buildAlert({
    analysis: analysis(),
    event: { hasEarnings: true, daysUntil: 2, label: 'Earnings in 2 days' },
  });
  assert.equal(alert.action, 'accumulate');
  assert.match(alert.reason, /Earnings in 2 day/);
});

test('a negative news shock blocks a fresh buy', () => {
  const alert = buildAlert({ analysis: analysis(), news: news(-55) });
  assert.equal(alert.action, 'accumulate');
  assert.match(alert.reason, /sharply negative/);
});

test('positive news flow lifts confidence, thin samples do not', () => {
  const base = buildAlert({ analysis: analysis() });
  const tailwind = buildAlert({ analysis: analysis(), news: news(45) });
  const thin = buildAlert({ analysis: analysis(), news: news(90, 1) });
  assert.ok(tailwind.confidence > base.confidence);
  assert.equal(thin.confidence, base.confidence);
  assert.ok(tailwind.confidence <= 92);
});

test('an improving archived trend adds confidence', () => {
  const base = buildAlert({ analysis: analysis() });
  const improving = buildAlert({
    analysis: analysis(),
    newsHistory: { delta7: 12, direction: 'improving', sentiment7: 20 },
  });
  assert.ok(improving.confidence > base.confidence);
  assert.match(improving.reason, /7-day trend is improving/);
});

test('confidence stays inside its bounds even with stacked negatives', () => {
  const alert = buildAlert({
    analysis: analysis({ indicators: { adx14: 8, volumeRatio: 0.6 }, plan: { stopLoss: 98, riskReward: 1.1 } }),
    news: news(-80),
    event: { hasEarnings: true, daysUntil: 1 },
    analyst: { tilt: -0.9 },
  });
  assert.ok(alert.confidence >= 25 && alert.confidence <= 92);
  // Two blockers take a buy to hold; they never create a sell on their own.
  assert.equal(alert.action, 'hold');
  assert.equal(alert.setup, 'pullback');
});
