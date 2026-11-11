import { applyForecastAnalyst } from '../agent/forecastAnalyst.js';
import { analyzeChartPattern } from '../analytics/chartPattern.js';
import { FORECAST_WINDOW, forecastSymbol } from '../analytics/forecast.js';
import { analyzeGeopolitics } from '../analytics/geopolitics.js';
import { summarizeEarnings } from '../analytics/news.js';
import { cache } from '../lib/cache.js';
import { HttpError } from '../lib/errors.js';
import { getForecastNews } from '../lib/newsFeed.js';
import { getFundamentals, getHistory, getNews, getQuote, getQuotes } from '../lib/yahoo.js';

/**
 * One loader for the 1-month forecast, shared by the page endpoint and the
 * grounded Q&A endpoint so a question is answered from exactly the numbers the
 * user is looking at (including the cached copy, not a fresher one).
 *
 * With `withLlm` (the default) the forecast desk reads the 21-session chart and
 * its deep pattern read, the full ranked news set (Yahoo search + RSS,
 * deduped), the earnings report, the tagged business deals and the
 * geopolitical/macro regime, then makes the day/week calls. The risers board
 * passes `withLlm: false` so a scan stays on the mechanical 1-month pattern
 * instead of firing one model call per name.
 */
export const FORECAST_TTL = 5 * 60_000;
/** Macro proxies the geopolitical read blends with the news themes. */
export const MACRO_SYMBOLS = ['^VIX', 'SPY', 'CL=F', 'GC=F', 'DX-Y.NYB'];

function macroSnapshot(quotes = []) {
  const bySymbol = new Map((Array.isArray(quotes) ? quotes : []).map((quote) => [quote.symbol, quote]));
  const pick = (symbol) => {
    const quote = bySymbol.get(symbol);
    return quote && Number.isFinite(quote.price)
      ? { price: quote.price, changePercent: Number.isFinite(quote.changePercent) ? quote.changePercent : null }
      : null;
  };
  return { vix: pick('^VIX'), spy: pick('SPY'), oil: pick('CL=F'), gold: pick('GC=F'), dollar: pick('DX-Y.NYB') };
}
export const MIN_WINDOW = 10;
export const MAX_WINDOW = 60;

export function normalizeWindowDays(value) {
  const parsed = Number(value);
  const days = Number.isFinite(parsed) ? parsed : FORECAST_WINDOW;
  return Math.min(Math.max(Math.round(days), MIN_WINDOW), MAX_WINDOW);
}

export async function getForecast(symbol, { days = FORECAST_WINDOW, refresh = false, withLlm = true } = {}) {
  const window = normalizeWindowDays(days);
  const key = `forecast:${symbol}:${window}:${withLlm ? 'llm' : 'engine'}`;
  if (refresh) {
    cache.clear(key);
    // A refresh must not re-run the desk on the bars and price the user just
    // saw; Yahoo keeps those for a while, so bust them together with the read.
    cache.clear(`history:${symbol}:6mo:1d`);
    cache.clear(`quote:${symbol}`);
  }

  return cache.wrap(key, FORECAST_TTL, async () => {
    const [quote, history] = await Promise.all([
      getQuote(symbol),
      // Six months of daily bars gives the indicators and the 1-month replay
      // enough warm-up history without a second request.
      getHistory(symbol, { range: '6mo', interval: '1d' }),
    ]);

    const spot = quote.price ?? history.bars[history.bars.length - 1]?.close;
    if (!Number.isFinite(spot)) throw new HttpError(404, `No live price available for ${symbol}`);

    const base = forecastSymbol({
      symbol,
      name: quote.name,
      quoteType: quote.quoteType,
      currency: quote.currency,
      exchange: quote.exchange,
      bars: history.bars,
      window,
      price: spot,
      change: quote.change,
      changePercent: quote.changePercent,
    });

    if (!base) {
      throw new HttpError(
        422,
        `${symbol} does not have enough daily history for a ${window}-session forecast (at least 40 sessions are needed)`,
      );
    }

    // The deep structural read is cheap and useful even for a mechanical scan.
    const forecast = { ...base, chartPattern: analyzeChartPattern(history.bars, { window }) };
    if (!withLlm) return forecast;

    // The desk sees the same 21 candles the page draws and their deep pattern
    // read, every headline the two Yahoo feeds carry (deduped and ranked), the
    // earnings report, the tagged business deals and the macro/geopolitical
    // tape; the mechanical forecast stays as the cross-check and fallback.
    const [news, fundamentals, marketHeadlines, macroQuotes] = await Promise.all([
      getForecastNews(symbol, quote.name).catch(() => null),
      getFundamentals(symbol).catch(() => null),
      getNews('^GSPC', { limit: 12 }).catch(() => []),
      getQuotes(MACRO_SYMBOLS).catch(() => []),
    ]);

    const earnings = summarizeEarnings(fundamentals);
    const geopolitics = analyzeGeopolitics({
      headlines: [...(news?.headlines || []), ...(marketHeadlines || [])],
      market: macroSnapshot(macroQuotes),
    });

    return applyForecastAnalyst({ forecast, news, earnings, geopolitics });
  });
}
