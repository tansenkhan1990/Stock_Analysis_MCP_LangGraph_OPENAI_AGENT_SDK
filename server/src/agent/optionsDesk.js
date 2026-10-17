import { normalizeAction, parseDecisionJson } from './llmDecision.js';
import { evaluateStrategy } from '../analytics/options.js';
import { chatWithLLM } from './providers.js';

/**
 * The options desk call: the LLM decides whether to buy or sell premium for the
 * chosen expiry, given the chain analytics, the technical plan, the news flow
 * and a numbered list of pre-priced candidate structures.
 *
 * Safety rules baked into the contract:
 *  - the model may pick a candidate by index, or send its own legs — but every
 *    leg is snapped onto a real contract from the live chain and re-priced from
 *    the chain, never from the model's own numbers;
 *  - a structure whose loss is unbounded (naked short) is rejected outright;
 *  - the structure's direction must agree with the call, so a "sell" can never
 *    ship a bullish debit spread.
 */

export const OPTIONS_SYSTEM_PROMPT = `You are MarketPilot's options desk. You decide how to express one directional view with options for a single liquid US name, using the chain analytics and the numbered candidate structures in the dossier.

Weigh the evidence in this order:
1. STRUCTURE — where the underlying is in its trend (technical plan, score, targets, stop) and which strikes that makes relevant.
2. VOLATILITY — ATM implied volatility versus the IV state (rich/fair/cheap), the expected move and the actual 5-minute/daily realised range. Rich IV favours selling premium (credits, spreads); cheap IV favours debits.
3. POSITIONING — put/call open interest, max pain and skew. Heavy put OI below spot is support; heavy call OI above is resistance.
4. NEWS, DEALS AND EVENT RISK — an earnings date inside the expiry is a reason for a smaller, defined-risk structure or no trade at all.
5. CANDIDATES — the numbered structures are already priced off the real chain. Choosing one is usually better than inventing levels, because the strikes are liquid.

Rules:
- Use ONLY strikes, premiums and metrics present in the dossier. Never invent a contract.
- Action must be one of "buy"/"accumulate" (bullish expression), "hold" (no directional edge — iron condor/credit structures only), "reduce"/"sell" (bearish expression).
- Prefer defined risk: spreads and condors. Never propose a naked short option or a naked short strangle.
- Give the probability of profit you expect and how to manage the position (profit target, stop on the underlying, or roll rule).
- If IV is cheap, do not sell premium; if IV is rich, do not pay for long premium you can express with a spread.
- Conviction 75+ only when the plan, the volatility state and the news all agree.
- Output MUST be a single minified JSON object and nothing else. No markdown, no commentary.

Exact schema:
{"action":"buy|accumulate|hold|reduce|sell","conviction":0-100,"thesis":"2-4 sentences citing specific numbers","optionBias":"bullish|bearish|neutral","structureChoice":0,"legs":[{"action":"buy","kind":"call","strike":0,"premium":0}],"structureName":"string","probabilityOfProfit":0-100,"management":"one or two sentences","catalysts":[{"type":"news|deal|analyst|event|volatility","direction":"bullish|bearish|neutral","detail":"..."}],"risks":["..."],"invalidations":["..."],"whatWouldChangeMyMind":"string"}`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const legText = (leg) => `${leg.action === 'buy' ? 'Buy' : 'Sell'} ${leg.kind} ${leg.strike} @ ${leg.premium}`;

const compactMetrics = (metrics) => ({
  netPremium: metrics.netPremium,
  isCredit: metrics.isCredit,
  maxProfit: metrics.maxProfit,
  maxProfitUnbounded: Boolean(metrics.maxProfitUnbounded),
  maxLoss: metrics.maxLoss,
  maxLossUnbounded: Boolean(metrics.maxLossUnbounded),
  breakevens: metrics.breakevens,
  probabilityOfProfit: metrics.probabilityOfProfit,
  returnOnRisk: metrics.returnOnRisk,
  greeks: metrics.greeks,
});

