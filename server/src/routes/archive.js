import { Router } from 'express';
import { archiveJobStatus, runMarketArchive } from '../jobs/marketArchive.js';
import { isMongoReady, mongoStatus } from '../lib/db.js';
import { asyncHandler, normalizeSymbol } from '../lib/errors.js';
import { getMarketHistory, listSnapshots, marketArchiveStats } from '../services/marketHistoryService.js';

export const archiveRouter = Router();

/** Archive status: storage, counters and the last daily run. */
archiveRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json({
      storage: mongoStatus(),
      archive: await marketArchiveStats(),
      job: archiveJobStatus(),
    });
  }),
);

/** Manual trigger — useful from cron, or right after adding a symbol. */
archiveRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    if (!isMongoReady()) {
      return res.status(503).json({
        error: 'MongoDB is not connected — the daily archive is unavailable',
        hint: 'Set MONGODB_URI (see .env.example) or run `docker compose up -d mongo`',
      });
    }
    const raw = req.body?.symbols;
    const symbols = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
      .map((symbol) => symbol.trim())
      .filter(Boolean)
      .map(normalizeSymbol);
    res.json(
      await runMarketArchive({
        force: true,
        reason: 'api',
        symbols: symbols.length ? symbols : null,
      }),
    );
  }),
);

/** Stored snapshots (newest first) plus the derived trend summary. */
archiveRouter.get(
  '/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const days = Number(req.query.days) || 60;
    const [history, snapshots] = await Promise.all([
      getMarketHistory(symbol, { days }),
      listSnapshots(symbol, { days }),
    ]);
    if (!history) {
      return res.status(404).json({
        error: `No archived snapshots for ${symbol} yet`,
        hint: isMongoReady()
          ? 'Run POST /api/archive/run to capture today, or wait for the daily job.'
          : 'MongoDB is not connected — the archive is disabled',
      });
    }
    res.json({ symbol, days: snapshots.length, history, snapshots });
  }),
);
