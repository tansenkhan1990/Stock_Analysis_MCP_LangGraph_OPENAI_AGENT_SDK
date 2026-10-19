import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { MAX_UPLOAD_BYTES } from '../analytics/portfolio.js';
import { runAgent } from '../agent/agent.js';
import { describeProvider } from '../agent/providers.js';
import { TOOL_DEFINITIONS } from '../agent/tools.js';
import { parseImageAttachment } from '../agent/vision.js';
import { asyncHandler, badRequest } from '../lib/errors.js';
import {
  appendMessages,
  createThread,
  getThread,
  getThreadImage,
  getThreadPortfolio,
  listThreads,
  saveThreadImage,
  saveThreadPortfolio,
} from '../lib/store.js';
import { parsePortfolioUpload, reviewPortfolio } from '../services/portfolioService.js';

export const agentRouter = Router();

const DEFAULT_PORTFOLIO_PROMPT =
  'Review my portfolio — what should I hold, trim or sell, and where is the risk?';
const DEFAULT_IMAGE_PROMPT =
  'What does this image show, and what should I take away from it?';

/** Validate an uploaded holdings file without touching the market. */
function readAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fileName = typeof raw.fileName === 'string' ? raw.fileName.slice(0, 120) : 'portfolio.csv';
  const content = typeof raw.content === 'string' ? raw.content : '';
  if (!content.trim()) throw badRequest('The attached portfolio file is empty.');
  if (Buffer.byteLength(content, 'utf8') > MAX_UPLOAD_BYTES) {
    throw badRequest('Portfolio file is too large (max 256 KB).');
  }
  try {
    return { fileName, content, parsed: parsePortfolioUpload({ fileName, content }) };
  } catch (error) {
    throw badRequest(error.message);
  }
}

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
    const attachment = readAttachment(req.body?.attachment);
    const image = parseImageAttachment(req.body?.image);
    const rawMessage = String(req.body?.message || '').trim();
    const message = rawMessage || (attachment ? DEFAULT_PORTFOLIO_PROMPT : image ? DEFAULT_IMAGE_PROMPT : '');
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
        title: (attachment
          ? `Portfolio review — ${attachment.parsed.fileName}`
          : image
            ? `Image — ${image.fileName}`
            : message
        ).slice(0, 70),
        provider: describeProvider().provider,
      });
    }

    // An image stays with the thread: a follow-up question about the same chart
    // should not need the file uploaded again. A new upload replaces it, and
    // an unrelated later question can start a new chat to drop it.
    let activeImage = image;
    if (image) await saveThreadImage(threadId, image);
    else activeImage = await getThreadImage(threadId);
    const imageFromHistory = Boolean(activeImage) && !image;

    // A newly uploaded file replaces the thread's book; otherwise follow-up
    // questions keep using the last portfolio the user attached.
    const portfolioSource = attachment
      ? await saveThreadPortfolio(threadId, attachment.parsed)
      : await getThreadPortfolio(threadId);

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
      image: activeImage ? { fileName: activeImage.fileName, fromHistory: imageFromHistory } : null,
      startedAt: new Date().toISOString(),
    });

    const started = Date.now();
    try {
      let portfolioReview = null;
      if (portfolioSource) {
        try {
          portfolioReview = await reviewPortfolio(portfolioSource, { emit: send });
          send({ type: 'portfolio', review: portfolioReview });
        } catch (error) {
          console.error('[portfolio]', error);
          send({ type: 'warning', message: `Portfolio review failed: ${error.message}` });
        }
      }

      const result = await runAgent({
        message,
        history: thread.messages || [],
        symbol,
        emit: send,
        portfolioReview,
        image: activeImage,
        imageFromHistory,
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

      const notes = [
        attachment ? `[Attached portfolio: ${attachment.parsed.fileName} — ${attachment.parsed.positions.length} positions]` : null,
        image ? `[Attached image: ${image.fileName}]` : null,
      ].filter(Boolean);
      const userContent = notes.length ? `${message}\n\n${notes.join('\n')}` : message;
      await appendMessages(
        threadId,
        [
          { role: 'user', content: userContent },
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
