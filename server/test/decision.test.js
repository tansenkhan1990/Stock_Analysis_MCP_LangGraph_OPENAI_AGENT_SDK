import test from 'node:test';
import assert from 'node:assert/strict';
import {
  builtinDecision,
  combinedSignal,
  eventRisk,
  pickPlanForAction,
  tradeTriggers,
} from '../src/analytics/decision.js';
import { normalizeAction, normalizeDecision, parseDecisionJson } from '../src/agent/llmDecision.js';
import { peekDecision, withDeskDecision } from '../src/agent/symbolDesk.js';
import { buildAnalysis } from '../src/analytics/analysis.js';
import { cache } from '../src/lib/cache.js';

function makeBars(n, drift = 0.3) {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i * drift + Math.sin(i / 16) * 3;
    return {
      date: new Date(Date.now() - (n - i) * 86_400_000).toISOString(),
      open: close - 0.4,
      high: close + 1,
      low: close - 1,
      close,
      adjClose: close,
      volume: 1_000_000 * (1 + 0.3 * Math.sin(i / 5)),
    };
  });
}

const analysisFixture = () => {
  const bars = makeBars(260);
  const quote = {
    symbol: 'NVDA',
    name: 'NVIDIA Corp.',
    quoteType: 'EQUITY',
    currency: 'USD',
    price: Number(bars.at(-1).close.toFixed(2)),
    change: 1.4,
    changePercent: 0.9,
    beta: 1.6,
  };
  return buildAnalysis({ quote, history: { bars }, fundamentals: null });
};

const newsFixture = (sentiment) => ({
  sentiment,
  label: sentiment > 12 ? 'positive' : sentiment < -12 ? 'negative' : 'mixed',
  headlineCount: 8,
  counts: { bullish: 5, bearish: 1, neutral: 2 },
  deals: sentiment > 0 ? [{ title: 'NVDA signs supply deal', direction: 'bullish', score: 45 }] : [],
  catalysts: [{ title: 'Nvidia beats on record revenue', direction: sentiment > 0 ? 'bullish' : 'bearish', score: sentiment, tags: ['Earnings'] }],
  risks: sentiment < 0 ? [{ title: 'Export restrictions bite', score: -40, tags: ['Macro'] }] : [],
  headlines: [],
});

test('positive news and upgrades lift the fused score above negative news', () => {
  const analysis = analysisFixture();
  const bullish = combinedSignal({
    analysis,
    news: newsFixture(45),
    analyst: { tilt: 0.6, upgrades: 5, downgrades: 1, total: 6, window: '120 days', latest: [] },
    event: { hasEarnings: false },
  });
  const bearish = combinedSignal({
    analysis,
    news: newsFixture(-45),
    analyst: { tilt: -0.6, upgrades: 0, downgrades: 5, total: 5, window: '120 days', latest: [] },
    event: { hasEarnings: true, daysUntil: 3, label: 'Earnings in 3 days' },
  });

  assert.ok(bullish.score > bearish.score);
  assert.ok(bullish.conviction > bearish.conviction);
  // Quality is explicitly action-free: the alert owns the action.
  assert.equal(bullish.action, undefined);
  assert.equal(bullish.actionLabel, undefined);
  assert.equal(bullish.components.length, 4);
  assert.ok(bullish.components.every((component) => component.weight > 0));
});

test('event risk flags imminent earnings and counts conviction down', () => {
  const imminent = eventRisk({ earningsDate: new Date(Date.now() + 4 * 86_400_000).toISOString() });
  const distant = eventRisk({ earningsDate: new Date(Date.now() + 60 * 86_400_000).toISOString() });
  assert.equal(imminent.hasEarnings, true);
  assert.ok(imminent.daysUntil <= 5);
  assert.equal(distant.hasEarnings, false);

  const analysis = analysisFixture();
  const neutralNews = newsFixture(10);
  const analyst = { tilt: 0.2, upgrades: 2, downgrades: 1, total: 3, window: '120 days', latest: [] };
  const noEvent = combinedSignal({ analysis, news: neutralNews, analyst, event: { hasEarnings: false } });
  const withEvent = combinedSignal({ analysis, news: neutralNews, analyst, event: imminent });
  assert.ok(noEvent.conviction > withEvent.conviction);
  assert.ok(noEvent.conviction <= 95 && withEvent.conviction >= 30);
});

