/**
 * Shared outbound-HTTP helpers. Yahoo rate limits aggressively (HTTP 429 on
 * bursts), so every request to a Yahoo host — quotes, charts, RSS, article
 * pages — passes through one global gate with retry and backoff.
 */
export function createGate(maxConcurrent) {
  const limit = Math.max(1, Number(maxConcurrent) || 1);
  let active = 0;
  const waiters = [];

  return async function withSlot(fn) {
    if (active < limit) {
      active += 1;
    } else {
      // Hand the slot straight to the next waiter: the releasing call must not
      // decrement first, or a new caller can slip in before the woken waiter
      // resumes and push the gate above its limit.
      await new Promise((resolve) => waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
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
    let response;
    try {
      response = await gate(() =>
        fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' }),
      );
    } catch (error) {
      // Timeouts and network blips are worth retrying; a non-retryable HTTP
      // status is not, so the two paths are handled separately.
      lastError = error;
      if (attempt === retries - 1) break;
      await sleep(500 * 2 ** attempt + Math.random() * 400);
      continue;
    }

    if (response.ok) return await response.text();

    lastError = new Error(`HTTP ${response.status} for ${url}`);
    if (!RETRYABLE(response.status) || attempt === retries - 1) break;
    await sleep(500 * 2 ** attempt + Math.random() * 400);
  }

  throw lastError;
}
