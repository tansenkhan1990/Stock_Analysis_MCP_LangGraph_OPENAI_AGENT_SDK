/**
 * Market-wide screener layer for the Hot Stocks board.
 *
 * Yahoo's predefined screens give a live slice of the whole US market (most
 * actives, day gainers, growth, value, small-cap movers). This module turns
 * those quote lists into one ranked "tape", then picks which names get the full
 * analysis (levels, targets, stop) — the rest still show their live quote so the
 * page reflects the whole screened market, not a hand-written shortlist.
 *
 * Everything here is pure: the caller owns the network and the cache.
 */

/** Predefined Yahoo screens merged into the market universe. */
export const MARKET_SCREENS = [
  { id: 'most_actives', label: 'Most active', count: 250 },
  { id: 'day_gainers', label: 'Day gainers', count: 100 },
  { id: 'growth_technology_stocks', label: 'Growth tech', count: 100 },
  { id: 'undervalued_large_caps', label: 'Undervalued large caps', count: 100 },
  { id: 'small_cap_gainers', label: 'Small-cap gainers', count: 100 },
  { id: 'aggressive_small_caps', label: 'Aggressive small caps', count: 100 },
];

export const MARKET_SCREEN_IDS = MARKET_SCREENS.map((screen) => screen.id);

export const DEFAULT_MARKET_LIMIT = 600;
export const DEFAULT_DEPTH = 100;
export const MAX_DEPTH = 150;

const round = (value, digits = 2) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const US_VENUE_RE = /nasdaq|nyse|amex|arca|bats|cboe/i;

/** Only plain US-listed shares and ETFs can be scored by the daily engine. */
export const isTradeableQuote = (quote, { minPrice = 3, minAverageVolume = 300_000 } = {}) => {
  if (!quote?.symbol || !Number.isFinite(Number(quote.price)) || Number(quote.price) < minPrice) return false;
  if (!['EQUITY', 'ETF'].includes(String(quote.quoteType || 'EQUITY').toUpperCase())) return false;
  if (/[.=^]/.test(quote.symbol)) return false;
  if (quote.exchange && !US_VENUE_RE.test(quote.exchange)) return false;
  const averageVolume = Number(quote.averageVolume);
  if (Number.isFinite(averageVolume) && averageVolume > 0 && averageVolume < minAverageVolume) return false;
  return true;
};

/**
 * Cheap heat score used to decide WHO gets the expensive analysis. It rewards
 * unusual volume, a tradable move (a mild pullback or a steady rise — not a
 * parabolic spike) and liquidity.
 */
export function heatScore({ changePercent, volume, averageVolume, marketCap } = {}) {
  const avg = Number(averageVolume);
  const vol = Number(volume);
  const relativeVolume = Number.isFinite(avg) && avg > 0 && Number.isFinite(vol) && vol > 0 ? vol / avg : null;
  // 1x ≈ 50, 2x ≈ 75, 3x+ ≈ 100
  const volumeScore = relativeVolume === null ? 50 : clamp(50 + (Math.min(relativeVolume, 3) - 1) * 25, 25, 100);

  const change = Number.isFinite(Number(changePercent)) ? Number(changePercent) : 0;
  // A steady mover is more tradable than a blow-off top: cap the reward at ~8%
  // and give back some of it beyond that.
  const moveScore =
    change >= 0
      ? change <= 8
        ? 55 + change * 4
        : Math.max(45, 87 - (change - 8) * 1.6)
      : Math.max(30, 55 + change * 2.5);

  const cap = Number(marketCap);
  const liquidityScore = clamp(
    40 + Math.log10(Math.max(avg || 500_000, 100_000) / 500_000) * 20 + (Number.isFinite(cap) && cap > 0 ? Math.log10(cap) * 1.5 : 0),
    20,
    100,
  );

  return clamp(Math.round(volumeScore * 0.45 + clamp(moveScore, 20, 100) * 0.35 + liquidityScore * 0.2), 0, 100);
}

/**
 * Merge the screener quote lists (plus the curated universe and the user's
 * watchlist) into one de-duplicated, ranked tape.
 */
