import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Support both a root .env and server/.env (the server file wins).
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(projectRoot, 'server', '.env'), override: true, quiet: true });

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const provider = (process.env.LLM_PROVIDER || 'auto').toLowerCase();

const detectedProvider =
  provider !== 'auto'
    ? provider
    : process.env.OPENAI_API_KEY
      ? 'openai'
      : process.env.ANTHROPIC_API_KEY
        ? 'anthropic'
        : process.env.GEMINI_API_KEY
          ? 'gemini'
          : process.env.OLLAMA_BASE_URL
            ? 'ollama'
            : 'builtin';

export const config = {
  port: num(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',
  mongo: {
    uri: process.env.MONGODB_URI || '',
    dbName: process.env.MONGODB_DB || 'marketpilot',
    serverSelectionTimeoutMs: num(process.env.MONGODB_TIMEOUT_MS, 5000),
  },
  ingest: {
    enabled: (process.env.NEWS_INGEST_ENABLED ?? 'true') !== 'false',
    onBoot: (process.env.NEWS_INGEST_ON_BOOT ?? 'true') !== 'false',
    hour: num(process.env.NEWS_INGEST_HOUR, 18),
    retentionDays: num(process.env.NEWS_RETENTION_DAYS, 365),
  },
  fx: {
    // Fixed USD→EUR rate for offline use; empty/0 means live Yahoo data.
    manualRate: Math.max(0, num(process.env.USD_EUR_RATE, 0)),
    ttlMs: num(process.env.CACHE_TTL_FX, 10 * 60_000),
  },
  cache: {
    quoteTtl: num(process.env.CACHE_TTL_QUOTE, 60_000),
    historyTtl: num(process.env.CACHE_TTL_HISTORY, 5 * 60_000),
    intradayTtl: num(process.env.CACHE_TTL_INTRADAY, 60_000),
    optionsTtl: num(process.env.CACHE_TTL_OPTIONS, 3 * 60_000),
    analysisTtl: num(process.env.CACHE_TTL_ANALYSIS, 90_000),
    scanTtl: num(process.env.CACHE_TTL_SCAN, 5 * 60_000),
  },
  llm: {
    provider: detectedProvider,
    maxToolRounds: num(process.env.LLM_MAX_TOOL_ROUNDS, 5),
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, ''),
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      baseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    },
    ollama: {
      baseUrl: (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
      model: process.env.OLLAMA_MODEL || 'llama3.1',
    },
  },
};

/**
 * A provider is only "live" when it can actually be called. An explicit
 * LLM_PROVIDER with no key would otherwise make every surface claim an LLM is
 * active and then fail on every request instead of using the rule engine.
 */
export const hasLLM = (() => {
  switch (config.llm.provider) {
    case 'openai':
      return Boolean(config.llm.openai.apiKey);
    case 'anthropic':
      return Boolean(config.llm.anthropic.apiKey);
    case 'gemini':
      return Boolean(config.llm.gemini.apiKey);
    case 'ollama':
      // Ollama is local and keyless; a configured base URL is enough to try it.
      return Boolean(config.llm.ollama.baseUrl);
    default:
      return false;
  }
})();
