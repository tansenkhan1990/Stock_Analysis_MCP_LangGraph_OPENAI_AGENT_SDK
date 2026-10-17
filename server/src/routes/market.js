import { Router } from 'express';
import { getHistory, getQuote, searchSymbols } from '../lib/yahoo.js';
import { asyncHandler, normalizeSymbol } from '../lib/errors.js';
import { getUsdEurRate } from '../services/fxService.js';
import { getMarketOverview } from '../services/marketService.js';

export const marketRouter = Router();

marketRouter.get(
  '/fx',
  asyncHandler(async (req, res) => {
    res.json(await getUsdEurRate());
  }),
);

marketRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    res.json(await getMarketOverview());
  }),
);

marketRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json({ query, results: [] });
    res.json({ query, results: await searchSymbols(query) });
  }),
);

marketRouter.get(
  '/quote/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    res.json(await getQuote(symbol));
  }),
);

marketRouter.get(
  '/history/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const range = String(req.query.range || '1y');
    const interval = String(req.query.interval || '1d');
    res.json(await getHistory(symbol, { range, interval }));
  }),
);