test('the rule-engine action is the alert action, not the quality score', () => {
  const analysis = analysisFixture();
  const decision = builtinDecision({
    symbol: 'NVDA',
    meta: { symbol: 'NVDA', name: 'NVIDIA Corp.', theme: 'AI compute' },
    analysis,
    news: newsFixture(10),
    analyst: { tilt: 0, upgrades: 1, downgrades: 1, total: 2, window: '120 days', latest: [] },
    event: eventRisk({}),
    options: null,
  });

  assert.equal(decision.action, analysis.alert.action);
  assert.equal(decision.actionLabel, analysis.alert.actionLabel);
  assert.equal(decision.setupLabel, analysis.alert.setupLabel);
});

test('rule-engine decision satisfies the contract', () => {
  const analysis = analysisFixture();
  const decision = builtinDecision({
    symbol: 'NVDA',
    meta: { symbol: 'NVDA', name: 'NVIDIA Corp.', theme: 'AI compute' },
    analysis,
    news: newsFixture(30),
    analyst: { tilt: 0.4, upgrades: 3, downgrades: 1, total: 4, window: '120 days', latest: [{ date: '2026-10-01', firm: 'Citi', action: 'main', toGrade: 'Buy', score: 1 }] },
    event: eventRisk({}),
    options: null,
  });

  assert.ok(['buy', 'accumulate', 'hold', 'reduce', 'sell'].includes(decision.action));
  assert.ok(decision.conviction >= 30 && decision.conviction <= 95);
  assert.ok(decision.thesis.length > 80);
  assert.ok(Array.isArray(decision.upsideDrivers) && decision.upsideDrivers.length > 0);
  assert.ok(Array.isArray(decision.downsideRisks));
  assert.ok(decision.catalysts.length > 0);
  assert.equal(typeof decision.keyLevels.stop, 'number');
  assert.ok(decision.invalidations.length >= 2);
  assert.equal(decision.generatedBy, 'rule-engine');
  assert.ok([analysis.plan.stopLoss, analysis.plan.targets[0].price].every((value) => Number.isFinite(value)));
});

test('every call carries a two-sided trigger with buy above and sell below', () => {
  const analysis = analysisFixture();
  const triggers = tradeTriggers({ analysis });

  assert.ok(triggers, 'triggers exist for a normal analysis');
  assert.ok(Number.isFinite(triggers.buyAbove));
  assert.ok(Number.isFinite(triggers.sellBelow));
  assert.ok(triggers.buyAbove >= analysis.price, 'buy trigger is never below spot');
  assert.ok(triggers.sellBelow < triggers.buyAbove, 'sell trigger sits below the buy trigger');
  assert.ok(triggers.sellBelow < analysis.price, 'sell trigger is always below spot');
  assert.ok(triggers.sellBelow > 0);
  assert.equal(typeof triggers.buyNote, 'string');
  assert.equal(typeof triggers.sellNote, 'string');
  assert.ok(Number.isFinite(triggers.distanceToBuyPct));
  assert.ok(triggers.distanceToSellPct < 0, 'distance to the sell trigger is negative');

  // A bearish plan may carry an overhead trim zone, but never an overhead exit.
  const bearish = JSON.parse(JSON.stringify(analysis));
  bearish.plan.shortZone = { low: bearish.price + 5, high: bearish.price + 12 };
  bearish.plan.stopLoss = bearish.price + 10;
  const bearishTriggers = tradeTriggers({ analysis: bearish });
  assert.ok(bearishTriggers.sellBelow < bearish.price);
  assert.equal(bearishTriggers.trimAbove, bearish.plan.shortZone.low);

  const decision = builtinDecision({
    symbol: 'NVDA',
    meta: { symbol: 'NVDA', name: 'NVIDIA Corp.', theme: 'AI compute' },
    analysis,
    news: newsFixture(20),
    analyst: { tilt: 0.2, upgrades: 2, downgrades: 1, total: 3, window: '120 days', latest: [] },
    event: eventRisk({}),
    options: null,
  });
  assert.deepEqual(decision.triggers, triggers);
});

