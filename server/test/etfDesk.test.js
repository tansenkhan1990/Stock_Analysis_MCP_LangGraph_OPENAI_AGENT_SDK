import test from 'node:test';
import assert from 'node:assert/strict';
import { ETF_UNIVERSE, etfThesis, resolveEtfUniverse, sortEtfRows } from '../src/services/etfDeskService.js';

test('the ETF universe holds the curated funds and no single stocks', () => {
  for (const symbol of ['SPY', 'QQQ', 'IWM', 'SMH', 'TLT', 'GLD', 'ISDW.L', 'DIA', 'XLF', 'XLE']) {
    assert.ok(ETF_UNIVERSE.includes(symbol), `${symbol} should be in the ETF universe`);
  }
  for (const symbol of ['NVDA', 'MSFT', 'AMZN', 'AAPL']) {
    assert.ok(!ETF_UNIVERSE.includes(symbol), `${symbol} is a stock, not an ETF`);
  }
});

test('resolveEtfUniverse keeps curated funds, adds ETF watchlist names and drops stocks', () => {
  const symbols = resolveEtfUniverse({
    watchlist: [
      { symbol: 'VOO', quoteType: 'ETF' },
      { symbol: 'AAPL', quoteType: 'EQUITY' },
      'RAWSTRING',
      { symbol: 'qqq', quoteType: 'ETF' }, // duplicate, lower case
    ],
  });
  assert.ok(symbols.includes('VOO'), 'an ETF the user added is tracked');
  assert.ok(symbols.includes('QQQ'), 'the curated fund is present');
  assert.ok(!symbols.includes('AAPL'), 'a stock must not enter the ETF desk');
  assert.ok(!symbols.includes('RAWSTRING'), 'a plain string item carries no quote type and is ignored');
  assert.equal(symbols.length, new Set(symbols).size, 'no duplicates');
  assert.ok(symbols.every((symbol) => symbol === symbol.toUpperCase()), 'symbols are normalized');
});

test('resolveEtfUniverse honours the cap and explicit extras', () => {
  const capped = resolveEtfUniverse({ watchlist: [], extra: ['ARKK'], limit: 3 });
  assert.equal(capped.length, 3);
  assert.ok(capped.includes('ARKK') || capped.includes(ETF_UNIVERSE[0]));

  const many = resolveEtfUniverse({
    watchlist: Array.from({ length: 40 }, (_, index) => ({ symbol: `ETF${index}`, quoteType: 'ETF' })),
  });
  assert.ok(many.length <= 24, `expected the list to stay bounded, got ${many.length}`);
});

test('sortEtfRows ranks the highest chance to rise first and leaves the input alone', () => {
  const rows = [
    { symbol: 'TLT', growthProbability: 41, decision: { conviction: 70 } },
    { symbol: 'QQQ', growthProbability: 74, decision: { conviction: 60 } },
    { symbol: 'GLD', growthProbability: null, decision: { conviction: 90 } },
    { symbol: 'SPY', growthProbability: 74, decision: { conviction: 65 } },
    { symbol: 'IWM', growthProbability: 55, decision: { conviction: 50 } },
  ];
  const before = rows.map((row) => row.symbol);
  const sorted = sortEtfRows(rows);

  // QQQ and SPY share 74%; the higher conviction (SPY 65) breaks the tie.
  assert.deepEqual(
    sorted.map((row) => row.symbol),
    ['SPY', 'QQQ', 'IWM', 'TLT', 'GLD'],
  );
  assert.deepEqual(
    rows.map((row) => row.symbol),
    before,
    'sortEtfRows must not mutate its input',
  );
});

test('etfThesis prefers the model thesis and composes one for an engine call', () => {
  assert.equal(etfThesis({ decision: { thesis: 'The model read.' } }), 'The model read.');

  const engine = etfThesis({
    decision: {
      setupLabel: 'Uptrend pullback',
      alert: { reason: 'Price is above the 50-day and the 200-day, RSI 52.' },
    },
    technical: { signalLabel: 'Bullish', score: 71 },
  });
  assert.match(engine, /Uptrend pullback/);
  assert.match(engine, /above the 50-day/);
  assert.match(engine, /Bullish · quality 71\/100/);

  assert.equal(etfThesis({}), 'No model call yet — the engine call stands in.');
  assert.equal(etfThesis({ decision: { thesis: '   ' } }), 'No model call yet — the engine call stands in.');
});

test('sortEtfRows tolerates missing decisions and matches symbols deterministically', () => {
  const sorted = sortEtfRows([
    { symbol: 'XLE' },
    { symbol: 'XLF', growthProbability: 60 },
    { symbol: 'DIA', growthProbability: 60 },
  ]);
  assert.deepEqual(
    sorted.map((row) => row.symbol),
    ['DIA', 'XLF', 'XLE'],
  );
});
