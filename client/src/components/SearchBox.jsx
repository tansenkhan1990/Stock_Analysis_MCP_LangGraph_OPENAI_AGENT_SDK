import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

export default function SearchBox({ onSelect, placeholder = 'Search ticker or company…', autoFocus = false, compact = false }) {
  const [value, setValue] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const onClick = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    const query = value.trim();
    if (query.length < 1) {
      setResults([]);
      return undefined;
    }
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const data = await api.search(query);
        setResults(data.results || []);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  const choose = (symbol) => {
    if (!symbol) return;
    setValue('');
    setOpen(false);
    setResults([]);
    inputRef.current?.blur();
    onSelect?.(symbol.toUpperCase());
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((prev) => Math.min(prev + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((prev) => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0 && results[active]) choose(results[active].symbol);
      else if (/^[a-z0-9.^=-]{1,15}$/i.test(value.trim())) choose(value.trim());
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={`search-box ${compact ? 'compact' : ''}`} ref={wrapRef}>
      <span className="search-icon" aria-hidden>
        ⌕
      </span>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setActive(-1);
        }}
        onFocus={() => results.length && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        aria-label="Search symbols"
      />
      {loading && <span className="search-spinner" aria-hidden />}
      {open && results.length > 0 && (
        <ul className="search-results">
          {results.map((item, index) => (
            <li key={item.symbol}>
              <button
                type="button"
                className={index === active ? 'active' : ''}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(item.symbol)}
              >
                <span className="search-symbol">{item.symbol}</span>
                <span className="search-name">{item.name}</span>
                <span className={`badge badge-type ${item.quoteType === 'ETF' ? 'etf' : ''}`}>{item.quoteType}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
