import { useCallback, useEffect, useRef, useState } from 'react';
import LlmBadge from '../components/LlmBadge.jsx';
import Markdown from '../components/Markdown.jsx';
import PortfolioReview from '../components/PortfolioReview.jsx';
import { api } from '../lib/api.js';
import { convertMoneyText } from '../lib/currency.js';
import { timeAgo } from '../lib/format.js';

const TOOL_LABELS = {
  get_full_analysis: 'Full analysis',
  get_quote: 'Live quote',
  get_price_history: 'Price history',
  get_option_chain: 'Option chain',
  get_news: 'News',
  get_research_digest: 'Research digest',
  get_focus_board: 'Focus board',
  get_portfolio_review: 'Portfolio review',
  compare_symbols: 'Compare',
  search_symbol: 'Symbol search',
  get_market_overview: 'Market overview',
  evaluate_options_strategy: 'Strategy math',
};

const SUGGESTIONS = [
  { title: 'Single-stock plan', prompt: 'Give me a full trade plan for NVDA: verdict, buy zone, targets, stop and the best options structure.', tag: 'Analyze' },
  { title: 'Head-to-head', prompt: 'Compare AAPL, MSFT and NVDA — which has the best risk/reward right now and why?', tag: 'Compare' },
  { title: 'Income trade', prompt: 'What is the highest-probability defined-risk income trade on SPY right now? Show the legs and max loss.', tag: 'Options' },
  { title: 'Market regime', prompt: 'How is the market trading today? Give me breadth, VIX, leading sectors and what it means for risk.', tag: 'Macro' },
  {
    title: 'Portfolio check',
    prompt: 'Review my portfolio — what should I hold, trim or sell, and where is the risk?',
    tag: 'Upload',
    upload: true,
  },
  {
    title: 'Read a chart',
    prompt: 'Here is a chart. Read the trend, the visible levels and what you would do next.',
    tag: 'Image',
    image: true,
  },
];

const MAX_FILE_BYTES = 256 * 1024;
const ALLOWED_FILE = /\.(csv|tsv|txt|json)$/i;
const PORTFOLIO_PROMPT = 'Review my portfolio — what should I hold, trim or sell, and where is the risk?';
const IMAGE_PROMPT = 'What does this image show, and what should I take away from it?';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// Charts and broker screenshots come in huge; downscale before sending so the
// request stays small and the model is not billed for pixels it cannot use.
const MAX_IMAGE_EDGE = 1600;

/**
 * Read an image into a data URL, shrinking anything oversized. PNG stays PNG
 * when it is already small so chart text keeps its edges.
 */
function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => {
      const original = String(reader.result || '');
      const probe = new Image();
      probe.onerror = () => reject(new Error('That file is not a readable image.'));
      probe.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(probe.width, probe.height));
        if (scale === 1 && file.size <= MAX_IMAGE_BYTES) {
          resolve({ dataUrl: original, mimeType: file.type });
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(probe.width * scale));
        canvas.height = Math.max(1, Math.round(probe.height * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(probe, 0, 0, canvas.width, canvas.height);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.92), mimeType: 'image/jpeg' });
      };
      probe.src = original;
    };
    reader.readAsDataURL(file);
  });
}
const TEMPLATE_CSV = [
  'Ticker,Name,Quantity,Average cost,Currency',
  'AAPL,Apple Inc.,10,180.50,USD',
  'MSFT,Microsoft,5,400.25,USD',
  'SPY,SPDR S&P 500 ETF,4,520.00,USD',
].join('\n');

const uid = () => Math.random().toString(36).slice(2);

