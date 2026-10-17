import { buildDossier, decideWithLLM } from './llmDecision.js';
import { describeProvider } from './providers.js';
import { cache } from '../lib/cache.js';

/**
 * One place that runs the LLM desk call for a single symbol, so every surface
 * that shows a BUY/SELL call (Focus board, deep research, Analyzer, options and
 * intraday desks) hits the same model, the same cache and the same fallback
 * rules. The deterministic rule engine is always the fallback: with no key, on
 * a provider error, or on unparseable output, the caller still gets a call.
 */
export const SYMBOL_DECISION_TTL = 30 * 60_000;

const RULE_META = { provider: 'rule-engine', model: 'MarketPilot rule engine', cached: false };

export const ruleEngineMeta = () => ({ ...RULE_META });

/**
 * @returns {{ decision: object|null, decisionMeta: object, decisionError: string|null }}
 */
export async function symbolAiDecision({
  symbol,
  meta,
  analysis,
  news = null,
  newsHistory = null,
  analyst = null,
  event = null,
  options = null,
  alert = null,
  fallback,
  refresh = false,
  ttlMs = SYMBOL_DECISION_TTL,
}) {
  if (!fallback) {
    return {
      decision: null,
      decisionMeta: ruleEngineMeta(),
      decisionError: 'No rule-engine call is available for this symbol.',
    };
  }

  const key = `decision:${symbol}`;
  if (refresh) cache.clear(key);

  const cached = cache.get(key);
  if (cached) {
    return { decision: cached.decision, decisionMeta: { ...cached.decisionMeta, cached: true }, decisionError: null };
  }

  const provider = describeProvider();
  if (!provider.live) {
    return {
      decision: fallback,
      decisionMeta: ruleEngineMeta(),
      decisionError: `No LLM key configured — showing the rule-engine call (${provider.label}).`,
    };
  }

  try {
    const result = await decideWithLLM({
      dossier: buildDossier({ symbol, meta, analysis, news, analyst, event, options, newsHistory, alert }),
      fallback,
    });
    const decisionMeta = {
      provider: provider.provider,
      model: provider.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
      cached: false,
    };
    cache.set(key, { decision: result.decision, decisionMeta }, ttlMs);
    return { decision: result.decision, decisionMeta, decisionError: null };
  } catch (error) {
    return {
      decision: fallback,
      decisionMeta: ruleEngineMeta(),
      decisionError: `LLM call failed (${error.message}) — showing the rule-engine call.`,
    };
  }
}
