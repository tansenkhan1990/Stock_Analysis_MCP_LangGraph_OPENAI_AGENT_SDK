import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS, executeTool } from '../src/agent/tools.js';
import {
  MAX_POSITION_WEIGHT,
  buildPortfolioReview,
  compactPortfolioReview,
  parseNumber,
  portfolioContextBlock,
  parsePortfolioFile,
  parsePortfolioText,
  portfolioPromptLine,
} from '../src/analytics/portfolio.js';

const csv = `Account,ISA
As of,2026-10-17

Ticker,Name,Quantity,Average cost,Currency,Type
AAPL_US_EQ,Apple Inc.,10,180.50,USD,EQUITY
MSFT,Microsoft,5,"400,25",USD,EQUITY
CASH,Cash,1250.75,,USD,CASH
`;

test('parseNumber reads US, UK and continental formats without guessing signs', () => {
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('"400,25"'), 400.25);
  assert.equal(parseNumber('(1,000.50)'), -1000.5);
  assert.equal(parseNumber('$12,500'), 12500);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('n/a'), null);
});

test('parses a broker export with preamble, aliases, cash and quoted decimals', () => {
  const parsed = parsePortfolioText(csv, { fileName: 'isa.csv' });
  assert.equal(parsed.positions.length, 2);
  assert.equal(parsed.cash.length, 1);
  assert.equal(parsed.cash[0].value, 1250.75);
  assert.equal(parsed.format, 'csv');

  const apple = parsed.positions.find((position) => position.symbol === 'AAPL');
  assert.equal(apple.symbol, 'AAPL', 'Trading212 _US_EQ suffix is stripped');
  assert.equal(apple.quantity, 10);
  assert.equal(apple.avgCost, 180.5);

  const microsoft = parsed.positions.find((position) => position.symbol === 'MSFT');
  assert.equal(microsoft.avgCost, 400.25, 'decimal comma is read as a decimal, not thousands');
});

test('merges duplicate lots at a quantity-weighted average cost', () => {
  const parsed = parsePortfolioText(`Ticker,Qty,Avg price
AAPL,10,100
AAPL,5,200
`);
  assert.equal(parsed.positions.length, 1);
  assert.equal(parsed.positions[0].quantity, 15);
  assert.equal(parsed.positions[0].avgCost, 133.333333);
  assert.ok(parsed.warnings.some((warning) => /merged/i.test(warning)));
});

test('derives per-share cost from a total cost-basis column', () => {
  const parsed = parsePortfolioText(`Symbol,Shares,Cost Basis
NVDA,4,1000
`);
  assert.equal(parsed.positions[0].avgCost, 250);
});

test('semicolon and tab exports are detected, not assumed comma', () => {
  const semicolon = parsePortfolioText('Ticker;Quantity;Avg price\nSPY;3;500\n');
  assert.equal(semicolon.format, 'csv');
  assert.equal(semicolon.positions[0].symbol, 'SPY');

  const tab = parsePortfolioText('Ticker\tQuantity\tAvg price\nQQQ\t2\t400\n');
  assert.equal(tab.format, 'tsv');
  assert.equal(tab.positions[0].quantity, 2);
});

test('bad rows are skipped with reasons, totals rows are ignored, valid rows survive', () => {
  const parsed = parsePortfolioText(`Ticker,Quantity,Avg price
AAPL,10,100
TOTAL,,1000
???,5,10
MSFT,not-a-number,400
TSLA,2,200
`);
  assert.deepEqual(
    parsed.positions.map((position) => position.symbol),
    ['AAPL', 'TSLA'],
  );
  assert.equal(parsed.ignored.length, 2);
  assert.ok(parsed.warnings.some((warning) => /could not be read/i.test(warning)));
});

test('a file without a ticker/quantity table is rejected with a useful message', () => {
  assert.throws(() => parsePortfolioText('hello,world\n1,2\n'), /holdings table/i);
  assert.throws(() => parsePortfolioText(''), /empty/i);
});

test('JSON holdings use the same aliases and validation', () => {
  const parsed = parsePortfolioFile({
    fileName: 'book.json',
    holdings: [
      { ticker: 'nvda', shares: 3, averageCost: 100 },
      { symbol: 'MSFT', qty: 2, costBasis: 800 },
    ],
  });
  assert.equal(parsed.format, 'json');
  assert.equal(parsed.positions.length, 2);
  assert.equal(parsed.positions.find((position) => position.symbol === 'NVDA').quantity, 3);
  assert.equal(parsed.positions.find((position) => position.symbol === 'MSFT').avgCost, 400);
});

