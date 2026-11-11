import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_WEIGHTS,
  blendRiseChance,
  buildForecastBoardRow,
  newsToProbability,
  rankForecastRows,
  relativeStrengthToProbability,
} from '../src/analytics/forecastBoard.js';
import { forecastSymbol } from '../src/analytics/forecast.js';
import { BOARD_SCOPES, normalizeBoardDepth, resolveUniverse } from '../src/services/forecastBoardService.js';

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

const forecastFor = (drift) => {
  const bars = makeBars(series(120, (index) => 120 * (1 + drift * index)));
  return forecastSymbol({ symbol: 'TEST', bars, window: 30, price: bars.at(-1).close, name: 'Test Corp.' });
};

const newsFor = (sentiment, { headlines = 5 } = {}) => ({
  sentiment,
  label: sentiment >= 12 ? 'positive' : sentiment <= -12 ? 'negative' : 'mixed',
  headlineCount: headlines,
  counts: { bullish: 3, bearish: 1, neutral: 1 },
  headlines: [{ title: sentiment >= 0 ? 'Beats estimates and raises guidance' : 'Misses estimates and cuts guidance' }],
});

const analysisFor = ({ quality = 72, relativeStrength = 4.2 } = {}) => ({
  score: { total: quality, label: 'Strong' },
  signalLabel: 'strong',
  performance: { relativeStrength },
  alert: { action: 'buy', actionLabel: 'Buy' },
});

test('the blend uses all four parameters and renormalises missing evidence', () => {
  const full = blendRiseChance({
    patternProbability: 70,
    newsSentiment: 40,
    qualityScore: 80,
    relativeStrengthSpread: 5,
  });
  const expected =
    (70 * BOARD_WEIGHTS.pattern +
      (50 + 40 * 0.35) * BOARD_WEIGHTS.news +
      80 * BOARD_WEIGHTS.quality +
      (50 + 5 * 2.5) * BOARD_WEIGHTS.relativeStrength) /
    (BOARD_WEIGHTS.pattern + BOARD_WEIGHTS.news + BOARD_WEIGHTS.quality + BOARD_WEIGHTS.relativeStrength);
  assert.equal(full, Math.round(expected));

  // No news / quality / relative strength: the pattern stands on its own.
  assert.equal(blendRiseChance({ patternProbability: 70 }), 70);
  // Present but neutral evidence tempers a strong pattern without collapsing it.
  const tempered = blendRiseChance({ patternProbability: 70, newsSentiment: 0, qualityScore: 50 });
  assert.ok(tempered < 70 && tempered > 55, `expected a tempered 55-70, got ${tempered}`);
  assert.equal(blendRiseChance({}), null);
});

test('news and relative strength map onto a bounded probability scale', () => {
  assert.equal(newsToProbability(0), 50);
  assert.ok(newsToProbability(40) > 55);
  assert.ok(newsToProbability(-40) < 45);
  assert.equal(newsToProbability(100), 85);
  assert.equal(newsToProbability(-100), 15);
  assert.equal(newsToProbability(null), null);

  assert.equal(relativeStrengthToProbability(0), 50);
  assert.ok(relativeStrengthToProbability(6) > 60);
  assert.ok(relativeStrengthToProbability(-6) < 40);
  assert.equal(relativeStrengthToProbability(100), 95);
  assert.equal(relativeStrengthToProbability(-100), 5);
});

