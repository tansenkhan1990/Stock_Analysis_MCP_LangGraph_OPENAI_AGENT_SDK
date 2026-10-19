import { config, hasLLM } from '../config.js';

/**
 * Provider adapters all speak one internal message format:
 *   { role: 'system'|'user'|'assistant'|'tool', content, toolCalls?, toolCallId?, name? }
 * and return { content, toolCalls: [{ id, name, arguments }] }.
 *
 * A user message that carries an image uses multi-part content:
 *   [{ type: 'text', text }, { type: 'image', mimeType, data }]
 * where `data` is raw base64 (no data: prefix). Each adapter converts those
 * blocks into its own vision format below.
 */

const isImageBlock = (block) => block?.type === 'image' && block.data;
const textOf = (content) =>
  Array.isArray(content)
    ? content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n')
    : content || '';
const imagesOf = (content) =>
  Array.isArray(content) ? content.filter(isImageBlock).map((block) => block.data) : [];
const dataUrl = (block) => `data:${block.mimeType || 'image/png'};base64,${block.data}`;

const parseArgs = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

async function postJSON(url, body, headers = {}, timeout = 90_000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Provider returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

const toOpenAIMessages = (messages) =>
  messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
        })),
      };
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    if (Array.isArray(message.content)) {
      return {
        role: message.role,
        content: message.content.map((block) =>
          isImageBlock(block)
            ? { type: 'image_url', image_url: { url: dataUrl(block) } }
            : { type: 'text', text: block.text || '' },
        ),
      };
    }
    return { role: message.role, content: message.content };
  });

/** Ollama takes a plain string plus a separate `images` array of base64. */
const toOllamaMessages = (messages) =>
  toOpenAIMessages(messages).map((message, index) => {
    const source = messages[index];
    const images = imagesOf(source?.content);
    if (!images.length) return message;
    return { role: message.role, content: textOf(source.content), images };
  });

function toAnthropicMessages(messages) {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const out = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments || {} });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (Array.isArray(message.content)) {
      out.push({
        role: message.role,
        content: message.content.map((block) =>
          isImageBlock(block)
            ? { type: 'image', source: { type: 'base64', media_type: block.mimeType || 'image/png', data: block.data } }
            : { type: 'text', text: block.text || '' },
        ),
      });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return { system, messages: out };
}

function toGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const part = {
        functionResponse: {
          name: message.name || 'tool',
          response: { result: message.content },
        },
      };
      const last = contents[contents.length - 1];
      if (last?.role === 'user') last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      continue;
    }
    if (message.role === 'assistant') {
      const parts = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls || []) {
        parts.push({ functionCall: { name: call.name, args: call.arguments || {} } });
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }
    if (Array.isArray(message.content)) {
      contents.push({
        role: 'user',
        parts: message.content.map((block) =>
          isImageBlock(block)
            ? { inlineData: { mimeType: block.mimeType || 'image/png', data: block.data } }
            : { text: block.text || '' },
        ),
      });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: message.content }] });
  }
  return contents;
}

/** Vision models on Ollama are opt-in; a text-only model would just error. */
const OLLAMA_VISION_MODEL = /llava|bakllava|vision|moondream|minicpm-v|qwen2(?:\.\d)?-?vl|gemma3/i;

/**
 * Every live provider can carry an image, but the configured model and the
 * endpoint must actually accept one. This drives the UI hint, not a hard gate:
 * a provider-side rejection is surfaced to the user as a provider error.
 */
export function supportsVision() {
  const provider = config.llm.provider;
  if (provider === 'openai' || provider === 'anthropic' || provider === 'gemini') return true;
  if (provider === 'ollama') return OLLAMA_VISION_MODEL.test(config.llm.ollama.model);
  return false;
}

export function describeProvider() {
  const provider = config.llm.provider;
  const models = {
    openai: config.llm.openai.model,
    anthropic: config.llm.anthropic.model,
    gemini: config.llm.gemini.model,
    ollama: config.llm.ollama.model,
    builtin: 'MarketPilot rule engine',
  };
  return {
    provider,
    model: models[provider] || 'built-in',
    live: hasLLM,
    vision: hasLLM && supportsVision(),
    label: hasLLM ? `${provider} · ${models[provider]}` : 'built-in analyst (no API key configured)',
  };
}

export async function chatWithLLM({ messages, tools }) {
  const provider = config.llm.provider;
  const started = Date.now();

  if (provider === 'openai') {
    const data = await postJSON(
      `${config.llm.openai.baseUrl}/chat/completions`,
      {
        model: config.llm.openai.model,
        messages: toOpenAIMessages(messages),
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        temperature: 0.2,
      },
      { authorization: `Bearer ${config.llm.openai.apiKey}` },
    );
    const message = data.choices?.[0]?.message || {};
    return {
      content: message.content || '',
      toolCalls: (message.tool_calls || []).map((call) => ({
        id: call.id || `call_${Math.random().toString(36).slice(2)}`,
        name: call.function?.name,
        arguments: parseArgs(call.function?.arguments),
      })),
      usage: data.usage,
      durationMs: Date.now() - started,
    };
  }

  if (provider === 'anthropic') {
    const { system, messages: converted } = toAnthropicMessages(messages);
    const anthropicTools = tools?.length
      ? {
          tools: tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
          })),
        }
      : {};
    const data = await postJSON(
      `${config.llm.anthropic.baseUrl}/messages`,
      {
        model: config.llm.anthropic.model,
        system,
        messages: converted,
        max_tokens: 2200,
        temperature: 0.2,
        ...anthropicTools,
      },
      { 'x-api-key': config.llm.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
    );
    const blocks = data.content || [];
    return {
      content: blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
      toolCalls: blocks
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, arguments: block.input || {} })),
      usage: data.usage,
      durationMs: Date.now() - started,
    };
  }

  if (provider === 'gemini') {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const data = await postJSON(
      `${config.llm.gemini.baseUrl}/models/${config.llm.gemini.model}:generateContent?key=${config.llm.gemini.apiKey}`,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: toGeminiContents(messages),
        ...(tools?.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((tool) => ({
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters,
                  })),
                },
              ],
            }
          : {}),
        generationConfig: { temperature: 0.2, maxOutputTokens: 2200 },
      },
    );
    const parts = data.candidates?.[0]?.content?.parts || [];
    return {
      content: parts.filter((part) => part.text).map((part) => part.text).join('\n'),
      toolCalls: parts
        .filter((part) => part.functionCall)
        .map((part, index) => ({
          id: `gemini_${Date.now()}_${index}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
        })),
      usage: data.usageMetadata,
      durationMs: Date.now() - started,
    };
  }

  if (provider === 'ollama') {
    const data = await postJSON(
      `${config.llm.ollama.baseUrl}/api/chat`,
      {
        model: config.llm.ollama.model,
        messages: toOllamaMessages(messages),
        ...(tools?.length ? { tools } : {}),
        stream: false,
        options: { temperature: 0.2 },
      },
      {},
      120_000,
    );
    const message = data.message || {};
    return {
      content: message.content || '',
      toolCalls: (message.tool_calls || []).map((call, index) => ({
        id: `ollama_${Date.now()}_${index}`,
        name: call.function?.name,
        arguments: parseArgs(call.function?.arguments),
      })),
      usage: { prompt_tokens: data.prompt_eval_count, completion_tokens: data.eval_count },
      durationMs: Date.now() - started,
    };
  }

  throw new Error(`Unsupported LLM provider "${provider}"`);
}