const quote = (symbol, price, changePercent = 1, quoteType = 'EQUITY') => ({
  symbol,
  name: `${symbol} Inc.`,
  price,
  changePercent,
  change: price * (changePercent / 100),
  quoteType,
  currency: 'USD',
});

const analysis = ({ action = 'hold', stopLoss = null, direction = 'long', targets = [], zone = null, sector = 'Technology', score = 60 }) => ({
  score: { total: score },
  alert: { action, actionLabel: action[0].toUpperCase() + action.slice(1), setupLabel: 'test setup' },
  plan: {
    direction,
    stopLoss,
    targets: targets.map((price, index) => ({ label: `T${index + 1}`, price, upsidePct: 5, probability: 55 })),
    buyZone: zone,
  },
  fundamentals: { sector },
});

const book = () =>
  buildPortfolioReview({
    fileName: 'book.csv',
    positions: [
      { symbol: 'AAPL', name: 'Apple', quantity: 100, avgCost: 150, currency: 'USD' },
      { symbol: 'MSFT', name: 'Microsoft', quantity: 10, avgCost: 400, currency: 'USD' },
      { symbol: 'GOOGL', name: 'Alphabet', quantity: 1, avgCost: 90, currency: 'USD' },
      { symbol: 'PLTR', name: 'Palantir', quantity: 5, avgCost: 20, currency: 'USD' },
      { symbol: 'NOPE', name: 'Missing', quantity: 2, avgCost: 10, currency: 'USD' },
    ],
    cash: [{ currency: 'USD', value: 5000 }],
    quotes: {
      AAPL: quote('AAPL', 200, 2),
      MSFT: quote('MSFT', 300, -1),
      GOOGL: quote('GOOGL', 100, 0.5),
      PLTR: quote('PLTR', 35, 3),
    },
    analyses: {
      AAPL: analysis({ action: 'hold', stopLoss: 190, targets: [220, 240], sector: 'Technology' }),
      MSFT: analysis({ action: 'hold', stopLoss: 310, targets: [280], sector: 'Technology' }),
      GOOGL: analysis({
        action: 'buy',
        stopLoss: 92,
        targets: [115],
        zone: { low: 92, high: 96 },
        sector: 'Communication Services',
      }),
      PLTR: analysis({
        action: 'accumulate',
        stopLoss: 30,
        targets: [42],
        zone: { low: 30, high: 33 },
        sector: 'Technology',
      }),
      NOPE: null,
    },
  });

test('review totals, weights and P/L are measured from live prices and cash', () => {
  const review = book();
  assert.equal(review.totals.totalValue, 20000 + 3000 + 100 + 175 + 5000);
  assert.equal(review.totals.grossInvested, 23275);
  assert.equal(review.totals.cash, 5000);
  assert.equal(review.totals.cashPct, 17.68);
  assert.equal(review.totals.unrealizedPnl, 5000 - 1000 + 10 + 75);

  const apple = review.positions.find((position) => position.symbol === 'AAPL');
  assert.equal(apple.marketValue, 20000);
  assert.equal(apple.unrealizedPnl, 5000);
  assert.equal(apple.unrealizedPnlPct, 33.33);
  assert.equal(apple.weightPct, 70.73);
});

test('risk comes before size and the call: stops exit, oversize trims, sells exit', () => {
  const review = book();
  const bySymbol = Object.fromEntries(review.positions.map((position) => [position.symbol, position]));

  assert.equal(bySymbol.MSFT.recommendation, 'exit', 'price below the plan stop');
  assert.equal(bySymbol.MSFT.stopBreached, true);
  assert.equal(bySymbol.MSFT.trimShares, 10);

  assert.equal(bySymbol.AAPL.recommendation, 'trim', '70% of the book breaches the 20% cap');
  assert.ok(bySymbol.AAPL.weightPct > MAX_POSITION_WEIGHT * 100);
  assert.ok(bySymbol.AAPL.trimShares > 0 && bySymbol.AAPL.trimShares < 100);

  const googl = bySymbol.GOOGL;
  assert.equal(googl.recommendation, 'add', 'buy call, small weight, price within 5% of the zone');
  assert.equal(bySymbol.PLTR.recommendation, 'hold', 'price is over 5% above the buy zone — do not chase');

  assert.ok(review.flags.some((flag) => flag.code === 'stop-breach'));
  assert.ok(review.flags.some((flag) => flag.code === 'concentration'));
  assert.ok(review.flags.some((flag) => flag.code === 'sector-concentration'));
  assert.ok(review.flags.some((flag) => flag.code === 'unpriced'));
  assert.equal(review.counts.exit, 1);
  assert.equal(review.counts.trim, 1);
});

