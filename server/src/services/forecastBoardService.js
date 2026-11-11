import { buildAnalysis } from '../analytics/analysis.js';
import { buildForecastBoardRow, BOARD_WEIGHTS, rankForecastRows } from '../analytics/forecastBoard.js';
import { analyzeNews } from '../analytics/news.js';
import { FORECAST_WINDOW } from '../analytics/forecast.js';
import { HOT_SYMBOLS, hotMeta } from '../data/universe.js';
import { cache } from '../lib/cache.js';
import { listWatchlist, seedWatchlist } from '../lib/store.js';
import { getHistory, getNews, getQuote } from '../lib/yahoo.js';
import { DAY_TRADE_UNIVERSE } from './dayTradeService.js';
import { getForecast } from './forecastService.js';

/**
 * Risers board orchestration: resolve the universe, then for each name read the
 * live quote, six months of daily bars, the five newest headlines, the 1-month
 * forecast and the engine analysis (quality + relative strength). The blend and
 * ranking themselves live in analytics/forecastBoard.js and are unit-tested.
 */
export const BOARD_TTL = 5 * 60_000;
export const BOARD_SCOPES = ['watchlist', 'curated', 'daytrade'];
export const MAX_BOARD_DEPTH = 20;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeBoardDepth(value) {
  const parsed = Number(value);
  const depth = Number.isFinite(parsed) ? parsed : 10;
  return clamp(Math.round(depth), 4, MAX_BOARD_DEPTH);
}

/** Small worker pool so a board scan cannot open dozens of Yahoo requests. */
async function runWithConcurrency(items, worker, concurrency = 3) {
  const queue = [...items];
  const results = [];
  const pool = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        results.push({ status: 'fulfilled', value: await worker(item) });
      } catch (error) {
        results.push({ status: 'rejected', reason: error, item });
      }
    }
  });
  await Promise.all(pool);
  return results;
}

export async function resolveUniverse(scope) {
  if (scope === 'curated') {
    return HOT_SYMBOLS.map((symbol) => {
      const meta = hotMeta(symbol);
      return { symbol, name: meta.name, quoteType: meta.kind === 'etf' ? 'ETF' : 'EQUITY' };
    });
  }
  if (scope === 'daytrade') {
    // The same liquid US stocks and ETFs the intraday board reads, so the
    // next-move list and the 1-hour board describe the same names.
    return DAY_TRADE_UNIVERSE.map((item) => ({
      symbol: item.symbol,
      name: item.name,
      quoteType: item.kind === 'etf' ? 'ETF' : 'EQUITY',
    }));
  }
  // Seed on first use so a fresh process has the focus list, then respect every
  // add/remove the user has made since.
  const list = await seedWatchlist();
  return list.map((item) => ({
    symbol: item.symbol,
    name: item.name,
    quoteType: item.quoteType || 'EQUITY',
  }));
}

export async function getForecastBoard({ scope = 'watchlist', depth = 10, refresh = false } = {}) {
  const resolvedScope = BOARD_SCOPES.includes(scope) ? scope : 'watchlist';
  const limit = normalizeBoardDepth(depth);
  const key = `forecastBoard:${resolvedScope}:${limit}`;
  if (refresh) cache.clear(key);

  return cache.wrap(key, BOARD_TTL, async () => {
    const universe = (await resolveUniverse(resolvedScope)).slice(0, limit);
    // One benchmark fetch for the whole scan; buildAnalysis derives the
    // 3-month relative strength from it.
    const benchmark = await getHistory('SPY', { range: '6mo', interval: '1d' }).catch(() => null);

    const settled = await runWithConcurrency(
      universe,
      async ({ symbol, name, quoteType }) => {
        const [quote, history, headlines, forecast] = await Promise.all([
          getQuote(symbol),
          getHistory(symbol, { range: '6mo', interval: '1d' }),
          getNews(symbol),
          // The board stays on the mechanical 1-month pattern: one LLM call per
          // name would make a 20-name scan slow and rate-limit prone.
          getForecast(symbol, { days: FORECAST_WINDOW, withLlm: false }),
        ]);

        const news = analyzeNews(headlines || []);
        const analysis = buildAnalysis({ quote, history, fundamentals: null, benchmark });
        const row = buildForecastBoardRow({ forecast, news, analysis });
        if (!row) throw new Error('No forecast available');
        return { ...row, name: row.name || name, quoteType: row.quoteType || quoteType };
      },
      3,
    );

    const rows = rankForecastRows(settled.filter((result) => result.status === 'fulfilled').map((result) => result.value));
    const errors = settled
      .filter((result) => result.status === 'rejected')
      .map((result) => `${result.item?.symbol}: ${result.reason?.message || 'could not be read'}`);

    return {
      generatedAt: new Date().toISOString(),
      scope: resolvedScope,
      depth: limit,
      universeSize: universe.length,
      requested: universe.length,
      scanned: rows.length,
      risingCount: rows.filter((row) => row.week.chance >= 55).length,
      dayRisingCount: rows.filter((row) => row.day.chance >= 55).length,
      rows,
      errors,
      weights: BOARD_WEIGHTS,
      method:
        'Chance to rise blends the 1-month pattern (50%, including the in-window analog replay), news sentiment (25%), the engine quality score (15%) and 3-month relative strength vs SPY (10%). Missing evidence is renormalised, never counted as neutral.',
    };
  });
}
