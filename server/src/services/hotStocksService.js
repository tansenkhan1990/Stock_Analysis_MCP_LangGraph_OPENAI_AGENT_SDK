import {
  DEFAULT_DEPTH,
  DEFAULT_MARKET_LIMIT,
  MAX_DEPTH,
  MARKET_SCREENS,
  buildMarketTape,
  selectDeepSymbols,
} from '../analytics/marketScreen.js';
import { rankHotStocks } from '../analytics/hotStocks.js';
import {
  OUTLOOK_BATCH_SIZE,
  OUTLOOK_TTL_MS,
  buildOutlookRows,
  chunkRows,
  decideOutlookBatch,
  engineOutlook,
  mergeOutlook,
} from '../agent/hotOutlook.js';
import { describeProvider } from '../agent/providers.js';
import { DEFAULT_SCAN_SYMBOLS, HOT_SYMBOLS, HOT_UNIVERSE, focusMeta } from '../data/universe.js';
import { cache } from '../lib/cache.js';
import { seedWatchlist } from '../lib/store.js';
import { getScreener } from '../lib/yahoo.js';
import { scanSymbols } from './analysisService.js';
import { getFocusBoard } from './researchService.js';

export const MAX_HOT_UNIVERSE = 48;
export const HOT_SCOPES = ['market', 'broad', 'focus'];
export const HOT_DEPTHS = [40, 60, DEFAULT_DEPTH, MAX_DEPTH];

const normalizeSymbols = (symbols = []) => [
  ...new Set(
    symbols
      .map((symbol) => String(symbol).trim().toUpperCase())
      .filter(Boolean),
  ),
];

/**
 * The Focus board is the single source of truth for a tracked name's call: it
 * fuses news, Street actions, earnings risk and the daily archive, none of
 * which a market-wide scan can afford for every screened name. A tracked name
 * therefore takes the Focus row's action, conviction, setup and chance to rise
 * verbatim, so a symbol added from Hot Stocks shows the same verdict when the
 * Focus list is opened instead of two different ones.
 */
export function applyFocusDecision(signal = {}, row = null) {
  const decision = row?.decision;
  if (!decision) return signal;
  const rawGrowth = row.growthProbability;
  const growth = rawGrowth === null || rawGrowth === undefined || rawGrowth === '' ? NaN : Number(rawGrowth);
  return {
    ...signal,
    action: decision.action ?? signal.action,
    actionLabel: decision.actionLabel ?? signal.actionLabel,
    conviction: decision.conviction ?? signal.conviction,
    setup: decision.setup ?? signal.setup ?? null,
    setupLabel: decision.setupLabel ?? signal.setupLabel ?? null,
    growthProbability: Number.isFinite(growth) ? growth : signal.growthProbability,
    growthBand: row.growthBand ?? signal.growthBand ?? null,
  };
}

/**
 * Focus rows for the tracked names in a scan, keyed by symbol. Enriching a name
 * costs a news feed, fundamentals and archive reads, so the merge is bounded.
 */
const MAX_FOCUS_DECISIONS = 48;

