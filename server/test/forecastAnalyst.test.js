import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastSymbol } from '../src/analytics/forecast.js';
import {
  applyForecastAnalyst,
  buildForecastAnalystDossier,
  mergeForecastPrediction,
  normalizeForecastPrediction,
  summarizeForecastNews,
} from '../src/agent/forecastAnalyst.js';

const series = (length, fn) => Array.from({ length }, (_, index) => fn(index));

function makeBars(closes) {
  return closes.map((close, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    open: index ? closes[index - 1] : close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000_000 + index,
  }));
}

const makeForecast = (symbol = 'NVDA') => {
  const bars = makeBars(series(120, (index) => 100 * (1 + 0.004 * index)));
  return forecastSymbol({ symbol, bars, window: 21, price: bars.at(-1).close, currency: 'USD' });
};

const makeNews = () => ({
  sentiment: 32,
  label: 'positive',
  headlineCount: 2,
  counts: { bullish: 2, bearish: 0, neutral: 0 },
  headlines: [
    {
      title: 'Chipmaker wins a new supply agreement',
      publisher: 'Reuters',
      publishedAt: '2026-04-28T12:00:00.000Z',
      direction: 'bullish',
    },
    {
      title: 'Analysts raise the price target',
      publisher: 'Yahoo Finance',
      publishedAt: '2026-04-27T09:00:00.000Z',
      direction: 'bullish',
    },
  ],
});

const modelAnswer = {
  summary: 'The 1-month chart is in a steady uptrend above its 20-day mean, and the new supply deal supports the next week.',
  newsTakeaway: 'The supply agreement is the headline that mattered.',
  whatWouldChangeMyMind: 'A close below the 20-day mean on heavy volume.',
  day: {
    direction: 'rise',
    probability: 61,
    expectedPct: 0.8,
    rangePct: 2.2,
    confidence: 66,
    drivers: ['Close above the 20-day mean', '10-session slope positive'],
    caveats: ['RSI is approaching 70'],
  },
  week: {
    direction: 'drop',
    probability: 58,
    expectedPct: -2.1,
    rangePct: 4.5,
    confidence: 44,
    drivers: ['Price is stretched from the mean', 'The supply headline is already priced in'],
    caveats: ['One week compounds five sessions of news'],
  },
};

test('the desk dossier carries the 1-month chart, the indicators and the headlines', () => {
  const forecast = makeForecast();
  const dossier = buildForecastAnalystDossier({ forecast, news: makeNews() });

  assert.equal(dossier.window.sessions, 21);
  assert.equal(dossier.candles.length, 21);
  assert.match(dossier.chart, /1 month/i);
  assert.equal(dossier.candles.at(-1).c, forecast.price);
  assert.equal(dossier.news.headlines.length, 2);
  assert.match(dossier.news.headlines[0].title, /supply agreement/i);
  assert.ok(dossier.mechanicalReference.day.probability > 0);
  assert.ok(dossier.technicals.rsi14 > 0);
});

test('the dossier carries the full news set, the deals and the earnings report', () => {
  const news = {
    ...makeNews(),
    headlineCount: 9,
    deals: [{ title: 'Chipmaker signs a $2B supply deal', direction: 'bullish', score: 45 }],
    catalysts: [{ title: 'Chipmaker signs a $2B supply deal', direction: 'bullish', tags: ['Business deal'] }],
    risks: [{ title: 'Export restrictions widen', score: -40 }],
    headlines: Array.from({ length: 9 }, (_, index) => ({
      title: `Headline ${index + 1}`,
      summary: 'Body text for the story.',
      direction: index % 2 ? 'bearish' : 'bullish',
    })),
  };
  const earnings = {
    nextDate: '2026-11-19',
    daysUntil: 9,
    label: 'Earnings in 9 days',
    quarters: [{ quarter: '2026-09-30', epsActual: 1.25, epsEstimate: 1.1, surprisePercent: 13.6 }],
    reportedQuarters: 1,
    beats: 1,
    misses: 0,
    revenueGrowthPct: 22,
    earningsGrowthPct: 31,
    estimates: [],
  };

  const dossier = buildForecastAnalystDossier({ forecast: makeForecast(), news, earnings });
  assert.equal(dossier.news.headlines.length, 9);
  assert.equal(dossier.news.headlines[0].summary, 'Body text for the story.');
  assert.match(dossier.news.deals[0].title, /supply deal/i);
  assert.equal(dossier.news.risks.length, 1);
  assert.equal(dossier.earnings.label, 'Earnings in 9 days');
  assert.equal(dossier.earnings.quarters[0].surprisePercent, 13.6);
});

