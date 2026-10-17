# MarketPilot — AI Stock & ETF Analyst with an Options Lab

MarketPilot turns live Yahoo Finance data into a transparent, actionable trade plan. It scores any stock or ETF, produces a **buy zone, three sell targets and a stop**, surfaces **defined-risk options structures**, and lets you interrogate all of it through an **LLM agent with real tool calling**.

> Educational research only. Not investment advice. Markets can gap through stops and options can expire worthless.

---

## What you get

| Area | Capability |
| --- | --- |
| Market dashboard | Index tape (SPY, QQQ, DIA, IWM, VIX, 10Y), sector breadth, risk regime, watchlist, scored signal board |
| Analyzer | 0–100 multi-factor score, confidence, buy zone, T1/T2/T3 targets, stop, reward:risk, position sizing, candlestick chart with SMA/RSI/volume, level map, fundamentals, news |
| Options Lab | Live chain, ATM IV, IV vs realised vol, expected move, max pain, put/call ratio, contract-level liquidity, strategy builder with expiry payoff, breakevens, probability of profit and greeks |
| Options ideas | One-click scan of your watchlist: best defined-risk structure per name (IV state, expected move, credit/debit, max loss, probability of profit) loadable straight into the builder |
| Focus board | Buy & sell signals on your editable focus list, seeded with **NVDA, MSFT, AMZN, GOOGL, PLTR, TSLA, AMD, TSM**, option-tradable ETFs (**SPY, QQQ, IWM, SMH, TLT, GLD**) and the Shariah-screened **ISDW.L** (iShares MSCI World Islamic UCITS ETF, IE00B27YCN58, USD on LSE). Add any other stock or ETF from the search box and remove names with ×. The action is a validated regime rule (buy pullbacks in an uptrend, exit on a trend break), shaped by news, deals, Street actions and earnings risk, with both triggers on every card: **BUY ABOVE** and **SELL BELOW** |
| Deep research / AI desk | Per-name dossier (price structure, article text, deals, upgrades, earnings risk, option pricing) → BUY / ACCUMULATE / HOLD / REDUCE / SELL with thesis, upside drivers, downside risks, catalysts, invalidation and an options expression. “Run AI desk on all” does the whole board in one pass |
| AI Agent | Streaming chat with visible tool traces. Tools: full analysis, quote, history, option chain, news, comparison, symbol search, market overview, strategy evaluation |
| News & deal archive | MongoDB stores every Yahoo Finance headline and business-deal story it sees, plus a daily sentiment digest per symbol. A daily job refreshes the archive; the app reads 7/30-day trends from it |
| Session state | Watchlist, saved research snapshots and agent threads held in memory for the lifetime of the server |

Supported instruments: US-listed **stocks** and **ETFs**, plus international listings with a Yahoo ticker (e.g. `ISDW.L`), with options where Yahoo provides a chain.

---

## Architecture

```
React 19 + Vite (client)
        │  /api/*  (Vite proxy in dev, Express static in prod)
        ▼
Express 5 API
   ├── Yahoo Finance service ── TTL cache + in-flight de-dupe + 429 retry + concurrency gate
   ├── Analytics engine ────── indicators → scoring → levels → targets → risk plan
   ├── Options engine ──────── chain analytics → Black-Scholes greeks → payoff simulator
   ├── AI agent ────────────── provider adapters (OpenAI-compatible / Anthropic / Gemini / Ollama)
   │                           + 9 live-data tools + built-in rule-based fallback
   ├── Store ───────────────── in-memory watchlist, snapshots and threads
   └── MongoDB ─────────────── news/deal archive + daily sentiment digests (optional)
```

### Scoring model (0–100)

