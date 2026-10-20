import { config } from '../config.js';
import { describeProvider } from '../agent/providers.js';
import { peekDecision, ruleEngineMeta, symbolAiDecision, withDeskDecision } from '../agent/symbolDesk.js';
import { ACTION_RANK, buildAlert } from '../analytics/alert.js';
import { builtinDecision, combinedSignal, eventRisk, tradeTriggers } from '../analytics/decision.js';
import { applyHistoryToDecision, archiveTrend } from '../analytics/history.js';
import { analyzeAnalystActions } from '../analytics/news.js';
import { buildAnalysis } from '../analytics/analysis.js';
import { growthBand, growthProbability } from '../analytics/growth.js';
import { FOCUS_SYMBOLS, focusMeta } from '../data/universe.js';
import { cache } from '../lib/cache.js';
import { HttpError } from '../lib/errors.js';
import { seedWatchlist } from '../lib/store.js';
import { getNewsDigest } from '../lib/newsFeed.js';
import { getFundamentals, getHistory, getQuotes } from '../lib/yahoo.js';
import { getAnalysis } from './analysisService.js';
import { getHistoryForSymbols, getMarketHistory } from './marketHistoryService.js';
import { getNewsHistory } from './newsHistoryService.js';

const BOARD_TTL = Math.min(5 * 60_000, config.cache.quoteTtl);
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
  // The same SMA50-based trend the compact scan signal uses, so a board row
  // and its Hot Stocks twin score an identical chance to rise.
  trend:
    analysis.indicators?.sma50 === null || analysis.indicators?.sma50 === undefined
      ? null
      : analysis.price > analysis.indicators.sma50
        ? 'up'
        : 'down',
  // Same ratio at the live price, so a surface can tell the reference-entry
  // figure apart from what a fill at spot actually earns.
  riskRewardAtSpot: analysis.plan.riskRewardAtSpot,
  horizon: analysis.plan.horizon,
  invalidation: analysis.plan.invalidation,
  triggers: tradeTriggers({ analysis }),
});

/**
 * Attach the blended "chance to rise" to a board row. Measured after the desk
 * layer so a model conviction is what feeds the number, not the engine's.
 */
const withGrowth = (row) => {
  const targets = row.technical?.targets || [];
  const direction = row.technical?.direction ?? null;
  const probability = growthProbability({
    targetProbability: targets[1]?.probability ?? targets[0]?.probability ?? null,
    conviction: row.decision?.conviction,
    quality: row.technical?.score,
    // Prefer the live SMA50 trend (identical to the Hot Stocks row); fall back
    // to the plan's side when indicators are missing. A short row is flipped to
    // a low chance to rise rather than rewarded for a working bearish plan.
    trend: row.technical?.trend ?? (direction === 'long' ? 'up' : direction === 'short' ? 'down' : null),
    direction,
    hitRate: row.archive?.hitRate ?? null,
  });
  return { ...row, growthProbability: probability, growthBand: growthBand(probability) };
};

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
 *
 * Only the evidence is cached: the decision layer is applied per request from
 * the desk cache, so a model call made a second ago is what the board shows
 * instead of waiting out the analytics cache.
 */