test('the exit trigger never sits inside the buy zone it tells you to accumulate in', () => {
  const analysis = analysisFixture();
  const triggers = tradeTriggers({ analysis });

  assert.ok(analysis.plan.buyZone, 'fixture carries an accumulation range');
  assert.ok(
    triggers.sellBelow <= analysis.plan.buyZone.low,
    `exit ${triggers.sellBelow} must sit below the ${analysis.plan.buyZone.low} buy-zone floor`,
  );
  // The exit is either an earlier support break above the stop or the stop
  // itself. Never a level between the two: when the nearest support sits inside
  // the buy zone, the exit is the stop (a "support break" there would be a price
  // the card still tells you to buy at).
  assert.ok(triggers.sellBelow >= analysis.plan.stopLoss, 'the exit sits at or above the hard stop');
  assert.equal(triggers.exitIsStop, true, 'a support inside the buy zone hands the exit to the planned stop');
  assert.match(triggers.sellHint, /stop-loss exit, not a sell target/);
});

test('a long card names the lower level as an exit, not a sell target', () => {
  const analysis = analysisFixture();
  const triggers = tradeTriggers({ analysis });
  const entry = analysis.plan.entryRef ?? analysis.price;

  assert.equal(triggers.buyLabel, 'BUY ABOVE');
  assert.equal(triggers.sellLabel, 'EXIT BELOW');
  assert.match(triggers.sellHint, /not a sell target/);
  // The exit is below the reference entry by construction; the profit targets
  // are the numbers above spot, so "sell lower" is the stop-loss, not a loss-making
  // trade instruction.
  assert.ok(triggers.sellBelow < entry);
  assert.ok(triggers.buyAbove >= analysis.price);
  assert.ok(analysis.plan.targets[0].price > analysis.price);
});

test('a short card enters above its first target, never below it', () => {
  const long = analysisFixture();
  const short = JSON.parse(JSON.stringify(long));
  short.plan.direction = 'short';
  short.plan.buyZone = null;
  short.plan.shortZone = { low: Number((short.price + 3).toFixed(2)), high: Number((short.price + 6).toFixed(2)) };
  short.plan.stopLoss = Number((short.price + 8).toFixed(2));
  short.plan.targets = [
    { label: 'T1', price: Number((short.price - 4).toFixed(2)), upsidePct: 2.3, source: 'support', probability: 60 },
    { label: 'T2', price: Number((short.price - 8).toFixed(2)), upsidePct: 4.6, source: 'ATR projection', probability: 50 },
    { label: 'T3', price: Number((short.price - 12).toFixed(2)), upsidePct: 6.9, source: 'ATR projection', probability: 40 },
  ];

  const triggers = tradeTriggers({ analysis: short });

  assert.equal(triggers.buyLabel, 'STOP ABOVE');
  assert.equal(triggers.sellLabel, 'BREAKDOWN BELOW');
  assert.match(triggers.sellHint, /not a short recommendation/);
  assert.ok(triggers.sellBelow < short.price, 'the breakdown level is below spot');
  assert.ok(
    triggers.sellBelow > short.plan.targets[0].price,
    `breakdown level ${triggers.sellBelow} must sit above T1 ${short.plan.targets[0].price}`,
  );
  assert.match(triggers.sellNote, /first downside level/);
});

