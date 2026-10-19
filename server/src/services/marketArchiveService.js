import { buildSnapshotRow, SNAPSHOT_SOURCE } from '../analytics/history.js';
import { analyzeAnalystActions } from '../analytics/news.js';
import { FOCUS_SYMBOLS, focusMeta } from '../data/universe.js';
import { isMongoReady } from '../lib/db.js';
import { getNewsDigest } from '../lib/newsFeed.js';
import { MarketSnapshot } from '../models/MarketSnapshot.js';
import { getAnalysis } from './analysisService.js';
import { clearHistoryCache } from './marketHistoryService.js';

/**
 * Write side of the archive: every session, store what Yahoo Finance said about
 * each tracked symbol. The documents are what later decisions read back —
 * score trend, action streak, how the previous calls actually resolved, and the
 * plan levels as they stood that day.
 *
 * Idempotent: one row per symbol per date, so re-running the job all day (or
 * after a restart) updates today's row instead of duplicating it.
 */

const dayKey = (date = new Date()) => new Date(date).toISOString().slice(0, 10);

export async function captureSymbolSnapshot(symbol, { date = new Date(), refresh = false } = {}) {
  if (!isMongoReady()) return { symbol, skipped: true, reason: 'mongodb-unavailable' };

  const meta = focusMeta(symbol);
  // Core analysis only: the archive wants the plan/score/indicators, and a
  // chain fetch per symbol per day would be wasted provider load.
  const analysis = await getAnalysis(symbol, { withOptions: false, refresh });
  const [news] = await Promise.all([
    getNewsDigest(symbol, meta.name, { withContent: false }).catch(() => null),
  ]);
  const analyst = analyzeAnalystActions(analysis.fundamentals?.analystActionsRaw || []);

  const row = buildSnapshotRow(analysis, { date, capturedAt: new Date(), news, analyst });
  if (!row) return { symbol, skipped: true, reason: 'no-analysis' };

  await MarketSnapshot.updateOne(
    { symbol: row.symbol, date: row.date },
    { $set: row, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  clearHistoryCache(row.symbol);

  return {
    symbol: row.symbol,
    date: row.date,
    close: row.close,
    action: row.action,
    actionLabel: row.actionLabel,
    score: row.score,
    source: SNAPSHOT_SOURCE,
  };
}

/** Capture the universe (or a subset) with a small worker pool. */
export async function captureUniverse({ symbols = FOCUS_SYMBOLS, concurrency = 2, date } = {}) {
  if (!isMongoReady()) {
    return { ok: false, reason: 'mongodb-unavailable', results: [] };
  }

  const queue = [...symbols];
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const symbol = queue.shift();
      try {
        results.push(await captureSymbolSnapshot(symbol, { date }));
      } catch (error) {
        results.push({ symbol, error: error.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, symbols.length)) }, () => worker()));

  return {
    ok: true,
    ranAt: new Date().toISOString(),
    date: dayKey(date || new Date()),
    symbols: symbols.length,
    stored: results.filter((result) => !result.skipped && !result.error).length,
    failures: results.filter((result) => result.error || result.skipped).length,
    results,
  };
}

export const _internals = { dayKey };
