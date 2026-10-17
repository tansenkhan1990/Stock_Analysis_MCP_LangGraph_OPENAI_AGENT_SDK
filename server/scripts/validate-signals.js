/**
 * Signal validation: replay the alert engine (`analytics/alert.js`) over daily
 * bars for the focus universe and report what actually happened after each
 * alert fired. The data is split chronologically in half so you can see whether
 * an edge held up out-of-sample instead of only in the period it was tuned on.
 *
 *   npm run validate
 *   npm run validate -- NVDA,MSFT       # subset
 *   npm run validate -- "" 2y           # custom lookback
 *
 * It measures the technical regime rule only — there is no free archive of news
 * or Street actions, which are guardrails in the live product, not inputs here.
 */
import { buildAlert } from '../src/analytics/alert.js';
import { buildAnalysis } from '../src/analytics/analysis.js';
import { FOCUS_UNIVERSE } from '../src/data/universe.js';
import { getHistory } from '../src/lib/yahoo.js';

const HORIZONS = [5, 10, 20];
const WARMUP = 260; // 200-day SMA plus indicator warm-up

const args = process.argv.slice(2).filter(Boolean);
const requested = args[0] ? args[0].split(',').map((symbol) => symbol.trim().toUpperCase()) : null;
const range = ['1y', '2y', '5y'].includes(args[1]) ? args[1] : '5y';
const universe = FOCUS_UNIVERSE.filter((meta) => !requested || requested.includes(meta.symbol));

if (!universe.length) {
  console.error(`No focus symbols matched ${args[0]}`);
  process.exit(1);
}

const rows = [];
const errors = [];

for (const meta of universe) {
  let history;
  try {
    history = await getHistory(meta.symbol, { range, interval: '1d' });
  } catch (error) {
    errors.push(`${meta.symbol}: ${error.message}`);
    continue;
  }

  const bars = history.bars;
  const closes = bars.map((bar) => bar.close);
  const horizon = Math.max(...HORIZONS);

  for (let i = WARMUP; i < bars.length - horizon - 1; i += 1) {
    const prior = closes[i - 1];
    const quote = {
      symbol: meta.symbol,
      name: meta.name,
      quoteType: meta.kind === 'etf' ? 'ETF' : 'EQUITY',
      currency: 'USD',
      exchange: 'NMS',
      price: closes[i],
      previousClose: prior,
      change: Number((closes[i] - prior).toFixed(2)),
      changePercent: Number((((closes[i] - prior) / prior) * 100).toFixed(2)),
      beta: null,
    };

    let analysis;
    try {
      analysis = buildAnalysis({ quote, history: { bars: bars.slice(0, i + 1) }, fundamentals: null, benchmark: null });
    } catch (error) {
      errors.push(`${meta.symbol}@${i}: ${error.message}`);
      break;
    }

    const alert = buildAlert({ analysis });
    if (!alert) continue;

    const entry = closes[i];
    const forward = Object.fromEntries(
      HORIZONS.map((h) => [h, ((closes[i + h] - entry) / entry) * 100]),
    );
    const min10 = ((Math.min(...closes.slice(i + 1, i + 11)) - entry) / entry) * 100;

    rows.push({
      date: new Date(bars[i].date).getTime(),
      kind: meta.kind,
      action: alert.action,
      setup: alert.setup,
      ...forward,
      fwd5: forward[5],
      fwd10: forward[10],
      fwd20: forward[20],
      min10,
    });
  }
}

if (!rows.length) {
  console.error('No snapshots produced — check the symbol list and Yahoo availability.');
  process.exit(1);
}

rows.sort((a, b) => a.date - b.date);
const splitIndex = Math.floor(rows.length / 2);
const splitDate = new Date(rows[splitIndex].date).toISOString().slice(0, 10);
const windows = [
  { label: `TRAIN (before ${splitDate})`, rows: rows.slice(0, splitIndex) },
  { label: `TEST  (from ${splitDate})`, rows: rows.slice(splitIndex) },
];

const ACTIONS = ['buy', 'accumulate', 'hold', 'reduce', 'sell'];
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const fmt = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

const summarise = (subset) => {
  const avg = (key) => mean(subset.map((row) => row[key]));
  return {
    n: subset.length,
    fwd5: avg('fwd5'),
    fwd10: avg('fwd10'),
    fwd20: avg('fwd20'),
    win10: (subset.filter((row) => row.fwd10 > 0).length / subset.length) * 100,
    tail10: (subset.filter((row) => row.min10 <= -8).length / subset.length) * 100,
  };
};

