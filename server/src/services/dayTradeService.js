import { describeProvider } from '../agent/providers.js';
import {
  buildIntradayDossier,
  decideIntradayWithLLM,
  mergeIntradayDecision,
} from '../agent/intradayDesk.js';
import { eventRisk } from '../analytics/decision.js';
import { buildDayTrade } from '../analytics/dayTrading.js';
import { config } from '../config.js';
import { cache } from '../lib/cache.js';
import { HttpError } from '../lib/errors.js';
import { getNewsDigest } from '../lib/newsFeed.js';
import { getHistory, getQuote } from '../lib/yahoo.js';
import { getAnalysis } from './analysisService.js';

export const DAY_TRADE_INTERVAL = '5m';
const HISTORY_RANGE = '5d';
const US_VENUE_RE = /nasdaq|nyse|amex|arca|bats|cboe/i;
/** The desk call is deliberately slower-moving than the 60-second bar cache. */
const DECISION_TTL = 10 * 60_000;

/**
 * The intraday model uses the US regular session (09:30–16:00 New York) and the
 * opening-range rule, so it only runs on US-listed venues. Rejecting others is
 * better than silently computing VWAP over a filtered, wrong session.
 */
export const isUsVenue = (exchange) => US_VENUE_RE.test(String(exchange || ''));

/**
 * Everything outside the 5-minute chart that a day trader should see: the daily
 * regime, fundamentals, event risk, headline flow and option positioning. Only
 * fetched when a desk call actually has to be computed.
 */
async function buildIntradayContext(symbol, trade) {
  const [analysis, news] = await Promise.all([
    getAnalysis(symbol, { withOptions: true }).catch(() => null),
    getNewsDigest(symbol, trade.name, { withContent: false }).catch(() => null),
  ]);

  const plan = analysis?.plan;
  const summary = analysis?.options?.summary;

  return {
    technical: analysis
      ? {
          score: analysis.score?.total,
          verdict: analysis.signalLabel,
          action: analysis.alert?.action ?? null,
          setupLabel: analysis.alert?.setupLabel ?? null,
          sma50: analysis.indicators?.sma50,
          sma200: analysis.indicators?.sma200,
          rsi14: analysis.indicators?.rsi14,
          adx14: analysis.indicators?.adx14,
          atrPct: analysis.indicators?.atrPct,
          annualizedVolatility: analysis.indicators?.annualizedVolatility,
          stopLoss: plan?.stopLoss,
          targets: (plan?.targets || []).map((target) => ({ label: target.label, price: target.price })),
          nearestSupport: analysis.levels?.nearestSupport ?? null,
          nearestResistance: analysis.levels?.nearestResistance ?? null,
        }
      : null,
    fundamentals: analysis?.fundamentals
      ? {
          sector: analysis.fundamentals.sector,
          trailingPE: analysis.fundamentals.trailingPE,
          forwardPE: analysis.fundamentals.forwardPE,
          analystTarget: analysis.fundamentals.analystTarget,
          recommendationMean: analysis.fundamentals.recommendationMean,
          revenueGrowth: analysis.fundamentals.revenueGrowth,
          earningsGrowth: analysis.fundamentals.earningsGrowth,
          profitMargin: analysis.fundamentals.profitMargin,
        }
      : null,
    event: analysis?.fundamentals ? eventRisk(analysis.fundamentals) : null,
    news: news
      ? {
          sentiment: news.sentiment,
          label: news.label,
          headlineCount: news.headlineCount,
          counts: news.counts,
          catalysts: news.catalysts.slice(0, 4),
          deals: news.deals.slice(0, 3),
          risks: news.risks.slice(0, 2),
          headlines: news.headlines.slice(0, 8).map((item) => ({
            title: item.title,
            direction: item.direction,
            publishedAt: item.publishedAt,
          })),
        }
      : null,
    options: summary
      ? {
          expiration: analysis.options.expiration,
          dte: summary.dte,
          atmIv: summary.atmIv,
          ivState: summary.ivState,
          expectedMovePct: summary.expectedMovePct,
          expectedLow: summary.expectedLow,
          expectedHigh: summary.expectedHigh,
          maxPain: summary.maxPain,
          pcrOi: summary.pcrOi,
          positioning: summary.positioning,
          liquidity: summary.liquidity,
        }
      : null,
  };
}

