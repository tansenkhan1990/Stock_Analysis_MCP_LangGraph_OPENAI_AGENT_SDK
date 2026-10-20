import { useCallback, useEffect, useState } from 'react';
import CurrencySwitch from './components/CurrencySwitch.jsx';
import { useCurrency } from './components/CurrencyProvider.jsx';
import LlmBadge from './components/LlmBadge.jsx';
import SearchBox from './components/SearchBox.jsx';
import { api } from './lib/api.js';
import AgentPage from './pages/AgentPage.jsx';
import AnalyzerPage from './pages/AnalyzerPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import DayTradePage from './pages/DayTradePage.jsx';
import HotStocksPage from './pages/HotStocksPage.jsx';
import FocusPage from './pages/FocusPage.jsx';
import OptionsLabPage from './pages/OptionsLabPage.jsx';
import PortfolioPage from './pages/PortfolioPage.jsx';

const parseHash = () => {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  return {
    page: parts[0] || 'focus',
    param: parts[1] ? decodeURIComponent(parts[1]).toUpperCase() : null,
    query: new URLSearchParams(queryPart || ''),
  };
};

const TABS = [
  { id: 'focus', label: 'Focus List', path: '/', icon: '◎' },
  { id: 'hot', label: 'Hot Stocks', path: '/hot', icon: '⇗' },
  { id: 'portfolio', label: 'Portfolio', path: '/portfolio', icon: '▤' },
  { id: 'daytrade', label: 'Day Trading', path: '/daytrade/NVDA', icon: '⚡' },
  { id: 'market', label: 'Market', path: '/market', icon: '◧' },
  { id: 'analyze', label: 'Analyzer', path: '/analyze/NVDA', icon: '◔' },
  { id: 'options', label: 'Options Lab', path: '/options/NVDA', icon: '⌁' },
  { id: 'agent', label: 'AI Agent', path: '/agent', icon: '✦' },
];

export default function App() {
  const [route, setRoute] = useState(parseHash);
  const [health, setHealth] = useState(null);
  const { code, rate, live, stale } = useCurrency();

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .health()
        .then((payload) => {
          if (!cancelled) setHealth(payload);
        })
        .catch(() => {
          if (!cancelled) setHealth({ ok: false });
        });
    load();
    // The API reads .env once at boot, so after a restart (a model switch) the
    // badge should follow along without a full page reload.
    const timer = setInterval(load, 60_000);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const go = useCallback((path) => {
    const target = path.startsWith('#') ? path : `#${path}`;
    if (window.location.hash === target) {
      setRoute(parseHash());
    } else {
      window.location.hash = target;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const active = ['focus', 'hot', 'portfolio', 'daytrade', 'market', 'analyze', 'options', 'agent'].includes(route.page)
    ? route.page
    : 'focus';
  const page = (() => {
    switch (active) {
      case 'hot':
        return <HotStocksPage go={go} health={health} />;
      case 'portfolio':
        return <PortfolioPage health={health} />;
      case 'daytrade':
        return <DayTradePage symbol={route.param || 'NVDA'} go={go} />;
      case 'analyze':
        return <AnalyzerPage symbol={route.param || 'NVDA'} go={go} />;
      case 'options':
        return <OptionsLabPage symbol={route.param || 'NVDA'} go={go} route={route} />;
      case 'agent':
        return <AgentPage go={go} health={health} />;
      case 'market':
        return <DashboardPage go={go} />;
      default:
        return <FocusPage go={go} health={health} />;
    }
  })();

  return (
    <div className="app">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <button type="button" className="brand" onClick={() => go('/')}>
          <span className="brand-mark">
            <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
              <path d="M5 24 L12 15 L18 19 L27 7" fill="none" stroke="url(#brand-gradient)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="27" cy="7" r="3" fill="#34d399" />
              <defs>
                <linearGradient id="brand-gradient" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#34d399" />
                </linearGradient>
              </defs>
            </svg>
          </span>
          <span className="brand-text">
            Market<span>Pilot</span>
          </span>
        </button>

        <nav className="nav" aria-label="Primary">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`nav-tab ${active === tab.id ? 'active' : ''}`}
              onClick={() => go(tab.path)}
            >
              <span className="nav-icon" aria-hidden>
                {tab.icon}
              </span>
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="topbar-actions">
          <SearchBox compact onSelect={(symbol) => go(`/analyze/${symbol}`)} placeholder="Ticker…" />
          <CurrencySwitch />
          {health === null ? (
            <LlmBadge agent={null} />
          ) : health.ok ? (
            <LlmBadge agent={health.agent} />
          ) : (
            <div className="status-pill offline" title="The API is not responding">
              <span className="status-dot" />
              <span className="status-text">offline</span>
            </div>
          )}
        </div>
      </header>

      <main className="main">{page}</main>

      <footer className="footer">
        <div>
          <strong>MarketPilot</strong> · Yahoo Finance data · AI research assistant
          {code !== 'USD' && live && (
            <span className="fx-note">
              {' '}
              · prices in {code} at 1 USD = {rate.toFixed(4)} {code}
              {stale ? ' (last known rate)' : ''}
            </span>
          )}
          {code !== 'USD' && !live && <span className="fx-note warn"> · live USD→{code} rate unavailable — showing USD</span>}
        </div>
        <div className="footer-note">
          Educational analysis only. Not investment advice. Options involve substantial risk of loss.
        </div>
      </footer>
    </div>
  );
}
