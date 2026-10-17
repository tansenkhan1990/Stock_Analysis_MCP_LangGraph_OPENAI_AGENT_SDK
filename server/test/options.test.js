import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blackScholes,
  buildOptionPlans,
  daysToExpiry,
  evaluateStrategy,
  summarizeChain,
} from '../src/analytics/options.js';

const leg = (kind, action, strike, premium, qty = 1) => ({ kind, action, strike, premium, qty });

test('Black-Scholes satisfies put-call parity', () => {
  const params = { spot: 100, strike: 105, years: 0.5, iv: 0.3, rate: 0.04 };
  const call = blackScholes({ ...params, type: 'call' });
  const put = blackScholes({ ...params, type: 'put' });
  const parity = call.price - put.price;
  const expected = params.spot - params.strike * Math.exp(-params.rate * params.years);
  assert.ok(Math.abs(parity - expected) < 0.01);
  assert.ok(call.delta > 0 && put.delta < 0);
});

test('long call has capped loss, unlimited upside and correct breakeven', () => {
  const metrics = evaluateStrategy([leg('call', 'buy', 100, 5)], 100, { iv: 0.3, dte: 30 });
  assert.equal(metrics.maxLoss, -500);
  assert.equal(metrics.maxProfitUnbounded, true);
  assert.deepEqual(metrics.breakevens, [105]);
  assert.ok(metrics.greeks.delta > 0);
  assert.ok(metrics.probabilityOfProfit > 0 && metrics.probabilityOfProfit < 100);
});

test('a long put reports the payoff at zero, not a truncated grid edge', () => {
  const metrics = evaluateStrategy([leg('put', 'buy', 100, 5)], 100, { iv: 0.3, dte: 30 });
  // Full intrinsic at a price of zero is 100 × $100 = $10,000, minus the $500
  // premium. The old grid stopped at 0.6 × spot and reported $3,500.
  assert.equal(metrics.maxProfit, 9500);
  assert.equal(metrics.maxProfitUnbounded, false);
  assert.deepEqual(metrics.breakevens, [95]);
});

test('a naked short put reports its true loss at zero', () => {
  const metrics = evaluateStrategy([leg('put', 'sell', 100, 5)], 100, { iv: 0.3, dte: 30 });
  assert.equal(metrics.maxLoss, -9500);
  assert.equal(metrics.maxLossUnbounded, false);
});

test('bad IV/DTE inputs are normalised instead of inverting the probability', () => {
  const good = evaluateStrategy([leg('call', 'buy', 100, 5)], 100, { iv: 0.3, dte: 30 });
  const badIv = evaluateStrategy([leg('call', 'buy', 100, 5)], 100, { iv: -0.3, dte: 30 });
  assert.deepEqual(badIv.breakevens, good.breakevens);
  assert.equal(badIv.probabilityOfProfit, good.probabilityOfProfit);
  assert.deepEqual(badIv.greeks, good.greeks);

  // A negative DTE is floored to one day rather than producing a negative sigma.
  const badDte = evaluateStrategy([leg('call', 'buy', 100, 5)], 100, { iv: 0.3, dte: -5 });
  assert.ok(Number.isFinite(badDte.probabilityOfProfit));
  assert.ok(badDte.probabilityOfProfit >= 0 && badDte.probabilityOfProfit <= 100);
  assert.ok(Number.isFinite(badDte.greeks.delta));
});

test('an invalid expiry string yields 0 DTE instead of NaN', () => {
  assert.equal(daysToExpiry('not-a-date'), 0);
});

test('bull call spread has defined max profit, max loss and one breakeven', () => {
  const metrics = evaluateStrategy(
    [leg('call', 'buy', 100, 5), leg('call', 'sell', 110, 2)],
    100,
    { iv: 0.3, dte: 30 },
  );
  assert.equal(metrics.maxProfit, 700);
  assert.equal(metrics.maxLoss, -300);
  assert.equal(metrics.maxProfitUnbounded, false);
  assert.deepEqual(metrics.breakevens, [103]);
  assert.equal(metrics.netPremium, 300); // positive = net debit paid
  assert.ok(metrics.returnOnRisk > 2);
});

test('covered call shows stock protection and capped upside', () => {
  const metrics = evaluateStrategy(
    [leg('stock', 'buy', null, 0), leg('call', 'sell', 110, 3)],
    100,
    { iv: 0.3, dte: 30 },
  );
  assert.equal(metrics.maxProfit, 1300);
  assert.equal(metrics.maxLossUnbounded, false);
  assert.ok(metrics.breakevens.includes(97));
});

test('probability of profit integrates every profitable region, not just the gap between breakevens', () => {
  // A long straddle profits OUTSIDE its two breakevens. The old shortcut
  // reported P(between the breakevens), which is this trade's probability of
  // LOSS (~76%) rather than its probability of profit (~24%).
  const straddle = evaluateStrategy(
    [leg('call', 'buy', 100, 5), leg('put', 'buy', 100, 5)],
    100,
    { iv: 0.3, dte: 30 },
  );
  assert.deepEqual(straddle.breakevens, [90, 110]);
  assert.ok(straddle.probabilityOfProfit < 40, `PoP ${straddle.probabilityOfProfit}%`);
  assert.ok(straddle.probabilityOfProfit > 10, `PoP ${straddle.probabilityOfProfit}%`);

  // The same rule must still put an iron condor's profit INSIDE the breakevens.
  const condor = evaluateStrategy(
    [
      leg('put', 'buy', 80, 1.2),
      leg('put', 'sell', 90, 3),
      leg('call', 'sell', 110, 3.2),
      leg('call', 'buy', 120, 1.4),
    ],
    100,
    { iv: 0.28, dte: 35 },
  );
  assert.ok(condor.probabilityOfProfit > 40, `PoP ${condor.probabilityOfProfit}%`);
});

