# MarketPilot — AI Stock & ETF Analyst with an Options Lab

MarketPilot turns live Yahoo Finance data into a transparent, actionable trade plan. It scores any stock or ETF, produces a **buy zone, three sell targets and a stop**, surfaces **defined-risk options structures**, and lets you interrogate all of it through an **LLM agent with real tool calling**.

> Educational research only. Not investment advice. Markets can gap through stops and options can expire worthless.

---

## What you get

| Area | Capability |
| --- | --- |
| Market dashboard | Index tape (SPY, QQQ, DIA, IWM, VIX, 10Y), sector breadth, risk regime, watchlist, scored signal board |
| Analyzer | 0–100 multi-factor score, confidence, buy zone, T1/T2/T3 targets, stop, reward:risk, position sizing, candlestick chart with SMA/RSI/volume, level map, fundamentals, news |
| Options Lab | Live chain, ATM IV, IV vs realised vol, expected move, max pain, put/call ratio, contract-level liquidity, strategy builder with expiry payoff, breakevens, probability of profit and greeks — plus an **AI options desk** at the top that reads the chain, the technical plan and the news, then picks the structure to buy or sell with a thesis, management rule and conviction, loadable into the builder in one click |
| Options ideas | One-click scan of your watchlist: best defined-risk structure per name (IV state, expected move, credit/debit, max loss, probability of profit) loadable straight into the builder. **Run AI desk** upgrades the scan so the model chooses each structure and explains why |
| Focus board | Buy & sell signals on your editable focus list, seeded with **NVDA, MSFT, AMZN, GOOGL, PLTR, TSLA, AMD, TSM**, option-tradable ETFs (**SPY, QQQ, IWM, SMH, TLT, GLD**) and the Shariah-screened **ISDW.L** (iShares MSCI World Islamic UCITS ETF, IE00B27YCN58, USD on LSE). Add any other stock or ETF with the **☆ Add a favorite** control (type a ticker, press **+ Add**), remove a name with the × on its card, or open **★ Manage list** to see every tracked ticker and add or delete any of them from one panel — including names whose quote failed and therefore never appear as a card. The action is a validated regime rule (buy pullbacks in an uptrend, exit on a trend break), shaped by news, deals, Street actions and earnings risk, with both triggers on every card: **BUY ABOVE** and **SELL BELOW**. Each card shows a **chance to rise** chip and the board is ranked by it by default, with **Min chance** (≥50/60/70%) and **Sort** controls — a bearish plan scores low on purpose, so filtering by chance never surfaces a short as a growth candidate |
| Deep research / AI desk | Per-name dossier (price structure, article text, deals, upgrades, earnings risk, option pricing) → BUY / ACCUMULATE / HOLD / REDUCE / SELL with thesis, upside drivers, downside risks, catalysts, invalidation and an options expression. “Run AI desk on all” does the whole board in one pass |
| AI Agent | Streaming chat with visible tool traces. Tools: full analysis, quote, history, option chain, research digest, **archived market history**, focus board, **portfolio review**, news, comparison, symbol search, market overview, strategy evaluation. **Images** can be attached (chart screenshot, broker page, position table) and the agent answers questions about what it actually sees — the image stays with the thread for follow-up questions |
| Portfolio review | Attach a broker export (CSV/TSV/JSON) in the chat or drag it onto the composer. Every line is priced live and measured against the engine plan: weight, unrealized P/L, stop distance, concentration, sector exposure and a specific **exit / trim N shares / add / hold** call. A structured card renders the book next to the agent's written review, and the portfolio stays attached to the thread for follow-up questions |
| Daily market archive | MongoDB stores one Yahoo Finance snapshot per tracked symbol per session — quote, volume, the full trade plan (buy zone, stop, T1/T2/T3), quality score, indicators, the engine call, news sentiment, Street tilt and option context. A daily job refreshes it, and every decision reads it back as memory: how long the call has stood, whether the score is improving, whether the previous calls followed through, and how far the stop/targets have drifted |
| News & deal archive | MongoDB stores every Yahoo Finance headline and business-deal story it sees, plus a daily sentiment digest per symbol. A daily job refreshes the archive; the app reads 7/30-day trends from it |
| Session state | Watchlist, saved research snapshots, agent threads and each thread's uploaded portfolio held in memory for the lifetime of the server |
| Hot Stocks | A ranked buy-now board over the **live US market**: the Yahoo screens (most actives, day gainers, growth tech, undervalued large caps, small-cap movers) are merged into one **market tape of ~500 names** with live price, day move and relative volume. A heat score decides which names get the full plan — the **buy zone**, the **T1/T2/T3 sell prices** (upside + estimated probability), the stop and reward:risk — and the rest stay on the tape with their quote, so nothing is hidden. **All market / Curated board / My list** scopes and a **40–150 name analysis depth** control the scan; names outside the entry band are shown separately with the price to wait for — the top of the band when price is above it, the floor to reclaim when price has broken below it — so the page never tells you to chase or to buy a broken setup. A **Watch** bucket keeps the rest of the good pile visible: quality in the bullish half, price above the 50-day and a real long plan, but no entry trigger yet. Every card and tape row has a **☆** button that adds the name to your focus list. The **AI outlook** sends every fully analysed name — not just the top 20 — to the configured model in compact batches and lists the ones it expects to rise, with a confidence, an expected move, a horizon and a one-line reason citing the row's own figures; a **▲/▼ AI %** chip on every card carries that verdict, and the pass is cached for 30 minutes. Every row also carries the blended **chance to rise** (its own **↑ N% chance** chip), and **Min chance** plus **Sort** controls rank and filter the cards by it — the buckets are chance-ordered by default instead of hot-score-ordered. An **ETF Desk** section lists only ETFs, ranked by chance to rise, with the model's own BUY / ACCUMULATE / HOLD / REDUCE / SELL call per fund |
| Day Trading | Pick any **US-listed** ticker (09:30–16:00 New York) and get an intraday **BUY / SELL / WAIT** read from 5-minute bars: session VWAP, EMA9 vs EMA20, RSI(14), the 30-minute opening range and relative volume. When a provider is configured the **LLM intraday desk makes the call** (its own entry, stop and 1.5R / 2.5R / 4R targets, with the mechanical read kept beside it), and the page adds the daily regime, headline flow, event risk, option positioning and fundamentals. The chart plots candles, VWAP/EMAs, the opening range, prior close and the trade levels, and the page refreshes every 60 seconds |
| AI on every buy/sell surface | The model, not just the rule engine, decides the call wherever the app tells you to buy or sell: the **Options Lab** (it picks the structure from the priced candidates or sends its own legs, which are re-priced off the live chain and rejected if the risk is unbounded), the **Day Trading** desk, the **Analyzer** (AI desk call card), the **Focus board** and deep research, plus an on-demand **AI column** on Hot Stocks and the Market dashboard. Model name, latency, cache state and any provider failure are always shown, and every surface falls back to the deterministic engine when there is no key |
| Display currency | Prices are shown in **EUR** by default, converted from the USD quotes at the live USD→EUR rate; the header switch flips back to native USD and the active rate is printed in the footer. Option strikes, premiums and P/L stay in USD — the US contract convention — while the Options Lab still shows the stock spot in your display currency (USD quote in brackets) |

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
   │                           + 12 live-data tools + built-in rule-based fallback
   ├── Portfolio ───────────── broker-file parser → live pricing → plan-aware actions
   ├── Store ───────────────── in-memory watchlist, snapshots and threads
   └── MongoDB ─────────────── daily market snapshots + news/deal archive (optional)
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

