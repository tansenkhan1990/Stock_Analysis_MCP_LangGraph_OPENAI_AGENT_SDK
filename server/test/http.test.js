import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, fetchText } from '../src/lib/http.js';

test('createGate never runs more than its concurrency limit at once', async () => {
  const gate = createGate(2);
  let active = 0;
  let peak = 0;

  const jobs = Array.from({ length: 12 }, () =>
    gate(async () => {
      active += 1;
      peak = Math.max(peak, active);
      // Yield so every job overlaps with the others in the same pool.
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    }),
  );

  await Promise.all(jobs);

  assert.ok(peak <= 2, `gate ran ${peak} tasks at once (limit 2)`);
  assert.equal(active, 0);
});

test('createGate treats a non-positive limit as one slot', async () => {
  const gate = createGate(0);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      gate(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 1);
});

test('fetchText does not retry a non-retryable HTTP status', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  try {
    await assert.rejects(() => fetchText('https://example.invalid/missing', { retries: 3 }), /HTTP 404/);
    assert.equal(calls, 1, 'a 404 must fail immediately instead of being retried');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
