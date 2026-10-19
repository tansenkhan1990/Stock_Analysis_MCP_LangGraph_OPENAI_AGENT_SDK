import { HOT_ACTIONS, WATCH_MIN_SCORE } from '../analytics/hotStocks.js';
import { chatWithLLM } from './providers.js';

/**
 * The Hot Stocks "AI outlook": instead of one model call per name (which caps
 * the board at ~20 names), the analyzed scan is handed to the model in compact
 * batches and it returns one verdict per candidate — which of these names it
 * expects to rise over the next few weeks, how strongly, and why.
 *
 * The module is deliberately split into pure helpers (`buildOutlookRows`,
 * `parseOutlookJson`, `normalizeOutlookPicks`, `engineOutlook`, `mergeOutlook`)
 * plus one thin provider call (`decideOutlookBatch`), so the batching, prompt
 * contract and fallback can be tested without a network.
 */

export const OUTLOOK_BATCH_SIZE = 30;
export const OUTLOOK_TTL_MS = 30 * 60_000;

const SYSTEM_PROMPT = `You are MarketPilot's momentum screener. You receive a batch of candidate tickers with the app's own compact evidence: quality score, engine call, setup, trend, RSI, buy zone, primary target and stop, and the live price and day move.

Your job: decide which of these names are likely to RISE over roughly the next 1-4 weeks, and rank your conviction. You are not writing a full report — one short, specific reason per name.

How to judge:
1. PRICE STRUCTURE first: uptrend (price above the 50-day), a constructive setup, score in the bullish half, and reward:risk of at least ~1.5 from the buy zone.
2. MOMENTUM AND TIMING: RSI 40-65 with a rising trend is the sweet spot; RSI above 75 is stretched, RSI below 30 with a broken trend is a falling knife.
3. THE ENGINE CALL is strong evidence but not binding: you may flag an "accumulate"/"hold" name as a riser when the structure supports it, and you may downgrade a "buy" whose price is far above its buy zone.
4. A price far BELOW its buy zone is a broken setup until it reclaims the band — call that "down" or "flat", not "up".
5. Do not invent numbers. Use only the figures in the candidate row.

Output a single minified JSON object and nothing else:
{"picks":[{"symbol":"NVDA","direction":"up|flat|down","confidence":0-100,"expectedMovePct":12.5,"horizon":"1-4 weeks","reason":"one sentence citing figures from the row"}]}

Return a pick for EVERY candidate you were given, using the exact symbol strings. "direction":"up" means you expect it to rise; use "flat" or "down" otherwise. Confidence must be calibrated: 75+ only for aligned structure, momentum and a clean entry.`;

const DIRECTIONS = ['up', 'flat', 'down'];

const round = (value, digits = 2) => {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
};

const clampNumber = (value, min, max, fallback = null) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

/** Compact, token-efficient candidate row handed to the model. */
export function buildOutlookRows(signals = []) {
  return (Array.isArray(signals) ? signals : [])
    .map((signal) => {
      if (!signal?.symbol) return null;
      const targets = Array.isArray(signal.targets) ? signal.targets : [];
      const primary = targets[1] || targets[0] || null;
      return {
        symbol: signal.symbol,
        name: signal.name || signal.symbol,
        price: round(signal.price),
        changePercent: round(signal.changePercent),
        quality: clampNumber(signal.score, 0, 100, null),
        conviction: clampNumber(signal.conviction, 0, 100, null),
        engineCall: signal.actionLabel || signal.action || 'Hold',
        setup: signal.setupLabel || null,
        trend: signal.trend || null,
        rsi: round(signal.rsi, 1),
        buyZone:
          signal.buyZone && Number.isFinite(Number(signal.buyZone.low)) && Number.isFinite(Number(signal.buyZone.high))
            ? { low: round(signal.buyZone.low), high: round(signal.buyZone.high) }
            : null,
        primaryTarget: primary ? { price: round(primary.price), upsidePct: round(primary.upsidePct) } : null,
        stopLoss: round(signal.stopLoss),
        riskReward: round(signal.riskReward),
      };
    })
    .filter(Boolean);
}

export function chunkRows(rows = [], size = OUTLOOK_BATCH_SIZE) {
  const width = Math.max(1, Math.floor(Number(size) || OUTLOOK_BATCH_SIZE));
  const out = [];
  for (let index = 0; index < rows.length; index += width) out.push(rows.slice(index, index + width));
  return out;
}

/** Pull the JSON object out of a model response, tolerating fences/prose. */
export function parseOutlookJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  // Try the payload as-is first (it may be a bare array), then the outermost
  // { ... } slice for responses wrapped in prose.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const attempts = [candidate];
  if (start !== -1 && end > start) attempts.push(candidate.slice(start, end + 1));

  for (const attempt of attempts) {
    let parsed;
    try {
      parsed = JSON.parse(attempt);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) return { picks: parsed };
    if (Array.isArray(parsed?.picks)) return parsed;
    if (Array.isArray(parsed?.stocks)) return { picks: parsed.stocks };
    if (Array.isArray(parsed?.outlook)) return { picks: parsed.outlook };
  }
  return null;
}

export function normalizeDirection(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (!raw) return null;
  if (/^(up|bull|bullish|rise|rising|long|higher|outperform|buy)/.test(raw)) return 'up';
  if (/^(flat|neutral|sideways|range|hold|mixed)/.test(raw)) return 'flat';
  if (/^(down|bear|bearish|fall|falling|short|lower|underperform|sell)/.test(raw)) return 'down';
  return null;
}

