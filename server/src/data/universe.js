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

export const FOCUS_UNIVERSE = [...FOCUS_STOCKS, ...FOCUS_ETFS];

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
