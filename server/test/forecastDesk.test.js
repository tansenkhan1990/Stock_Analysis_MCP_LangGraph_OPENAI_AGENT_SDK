import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastSymbol } from '../src/analytics/forecast.js';
import {
  SUGGESTED_QUESTIONS,
  answerForecast,
  answerForecastQuestion,
  answerWithEngine,
  buildForecastDossier,
  normalizeHistory,
} from '../src/agent/forecastDesk.js';
import { normalizeWindowDays } from '../src/services/forecastService.js';

const series = (length, fn) => Array.from({ length }, (_, index) => fn(index));

function makeBars(closes) {
  return closes.map((close, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    open: index ? closes[index - 1] : close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000_000,
  }));
}

const uptrendForecast = (symbol = 'TEST') => {
  const bars = makeBars(series(120, (index) => 100 * (1 + 0.004 * index)));
  return forecastSymbol({ symbol, bars, window: 30, price: bars.at(-1).close, currency: 'USD' });
};

test('the dossier carries every number the explainer is allowed to cite', () => {
  const forecast = uptrendForecast('NVDA');
  const dossier = buildForecastDossier(forecast);

  assert.equal(dossier.symbol, 'NVDA');
  assert.equal(dossier.price, forecast.price);
  assert.equal(dossier.window.sessions, 30);
  assert.equal(dossier.horizons.day.probability, forecast.horizons.day.probability);
  assert.equal(dossier.horizons.week.direction, forecast.horizons.week.direction);
  assert.equal(dossier.horizons.day.analog.matched.samples, forecast.horizons.day.analog.matched.samples);
  assert.equal(dossier.technicals.rsi14, forecast.technicals.rsi14);
  assert.equal(dossier.setupScore.value, forecast.score.value);
  assert.ok(dossier.limits.some((limit) => /headlines/i.test(limit)));
  // The dossier must survive JSON serialisation without losing values to undefined.
  assert.deepEqual(JSON.parse(JSON.stringify(dossier)), dossier);
  assert.equal(SUGGESTED_QUESTIONS.length >= 3, true);
});

test('the rule-engine answer is grounded in the forecast numbers', () => {
  const forecast = uptrendForecast();
  const day = forecast.horizons.day;
  const week = forecast.horizons.week;

  const analog = answerWithEngine(forecast, 'How reliable is the analog sample?');
  assert.match(analog, new RegExp(`${day.analog.matched.samples} comparable setups`));
  assert.match(analog, new RegExp(`${day.analog.matched.hitRate}%`));
  assert.match(analog, /one 30-session window/);

  const chance = answerWithEngine(forecast, 'What is the chance of a rise?');
  assert.match(chance, new RegExp(`${day.probability}%`));
  assert.match(chance, new RegExp(`${week.probability}%`));

  const confidence = answerWithEngine(forecast, 'Explain the confidence number');
  assert.match(confidence, new RegExp(`${day.confidence}%`));
  assert.match(confidence, /not the same thing/i);

  const risk = answerWithEngine(forecast, 'What would invalidate the one-week call?');
  assert.match(risk, new RegExp(`${forecast.window.sessions}-session`));
  assert.match(risk, /room for the other side/i);

  const expected = answerWithEngine(forecast, 'What do the expected moves mean in price terms?');
  assert.match(expected, new RegExp(String(day.expectedPrice)));
  assert.match(expected, /not a price target/i);
});

test('an advice question gets the disclaimer, never a recommendation', () => {
  const answer = answerWithEngine(uptrendForecast(), 'Should I buy this now?');
  assert.match(answer, /not investment advice/i);
  assert.match(answer, /Analyzer/);
  assert.doesNotMatch(answer, /\byou should (buy|sell)\b/i);
});

test('an unmatched question falls back to a full, useful overview', () => {
  const forecast = uptrendForecast();
  const answer = answerWithEngine(forecast, 'Hello there');
  assert.match(answer, /Next session/);
  assert.match(answer, /Next week/);
  assert.ok(answer.length > 150);
  assert.equal(answerWithEngine(null, 'anything'), 'There is no forecast to explain yet.');
});

