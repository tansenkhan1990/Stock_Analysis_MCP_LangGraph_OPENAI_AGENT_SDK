import { parseDecisionJson } from './llmDecision.js';
import { chatWithLLM, describeProvider } from './providers.js';

/**
 * The forecast desk: the next-session and next-week calls are made by the
 * configured LLM from the 1-month daily chart (21 candles), the full ranked
 * news set (headlines, catalysts, business deals and risks), the earnings
 * report and the event calendar for the same stock or ETF.
 *
 * The deterministic technical model is still computed and sent to the model as
 * a cross-check, and its projections are the labelled fallback whenever no LLM
 * key is configured or the model call fails — the page never invents a call.
 */

export const FORECAST_DESK_PROMPT = `You are MarketPilot's short-horizon forecast desk. For each dossier you make ONE call for a single stock or ETF: the next trading session (1 day) and the next week (5 sessions). You learn from the deep 1-month chart pattern, the full news set and business deals, the earnings report and the geopolitical backdrop.

Weigh the evidence in this order:
1. THE DEEP 1-MONTH CHART — candles are the last 21 daily sessions and chartPattern is the structural read: swing highs and lows, trend and fitted channel, range position, breakout or breakdown, support and resistance distances, RSI and MACD momentum including divergence, the volatility regime, and the last candle's shape and volume. The pattern anchors the next session.
2. THE FULL NEWS SET — the dossier carries every ranked headline with its summary and sentiment, the tagged catalysts, the business deals (acquisitions, mergers, partnerships, contracts, orders, capital raises) and the risk stories. Weigh the whole set rather than only the newest line, and name the story that mattered most. A deal or contract can re-rate a name; a legal or guidance headline can override a clean setup. If the news contradicts the chart, lower conviction or call flat.
3. THE EARNINGS REPORT — the earnings block carries the next report date and days until it, the last reported quarters (EPS actual vs estimate and surprise %), the beat streak, average surprise, revenue and earnings growth, forward growth estimates and the analyst target. Use it as the fundamental backdrop, and treat a report due inside the horizon as event risk: keep the probability modest and name the event in the caveats unless the chart is decisive.
4. GEOPOLITICS AND MACRO — the geopolitics block carries the macro tilt, the risk tone, the active themes (Fed and rates, trade and tariffs, China and Asia, conflict and energy, regulation, dollar and credit, global growth) and the proxy tape (VIX, S&P 500, oil, gold, dollar). Read it as a regime: a hostile backdrop narrows the case for a strong rise; a supportive one lets a good chart run. A name with direct thematic exposure (tariffs, export controls, energy) should weight the relevant theme more heavily.
5. VOLATILITY — expectedPct and rangePct must be plausible for this name's ATR% and daily volatility. Never forecast a move outside the typical range.
6. MECHANICAL REFERENCE — setupScore, mechanicalReference and the analog hit rate are a cross-check, not the answer. You may disagree with them; when you do, say why in the drivers.

How to be effective:
- Converging evidence deserves a strong call: when the pattern, the deal and earnings backdrop, and the macro regime point the same way, take the direction and push probability toward 75-85 with confidence 70+, and cite the specific confirmations.
- Conflicting evidence deserves candour: when the chart fights the news, the earnings date sits inside the horizon, or the macro tape is hostile, cut conviction or call flat rather than forcing an arrow.
- Every driver must name a number, level, headline, deal or theme from the dossier.

Rules:
- direction is exactly "rise", "drop" or "flat". Use "flat" when the evidence is balanced or the chart is a tight range.
- probability is the chance of the direction you name, 5-95. For flat use 50. Never report a rise-only probability.
- expectedPct is the signed percent change to the expected price. rangePct is one standard deviation of the horizon's noise.
- confidence reflects evidence quality: 70+ only when the pattern, the setup, the news, the deals, the earnings backdrop and the macro regime agree. Flat calls must stay at or below 45.
- drivers: 2-4 short items citing specific numbers, levels, headlines, deals, earnings figures or themes from the dossier. caveats: 1-3 real risks (volatility, headline risk, an earnings date, a hostile macro theme, a thin analog sample, conflicting signals).
- If the dossier has no headlines, say the call is chart-only; never invent a headline, catalyst, deal, earnings date or EPS figure.
- This is a statistical forecast, not investment advice.
- Output MUST be a single minified JSON object and nothing else. No markdown, no commentary.

Exact schema:
{"summary":"2-4 sentences on the deep chart pattern and the call","patternTakeaway":"one sentence on the chart structure and what it implies","newsTakeaway":"one sentence naming the headline that mattered, or an empty string","dealTakeaway":"one sentence on the business-deal flow, or an empty string","macroTakeaway":"one sentence on the geopolitical/macro backdrop, or an empty string","whatWouldChangeMyMind":"one sentence","day":{"direction":"rise|drop|flat","probability":0,"expectedPct":0,"rangePct":0,"confidence":0,"drivers":["..."],"caveats":["..."]},"week":{"direction":"rise|drop|flat","probability":0,"expectedPct":0,"rangePct":0,"confidence":0,"drivers":["..."],"caveats":["..."]}}`;

