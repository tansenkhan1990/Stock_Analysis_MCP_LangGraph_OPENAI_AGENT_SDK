/**
 * Shared outbound-HTTP helpers. Yahoo rate limits aggressively (HTTP 429 on
 * bursts), so every request to a Yahoo host — quotes, charts, RSS, article
 * pages — passes through one global gate with retry and backoff.
 */
export function createGate(maxConcurrent) {
  let active = 0;
  const waiters = [];

  return async function withSlot(fn) {
    if (active >= maxConcurrent) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

/** One gate for every Yahoo host so bursts can never stack up. */
export const yahooGate = createGate(3);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE = (status) => status === 429 || status === 408 || status >= 500;

/**
 * Yahoo returns 429 for browser-spoofing user agents on its public feeds, but
 * serves a plain UA (or none) normally — verified against the RSS and article
 * endpoints. Keep this minimal.
 */
export const DEFAULT_HEADERS = {
  'user-agent': 'Mozilla/5.0',
  accept: 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
};

/**
 * Gated fetch that returns the response body text, retrying rate limits and
 * transient failures with exponential backoff and jitter.
 */
export async function fetchText(
  url,
  { headers = DEFAULT_HEADERS, timeout = 12_000, retries = 3, gate = yahooGate } = {},
) {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await gate(() =>
        fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' }),
      );

      if (response.ok) return await response.text();

      if (!RETRYABLE(response.status) || attempt === retries - 1) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries - 1) break;
    }

    await sleep(500 * 2 ** attempt + Math.random() * 400);
  }

  throw lastError;
}
