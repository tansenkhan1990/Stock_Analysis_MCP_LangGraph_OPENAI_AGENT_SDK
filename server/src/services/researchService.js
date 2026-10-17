import { describeProvider } from '../agent/providers.js';
import { ruleEngineMeta, symbolAiDecision } from '../agent/symbolDesk.js';
import { ACTION_RANK, buildAlert } from '../analytics/alert.js';
import { builtinDecision, combinedSignal, eventRisk, tradeTriggers } from '../analytics/decision.js';
import { analyzeAnalystActions } from '../analytics/news.js';
import { buildAnalysis } from '../analytics/analysis.js';
import { FOCUS_SYMBOLS, focusMeta } from '../data/universe.js';
import { cache } from '../lib/cache.js';
import { HttpError } from '../lib/errors.js';
import { seedWatchlist } from '../lib/store.js';
import { getNewsDigest } from '../lib/newsFeed.js';
import { getFundamentals, getHistory, getQuotes } from '../lib/yahoo.js';
import { getAnalysis } from './analysisService.js';
import { getNewsHistory } from './newsHistoryService.js';

const BOARD_TTL = 5 * 60_000;
const DECISION_TTL = 30 * 60_000;

const compactPlan = (analysis) => ({
  signal: analysis.signal,
  signalLabel: analysis.signalLabel,
  score: analysis.score.total,
  confidence: analysis.score.confidence,
  direction: analysis.plan.direction,
  entryRef: analysis.plan.entryRef,
  buyZone: analysis.plan.buyZone,
  shortZone: analysis.plan.shortZone,
  targets: analysis.plan.targets.map(({ label, price, upsidePct, source, probability }) => ({
    label,
    price,
    upsidePct,
    source,
    probability,
  })),
  stopLoss: analysis.plan.stopLoss,
  riskReward: analysis.plan.riskReward,
  horizon: analysis.plan.horizon,
  invalidation: analysis.plan.invalidation,
  triggers: tradeTriggers({ analysis }),
});

/** Symbols the user is tracking: the editable watchlist, seeded from the focus universe. */
async function trackedSymbols() {
  const items = await seedWatchlist();
  return items.map((item) => item.symbol);
}

/**
 * The Focus board: technical structure, news flow, business deals, Street
 * activity and event risk for every name in the user's watchlist — fused into
 * one actionable call per symbol. Deliberately skips option-chain fetches so a
 * cold load stays fast; deep research pulls the chain on demand.
 */