test('a price inside the buy zone is called in-zone, not a breakout', () => {
  const inZone = JSON.parse(JSON.stringify(analysisFixture()));
  inZone.plan.buyZone = { low: Number((inZone.price * 0.98).toFixed(2)), high: inZone.price };
  inZone.plan.stopLoss = Number((inZone.price * 0.95).toFixed(2));

  const triggers = tradeTriggers({ analysis: inZone });

  assert.equal(triggers.inBuyZone, true);
  // The breakout level is a whisker above spot, so the note (and the card) must
  // say the zone is already live instead of asking for a breakout.
  assert.ok(triggers.distanceToBuyPct >= 0 && triggers.distanceToBuyPct < 0.2);
  assert.match(triggers.buyNote, /inside the .+ buy zone — accumulate here/);
  assert.ok(triggers.sellBelow <= inZone.plan.buyZone.low);
});

test('on a Reduce/Sell call the upper level is a reclaim, not a buy trigger', () => {
  const analysis = analysisFixture();
  analysis.alert = { ...(analysis.alert || {}), action: 'reduce', actionLabel: 'Reduce' };
  const triggers = tradeTriggers({ analysis });

  assert.equal(triggers.buyLabel, 'RECLAIM ABOVE');
  assert.match(triggers.buyHint, /cancel the exit call/);
  assert.equal(triggers.sellLabel, 'EXIT BELOW');
});

test('an LLM short entry below its own first target is rejected', () => {
  const short = JSON.parse(JSON.stringify(analysisFixture()));
  short.plan.direction = 'short';
  short.plan.buyZone = null;
  short.plan.shortZone = { low: Number((short.price + 3).toFixed(2)), high: Number((short.price + 6).toFixed(2)) };
  short.plan.stopLoss = Number((short.price + 8).toFixed(2));
  short.plan.targets = [
    { label: 'T1', price: Number((short.price - 4).toFixed(2)), upsidePct: 2.3, source: 'support', probability: 60 },
    { label: 'T2', price: Number((short.price - 8).toFixed(2)), upsidePct: 4.6, source: 'ATR projection', probability: 50 },
    { label: 'T3', price: Number((short.price - 12).toFixed(2)), upsidePct: 6.9, source: 'ATR projection', probability: 40 },
  ];
  const fallback = builtinDecision({
    symbol: 'TSLA',
    meta: { symbol: 'TSLA', name: 'Tesla Inc.', theme: 'EV' },
    analysis: short,
    news: newsFixture(-20),
    analyst: { tilt: -0.2, upgrades: 1, downgrades: 2, total: 3, window: '120 days', latest: [] },
    event: eventRisk({}),
    options: null,
  });

  // "Short below T1" would leave the model's own first target above its entry.
  const belowTarget = normalizeDecision(
    { action: 'sell', triggers: { sellBelow: Number((fallback.triggers.firstTarget - 1).toFixed(2)) } },
    fallback,
    { price: short.price, buyZone: null },
  );
  assert.equal(belowTarget.triggers.sellBelow, fallback.triggers.sellBelow);

  // A level above the first target is accepted and keeps the target below it.
  const inRange = Number((fallback.triggers.firstTarget + 1).toFixed(2));
  const accepted = normalizeDecision(
    { action: 'sell', triggers: { sellBelow: inRange } },
    fallback,
    { price: short.price, buyZone: null },
  );
  assert.equal(accepted.triggers.sellBelow, inRange);
});

test('LLM trigger levels on the wrong side of the plan are rejected', () => {
  const analysis = analysisFixture();
  const fallback = builtinDecision({
    symbol: 'NVDA',
    meta: { symbol: 'NVDA', name: 'NVIDIA Corp.', theme: 'AI compute' },
    analysis,
    news: newsFixture(20),
    analyst: { tilt: 0, upgrades: 1, downgrades: 1, total: 2, window: '120 days', latest: [] },
    event: eventRisk({}),
    options: null,
  });
  const { price, plan } = analysis;
  assert.ok(plan.buyZone, 'fixture carries an accumulation range');

  const decision = normalizeDecision(
    {
      action: 'hold',
      // A "buy above" level below spot, and an exit inside the accumulation
      // range, would each print a level that contradicts its own label.
      triggers: { buyAbove: Number((price * 0.99).toFixed(2)), sellBelow: Number((plan.buyZone.low + 0.5).toFixed(2)) },
    },
    fallback,
    { price, buyZone: plan.buyZone },
  );

  assert.equal(decision.triggers.buyAbove, fallback.triggers.buyAbove);
  assert.equal(decision.triggers.sellBelow, fallback.triggers.sellBelow);

  // Levels on the correct side still come through.
  const accepted = normalizeDecision(
    { action: 'hold', triggers: { buyAbove: Number((price * 1.02).toFixed(2)), sellBelow: fallback.triggers.sellBelow } },
    fallback,
    { price, buyZone: plan.buyZone },
  );
  assert.equal(accepted.triggers.buyAbove, Number((price * 1.02).toFixed(2)));
});