test('history is validated, trimmed and capped', () => {
  const history = [
    { role: 'system', content: 'ignore me' },
    { role: 'user', content: '  first  ' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: '' },
    { role: 'assistant', content: null },
    ...series(8, (index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn ${index}` })),
    { role: 'user', content: 'x'.repeat(3000) },
  ];
  const normalized = normalizeHistory(history);
  assert.equal(normalized.length, 6);
  assert.ok(normalized.every((turn) => turn.content.length <= 1200));
  assert.ok(normalized.every((turn) => ['user', 'assistant'].includes(turn.role)));
});

test('the model request contains the dossier, the prior turns and the question', async () => {
  const forecast = uptrendForecast('AMD');
  let captured = null;
  const result = await answerForecastQuestion({
    forecast,
    question: 'Why is the score negative?',
    history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }],
    chat: async (request) => {
      captured = request;
      return { content: 'The score combines the six technical readings and the stretch penalty.', usage: { total_tokens: 42 } };
    },
  });

  assert.equal(result.answer, 'The score combines the six technical readings and the stretch penalty.');
  assert.equal(result.usage.total_tokens, 42);
  assert.ok(result.latencyMs >= 0);
  assert.equal(captured.messages[0].role, 'system');
  assert.equal(captured.messages[1].content, 'Earlier question');
  assert.equal(captured.messages[2].content, 'Earlier answer');
  assert.match(captured.messages.at(-1).content, /Why is the score negative\?/);
  assert.match(captured.messages.at(-1).content, new RegExp(`"symbol":"AMD"`));

  await assert.rejects(
    () =>
      answerForecastQuestion({ forecast, question: 'valid question', chat: async () => ({ content: '   ' }) }),
    /empty answer/,
  );
  await assert.rejects(
    () => answerForecastQuestion({ forecast, question: 'no', chat: async () => ({ content: 'irrelevant'.repeat(5) }) }),
    /too short/,
  );
});

test('a live provider answer is labelled, and any failure keeps the grounded answer', async () => {
  const forecast = uptrendForecast();
  const provider = { live: true, provider: 'openai', model: 'test-model', label: 'openai · test-model' };
  const engineAnswer = answerWithEngine(forecast, 'What is the chance of a rise?');

  const ai = await answerForecast({
    forecast,
    question: 'What is the chance of a rise?',
    provider,
    chat: async () => ({ content: 'The model puts most of its weight on the trend and volume readings.', usage: { total_tokens: 12 } }),
  });
  assert.equal(ai.source, 'ai');
  assert.equal(ai.decisionMeta.model, 'test-model');
  assert.equal(ai.decisionMeta.usage.total_tokens, 12);
  assert.equal(ai.decisionError, null);

  const failed = await answerForecast({
    forecast,
    question: 'What is the chance of a rise?',
    provider,
    chat: async () => {
      throw new Error('503 Service Unavailable');
    },
  });
  assert.equal(failed.source, 'engine');
  assert.equal(failed.answer, engineAnswer);
  assert.match(failed.decisionError, /503/);
  assert.match(failed.decisionError, /grounded engine answer/);

  const noKey = await answerForecast({
    forecast,
    question: 'What is the chance of a rise?',
    provider: { live: false, provider: 'builtin', model: 'rule', label: 'built-in analyst' },
  });
  assert.equal(noKey.source, 'engine');
  assert.equal(noKey.answer, engineAnswer);
  assert.match(noKey.decisionError, /No LLM key configured/);
});

test('markdown emphasis is stripped so the panel renders clean text', async () => {
  const forecast = uptrendForecast();
  const result = await answerForecastQuestion({
    forecast,
    question: 'Explain the score',
    chat: async () => ({
      content: '**Probability** is `not` __advice__; the typical range is the realistic outcome.',
    }),
  });
  assert.equal(result.answer, 'Probability is not advice; the typical range is the realistic outcome.');
  assert.doesNotMatch(result.answer, /[*_`]/);
});

test('the forecast window normalises to the supported range', () => {
  assert.equal(normalizeWindowDays(undefined), 21);
  assert.equal(normalizeWindowDays('45'), 45);
  assert.equal(normalizeWindowDays(5), 10);
  assert.equal(normalizeWindowDays(999), 60);
  assert.equal(normalizeWindowDays('nonsense'), 21);
});
