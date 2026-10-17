/**
 * Options analytics: chain microstructure, expected move, max pain, and a
 * payoff engine shared by the API and the LLM agent's tools.
 */

import { ALERT_LABELS } from './alert.js';

const round = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

const CONTRACT_SIZE = 100;

export function daysToExpiry(expiration, now = Date.now()) {
  const expiry = new Date(`${expiration}T20:00:00Z`).getTime();
  if (!Number.isFinite(expiry)) return 0;
  return Math.max(0, Math.ceil((expiry - now) / 86_400_000));
}

// ---------- Normal distribution helpers ----------
const erf = (x) => {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
};
const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export function blackScholes({ type, spot, strike, years, iv, rate = 0.04 }) {
  if (!spot || !strike || !years || !iv) return { price: null, delta: null, gamma: null, theta: null, vega: null };
  const sqrtT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * years) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const discount = Math.exp(-rate * years);
  const delta = type === 'call' ? normCdf(d1) : normCdf(d1) - 1;
  const price =
    type === 'call'
      ? spot * normCdf(d1) - strike * discount * normCdf(d2)
      : strike * discount * normCdf(-d2) - spot * normCdf(-d1);
  const theta =
    (-(spot * normPdf(d1) * iv) / (2 * sqrtT) -
      (type === 'call' ? 1 : -1) * rate * strike * discount * normCdf(type === 'call' ? d2 : -d2)) /
    365;
  return {
    price,
    delta,
    gamma: normPdf(d1) / (spot * iv * sqrtT),
    theta,
    vega: (spot * normPdf(d1) * sqrtT) / 100,
  };
}

const average = (values) => {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
};

const nearest = (contracts, target, filter = () => true) => {
  let best = null;
  for (const contract of contracts) {
    if (!filter(contract)) continue;
    if (!best || Math.abs(contract.strike - target) < Math.abs(best.strike - target)) best = contract;
  }
  return best;
};

/** Choose a liquid contract at or around a target strike. */
function pickContract(contracts, target, { side = 'nearest', minOpenInterest = 0 } = {}) {
  const liquid = contracts.filter((c) => (c.mid > 0 || c.lastPrice > 0) && c.openInterest >= minOpenInterest);
  const pool = liquid.length ? liquid : contracts.filter((c) => (c.mid > 0 || c.lastPrice > 0));
  if (!pool.length) return null;
  const sorted = [...pool].sort((a, b) => a.strike - b.strike);
  if (side === 'below') {
    const below = sorted.filter((c) => c.strike <= target);
    return below.length ? below[below.length - 1] : sorted[0];
  }
  if (side === 'above') {
    const above = sorted.filter((c) => c.strike >= target);
    return above.length ? above[0] : sorted[sorted.length - 1];
  }
  return nearest(sorted, target);
}