export async function getFocusBoard({ symbols } = {}) {
  const requested = symbols ?? (await trackedSymbols());
  const universe = requested.map((symbol) => focusMeta(symbol)).filter(Boolean);
  const key = `focusBoard:${universe.map((item) => item.symbol).join(',')}`;

  return cache.wrap(key, BOARD_TTL, async () => {
    const [quotes, benchmark] = await Promise.all([
      getQuotes(universe.map((item) => item.symbol)),
      // Same benchmark the deep-research call uses, so a card and its desk call
      // never disagree on the score because of a missing relative-strength leg.
      getHistory('SPY', { range: '6mo', interval: '1d' }).catch(() => null),
    ]);
    const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));

    const rows = await Promise.all(
      universe.map(async (meta) => {
        const quote = quoteBySymbol.get(meta.symbol);
        if (!quote?.price) return null;

        const [history, fundamentals, news, history7d] = await Promise.all([
          getHistory(meta.symbol, { range: '2y', interval: '1d' }).catch(() => null),
          // ETFs use the same payload for fund quality, so fetch it for both.
          getFundamentals(meta.symbol).catch(() => null),
          getNewsDigest(meta.symbol, meta.name, { withContent: false }).catch(() => null),
          // Mongo-backed sentiment trend; null until the archive has data.
          getNewsHistory(meta.symbol, { days: 30 }).catch(() => null),
        ]);
        if (!history) return null;

        const analysis = buildAnalysis({ quote, history, fundamentals, benchmark });
        const analyst = analyzeAnalystActions(fundamentals?.analystActionsRaw || []);
        const event = eventRisk(fundamentals);
        const signal = combinedSignal({ analysis, news, analyst, event });
        const alert = buildAlert({ analysis, news, newsHistory: history7d, analyst, event });

        return {
          symbol: meta.symbol,
          name: quote.name || meta.name,
          theme: meta.theme,
          // A ticker added from the UI is not in FOCUS_UNIVERSE, so classify it
          // from the live quote instead of defaulting every newcomer to stock.
          kind: meta.kind === 'etf' || quote.quoteType === 'ETF' ? 'etf' : 'stock',
          price: quote.price,
          changePercent: quote.changePercent,
          change: quote.change,
          quoteType: quote.quoteType,
          technical: compactPlan(analysis),
          news: news
            ? {
                sentiment: news.sentiment,
                label: news.label,
                headlineCount: news.headlineCount,
                counts: news.counts,
                dealCount: news.deals.length,
                deals: news.deals.slice(0, 3),
                catalysts: news.catalysts.slice(0, 3),
                risks: news.risks.slice(0, 2),
              }
            : null,
          analyst: {
            tilt: analyst.tilt,
            upgrades: analyst.upgrades,
            downgrades: analyst.downgrades,
            window: analyst.window,
            latest: analyst.latest.slice(0, 2),
          },
          event,
          decision: {
            ...signal,
            action: alert?.action ?? 'hold',
            actionLabel: alert?.actionLabel ?? 'Hold',
            conviction: alert?.confidence ?? signal.conviction,
            setup: alert?.setup ?? null,
            setupLabel: alert?.setupLabel ?? null,
            alert,
            triggers: tradeTriggers({ analysis }),
          },
          newsHistory: history7d
            ? {
                sentiment7: history7d.sentiment7,
                delta7: history7d.delta7,
                direction: history7d.direction,
                deals30d: history7d.deals30d,
                coverageDays: history7d.coverageDays,
              }
            : null,
        };
      }),
    );

    // Rank by setup first (buy → sell is a risk ladder), then conviction.
    const signals = rows
      .filter(Boolean)
      .sort(
        (a, b) =>
          (ACTION_RANK[a.decision.action] ?? 5) - (ACTION_RANK[b.decision.action] ?? 5) ||
          b.decision.conviction - a.decision.conviction,
      );
    const buys = signals.filter((row) => ['buy', 'accumulate'].includes(row.decision.action));
    const sells = signals.filter((row) => ['sell', 'reduce'].includes(row.decision.action));

    return {
      generatedAt: new Date().toISOString(),
      universe,
      counts: {
        total: signals.length,
        buy: signals.filter((row) => row.decision.action === 'buy').length,
        accumulate: signals.filter((row) => row.decision.action === 'accumulate').length,
        hold: signals.filter((row) => row.decision.action === 'hold').length,
        reduce: signals.filter((row) => row.decision.action === 'reduce').length,
        sell: signals.filter((row) => row.decision.action === 'sell').length,
        deals: signals.reduce((acc, row) => acc + (row.news?.dealCount || 0), 0),
      },
      topPick: buys[0] || signals[0] || null,
      topRisk: sells[0] || signals[signals.length - 1] || null,
      averageNewsSentiment: signals.length
        ? Math.round(signals.reduce((acc, row) => acc + (row.news?.sentiment || 0), 0) / signals.length)
        : 0,
      signals,
    };
  });
}

/** Evidence bundle shared by the rule engine and the LLM. */
async function buildResearchBundle(symbol) {
  const meta = focusMeta(symbol);
  const analysis = await getAnalysis(symbol, { withOptions: true });
  const [news, fundamentals, newsHistory] = await Promise.all([
    getNewsDigest(symbol, meta.name, { withContent: true, articleCount: 3 }).catch(() => null),
    getFundamentals(symbol).catch(() => analysis.fundamentals),
    getNewsHistory(symbol, { days: 30 }).catch(() => null),
  ]);

  const analyst = analyzeAnalystActions(fundamentals?.analystActionsRaw || []);
  const event = eventRisk(fundamentals);
  const combined = combinedSignal({ analysis, news, analyst, event });
  const fallback = builtinDecision({
    symbol,
    meta,
    analysis,
    news,
    newsHistory,
    analyst,
    event,
    options: analysis.options,
    signal: combined,
  });

  return { meta, analysis, news, fundamentals, analyst, event, combined, fallback, newsHistory };
}

/**
 * Deep research for one symbol: the full evidence bundle plus either an LLM
 * desk call or the deterministic rule-engine call.
 */
