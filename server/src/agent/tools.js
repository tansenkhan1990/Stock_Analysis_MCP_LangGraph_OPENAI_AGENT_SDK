import { archiveTrend, buildArchivePrompt } from '../analytics/history.js';
import { annualizedVolatility } from '../analytics/indicators.js';
import { evaluateStrategy, summarizeChain } from '../analytics/options.js';
import { HttpError } from '../lib/errors.js';
import {
  getExpirations,
  getHistory,
  getNews,
  getOptionChain,
  getQuote,
  searchSymbols,
} from '../lib/yahoo.js';
import { getAnalysis, getFocusBoard, getMarketOverview, getResearch, pickExpiration } from '../services/index.js';
import { getMarketHistory } from '../services/marketHistoryService.js';

const compactPlan = (analysis) => ({
  symbol: analysis.symbol,
  name: analysis.name,
  quoteType: analysis.quoteType,
  asOf: analysis.generatedAt,
  price: analysis.price,
  change: analysis.change,
  changePercent: analysis.changePercent,
  action: analysis.alert?.action ?? null,
  actionLabel: analysis.alert?.actionLabel ?? null,
  setupLabel: analysis.alert?.setupLabel ?? null,
  verdict: { signal: analysis.signal, label: analysis.signalLabel, score: analysis.score.total, confidence: analysis.score.confidence },
  scoreBreakdown: analysis.score.components.map((component) => ({
    area: component.label,
    score: Math.round(component.score),
    weight: component.weight,
  })),
  plan: {
    direction: analysis.plan.direction,
    buyZone: analysis.plan.buyZone,
    shortZone: analysis.plan.shortZone,
    targets: analysis.plan.targets,
    stopLoss: analysis.plan.stopLoss,
    riskReward: analysis.plan.riskReward,
    horizon: analysis.plan.horizon,
    invalidation: analysis.plan.invalidation,
  },
  keyLevels: analysis.levels,
  indicators: analysis.indicators,
  performance: analysis.performance,
  rationale: analysis.rationale,
  risks: analysis.risks,
  checklist: analysis.checklist,
  fundamentals: analysis.fundamentals
    ? {
        sector: analysis.fundamentals.sector,
        trailingPE: analysis.fundamentals.trailingPE,
        forwardPE: analysis.fundamentals.forwardPE,
        pegRatio: analysis.fundamentals.pegRatio,
        profitMargin: analysis.fundamentals.profitMargin,
        revenueGrowth: analysis.fundamentals.revenueGrowth,
        analystTarget: analysis.fundamentals.analystTarget,
        recommendationMean: analysis.fundamentals.recommendationMean,
      }
    : null,
  options: analysis.options?.summary
    ? {
        summary: analysis.options.summary,
        plans: (analysis.options.plans || []).map((plan) => ({
          name: plan.name,
          thesis: plan.thesis,
          expiration: plan.expiration,
          dte: plan.dte,
          legs: plan.legs.map((leg) => ({ kind: leg.kind, action: leg.action, strike: leg.strike, premium: leg.premium })),
          maxProfit: plan.metrics.maxProfit,
          maxLoss: plan.metrics.maxLoss,
          breakevens: plan.metrics.breakevens,
          probabilityOfProfit: plan.metrics.probabilityOfProfit,
          greeks: plan.metrics.greeks,
        })),
      }
    : null,
});

const analysisCache = new Map();

