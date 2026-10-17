import { Router } from 'express';
import { asyncHandler, normalizeSymbol } from '../lib/errors.js';
import { getFocusBoard, getResearch, runDeskDecisions } from '../services/researchService.js';

export const focusRouter = Router();

focusRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    // An explicit `symbols` query (even empty) wins; otherwise the board is
    // built from the user's watchlist.
    const hasSymbols = typeof req.query.symbols === 'string';
    const symbols = hasSymbols
      ? req.query.symbols
          .split(',')
          .map((symbol) => symbol.trim().toUpperCase())
          .filter(Boolean)
      : undefined;
    res.json(await getFocusBoard(hasSymbols ? { symbols } : {}));
  }),
);

focusRouter.post(
  '/ai',
  asyncHandler(async (req, res) => {
    const raw = req.body?.symbols;
    const symbols = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(',').map((symbol) => symbol.trim())
        : [];
    const cleaned = symbols.map((symbol) => normalizeSymbol(symbol)).filter(Boolean);
    const refresh = req.body?.refresh === true || req.query.refresh === '1';
    res.json(await runDeskDecisions(cleaned.length ? { symbols: cleaned, refresh } : { refresh }));
  }),
);

focusRouter.get(
  '/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const ai = req.query.ai === '1' || req.query.ai === 'true';
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await getResearch(symbol, { ai, refresh }));
  }),
);
