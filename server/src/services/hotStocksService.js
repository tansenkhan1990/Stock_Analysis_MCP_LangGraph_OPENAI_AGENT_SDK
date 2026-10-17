import {
  DEFAULT_DEPTH,
  DEFAULT_MARKET_LIMIT,
  MAX_DEPTH,
  MARKET_SCREENS,
  buildMarketTape,
  selectDeepSymbols,
} from '../analytics/marketScreen.js';
import { rankHotStocks } from '../analytics/hotStocks.js';
import { DEFAULT_SCAN_SYMBOLS, HOT_SYMBOLS, HOT_UNIVERSE, focusMeta } from '../data/universe.js';
import { cache } from '../lib/cache.js';
import { listWatchlist } from '../lib/store.js';
import { getScreener } from '../lib/yahoo.js';
import { scanSymbols } from './analysisService.js';

export const MAX_HOT_UNIVERSE = 48;
export const HOT_SCOPES = ['market', 'broad', 'focus'];
export const HOT_DEPTHS = [40, DEFAULT_DEPTH, 100, MAX_DEPTH];

const normalizeSymbols = (symbols = []) => [
  ...new Set(
    symbols
      .map((symbol) => String(symbol).trim().toUpperCase())
      .filter(Boolean),
  ),
];

/**
 * Pick what the Hot Stocks board scans:
 *  - `broad` (default for the API): the curated liquid universe + user additions
 *  - `focus`: only the user's editable focus list
 *  - `market`: the live Yahoo screener tape (see getHotStocks)
 *  - explicit `symbols`: exactly those names (used by the API/tests)
 * Every path is de-duplicated and capped so one scan stays bounded.
 */
export function resolveHotUniverse({ scope = 'broad', watchlist = [], symbols = [] } = {}) {
  const explicit = normalizeSymbols(symbols);
  if (explicit.length) return { symbols: explicit.slice(0, MAX_HOT_UNIVERSE), scope: 'custom' };

  const list = normalizeSymbols(
    watchlist.map((item) => (typeof item === 'string' ? item : item?.symbol)).filter(Boolean),
  );
  const base = scope === 'focus' ? list : [...HOT_SYMBOLS, ...list];
  const unique = normalizeSymbols(base);
  const effective = unique.length ? unique : DEFAULT_SCAN_SYMBOLS;

  return {
    symbols: effective.slice(0, MAX_HOT_UNIVERSE),
    scope: scope === 'focus' ? 'focus' : 'broad',
  };
}

/** Live market tape from Yahoo's predefined screens, cached with the service. */
async function loadMarketTape({ watchlist = [], limit = DEFAULT_MARKET_LIMIT, refresh = false } = {}) {
  if (refresh) cache.clear('screener:');
  const settled = await Promise.allSettled(MARKET_SCREENS.map((screen) => getScreener(screen.id, { count: screen.count })));
  const screens = settled
    .map((result, index) => (result.status === 'fulfilled' ? result.value : { id: MARKET_SCREENS[index].id, quotes: [] }))
    .filter(Boolean);
  const screenErrors = settled
    .map((result, index) => (result.status === 'rejected' ? `${MARKET_SCREENS[index].id}: ${result.reason?.message}` : null))
    .filter(Boolean);

  const tape = buildMarketTape({
    screens,
    curated: HOT_UNIVERSE.map(({ symbol, name, kind }) => ({ symbol, name, kind })),
    watchlist,
    limit,
  });

  return { ...tape, screenErrors };
}

/**
 * Rank the buy/accumulate names across the whole screened market (or the
 * curated board / the user's focus list) into a "hot stocks" board.
 *
 * `market` scope is the full-market path: Yahoo's screens give the live
 * universe (price, day move, volume) for every name, the heat score decides
 * which `depth` names get the full analysis (buy zone, T1/T2/T3 sell prices,
 * stop), and the response carries the whole tape so nothing is hidden.
 */
