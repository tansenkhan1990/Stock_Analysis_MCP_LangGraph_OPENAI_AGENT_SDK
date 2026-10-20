import { Router } from 'express';
import { MAX_UPLOAD_BYTES } from '../analytics/portfolio.js';
import { parseImageAttachment } from '../agent/vision.js';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { extractPortfolioScreenshot, parsePortfolioUpload, reviewPortfolio } from '../services/portfolioService.js';

export const portfolioRouter = Router();

function readPayload(body) {
  if (Array.isArray(body?.holdings)) {
    if (!body.holdings.length) throw badRequest('The holdings list is empty.');
    return { fileName: typeof body?.fileName === 'string' ? body.fileName : 'portfolio.json', holdings: body.holdings };
  }
  const content = typeof body?.content === 'string' ? body.content : '';
  if (!content.trim()) throw badRequest('Attach a portfolio file (CSV, TSV or JSON).');
  if (Buffer.byteLength(content, 'utf8') > MAX_UPLOAD_BYTES) {
    throw badRequest('Portfolio file is too large (max 256 KB).');
  }
  return {
    fileName: typeof body?.fileName === 'string' ? body.fileName.slice(0, 120) : 'portfolio.csv',
    content,
  };
}

function parseOrThrow(payload) {
  try {
    const parsed = parsePortfolioUpload(payload);
    if (!parsed.positions.length && !parsed.cash.length) {
      throw new Error('No positions found in that file.');
    }
    return parsed;
  } catch (error) {
    throw badRequest(error.message);
  }
}

/**
 * Fast preview for the composer: parses the file and reports what was
 * recognised without pricing anything, so a bad export is caught before the
 * user sends a request.
 */
portfolioRouter.post(
  '/extract-image',
  asyncHandler(async (req, res) => {
    const image = parseImageAttachment(req.body?.image);
    if (!image) throw badRequest('Attach a portfolio screenshot first.');
    const { parsed, model } = await extractPortfolioScreenshot(image);
    res.json({ ...parsed, model });
  }),
);

portfolioRouter.post(
  '/parse',
  asyncHandler(async (req, res) => {
    const parsed = parseOrThrow(readPayload(req.body));
    res.json({
      fileName: parsed.fileName,
      format: parsed.format,
      baseCurrency: parsed.baseCurrency,
      positions: parsed.positions,
      cash: parsed.cash,
      warnings: parsed.warnings,
      ignored: parsed.ignored,
      parsedRows: parsed.parsedRows,
    });
  }),
);

/**
 * Full review: live quotes for every line, the engine plan for the largest
 * names, and per-position exit / trim / add / hold recommendations.
 */
portfolioRouter.post(
  '/review',
  asyncHandler(async (req, res) => {
    const parsed = parseOrThrow(readPayload(req.body));
    const review = await reviewPortfolio(parsed, { refresh: req.query.refresh === '1' });
    res.json(review);
  }),
);
