import test from 'node:test';
import assert from 'node:assert/strict';
import { FOCUS_UNIVERSE, HOT_SYMBOLS, HOT_UNIVERSE } from '../src/data/universe.js';
import { MAX_HOT_UNIVERSE, resolveHotUniverse } from '../src/services/hotStocksService.js';

test('broad hot universe is unique, well-formed and includes the focus names', () => {
  assert.ok(HOT_UNIVERSE.length >= 35, `expected a broad board, got ${HOT_UNIVERSE.length}`);
  assert.equal(new Set(HOT_SYMBOLS).size, HOT_SYMBOLS.length, 'symbols must be unique');

  for (const symbol of ['AAPL', 'META', 'AVGO', 'NVDA', 'MSFT', 'SPY', 'QQQ', 'DIA', 'XLF']) {
    assert.ok(HOT_SYMBOLS.includes(symbol), `missing ${symbol}`);
  }
  for (const item of HOT_UNIVERSE) {
    assert.ok(item.symbol, 'symbol required');
    assert.ok(item.name, `${item.symbol} name required`);
    assert.ok(['stock', 'etf'].includes(item.kind), `${item.symbol} kind`);
  }
  for (const item of FOCUS_UNIVERSE) {
    assert.ok(HOT_SYMBOLS.includes(item.symbol), `focus name ${item.symbol} must be in the hot universe`);
  }
});

test('broad scope scans the curated universe plus user additions, de-duplicated', () => {
  const { symbols, scope } = resolveHotUniverse({ watchlist: [{ symbol: 'AAPL' }, { symbol: 'ZZZZ' }] });
  assert.equal(scope, 'broad');
  assert.equal(symbols.length, HOT_SYMBOLS.length + 1);
  assert.ok(symbols.includes('AAPL'));
  assert.ok(symbols.includes('ZZZZ'));
});

test('focus scope scans only the editable focus list', () => {
  const { symbols, scope } = resolveHotUniverse({ scope: 'focus', watchlist: [{ symbol: 'AMD' }, { symbol: 'VOO' }] });
  assert.equal(scope, 'focus');
  assert.deepEqual(symbols, ['AMD', 'VOO']);
});

test('an empty focus list falls back to the seeded scan universe', () => {
  const { symbols, scope } = resolveHotUniverse({ scope: 'focus', watchlist: [] });
  assert.equal(scope, 'focus');
  assert.ok(symbols.length > 0);
  assert.ok(symbols.includes('NVDA'));
});

test('explicit symbols win, are normalised and capped', () => {
  const explicit = resolveHotUniverse({ symbols: [' nvda ', 'SPY', 'nvda'], watchlist: [{ symbol: 'AMD' }] });
  assert.equal(explicit.scope, 'custom');
  assert.deepEqual(explicit.symbols, ['NVDA', 'SPY']);

  const many = Array.from({ length: 60 }, (_, index) => `T${index}`);
  assert.equal(resolveHotUniverse({ symbols: many }).symbols.length, MAX_HOT_UNIVERSE);
});
