import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WATCHLIST,
  addWatchlist,
  listWatchlist,
  removeWatchlist,
  seedWatchlist,
} from '../src/lib/store.js';

const symbols = async () => (await listWatchlist()).map((item) => item.symbol);

test('watchlist seeds from the focus universe, accepts additions and removals', async () => {
  const seeded = await seedWatchlist();
  assert.equal(seeded.length, DEFAULT_WATCHLIST.length);
  assert.deepEqual(
    seeded.map((item) => item.symbol),
    DEFAULT_WATCHLIST.map((item) => item.symbol),
  );

  await addWatchlist({ symbol: 'VOO', name: 'Vanguard S&P 500 ETF', quoteType: 'ETF' });
  assert.ok((await symbols()).includes('VOO'));

  await removeWatchlist('VOO');
  assert.ok(!(await symbols()).includes('VOO'));
});

test('removing every name sticks — a later read does not resurrect the seed', async () => {
  for (const item of DEFAULT_WATCHLIST) await removeWatchlist(item.symbol);
  assert.equal((await listWatchlist()).length, 0);
  assert.equal((await seedWatchlist()).length, 0);
});
