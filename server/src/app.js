import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import { describeProvider } from './agent/providers.js';
import { config } from './config.js';
import { isMongoReady, mongoStatus } from './lib/db.js';
import { stats } from './lib/store.js';
import { newsArchiveStats } from './services/newsHistoryService.js';
import { agentRouter } from './routes/agent.js';
import { analysisRouter } from './routes/analysis.js';
import { dayTradeRouter } from './routes/dayTrade.js';
import { focusRouter } from './routes/focus.js';
import { marketRouter } from './routes/market.js';
import { newsRouter } from './routes/news.js';
import { optionsRouter } from './routes/options.js';
import { watchlistRouter } from './routes/watchlist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
if (config.nodeEnv !== 'test') app.use(morgan('tiny'));

app.get('/api/health', async (req, res) => {
  const [{ storage: _memoryOnly, ...memoryCounts }, archive] = await Promise.all([
    stats(),
    newsArchiveStats(),
  ]);
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    storage: isMongoReady() ? 'mongodb' : 'memory',
    database: mongoStatus(),
    agent: describeProvider(),
    counts: {
      ...memoryCounts,
      newsItems: archive.newsItems,
      digests: archive.digests,
      archivedDeals: archive.deals,
    },
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/market', marketRouter);
app.use('/api/news', newsRouter);
app.use('/api/focus', focusRouter);
app.use('/api', analysisRouter);
app.use('/api/options', optionsRouter);
app.use('/api/daytrade', dayTradeRouter);
app.use('/api/watchlist', watchlistRouter);
app.use('/api/agent', agentRouter);

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route ${req.originalUrl}` });
});

const clientDist = path.resolve(__dirname, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || 500;
  if (status >= 500) console.error('[api]', error);
  res.status(status).json({
    error: error.message || 'Internal server error',
    ...(error.details ? { details: error.details } : {}),
  });
});