test('a Sell call is an exit even when the stop has not been hit yet', () => {
  const review = buildPortfolioReview({
    positions: [{ symbol: 'TLT', quantity: 10, avgCost: 100, currency: 'USD' }],
    quotes: { TLT: quote('TLT', 88) },
    analyses: { TLT: analysis({ action: 'sell', stopLoss: 95, direction: 'short', targets: [80] }) },
  });
  const row = review.positions[0];
  assert.equal(row.recommendation, 'exit');
  assert.match(row.recommendationReason, /risk exit|trend break/i);
});

test('a short position is never told to add and exits when the call turns bullish', () => {
  const review = buildPortfolioReview({
    positions: [{ symbol: 'TSLA', quantity: -20, avgCost: 300, currency: 'USD' }],
    quotes: { TSLA: quote('TSLA', 250) },
    analyses: { TSLA: analysis({ action: 'buy', stopLoss: 240, targets: [290], zone: { low: 240, high: 255 } }) },
    cash: [{ currency: 'USD', value: 1000 }],
  });
  const row = review.positions[0];
  assert.equal(row.marketValue, -5000, 'short market value is negative');
  assert.equal(row.recommendation, 'exit');
  assert.match(row.recommendationReason, /short position/i);
  assert.notEqual(row.recommendation, 'add');
});

test('derivatives are not judged with equity stops and are sent to manual review', () => {
  const review = buildPortfolioReview({
    positions: [{ symbol: 'AAPL260116C00200000', quantity: 2, avgCost: 8, currency: 'USD' }],
    quotes: { 'AAPL260116C00200000': { ...quote('AAPL260116C00200000', 12), quoteType: 'OPTION' } },
    analyses: {},
  });
  const row = review.positions[0];
  assert.equal(row.recommendation, 'review');
  assert.match(row.recommendationReason, /not a stock or ETF/i);
  assert.ok(row.flags.some((flag) => flag.code === 'instrument'));
});

test('file names cannot carry a path into the app', () => {
  const parsed = parsePortfolioFile({ fileName: '../../etc/passwd', content: 'Ticker,Qty\nAAPL,1\n' });
  assert.equal(parsed.fileName, 'passwd');
});

test('unpriced and unsupported-currency lines stay out of the totals', () => {
  const review = buildPortfolioReview({
    positions: [
      { symbol: 'AAPL', quantity: 10, avgCost: 100, currency: 'USD' },
      { symbol: 'VOD.L', quantity: 100, avgCost: 1, currency: 'GBP' },
    ],
    quotes: {
      AAPL: quote('AAPL', 200),
      'VOD.L': { ...quote('VOD.L', 1.2), currency: 'GBP' },
    },
    analyses: { AAPL: analysis({ stopLoss: 150 }) },
  });
  assert.equal(review.totals.totalValue, 2000, 'GBP line is not silently added as USD');
  const vod = review.positions.find((position) => position.symbol === 'VOD.L');
  assert.equal(vod.marketValue, null);
  assert.equal(vod.recommendation, 'review');
  assert.ok(vod.flags.some((flag) => flag.code === 'currency'));
});

test('EUR lines convert with the supplied FX rate', () => {
  const review = buildPortfolioReview({
    positions: [{ symbol: 'SAP', quantity: 2, avgCost: 100, currency: 'EUR' }],
    quotes: { SAP: { ...quote('SAP', 200), currency: 'EUR' } },
    analyses: { SAP: analysis({ stopLoss: 150 }) },
    fx: { eurPerUsd: 0.5 },
  });
  assert.equal(review.totals.totalValue, 800, '€400 at 0.5 EUR per USD = $800');
  assert.equal(review.positions[0].marketValue, 800);
  assert.equal(review.positions[0].netWeightPct, 100);
});

test('the agent tool exposes the attached book and refuses to invent one', async () => {
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === 'get_portfolio_review'));
  const portfolio = { totals: { positions: 2, cashPct: 5 }, counts: { exit: 1, trim: 0 } };
  assert.equal(await executeTool('get_portfolio_review', {}, { portfolio }), portfolio);
  await assert.rejects(() => executeTool('get_portfolio_review', {}, {}), /No portfolio is attached/i);
});

test('the agent payload is compact and the prompt line names real facts', () => {
  const review = book();
  const compact = compactPortfolioReview(review);
  assert.equal(compact.positions.length, review.positions.length);
  assert.ok(compact.positions[0].reason);
  assert.ok(!('rawMarketValue' in compact.positions[0]));

  const line = portfolioPromptLine(review);
  assert.match(line, /5 positions/);
  assert.match(line, /1 exit, 1 trim/);
  assert.match(line, /cash/);

  const context = portfolioContextBlock(review);
  assert.match(context, /- AAPL \| qty 100/);
  assert.match(context, /Portfolio flags:/);
  assert.match(context, /stop \$/);
});