| Factor | Weight | Inputs |
| --- | --- | --- |
| Trend structure | 30% | Price vs SMA20/50/200, SMA alignment, ADX, SMA50 slope |
| Momentum | 25% | RSI regime, MACD line/signal/histogram, stochastic, 3-month relative strength vs SPY |
| Volume confirmation | 10% | 5d/50d volume ratio, OBV slope, up-volume bias |
| Risk profile | 10% | Annualised volatility, drawdown, beta, ATR% |
| Valuation / fund quality | 15% | PEG, P/E, forward P/E, margin, revenue growth, analyst target (ETFs: expense ratio, YTD, range position) |
| Street sentiment | 10% | Analyst recommendation mean + mean price target |

Missing factors are dropped and the remaining weights renormalised. The score is a **quality** read only — it never sets the action. Quality tiers:
`≥78 Excellent`, `≥66 Strong`, `≥56 Above average`, `≥45 Average`, `≥35 Weak`, else `Poor`.

### How the buy/sell action is decided

Two different things are reported, on purpose:

1. **Action (timing)** — a regime rule in `analytics/alert.js`.
2. **Quality (0–100)** — the fused score: price structure 50%, Yahoo news-flow sentiment 20%, Street upgrades/downgrades 15%, business deals/catalysts 15%. It answers “is this a good business/setup”, not “is now the moment”.

| Action | Setup | Rule |
| --- | --- | --- |
| **Buy** | Uptrend pullback | Price > 200-day, 50-day > 200-day, RSI ≤ 45 |
| **Accumulate** | Trend continuation | Same uptrend, RSI 45–58 (staged entry) |
| **Hold** | Extended uptrend | Same uptrend, RSI > 58 — don't chase |
| **Reduce** | Mixed / transition | 50-day and 200-day disagree |
| **Sell** | Trend break | Price and 50-day both below the 200-day — **exit, not a short forecast** |

Guardrails downgrade new entries (never below Hold): earnings within 3 days, or news sentiment ≤ −35 across ≥4 headlines. Positive news flow and an improving archived 7-day trend raise conviction. Stocks and ETFs use the same rule; only the quality inputs differ (ETFs get fund quality instead of valuation).

**Two-sided triggers.** Every card carries a long trigger (`BUY ABOVE` — zone ceiling or a breakout capped at ~1.5 ATR) and an exit trigger (`SELL BELOW` — first support beneath spot, or the hard stop on a bearish plan). When an LLM makes the call it may move either level, but a level on the wrong side of spot is rejected and the rule-engine level kept.

### Validating the signals (read this before trading them)

`npm run validate` replays the **shipped alert rule** over five years of daily bars for every focus name, splits the data in half chronologically, and prints forward returns plus calendar-year stability. Current measurement:

| bucket | n | fwd 10d | win 10d | P(<−8% in 10d) |
| --- | --- | --- | --- | --- |
| baseline (all days) | 13,636 | +1.65% | 58% | 11.2% |
| **buy** | 1,456 | **+2.28%** | **62%** | 11.3% |
| accumulate | 3,748 | +1.12% | 55% | 11.8% |
| hold | 4,062 | +1.51% | 59% | 9.5% |
| reduce | 1,666 | +1.71% | 60% | 10.9% |
| sell | 2,704 | +2.23% | 60% | 13.0% |

- **Buy edge:** +0.63pp over five years, +1.09pp in the first half, +0.12pp in the second half. Positive in 3 of 4 calendar years (+1.02, +1.17, −0.45, +0.24). Real but thin and regime-dependent.
- **By instrument:** stocks' buy days returned +2.57% vs +2.22% baseline; ETFs' +1.80% vs +0.89% (ETF pullbacks were the cleaner signal, and ETF sell days carried *lower* tail risk than baseline while stock sell days carried higher — another reason the sell side is framed as risk control).
- **Sell has no predictive edge** — trend-break days were followed by *above-baseline* returns. That is why the app labels `Sell` as a risk exit, not a forecast, and why the replay reports tail risk instead of pretending otherwise.

This is a disciplined way to structure a trade (levels, stop, size, options), **not a proven alpha engine**. The replay cannot include news, deals or Street history, and the sample is a bull market for these names.