export default function AgentPage({ go, health }) {
  const querySymbol = new URLSearchParams(window.location.hash.split('?')[1] || '').get('symbol')?.toUpperCase() || '';
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [symbol, setSymbol] = useState(querySymbol);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [threadId, setThreadId] = useState(null);
  const [provider, setProvider] = useState(health?.agent || null);
  const [threads, setThreads] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [error, setError] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [image, setImage] = useState(null);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef(null);
  const endRef = useRef(null);
  const textareaRef = useRef(null);
  const fileRef = useRef(null);
  const imageRef = useRef(null);

  useEffect(() => {
    api.agentStatus().then(setProvider).catch(() => {});
    api
      .agentThreads()
      .then((data) => setThreads(data.threads || []))
      .catch(() => {});
  }, []);

  // The header polls /api/health; fold a changed provider/model into this page
  // without dropping the tool list that /api/agent/status returned.
  useEffect(() => {
    if (!health?.agent) return;
    setProvider((current) => ({ ...(current || {}), ...health.agent }));
  }, [health?.agent]);

  useEffect(() => {
    if (querySymbol) {
      setInput(`Give me a full trade plan for ${querySymbol} — verdict, buy zone, targets, stop and the best options structure.`);
    }
  }, [querySymbol]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, status]);

  const loadThread = async (id) => {
    try {
      const thread = await api.agentThread(id);
      setThreadId(thread.threadId);
      setMessages(
        (thread.messages || []).map((message) => ({
          id: uid(),
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
        })),
      );
      setWarnings([]);
      setAttachment(null);
      setImage(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    if (!ALLOWED_FILE.test(file.name)) {
      setAttachment({ name: file.name, status: 'error', error: 'Use a CSV, TSV, TXT or JSON holdings export.' });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setAttachment({ name: file.name, status: 'error', error: 'That file is larger than 256 KB.' });
      return;
    }
    setAttachment({ name: file.name, size: file.size, status: 'parsing' });
    setError('');
    try {
      const content = await file.text();
      // Parse on the server before sending, so a broker export with the wrong
      // columns is caught in the composer instead of failing mid-chat.
      const preview = await api.portfolioParse({ fileName: file.name, content });
      setAttachment({ name: file.name, size: file.size, content, preview, status: 'ready' });
      setInput((current) => current || PORTFOLIO_PROMPT);
      setSymbol('');
    } catch (err) {
      setAttachment({ name: file.name, size: file.size, status: 'error', error: err.message });
    }
  }, []);

  const handleImage = useCallback(async (file) => {
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      setImage({ name: file.name, status: 'error', error: 'Use a PNG, JPEG, WebP or GIF image.' });
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImage({ name: file.name, status: 'error', error: 'That image is larger than 4 MB.' });
      return;
    }
    setImage({ name: file.name, status: 'reading' });
    setError('');
    try {
      const converted = await readImage(file);
      const data = converted.dataUrl.split(',')[1] || '';
      setImage({
        name: file.name,
        mimeType: converted.mimeType,
        data,
        preview: converted.dataUrl,
        status: data ? 'ready' : 'error',
        error: data ? undefined : 'Could not read that image.',
      });
      setInput((current) => current || IMAGE_PROMPT);
    } catch (err) {
      setImage({ name: file.name, status: 'error', error: err.message });
    }
  }, []);

  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = event.dataTransfer.files?.[0];
    if (file?.type?.startsWith('image/')) handleImage(file);
    else handleFile(file);
  };

  const onDragOver = (event) => {
    event.preventDefault();
    if (!busy) setDragging(true);
  };

  const onDragLeave = (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'marketpilot-portfolio-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const startNew = () => {
    abortRef.current?.abort();
    setBusy(false);
    setMessages([]);
    setThreadId(null);
    setStatus('');
    setWarnings([]);
    setError('');
    setInput('');
    setAttachment(null);
    setImage(null);
  };

  const send = useCallback(
    async (rawText) => {
      const ready = attachment?.status === 'ready' && attachment.content ? attachment : null;
      const readyImage = image?.status === 'ready' && image.data ? image : null;
      const text = (rawText ?? input).trim() || (ready ? PORTFOLIO_PROMPT : readyImage ? IMAGE_PROMPT : '');
      if (!text || busy) return;
      const userMessage = {
        id: uid(),
        role: 'user',
        content: text,
        attachment: ready?.name || null,
        image: readyImage ? { name: readyImage.name, preview: readyImage.preview } : null,
        createdAt: new Date().toISOString(),
      };
      const assistantId = uid();
      setMessages((current) => [
        ...current,
        userMessage,
        { id: assistantId, role: 'assistant', content: '', tools: [], createdAt: new Date().toISOString() },
      ]);
      setInput('');
      setBusy(true);
      setStatus('Connecting…');
      setError('');
      setWarnings([]);
      const controller = new AbortController();
      abortRef.current = controller;

      const patchAssistant = (patch) => {
        setMessages((current) =>
          current.map((message) => (message.id === assistantId ? { ...message, ...patch } : message)),
        );
      };

      try {
        await api.chatStream({
          message: text,
          threadId,
          symbol: symbol || undefined,
          attachment: ready ? { fileName: ready.name, content: ready.content } : undefined,
          image: readyImage
            ? { fileName: readyImage.name, mimeType: readyImage.mimeType, data: readyImage.data }
            : undefined,
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'meta') {
              if (event.threadId) setThreadId(event.threadId);
              if (event.provider) setProvider((current) => ({ ...(current || {}), ...event.provider }));
              setStatus('Thinking…');
            } else if (event.type === 'status') {
              setStatus(event.message);
            } else if (event.type === 'tool') {
              setMessages((current) =>
                current.map((message) => {
                  if (message.id !== assistantId) return message;
                  const tools = (message.tools || []).map((tool) => ({ ...tool }));
                  if (event.status === 'running') {
                    tools.push({ id: uid(), name: event.name, args: event.args, status: 'running', summary: '' });
                  } else {
                    let index = -1;
                    for (let i = tools.length - 1; i >= 0; i -= 1) {
                      if (tools[i].name === event.name && tools[i].status === 'running') {
                        index = i;
                        break;
                      }
                    }
                    if (index === -1) {
                      for (let i = tools.length - 1; i >= 0; i -= 1) {
                        if (tools[i].name === event.name) {
                          index = i;
                          break;
                        }
                      }
                    }
                    const patch = { status: event.status, summary: event.summary || '' };
                    if (index >= 0) tools[index] = { ...tools[index], ...patch };
                    else tools.push({ id: uid(), name: event.name, ...patch });
                  }
                  return { ...message, tools };
                }),
              );
              setStatus(event.status === 'running' ? `Running ${TOOL_LABELS[event.name] || event.name}…` : 'Reviewing results…');
            } else if (event.type === 'portfolio') {
              patchAssistant({ portfolio: event.review });
              setStatus('Reviewing the book…');
            } else if (event.type === 'answer') {
              patchAssistant({ content: event.text });
              setStatus('');
            } else if (event.type === 'warning') {
              setWarnings((current) => [...current, event.message]);
            } else if (event.type === 'done') {
              patchAssistant({
                meta: {
                  provider: event.provider,
                  model: event.model,
                  rounds: event.rounds,
                  durationMs: event.durationMs,
                  tools: event.toolTrace,
                },
              });
              setStatus('');
            } else if (event.type === 'error') {
              patchAssistant({ content: `⚠️ ${event.message}` });
              setStatus('');
            }
          },
        });
      } catch (err) {
        if (err.name !== 'AbortError') {
          setError(err.message);
          patchAssistant({ content: `⚠️ ${err.message}` });
        }
      } finally {
        setBusy(false);
        setStatus('');
        abortRef.current = null;
        api
          .agentThreads()
          .then((data) => setThreads(data.threads || []))
          .catch(() => {});
      }
    },
    [attachment, busy, image, input, symbol, threadId],
  );

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
    setStatus('');
  };

  return (
    <div className="page agent-page">
      <section className="page-head">
        <div>
          <div className="eyebrow">AI RESEARCH AGENT</div>
          <h1>Ask the desk</h1>
          <p className="page-sub">
            An LLM analyst wired to live quotes, technicals, option chains and news. It shows every tool call, so you can audit the work.
          </p>
        </div>
        <div className="head-actions">
          <LlmBadge agent={provider} />
          <button type="button" className="btn btn-ghost" onClick={startNew}>
            + New chat
          </button>
        </div>
      </section>

      {!provider?.live && (
        <div className="alert alert-info">
          <strong>Running in built-in mode.</strong> The rule-based analyst works with live data but has no free-form reasoning and
          cannot read images. Add an API key (<code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, <code>GEMINI_API_KEY</code>{' '}
          or Ollama) to <code>.env</code> and restart the server for the full LLM agent with multi-step tool use and image input.
        </div>
      )}

      <div className="agent-layout">
        <section className="panel chat-panel">
          <div className="chat-scroll">
            {messages.length === 0 ? (
              <div className="chat-hero">
                <div className="agent-orb">✦</div>
                <h2>What do you want to know?</h2>
                <p>
                  The agent can score a ticker, compare names, read an option chain, size a trade and explain the invalidation level —
                  using the same engine as the analyzer. Attach a broker export and it reviews your actual holdings, weights and P/L,
                  or attach a chart screenshot and ask what it is telling you.
                </p>
                <div className="suggestion-grid">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion.title}
                      type="button"
                      className="suggestion-card"
                      onClick={() => {
                        if (suggestion.upload) fileRef.current?.click();
                        else if (suggestion.image) imageRef.current?.click();
                        else send(suggestion.prompt);
                      }}
                    >
                      <span className="suggestion-tag">{suggestion.tag}</span>
                      <strong>{suggestion.title}</strong>
                      <span>{suggestion.prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <div key={message.id} className={`message ${message.role}`}>
                  <div className="message-avatar">{message.role === 'assistant' ? '✦' : 'You'}</div>
                  <div className="message-body">
                    {message.tools?.length > 0 && (
                      <div className="tool-trace">
                        {message.tools.map((tool) => (
                          <div key={tool.id} className={`tool-chip ${tool.status}`} title={tool.summary || ''}>
                            <span className="tool-dot" />
                            <span>{TOOL_LABELS[tool.name] || tool.name}</span>
                            {tool.status === 'running' && <span className="tool-running">running…</span>}
                            {tool.status === 'done' && tool.summary && (
                              <span className="tool-summary">{convertMoneyText(tool.summary)}</span>
                            )}
                            {tool.status === 'error' && <span className="tool-summary">failed</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {message.role === 'assistant' && message.portfolio && (
                      <PortfolioReview data={message.portfolio} />
                    )}
                    {message.role === 'assistant' && message.content ? (
                      <Markdown text={message.content} />
                    ) : message.role === 'user' ? (
                      <>
                        {message.attachment && (
                          <div className="message-file">📄 {message.attachment}</div>
                        )}
                        {message.image?.preview && (
                          <img className="message-image" src={message.image.preview} alt={message.image.name || 'Attached image'} />
                        )}
                        <p className="user-text">{message.content}</p>
                      </>
                    ) : (
                      <div className="typing">
                        <span />
                        <span />
                        <span />
                      </div>
                    )}
                    {message.meta && (
                      <div className="message-meta">
                        {message.meta.model || message.meta.provider} · {message.meta.rounds} pass
                        {message.meta.rounds === 1 ? '' : 'es'} · {Math.round((message.meta.durationMs || 0) / 100) / 10}s
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}

            {busy && messages.length > 0 && (
              <div className="chat-status">
                <span className="pulse-dot" />
                {status || 'Working…'}
              </div>
            )}
            {warnings.map((warning, index) => (
              <div key={index} className="alert alert-warn tiny">
                {warning}
              </div>
            ))}
            {error && <div className="alert alert-error tiny">{error}</div>}
            <div ref={endRef} />
          </div>

          <div
            className={`composer ${dragging ? 'dragging' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <input
              ref={fileRef}
              type="file"
              className="file-input"
              accept=".csv,.tsv,.txt,.json,text/csv,application/json"
              onChange={(event) => {
                handleFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <input
              ref={imageRef}
              type="file"
              className="file-input"
              accept={IMAGE_TYPES.join(',')}
              onChange={(event) => {
                handleImage(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            {image && (
              <div className={`attachment-chip image ${image.status || ''}`}>
                {image.preview ? (
                  <img className="attachment-thumb" src={image.preview} alt={image.name} />
                ) : (
                  <span className="attachment-icon">🖼️</span>
                )}
                <div className="attachment-copy">
                  <strong>{image.name}</strong>
                  <span>
                    {image.status === 'reading' && 'Reading image…'}
                    {image.status === 'error' && image.error}
                    {image.status === 'ready' &&
                      (provider?.live && provider?.vision === false
                        ? 'This model cannot read images — set a vision model first'
                        : 'Image attached — it stays with this conversation')}
                  </span>
                </div>
                <button
                  type="button"
                  className="attachment-remove"
                  title="Remove image"
                  onClick={() => setImage(null)}
                  disabled={busy}
                >
                  ×
                </button>
              </div>
            )}
            {attachment && (
              <div className={`attachment-chip ${attachment.status || ''}`}>
                <span className="attachment-icon">📄</span>
                <div className="attachment-copy">
                  <strong>{attachment.name}</strong>
                  <span>
                    {attachment.status === 'parsing' && 'Reading file…'}
                    {attachment.status === 'error' && attachment.error}
                    {attachment.status === 'ready' &&
                      `${attachment.preview.positions.length} position${
                        attachment.preview.positions.length === 1 ? '' : 's'
                      } · ${attachment.preview.positions.slice(0, 3).map((position) => position.symbol).join(', ')}${
                        attachment.preview.cash.length ? ' · cash included' : ''
                      }`}
                  </span>
                  {attachment.status === 'ready' && attachment.preview.warnings?.length > 0 && (
                    <span className="attachment-warning">{attachment.preview.warnings[0]}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="attachment-remove"
                  title="Remove file"
                  onClick={() => setAttachment(null)}
                  disabled={busy}
                >
                  ×
                </button>
              </div>
            )}
            {symbol && (
              <div className="context-chip">
                Focus: <strong>{symbol}</strong>
                <button type="button" onClick={() => setSymbol('')} title="Clear focus">
                  ×
                </button>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about a ticker, compare names, build an options trade — or drop a chart screenshot or portfolio CSV here…"
              rows={2}
              disabled={busy}
            />
            <div className="composer-actions">
              <div className="composer-tools">
                <button
                  type="button"
                  className="attach-btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  title="Attach a portfolio export (CSV, TSV or JSON)"
                >
                  📎 Portfolio
                </button>
                <button
                  type="button"
                  className="attach-btn"
                  onClick={() => imageRef.current?.click()}
                  disabled={busy}
                  title="Attach an image — a chart screenshot, a broker page or a position table"
                >
                  🖼️ Image
                </button>
                <span className="composer-hint">
                  {image?.status === 'ready'
                    ? 'Image attached — ask anything about it'
                    : attachment?.status === 'ready'
                      ? 'Attached — ask anything about the book'
                      : 'PNG, JPEG, WebP or GIF · CSV, TSV or JSON'}
                </span>
              </div>
              {busy ? (
                <button type="button" className="btn btn-ghost" onClick={stop}>
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => send()}
                  disabled={
                    busy ||
                    attachment?.status === 'parsing' ||
                    image?.status === 'reading' ||
                    (!input.trim() && attachment?.status !== 'ready' && image?.status !== 'ready')
                  }
                >
                  Send ↑
                </button>
              )}
            </div>
            {dragging && <div className="composer-drop">Drop a chart image or portfolio file to attach it</div>}
          </div>
        </section>

        <aside className="agent-rail">
          <section className="panel">
            <div className="eyebrow">AGENT STATUS</div>
            <div className="agent-status">
              <div className={`status-orb ${provider?.live ? 'live' : ''}`} />
              <div>
                <strong>{provider?.live ? provider.provider : 'Built-in analyst'}</strong>
                <div className="muted small">{provider?.model || 'MarketPilot rule engine'}</div>
              </div>
            </div>
            <div className="tool-list">
              {(provider?.tools || Object.keys(TOOL_LABELS)).map((tool) => (
                <span key={tool} className="tool-pill">
                  {TOOL_LABELS[tool] || tool}
                </span>
              ))}
            </div>
            <div className="rail-note">
              Every answer is generated from live data pulled through these tools — not from the model's memory.
            </div>
          </section>

          <section className="panel">
            <div className="eyebrow">PORTFOLIO</div>
            <button
              type="button"
              className="btn btn-ghost pf-upload"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              {attachment?.status === 'ready' ? 'Replace holdings file' : 'Upload holdings file'}
            </button>
            {attachment?.status === 'ready' ? (
              <div className="pf-rail-summary">
                <strong>{attachment.name}</strong>
                <span>
                  {attachment.preview.positions.length} position
                  {attachment.preview.positions.length === 1 ? '' : 's'} ·{' '}
                  {attachment.preview.positions.slice(0, 4).map((position) => position.symbol).join(', ')}
                </span>
                {attachment.preview.parsedRows > attachment.preview.positions.length && (
                  <span className="muted">Cash / ignored rows included in the export</span>
                )}
              </div>
            ) : (
              <p className="rail-note">
                A CSV, TSV or JSON export from your broker. The server parses and prices it; only the resulting positions are
                given to the model, and the chat keeps the book for follow-up questions.
              </p>
            )}
            <button type="button" className="link-btn pf-template" onClick={downloadTemplate}>
              Download CSV template
            </button>
          </section>

          <section className="panel">
            <div className="eyebrow">FOCUS SYMBOL</div>
            <input
              className="symbol-input"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase().slice(0, 10))}
              placeholder="e.g. AAPL"
            />
            <p className="rail-note">Pins the conversation to one ticker. You can still ask about others.</p>
          </section>

          <section className="panel">
            <div className="panel-head tight">
              <div className="eyebrow">RECENT THREADS</div>
              <button type="button" className="link-btn" onClick={() => go('/agent')}>
                new
              </button>
            </div>
            {threads.length ? (
              <div className="thread-list">
                {threads.slice(0, 6).map((thread) => (
                  <button
                    key={thread.threadId}
                    type="button"
                    className={`thread-item ${thread.threadId === threadId ? 'active' : ''}`}
                    onClick={() => loadThread(thread.threadId)}
                  >
                    <span>{thread.title}</span>
                    <small>{timeAgo(thread.updatedAt)}</small>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-note">Your conversations will appear here.</div>
            )}
          </section>

          <section className="panel rail-disclaimer">
            <strong>Risk note</strong>
            <p>
              The agent can be wrong and does not know your financial situation. Targets are probabilistic levels, not promises. Always
              use position sizing and stops.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
