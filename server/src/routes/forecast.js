import { Router } from 'express';
import { SUGGESTED_QUESTIONS, answerForecast, normalizeHistory } from '../agent/forecastDesk.js';
import { asyncHandler, HttpError, normalizeSymbol } from '../lib/errors.js';
import { getForecast } from '../services/forecastService.js';
import { getForecastBoard } from '../services/forecastBoardService.js';

export const forecastRouter = Router();

const MAX_QUESTION = 600;

/** `/board` must sit before `/:symbol` or Express would read it as a ticker. */
forecastRouter.get(
  '/board',
  asyncHandler(async (req, res) => {
    res.json(
      await getForecastBoard({
        scope: req.query.scope ? String(req.query.scope) : 'watchlist',
        depth: req.query.depth,
        refresh: req.query.refresh === '1',
      }),
    );
  }),
);

forecastRouter.get(
  '/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const forecast = await getForecast(symbol, {
      days: req.query.days,
      refresh: req.query.refresh === '1',
    });
    res.json({ ...forecast, suggestions: SUGGESTED_QUESTIONS });
  }),
);

forecastRouter.post(
  '/:symbol/ask',
  asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (question.length < 3) throw new HttpError(400, 'Ask a question of at least 3 characters.');
    if (question.length > MAX_QUESTION) {
      throw new HttpError(400, `Keep the question under ${MAX_QUESTION} characters.`);
    }

    // The question is answered from the same cached forecast the page is
    // showing, so the model cannot explain numbers the user does not see.
    const forecast = await getForecast(symbol, {
      days: req.body?.days ?? req.query.days,
      refresh: req.body?.refresh === true || req.query.refresh === '1',
    });

    const answer = await answerForecast({
      forecast,
      question,
      history: normalizeHistory(req.body?.history),
    });

    res.json({
      symbol,
      question,
      ...answer,
      suggestions: SUGGESTED_QUESTIONS,
    });
  }),
);