export function buildMarketTape({
  screens = [],
  curated = [],
  watchlist = [],
  limit = DEFAULT_MARKET_LIMIT,
  minPrice = 3,
  minAverageVolume = 300_000,
} = {}) {
  const curatedSet = new Set(curated.map((item) => String(typeof item === 'string' ? item : item?.symbol || '').toUpperCase()));
  const watchSet = new Set(
    watchlist.map((item) => String(typeof item === 'string' ? item : item?.symbol || '').toUpperCase()).filter(Boolean),
  );

  const rows = new Map();

  const addQuote = (quote) => {
    if (!isTradeableQuote(quote, { minPrice, minAverageVolume })) return;
    const symbol = String(quote.symbol).toUpperCase();
    const averageVolume = Number(quote.averageVolume) || 0;
    const volume = Number(quote.volume) || 0;
    const relativeVolume = averageVolume > 0 && volume > 0 ? round(volume / averageVolume, 2) : null;
    const existing = rows.get(symbol);
    if (existing) {
      // A symbol can appear in several screens; keep the richest quote.
      if (!existing.sources.includes(quote.screenId)) existing.sources.push(quote.screenId);
      return;
    }
    rows.set(symbol, {
      symbol,
      name: quote.name || symbol,
      quoteType: quote.quoteType || 'EQUITY',
      exchange: quote.exchange || null,
      price: round(quote.price),
      changePercent: round(quote.changePercent),
      change: round(quote.change),
      volume,
      averageVolume,
      relativeVolume,
      marketCap: Number(quote.marketCap) || null,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: quote.fiftyTwoWeekLow ?? null,
      marketState: quote.marketState ?? null,
      curated: curatedSet.has(symbol),
      watchlist: watchSet.has(symbol),
      sources: [quote.screenId].filter(Boolean),
      heat: heatScore({
        changePercent: quote.changePercent,
        volume,
        averageVolume,
        marketCap: quote.marketCap,
      }),
    });
  };

  for (const screen of screens) {
    for (const quote of screen.quotes || []) addQuote({ ...quote, screenId: screen.id });
  }

  const withExtras = (list, flags) => {
    for (const item of list) {
      const symbol = String(typeof item === 'string' ? item : item?.symbol || '').toUpperCase();
      if (!symbol || rows.has(symbol)) continue;
      const quote = typeof item === 'string' ? { symbol } : item;
      // Curated/watchlist names without a screener quote only join once an
      // upstream quote exists; the deep scan fetches them anyway.
      rows.set(symbol, {
        symbol,
        name: quote.name || symbol,
        quoteType: quote.quoteType === 'ETF' || quote.kind === 'etf' ? 'ETF' : 'EQUITY',
        exchange: null,
        price: null,
        changePercent: null,
        change: null,
        volume: 0,
        averageVolume: 0,
        relativeVolume: null,
        marketCap: null,
        fiftyTwoWeekHigh: null,
        fiftyTwoWeekLow: null,
        marketState: null,
        ...flags,
        sources: ['pinned'],
        heat: flags.curated ? 60 : 55,
      });
    }
  };

  withExtras(curated, { curated: true, watchlist: false });
  withExtras(watchlist, { curated: false, watchlist: true });

  const ranked = [...rows.values()].sort(
    (a, b) =>
      Number(b.curated) - Number(a.curated) ||
      Number(b.watchlist) - Number(a.watchlist) ||
      b.heat - a.heat ||
      String(a.symbol).localeCompare(String(b.symbol)),
  );

  // Every pinned name (curated + watchlist) always stays on the tape; the cap
  // only trims the long tail of screened names.
  const pinned = ranked.filter((row) => row.curated || row.watchlist);
  const rest = ranked.filter((row) => !row.curated && !row.watchlist).slice(0, Math.max(0, limit - pinned.length));

  return {
    rows: [...pinned, ...rest].sort(
      (a, b) => Number(b.curated) - Number(a.curated) || b.heat - a.heat || String(a.symbol).localeCompare(String(b.symbol)),
    ),
    universeSize: ranked.length,
    sources: screens.map((screen) => ({ id: screen.id, count: (screen.quotes || []).length })),
  };
}

/**
 * Which names get the full analysis: the hottest on the tape first, then any
 * pinned name the user cares about, capped at `depth`.
 */
export function selectDeepSymbols(rows = [], { depth = DEFAULT_DEPTH, always: extraSymbols = [] } = {}) {
  const cap = clamp(Number(depth) || DEFAULT_DEPTH, 1, MAX_DEPTH);
  const pinned = new Set(rows.filter((row) => row.curated || row.watchlist).map((row) => row.symbol));
  const extra = extraSymbols.map((symbol) => String(symbol).toUpperCase()).filter(Boolean);
  const hot = rows.map((row) => row.symbol);
  // Pinned names, then explicit extras, then the hottest of the tape.
  const ordered = [
    ...new Set([
      ...hot.filter((symbol) => pinned.has(symbol)),
      ...extra,
      ...hot,
    ]),
  ];
  return ordered.slice(0, cap);
}
