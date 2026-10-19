/**
 * Archive analytics: everything the app learns from its own daily snapshots.
 *
 * A live Yahoo quote answers "where is it now". These functions answer "where
 * has it been, has the call been stable, and did the previous calls work" —
 * which is what makes a decision grounded in both the database and the live
 * feed instead of only the current bar.
 *
 * Pure by design: the MongoDB layer hands in rows, and every transformation
 * here (trends, streaks, follow-through, prompt text, snapshot document) can be
 * unit-tested without a database or a network.
 */

export const SNAPSHOT_SOURCE = 'yahoo-finance-daily';
export const ACTION_SEQUENCE = ['sell', 'reduce', 'hold', 'accumulate', 'buy'];
export const ACTION_LABELS = {
  buy: 'Buy',
  accumulate: 'Accumulate',
  hold: 'Hold',
  reduce: 'Reduce',
  sell: 'Sell',
};

const round = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const avg = (list) => (list.length ? list.reduce((acc, value) => acc + value, 0) / list.length : null);
const dayKey = (date = new Date()) => new Date(date).toISOString().slice(0, 10);
const label = (action) => ACTION_LABELS[action] || null;
const closeOf = (row) => (Number.isFinite(row?.close) ? row.close : Number.isFinite(row?.quote?.price) ? row.quote.price : null);

/** Snapshot document for one symbol for one session (written by the daily job). */
export function buildSnapshotRow(analysis, { date = new Date(), capturedAt = new Date(), news = null, analyst = null } = {}) {
  if (!analysis?.symbol) return null;
  const plan = analysis.plan || {};
  const alert = analysis.alert || {};
  const ind = analysis.indicators || {};
  const levels = analysis.levels || {};
  const score = analysis.score || {};
  const fundamentals = analysis.fundamentals || null;
  const options = analysis.options?.summary || null;
  const targets = plan.targets || [];

  return {
    symbol: analysis.symbol,
    date: typeof date === 'string' ? date : dayKey(date),
    capturedAt: capturedAt instanceof Date ? capturedAt : new Date(capturedAt),
    source: SNAPSHOT_SOURCE,

    name: analysis.name || analysis.symbol,
    quoteType: analysis.quoteType || 'EQUITY',
    currency: analysis.currency || 'USD',
    exchange: analysis.exchange || null,
    assetClass: analysis.assetClass || null,

    close: analysis.price ?? null,
    previousClose: analysis.quote?.previousClose ?? null,
    change: analysis.change ?? null,
    changePercent: analysis.changePercent ?? null,
    volume: analysis.quote?.volume ?? null,
    averageVolume: analysis.quote?.averageVolume ?? null,
    marketCap: analysis.quote?.marketCap ?? null,
    fiftyTwoWeekHigh: analysis.levels?.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: analysis.levels?.fiftyTwoWeekLow ?? null,

    score: score.total ?? null,
    scoreLabel: score.label ?? null,
    confidence: score.confidence ?? null,
    scoreComponents: (score.components || []).map((component) => ({
      key: component.key,
      label: component.label,
      score: round(component.score, 1),
      weight: component.weight,
    })),

    direction: plan.direction ?? null,
    entryRef: plan.entryRef ?? null,
    buyZoneLow: plan.buyZone?.low ?? null,
    buyZoneHigh: plan.buyZone?.high ?? null,
    shortZoneLow: plan.shortZone?.low ?? null,
    shortZoneHigh: plan.shortZone?.high ?? null,
    stopLoss: plan.stopLoss ?? null,
    riskReward: plan.riskReward ?? null,
    riskRewardAtSpot: plan.riskRewardAtSpot ?? null,
    horizon: plan.horizon ?? null,
    invalidation: plan.invalidation ?? null,
    target1: targets[0]?.price ?? null,
    target2: targets[1]?.price ?? null,
    target3: targets[2]?.price ?? null,
    target1Probability: targets[0]?.probability ?? null,

    action: alert.action ?? null,
    actionLabel: alert.actionLabel ?? null,
    setup: alert.setup ?? null,
    setupLabel: alert.setupLabel ?? null,
    actionConfidence: alert.confidence ?? null,

    rsi14: ind.rsi14 ?? null,
    macdHistogram: ind.macdHistogram ?? null,
    adx14: ind.adx14 ?? null,
    atr14: ind.atr14 ?? null,
    atrPct: ind.atrPct ?? null,
    volumeRatio: ind.volumeRatio ?? null,
    annualizedVolatility: ind.annualizedVolatility ?? null,
    maxDrawdown: ind.maxDrawdown ?? null,
    sma20: ind.sma20 ?? null,
    sma50: ind.sma50 ?? null,
    sma200: ind.sma200 ?? null,
    rangePosition: levels.rangePosition ?? null,
    supportNearest: levels.nearestSupport ?? null,
    resistanceNearest: levels.nearestResistance ?? null,

    newsSentiment: news?.sentiment ?? null,
    newsLabel: news?.label ?? null,
    headlineCount: news?.headlineCount ?? null,
    dealCount: news?.deals?.length ?? null,
    analystTilt: analyst?.tilt ?? null,
    earningsDate: fundamentals?.earningsDate ? String(fundamentals.earningsDate).slice(0, 10) : null,

    sector: fundamentals?.sector ?? null,
    valuation: fundamentals
      ? {
          trailingPE: fundamentals.trailingPE ?? null,
          forwardPE: fundamentals.forwardPE ?? null,
          pegRatio: fundamentals.pegRatio ?? null,
          revenueGrowth: fundamentals.revenueGrowth ?? null,
          earningsGrowth: fundamentals.earningsGrowth ?? null,
          profitMargin: fundamentals.profitMargin ?? null,
          analystTarget: fundamentals.analystTarget ?? null,
          recommendationMean: fundamentals.recommendationMean ?? null,
        }
      : null,

    options: options
      ? {
          expiration: analysis.options?.expiration ?? null,
          atmIv: options.atmIv ?? null,
          ivState: options.ivState ?? null,
          expectedMovePct: options.expectedMovePct ?? null,
          maxPain: options.maxPain ?? null,
          pcrOi: options.pcrOi ?? null,
        }
      : null,
  };
}