**Where the AI decides, and what it is allowed to touch.** Three desk prompts run over real data: the swing desk (Focus, deep research, Analyzer), the intraday desk (Day Trading) and the options desk (Options Lab and the ideas scan). Each one sees a dossier built from live numbers only, returns strict JSON, and is validated before anything reaches the UI:

| Desk | The model decides | Enforced on the way back |
| --- | --- | --- |
| Swing (1–8 weeks) | Action, conviction, thesis, catalysts, key levels, both triggers, options expression | Levels on the wrong side of spot are rejected; thesis, conviction and prices are clamped into bounds |
| Intraday (one session) | BUY / SELL / WAIT, conviction, entry/stop/targets, both triggers, invalidation | Entry must sit within 1% of spot, the stop within 2.5% and on the correct side, targets in the trade's direction, and the exit trigger below spot — otherwise the mechanical plan is used |
| Options | Which structure to buy or sell (by candidate index or its own legs), bias, PoP, management rule, risks | Every leg is snapped to a real chain contract within 2% of the requested strike and re-priced from the chain; unbounded-risk (naked short) structures are dropped; the bias must match the call |

Decision detail arrives with the call: provider, model, latency, whether it came from cache, and — if the provider failed or no key is set — a plain-language note while the deterministic engine keeps working.

