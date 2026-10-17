import { Router } from 'express';
import { asyncHandler, normalizeSymbol } from '../lib/errors.js';
import { getSnapshot, listSnapshots, listWatchlist, saveSnapshot } from '../lib/store.js';
import { DEFAULT_SCAN_UNIVERSE, getAnalysis, scanSymbols } from '../services/analysisService.js';

export const analysisRouter = Router();

analysisRouter.get(
  '/scan',
  asyncHandler(async (req, res) => {
    let symbols = String(req.query.symbols || '')
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);

    if (!symbols.length) {
      const watchlist = await listWatchlist();
      symbols = watchlist.length ? watchlist.map((item) => item.symbol) : DEFAULT_SCAN_UNIVERSE;
    }
    res.json(await scanSymbols(symbols));
  }),
);

analysisRouter.get(
  '/analysis/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const withOptions = req.query.options !== '0';
    const persist = req.query.persist === '1';
    const refresh = req.query.refresh === '1';
    const analysis = await getAnalysis(symbol, { withOptions, refresh });
    if (persist) {
      try {
        analysis.snapshotId = await saveSnapshot(analysis);
      } catch (error) {
        console.warn('[store] failed to persist analysis:', error.message);
      }
    }
    res.json(analysis);
  }),
);

analysisRouter.get(
  '/snapshots',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    res.json({ snapshots: await listSnapshots(limit) });
  }),
);

analysisRouter.get(
  '/snapshots/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const snapshot = await getSnapshot(symbol);
    if (!snapshot) return res.status(404).json({ error: `No saved analysis for ${symbol}` });
    res.json(snapshot);
  }),
);
