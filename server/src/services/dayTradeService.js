import { describeProvider } from '../agent/providers.js';
import {
  buildIntradayDossier,
  decideIntradayWithLLM,
  mergeIntradayDecision,
} from '../agent/intradayDesk.js';
import { eventRisk } from '../analytics/decision.js';
import { rankDayTrades } from '../analytics/dayTradeBoard.js';
import { buildDayTrade } from '../analytics/dayTrading.js';
import { MARKET_SCREENS, buildMarketTape } from '../analytics/marketScreen.js';
import { config } from '../config.js';
import { HOT_UNIVERSE } from '../data/universe.js';
import { cache } from '../lib/cache.js';
import { HttpError } from '../lib/errors.js';
import { getNewsDigest } from '../lib/newsFeed.js';
import { seedWatchlist } from '../lib/store.js';
import { getHistory, getQuote, getQuotes, getScreener } from '../lib/yahoo.js';
import { getAnalysis } from './analysisService.js';

export const DAY_TRADE_INTERVAL = '5m';
const HISTORY_RANGE = '5d';
const US_VENUE_RE = /nasdaq|nyse|amex|arca|bats|cboe/i;
/** The desk call is deliberately slower-moving than the 60-second bar cache. */
const DECISION_TTL = 10 * 60_000;

/**
 * The intraday model uses the US regular session (09:30–16:00 New York) and the
 * opening-range rule, so it only runs on US-listed venues. Rejecting others is
 * better than silently computing VWAP over a filtered, wrong session.
 */
export const isUsVenue = (exchange) => US_VENUE_RE.test(String(exchange || ''));

// ---------- Best day-trading stocks ----------
//
// The single-symbol page answers "what is the intraday read on this ticker?".
// The board answers "which tickers are worth trading today, and which way?" —
// so it scans the live tape, runs the same 5-minute engine on the most active
// names, and ranks the reads. Each name costs one intraday history call, so the
// depth is deliberately small: this is a shortlist, not a market scan.
export const DAY_BOARD_SCOPES = ['market', 'focus'];
export const DAY_BOARD_DEPTHS = [8, 12, 20];
export const DEFAULT_DAY_BOARD_DEPTH = 12;
export const MAX_DAY_BOARD_DEPTH = 20;
const BOARD_TTL = 60_000;

const normalizeSymbols = (symbols = []) => [
  ...new Set(
    symbols
      .map((symbol) => String(symbol).trim().toUpperCase())
      .filter(Boolean),
  ),
];

/**
 * Which names the board reads. The market scope takes the hottest rows of the
 * Yahoo screener tape (heat already blends relative volume and a steady move);
 * focus takes the user's list; explicit symbols win over both.
 */
async function loadDayBoardUniverse({ scope = 'market', symbols = [], depth = DEFAULT_DAY_BOARD_DEPTH, refresh = false } = {}) {
  const cap = Math.min(Math.max(Number(depth) || DEFAULT_DAY_BOARD_DEPTH, 1), MAX_DAY_BOARD_DEPTH);
  const explicit = normalizeSymbols(symbols);
  if (explicit.length) {
    return { symbols: explicit.slice(0, cap), scope: 'custom', universeSize: explicit.length, relativeVolume: new Map() };
  }

  if (scope === 'focus') {
    const watchlist = await seedWatchlist();
    const list = normalizeSymbols(watchlist.map((item) => item?.symbol)).slice(0, cap);
    return { symbols: list, scope: 'focus', universeSize: list.length, relativeVolume: new Map() };
  }

  if (refresh) cache.clear('screener:');
  const settled = await Promise.allSettled(
    MARKET_SCREENS.map((screen) => getScreener(screen.id, { count: screen.count })),
  );
  const screens = settled.map((result, index) =>
    result.status === 'fulfilled' ? result.value : { id: MARKET_SCREENS[index].id, quotes: [] },
  );
  const screenErrors = settled
    .map((result, index) =>
      result.status === 'rejected' ? `${MARKET_SCREENS[index].id}: ${result.reason?.message}` : null,
    )
    .filter(Boolean);

  const tape = buildMarketTape({
    screens,
    curated: HOT_UNIVERSE.map(({ symbol, name, kind }) => ({ symbol, name, kind })),
    limit: 600,
  });

  // Day trading needs a live quote on a US venue; rank by heat (volume + move),
  // not by the tape's curated-first ordering.
  const picked = tape.rows
    .filter((row) => Number(row.price) > 0 && isUsVenue(row.exchange))
    .sort((a, b) => b.heat - a.heat)
    .slice(0, cap);

  return {
    symbols: picked.map((row) => row.symbol),
    scope: 'market',
    universeSize: tape.universeSize,
    relativeVolume: new Map(picked.map((row) => [row.symbol, row.relativeVolume])),
    screenErrors,
  };
}

