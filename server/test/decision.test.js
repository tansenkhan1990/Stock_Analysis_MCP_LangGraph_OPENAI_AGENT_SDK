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
import { buildAnalysis } from '../src/analytics/analysis.js';

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