export async function getResearch(symbol, { ai = false, refresh = false, persistFallback = false } = {}) {
  const key = `research:${symbol}`;
  if (refresh) cache.clear(key);

  const bundle = await cache.wrap(key, 5 * 60_000, () => buildResearchBundle(symbol));
  const { meta, analysis, news, fundamentals, analyst, event, combined, fallback, newsHistory } = bundle;

  let decision = fallback;
  let decisionMeta = ruleEngineMeta();
  let decisionError = null;

  if (ai) {
    // Shared with the Analyzer and the intraday desks, so the same symbol never
    // shows two different model calls with two different confidence numbers.
    const desk = await symbolAiDecision({
      symbol,
      meta,
      analysis,
      news,
      newsHistory,
      analyst,
      event,
      options: analysis.options,
      alert: fallback.alert,
      fallback,
      refresh,
      ttlMs: DECISION_TTL,
    });
    decision = desk.decision ?? fallback;
    decisionMeta = desk.decisionMeta;
    decisionError = desk.decisionError;
  }

  if (persistFallback) {
    decision = fallback;
    decisionMeta = ruleEngineMeta();
  }

  return {
    symbol,
    meta,
    generatedAt: new Date().toISOString(),
    quote: {
      price: analysis.price,
      change: analysis.change,
      changePercent: analysis.changePercent,
      currency: analysis.currency,
      exchange: analysis.exchange,
      marketState: analysis.quote?.marketState ?? null,
    },
    technical: {
      ...compactPlan(analysis),
      indicators: analysis.indicators,
      levels: analysis.levels,
      performance: analysis.performance,
      scoreComponents: analysis.score.components,
      checklist: analysis.checklist,
      rationale: analysis.rationale,
      risks: analysis.risks,
      assetClass: analysis.assetClass,
    },
    fundamentals: fundamentals
      ? {
          sector: fundamentals.sector,
          trailingPE: fundamentals.trailingPE,
          forwardPE: fundamentals.forwardPE,
          pegRatio: fundamentals.pegRatio,
          revenueGrowth: fundamentals.revenueGrowth,
          earningsGrowth: fundamentals.earningsGrowth,
          profitMargin: fundamentals.profitMargin,
          analystTarget: fundamentals.analystTarget,
          recommendationMean: fundamentals.recommendationMean,
          recommendationTrend: fundamentals.recommendationTrend,
          institutionTop: fundamentals.institutionTop,
          expenseRatio: fundamentals.expenseRatio ?? null,
        }
      : null,
    news,
    newsHistory,
    analyst,
    event,
    options: analysis.options,
    combined,
    alert: fallback.alert,
    decision,
    decisionMeta,
    decisionError,
  };
}

/**
 * Desk pass: run the deep-research call across the whole focus board (or a
 * subset) with a small worker pool, so every card can show an LLM decision
 * instead of only the fused rule-engine score. Names that fail keep their
 * deterministic call.
 */
export async function runDeskDecisions({ symbols, refresh = false, concurrency = 3 } = {}) {
  const provider = describeProvider();
  const tracked = symbols ?? (await trackedSymbols());
  const requested = [...new Set(tracked.map((symbol) => String(symbol).toUpperCase()))].slice(0, 20);
  const decisions = {};
  const queue = [...requested];

  const worker = async () => {
    while (queue.length) {
      const symbol = queue.shift();
      try {
        const research = await getResearch(symbol, { ai: provider.live, refresh });
        decisions[symbol] = {
          decision: research.decision,
          decisionMeta: research.decisionMeta,
          decisionError: research.decisionError,
          score: research.combined.score,
        };
      } catch (error) {
        decisions[symbol] = { decision: null, decisionMeta: null, decisionError: error.message };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, requested.length)) }, () => worker()),
  );

  return {
    generatedAt: new Date().toISOString(),
    provider: provider.live ? provider.provider : 'rule-engine',
    model: provider.live ? provider.model : 'MarketPilot rule engine',
    live: provider.live,
    decisions,
  };
}

export async function getFocusSymbols() {
  return FOCUS_SYMBOLS;
}

export async function resolveFocusSymbol(raw) {
  const symbol = String(raw || '').toUpperCase();
  if (!/^[A-Z0-9.^=-]{1,15}$/.test(symbol)) throw new HttpError(400, 'Invalid ticker symbol');
  return symbol;
}
