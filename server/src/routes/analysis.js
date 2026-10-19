import { Router } from 'express';
import { archiveTrend } from '../analytics/history.js';
import { asyncHandler, normalizeSymbol } from '../lib/errors.js';
import { getSnapshot, listSnapshots, listWatchlist, saveSnapshot } from '../lib/store.js';
import { DEFAULT_SCAN_UNIVERSE, getAnalysis, scanSymbols } from '../services/analysisService.js';
import { getMarketHistory } from '../services/marketHistoryService.js';
import { getEtfDesk } from '../services/etfDeskService.js';
import { HOT_SCOPES, getHotStocks, runHotStocksOutlook } from '../services/hotStocksService.js';

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

analysisRouter.post(
  '/hot-stocks/ai',
  asyncHandler(async (req, res) => {
    const raw = req.body?.symbols;
    const symbols = Array.isArray(raw)
      ? raw
      : String(raw || '')
          .split(',')
          .map((symbol) => symbol.trim())
          .filter(Boolean);
    res.json(
      await runHotStocksOutlook({
        symbols,
        scope: HOT_SCOPES.includes(String(req.body?.scope)) ? String(req.body.scope) : 'market',
        depth: req.body?.depth,
        refresh: req.body?.refresh === true || req.query.refresh === '1',
      }),
    );
  }),
);

analysisRouter.get(
  '/etfs',
  asyncHandler(async (req, res) => {
    // Cheap read: the curated ETFs plus the user's own, carrying any desk call
    // that already exists. No model call is made here.
    res.json(await getEtfDesk({ refresh: req.query.refresh === '1' }));
  }),
);

analysisRouter.post(
  '/etfs/ai',
  asyncHandler(async (req, res) => {
    // Runs the LLM desk over every ETF (market data, news, deals, Street, event
    // risk and the option chain) and returns them sorted by chance to rise.
    res.json(await getEtfDesk({ runAi: true, refresh: req.body?.refresh === true || req.query.refresh === '1' }));
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
    // The live plan plus what the daily MongoDB snapshots say about it (null
    // when the archive has no rows or MongoDB is not configured).
    const marketHistory = await getMarketHistory(symbol, { days: 60 }).catch(() => null);
    const payload = {
      ...analysis,
      marketHistory,
      archive: marketHistory ? archiveTrend(marketHistory, { action: analysis.alert?.action ?? null }) : null,
    };
    if (persist) {
      try {
        // Attach the id to the response copy only: `analysis` is the object
        // held by the shared analysis cache, and mutating it would leak a
        // snapshot id into every later (non-persist) response.
        const snapshotId = await saveSnapshot(analysis);
        return res.json({ ...payload, snapshotId });
      } catch (error) {
        console.warn('[store] failed to persist analysis:', error.message);
      }
    }
    res.json(payload);
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