const RULE_META = { provider: 'rule-engine', model: 'MarketPilot 1-month model', cached: false };
const DIRECTION_LABELS = { rise: 'Rise', drop: 'Drop', flat: 'No edge' };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(digits));
  return rounded === 0 ? 0 : rounded;
};
const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value, limit = 600) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
const asList = (value, limit = 4) =>
  (Array.isArray(value) ? value : [])
    .map((item) => (typeof item === 'string' ? item : item?.detail ?? item?.title ?? ''))
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, limit);

function normalizeDirection(value, fallback = 'flat') {
  const raw = String(value || '').toLowerCase();
  if (/\b(rise|up|higher|bull|bullish|long|gain)\b/.test(raw)) return 'rise';
  if (/\b(drop|down|lower|bear|bearish|short|fall|decline)\b/.test(raw)) return 'drop';
  if (/\b(flat|neutral|sideways|range|no edge|chop)\b/.test(raw)) return 'flat';
  return ['rise', 'drop', 'flat'].includes(fallback) ? fallback : 'flat';
}

const compactHorizon = (horizon) => ({
  direction: horizon.direction,
  probability: horizon.probability,
  expectedPct: horizon.expectedPct,
  typicalRangePct: { low: horizon.lowPct, high: horizon.highPct },
  confidence: horizon.confidence,
});

