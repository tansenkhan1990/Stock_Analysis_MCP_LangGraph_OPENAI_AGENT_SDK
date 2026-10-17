import { config, hasLLM } from '../config.js';
import { getAnalysis, getFocusBoard, getMarketOverview } from '../services/index.js';
import { describeProvider, chatWithLLM } from './providers.js';
import { TOOL_DEFINITIONS, TOOL_SUMMARY, executeTool } from './tools.js';

const DISCLAIMER =
  'Educational research only — not investment advice. Markets can gap through stops; size positions so a full stop-out costs no more than 1–2% of your account.';

const SYSTEM_PROMPT = `You are MarketPilot, a disciplined sell-side quality analyst embedded in a trading terminal.
Today is ${new Date().toISOString().slice(0, 10)}.

Your job: turn live Yahoo Finance data into an actionable, honest trade plan for stocks and ETFs.

Coverage: your highest-conviction universe is the AI/semis mega-cap complex (NVDA, MSFT, AMZN, GOOGL, PLTR, TSLA, AMD, TSM) plus the option-tradable ETFs (SPY, QQQ, IWM, SMH, TLT, GLD) and the Shariah-screened iShares MSCI World Islamic UCITS ETF (ISDW.L). You can analyze any liquid ticker, but these are the names you track closely.

Rules:
- ALWAYS call tools before stating prices, scores or levels. Never invent numbers. If a tool fails, say so plainly.
- For any "analyze / should I buy / target" question, call get_full_analysis. For options questions, also call get_option_chain.
- For any question that turns on news, business deals or "what does the story say", call get_research_digest — it returns Yahoo news sentiment, deal headlines, analyst upgrades/downgrades, earnings-date risk and article excerpts.
- For "what should I buy / what is the best opportunity today", call get_focus_board and lead with the ranked calls.
- Ground every target in a level: prior pivot, moving average, 52-week extreme, ATR projection or analyst consensus.
- Be decisive but calibrated: mention the invalidation level and what would change your mind.
- Consider both the technical score AND the risk (volatility, drawdown, event risk, liquidity).
- Options suggestions must be defined-risk, with strikes, expiry, net debit/credit, max profit, max loss and breakeven.
- Prefer concrete numbers and short tables. No more than ~450 words unless the user asks for depth.
- If the user asks for something outside markets, redirect briefly to what you can analyze.
- End with a one-line risk disclaimer, shortened to "Not investment advice."`;

const NOISE = new Set(
  'I A AN THE AND OR IF CAN YOU SHOULD STOCK STOCKS ETF ETFS BUY SELL HOLD AI RSI MACD PE EPS CEO USD IPO WHAT IS ARE MY ME IT FOR TO ON IN OF VS VERSUS OK NOW TODAY GOOD BAD WITH THIS THAT OPTION OPTIONS CALL PUT TARGET TARGETS PRICE MARKET HELP PLEASE TELL GIVE ANALYSIS ANALYZE'.split(
    ' ',
  ),
);

const fmt = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(digits)}` : '—';
const pctText = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}%` : '—';

