/**
 * "Best day-trading stocks" ranking.
 *
 * Input is one `buildDayTrade()` read per name plus the tape facts the screener
 * already knows (relative volume). The board answers two questions per row:
 *
 *   - is there a signal on the 1-hour chart right now?  BUY / SELL / WAIT
 *   - is this name worth day-trading today?  tradeability 0–100
 *
 * Tradeability rewards what an intraday trader actually needs: enough movement
 * (ATR%), enough participation (relative volume) and a decisive read (|score|).
 * A quiet, high-quality mega cap ranks below a volatile name with the same
 * signal, because there is nothing to trade in a stock that does not move.
 *
 * Everything here is pure — the caller owns the network and the cache.
 */

const round = (value, digits = 2) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Actionable reads first; a WAIT is informational, not a trade. */
const BUCKET_RANK = { buy: 0, sell: 0, wait: 1 };

export function tradeabilityScore({ atrPct, relativeVolume, score, price } = {}) {
  const atr = Number(atrPct);
  // A 0.5% ATR is thin for a day trade, ~2% is the sweet spot, 3%+ is a mover.
  const movement = Number.isFinite(atr) ? clamp(35 + atr * 20, 20, 100) : 45;

  const relative = Number(relativeVolume);
  const participation = Number.isFinite(relative) && relative > 0 ? clamp(40 + relative * 25, 20, 100) : 50;

  // Edge is sign-agnostic: a confirmed short is as tradable as a confirmed long.
  const edge = clamp(40 + Math.abs(Number(score) || 0) * 7, 40, 100);
  // Sub-$5 names slip on spreads, so they are never ranked as the best vehicle.
  const liquidity = Number(price) >= 5 ? 100 : 60;

  return clamp(Math.round(movement * 0.3 + participation * 0.25 + edge * 0.35 + liquidity * 0.1), 0, 100);
}

function openingRangePosition({ price, high, low }) {
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  if (price > high) return 'above';
  if (price < low) return 'below';
  return 'inside';
}

function setupLabel(action, position) {
  if (action === 'buy') {
    return position === 'above' ? 'First-hour breakout long' : 'VWAP reclaim long';
  }
  if (action === 'sell') {
    return position === 'below' ? 'First-hour breakdown short' : 'VWAP rejection short';
  }
  return 'Inside the first-hour range — wait for the break';
}

function buildWhy({ action, position, atrPct, relativeVolume, rsi, adx, trendless }) {
  const parts = [];
  if (action === 'buy') {
    parts.push(position === 'above' ? 'Above VWAP and the first-hour high' : 'Holding above session VWAP');
  } else if (action === 'sell') {
    parts.push(position === 'below' ? 'Below VWAP and the first-hour low' : 'Rejected at session VWAP');
  } else {
    parts.push('No confirmed break yet');
  }
  if (Number.isFinite(Number(atrPct))) parts.push(`ATR ${round(atrPct, 2)}%`);
  if (Number.isFinite(Number(relativeVolume)) && Number(relativeVolume) > 0) {
    parts.push(`${round(relativeVolume, 1)}× vol`);
  }
  if (Number.isFinite(Number(rsi))) parts.push(`RSI ${round(rsi, 0)}`);
  if (trendless) parts.push('ADX < 18 · range-bound');
  else if (Number.isFinite(Number(adx))) parts.push(`ADX ${round(adx, 0)}`);
  return parts.join(' · ');
}

/**
 * One board row from one intraday read. Returns null when the read is not
 * usable (no symbol or price), so the caller can drop failures quietly.
 */
