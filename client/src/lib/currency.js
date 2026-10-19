/**
 * Display currency for the whole app.
 *
 * Quotes arrive from Yahoo in USD. The user can show them in EUR (converted at
 * the live USD→EUR rate from `/api/market/fx`) or natively in USD.
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

export const currencySymbol = () => SYMBOLS[displayCurrency()] || '';

export const convertAmount = (value) => {
  const rate = activeRate();
  const amount = Number(value);
  return rate === null ? amount : amount * rate;
};

/** Currency code the UI is actually showing (USD while EUR FX is unavailable). */
export const isConverted = () => activeRate() !== null;

export const formatMoney = (value, digits = 2, { convert = true } = {}) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const code = convert ? displayCurrency() : 'USD';
  const amount = convert ? convertAmount(value) : Number(value);
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

export const convertMoneyText = (text) => {
  if (!isConverted()) return String(text ?? '');
  const rate = activeRate();
  const symbol = SYMBOLS[displayCurrency()] || '';
  return String(text ?? '').replace(
    /(-?)\$(-?\d[\d,]*(?:\.\d+)?)([KMBTk])?/g,
    (match, leading, rawNumber, suffix) => {
      const value = Number(String(rawNumber).replace(/,/g, ''));
      if (!Number.isFinite(value)) return match;
      const magnitude = suffix ? SUFFIX_SCALE[suffix.toUpperCase()] : 1;
      // Both "-$10" and "$-10" mean minus ten; never emit a double sign.
      const converted = Math.abs(value * magnitude * rate) * (leading === '-' || value < 0 ? -1 : 1);
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
