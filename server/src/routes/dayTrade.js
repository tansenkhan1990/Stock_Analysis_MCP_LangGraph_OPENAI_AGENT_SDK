import { Router } from 'express';
import { asyncHandler, normalizeSymbol } from '../lib/errors.js';
import { getDayTrade, getDayTradeBoard } from '../services/dayTradeService.js';

export const dayTradeRouter = Router();

/** `ai=1` / `ai=0` forces or disables the LLM desk call; omitted = auto. */
const parseAi = (value) => {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
};

/** `/board` must sit before `/:symbol` or Express would read it as a ticker. */
dayTradeRouter.get(
  '/board',
  asyncHandler(async (req, res) => {
    res.json(
      await getDayTradeBoard({
        symbols: req.query.symbols ? String(req.query.symbols).split(',') : [],
        scope: req.query.scope ? String(req.query.scope) : 'market',
        depth: req.query.depth,
        refresh: req.query.refresh === '1',
        ai: parseAi(req.query.ai),
      }),
    );
  }),
);

dayTradeRouter.get(
  '/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    res.json(
      await getDayTrade(symbol, {
        refresh: req.query.refresh === '1',
        ai: parseAi(req.query.ai),
      }),
    );
  }),
);
