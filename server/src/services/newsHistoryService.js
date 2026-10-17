import { DailyNewsDigest } from '../models/DailyNewsDigest.js';
import { NewsItem } from '../models/NewsItem.js';
import { FOCUS_SYMBOLS, focusMeta } from '../data/universe.js';
import { isMongoReady } from '../lib/db.js';
import { getNewsDigest } from '../lib/newsFeed.js';

/**
 * Permanent archive for Yahoo Finance news and business deals.
 *
 * Live quotes still come from Yahoo on every request; this layer accumulates
 * what the news feed said each day so the app can measure whether coverage is
 * improving or deteriorating instead of only seeing today's snapshot.
 */

const dayKey = (date = new Date()) => new Date(date).toISOString().slice(0, 10);

const toDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Persist one symbol's current feed. Idempotent: safe to re-run all day. */
export async function ingestSymbol(symbol, name, { date = new Date() } = {}) {
  if (!isMongoReady()) {
    return { symbol, skipped: true, reason: 'mongodb-unavailable' };
  }

  const meta = focusMeta(symbol);
  const digest = await getNewsDigest(symbol, name || meta.name, { withContent: false });
  const today = dayKey(date);

  const items = digest.headlines.filter((item) => item.link);
  if (items.length) {
    await NewsItem.bulkWrite(
      items.map((item) => {
        const published = toDate(item.publishedAt);
        const isDeal = (item.tags || []).includes('Business deal');
        return {
          updateOne: {
            filter: { symbol, link: item.link },
            update: {
              $set: {
                name: name || meta.name,
                title: item.title,
                publisher: item.publisher || null,
                publishedAt: published,
                day: published ? dayKey(published) : today,
                direction: item.direction || 'neutral',
                score: item.score ?? 0,
                tags: item.tags || [],
                isDeal,
                relevance: item.relevance ?? null,
              },
              $setOnInsert: { ingestedAt: new Date() },
            },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
  }

  await DailyNewsDigest.updateOne(
    { symbol, date: today },
    {
      $set: {
        sentiment: digest.sentiment,
        label: digest.label,
        headlineCount: digest.headlineCount,
        counts: digest.counts,
        dealCount: digest.deals.length,
        deals: digest.deals.map((deal) => ({
          title: deal.title,
          link: deal.link,
          score: deal.score,
          direction: deal.direction,
          publishedAt: toDate(deal.publishedAt),
        })),
        catalysts: digest.catalysts.map((item) => ({
          title: item.title,
          direction: item.direction,
          score: item.score,
          tags: item.tags || [],
          link: item.link,
        })),
        risks: digest.risks.map((item) => ({
          title: item.title,
          score: item.score,
          tags: item.tags || [],
          link: item.link,
        })),
        capturedAt: new Date(),
      },
    },
    { upsert: true },
  );

  return {
    symbol,
    stored: items.length,
    deals: digest.deals.length,
    sentiment: digest.sentiment,
    date: today,
  };
}

/** Delete archived items older than the retention window. */
export async function pruneOldNews({ days = 365 } = {}) {
  if (!isMongoReady()) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const result = await NewsItem.deleteMany({
    $or: [{ publishedAt: { $lt: cutoff } }, { publishedAt: null, ingestedAt: { $lt: cutoff } }],
  });
  return result.deletedCount || 0;
}

/** Ingest the whole focus universe (or a subset) with a small worker pool. */
export async function ingestUniverse({ symbols = FOCUS_SYMBOLS, concurrency = 2 } = {}) {
  if (!isMongoReady()) {
    return { ok: false, reason: 'mongodb-unavailable', results: [] };
  }

  const queue = [...symbols];
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const symbol = queue.shift();
      try {
        results.push(await ingestSymbol(symbol));
      } catch (error) {
        results.push({ symbol, error: error.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker()));

  return {
    ok: true,
    ranAt: new Date().toISOString(),
    symbols: symbols.length,
    stored: results.reduce((acc, item) => acc + (item.stored || 0), 0),
    deals: results.reduce((acc, item) => acc + (item.deals || 0), 0),
    failures: results.filter((item) => item.error || item.skipped).length,
    results,
  };
}

/** Pure aggregation of daily digests (oldest first) into a trend summary. */
export function summarizeHistory(symbol, ordered = []) {
  if (!ordered.length) return null;

  const avg = (slice) =>
    slice.length ? Math.round(slice.reduce((acc, row) => acc + row.sentiment, 0) / slice.length) : null;

  const last7 = ordered.slice(-7);
  const prior7 = ordered.slice(-14, -7);
  const sentiment7 = avg(last7);
  const sentimentPrior7 = avg(prior7);
  const delta7 = sentiment7 !== null && sentimentPrior7 !== null ? sentiment7 - sentimentPrior7 : null;
  const deals30 = ordered.reduce((acc, row) => acc + (row.dealCount || 0), 0);
  const headlines30 = ordered.reduce((acc, row) => acc + (row.headlineCount || 0), 0);

  return {
    symbol,
    coverageDays: ordered.length,
    firstDate: ordered[0]?.date ?? null,
    lastDate: ordered[ordered.length - 1]?.date ?? null,
    sentiment7,
    sentimentPrior7,
    delta7,
    direction: delta7 === null ? 'flat' : delta7 >= 8 ? 'improving' : delta7 <= -8 ? 'deteriorating' : 'flat',
    deals30d: deals30,
    headlines30d: headlines30,
    digests: ordered.map((row) => ({
      date: row.date,
      sentiment: row.sentiment,
      label: row.label,
      headlineCount: row.headlineCount,
      dealCount: row.dealCount,
      counts: row.counts,
    })),
  };
}

/** Last N daily digests for a symbol, oldest first, plus summary statistics. */
export async function getNewsHistory(symbol, { days = 30 } = {}) {
  if (!isMongoReady()) return null;

  const rows = await DailyNewsDigest.find({ symbol })
    .sort({ date: -1 })
    .limit(Math.min(Math.max(days, 1), 180))
    .lean();

  return summarizeHistory(symbol, rows.reverse());
}

/** Archived business deals for a symbol. */
export async function getDeals(symbol, { days = 90, limit = 30 } = {}) {
  if (!isMongoReady()) return [];
  const since = new Date(Date.now() - days * 86_400_000);
  return NewsItem.find({ symbol, isDeal: true, $or: [{ publishedAt: { $gte: since } }, { publishedAt: null }] })
    .sort({ publishedAt: -1, ingestedAt: -1 })
    .limit(Math.min(limit, 100))
    .select({ _id: 0, title: 1, link: 1, publisher: 1, publishedAt: 1, direction: 1, score: 1, tags: 1 })
    .lean();
}

/** Archived headlines for a symbol. */
export async function getArchivedNews(symbol, { limit = 50, days = 60 } = {}) {
  if (!isMongoReady()) return [];
  const since = new Date(Date.now() - days * 86_400_000);
  return NewsItem.find({ symbol, $or: [{ publishedAt: { $gte: since } }, { publishedAt: null }] })
    .sort({ publishedAt: -1, ingestedAt: -1 })
    .limit(Math.min(limit, 200))
    .select({ _id: 0, title: 1, link: 1, publisher: 1, publishedAt: 1, direction: 1, score: 1, tags: 1, isDeal: 1 })
    .lean();
}

/** Storage counters for /api/health and the news status endpoint. */
export async function newsArchiveStats() {
  if (!isMongoReady()) {
    return { connected: false, newsItems: 0, digests: 0, deals: 0, symbols: 0, lastDigestDate: null };
  }
  const [newsItems, deals, digests, symbols, latest] = await Promise.all([
    NewsItem.estimatedDocumentCount(),
    NewsItem.countDocuments({ isDeal: true }),
    DailyNewsDigest.estimatedDocumentCount(),
    DailyNewsDigest.distinct('symbol'),
    DailyNewsDigest.findOne().sort({ date: -1 }).select({ date: 1 }).lean(),
  ]);
  return {
    connected: true,
    newsItems,
    deals,
    digests,
    symbols: symbols.length,
    lastDigestDate: latest?.date ?? null,
  };
}

export const _internals = { dayKey };
