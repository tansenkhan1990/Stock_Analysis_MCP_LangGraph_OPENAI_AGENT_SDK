import { Router } from 'express';
import { evaluateStrategy } from '../analytics/options.js';
import { asyncHandler, badRequest, normalizeSymbol } from '../lib/errors.js';
import { getExpirations, getQuote } from '../lib/yahoo.js';
import { seedWatchlist } from '../lib/store.js';
import { getChainWithAnalytics, getOptionsIdeas } from '../services/analysisService.js';

export const optionsRouter = Router();

optionsRouter.get(
  '/ideas',
  asyncHandler(async (req, res) => {
    let symbols = String(req.query.symbols || '')
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);
    if (!symbols.length) {
      const watchlist = await seedWatchlist();
      symbols = watchlist.map((item) => item.symbol);
    }
    res.json(await getOptionsIdeas(symbols));
  }),
);

optionsRouter.get(
  '/:symbol/expirations',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    res.json(await getExpirations(symbol));
  }),
);

optionsRouter.get(
  '/:symbol/chain',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const date = req.query.date ? String(req.query.date) : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be YYYY-MM-DD');
    res.json(await getChainWithAnalytics(symbol, date));
  }),
);

optionsRouter.post(
  '/evaluate',
  asyncHandler(async (req, res) => {
    const { symbol, legs, iv, dte } = req.body || {};
    const ticker = normalizeSymbol(symbol);
    if (!Array.isArray(legs) || !legs.length) throw badRequest('Provide at least one option leg');
    if (legs.length > 8) throw badRequest('A maximum of 8 legs is supported');

    for (const leg of legs) {
      if (!['call', 'put', 'stock'].includes(leg.kind)) throw badRequest(`Invalid leg kind "${leg.kind}"`);
      if (!['buy', 'sell'].includes(leg.action)) throw badRequest(`Invalid leg action "${leg.action}"`);
      if (leg.kind !== 'stock' && (!Number.isFinite(Number(leg.strike)) || Number(leg.strike) <= 0)) {
        throw badRequest('Each option leg needs a positive strike');
      }
    }

    const quote = await getQuote(ticker);
    const cleanLegs = legs.map((leg) => ({
      kind: leg.kind,
      action: leg.action,
      strike: Number(leg.strike) || quote.price,
      premium: Math.max(0, Number(leg.premium) || 0),
      qty: Math.max(1, Number(leg.qty) || 1),
      iv: Number(leg.iv) || undefined,
      contractSymbol: leg.contractSymbol,
    }));

    const metrics = evaluateStrategy(cleanLegs, quote.price, {
      iv: Number(iv) || 0.3,
      dte: Number(dte) || 30,
    });
    if (!metrics) throw badRequest('Could not evaluate those legs');

    res.json({ symbol: ticker, spot: quote.price, legs: cleanLegs, ...metrics });
  }),
);
