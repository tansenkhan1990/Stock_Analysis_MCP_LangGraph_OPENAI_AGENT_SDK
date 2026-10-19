import { summarizeMarketHistory } from '../analytics/history.js';
import { cache } from '../lib/cache.js';
import { isMongoReady } from '../lib/db.js';
import { MarketSnapshot } from '../models/MarketSnapshot.js';

/**
 * Read side of the daily archive. Every function here degrades to null/[] when
 * MongoDB is absent, so the app keeps working on live Yahoo data alone — the
 * archive only ever adds evidence, never becomes a hard dependency.
 */

const HISTORY_TTL = 60_000;
const HISTORY_PREFIX = 'archiveHistory:';
const MAX_DAYS = 400;

const clampDays = (days, fallback = 60) => Math.min(Math.max(Number(days) || fallback, 1), MAX_DAYS);

export const historyCacheKey = (symbol, days = 60) => `${HISTORY_PREFIX}${symbol}:${clampDays(days)}`;

/** Drop the cached summary for a symbol (called after a fresh snapshot lands). */
export function clearHistoryCache(symbol) {
  if (symbol) {
    for (const days of [7, 14, 30, 60, 90, 120, 180, 365, 400]) cache.clear(historyCacheKey(symbol, days));
  }
  cache.clear(HISTORY_PREFIX);
}

/**
 * Trend summary for one symbol, or null when nothing is archived yet.
 * Powers the decision layer, the agent tool and the archive API.
 */
export async function getMarketHistory(symbol, { days = 60, refresh = false } = {}) {
  if (!isMongoReady() || !symbol) return null;
  const window = clampDays(days);
  const key = historyCacheKey(symbol, window);
  if (refresh) cache.clear(key);

  return cache.wrap(key, HISTORY_TTL, async () => {
    const rows = await MarketSnapshot.find({ symbol })
      .sort({ date: -1 })
      .limit(window)
      .lean();
    return summarizeMarketHistory(symbol, rows.reverse());
  });
}

/**
 * Trend summaries for many symbols in one query — used by the Focus board so a
 * board load costs a single archive read instead of one per row.
 */
export async function getHistoryForSymbols(symbols = [], { days = 30 } = {}) {
  const list = [...new Set(symbols.filter(Boolean).map((symbol) => String(symbol).toUpperCase()))];
  if (!isMongoReady() || !list.length) return {};
  const window = clampDays(days, 30);

  const rows = await MarketSnapshot.find({ symbol: { $in: list } })
    .sort({ date: -1 })
    .limit(list.length * window)
    .lean();

  const grouped = new Map();
  for (const row of rows) {
    const bucket = grouped.get(row.symbol) || [];
    bucket.push(row);
    grouped.set(row.symbol, bucket);
  }

  const out = {};
  for (const [symbol, bucket] of grouped) {
    out[symbol] = summarizeMarketHistory(symbol, bucket.reverse().slice(-window));
  }
  return out;
}

/** Raw archived rows (newest first) for the API and exports. */
export async function listSnapshots(symbol, { days = 60 } = {}) {
  if (!isMongoReady() || !symbol) return [];
  const rows = await MarketSnapshot.find({ symbol })
    .sort({ date: -1 })
    .limit(clampDays(days))
    .lean();
  return rows;
}

export async function pruneOldSnapshots({ days = 400 } = {}) {
  if (!isMongoReady()) return 0;
  const cutoff = new Date(Date.now() - Math.max(30, Number(days) || 400) * 86_400_000);
  const result = await MarketSnapshot.deleteMany({ capturedAt: { $lt: cutoff } });
  return result.deletedCount || 0;
}

export async function marketArchiveStats() {
  if (!isMongoReady()) {
    return {
      connected: false,
      supported: false,
      snapshots: 0,
      symbols: 0,
      firstDate: null,
      lastDate: null,
      todaySymbols: 0,
      lastCapturedAt: null,
    };
  }
  const today = new Date().toISOString().slice(0, 10);
  const [snapshots, symbols, latest, earliest, todaySymbols] = await Promise.all([
    MarketSnapshot.estimatedDocumentCount(),
    MarketSnapshot.distinct('symbol'),
    MarketSnapshot.findOne().sort({ date: -1, capturedAt: -1 }).select({ date: 1, capturedAt: 1 }).lean(),
    MarketSnapshot.findOne().sort({ date: 1 }).select({ date: 1 }).lean(),
    MarketSnapshot.countDocuments({ date: today }),
  ]);

  return {
    connected: true,
    supported: true,
    snapshots,
    symbols: symbols.length,
    firstDate: earliest?.date ?? null,
    lastDate: latest?.date ?? null,
    todaySymbols,
    lastCapturedAt: latest?.capturedAt ? new Date(latest.capturedAt).toISOString() : null,
  };
}

export const _internals = { clampDays };