export function extractSymbols(message) {
  const dollar = [...String(message).matchAll(/\$([A-Za-z]{1,5})\b/g)].map((match) => match[1].toUpperCase());
  if (dollar.length) return [...new Set(dollar)];

  const upper = [...String(message).matchAll(/\b([A-Z]{1,5})\b/g)]
    .map((match) => match[1])
    .filter((token) => !NOISE.has(token));
  const seen = new Set();
  return upper.filter((token) => {
    if (seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}

async function resolveTicker(message, contextSymbol, history = []) {
  const direct = extractSymbols(message);
  if (direct.length) return direct;

  const company = String(message).match(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?)\b/);
  if (company && /analy|buy|sell|target|option|forecast|outlook|price|should/i.test(message)) {
    try {
      const { searchSymbols } = await import('../lib/yahoo.js');
      const results = await searchSymbols(company[1]);
      const equity = results.find((item) => ['EQUITY', 'ETF'].includes(item.quoteType));
      if (equity) return [equity.symbol];
    } catch {
      // fall through
    }
  }
  if (contextSymbol) return [contextSymbol];

  // Follow-up questions inherit the tickers from earlier turns.
  for (const item of [...history].filter((entry) => entry.role === 'user').slice(-4).reverse()) {
    const previous = extractSymbols(item.content);
    if (previous.length) return previous;
  }
  return ['SPY'];
}

function planTable(analysis) {
  const { plan } = analysis;
  const rows = [];
  if (plan.buyZone) rows.push(`| Buy zone (price range to accumulate) | ${fmt(plan.buyZone.low)} – ${fmt(plan.buyZone.high)} |`);
  if (plan.shortZone) rows.push(`| Short / trim zone | ${fmt(plan.shortZone.low)} – ${fmt(plan.shortZone.high)} |`);
  for (const target of plan.targets) {
    rows.push(`| ${target.label} target | ${fmt(target.price)} (${target.upsidePct}% · ${target.probability}% est.) |`);
  }
  rows.push(`| Stop / invalidation | ${fmt(plan.stopLoss)} |`);
  rows.push(`| Risk : reward | ${plan.riskReward ?? '—'} : 1 |`);
  return `| Level | Price |\n| --- | --- |\n${rows.join('\n')}`;
}

function optionsBlock(analysis) {
  const options = analysis.options;
  if (!options?.plans?.length) return '';
  const plan = options.plans[0];
  const summary = options.summary;
  const legs = plan.legs
    .map((leg) => `${leg.action === 'buy' ? 'Buy' : 'Sell'} ${leg.kind} ${fmt(leg.strike, 0)} @ ${fmt(leg.premium)}`)
    .join(' · ');
  const metrics = plan.metrics;
  const lines = [
    `**Options idea — ${plan.name}** (${plan.expiration}, ${plan.dte} DTE)`,
    `${legs}`,
    `${metrics.isCredit ? 'Net credit' : 'Net debit'} ${fmt(Math.abs(metrics.netPremium), 0)} · max profit ${metrics.maxProfitUnbounded ? 'unlimited' : fmt(metrics.maxProfit, 0)} · max loss ${fmt(Math.abs(metrics.maxLoss), 0)} · breakeven ${metrics.breakevens.map((value) => fmt(value)).join(' / ') || '—'}${metrics.probabilityOfProfit !== null ? ` · est. PoP ${metrics.probabilityOfProfit}%` : ''}`,
  ];
  if (summary) {
    lines.push(
      `Chain read: ATM IV ${summary.atmIv ?? '—'}% (${summary.ivState} vs realised), expected move ±${summary.expectedMovePct ?? '—'}%, max pain ${fmt(summary.maxPain, 0)}, P/C OI ${summary.pcrOi ?? '—'}.`,
    );
  }
  return `\n${lines.join('\n')}\n`;
}

async function builtinAnalysis(symbol, { includeOptions = true } = {}) {
  const analysis = await getAnalysis(symbol, { withOptions: includeOptions });
  const call = analysis.alert?.actionLabel ?? 'Hold';
  const setup = analysis.alert?.setupLabel ? ` · ${analysis.alert.setupLabel}` : '';
  const header = `**${analysis.symbol} · ${analysis.name} — ${call}**${setup} (${fmt(analysis.price)} · ${pctText(analysis.changePercent)})`;
  const scoreLine = `Quality **${analysis.score.total}/100** (${analysis.score.label}) · confidence ${analysis.score.confidence}% · ${analysis.assetClass}${analysis.fundamentals?.sector ? ` · ${analysis.fundamentals.sector}` : ''}`;
  const narrative = analysis.rationale.slice(0, 3).map((line) => `- ${line}`).join('\n');
  const checks = analysis.checklist
    .slice(0, 6)
    .map((item) => `${item.passed ? '✓' : '✗'} ${item.label}${item.detail ? ` (${item.detail})` : ''}`)
    .join(' · ');
  const risks = analysis.risks.map((risk) => `- ${risk}`).join('\n');

  return `${header}
${scoreLine}

${narrative}

**Trade plan**
${planTable(analysis)}

**Signal checklist:** ${checks}
${includeOptions ? optionsBlock(analysis) : ''}
**Risks**
${risks}`;
}

async function builtinBoard() {
  const board = await getFocusBoard();
  const rows = board.signals
    .map(
      (row) =>
        `| ${row.symbol} | ${row.decision.actionLabel} | ${row.decision.setupLabel ?? '—'} | ${row.decision.score}/100 | ${row.decision.conviction}% | ${row.news ? `${row.news.sentiment > 0 ? '+' : ''}${row.news.sentiment} (${row.news.dealCount} deals)` : '—'} | ${fmt(row.technical.targets?.[0]?.price)} | ${fmt(row.technical.stopLoss)} |`,
    )
    .join('\n');

  const buys = board.signals.filter((row) => ['buy', 'accumulate'].includes(row.decision.action));
  const risks = [...board.signals].reverse().filter((row) => ['sell', 'reduce', 'hold'].includes(row.decision.action));
  const leader = board.topPick;

  return `**Focus board** — ${board.counts.buy} buy · ${board.counts.accumulate} accumulate · ${board.counts.hold} hold · ${board.counts.reduce} reduce · ${board.counts.sell} sell
Quality = price structure 50% + news flow 20% + Street activity 15% + deals/catalysts 15%; the call comes from the trend/RSI alert. Average news sentiment ${board.averageNewsSentiment > 0 ? '+' : ''}${board.averageNewsSentiment}, ${board.counts.deals} business-deal headlines tracked.

| Ticker | Call | Setup | Quality | Conviction | News | T1 | Stop |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

**Read:** ${leader ? `${leader.symbol} screens strongest (${leader.decision.actionLabel} · ${leader.decision.setupLabel ?? 'no setup'}, quality ${leader.decision.score}/100, ${leader.decision.conviction}% conviction) with news flow at ${leader.news ? `${leader.news.sentiment > 0 ? '+' : ''}${leader.news.sentiment}` : '—'}` : 'No signals available'}${
    buys.length ? `, with ${buys.map((row) => row.symbol).join(', ')} on the long side` : ''}.
${risks.length ? `Weakest / avoid: ${risks.slice(0, 3).map((row) => `${row.symbol} (${row.decision.actionLabel})`).join(', ')}.` : ''}

Open the Analyzer for a full plan, or Options Lab for the defined-risk structure on any name. _${DISCLAIMER}_`;
}

async function builtinMarket() {
  const market = await getMarketOverview();
  const rows = market.indices
    .map((item) => `| ${item.label} | ${item.symbol} | ${fmt(item.price)} | ${pctText(item.changePercent)} |`)
    .join('\n');
  const sectors = [...market.sectors]
    .sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0))
    .map((item) => `${item.label} ${pctText(item.changePercent)}`)
    .join(' · ');
  return `**Market overview** — ${market.regime} regime · VIX ${market.vix?.toFixed(1) ?? '—'}

| Index | Ticker | Last | Day |
| --- | --- | --- | --- |
${rows}

**Sector tape:** ${sectors}
**Breadth:** ${market.breadth.advancing}/${market.breadth.total} risk sectors advancing. Leader ${market.leader?.label ?? '—'}, laggard ${market.laggard?.label ?? '—'}.

Ask me to analyze any ticker for a scored buy zone, targets and an options structure. _${DISCLAIMER}_`;
}