### How levels are built

1. **Supports / resistances** — clustered swing pivots (left/right 4 bars, 1.2% tolerance) combined with SMA20/50/200, Bollinger bands and the 52-week extremes.
2. **Buy zone** — anchored to the nearest support within 8% of spot, widened by ATR; no long zone when the score is bearish.
3. **Targets** — nearest resistances, 52-week high, analyst consensus and ATR projections, spaced by at least 0.5 ATR. Always three tiers, each with an estimated probability.
4. **Stop** — support minus 0.6 ATR, clamped to a 3–12% band.
5. **Reward:risk** — measured from the **planned entry** (mid of the zone), not from spot, so chasing price is penalised.
6. **Sizing** — shares for a 1% risk budget on a $10,000 account.

### Options engine

- Chain analytics: ATM implied volatility, IV/realised-vol ratio, expected move (±1σ), straddle price, max pain, put/call OI & volume, 25-delta-ish skew proxy, liquidity score.
- Strategy selection follows the alert, not the quality score: **buy / accumulate** → bull put spread (rich IV) or bull call spread / long call (cheap IV); **sell / reduce** → bear call or bear put spread; **hold** → income only (iron condor when IV is rich), never a new directional position. Every plan carries a `bias`, and the ideas board/research decision only shows a structure that matches the alert — a sell call never ships with a bullish spread.
- Payoff engine: expiry P/L per 100-share contract, max profit/loss (with unbounded detection), interpolated breakevens, net debit/credit, return on risk, probability of profit via a lognormal approximation, and net delta/gamma/theta/vega from Black-Scholes.

---

## Quick start

Requirements: **Node.js 20+** (tested on Node 26) and npm.

```bash
git clone <your-repo> marketpilot
cd marketpilot

npm run install:all      # root + server + client
cp .env.example .env     # optional but recommended

npm run dev              # API :4000 + Vite :5173
```

Open <http://localhost:5173>.

The app runs with **no API keys at all**:
- Yahoo Finance needs no key.
- Without an LLM key the agent runs in **built-in analyst** mode (rule-based, still uses live data).
- MongoDB is optional at runtime: without it the app still scores, researches and serves options; only the news archive is unavailable.

### MongoDB + Docker (news & deal archive)

Prices and option chains are always read live from Yahoo. MongoDB stores the part Yahoo does not keep for you: the headlines and business deals themselves, one row per story plus a per-symbol daily sentiment digest. That is what makes a 7-day news trend possible.

```bash
docker compose up -d --build     # mongo + the dockerised backend
```

- App (API + built UI): <http://localhost:4000>
- MongoDB: `localhost:27017/marketpilot`, persisted in the `mongo-data` volume
- The API container runs the daily archive job: once shortly after boot, then daily after `NEWS_INGEST_HOUR` (default 18:00 local).

Running without Docker:

```bash
docker run -d --name marketpilot-mongo -p 27017:27017 -v marketpilot-mongo:/data/db mongo:7
npm run dev
```

Archive commands:

```bash
npm run ingest                  # collect now (all focus symbols)
npm run ingest -- NVDA,MSFT     # subset
curl localhost:4000/api/news/status
curl localhost:4000/api/news/NVDA/history?days=30
curl localhost:4000/api/news/NVDA/deals?days=90
curl -X POST localhost:4000/api/news/ingest -H 'content-type: application/json' -d '{}'
```

The archive is idempotent (deduplicated on the article URL), so re-running it never duplicates rows. Watchlist edits, saved snapshots and agent threads still live in the API process.

### LLM agent (optional)

`LLM_PROVIDER=auto` picks the first configured provider, otherwise the built-in analyst.

