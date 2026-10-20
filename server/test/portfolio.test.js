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
  salvageTicker,
} from '../src/analytics/portfolio.js';
import { parsePortfolioImageResult, parsePortfolioTranscription } from '../src/services/portfolioService.js';

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

test('portfolio screenshot extraction accepts JSON and fenced JSON but requires readable positions', () => {
  const parsed = parsePortfolioImageResult(
    '```json\n{"holdings":[{"symbol":"aapl","quantity":10,"avgCost":180.5}]}\n```',
    { fileName: 'broker.png' },
  );
  assert.equal(parsed.fileName, 'broker.png');
  assert.deepEqual(
    parsed.positions.map(({ symbol, quantity, avgCost }) => ({ symbol, quantity, avgCost })),
    [{ symbol: 'AAPL', quantity: 10, avgCost: 180.5 }],
  );

  assert.throws(() => parsePortfolioImageResult('not json'), /clearer or closer image/i);
  assert.throws(() => parsePortfolioImageResult('{"holdings":[]}'), /No stock or ETF positions were readable/i);
});

test('salvageTicker recovers a ticker from noisy screenshot cells', () => {
  assert.equal(salvageTicker('AAPL - Apple Inc.'), 'AAPL');
  assert.equal(salvageTicker('NVIDIA Corp. (NVDA)'), 'NVDA');
  assert.equal(salvageTicker('NYSE:TSM'), 'TSM');
  assert.equal(salvageTicker('aapl'), 'AAPL');
  assert.equal(salvageTicker('BRK/B'), 'BRK-B');
  assert.equal(salvageTicker('Apple Inc.'), '');
  assert.equal(salvageTicker('Total'), '');
});

test('a screenshot row with a blurry share count is kept for verification', () => {
  const parsed = parsePortfolioImageResult(
    JSON.stringify({
      holdings: [
        { instrument: 'AAPL - Apple Inc.', shares: '40 shares' },
        { tickerSymbol: 'NVIDIA Corp. (NVDA)', quantity: null },
        { symbol: 'Apple Inc.' },
      ],
    }),
    { fileName: 'broker.png' },
  );
  assert.deepEqual(
    parsed.positions.map((position) => [position.symbol, position.quantity]),
    [
      ['AAPL', 40],
      ['NVDA', null],
    ],
  );
  assert.ok(parsed.warnings.some((warning) => /share quantity/i.test(warning)));
  assert.equal(parsed.ignored.length, 1);
  assert.ok(parsed.ignored[0].line > 0);
});

test('screenshot extraction survives prose, reads cash and keeps shorts negative', () => {
  const parsed = parsePortfolioImageResult(
    'Here are the holdings I can read:\n' +
      '{"holdings":[{"symbol":"TSLA","quantity":12},{"symbol":"AMD","quantity":-5,"avgCost":"$240.10"}],' +
      '"cash":[{"currency":"usd","value":"1,850.00"},{"value":-250}]}\n' +
      'I left the blurry rows out.',
    { fileName: 'broker.png' },
  );
  assert.deepEqual(
    parsed.positions.map(({ symbol, quantity }) => ({ symbol, quantity })),
    [
      { symbol: 'TSLA', quantity: 12 },
      { symbol: 'AMD', quantity: -5 },
    ],
  );
  assert.equal(parsed.positions[1].avgCost, 240.1, 'currency symbols are stripped from cost basis');
  assert.equal(parsed.cash.length, 1);
  assert.equal(parsed.cash[0].value, 1600, 'cash rows merge by currency, debit included');
});

test('a non-JSON table from the vision model is still readable', () => {
  const parsed = parsePortfolioImageResult(
    'TICKER | QUANTITY | AVG COST | CURRENCY | NAME\nAAPL | 40 | 180.50 | USD | Apple Inc.\nNVDA | 3 | 118.20 | USD | NVIDIA Corp.\n',
    { fileName: 'broker.png' },
  );
  assert.deepEqual(
    parsed.positions.map(({ symbol, quantity, avgCost }) => ({ symbol, quantity, avgCost })),
    [
      { symbol: 'AAPL', quantity: 40, avgCost: 180.5 },
      { symbol: 'NVDA', quantity: 3, avgCost: 118.2 },
    ],
  );
});

