import { useCallback, useEffect, useState } from 'react';
import SearchBox from '../components/SearchBox.jsx';
import Sparkline from '../components/Sparkline.jsx';
import { api } from '../lib/api.js';
import { money, num, pct, scoreTone, timeAgo, toneForChange } from '../lib/format.js';

const SkeletonRow = () => (
  <div className="skeleton-row">
    <div className="skeleton" style={{ width: '18%' }} />
    <div className="skeleton" style={{ width: '10%' }} />
    <div className="skeleton" style={{ width: '24%' }} />
    <div className="skeleton" style={{ width: '16%' }} />
    <div className="skeleton" style={{ width: '12%' }} />
  </div>
);

export default function DashboardPage({ go }) {
  const [overview, setOverview] = useState(null);
  const [scan, setScan] = useState(null);
  const [watchlist, setWatchlist] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [addError, setAddError] = useState('');
  const [busySymbol, setBusySymbol] = useState('');
  // LLM desk verdicts for the scan table, fetched on demand (one call per name).
  const [aiDecisions, setAiDecisions] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const watch = await api.watchlist();
      setWatchlist(watch.items || []);
      const symbols = (watch.items || []).map((item) => item.symbol);
      const [overviewData, scanData, snapshotData] = await Promise.allSettled([
        api.overview(),
        api.scan(symbols.length ? symbols : undefined),
        api.snapshots(6),
      ]);
      if (overviewData.status === 'fulfilled') setOverview(overviewData.value);
      if (scanData.status === 'fulfilled') setScan(scanData.value);
      if (snapshotData.status === 'fulfilled') setSnapshots(snapshotData.value.snapshots || []);
      if (overviewData.status === 'rejected' && scanData.status === 'rejected') {
        setError(overviewData.reason?.message || 'Unable to reach the MarketPilot API.');
      }
    } catch (err) {
      setError(err.message || 'Unable to load the dashboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addSymbol = async (symbol) => {
    setAddError('');
    setBusySymbol(symbol);
    try {
      await api.addWatchlist(symbol);
      await load(true);
    } catch (err) {
      setAddError(err.message);
    } finally {
      setBusySymbol('');
    }
  };

  const removeSymbol = async (symbol) => {
    setBusySymbol(symbol);
    try {
      await api.removeWatchlist(symbol);
      setWatchlist((items) => items.filter((item) => item.symbol !== symbol));
      setScan((current) => (current ? { ...current, signals: current.signals.filter((item) => item.symbol !== symbol) } : current));
    } catch (err) {
      setAddError(err.message);
    } finally {
      setBusySymbol('');
    }
  };

  const indices = overview?.indices || [];
  const signals = scan?.signals || [];
  const aiUniverse = signals.slice(0, 20).map((signal) => signal.symbol);
  const aiMeta =
    aiDecisions && Object.values(aiDecisions).find((entry) => entry?.decisionMeta?.provider !== 'rule-engine')?.decisionMeta;

  const runAiDesk = async () => {
    if (!aiUniverse.length) return;
    setAiLoading(true);
    setAiError('');
    try {
      const payload = await api.deskAi({ symbols: aiUniverse });
      setAiDecisions(payload.decisions || {});
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="page dashboard">
      <section className="page-head">
        <div>
          <div className="eyebrow">MARKET COMMAND CENTER</div>
          <h1>What is the tape telling you?</h1>
          <p className="page-sub">
            Live Yahoo Finance prices, a transparent multi-factor score, and a concrete buy zone, targets and stop for every name you follow.
          </p>
        </div>
        <div className="head-actions">
          {overview?.asOf && <span className="meta-time">Updated {timeAgo(overview.asOf)}</span>}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={runAiDesk}
            disabled={aiLoading || loading || !aiUniverse.length}
            title={`Run the LLM desk call on the top ${aiUniverse.length} names (one model call each, cached 30 minutes)`}
          >
            <span className={aiLoading ? 'spin' : ''}>✦</span> {aiLoading ? 'AI desk running…' : 'Run AI desk'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={refreshing}>
            <span className={refreshing ? 'spin' : ''}>↻</span> Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={() => go('/analyze/AAPL')}>
            Open analyzer
          </button>
        </div>
      </section>

      {error && (
        <div className="alert alert-error">
          <strong>API unavailable.</strong> {error} — make sure the Express server is running on port 4000.
        </div>
      )}

      <section className="index-strip">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="index-card skeleton-card" />)
          : indices.map((item) => (
              <div key={item.symbol} className="index-card">
                <div className="index-top">
                  <span className="index-label">{item.label}</span>
                  <span className="index-symbol">{item.symbol}</span>
                </div>
                <div className="index-price">{item.price === null ? '—' : num(item.price)}</div>
                <div className={`index-change ${toneForChange(item.changePercent)}`}>
                  {pct(item.changePercent)} <span className="muted">today</span>
                </div>

              </div>
            ))}
      </section>

      <div className="dashboard-grid">
        <section className="panel pulse-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">MARKET PULSE</div>
              <h2>Risk regime</h2>
            </div>
            {overview && <span className={`regime regime-${overview.regime}`}>{overview.regime}</span>}
          </div>

          {overview ? (
            <>
              <div className="pulse-metrics">
                <div>
                  <span className="metric-label">VIX</span>
                  <span className="metric-value">{num(overview.vix, 1)}</span>
                </div>
                <div>
                  <span className="metric-label">Sector breadth</span>
                  <span className="metric-value">
                    {overview.breadth.advancing}
                    <span className="muted">/{overview.breadth.total}</span>
                  </span>
                </div>
                <div>
                  <span className="metric-label">Leader</span>
                  <span className="metric-value small up">{overview.leader?.label || '—'}</span>
                </div>
                <div>
                  <span className="metric-label">Laggard</span>
                  <span className="metric-value small down">{overview.laggard?.label || '—'}</span>
                </div>
              </div>
              <div className="breadth-bar">
                <div
                  className="breadth-fill"
                  style={{ width: `${(overview.breadth.advancing / Math.max(1, overview.breadth.total)) * 100}%` }}
                />
              </div>
              <div className="sector-grid">
                {overview.sectors.map((sector) => (
                  <div key={sector.symbol} className={`sector-chip ${toneForChange(sector.changePercent)}`}>
                    <span>{sector.label}</span>
                    <strong>{pct(sector.changePercent, 1)}</strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="skeleton" style={{ height: 160 }} />
          )}
        </section>

        <section className="panel watch-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">WATCHLIST</div>
              <h2>{watchlist.length} instruments</h2>
            </div>
            <span className="muted small">Click × to remove</span>
          </div>
          <div className="watch-add">
            <SearchBox compact placeholder="Add ticker…" onSelect={addSymbol} />
            {busySymbol && <span className="muted small">Updating {busySymbol}…</span>}
          </div>
          {addError && <div className="alert alert-error tiny">{addError}</div>}
          <div className="watch-list">
            {watchlist.map((item) => {
              const signal = signals.find((row) => row.symbol === item.symbol);
              return (
                <div key={item.symbol} className="watch-item">
                  <button type="button" className="watch-main" onClick={() => go(`/analyze/${item.symbol}`)}>
                    <span className="watch-symbol">{item.symbol}</span>
                    <span className="watch-name">{item.name}</span>
                    <span className={`badge badge-type ${item.quoteType === 'ETF' ? 'etf' : ''}`}>{item.quoteType}</span>
                  </button>
                  <div className="watch-right">
                    {signal ? (
                      <>
                        <span className={`score-chip ${scoreTone(signal.score)}`}>{signal.score}</span>
                        <span className={`change ${toneForChange(signal.changePercent)}`}>{pct(signal.changePercent)}</span>
                      </>
                    ) : (
                      <span className="muted small">—</span>
                    )}
                    <button
                      type="button"
                      className="icon-btn"
                      title={`Remove ${item.symbol}`}
                      onClick={() => removeSymbol(item.symbol)}
                      disabled={busySymbol === item.symbol}
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
            {!watchlist.length && !loading && <div className="empty-note">Add a ticker to start tracking it.</div>}
          </div>
        </section>
      </div>

      <section className="panel signals-panel">
        <div className="panel-head">
          <div>
            <div className="eyebrow">AI SIGNAL BOARD</div>
            <h2>Scored opportunities</h2>
          </div>
          <div className="signal-legend">
            <span className="legend-dot good" /> Strong
            <span className="legend-dot neutral" /> Neutral
            <span className="legend-dot bad" /> Weak
          </div>
        </div>

        {loading && <SkeletonRow />}
        {!loading && !signals.length && (
          <div className="empty-note">No signals yet. Add tickers to your watchlist and refresh.</div>
        )}

        {signals.length > 0 && (
          <div className="table-wrap">
            <table className="signal-table">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Last</th>
                  <th>Day</th>
                  <th>Score</th>
                  <th>Verdict</th>
                  <th title="LLM desk call — run the AI pass to fill this column">AI</th>
                  <th>Buy zone</th>
                  <th>Sell targets</th>
                  <th>Stop</th>
                  <th>R:R</th>
                  <th>40d</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {signals.map((signal) => (
                  <tr key={signal.symbol} onClick={() => go(`/analyze/${signal.symbol}`)} className="clickable">
                    <td>
                      <div className="ticker-cell">
                        <span className="ticker-symbol">{signal.symbol}</span>
                        <span className="ticker-name">{signal.name}</span>
                      </div>
                    </td>
                    <td className="mono">{money(signal.price)}</td>
                    <td className={`mono ${toneForChange(signal.changePercent)}`}>{pct(signal.changePercent)}</td>
                    <td>
                      <span className={`score-chip ${scoreTone(signal.score)}`}>{signal.score}</span>
                    </td>
                    <td>
                      <span className={`signal-pill ${signal.action}`}>{signal.actionLabel}</span>
                    </td>
                    <td>
                      {aiDecisions?.[signal.symbol]?.decision ? (
                        <span className="ai-cell">
                          <span className={`signal-pill ${aiDecisions[signal.symbol].decision.action}`}>
                            {aiDecisions[signal.symbol].decision.actionLabel}
                          </span>
                          <span className="muted small">{aiDecisions[signal.symbol].decision.conviction}%</span>
                          {aiDecisions[signal.symbol].decision.action !== signal.action && (
                            <span className="chip warn" title={`Conflicts with the mechanical call: engine says ${signal.actionLabel}`}>
                              ≠ engine
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="muted small">{aiDecisions ? '—' : 'not run'}</span>
                      )}
                    </td>
                    <td className="mono">
                      {signal.buyZone ? `${money(signal.buyZone.low, 0)}–${money(signal.buyZone.high, 0)}` : <span className="muted">wait</span>}
                    </td>
                    <td className="mono targets-cell">
                      {signal.targets?.length
                        ? signal.targets.map((target) => (
                            <span key={target.label} className="target-chip">
                              {target.label} {money(target.price, 0)}
                            </span>
                          ))
                        : '—'}
                    </td>
                    <td className="mono down">{money(signal.stopLoss, 0)}</td>
                    <td className="mono">{signal.riskReward ?? '—'}</td>
                    <td>
                      <Sparkline values={signal.sparkline} positive={signal.changePercent >= 0} width={76} height={26} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-mini"
                        onClick={(event) => {
                          event.stopPropagation();
                          go(`/options/${signal.symbol}`);
                        }}
                      >
                        Options
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {aiDecisions && (
          <div className="alert alert-success tiny">
            AI desk reviewed {Object.keys(aiDecisions).length} names
            {aiMeta ? ` · ${aiMeta.provider} · ${aiMeta.model}` : ' — no LLM key configured, so the AI column shows the engine call'}.
          </div>
        )}
        {aiError && <div className="alert alert-error">AI desk failed — {aiError}</div>}
      </section>

      <div className="dashboard-grid bottom-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">RECENT RESEARCH</div>
              <h2>Saved analyses</h2>
            </div>
          </div>
          {snapshots.length ? (
            <div className="snapshot-list">
              {snapshots.map((snapshot) => (
                <button
                  key={snapshot.id}
                  type="button"
                  className="snapshot-row"
                  onClick={() => go(`/analyze/${snapshot.symbol}`)}
                >
                  <span className="ticker-symbol">{snapshot.symbol}</span>
                  <span className={`signal-pill ${snapshot.action || snapshot.signal}`}>
                    {snapshot.actionLabel || snapshot.signal?.replace('_', ' ')}
                  </span>
                  <span className="mono">{money(snapshot.price)}</span>
                  <span className={`score-chip ${scoreTone(snapshot.score)}`}>{snapshot.score}</span>
                  <span className="muted small">{timeAgo(snapshot.createdAt)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-note">
              Save an analysis from the Analyzer to keep a research trail.
            </div>
          )}
        </section>

        <section className="panel how-panel">
          <div className="eyebrow">HOW IT WORKS</div>
          <h2>One engine, three lenses</h2>
          <ol className="how-list">
            <li>
              <span className="how-num">01</span>
              <div>
                <strong>Multi-factor score</strong>
                <p>Trend, momentum, volume, valuation, risk and Street sentiment weighted into a 0–100 score.</p>
              </div>
            </li>
            <li>
              <span className="how-num">02</span>
              <div>
                <strong>Level-based plan</strong>
                <p>Buy zone, three targets and a stop anchored to pivots, moving averages and ATR — not guesswork.</p>
              </div>
            </li>
            <li>
              <span className="how-num">03</span>
              <div>
                <strong>Options expression</strong>
                <p>Defined-risk spreads chosen from implied-volatility richness, max pain and expected move.</p>
              </div>
            </li>
          </ol>
          <button type="button" className="btn btn-primary wide" onClick={() => go('/agent')}>
            Ask the AI analyst
          </button>
        </section>
      </div>

      <div className="dashboard-footnote">
        Data sourced from Yahoo Finance and may be delayed. Scores are probabilistic, not guarantees.
      </div>
    </div>
  );
}
