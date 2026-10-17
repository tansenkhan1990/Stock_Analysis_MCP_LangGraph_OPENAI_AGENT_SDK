/**
 * The MarketPilot focus universe: the high-conviction, option-tradable names
 * this app researches by default. Everything else still works — search any
 * ticker in the Analyzer — but the Focus board is built around these.
 */
export const FOCUS_STOCKS = [
  { symbol: 'NVDA', name: 'NVIDIA Corp.', theme: 'AI compute', kind: 'stock' },
  { symbol: 'MSFT', name: 'Microsoft Corp.', theme: 'Cloud + AI', kind: 'stock' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', theme: 'Cloud + retail', kind: 'stock' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', theme: 'Search + AI', kind: 'stock' },
  { symbol: 'PLTR', name: 'Palantir Technologies', theme: 'AI software', kind: 'stock' },
  { symbol: 'TSLA', name: 'Tesla Inc.', theme: 'EV + autonomy', kind: 'stock' },
  { symbol: 'AMD', name: 'Advanced Micro Devices', theme: 'AI accelerators', kind: 'stock' },
  { symbol: 'TSM', name: 'Taiwan Semiconductor', theme: 'Foundry', kind: 'stock' },
];

/** Liquid ETFs for hedging, index views and regional/Shariah exposure (options where Yahoo has a chain). */
export const FOCUS_ETFS = [
  { symbol: 'SPY', name: 'S&P 500 ETF', theme: 'US large cap', kind: 'etf' },
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF', theme: 'US growth', kind: 'etf' },
  { symbol: 'IWM', name: 'Russell 2000 ETF', theme: 'US small cap', kind: 'etf' },
  { symbol: 'SMH', name: 'Semiconductor ETF', theme: 'Semis (basket proxy)', kind: 'etf' },
  { symbol: 'TLT', name: '20Y Treasury ETF', theme: 'Rates hedge', kind: 'etf' },
  { symbol: 'GLD', name: 'Gold ETF', theme: 'Hard-asset hedge', kind: 'etf' },
  {
    symbol: 'ISDW.L',
    name: 'iShares MSCI World Islamic UCITS ETF',
    theme: 'Global developed (Shariah)',
    kind: 'etf',
  },
];

/**
 * The broad Hot Stocks universe: liquid, reputable US large caps and
 * option-tradable ETFs that are practical to trade. It is additive to the
 * focus list — the Hot Stocks page scans these plus whatever the user added.
 */
export const HOT_EXTRA_STOCKS = [
  { symbol: 'AAPL', name: 'Apple Inc.', theme: 'Consumer tech', kind: 'stock' },
  { symbol: 'META', name: 'Meta Platforms', theme: 'Social + AI', kind: 'stock' },
  { symbol: 'AVGO', name: 'Broadcom Inc.', theme: 'AI networking', kind: 'stock' },
  { symbol: 'NFLX', name: 'Netflix Inc.', theme: 'Streaming', kind: 'stock' },
  { symbol: 'CRM', name: 'Salesforce Inc.', theme: 'Enterprise software', kind: 'stock' },
  { symbol: 'ORCL', name: 'Oracle Corp.', theme: 'Cloud infrastructure', kind: 'stock' },
  { symbol: 'ADBE', name: 'Adobe Inc.', theme: 'Creative software', kind: 'stock' },
  { symbol: 'QCOM', name: 'Qualcomm Inc.', theme: 'Mobile silicon', kind: 'stock' },
  { symbol: 'MU', name: 'Micron Technology', theme: 'Memory chips', kind: 'stock' },
  { symbol: 'UBER', name: 'Uber Technologies', theme: 'Mobility platform', kind: 'stock' },
  { symbol: 'COST', name: 'Costco Wholesale', theme: 'Defensive retail', kind: 'stock' },
  { symbol: 'JPM', name: 'JPMorgan Chase', theme: 'Banks', kind: 'stock' },
  { symbol: 'V', name: 'Visa Inc.', theme: 'Payments', kind: 'stock' },
  { symbol: 'MA', name: 'Mastercard Inc.', theme: 'Payments', kind: 'stock' },
  { symbol: 'UNH', name: 'UnitedHealth Group', theme: 'Managed care', kind: 'stock' },
  { symbol: 'LLY', name: 'Eli Lilly & Co.', theme: 'Pharma / GLP-1', kind: 'stock' },
  { symbol: 'MRK', name: 'Merck & Co.', theme: 'Pharma', kind: 'stock' },
  { symbol: 'XOM', name: 'Exxon Mobil', theme: 'Energy', kind: 'stock' },
  { symbol: 'WMT', name: 'Walmart Inc.', theme: 'Defensive retail', kind: 'stock' },
  { symbol: 'HD', name: 'Home Depot', theme: 'Housing retail', kind: 'stock' },
  { symbol: 'CAT', name: 'Caterpillar Inc.', theme: 'Industrials', kind: 'stock' },
  { symbol: 'DIS', name: 'Walt Disney Co.', theme: 'Media + parks', kind: 'stock' },
];

export const HOT_EXTRA_ETFS = [
  { symbol: 'DIA', name: 'Dow Jones 30 ETF', theme: 'US blue chips', kind: 'etf' },
  { symbol: 'XLF', name: 'Financials Select SPDR', theme: 'Financials sector', kind: 'etf' },
  { symbol: 'XLE', name: 'Energy Select SPDR', theme: 'Energy sector', kind: 'etf' },
];

export const FOCUS_UNIVERSE = [...FOCUS_STOCKS, ...FOCUS_ETFS];

const dedupeBySymbol = (items) => [...new Map(items.map((item) => [item.symbol, item])).values()];

export const HOT_UNIVERSE = dedupeBySymbol([...FOCUS_UNIVERSE, ...HOT_EXTRA_STOCKS, ...HOT_EXTRA_ETFS]);

export const HOT_SYMBOLS = HOT_UNIVERSE.map((item) => item.symbol);

export const hotMeta = (symbol) =>
  HOT_UNIVERSE.find((item) => item.symbol === symbol) || { symbol, name: symbol, theme: 'Ad-hoc research', kind: 'stock' };

export const FOCUS_SYMBOLS = FOCUS_UNIVERSE.map((item) => item.symbol);

export const focusMeta = (symbol) =>
  FOCUS_UNIVERSE.find((item) => item.symbol === symbol) || {
    symbol,
    name: symbol,
    theme: 'Ad-hoc research',
    kind: 'stock',
  };

/** Default watchlist and scan universe now mirror the focus list. */
export const DEFAULT_WATCHLIST = FOCUS_UNIVERSE.map(({ symbol, name, kind }) => ({
  symbol,
  name,
  quoteType: kind === 'etf' ? 'ETF' : 'EQUITY',
}));

export const DEFAULT_SCAN_SYMBOLS = FOCUS_SYMBOLS;