test('transcription fallback handles unreadable cells, prose and blank replies', () => {
  const parsed = parsePortfolioTranscription(
    'Here is what I can read:\n```\nAAPL | ? | ? | USD | Apple Inc.\nMSFT  12  410.25\nNOTHING\n```\n',
    { fileName: 'broker.png' },
  );
  assert.deepEqual(
    parsed.positions.map(({ symbol, quantity }) => [symbol, quantity]),
    [
      ['AAPL', null],
      ['MSFT', 12],
    ],
  );
  assert.ok(parsed.warnings.some((warning) => /share quantity/i.test(warning)));
  assert.equal(parsePortfolioTranscription('NOTHING'), null);
  assert.equal(parsePortfolioTranscription('   '), null);
});

test('a name-only row adopts a ticker resolved from the company name', () => {
  const tickersByName = new Map([['apple', 'AAPL']]);
  const fromJson = parsePortfolioImageResult(
    JSON.stringify({ holdings: [{ name: 'Apple Inc.', quantity: 12 }] }),
    { fileName: 'broker.png', tickersByName },
  );
  assert.deepEqual(
    fromJson.positions.map(({ symbol, quantity }) => [symbol, quantity]),
    [['AAPL', 12]],
  );

  // Many European brokers print only the company name on the row.
  const fromTable = parsePortfolioTranscription('Apple Inc. | 12 | 180.50 | USD\n', {
    fileName: 'broker.png',
    tickersByName,
  });
  assert.deepEqual(
    fromTable.positions.map(({ symbol, quantity }) => [symbol, quantity]),
    [['AAPL', 12]],
  );
});

test('a company name in the symbol cell is looked up, not read as a ticker', () => {
  // "NVIDIA" is not a listed ticker; the row must resolve to NVDA instead.
  assert.throws(
    () => parsePortfolioImageResult(JSON.stringify({ holdings: [{ symbol: 'NVIDIA Corp.', quantity: 25 }] })),
    (error) => error.unresolved?.[0] === 'NVIDIA Corp.',
  );
  const resolved = parsePortfolioImageResult(
    JSON.stringify({ holdings: [{ symbol: 'NVIDIA Corp.', quantity: 25 }] }),
    { fileName: 'broker.png', tickersByName: new Map([['nvidia', 'NVDA']]) },
  );
  assert.equal(resolved.positions[0].symbol, 'NVDA');
});

test('name-only rows are reported for a lookup instead of silently dropped', () => {
  assert.throws(
    () => parsePortfolioImageResult(JSON.stringify({ holdings: [{ name: 'Apple Inc.' }] })),
    (error) => error.unresolved?.[0] === 'Apple Inc.',
  );
  const table = parsePortfolioTranscription('Apple Inc. | 12\n');
  assert.deepEqual(table.unresolved, ['Apple Inc.']);
});

test('a negative cash row is a margin debit, not flipped into a credit', () => {
  const parsed = parsePortfolioText('Ticker,Quantity,Avg price\nAAPL,10,100\nCASH,-500,,USD\n');
  assert.equal(parsed.cash[0].value, -500);
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

test('a Sell call on a short position is a hold, not an exit', () => {
  const review = buildPortfolioReview({
    positions: [{ symbol: 'TSLA', quantity: -4, avgCost: 300, currency: 'USD' }],
    quotes: { TSLA: quote('TSLA', 250) },
    analyses: { TSLA: analysis({ action: 'sell', stopLoss: 265, direction: 'short', targets: [220] }) },
    cash: [{ currency: 'USD', value: 10000 }],
  });
  const row = review.positions[0];
  assert.equal(row.recommendation, 'hold');
  assert.match(row.recommendationReason, /short/i);
  assert.equal(row.trimShares, null);
  assert.equal(
    review.flags.some((flag) => flag.code === 'sell-call'),
    false,
    'a short working with the trend is not tagged for an exit',
  );
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
