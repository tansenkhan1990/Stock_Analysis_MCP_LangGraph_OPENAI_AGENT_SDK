import { Router } from 'express';
import { badRequest, asyncHandler, normalizeSymbol } from '../lib/errors.js';
import { addWatchlist, listWatchlist, removeWatchlist, seedWatchlist } from '../lib/store.js';
import { getQuote } from '../lib/yahoo.js';

export const watchlistRouter = Router();

watchlistRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await seedWatchlist();
    res.json({ items });
  }),
);

watchlistRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.body?.symbol);
    const quote = await getQuote(symbol);
    const item = await addWatchlist({
      symbol,
      name: quote.name,
      quoteType: quote.quoteType,
      note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : '',
    });
    res.status(201).json(item);
  }),
);

watchlistRouter.delete(
  '/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    await removeWatchlist(symbol);
    res.json({ ok: true, symbol });
  }),
);