export function summarizeChain({ calls, puts, spot, expiration, realizedVol = null }) {
  if (!calls?.length || !puts?.length || !spot) return null;

  const callOi = calls.reduce((acc, c) => acc + c.openInterest, 0);
  const putOi = puts.reduce((acc, c) => acc + c.openInterest, 0);
  const callVolume = calls.reduce((acc, c) => acc + c.volume, 0);
  const putVolume = puts.reduce((acc, c) => acc + c.volume, 0);
  const pcrOi = callOi ? putOi / callOi : null;
  const pcrVolume = callVolume ? putVolume / callVolume : null;

  const atmCall = nearest(calls, spot, (c) => c.impliedVolatility > 0);
  const atmPut = nearest(puts, spot, (p) => p.impliedVolatility > 0);
  const atmIv = average([atmCall?.impliedVolatility, atmPut?.impliedVolatility]);

  const dte = daysToExpiry(expiration);
  const expectedMove = atmIv ? spot * atmIv * Math.sqrt(dte / 365) : null;
  const straddle = atmCall && atmPut ? (atmCall.mid || atmCall.lastPrice) + (atmPut.mid || atmPut.lastPrice) : null;

  const strikes = [...new Set([...calls.map((c) => c.strike), ...puts.map((p) => p.strike)])].sort((a, b) => a - b);
  let maxPain = null;
  let maxPainValue = Infinity;
  for (const strike of strikes) {
    let payout = 0;
    for (const call of calls) payout += Math.max(0, strike - call.strike) * call.openInterest;
    for (const put of puts) payout += Math.max(0, put.strike - strike) * put.openInterest;
    if (payout < maxPainValue) {
      maxPainValue = payout;
      maxPain = strike;
    }
  }

  const otmPut = nearest(puts, spot * 0.9, (p) => p.impliedVolatility > 0 && p.strike < spot);
  const otmCall = nearest(calls, spot * 1.1, (c) => c.impliedVolatility > 0 && c.strike > spot);
  const skew = otmPut && otmCall ? otmPut.impliedVolatility - otmCall.impliedVolatility : null;
  const ivPremium = atmIv && realizedVol ? (atmIv * 100) / realizedVol : null;

  const all = [...calls, ...puts];
  const liquidCount = all.filter((c) => {
    const spread = c.ask - c.bid;
    return c.openInterest >= 10 && c.mid > 0 && spread / c.mid <= 0.15;
  }).length;
  const liquidity = all.length ? Math.round((liquidCount / all.length) * 100) : 0;

  return {
    expiration,
    dte,
    spot: round(spot),
    atmStrike: atmCall?.strike ?? null,
    atmIv: atmIv ? round(atmIv * 100, 2) : null,
    expectedMove: expectedMove ? round(expectedMove) : null,
    expectedMovePct: expectedMove ? round((expectedMove / spot) * 100, 2) : null,
    expectedLow: expectedMove ? round(spot - expectedMove) : null,
    expectedHigh: expectedMove ? round(spot + expectedMove) : null,
    straddle: round(straddle),
    straddlePct: straddle ? round((straddle / spot) * 100, 2) : null,
    maxPain,
    pcrOi: round(pcrOi, 2),
    pcrVolume: round(pcrVolume, 2),
    callOpenInterest: callOi,
    putOpenInterest: putOi,
    skew: skew !== null ? round(skew * 100, 2) : null,
    ivPremium: round(ivPremium, 2),
    liquidity,
    positioning:
      pcrOi === null ? 'unknown' : pcrOi > 1.15 ? 'defensive / put-heavy' : pcrOi < 0.7 ? 'complacent / call-heavy' : 'balanced',
    ivState:
      ivPremium === null ? 'unknown' : ivPremium > 1.15 ? 'rich' : ivPremium < 0.9 ? 'cheap' : 'fair',
  };
}