const actionAsOf = (rows, index) => rows[index]?.action ?? null;

/**
 * Measure the previous calls against what actually happened next.
 * `ahead` sessions after each snapshot decide whether that call followed
 * through: a Buy/Accumulate that kept rising, a Sell/Reduce that kept falling.
 */
function followThrough(rows, { ahead = 1 } = {}) {
  const samples = [];
  for (let index = 0; index + ahead < rows.length; index += 1) {
    const action = actionAsOf(rows, index);
    const start = closeOf(rows[index]);
    const end = closeOf(rows[index + ahead]);
    if (!action || start === null || end === null || start === 0) continue;
    samples.push({ action, date: rows[index].date, nextPct: ((end - start) / start) * 100 });
  }

  const directionOf = (action) => (action === 'buy' || action === 'accumulate' ? 1 : action === 'reduce' || action === 'sell' ? -1 : 0);
  const directional = samples.filter((sample) => directionOf(sample.action) !== 0);
  const hits = directional.filter((sample) => directionOf(sample.action) * sample.nextPct > 0);

  const byAction = {};
  for (const action of ACTION_SEQUENCE) {
    const group = samples.filter((sample) => sample.action === action);
    if (!group.length) continue;
    byAction[action] = {
      samples: group.length,
      avgNextPct: round(avg(group.map((sample) => sample.nextPct)), 2),
      hitRate: round(
        (group.filter((sample) => directionOf(action) * sample.nextPct > 0).length / group.length) * 100,
        0,
      ),
    };
  }

  return {
    aheadSessions: ahead,
    samples: directional.length,
    hitRate: directional.length ? round((hits.length / directional.length) * 100, 0) : null,
    avgNextPct: round(avg(directional.map((sample) => sample.nextPct)), 2),
    buySamples: samples.filter((sample) => directionOf(sample.action) > 0).length,
    avoidSamples: samples.filter((sample) => directionOf(sample.action) < 0).length,
    byAction,
  };
}

/**
 * Trend summary over the archived rows for one symbol (oldest first).
 * Returns null when there is nothing archived yet, so every caller can fall
 * back to live-only decision-making.
 */
