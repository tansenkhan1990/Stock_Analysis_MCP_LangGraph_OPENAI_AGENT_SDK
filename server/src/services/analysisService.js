import { config } from '../config.js';
import { buildAnalysis } from '../analytics/analysis.js';
import { ACTION_RANK } from '../analytics/alert.js';
import { eventRisk, pickPlanForAction } from '../analytics/decision.js';
import { analyzeAnalystActions } from '../analytics/news.js';
import { buildOptionPlans, daysToExpiry, summarizeChain } from '../analytics/options.js';
import { buildOptionsDossier, decideOptionsWithLLM } from '../agent/optionsDesk.js';
import { describeProvider } from '../agent/providers.js';
import { annualizedVolatility } from '../analytics/indicators.js';
import { DEFAULT_SCAN_SYMBOLS } from '../data/universe.js';
import { cache } from '../lib/cache.js';
import { HttpError } from '../lib/errors.js';
import { getNewsDigest } from '../lib/newsFeed.js';
import {
  getExpirations,
  getFundamentals,
  getHistory,
  getNews,
  getOptionChain,
  getQuote,
  getQuotes,
} from '../lib/yahoo.js';

const BENCHMARK = 'SPY';

async function benchmarkHistory() {
  try {
    return await getHistory(BENCHMARK, { range: '6mo', interval: '1d' });
  } catch {
    return null;
  }
}

export function pickExpiration(expirations, { targetDte = 35, minDte = 7, maxDte = 90 } = {}) {
  const withDte = (expirations || [])
    .map((expiration) => ({ expiration, dte: daysToExpiry(expiration) }))
    .filter((item) => item.dte >= minDte && item.dte <= maxDte);
  if (!withDte.length) return (expirations || [])[0] || null;
  withDte.sort((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte));
  return withDte[0].expiration;
}

export async function getOptionsPlan(symbol, analysis, expiration = null) {
  const [quote, expiryInfo] = await Promise.all([getQuote(symbol), getExpirations(symbol)]);
  const chosen = expiration || pickExpiration(expiryInfo.expirations);
  if (!chosen) return null;
  const chain = await getOptionChain(symbol, chosen);
  const spot = quote.price ?? analysis.price;
  chain.spot = spot;
  chain.expiration = chain.expiration || chosen;

  const { summary, plans } = buildOptionPlans({
    symbol,
    spot,
    score: analysis.score.total,
    direction: analysis.plan.direction,
    action: analysis.alert?.action ?? null,
    chain,
    realizedVol: analysis.indicators.annualizedVolatility,
    atrValue: analysis.indicators.atr14,
    targets: analysis.plan.targets,
    stopLoss: analysis.plan.stopLoss,
    support: analysis.levels.nearestSupport,
    resistance: analysis.levels.nearestResistance,
  });

  return {
    symbol,
    spot,
    expiration: chosen,
    expirations: expiryInfo.expirations,
    summary: summary || summarizeChain({ calls: chain.calls, puts: chain.puts, spot, expiration: chosen }),
    plans,
  };
}

export async function getAnalysis(symbol, { withOptions = true, refresh = false } = {}) {
  const key = `analysis:${symbol}:${withOptions ? 'full' : 'core'}`;
  if (refresh) cache.clear(key);

  return cache.wrap(key, config.cache.analysisTtl, async () => {
    const [quote, history, fundamentals, bench] = await Promise.all([
      getQuote(symbol),
      getHistory(symbol, { range: '2y', interval: '1d' }),
      getFundamentals(symbol),
      benchmarkHistory(),
    ]);

    if (!quote.price) throw new HttpError(404, `No live price available for ${symbol}`);
    const analysis = buildAnalysis({ quote, history, fundamentals, benchmark: bench });

    if (withOptions && ['EQUITY', 'ETF'].includes(quote.quoteType)) {
      try {
        analysis.options = await getOptionsPlan(symbol, analysis);
      } catch (error) {
        analysis.options = { error: error.message, plans: [], summary: null };
      }
    } else {
      analysis.options = { plans: [], summary: null, note: 'Options data is not available for this instrument.' };
    }

    try {
      analysis.news = await getNews(symbol);
    } catch {
      analysis.news = [];
    }

    return analysis;
  });
}

