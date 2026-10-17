/**
 * Headline analytics: sentiment, catalyst tagging and relevance ranking for
 * Yahoo Finance news. Pure functions only — all network IO lives in
 * lib/newsFeed.js so this file stays unit-testable.
 */

const STRONG_BULL = [
  'surge',
  'soar',
  'skyrocket',
  'plunge higher',
  'record high',
  'record revenue',
  'record profit',
  'blowout',
  'beat',
  'beats',
  'topped estimates',
  'raised guidance',
  'raises guidance',
  'raises outlook',
  'hikes forecast',
  'upgrade',
  'upgraded',
  'outperform',
  'buy rating',
  'price target raised',
  'wins contract',
  'wins order',
  'secured contract',
  'approval',
  'approved',
  'buyback',
  'repurchase',
  'breakthrough',
  'strong demand',
  'demand surges',
  'accelerating growth',
  'expands partnership',
];

const MILD_BULL = [
  'rally',
  'gain',
  'gains',
  'jump',
  'climbs',
  'rises',
  'higher',
  'growth',
  'expansion',
  'launch',
  'launches',
  'unveils',
  'partnership',
  'collaboration',
  'agreement',
  'deal',
  'investment',
  'invests',
  'stake',
  'dividend increase',
  'initiates coverage',
  'initiated with buy',
  'positive',
  'upside',
  'optimistic',
  'bullish',
  'record orders',
  'backlog',
  'capacity expansion',
  'ai demand',
  'contract',
  'wins',
  'secures',
  'signs',
  'supply agreement',
  'design win',
  'adoption',
  'ramp',
  'supplier',
];

const STRONG_BEAR = [
  'plunge',
  'plummet',
  'tumble',
  'slump',
  'crash',
  'selloff',
  'sell-off',
  'miss',
  'misses',
  'missed estimates',
  'cut guidance',
  'cuts guidance',
  'lowers outlook',
  'slashed forecast',
  'downgrade',
  'downgraded',
  'underperform',
  'sell rating',
  'price target cut',
  'lawsuit',
  'class action',
  'probe',
  'investigation',
  'subpoena',
  'recall',
  'fraud',
  'accounting issues',
  'bankruptcy',
  'delisting',
  'trading halt',
  'short seller',
  'layoffs',
  'job cuts',
  'writedown',
  'write-down',
  'impairment',
  'guidance withdrawn',
];

const MILD_BEAR = [
  'falls',
  'declines',
  'drops',
  'slides',
  'lower',
  'weak demand',
  'slowdown',
  'pressure',
  'concern',
  'concerns',
  'risk',
  'risks',
  'delay',
  'delays',
  'competition',
  'competitor',
  'costly',
  'headwind',
  'uncertainty',
  'warning',
  'cautious',
  'bearish',
  'downturn',
  'margin squeeze',
  'tariff',
  'export restrictions',
  'sanctions',
];

const TAG_RULES = [
  { tag: 'deal', re: /\b(acquir|acquisition|merger|takeover|buyout|stake|partnership|joint venture|collaborat|agreement|contract|order|supply deal|licens|alliance|invest(?:s|ment|ing)? in)\b/i, label: 'Business deal' },
  { tag: 'analyst', re: /\b(upgrade|downgrade|price target|pt |rating|initiat|analyst|outperform|underperform|overweight|equal-weight|neutral rating|buy rating|sell rating)\b/i, label: 'Analyst action' },
  { tag: 'earnings', re: /\b(earnings|quarter|q[1-4]\b|results|guidance|revenue|profit|eps|forecast|outlook|margin|beats|misses)\b/i, label: 'Earnings' },
  { tag: 'legal', re: /\b(lawsuit|sue[sd]?|court|probe|investigation|regulat|antitrust|fine|penalt|sec filing|subpoena)\b/i, label: 'Legal / regulatory' },
  { tag: 'macro', re: /\b(fed|federal reserve|inflation|rate cut|rate hike|treasury yield|recession|tariff|china|export control|sanction|gdp)\b/i, label: 'Macro' },
  { tag: 'product', re: /\b(launch|unveil|chip|gpu|accelerator|model release|data center|foundry|capacity|production|roadmap|prototype|autonomous|robotaxi)\b/i, label: 'Product / capacity' },
  { tag: 'capital', re: /\b(buyback|repurchase|dividend|stock split|offering|convertible|debt sale|credit facility|raise[sd]? capital)\b/i, label: 'Capital return' },
  { tag: 'ownership', re: /\b(ark invest|hedge fund|institutional|13f|insider (?:buy|sell)|stake (?:increase|cut)|files to sell|short interest)\b/i, label: 'Ownership flow' },
];

