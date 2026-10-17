import { cache } from '../lib/cache.js';
import { getQuotes } from '../lib/yahoo.js';

const INDICES = [
  { symbol: 'SPY', label: 'S&P 500' },
  { symbol: 'QQQ', label: 'Nasdaq 100' },
  { symbol: 'DIA', label: 'Dow 30' },
  { symbol: 'IWM', label: 'Russell 2000' },
  { symbol: '^VIX', label: 'VIX' },
  { symbol: '^TNX', label: '10Y Yield' },
];

const SECTORS = [
  { symbol: 'XLK', label: 'Technology' },
  { symbol: 'XLF', label: 'Financials' },
  { symbol: 'XLE', label: 'Energy' },
  { symbol: 'XLV', label: 'Healthcare' },
  { symbol: 'XLY', label: 'Consumer Disc.' },
  { symbol: 'XLI', label: 'Industrials' },
  { symbol: 'XLU', label: 'Utilities' },
  { symbol: 'GLD', label: 'Gold' },
  { symbol: 'TLT', label: 'Long Bonds' },
];

export async function getMarketOverview() {
  return cache.wrap('market:overview', 60_000, async () => {
    const quotes = await getQuotes([...INDICES, ...SECTORS].map((item) => item.symbol));
    const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
    const decorate = (item) => {
      const quote = bySymbol.get(item.symbol);
      return {
        ...item,
        price: quote?.price ?? null,
        change: quote?.change ?? null,
        changePercent: quote?.changePercent ?? null,
        currency: quote?.currency ?? 'USD',
        marketState: quote?.marketState ?? null,
      };
    };

    const indices = INDICES.map(decorate);
    const sectors = SECTORS.map(decorate).filter((item) => item.price !== null);
    const advancing = sectors.filter((item) => (item.changePercent ?? 0) > 0).length;
    const sorted = [...sectors].sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0));
    const vix = bySymbol.get('^VIX');

    return {
      asOf: new Date().toISOString(),
      indices,
      sectors,
      breadth: {
        advancing,
        declining: sectors.length - advancing,
        total: sectors.length,
      },
      leader: sorted[0] || null,
      laggard: sorted[sorted.length - 1] || null,
      regime:
        vix?.price === null || vix?.price === undefined
          ? 'unknown'
          : vix.price > 25
            ? 'risk-off'
            : vix.price < 15
              ? 'risk-on'
              : 'balanced',
      vix: vix?.price ?? null,
    };
  });
}