/**
 * Intraday read for one symbol. The 5-minute signal is cached for ~a minute so a
 * polling page does not hammer Yahoo; `refresh=1` clears both the signal and its
 * bar cache. When a provider is configured the LLM desk call runs on top of the
 * mechanical read and decides the headline BUY / SELL / WAIT.
 */
export async function getDayTrade(symbol, { interval = DAY_TRADE_INTERVAL, refresh = false, ai } = {}) {
  const key = `daytrade:${symbol}:${interval}`;
  if (refresh) {
    cache.clear(key);
    cache.clear(`history:${symbol}:${HISTORY_RANGE}:${interval}`);
    cache.clear(`quote:${symbol}`);
  }

  const trade = await cache.wrap(key, config.cache.intradayTtl, async () => {
    const quote = await getQuote(symbol);
    if (!isUsVenue(quote.exchange)) {
      throw new HttpError(
        422,
        `Day Trading currently supports US-listed tickers (09:30–16:00 New York). ${symbol} trades on ${quote.exchange || 'another venue'}.`,
      );
    }

    const history = await getHistory(symbol, { range: HISTORY_RANGE, interval });
    return buildDayTrade({ quote, history, interval });
  });

  const provider = describeProvider();
  // Default: use the model whenever a key is configured. `ai=0` forces the
  // mechanical read, `ai=1` asks even when auto-detection would say no.
  const explicitOff = ai === false;
  const wantAi = ai === undefined || ai === null ? provider.live : Boolean(ai);
  // An explicit opt-out stays lean — no context fetch, no note.
  if (!wantAi && explicitOff) return mergeIntradayDecision({ trade });

  const contextKey = `intradayContext:${symbol}`;
  if (refresh) cache.clear(contextKey);
  // The daily regime, news, event risk and option positioning a day trader
  // should see, independent of whether the model is answered from cache.
  const context = await cache.wrap(contextKey, 5 * 60_000, () => buildIntradayContext(symbol, trade));

  const decisionKey = `intradayDecision:${symbol}:${interval}:${trade.session?.date ?? 'na'}`;
  if (refresh) cache.clear(decisionKey);

  const cached = cache.get(decisionKey);
  if (cached) {
    return mergeIntradayDecision({
      trade,
      context,
      decision: cached.decision,
      decisionMeta: { ...cached.decisionMeta, cached: true },
      decisionError: null,
    });
  }

  const ruleMeta = { provider: 'rule-engine', model: 'MarketPilot rule engine', cached: false };

  if (!wantAi || !provider.live) {
    return mergeIntradayDecision({
      trade,
      context,
      decision: null,
      decisionMeta: ruleMeta,
      decisionError: `No LLM key configured — showing the mechanical intraday read (${provider.label}).`,
    });
  }

  try {
    const result = await decideIntradayWithLLM({
      dossier: buildIntradayDossier({ trade, context }),
      fallback: trade,
    });
    const decisionMeta = {
      provider: provider.provider,
      model: provider.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
      cached: false,
    };
    cache.set(decisionKey, { decision: result.decision, decisionMeta }, DECISION_TTL);
    return mergeIntradayDecision({ trade, context, decision: result.decision, decisionMeta, decisionError: null });
  } catch (error) {
    return mergeIntradayDecision({
      trade,
      context,
      decision: null,
      decisionMeta: ruleMeta,
      decisionError: `AI desk call failed (${error.message}) — showing the mechanical read.`,
    });
  }
}