export function summarizeMarketHistory(symbol, ordered = []) {
  const rows = (ordered || []).filter((row) => row && closeOf(row) !== null);
  if (!rows.length) return null;

  const last = rows[rows.length - 1];
  const first = rows[0];
  const closes = rows.map(closeOf);
  const scores = rows.map((row) => row.score).filter(Number.isFinite);
  const sentiments = rows.map((row) => row.newsSentiment).filter(Number.isFinite);

  const last5 = rows.slice(-5);
  const prior5 = rows.slice(-10, -5);
  const scoreAvg5 = avg(last5.map((row) => row.score).filter(Number.isFinite));
  const scoreAvgPrior5 = avg(prior5.map((row) => row.score).filter(Number.isFinite));
  const scoreDelta5 = scoreAvg5 !== null && scoreAvgPrior5 !== null ? round(scoreAvg5 - scoreAvgPrior5, 1) : null;
  const sentimentAvg5 = avg(last5.map((row) => row.newsSentiment).filter(Number.isFinite));
  const sentimentDelta5 =
    sentimentAvg5 !== null && sentiments.length >= 6
      ? round(sentimentAvg5 - avg(sentiments.slice(-10, -5)), 1)
      : null;

  // Action streak: how many consecutive archived sessions carried today's call.
  let streak = 1;
  for (let index = rows.length - 2; index >= 0; index -= 1) {
    if (rows[index].action !== last.action) break;
    streak += 1;
  }
  const previous = rows.length > streak ? rows[rows.length - 1 - streak] : null;
  const changes = [];
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].action && rows[index - 1].action && rows[index].action !== rows[index - 1].action) {
      changes.push({ date: rows[index].date, from: rows[index - 1].action, to: rows[index].action });
    }
  }

  const firstClose = closeOf(first);
  const lastClose = closeOf(last);
  const scoreStdDev =
    scores.length > 1
      ? round(Math.sqrt(avg(scores.map((value) => (value - avg(scores)) ** 2))), 1)
      : null;

  return {
    symbol,
    source: SNAPSHOT_SOURCE,
    coverageDays: rows.length,
    firstDate: first.date ?? null,
    lastDate: last.date ?? null,
    capturedAt: last.capturedAt instanceof Date ? last.capturedAt.toISOString() : (last.capturedAt ?? null),
    price: {
      first: round(firstClose),
      last: round(lastClose),
      changePct: firstClose ? round(((lastClose - firstClose) / firstClose) * 100, 2) : null,
      high: round(Math.max(...closes)),
      low: round(Math.min(...closes)),
    },
    score: {
      latest: last.score ?? null,
      label: last.scoreLabel ?? null,
      avg5: round(scoreAvg5, 1),
      avgPrior5: round(scoreAvgPrior5, 1),
      delta5: scoreDelta5,
      trend:
        scoreDelta5 === null ? 'stable' : scoreDelta5 >= 5 ? 'improving' : scoreDelta5 <= -5 ? 'deteriorating' : 'stable',
      stdDev: scoreStdDev,
      series: rows.slice(-30).map((row) => ({ date: row.date, score: row.score ?? null })),
    },
    action: {
      latest: last.action ?? null,
      latestLabel: last.actionLabel ?? label(last.action),
      streak,
      streakSince: rows[rows.length - streak]?.date ?? null,
      previous: previous?.action ?? null,
      previousDate: previous?.date ?? null,
      changes: changes.slice(-6),
    },
    sentiment: {
      latest: last.newsSentiment ?? null,
      avg5: round(sentimentAvg5, 1),
      delta5: sentimentDelta5,
      trend:
        sentimentDelta5 === null
          ? 'stable'
          : sentimentDelta5 >= 8
            ? 'improving'
            : sentimentDelta5 <= -8
              ? 'deteriorating'
              : 'stable',
      series: rows.slice(-30).map((row) => ({ date: row.date, sentiment: row.newsSentiment ?? null })),
    },
    levels: {
      stopLoss: last.stopLoss ?? null,
      stopLossChangePct:
        Number.isFinite(first.stopLoss) && first.stopLoss !== 0 && Number.isFinite(last.stopLoss)
          ? round(((last.stopLoss - first.stopLoss) / first.stopLoss) * 100, 2)
          : null,
      target1: last.target1 ?? null,
      target1ChangePct:
        Number.isFinite(first.target1) && first.target1 !== 0 && Number.isFinite(last.target1)
          ? round(((last.target1 - first.target1) / first.target1) * 100, 2)
          : null,
      direction: last.direction ?? null,
      rangePosition: last.rangePosition ?? null,
      sector: last.sector ?? null,
    },
    followThrough: followThrough(rows, { ahead: 1 }),
    followThrough5: followThrough(rows, { ahead: 5 }),
    snapshots: rows.slice(-20).map((row) => ({
      date: row.date,
      close: round(closeOf(row)),
      score: row.score ?? null,
      action: row.action ?? null,
      actionLabel: row.actionLabel ?? label(row.action),
      newsSentiment: row.newsSentiment ?? null,
      stopLoss: row.stopLoss ?? null,
      target1: row.target1 ?? null,
    })),
  };
}