### Image questions

Attach an image in the AI Agent composer (**Image**, drag-and-drop, or the *Read a chart* card) and ask your question in the same message. The image is sent inline to the configured vision model with the chat, and the thread keeps it for follow-ups.

| Input | Behaviour |
| --- | --- |
| Formats | PNG, JPEG, WebP or GIF, max 4 MB |
| Resizing | Anything larger than 1600 px on its longest edge is downscaled in the browser before it is sent |
| Prompting | Leave the message empty to get a default "what does this show?" read; ask anything specific instead |
| Grounding | The agent transcribes only what is legible (ticker, timeframe, levels, positions), calls its tools for the live price, and says so when a figure is cut off rather than inventing it |
| Thread reuse | The last image attached stays available for follow-up questions in the same chat; **+ New chat** starts fresh |
| Requirement | A vision-capable model — the built-in analyst cannot read images and says so instead of guessing |

### Portfolio import & review

Upload a holdings file in the AI Agent page (paperclip, drag-and-drop, or **Download CSV template**). Parsing runs on the server before anything is sent to a model, so a malformed export is rejected in the composer.

| Input | Behaviour |
| --- | --- |
| Formats | CSV, TSV, TXT or JSON, comma/semicolon/tab separated, with or without account metadata above the table |
| Required | A ticker column and a share-quantity column (`Ticker`/`Symbol`, `Quantity`/`Qty`/`Shares`/`Units`) |
| Optional | Average cost, total cost basis, name, currency, asset type, sector, cash rows |
| Symbols | Handles broker suffixes (`AAPL_US_EQ`, `AAPL.US`, `NASDAQ:AAPL`), `$` prefixes and quoted names |
| Numbers | US and continental formats (`1,234.56`, `1.234,56`, `400,25`), parenthesised negatives, currency symbols |
| Merging | Repeated lots are combined at a quantity-weighted average cost; cash rows are summed per currency |
| Limits | 256 KB, 100 positions; the 25 largest by market value get the full engine pass, the rest still get live prices |

Every review is priced from live quotes and then judged **risk first**:

