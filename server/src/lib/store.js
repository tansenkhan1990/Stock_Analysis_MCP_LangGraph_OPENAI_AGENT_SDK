import { randomUUID } from 'node:crypto';
import { DEFAULT_WATCHLIST as FOCUS_WATCHLIST } from '../data/universe.js';

/**
 * In-process store for ephemeral session state: the watchlist, saved research
 * snapshots and agent threads live in memory for the lifetime of the server
 * process. Market data is always live; MongoDB is optional and only used for
 * the news/deal archive (see lib/db.js).
 */
const memory = {
  watchlist: new Map(),
  snapshots: [],
  threads: new Map(),
};

const MAX_SNAPSHOTS = 200;
const MAX_THREADS = 50;

/** Keep the in-memory agent history bounded; drop the least recently used. */
function trimThreads() {
  if (memory.threads.size <= MAX_THREADS) return;
  const excess = [...memory.threads.values()]
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt))
    .slice(0, memory.threads.size - MAX_THREADS);
  for (const thread of excess) memory.threads.delete(thread.threadId);
}

/** The watchlist starts as the curated focus universe. */
export const DEFAULT_WATCHLIST = FOCUS_WATCHLIST;

export async function listWatchlist() {
  return [...memory.watchlist.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export async function addWatchlist({ symbol, name, quoteType = 'EQUITY', note = '' }) {
  const existing = memory.watchlist.get(symbol);
  const item = {
    id: existing?.id || randomUUID(),
    symbol,
    name,
    quoteType,
    note,
    createdAt: existing?.createdAt || new Date(),
  };
  memory.watchlist.set(symbol, item);
  return item;
}

export async function removeWatchlist(symbol) {
  memory.watchlist.delete(symbol);
}

/**
 * Seed the curated focus list exactly once per process. Seeding on every
 * empty read would resurrect names the user deleted, so track it explicitly.
 * The in-flight promise is shared so two concurrent first reads cannot return
 * a half-seeded watchlist.
 */
let seedPromise = null;

export async function seedWatchlist() {
  if (!seedPromise) {
    seedPromise = (async () => {
      for (const item of DEFAULT_WATCHLIST) await addWatchlist(item);
    })().catch((error) => {
      seedPromise = null;
      throw error;
    });
  }
  await seedPromise;
  return listWatchlist();
}

export async function saveSnapshot(analysis) {
  const doc = {
    id: randomUUID(),
    symbol: analysis.symbol,
    name: analysis.name,
    quoteType: analysis.quoteType,
    price: analysis.price,
    score: analysis.score.total,
    signal: analysis.signal,
    action: analysis.alert?.action ?? 'hold',
    actionLabel: analysis.alert?.actionLabel ?? 'Hold',
    buyZoneLow: analysis.plan.buyZone?.low ?? null,
    buyZoneHigh: analysis.plan.buyZone?.high ?? null,
    target1: analysis.plan.targets[0]?.price ?? null,
    stopLoss: analysis.plan.stopLoss,
    payload: analysis,
    createdAt: new Date(),
  };
  memory.snapshots.push(doc);
  if (memory.snapshots.length > MAX_SNAPSHOTS) memory.snapshots.shift();
  return doc.id;
}

export async function listSnapshots(limit = 25) {
  return [...memory.snapshots]
    .reverse()
    .slice(0, limit)
    .map(({ payload, ...rest }) => rest);
}

export async function getSnapshot(symbol) {
  return [...memory.snapshots].reverse().find((item) => item.symbol === symbol) || null;
}

export async function createThread({ threadId, title, provider = 'builtin' }) {
  const id = threadId || randomUUID();
  const thread = {
    threadId: id,
    title,
    provider,
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  memory.threads.set(id, thread);
  trimThreads();
  return thread;
}

export async function getThread(threadId) {
  return memory.threads.get(threadId) || null;
}

export async function appendMessages(threadId, messages, { title, provider } = {}) {
  const thread = memory.threads.get(threadId) || {
    threadId,
    title: title || 'New analysis',
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  thread.messages.push(
    ...messages.map((message) => ({ ...message, createdAt: message.createdAt || new Date() })),
  );
  thread.updatedAt = new Date();
  if (title) thread.title = title;
  if (provider) thread.provider = provider;
  memory.threads.set(threadId, thread);
  trimThreads();
}

export async function listThreads(limit = 20) {
  return [...memory.threads.values()]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, limit)
    .map(({ threadId, title, provider, updatedAt }) => ({ threadId, title, provider, updatedAt }));
}

export async function stats() {
  return {
    watchlist: memory.watchlist.size,
    snapshots: memory.snapshots.length,
    threads: memory.threads.size,
    storage: 'memory',
  };
}
