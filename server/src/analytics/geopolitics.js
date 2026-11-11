/**
 * Geopolitical / macro regime read.
 *
 * Short-horizon forecasts are made inside a regime, not a vacuum: tariffs,
 * sanctions, conflict, energy shocks, central-bank guidance and the dollar all
 * move the tape a stock trades on. This module classifies the macro-tagged and
 * geopolitical headlines into themes, scores their direction, and blends that
 * with the proxy tape (VIX, S&P 500, oil, gold, dollar) into one tilt.
 *
 * Pure: the service layer supplies headlines and quotes; every rule here is
 * unit-tested. Missing evidence is dropped, never counted as neutral.
 */
import { analyzeHeadline } from './news.js';

export const GEOPOLITICAL_THEMES = [
  {
    key: 'rates',
    label: 'Fed & rates',
    re: /\b(fed|fomc|powell|rate cut|rate hike|interest rate|treasury yield|inflation|cpi|pce|payrolls|jobs report)\b/i,
  },
  {
    key: 'trade',
    label: 'Trade & tariffs',
    re: /\b(tariff|trade war|trade deal|export control|export ban|sanction|embargo|quota|wto|customs)\b/i,
  },
  {
    key: 'china',
    label: 'China & Asia',
    re: /\b(china|chinese|beijing|taiwan|xi jinping|japan|south korea|india)\b/i,
  },
  {
    key: 'conflict',
    label: 'Conflict & energy',
    re: /\b(war|conflict|attack|missile|middle east|opec|oil|crude|energy|pipeline|shipping|red sea|hormuz)\b/i,
  },
  {
    key: 'policy',
    label: 'Elections & regulation',
    re: /\b(election|vote|legislation|congress|senate|white house|regulation|antitrust|budget)\b/i,
  },
  {
    key: 'credit',
    label: 'Dollar & credit',
    re: /\b(dollar|currency|credit|default|bond market|debt ceiling|yield curve|bank)\b/i,
  },
  {
    key: 'growth',
    label: 'Global growth',
    re: /\b(gdp|recession|slowdown|pmi|stimulus|unemployment)\b/i,
  },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function readProxy(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? { price: value, changePercent: null } : null;
  const price = Number(value.price);
  if (!Number.isFinite(price)) return null;
  const rawChange = value.changePercent;
  const change =
    rawChange === null || rawChange === undefined || rawChange === ''
      ? null
      : Number.isFinite(Number(rawChange))
        ? Number(rawChange)
        : null;
  return { price: Number(price.toFixed(2)), changePercent: change };
}

export function analyzeGeopolitics({ headlines = [], market = null } = {}) {
  const annotated = (Array.isArray(headlines) ? headlines : [])
    .filter((item) => item && item.title)
    .map((item) => analyzeHeadline(item));

  const themed = [];
  for (const item of annotated) {
    const text = `${item.title} ${item.summary}`;
    const matches = GEOPOLITICAL_THEMES.filter((theme) => theme.re.test(text));
    if (matches.length) themed.push({ item, matches });
  }

  const themes = GEOPOLITICAL_THEMES.map((theme) => {
    const items = themed
      .filter((entry) => entry.matches.some((match) => match.key === theme.key))
      .map((entry) => entry.item);
    if (!items.length) return null;
    const weight = items.reduce((sum, item) => sum + item.weight, 0) || 1;
    const score = Math.round(
      (items.reduce((sum, item) => sum + item.score * item.weight, 0) / weight) * 100,
    );
    const top = [...items].sort((a, b) => Math.abs(b.score) * b.weight - Math.abs(a.score) * a.weight)[0];
    return {
      key: theme.key,
      label: theme.label,
      headlines: items.length,
      score,
      direction: score > 12 ? 'bullish' : score < -12 ? 'bearish' : 'neutral',
      topHeadline: top?.title ?? null,
    };
  })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.score) * b.headlines - Math.abs(a.score) * a.headlines);

  const totalWeight = themed.reduce((sum, entry) => sum + entry.item.weight, 0);
  const headlineTilt = totalWeight
    ? Math.round(
        (themed.reduce((sum, entry) => sum + entry.item.score * entry.item.weight, 0) / totalWeight) * 100,
      )
    : null;

  const proxies =
    market && typeof market === 'object'
      ? {
          vix: readProxy(market.vix),
          spy: readProxy(market.spy),
          oil: readProxy(market.oil),
          gold: readProxy(market.gold),
          dollar: readProxy(market.dollar),
        }
      : {};
  const tradedProxies = Object.values(proxies).some(Boolean) ? proxies : null;

  let macroScore = null;
  const notes = [];
  if (tradedProxies) {
    let score = 0;
    let used = false;

    const vix = proxies.vix;
    if (vix?.price) {
      used = true;
      if (vix.price >= 28) {
        score -= 30;
        notes.push(`VIX ${vix.price.toFixed(1)} signals stress`);
      } else if (vix.price >= 20) {
        score -= 10;
        notes.push(`VIX ${vix.price.toFixed(1)} is elevated`);
      } else if (vix.price < 14) {
        score += 15;
        notes.push(`VIX ${vix.price.toFixed(1)} is calm`);
      }
      if (Number.isFinite(vix.changePercent)) {
        if (vix.changePercent <= -5) score += 10;
        else if (vix.changePercent >= 5) score -= 10;
      }
    }

    const spy = proxies.spy;
    if (spy && Number.isFinite(spy.changePercent)) {
      used = true;
      if (spy.changePercent <= -1) {
        score -= 20;
        notes.push(`S&P 500 ${spy.changePercent.toFixed(1)}%`);
      } else if (spy.changePercent >= 1) {
        score += 15;
        notes.push(`S&P 500 +${spy.changePercent.toFixed(1)}%`);
      }
    }

    const oil = proxies.oil;
    if (oil && Number.isFinite(oil.changePercent)) {
      used = true;
      if (oil.changePercent >= 3) {
        score -= 10;
        notes.push(`Oil +${oil.changePercent.toFixed(1)}% (cost shock)`);
      } else if (oil.changePercent <= -3) {
        score += 6;
        notes.push(`Oil ${oil.changePercent.toFixed(1)}% (cost relief)`);
      }
    }

    const dollar = proxies.dollar;
    if (dollar && Number.isFinite(dollar.changePercent)) {
      used = true;
      if (dollar.changePercent >= 0.7) {
        score -= 8;
        notes.push('Dollar firming (tighter liquidity)');
      } else if (dollar.changePercent <= -0.7) {
        score += 6;
        notes.push('Dollar softening');
      }
    }

    const gold = proxies.gold;
    if (gold && Number.isFinite(gold.changePercent) && gold.changePercent >= 1.2) {
      used = true;
      score -= 6;
      notes.push(`Gold +${gold.changePercent.toFixed(1)}% (haven bid)`);
    }

    macroScore = used ? clamp(Math.round(score), -100, 100) : null;
  }

  if (!themes.length && macroScore === null) return null;

  const riskTone =
    macroScore === null ? null : macroScore <= -20 ? 'risk-off' : macroScore >= 20 ? 'risk-on' : 'neutral';

  const parts = [];
  if (headlineTilt !== null) parts.push({ weight: 0.6, value: headlineTilt });
  if (macroScore !== null) parts.push({ weight: 0.4, value: macroScore });
  const weightTotal = parts.reduce((sum, part) => sum + part.weight, 0);
  const tilt = weightTotal
    ? Math.round(
        clamp(parts.reduce((sum, part) => sum + part.weight * part.value, 0) / weightTotal, -100, 100),
      )
    : null;
  const label = tilt === null ? 'mixed' : tilt >= 15 ? 'supportive' : tilt <= -15 ? 'hostile' : 'mixed';

  const topHeadlines = [...themed]
    .sort((a, b) => Math.abs(b.item.score) * b.item.weight - Math.abs(a.item.score) * a.item.weight)
    .slice(0, 6)
    .map(({ item }) => ({
      title: item.title,
      direction: item.direction,
      score: Math.round(item.score * 100),
      tags: item.tags,
    }));

  const summary =
    `The geopolitical backdrop is ${label}${tilt !== null ? ` (tilt ${tilt})` : ''}` +
    (riskTone ? ` on a ${riskTone} tape` : '') +
    (themes.length
      ? `; active themes: ${themes
          .slice(0, 3)
          .map((theme) => `${theme.label} (${theme.direction})`)
          .join(', ')}`
      : '') +
    (notes.length ? `. ${notes.slice(0, 3).join('; ')}.` : '.');

  return {
    label,
    tilt,
    riskTone,
    macroScore,
    headlineTilt,
    themes,
    headlines: topHeadlines,
    headlineCount: annotated.length,
    themedCount: themed.length,
    market: tradedProxies,
    notes,
    summary,
  };
}

export const _internals = { readProxy };
