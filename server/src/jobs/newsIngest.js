import { config } from '../config.js';
import { FOCUS_SYMBOLS } from '../data/universe.js';
import { isMongoReady } from '../lib/db.js';
import { DailyNewsDigest } from '../models/DailyNewsDigest.js';
import { ingestUniverse, pruneOldNews } from '../services/newsHistoryService.js';

/**
 * Daily news/deal archive job.
 *
 * Runs once shortly after boot (so a fresh install has data immediately) and
 * then once per day after NEWS_INGEST_HOUR local time. A 30-minute tick keeps
 * the check cheap; the actual work happens at most once per day because the
 * presence of today's digests is the idempotency guard.
 */

const TICK_MS = 30 * 60_000;
const BOOT_DELAY_MS = 4_000;

const state = {
  running: false,
  lastRun: null,
  lastResult: null,
  lastError: null,
  timer: null,
  bootTimer: null,
};

const today = () => new Date().toISOString().slice(0, 10);

async function isTodayComplete() {
  const count = await DailyNewsDigest.countDocuments({ date: today(), symbol: { $in: FOCUS_SYMBOLS } });
  return count >= FOCUS_SYMBOLS.length;
}

export async function runNewsIngest({ force = false, reason = 'manual' } = {}) {
  if (!isMongoReady()) {
    return { ok: false, reason: 'mongodb-unavailable', results: [] };
  }
  if (state.running) {
    return { ok: false, reason: 'already-running', results: [] };
  }
  if (!force && (await isTodayComplete())) {
    return { ok: true, skipped: true, reason: 'already-ingested-today', results: [] };
  }

  state.running = true;
  state.lastRun = new Date();
  try {
    const result = await ingestUniverse();
    // Housekeeping once a day: drop items outside the retention window.
    const pruned = await pruneOldNews({ days: config.ingest.retentionDays }).catch(() => 0);
    state.lastResult = {
      ...result,
      pruned,
      reason,
      durationMs: Date.now() - state.lastRun.getTime(),
    };
    state.lastError = null;
    console.log(
      `[ingest] ${reason}: ${result.stored} headlines, ${result.deals} deals across ${result.symbols} symbols` +
        (pruned ? ` · pruned ${pruned} old item(s)` : '') +
        (result.failures ? ` (${result.failures} failed)` : ''),
    );
    return state.lastResult;
  } catch (error) {
    state.lastError = error.message;
    console.warn(`[ingest] failed: ${error.message}`);
    return { ok: false, reason: 'error', error: error.message, results: [] };
  } finally {
    state.running = false;
  }
}

async function tick() {
  if (!isMongoReady()) return;
  const hour = new Date().getHours();
  if (hour < config.ingest.hour) return;
  await runNewsIngest({ reason: 'daily' });
}

export function startNewsIngest() {
  if (!config.ingest.enabled) {
    console.log('[ingest] daily news archive disabled (NEWS_INGEST_ENABLED=false)');
    return;
  }
  if (!isMongoReady()) {
    console.log('[ingest] MongoDB not connected — daily news archive is idle');
    return;
  }

  if (config.ingest.onBoot) {
    state.bootTimer = setTimeout(() => {
      runNewsIngest({ reason: 'boot' });
    }, BOOT_DELAY_MS);
    state.bootTimer.unref?.();
  }

  state.timer = setInterval(tick, TICK_MS);
  state.timer.unref?.();
  console.log(
    `[ingest] daily news archive active · runs after ${String(config.ingest.hour).padStart(2, '0')}:00 local`,
  );
}

export function stopNewsIngest() {
  if (state.timer) clearInterval(state.timer);
  if (state.bootTimer) clearTimeout(state.bootTimer);
  state.timer = null;
  state.bootTimer = null;
}

export function ingestStatus() {
  return {
    enabled: config.ingest.enabled,
    runsAfterHour: config.ingest.hour,
    running: state.running,
    lastRun: state.lastRun ? state.lastRun.toISOString() : null,
    lastResult: state.lastResult
      ? {
          symbols: state.lastResult.symbols,
          stored: state.lastResult.stored,
          deals: state.lastResult.deals,
          failures: state.lastResult.failures,
          pruned: state.lastResult.pruned || 0,
          reason: state.lastResult.reason,
          durationMs: state.lastResult.durationMs,
        }
      : null,
    lastError: state.lastError,
  };
}
