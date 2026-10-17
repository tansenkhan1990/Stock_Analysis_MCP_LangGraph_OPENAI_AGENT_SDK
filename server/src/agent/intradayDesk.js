import { parseDecisionJson } from './llmDecision.js';
import { chatWithLLM } from './providers.js';

/**
 * The intraday desk call: the LLM reads the live 5-minute picture plus the daily
 * context (trend, news, event risk, option positioning) and returns a single
 * BUY / SELL / WAIT read with its own entry, stop and targets.
 *
 * Two rules keep the output safe for real orders:
 *  - every price the model returns is validated against spot and the 5-minute
 *    ATR; anything absurd falls back to the mechanical plan, and
 *  - the deterministic engine read is always kept alongside the model's call so
 *    the UI can show both when they disagree.
 */

export const INTRADAY_SYSTEM_PROMPT = `You are MarketPilot's intraday trading desk. You make ONE call per dossier for a single US cash session (09:30-16:00 New York) using 5-minute bars. You are decisive, calibrated and you trade the tape that is in front of you.

Weigh the evidence in this order:
1. INTRADAY STRUCTURE (the mechanical read) — session VWAP, EMA9 vs EMA20, RSI(14), the 30-minute opening range, relative volume, prior session high/low/close. This is the backbone of the call.
2. REGIME — the daily trend (50/200-day), ADX and ATR%. Intraday longs work with the daily trend or after a washed-out pullback; counter-trend longs against a broken daily trend are lower conviction.
3. NEWS AND CATALYSTS — headline flow and business deals. Short-term flow can be driven by a headline; if the news directly contradicts the mechanical read, say so and lower conviction.
4. EVENT RISK — earnings today or tomorrow means smaller size and lower conviction, or no trade at all.
5. OPTIONS POSITIONING — ATM implied volatility, expected move and max pain tell you how much range the market has priced.

Rules:
- Use ONLY the numbers in the dossier. Never invent prices, times or figures.
- Action must be exactly one of: "buy" (long), "sell" (short), "hold" (stand aside — the app shows this as WAIT).
- A "hold" call is a real answer: intraday edges are small, and the middle of the opening range is not a trade.
- Conviction 75+ only when intraday structure, daily regime and news all point the same way with volume confirmation. No-trade reads should stay at or below 60.
- Stop must be ATR-aware and never further than 2.5% from entry. Targets must sit in the direction of the trade and be reachable inside the session.
- Always give both sides of the tape in triggers: buyAbove and sellBelow, relative to current spot.
- Output MUST be a single minified JSON object and nothing else. No markdown, no commentary.

Exact schema:
{"action":"buy|sell|hold","conviction":0-100,"thesis":"2-4 sentences citing the specific numbers you used","reasons":["short bullet","..."],"risks":["short bullet","..."],"catalysts":[{"type":"news|deal|analyst|event|technical","direction":"bullish|bearish|neutral","detail":"..."}],"levels":{"entry":0,"stop":0,"target1":0,"target2":0,"target3":0},"triggers":{"buyAbove":0,"sellBelow":0},"sessionBias":"long|short|flat","invalidation":"one sentence","whatWouldChangeMyMind":"one sentence"}`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** A price the model returned, kept only if it is positive and sane. */
const priceOr = (value, fallback = null) => {
  const number = toNumber(value);
  if (number === null || number <= 0.01) return fallback;
  return Number(number.toFixed(2));
};

export const intradAction = (value) => {
  const raw = String(value || '').toLowerCase();
  if (/strong\s*buy|aggressive\s*buy|\bbuy\b|long|accumulate|overweight|breakout/.test(raw)) return 'buy';
  if (/sell|short|reduce|trim|exit|underweight|breakdown/.test(raw)) return 'sell';
  return 'wait';
};

const asList = (value, limit = 5) =>
  (Array.isArray(value) ? value : [])
    .map((item) => (typeof item === 'string' ? item : item?.detail ?? item?.title ?? ''))
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, limit);

