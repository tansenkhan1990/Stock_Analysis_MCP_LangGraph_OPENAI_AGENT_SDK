import test from 'node:test';
import assert from 'node:assert/strict';
import { chatWithLLM } from '../src/agent/providers.js';
import { config } from '../src/config.js';

/** What undici throws when the socket never reaches the provider. */
const fetchFailed = (code, detail) =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(detail), { code }),
  });

/** Run one provider call against a stubbed fetch and return its rejection. */
async function failureFor({ provider, apiKey, rejection, baseUrl }) {
  const originalFetch = globalThis.fetch;
  const originalProvider = config.llm.provider;
  const originalKey = config.llm[provider].apiKey;
  const originalBaseUrl = config.llm[provider].baseUrl;
  globalThis.fetch = async () => {
    throw rejection;
  };
  config.llm.provider = provider;
  config.llm[provider].apiKey = apiKey;
  // A developer .env may point the provider at a local gateway; the endpoint in
  // the message is what is under test, so pin the base URL.
  if (baseUrl) config.llm[provider].baseUrl = baseUrl;
  let message = null;
  try {
    await chatWithLLM({ messages: [{ role: 'user', content: 'hi' }] });
  } catch (error) {
    message = String(error?.message || '');
  } finally {
    config.llm.provider = originalProvider;
    config.llm[provider].apiKey = originalKey;
    config.llm[provider].baseUrl = originalBaseUrl;
    globalThis.fetch = originalFetch;
  }
  return message;
}

test('a network failure names the provider, endpoint and cause instead of "fetch failed"', async () => {
  const message = await failureFor({
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    rejection: fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND api.openai.com'),
  });

  assert.ok(message, 'the call must reject');
  assert.doesNotMatch(message, /^fetch failed$/, 'the generic undici wrapper is not a usable error');
  assert.match(message, /could not reach openai/);
  assert.match(message, /api\.openai\.com\/v1\/chat\/completions/);
  assert.match(message, /ENOTFOUND/, 'the underlying cause code is the whole point');
  assert.match(message, /base URL/, 'the message says what to check');
});

test('a refused connection to a local provider is reported with its code', async () => {
  const message = await failureFor({
    provider: 'ollama',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434',
    rejection: fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:11434'),
  });

  assert.match(message, /could not reach ollama/);
  assert.match(message, /127\.0\.0\.1:11434/);
  assert.match(message, /ECONNREFUSED/);
});

test('a provider timeout is reported as a timeout, not a parse failure', async () => {
  // The budget comes from config, so a raised LLM_TIMEOUT_MS is what the user sees.
  const originalTimeout = config.llm.timeoutMs;
  config.llm.timeoutMs = 45_000;
  const message = await failureFor({
    provider: 'anthropic',
    apiKey: 'test-key',
    rejection: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
  });
  config.llm.timeoutMs = originalTimeout;

  assert.match(message, /no answer from anthropic/);
  assert.match(message, /within 45s/);
});

test('the provider URL in the error never carries the API key', async () => {
  const message = await failureFor({
    provider: 'gemini',
    apiKey: 'super-secret-key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    rejection: fetchFailed('ENETUNREACH', 'connect ENETUNREACH'),
  });

  assert.ok(message, 'the call must reject');
  assert.doesNotMatch(message, /super-secret-key/, 'the Gemini key sits in the query string');
  assert.match(message, /generativelanguage\.googleapis\.com/);
});