export async function getFocusBoard({ symbols } = {}) {
  const requested = symbols ?? (await trackedSymbols());
  const universe = requested.map((symbol) => focusMeta(symbol)).filter(Boolean);
  const key = `focusBoard:${universe.map((item) => item.symbol).join(',')}`;

  const rows = await cache.wrap(key, BOARD_TTL, async () => {
    const [quotes, benchmark, archive] = await Promise.all([
      getQuotes(universe.map((item) => item.symbol)),
      // Same benchmark the deep-research call uses, so a card and its desk call
      // never disagree on the score because of a missing relative-strength leg.
      getHistory('SPY', { range: '6mo', interval: '1d' }).catch(() => null),
      // One archive read for the whole board: score trend, call streak and how
      // the previous calls resolved, from the daily MongoDB snapshots.
      getHistoryForSymbols(universe.map((item) => item.symbol), { days: 30 }).catch(() => ({})),
    ]);
    const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));

    const rows = await Promise.all(
      universe.map(async (meta) => {
        const quote = quoteBySymbol.get(meta.symbol);
        if (!quote?.price) return null;

        const [history, fundamentals, news, history7d] = await Promise.all([
          getHistory(meta.symbol, { range: '1y', interval: '1d' }).catch(() => null),
          // ETFs use the same payload for fund quality, so fetch it for both.
          getFundamentals(meta.symbol).catch(() => null),
          getNewsDigest(meta.symbol, meta.name, { withContent: false }).catch(() => null),
          // Mongo-backed sentiment trend; null until the archive has data.
          getNewsHistory(meta.symbol, { days: 30 }).catch(() => null),
        ]);
        if (!history) return null;

        // Keep technical scores and price levels on the same inputs as the Hot
        // Stocks scan; fundamentals still inform the separate analyst/event read.
        const analysis = buildAnalysis({ quote, history, fundamentals: null, benchmark });
        const analyst = analyzeAnalystActions(fundamentals?.analystActionsRaw || []);
        const event = eventRisk(fundamentals);
        const signal = combinedSignal({ analysis, news, analyst, event });
        const alert = buildAlert({ analysis, news, newsHistory: history7d, analyst, event });

        // The archive only adjusts how much the live call can be trusted —
        // levels and the action stay live-data decisions.
        const marketHistory = archive?.[meta.symbol] ?? null;
        const historyRead = applyHistoryToDecision({
          action: alert?.action ?? 'hold',
          conviction: alert?.confidence ?? signal.conviction,
          history: marketHistory,
        });
        const engineDecision = {
          ...signal,
          action: alert?.action ?? 'hold',
          actionLabel: alert?.actionLabel ?? 'Hold',
          conviction: historyRead.conviction,
          engineConviction: alert?.confidence ?? signal.conviction,
          convictionDelta: historyRead.delta,
          historyNotes: historyRead.notes,
          setup: alert?.setup ?? null,
          setupLabel: alert?.setupLabel ?? null,
          alert,
          triggers: tradeTriggers({ analysis }),
        };
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
          // The mechanical call is the row's default decision; the desk layer
          // below replaces it the moment a model call exists, so the board
          // always carries an actionable verdict.
          decision: engineDecision,
          decisionSource: 'rule-engine',
          decisionMeta: ruleEngineMeta(),
          // Kept separately so every surface can show the engine's call as a
          // cross-check instead of silently swapping it out.
          engineDecision: {
            action: engineDecision.action,
            actionLabel: engineDecision.actionLabel,
            setup: engineDecision.setup,
            setupLabel: engineDecision.setupLabel,
            conviction: engineDecision.conviction,
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
          // Compact archive trend for the card: how long the call has stood,
          // where the score is going, and whether previous calls worked.
          archive: marketHistory ? archiveTrend(marketHistory, { action: alert?.action ?? 'hold' }) : null,
        };
      }),
    );

    return rows.filter(Boolean);
  });

  // The model owns the call: layer every desk decision that exists onto its row
  // and rank by the resulting verdict (buy → sell is a risk ladder).
  const signals = rows
    .map((row) => {
      const desk = peekDecision(row.symbol);
      if (!desk) return withGrowth(row);
      return withGrowth({
        ...row,
        decision: withDeskDecision(row.decision, desk),
        decisionSource: 'llm',
        decisionMeta: desk.decisionMeta,
      });
    })
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
    // Who decided each row: the model, or the rule engine standing in for it.
    decisions: {
      llm: signals.filter((row) => row.decisionSource === 'llm').length,
      ruleEngine: signals.filter((row) => row.decisionSource === 'rule-engine').length,
    },
    averageNewsSentiment: signals.length
      ? Math.round(signals.reduce((acc, row) => acc + (row.news?.sentiment || 0), 0) / signals.length)
      : 0,
    signals,
  };
}

/** Evidence bundle shared by the rule engine and the LLM. */
async function buildResearchBundle(symbol) {
  const meta = focusMeta(symbol);
  const analysis = await getAnalysis(symbol, { withOptions: true });
  const [news, fundamentals, newsHistory, marketHistory] = await Promise.all([
    getNewsDigest(symbol, meta.name, { withContent: true, articleCount: 3 }).catch(() => null),
    getFundamentals(symbol).catch(() => analysis.fundamentals),
    getNewsHistory(symbol, { days: 30 }).catch(() => null),
    // Daily snapshot history from MongoDB; null until the archive has rows.
    getMarketHistory(symbol, { days: 60 }).catch(() => null),
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
    marketHistory,
    analyst,
    event,
    options: analysis.options,
    signal: combined,
  });

  return { meta, analysis, news, fundamentals, analyst, event, combined, fallback, newsHistory, marketHistory };
}

/**
 * Deep research for one symbol: the full evidence bundle plus either an LLM
 * desk call or the deterministic rule-engine call.
 */
export async function getResearch(symbol, { ai = false, refresh = false, persistFallback = false } = {}) {
  const key = `research:${symbol}`;
  if (refresh) cache.clear(key);

  const bundle = await cache.wrap(key, 5 * 60_000, () => buildResearchBundle(symbol));
  const { meta, analysis, news, fundamentals, analyst, event, combined, fallback, newsHistory, marketHistory } = bundle;

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
      marketHistory,
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
    marketHistory,
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