// ---------- Payoff engine ----------
export function evaluateStrategy(legs, spot, { iv = 0.3, dte = 30 } = {}) {
  spot = Number(spot);
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const strikes = legs.map((leg) => leg.strike).filter((strike) => Number.isFinite(strike));
  if (!strikes.length) return null;

  // Callers (the API and the agent tools) can pass a negative or non-numeric
  // IV/DTE. Normalise both before they reach the probability integral, where a
  // negative sigma would silently invert every probability.
  const ivInput = Number(iv);
  const vol = Number.isFinite(ivInput) && ivInput > 0 ? Math.min(ivInput, 5) : 0.3;
  const dteInput = Number(dte);
  const days = Number.isFinite(dteInput) ? Math.min(Math.max(Math.round(dteInput), 1), 730) : 30;

  const minStrike = Math.min(...strikes);
  const maxStrike = Math.max(...strikes);
  const hasStock = legs.some((leg) => leg.kind === 'stock');
  const hasPut = legs.some((leg) => leg.kind === 'put');
  // A stock leg or any put can reach its true maximum at a price of zero (short
  // puts carry their full strike risk there, long puts their full payoff), so
  // anchor the grid at zero instead of truncating the risk profile.
  const low = hasStock || hasPut ? 0 : Math.max(0.01, Math.min(minStrike * 0.7, spot * 0.6));
  const high = Math.max(maxStrike * 1.3, spot * 1.4);
  const steps = hasStock || hasPut ? 241 : 161;
  const grid = Array.from({ length: steps }, (_, i) => low + ((high - low) * i) / (steps - 1));

  let optionsCash = 0; // > 0 means option premium credited
  let stockCost = 0; // > 0 means cash required to buy shares
  let netCallQty = 0;
  let netPutQty = 0;
  let netStockQty = 0;
  for (const leg of legs) {
    const sign = leg.action === 'sell' ? -1 : 1;
    const qty = leg.qty ?? 1;
    if (leg.kind === 'stock') {
      stockCost += sign === -1 ? -spot * qty : spot * qty;
      netStockQty += sign * qty;
      continue;
    }
    optionsCash += sign === 1 ? -leg.premium * qty : leg.premium * qty;
    if (leg.kind === 'call') netCallQty += sign * qty;
    else netPutQty += sign * qty;
  }
  const netCash = optionsCash + -stockCost;

  const payoffAt = (price) => {
    let value = 0;
    for (const leg of legs) {
      const sign = leg.action === 'sell' ? -1 : 1;
      const qty = leg.qty ?? 1;
      if (leg.kind === 'call') value += sign * qty * Math.max(0, price - leg.strike);
      else if (leg.kind === 'put') value += sign * qty * Math.max(0, leg.strike - price);
      else value += sign * qty * price;
    }
    return (value + netCash) * CONTRACT_SIZE;
  };

  const curve = grid.map((price) => ({ price: round(price), profit: round(payoffAt(price), 0) }));
  const profits = curve.map((point) => point.profit);
  const maxProfit = Math.max(...profits);
  const maxLoss = Math.min(...profits);
  const maxProfitUnbounded = netCallQty > 0 || (netStockQty > 0 && netCallQty === 0);
  const maxLossUnbounded = netStockQty < 0 || (netCallQty < 0 && netStockQty + netCallQty < 0);

  const breakevens = [];
  for (let i = 1; i < curve.length; i += 1) {
    const prev = curve[i - 1];
    const curr = curve[i];
    if ((prev.profit <= 0 && curr.profit > 0) || (prev.profit >= 0 && curr.profit < 0)) {
      const ratio = Math.abs(prev.profit) / (Math.abs(prev.profit) + Math.abs(curr.profit) || 1);
      breakevens.push(round(prev.price + (curr.price - prev.price) * ratio));
    }
  }

  const years = days / 365;
  const greeks = legs.reduce(
    (acc, leg) => {
      if (leg.kind === 'stock') {
        acc.delta += (leg.action === 'sell' ? -1 : 1) * (leg.qty ?? 1);
        return acc;
      }
      const greek = blackScholes({
        type: leg.kind,
        spot,
        strike: leg.strike,
        years,
        iv: leg.iv || vol,
      });
      const sign = (leg.action === 'sell' ? -1 : 1) * (leg.qty ?? 1);
      acc.delta += (greek.delta || 0) * sign;
      acc.gamma += (greek.gamma || 0) * sign;
      acc.theta += (greek.theta || 0) * sign;
      acc.vega += (greek.vega || 0) * sign;
      return acc;
    },
    { delta: 0, gamma: 0, theta: 0, vega: 0 },
  );

  // Probability of profit at expiry using a lognormal approximation. The payoff
  // is piecewise linear, so profitable regions are the intervals between
  // breakevens. Integrating each interval (rather than assuming "between the
  // two breakevens") is what makes a long straddle, which profits OUTSIDE its
  // breakevens, report its probability of profit instead of its probability of
  // loss. Stock legs still report null because the funding cost/assignment
  // assumptions are not in this model.
  const sigma = vol * Math.sqrt(years);
  const mu = Math.log(spot) - (sigma * sigma) / 2;
  const probabilityBelow = (price) =>
    normCdf((Math.log(Math.max(price, 0.0001)) - mu) / (sigma || 1));
  let probabilityOfProfit = null;
  if (!legs.some((leg) => leg.kind === 'stock') && Number.isFinite(spot) && spot > 0) {
    const bounds = [0, ...breakevens.slice().sort((a, b) => a - b), Infinity];
    let probability = 0;
    for (let i = 1; i < bounds.length; i += 1) {
      const lower = bounds[i - 1];
      const upper = bounds[i];
      // No further crossing exists inside the interval, so one sample (above
      // the last breakeven the sign is constant) classifies the whole region.
      const sample = Number.isFinite(upper) ? (lower + upper) / 2 : lower + Math.max(spot, 1);
      if (payoffAt(sample) <= 0) continue;
      probability +=
        (Number.isFinite(upper) ? probabilityBelow(upper) : 1) - probabilityBelow(lower);
    }
    probabilityOfProfit = Math.min(1, Math.max(0, probability));
  }

  return {
    netPremium: round(-optionsCash * CONTRACT_SIZE, 0),
    stockCost: round(stockCost * CONTRACT_SIZE, 0),
    isCredit: optionsCash > 0,
    maxProfit: round(maxProfit, 0),
    maxProfitUnbounded,
    maxLoss: round(maxLoss, 0),
    maxLossUnbounded,
    breakevens,
    probabilityOfProfit: probabilityOfProfit !== null ? round(probabilityOfProfit * 100, 0) : null,
    returnOnRisk:
      maxProfit > 0 && maxLoss < 0 ? round(Math.abs(maxProfit / maxLoss), 2) : null,
    greeks: {
      delta: round(greeks.delta, 3),
      gamma: round(greeks.gamma, 4),
      theta: round(greeks.theta, 2),
      vega: round(greeks.vega, 2),
    },
    curve,
  };
}

