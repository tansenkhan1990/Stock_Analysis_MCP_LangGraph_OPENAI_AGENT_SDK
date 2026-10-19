import test from 'node:test';
import assert from 'node:assert/strict';
import { chatWithLLM } from '../src/agent/providers.js';
import { imageMessage, MAX_IMAGE_BYTES, parseImageAttachment } from '../src/agent/vision.js';
import { config } from '../src/config.js';

// 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMAGE = parseImageAttachment({ fileName: 'chart.png', mimeType: 'image/png', data: PNG_BASE64 });

test('parseImageAttachment accepts raw base64 and data: URLs', () => {
  const raw = parseImageAttachment({ fileName: 'chart.png', mimeType: 'image/png', data: PNG_BASE64 });
  assert.equal(raw.fileName, 'chart.png');
  assert.equal(raw.mimeType, 'image/png');
  assert.ok(raw.bytes > 0);

  const dataUrl = parseImageAttachment({ data: `data:image/jpeg;base64,${PNG_BASE64}` });
  assert.equal(dataUrl.mimeType, 'image/jpeg', 'the data URL mime type is used when none is given');
  assert.equal(dataUrl.fileName, 'image.png', 'a missing name falls back to a placeholder');

  assert.equal(parseImageAttachment(undefined), null, 'no image is not an error');
  assert.equal(parseImageAttachment(null), null);
});

test('parseImageAttachment normalizes jpg to jpeg', () => {
  const image = parseImageAttachment({ fileName: 'shot.jpg', mimeType: 'image/jpg', data: PNG_BASE64 });
  assert.equal(image.mimeType, 'image/jpeg');
});

test('parseImageAttachment rejects unsupported and malformed payloads', () => {
  assert.throws(() => parseImageAttachment({ mimeType: 'image/svg+xml', data: PNG_BASE64 }), /Unsupported image type/);
  assert.throws(() => parseImageAttachment({ mimeType: 'application/pdf', data: PNG_BASE64 }), /Unsupported image type/);
  assert.throws(() => parseImageAttachment({ mimeType: 'image/png', data: '' }), /empty/);
  assert.throws(() => parseImageAttachment({ mimeType: 'image/png', data: 'not base64!!' }), /base64/);
  assert.throws(() => parseImageAttachment('chart.png'), /invalid/);
});

test('parseImageAttachment enforces the size cap', () => {
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1024, 7).toString('base64');
  assert.throws(
    () => parseImageAttachment({ mimeType: 'image/png', data: oversized }),
    /too large/,
  );
});

test('imageMessage builds multi-part content and stays a string without an image', () => {
  assert.deepEqual(imageMessage('plain question', null), { role: 'user', content: 'plain question' });
  const message = imageMessage('read this', IMAGE);
  assert.equal(message.role, 'user');
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.content[1].type, 'image');
  assert.equal(message.content[1].mimeType, 'image/png');
});

/** Run chatWithLLM against a stubbed fetch, capturing the outgoing body. */
async function capture(provider, reply) {
  const originalFetch = globalThis.fetch;
  const originalProvider = config.llm.provider;
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(reply) };
  };
  try {
    config.llm.provider = provider;
    config.llm.openai.apiKey = 'test-key';
    config.llm.anthropic.apiKey = 'test-key';
    config.llm.gemini.apiKey = 'test-key';
    await chatWithLLM({ messages: [imageMessage('read this', IMAGE)] });
    return captured;
  } finally {
    config.llm.provider = originalProvider;
    globalThis.fetch = originalFetch;
  }
}

test('the OpenAI adapter sends the image as an image_url part', async () => {
  const captured = await capture('openai', { choices: [{ message: { content: 'ok' } }] });
  const parts = captured.body.messages[0].content;
  assert.deepEqual(parts[0], { type: 'text', text: 'read this' });
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, `data:image/png;base64,${PNG_BASE64}`);
});

test('the Anthropic adapter sends a base64 image block', async () => {
  const captured = await capture('anthropic', { content: [{ type: 'text', text: 'ok' }] });
  const [image] = captured.body.messages;
  assert.equal(image.role, 'user');
  assert.deepEqual(image.content[0], { type: 'text', text: 'read this' });
  assert.deepEqual(image.content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
  });
});

test('the Gemini adapter sends inlineData for the image', async () => {
  const captured = await capture('gemini', {
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
  });
  const [user] = captured.body.contents;
  assert.equal(user.role, 'user');
  assert.deepEqual(user.parts[0], { text: 'read this' });
  assert.deepEqual(user.parts[1], { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } });
});

test('the Ollama adapter sends a string content plus an images array', async () => {
  const captured = await capture('ollama', { message: { content: 'ok' } });
  assert.deepEqual(captured.body.messages[0], {
    role: 'user',
    content: 'read this',
    images: [PNG_BASE64],
  });
});