1. **Stop breach** → exit (only when the engine plan is on the same side as the position — a downside plan's stop is not the stop on a long holding).
2. **Sell call** → exit. This is a trend-break risk exit, not a short recommendation.
3. **Size** → trim above the 20% single-name cap (back to 20%, or 15% when a line is over 30% of the book).
4. **Reduce call** → trim.
5. **Buy / Accumulate** → add only if the name is under 10% and no more than 5% above its buy zone; otherwise hold and wait. A short position is never told to add, and is covered when the call turns bullish.

Concentration is measured with the top-1/top-5 weights, sector exposure and the Herfindahl index (effective number of names). Flags call out stop breaches, Sell calls, single-name and sector concentration, 20%+ drawdowns, unpriced tickers, missing cost basis and low cash. Nothing is invented: a line with no live quote, no cost basis or an unsupported currency is excluded from the affected total and flagged rather than filled with a stale or guessed number. Cash is included only when the export contains a cash row.

The chat injects a compact, priced view of the book and exposes it as the `get_portfolio_review` tool, so the model cites real quantities, weights, stops and targets. Without an API key the built-in analyst returns the same review deterministically. The upload is held in memory against the thread (`portfolios` in `/api/health`), and a new file replaces it.

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
- MongoDB is optional at runtime: without it the app still scores, researches and serves options; only the news and daily market archives are unavailable (and decisions fall back to live data alone).

### MongoDB + Docker (daily market & news archive)

Prices and option chains are always read live from Yahoo. MongoDB stores the part Yahoo does not keep for you: **one market snapshot per symbol per session** (the quote, plan, score, indicators and call as they stood that day) and the **headlines and business deals themselves**, one row per story plus a per-symbol daily sentiment digest. That is what makes a 7-day news trend and a week-over-week call history possible.

Every decision is then fused from two sources: the **live** Yahoo quote, chain and news, and the **archived** daily rows. The archive never overrides a live price or plan level; it changes how much the call can be trusted — a call confirmed by weeks of snapshots and a good follow-through rate earns conviction, while a first-day flip, a deteriorating score or a history of failed calls loses it. The model is told both explicitly, so its buy/sell call, conviction and price targets are grounded in the database as well as the feed.

```bash
docker compose up -d --build     # mongo + the dockerised backend
```

- App (API + built UI): <http://localhost:4000>
- MongoDB: `localhost:27017/marketpilot`, persisted in the `mongo-data` volume
- The API container runs both daily jobs: once shortly after boot, then daily after `NEWS_INGEST_HOUR` (default 18:00 local) for news and `ARCHIVE_HOUR` (default 22:00 local) for the market snapshot. Set `ARCHIVE_ENABLED=false` to turn the snapshot job off; `ARCHIVE_RETENTION_DAYS` (default 400) bounds what is kept.

Running without Docker:

```bash
docker run -d --name marketpilot-mongo -p 27017:27017 -v marketpilot-mongo:/data/db mongo:7
npm run dev
```

Archive commands:

```bash
cd server
npm run ingest                  # collect news now (all focus symbols)
npm run ingest -- NVDA,MSFT     # subset
npm run archive                 # capture today's market snapshot (all focus symbols)
npm run archive -- NVDA,MSFT    # subset
curl localhost:4000/api/archive/status
curl localhost:4000/api/archive/NVDA?days=60
curl -X POST localhost:4000/api/archive/run -H 'content-type: application/json' -d '{"symbols":["NVDA"]}'
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

Restart the API after changing `.env`. The **LLM badge in the header** names the model doing the work — `LLM deepseek/deepseek-v4.1-flash · openai` — with the provider, image support and full label in its tooltip; it turns green for a live model, reads `AI rule engine` when no key is configured, and re-reads the API every minute so a model switch appears without a page reload. The same badge is on the AI Agent page, and every AI decision card names its own provider, model and latency. Tool calls are streamed to the UI as they happen; provider failures fall back to the built-in analyst with a warning.

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

The model has to do two different jobs here: read a numbers-heavy dossier and return one strict JSON decision (deep research), and drive the agent’s twelve live-data tools (tool calling). `deepseek/deepseek-v4-pro` is the default recommendation — strongest reasoning-per-dollar for multi-company comparison and sentiment attribution — with `deepseek/deepseek-v4.1-flash` as the cheaper option and `anthropic/claude-sonnet-4.6` when you want maximum judgement and don’t mind roughly 20x the token cost. Any model in OpenRouter’s tool-calling + structured-output sets works; swap the ID and restart.

A wrong or expired key does not break the app: the header badge stays on the rule engine and each research call reports `decisionError` with the provider’s message.

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run Express + Vite together |
| `npm run dev:api` / `npm run dev:web` | Run one side only |
| `npm test` | Node test runner: indicators, scoring/plan engine, alert rule, news analytics, options math, hot-stock ranking, day-trade scoring, portfolio parsing/review, FX |
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
| GET | `/api/market/fx` | USD→EUR display rate (live Yahoo `USDEUR=X`, cached 10 min, `USD_EUR_RATE` override) |
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

### Market archive
| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/archive/status` | Mongo connection, snapshot/symbol counts, coverage window, last daily run |
| GET | `/api/archive/:symbol?days=60` | Stored daily snapshots (newest first) plus the derived trend: score/price trend, action streak, plan drift, follow-through hit rate |
| POST | `/api/archive/run` | Capture now (`{"symbols":["NVDA"]}`); idempotent per symbol per session |

### Analysis
| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/analysis/:symbol?options=1&persist=0&refresh=0` | Full scored analysis + plan + option ideas + news |
| GET | `/api/scan?symbols=AAPL,NVDA` | Scored signal board (48 symbols by default, up to 200) |
| GET | `/api/etfs` | ETF desk read: only the curated ETFs plus any the user added as an ETF, each with price, the plan levels, news/deal/Street/event/archive evidence and `growthProbability` / `growthBand`, sorted highest chance to rise first. No model call is made — it returns whatever desk call already exists |
| POST | `/api/etfs/ai` | Runs the LLM desk over every ETF and returns the same payload with `llmCalls` > 0. Body `{ refresh }`. Each call reads market data (trend, RSI, volatility, relative strength, option chain), news and business/macro deal flow, Street activity, event risk and the archive, then fuses that with the mechanical plan. A fund the model did not cover keeps its engine thesis; calls are cached 30 minutes per symbol |
| GET | `/api/hot-stocks?scope=market&depth=100&symbols=AAPL,NVDA&refresh=1` | Hot Stocks board. `market` (default) merges Yahoo's predefined screens into a live market tape (~500 names), fully analyses the hottest `depth` names (default 100, max 150) and returns both the actionable rows and the whole tape; `broad` scans the curated ~40-name board, `focus` only the watchlist, and explicit `symbols` wins over `scope`. `stocks` carries the `buyNow`, `waiting` and `watch` buckets plus `buyNowCount` / `waitingCount` / `watchCount`; every ranked row (and analysed tape row) carries `growthProbability` / `growthBand`, the blended chance to rise |
| POST | `/api/hot-stocks/ai` | AI outlook over the whole analysed scan. Body `{ scope, depth, symbols, refresh }` (same resolution as the board). The model reads compact candidate batches and returns one verdict per name; the response carries `picks`, `rising` (what it expects to rise, best first), `risingCount`, `modelRising` / `engineRising`, `uncovered`, `provider` / `model` / `live`, `latencyMs` and any per-batch `errors`. Cached 30 minutes; falls back to the deterministic engine ranking when no LLM key is set or a batch fails |
| GET | `/api/snapshots` | Recent saved research |
| GET | `/api/snapshots/:symbol` | Latest saved analysis payload |

### Focus research
| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/focus?symbols=AAPL,SPY` | Focus board: fused buy/sell signals, news + deal read, two-sided triggers for every name (defaults to the watchlist). Each row carries `growthProbability` (1–99, the blended chance to rise) and `growthBand` (`low`/`moderate`/`good`/`high`) |
| GET | `/api/focus/:symbol?ai=1` | Deep research: dossier, headline/deal evidence, decision + option expression (`ai=1` uses the LLM) |
| POST | `/api/focus/ai` | Desk pass — runs the decision engine (LLM when a key is set, rules otherwise) across the board. Body: `{ "symbols": ["NVDA"], "refresh": false }` |

### Day trading
| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/daytrade/:symbol?refresh=1&ai=1` | Intraday read: 5-minute bars → action, confidence, reasons, entry/stop/targets, session VWAP/EMA/opening-range levels and a two-session chart payload. With a provider configured the LLM desk decides the call (`ai=1` forces it, `ai=0` returns the mechanical read only, cached 10 minutes per symbol and session); the payload also carries the daily regime, news, event risk, option positioning, fundamentals and both reads side by side |

### Options
| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/options/:symbol/expirations` | Expiry calendar |
| GET | `/api/options/:symbol/chain?date=YYYY-MM-DD` | Chain + analytics |
| GET | `/api/options/:symbol/ai?ai=1` | **AI options desk**: the model's buy/sell call for the chosen expiry, the structure it picked (or its own legs, validated against the live chain), thesis, management rule, PoP, catalysts, risks and invalidation, plus the priced candidates it chose from |
| GET | `/api/options/ideas?symbols=AAPL,SPY&ai=1` | Best defined-risk structure per symbol (defaults to the watchlist); `ai=1` lets the LLM options desk choose each structure |
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

### Portfolio
| Method | Route | Description |
| --- | --- | --- |
| POST | `/api/portfolio/parse` | Fast preview: parse and validate `{ fileName, content }` (or `{ holdings }`) without pricing |
| POST | `/api/portfolio/review` | Full review: live quotes, engine plan on the largest lines, weights, P/L, concentration, flags and per-position actions. `?refresh=1` bypasses the 2-minute cache |

### Watchlist & agent
| Method | Route | Description |
| --- | --- | --- |
| GET/POST | `/api/watchlist` | List / add `{ "symbol": "AMD" }` — drives the Focus board, dashboard scan and options ideas |
| DELETE | `/api/watchlist/:symbol` | Remove from the focus list |
| GET | `/api/agent/status` | Provider, model, tool list |
| POST | `/api/agent/chat` | **SSE stream**: `{ message, threadId?, symbol?, attachment?, image? }`. `attachment` is `{ fileName, content }` (CSV/TSV/JSON, max 256 KB); `image` is `{ fileName, mimeType, data }` where `data` is base64 or a `data:` URL (PNG/JPEG/WebP/GIF, 4 MB decoded). A message may be empty when a file or image is attached. The file replaces the thread's portfolio and the image becomes the thread's image; both are reused on later turns |
| GET | `/api/agent/threads` | Recent conversations |
| GET | `/api/agent/threads/:id` | Full thread |

SSE event types: `meta`, `status`, `tool` (running/done/error), `portfolio` (the structured review, sent before the answer), `answer`, `warning`, `done`, `error`.

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
│   │   │   ├── portfolio.js     # broker-file parsing, weights, concentration, position actions
│   │   │   └── options.js       # chain analytics, Black-Scholes, payoff engine, strategy picker
│   │   ├── agent/
│   │   │   ├── agent.js         # loop, system prompt, built-in analyst
│   │   │   ├── providers.js     # OpenAI / Anthropic / Gemini / Ollama adapters
│   │   │   ├── llmDecision.js   # swing-trade dossier + decision contract
│   │   │   ├── symbolDesk.js    # shared, cached desk call for any surface
│   │   │   ├── intradayDesk.js  # day-trading desk: dossier, validation, merge
│   │   │   ├── optionsDesk.js   # options desk: candidates, leg validation, defined-risk gate
│   │   │   ├── vision.js        # image attachment validation + multi-part user message
│   │   │   └── tools.js         # 12 tool definitions + executors
│   │   ├── lib/                 # Yahoo client, cache, Mongo connection, in-memory store, errors
│   │   ├── models/              # Mongoose: NewsItem, DailyNewsDigest
│   │   ├── jobs/                # daily news ingest scheduler
│   │   ├── routes/              # market, news, analysis, options, portfolio, watchlist, agent
│   │   └── services/            # orchestration, market aggregation, news archive
│   ├── scripts/                 # validate-signals.js, ingest-news.js
│   ├── Dockerfile
│   └── test/                    # node:test suites
└── client/
    └── src/
        ├── App.jsx              # hash router + shell
        ├── pages/               # Focus, Hot Stocks, Day Trading, Dashboard, Analyzer, OptionsLab, Agent
        ├── components/          # candle chart, payoff chart, markdown, search, gauges
        └── styles.css           # dark terminal theme
```

## Reliability notes

- Yahoo calls are cached (quotes 60s, daily history 5m, intraday bars 60s, chains 3m, analysis 90s, scans 5m, FX 10m), de-duplicated in flight, gated to 3 concurrent requests and retried with backoff on HTTP 429.
- Currency display is presentation-only: the analytics engine, plans and option math stay in USD. If live FX is unavailable the UI serves the last known rate (or falls back to USD) rather than inventing one.
- Every analytics function is pure and unit-tested; the live layer degrades gracefully when Yahoo or the LLM is unavailable.
- Option quotes use the mid, falling back to last price. Always re-check the live bid/ask before sending an order.

## Disclaimer

MarketPilot is a research tool, not a broker or adviser. Data may be delayed or incomplete. Scores and target probabilities are model estimates, not predictions. Options trading involves substantial risk; you can lose the entire premium and more on short structures.
