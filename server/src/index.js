import { app } from './app.js';
import { config } from './config.js';
import { startNewsIngest, stopNewsIngest } from './jobs/newsIngest.js';
import { closeMongo, connectMongo, isMongoReady } from './lib/db.js';

await connectMongo();

const server = app.listen(config.port, () => {
  console.log(`[api] MarketPilot API listening on http://localhost:${config.port}`);
  console.log(
    isMongoReady()
      ? '[api] state: MongoDB connected — news & deal history is persisted'
      : '[api] state: in-memory (news history not persisted)',
  );
  startNewsIngest();
});

const shutdown = async (signal) => {
  console.log(`\n[api] ${signal} received — shutting down`);
  stopNewsIngest();
  server.close(async () => {
    await closeMongo();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