| Provider | Env vars | Notes |
| --- | --- | --- |
| OpenAI / compatible | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | Any OpenAI-compatible gateway works (OpenLLM, OpenRouter, Groq, Together, vLLM) |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Native tool-use API |
| Google Gemini | `GEMINI_API_KEY`, `GEMINI_MODEL` | Function declarations |
| Ollama | `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Fully local, no key |

Restart the API after changing `.env`. The agent's badge in the header turns green and shows the model name when a live LLM is active. Tool calls are streamed to the UI as they happen; provider failures fall back to the built-in analyst with a warning.

For an OpenAI-compatible gateway such as [OpenLLM](https://openllm.sh), set:

```dotenv
LLM_PROVIDER=openai
OPENAI_API_KEY=<gateway key>
OPENAI_BASE_URL=https://api.openllm.sh/v1
OPENAI_MODEL=<model routed by the gateway>
```

For **OpenRouter**, keep the same three variables and point them at OpenRouter:

```dotenv
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-or-v1-...          # https://openrouter.ai/keys
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=deepseek/deepseek-v4-pro
```

The model has to do two different jobs here: read a numbers-heavy dossier and return one strict JSON decision (deep research), and drive the agent’s nine live-data tools (tool calling). `deepseek/deepseek-v4-pro` is the default recommendation — strongest reasoning-per-dollar for multi-company comparison and sentiment attribution — with `deepseek/deepseek-v4.1-flash` as the cheaper option and `anthropic/claude-sonnet-4.6` when you want maximum judgement and don’t mind roughly 20x the token cost. Any model in OpenRouter’s tool-calling + structured-output sets works; swap the ID and restart.

A wrong or expired key does not break the app: the header badge stays on the rule engine and each research call reports `decisionError` with the provider’s message.

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run Express + Vite together |
| `npm run dev:api` / `npm run dev:web` | Run one side only |
| `npm test` | Node test runner: indicators, scoring/plan engine, alert rule, news analytics, options math |
| `npm run build` | Build the React client into `client/dist` |
| `npm start` | Serve API + built client on `:4000` |

After `npm run build`, `npm start` serves the SPA from Express (single-origin deploy).

---

## API

### Market
| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/health` | Uptime, storage mode, active LLM provider, record counts |
| GET | `/api/market/overview` | Indices, sectors, breadth, VIX regime |
| GET | `/api/market/search?q=apple` | Symbol search |
| GET | `/api/market/quote/:symbol` | Live quote |
| GET | `/api/market/history/:symbol?range=1y&interval=1d` | OHLCV bars |

### News archive
| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/news/status` | Mongo connection, item/deal/digest counts, last ingest result |
| GET | `/api/news/:symbol/history?days=30` | Daily sentiment digests, 7-day vs prior-week trend, deal count |
| GET | `/api/news/:symbol/deals?days=90` | Archived business-deal stories |
| GET | `/api/news/:symbol/items?limit=50` | Archived headlines (deduplicated by URL) |
| POST | `/api/news/ingest` | Run the archive now (`{"symbols":["NVDA"],"force":true}`) |

### Analysis
| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/analysis/:symbol?options=1&persist=0&refresh=0` | Full scored analysis + plan + option ideas + news |
| GET | `/api/scan?symbols=AAPL,NVDA` | Scored signal board (max 24 symbols) |
| GET | `/api/snapshots` | Recent saved research |
| GET | `/api/snapshots/:symbol` | Latest saved analysis payload |

### Focus research
| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/focus?symbols=AAPL,SPY` | Focus board: fused buy/sell signals, news + deal read, two-sided triggers for every name (defaults to the watchlist) |
| GET | `/api/focus/:symbol?ai=1` | Deep research: dossier, headline/deal evidence, decision + option expression (`ai=1` uses the LLM) |
| POST | `/api/focus/ai` | Desk pass — runs the decision engine (LLM when a key is set, rules otherwise) across the board. Body: `{ "symbols": ["NVDA"], "refresh": false }` |

### Options
| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/options/:symbol/expirations` | Expiry calendar |
| GET | `/api/options/:symbol/chain?date=YYYY-MM-DD` | Chain + analytics |
| GET | `/api/options/ideas?symbols=AAPL,SPY` | Best defined-risk structure per symbol (defaults to the watchlist) |
| POST | `/api/options/evaluate` | Payoff/greeks for any leg set |