async function cachedAnalysis(symbol) {
  const key = symbol;
  const hit = analysisCache.get(key);
  if (hit && Date.now() - hit.time < 90_000) return hit.value;
  const value = await getAnalysis(symbol, { withOptions: true });
  analysisCache.set(key, { time: Date.now(), value });
  return value;
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_full_analysis',
      description:
        'Run the full MarketPilot engine on a ticker: score, verdict, buy/sell zone, price targets, stop loss, technicals, fundamentals and option ideas. Use this for any "should I buy/sell/analyze" question.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Ticker, e.g. AAPL or QQQ' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_quote',
      description: 'Get the latest price, change, volume, 52-week range and valuation snapshot for a ticker.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_price_history',
      description: 'Get recent OHLC bars and performance stats for a ticker.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          range: { type: 'string', enum: ['1mo', '3mo', '6mo', '1y', '2y'] },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_option_chain',
      description:
        'Get the option chain summary (ATM IV, expected move, max pain, put/call ratio) plus liquid calls and puts near the money.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          expiration: { type: 'string', description: 'YYYY-MM-DD; omit for the ~35 day expiry' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_research_digest',
      description:
        'Deep research digest: technical plan, Yahoo news sentiment with business deals, analyst upgrades/downgrades, earnings event risk, and the rule-engine call. Use this for any "should I buy/sell given the news" question.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', description: 'Ticker, e.g. NVDA' } },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_focus_board',
      description:
        "Ranked buy/sell signal board for the user's focus list (seeded with AI mega-caps NVDA, MSFT, AMZN, GOOGL, PLTR, TSLA, AMD, TSM; ETFs SPY, QQQ, IWM, SMH, TLT, GLD; and ISDW.L — the user can add or remove any stock or ETF), combining technicals, news flow, deals and Street activity.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_market_history',
      description:
        "The archived daily Yahoo Finance snapshots for a ticker (MongoDB): quality-score trend, buy/sell call history and streak, stop/target drift, archived news sentiment, and whether the previous calls actually followed through. Use it alongside live data for any 'is this still working / has the call changed / how has it behaved' question, and to sanity-check a fresh call against its own history.",
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Ticker, e.g. NVDA' },
          days: { type: 'number', description: 'Look-back window in sessions (default 60, max 400)' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_portfolio_review',
      description:
        "The user's uploaded portfolio, already priced against live quotes and the engine: position sizes, weights, unrealized P/L, the engine call, stop, targets, concentration and a computed exit / trim / add / hold recommendation for every line. Use this whenever the question involves the user's holdings, allocation, risk, rebalancing or what to sell.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_news',
      description: 'Recent Yahoo Finance headlines for a ticker.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_symbols',
      description: 'Score and compare 2–4 tickers side by side, including targets and risk/reward.',
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
        },
        required: ['symbols'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_symbol',
      description: 'Resolve a company name or partial ticker to a tradable symbol.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_market_overview',
      description: 'Current index levels, VIX, Treasury yield, sector breadth and market regime.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'evaluate_options_strategy',
      description:
        'Evaluate a user-defined option strategy. Returns net debit/credit, max profit/loss, breakevens, probability of profit and greeks.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          iv: { type: 'number', description: 'Implied volatility as a decimal, e.g. 0.32' },
          dte: { type: 'number', description: 'Days to expiration' },
          legs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['call', 'put', 'stock'] },
                action: { type: 'string', enum: ['buy', 'sell'] },
                strike: { type: 'number' },
                premium: { type: 'number' },
                qty: { type: 'number' },
              },
              required: ['kind', 'action'],
            },
          },
        },
        required: ['symbol', 'legs'],
      },
    },
  },
];

const requireSymbol = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'A ticker symbol is required');
  return value.trim().toUpperCase();
};

async function optionChainTool({ symbol, expiration }) {
  const ticker = requireSymbol(symbol);
  const [quote, expiryInfo, history] = await Promise.all([
    getQuote(ticker),
    getExpirations(ticker),
    getHistory(ticker, { range: '3mo', interval: '1d' }).catch(() => null),
  ]);
  // The tool contract says "omit for the ~35 day expiry"; the nearest listed
  // expiry is often 0–2 DTE, which is a different (and far riskier) trade.
  const expiry = expiration || pickExpiration(expiryInfo.expirations) || expiryInfo.expirations[0];
  const chain = await getOptionChain(ticker, expiry);
  const spot = quote.price;
  const realizedVol = history ? annualizedVolatility(history.bars.map((bar) => bar.close), 20) : null;
  const summary = summarizeChain({ calls: chain.calls, puts: chain.puts, spot, expiration: expiry, realizedVol });

  const near = (contracts) =>
    [...contracts]
      .filter((contract) => Math.abs(contract.strike - spot) / spot < 0.09)
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
      .slice(0, 6)
      .sort((a, b) => a.strike - b.strike)
      .map(({ strike, bid, ask, mid, impliedVolatility, openInterest, volume, inTheMoney }) => ({
        strike,
        bid,
        ask,
        mid,
        iv: impliedVolatility ? Number((impliedVolatility * 100).toFixed(1)) : null,
        openInterest,
        volume,
        inTheMoney,
      }));

  return {
    symbol: ticker,
    spot,
    expiration: expiry,
    expirations: expiryInfo.expirations.slice(0, 8),
    summary,
    calls: near(chain.calls),
    puts: near(chain.puts),
  };
}

