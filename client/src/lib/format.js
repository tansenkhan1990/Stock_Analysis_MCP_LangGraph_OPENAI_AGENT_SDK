import { convertAmount, currencySymbol, formatMoney } from './currency.js';

/** Display currency (EUR by default, live-converted) — used for all prices. */
export const money = (value, digits = 2) => formatMoney(value, digits);

/** Native US-dollar formatting for option contract terms (strikes, premiums). */
export const usd = (value, digits = 2) => formatMoney(value, digits, { convert: false });

export const num = (value, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

export const pct = (value, digits = 2, signed = true) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${Number(value).toFixed(digits)}%`;
};

/** Market values (market cap, …) in the display currency. */
export const bigNumber = (value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const converted = convertAmount(value);
  const symbol = currencySymbol();
  const abs = Math.abs(converted);
  if (abs >= 1e12) return `${symbol}${(converted / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${symbol}${(converted / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${symbol}${(converted / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${symbol}${(converted / 1e3).toFixed(1)}K`;
  return `${symbol}${converted.toFixed(2)}`;
};

/** Share counts and other plain quantities — never currency-converted. */
export const compact = (value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
};

export const scoreTone = (score) => {
  if (score >= 66) return 'good';
  if (score >= 56) return 'ok';
  if (score >= 45) return 'neutral';
  return 'bad';
};

export const toneForChange = (value) => (Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat');

export const timeAgo = (iso) => {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const shortDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';

export const expiryLabel = (date) => {
  if (!date) return '—';
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
};