/**
 * Apply the archive to a live call. The live plan still owns the levels and the
 * regime rule still owns the action; the archive decides how much to trust it —
 * a call confirmed by weeks of snapshots earns conviction, a first-day flip or
 * a history of failed calls loses it.
 */
export function applyHistoryToDecision({ action, conviction = 50, history = null }) {
  if (!history) return { conviction, notes: [], risks: [], summary: null };
  const notes = [];
  const risks = [];
  let next = conviction;

  const streak = history.action?.streak ?? 0;
  const archivedAction = history.action?.latest ?? null;
  const previousAction = history.action?.previous ?? null;

  if (archivedAction && archivedAction === action) {
    if (streak >= 3) {
      next += 5;
      notes.push(
        `Archive: the daily snapshots have carried ${history.action.latestLabel ?? label(action)} for ${streak} consecutive sessions (since ${history.action.streakSince}) — the regime is confirmed rather than a one-day reading.`,
      );
    } else if (streak === 1 && previousAction && previousAction !== action) {
      next -= 5;
      notes.push(
        `Archive: the archived call flipped to ${label(action)} in the latest snapshot — the previous archived call was ${label(previousAction)} on ${history.action.previousDate}. This is the first session of the new call; wait for the next snapshot to confirm it before sizing up.`,
      );
    } else if (streak <= 2) {
      notes.push(
        `Archive: the archived call has only ${streak} session${streak === 1 ? '' : 's'} behind it — too short to confirm a regime, so conviction is unchanged.`,
      );
    }
  } else if (archivedAction) {
    next -= 5;
    notes.push(
      `Archive: the last stored snapshot still reads ${history.action.latestLabel ?? archivedAction} (${history.action.streakSince ?? 'n/a'}), so today's ${label(action)} call is not in the archive yet — treat it as unconfirmed until the next capture.`,
    );
  }

  const follow = history.followThrough;
  if (follow?.hitRate !== null && follow.samples >= 8) {
    if (follow.hitRate >= 60) {
      next += 4;
      notes.push(
        `Archive: previous archived calls followed through ${follow.hitRate}% of the time (${follow.samples} samples, ${follow.avgNextPct > 0 ? '+' : ''}${follow.avgNextPct}% average next-session move).`,
      );
    } else if (follow.hitRate <= 45) {
      next -= 5;
      risks.push(
        `The archive is unkind to this call type: previous archived calls followed through only ${follow.hitRate}% of the time (${follow.samples} samples). Demand price confirmation before acting.`,
      );
    }
  }

  const scoreTrend = history.score?.trend;
  if (scoreTrend === 'improving' && (action === 'buy' || action === 'accumulate')) {
    next += 3;
    notes.push(
      `Archive: the quality score is improving (${history.score.avg5} average over the last five snapshots versus ${history.score.avgPrior5} before, ${history.score.delta5 > 0 ? '+' : ''}${history.score.delta5}).`,
    );
  } else if (scoreTrend === 'deteriorating' && (action === 'buy' || action === 'accumulate')) {
    next -= 6;
    risks.push(
      `The archived quality score is deteriorating (${history.score.delta5} over five sessions) while the call is still ${label(action)} — treat this as a late-cycle entry.`,
    );
  }

  if (history.sentiment?.trend === 'deteriorating' && (action === 'buy' || action === 'accumulate')) {
    next -= 3;
    risks.push(
      `Archived news sentiment is deteriorating (${history.sentiment.delta5} versus the prior week) — the live feed may not have priced it in yet.`,
    );
  }

  return {
    conviction: Math.min(95, Math.max(20, Math.round(next))),
    delta: Math.round(next) - conviction,
    notes,
    risks,
    summary: {
      coverageDays: history.coverageDays,
      firstDate: history.firstDate,
      lastDate: history.lastDate,
      actionStreak: history.action?.streak ?? null,
      actionStreakSince: history.action?.streakSince ?? null,
      scoreDelta5: history.score?.delta5 ?? null,
      scoreTrend: history.score?.trend ?? null,
      sentimentTrend: history.sentiment?.trend ?? null,
      hitRate: history.followThrough?.hitRate ?? null,
      hitRateSamples: history.followThrough?.samples ?? null,
      avgNextPct: history.followThrough?.avgNextPct ?? null,
      priceChangePct: history.price?.changePct ?? null,
    },
  };
}