/** Everything the options model is allowed to look at. */
export function buildOptionsDossier({
  symbol,
  name,
  spot,
  quote,
  expiration,
  dte,
  summary,
  technical = null,
  news = null,
  fundamentals = null,
  event = null,
  analyst = null,
  candidates = [],
}) {
  return {
    symbol,
    name,
    spot,
    changePercent: quote?.changePercent ?? null,
    expiration,
    dte,
    chain: summary
      ? {
          atmStrike: summary.atmStrike,
          atmIv: summary.atmIv,
          ivState: summary.ivState,
          ivPremium: summary.ivPremium,
          realizedVol: summary.realizedVol ?? null,
          expectedMove: summary.expectedMove,
          expectedMovePct: summary.expectedMovePct,
          expectedLow: summary.expectedLow,
          expectedHigh: summary.expectedHigh,
          straddle: summary.straddle,
          maxPain: summary.maxPain,
          pcrOi: summary.pcrOi,
          pcrVolume: summary.pcrVolume,
          skew: summary.skew,
          liquidity: summary.liquidity,
          positioning: summary.positioning,
          callOpenInterest: summary.callOpenInterest,
          putOpenInterest: summary.putOpenInterest,
        }
      : null,
    technical,
    news,
    fundamentals,
    event,
    analyst,
    candidates: candidates.map((candidate, index) => ({
      index,
      name: candidate.name,
      bias: candidate.bias,
      thesis: candidate.thesis,
      legs: candidate.legs.map((leg) => ({
        action: leg.action,
        kind: leg.kind,
        strike: leg.strike,
        premium: leg.premium,
        iv: leg.iv,
      })),
      isCredit: candidate.metrics.isCredit,
      maxProfit: candidate.metrics.maxProfitUnbounded ? 'unbounded' : candidate.metrics.maxProfit,
      maxLoss: Math.abs(candidate.metrics.maxLoss),
      breakevens: candidate.metrics.breakevens,
      probabilityOfProfit: candidate.metrics.probabilityOfProfit,
      notes: candidate.notes,
    })),
  };
}

const snapToContract = (contracts, kind, strike) => {
  const pool = contracts.filter(
    (contract) => contract.kind === kind && contract.strike > 0 && (contract.mid > 0 || contract.lastPrice > 0),
  );
  if (!pool.length || !Number.isFinite(strike)) return null;
  const exact = pool.find((contract) => Math.abs(contract.strike - strike) < 0.0001);
  if (exact) return { contract: exact, snapped: false };
  const nearest = pool.reduce(
    (best, contract) => (Math.abs(contract.strike - strike) < Math.abs(best.strike - strike) ? contract : best),
    pool[0],
  );
  // Snapping is only allowed within 2% of the strike the model asked for, so a
  // typo cannot silently become a completely different trade.
  if (Math.abs(nearest.strike - strike) / Math.max(strike, 1) > 0.02) return null;
  return { contract: nearest, snapped: true };
};

