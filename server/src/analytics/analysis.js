import { buildAlert } from './alert.js';
import {
  adx,
  annualizedVolatility,
  atr,
  bollinger,
  ema,
  last,
  macd,
  maxDrawdown,
  normalizedSlope,
  obv,
  pctChange,
  pivotLevels,
  rsi,
  sma,
  stochastic,
} from './indicators.js';

const round = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));

const pct = (from, to) => (from ? ((to - from) / from) * 100 : null);

// Quality tiers describe how good the setup is — not what to do with it. The
// action comes from alert.js, so an "Excellent" quality name can still be a
// Hold if price is extended. "signal"/"signalLabel" keep their old field names
// for API compatibility but now carry these quality tiers, not buy/sell calls.
const SCORE_LABELS = [
  { min: 78, label: 'Excellent', signal: 'excellent' },
  { min: 66, label: 'Strong', signal: 'strong' },
  { min: 56, label: 'Above average', signal: 'above_average' },
  { min: 45, label: 'Average', signal: 'average' },
  { min: 35, label: 'Weak', signal: 'weak' },
  { min: 0, label: 'Poor', signal: 'poor' },
];

/**
 * RSI is read in the context of the primary trend: an oversold print is a dip
 * to buy only while price holds above the 200-day, and is a warning — not an
 * opportunity — once the long-term trend has broken.
 */
function scoreRsi(value, { aboveSma200 = true } = {}) {
  if (value === null) return { score: 50, note: 'RSI unavailable' };

  if (aboveSma200) {
    // Uptrend: buy the pullback, do not chase the stretch. A 40 RSI inside an
    // uptrend has historically paid far better than a 60 RSI breakout.
    if (value >= 35 && value <= 50) return { score: 100, note: `RSI ${round(value, 1)} is a pullback inside an uptrend — preferred entry` };
    if (value > 50 && value <= 60) return { score: 85, note: `RSI ${round(value, 1)} is healthy momentum` };
    if (value > 60 && value <= 70) return { score: 70, note: `RSI ${round(value, 1)} is running hot but trend-aligned` };
    if (value > 70 && value <= 80) return { score: 40, note: `RSI ${round(value, 1)} is overbought — wait for a reset` };
    if (value > 80) return { score: 25, note: `RSI ${round(value, 1)} is extremely overbought — poor entry` };
    if (value >= 25) return { score: 70, note: `RSI ${round(value, 1)} is oversold inside an uptrend — bounce setup` };
    return { score: 50, note: `RSI ${round(value, 1)} is deeply oversold even for an uptrend` };
  }

  // Downtrend: rallies into strength are the sell, not the buy. Deep oversold
  // is a falling knife, not a discount.
  if (value >= 55 && value <= 70) return { score: 20, note: `RSI ${round(value, 1)} is a counter-trend bounce in a downtrend — sell zone` };
  if (value > 70) return { score: 30, note: `RSI ${round(value, 1)} is overbought against a falling 200-day` };
  if (value >= 45) return { score: 45, note: `RSI ${round(value, 1)} is neutral with the trend down` };
  if (value >= 35) return { score: 38, note: `RSI ${round(value, 1)} is soft and the primary trend is down` };
  if (value >= 25) return { score: 22, note: `RSI ${round(value, 1)} is oversold in a downtrend — do not catch the knife` };
  return { score: 15, note: `RSI ${round(value, 1)} is capitulating with the trend broken` };
}

function dedupeLevels(levels, tolerancePct = 1.2) {
  const sorted = levels
    .filter((level) => Number.isFinite(level.level) && level.level > 0)
    .sort((a, b) => b.level - a.level);
  const out = [];
  for (const level of sorted) {
    const existing = out.find((item) => Math.abs(item.level - level.level) / level.level <= tolerancePct / 100);
    if (existing) {
      existing.touches = Math.max(existing.touches || 0, level.touches || 0);
      existing.sources = [...new Set([...(existing.sources || []), level.source])];
    } else {
      out.push({ ...level, sources: [level.source] });
    }
  }
  return out;
}

