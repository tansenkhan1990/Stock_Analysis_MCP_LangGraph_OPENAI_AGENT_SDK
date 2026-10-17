import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEPTH,
  MAX_DEPTH,
  MARKET_SCREEN_IDS,
  buildMarketTape,
  heatScore,
  isTradeableQuote,
  selectDeepSymbols,
} from '../src/analytics/marketScreen.js';

const quote = (symbol, overrides = {}) => ({
  symbol,
  name: `${symbol} Inc.`,
  quoteType: 'EQUITY',
  exchange: 'NasdaqGS',
  price: 100,
  changePercent: 1,
  change: 1,
  volume: 2_000_000,
  averageVolume: 1_000_000,
  marketCap: 50_000_000_000,
  ...overrides,
});

test('the market tape merges overlapping screens, keeps the richest quote and tags sources', () => {
  const tape = buildMarketTape({
    screens: [
      { id: 'most_actives', quotes: [quote('NVDA', { volume: 5_000_000 }), quote('AAPL')] },
      { id: 'day_gainers', quotes: [quote('NVDA'), quote('PLTR', { changePercent: 7 })] },
    ],
  });

  const symbols = tape.rows.map((row) => row.symbol);
  assert.deepEqual(symbols.sort(), ['AAPL', 'NVDA', 'PLTR']);
  const nvda = tape.rows.find((row) => row.symbol === 'NVDA');
  assert.deepEqual(nvda.sources.sort(), ['day_gainers', 'most_actives']);
  assert.equal(nvda.relativeVolume, 5, 'the richest quote (highest volume) wins');
  assert.equal(tape.universeSize, 3);
  assert.equal(tape.sources.length, 2);
});

test('a repeated symbol keeps the most active snapshot, not the first screen it appeared in', () => {
  const tape = buildMarketTape({
    screens: [
      { id: 'day_gainers', quotes: [quote('NVDA', { volume: 1_000_000, changePercent: 9 })] },
      { id: 'most_actives', quotes: [quote('NVDA', { volume: 6_000_000, changePercent: 2 })] },
    ],
  });

  const nvda = tape.rows.find((row) => row.symbol === 'NVDA');
  assert.equal(nvda.volume, 6_000_000);
  assert.equal(nvda.relativeVolume, 6);
  assert.equal(nvda.changePercent, 2, 'relative volume and day move come from the same quote');
  assert.deepEqual(nvda.sources.sort(), ['day_gainers', 'most_actives']);
});

test('cheap, illiquid, foreign and non-equity quotes never reach the tape', () => {
  assert.equal(isTradeableQuote(quote('PENNY', { price: 1.2 })), false);
  assert.equal(isTradeableQuote(quote('THIN', { averageVolume: 20_000 })), false);
  assert.equal(isTradeableQuote(quote('ISDW.L', { exchange: 'LSE' })), false);
  assert.equal(isTradeableQuote(quote('ES=F', { exchange: 'CME' })), false);
  assert.equal(isTradeableQuote(quote('OPT', { quoteType: 'OPTION' })), false);
  assert.equal(isTradeableQuote(quote('GOOD', { exchange: 'NYSE' })), true);

  const tape = buildMarketTape({
    screens: [
      {
        id: 'most_actives',
        quotes: [quote('PENNY', { price: 1 }), quote('ISDW.L', { exchange: 'LSE' }), quote('GOOD', { exchange: 'NYSE' })],
      },
    ],
  });
  assert.deepEqual(
    tape.rows.map((row) => row.symbol),
    ['GOOD'],
  );
});

test('heat favours unusual volume and a steady move over a parabolic spike', () => {
  const base = { averageVolume: 1_000_000, marketCap: 10_000_000_000 };
  const quiet = heatScore({ ...base, volume: 400_000, changePercent: 0.1 });
  const active = heatScore({ ...base, volume: 2_500_000, changePercent: 3 });
  const parabolic = heatScore({ ...base, volume: 2_500_000, changePercent: 45 });
  const crashing = heatScore({ ...base, volume: 2_500_000, changePercent: -18 });

  assert.ok(active > quiet, 'volume + a tradable move beats a dead tape');
  assert.ok(active > parabolic, 'a blow-off top is damped, not rewarded');
  assert.ok(active > crashing, 'a collapse is not a buy candidate');
  assert.ok(active <= 100 && quiet >= 0);
});

test('pinned names (curated + watchlist) always stay on the tape, even past the limit', () => {
  const screens = [
    {
      id: 'most_actives',
      quotes: Array.from({ length: 20 }, (_, index) => quote(`HOT${index}`, { volume: 20_000_000 - index * 100_000 })),
    },
  ];
  const tape = buildMarketTape({
    screens,
    curated: [{ symbol: 'NVDA', name: 'NVIDIA' }],
    watchlist: [{ symbol: 'MINE' }],
    limit: 5,
  });

  const symbols = tape.rows.map((row) => row.symbol);
  assert.ok(symbols.includes('NVDA'), 'curated name pinned');
  assert.ok(symbols.includes('MINE'), 'watchlist name pinned');
  assert.equal(tape.rows.filter((row) => !row.curated && !row.watchlist).length, 3);
  assert.equal(tape.universeSize, 22);
  assert.equal(tape.rows[0].curated, true, 'pinned names sort first');
});

test('the deep-scan selection takes pinned names first, then the hottest, capped by depth', () => {
  const rows = [
    { symbol: 'HOT1', heat: 95, curated: false, watchlist: false },
    { symbol: 'HOT2', heat: 90, curated: false, watchlist: false },
    { symbol: 'HOT3', heat: 85, curated: false, watchlist: false },
    { symbol: 'LOW', heat: 10, curated: false, watchlist: false },
    { symbol: 'NVDA', heat: 60, curated: true, watchlist: false },
    { symbol: 'MINE', heat: 5, curated: false, watchlist: true },
  ];

  const deep = selectDeepSymbols(rows, { depth: 3 });
  assert.deepEqual(deep.slice(0, 2).sort(), ['MINE', 'NVDA']);
  assert.equal(deep.length, 3, 'the cap is honoured');
  assert.ok(deep.includes('HOT1'), 'the hottest unpinned name fills the rest');

  const withExtra = selectDeepSymbols(rows, { depth: 4, always: ['EXTRA'] });
  assert.equal(withExtra.length, 4);
  assert.ok(withExtra.includes('EXTRA'));

  assert.equal(selectDeepSymbols(rows, { depth: 10_000 }).length, rows.length, 'never more names than the tape holds');
  assert.equal(selectDeepSymbols(rows, {}).length, Math.min(rows.length, DEFAULT_DEPTH));
  assert.equal(selectDeepSymbols([], { depth: 5 }).length, 0);

  // The depth parameter itself is clamped to the supported maximum.
  const big = Array.from({ length: 400 }, (_, index) => ({ symbol: `S${index}`, heat: 100 - index }));
  assert.equal(selectDeepSymbols(big, { depth: 10_000 }).length, MAX_DEPTH);
  assert.equal(selectDeepSymbols(big, { depth: 0 }).length, DEFAULT_DEPTH, 'a missing depth falls back to the default');
});

test('the merged screen list is the live market universe', () => {
  assert.ok(MARKET_SCREEN_IDS.includes('most_actives'));
  assert.ok(MARKET_SCREEN_IDS.includes('day_gainers'));
  assert.ok(MARKET_SCREEN_IDS.length >= 4);
});