export async function getHotStocks({
  symbols = [],
  scope = 'market',
  limit = null,
  depth = DEFAULT_DEPTH,
  refresh = false,
} = {}) {
  const watchlist = await listWatchlist();
  const explicit = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
  const effectiveScope = explicit.length ? 'custom' : HOT_SCOPES.includes(scope) ? scope : 'market';

  if (effectiveScope === 'market') {
    if (refresh) cache.clear('scan:');
    const tape = await loadMarketTape({ watchlist, refresh });
    const deepSymbols = selectDeepSymbols(tape.rows, {
      depth,
      // The curated board and the user's own names always get a full plan.
      always: [...HOT_SYMBOLS, ...watchlist.map((item) => item.symbol)],
    });

    const scan = deepSymbols.length
      ? await scanSymbols(deepSymbols, { maxSymbols: Math.max(deepSymbols.length, MAX_DEPTH) })
      : { generatedAt: new Date().toISOString(), universe: [], count: 0, signals: [], errors: [] };

    const ranked = rankHotStocks(scan.signals);
    const bySymbol = new Map(ranked.stocks.map((stock) => [stock.symbol, stock]));
    const analysed = new Set(scan.universe);

    // The tape carries every screened name; analysed names also carry their
    // action, buy zone and sell ladder.
    const rows = tape.rows.map((row) => {
      const stock = bySymbol.get(row.symbol);
      if (stock) {
        return { ...row, analysed: true, action: stock.action, actionLabel: stock.actionLabel, buyNow: stock.buyNow, hotScore: stock.hotScore, buyZone: stock.buyZone, sellPlan: stock.sellPlan, stopLoss: stock.stopLoss, primaryTarget: stock.primaryTarget, setupLabel: stock.setupLabel, waiting: !stock.buyNow };
      }
      const meta = focusMeta(row.symbol);
      return {
        ...row,
        name: row.name === row.symbol ? meta.name : row.name,
        analysed: analysed.has(row.symbol),
        action: null,
        actionLabel: null,
        buyNow: false,
        hotScore: null,
        buyZone: null,
        sellPlan: [],
        stopLoss: null,
        primaryTarget: null,
        setupLabel: null,
        waiting: false,
      };
    });

    const maxRows = Number(limit) > 0 ? Math.min(Number(limit), MAX_DEPTH) : ranked.stocks.length;
    const stocks = ranked.stocks.slice(0, maxRows);

    return {
      generatedAt: scan.generatedAt,
      scope: 'market',
      depth: deepSymbols.length,
      universe: deepSymbols,
      scanned: scan.universe.length,
      universeSize: tape.universeSize,
      signals: scan.count,
      count: stocks.length,
      buyNowCount: stocks.filter((stock) => stock.buyNow).length,
      waitingCount: stocks.filter((stock) => !stock.buyNow).length,
      marketBuyNowCount: rows.filter((row) => row.buyNow).length,
      screens: tape.sources,
      stocks,
      tape: rows,
      errors: [...(scan.errors || []), ...(tape.screenErrors || [])],
    };
  }

  const resolved = explicit.length
    ? { symbols: normalizeSymbols(explicit).slice(0, MAX_HOT_UNIVERSE), scope: 'custom' }
    : resolveHotUniverse({ scope: effectiveScope, watchlist });
  if (refresh) cache.clear('scan:');

  const scan = await scanSymbols(resolved.symbols);
  const ranked = rankHotStocks(scan.signals);
  const maxRows = Math.min(Math.max(Number(limit) || MAX_HOT_UNIVERSE, 1), MAX_HOT_UNIVERSE);
  const stocks = ranked.stocks.slice(0, maxRows);

  return {
    generatedAt: scan.generatedAt,
    scope: resolved.scope,
    depth: resolved.symbols.length,
    universe: scan.universe,
    universeSize: resolved.symbols.length,
    scanned: scan.universe.length,
    signals: scan.count,
    count: stocks.length,
    buyNowCount: stocks.filter((stock) => stock.buyNow).length,
    waitingCount: stocks.filter((stock) => !stock.buyNow).length,
    marketBuyNowCount: stocks.filter((stock) => stock.buyNow).length,
    screens: [],
    stocks,
    // The curated/focus paths already return every analysed name, so the tape
    // is the ranked list itself.
    tape: ranked.stocks.map((stock) => ({
      symbol: stock.symbol,
      name: stock.name,
      price: stock.price,
      changePercent: stock.changePercent,
      analysed: true,
      action: stock.action,
      actionLabel: stock.actionLabel,
      buyNow: stock.buyNow,
      hotScore: stock.hotScore,
      buyZone: stock.buyZone,
      sellPlan: stock.sellPlan,
      stopLoss: stock.stopLoss,
      primaryTarget: stock.primaryTarget,
      setupLabel: stock.setupLabel,
      waiting: !stock.buyNow,
      curated: HOT_SYMBOLS.includes(stock.symbol),
      watchlist: false,
      sources: ['curated'],
      relativeVolume: null,
      marketCap: null,
      exchange: null,
    })),
    errors: scan.errors,
  };
}