/** Everything the forecast desk is allowed to learn from. */
export function buildForecastAnalystDossier({ forecast, news = null, earnings = null, geopolitics = null }) {
  if (!forecast?.horizons?.day || !forecast?.horizons?.week) return null;
  const cleanNews = news && Number(news.headlineCount) > 0 ? news : null;

  return {
    symbol: forecast.symbol,
    name: forecast.name ?? forecast.symbol,
    quoteType: forecast.quoteType ?? 'EQUITY',
    currency: forecast.currency ?? 'USD',
    exchange: forecast.exchange ?? null,
    price: forecast.price ?? null,
    changePercent: forecast.changePercent ?? null,
    asOf: forecast.asOf ?? null,
    chart: '1 month of daily candles (21 trading sessions)',
    window: {
      sessions: forecast.window?.sessions ?? null,
      from: forecast.window?.from ?? null,
      to: forecast.window?.to ?? null,
      changePct: forecast.window?.changePct ?? null,
      high: forecast.window?.high ?? null,
      low: forecast.window?.low ?? null,
    },
    columns: 'd=date, o=open, h=high, l=low, c=close, v=volume, ma20=20-day mean, rsi14=RSI(14)',
    candles: (forecast.series || []).map((bar) => ({
      d: String(bar.date || '').slice(0, 10),
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
      ma20: bar.sma20,
      rsi14: bar.rsi14,
    })),
    technicals: forecast.technicals ?? null,
    chartPattern: forecast.chartPattern ?? null,
    earnings: earnings ?? null,
    geopolitics: geopolitics ?? null,
    setupScore: forecast.score ?? null,
    mechanicalReference: {
      day: compactHorizon(forecast.horizons.day),
      week: compactHorizon(forecast.horizons.week),
    },
    analog: {
      day: forecast.horizons.day.analog?.matched ?? null,
      week: forecast.horizons.week.analog?.matched ?? null,
      note: forecast.analog?.note ?? null,
    },
    news: cleanNews
      ? {
          sentiment: cleanNews.sentiment ?? null,
          label: cleanNews.label ?? null,
          headlineCount: cleanNews.headlineCount,
          bullish: cleanNews.bullish ?? null,
          bearish: cleanNews.bearish ?? null,
          deals: (cleanNews.deals || []).slice(0, 6).map((item) => ({
            title: item.title,
            direction: item.direction ?? null,
            score: item.score ?? null,
            publishedAt: item.publishedAt ?? null,
          })),
          catalysts: (cleanNews.catalysts || []).slice(0, 6).map((item) => ({
            title: item.title,
            direction: item.direction ?? null,
            tags: item.tags || [],
            publishedAt: item.publishedAt ?? null,
          })),
          risks: (cleanNews.risks || []).slice(0, 4).map((item) => ({
            title: item.title,
            score: item.score ?? null,
            publishedAt: item.publishedAt ?? null,
          })),
          headlines: (cleanNews.headlines || []).slice(0, 12).map((item) => ({
            title: item.title,
            summary: item.summary ? String(item.summary).slice(0, 240) : '',
            direction: item.direction ?? null,
            tags: item.tags || [],
            publishedAt: item.publishedAt ?? null,
            publisher: item.publisher ?? null,
          })),
        }
      : {
          headlineCount: 0,
          headlines: [],
          note: 'No recent headlines were available; make the call from the 1-month chart only, using the earnings block for the fundamental backdrop.',
        },
  };
}

/** Keep the headlines the forecast actually read, in a UI-friendly shape. */
export function summarizeForecastNews(news) {
  if (!news || !(Number(news.headlineCount) > 0)) return null;
  return {
    sentiment: round(Number(news.sentiment), 0),
    label: news.label ?? null,
    headlineCount: news.headlineCount,
    bullish: news.counts?.bullish ?? null,
    bearish: news.counts?.bearish ?? null,
    deals: (news.deals || []).slice(0, 6).map((item) => ({
      title: item.title,
      direction: item.direction ?? null,
      score: item.score ?? null,
      publishedAt: item.publishedAt ?? null,
    })),
    catalysts: (news.catalysts || []).slice(0, 6).map((item) => ({
      title: item.title,
      direction: item.direction ?? null,
      tags: item.tags || [],
      publishedAt: item.publishedAt ?? null,
    })),
    risks: (news.risks || []).slice(0, 4).map((item) => ({
      title: item.title,
      score: item.score ?? null,
      publishedAt: item.publishedAt ?? null,
    })),
    headlines: (news.headlines || []).slice(0, 10).map((item) => ({
      title: item.title,
      summary: item.summary ? String(item.summary).slice(0, 240) : '',
      direction: item.direction ?? null,
      tags: item.tags || [],
      publishedAt: item.publishedAt ?? null,
      publisher: item.publisher ?? null,
    })),
  };
}