export async function executeTool(name, args = {}, context = {}) {
  switch (name) {
    case 'get_full_analysis': {
      const symbol = requireSymbol(args.symbol);
      const analysis = await cachedAnalysis(symbol);
      // Live plan plus what our own daily snapshots say about it.
      const history = await getMarketHistory(symbol, { days: 60 }).catch(() => null);
      return {
        ...compactPlan(analysis),
        archive: history ? archiveTrend(history, { action: analysis.alert?.action ?? null }) : null,
        archiveSummary: history
          ? {
              coverageDays: history.coverageDays,
              firstDate: history.firstDate,
              lastDate: history.lastDate,
              scoreTrend: history.score?.trend ?? null,
              scoreDelta5: history.score?.delta5 ?? null,
              actionStreak: history.action?.streak ?? null,
              actionStreakSince: history.action?.streakSince ?? null,
              previousHits: history.followThrough?.hitRate ?? null,
              previousSamples: history.followThrough?.samples ?? null,
              sentimentTrend: history.sentiment?.trend ?? null,
            }
          : null,
      };
    }
    case 'get_quote': {
      const quote = await getQuote(requireSymbol(args.symbol));
      return quote;
    }
    case 'get_price_history': {
      const symbol = requireSymbol(args.symbol);
      const history = await getHistory(symbol, { range: args.range || '6mo', interval: '1d' });
      const closes = history.bars.map((bar) => bar.close);
      return {
        symbol,
        range: history.range,
        bars: history.bars.slice(-15),
        high: Math.max(...closes),
        low: Math.min(...closes),
        performance: {
          week: closes.length > 5 ? Number((((closes.at(-1) - closes.at(-6)) / closes.at(-6)) * 100).toFixed(2)) : null,
          month: closes.length > 21 ? Number((((closes.at(-1) - closes.at(-22)) / closes.at(-22)) * 100).toFixed(2)) : null,
          quarter: closes.length > 63 ? Number((((closes.at(-1) - closes.at(-64)) / closes.at(-64)) * 100).toFixed(2)) : null,
        },
      };
    }
    case 'get_option_chain':
      return optionChainTool(args);
    case 'get_news': {
      const news = await getNews(requireSymbol(args.symbol));
      return { symbol: args.symbol.toUpperCase(), news };
    }
    case 'get_market_history': {
      const symbol = requireSymbol(args.symbol);
      const days = Math.min(Math.max(Number(args.days) || 60, 1), 400);
      const history = await getMarketHistory(symbol, { days });
      if (!history) {
        throw new HttpError(404, `No archived snapshots for ${symbol} yet — the daily archive has not captured it`);
      }
      const { series: _scoreSeries, snapshots, ...summary } = history;
      return {
        symbol,
        days: history.coverageDays,
        brief: buildArchivePrompt({ symbol, history }),
        summary,
        snapshots,
      };
    }
    case 'get_portfolio_review': {
      if (!context.portfolio) {
        throw new HttpError(
          400,
          'No portfolio is attached to this chat. Ask the user to upload a holdings CSV, TSV or JSON file.',
        );
      }
      return context.portfolio;
    }
    case 'get_research_digest': {
      const research = await getResearch(requireSymbol(args.symbol), { ai: false });
      const { technical, news, analyst, event, combined, options, fundamentals, decision } = research;
      return {
        symbol: research.symbol,
        name: research.meta?.name,
        price: research.quote.price,
        changePercent: research.quote.changePercent,
        technical: {
          score: technical.score,
          verdict: technical.signalLabel,
          confidence: technical.confidence,
          direction: technical.direction,
          entry: technical.entryRef,
          buyZone: technical.buyZone,
          shortZone: technical.shortZone,
          targets: technical.targets,
          stopLoss: technical.stopLoss,
          riskReward: technical.riskReward,
          horizon: technical.horizon,
          invalidation: technical.invalidation,
          checklist: technical.checklist,
          risks: technical.risks,
          rationale: technical.rationale,
          indicators: technical.indicators,
          performance: technical.performance,
        },
        news: news
          ? {
              sentiment: news.sentiment,
              label: news.label,
              counts: news.counts,
              catalysts: news.catalysts,
              deals: news.deals,
              bearishItems: news.risks,
              headlines: news.headlines.slice(0, 8),
              articleExcerpts: (news.excerpts || []).map((item) => ({
                title: item.title,
                text: item.content.slice(0, 900),
              })),
            }
          : null,
        analyst,
        event,
        fundamentals,
        combined,
        ruleEngineCall: decision,
        archive: research.marketHistory
          ? {
              coverageDays: research.marketHistory.coverageDays,
              firstDate: research.marketHistory.firstDate,
              lastDate: research.marketHistory.lastDate,
              scoreTrend: research.marketHistory.score?.trend ?? null,
              scoreDelta5: research.marketHistory.score?.delta5 ?? null,
              actionStreak: research.marketHistory.action?.streak ?? null,
              actionStreakSince: research.marketHistory.action?.streakSince ?? null,
              previousHits: research.marketHistory.followThrough?.hitRate ?? null,
              previousSamples: research.marketHistory.followThrough?.samples ?? null,
              sentimentTrend: research.marketHistory.sentiment?.trend ?? null,
              brief: buildArchivePrompt({ symbol: research.symbol, history: research.marketHistory }),
            }
          : null,
        options: options?.summary
          ? { summary: options.summary, plans: options.plans.map((plan) => ({ name: plan.name, legs: plan.legs, metrics: plan.metrics })) }
          : null,
        note: 'combinedSignal and ruleEngineCall are the deterministic reference call; form your own view using every stream above.',
      };
    }
    case 'get_focus_board': {
      const board = await getFocusBoard();
      return {
        generatedAt: board.generatedAt,
        counts: board.counts,
        averageNewsSentiment: board.averageNewsSentiment,
        signals: board.signals.map((row) => ({
          symbol: row.symbol,
          name: row.name,
          theme: row.theme,
          price: row.price,
          action: row.decision.action,
          setupLabel: row.decision.setupLabel,
          alertReason: row.decision.alert?.reason ?? null,
          conviction: row.decision.conviction,
          combinedScore: row.decision.score,
          technicalScore: row.technical.score,
          technicalVerdict: row.technical.signalLabel,
          newsSentiment: row.news?.sentiment ?? null,
          deals: row.news?.dealCount ?? 0,
          streetTilt: row.analyst?.tilt ?? 0,
          event: row.event?.label ?? null,
          targets: row.technical.targets?.map((target) => target.price) ?? [],
          stopLoss: row.technical.stopLoss,
          topCatalyst: row.news?.catalysts?.[0]?.title ?? null,
        })),
        note: 'Actions come from the regime alert (trend + RSI rule with news/earnings guardrails); combinedScore is quality/context, not the action.',
      };
    }
    case 'compare_symbols': {
      const symbols = Array.isArray(args.symbols) ? args.symbols.slice(0, 4).map(requireSymbol) : [];
      if (symbols.length < 2) throw new HttpError(400, 'Provide at least two symbols to compare');
      const analyses = await Promise.all(
        symbols.map(async (symbol) => {
          const analysis = await getAnalysis(symbol, { withOptions: false });
          return {
            symbol,
            name: analysis.name,
            price: analysis.price,
            action: analysis.alert?.actionLabel ?? null,
            setup: analysis.alert?.setupLabel ?? null,
            qualityLabel: analysis.signalLabel,
            score: analysis.score.total,
            confidence: analysis.score.confidence,
            monthReturn: analysis.performance.month,
            quarterReturn: analysis.performance.quarter,
            relativeStrength: analysis.performance.relativeStrength,
            buyZone: analysis.plan.buyZone,
            targets: analysis.plan.targets.map((target) => target.price),
            stopLoss: analysis.plan.stopLoss,
            riskReward: analysis.plan.riskReward,
            rsi: analysis.indicators.rsi14,
            trend: analysis.indicators.sma200
              ? analysis.price > analysis.indicators.sma200
                ? 'above 200-day'
                : 'below 200-day'
              : null,
          };
        }),
      );
      const ranked = [...analyses].sort((a, b) => b.score - a.score);
      return { comparison: analyses, best: ranked[0], worst: ranked[ranked.length - 1] };
    }
    case 'search_symbol': {
      const results = await searchSymbols(args.query);
      return { query: args.query, results };
    }
    case 'get_market_overview':
      return getMarketOverview();
    case 'evaluate_options_strategy': {
      const symbol = requireSymbol(args.symbol);
      const quote = await getQuote(symbol);
      if (!Number.isFinite(quote.price) || quote.price <= 0) {
        throw new HttpError(404, `No live price available for ${symbol}`);
      }
      const legs = (args.legs || [])
        .filter((leg) => ['call', 'put', 'stock'].includes(leg?.kind) && ['buy', 'sell'].includes(leg?.action))
        .map((leg) => ({
          kind: leg.kind,
          action: leg.action,
          strike: Number(leg.strike) || quote.price,
          premium: Math.max(0, Number(leg.premium) || 0),
          qty: Math.max(1, Number(leg.qty) || 1),
        }));
      if (!legs.length) throw new HttpError(400, 'At least one valid option leg is required');
      const metrics = evaluateStrategy(legs, quote.price, {
        iv: Number(args.iv) || 0.3,
        dte: Number(args.dte) || 30,
      });
      if (!metrics) throw new HttpError(400, 'Could not evaluate those legs');
      const { curve, ...rest } = metrics;
      return { symbol, spot: quote.price, legs, ...rest };
    }
    default:
      throw new HttpError(400, `Unknown tool "${name}"`);
  }
}

