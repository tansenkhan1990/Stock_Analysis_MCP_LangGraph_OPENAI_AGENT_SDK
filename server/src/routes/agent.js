import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { runAgent } from '../agent/agent.js';
import { describeProvider } from '../agent/providers.js';
import { TOOL_DEFINITIONS } from '../agent/tools.js';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { appendMessages, createThread, getThread, listThreads } from '../lib/store.js';

export const agentRouter = Router();

agentRouter.get('/status', (req, res) => {
  res.json({ ...describeProvider(), tools: TOOL_DEFINITIONS.map((tool) => tool.function.name) });
});

agentRouter.get(
  '/threads',
  asyncHandler(async (req, res) => {
    res.json({ threads: await listThreads(20) });
  }),
);

agentRouter.get(
  '/threads/:id',
  asyncHandler(async (req, res) => {
    const thread = await getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json(thread);
  }),
);

agentRouter.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) throw badRequest('Message is required');
    if (message.length > 4000) throw badRequest('Message is too long (max 4000 characters)');

    const symbol =
      typeof req.body?.symbol === 'string' && /^[A-Z0-9.^=-]{1,15}$/i.test(req.body.symbol.trim())
        ? req.body.symbol.trim().toUpperCase()
        : null;

    let threadId = typeof req.body?.threadId === 'string' ? req.body.threadId : null;
    if (!threadId) threadId = randomUUID();

    let thread = null;
    try {
      thread = await getThread(threadId);
    } catch {
      thread = null;
    }
    if (!thread) {
      thread = await createThread({
        threadId,
        title: message.slice(0, 70),
        provider: describeProvider().provider,
      });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    const send = (event) => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({
      type: 'meta',
      threadId,
      provider: describeProvider(),
      startedAt: new Date().toISOString(),
    });

    const started = Date.now();
    try {
      const result = await runAgent({
        message,
        history: thread.messages || [],
        symbol,
        emit: send,
      });

      send({ type: 'answer', text: result.text });
      send({
        type: 'done',
        threadId,
        provider: result.provider,
        model: result.model,
        rounds: result.rounds,
        toolTrace: result.toolTrace,
        usage: result.usage,
        durationMs: Date.now() - started,
      });

      await appendMessages(
        threadId,
        [
          { role: 'user', content: message },
          { role: 'assistant', content: result.text },
        ],
        { title: thread.title || message.slice(0, 70), provider: result.provider },
      );
    } catch (error) {
      console.error('[agent]', error);
      send({ type: 'error', message: error.message || 'The agent failed to respond' });
    } finally {
      if (!closed) res.end();
    }
  }),
);