/** Force one model horizon into the forecast contract. */
function normalizeHorizon(raw, fallback, { spot = null, isDay = true } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  let direction = normalizeDirection(source.direction, fallback.direction);
  let probability = clamp(Math.round(num(source.probability) ?? fallback.probability ?? 50), 5, 95);
  // The named direction has to be the more likely outcome. A "rise" carrying a
  // 40% probability is a no-edge read with an arrow attached, so publish it as
  // flat instead of letting the card contradict its own number.
  if (direction !== 'flat' && probability < 50) direction = 'flat';
  if (direction === 'flat') probability = 50;
  const riseProbability = direction === 'drop' ? 100 - probability : direction === 'rise' ? probability : 50;

  const fallbackRange = Math.max(0.2, num(fallback.rangePct) ?? (isDay ? 2 : 4));
  const maxRange = isDay ? 15 : 30;
  let rangePct = clamp(num(source.rangePct) ?? fallbackRange, 0.2, maxRange);
  let expectedPct = clamp(num(source.expectedPct) ?? num(fallback.expectedPct) ?? 0, -rangePct, rangePct);
  // A call's expected move cannot point the other way: a rise that expects a
  // lower price (or a drop expecting a higher one) is a zero-move read. A flat
  // call has no directional edge, so its expected move is zero too.
  if (direction === 'flat') expectedPct = 0;
  else if ((direction === 'rise' && expectedPct < 0) || (direction === 'drop' && expectedPct > 0)) expectedPct = 0;
  // A move at the edge of the range makes the range meaningless, so widen it.
  if (Math.abs(expectedPct) > rangePct * 0.9) {
    rangePct = clamp(Math.abs(expectedPct) * 1.25, 0.2, maxRange);
  }
  rangePct = round(rangePct, 2);
  expectedPct = round(expectedPct, 2);

  let confidence = clamp(Math.round(num(source.confidence) ?? fallback.confidence ?? 50), 20, 92);
  if (direction === 'flat') confidence = Math.min(confidence, 45);

  const drivers = asList(source.drivers, 4);
  const caveats = asList(source.caveats, 4);

  return {
    horizon: fallback.horizon,
    label: fallback.label,
    direction,
    directionLabel: DIRECTION_LABELS[direction],
    probability,
    riseProbability,
    dropProbability: 100 - riseProbability,
    expectedPct,
    expectedPrice: spot ? round(spot * (1 + expectedPct / 100)) : fallback.expectedPrice,
    rangePct,
    lowPct: round(-rangePct, 2),
    highPct: round(rangePct, 2),
    lowPrice: spot ? round(spot * (1 - rangePct / 100)) : fallback.lowPrice,
    highPrice: spot ? round(spot * (1 + rangePct / 100)) : fallback.highPrice,
    confidence,
    drivers: drivers.length ? drivers : fallback.drivers,
    caveats: caveats.length ? caveats : fallback.caveats,
    // The mechanical replay stays attached as evidence for the Q&A panel.
    analog: fallback.analog ?? null,
    generatedBy: 'llm',
  };
}

/**
 * Validate the model's answer. Both horizons are required: a partial call is
 * treated as a failure so the page falls back to the complete mechanical read
 * instead of mixing a model day call with an engine week call.
 */