export const TOOL_SUMMARY = {
  get_full_analysis: (result) => `${result.symbol}: score ${result.verdict.score}/100 · ${result.verdict.label} · targets ${result.plan?.targets?.map((t) => `$${t.price}`).join(' / ') || 'n/a'}`,
  get_quote: (result) => `${result.symbol} $${result.price} (${result.changePercent ?? 0}%)`,
  get_price_history: (result) => `${result.symbol}: ${result.bars.length} bars, range $${result.low}–$${result.high}`,
  get_option_chain: (result) =>
    `${result.symbol} ${result.expiration}: ATM IV ${result.summary?.atmIv ?? '—'}% · max pain $${result.summary?.maxPain ?? '—'}`,
  get_news: (result) => `${result.news?.length || 0} recent headlines`,
  get_market_history: (result) =>
    `${result.symbol}: ${result.days} archived session${result.days === 1 ? '' : 's'} · ${result.summary?.action?.latestLabel ?? '—'} (${result.summary?.action?.streak ?? 0} session${result.summary?.action?.streak === 1 ? '' : 's'}) · score trend ${result.summary?.score?.trend ?? '—'}`,
  get_portfolio_review: (result) =>
    `${result.totals?.positions ?? 0} positions · ${result.counts?.exit ?? 0} exit / ${result.counts?.trim ?? 0} trim · ${result.totals?.cashPct ?? 0}% cash`,
  get_research_digest: (result) =>
    `${result.symbol}: ${result.ruleEngineCall?.actionLabel} (${result.ruleEngineCall?.setupLabel ?? 'no setup'}, quality ${result.combined?.score}/100) · news ${result.news?.sentiment ?? 0} (${result.news?.deals?.length || 0} deals) · street tilt ${result.analyst?.tilt ?? 0}`,
  get_focus_board: (result) =>
    `${result.counts.buy} buy / ${result.counts.accumulate} accumulate / ${result.counts.hold} hold · avg news sentiment ${result.averageNewsSentiment}`,
  compare_symbols: (result) => `Compared ${result.comparison.length} tickers · best: ${result.best?.symbol}`,
  search_symbol: (result) => `${result.results?.length || 0} matches`,
  get_market_overview: (result) => `${result.regime} · VIX ${result.vix ?? '—'} · ${result.breadth.advancing}/${result.breadth.total} sectors green`,
  evaluate_options_strategy: (result) => `Max profit $${result.maxProfit} · max loss $${result.maxLoss} · PoP ${result.probabilityOfProfit ?? '—'}%`,
};