test('a desk call owns the decision while the engine keeps supplying the rest', () => {
  const engineDecision = {
    action: 'buy',
    actionLabel: 'Buy',
    score: 72,
    setup: 'pullback',
    setupLabel: 'Uptrend pullback',
    conviction: 64,
  };
  const desk = {
    decision: { action: 'hold', actionLabel: 'Hold', generatedBy: 'llm', conviction: 55 },
    decisionMeta: { provider: 'openai', model: 'test-model' },
  };

  assert.deepEqual(withDeskDecision(engineDecision, null), engineDecision, 'no desk call leaves the engine in place');
  assert.deepEqual(withDeskDecision(engineDecision, {}), engineDecision);

  const merged = withDeskDecision(engineDecision, desk);
  assert.equal(merged.action, 'hold', 'the model owns the action');
  assert.equal(merged.generatedBy, 'llm');
  assert.equal(merged.score, 72, 'the fused quality score survives');
  assert.equal(merged.setupLabel, 'Uptrend pullback', 'the engine setup context survives as the cross-check');
});

test('a prepared desk call can be read back without calling the model', () => {
  const decision = { action: 'accumulate', actionLabel: 'Accumulate', generatedBy: 'llm' };
  cache.set('decision:ZZTEST', { decision, decisionMeta: { provider: 'openai', model: 'm' } }, 60_000);

  const peeked = peekDecision('ZZTEST');
  assert.equal(peeked.decision.action, 'accumulate');
  assert.equal(peeked.decisionMeta.cached, true);

  cache.clear('decision:ZZTEST');
  assert.equal(peekDecision('ZZTEST'), null, 'an expired/absent call never falls back to a cached engine verdict');
});

test('LLM action aliases normalize onto the enum', () => {
  assert.equal(normalizeAction('Strong Buy'), 'buy');
  assert.equal(normalizeAction('accumulate'), 'accumulate');
  assert.equal(normalizeAction('Market Perform'), 'hold');
  assert.equal(normalizeAction('Trim'), 'reduce');
  assert.equal(normalizeAction('Exit'), 'sell');
  assert.equal(normalizeAction(undefined), 'hold');
});

test('parseDecisionJson tolerates fenced and chatty model output', () => {
  assert.deepEqual(parseDecisionJson('{"action":"buy"}'), { action: 'buy' });
  assert.deepEqual(parseDecisionJson('```json\n{"action":"sell","conviction":70}\n```'), { action: 'sell', conviction: 70 });
  assert.deepEqual(parseDecisionJson('Here you go:\n{"action":"hold"} — hope that helps'), { action: 'hold' });
  assert.equal(parseDecisionJson('no json here'), null);
});

