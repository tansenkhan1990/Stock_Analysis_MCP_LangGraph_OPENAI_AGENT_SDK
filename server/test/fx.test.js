import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { cache } from '../src/lib/cache.js';
import {
  FX_CACHE_KEY,
  _resetFxState,
  fallbackSnapshot,
  getUsdEurRate,
  manualSnapshot,
  snapshotFromQuote,
} from '../src/services/fxService.js';

const quote = { price: 0.8895, updatedAt: '2026-10-17T12:20:52.000Z' };

test('USDEUR quote becomes a USD→EUR snapshot', () => {
  const snapshot = snapshotFromQuote(quote);
  assert.equal(snapshot.base, 'USD');
  assert.equal(snapshot.quote, 'EUR');
  assert.equal(snapshot.rate, 0.8895);
  assert.equal(snapshot.pair, 'USDEUR=X');
  assert.equal(snapshot.asOf, quote.updatedAt);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.error, null);
});

test('invalid FX quotes are rejected instead of silently used', () => {
  assert.throws(() => snapshotFromQuote({ price: 0 }), /Invalid USD\/EUR/);
  assert.throws(() => snapshotFromQuote({ price: -1 }), /Invalid USD\/EUR/);
  assert.throws(() => snapshotFromQuote({ price: 'n/a' }), /Invalid USD\/EUR/);
  assert.throws(() => snapshotFromQuote(null), /Invalid USD\/EUR/);
});

test('manual override is rounded and labelled', () => {
  const snapshot = manualSnapshot(0.91234567);
  assert.equal(snapshot.rate, 0.912346);
  assert.equal(snapshot.source, 'USD_EUR_RATE override');
  assert.equal(snapshot.stale, false);
});

test('fallback never invents a rate', () => {
  const snapshot = fallbackSnapshot('boom');
  assert.equal(snapshot.rate, null);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.error, 'boom');
});

test('a cached rate is served without hitting Yahoo', async () => {
  const original = config.fx.manualRate;
  config.fx.manualRate = 0;
  const cached = {
    base: 'USD',
    quote: 'EUR',
    rate: 0.9,
    asOf: quote.updatedAt,
    source: 'test fixture',
    pair: 'USDEUR=X',
    stale: false,
    error: null,
  };
  cache.set(FX_CACHE_KEY, cached, 60_000);
  try {
    assert.deepEqual(await getUsdEurRate(), cached);
  } finally {
    _resetFxState();
    config.fx.manualRate = original;
  }
});