export function buildDayTradeRow(trade = {}) {
  const price = Number(trade.price);
  if (!trade.symbol || !Number.isFinite(price) || price <= 0) return null;

  const action = trade.action === 'buy' || trade.action === 'sell' ? trade.action : 'wait';
  const levels = {
    vwap: round(trade.levels?.vwap),
    ema9: round(trade.levels?.ema9),
    ema20: round(trade.levels?.ema20),
    openingRangeHigh: round(trade.levels?.openingRangeHigh),
    openingRangeLow: round(trade.levels?.openingRangeLow),
    priorClose: round(trade.levels?.priorClose),
  };
  const position = openingRangePosition({ price, high: levels.openingRangeHigh, low: levels.openingRangeLow });

  const plan =
    trade.plan && trade.plan.direction
      ? {
          direction: trade.plan.direction,
          entry: round(trade.plan.entry),
          stopLoss: round(trade.plan.stopLoss),
          riskPerShare: round(trade.plan.riskPerShare),
          riskReward: trade.plan.riskReward ?? null,
          targets: (trade.plan.targets || []).map((target) => ({
            label: target.label,
            price: round(target.price),
            rMultiple: target.rMultiple,
            movePct: round(target.movePct),
          })),
        }
      : null;

  const atrPct = round(trade.indicators?.atrPct);
  const adx = round(trade.indicators?.adx14, 1);
  const trendless = Boolean(trade.indicators?.chop);
  const relativeVolume = Number.isFinite(Number(trade.relativeVolume)) ? Number(trade.relativeVolume) : null;
  const pattern = trade.sessionPattern || null;
  const ai = trade.ai || null;
  const source = trade.source === 'ai' ? 'ai' : 'engine';
  // When the model made the call, its conviction is the strength of the read;
  // the mechanical score only ranks the names the engine decided.
  const edgeScore =
    source === 'ai' ? ((Number(trade.confidence) || 50) - 50) / 2.5 : Number(trade.score) || 0;

  return {
    symbol: trade.symbol,
    name: trade.name || trade.symbol,
    quoteType: trade.quoteType || 'EQUITY',
    price: round(price),
    changePercent: round(trade.changePercent),
    session: trade.session?.date ?? null,
    interval: trade.interval || '60m',
    action,
    actionLabel: action === 'buy' ? 'Buy' : action === 'sell' ? 'Sell' : 'Wait',
    bucket: action === 'wait' ? 'wait' : action,
    setup: setupLabel(action, position),
    openingRangePosition: position,
    score: Number(trade.score) || 0,
    confidence: Number(trade.confidence) || 0,
    source,
    decisionSourceLabel: trade.decisionSourceLabel ?? null,
    engineAction: trade.engine?.action ?? action,
    conviction: source === 'ai' ? Number(trade.confidence) || null : null,
    aiThesis: ai?.thesis ?? null,
    agreesWithEngine: ai?.agreesWithEngine ?? null,
    tradeability: tradeabilityScore({ atrPct, relativeVolume, score: edgeScore, price }),
    relativeVolume: round(relativeVolume),
    rsi: round(trade.indicators?.rsi14, 1),
    adx,
    trendless,
    atrPct,
    sessionVolumeRatio: round(trade.indicators?.volumeRatio),
    vwapDistancePct: round(trade.indicators?.vwapDistancePct),
    aboveVwap: Boolean(trade.indicators?.aboveVwap),
    emaUptrend: Boolean(trade.indicators?.ema9Above20),
    levels,
    triggers: {
      buyAbove: round(trade.triggers?.buyAbove),
      sellBelow: round(trade.triggers?.sellBelow),
    },
    plan,
    sessionPattern: pattern
      ? {
          label: pattern.label,
          dayType: pattern.dayType,
          bias: pattern.bias,
          gapPct: round(pattern.gapPct),
          closePositionPct: pattern.closePositionPct ?? null,
          vwapTimeAbovePct: pattern.vwapTimeAbovePct ?? null,
        }
      : null,
    reasons: (trade.reasons || []).slice(0, 3),
    why: buildWhy({
      action,
      position,
      atrPct,
      relativeVolume,
      rsi: trade.indicators?.rsi14,
      adx,
      trendless,
    }),
  };
}

/**
 * Rank every readable name and split it into the buckets the page renders:
 * buy and sell setups first (the tradeable ones), then the no-trade reads.
 */
export function rankDayTrades(trades = []) {
  const rows = trades
    .map((trade) => buildDayTradeRow(trade))
    .filter(Boolean)
    .sort(
      (a, b) =>
        (BUCKET_RANK[a.bucket] ?? 2) - (BUCKET_RANK[b.bucket] ?? 2) ||
        b.tradeability - a.tradeability ||
        b.confidence - a.confidence ||
        Math.abs(b.score) - Math.abs(a.score) ||
        String(a.symbol).localeCompare(String(b.symbol)),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));

  const buy = rows.filter((row) => row.bucket === 'buy');
  const sell = rows.filter((row) => row.bucket === 'sell');
  const wait = rows.filter((row) => row.bucket === 'wait');

  return {
    rows,
    buy,
    sell,
    wait,
    buyCount: buy.length,
    sellCount: sell.length,
    waitCount: wait.length,
  };
}
