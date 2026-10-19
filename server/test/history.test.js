import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_LABELS,
  applyHistoryToDecision,
  archiveTrend,
  buildArchivePrompt,
  buildSnapshotRow,
  summarizeMarketHistory,
} from '../src/analytics/history.js';

const analysis = {
  symbol: 'NVDA',
  name: 'NVIDIA Corp.',
  quoteType: 'EQUITY',
  currency: 'USD',
  exchange: 'NasdaqGS',
  assetClass: 'Stock',
  price: 214.13,
  change: 4.1,
  changePercent: 1.95,
  quote: { previousClose: 210.03, volume: 190_000_000, averageVolume: 210_000_000, marketCap: 5.2e12 },
  score: {
    total: 71,
    label: 'Strong',
    confidence: 68,
    components: [{ key: 'technical', label: 'Price structure & plan', score: 74.2, weight: 0.5 }],
  },
  plan: {
    direction: 'long',
    entryRef: 210,
    buyZone: { low: 206.53, high: 213.09 },
    shortZone: null,
    stopLoss: 204.74,
    riskReward: 2.1,
    riskRewardAtSpot: 1.8,
    horizon: '1-8 weeks',
    invalidation: 'Daily close below $204.74',
    targets: [{ label: 'T1', price: 216.83, probability: 62 }],
  },
  alert: { action: 'buy', actionLabel: 'Buy', setup: 'pullback', setupLabel: 'Uptrend pullback', confidence: 64 },
  indicators: { rsi14: 41.2, adx14: 28.4, atr14: 6.1, atrPct: 2.9, volumeRatio: 1.12, sma50: 198.4, sma200: 180.2 },
  levels: { rangePosition: 0.82, nearestSupport: 208.5, nearestResistance: 219.4, fiftyTwoWeekHigh: 230, fiftyTwoWeekLow: 130 },
  fundamentals: {
    sector: 'Technology',
    trailingPE: 48.2,
    forwardPE: 31.4,
    revenueGrowth: 0.62,
    analystTarget: 240,
    recommendationMean: 1.6,
    earningsDate: '2026-11-19T00:00:00.000Z',
  },
  options: { summary: { atmIv: 44.1, ivState: 'rich', expectedMovePct: 6.2, maxPain: 210, pcrOi: 0.82 } },
};

test('a snapshot row carries the quote, plan, call and context for one session', () => {
  const row = buildSnapshotRow(analysis, {
    date: '2026-10-17',
    capturedAt: new Date('2026-10-17T20:05:00Z'),
    news: { sentiment: 18, label: 'bullish', headlineCount: 7, deals: [{ title: 'deal' }] },
    analyst: { tilt: 0.4 },
  });
  assert.equal(row.symbol, 'NVDA');
  assert.equal(row.date, '2026-10-17');
  assert.equal(row.source, 'yahoo-finance-daily');
  assert.equal(row.close, 214.13);
  assert.equal(row.score, 71);
  assert.equal(row.action, 'buy');
  assert.equal(row.setupLabel, 'Uptrend pullback');
  assert.equal(row.buyZoneLow, 206.53);
  assert.equal(row.stopLoss, 204.74);
  assert.equal(row.target1, 216.83);
  assert.equal(row.newsSentiment, 18);
  assert.equal(row.dealCount, 1);
  assert.equal(row.analystTilt, 0.4);
  assert.equal(row.sector, 'Technology');
  assert.equal(row.earningsDate, '2026-11-19');
  assert.equal(row.valuation.forwardPE, 31.4);
  assert.equal(row.options.atmIv, 44.1);
  assert.equal(buildSnapshotRow({ price: 1 }, {}), null, 'a row without a symbol is not archived');
});

const session = (day, close, score, action, extra = {}) => ({
  date: day,
  close,
  score,
  action,
  actionLabel: ACTION_LABELS[action],
  newsSentiment: extra.newsSentiment ?? 0,
  stopLoss: extra.stopLoss ?? 100,
  target1: extra.target1 ?? 120,
  capturedAt: new Date(`${day}T20:00:00Z`),
  ...extra,
});

const risingBook = () =>
  Array.from({ length: 12 }, (_, index) =>
    session(`2026-10-${String(index + 1).padStart(2, '0')}`, 100 + index, index < 7 ? 50 : 62, 'buy'),
  );

test('the history summary measures trend, streak and how the previous calls worked out', () => {
  const history = summarizeMarketHistory('NVDA', risingBook());
  assert.equal(history.symbol, 'NVDA');
  assert.equal(history.coverageDays, 12);
  assert.equal(history.firstDate, '2026-10-01');
  assert.equal(history.lastDate, '2026-10-12');
  assert.equal(history.price.first, 100);
  assert.equal(history.price.last, 111);
  assert.equal(history.price.changePct, 11);

  assert.equal(history.score.latest, 62);
  assert.equal(history.score.avg5, 62);
  assert.equal(history.score.avgPrior5, 50);
  assert.equal(history.score.delta5, 12);
  assert.equal(history.score.trend, 'improving');

  assert.equal(history.action.latest, 'buy');
  assert.equal(history.action.streak, 12);
  assert.equal(history.action.streakSince, '2026-10-01');
  assert.equal(history.action.changes.length, 0);

  assert.equal(history.followThrough.samples, 11);
  assert.equal(history.followThrough.hitRate, 100);
  assert.equal(history.followThrough.avgNextPct, 0.95, 'one point on a rising base, averaged');
  assert.equal(history.followThrough.byAction.buy.samples, 11);

  assert.equal(summarizeMarketHistory('NVDA', []), null, 'no archive means no history');
});

