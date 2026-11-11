import { describeProvider, chatWithLLM } from './providers.js';

/**
 * Forecast Q&A: answer a user's question about one 1-month forecast from the
 * forecast payload alone.
 *
 * The model never sees the open web or the rest of the app — only the dossier
 * built here (price, the chart's readings, both calls, the headlines the desk
 * read, the analog sample and the technical evidence). That keeps the answer
 * honest about its own evidence, and it makes the deterministic fallback below
 * a fair substitute rather than a different opinion. With no API key, on a
 * provider error or on an empty answer, the engine answer is returned instead.
 */

export const SUGGESTED_QUESTIONS = [
  'Why does the model lean this way?',
  'Which headline drove this call?',
  'How reliable is the analog sample?',
  'What would invalidate the one-week call?',
  'Explain what the confidence number means.',
  'What do the expected moves mean in price terms?',
];

export const FORECAST_SYSTEM_PROMPT = `You are MarketPilot's forecast explainer. You answer questions about ONE 1-month (21-session) forecast, using only the dossier in the user message.

How the forecast works (state it when relevant):
- The forecast desk reads the deep 1-month chart pattern (swing structure, channel, breakout, support and resistance, momentum, volatility), every ranked Yahoo headline with its summary, the tagged business deals, the earnings report (next date, beat/miss record, growth) and the geopolitical/macro backdrop (risk tone, themes, VIX/oil/gold/dollar proxies), then makes the next-session and next-week calls: direction, probability, expected move, typical range and confidence.
- The mechanical model (six weighted technical readings, a logistic probability and the in-window analog replay) stays in the dossier as the cross-check, and it is the fallback when no model is configured.
- The dossier's "call" block names whether the published projections came from the forecast desk or the rule engine.
- A flat read means no directional edge; probability is always the chance of the named direction.

Rules:
- Use ONLY numbers, dates, headlines and labels present in the dossier. Never invent a price, probability, headline, earnings date, valuation or analyst figure.
- Use riseProbability and dropProbability when the user asks about either side.
- News questions: answer from the dossier's news block, including the deals, catalysts and risks. If it is null or has no headlines, say the call was chart-only.
- Earnings questions: answer from the dossier's earnings block (next date, beat/miss record, growth, estimates). If it is null, say the feed had no earnings data for this name.
- Pattern questions: answer from the dossier's chartPattern block (swing structure, levels, momentum, volatility).
- Deal questions: answer from the news block's deals list.
- Macro and geopolitics questions: answer from the geopolitics block, including riskTone, themes and the proxy tape.
- If the question needs data this forecast does not have (options, valuation multiples, balance-sheet detail, portfolio, other tickers), say so plainly and point the user to the Analyzer or AI Agent tab instead of guessing.
- Explain for a non-expert: say what the number means, what drives it, and what would change it.
- Be concise: 2–5 sentences, or up to four short bullet lines. Plain text only — no markdown headings, tables or code blocks.
- Never give investment advice or tell the user to buy or sell. If asked, restate the read and the caveats and say this is a statistical forecast, not advice.
- If the question is ambiguous, answer the most likely interpretation and name the assumption in one clause.`;

const RULE_META = { provider: 'rule-engine', model: 'MarketPilot rule engine', cached: false };
const MAX_QUESTION = 600;
const MAX_ANSWER = 4000;
const MAX_HISTORY_TURNS = 6;