const compactSignal = (analysis, sparkline) => ({
  symbol: analysis.symbol,
  name: analysis.name,
  quoteType: analysis.quoteType,
  price: analysis.price,
  changePercent: analysis.changePercent,
  score: analysis.score.total,
  signal: analysis.signal,
  signalLabel: analysis.signalLabel,
  action: analysis.alert?.action ?? 'hold',
  actionLabel: analysis.alert?.actionLabel ?? 'Hold',
  setup: analysis.alert?.setup ?? null,
  setupLabel: analysis.alert?.setupLabel ?? null,
  conviction: analysis.alert?.confidence ?? analysis.score.confidence,
  confidence: analysis.score.confidence,
  buyZone: analysis.plan.buyZone,
  targets: analysis.plan.targets.map((target) => ({
    label: target.label,
    price: target.price,
    upsidePct: target.upsidePct,
    probability: target.probability,
    source: target.source,
  })),
  stopLoss: analysis.plan.stopLoss,
  riskReward: analysis.plan.riskReward,
  rsi: analysis.indicators.rsi14,
  trend: analysis.indicators.sma50 && analysis.price > analysis.indicators.sma50 ? 'up' : 'down',
  sparkline,
});

export const DEFAULT_SCAN_UNIVERSE = DEFAULT_SCAN_SYMBOLS;

/** Upper bound per scan. The broad Hot Stocks board needs more than the old 24. */
export const MAX_SCAN_SYMBOLS = 48;

export async function scanSymbols(symbols = DEFAULT_SCAN_UNIVERSE, { maxSymbols = MAX_SCAN_SYMBOLS } = {}) {
  const cap = Math.min(Math.max(Number(maxSymbols) || MAX_SCAN_SYMBOLS, 1), 200);
  const universe = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].slice(0, cap);
  const key = `scan:${[...universe].sort().join(',')}`;
  return cache.wrap(key, config.cache.scanTtl, async () => {
    const quotes = await getQuotes(universe);
    const bench = await benchmarkHistory();
    const run = async (quote) => {
      const history = await getHistory(quote.symbol, { range: '1y', interval: '1d' });
      const analysis = buildAnalysis({ quote, history, fundamentals: null, benchmark: bench });
      const sparkline = history.bars.slice(-40).map((bar) => bar.close);
      return compactSignal(analysis, sparkline);
    };

    const settled = await Promise.allSettled(quotes.map(run));
    const signals = settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value)
      .sort(
        (a, b) =>
          (ACTION_RANK[a.action] ?? 5) - (ACTION_RANK[b.action] ?? 5) || b.conviction - a.conviction,
      );

    return {
      generatedAt: new Date().toISOString(),
      universe,
      count: signals.length,
      signals,
      errors: settled
        .map((result, index) => (result.status === 'rejected' ? `${quotes[index]?.symbol}: ${result.reason?.message}` : null))
        .filter(Boolean),
    };
  });
}

/** Small worker pool: keeps provider concurrency (and rate limits) under control. */
async function runWithConcurrency(items, worker, concurrency = 3) {
  const queue = [...items];
  const results = [];
  const pool = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        results.push({ status: 'fulfilled', value: await worker(item) });
      } catch (error) {
        results.push({ status: 'rejected', reason: error });
      }
    }
  });
  await Promise.all(pool);
  return results;
}