async function focusDecisions(symbols = []) {
  const list = normalizeSymbols(symbols).slice(0, MAX_FOCUS_DECISIONS);
  if (!list.length) return new Map();
  const board = await getFocusBoard({ symbols: list }).catch(() => null);
  return new Map((board?.signals || []).map((row) => [row.symbol, row]));
}

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
  // Internal: the AI outlook needs the full compact signals of every analysed
  // name, which the public board response deliberately does not carry.
  includeSignals = false,
} = {}) {
  // Seed first: the Focus board is built from the seeded focus universe, so the
  // Hot board must track the same names or a fresh page load compares against
  // an empty watchlist and the two boards disagree.
  const watchlist = await seedWatchlist();
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

    // Tracked names take the Focus board's enriched call (news, Street, event
    // risk, archive) instead of the scan's technical-only one.
    const tracked = new Set(watchlist.map((item) => item.symbol));
    const focusRows = await focusDecisions(scan.signals.filter((signal) => tracked.has(signal.symbol)).map((signal) => signal.symbol));
    const signals = scan.signals.map((signal) =>
      focusRows.has(signal.symbol) ? applyFocusDecision(signal, focusRows.get(signal.symbol)) : signal,
    );

    const ranked = rankHotStocks(signals);
    const bySymbol = new Map(ranked.stocks.map((stock) => [stock.symbol, stock]));
    // `scan.universe` is what we asked for; `scan.signals` is what actually
    // produced a scored plan. A failed symbol must show "not analysed", not
    // "no long setup".
    const analysed = new Set(signals.map((signal) => signal.symbol));

    // The tape carries every screened name; analysed names also carry their
    // action, buy zone and sell ladder (and therefore every field the cards use).
    const rows = tape.rows.map((row) => {
      const stock = bySymbol.get(row.symbol);
      if (stock) return { ...row, ...stock, analysed: true };
      const meta = focusMeta(row.symbol);
      return {
        ...row,
        name: row.name === row.symbol ? meta.name : row.name,
        analysed: analysed.has(row.symbol),
        action: null,
        actionLabel: null,
        buyNow: false,
        watch: false,
        bucket: null,
        hotScore: null,
        growthProbability: null,
        growthBand: null,
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
      waitingCount: stocks.filter((stock) => stock.bucket === 'waiting').length,
      watchCount: stocks.filter((stock) => stock.watch).length,
      marketBuyNowCount: rows.filter((row) => row.buyNow).length,
      screens: tape.sources,
      stocks,
      tape: rows,
      errors: [...(scan.errors || []), ...(tape.screenErrors || [])],
      ...(includeSignals ? { analysed: signals } : {}),
    };
  }

  const resolved = explicit.length
    ? { symbols: normalizeSymbols(explicit).slice(0, MAX_HOT_UNIVERSE), scope: 'custom' }
    : resolveHotUniverse({ scope: effectiveScope, watchlist });
  if (refresh) cache.clear('scan:');

  const scan = await scanSymbols(resolved.symbols);
  // Same rule as the market path: a name the user tracks is decided by the
  // Focus board, so both boards publish one verdict for it.
  const tracked = new Set(watchlist.map((item) => item.symbol));
  const focusRows = await focusDecisions(scan.signals.filter((signal) => tracked.has(signal.symbol)).map((signal) => signal.symbol));
  const signals = scan.signals.map((signal) =>
    focusRows.has(signal.symbol) ? applyFocusDecision(signal, focusRows.get(signal.symbol)) : signal,
  );

  const ranked = rankHotStocks(signals);
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
    waitingCount: stocks.filter((stock) => stock.bucket === 'waiting').length,
    watchCount: stocks.filter((stock) => stock.watch).length,
    marketBuyNowCount: stocks.filter((stock) => stock.buyNow).length,
    screens: [],
    stocks,
    // The curated/focus paths already return every analysed name, so the tape
    // is the ranked list itself — carrying the full row (score, conviction,
    // RSI, risk/reward, sparkline) instead of a trimmed copy that left fields
    // the cards and the API consumer expect.
    tape: ranked.stocks.map((stock) => ({
      ...stock,
      analysed: true,
      curated: HOT_SYMBOLS.includes(stock.symbol),
      watchlist: tracked.has(stock.symbol),
      sources: tracked.has(stock.symbol) ? ['focus'] : ['curated'],
      relativeVolume: null,
      marketCap: null,
      exchange: null,
    })),
    errors: scan.errors,
    ...(includeSignals ? { analysed: signals } : {}),
  };
}

/**
 * The AI outlook: hand every analysed name to the configured model in compact
 * batches and return the ones it expects to rise. Cached for 30 minutes, and
 * it degrades to the deterministic engine ranking when there is no LLM key or
 * an individual batch fails, so the board always answers.
 */
export async function runHotStocksOutlook({
  symbols = [],
  scope = 'market',
  depth = DEFAULT_DEPTH,
  refresh = false,
  concurrency = 2,
} = {}) {
  const board = await getHotStocks({ symbols, scope, depth, limit: null, refresh, includeSignals: true });
  const signals = board.analysed || [];
  const rows = buildOutlookRows(signals);
  const enginePicks = engineOutlook(signals);
  const provider = describeProvider();
  const key = `hotOutlook:${rows.map((row) => row.symbol).sort().join(',')}`;

  if (refresh) cache.clear('hotOutlook:');
  const cached = cache.get(key);
  if (cached) return { ...cached, scope: board.scope, depth: board.depth, cached: true };

  const build = async () => {
    const started = Date.now();
    const generatedAt = new Date().toISOString();

    if (!provider.live || !rows.length) {
      return {
        ...mergeOutlook({ rows, modelPicks: [], enginePicks }),
        generatedAt,
        live: false,
        provider: 'rule-engine',
        model: 'MarketPilot rule engine',
        analysed: rows.length,
        latencyMs: Date.now() - started,
        errors: [],
      };
    }

    const batches = chunkRows(rows, OUTLOOK_BATCH_SIZE);
    const modelPicks = [];
    const errors = [];
    const queue = [...batches];
    const worker = async () => {
      while (queue.length) {
        const batch = queue.shift();
        try {
          const result = await decideOutlookBatch({ rows: batch });
          modelPicks.push(...result.picks);
        } catch (error) {
          errors.push(error.message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, () => worker()));

    return {
      ...mergeOutlook({ rows, modelPicks, enginePicks }),
      generatedAt,
      live: true,
      provider: provider.provider,
      model: provider.model,
      analysed: rows.length,
      latencyMs: Date.now() - started,
      errors: errors.slice(0, 3),
    };
  };

  const payload = await cache.wrap(key, OUTLOOK_TTL_MS, build);
  return { ...payload, scope: board.scope, depth: board.depth, cached: false };
}