export function normalizeForecastPrediction(parsed, forecast) {
  if (!forecast?.horizons?.day || !forecast?.horizons?.week) {
    throw new Error('There is no forecast to project');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('The model did not return a forecast');
  if (!parsed.day || typeof parsed.day !== 'object' || !parsed.week || typeof parsed.week !== 'object') {
    throw new Error('The model did not return both the day and the week forecast');
  }

  const spot = num(forecast.price);
  return {
    thesis: text(parsed.summary, 1200) || text(parsed.thesis, 1200),
    patternTakeaway: text(parsed.patternTakeaway, 500),
    newsTakeaway: text(parsed.newsTakeaway, 400),
    dealTakeaway: text(parsed.dealTakeaway, 500),
    macroTakeaway: text(parsed.macroTakeaway, 500),
    whatWouldChangeMyMind: text(parsed.whatWouldChangeMyMind, 400),
    day: normalizeHorizon(parsed.day, forecast.horizons.day, { spot, isDay: true }),
    week: normalizeHorizon(parsed.week, forecast.horizons.week, { spot, isDay: false }),
  };
}

/** Ask the configured model for the call. Throws on failure or unparseable output. */
export async function decideForecastWithLLM({ forecast, news = null, earnings = null, geopolitics = null, chat = chatWithLLM }) {
  const dossier = buildForecastAnalystDossier({ forecast, news, earnings, geopolitics });
  if (!dossier) throw new Error('There is no forecast to project');

  const started = Date.now();
  const result = await chat({
    messages: [
      { role: 'system', content: FORECAST_DESK_PROMPT },
      { role: 'user', content: `1-month forecast dossier:\n${JSON.stringify(dossier)}` },
      // A local or smaller model will often answer the big dossier with prose
      // even when the system prompt demands JSON. Restating the format in the
      // last turn keeps the desk on the strict schema.
      {
        role: 'user',
        content:
          'Return ONLY the minified JSON object matching the exact schema in the system prompt. No markdown, no prose, no commentary.',
      },
    ],
    tools: [],
  });

  const parsed = parseDecisionJson(result?.content);
  if (!parsed) throw new Error('The model did not return parseable JSON');
  return {
    prediction: normalizeForecastPrediction(parsed, forecast),
    latencyMs: Date.now() - started,
    usage: result?.usage,
  };
}

/**
 * Make the model's call the page's headline read while keeping every piece of
 * mechanical evidence (score, technicals, analog replay) untouched.
 */
export function mergeForecastPrediction({
  forecast,
  prediction = null,
  news = null,
  earnings = null,
  geopolitics = null,
  decisionMeta = null,
  decisionError = null,
}) {
  if (!forecast) return null;
  const source = prediction ? 'ai' : 'engine';
  const merged = {
    ...forecast,
    source,
    decisionSourceLabel:
      source === 'ai'
        ? `${decisionMeta?.provider || 'ai'} · ${decisionMeta?.model || 'model'}`
        : 'MarketPilot rule engine',
    decisionMeta: decisionMeta || { ...RULE_META },
    decisionError: decisionError ?? null,
    news: news ?? forecast.news ?? null,
    earnings: earnings ?? forecast.earnings ?? null,
    geopolitics: geopolitics ?? forecast.geopolitics ?? null,
    analysis: prediction
      ? {
          thesis: prediction.thesis,
          patternTakeaway: prediction.patternTakeaway,
          newsTakeaway: prediction.newsTakeaway,
          dealTakeaway: prediction.dealTakeaway,
          macroTakeaway: prediction.macroTakeaway,
          whatWouldChangeMyMind: prediction.whatWouldChangeMyMind,
          chart: '1 month (21 daily sessions)',
          evidence: {
            pattern: forecast.chartPattern?.label ?? null,
            earnings: earnings?.label ?? forecast.earnings?.label ?? null,
            deals: (news?.deals || forecast.news?.deals || []).length,
            macro: geopolitics?.label ?? forecast.geopolitics?.label ?? null,
          },
          generatedAt: new Date().toISOString(),
        }
      : null,
  };

  if (prediction) {
    merged.horizons = {
      day: { ...forecast.horizons.day, ...prediction.day },
      week: { ...forecast.horizons.week, ...prediction.week },
    };
    merged.summary = [
      prediction.thesis || forecast.summary[0],
      ...forecast.summary.slice(1),
    ];
  }

  return merged;
}

/**
 * Full desk pass: model call when a provider is configured, labelled mechanical
 * read when it is not or when the call fails. Never throws.
 */
export async function applyForecastAnalyst({
  forecast,
  news = null,
  earnings = null,
  geopolitics = null,
  provider = describeProvider(),
  chat = chatWithLLM,
}) {
  if (!forecast) return null;
  const summarized = summarizeForecastNews(news);

  if (!provider?.live) {
    return mergeForecastPrediction({
      forecast,
      news: summarized,
      earnings,
      geopolitics,
      decisionMeta: { ...RULE_META },
      decisionError: 'No LLM key configured — the projections come from the mechanical 1-month model, not the AI forecast desk.',
    });
  }

  try {
    const result = await decideForecastWithLLM({ forecast, news: summarized, earnings, geopolitics, chat });
    return mergeForecastPrediction({
      forecast,
      prediction: result.prediction,
      news: summarized,
      earnings,
      geopolitics,
      decisionMeta: {
        provider: provider.provider,
        model: provider.model,
        latencyMs: result.latencyMs,
        usage: result.usage,
        cached: false,
      },
      decisionError: null,
    });
  } catch (error) {
    return mergeForecastPrediction({
      forecast,
      news: summarized,
      earnings,
      geopolitics,
      decisionMeta: { ...RULE_META },
      decisionError: `LLM forecast call failed (${error.message}) — showing the mechanical 1-month model.`,
    });
  }
}

export const _internals = { normalizeDirection, asList, clamp, round };