/** Engine-only idea for one symbol: the priced structure that matches its alert. */
async function buildEngineIdea(symbol) {
  const analysis = await getAnalysis(symbol, { withOptions: true });
  const options = analysis.options;
  // Only surface a structure that agrees with the alert; a "sell" name
  // gets a bearish spread or nothing, never a bull put spread.
  const action = analysis.alert?.action ?? 'hold';
  const plan = pickPlanForAction(options?.plans, action);
  if (!options?.summary || !plan) return null;
  return {
    symbol: analysis.symbol,
    name: analysis.name,
    quoteType: analysis.quoteType,
    price: analysis.price,
    score: analysis.score.total,
    signal: analysis.signal,
    signalLabel: analysis.signalLabel,
    action,
    actionLabel: analysis.alert?.actionLabel ?? 'Hold',
    setupLabel: analysis.alert?.setupLabel ?? null,
    bias: plan.bias || null,
    expiration: options.expiration,
    dte: options.summary.dte,
    atmIv: options.summary.atmIv,
    ivState: options.summary.ivState,
    ivPremium: options.summary.ivPremium,
    expectedMovePct: options.summary.expectedMovePct,
    maxPain: options.summary.maxPain,
    pcrOi: options.summary.pcrOi,
    positioning: options.summary.positioning,
    plan: {
      name: plan.name,
      thesis: plan.thesis,
      legs: plan.legs.map((leg) => ({
        kind: leg.kind,
        action: leg.action,
        strike: leg.strike,
        premium: leg.premium,
        iv: leg.iv,
        qty: leg.qty ?? 1,
        contractSymbol: leg.contractSymbol,
      })),
      netPremium: plan.metrics.netPremium,
      isCredit: plan.metrics.isCredit,
      maxProfit: plan.metrics.maxProfit,
      maxLoss: plan.metrics.maxLoss,
      breakevens: plan.metrics.breakevens,
      probabilityOfProfit: plan.metrics.probabilityOfProfit,
    },
    source: 'engine',
  };
}

/**
 * AI idea for one symbol: the LLM options desk decides the structure, and the
 * card carries its reasoning, management note and model label.
 */
async function buildAiIdea(symbol) {
  const desk = await getOptionsDesk(symbol, { ai: true });
  const decision = desk?.decision;
  const structure = decision?.structure;
  if (!desk?.summary || !structure) return null;
  return {
    symbol: desk.symbol,
    name: desk.name,
    quoteType: desk.quoteType,
    price: desk.price,
    score: desk.context?.technical?.score ?? null,
    signal: null,
    signalLabel: desk.context?.technical?.verdict ?? null,
    action: decision.action,
    actionLabel: decision.actionLabel,
    conviction: decision.conviction,
    setupLabel: desk.engine?.setupLabel ?? null,
    bias: structure.bias,
    expiration: structure.expiration ?? desk.expiration,
    dte: structure.dte ?? desk.dte,
    atmIv: desk.summary.atmIv,
    ivState: desk.summary.ivState,
    ivPremium: desk.summary.ivPremium,
    expectedMovePct: desk.summary.expectedMovePct,
    maxPain: desk.summary.maxPain,
    pcrOi: desk.summary.pcrOi,
    positioning: desk.summary.positioning,
    source: 'ai',
    provider: desk.decisionMeta?.provider ?? null,
    model: desk.decisionMeta?.model ?? null,
    reasoning: decision.thesis,
    management: decision.management,
    risks: decision.risks,
    plan: {
      name: structure.name,
      thesis: structure.thesis || decision.thesis,
      legs: structure.legs.map((leg) => ({
        kind: leg.kind,
        action: leg.action,
        strike: leg.strike,
        premium: leg.premium,
        iv: leg.iv,
        qty: leg.qty ?? 1,
        contractSymbol: leg.contractSymbol,
      })),
      netPremium: structure.metrics.netPremium,
      isCredit: structure.metrics.isCredit,
      maxProfit: structure.metrics.maxProfit,
      maxLoss: structure.metrics.maxLoss,
      breakevens: structure.metrics.breakevens,
      probabilityOfProfit: structure.metrics.probabilityOfProfit,
    },
  };
}

/**
 * Best structure per name. The engine scan is instant; `ai: true` runs the LLM
 * options desk per symbol (cached 10 minutes) and marks the payload as AI.
 */
