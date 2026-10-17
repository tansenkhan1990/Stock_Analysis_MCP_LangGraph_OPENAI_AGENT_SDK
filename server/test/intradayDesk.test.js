import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntradayDossier,
  decideIntradayWithLLM,
  mergeIntradayDecision,
  normalizeIntradayDecision,
} from '../src/agent/intradayDesk.js';
import { buildDayTrade } from '../src/analytics/dayTrading.js';

const BARS_PER_SESSION = 78;

function makeSession(date, startPrice, step, { bars = BARS_PER_SESSION } = {}) {
  const start = new Date(`${date}T13:30:00.000Z`).getTime();
  return Array.from({ length: bars }, (_, index) => {
    const close = startPrice + step * index;
    const open = startPrice + step * (index - 0.3);
    return {
      date: new Date(start + index * 5 * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + Math.abs(step) * 0.8 + 0.02,
      low: Math.min(open, close) - Math.abs(step) * 0.8 - 0.02,
      close,
      volume: 100_000,
    };
  });
}

const engineTrade = (symbol = 'TEST') => {
  const bars = [...makeSession('2026-10-15', 100, 0.05), ...makeSession('2026-10-16', 103.9, 0.06)];
  return buildDayTrade({
    quote: {
      symbol,
      name: 'Test Corp.',
      quoteType: 'EQUITY',
      exchange: 'NasdaqGS',
      marketState: 'REGULAR',
      price: bars[bars.length - 1].close,
      previousClose: bars[BARS_PER_SESSION - 1].close,
      changePercent: 1.1,
    },
    history: { bars },
  });
};

const flatTrade = () => {
  const bars = [
    ...makeSession('2026-10-15', 100, 0.001),
    ...makeSession('2026-10-16', 100.02, 0.001),
  ];
  return buildDayTrade({
    quote: {
      symbol: 'FLAT',
      name: 'Flat Corp.',
      quoteType: 'EQUITY',
      exchange: 'NYSE',
      marketState: 'REGULAR',
      price: bars[bars.length - 1].close,
      previousClose: bars[BARS_PER_SESSION - 1].close,
      changePercent: 0.01,
    },
    history: { bars },
  });
};

test('the intraday desk turns model aliases into buy / sell / wait', () => {
  const trade = engineTrade();
  const buy = normalizeIntradayDecision({ action: 'STRONG BUY', conviction: 240, thesis: 'x'.repeat(80) }, trade, {
    price: trade.price,
    atr: trade.indicators.atr14,
  });
  assert.equal(buy.action, 'buy');
  assert.equal(buy.actionLabel, 'Buy');
  assert.equal(buy.conviction, 95);
  assert.equal(buy.plan.direction, 'long');
  assert.equal(buy.plan.targets.length, 3);
  assert.ok(buy.plan.riskPerShare > 0);
  assert.ok(buy.plan.targets[2].price > buy.plan.targets[0].price);

  const sell = normalizeIntradayDecision({ action: 'short the rip', conviction: 70 }, trade, { price: trade.price });
  assert.equal(sell.action, 'sell');
  assert.equal(sell.plan.direction, 'short');
  for (const target of sell.plan.targets) assert.ok(target.price < sell.plan.entry);

  const wait = normalizeIntradayDecision({ action: 'market perform', conviction: 90 }, trade, { price: trade.price });
  assert.equal(wait.action, 'wait');
  assert.equal(wait.plan, null);
  assert.ok(wait.conviction <= 60, 'a no-trade read must not carry a high conviction');
});

test('stop and target prices from the model are validated against spot and ATR', () => {
  const trade = engineTrade();
  const price = trade.price;

  // A long stop above entry is nonsense: it must be replaced with a usable one.
  const broken = normalizeIntradayDecision(
    {
      action: 'buy',
      conviction: 70,
      thesis: 'x'.repeat(80),
      levels: { entry: price, stop: price + 5, target1: price - 10 },
      triggers: { buyAbove: price * 0.5, sellBelow: price * 1.5 },
    },
    trade,
    { price, atr: trade.indicators.atr14 },
  );
  assert.ok(broken.plan.stopLoss < broken.plan.entry);
  assert.ok(broken.plan.stopLoss >= broken.plan.entry * 0.975);
  assert.ok(broken.plan.targets[0].price > broken.plan.entry);
  // Crossed triggers are rejected: the exit level stays below spot, and the long
  // trigger stays actionable above spot instead of a stale opening-range high
  // that price has already cleared.
  assert.ok(broken.triggers.buyAbove >= price * 0.995, 'buy trigger above spot');
  assert.ok(broken.triggers.sellBelow < price, 'sell trigger below spot');
  assert.equal(broken.triggers.sellBelow, trade.triggers.sellBelow, 'an in-range mechanical exit level survives');

  // An entry miles from spot is not an intraday entry — it snaps back to spot.
  const stretched = normalizeIntradayDecision(
    { action: 'buy', conviction: 65, levels: { entry: price * 1.2, stop: price * 1.1 } },
    trade,
    { price, atr: trade.indicators.atr14 },
  );
  assert.ok(Math.abs(stretched.plan.entry - price) / price < 0.02);
});

test('trigger levels always sit on the correct side of spot, even after a breakdown', () => {
  // A downtrend that has already lost the opening range: the mechanical
  // "sell below" level is ABOVE spot and must not become the exit trigger.
  const bars = [...makeSession('2026-10-15', 120, -0.05), ...makeSession('2026-10-16', 116.1, -0.06)];
  const trade = buildDayTrade({
    quote: {
      symbol: 'DOWN',
      name: 'Down Corp.',
      quoteType: 'EQUITY',
      exchange: 'NYSE',
      marketState: 'REGULAR',
      price: bars[bars.length - 1].close,
      previousClose: bars[BARS_PER_SESSION - 1].close,
      changePercent: -2.4,
    },
    history: { bars },
  });

  const decision = normalizeIntradayDecision(
    { action: 'sell', conviction: 74, thesis: 'x'.repeat(70), triggers: { buyAbove: 0, sellBelow: 0 } },
    trade,
    { price: trade.price, atr: trade.indicators.atr14 },
  );

  assert.ok(decision.triggers.sellBelow < trade.price, 'sell trigger must sit below spot');
  assert.ok(decision.triggers.buyAbove >= trade.price * 0.995, 'buy trigger must sit at or above spot');
});

test('the LLM desk call parses fenced JSON and rejects unparseable output', async () => {
  const trade = engineTrade('NVDA');
  const dossier = buildIntradayDossier({ trade, context: null });
  assert.equal(dossier.symbol, 'NVDA');
  assert.equal(dossier.intraday.mechanicalAction, trade.action);
  assert.ok(dossier.intraday.vwap > 0);

  const fakeChat = async () => ({
    content: '```json\n{"action":"sell","conviction":72,"thesis":"Fade the failed breakout below VWAP.","levels":{"entry":0,"stop":0},"triggers":{"buyAbove":0,"sellBelow":0}}\n```',
    usage: { total_tokens: 10 },
  });
  const result = await decideIntradayWithLLM({ dossier, fallback: trade, chat: fakeChat });
  assert.equal(result.decision.action, 'sell');
  assert.equal(result.decision.generatedBy, 'llm');
  assert.equal(result.usage.total_tokens, 10);
  assert.ok(result.latencyMs >= 0);

  await assert.rejects(
    () => decideIntradayWithLLM({ dossier, fallback: trade, chat: async () => ({ content: 'no json here' }) }),
    /parseable JSON/,
  );
});

test('the model call becomes the headline read while the engine read is kept', () => {
  const trade = flatTrade();
  const decision = normalizeIntradayDecision(
    { action: 'buy', conviction: 78, thesis: 'Reclaiming VWAP with volume expansion favours the long side.' },
    trade,
    { price: trade.price, atr: trade.indicators.atr14 },
  );
  const merged = mergeIntradayDecision({
    trade,
    decision,
    decisionMeta: { provider: 'openai', model: 'gpt-4o-mini', cached: false },
    decisionError: null,
  });

  assert.equal(merged.source, 'ai');
  assert.equal(merged.action, 'buy');
  assert.equal(merged.confidence, 78);
  assert.ok(merged.plan.entry > 0);
  assert.equal(merged.engine.action, trade.action);
  assert.equal(merged.engine.plan, trade.plan);
  assert.equal(merged.decisionMeta.model, 'gpt-4o-mini');
  assert.ok(merged.reasons[0].includes('VWAP'));
});

test('a provider failure or a missing key leaves the mechanical read in charge', () => {
  const trade = engineTrade();
  const merged = mergeIntradayDecision({
    trade,
    decision: null,
    decisionMeta: { provider: 'rule-engine', model: 'MarketPilot rule engine', cached: false },
    decisionError: 'LLM call failed (500) — showing the mechanical read.',
  });

  assert.equal(merged.source, 'engine');
  assert.equal(merged.action, trade.action);
  assert.equal(merged.actionLabel, trade.actionLabel);
  assert.equal(merged.confidence, trade.confidence);
  assert.equal(merged.ai, null);
  assert.equal(merged.plan, trade.plan);
  assert.match(merged.decisionError, /mechanical read/);
  assert.equal(merged.engine.action, trade.action);
});