test('normalizeDecision clamps values and backfills from the rule engine', () => {
  const fallback = builtinDecision({
    symbol: 'NVDA',
    meta: { symbol: 'NVDA' },
    analysis: analysisFixture(),
    news: newsFixture(20),
    analyst: { tilt: 0.3, upgrades: 2, downgrades: 0, total: 2, window: '120 days', latest: [] },
    event: eventRisk({}),
    options: null,
  });

  const decision = normalizeDecision(
    {
      action: 'STRONG BUY',
      conviction: 250,
      thesis: 'x'.repeat(200),
      catalysts: [{ type: 'weird', direction: 'up', detail: 'Deal signed' }],
      keyLevels: { entry: 'not a number', target: 250, stop: -5 },
      optionsIdea: { name: 'Bull call spread', legs: ['Buy call 200 @ 5'], probabilityOfProfit: 140 },
    },
    fallback,
  );

  assert.equal(decision.action, 'buy');
  assert.equal(decision.conviction, 99);
  assert.equal(decision.keyLevels.target, 250);
  assert.equal(decision.keyLevels.entry, fallback.keyLevels.entry);
  assert.equal(decision.keyLevels.stop, fallback.keyLevels.stop);
  assert.deepEqual(decision.catalysts[0], { type: 'news', direction: 'neutral', detail: 'Deal signed' });
  assert.equal(decision.optionsIdea.probabilityOfProfit, 100);
  assert.equal(decision.generatedBy, 'llm');
  assert.ok(decision.horizon);
});

test('LLM trigger levels override the rule-engine levels and otherwise inherit them', () => {
  const analysis = analysisFixture();
  const fallback = builtinDecision({
    symbol: 'NVDA',
    meta: { symbol: 'NVDA', name: 'NVIDIA Corp.', theme: 'AI compute' },
    analysis,
    news: newsFixture(20),
    analyst: { tilt: 0.1, upgrades: 1, downgrades: 1, total: 2, window: '120 days', latest: [] },
    event: eventRisk({}),
    options: null,
  });

  const overridden = normalizeDecision(
    { action: 'hold', triggers: { buyAbove: 210.5, sellBelow: 181.25 } },
    fallback,
  );
  assert.equal(overridden.triggers.buyAbove, 210.5);
  assert.equal(overridden.triggers.sellBelow, 181.25);

  const inherited = normalizeDecision({ action: 'hold' }, fallback);
  assert.equal(inherited.triggers.buyAbove, fallback.triggers.buyAbove);
  assert.equal(inherited.triggers.sellBelow, fallback.triggers.sellBelow);
  assert.equal(inherited.triggers.stop, fallback.triggers.stop);
});

test('crossed LLM triggers are rejected and the rule-engine levels survive', () => {
  const analysis = analysisFixture();
  const fallback = builtinDecision({
    symbol: 'NVDA',
    meta: { symbol: 'NVDA', name: 'NVIDIA Corp.', theme: 'AI compute' },
    analysis,
    news: newsFixture(20),
    analyst: { tilt: 0, upgrades: 1, downgrades: 1, total: 2, window: '120 days', latest: [] },
    event: eventRisk({}),
    options: null,
  });

  const price = analysis.price;
  const decision = normalizeDecision(
    { action: 'hold', triggers: { buyAbove: price * 0.5, sellBelow: price * 1.5 } },
    fallback,
    { price },
  );

  assert.equal(decision.triggers.buyAbove, fallback.triggers.buyAbove);
  assert.equal(decision.triggers.sellBelow, fallback.triggers.sellBelow);
  assert.ok(decision.triggers.distanceToSellPct < 0);
});

test('the options expression follows the alert, not the stale plan direction', () => {
  const plans = [
    { name: 'Bull put spread', bias: 'bullish', legs: [], metrics: { maxLoss: -300, probabilityOfProfit: 70 }, thesis: 'Bullish' },
    { name: 'Bear put spread', bias: 'bearish', legs: [], metrics: { maxLoss: -250, probabilityOfProfit: 55 }, thesis: 'Bearish' },
  ];

  assert.equal(pickPlanForAction(plans, 'buy').name, 'Bull put spread');
  assert.equal(pickPlanForAction(plans, 'accumulate').name, 'Bull put spread');
  assert.equal(pickPlanForAction(plans, 'sell').name, 'Bear put spread');
  assert.equal(pickPlanForAction(plans, 'reduce').name, 'Bear put spread');
  assert.equal(pickPlanForAction(plans, 'hold').name, 'Bull put spread');

  const onlyBullish = plans.slice(0, 1);
  assert.equal(pickPlanForAction(onlyBullish, 'sell'), null, 'a sell alert must not carry a bullish structure');
  assert.equal(pickPlanForAction([], 'buy'), null);
});
