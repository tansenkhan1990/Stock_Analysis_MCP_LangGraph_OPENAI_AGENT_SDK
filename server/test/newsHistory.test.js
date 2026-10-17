import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHistory } from '../src/services/newsHistoryService.js';

const digest = (date, sentiment, dealCount = 0, headlineCount = 5) => ({
  date,
  sentiment,
  label: sentiment >= 12 ? 'positive' : sentiment <= -12 ? 'negative' : 'mixed',
  headlineCount,
  dealCount,
  counts: { bullish: 2, bearish: 1, neutral: 2 },
});

test('empty history has no summary', () => {
  assert.equal(summarizeHistory('NVDA', []), null);
});

test('a single day is flat with no comparison window', () => {
  const summary = summarizeHistory('NVDA', [digest('2026-10-17', 22, 2, 3)]);
  assert.equal(summary.coverageDays, 1);
  assert.equal(summary.sentiment7, 22);
  assert.equal(summary.sentimentPrior7, null);
  assert.equal(summary.delta7, null);
  assert.equal(summary.direction, 'flat');
  assert.equal(summary.deals30d, 2);
  assert.equal(summary.headlines30d, 3);
});

test('the 7-day read is compared with the prior week', () => {
  const rows = [
    // prior week: mildly negative
    ...Array.from({ length: 7 }, (_, index) => digest(`2026-10-0${index + 1}`, -20)),
    // last week: clearly positive
    ...Array.from({ length: 7 }, (_, index) => digest(`2026-10-${String(index + 8).padStart(2, '0')}`, 20)),
  ];
  const summary = summarizeHistory('MSFT', rows);
  assert.equal(summary.coverageDays, 14);
  assert.equal(summary.sentiment7, 20);
  assert.equal(summary.sentimentPrior7, -20);
  assert.equal(summary.delta7, 40);
  assert.equal(summary.direction, 'improving');
  assert.equal(summary.firstDate, '2026-10-01');
  assert.equal(summary.lastDate, '2026-10-14');
  assert.equal(summary.headlines30d, 70);
});

test('deteriorating coverage is labelled, small moves stay flat', () => {
  const week = (value, start) =>
    Array.from({ length: 7 }, (_, index) => digest(`2026-09-${String(start + index).padStart(2, '0')}`, value));

  const worse = summarizeHistory('TSLA', [...week(30, 1), ...week(-10, 8)]);
  assert.equal(worse.direction, 'deteriorating');
  assert.equal(worse.delta7, -40);

  const noise = summarizeHistory('TSLA', [...week(10, 1), ...week(14, 8)]);
  assert.equal(noise.direction, 'flat');
  assert.equal(noise.delta7, 4);
});