const fmtPct = (value, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(digits)}%`;
};
const fmtPrice = (forecast, value) =>
  value === null || value === undefined ? '—' : `${forecast.currency || 'USD'} ${value}`;
const fmtScore = (value) => (value > 0 ? `+${value}` : String(value));

/** Keep only well-formed prior turns, newest six, bounded length. */
export function normalizeHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter(
      (turn) =>
        turn &&
        ['user', 'assistant'].includes(turn.role) &&
        typeof turn.content === 'string' &&
        turn.content.trim().length > 0,
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.content.trim().slice(0, 1200) }));
}

/** Everything the explainer model is allowed to look at. */
export function buildForecastDossier(forecast) {
  if (!forecast?.horizons) return null;

  const compactHorizon = (horizon) => ({
    label: horizon.label,
    horizon: horizon.horizon,
    direction: horizon.direction,
    directionLabel: horizon.directionLabel,
    probability: horizon.probability,
    riseProbability: horizon.riseProbability,
    dropProbability: horizon.dropProbability,
    expectedPct: horizon.expectedPct,
    expectedPrice: horizon.expectedPrice,
    typicalRangePct: { low: horizon.lowPct, high: horizon.highPct },
    typicalRangePrice: { low: horizon.lowPrice, high: horizon.highPrice },
    confidence: horizon.confidence,
    drivers: horizon.drivers || [],
    caveats: horizon.caveats || [],
    analog: {
      matched: horizon.analog?.matched ?? null,
      baseline: horizon.analog?.baseline ?? null,
    },
  });

  return {
    symbol: forecast.symbol,
    name: forecast.name ?? null,
    quoteType: forecast.quoteType ?? 'EQUITY',
    currency: forecast.currency ?? 'USD',
    price: forecast.price ?? null,
    changePercent: forecast.changePercent ?? null,
    asOf: forecast.asOf ?? null,
    window: {
      sessions: forecast.window?.sessions ?? null,
      from: forecast.window?.from ?? null,
      to: forecast.window?.to ?? null,
      changePct: forecast.window?.changePct ?? null,
      high: forecast.window?.high ?? null,
      low: forecast.window?.low ?? null,
    },
    setupScore: forecast.score
      ? { value: forecast.score.value, label: forecast.score.label, direction: forecast.score.direction }
      : null,
    horizons: {
      day: compactHorizon(forecast.horizons.day),
      week: compactHorizon(forecast.horizons.week),
    },
    technicals: forecast.technicals ?? null,
    analog: {
      windowSessions: forecast.analog?.windowSessions ?? null,
      threshold: forecast.analog?.threshold ?? null,
      samples: forecast.analog?.samples ?? null,
      day: forecast.analog?.day ?? null,
      week: forecast.analog?.week ?? null,
      note: forecast.analog?.note ?? null,
    },
    chartPattern: forecast.chartPattern ?? null,
    earnings: forecast.earnings ?? null,
    geopolitics: forecast.geopolitics ?? null,
    call: {
      source: forecast.decisionSourceLabel ?? forecast.source ?? 'MarketPilot rule engine',
      thesis: forecast.analysis?.thesis ?? null,
      newsTakeaway: forecast.analysis?.newsTakeaway ?? null,
      whatWouldChangeMyMind: forecast.analysis?.whatWouldChangeMyMind ?? null,
    },
    news: forecast.news
      ? {
          sentiment: forecast.news.sentiment ?? null,
          label: forecast.news.label ?? null,
          headlineCount: forecast.news.headlineCount ?? null,
          bullish: forecast.news.bullish ?? null,
          bearish: forecast.news.bearish ?? null,
          deals: (forecast.news.deals || []).slice(0, 6).map((item) => ({
            title: item.title,
            direction: item.direction ?? null,
            publishedAt: item.publishedAt ?? null,
          })),
          catalysts: (forecast.news.catalysts || []).slice(0, 6).map((item) => ({
            title: item.title,
            direction: item.direction ?? null,
            tags: item.tags || [],
            publishedAt: item.publishedAt ?? null,
          })),
          risks: (forecast.news.risks || []).slice(0, 4).map((item) => ({
            title: item.title,
            score: item.score ?? null,
            publishedAt: item.publishedAt ?? null,
          })),
          headlines: (forecast.news.headlines || []).map((item) => ({
            title: item.title,
            summary: item.summary ?? null,
            direction: item.direction ?? null,
            publishedAt: item.publishedAt ?? null,
          })),
        }
      : null,
    method: forecast.model?.method ?? null,
    limits: [
      'Built from the last month (21 sessions) of daily candles and their deep pattern read, all ranked Yahoo headlines, the tagged business deals, the earnings report and the macro/geopolitical tape — no options, valuation multiples or portfolio data.',
      `The analog hit rate comes from one ${forecast.window?.sessions ?? 21}-session window in a single market regime and may be small.`,
      'Probabilities are model estimates, not guarantees; a flat read means no directional edge.',
    ],
  };
}

/** Plain text only: the panel renders the answer verbatim, so strip emphasis markers. */
const cleanAnswer = (raw) =>
  String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
    .slice(0, MAX_ANSWER);

/** Ask the model to explain the forecast. Throws on provider failure or an empty answer. */
export async function answerForecastQuestion({ forecast, question, history = [], chat = chatWithLLM }) {
  if (!forecast) throw new Error('There is no forecast to explain');
  const value = String(question ?? '').trim();
  if (value.length < 3) throw new Error('Question is too short');
  if (value.length > MAX_QUESTION) throw new Error(`Keep the question under ${MAX_QUESTION} characters`);

  const dossier = buildForecastDossier(forecast);
  const turns = normalizeHistory(history);
  const started = Date.now();
  const result = await chat({
    messages: [
      { role: 'system', content: FORECAST_SYSTEM_PROMPT },
      ...turns,
      {
        role: 'user',
        content: `Forecast dossier:\n${JSON.stringify(dossier)}\n\nQuestion: ${value}`,
      },
    ],
    tools: [],
  });

  const answer = cleanAnswer(result?.content);
  if (answer.length < 20) throw new Error('The model returned an empty answer');
  return { answer, latencyMs: Date.now() - started, usage: result?.usage };
}

const oddsText = (horizon) =>
  horizon.direction === 'rise'
    ? `${horizon.probability}% chance of a rise, ${horizon.dropProbability}% chance of a drop`
    : horizon.direction === 'drop'
      ? `${horizon.probability}% chance of a drop, ${horizon.riseProbability}% chance of a rise`
      : `no directional edge — ${horizon.riseProbability}% rise vs ${horizon.dropProbability}% drop`;

const describeHorizon = (horizon) =>
  horizon.direction === 'flat'
    ? `no directional edge (${horizon.confidence}% confidence)`
    : `${horizon.direction} with a ${horizon.probability}% probability and ${horizon.confidence}% confidence`;

/**
 * Deterministic, data-grounded answer used when no model is configured or the
 * model call fails. Same evidence, no provider dependency.
 */
export function answerWithEngine(forecast, question = '') {
  if (!forecast?.horizons) return 'There is no forecast to explain yet.';
  const { horizons, technicals, analog, window: view, score } = forecast;
  const day = horizons.day;
  const week = horizons.week;
  const q = String(question).toLowerCase();

  const priceText = (horizon) =>
    `${fmtPrice(forecast, horizon.expectedPrice)} expected (${fmtPct(horizon.expectedPct)}), typical range ` +
    `${fmtPrice(forecast, horizon.lowPrice)} to ${fmtPrice(forecast, horizon.highPrice)}`;

  if (/(confiden|how sure|how certain|trust the)/.test(q)) {
    return [
      `Probability and confidence are not the same thing. Probability is the directional odds — ${oddsText(day)} next session, and ${oddsText(week)} next week. Confidence (${day.confidence}% next session, ${week.confidence}% next week) says how much evidence backs that read.`,
      forecast.source === 'ai'
        ? `The forecast desk sets it after reading the ${view.sessions}-session chart and the headlines: it falls when the chart and the news disagree, when price is stretched from its 20-day mean (${fmtScore(score.value)} composite score) or when the setup is a tight range.`
        : `It rises when the technical readings agree, when the ${view.sessions}-session window contains more comparable setups (${analog.day.matched.samples} for the next session, ${analog.week.matched.samples} for next week) and when the composite score sits far from zero (${fmtScore(score.value)} on a -100 to +100 scale).`,
      'A flat read caps confidence at 45% on purpose, so mixed signals never look decisive.',
    ].join('\n\n');
  }

  if (/(analog|similar|hit rate|reliab|backtest|history|sample|window|learn)/.test(q)) {
    const lines = [
      `${forecast.source === 'ai' ? 'The mechanical cross-check' : 'The model'} learned ${analog.samples} scored sessions from the last ${view.sessions} daily bars (${String(view.from || '').slice(0, 10)} to ${String(view.to || '').slice(0, 10)}).`,
    ];
    lines.push(
      analog.day.matched.samples
        ? `Next-session analog: ${analog.day.matched.samples} comparable setups hit the direction ${analog.day.matched.hitRate}% of the time, against a ${analog.day.baseline.hitRate}% baseline for every usable session in the window; the average next-session move was ${fmtPct(analog.day.matched.avgPct)}.`
        : `Next-session analog: no day cleared the ±${analog.threshold} setup threshold, so that probability is model-only.`,
    );
    lines.push(
      analog.week.matched.samples
        ? `Next-week analog: ${analog.week.matched.samples} comparable setups hit ${analog.week.matched.hitRate}% (baseline ${analog.week.baseline.hitRate}%), averaging ${fmtPct(analog.week.matched.avgPct)} over five sessions.`
        : 'Next-week analog: too few comparable setups to blend a hit rate.',
    );
    lines.push(`This is one ${view.sessions}-session window in one regime, so read the hit rate as context, not proof.`);
    return lines.join('\n\n');
  }

  if (forecast.chartPattern && /(pattern|structure|support|resistance|channel|consolidat|breakout|breakdown|higher high|higher low|swing)/.test(q)) {
    const pattern = forecast.chartPattern;
    return [
      `The ${view.sessions}-session pattern reads as ${String(pattern.label).toLowerCase()} (${pattern.direction} structure, ${pattern.strength}/100 clarity).`,
      pattern.summary,
      pattern.levels?.support || pattern.levels?.resistance
        ? `Key levels: support ${fmtPrice(forecast, pattern.levels.support)}${pattern.levels.supportDistancePct !== null ? ` (${fmtPct(pattern.levels.supportDistancePct, 1)} away)` : ''}, resistance ${fmtPrice(forecast, pattern.levels.resistance)}${pattern.levels.resistanceDistancePct !== null ? ` (${fmtPct(pattern.levels.resistanceDistancePct, 1)} away)` : ''}.`
        : null,
      ...(pattern.caveats || []).map((caveat) => `• ${caveat}`),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  if (forecast.earnings && /(earning|eps|beat|miss|report|guidance|surprise)/.test(q)) {
    const earnings = forecast.earnings;
    return [
      earnings.label ? `${earnings.label}${earnings.nextDate ? ` (${earnings.nextDate})` : ''}.` : 'No scheduled report in the feed.',
      earnings.reportedQuarters
        ? `Last ${earnings.reportedQuarters} quarters: ${earnings.beats} beat and ${earnings.misses} missed, average surprise ${fmtPct(earnings.avgSurprisePct, 1)}.`
        : null,
      Number.isFinite(earnings.revenueGrowthPct) || Number.isFinite(earnings.earningsGrowthPct)
        ? `Growth is running at ${fmtPct(earnings.revenueGrowthPct, 1)} revenue and ${fmtPct(earnings.earningsGrowthPct, 1)} EPS.`
        : null,
      'A report inside the horizon is event risk: the desk keeps the probability modest unless the chart is decisive.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  if (forecast.geopolitics && /(geopolit|macro|tariff|trade war|sanction|conflict|war|oil|vix|fed|rate|risk-off|risk off|dollar)/.test(q)) {
    const geo = forecast.geopolitics;
    const themes = (geo.themes || [])
      .slice(0, 3)
      .map((theme) => `${theme.label} (${theme.direction}, ${theme.headlines} stories)`);
    return [
      `The geopolitical backdrop is ${geo.label}${geo.tilt !== null ? ` with a ${fmtScore(geo.tilt)} tilt` : ''}${geo.riskTone ? ` on a ${geo.riskTone} tape` : ''}.`,
      themes.length ? `Active themes: ${themes.join('; ')}.` : null,
      geo.market?.vix?.price
        ? `VIX is ${geo.market.vix.price}${Number.isFinite(geo.market.vix.changePercent) ? ` (${fmtPct(geo.market.vix.changePercent, 1)})` : ''}.`
        : null,
      geo.summary,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  if (/(risk|invalidat|wrong|downside|caveat|change.*mind|what could)/.test(q)) {
    const sma20 = fmtPrice(forecast, technicals.sma20);
    const invalidation =
      day.direction === 'drop'
        ? `a close back above the 20-day mean (${sma20}) with RSI recovering through 50 would flip the trend readings, while losing the ${view.sessions}-session low (${fmtPrice(forecast, view.low)}) would reinforce the bearish case`
        : day.direction === 'rise'
          ? `losing the 20-day mean (${sma20}) on expanding volume would flip the trend readings, while a break above the ${view.sessions}-session high (${fmtPrice(forecast, view.high)}) would reinforce the bullish case`
          : `a decisive break of the ${view.sessions}-session high (${fmtPrice(forecast, view.high)}) or low (${fmtPrice(forecast, view.low)}) on volume is what would create an edge here`;
    return [
      `The model's own odds leave room for the other side: ${oddsText(day)} next session, ${oddsText(week)} next week.`,
      `Daily volatility is ${fmtPct(technicals.volatilityPct, 2)} and ATR is ${fmtPct(technicals.atrPct, 2)} of price, so even a one-session call carries a typical ${fmtPct(day.lowPct, 2)} to ${fmtPct(day.highPct, 2)} range. The weekly range is ${fmtPct(week.lowPct, 2)} to ${fmtPct(week.highPct, 2)}.`,
      `What would invalidate the read: ${invalidation}.`,
      forecast.earnings?.label
        ? `Event risk: ${forecast.earnings.label}${forecast.earnings.nextDate ? ` (${forecast.earnings.nextDate})` : ''} — an earnings report can override a clean technical read.`
        : null,
      ...week.caveats.map((caveat) => `• ${caveat}`),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  if (/(expected|move|target|price|range|how far)/.test(q)) {
    return [
      `Next session: ${priceText(day)}.`,
      `Next week: ${priceText(week)}.`,
      `The expected move is deliberately small: it is the coin-flip edge times the stock's own typical move (ATR ${fmtPct(technicals.atrPct, 2)} of price, daily volatility ${fmtPct(technicals.volatilityPct, 2)}), not a price target. The range is one standard deviation of that horizon's noise, so price finishing inside it is the normal outcome.`,
    ].join('\n\n');
  }

  if (/(probability|chance|odds|likely|how often)/.test(q)) {
    return [
      `Next session — ${day.directionLabel}: ${oddsText(day)} (${day.confidence}% confidence).`,
      `Next week — ${week.directionLabel}: ${oddsText(week)} (${week.confidence}% confidence).`,
      forecast.source === 'ai'
        ? `These are the forecast desk's calls from the ${view.sessions}-session chart and the headlines; the composite score of ${fmtScore(score.value)} / 100 (${score.label}) and the analog hit rate are kept as a cross-check. A flat read means the desk saw no directional edge, not a hedge.`
        : `These come from the composite setup score of ${fmtScore(score.value)} / 100 (${score.label}), mapped through a logistic curve and blended with the in-window analog hit rate. A flat read means the score and the blended odds both sit close to a coin flip, so the model refuses to force a direction.`,
    ].join('\n\n');
  }

  if (/(rsi|macd|volume|indicator|technical|trend|driver|why|explain|score|model)/.test(q)) {
    const parts = (technicals.parts || [])
      .map(
        (part) =>
          `• ${part.label}: ${part.detail} (${part.score > 0 ? '+' : ''}${Math.round(part.score * 100)} out of ±100)`,
      )
      .join('\n');
    const deskDrivers =
      forecast.source === 'ai'
        ? [
            `Next session, the forecast desk cited: ${(day.drivers || []).map((driver) => `• ${driver}`).join(' ') || 'no specific driver'}.`,
            `Next week: ${(week.drivers || []).map((driver) => `• ${driver}`).join(' ') || 'no specific driver'}.`,
          ]
        : [];
    return [
      `Composite setup score: ${fmtScore(score.value)} / 100 (${score.label}) across the last ${view.sessions} sessions.`,
      ...deskDrivers,
      parts,
      `RSI(14) is ${technicals.rsi14}, price is ${technicals.aboveSma20 ? 'above' : 'below'} its 20-day mean (${fmtPrice(forecast, technicals.sma20)}), the close streak is ${fmtScore(technicals.streak)} session${Math.abs(technicals.streak) === 1 ? '' : 's'} and the up-volume bias is ${fmtScore(technicals.volumeBias)}%.`,
      `The six weighted readings are trend slope 26%, price vs averages 20%, MACD 16%, RSI 14%, range 14% and volume 10%; a stretch penalty then trims the score when price is far from its mean.`,
    ].join('\n\n');
  }

  if (/(should i|buy|sell|trade|invest|advice|position)/.test(q)) {
    return [
      'This page is a statistical forecast, not investment advice, and it knows nothing about your position, horizon or risk budget.',
      `The read itself: next session ${describeHorizon(day)}, next week ${describeHorizon(week)}. Expected moves are ${fmtPct(day.expectedPct)} and ${fmtPct(week.expectedPct)}, with typical ranges of ${fmtPct(day.lowPct)} to ${fmtPct(day.highPct)} and ${fmtPct(week.lowPct)} to ${fmtPct(week.highPct)}.`,
      'Treat the range as the realistic outcome. The Analyzer adds levels, stop and position sizing, and the AI Agent can go deeper on valuation and options than this short-horizon forecast.',
    ].join('\n\n');
  }

  return [
    `${forecast.symbol} is ${fmtPrice(forecast, forecast.price)} after ${fmtPct(view.changePct)} over ${view.sessions} sessions; composite setup score ${fmtScore(score.value)} / 100 (${score.label}).`,
    `Next session — ${oddsText(day)}; expected ${fmtPct(day.expectedPct)} with a ${fmtPct(day.lowPct)} to ${fmtPct(day.highPct)} typical range.`,
    `Next week — ${oddsText(week)}; expected ${fmtPct(week.expectedPct)} with a ${fmtPct(week.lowPct)} to ${fmtPct(week.highPct)} typical range.`,
    'Ask about the analog hit rate, the confidence, the technical drivers or what would invalidate the call — or open the Analyzer for news, fundamentals and trade structure.',
  ].join('\n\n');
}

/**
 * Model answer when a provider is configured, deterministic ground truth when
 * not. Never throws: the caller always gets an answer plus provenance.
 */
export async function answerForecast({
  forecast,
  question,
  history = [],
  chat = chatWithLLM,
  provider = describeProvider(),
}) {
  const engineAnswer = answerWithEngine(forecast, question);

  if (!provider?.live) {
    return {
      answer: engineAnswer,
      source: 'engine',
      decisionMeta: { ...RULE_META },
      decisionError: `No LLM key configured — showing the grounded engine answer (${provider?.label || 'rule engine'}).`,
    };
  }

  try {
    const result = await answerForecastQuestion({ forecast, question, history, chat });
    return {
      answer: result.answer,
      source: 'ai',
      decisionMeta: {
        provider: provider.provider,
        model: provider.model,
        latencyMs: result.latencyMs,
        usage: result.usage,
        cached: false,
      },
      decisionError: null,
    };
  } catch (error) {
    return {
      answer: engineAnswer,
      source: 'engine',
      decisionMeta: { ...RULE_META },
      decisionError: `LLM call failed (${error.message}) — showing the grounded engine answer.`,
    };
  }
}

export const _internals = { cleanAnswer, oddsText, fmtPct };