function buildTargets({ price, atrValue, score, resistances, supports, fiftyTwoWeekHigh, analystTarget, direction }) {
  const atrUnit = atrValue || price * 0.02;
  const strength = clamp(score / 100, 0.3, 1.15);
  const candidates = [];
  const isLong = direction !== 'short';

  const add = (level, source, weight = 1) => {
    if (!Number.isFinite(level) || level <= 0) return;
    const upside = pct(price, level);
    if (upside === null) return;
    if (isLong && upside < 1.2) return;
    if (!isLong && upside > -1.2) return;
    candidates.push({ price: level, source, weight, upside });
  };

  if (isLong) {
    for (const resistance of resistances.slice(0, 4)) add(resistance.level, 'resistance', 1.3);
    if (fiftyTwoWeekHigh && fiftyTwoWeekHigh > price) add(fiftyTwoWeekHigh, '52-week high', 1.1);
    if (analystTarget && analystTarget > price) add(analystTarget, 'analyst consensus', 0.9);
    for (const mult of [1.4, 2.2, 3.2, 4.4]) add(price + atrUnit * mult * strength, 'ATR projection', 0.8);
    candidates.sort((a, b) => a.price - b.price);
  } else {
    for (const support of supports.slice(0, 4)) add(support.level, 'support', 1.2);
    if (analystTarget && analystTarget < price) add(analystTarget, 'analyst consensus', 0.9);
    for (const mult of [1.2, 2.2, 3.2, 4.4]) add(price - atrUnit * mult * strength, 'ATR projection', 0.9);
    candidates.sort((a, b) => b.price - a.price);
  }

  const picked = [];
  for (const candidate of candidates) {
    if (picked.length >= 3) break;
    if (picked.length) {
      const lastPrice = picked[picked.length - 1].price;
      const gap = Math.abs(candidate.price - lastPrice);
      if (isLong && (candidate.price <= lastPrice * 1.008 || gap < atrUnit * 0.5)) continue;
      if (!isLong && (candidate.price >= lastPrice * 0.992 || gap < atrUnit * 0.5)) continue;
    }
    picked.push(candidate);
  }

  // Always deliver three tiers — extend with ATR projections when the chart
  // has not printed enough distinct overhead levels.
  let guard = 0;
  while (picked.length < 3 && guard < 6) {
    guard += 1;
    const base = picked[picked.length - 1]?.price ?? price;
    const step = Math.max(atrUnit * 1.1, base * 0.018);
    const nextPrice = isLong ? base + step : base - step;
    if (nextPrice <= 0) break;
    picked.push({
      price: nextPrice,
      source: 'ATR extension',
      weight: 0.7,
      upside: pct(price, nextPrice),
    });
  }

  const labels = ['T1', 'T2', 'T3'];
  return picked.map((candidate, index) => ({
    label: labels[index],
    price: round(candidate.price),
    upsidePct: round(Math.abs(candidate.upside)),
    source: candidate.source,
    probability: clamp(
      Math.round(
        (direction === 'long' ? 72 : 68) - index * 13 + (score - 50) * 0.25 + (candidate.weight - 1) * 6,
      ),
      25,
      88,
    ),
    rationale:
      direction === 'long'
        ? `${candidate.source} at $${round(candidate.price)} — ${round(Math.abs(candidate.upside), 1)}% above spot`
        : `${candidate.source} at $${round(candidate.price)} — ${round(Math.abs(candidate.upside), 1)}% of downside`,
  }));
}

