import { config } from '../config.js';
import { FOCUS_SYMBOLS } from '../data/universe.js';
import { isMongoReady } from '../lib/db.js';
import { seedWatchlist } from '../lib/store.js';
import { MarketSnapshot } from '../models/MarketSnapshot.js';
import { captureUniverse } from '../services/marketArchiveService.js';
import { pruneOldSnapshots } from '../services/marketHistoryService.js';

/**
 * Daily Yahoo Finance archive job.
 *
 * Stores one snapshot per tracked symbol per session in MongoDB, so the
 * decision layer can read yesterday's structure, score trend and call history
 * instead of only today's quote. Runs shortly after boot (a fresh install gets
 * data immediately) and then once a day after ARCHIVE_HOUR local time. The
 * presence of today's rows is the idempotency guard, exactly like the news job.
 */

const TICK_MS = 30 * 60_000;
const BOOT_DELAY_MS = 8_000;

const state = {
  running: false,
  lastRun: null,
  lastResult: null,
  lastError: null,
  timer: null,
  bootTimer: null,
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Everything the app tracks: the focus universe plus whatever the user added to
 * the watchlist, deduped. Archive the user's own names too, otherwise their
 * cards have no history and every decision about them is first-day.
 */
async function archiveSymbols() {
  const watchlist = await seedWatchlist().catch(() => []);
  return [...new Set([...FOCUS_SYMBOLS, ...watchlist.map((item) => item.symbol)])];
}

async function isTodayComplete(symbols) {
  const count = await MarketSnapshot.countDocuments({ date: today(), symbol: { $in: symbols } });
  return count >= symbols.length;
}

export async function runMarketArchive({ force = false, reason = 'manual', symbols = null } = {}) {
  if (!isMongoReady()) {
    return { ok: false, reason: 'mongodb-unavailable', results: [] };
  }
  if (state.running) {
    return { ok: false, reason: 'already-running', results: [] };
  }
  const tracked = symbols || (await archiveSymbols());
  if (!force && !symbols && (await isTodayComplete(tracked))) {
    return { ok: true, skipped: true, reason: 'already-archived-today', results: [] };
  }

  state.running = true;
  state.lastRun = new Date();
  try {
    const result = await captureUniverse({ symbols: tracked });
    // Housekeeping once a day: drop snapshots outside the retention window.
    const pruned = await pruneOldSnapshots({ days: config.archive.retentionDays }).catch(() => 0);
    state.lastResult = {
      ...result,
      pruned,
      reason,
      durationMs: Date.now() - state.lastRun.getTime(),
    };
    state.lastError = null;
    console.log(
      `[archive] ${reason}: ${result.stored} snapshot(s) stored for ${result.date}` +
        (pruned ? ` · pruned ${pruned} old row(s)` : '') +
        (result.failures ? ` (${result.failures} failed)` : ''),
    );
    return state.lastResult;
  } catch (error) {
    state.lastError = error.message;
    console.warn(`[archive] failed: ${error.message}`);
    return { ok: false, reason: 'error', error: error.message, results: [] };
  } finally {
    state.running = false;
  }
}

async function tick() {
  if (!isMongoReady()) return;
  if (new Date().getHours() < config.archive.hour) return;
  await runMarketArchive({ reason: 'daily' });
}

export function startMarketArchive() {
  if (!config.archive.enabled) {
    console.log('[archive] daily market archive disabled (ARCHIVE_ENABLED=false)');
    return;
  }
  if (!isMongoReady()) {
    console.log('[archive] MongoDB not connected — daily market archive is idle');
    return;
  }

  if (config.archive.onBoot) {
    state.bootTimer = setTimeout(() => {
      runMarketArchive({ reason: 'boot' });
    }, BOOT_DELAY_MS);
    state.bootTimer.unref?.();
  }

  state.timer = setInterval(tick, TICK_MS);
  state.timer.unref?.();
  console.log(
    `[archive] daily market archive active · runs after ${String(config.archive.hour).padStart(2, '0')}:00 local`,
  );
}

export function stopMarketArchive() {
  if (state.timer) clearInterval(state.timer);
  if (state.bootTimer) clearTimeout(state.bootTimer);
  state.timer = null;
  state.bootTimer = null;
}

export function archiveJobStatus() {
  return {
    enabled: config.archive.enabled,
    runsAfterHour: config.archive.hour,
    retentionDays: config.archive.retentionDays,
    running: state.running,
    lastRun: state.lastRun ? state.lastRun.toISOString() : null,
    lastResult: state.lastResult
      ? {
          date: state.lastResult.date,
          symbols: state.lastResult.symbols,
          stored: state.lastResult.stored,
          failures: state.lastResult.failures,
          pruned: state.lastResult.pruned || 0,
          reason: state.lastResult.reason,
          durationMs: state.lastResult.durationMs,
        }
      : null,
    lastError: state.lastError,
  };
}