export async function getOptionsIdeas(symbols = [], { ai = false } = {}) {
  const list = [...new Set(symbols.map((symbol) => String(symbol).toUpperCase()))].slice(0, 8);
  const provider = describeProvider();
  const wantAi = Boolean(ai && provider.live);
  const key = `optionsIdeas:${[...list].sort().join(',')}:${wantAi ? 'ai' : 'engine'}`;

  return cache.wrap(key, wantAi ? OPTIONS_DESK_TTL : 5 * 60_000, async () => {
    // The engine scan is free to fan out; the AI pass goes through a small
    // worker pool so one click cannot open eight simultaneous model calls.
    const settled = wantAi
      ? await runWithConcurrency(list, buildAiIdea, 3)
      : (await Promise.allSettled(list.map((symbol) => buildEngineIdea(symbol)))).filter(
          (result) => result.status === 'fulfilled',
        );

    const ideas = settled
      .map((result) => result.value)
      .filter(Boolean)
      .sort(
        (a, b) =>
          (ACTION_RANK[a.action] ?? 5) - (ACTION_RANK[b.action] ?? 5) || (b.score ?? 0) - (a.score ?? 0),
      );

    return {
      generatedAt: new Date().toISOString(),
      source: wantAi ? 'ai' : 'engine',
      provider: wantAi ? provider.provider : null,
      model: wantAi ? provider.model : null,
      count: ideas.length,
      ideas,
    };
  });
}

export async function getChainWithAnalytics(symbol, expiration = null) {
  const [quote, expiryInfo] = await Promise.all([getQuote(symbol), getExpirations(symbol)]);
  const chosen = expiration || pickExpiration(expiryInfo.expirations);
  const [chain, history] = await Promise.all([
    getOptionChain(symbol, chosen),
    getHistory(symbol, { range: '3mo', interval: '1d' }).catch(() => null),
  ]);
  const spot = quote.price;
  const realizedVol = history ? annualizedVolatility(history.bars.map((bar) => bar.close), 20) : null;
  const summary = summarizeChain({
    calls: chain.calls,
    puts: chain.puts,
    spot,
    expiration: chosen,
    realizedVol,
  });
  return {
    ...chain,
    spot,
    quote,
    expirations: expiryInfo.expirations,
    summary,
  };
}

const OPTIONS_DESK_TTL = 10 * 60_000;
const RULE_META = { provider: 'rule-engine', model: 'MarketPilot rule engine', cached: false };

const biasForAction = (action) =>
  action === 'buy' || action === 'accumulate' ? 'bullish' : action === 'sell' || action === 'reduce' ? 'bearish' : 'neutral';

const legText = (leg) => `${leg.action === 'buy' ? 'Buy' : 'Sell'} ${leg.kind} ${leg.strike} @ ${leg.premium}`;

/** One priced structure, shaped for both the API and the LLM dossier. */
const compactCandidate = (plan, index) => ({
  index,
  name: plan.name,
  bias: plan.bias,
  thesis: plan.thesis,
  notes: plan.notes,
  riskNote: plan.riskNote ?? null,
  expiration: plan.expiration,
  dte: plan.dte,
  source: 'engine',
  legs: plan.legs.map((leg) => ({
    kind: leg.kind,
    action: leg.action,
    strike: leg.strike,
    premium: leg.premium,
    iv: leg.iv,
    qty: leg.qty ?? 1,
    contractSymbol: leg.contractSymbol,
  })),
  legText: plan.legs.map(legText),
  metrics: {
    netPremium: plan.metrics.netPremium,
    isCredit: plan.metrics.isCredit,
    maxProfit: plan.metrics.maxProfit,
    maxProfitUnbounded: Boolean(plan.metrics.maxProfitUnbounded),
    maxLoss: plan.metrics.maxLoss,
    maxLossUnbounded: Boolean(plan.metrics.maxLossUnbounded),
    breakevens: plan.metrics.breakevens,
    probabilityOfProfit: plan.metrics.probabilityOfProfit,
    returnOnRisk: plan.metrics.returnOnRisk,
    greeks: plan.metrics.greeks,
  },
});