async function builtinCompare(symbols, criterion = 'score') {
  const analyses = [];
  for (const symbol of symbols.slice(0, 3)) {
    try {
      analyses.push(await getAnalysis(symbol, { withOptions: false }));
    } catch {
      // skip failed symbols
    }
  }
  if (!analyses.length) throw new Error('Could not load data for those tickers');
  const rankValue = (analysis) => {
    if (criterion === 'riskReward') return analysis.plan.riskReward ?? -1;
    if (criterion === 'momentum') return analysis.performance.quarter ?? -999;
    return analysis.score.total;
  };
  const ranked = [...analyses].sort((a, b) => rankValue(b) - rankValue(a));
  const rows = analyses
    .map(
      (analysis) =>
        `| ${analysis.symbol} | ${fmt(analysis.price)} | ${analysis.alert?.actionLabel ?? 'Hold'} | ${analysis.score.total} | ${fmt(analysis.plan.buyZone?.low)}–${fmt(analysis.plan.buyZone?.high)} | ${fmt(analysis.plan.targets[0]?.price)} | ${fmt(analysis.plan.stopLoss)} | ${analysis.plan.riskReward ?? '—'} |`,
    )
    .join('\n');
  const best = ranked[0];
  const bestRead =
    criterion === 'riskReward'
      ? `best reward-to-risk (${best.plan.riskReward ?? '—'}:1 measured from its planned entry)`
      : criterion === 'momentum'
        ? `strongest 3-month momentum (${best.performance.quarter ?? '—'}%)`
        : `best composite score (${best.score.total}/100 across trend, momentum, volume, risk and valuation)`;
  return `**Comparison** — ${ranked.map((item) => `${item.symbol} ${item.score.total}`).join(' · ')}

| Ticker | Price | Call | Quality | Buy zone | T1 | Stop | R:R |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

**Read:** ${best.symbol} screens best: ${bestRead}. ${
    best.plan.buyZone ? `A staged entry between ${fmt(best.plan.buyZone.low)} and ${fmt(best.plan.buyZone.high)} with a ${fmt(best.plan.stopLoss)} stop gives ${best.plan.riskReward ?? '—'}:1 to the second target.` : `Wait for a better setup; the current risk/reward is not compelling.`
  }

_${DISCLAIMER}_`;
}

