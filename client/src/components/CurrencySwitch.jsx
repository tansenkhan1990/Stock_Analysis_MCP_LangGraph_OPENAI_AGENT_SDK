import { useCurrency } from './CurrencyProvider.jsx';

const LABELS = [
  { code: 'EUR', label: 'EUR', hint: 'Prices in euro (converted at the live USD→EUR rate)' },
  { code: 'USD', label: 'USD', hint: 'Prices in US dollars (native quote currency)' },
];

export default function CurrencySwitch() {
  const { code, rate, live, stale, error, setCurrency } = useCurrency();

  const title = (() => {
    if (code === 'USD') return 'Displaying native USD prices. Switch to EUR to convert.';
    if (!live) return `Live USD→EUR rate unavailable${error ? ` (${error})` : ''} — showing USD.`;
    const when = stale ? 'last known rate' : 'live rate';
    return `1 USD = ${rate.toFixed(4)} EUR (${when}). Click USD to show native prices.`;
  })();

  return (
    <div className={`currency-switch ${live && code === 'EUR' ? 'live' : ''}`} role="group" aria-label="Display currency" title={title}>
      {LABELS.map((item) => (
        <button
          key={item.code}
          type="button"
          className={item.code === code ? 'active' : ''}
          aria-pressed={item.code === code}
          onClick={() => setCurrency(item.code)}
          title={item.hint}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
