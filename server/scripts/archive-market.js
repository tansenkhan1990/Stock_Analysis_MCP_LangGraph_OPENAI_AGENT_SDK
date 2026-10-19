/**
 * CLI wrapper for the daily Yahoo Finance market archive, usable from cron or
 * a one-off backfill:
 *
 *   npm run archive                 # focus universe, today
 *   npm run archive -- NVDA,MSFT    # subset
 *
 * Always captures the current session from Yahoo; it never invents a past row.
 */
import { closeMongo, connectMongo, isMongoReady } from '../src/lib/db.js';
import { FOCUS_SYMBOLS } from '../src/data/universe.js';
import { captureUniverse } from '../src/services/marketArchiveService.js';
import { marketArchiveStats } from '../src/services/marketHistoryService.js';

const positional = process.argv.slice(2).filter((value) => !value.startsWith('-'));
const symbols = positional.length
  ? positional
      .join(',')
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean)
  : FOCUS_SYMBOLS;

const connected = await connectMongo();
if (!connected) {
  console.error('MongoDB is not reachable — set MONGODB_URI or start the mongo container.');
  process.exit(1);
}

try {
  console.log(`[archive] capturing ${symbols.length} symbol(s)…`);
  const result = await captureUniverse({ symbols });
  console.log(
    `[archive] done · ${result.stored} snapshot(s) stored for ${result.date}, ${result.failures} failure(s)`,
  );
  for (const row of result.results) {
    if (row.error) console.warn(`[archive] ${row.symbol} failed: ${row.error}`);
    else if (row.skipped) console.warn(`[archive] ${row.symbol} skipped: ${row.reason}`);
  }
  const stats = await marketArchiveStats();
  console.log(
    `[archive] stored history · ${stats.snapshots} snapshots across ${stats.symbols} symbols (${stats.firstDate} → ${stats.lastDate})`,
  );
  if (result.ok === false) process.exitCode = 1;
} finally {
  if (isMongoReady()) await closeMongo();
}