/** Compact row for UI chips: "Buy · 6 sessions · score +6 · 62% hit rate". */
export function archiveTrend(history, { action = null } = {}) {
  if (!history) return null;
  const streak = history.action?.streak ?? 0;
  const sameSide = action && history.action?.latest === action;
  return {
    label: history.action?.latestLabel ?? null,
    sameSide: Boolean(sameSide),
    streak,
    streakSince: history.action?.streakSince ?? null,
    coverageDays: history.coverageDays,
    lastDate: history.lastDate,
    score: history.score?.latest ?? null,
    scoreDelta5: history.score?.delta5 ?? null,
    scoreTrend: history.score?.trend ?? null,
    sentimentTrend: history.sentiment?.trend ?? null,
    hitRate: history.followThrough?.hitRate ?? null,
    hitRateSamples: history.followThrough?.samples ?? null,
    avgNextPct: history.followThrough?.avgNextPct ?? null,
    priceChangePct: history.price?.changePct ?? null,
  };
}

/** Prompt block: the archive evidence handed to the model alongside live data. */
export function buildArchivePrompt({ symbol, history, newsHistory = null } = {}) {
  if (!history) return '';
  const lines = [
    `ARCHIVE — ${symbol} (${history.coverageDays} daily MongoDB snapshots, ${history.firstDate} → ${history.lastDate}; live Yahoo Finance is the current session and overrides the last archived row)`,
  ];
  if (history.price) {
    lines.push(
      `- Price across the window: ${history.price.first} → ${history.price.last} (${history.price.changePct > 0 ? '+' : ''}${history.price.changePct}%), high ${history.price.high} / low ${history.price.low}.`,
    );
  }
  if (history.score?.latest !== null && history.score?.latest !== undefined) {
    lines.push(
      `- Quality score: ${history.score.latest} now, ${history.score.avg5} average over the last 5 snapshots vs ${history.score.avgPrior5} before (${history.score.trend}${history.score.delta5 === null ? '' : `, ${history.score.delta5 > 0 ? '+' : ''}${history.score.delta5}`}); ${history.score.stdDev} std dev.`,
    );
  }
  if (history.action?.latest) {
    lines.push(
      `- Archived call: ${history.action.latestLabel} for ${history.action.streak === 1 ? '1 session' : `${history.action.streak} consecutive sessions`}${
        history.action.streakSince ? ` (since ${history.action.streakSince})` : ''
      }${history.action.previous ? `; before that ${history.action.previous} on ${history.action.previousDate}` : ''}.`,
    );
  }
  if (history.followThrough?.samples) {
    lines.push(
      `- Previous archived calls: ${history.followThrough.hitRate}% followed through (${history.followThrough.samples} directional samples, ${history.followThrough.avgNextPct > 0 ? '+' : ''}${history.followThrough.avgNextPct}% average next-session move). Buy/Accumulate samples: ${history.followThrough.buySamples}, Reduce/Sell samples: ${history.followThrough.avoidSamples}.`,
    );
  }
  if (history.sentiment?.latest !== null && history.sentiment?.latest !== undefined) {
    lines.push(
      `- Archived news sentiment: ${history.sentiment.latest} (${history.sentiment.trend}${history.sentiment.delta5 === null ? '' : `, ${history.sentiment.delta5 > 0 ? '+' : ''}${history.sentiment.delta5} vs the prior week`}).`,
    );
  }
  if (history.levels?.stopLossChangePct !== null && history.levels?.stopLossChangePct !== undefined) {
    lines.push(
      `- Plan drift over the window: stop moved ${history.levels.stopLossChangePct > 0 ? '+' : ''}${history.levels.stopLossChangePct}%, T1 moved ${history.levels.target1ChangePct > 0 ? '+' : ''}${history.levels.target1ChangePct}% (now stop ${history.levels.stopLoss}, T1 ${history.levels.target1}).`,
    );
  }
  if (newsHistory?.delta7 !== null && newsHistory?.delta7 !== undefined) {
    lines.push(
      `- Headline archive (MongoDB NewsItem/DailyNewsDigest): 7-day sentiment ${newsHistory.sentiment7} vs ${newsHistory.sentimentPrior7} the prior week (${newsHistory.direction}), ${newsHistory.deals30d} deal stories in 30 days.`,
    );
  }
  if (history.snapshots?.length) {
    lines.push(
      `- Last ${history.snapshots.length} snapshots (date | close | score | call): ${history.snapshots
        .slice(-8)
        .map((row) => `${row.date} | ${row.close} | ${row.score} | ${row.actionLabel ?? row.action ?? '—'}`)
        .join(' · ')}`,
    );
  }
  return lines.join('\n');
}

export const _internals = { followThrough, closeOf, dayKey };