test('the dossier carries the deep pattern and the geopolitical backdrop', () => {
  const chartPattern = {
    label: 'Higher highs and higher lows (uptrend)',
    direction: 'bullish',
    score: 62,
    summary: 'Steady advance above the 20-day mean.',
    drivers: ['Slope +0.4% per session'],
    caveats: [],
  };
  const geopolitics = {
    label: 'hostile',
    tilt: -38,
    riskTone: 'risk-off',
    themes: [{ key: 'trade', label: 'Trade & tariffs', direction: 'bearish', headlines: 3 }],
    market: { vix: { price: 29 } },
  };

  const dossier = buildForecastAnalystDossier({
    forecast: { ...makeForecast(), chartPattern },
    news: makeNews(),
    geopolitics,
  });

  assert.equal(dossier.chartPattern.score, 62);
  assert.match(dossier.chartPattern.label, /uptrend/i);
  assert.equal(dossier.geopolitics.riskTone, 'risk-off');
  assert.equal(dossier.geopolitics.themes[0].key, 'trade');
});

test('model takeaways for pattern, deals and macro are kept on the published read', () => {
  const forecast = makeForecast();
  const prediction = normalizeForecastPrediction(
    {
      ...modelAnswer,
      patternTakeaway: 'Higher highs and higher lows support the next session.',
      dealTakeaway: 'The supply agreement underpins the week.',
      macroTakeaway: 'A hostile tariff backdrop caps the upside.',
    },
    forecast,
  );

  assert.match(prediction.patternTakeaway, /Higher highs/);
  assert.match(prediction.dealTakeaway, /supply agreement/i);
  assert.match(prediction.macroTakeaway, /tariff/i);

  const merged = mergeForecastPrediction({
    forecast,
    prediction,
    news: summarizeForecastNews(makeNews()),
    earnings: { label: 'Earnings in 9 days' },
    geopolitics: { label: 'hostile', tilt: -30 },
    decisionMeta: { provider: 'openai', model: 'test-model', cached: false },
  });

  assert.equal(merged.analysis.patternTakeaway, prediction.patternTakeaway);
  assert.equal(merged.analysis.macroTakeaway, prediction.macroTakeaway);
  assert.equal(merged.geopolitics.label, 'hostile');
  assert.equal(merged.earnings.label, 'Earnings in 9 days');
  assert.equal(merged.analysis.evidence.macro, 'hostile');
});

test('the dossier tells the model when there are no headlines', () => {
  const dossier = buildForecastAnalystDossier({ forecast: makeForecast(), news: summarizeForecastNews(null) });
  assert.equal(dossier.news.headlineCount, 0);
  assert.match(dossier.news.note, /chart only|chart-only/i);
});

test('a model answer replaces both calls but keeps the mechanical evidence', () => {
  const forecast = makeForecast();
  const prediction = normalizeForecastPrediction(modelAnswer, forecast);
  const merged = mergeForecastPrediction({
    forecast,
    prediction,
    news: summarizeForecastNews(makeNews()),
    decisionMeta: { provider: 'openai', model: 'test-model', cached: false },
  });

  assert.equal(merged.source, 'ai');
  assert.equal(merged.decisionSourceLabel, 'openai · test-model');
  assert.equal(merged.analysis.thesis, modelAnswer.summary);
  assert.equal(merged.analysis.whatWouldChangeMyMind, modelAnswer.whatWouldChangeMyMind);
  assert.equal(merged.news.headlines.length, 2);

  const day = merged.horizons.day;
  assert.equal(day.direction, 'rise');
  assert.equal(day.probability, 61);
  assert.equal(day.riseProbability, 61);
  assert.equal(day.dropProbability, 39);
  assert.equal(day.expectedPct, 0.8);
  assert.equal(day.expectedPrice, Number((forecast.price * 1.008).toFixed(2)));
  assert.equal(day.confidence, 66);
  assert.deepEqual(day.drivers, modelAnswer.day.drivers);

  const week = merged.horizons.week;
  assert.equal(week.direction, 'drop');
  assert.equal(week.probability, 58);
  assert.equal(week.riseProbability, 42);
  assert.equal(week.dropProbability, 58);
  assert.ok(week.lowPrice < forecast.price && week.highPrice > forecast.price);

  // The technical read and the analog replay are still attached for the Q&A.
  assert.equal(merged.score.value, forecast.score.value);
  assert.equal(merged.technicals.score, forecast.technicals.score);
  assert.equal(merged.horizons.day.analog, forecast.horizons.day.analog);
});

