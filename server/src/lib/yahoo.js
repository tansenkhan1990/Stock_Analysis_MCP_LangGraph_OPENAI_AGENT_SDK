import YahooFinance from 'yahoo-finance2';
import { config } from '../config.js';
import { cache } from './cache.js';
import { HttpError } from './errors.js';
import { yahooGate } from './http.js';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shared concurrency gate so quotes, charts, RSS and articles never burst. */
const withSlot = yahooGate;

const isRateLimit = (error) =>
  /429|too many requests|rate limit/i.test(String(error?.message || error));

async function withRetry(fn, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await withSlot(fn);
    } catch (error) {
      lastError = error;
      if (!isRateLimit(error) || attempt === attempts - 1) break;
      await sleep(700 * 2 ** attempt + Math.random() * 400);
    }
  }
  throw lastError;
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Turn Yahoo's assorted "bad symbol" errors into a clean 404. */
function translateError(error, symbol) {
  if (error instanceof HttpError) return error;
  if (/not found|no data|delisted|validation|invalid symbol|does not exist/i.test(String(error?.message))) {
    return new HttpError(404, `No market data found for ${symbol}`);
  }
  return error;
}
const round = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : null;

function normalizeQuote(raw) {
  if (!raw || !raw.symbol) return null;
  const price = num(raw.regularMarketPrice);
  return {
    symbol: raw.symbol,
    name: raw.longName || raw.shortName || raw.symbol,
    quoteType: raw.quoteType || 'EQUITY',
    exchange: raw.fullExchangeName || raw.exchange || null,
    currency: raw.currency || 'USD',
    price,
    previousClose: num(raw.regularMarketPreviousClose),
    change: round(num(raw.regularMarketChange)),
    changePercent: round(num(raw.regularMarketChangePercent)),
    dayOpen: num(raw.regularMarketOpen),
    dayHigh: num(raw.regularMarketDayHigh),
    dayLow: num(raw.regularMarketDayLow),
    volume: num(raw.regularMarketVolume),
    averageVolume: num(raw.averageDailyVolume3Month),
    marketCap: num(raw.marketCap),
    fiftyTwoWeekHigh: num(raw.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(raw.fiftyTwoWeekLow),
    trailingPE: round(num(raw.trailingPE)),
    forwardPE: round(num(raw.forwardPE)),
    eps: round(num(raw.epsTrailingTwelveMonths)),
    priceToBook: round(num(raw.priceToBook)),
    dividendYield: num(raw.dividendYield),
    beta: round(num(raw.beta), 3),
    marketState: raw.marketState || null,
    updatedAt: raw.regularMarketTime || new Date().toISOString(),
  };
}

export async function getQuote(symbol) {
  return cache.wrap(`quote:${symbol}`, config.cache.quoteTtl, async () => {
    try {
      const raw = await withRetry(() => yf.quote(symbol));
      const quote = normalizeQuote(Array.isArray(raw) ? raw[0] : raw);
      if (!quote) throw new HttpError(404, `No market data found for ${symbol}`);
      return quote;
    } catch (error) {
      throw translateError(error, symbol);
    }
  });
}

export async function getQuotes(symbols) {
  const unique = [...new Set(symbols)];
  const missing = unique.filter((symbol) => !cache.get(`quote:${symbol}`));
  if (missing.length) {
    const batchKey = `quoteBatch:${missing.sort().join(',')}`;
    try {
      await cache.wrap(batchKey, config.cache.quoteTtl, async () => {
        const raw = await withRetry(() => yf.quote(missing));
        const list = Array.isArray(raw) ? raw : [raw];
        for (const item of list) {
          const quote = normalizeQuote(item);
          if (quote) cache.set(`quote:${quote.symbol}`, quote, config.cache.quoteTtl);
        }
        return true;
      });
    } catch {
      // Fall back to individual fetches (one bad symbol should not break the batch).
    }
  }
  const results = await Promise.allSettled(unique.map((symbol) => getQuote(symbol)));
  return results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);
}

const RANGE_DAYS = {
  '1d': 1,
  '5d': 5,
  '1mo': 31,
  '3mo': 92,
  '6mo': 183,
  '1y': 366,
  '2y': 732,
  '5y': 1827,
  '10y': 3653,
  max: 3653,
};

export async function getHistory(symbol, { range = '1y', interval = '1d' } = {}) {
  if (!RANGE_DAYS[range]) throw new HttpError(400, `Unsupported range "${range}"`);
  if (!['1m', '2m', '5m', '15m', '30m', '60m', '1d', '1wk', '1mo'].includes(interval)) {
    throw new HttpError(400, `Unsupported interval "${interval}"`);
  }

  const intraday = /m$/.test(interval);

  return cache.wrap(
    `history:${symbol}:${range}:${interval}`,
    intraday ? config.cache.intradayTtl : config.cache.historyTtl,
    async () => {
      const period1 = new Date(Date.now() - RANGE_DAYS[range] * 86_400_000);
      let raw;
      try {
        raw = await withRetry(() => yf.chart(symbol, { period1, interval }));
      } catch (error) {
        throw translateError(error, symbol);
      }
      const bars = (raw?.quotes || [])
        .filter((bar) => num(bar.close) !== null)
        .map((bar) => ({
          date: new Date(bar.date).toISOString(),
          open: num(bar.open) ?? num(bar.close),
          high: num(bar.high) ?? num(bar.close),
          low: num(bar.low) ?? num(bar.close),
          close: num(bar.close),
          adjClose: num(bar.adjclose) ?? num(bar.close),
          volume: num(bar.volume) ?? 0,
        }));

      if (!bars.length) throw new HttpError(404, `No price history found for ${symbol}`);

      return {
        symbol,
        currency: raw?.meta?.currency || 'USD',
        range,
        interval,
        bars,
      };
    },
  );
}