/**
 * Force the model output into the contract: only known symbols survive, the
 * direction is normalized, and confidence/expected move are clamped. A symbol
 * the model returned twice keeps its highest-confidence verdict.
 */
export function normalizeOutlookPicks(parsed, rows = []) {
  const list = Array.isArray(parsed?.picks) ? parsed.picks : [];
  const known = new Map(rows.map((row) => [String(row.symbol).toUpperCase(), row]));
  const picks = new Map();

  for (const item of list) {
    const symbol = String(item?.symbol || '').trim().toUpperCase();
    const row = known.get(symbol);
    if (!row) continue;
    const direction = normalizeDirection(item?.direction ?? item?.trend ?? item?.outlook ?? item?.call);
    if (!DIRECTIONS.includes(direction)) continue;
    const pick = {
      symbol,
      name: row.name,
      direction,
      confidence: Math.round(clampNumber(item?.confidence ?? item?.conviction, 0, 100, row.conviction ?? 50)),
      expectedMovePct: round(clampNumber(item?.expectedMovePct ?? item?.expectedUpsidePct, -90, 300, null), 1),
      horizon: typeof item?.horizon === 'string' && item.horizon.trim() ? item.horizon.trim().slice(0, 40) : '1–4 weeks',
      reason: String(item?.reason ?? item?.thesis ?? '')
        .trim()
        .slice(0, 400),
      source: 'llm',
    };
    const existing = picks.get(symbol);
    if (!existing || pick.confidence > existing.confidence) picks.set(symbol, pick);
  }

  return [...picks.values()];
}

/**
 * Deterministic fallback used when there is no LLM key, or a batch fails:
 * actionable longs and constructive holds, ranked by fused quality/conviction.
 */
export function engineOutlook(signals = []) {
  return (Array.isArray(signals) ? signals : [])
    .map((signal) => {
      if (!signal?.symbol) return null;
      const actionable = HOT_ACTIONS.includes(signal.action);
      const constructiveHold =
        signal.action === 'hold' && signal.trend === 'up' && Number(signal.score) >= WATCH_MIN_SCORE;
      if (!actionable && !constructiveHold) return null;
      const targets = Array.isArray(signal.targets) ? signal.targets : [];
      const primary = targets[1] || targets[0] || null;
      const upside = Number(primary?.upsidePct);
      const quality = clampNumber(signal.score, 0, 100, 50);
      const conviction = clampNumber(signal.conviction, 0, 100, 50);
      const confidence = Math.round(clampNumber(quality * 0.7 + conviction * 0.3, 0, 99, 50));
      const parts = [signal.setupLabel || signal.actionLabel || 'Constructive chart'];
      if (Number.isFinite(Number(signal.rsi))) parts.push(`RSI ${round(signal.rsi, 1)}`);
      if (Number.isFinite(upside)) parts.push(`${round(upside, 1)}% to the primary target`);
      return {
        symbol: signal.symbol,
        name: signal.name || signal.symbol,
        direction: 'up',
        confidence,
        expectedMovePct: Number.isFinite(upside) ? round(upside, 1) : null,
        horizon: '1–4 weeks',
        reason: `Engine: ${parts.join(' · ')}.`,
        source: 'engine',
      };
    })
    .filter(Boolean);
}

/** Model verdicts first, then engine fallbacks; higher confidence leads. */
export function rankOutlookPicks(picks = []) {
  const sourceRank = { llm: 0, engine: 1 };
  return [...picks].sort(
    (a, b) =>
      (sourceRank[a.source] ?? 2) - (sourceRank[b.source] ?? 2) ||
      b.confidence - a.confidence ||
      (b.expectedMovePct ?? -Infinity) - (a.expectedMovePct ?? -Infinity) ||
      String(a.symbol).localeCompare(String(b.symbol)),
  );
}

/**
 * Combine the model verdicts with the engine fallback so every analysed name
 * carries a verdict, and expose the risers the page renders.
 */
export function mergeOutlook({ rows = [], modelPicks = [], enginePicks = [] } = {}) {
  const modelBySymbol = new Map(modelPicks.map((pick) => [pick.symbol, pick]));
  const engineBySymbol = new Map(enginePicks.map((pick) => [pick.symbol, pick]));
  const picks = rows
    .map((row) => modelBySymbol.get(row.symbol) || engineBySymbol.get(row.symbol) || null)
    .filter(Boolean);
  const rising = rankOutlookPicks(picks.filter((pick) => pick.direction === 'up'));
  return {
    picks: rankOutlookPicks(picks),
    rising,
    risingCount: rising.length,
    modelRising: rising.filter((pick) => pick.source === 'llm').length,
    engineRising: rising.filter((pick) => pick.source === 'engine').length,
    uncovered: rows.filter((row) => !modelBySymbol.has(row.symbol)).map((row) => row.symbol),
  };
}

/** One model call for a batch of candidate rows. Throws on provider failure. */
export async function decideOutlookBatch({ rows = [] } = {}) {
  const started = Date.now();
  const result = await chatWithLLM({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Candidates:\n${JSON.stringify({ candidates: rows })}` },
    ],
    tools: [],
  });
  const parsed = parseOutlookJson(result.content);
  if (!parsed) throw new Error('The model did not return parseable outlook JSON');
  const picks = normalizeOutlookPicks(parsed, rows);
  if (!picks.length) throw new Error('The model returned no usable picks');
  return { picks, usage: result.usage, latencyMs: Date.now() - started };
}

export const _internals = { SYSTEM_PROMPT, clampNumber };
