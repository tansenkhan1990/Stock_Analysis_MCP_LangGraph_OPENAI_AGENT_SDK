import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAnalystActions, analyzeHeadline, analyzeNews, relevanceScore } from '../src/analytics/news.js';
import { decodeEntities, extractArticle, rankHeadlines } from '../src/lib/newsFeed.js';

test('bullish headline is scored positive and tagged', () => {
  const item = analyzeHeadline({
    title: 'Nvidia beats estimates as AI chip demand surges, raises guidance',
    publishedAt: new Date().toISOString(),
  });
  assert.equal(item.direction, 'bullish');
  assert.ok(item.score > 0.2);
  assert.ok(item.tags.includes('earnings'));
  assert.equal(item.weight, 1);
});

test('bearish headline with legal tag is scored negative', () => {
  const item = analyzeHeadline({
    title: 'Tesla slides after regulator opens investigation into Autopilot claims',
    publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  });
  assert.equal(item.direction, 'bearish');
  assert.ok(item.score < 0);
  assert.ok(item.tags.includes('legal'));
  assert.ok(item.weight < 1);
});

test('deal headlines are tagged as business deals', () => {
  const item = analyzeHeadline({
    title: 'AMD signs multi-year partnership and supply agreement with hyperscaler',
    publishedAt: new Date().toISOString(),
  });
  assert.ok(item.tags.includes('deal'));
  assert.equal(item.direction, 'bullish');
});

test('neutral headline stays neutral', () => {
  const item = analyzeHeadline({ title: 'Cathie Wood rebalances Ark funds', publishedAt: new Date().toISOString() });
  assert.equal(item.direction, 'neutral');
  assert.ok(Math.abs(item.score) <= 0.12);
});

test('relevance ranking prefers ticker and company mentions', () => {
  const onTopic = relevanceScore({ title: 'NVDA stock jumps on data centre demand' }, 'NVDA', 'NVIDIA Corp.');
  const offTopic = relevanceScore({ title: 'AbbVie is a dividend king' }, 'NVDA', 'NVIDIA Corp.');
  assert.ok(onTopic > offTopic);

  const ranked = rankHeadlines(
    [
      { title: 'AbbVie dividend analysis', publishedAt: new Date().toISOString() },
      { title: 'NVIDIA unveils new accelerator', publishedAt: new Date().toISOString() },
    ],
    'NVDA',
    'NVIDIA Corp.',
  );
  assert.match(ranked[0].title, /NVIDIA/);
});

test('news digest aggregates sentiment, deals and risks', () => {
  const digest = analyzeNews([
    { title: 'Nvidia beats on record data centre revenue, raises outlook', publishedAt: new Date().toISOString() },
    { title: 'Nvidia wins major supply contract with cloud provider', publishedAt: new Date().toISOString() },
    { title: 'Nvidia plunges as export restrictions hit guidance', publishedAt: new Date().toISOString() },
  ]);
  assert.ok(digest.headlineCount === 3);
  assert.ok(digest.counts.bullish === 2);
  assert.ok(digest.counts.bearish === 1);
  assert.ok(digest.deals.length >= 1);
  assert.ok(digest.catalysts.length >= 2);
  assert.ok(digest.risks.length === 1);
  assert.ok(digest.sentiment > -100 && digest.sentiment < 100);
});

test('analyst actions produce a tilt over the lookback window', () => {
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const older = new Date(Date.now() - 200 * 86_400_000).toISOString();
  const result = analyzeAnalystActions([
    { epochGradeDate: recent, firm: 'Morgan Stanley', fromGrade: 'Equal-Weight', toGrade: 'Overweight', action: 'up' },
    { epochGradeDate: recent, firm: 'Citi', fromGrade: 'Buy', toGrade: 'Buy', action: 'main' },
    { epochGradeDate: recent, firm: 'Barclays', fromGrade: 'Overweight', toGrade: 'Underweight', action: 'down' },
    { epochGradeDate: older, firm: 'Stale Firm', toGrade: 'Buy', action: 'up' },
  ]);
  assert.equal(result.total, 3);
  // Only the real upgrade/downgrade counts — "maintains Buy" is not an upgrade.
  assert.equal(result.upgrades, 1);
  assert.equal(result.downgrades, 1);
  assert.equal(result.tilt, 0);
  assert.equal(result.latest.length, 3);
});

test('a downgrade to a still-positive grade counts as negative', () => {
  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const result = analyzeAnalystActions([
    { epochGradeDate: recent, firm: 'Morgan Stanley', fromGrade: 'Overweight', toGrade: 'Equal-Weight', action: 'down' },
    { epochGradeDate: recent, firm: 'Goldman Sachs', fromGrade: 'Strong Buy', toGrade: 'Buy', action: 'down' },
    { epochGradeDate: recent, firm: 'Citi', fromGrade: 'Buy', toGrade: 'Buy', action: 'reit' },
  ]);
  assert.equal(result.upgrades, 0);
  assert.equal(result.downgrades, 2);
  assert.ok(result.tilt < 0);
});

test('keyword matching respects word boundaries', () => {
  const falling = analyzeHeadline({ title: 'Tesla falls again as demand worries build' });
  assert.equal(falling.direction, 'bearish');
  assert.ok(!falling.reasons.includes('gain'), 'the word "again" is not a gain');

  const dealer = analyzeHeadline({ title: 'Dealer network expands across Europe' });
  assert.ok(!dealer.tags.includes('deal'), 'a dealer is not a business deal');

  const miss = analyzeHeadline({ title: 'Company mission statement updated' });
  assert.equal(miss.direction, 'neutral');
});

test('article extraction prefers JSON-LD body and falls back to paragraphs', () => {
  const jsonLdHtml = `<html><script type="application/ld+json">{"articleBody":"${'Nvidia said demand outstripped supply for a fourth straight quarter. '.repeat(6)}"}</script></html>`;
  const fromJsonLd = extractArticle(jsonLdHtml);
  assert.ok(fromJsonLd && fromJsonLd.length > 240);

  const plainHtml = `<html><body>${[1, 2, 3]
    .map(
      (page) =>
        `<p>${'The company raised its full year outlook as orders accelerated and margins expanded. '.repeat(2)}(section ${page})</p>`,
    )
    .join('')}</body></html>`;
  const fromParagraphs = extractArticle(plainHtml);
  assert.ok(fromParagraphs && /raised its full year outlook/.test(fromParagraphs));

  assert.equal(extractArticle('<html><body><p>short</p></body></html>'), null);
});

test('entity decoding handles common Yahoo news escapes', () => {
  assert.equal(decodeEntities('Nvidia&amp;#39;s chip &quot;Blackwell&quot;'), 'Nvidia&#39;s chip "Blackwell"');
  assert.equal(decodeEntities('&#8217;'), '’');
});

test('off-topic headlines are dropped when the company is actually covered', () => {
  const now = new Date().toISOString();
  const ranked = rankHeadlines(
    [
      { title: 'Apple is now the top-performing Magnificent 7 stock', publishedAt: now },
      { title: 'NVIDIA unveils next-gen accelerator at GTC', publishedAt: now },
      { title: 'Microsoft Azure wins a large AI cloud contract', publishedAt: now },
      { title: 'Oil prices slip on demand worries', publishedAt: now },
    ],
    'MSFT',
    'Microsoft Corp.',
  );
  assert.ok(ranked.length >= 1);
  assert.ok(ranked.every((item) => /microsoft|msft/i.test(item.title)), ranked.map((item) => item.title).join(' | '));
});
