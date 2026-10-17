/**
 * CLI wrapper for the news/deal archive, usable from cron or a one-off backfill:
 *
 *   npm run ingest                 # focus universe, today
 *   npm run ingest -- NVDA,MSFT    # subset
 */
import { closeMongo, connectMongo, isMongoReady } from '../src/lib/db.js';
import { FOCUS_SYMBOLS } from '../src/data/universe.js';
import { ingestUniverse, newsArchiveStats } from '../src/services/newsHistoryService.js';

const arg = process.argv.slice(2).find((value) => !value.startsWith('-'));
const symbols = arg ? arg.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean) : FOCUS_SYMBOLS;

const connected = await connectMongo();
if (!connected) {
  console.error('MongoDB is not reachable — set MONGODB_URI or start the mongo container.');
  process.exit(1);
}

try {
  console.log(`[ingest] collecting news for ${symbols.length} symbol(s)…`);
  const result = await ingestUniverse({ symbols });
  console.log(
    `[ingest] done · ${result.stored} headlines, ${result.deals} deals, ${result.failures} failure(s)`,
  );
  const stats = await newsArchiveStats();
  console.log(
    `[ingest] archive · ${stats.newsItems} items, ${stats.deals} deals, ${stats.digests} daily digests across ${stats.symbols} symbols`,
  );
  if (result.ok === false) process.exitCode = 1;
} finally {
  if (isMongoReady()) await closeMongo();
}