/**
 * The options desk: chain analytics + the technical/news/event context + a
 * numbered list of engine-priced structures, handed to the LLM so it decides
 * what to buy or sell. Falls back to the engine's structure whenever no key is
 * configured, the provider errors, or the model returns something unusable.
 */
export async function getOptionsDesk(symbol, { ai, refresh = false, expiration = null } = {}) {
  const analysis = await getAnalysis(symbol, { withOptions: true, refresh });
  const options = analysis.options || {};
  const candidates = (options.plans || []).map(compactCandidate);
  const summary = options.summary || null;
  const spot = analysis.price;
  const chosenExpiration = options.expiration || expiration || null;
  const dte = summary?.dte ?? 30;

  const alertAction = analysis.alert?.action ?? 'hold';
  const engineStructure =
    candidates.find((candidate) => candidate.bias === biasForAction(alertAction)) || candidates[0] || null;

  const [chain, news] = await Promise.all([
    chosenExpiration ? getOptionChain(symbol, chosenExpiration).catch(() => null) : Promise.resolve(null),
    getNewsDigest(symbol, analysis.name, { withContent: false }).catch(() => null),
  ]);

  const contracts = chain
    ? [
        ...(chain.calls || []).map((contract) => ({ ...contract, kind: 'call' })),
        ...(chain.puts || []).map((contract) => ({ ...contract, kind: 'put' })),
      ]
    : [];

  const analyst = analyzeAnalystActions(analysis.fundamentals?.analystActionsRaw || []);
  const event = eventRisk(analysis.fundamentals);

  const context = {
    technical: {
      score: analysis.score?.total,
      verdict: analysis.signalLabel,
      confidence: analysis.score?.confidence,
      action: alertAction,
      actionLabel: analysis.alert?.actionLabel ?? 'Hold',
      setupLabel: analysis.alert?.setupLabel ?? null,
      direction: analysis.plan?.direction ?? null,
      entry: analysis.plan?.entryRef ?? null,
      targets: (analysis.plan?.targets || []).map((target) => ({ label: target.label, price: target.price, upsidePct: target.upsidePct })),
      stopLoss: analysis.plan?.stopLoss ?? null,
      riskReward: analysis.plan?.riskReward ?? null,
      rsi14: analysis.indicators?.rsi14,
      adx14: analysis.indicators?.adx14,
      atrPct: analysis.indicators?.atrPct,
      sma50: analysis.indicators?.sma50,
      sma200: analysis.indicators?.sma200,
      annualizedVolatility: analysis.indicators?.annualizedVolatility,
      nearestSupport: analysis.levels?.nearestSupport ?? null,
      nearestResistance: analysis.levels?.nearestResistance ?? null,
    },
    news: news
      ? {
          sentiment: news.sentiment,
          label: news.label,
          headlineCount: news.headlineCount,
          catalysts: news.catalysts.slice(0, 4),
          deals: news.deals.slice(0, 3),
          headlines: news.headlines.slice(0, 6).map((item) => ({ title: item.title, direction: item.direction })),
        }
      : null,
    fundamentals: analysis.fundamentals
      ? {
          sector: analysis.fundamentals.sector,
          trailingPE: analysis.fundamentals.trailingPE,
          forwardPE: analysis.fundamentals.forwardPE,
          analystTarget: analysis.fundamentals.analystTarget,
          recommendationMean: analysis.fundamentals.recommendationMean,
          revenueGrowth: analysis.fundamentals.revenueGrowth,
          earningsGrowth: analysis.fundamentals.earningsGrowth,
          profitMargin: analysis.fundamentals.profitMargin,
        }
      : null,
    event,
    analyst: analyst?.total
      ? { tilt: analyst.tilt, upgrades: analyst.upgrades, downgrades: analyst.downgrades, window: analyst.window }
      : null,
  };

  const base = {
    symbol,
    name: analysis.name,
    quoteType: analysis.quoteType,
    exchange: analysis.exchange,
    price: analysis.price,
    currency: analysis.currency,
    spot,
    expiration: chosenExpiration,
    expirations: options.expirations ?? null,
    dte,
    summary,
    candidates,
    context,
    engine: {
      action: alertAction,
      actionLabel: analysis.alert?.actionLabel ?? 'Hold',
      conviction: analysis.alert?.confidence ?? analysis.score?.confidence ?? 50,
      setupLabel: analysis.alert?.setupLabel ?? null,
      structure: engineStructure,
    },
  };

  const fallbackDecision = {
    action: alertAction,
    actionLabel: analysis.alert?.actionLabel ?? 'Hold',
    conviction: analysis.alert?.confidence ?? analysis.score?.confidence ?? 50,
    optionBias: biasForAction(alertAction),
    thesis:
      engineStructure?.thesis ??
      `No defined-risk structure is priced for ${symbol} on this expiry yet, so there is nothing to buy or sell here.`,
    structure: engineStructure,
    structureNote: null,
    probabilityOfProfit: engineStructure?.metrics?.probabilityOfProfit ?? null,
    management: null,
    catalysts: [],
    risks: [],
    invalidations: [],
    whatWouldChangeMyMind: null,
    engineAction: alertAction,
    engineLabel: analysis.alert?.actionLabel ?? 'Hold',
    agreesWithEngine: true,
    generatedBy: 'rule-engine',
    generatedAt: new Date().toISOString(),
  };

  if (!candidates.length || !summary) {
    return {
      ...base,
      source: 'engine',
      decision: fallbackDecision,
      decisionMeta: RULE_META,
      decisionError: 'No priced option structures are available for this symbol and expiry.',
    };
  }

  const provider = describeProvider();
  const explicitOff = ai === false;
  const wantAi = ai === undefined || ai === null ? provider.live : Boolean(ai);
  if (!wantAi) {
    return {
      ...base,
      source: 'engine',
      decision: fallbackDecision,
      decisionMeta: RULE_META,
      decisionError:
        explicitOff || provider.live
          ? null
          : `No LLM key configured — showing the engine-priced structure (${provider.label}).`,
    };
  }

  const decisionKey = `optionsDecision:${symbol}:${chosenExpiration}`;
  if (refresh) cache.clear(decisionKey);
  const cached = cache.get(decisionKey);
  if (cached) {
    return {
      ...base,
      source: 'ai',
      decision: cached.decision,
      decisionMeta: { ...cached.decisionMeta, cached: true },
      decisionError: null,
    };
  }

  if (!provider.live) {
    return {
      ...base,
      source: 'engine',
      decision: fallbackDecision,
      decisionMeta: RULE_META,
      decisionError: `No LLM key configured — showing the engine-priced structure (${provider.label}).`,
    };
  }

  try {
    const dossier = buildOptionsDossier({
      symbol,
      name: analysis.name,
      spot,
      quote: { changePercent: analysis.changePercent },
      expiration: chosenExpiration,
      dte,
      summary,
      technical: context.technical,
      news: context.news,
      fundamentals: context.fundamentals,
      event: context.event,
      analyst: context.analyst,
      candidates: options.plans || [],
    });
    const result = await decideOptionsWithLLM({
      dossier,
      fallback: {
        ...fallbackDecision,
        candidates,
        contracts,
        iv: summary.atmIv ? summary.atmIv / 100 : 0.3,
      },
    });
    const decisionMeta = {
      provider: provider.provider,
      model: provider.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
      cached: false,
    };
    cache.set(decisionKey, { decision: result.decision, decisionMeta }, OPTIONS_DESK_TTL);
    return { ...base, source: 'ai', decision: result.decision, decisionMeta, decisionError: null };
  } catch (error) {
    return {
      ...base,
      source: 'engine',
      decision: fallbackDecision,
      decisionMeta: RULE_META,
      decisionError: `AI options desk failed (${error.message}) — showing the engine-priced structure.`,
    };
  }
}
