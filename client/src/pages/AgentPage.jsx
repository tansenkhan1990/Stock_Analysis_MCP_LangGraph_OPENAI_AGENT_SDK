import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from '../components/Markdown.jsx';
import { api } from '../lib/api.js';
import { convertMoneyText } from '../lib/currency.js';
import { timeAgo } from '../lib/format.js';

const TOOL_LABELS = {
  get_full_analysis: 'Full analysis',
  get_quote: 'Live quote',
  get_price_history: 'Price history',
  get_option_chain: 'Option chain',
  get_news: 'News',
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
];

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
  const abortRef = useRef(null);
  const endRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    api.agentStatus().then(setProvider).catch(() => {});
    api
      .agentThreads()
      .then((data) => setThreads(data.threads || []))
      .catch(() => {});
  }, []);

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
    } catch (err) {
      setError(err.message);
    }
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
  };

  const send = useCallback(
    async (rawText) => {
      const text = (rawText ?? input).trim();
      if (!text || busy) return;
      const userMessage = { id: uid(), role: 'user', content: text, createdAt: new Date().toISOString() };
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
    [busy, input, symbol, threadId],
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
          <div className={`provider-chip ${provider?.live ? 'live' : ''}`}>
            <span className="status-dot" />
            {provider?.live ? `${provider.provider} · ${provider.model}` : 'Built-in analyst'}
          </div>
          <button type="button" className="btn btn-ghost" onClick={startNew}>
            + New chat
          </button>
        </div>
      </section>

      {!provider?.live && (
        <div className="alert alert-info">
          <strong>Running in built-in mode.</strong> The rule-based analyst works with live data but has no free-form reasoning. Add an
          API key (<code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, <code>GEMINI_API_KEY</code> or Ollama) to{' '}
          <code>.env</code> and restart the server for the full LLM agent with multi-step tool use.
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
                  using the same engine as the analyzer.
                </p>
                <div className="suggestion-grid">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion.title}
                      type="button"
                      className="suggestion-card"
                      onClick={() => send(suggestion.prompt)}
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
                    {message.role === 'assistant' && message.content ? (
                      <Markdown text={message.content} />
                    ) : message.role === 'user' ? (
                      <p className="user-text">{message.content}</p>
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

          <div className="composer">
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
              placeholder="Ask about a ticker, compare names, or build an options trade…"
              rows={2}
              disabled={busy}
            />
            <div className="composer-actions">
              <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
              {busy ? (
                <button type="button" className="btn btn-ghost" onClick={stop}>
                  Stop
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => send()} disabled={!input.trim()}>
                  Send ↑
                </button>
              )}
            </div>
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