/**
 * Build the board for one universe. A name that fails (no quote, a non-US
 * listing, a thin session) is recorded and skipped — one bad ticker must never
 * take the whole board down.
 */
async function buildDayBoard({ scope, symbols, depth, refresh }) {
  const universe = await loadDayBoardUniverse({ scope, symbols, depth, refresh });
  const generatedAt = new Date().toISOString();
  const errors = [...(universe.screenErrors || [])];

  if (!universe.symbols.length) {
    return {
      generatedAt,
      scope: universe.scope,
      depth: 0,
      requested: 0,
      scanned: 0,
      interval: DAY_TRADE_INTERVAL,
      marketState: null,
      rows: [],
      buy: [],
      sell: [],
      wait: [],
      buyCount: 0,
      sellCount: 0,
      waitCount: 0,
      errors,
      note:
        universe.scope === 'focus'
          ? 'Your focus list has no US-listed names yet — add a ticker, or switch to the market scan.'
          : 'The market screen returned no tradable US names — try the focus-list scope or a specific ticker.',
    };
  }

  const quotes = await getQuotes(universe.symbols).catch(() => []);
  const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));

  const settled = await Promise.allSettled(
    universe.symbols.map(async (symbol) => {
      const quote = quoteMap.get(symbol);
      if (!quote) throw new HttpError(404, `${symbol}: no live quote`);
      if (!isUsVenue(quote.exchange)) throw new HttpError(422, `${symbol}: not a US-listed venue`);
      const history = await getHistory(symbol, { range: HISTORY_RANGE, interval: DAY_TRADE_INTERVAL });
      const trade = buildDayTrade({ quote, history, interval: DAY_TRADE_INTERVAL });
      return { ...trade, relativeVolume: universe.relativeVolume.get(symbol) ?? null };
    }),
  );

  const trades = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') trades.push(result.value);
    else errors.push(result.reason?.message || `${universe.symbols[index]}: intraday read failed`);
  });

  const marketState = quotes[0]?.marketState ?? null;

  return {
    generatedAt,
    scope: universe.scope,
    depth: trades.length,
    requested: universe.symbols.length,
    universeSize: universe.universeSize ?? universe.symbols.length,
    interval: DAY_TRADE_INTERVAL,
    marketState,
    ...rankDayTrades(trades),
    errors: errors.slice(0, 6),
    note: trades.length
      ? null
      : `No session to read yet${marketState ? ` (market ${marketState.toLowerCase()})` : ''} — the board fills during the 09:30–16:00 New York session.`,
  };
}

/**
 * Ranked intraday board: BUY / SELL / WAIT per name plus the trade plan and a
 * tradeability score. Cached for a minute, like the 5-minute bars behind it.
 */
export async function getDayTradeBoard({
  symbols = [],
  scope = 'market',
  depth = DEFAULT_DAY_BOARD_DEPTH,
  refresh = false,
} = {}) {
  const cap = Math.min(Math.max(Number(depth) || DEFAULT_DAY_BOARD_DEPTH, 1), MAX_DAY_BOARD_DEPTH);
  const effectiveScope = DAY_BOARD_SCOPES.includes(scope) ? scope : 'market';
  const key = `dayboard:${effectiveScope}:${cap}:${normalizeSymbols(symbols).join(',')}`;

  if (refresh) {
    cache.clear('dayboard:');
    cache.clear('screener:');
  }

  return cache.wrap(key, BOARD_TTL, () =>
    buildDayBoard({ scope: effectiveScope, symbols, depth: cap, refresh }),
  );
}

/**
 * Everything outside the 5-minute chart that a day trader should see: the daily
 * regime, fundamentals, event risk, headline flow and option positioning. Only
 * fetched when a desk call actually has to be computed.
 */
