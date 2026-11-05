/**
 * Display currency for the whole app.
 *
 * Yahoo quotes retain their native currency. The user can show USD and EUR
 * listings in the selected display currency when the live FX rate is available.
 *
 * `money()` and the other formatters in `format.js` read this module-level
 * state, so every price in the UI flips with one switch. `CurrencyProvider`
 * keeps it in sync with the fetched rate and re-renders the tree.
 */
export const CURRENCIES = ['EUR', 'USD'];
export const DEFAULT_CURRENCY = 'EUR';
export const CURRENCY_STORAGE_KEY = 'marketpilot:currency';

const SYMBOLS = { EUR: '€', USD: '$' };

let state = {
  code: DEFAULT_CURRENCY,
  rate: null, // EUR per 1 USD
  asOf: null,
  stale: false,
  source: null,
  error: null,
};

export const readStoredCurrency = () => {
  try {
    const stored = window.localStorage.getItem(CURRENCY_STORAGE_KEY);
    return CURRENCIES.includes(stored) ? stored : DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
};

export const storeCurrency = (code) => {
  try {
    window.localStorage.setItem(CURRENCY_STORAGE_KEY, code);
  } catch {
    /* private mode — the choice just won't survive a reload */
  }
};

export const setMoneyState = (patch) => {
  state = { ...state, ...patch };
  return state;
};

/** EUR per USD, or null when the user is on USD / no rate is available yet. */
export const activeRate = () => {
  if (state.code === 'USD') return null;
  return Number.isFinite(state.rate) && state.rate > 0 ? state.rate : null;
};

export const displayCurrency = () => (activeRate() === null ? 'USD' : state.code);

export const currencySymbol = (sourceCurrency = 'USD') => {
  const source = String(sourceCurrency || 'USD').toUpperCase();
  const target = displayCurrency();
  const rate = Number.isFinite(state.rate) && state.rate > 0 ? state.rate : null;
  if (rate === null || (source !== 'USD' && source !== 'EUR')) return SYMBOLS[source] || `${source} `;
  return SYMBOLS[target] || '';
};

export const convertAmount = (value, sourceCurrency = 'USD') => {
  const rate = Number.isFinite(state.rate) && state.rate > 0 ? state.rate : null;
  const amount = Number(value);
  const source = String(sourceCurrency || 'USD').toUpperCase();
  const target = displayCurrency();
  if (source === target || rate === null) return amount;
  if (source === 'USD' && target === 'EUR') return amount * rate;
  if (source === 'EUR' && target === 'USD') return amount / rate;
  return amount;
};

export const formatMoney = (value, digits = 2, { convert = true, sourceCurrency = 'USD' } = {}) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const source = String(sourceCurrency || 'USD').toUpperCase();
  const target = convert ? displayCurrency() : source;
  const rate = Number.isFinite(state.rate) && state.rate > 0 ? state.rate : null;
  const canConvert = rate !== null && ((source === 'USD' && target === 'EUR') || (source === 'EUR' && target === 'USD'));
  const code = canConvert || source === target ? target : source;
  const amount = convert ? convertAmount(value, source) : Number(value);
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

/**
 * Rewrite `$` amounts in free-form text (AI answers, research notes) into the
 * active display currency. Handles grouped numbers and K/M/B/T suffixes.
 */
const SUFFIX_SCALE = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

export const convertMoneyText = (text, sourceCurrency = 'USD') => {
  const source = String(sourceCurrency || 'USD').toUpperCase();
  const target = displayCurrency();
  const rate = Number.isFinite(state.rate) && state.rate > 0 ? state.rate : null;
  const rawText = String(text ?? '');
  if (source === target) return source === 'EUR' ? rawText.replace(/\$/g, '€') : rawText;
  if (source !== 'USD' && source !== 'EUR') return rawText;
  if (rate === null) return source === 'EUR' ? rawText.replace(/\$/g, '€') : rawText;
  const symbol = SYMBOLS[target] || '';
  return String(text ?? '').replace(
    /(-?)\$(-?\d[\d,]*(?:\.\d+)?)([KMBTk])?/g,
    (match, leading, rawNumber, suffix) => {
      const value = Number(String(rawNumber).replace(/,/g, ''));
      if (!Number.isFinite(value)) return match;
      const magnitude = suffix ? SUFFIX_SCALE[suffix.toUpperCase()] : 1;
      // Both "-$10" and "$-10" mean minus ten; never emit a double sign.
      const direction = leading === '-' || value < 0 ? -1 : 1;
      const amount = Math.abs(value * magnitude);
      const converted = (source === 'USD' ? amount * rate : amount / rate) * direction;
      const sign = converted < 0 ? '−' : '';
      const abs = Math.abs(converted);

      if (suffix) {
        const scaled = abs / magnitude;
        return `${sign}${symbol}${scaled.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
      }

      const digits = Number.isInteger(value) ? 0 : 2;
      return `${sign}${symbol}${abs.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}`;
    },
  );
};