test('the board row carries both horizons, the pattern and the news evidence', () => {
  const forecast = forecastFor(0.004);
  const row = buildForecastBoardRow({ forecast, news: newsFor(30), analysis: analysisFor() });

  assert.ok(row);
  assert.equal(row.symbol, 'TEST');
  assert.equal(row.name, 'Test Corp.');
  assert.ok(row.day.chance >= 1 && row.day.chance <= 99);
  assert.ok(row.week.chance >= 1 && row.week.chance <= 99);
  assert.equal(row.day.direction, row.day.chance >= 55 ? 'rise' : row.day.chance <= 45 ? 'drop' : 'flat');
  assert.equal(row.week.patternProbability, forecast.horizons.week.riseProbability);
  assert.equal(row.pattern.score, forecast.score.value);
  assert.equal(row.news.sentiment, 30);
  assert.equal(row.news.headlineCount, 5);
  assert.match(row.news.topHeadline, /raises guidance/);
  assert.equal(row.relativeStrength, 4.2);
  assert.equal(row.technical.qualityScore, 72);
  assert.equal(row.action, 'buy');
  assert.match(row.why, /news positive/);
  assert.match(row.why, /RS \+4.2pp vs SPY/);
  assert.ok(row.components.some((component) => component.key === 'news'));
  assert.ok(row.components.some((component) => component.key === 'quality'));
  assert.ok(row.components.some((component) => component.key === 'relativeStrength'));
});

test('positive news lifts the chance and negative news lowers it', () => {
  const forecast = forecastFor(0.001);
  const positive = buildForecastBoardRow({ forecast, news: newsFor(45), analysis: analysisFor() });
  const negative = buildForecastBoardRow({ forecast, news: newsFor(-45), analysis: analysisFor() });
  assert.ok(positive.week.chance > negative.week.chance);
  assert.ok(positive.day.chance > negative.day.chance);
  // The pattern is identical, so the whole difference has to come from the news.
  assert.ok(positive.week.chance - negative.week.chance >= 5);
});

test('a headline-less name falls back to the other evidence instead of a news penalty', () => {
  const forecast = forecastFor(0.004);
  const withoutNews = buildForecastBoardRow({ forecast, news: newsFor(0, { headlines: 0 }), analysis: analysisFor({ quality: null, relativeStrength: null }) });
  const noNewsArgument = buildForecastBoardRow({ forecast, news: null, analysis: analysisFor({ quality: null, relativeStrength: null }) });

  assert.equal(withoutNews.news, null);
  assert.equal(withoutNews.week.chance, forecast.horizons.week.riseProbability);
  assert.equal(withoutNews.week.chance, noNewsArgument.week.chance);
});

test('rows rank by week chance first, then by day chance, with a rank assigned', () => {
  const forecast = forecastFor(0.002);
  const strong = buildForecastBoardRow({ forecast, news: newsFor(60), analysis: analysisFor({ quality: 90, relativeStrength: 8 }) });
  const weak = buildForecastBoardRow({ forecast, news: newsFor(-60), analysis: analysisFor({ quality: 30, relativeStrength: -8 }) });
  const middle = buildForecastBoardRow({ forecast, news: newsFor(5), analysis: analysisFor({ quality: 55, relativeStrength: 0 }) });

  const ranked = rankForecastRows([weak, strong, middle]);
  assert.deepEqual(
    ranked.map((row) => row.rank),
    [1, 2, 3],
  );
  assert.ok(ranked[0].week.chance >= ranked[1].week.chance);
  assert.ok(ranked[1].week.chance >= ranked[2].week.chance);
  assert.equal(rankForecastRows([null, undefined]).length, 0);
});

test('the day-trade scope resolves the same liquid universe the intraday board reads', async () => {
  assert.ok(BOARD_SCOPES.includes('daytrade'));
  const universe = await resolveUniverse('daytrade');
  assert.ok(universe.length > 10, `expected a real universe, got ${universe.length}`);
  assert.ok(universe.every((item) => item.symbol && item.name));
  assert.equal(new Set(universe.map((item) => item.symbol)).size, universe.length);
  assert.ok(universe.some((item) => item.quoteType === 'ETF'));
});

test('the board depth is normalised to a bounded scan', () => {
  assert.equal(normalizeBoardDepth(undefined), 10);
  assert.equal(normalizeBoardDepth('8'), 8);
  assert.equal(normalizeBoardDepth(1), 4);
  assert.equal(normalizeBoardDepth(999), 20);
  assert.equal(normalizeBoardDepth('nonsense'), 10);
});