test('flat calls are normalised to a coin flip and capped confidence', () => {
  const forecast = makeForecast();
  const prediction = normalizeForecastPrediction(
    {
      ...modelAnswer,
      day: { direction: 'flat', probability: 78, expectedPct: 0, rangePct: 1.5, confidence: 80 },
    },
    forecast,
  );

  assert.equal(prediction.day.direction, 'flat');
  assert.equal(prediction.day.probability, 50);
  assert.equal(prediction.day.riseProbability, 50);
  assert.ok(prediction.day.confidence <= 45);
});

test('a named direction must agree with its own probability and expected move', () => {
  const forecast = makeForecast();
  const prediction = normalizeForecastPrediction(
    {
      ...modelAnswer,
      day: { direction: 'rise', probability: 38, expectedPct: -1.2, rangePct: 2, confidence: 70 },
      week: { direction: 'drop', probability: 62, expectedPct: 1.4, rangePct: 4, confidence: 60 },
    },
    forecast,
  );

  // A 'rise' with a 38% chance is a no-edge read, not a directional call.
  assert.equal(prediction.day.direction, 'flat');
  assert.equal(prediction.day.probability, 50);
  assert.equal(prediction.day.expectedPct, 0);
  assert.ok(prediction.day.confidence <= 45);

  // A drop that expects a higher price is corrected to a zero expected move.
  assert.equal(prediction.week.direction, 'drop');
  assert.equal(prediction.week.expectedPct, 0);
  assert.equal(prediction.week.expectedPrice, forecast.price);
});

test('a partial model answer is rejected so the page can fall back intact', () => {
  assert.throws(() => normalizeForecastPrediction({ day: modelAnswer.day }, makeForecast()), /both the day and the week/i);
});

test('no API key keeps the mechanical 1-month forecast and the news evidence', async () => {
  const forecast = makeForecast();
  const result = await applyForecastAnalyst({
    forecast,
    news: makeNews(),
    earnings: { label: 'Earnings in 9 days', daysUntil: 9 },
    provider: { live: false, provider: 'builtin', model: 'rule', label: 'built-in analyst' },
  });

  assert.equal(result.source, 'engine');
  assert.match(result.decisionError, /No LLM key configured/);
  assert.deepEqual(result.horizons, forecast.horizons);
  assert.equal(result.news.headlineCount, 2);
  assert.equal(result.earnings.label, 'Earnings in 9 days');
});

test('a provider failure keeps the mechanical forecast and names the error', async () => {
  const result = await applyForecastAnalyst({
    forecast: makeForecast(),
    news: makeNews(),
    provider: { live: true, provider: 'openai', model: 'test-model', label: 'openai · test-model' },
    chat: async () => {
      throw new Error('503 Service Unavailable');
    },
  });

  assert.equal(result.source, 'engine');
  assert.match(result.decisionError, /503/);
  assert.match(result.decisionError, /mechanical 1-month model/);
});

test('a live model answer becomes the published forecast', async () => {
  const forecast = makeForecast('SPY');
  const result = await applyForecastAnalyst({
    forecast,
    news: makeNews(),
    provider: { live: true, provider: 'openai', model: 'test-model', label: 'openai · test-model' },
    chat: async ({ messages }) => {
      // The dossier must be in a user message, not hidden in the system prompt,
      // and the last turn must restate the strict JSON format.
      const dossier = messages.find((message) => message.role === 'user' && /"candles"/.test(message.content));
      assert.ok(dossier, 'dossier must be sent as a user message');
      assert.match(dossier.content, /supply agreement/i);
      assert.match(messages.at(-1).content, /Return ONLY the minified JSON object/);
      return { content: `\`\`\`json\n${JSON.stringify(modelAnswer)}\n\`\`\``, usage: { total_tokens: 21 } };
    },
  });

  assert.equal(result.source, 'ai');
  assert.equal(result.decisionMeta.model, 'test-model');
  assert.equal(result.decisionMeta.usage.total_tokens, 21);
  assert.equal(result.horizons.day.probability, 61);
  assert.equal(result.horizons.week.direction, 'drop');
  assert.equal(result.decisionError, null);
});