/**
 * Whole-word keyword matching. Substring matching counted "again" as a bullish
 * "gain", "dealer" as a "deal" and "mission" as a "miss"; boundaries stop that.
 */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchesAny = (haystack, needles) =>
  needles.filter((needle) => new RegExp(`\\b${escapeRegex(needle).replace(/\s+/g, '\\s+')}\\b`, 'i').test(haystack)).length;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const recencyWeight = (publishedAt) => {
  if (!publishedAt) return 0.5;
  const ageHours = (Date.now() - new Date(publishedAt).getTime()) / 3_600_000;
  if (Number.isNaN(ageHours)) return 0.5;
  if (ageHours <= 24) return 1;
  if (ageHours <= 72) return 0.8;
  if (ageHours <= 24 * 7) return 0.6;
  return 0.4;
};

/** Score a single headline into direction, strength, tags and reasons. */
export function analyzeHeadline({
  title = '',
  summary = '',
  publishedAt = null,
  publisher = '',
  link = null,
  relevance = null,
}) {
  const haystack = `${title} ${summary}`.toLowerCase();
  const strongBull = STRONG_BULL.filter((term) => matchesAny(haystack, [term]));
  const mildBull = MILD_BULL.filter((term) => matchesAny(haystack, [term]));
  const strongBear = STRONG_BEAR.filter((term) => matchesAny(haystack, [term]));
  const mildBear = MILD_BEAR.filter((term) => matchesAny(haystack, [term]));

  const raw = strongBull.length * 2 + mildBull.length - strongBear.length * 2 - mildBear.length;
  const score = clamp(raw / 4, -1, 1);
  const tags = TAG_RULES.filter((rule) => rule.re.test(haystack)).map((rule) => rule.tag);
  const tagLabels = TAG_RULES.filter((rule) => rule.re.test(haystack)).map((rule) => rule.label);
  const direction = score > 0.12 ? 'bullish' : score < -0.12 ? 'bearish' : 'neutral';
  // Headlines that actually name the ticker/company (and are fresh) carry more
  // weight than loosely related market commentary.
  const relevanceFactor = relevance === null ? 1 : clamp(0.4 + relevance / 5, 0.4, 1);
  const weight = Number((recencyWeight(publishedAt) * relevanceFactor).toFixed(3));

  return {
    title,
    publisher,
    link,
    publishedAt,
    direction,
    score: Number(score.toFixed(3)),
    relevance,
    weight,
    tags,
    tagLabels,
    reasons: [...strongBull, ...mildBull, ...strongBear, ...mildBear].slice(0, 5),
    summary: summary ? summary.slice(0, 400) : '',
  };
}

/** Relevance of a headline to a ticker, used for ranking before analysis. */
export function relevanceScore(item, symbol, companyName = '') {
  const title = String(item.title || '').toLowerCase();
  const summary = String(item.summary || '').toLowerCase();
  const company = String(companyName || '')
    .toLowerCase()
    .replace(/\b(inc|corp|corporation|company|technologies|limited|ltd|plc|group|holdings|co)\b\.?/g, '')
    .trim()
    .split(/\s+/)[0] || '';
  const ticker = symbol.toLowerCase().replace(/^\^/, '');

  let score = 0;
  if (new RegExp(`\\b${ticker}\\b`, 'i').test(title)) score += 3;
  if (company && company.length > 2 && title.includes(company)) score += 3;
  if (new RegExp(`\\b${ticker}\\b`, 'i').test(summary)) score += 1;
  if (company && company.length > 2 && summary.includes(company)) score += 1;
  if ((item.relatedTickers || []).map((t) => t.toUpperCase()).includes(symbol.toUpperCase())) score += 1;
  // Generic market vocabulary is a weak hint only — it must never be enough on
  // its own to qualify a headline as being about this company.
  if (/\b(stock|shares|earnings|revenue|guidance)\b/i.test(title)) score += 0.2;
  return score + recencyWeight(item.publishedAt) * 0.5;
}