function builtinNews(analysis) {
  if (!analysis.news?.length) return '';
  return `\n**Latest headlines**\n${analysis.news
    .slice(0, 4)
    .map((item) => `- ${item.title} — ${item.publisher}`)
    .join('\n')}\n`;
}

async function runBuiltin({ message, contextSymbol, history = [], emit }) {
  const lower = message.toLowerCase();
  const symbols = await resolveTicker(message, contextSymbol, history);
  const wantsMarket = /market|indices|sector|breadth|vix|regime/.test(lower) && !extractSymbols(message).length;
  const wantsBoard =
    !wantsMarket &&
    !extractSymbols(message).length &&
    /focus|watchlist|board|what (?:should|to) (?:i )?buy|best (?:buy|trade|opportunit)|scan|screen|today|top pick/.test(lower);
  const wantsCompare = symbols.length >= 2 || /compare|versus|\bvs\b|better buy/.test(lower);

  emit({ type: 'status', message: 'Querying live Yahoo Finance data…' });

  if (wantsBoard) {
    emit({ type: 'tool', name: 'get_focus_board', args: {}, status: 'running' });
    const board = await getFocusBoard();
    emit({
      type: 'tool',
      name: 'get_focus_board',
      status: 'done',
      summary: `${board.counts.buy} buy / ${board.counts.accumulate} accumulate · ${board.counts.deals} deals tracked`,
    });
    const text = await builtinBoard();
    return { text, toolTrace: ['get_focus_board'] };
  }

  if (wantsMarket) {
    emit({ type: 'tool', name: 'get_market_overview', args: {}, status: 'running' });
    const text = await builtinMarket();
    emit({ type: 'tool', name: 'get_market_overview', status: 'done', summary: 'Index and sector tape loaded' });
    return { text, toolTrace: ['get_market_overview'] };
  }

  if (wantsCompare && symbols.length >= 2) {
    const chosen = symbols.slice(0, 3);
    const criterion = /risk|reward|\brr\b/i.test(lower)
      ? 'riskReward'
      : /momentum|trend|strength/i.test(lower)
        ? 'momentum'
        : 'score';
    emit({ type: 'tool', name: 'compare_symbols', args: { symbols: chosen }, status: 'running' });
    const text = await builtinCompare(chosen, criterion);
    emit({ type: 'tool', name: 'compare_symbols', status: 'done', summary: `Compared ${chosen.join(', ')}` });
    return { text, toolTrace: ['compare_symbols'] };
  }

  const symbol = symbols[0];
  emit({ type: 'tool', name: 'get_full_analysis', args: { symbol }, status: 'running' });
  const analysis = await getAnalysis(symbol, { withOptions: true });
  emit({
    type: 'tool',
    name: 'get_full_analysis',
    status: 'done',
    summary: `${analysis.symbol}: ${analysis.alert?.actionLabel ?? 'Hold'} · quality ${analysis.score.total}/100 · targets ${analysis.plan.targets.map((target) => `$${target.price}`).join(' / ') || 'n/a'}`,
  });
  const text = `${await builtinAnalysis(symbol)}${builtinNews(analysis)}

_${DISCLAIMER}_`;
  return { text, toolTrace: ['get_full_analysis'] };
}