Example evaluation body:

```json
{
  "symbol": "AAPL",
  "iv": 0.28,
  "dte": 35,
  "legs": [
    { "kind": "call", "action": "buy", "strike": 345, "premium": 8.1 },
    { "kind": "call", "action": "sell", "strike": 360, "premium": 3.4 }
  ]
}
```

### Watchlist & agent
| Method | Route | Description |
| --- | --- | --- |
| GET/POST | `/api/watchlist` | List / add `{ "symbol": "AMD" }` — drives the Focus board, dashboard scan and options ideas |
| DELETE | `/api/watchlist/:symbol` | Remove from the focus list |
| GET | `/api/agent/status` | Provider, model, tool list |
| POST | `/api/agent/chat` | **SSE stream**: `{ message, threadId?, symbol? }` |
| GET | `/api/agent/threads` | Recent conversations |
| GET | `/api/agent/threads/:id` | Full thread |

SSE event types: `meta`, `status`, `tool` (running/done/error), `answer`, `warning`, `done`, `error`.

---

## Docker

| File | Purpose |
| --- | --- |
| `server/Dockerfile` | Multi-stage: builds the React client, installs production server deps, runs the API with a healthcheck |
| `docker-compose.yml` | `mongo:7` (healthchecked, volume-backed) + `api` on port 4000 |
| `.dockerignore` | Keeps `node_modules`, `dist`, `.env` and logs out of the build context |

Both containers restart unless stopped. The API waits for Mongo's healthcheck before starting, then reconnects automatically if Mongo restarts.

## Project structure

```
.
├── package.json                 # dev orchestration
├── .env.example
├── server/
│   ├── src/
│   │   ├── index.js / app.js
│   │   ├── config.js
│   │   ├── analytics/
│   │   │   ├── indicators.js    # SMA, EMA, RSI, MACD, ATR, Bollinger, ADX, OBV, pivots
│   │   │   ├── analysis.js      # scoring, levels, targets, stop, confidence
│   │   │   └── options.js       # chain analytics, Black-Scholes, payoff engine, strategy picker
│   │   ├── agent/
│   │   │   ├── agent.js         # loop, system prompt, built-in analyst
│   │   │   ├── providers.js     # OpenAI / Anthropic / Gemini / Ollama adapters
│   │   │   └── tools.js         # 9 tool definitions + executors
│   │   ├── lib/                 # Yahoo client, cache, Mongo connection, in-memory store, errors
│   │   ├── models/              # Mongoose: NewsItem, DailyNewsDigest
│   │   ├── jobs/                # daily news ingest scheduler
│   │   ├── routes/              # market, news, analysis, options, watchlist, agent
│   │   └── services/            # orchestration, market aggregation, news archive
│   ├── scripts/                 # validate-signals.js, ingest-news.js
│   ├── Dockerfile
│   └── test/                    # node:test suites
└── client/
    └── src/
        ├── App.jsx              # hash router + shell
        ├── pages/               # Dashboard, Analyzer, OptionsLab, Agent
        ├── components/          # candle chart, payoff chart, markdown, search, gauges
        └── styles.css           # dark terminal theme
```

## Reliability notes

- Yahoo calls are cached (quotes 60s, history 5m, chains 3m, analysis 90s, scans 5m), de-duplicated in flight, gated to 4 concurrent requests and retried with backoff on HTTP 429.
- Every analytics function is pure and unit-tested; the live layer degrades gracefully when Yahoo or the LLM is unavailable.
- Option quotes use the mid, falling back to last price. Always re-check the live bid/ask before sending an order.

## Disclaimer

MarketPilot is a research tool, not a broker or adviser. Data may be delayed or incomplete. Scores and target probabilities are model estimates, not predictions. Options trading involves substantial risk; you can lose the entire premium and more on short structures.