const structureFromLegs = ({ legs, contracts, spot, iv, dte, expiration, name, bias, thesis }) => {
  const clean = [];
  for (const leg of legs) {
    const kind = String(leg?.kind || '').toLowerCase();
    if (!['call', 'put'].includes(kind)) continue;
    const action = String(leg?.action || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
    const strike = toNumber(leg?.strike);
    const snapped = snapToContract(contracts, kind, strike);
    if (!snapped) continue;
    const { contract } = snapped;
    clean.push({
      kind,
      action,
      strike: contract.strike,
      premium: contract.mid || contract.lastPrice || 0,
      iv: contract.impliedVolatility,
      openInterest: contract.openInterest,
      contractSymbol: contract.contractSymbol,
      qty: 1,
    });
  }
  if (!clean.length) return null;

  const metrics = evaluateStrategy(clean, spot, { iv, dte });
  if (!metrics) return null;
  // Naked short premium is never allowed to reach the UI.
  if (metrics.maxLossUnbounded) return null;

  const delta = metrics.greeks?.delta ?? 0;
  if (bias === 'bullish' && delta <= 0) return null;
  if (bias === 'bearish' && delta >= 0) return null;

  return {
    name: name || 'Custom structure',
    bias,
    thesis: thesis || null,
    expiration,
    dte,
    legs: clean,
    legText: clean.map(legText),
    metrics: compactMetrics(metrics),
    source: 'llm-custom',
  };
};

const biasForAction = (action) =>
  action === 'buy' || action === 'accumulate' ? 'bullish' : action === 'sell' || action === 'reduce' ? 'bearish' : 'neutral';

/** Fill in the presentation fields a candidate needs to reach the UI intact. */
const asCandidate = (candidate) =>
  candidate
    ? {
        ...candidate,
        source: candidate.source ?? 'engine',
        legText: candidate.legText?.length ? candidate.legText : (candidate.legs || []).map(legText),
      }
    : null;

/**
 * Force the model output into the options contract. Legs are re-priced from the
 * live chain, unbounded risk is rejected, and the structure must agree with the
 * action before it can become an order ticket.
 */
export function normalizeOptionsDecision(
  parsed,
  fallback = {},
  { spot, contracts = [], candidates = [], expiration = null, dte = 30 } = {},
) {
  const action = normalizeAction(parsed?.action);
  const desiredBias = biasForAction(action);
  const iv = fallback.iv || 0.3;
  const candidateCount = candidates.length;

  const choice = Number(parsed?.structureChoice);
  const chosenCandidate =
    Number.isInteger(choice) && choice >= 0 && choice < candidateCount ? asCandidate(candidates[choice]) : null;

  const custom = Array.isArray(parsed?.legs) && parsed.legs.length
    ? structureFromLegs({
        legs: parsed.legs,
        contracts,
        spot,
        iv,
        dte,
        expiration,
        name: typeof parsed?.structureName === 'string' ? parsed.structureName.slice(0, 120) : 'AI structure',
        bias: desiredBias,
        thesis: typeof parsed?.thesis === 'string' ? parsed.thesis.trim().slice(0, 1200) : null,
      })
    : null;

  // Direction comes first: keep only a structure that expresses the call.
  const compatible = (candidate) => candidate && candidate.bias === desiredBias;
  let structure = custom || (compatible(chosenCandidate) ? chosenCandidate : null);
  let structureNote = null;

  if (!structure && compatible(fallback.structure)) {
    structure = asCandidate(fallback.structure);
    structureNote = 'The model did not return a usable structure — showing the engine-priced one for this call.';
  }
  if (!structure && chosenCandidate && !compatible(chosenCandidate)) {
    structureNote = `The model picked ${chosenCandidate.name}, which does not express a ${action} call — dropped it rather than ship a mismatched ticket.`;
  }

  const thesis =
    typeof parsed?.thesis === 'string' && parsed.thesis.trim().length > 40
      ? parsed.thesis.trim().slice(0, 1200)
      : fallback.thesis || null;

  const conviction = clamp(
    Math.round(toNumber(parsed?.conviction) ?? fallback.conviction ?? 50),
    20,
    95,
  );

  const parsedPop = toNumber(parsed?.probabilityOfProfit);
  const probabilityOfProfit =
    structure?.metrics?.probabilityOfProfit ?? (parsedPop === null ? null : clamp(Math.round(parsedPop), 0, 100));

  return {
    action,
    actionLabel: action.charAt(0).toUpperCase() + action.slice(1),
    conviction,
    optionBias: ['bullish', 'bearish', 'neutral'].includes(parsed?.optionBias) ? parsed.optionBias : desiredBias,
    thesis,
    structure,
    structureNote,
    probabilityOfProfit,
    management:
      typeof parsed?.management === 'string' && parsed.management.trim()
        ? parsed.management.trim().slice(0, 600)
        : fallback.management || null,
    candidatesConsidered: candidateCount,
    catalysts: (Array.isArray(parsed?.catalysts) ? parsed.catalysts : [])
      .map((item) => ({
        type: ['news', 'deal', 'analyst', 'event', 'volatility'].includes(item?.type) ? item.type : 'volatility',
        direction: ['bullish', 'bearish', 'neutral'].includes(item?.direction) ? item.direction : 'neutral',
        detail: String(item?.detail || '').trim().slice(0, 300),
      }))
      .filter((item) => item.detail)
      .slice(0, 6),
    risks: (Array.isArray(parsed?.risks) ? parsed.risks : [])
      .map((item) => String(item?.detail ?? item ?? '').trim())
      .filter(Boolean)
      .slice(0, 5),
    invalidations: (Array.isArray(parsed?.invalidations) ? parsed.invalidations : [])
      .map((item) => String(item?.detail ?? item ?? '').trim())
      .filter(Boolean)
      .slice(0, 4),
    whatWouldChangeMyMind:
      typeof parsed?.whatWouldChangeMyMind === 'string' && parsed.whatWouldChangeMyMind.trim()
        ? parsed.whatWouldChangeMyMind.trim().slice(0, 600)
        : null,
    engineAction: fallback.action ?? null,
    engineLabel: fallback.actionLabel ?? null,
    agreesWithEngine: fallback.action ? action === fallback.action : null,
    generatedBy: 'llm',
    generatedAt: new Date().toISOString(),
  };
}

/** Ask the LLM for the options call. Throws on provider failure or bad JSON. */
export async function decideOptionsWithLLM({ dossier, fallback, chat = chatWithLLM }) {
  const started = Date.now();
  const result = await chat({
    messages: [
      { role: 'system', content: OPTIONS_SYSTEM_PROMPT },
      { role: 'user', content: `Options dossier:\n${JSON.stringify(dossier)}` },
    ],
    tools: [],
  });
  const parsed = parseDecisionJson(result?.content);
  if (!parsed) throw new Error('The model did not return parseable JSON');
  const decision = normalizeOptionsDecision(parsed, fallback, {
    spot: dossier?.spot,
    contracts: fallback.contracts || [],
    candidates: fallback.candidates || [],
    expiration: dossier?.expiration,
    dte: dossier?.dte ?? 30,
  });
  return { decision, latencyMs: Date.now() - started, usage: result?.usage };
}

export const _internals = { legText, snapToContract, structureFromLegs, biasForAction };