const legFrom = (contract, kind, action) => ({
  kind,
  action,
  strike: contract.strike,
  premium: contract.mid || contract.lastPrice || 0,
  iv: contract.impliedVolatility,
  openInterest: contract.openInterest,
  contractSymbol: contract.contractSymbol,
  qty: 1,
});

export function buildOptionPlans({
  symbol,
  spot,
  score,
  direction,
  action = null,
  chain,
  realizedVol,
  atrValue,
  targets = [],
  stopLoss = null,
  support = null,
  resistance = null,
}) {
  const summary = summarizeChain({
    calls: chain.calls,
    puts: chain.puts,
    spot,
    expiration: chain.expiration,
    realizedVol,
  });
  if (!summary) return { summary: null, plans: [] };

  const ivRich = summary.ivPremium ? summary.ivPremium > 1.12 : false;
  const dte = summary.dte;
  const iv = summary.atmIv ? summary.atmIv / 100 : 0.3;
  const target1 = targets[0]?.price ?? null;
  // The alert is the source of truth when it is available: a Hold should not
  // ship a structure that adds directional risk, and a Sell should only get a
  // bearish expression. Score + plan direction remain the fallback for callers
  // that only have a technical plan.
  const directional =
    action === 'buy' || action === 'accumulate'
      ? 'bullish'
      : action === 'reduce' || action === 'sell'
        ? 'bearish'
        : action === 'hold'
          ? 'neutral'
          : null;
  const bullish = directional ? directional === 'bullish' : direction === 'long' && score >= 56;
  const bearish = directional ? directional === 'bearish' : score < 45;
  const neutral = directional ? directional === 'neutral' : !bullish && !bearish;
  const actionLabel = action ? ALERT_LABELS[action].toLowerCase() : null;

  const plans = [];
  const pushPlan = (name, thesis, legs, notes = [], bias = 'neutral') => {
    const clean = legs.filter(Boolean);
    if (clean.length < 1) return;
    const metrics = evaluateStrategy(clean, spot, { iv, dte });
    if (!metrics) return;
    plans.push({
      name,
      bias,
      thesis,
      expiration: chain.expiration,
      dte,
      legs: clean,
      metrics,
      notes,
      riskNote:
        'Max loss assumes the position is held to expiration. Use limit orders at the mid price and size positions so total premium at risk stays under 2% of the account.',
    });
  };

  if (bullish) {
    const atmCall = pickContract(chain.calls, spot, { side: 'below' });
    const exitTarget = targets[1]?.price ?? target1;
    const spreadExit = exitTarget ? pickContract(chain.calls, exitTarget, { side: 'above' }) : null;

    if (ivRich) {
      const shortPutStrike = support && support < spot ? support : spot * 0.95;
      const shortPut = pickContract(chain.puts, shortPutStrike, { side: 'below' });
      const longPut = pickContract(chain.puts, (shortPut?.strike ?? shortPutStrike) - (atrValue || spot * 0.03) * 1.5, {
        side: 'below',
      });
      if (shortPut && longPut && longPut.strike < shortPut.strike) {
        pushPlan(
          'Bull put spread',
          `Rich implied volatility and a ${actionLabel || 'buy'} setup — get paid to buy the dip at support while capping downside risk.`,
          [legFrom(shortPut, 'put', 'sell'), legFrom(longPut, 'put', 'buy')],
          [
            `Short strike near support ${support ? `$${round(support)}` : '5% below spot'}`,
            ivRich ? 'IV is above realised volatility, favouring premium selling' : '',
          ].filter(Boolean),
          'bullish',
        );
      }
      if (atmCall && spreadExit && spreadExit.strike > atmCall.strike) {
        pushPlan(
          'Bull call spread (alternative)',
          'Defined-risk directional exposure if you prefer to be long delta rather than short premium.',
          [legFrom(atmCall, 'call', 'buy'), legFrom(spreadExit, 'call', 'sell')],
          [],
          'bullish',
        );
      }
    } else {
      if (atmCall && spreadExit && spreadExit.strike > atmCall.strike) {
        pushPlan(
          'Bull call spread',
          `Cheap implied volatility with a ${actionLabel || 'bullish'} alert — buy the move with capped cost.`,
          [legFrom(atmCall, 'call', 'buy'), legFrom(spreadExit, 'call', 'sell')],
          ['Financing the trade by selling the target-1 strike keeps theta working for you'],
          'bullish',
        );
      }
      if (atmCall) {
        pushPlan(
          'Long call',
          'Simple leveraged upside to the first target with defined premium at risk.',
          [legFrom(atmCall, 'call', 'buy')],
          [],
          'bullish',
        );
      }
    }
  } else if (bearish) {
    const atmPut = pickContract(chain.puts, spot, { side: 'above' });
    const exitTarget = targets[1]?.price ?? target1;
    const spreadExit = exitTarget ? pickContract(chain.puts, exitTarget, { side: 'below' }) : null;

    if (ivRich && resistance) {
      const shortCall = pickContract(chain.calls, resistance, { side: 'above' });
      const longCall = pickContract(chain.calls, (shortCall?.strike ?? resistance) + (atrValue || spot * 0.03) * 1.5, {
        side: 'above',
      });
      if (shortCall && longCall && longCall.strike > shortCall.strike) {
        pushPlan(
          'Bear call spread',
          `${actionLabel ? `${actionLabel[0].toUpperCase()}${actionLabel.slice(1)}` : 'Bearish'} alert plus rich IV — sell rallies into resistance with capped risk above.`,
          [legFrom(shortCall, 'call', 'sell'), legFrom(longCall, 'call', 'buy')],
          [],
          'bearish',
        );
      }
    }
    if (atmPut && spreadExit && spreadExit.strike < atmPut.strike) {
      pushPlan(
        'Bear put spread',
        'Defined-risk downside participation to the first support target.',
        [legFrom(atmPut, 'put', 'buy'), legFrom(spreadExit, 'put', 'sell')],
        [],
        'bearish',
      );
    } else if (atmPut) {
      pushPlan('Long put', 'Direct downside exposure with premium-limited risk.', [legFrom(atmPut, 'put', 'buy')], [], 'bearish');
    }
  } else {
    const lower = support ? support * 0.97 : spot * 0.92;
    const upper = resistance ? resistance * 1.03 : spot * 1.08;
    const shortPut = pickContract(chain.puts, lower, { side: 'below' });
    const longPut = pickContract(chain.puts, lower - (atrValue || spot * 0.02) * 1.5, { side: 'below' });
    const shortCall = pickContract(chain.calls, upper, { side: 'above' });
    const longCall = pickContract(chain.calls, upper + (atrValue || spot * 0.02) * 1.5, { side: 'above' });
    if (ivRich && shortPut && longPut && shortCall && longCall) {
      pushPlan(
        'Iron condor',
        `No directional edge (${actionLabel || 'hold'}) and rich IV — collect premium inside the expected move.`,
        [
          legFrom(shortPut, 'put', 'sell'),
          legFrom(longPut, 'put', 'buy'),
          legFrom(shortCall, 'call', 'sell'),
          legFrom(longCall, 'call', 'buy'),
        ],
        [
          `Short strikes ${shortPut.strike}/${shortCall.strike} bracket the expected move`,
          `Max profit if ${symbol} finishes between the short strikes`,
        ],
        'neutral',
      );
    }
  }

  return { summary, plans: plans.slice(0, 2), ivState: summary.ivState };
}