export function buildAnalysis({ quote, history, fundamentals = null, benchmark = null }) {
  const bars = history.bars;
  const closes = bars.map((bar) => bar.close);
  const price = quote.price ?? closes[closes.length - 1];
  if (!price) throw new Error(`No usable price for ${quote.symbol}`);

  const sma20Series = sma(closes, 20);
  const sma50Series = sma(closes, 50);
  const sma200Series = sma(closes, 200);
  const ema21Series = ema(closes, 21);
  const rsiSeries = rsi(closes, 14);
  const macdSeries = macd(closes);
  const atrSeries = atr(bars, 14);
  const bb = bollinger(closes, 20, 2);
  const stoch = stochastic(bars);
  const adxSeries = adx(bars, 14);
  const obvSeries = obv(bars);

  const sma20 = last(sma20Series);
  const sma50 = last(sma50Series);
  const sma200 = last(sma200Series);
  const ema21 = last(ema21Series);
  const rsiValue = last(rsiSeries);
  const macdLine = last(macdSeries.line);
  const macdSignal = last(macdSeries.signal);
  const macdHist = last(macdSeries.histogram);
  const atrValue = last(atrSeries) ?? price * 0.02;
  const bbUpper = last(bb.upper);
  const bbLower = last(bb.lower);
  const bbWidth = last(bb.width);
  const stochK = last(stoch.k);
  const stochD = last(stoch.d);
  const adxValue = last(adxSeries.adx);
  const plusDI = last(adxSeries.plusDI);
  const minusDI = last(adxSeries.minusDI);
  const obvSlope = normalizedSlope(obvSeries.slice(-25));
  const sma50Slope = normalizedSlope(sma50Series.slice(-20));
  const volatility = annualizedVolatility(closes, 20);
  const atrPct = (atrValue / price) * 100;
  const drawdown = maxDrawdown(closes.slice(-252));

  const avgVolume50 =
    bars.slice(-50).reduce((acc, bar) => acc + (bar.volume || 0), 0) / Math.max(1, bars.slice(-50).length);
  const avgVolume5 =
    bars.slice(-5).reduce((acc, bar) => acc + (bar.volume || 0), 0) / Math.max(1, bars.slice(-5).length);
  const volumeRatio = avgVolume50 ? avgVolume5 / avgVolume50 : null;

  const high52 = Math.max(...bars.slice(-252).map((bar) => bar.high), price);
  const low52 = Math.min(...bars.slice(-252).map((bar) => bar.low), price);
  const rangePosition = ((price - low52) / (high52 - low52 || 1)) * 100;

  const returns = {
    week: round(pctChange(closes, 5)),
    month: round(pctChange(closes, 21)),
    quarter: round(pctChange(closes, 63)),
    halfYear: round(pctChange(closes, 126)),
    year: round(pctChange(closes, 252)),
  };

  let benchmarkReturn = null;
  if (benchmark?.bars?.length) {
    const benchCloses = benchmark.bars.map((bar) => bar.close);
    benchmarkReturn = pctChange(benchCloses, 63);
  }
  const relativeStrength =
    returns.quarter !== null && benchmarkReturn !== null ? round(returns.quarter - benchmarkReturn) : null;

  const pivots = pivotLevels(bars.slice(-220), { left: 4, right: 4, tolerancePct: 1.2 });
  const isEtf = quote.quoteType === 'ETF' || quote.quoteType === 'MUTUALFUND';
  const supports = dedupeLevels(
    [
      ...pivots.lows.filter((level) => level.level < price * 0.995).map((level) => ({ ...level, source: 'pivot low' })),
      ...(sma20 && sma20 < price ? [{ level: sma20, source: 'SMA-20', touches: 1 }] : []),
      ...(sma50 && sma50 < price ? [{ level: sma50, source: 'SMA-50', touches: 1 }] : []),
      ...(sma200 && sma200 < price ? [{ level: sma200, source: 'SMA-200', touches: 2 }] : []),
      ...(bbLower && bbLower < price ? [{ level: bbLower, source: 'lower Bollinger', touches: 1 }] : []),
      { level: low52, source: '52-week low', touches: 1 },
    ],
  )
    .filter((level) => level.level > price * 0.55)
    .sort((a, b) => b.level - a.level);

  const resistances = dedupeLevels(
    [
      ...pivots.highs.filter((level) => level.level > price * 1.005).map((level) => ({ ...level, source: 'pivot high' })),
      ...(sma20 && sma20 > price ? [{ level: sma20, source: 'SMA-20', touches: 1 }] : []),
      ...(sma50 && sma50 > price ? [{ level: sma50, source: 'SMA-50', touches: 1 }] : []),
      ...(sma200 && sma200 > price ? [{ level: sma200, source: 'SMA-200', touches: 2 }] : []),
      ...(bbUpper && bbUpper > price ? [{ level: bbUpper, source: 'upper Bollinger', touches: 1 }] : []),
      { level: high52, source: '52-week high', touches: 1 },
    ],
  )
    .filter((level) => level.level < price * 1.6)
    .sort((a, b) => a.level - b.level);

  // ---------- Score ----------
  const components = [];

  let trendPoints = 0;
  if (sma20) trendPoints += price > sma20 ? 15 : 0;
  if (sma50) trendPoints += price > sma50 ? 15 : 0;
  if (sma200) trendPoints += price > sma200 ? 20 : 0;
  if (sma20 && sma50) trendPoints += sma20 > sma50 ? 20 : 0;
  if (sma50 && sma200) trendPoints += sma50 > sma200 ? 15 : 0;
  if (adxValue !== null) trendPoints += adxValue >= 20 ? 10 : 0;
  trendPoints += sma50Slope > 0 ? 5 : 0;
  components.push({
    key: 'trend',
    label: 'Trend structure',
    weight: 30,
    score: clamp(trendPoints),
    notes: [
      sma20 ? `Price ${price > sma20 ? 'above' : 'below'} SMA-20 (${round(sma20)})` : 'SMA-20 unavailable',
      sma50 ? `SMA-50 ${round(sma50)}${sma50Slope > 0 ? ' rising' : ' flattening/falling'}` : 'SMA-50 unavailable',
      sma200 ? `${price > sma200 ? 'Long-term uptrend' : 'Below long-term trend'} (SMA-200 ${round(sma200)})` : 'SMA-200 unavailable',
      adxValue !== null ? `ADX ${round(adxValue, 1)} (${adxValue >= 25 ? 'strong trend' : adxValue >= 20 ? 'trending' : 'range-bound'})` : '',
    ].filter(Boolean),
  });

  const aboveSma200 = sma200 === null ? true : price > sma200;
  const rsiScore = scoreRsi(rsiValue, { aboveSma200 });
  let momentumPoints = rsiScore.score * 0.3;
  const macdBull = macdLine !== null && macdSignal !== null && macdLine > macdSignal;
  momentumPoints += macdBull ? 20 : 4;
  momentumPoints += macdHist !== null && macdHist > 0 ? 10 : 0;
  momentumPoints += stochK !== null && stochD !== null && stochK > stochD ? 12 : 3;
  const rsPoints =
    relativeStrength === null ? 10 : clamp(10 + relativeStrength * 0.8, 0, 28);
  momentumPoints += rsPoints;
  momentumPoints += clamp((returns.month ?? 0) * 0.8, -6, 10);
  components.push({
    key: 'momentum',
    label: 'Momentum',
    weight: 25,
    score: clamp(momentumPoints),
    notes: [
      rsiScore.note,
      macdBull ? 'MACD is above its signal line' : 'MACD is below its signal line',
      stochK !== null ? `Stochastic %K ${round(stochK, 1)} / %D ${round(stochD, 1)}` : '',
      relativeStrength !== null
        ? `${relativeStrength >= 0 ? 'Outperforming' : 'Underperforming'} SPY by ${round(Math.abs(relativeStrength), 1)}pp over 3 months`
        : '',
    ].filter(Boolean),
  });

  const upVolumeBias = returns.week !== null && returns.week > 0 && volumeRatio !== null && volumeRatio > 1;
  const volumeScore = clamp((obvSlope > 0 ? 45 : 15) + (upVolumeBias ? 30 : volumeRatio !== null && volumeRatio < 0.8 ? 10 : 20) + (volumeRatio ? clamp(volumeRatio * 12, 5, 25) : 10));
  components.push({
    key: 'volume',
    label: 'Volume confirmation',
    weight: 10,
    score: volumeScore,
    notes: [
      volumeRatio !== null ? `5-day volume is ${round(volumeRatio * 100, 0)}% of the 50-day average` : '',
      obvSlope > 0 ? 'On-balance volume is rising' : 'On-balance volume is flat or falling',
    ].filter(Boolean),
  });

  let riskPoints = 0;
  if (volatility !== null) riskPoints += volatility < 22 ? 35 : volatility < 32 ? 26 : volatility < 45 ? 16 : 7;
  riskPoints += drawdown > -8 ? 25 : drawdown > -15 ? 18 : drawdown > -25 ? 10 : 4;
  riskPoints += (quote.beta ?? 1) < 1.1 ? 20 : (quote.beta ?? 1) < 1.5 ? 13 : 6;
  riskPoints += atrPct < 2 ? 20 : atrPct < 3.5 ? 14 : 6;
  components.push({
    key: 'risk',
    label: 'Risk profile',
    weight: 10,
    score: clamp(riskPoints),
    notes: [
      volatility !== null ? `Annualised volatility ${round(volatility, 1)}%` : '',
      `ATR is ${round(atrPct, 2)}% of price`,
      `Drawdown from 1-year peak ${round(drawdown, 1)}%`,
    ].filter(Boolean),
  });

  if (!isEtf && fundamentals) {
    let valuePoints = 0;
    const pe = fundamentals.trailingPE ?? quote.trailingPE;
    const forwardPe = fundamentals.forwardPE ?? quote.forwardPE;
    const peg = fundamentals.pegRatio;
    const margin = fundamentals.profitMargin;
    const growth = fundamentals.revenueGrowth;
    const analystUpside = fundamentals.analystTarget ? pct(price, fundamentals.analystTarget) : null;

    // A negative P/E (loss-making) or PEG is not "cheap" — treat it as a
    // neutral/unknown valuation instead of awarding the best score.
    const pePositive = Number.isFinite(pe) && pe > 0;
    const pegPositive = Number.isFinite(peg) && peg > 0;
    valuePoints += pegPositive
      ? peg < 1
        ? 26
        : peg < 2
          ? 18
          : peg < 3
            ? 10
            : 3
      : pePositive
        ? pe < 18
          ? 20
          : pe < 30
            ? 15
            : pe < 45
              ? 8
              : 3
        : 10;
    valuePoints +=
      pePositive && Number.isFinite(forwardPe) && forwardPe > 0 && forwardPe < pe ? 16 : 8;
    valuePoints += margin !== null ? (margin > 0.2 ? 20 : margin > 0.1 ? 14 : margin > 0 ? 8 : 2) : 8;
    valuePoints += growth !== null ? (growth > 0.15 ? 22 : growth > 0.05 ? 15 : growth > 0 ? 8 : 2) : 8;
    valuePoints += analystUpside !== null ? clamp(8 + analystUpside, 0, 16) : 8;
    components.push({
      key: 'valuation',
      label: 'Valuation & fundamentals',
      weight: 15,
      score: clamp(valuePoints),
      notes: [
        pe ? `Trailing P/E ${round(pe, 1)}` : 'No trailing P/E',
        peg ? `PEG ${round(peg, 2)}` : '',
        margin !== null ? `Net margin ${round(margin * 100, 1)}%` : '',
        growth !== null ? `Revenue growth ${round(growth * 100, 1)}%` : '',
        analystUpside !== null ? `Analyst target implies ${round(analystUpside, 1)}% upside` : '',
      ].filter(Boolean),
    });
  } else if (isEtf) {
    let etfPoints = 50;
    if (fundamentals?.expenseRatio !== undefined && fundamentals?.expenseRatio !== null) {
      etfPoints += fundamentals.expenseRatio < 0.002 ? 25 : fundamentals.expenseRatio < 0.005 ? 15 : 5;
    }
    if (fundamentals?.ytdReturn !== undefined && fundamentals?.ytdReturn !== null) {
      etfPoints += clamp(fundamentals.ytdReturn * 100, -20, 25);
    }
    if (rangePosition > 80) etfPoints += 5;
    components.push({
      key: 'fund',
      label: 'Fund quality',
      weight: 15,
      score: clamp(etfPoints),
      notes: [
        fundamentals?.fundFamily ? `${fundamentals.fundFamily} fund` : 'Diversified exchange-traded product',
        fundamentals?.expenseRatio !== undefined && fundamentals?.expenseRatio !== null
          ? `Expense ratio ${(fundamentals.expenseRatio * 100).toFixed(2)}%`
          : '',
        `Trading at ${round(rangePosition, 0)}% of its 52-week range`,
      ].filter(Boolean),
    });
  }

  let sentimentPoints = 50;
  const sentimentNotes = [];
  if (fundamentals?.recommendationMean) {
    sentimentPoints = clamp(110 - fundamentals.recommendationMean * 20);
    sentimentNotes.push(`Analyst consensus ${round(fundamentals.recommendationMean, 2)} / 5 (1 = strong buy)`);
  }
  if (fundamentals?.analystTarget) {
    const upside = pct(price, fundamentals.analystTarget);
    if (upside !== null) {
      sentimentPoints = clamp(sentimentPoints + clamp(upside, -15, 15));
      sentimentNotes.push(`Mean price target $${round(fundamentals.analystTarget)}`);
    }
  }
  if (!sentimentNotes.length) sentimentNotes.push('No sell-side coverage available — technicals only');
  components.push({
    key: 'sentiment',
    label: 'Street sentiment',
    weight: 10,
    score: sentimentPoints,
    notes: sentimentNotes,
  });

  const weightTotal = components.reduce((acc, item) => acc + item.weight, 0);
  const rawScore = Math.round(
    components.reduce((acc, item) => acc + item.score * (item.weight / weightTotal), 0),
  );

  // Do not fight the primary trend. A name below its 200-day can score a Hold
  // at best, and a confirmed downtrend (death cross + directional ADX + a
  // bearish MACD) can score no better than Reduce. Without these caps the
  // momentum components can hand a broken chart a "buy" on a dead-cat bounce.
  const below200 = sma200 !== null && price < sma200;
  const deathCross = sma50 !== null && sma200 !== null && sma50 < sma200;
  const bearishMacd = macdLine !== null && macdSignal !== null && macdLine < macdSignal;
  const confirmedDowntrend = below200 && deathCross && (adxValue ?? 0) >= 20 && bearishMacd;
  let totalScore = rawScore;
  if (below200) totalScore = Math.min(totalScore, 54);
  if (confirmedDowntrend) totalScore = Math.min(totalScore, 34);

  const label = SCORE_LABELS.find((item) => totalScore >= item.min);
  // The plan's side must agree with the call's side. The alert is a regime
  // rule: price below the 200-day with the 50-day also below it is a trend
  // break, regardless of how the quality score rounds. Deriving the plan from
  // the score alone let a Sell call carry an upside plan (targets above spot,
  // "buy above" trigger) — two halves of the same card contradicting each
  // other. A confirmed downtrend now produces downside levels, a stop above
  // spot and a bearish invalidation, which is what the Sell label means.
  const trendDownRegime = below200 === true && sma50 !== null && sma200 !== null && sma50 < sma200;
  // The plan must agree with the call. The action is the regime rule in
  // alert.js, so a Buy/Accumulate name needs an accumulation range even when
  // the quality score sits just below the 56 cutoff — otherwise the card says
  // "Buy" with no price to buy in, and the Hot Stocks board (which needs a band
  // to rank an actionable name) silently drops a name the Focus board shows.
  // Only the regime is read here; the final alert below still sees the plan.
  const entryCall = ['buy', 'accumulate'].includes(
    buildAlert({
      analysis: {
        price,
        indicators: { sma50, sma200, rsi14: rsiValue, adx14: adxValue, volumeRatio },
        plan: null,
      },
    })?.action,
  );
  const direction = trendDownRegime ? 'short' : entryCall || totalScore >= 45 ? 'long' : 'short';
  const bullish = direction === 'long' && (totalScore >= 56 || entryCall);

  // ---------- Entry, targets, stop ----------
  const nearestSupport = supports[0]?.level ?? null;
  const nearestResistance = resistances[0]?.level ?? null;
  const atrUnit = atrValue || price * 0.02;

  let buyZone = null;
  let shortZone = null;
  if (bullish) {
    let high = Math.min(price, price - atrUnit * 0.1);
    let low = high - atrUnit * 0.9;
    if (nearestSupport && nearestSupport < price && nearestSupport > price * 0.92) {
      low = Math.max(nearestSupport - atrUnit * 0.3, price * 0.88);
      high = Math.min(price, low + atrUnit * 1.1);
    }
    if (high <= low) high = low + atrUnit * 0.5;
    buyZone = { low: round(low), high: round(high) };
  }
  if (totalScore < 50) {
    shortZone = {
      low: round(price + atrUnit * 0.1),
      high: round(price + atrUnit * 0.7),
    };
  }

  const targets = buildTargets({
    price,
    atrValue,
    score: totalScore,
    resistances,
    supports,
    fiftyTwoWeekHigh: high52,
    analystTarget: fundamentals?.analystTarget ?? null,
    direction,
  });

  let stopLoss;
  if (direction === 'long') {
    const supportStop = nearestSupport ? nearestSupport - atrUnit * 0.6 : price - atrValue * 1.8;
    stopLoss = Math.max(supportStop, price - price * 0.12);
    stopLoss = Math.min(stopLoss, price - price * 0.03);
  } else {
    const resistanceStop = nearestResistance ? nearestResistance + atrUnit * 0.6 : price + atrValue * 1.8;
    stopLoss = Math.min(resistanceStop, price + price * 0.12);
    stopLoss = Math.max(stopLoss, price + price * 0.03);
  }
  stopLoss = round(stopLoss);

  // A stop inside the entry band makes the plan self-contradictory: part of the
  // "buy" range would already be past the exit, so risk-per-share would be zero
  // or negative for an entry at the wrong end of the zone. Huge ATRs (above
  // ~13% of spot) can widen the band enough for that to happen, so pull the
  // near edge of the band back to the safe side of the stop.
  if (direction === 'long' && buyZone && stopLoss >= buyZone.low) {
    const lifted = round(stopLoss + Math.max(atrUnit * 0.15, price * 0.004));
    if (lifted < price) {
      const width = Math.max(atrUnit * 0.1, price * 0.002);
      buyZone = { low: lifted, high: Math.min(price, Math.max(buyZone.high, lifted + width)) };
    } else {
      buyZone = null;
    }
  } else if (direction === 'short' && shortZone && stopLoss <= shortZone.high) {
    const capped = round(stopLoss - Math.max(atrUnit * 0.15, price * 0.004));
    if (capped > price) {
      const width = Math.max(atrUnit * 0.1, price * 0.002);
      shortZone = { low: Math.max(price, Math.min(shortZone.low, capped - width)), high: capped };
    } else {
      shortZone = null;
    }
  }

  const primaryTarget = targets[1]?.price ?? targets[0]?.price ?? null;
  // Risk/reward is measured from the planned entry (mid of the zone), not from
  // spot — chasing price above the zone would otherwise flatter the ratio.
  const entryRef =
    direction === 'long'
      ? buyZone
        ? round((buyZone.low + buyZone.high) / 2)
        : price
      : shortZone
        ? round((shortZone.low + shortZone.high) / 2)
        : price;
  const riskPerShare = round(Math.abs(entryRef - stopLoss));
  const rewardPerShare = primaryTarget ? round(Math.abs(primaryTarget - entryRef)) : null;
  const riskReward = riskPerShare && rewardPerShare ? round(rewardPerShare / riskPerShare, 2) : null;

  // The same ratio at the live price. The headline figure is measured from the
  // reference entry, so a card that says "in the zone now" at the top of that
  // range would be advertising a ratio the current price cannot deliver; this
  // one is what a fill at spot actually earns.
  const spotRisk = direction === 'long' ? price - stopLoss : stopLoss - price;
  const spotReward =
    primaryTarget === null ? null : direction === 'long' ? primaryTarget - price : price - primaryTarget;
  const riskRewardAtSpot = spotRisk > 0 && spotReward > 0 ? round(spotReward / spotRisk, 2) : null;

  const confidence = clamp(
    Math.round(
      45 +
        Math.abs(totalScore - 50) * 0.9 +
        (adxValue !== null && adxValue > 25 ? 8 : 0) +
        (volumeRatio !== null && volumeRatio > 1.1 ? 4 : 0) -
        (bars.length < 180 ? 8 : 0) -
        (fundamentals ? 0 : 4),
    ),
    35,
    94,
  );

  // ---------- Narrative ----------
  const rationale = [];
  if (bullish) {
    rationale.push(
      `Composite score ${totalScore}/100 (${label.label}) with ${round(confidence, 0)}% confidence across trend, momentum, volume and risk.`,
    );
    if (sma50 && sma200) {
      rationale.push(
        `Price ${price > sma50 ? 'holds above' : 'is below'} the 50-day ($${round(sma50)}) and ${price > sma200 ? 'above' : 'below'} the 200-day ($${round(sma200)}), a ${price > sma50 && sma50 > sma200 ? 'constructive' : 'mixed'} structural setup.`,
      );
    }
    rationale.push(
      `RSI ${round(rsiValue, 1)} and ${macdBull ? 'a positive' : 'a negative'} MACD posture give ${macdBull ? 'momentum confirmation' : 'a caution flag'}; ADX ${round(adxValue ?? 0, 1)} says the move is ${(adxValue ?? 0) >= 25 ? 'trend-driven' : 'still developing'}.`,
    );
  } else {
    rationale.push(
      `Composite score ${totalScore}/100 (${label.label}) — trend and momentum are not aligned for fresh long exposure.`,
    );
    rationale.push(
      `Price is ${sma50 ? (price > sma50 ? 'above' : 'below') : 'near'} the 50-day and ${sma200 ? (price > sma200 ? 'above' : 'below') : 'near'} the 200-day; RSI ${round(rsiValue, 1)}, MACD ${macdBull ? 'bullish' : 'bearish'}.`,
    );
    rationale.push(
      `${direction === 'long' ? 'Upside targets' : 'Downside levels'}: ${
        targets.map((target) => `$${target.price}`).join(' → ') || 'not enough price data'
      }; invalidation ${direction === 'long' ? 'below' : 'above'} $${stopLoss}.`,
    );
  }
  if (buyZone) {
    rationale.push(
      `Buy zone $${buyZone.low}–$${buyZone.high} — the price range to accumulate, with a planned entry of $${entryRef} in the middle. First checkpoint (T1) $${targets[0]?.price ?? '—'}; main target (T2) $${primaryTarget ?? '—'}${riskReward !== null ? `, a ${riskReward}:1 reward-to-risk from the planned entry` : ''}. The idea is wrong on a daily close below the $${stopLoss} stop.`,
    );
  }

  const risks = [];
  if (rsiValue !== null && rsiValue > 72) risks.push(`Overbought RSI at ${round(rsiValue, 1)} — entries chase an extended move.`);
  if (volatility !== null && volatility > 40) risks.push(`High annualised volatility (${round(volatility, 1)}%) requires smaller position size.`);
  if (sma200 && price < sma200) risks.push(`Price is below the 200-day SMA ($${round(sma200)}); the primary trend is down.`);
  if (drawdown < -20) risks.push(`Still ${round(Math.abs(drawdown), 1)}% below its 1-year peak — overhead supply exists.`);
  if (!fundamentals) risks.push('Fundamental data unavailable; the score is technical-only.');
  if (riskReward !== null && riskReward < 1.5) {
    risks.push(`Reward-to-risk is only ${riskReward}:1 from the planned entry — wait for a pullback into the zone or size smaller.`);
  }
  // The plan is only as good as the entry it is measured from. When price sits
  // inside the accumulation range, say out loud that a fill at spot earns less
  // than the headline ratio instead of letting the card flatter itself.
  if (
    buyZone &&
    price >= buyZone.low &&
    riskReward !== null &&
    riskRewardAtSpot !== null &&
    riskRewardAtSpot < riskReward * 0.75
  ) {
    risks.push(
      `A fill at the current $${round(price)} is only ${riskRewardAtSpot}:1 to the main target — the ${riskReward}:1 plan assumes the $${entryRef} reference entry, the middle of the $${round(buyZone.low)}–$${round(buyZone.high)} range.`,
    );
  }
  if (!risks.length) risks.push('Broad-market shocks or earnings surprises can invalidate technical levels; use the stop.');

  const checklist = [
    { label: 'Price above SMA-20', passed: sma20 ? price > sma20 : false, detail: sma20 ? `$${round(sma20)}` : 'n/a' },
    { label: 'Golden-cross structure', passed: !!(sma50 && sma200 && sma50 > sma200), detail: sma50 && sma200 ? `SMA50 ${round(sma50)} / SMA200 ${round(sma200)}` : 'n/a' },
    { label: 'RSI in healthy range', passed: rsiValue !== null && rsiValue >= 40 && rsiValue <= 70, detail: round(rsiValue, 1) },
    { label: 'MACD above signal', passed: macdBull, detail: macdLine !== null ? round(macdLine, 2) : 'n/a' },
    { label: 'Volume confirmation', passed: !!(volumeRatio && volumeRatio > 1 && obvSlope > 0), detail: volumeRatio ? `${round(volumeRatio * 100, 0)}% of avg` : 'n/a' },
    { label: 'Trend strength (ADX > 20)', passed: (adxValue ?? 0) > 20, detail: round(adxValue, 1) },
    { label: 'Risk/reward above 2:1', passed: (riskReward ?? 0) >= 2, detail: riskReward ? `${riskReward}:1` : 'n/a' },
  ];

  // ---------- Chart payload (last 180 bars) ----------
  const startIndex = Math.max(0, bars.length - 180);
  const chart = {
    bars: bars.slice(startIndex).map((bar) => ({
      date: bar.date,
      open: round(bar.open),
      high: round(bar.high),
      low: round(bar.low),
      close: round(bar.close),
      volume: bar.volume,
    })),
    overlays: {
      sma20: sma20Series.slice(startIndex).map((value) => round(value)),
      sma50: sma50Series.slice(startIndex).map((value) => round(value)),
      sma200: sma200Series.slice(startIndex).map((value) => round(value)),
      ema21: ema21Series.slice(startIndex).map((value) => round(value)),
    },
    rsi: rsiSeries.slice(startIndex).map((value) => round(value, 1)),
    macd: macdSeries.histogram.slice(startIndex).map((value) => round(value, 3)),
    bollinger: {
      upper: bb.upper.slice(startIndex).map((value) => round(value)),
      lower: bb.lower.slice(startIndex).map((value) => round(value)),
    },
  };

  const result = {
    symbol: quote.symbol,
    name: quote.name,
    quoteType: quote.quoteType,
    assetClass: isEtf ? 'ETF' : 'Stock',
    currency: quote.currency,
    exchange: quote.exchange,
    generatedAt: new Date().toISOString(),
    quote,
    fundamentals,
    price,
    change: quote.change,
    changePercent: quote.changePercent,
    signal: label.signal,
    signalLabel: label.label,
    score: {
      total: totalScore,
      raw: rawScore,
      capped: totalScore !== rawScore,
      label: label.label,
      confidence,
      components,
      weightsNormalised: true,
    },
    levels: {
      supports: supports.slice(0, 5).map(({ level, source, touches }) => ({ price: round(level), source, touches })),
      resistances: resistances.slice(0, 5).map(({ level, source, touches }) => ({ price: round(level), source, touches })),
      nearestSupport: round(nearestSupport),
      nearestResistance: round(nearestResistance),
      fiftyTwoWeekHigh: round(high52),
      fiftyTwoWeekLow: round(low52),
      rangePosition: round(rangePosition, 1),
      pivot:
        price > ((high52 + low52 + price) / 3) ? 'above central pivot' : 'below central pivot',
    },
    indicators: {
      sma20: round(sma20),
      sma50: round(sma50),
      sma200: round(sma200),
      ema21: round(ema21),
      rsi14: round(rsiValue, 2),
      macd: round(macdLine, 3),
      macdSignal: round(macdSignal, 3),
      macdHistogram: round(macdHist, 3),
      atr14: round(atrValue),
      atrPct: round(atrPct, 2),
      bollingerUpper: round(bbUpper),
      bollingerLower: round(bbLower),
      bollingerWidth: round(bbWidth, 2),
      stochasticK: round(stochK, 1),
      stochasticD: round(stochD, 1),
      adx14: round(adxValue, 1),
      plusDI: round(plusDI, 1),
      minusDI: round(minusDI, 1),
      obvSlope: round(obvSlope, 3),
      volumeRatio: round(volumeRatio, 2),
      annualizedVolatility: round(volatility, 1),
      maxDrawdown: round(drawdown, 1),
      beta: quote.beta ?? fundamentals?.beta ?? null,
    },
    performance: { ...returns, relativeStrength },
    plan: {
      direction,
      buyZone: direction === 'long' ? buyZone : null,
      shortZone,
      entryRef,
      targets,
      stopLoss,
      riskPerShare,
      riskReward,
      // Same ratio measured from the live price rather than the reference entry.
      riskRewardAtSpot,
      riskBudgetExample: {
        accountSize: 10_000,
        riskPct: 1,
        riskDollars: 100,
        // A single share that already risks more than the $100 budget is not a
        // valid size — report null rather than silently over-risking.
        shares: riskPerShare && riskPerShare <= 100 ? Math.floor(100 / riskPerShare) : null,
      },
      horizon: totalScore >= 66 ? '4–8 weeks (swing)' : '2–4 weeks (tactical)',
      invalidation: direction === 'long' ? `Daily close below $${stopLoss}` : `Daily close above $${stopLoss}`,
    },
    rationale,
    risks,
    checklist,
    chart,
  };

  // The action is the regime rule, not the score band. Attached here so the
  // Analyzer, the scan board and the focus board all speak the same language;
  // the research layer recomputes it with news/earnings guardrails.
  result.alert = buildAlert({ analysis: result });
  return result;
}

export const _internals = { dedupeLevels, buildTargets, scoreRsi, SCORE_LABELS };