/**
 * Yahoo's predefined stock screener — the live market-wide universe (most
 * actives, day gainers, growth, value…). Yahoo's payload no longer matches the
 * library's schema, so validation is skipped and the raw quotes are normalised
 * through the same path as every other quote.
 */
export async function getScreener(scrId, { count = 100 } = {}) {
  return cache.wrap(`screener:${scrId}:${count}`, config.cache.quoteTtl, async () => {
    let raw;
    try {
      raw = await withRetry(() => yf.screener({ scrIds: scrId, count }, {}, { validateResult: false }));
    } catch (error) {
      throw translateError(error, `screener ${scrId}`);
    }
    const quotes = (raw?.quotes || []).map(normalizeQuote).filter((quote) => quote?.symbol && quote.price);
    for (const quote of quotes) cache.set(`quote:${quote.symbol}`, quote, config.cache.quoteTtl);
    return {
      id: scrId,
      total: num(raw?.total) ?? quotes.length,
      quotes,
      fetchedAt: new Date().toISOString(),
    };
  });
}

export async function searchSymbols(query) {
  const q = String(query || '').trim();
  if (q.length < 1) return [];
  return cache.wrap(`search:${q.toLowerCase()}`, 10 * 60_000, async () => {
    const raw = await withRetry(() => yf.search(q, { quotesCount: 10, newsCount: 0 }));
    return (raw?.quotes || [])
      .filter((item) => item.symbol && item.quoteType)
      .map((item) => ({
        symbol: item.symbol,
        name: item.longname || item.shortname || item.symbol,
        quoteType: item.quoteType,
        exchange: item.exchDisp || item.exchange || null,
      }))
      .slice(0, 10);
  });
}

export async function getNews(symbol) {
  return cache.wrap(`news:${symbol}`, 10 * 60_000, async () => {
    try {
      const raw = await withRetry(() => yf.search(symbol, { quotesCount: 0, newsCount: 6 }));
      return (raw?.news || []).map((item) => ({
        title: item.title,
        publisher: item.publisher || item.provider || 'Yahoo Finance',
        link: item.link,
        publishedAt: item.providerPublishTime
          ? new Date(item.providerPublishTime).toISOString()
          : null,
        thumbnail: item.thumbnail?.resolutions?.[0]?.url || null,
      }));
    } catch {
      return [];
    }
  });
}

