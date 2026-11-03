import { describeProvider } from '../agent/providers.js';
import {
  buildIntradayDossier,
  decideIntradayWithLLM,
  mergeIntradayDecision,
} from '../agent/intradayDesk.js';
import { eventRisk } from '../analytics/decision.js';
import { rankDayTrades } from '../analytics/dayTradeBoard.js';
import { buildDayTrade } from '../analytics/dayTrading.js';
import {
  REPUTABLE_MIN_AVERAGE_VOLUME,
  REPUTABLE_MIN_PRICE,
  isReputableInstrument,
} from '../analytics/marketScreen.js';
import { config } from '../config.js';
import { HOT_UNIVERSE } from '../data/universe.js';
import { cache } from '../lib/cache.js';
import { HttpError } from '../lib/errors.js';
import { getNewsDigest } from '../lib/newsFeed.js';
import { seedWatchlist } from '../lib/store.js';
import { getHistory, getQuote, getQuotes } from '../lib/yahoo.js';
import { getAnalysis } from './analysisService.js';

export const DAY_TRADE_INTERVAL = '60m';
/** 1-hour bars need a month of history for RSI(14), ADX(14) and five chart sessions. */
const HISTORY_RANGE = '1mo';
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
// over a curated universe of liquid US large caps and ETFs, never the raw
// "most active" screener tape (which is full of sub-$5 micro caps and
// leveraged products nobody should day-trade). Each name costs one hourly
// history call, so the depth is deliberately small: a shortlist, not a scan.
export const DAY_BOARD_SCOPES = ['market', 'focus'];

// ---------- Quality gate ----------
//
// A day-trade needs a tight spread and real volume. These thresholds are what
// separates "reputable" from "moves 40% on 200k shares", and they apply to
// every scope — including explicit symbols — so junk can never reach the board.
/** Stocks and ETFs only — the board never reads an index, a fund of funds or a crypto pair. */
export const DAY_TRADE_UNIVERSE = HOT_UNIVERSE.filter(
  (item) => item.kind === 'stock' || item.kind === 'etf',
);

const clamp01 = (value) => Math.min(1, Math.max(0, value));

// The gate itself lives in marketScreen.js so the day-trade board, the Hot
// Stocks board and the scan API all use one definition of "reputable".
// Re-exported here because this is the service the day-trade tests import.
export { isReputableInstrument };

export const relativeVolumeOf = (quote = {}) => {
  const averageVolume = Number(quote.averageVolume);
  const volume = Number(quote.volume);
  return averageVolume > 0 && volume > 0 ? Number((volume / averageVolume).toFixed(2)) : null;
};

/**
 * Cheap liquidity + activity score used to decide which curated names get the
 * (expensive) hourly read. Size first: a $10B/day name carries a tighter spread
 * than a $30M/day one, whatever its move.
 */
export function boardCandidateScore({ price, averageVolume, volume, changePercent } = {}) {
  const dollarVolume = Math.max((Number(price) || 0) * (Number(averageVolume) || 0), 1);
  // $10M/day ≈ 0, $1B ≈ 0.67, $10B+ = 1 — a thin mover cannot outrank a mega cap.
  const liquidity = clamp01((Math.log10(dollarVolume) - 7) / 3);
  const relative = relativeVolumeOf({ averageVolume, volume });
  const activity = clamp01((Math.min(relative ?? 1, 3) - 0.5) / 2.5);
  const move = clamp01(Math.abs(Number(changePercent) || 0) / 5);
  return Number((liquidity * 55 + activity * 25 + move * 20).toFixed(2));
}
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
 * Which names the board reads. The market scope is the curated universe of
 * liquid US stocks and ETFs, ranked by liquidity and today's activity; focus
 * takes the user's own list; explicit symbols win over both. All three scopes
 * still have to pass the quality gate below.
 */
async function loadDayBoardUniverse({ scope = 'market', symbols = [], depth = DEFAULT_DAY_BOARD_DEPTH } = {}) {
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

  const curatedSymbols = DAY_TRADE_UNIVERSE.map((item) => item.symbol);
  const quotes = await getQuotes(curatedSymbols).catch(() => []);
  const picked = quotes
    .filter((quote) => isReputableInstrument(quote))
    .map((quote) => ({ quote, score: boardCandidateScore(quote) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((row) => row.quote);

  return {
    symbols: picked.map((quote) => quote.symbol),
    scope: 'market',
    universeSize: curatedSymbols.length,
    relativeVolume: new Map(picked.map((quote) => [quote.symbol, relativeVolumeOf(quote)])),
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
  const errors = [];

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
          ? 'Your focus list has no liquid US stocks or ETFs yet — add a ticker, or switch to the curated scan.'
          : 'No name in the curated universe passed the quality filter — try the focus-list scope or a specific ticker.',
    };
  }

  const quotes = await getQuotes(universe.symbols).catch(() => []);
  const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));

  const settled = await Promise.allSettled(
    universe.symbols.map(async (symbol) => {
      const quote = quoteMap.get(symbol);
      if (!quote) throw new HttpError(404, `${symbol}: no live quote`);
      if (!isUsVenue(quote.exchange)) throw new HttpError(422, `${symbol}: not a US-listed venue`);
      if (!isReputableInstrument(quote)) {
        throw new HttpError(
          422,
          `${symbol}: filtered — the board only reads US stocks and ETFs above $${REPUTABLE_MIN_PRICE} with at least ${REPUTABLE_MIN_AVERAGE_VOLUME / 1_000_000}M average shares a day`,
        );
      }
      const history = await getHistory(symbol, { range: HISTORY_RANGE, interval: DAY_TRADE_INTERVAL });
      const trade = buildDayTrade({ quote, history, interval: DAY_TRADE_INTERVAL });
      return { ...trade, relativeVolume: universe.relativeVolume.get(symbol) ?? relativeVolumeOf(quote) };
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
    scanned: trades.length,
    requested: universe.symbols.length,
    universeSize: universe.universeSize ?? universe.symbols.length,
    interval: DAY_TRADE_INTERVAL,
    marketState,
    ...rankDayTrades(trades),
    errors: errors.slice(0, 6),
    note: trades.length
      ? null
      : `No session to read yet${marketState ? ` (market ${marketState.toLowerCase()})` : ''} — the board fills during the 09:30–16:00 New York session, once the first hour has closed.`,
  };
}

/**
 * Ranked intraday board: BUY / SELL / WAIT per name plus the trade plan and a
 * tradeability score. Cached for a minute, like the hourly bars behind it.
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
    // quote: / quoteBatch: are the live tape behind the universe ranking.
    cache.clear('quote:');
    cache.clear('quoteBatch:');
  }

  return cache.wrap(key, BOARD_TTL, () =>
    buildDayBoard({ scope: effectiveScope, symbols, depth: cap, refresh }),
  );
}

/**
 * Everything outside the hourly chart that a day trader should see: the daily
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
 * Intraday read for one symbol. The hourly signal is cached for ~a minute so a
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
