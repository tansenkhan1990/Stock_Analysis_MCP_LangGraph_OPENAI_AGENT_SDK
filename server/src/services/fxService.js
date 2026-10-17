import { config } from '../config.js';
import { cache } from '../lib/cache.js';
import { getQuote } from '../lib/yahoo.js';

/**
 * Display-currency FX. Yahoo quotes USDEUR=X as "EUR per 1 USD", which is
 * exactly what the client needs to convert USD prices into euro.
 *
 * The rate is cached for a few minutes, a fixed rate from USD_EUR_RATE wins
 * over live data, and a stale-but-real rate is served if Yahoo is briefly
 * unavailable. We never invent a rate: with no live rate and no last-good
 * value the API reports rate: null and the UI keeps showing USD.
 */
const PAIR = 'USDEUR=X';
export const FX_CACHE_KEY = 'fx:usd-eur';

let lastGood = null;
let inFlight = null;

const round = (value, digits = 6) => Number(Number(value).toFixed(digits));

export function snapshotFromQuote(quote) {
  const price = Number(quote?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Invalid USD/EUR exchange rate');
  }
  return {
    base: 'USD',
    quote: 'EUR',
    rate: round(price),
    asOf: quote.updatedAt || null,
    source: 'Yahoo Finance',
    pair: PAIR,
    stale: false,
    error: null,
  };
}

export function manualSnapshot(rate) {
  return {
    base: 'USD',
    quote: 'EUR',
    rate: round(rate),
    asOf: new Date().toISOString(),
    source: 'USD_EUR_RATE override',
    pair: PAIR,
    stale: false,
    error: null,
  };
}

export function fallbackSnapshot(message) {
  if (lastGood) {
    return { ...lastGood, stale: true, error: message || 'Live FX temporarily unavailable' };
  }
  return {
    base: 'USD',
    quote: 'EUR',
    rate: null,
    asOf: null,
    source: 'unavailable',
    pair: PAIR,
    stale: true,
    error: message || 'Live FX unavailable',
  };
}

async function fetchRate() {
  try {
    const quote = await getQuote(PAIR);
    lastGood = snapshotFromQuote(quote);
    return lastGood;
  } catch (error) {
    return fallbackSnapshot(error?.message);
  }
}

export async function getUsdEurRate() {
  if (config.fx.manualRate > 0) return manualSnapshot(config.fx.manualRate);

  const cached = cache.get(FX_CACHE_KEY);
  if (cached) return cached;

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const snapshot = await fetchRate();
      // Retry stale/unavailable reads sooner than a good live rate.
      cache.set(FX_CACHE_KEY, snapshot, snapshot.rate ? config.fx.ttlMs : 60_000);
      return snapshot;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Test hook: forget the last good rate. */
export function _resetFxState() {
  lastGood = null;
  inFlight = null;
  cache.clear(FX_CACHE_KEY);
}