test('an action change ends the streak and is recorded with the date it flipped', () => {
  const rows = risingBook();
  rows[10] = session('2026-10-11', 110, 61, 'hold');
  rows[11] = session('2026-10-12', 111, 60, 'hold');
  const history = summarizeMarketHistory('NVDA', rows);
  assert.equal(history.action.latest, 'hold');
  assert.equal(history.action.streak, 2);
  assert.equal(history.action.streakSince, '2026-10-11');
  assert.equal(history.action.previous, 'buy');
  assert.equal(history.action.previousDate, '2026-10-10');
  assert.deepEqual(history.action.changes.at(-1), { date: '2026-10-11', from: 'buy', to: 'hold' });
});

test('failed calls are visible: a falling tape behind Buy calls yields a low hit rate', () => {
  const rows = Array.from({ length: 11 }, (_, index) =>
    session(`2026-09-${String(index + 1).padStart(2, '0')}`, 200 - index * 2, 60, 'buy'),
  );
  const history = summarizeMarketHistory('AAPL', rows);
  assert.equal(history.followThrough.hitRate, 0);
  assert.equal(history.followThrough.samples, 10);
  assert.equal(history.followThrough.byAction.buy.hitRate, 0);
  assert.equal(history.followThrough.avgNextPct, -1.05);

  // The 11-session Buy streak earns +5, but a 0% follow-through costs it back:
  // conviction never rises on a book of failed calls.
  const applied = applyHistoryToDecision({ action: 'buy', conviction: 60, history });
  assert.equal(applied.conviction, 60);
  assert.ok(applied.risks.some((line) => /followed through only/i.test(line)));

  const freshBuy = applyHistoryToDecision({ action: 'buy', conviction: 60, history: { ...history, action: { latest: 'hold', streak: 3 } } });
  assert.ok(freshBuy.conviction < 60, 'a flip plus failed follow-through both subtract');
});

test('the archive confirms, doubts or contradicts a live call through conviction and notes', () => {
  const history = summarizeMarketHistory('NVDA', risingBook());

  const confirmed = applyHistoryToDecision({ action: 'buy', conviction: 60, history });
  assert.equal(confirmed.conviction, 72, 'streak +5, improving score +3, good follow-through +4');
  assert.equal(confirmed.notes.length, 3);
  assert.match(confirmed.notes[0], /12 consecutive sessions/);
  assert.equal(confirmed.summary.actionStreak, 12);
  assert.equal(confirmed.summary.hitRate, 100);

  const flipped = applyHistoryToDecision({ action: 'hold', conviction: 60, history });
  assert.equal(flipped.conviction, 59, 'the live call is not in the archive yet: -5, good history +4');
  assert.ok(flipped.notes.some((line) => /not in the archive yet/i.test(line)));

  // The call just changed in the latest snapshot: same action, one session old.
  const freshFlip = applyHistoryToDecision({
    action: 'buy',
    conviction: 60,
    history: {
      ...history,
      action: { latest: 'buy', latestLabel: 'Buy', streak: 1, streakSince: '2026-10-12', previous: 'hold', previousDate: '2026-10-11' },
    },
  });
  assert.equal(freshFlip.conviction, 62, 'the flip costs 5, then good history (+4) and an improving score (+3) earn back');
  assert.ok(freshFlip.notes.some((line) => /flipped to Buy in the latest snapshot/i.test(line)));

  const noArchive = applyHistoryToDecision({ action: 'buy', conviction: 60, history: null });
  assert.equal(noArchive.conviction, 60);
  assert.deepEqual(noArchive.notes, []);
  assert.equal(noArchive.summary, null);
});

test('a deteriorating score caps a Buy even when the call still says buy', () => {
  const rows = risingBook().map((row, index) => ({ ...row, score: index < 7 ? 70 : 52 }));
  const history = summarizeMarketHistory('NVDA', rows);
  assert.equal(history.score.trend, 'deteriorating');
  const applied = applyHistoryToDecision({ action: 'buy', conviction: 70, history });
  assert.ok(applied.risks.some((line) => /deteriorating/i.test(line)));
  assert.equal(applied.conviction, 73, 'streak +5 and follow-through +4, minus the 6-point trend penalty');
});

test('the prompt block carries the archived evidence the model must weigh', () => {
  const history = summarizeMarketHistory('NVDA', risingBook());
  const prompt = buildArchivePrompt({
    symbol: 'NVDA',
    history,
    newsHistory: { sentiment7: 18, sentimentPrior7: 4, delta7: 14, direction: 'improving', deals30d: 3 },
  });
  assert.match(prompt, /ARCHIVE — NVDA/);
  assert.match(prompt, /12 daily MongoDB snapshots/);
  assert.match(prompt, /Quality score: 62 now/);
  assert.match(prompt, /Archived call: Buy for 12 consecutive sessions/);
  assert.match(prompt, /Previous archived calls: 100% followed through/);
  assert.match(prompt, /Headline archive/);
  assert.match(prompt, /Last 8 snapshots|Last 12 snapshots/);
  assert.equal(buildArchivePrompt({ symbol: 'NVDA', history: null }), '');
});

test('the compact trend row is what a card can render', () => {
  const history = summarizeMarketHistory('NVDA', risingBook());
  const trend = archiveTrend(history, { action: 'buy' });
  assert.equal(trend.label, 'Buy');
  assert.equal(trend.sameSide, true);
  assert.equal(trend.streak, 12);
  assert.equal(trend.coverageDays, 12);
  assert.equal(trend.scoreDelta5, 12);
  assert.equal(trend.hitRate, 100);
  assert.equal(archiveTrend(null), null);
});
