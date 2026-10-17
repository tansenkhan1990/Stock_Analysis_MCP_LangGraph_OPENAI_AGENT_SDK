import { Router } from 'express';
import { asyncHandler, normalizeSymbol } from '../lib/errors.js';
import { getDayTrade } from '../services/dayTradeService.js';

export const dayTradeRouter = Router();

/** `ai=1` / `ai=0` forces or disables the LLM desk call; omitted = auto. */
const parseAi = (value) => {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
};

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
