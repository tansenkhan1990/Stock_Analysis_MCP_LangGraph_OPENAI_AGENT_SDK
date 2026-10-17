import { Router } from 'express';
import { asyncHandler, normalizeSymbol } from '../lib/errors.js';
import { getSnapshot, listSnapshots, listWatchlist, saveSnapshot } from '../lib/store.js';
import { DEFAULT_SCAN_UNIVERSE, getAnalysis, scanSymbols } from '../services/analysisService.js';
import { HOT_SCOPES, getHotStocks } from '../services/hotStocksService.js';

export const analysisRouter = Router();

analysisRouter.get(
  '/hot-stocks',
  asyncHandler(async (req, res) => {
    const symbols = String(req.query.symbols || '')
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);
    res.json(
      await getHotStocks({
        symbols,
        scope: HOT_SCOPES.includes(String(req.query.scope)) ? String(req.query.scope) : 'market',
        limit: req.query.limit,
        // How many names of the live market tape get the full analysis.
        depth: req.query.depth,
        refresh: req.query.refresh === '1',
      }),
    );
  }),
);

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
        // Attach the id to the response copy only: `analysis` is the object
        // held by the shared analysis cache, and mutating it would leak a
        // snapshot id into every later (non-persist) response.
        const snapshotId = await saveSnapshot(analysis);
        return res.json({ ...analysis, snapshotId });
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
