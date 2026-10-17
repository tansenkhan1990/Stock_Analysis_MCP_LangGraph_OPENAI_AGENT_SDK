import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOptionsDossier,
  decideOptionsWithLLM,
  normalizeOptionsDecision,
} from '../src/agent/optionsDesk.js';

const chainContracts = () =>
  [
    { kind: 'call', strike: 100, mid: 5.0, impliedVolatility: 0.4, openInterest: 900, contractSymbol: 'C100' },
    { kind: 'call', strike: 105, mid: 2.6, impliedVolatility: 0.38, openInterest: 800, contractSymbol: 'C105' },
    { kind: 'call', strike: 110, mid: 1.2, impliedVolatility: 0.36, openInterest: 700, contractSymbol: 'C110' },
    { kind: 'put', strike: 95, mid: 2.8, impliedVolatility: 0.42, openInterest: 850, contractSymbol: 'P95' },
    { kind: 'put', strike: 90, mid: 1.3, impliedVolatility: 0.44, openInterest: 750, contractSymbol: 'P90' },
    { kind: 'put', strike: 85, mid: 0.6, impliedVolatility: 0.46, openInterest: 650, contractSymbol: 'P85' },
  ].map((contract) => ({ ...contract, lastPrice: contract.mid, bid: contract.mid - 0.1, ask: contract.mid + 0.1 }));

const candidate = (name, bias) => ({
  index: 0,
  name,
  bias,
  thesis: `${name} thesis`,
  legs: [],
  legText: [],
  metrics: { netPremium: -200, isCredit: false, maxProfit: 300, maxLoss: -200, breakevens: [102], probabilityOfProfit: 55 },
});

const baseFallback = () => ({
  action: 'buy',
  actionLabel: 'Buy',
  conviction: 62,
  structure: { name: 'Bull call spread', bias: 'bullish', legs: [], metrics: { maxLoss: -200, probabilityOfProfit: 58 } },
  candidates: [candidate('Bull call spread', 'bullish'), candidate('Bear put spread', 'bearish')],
  contracts: chainContracts(),
  iv: 0.4,
});

test('the options desk can pick a priced candidate by index', () => {
  const fallback = baseFallback();
  const decision = normalizeOptionsDecision(
    { action: 'buy', conviction: 71, thesis: 'x'.repeat(60), structureChoice: 0, management: 'Take profit at 50% of max.' },
    fallback,
    { spot: 100, contracts: fallback.contracts, candidates: fallback.candidates, expiration: '2026-11-20', dte: 30 },
  );

  assert.equal(decision.action, 'buy');
  assert.equal(decision.conviction, 71);
  assert.equal(decision.structure.name, 'Bull call spread');
  assert.equal(decision.structure.source, 'engine');
  assert.equal(decision.probabilityOfProfit, 55);
  assert.equal(decision.agreesWithEngine, true);
  assert.equal(decision.generatedBy, 'llm');
});

test('custom legs are re-priced from the live chain, never from the model', () => {
  const fallback = baseFallback();
  const decision = normalizeOptionsDecision(
    {
      action: 'buy',
      conviction: 68,
      thesis: 'x'.repeat(60),
      legs: [
        { action: 'buy', kind: 'call', strike: 100, premium: 0.01 },
        { action: 'sell', kind: 'call', strike: 105, premium: 99 },
      ],
    },
    fallback,
    { spot: 100, contracts: fallback.contracts, candidates: fallback.candidates, expiration: '2026-11-20', dte: 30 },
  );

  assert.equal(decision.structure.source, 'llm-custom');
  assert.deepEqual(
    decision.structure.legs.map((leg) => [leg.action, leg.kind, leg.strike, leg.premium]),
    [
      ['buy', 'call', 100, 5],
      ['sell', 'call', 105, 2.6],
    ],
  );
  assert.equal(decision.structure.metrics.maxLossUnbounded, false);
  assert.equal(decision.structure.legText.length, 2);
});

