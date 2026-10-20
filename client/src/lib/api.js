const BASE = '/api';

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const out = search.toString();
  return out ? `?${out}` : '';
};

export const api = {
  health: () => request('/health'),
  overview: () => request('/market/overview'),
  search: (q) => request(`/market/search${qs({ q })}`),
  fx: () => request('/market/fx'),
  quote: (symbol) => request(`/market/quote/${symbol}`),
  history: (symbol, range = '1y', interval = '1d') =>
    request(`/market/history/${symbol}${qs({ range, interval })}`),

  focus: (symbols) => request(`/focus${qs({ symbols: Array.isArray(symbols) ? symbols.join(',') : symbols })}`),
  research: (symbol, { ai = false, refresh = false } = {}) =>
    request(`/focus/${symbol}${qs({ ai: ai ? 1 : 0, refresh: refresh ? 1 : 0 })}`),
  deskAi: ({ symbols, refresh = false } = {}) =>
    request('/focus/ai', {
      method: 'POST',
      body: JSON.stringify({ symbols, refresh }),
    }),

  dayTrade: (symbol, { refresh = false, ai } = {}) =>
    request(`/daytrade/${symbol}${qs({ refresh: refresh ? 1 : undefined, ai: ai === undefined ? undefined : ai ? 1 : 0 })}`),
  analysis: (symbol, { options = true, persist = false, refresh = false } = {}) =>
    request(`/analysis/${symbol}${qs({ options: options ? 1 : 0, persist: persist ? 1 : 0, refresh: refresh ? 1 : 0 })}`),
  scan: (symbols) => request(`/scan${qs({ symbols: Array.isArray(symbols) ? symbols.join(',') : symbols })}`),
  hotStocks: ({ symbols, limit, scope, depth, refresh = false } = {}) =>
    request(
      `/hot-stocks${qs({
        symbols: Array.isArray(symbols) ? symbols.join(',') : symbols,
        limit,
        scope,
        depth,
        refresh: refresh ? 1 : undefined,
      })}`,
    ),
  hotStocksAi: ({ symbols, scope, depth, refresh = false } = {}) =>
    request('/hot-stocks/ai', {
      method: 'POST',
      body: JSON.stringify({
        symbols: Array.isArray(symbols) ? symbols : symbols ? String(symbols).split(',') : undefined,
        scope,
        depth,
        refresh,
      }),
    }),
  etfDesk: ({ ai = false, refresh = false } = {}) =>
    ai
      ? request('/etfs/ai', { method: 'POST', body: JSON.stringify({ refresh }) })
      : request(`/etfs${qs({ refresh: refresh ? 1 : undefined })}`),
  snapshots: (limit = 20) => request(`/snapshots${qs({ limit })}`),

  optionsIdeas: (symbols, { ai = false } = {}) =>
    request(
      `/options/ideas${qs({
        symbols: Array.isArray(symbols) ? symbols.join(',') : symbols,
        ai: ai ? 1 : undefined,
      })}`,
    ),
  expirations: (symbol) => request(`/options/${symbol}/expirations`),
  chain: (symbol, date) => request(`/options/${symbol}/chain${qs({ date })}`),
  optionsDesk: (symbol, { date, refresh = false } = {}) =>
    request(`/options/${symbol}/ai${qs({ date, refresh: refresh ? 1 : undefined })}`),
  evaluate: (payload) =>
    request('/options/evaluate', { method: 'POST', body: JSON.stringify(payload) }),

  portfolioParse: ({ fileName, content, holdings }) =>
    request('/portfolio/parse', { method: 'POST', body: JSON.stringify({ fileName, content, holdings }) }),
  portfolioExtractImage: ({ fileName, mimeType, data }) =>
    request('/portfolio/extract-image', {
      method: 'POST',
      body: JSON.stringify({ image: { fileName, mimeType, data } }),
    }),
  portfolioReview: ({ fileName, content, holdings }) =>
    request('/portfolio/review', { method: 'POST', body: JSON.stringify({ fileName, content, holdings }) }),

  watchlist: () => request('/watchlist'),
  addWatchlist: (symbol) => request('/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) }),
  removeWatchlist: (symbol) => request(`/watchlist/${symbol}`, { method: 'DELETE' }),

  agentStatus: () => request('/agent/status'),
  agentThreads: () => request('/agent/threads'),
  agentThread: (id) => request(`/agent/threads/${id}`),

  async chatStream({ message, threadId, symbol, attachment, image, onEvent, signal }) {
    const response = await fetch(`${BASE}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, threadId, symbol, attachment, image }),
      signal,
    });
    if (!response.ok) {
      const text = await response.text();
      let error = `${response.status} ${response.statusText}`;
      try {
        error = JSON.parse(text).error || error;
      } catch {
        /* keep default */
      }
      throw new Error(error);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const line = chunk
          .split('\n')
          .filter((item) => item.startsWith('data:'))
          .map((item) => item.slice(5).trim())
          .join('');
        if (!line) continue;
        try {
          onEvent(JSON.parse(line));
        } catch {
          /* ignore malformed keep-alive frames */
        }
      }
    }
  },
};
