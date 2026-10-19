import { createHash } from 'node:crypto';
import {
  MAX_ANALYSED_POSITIONS,
  buildPortfolioReview,
  compactPortfolioReview,
  parsePortfolioFile,
} from '../analytics/portfolio.js';
import { cache } from '../lib/cache.js';
import { getQuotes } from '../lib/yahoo.js';
import { getAnalysis } from './analysisService.js';
import { getUsdEurRate } from './fxService.js';

const REVIEW_TTL = 2 * 60_000;

/** Parse an uploaded portfolio; throws a plain Error the route maps to a 400. */
export function parsePortfolioUpload(payload = {}) {
  return parsePortfolioFile({
    fileName: typeof payload.fileName === 'string' ? payload.fileName : 'portfolio.csv',
    content: typeof payload.content === 'string' ? payload.content : undefined,
    holdings: Array.isArray(payload.holdings) ? payload.holdings : undefined,
  });
}

/** Small worker pool so a 30-name portfolio cannot burst the Yahoo gate. */
async function mapWithConcurrency(items, worker, concurrency = 3) {
  const queue = [...items];
  const results = [];
  const pool = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        results.push({ status: 'fulfilled', value: await worker(item) });
      } catch (error) {
        results.push({ status: 'rejected', reason: error });
      }
    }
  });
  await Promise.all(pool);
  return results;
}

const portfolioKey = (parsed) =>
  `portfolio:${createHash('sha1')
    .update(JSON.stringify({ positions: parsed.positions, cash: parsed.cash }))
    .digest('hex')}`;

/**
 * Price the book and run the engine on its largest lines.
 *
 * Every position is quoted. Only the largest MAX_ANALYSED_POSITIONS names get
 * the full analysis pass (history, fundamentals, news), which keeps a large
 * broker export inside provider rate limits while still covering the book's
 * actual risk — the lines that can move the portfolio.
 */
export async function reviewPortfolio(parsed, { refresh = false, emit = () => {} } = {}) {
  if (!parsed?.positions?.length && !parsed?.cash?.length) {
    throw new Error('The portfolio has no positions to review.');
  }

  const key = portfolioKey(parsed);
  if (refresh) cache.clear(key);

  return cache.wrap(key, REVIEW_TTL, async () => {
    const symbols = [...new Set(parsed.positions.map((position) => position.symbol))];

    emit({ type: 'status', message: `Pricing ${symbols.length} position${symbols.length === 1 ? '' : 's'}…` });
    const quotes = await getQuotes(symbols);
    const quoteBySymbol = Object.fromEntries(quotes.map((quote) => [quote.symbol, quote]));

    const ranked = [...parsed.positions].sort((a, b) => {
      const value = (position) =>
        Math.abs(position.quantity) * (quoteBySymbol[position.symbol]?.price ?? position.avgCost ?? 0);
      return value(b) - value(a);
    });
    const deep = ranked
      .filter((position) => quoteBySymbol[position.symbol]?.price)
      .slice(0, MAX_ANALYSED_POSITIONS)
      .map((position) => position.symbol);

    emit({
      type: 'status',
      message: `Running the engine on ${deep.length} position${deep.length === 1 ? '' : 's'}…`,
    });
    const settled = deep.length
      ? await mapWithConcurrency(
          deep,
          async (symbol) => ({ symbol, analysis: await getAnalysis(symbol, { withOptions: false }) }),
          3,
        )
      : [];
    const analyses = {};
    const analysisErrors = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') analyses[result.value.symbol] = result.value.analysis;
      else analysisErrors.push(result.reason?.message || 'Analysis failed');
    }

    const fx = await getUsdEurRate().catch(() => ({ rate: null }));

    const review = buildPortfolioReview({
      fileName: parsed.fileName,
      positions: parsed.positions,
      cash: parsed.cash,
      quotes: quoteBySymbol,
      analyses,
      fx: { eurPerUsd: fx?.rate ?? null },
      warnings: parsed.warnings || [],
      analysedSymbols: Object.keys(analyses).length,
    });

    const unpriced = review.positions.filter((row) => row.marketValue === null).map((row) => row.symbol);
    if (unpriced.length) {
      review.warnings = [
        ...review.warnings,
        `No live quote for ${unpriced.join(', ')} — check the ticker and exchange suffix.`,
      ];
    }
    if (analysisErrors.length) {
      review.warnings = [...review.warnings, `${analysisErrors.length} engine pass(es) failed; those lines use quotes only.`];
    }

    return review;
  });
}

/** Parse + review in one call (API routes and scripted checks). */
export async function reviewPortfolioUpload(payload, options = {}) {
  const parsed = parsePortfolioUpload(payload);
  const review = await reviewPortfolio(parsed, options);
  return { parsed, review };
}

export { compactPortfolioReview };