/** Aggregate annotated headlines into a news read for one ticker. */
export function analyzeNews(items = []) {
  const annotated = items.map(analyzeHeadline);
  const totalWeight = annotated.reduce((acc, item) => acc + item.weight, 0) || 1;
  const sentiment = Math.round(
    clamp(
      (annotated.reduce((acc, item) => acc + item.score * item.weight, 0) / totalWeight) * 100,
      -100,
      100,
    ),
  );

  const catalysts = annotated
    .filter((item) => item.direction !== 'neutral' || item.tags.includes('deal'))
    .sort((a, b) => Math.abs(b.score) * b.weight - Math.abs(a.score) * a.weight)
    .slice(0, 6)
    .map((item) => ({
      title: item.title,
      direction: item.direction,
      score: Math.round(item.score * 100),
      tags: item.tagLabels,
      publisher: item.publisher,
      link: item.link,
      publishedAt: item.publishedAt,
    }));

  const deals = annotated
    .filter((item) => item.tags.includes('deal'))
    .map((item) => ({
      title: item.title,
      direction: item.direction,
      score: Math.round(item.score * 100),
      link: item.link,
      publishedAt: item.publishedAt,
    }));

  const risks = annotated
    .filter((item) => item.direction === 'bearish')
    .sort((a, b) => a.score * a.weight - b.score * b.weight)
    .slice(0, 4)
    .map((item) => ({
      title: item.title,
      score: Math.round(item.score * 100),
      tags: item.tagLabels,
      link: item.link,
      publishedAt: item.publishedAt,
    }));

  const counts = {
    bullish: annotated.filter((item) => item.direction === 'bullish').length,
    bearish: annotated.filter((item) => item.direction === 'bearish').length,
    neutral: annotated.filter((item) => item.direction === 'neutral').length,
  };

  const label =
    sentiment >= 35 ? 'strongly positive' : sentiment >= 12 ? 'positive' : sentiment <= -35 ? 'strongly negative' : sentiment <= -12 ? 'negative' : 'mixed';

  return {
    sentiment,
    label,
    headlineCount: annotated.length,
    counts,
    deals,
    catalysts,
    risks,
    headlines: annotated.map((item) => ({
      title: item.title,
      publisher: item.publisher,
      link: item.link,
      publishedAt: item.publishedAt,
      direction: item.direction,
      score: Math.round(item.score * 100),
      relevance: item.relevance,
      weight: item.weight,
      tags: item.tagLabels,
    })),
  };
}

/** Translate a stream of analyst actions into a tilt plus the latest moves. */
export function analyzeAnalystActions(history = [], limit = 6, lookbackDays = 120) {
  const cutoff = Date.now() - lookbackDays * 86_400_000;
  const recent = history
    .filter((entry) => entry.epochGradeDate && new Date(entry.epochGradeDate).getTime() >= cutoff)
    .sort((a, b) => new Date(b.epochGradeDate) - new Date(a.epochGradeDate));

  /**
   * The `action` field is the authoritative direction. Yahoo marks routine
   * reiterations as "main"/"reit" (same grade in and out) — scoring those from
   * `toGrade` turned every "maintains Buy" into an upgrade and saturated the
   * Street tilt. Only real up/down changes count, with new coverage weighted
   * at half.
   */
  const scoreAction = (entry) => {
    const direction = String(entry.action || '').toLowerCase();
    const to = String(entry.toGrade || '').toLowerCase();
    const grade = /strong buy|conviction buy/.test(to)
      ? 2
      : /buy|outperform|overweight|accumulate|positive/.test(to)
        ? 1
        : /strong sell/.test(to)
          ? -2
          : /underperform|underweight|sell|reduce/.test(to)
            ? -1
            : 0;
    if (direction === 'up') return Math.max(1, grade);
    if (direction === 'down') return Math.min(-1, grade);
    if (direction === 'init') return grade * 0.5;
    return 0;
  };

  const scored = recent.map((entry) => ({
    date: new Date(entry.epochGradeDate).toISOString().slice(0, 10),
    firm: entry.firm,
    action: entry.action,
    fromGrade: entry.fromGrade || null,
    toGrade: entry.toGrade || null,
    score: scoreAction(entry),
  }));

  const tilt = scored.reduce((acc, entry) => acc + entry.score, 0);
  const upgrades = scored.filter((entry) => entry.score > 0).length;
  const downgrades = scored.filter((entry) => entry.score < 0).length;

  return {
    window: `${lookbackDays} days`,
    total: scored.length,
    upgrades,
    downgrades,
    tilt: clamp(tilt / 6, -1, 1),
    latest: scored.slice(0, limit),
  };
}

export const _internals = {
  STRONG_BULL,
  STRONG_BEAR,
  TAG_RULES,
  recencyWeight,
  matchesAny,
};