test('naked short premium and direction mismatches are rejected', () => {
  const fallback = baseFallback();

  const naked = normalizeOptionsDecision(
    {
      action: 'hold',
      conviction: 60,
      thesis: 'x'.repeat(60),
      legs: [{ action: 'sell', kind: 'call', strike: 110 }],
    },
    fallback,
    { spot: 100, contracts: fallback.contracts, candidates: fallback.candidates, expiration: '2026-11-20', dte: 30 },
  );
  assert.notEqual(naked.structure?.source, 'llm-custom', 'a naked short call must never survive');

  // A sell call expressed with a bullish call debit spread is a contradiction.
  const mismatched = normalizeOptionsDecision(
    {
      action: 'sell',
      conviction: 65,
      thesis: 'x'.repeat(60),
      legs: [
        { action: 'buy', kind: 'call', strike: 100 },
        { action: 'sell', kind: 'call', strike: 105 },
      ],
    },
    fallback,
    { spot: 100, contracts: fallback.contracts, candidates: fallback.candidates, expiration: '2026-11-20', dte: 30 },
  );
  assert.notEqual(mismatched.structure?.source, 'llm-custom');

  // A sell call may keep the bearish candidate...
  const bearish = normalizeOptionsDecision(
    { action: 'sell', conviction: 66, thesis: 'x'.repeat(60), structureChoice: 1 },
    fallback,
    { spot: 100, contracts: fallback.contracts, candidates: fallback.candidates, expiration: '2026-11-20', dte: 30 },
  );
  assert.equal(bearish.structure.name, 'Bear put spread');

  // ...but a bullish ticket is dropped, never shipped against a sell call.
  const crossed = normalizeOptionsDecision(
    { action: 'sell', conviction: 66, thesis: 'x'.repeat(60), structureChoice: 0 },
    fallback,
    { spot: 100, contracts: fallback.contracts, candidates: fallback.candidates, expiration: '2026-11-20', dte: 30 },
  );
  assert.equal(crossed.structure, null);
  assert.match(crossed.structureNote, /does not express/);
});

test('strikes far from the real chain are dropped rather than invented', () => {
  const fallback = baseFallback();
  const decision = normalizeOptionsDecision(
    {
      action: 'buy',
      conviction: 64,
      thesis: 'x'.repeat(60),
      legs: [{ action: 'buy', kind: 'call', strike: 500 }],
    },
    fallback,
    { spot: 100, contracts: fallback.contracts, candidates: fallback.candidates, expiration: '2026-11-20', dte: 30 },
  );
  assert.equal(decision.structure.source, 'engine');
  assert.equal(decision.structure.name, 'Bull call spread');
});

test('the options desk call parses the model JSON and rejects garbage', async () => {
  const fallback = baseFallback();
  const dossier = buildOptionsDossier({
    symbol: 'NVDA',
    name: 'NVIDIA Corp.',
    spot: 100,
    quote: { changePercent: 1.2 },
    expiration: '2026-11-20',
    dte: 30,
    summary: { atmIv: 42, ivState: 'rich', expectedMovePct: 5.2, maxPain: 98, pcrOi: 1.1, liquidity: 80 },
    candidates: fallback.candidates,
    technical: { score: 62, verdict: 'Bullish', stopLoss: 96 },
  });
  assert.equal(dossier.candidates[0].index, 0);
  assert.equal(dossier.chain.ivState, 'rich');

  const result = await decideOptionsWithLLM({
    dossier,
    fallback,
    chat: async () => ({ content: '{"action":"accumulate","conviction":73,"thesis":"'+'x'.repeat(60)+'","structureChoice":0}' , usage: { total_tokens: 20 } }),
  });
  assert.equal(result.decision.action, 'accumulate');
  assert.equal(result.decision.structure.name, 'Bull call spread');
  assert.equal(result.usage.total_tokens, 20);

  await assert.rejects(
    () => decideOptionsWithLLM({ dossier, fallback, chat: async () => ({ content: 'not json' }) }),
    /parseable JSON/,
  );
});