export async function runAgent({ message, history = [], symbol = null, emit = () => {} }) {
  const providerInfo = describeProvider();

  if (!hasLLM) {
    const result = await runBuiltin({ message, contextSymbol: symbol, history, emit });
    return { ...result, provider: 'builtin', model: providerInfo.model, rounds: 1 };
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history
      .filter((item) => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
      .slice(-8)
      .map((item) => ({ role: item.role, content: item.content.slice(0, 4000) })),
    {
      role: 'user',
      content: symbol ? `${message}\n\n(Context: the user currently has ${symbol} open in the analyzer.)` : message,
    },
  ];

  const trace = [];
  let rounds = 0;
  let usage = null;

  try {
    while (rounds < config.llm.maxToolRounds) {
      rounds += 1;
      emit({ type: 'status', message: rounds === 1 ? 'Thinking…' : 'Reviewing tool output…' });
      const result = await chatWithLLM({ messages, tools: TOOL_DEFINITIONS });
      usage = result.usage || usage;

      if (result.toolCalls?.length) {
        messages.push({ role: 'assistant', content: result.content || '', toolCalls: result.toolCalls });
        for (const call of result.toolCalls) {
          trace.push(call.name);
          emit({ type: 'tool', name: call.name, args: call.arguments, status: 'running' });
          let payload;
          let summary = '';
          try {
            payload = await executeTool(call.name, call.arguments);
            summary = TOOL_SUMMARY[call.name]?.(payload) || 'Done';
            emit({ type: 'tool', name: call.name, status: 'done', summary });
          } catch (error) {
            payload = { error: error.message };
            summary = error.message;
            emit({ type: 'tool', name: call.name, status: 'error', summary });
          }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify(payload).slice(0, 16_000),
          });
        }
        continue;
      }

      const text = (result.content || '').trim();
      if (!text) throw new Error('The model returned an empty response');
      return { text, provider: providerInfo.provider, model: providerInfo.model, rounds, usage, toolTrace: trace };
    }

    const final = await chatWithLLM({
      messages: [
        ...messages,
        { role: 'user', content: 'Stop calling tools and give your final answer now using the data already gathered.' },
      ],
      tools: TOOL_DEFINITIONS,
    });
    return {
      text: final.content?.trim() || 'I could not complete the analysis. Please try again.',
      provider: providerInfo.provider,
      model: providerInfo.model,
      rounds,
      usage,
      toolTrace: trace,
    };
  } catch (error) {
    emit({ type: 'warning', message: `LLM provider error: ${error.message}. Falling back to the built-in analyst.` });
    const fallback = await runBuiltin({ message, contextSymbol: symbol, history, emit });
    return {
      ...fallback,
      text: `> ⚠️ Live LLM unavailable (${error.message.slice(0, 140)}). Built-in analyst result:\n\n${fallback.text}`,
      provider: 'builtin-fallback',
      model: providerInfo.model,
      rounds,
      toolTrace: trace,
    };
  }
}

export const _internals = { SYSTEM_PROMPT, planTable, optionsBlock };