export async function getFundamentals(symbol) {
  return cache.wrap(`fundamentals:${symbol}`, 6 * 60 * 60_000, async () => {
    try {
      const raw = await withRetry(() =>
        yf.quoteSummary(symbol, {
          modules: [
            'summaryDetail',
            'defaultKeyStatistics',
            'financialData',
            'assetProfile',
            'fundProfile',
            'upgradeDowngradeHistory',
            'recommendationTrend',
            'calendarEvents',
            'earningsTrend',
            'institutionOwnership',
          ],
        }),
      );
      const sd = raw.summaryDetail || {};
      const ks = raw.defaultKeyStatistics || {};
      const fd = raw.financialData || {};
      const ap = raw.assetProfile || {};
      const fp = raw.fundProfile || {};
      return {
        sector: ap.sector || fp.categoryName || null,
        industry: ap.industry || null,
        summary: ap.longBusinessSummary || null,
        trailingPE: round(num(sd.trailingPE)),
        forwardPE: round(num(sd.forwardPE)),
        priceToBook: round(num(ks.priceToBook)),
        pegRatio: round(num(ks.pegRatio)),
        enterpriseToEbitda: round(num(ks.enterpriseToEbitda)),
        profitMargin: num(fd.profitMargins),
        operatingMargin: num(fd.operatingMargins),
        revenueGrowth: num(fd.revenueGrowth),
        // Financial-data growth is the reported figure; fall back to the
        // forward estimate when Yahoo omits it. A duplicate key here used to
        // overwrite a valid value with null.
        earningsGrowth:
          num(fd.earningsGrowth) ??
          num(raw.earningsTrend?.trend?.find((item) => item.period === '0y')?.earningsEstimate?.growth) ??
          null,
        returnOnEquity: num(fd.returnOnEquity),
        totalCash: num(fd.totalCash),
        totalDebt: num(fd.totalDebt),
        debtToEquity: round(num(fd.debtToEquity)),
        beta: round(num(sd.beta), 3),
        dividendYield: num(sd.dividendYield),
        payoutRatio: num(sd.payoutRatio),
        analystTarget: round(num(fd.targetMeanPrice)),
        analystHigh: round(num(fd.targetHighPrice)),
        analystLow: round(num(fd.targetLowPrice)),
        recommendationMean: round(num(fd.recommendationMean)),
        numberOfAnalysts: num(fd.numberOfAnalystOpinions),
        totalAssets: num(sd.totalAssets),
        expenseRatio: num(fp.feesExpensesInvestment?.annualReportExpenseRatio),
        fundFamily: fp.family || null,
        ytdReturn: num(fp.fundPerformance?.ytdReturn),
        // Street activity: upgrades/downgrades, coverage mix, event dates and
        // institutional flow feed the deal/news research layer.
        analystActionsRaw: (raw.upgradeDowngradeHistory?.history || []).slice(0, 40).map((entry) => ({
          epochGradeDate: entry.epochGradeDate,
          firm: entry.firm,
          fromGrade: entry.fromGrade || null,
          toGrade: entry.toGrade || null,
          action: entry.action,
        })),
        recommendationTrend: raw.recommendationTrend?.trend?.[0]
          ? {
              strongBuy: num(raw.recommendationTrend.trend[0].strongBuy) ?? 0,
              buy: num(raw.recommendationTrend.trend[0].buy) ?? 0,
              hold: num(raw.recommendationTrend.trend[0].hold) ?? 0,
              sell: num(raw.recommendationTrend.trend[0].sell) ?? 0,
              strongSell: num(raw.recommendationTrend.trend[0].strongSell) ?? 0,
            }
          : null,
        earningsDate: raw.calendarEvents?.earnings?.earningsDate?.[0]
          ? new Date(raw.calendarEvents.earnings.earningsDate[0]).toISOString()
          : null,
        institutionTop: (raw.institutionOwnership?.ownershipList || []).slice(0, 5).map((owner) => ({
          organization: owner.organization,
          pctHeld: num(owner.pctHeld),
          pctChange: num(owner.pctChange),
          reportDate: owner.reportDate ? new Date(owner.reportDate).toISOString().slice(0, 10) : null,
        })),
      };
    } catch {
      return null;
    }
  });
}

const normalizeContract = (contract) => {
  const bid = num(contract.bid) ?? 0;
  const ask = num(contract.ask) ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : num(contract.lastPrice) ?? 0;
  return {
    contractSymbol: contract.contractSymbol,
    strike: num(contract.strike),
    lastPrice: num(contract.lastPrice),
    bid: round(bid, 2),
    ask: round(ask, 2),
    mid: round(mid, 2),
    volume: num(contract.volume) ?? 0,
    openInterest: num(contract.openInterest) ?? 0,
    impliedVolatility: num(contract.impliedVolatility),
    inTheMoney: Boolean(contract.inTheMoney),
    change: round(num(contract.change)),
    percentChange: round(num(contract.percentChange)),
  };
};

export async function getExpirations(symbol) {
  return cache.wrap(`expirations:${symbol}`, config.cache.optionsTtl, async () => {
    let raw;
    try {
      raw = await withRetry(() => yf.options(symbol));
    } catch (error) {
      throw translateError(error, symbol);
    }
    const dates = (raw?.expirationDates || [])
      .map((date) => new Date(date))
      .filter((date) => !Number.isNaN(date.getTime()))
      .map((date) => date.toISOString().slice(0, 10));
    return { symbol, expirations: dates, strikes: raw?.strikes || [] };
  });
}

export async function getOptionChain(symbol, date) {
  const key = `chain:${symbol}:${date || 'front'}`;
  return cache.wrap(key, config.cache.optionsTtl, async () => {
    const args = date ? { date } : {};
    let raw;
    try {
      raw = await withRetry(() => yf.options(symbol, args));
    } catch (error) {
      throw translateError(error, symbol);
    }
    const block = raw?.options?.[0];
    if (!block) throw new HttpError(404, `No options chain available for ${symbol}`);
    // Yahoo occasionally returns an expiry the JS Date cannot parse; a thrown
    // RangeError here would turn a usable chain into a 500.
    const expirySource = block.expirationDate || raw.expirationDates?.[0] || date;
    const expiryDate = expirySource ? new Date(expirySource) : null;
    const expiration =
      expiryDate && !Number.isNaN(expiryDate.getTime()) ? expiryDate.toISOString().slice(0, 10) : null;
    return {
      symbol,
      expiration,
      expirations: (raw.expirationDates || [])
        .map((d) => new Date(d))
        .filter((d) => !Number.isNaN(d.getTime()))
        .map((d) => d.toISOString().slice(0, 10)),
      spot: null,
      calls: (block.calls || []).map(normalizeContract).filter((c) => c.strike),
      puts: (block.puts || []).map(normalizeContract).filter((c) => c.strike),
    };
  });
}

export async function findRelatedSymbols(symbol) {
  try {
    const raw = await withRetry(() => yf.recommendationsBySymbol(symbol));
    return (raw?.recommendedSymbols || []).slice(0, 6).map((item) => item.symbol);
  } catch {
    return [];
  }
}

export const _internals = { withRetry, normalizeQuote, isRateLimit };
