import { Router } from 'express';
import { ingestStatus, runNewsIngest } from '../jobs/newsIngest.js';
import { isMongoReady, mongoStatus } from '../lib/db.js';
import { asyncHandler, normalizeSymbol } from '../lib/errors.js';
import {
  getArchivedNews,
  getDeals,
  getNewsHistory,
  ingestSymbol,
  newsArchiveStats,
} from '../services/newsHistoryService.js';

export const newsRouter = Router();

/** Archive status: connection, counters, last ingest run. */
newsRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json({
      storage: mongoStatus(),
      archive: await newsArchiveStats(),
      ingest: ingestStatus(),
    });
  }),
);

/** Manual trigger (useful for cron or after adding a symbol). */
newsRouter.post(
  '/ingest',
  asyncHandler(async (req, res) => {
    const raw = req.body?.symbols;
    const symbols = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];

    if (!isMongoReady()) {
      return res.status(503).json({ error: 'MongoDB is not connected — news history is unavailable' });
    }

    if (symbols.length) {
      const results = [];
      for (const symbol of symbols) results.push(await ingestSymbol(normalizeSymbol(symbol)));
      return res.json({ ok: true, results });
    }

    // A manual trigger always runs: the user is explicitly asking for a refresh.
    res.json(await runNewsIngest({ force: true, reason: 'api' }));
  }),
);

/** Daily sentiment history + 7-day trend for one symbol. */
newsRouter.get(
  '/:symbol/history',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const days = Number(req.query.days) || 30;
    const history = await getNewsHistory(symbol, { days });
    if (!history) {
      return res.status(404).json({
        error: `No archived news for ${symbol} yet`,
        hint: isMongoReady() ? 'Run POST /api/news/ingest to collect it' : 'MongoDB is not connected',
      });
    }
    res.json(history);
  }),
);

/** Archived business deals. */
newsRouter.get(
  '/:symbol/deals',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const deals = await getDeals(symbol, {
      days: Number(req.query.days) || 90,
      limit: Number(req.query.limit) || 30,
    });
    res.json({ symbol, count: deals.length, deals });
  }),
);

/** Archived headlines (newest first). */
newsRouter.get(
  '/:symbol/items',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const items = await getArchivedNews(symbol, {
      days: Number(req.query.days) || 60,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ symbol, count: items.length, items });
  }),
);
