import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { readStoredCurrency, setMoneyState, storeCurrency } from '../lib/currency.js';

const CurrencyContext = createContext({
  code: 'EUR',
  rate: null,
  live: false,
  stale: false,
  error: null,
  setCurrency: () => {},
});

export function CurrencyProvider({ children }) {
  const [code, setCode] = useState(readStoredCurrency);
  const [fx, setFx] = useState({ rate: null, asOf: null, stale: false, error: null, source: null });

  // Formatters read module state, so publish it before children render. This
  // is a plain assignment (no React state) and is idempotent under StrictMode.
  setMoneyState({ code, rate: fx.rate, asOf: fx.asOf, stale: fx.stale, error: fx.error, source: fx.source });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.fx();
        if (cancelled) return;
        setFx({
          rate: data?.rate ?? null,
          asOf: data?.asOf ?? null,
          stale: Boolean(data?.stale),
          error: data?.error ?? null,
          source: data?.source ?? null,
        });
      } catch (error) {
        if (!cancelled) setFx((current) => ({ ...current, error: error.message }));
      }
    };

    load();
    const timer = setInterval(load, 15 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const setCurrency = useCallback((next) => {
    if (!['EUR', 'USD'].includes(next)) return;
    storeCurrency(next);
    setCode(next);
  }, []);

  const value = useMemo(
    () => ({
      code,
      rate: fx.rate,
      live: Number.isFinite(fx.rate) && fx.rate > 0,
      stale: fx.stale,
      error: fx.error,
      source: fx.source,
      setCurrency,
    }),
    [code, fx, setCurrency],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export const useCurrency = () => useContext(CurrencyContext);
