import { analyzeNews, relevanceScore } from '../analytics/news.js';
import { cache } from './cache.js';
import { fetchText } from './http.js';

/**
 * Yahoo Finance news layer: per-ticker RSS feed, relevance ranking, and
 * best-effort article body extraction so the research agent reads the story
 * behind a headline instead of guessing from the title.
 */


const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '"',
  rdquo: '"',
  lsquo: "'",
  rsquo: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  percent: '%',
  dollar: '$',
};

export function decodeEntities(text = '') {
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

const stripCdata = (value = '') => value.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();

const tagValue = (block, tag) => {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? stripCdata(match[1]) : '';
};

/** Raw Yahoo Finance RSS headlines for a ticker (already symbol-filtered by Yahoo). */
export async function getRssHeadlines(symbol) {
  return cache.wrap(`rss:${symbol}`, 10 * 60_000, async () => {
    try {
      const xml = await fetchText(`https://finance.yahoo.com/rss/headline?s=${encodeURIComponent(symbol)}`);
      const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1]);
      return blocks
        .map((block) => {
          const title = decodeEntities(tagValue(block, 'title'));
          const link = tagValue(block, 'link');
          const pubDate = tagValue(block, 'pubDate');
          const description = decodeEntities(tagValue(block, 'description'))
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const published = pubDate ? new Date(pubDate) : null;
          return {
            title,
            link,
            summary: description.slice(0, 400),
            publisher: 'Yahoo Finance',
            publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
          };
        })
        .filter((item) => item.title);
    } catch {
      return [];
    }
  });
}

/** Extract the most readable article body we can from a Yahoo article page. */
export function extractArticle(html = '') {
  const ldBlocks = html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || [];
  for (const block of ldBlocks) {
    const body = block.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (body) {
      try {
        const text = decodeEntities(JSON.parse(`"${body[1]}"`)).replace(/\s+/g, ' ').trim();
        if (text.length > 240) return text.slice(0, 4000);
      } catch {
        // fall through to paragraph scraping
      }
    }
  }

  const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]{40,900}?)<\/p>/g)]
    .map((match) => decodeEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 60 && !/^(subscribe|sign in|read more|terms of|privacy)/i.test(text));

  const text = [...new Set(paragraphs)].join('\n').slice(0, 4000);
  return text.length > 200 ? text : null;
}

export async function getArticleText(url) {
  if (!url || !/^https?:\/\//.test(url)) return null;
  return cache.wrap(`article:${url}`, 6 * 60 * 60_000, async () => {
    try {
      const html = await fetchText(url, { timeout: 15_000 });
      return extractArticle(html);
    } catch {
      return null;
    }
  });
}

/** Rank headlines for a ticker, keeping the most relevant ones. */
export function rankHeadlines(items, symbol, companyName, limit = 12) {
  const scored = items
    .map((item) => ({ ...item, relevance: relevanceScore(item, symbol, companyName) }))
    .sort((a, b) => b.relevance - a.relevance);
  const relevant = scored.filter((item) => item.relevance >= 1);
  // Yahoo's per-ticker feed still carries generic market stories. Only fall
  // back to unranked items when almost nothing mentions the company, otherwise
  // an "Apple is the top Magnificent 7 stock" piece ends up as a Microsoft
  // catalyst and skews the signal.
  const pool = relevant.length ? relevant : scored.slice(0, 5);
  return pool.slice(0, limit);
}

/**
 * Full news digest for a ticker: ranked headlines, sentiment, catalysts, deals,
 * risks, and (optionally) the text of the top articles for the LLM to read.
 */
export async function getNewsDigest(symbol, companyName, { withContent = false, articleCount = 3 } = {}) {
  const raw = await getRssHeadlines(symbol);
  const ranked = rankHeadlines(raw, symbol, companyName, 12);
  const digest = analyzeNews(ranked);

  let excerpts = [];
  if (withContent && ranked.length) {
    const targets = ranked.slice(0, articleCount);
    const texts = await Promise.all(targets.map((item) => getArticleText(item.link)));
    excerpts = targets
      .map((item, index) => ({
        title: item.title,
        link: item.link,
        publishedAt: item.publishedAt,
        content: texts[index] ? texts[index].slice(0, 1600) : null,
      }))
      .filter((item) => item.content);
  }

  return { ...digest, excerpts };
}

export const _internals = { stripCdata, tagValue };