/** Everything the intraday model is allowed to look at. */
export function buildIntradayDossier({ trade, context = null }) {
  return {
    symbol: trade.symbol,
    name: trade.name,
    exchange: trade.exchange,
    marketState: trade.marketState,
    sessionDate: trade.session?.date,
    sessionBars: trade.session?.bars,
    openingRangeComplete: trade.session?.openingRangeComplete,
    price: trade.price,
    changePercent: trade.changePercent,
    previousClose: trade.previousClose,
    intraday: {
      mechanicalAction: trade.action,
      mechanicalScore: trade.score,
      mechanicalConfidence: trade.confidence,
      mechanicalReasons: trade.reasons,
      vwap: trade.levels?.vwap,
      ema9: trade.levels?.ema9,
      ema20: trade.levels?.ema20,
      openingRangeHigh: trade.levels?.openingRangeHigh,
      openingRangeLow: trade.levels?.openingRangeLow,
      sessionHigh: trade.levels?.sessionHigh,
      sessionLow: trade.levels?.sessionLow,
      priorHigh: trade.levels?.priorHigh,
      priorLow: trade.levels?.priorLow,
      priorClose: trade.levels?.priorClose,
      rsi14: trade.indicators?.rsi14,
      atr14: trade.indicators?.atr14,
      atrPct: trade.indicators?.atrPct,
      volumeRatio: trade.indicators?.volumeRatio,
      vwapDistancePct: trade.indicators?.vwapDistancePct,
      aboveVwap: trade.indicators?.aboveVwap,
      ema9Above20: trade.indicators?.ema9Above20,
      mechanicalPlan: trade.plan,
      mechanicalTriggers: trade.triggers,
    },
    daily: context?.technical || null,
    fundamentals: context?.fundamentals || null,
    event: context?.event || null,
    news: context?.news || null,
    options: context?.options || null,
  };
}

/**
 * Force the model output into the intraday contract. Prices are validated
 * against spot/ATR before they are allowed to become an order plan.
 */
