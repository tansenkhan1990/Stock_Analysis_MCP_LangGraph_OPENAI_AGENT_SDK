import { describeProvider } from '../agent/providers.js';
import { HOT_UNIVERSE } from '../data/universe.js';
import { listWatchlist } from '../lib/store.js';
import { getFocusBoard, runDeskDecisions } from './researchService.js';

/**
 * The ETF desk.
 *
 * ETFs are a different animal from single stocks: there is no product launch or
 * takeover to read, so the LLM call has to come from market data — trend,
 * breadth, relative strength, volatility, rates and sector rotation — plus the
 * macro news flow, and from the way those line up with the mechanical plan.
 * The deep research bundle already assembles all of that (indicators, news,
 * "deals" where an ETF has any, Street tilt, event risk and the option chain),
 * so this service reuses it: it resolves the ETF universe, asks the model for a
 * BUY / ACCUMULATE / HOLD / REDUCE / SELL call per fund, and returns the rows
 * sorted by the blended chance to rise.
 *
 * Every model call is the shared per-symbol desk cache (30 minutes), so a page
 * load after the first one is free until the calls go stale.
 */

/** The curated ETFs plus anything the user added that Yahoo reports as an ETF. */
export const ETF_UNIVERSE = HOT_UNIVERSE.filter((item) => item.kind === 'etf').map((item) => item.symbol);

const normalize = (symbol) => String(symbol || '').trim().toUpperCase();

export function resolveEtfUniverse({ watchlist = [], extra = [], limit = 24 } = {}) {
  const added = (Array.isArray(watchlist) ? watchlist : [])
    .filter((item) => typeof item !== 'string' && item?.quoteType === 'ETF')
    .map((item) => item.symbol);
  const symbols = [...new Set([...ETF_UNIVERSE, ...added, ...extra].map(normalize).filter(Boolean))];
  const cap = Math.max(1, Number(limit) || 24);
  return symbols.slice(0, cap);
}

/**
 * The sentence the card shows under the call. A model call carries its own
 * thesis; an engine call has to be composed from the alert's own reasoning, so
 * the desk never renders an empty paragraph.
 */
export function etfThesis(row = {}) {
  const decision = row.decision || {};
  if (typeof decision.thesis === 'string' && decision.thesis.trim()) return decision.thesis.trim();
  const parts = [];
  if (decision.setupLabel) parts.push(decision.setupLabel);
  if (decision.alert?.reason) parts.push(decision.alert.reason);
  if (row.technical?.signalLabel) {
    parts.push(`${row.technical.signalLabel} · quality ${row.technical.score ?? '—'}/100`);
  }
  return parts.join(' — ') || 'No model call yet — the engine call stands in.';
}

/** Highest chance to rise first; conviction breaks ties; the symbol is stable. */
export function sortEtfRows(rows = []) {
  return [...rows].sort(
    (a, b) =>
      (b.growthProbability ?? -1) - (a.growthProbability ?? -1) ||
      (b.decision?.conviction ?? 0) - (a.decision?.conviction ?? 0) ||
      String(a.symbol).localeCompare(String(b.symbol)),
  );
}

export async function getEtfDesk({ runAi = false, refresh = false } = {}) {
  const watchlist = await listWatchlist();
  const symbols = resolveEtfUniverse({ watchlist });
  const provider = describeProvider();

  if (!symbols.length) {
    return {
      generatedAt: new Date().toISOString(),
      live: false,
      provider: 'rule-engine',
      model: 'MarketPilot rule engine',
      count: 0,
      llmCalls: 0,
      etfs: [],
    };
  }

  // Warm the evidence cache first so the desk pass and the read after it share
  // one analysis per fund.
  const first = await getFocusBoard({ symbols });

  const decisionErrors = {};
  if (runAi && provider.live) {
    const desk = await runDeskDecisions({ symbols, refresh });
    for (const [symbol, entry] of Object.entries(desk.decisions || {})) {
      if (entry?.decisionError) decisionErrors[symbol] = entry.decisionError;
    }
  }

  // Re-read: getFocusBoard layers whatever desk decisions now exist (cached or
  // just made) onto the rows and re-derives the chance to rise from them.
  const board = runAi && provider.live ? await getFocusBoard({ symbols }) : first;
  const etfs = sortEtfRows(
    board.signals.map((row) => ({
      ...row,
      decision: { ...row.decision, thesis: etfThesis(row) },
      llm: row.decisionSource === 'llm',
      decisionError: decisionErrors[row.symbol] ?? null,
    })),
  );

  return {
    generatedAt: new Date().toISOString(),
    live: provider.live,
    provider: provider.live ? provider.provider : 'rule-engine',
    model: provider.live ? provider.model : 'MarketPilot rule engine',
    count: etfs.length,
    llmCalls: etfs.filter((row) => row.llm).length,
    etfs,
  };
}