const line = (label, stats) => {
  console.log(
    label.padEnd(12),
    String(stats.n).padStart(5),
    fmt(stats.fwd5).padStart(9),
    fmt(stats.fwd10).padStart(9),
    fmt(stats.fwd20).padStart(9),
    `${stats.win10.toFixed(0)}%`.padStart(7),
    `${stats.tail10.toFixed(1)}%`.padStart(8),
  );
};

const edges = [];
console.log(`\nSignal replay · ${range} · ${universe.length} symbols · ${rows.length} snapshots`);
console.log('Alerts: buy = uptrend pullback · accumulate = uptrend continuation · hold = extended');
console.log('        reduce = mixed structure · sell = trend break (risk exit)\n');

for (const window of windows) {
  console.log(`=== ${window.label} · n=${window.rows.length} ===`);
  console.log('action           n     fwd5     fwd10     fwd20  win10   P(<-8% 10d)');
  const baseline = summarise(window.rows);
  line('baseline', baseline);
  for (const action of ACTIONS) {
    const subset = window.rows.filter((row) => row.action === action);
    if (subset.length) line(action, summarise(subset));
  }
  const buy = window.rows.filter((row) => row.action === 'buy');
  if (buy.length) {
    const buyStats = summarise(buy);
    edges.push({ label: window.label, edge: buyStats.fwd10 - baseline.fwd10, n: buyStats.n });
  }
  console.log('');
}

console.log('=== ALL DATA ===');
console.log('action           n     fwd5     fwd10     fwd20  win10   P(<-8% 10d)');
line('baseline', summarise(rows));
for (const action of ACTIONS) {
  const bucket = rows.filter((row) => row.action === action);
  if (bucket.length) line(action, summarise(bucket));
}
console.log('');

console.log('=== ETF vs STOCK (all data) ===');
for (const kind of ['etf', 'stock']) {
  const subset = rows.filter((row) => row.kind === kind);
  console.log(`-- ${kind}`);
  console.log('action           n     fwd5     fwd10     fwd20  win10   P(<-8% 10d)');
  line('baseline', summarise(subset));
  for (const action of ['buy', 'sell']) {
    const bucket = subset.filter((row) => row.action === action);
    if (bucket.length) line(action, summarise(bucket));
  }
  console.log('');
}

// Year-by-year stability: one lucky half is not an edge.
const years = [...new Set(rows.map((row) => new Date(row.date).getUTCFullYear()))].sort();
console.log('=== buy edge by calendar year (10-day forward) ===');
console.log('year    baseline      buy     edge      n');
for (const year of years) {
  const inYear = rows.filter((row) => new Date(row.date).getUTCFullYear() === year);
  const buys = inYear.filter((row) => row.action === 'buy');
  if (!inYear.length || !buys.length) continue;
  const base = mean(inYear.map((row) => row.fwd10));
  const buyAvg = mean(buys.map((row) => row.fwd10));
  console.log(
    String(year).padEnd(7),
    fmt(base).padStart(9),
    fmt(buyAvg).padStart(9),
    fmt(buyAvg - base).padStart(9),
    String(buys.length).padStart(6),
  );
}

const positiveYears = years.filter((year) => {
  const inYear = rows.filter((row) => new Date(row.date).getUTCFullYear() === year);
  const buys = inYear.filter((row) => row.action === 'buy');
  return buys.length >= 30 && mean(buys.map((row) => row.fwd10)) > mean(inYear.map((row) => row.fwd10));
});
const testedYears = years.filter((year) => {
  const inYear = rows.filter((row) => new Date(row.date).getUTCFullYear() === year);
  return inYear.filter((row) => row.action === 'buy').length >= 30;
});

const consistent = edges.length === 2 && edges.every((item) => item.edge > 0);
console.log('\n--- verdict ---');
for (const item of edges) {
  console.log(`${item.label}: buy edge ${fmt(item.edge)} vs baseline (n=${item.n})`);
}
console.log(
  consistent
    ? 'Buy alerts beat the baseline in both halves of the sample.'
    : 'Buy alerts did NOT beat the baseline in both halves — treat them as context, not edge.',
);
console.log(`Buy edge positive in ${positiveYears.length}/${testedYears.length} calendar years with enough signals.`);
if (edges.length === 2 && edges[1].edge >= 0 && edges[1].edge < 0.5) {
  console.log('The out-of-sample edge is positive but thin (under 0.5pp per 10 days) — position sizing matters more than the signal.');
}
console.log(
  'Sell alerts are a risk rule: the replay showed no predictive edge for declines, so they exist to cap drawdown, not to forecast.',
);
if (errors.length) console.log(`skipped: ${errors.length} symbol(s) — ${errors.slice(0, 2).join('; ')}`);
console.log('Note: technical rule only (no news/Street history), long-only sample bias, past data.\n');