test('iron condor is a net credit with two breakevens', () => {
  const metrics = evaluateStrategy(
    [
      leg('put', 'buy', 80, 1.2),
      leg('put', 'sell', 90, 3),
      leg('call', 'sell', 110, 3.2),
      leg('call', 'buy', 120, 1.4),
    ],
    100,
    { iv: 0.28, dte: 35 },
  );
  assert.equal(metrics.maxProfit, 360);
  assert.equal(metrics.maxLoss, -640);
  assert.equal(metrics.breakevens.length, 2);
  assert.ok(metrics.probabilityOfProfit > 40);
});

const syntheticChain = () => {
  const strikes = [80, 85, 90, 95, 100, 105, 110, 115, 120];
  const contract = (kind, strike) => {
    const mid = Math.max(0.6, 8 - Math.abs(100 - strike) * 0.9) + (kind === 'put' ? 0.2 : 0);
    return {
      contractSymbol: `${kind[0].toUpperCase()}${strike}`,
      strike,
      mid,
      bid: Number((mid - 0.05).toFixed(2)),
      ask: Number((mid + 0.05).toFixed(2)),
      lastPrice: mid,
      impliedVolatility: 0.3,
      openInterest: 500,
      volume: 40,
    };
  };
  return {
    calls: strikes.map((strike) => contract('call', strike)),
    puts: strikes.map((strike) => contract('put', strike)),
    expiration: new Date(Date.now() + 35 * 86_400_000).toISOString().slice(0, 10),
  };
};

const planInput = (action, extra = {}) => ({
  symbol: 'TEST',
  spot: 100,
  score: 72,
  direction: 'long',
  action,
  chain: syntheticChain(),
  // 30% IV against 30% realised keeps IV "fair", so neither branch relies on
  // the rich-IV premium-selling path.
  realizedVol: 30,
  atrValue: 2,
  targets: [{ price: 108 }, { price: 116 }],
  stopLoss: 95,
  support: 94,
  resistance: 106,
  ...extra,
});

test('option structures follow the alert, not the technical score band', () => {
  const buy = buildOptionPlans(planInput('buy'));
  assert.ok(buy.plans.length > 0);
  assert.ok(buy.plans.every((plan) => plan.bias === 'bullish'));

  const sell = buildOptionPlans(planInput('sell', { score: 30, direction: 'short' }));
  assert.ok(sell.plans.length > 0);
  assert.ok(sell.plans.every((plan) => plan.bias === 'bearish'));

  // Hold = do not add directional risk, even when quality is high and the
  // technical plan still points long.
  const hold = buildOptionPlans(planInput('hold'));
  assert.ok(hold.plans.every((plan) => plan.bias === 'neutral'));

  const holdRich = buildOptionPlans(planInput('hold', { realizedVol: 20 }));
  assert.equal(holdRich.plans[0]?.name, 'Iron condor');
  assert.equal(holdRich.plans[0]?.bias, 'neutral');
});

test('a spread whose long leg collapses onto the short strike is dropped, not shipped', () => {
  // Support below the lowest listed put makes the rich-IV bull put spread pick
  // the same strike twice (sell 80 / buy 80) — that is not a spread.
  const bull = buildOptionPlans(planInput('buy', { realizedVol: 20, support: 70 }));
  assert.ok(bull.plans.length > 0);
  for (const plan of bull.plans) {
    const strikes = plan.legs.map((item) => `${item.kind}:${item.strike}`);
    assert.equal(new Set(strikes).size, strikes.length, `${plan.name} repeats a strike`);
  }

  // The mirror case: resistance above the highest listed call.
  const bear = buildOptionPlans(
    planInput('sell', { score: 30, direction: 'short', realizedVol: 20, resistance: 130 }),
  );
  for (const plan of bear.plans) {
    const strikes = plan.legs.map((item) => `${item.kind}:${item.strike}`);
    assert.equal(new Set(strikes).size, strikes.length, `${plan.name} repeats a strike`);
  }
});

test('chain summary computes PCR, max pain and expected move', () => {
  const calls = [
    { strike: 90, openInterest: 100, volume: 10, impliedVolatility: 0.35, mid: 12, bid: 11.9, ask: 12.1, lastPrice: 12 },
    { strike: 100, openInterest: 500, volume: 50, impliedVolatility: 0.3, mid: 5, bid: 4.9, ask: 5.1, lastPrice: 5 },
    { strike: 110, openInterest: 200, volume: 20, impliedVolatility: 0.32, mid: 1.5, bid: 1.45, ask: 1.55, lastPrice: 1.5 },
  ];
  const puts = [
    { strike: 90, openInterest: 400, volume: 40, impliedVolatility: 0.36, mid: 1.6, bid: 1.55, ask: 1.65, lastPrice: 1.6 },
    { strike: 100, openInterest: 450, volume: 45, impliedVolatility: 0.31, mid: 4.5, bid: 4.45, ask: 4.55, lastPrice: 4.5 },
    { strike: 110, openInterest: 120, volume: 12, impliedVolatility: 0.33, mid: 10, bid: 9.9, ask: 10.1, lastPrice: 10 },
  ];
  const expiration = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const summary = summarizeChain({ calls, puts, spot: 101, expiration, realizedVol: 25 });

  assert.equal(summary.pcrOi, 1.21);
  assert.equal(summary.maxPain, 100);
  assert.ok(summary.expectedMove > 0);
  assert.ok(summary.expectedMovePct > 0);
  assert.ok(summary.atmIv > 25 && summary.atmIv < 35);
  assert.ok(['rich', 'fair', 'cheap'].includes(summary.ivState));
});
