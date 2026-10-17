import mongoose from 'mongoose';
import { config } from '../config.js';

/**
 * MongoDB is optional at runtime: prices, options and scoring all work without
 * it. When a database is reachable we use it as the permanent archive for the
 * news feed and deal history the daily ingest job collects, which is the one
 * thing an in-memory process cannot retain.
 */
const state = {
  connected: false,
  lastError: null,
  connectedAt: null,
};

mongoose.set('strictQuery', true);

export async function connectMongo() {
  const uri = config.mongo.uri;
  if (!uri) {
    console.log('[db] MONGODB_URI not set — news history will not be persisted');
    return false;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
      dbName: config.mongo.dbName,
    });
    state.connected = true;
    state.connectedAt = new Date();
    state.lastError = null;
    const { host, port, name } = mongoose.connection;
    console.log(`[db] MongoDB connected · ${host}:${port}/${name}`);
  } catch (error) {
    state.connected = false;
    state.lastError = error.message;
    console.warn(`[db] MongoDB unavailable (${error.message}) — continuing without news history`);
  }

  mongoose.connection.on('disconnected', () => {
    state.connected = false;
    state.lastError = 'disconnected';
    console.warn('[db] MongoDB disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    state.connected = true;
    state.lastError = null;
    console.log('[db] MongoDB reconnected');
  });

  return state.connected;
}

export async function closeMongo() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect().catch(() => {});
  state.connected = false;
}

export function isMongoReady() {
  return state.connected && mongoose.connection.readyState === 1;
}

export function mongoStatus() {
  return {
    driver: 'mongodb',
    connected: isMongoReady(),
    readyState: mongoose.connection.readyState,
    database: mongoose.connection.name || config.mongo.dbName || null,
    host: mongoose.connection.host || null,
    connectedAt: state.connectedAt ? state.connectedAt.toISOString() : null,
    lastError: state.lastError,
  };
}

export { mongoose };
