import { config } from '../config.js';
import { buildAnalysis } from '../analytics/analysis.js';
import { ACTION_RANK } from '../analytics/alert.js';
import { pickPlanForAction } from '../analytics/decision.js';
import { buildOptionPlans, daysToExpiry, summarizeChain } from '../analytics/options.js';
import { annualizedVolatility } from '../analytics/indicators.js';
import { DEFAULT_SCAN_SYMBOLS } from '../data/universe.js';
import { cache } from '../lib/cache.js';
import { HttpError } from '../lib/errors.js';
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
  targets: analysis.plan.targets.map((target) => ({ label: target.label, price: target.price, upsidePct: target.upsidePct })),
  stopLoss: analysis.plan.stopLoss,
  riskReward: analysis.plan.riskReward,
  rsi: analysis.indicators.rsi14,
  trend: analysis.indicators.sma50 && analysis.price > analysis.indicators.sma50 ? 'up' : 'down',
  sparkline,
});

export const DEFAULT_SCAN_UNIVERSE = DEFAULT_SCAN_SYMBOLS;

export async function scanSymbols(symbols = DEFAULT_SCAN_UNIVERSE) {
  const universe = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].slice(0, 24);
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

export async function getOptionsIdeas(symbols = []) {
  const list = [...new Set(symbols.map((symbol) => String(symbol).toUpperCase()))].slice(0, 8);
  const key = `optionsIdeas:${[...list].sort().join(',')}`;
  return cache.wrap(key, 5 * 60_000, async () => {
    const settled = await Promise.allSettled(
      list.map(async (symbol) => {
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
        };
      }),
    );

    const ideas = settled
      .filter((result) => result.status === 'fulfilled' && result.value)
      .map((result) => result.value)
      .sort(
        (a, b) =>
          (ACTION_RANK[a.action] ?? 5) - (ACTION_RANK[b.action] ?? 5) || b.score - a.score,
      );

    return { generatedAt: new Date().toISOString(), count: ideas.length, ideas };
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