export function normalizeIntradayDecision(parsed, fallback = {}, { price, atr = null } = {}) {
  const spot = toNumber(price);
  const action = intradAction(parsed?.action);
  const enginePlan = fallback?.plan || null;
  const levels = parsed?.levels || {};
  const maxRiskPct = 0.025; // a day-trade stop beyond 2.5% is not an intraday risk
  const buffer = atr ? Math.max(atr * 0.5, spot ? spot * 0.002 : 0) : spot ? spot * 0.004 : 0;

  let plan = null;

  if (action !== 'wait' && spot) {
    const direction = action;
    let entry = priceOr(levels.entry, spot);
    // An entry far away from spot is not actionable inside the session.
    if (Math.abs(entry - spot) / spot > 0.01) entry = spot;

    const minStop = entry * (1 - maxRiskPct);
    const maxStop = entry * (1 + maxRiskPct);
    let stop = priceOr(levels.stop, null);
    const stopValid =
      stop !== null &&
      direction === 'buy' &&
      stop < entry - buffer * 0.2 &&
      stop >= minStop;
    const shortStopValid =
      stop !== null &&
      direction === 'sell' &&
      stop > entry + buffer * 0.2 &&
      stop <= maxStop;

    if (!stopValid && !shortStopValid) {
      // Fall back to the mechanical stop, then to an ATR band around spot.
      const engineStop = priceOr(enginePlan?.stopLoss, null);
      const engineUsable =
        engineStop !== null &&
        ((direction === 'buy' && engineStop < entry && engineStop >= minStop) ||
          (direction === 'sell' && engineStop > entry && engineStop <= maxStop));
      stop = engineUsable
        ? engineStop
        : direction === 'buy'
          ? clamp(entry - (atr || entry * 0.01), minStop, entry * 0.999)
          : clamp(entry + (atr || entry * 0.01), entry * 1.001, maxStop);
    }

    stop = Number(stop.toFixed(2));
    const riskPerShare = Number(Math.abs(entry - stop).toFixed(2));

    if (riskPerShare > 0.001) {
      const multiples = [1.5, 2.5, 4];
      const rawTargets = [levels.target1, levels.target2, levels.target3].map((value) => priceOr(value, null));
      const targets = multiples.map((multiple, index) => {
        const suggested = direction === 'buy' ? entry + riskPerShare * multiple : entry - riskPerShare * multiple;
        const candidate = rawTargets[index];
        const valid =
          candidate !== null &&
          ((direction === 'buy' && candidate > entry + riskPerShare * 0.3) ||
            (direction === 'sell' && candidate < entry - riskPerShare * 0.3));
        const price2 = Number((valid ? candidate : suggested).toFixed(2));
        return {
          label: `T${index + 1}`,
          price: price2,
          rMultiple: multiple,
          movePct: Number((((price2 - entry) / entry) * 100).toFixed(2)),
        };
      });

      plan = {
        direction: direction === 'buy' ? 'long' : 'short',
        entry: Number(entry.toFixed(2)),
        stopLoss: stop,
        riskPerShare,
        targets,
        riskReward: 2.5,
        invalidation:
          typeof parsed?.invalidation === 'string' && parsed.invalidation.trim()
            ? parsed.invalidation.trim().slice(0, 300)
            : direction === 'buy'
              ? 'A close back above the stop, or a loss of VWAP, ends the long read.'
              : 'A close back above the stop, or a reclaim of VWAP, ends the short read.',
      };
    }
  }

  const buyOverride = priceOr(parsed?.triggers?.buyAbove, null);
  const sellOverride = priceOr(parsed?.triggers?.sellBelow, null);
  const buyValid = buyOverride !== null && (!spot || buyOverride >= spot * 0.995);
  const sellValid = sellOverride !== null && (!spot || sellOverride < spot);

  // Both fallback sources have to respect the sides of the tape too: once price
  // has already broken below the opening range, the mechanical "sell below"
  // level sits ABOVE spot, which would be a nonsense exit trigger.
  const engineBuy = priceOr(fallback?.triggers?.buyAbove, null);
  const engineSell = priceOr(fallback?.triggers?.sellBelow, null);
  const atrBand = atr && Number.isFinite(atr) && atr > 0 ? atr : spot ? spot * 0.01 : null;
  const buyTrigger = buyValid
    ? buyOverride
    : engineBuy !== null && (!spot || engineBuy >= spot * 0.995)
      ? engineBuy
      : spot
        ? Number((spot + (atrBand || 0) * 0.5).toFixed(2))
        : null;
  const sellTrigger = sellValid
    ? sellOverride
    : engineSell !== null && (!spot || engineSell < spot)
      ? engineSell
      : spot
        ? Number((spot - (atrBand || 0) * 0.5).toFixed(2))
        : null;

  const thesis =
    typeof parsed?.thesis === 'string' && parsed.thesis.trim().length > 40
      ? parsed.thesis.trim().slice(0, 1200)
      : fallback?.thesis || null;

  const convictionBase = toNumber(parsed?.conviction);
  const conviction =
    action === 'wait'
      ? clamp(Math.round(convictionBase ?? fallback?.confidence ?? 50), 20, 60)
      : clamp(Math.round(convictionBase ?? fallback?.confidence ?? 55), 30, 95);

  return {
    action,
    actionLabel: action === 'buy' ? 'Buy' : action === 'sell' ? 'Sell' : 'Wait',
    conviction,
    horizon: 'intraday (same session)',
    thesis,
    reasons: asList(parsed?.reasons, 6),
    risks: asList(parsed?.risks, 5),
    catalysts: (Array.isArray(parsed?.catalysts) ? parsed.catalysts : [])
      .map((item) => ({
        type: ['news', 'deal', 'analyst', 'event', 'technical'].includes(item?.type) ? item.type : 'technical',
        direction: ['bullish', 'bearish', 'neutral'].includes(item?.direction) ? item.direction : 'neutral',
        detail: String(item?.detail || '').trim().slice(0, 300),
      }))
      .filter((item) => item.detail)
      .slice(0, 6),
    sessionBias: ['long', 'short', 'flat'].includes(parsed?.sessionBias) ? parsed.sessionBias : action === 'buy' ? 'long' : action === 'sell' ? 'short' : 'flat',
    levels: {
      entry: plan?.entry ?? priceOr(levels.entry, null),
      stop: plan?.stopLoss ?? priceOr(levels.stop, null),
      targets: plan?.targets?.map((target) => target.price) ?? [],
    },
    plan,
    triggers: {
      buyAbove: buyTrigger,
      sellBelow: sellTrigger,
      note:
        'Intraday triggers — wait for a 5-minute candle close, not just a wick, and respect the stop.',
    },
    invalidation: plan?.invalidation ?? fallback?.plan?.invalidation ?? 'Standing aside means the setup never triggered.',
    whatWouldChangeMyMind:
      typeof parsed?.whatWouldChangeMyMind === 'string' && parsed.whatWouldChangeMyMind.trim()
        ? parsed.whatWouldChangeMyMind.trim().slice(0, 600)
        : null,
    engineAction: fallback?.action ?? null,
    engineLabel: fallback?.actionLabel ?? null,
    agreesWithEngine: fallback?.action ? action === fallback.action : null,
    generatedBy: 'llm',
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Ask the LLM for the intraday call. Throws on provider failure or unparseable
 * output so the caller can fall back to the mechanical read.
 */
export async function decideIntradayWithLLM({ dossier, fallback, chat = chatWithLLM }) {
  const started = Date.now();
  const result = await chat({
    messages: [
      { role: 'system', content: INTRADAY_SYSTEM_PROMPT },
      { role: 'user', content: `Intraday dossier:\n${JSON.stringify(dossier)}` },
    ],
    tools: [],
  });
  const parsed = parseDecisionJson(result?.content);
  if (!parsed) throw new Error('The model did not return parseable JSON');
  const decision = normalizeIntradayDecision(parsed, fallback, {
    price: dossier?.price,
    atr: dossier?.intraday?.atr14 ?? null,
  });
  return { decision, latencyMs: Date.now() - started, usage: result?.usage };
}

/**
 * Merge the desk call into the mechanical payload the page already renders, so
 * the headline action/plan/confidence are the model's when it spoke and the
 * rule engine's otherwise. The engine read stays available untouched.
 */
export function mergeIntradayDecision({
  trade,
  context = null,
  decision = null,
  decisionMeta = null,
  decisionError = null,
}) {
  const engine = {
    action: trade.action,
    actionLabel: trade.actionLabel,
    score: trade.score,
    confidence: trade.confidence,
    reasons: trade.reasons,
    plan: trade.plan,
    triggers: trade.triggers,
    risks: trade.risks,
  };

  const ai = decision
    ? {
        ...decision,
        model: decisionMeta?.model ?? null,
        provider: decisionMeta?.provider ?? null,
      }
    : null;
  const source = ai && ai.generatedBy === 'llm' ? 'ai' : 'engine';

  const reasons = source === 'ai' ? [ai.thesis, ...ai.reasons].filter(Boolean) : trade.reasons;
  const risks = source === 'ai' ? [...new Set([...ai.risks, ...trade.risks])].slice(0, 7) : trade.risks;

  return {
    ...trade,
    source,
    decisionSourceLabel:
      source === 'ai'
        ? `${decisionMeta?.provider || 'ai'} · ${decisionMeta?.model || 'model'}`
        : 'MarketPilot rule engine',
    action: source === 'ai' ? ai.action : trade.action,
    actionLabel: source === 'ai' ? ai.actionLabel : trade.actionLabel,
    confidence: source === 'ai' ? ai.conviction : trade.confidence,
    reasons,
    risks,
    plan: source === 'ai' ? ai.plan : trade.plan,
    triggers: source === 'ai' ? { ...trade.triggers, ...ai.triggers } : trade.triggers,
    engine,
    ai,
    context,
    decisionMeta,
    decisionError,
  };
}

export const _internals = { asList, priceOr, clamp };