async function buildIntradayContext(symbol, trade) {
  const [analysis, news] = await Promise.all([
    getAnalysis(symbol, { withOptions: true }).catch(() => null),
    getNewsDigest(symbol, trade.name, { withContent: false }).catch(() => null),
  ]);

  const plan = analysis?.plan;
  const summary = analysis?.options?.summary;

  return {
    technical: analysis
      ? {
          score: analysis.score?.total,
          verdict: analysis.signalLabel,
          action: analysis.alert?.action ?? null,
          setupLabel: analysis.alert?.setupLabel ?? null,
          sma50: analysis.indicators?.sma50,
          sma200: analysis.indicators?.sma200,
          rsi14: analysis.indicators?.rsi14,
          adx14: analysis.indicators?.adx14,
          atrPct: analysis.indicators?.atrPct,
          annualizedVolatility: analysis.indicators?.annualizedVolatility,
          stopLoss: plan?.stopLoss,
          targets: (plan?.targets || []).map((target) => ({ label: target.label, price: target.price })),
          nearestSupport: analysis.levels?.nearestSupport ?? null,
          nearestResistance: analysis.levels?.nearestResistance ?? null,
        }
      : null,
    fundamentals: analysis?.fundamentals
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
    event: analysis?.fundamentals ? eventRisk(analysis.fundamentals) : null,
    news: news
      ? {
          sentiment: news.sentiment,
          label: news.label,
          headlineCount: news.headlineCount,
          counts: news.counts,
          catalysts: news.catalysts.slice(0, 4),
          deals: news.deals.slice(0, 3),
          risks: news.risks.slice(0, 2),
          headlines: news.headlines.slice(0, 8).map((item) => ({
            title: item.title,
            direction: item.direction,
            publishedAt: item.publishedAt,
          })),
        }
      : null,
    options: summary
      ? {
          expiration: analysis.options.expiration,
          dte: summary.dte,
          atmIv: summary.atmIv,
          ivState: summary.ivState,
          expectedMovePct: summary.expectedMovePct,
          expectedLow: summary.expectedLow,
          expectedHigh: summary.expectedHigh,
          maxPain: summary.maxPain,
          pcrOi: summary.pcrOi,
          positioning: summary.positioning,
          liquidity: summary.liquidity,
        }
      : null,
  };
}

/**
 * Intraday read for one symbol. The 5-minute signal is cached for ~a minute so a
 * polling page does not hammer Yahoo; `refresh=1` clears both the signal and its
 * bar cache. When a provider is configured the LLM desk call runs on top of the
 * mechanical read and decides the headline BUY / SELL / WAIT.
 */
export async function getDayTrade(symbol, { interval = DAY_TRADE_INTERVAL, refresh = false, ai } = {}) {
  const key = `daytrade:${symbol}:${interval}`;
  if (refresh) {
    cache.clear(key);
    cache.clear(`history:${symbol}:${HISTORY_RANGE}:${interval}`);
    cache.clear(`quote:${symbol}`);
  }

  const trade = await cache.wrap(key, config.cache.intradayTtl, async () => {
    const quote = await getQuote(symbol);
    if (!isUsVenue(quote.exchange)) {
      throw new HttpError(
        422,
        `Day Trading currently supports US-listed tickers (09:30–16:00 New York). ${symbol} trades on ${quote.exchange || 'another venue'}.`,
      );
    }

    const history = await getHistory(symbol, { range: HISTORY_RANGE, interval });
    return buildDayTrade({ quote, history, interval });
  });

  const provider = describeProvider();
  // Default: use the model whenever a key is configured. `ai=0` forces the
  // mechanical read, `ai=1` asks even when auto-detection would say no.
  const explicitOff = ai === false;
  const wantAi = ai === undefined || ai === null ? provider.live : Boolean(ai);
  // An explicit opt-out stays lean — no context fetch, no note.
  if (!wantAi && explicitOff) return mergeIntradayDecision({ trade });

  const contextKey = `intradayContext:${symbol}`;
  if (refresh) cache.clear(contextKey);
  // The daily regime, news, event risk and option positioning a day trader
  // should see, independent of whether the model is answered from cache.
  const context = await cache.wrap(contextKey, 5 * 60_000, () => buildIntradayContext(symbol, trade));

  const decisionKey = `intradayDecision:${symbol}:${interval}:${trade.session?.date ?? 'na'}`;
  if (refresh) cache.clear(decisionKey);

  const cached = cache.get(decisionKey);
  if (cached) {
    return mergeIntradayDecision({
      trade,
      context,
      decision: cached.decision,
      decisionMeta: { ...cached.decisionMeta, cached: true },
      decisionError: null,
    });
  }

  const ruleMeta = { provider: 'rule-engine', model: 'MarketPilot rule engine', cached: false };

  if (!wantAi || !provider.live) {
    return mergeIntradayDecision({
      trade,
      context,
      decision: null,
      decisionMeta: ruleMeta,
      decisionError: `No LLM key configured — showing the mechanical intraday read (${provider.label}).`,
    });
  }

  try {
    const result = await decideIntradayWithLLM({
      dossier: buildIntradayDossier({ trade, context }),
      fallback: trade,
    });
    const decisionMeta = {
      provider: provider.provider,
      model: provider.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
      cached: false,
    };
    cache.set(decisionKey, { decision: result.decision, decisionMeta }, DECISION_TTL);
    return mergeIntradayDecision({ trade, context, decision: result.decision, decisionMeta, decisionError: null });
  } catch (error) {
    return mergeIntradayDecision({
      trade,
      context,
      decision: null,
      decisionMeta: ruleMeta,
      decisionError: `AI desk call failed (${error.message}) — showing the mechanical read.`,
    });
  }
}
