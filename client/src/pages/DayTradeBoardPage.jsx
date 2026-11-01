import { useCallback, useEffect, useState } from 'react';
import SearchBox from '../components/SearchBox.jsx';
import { api } from '../lib/api.js';
import { money, pct, scoreTone, timeAgo, toneForChange } from '../lib/format.js';

const SCOPES = [
  { id: 'market', label: 'Live market' },
  { id: 'focus', label: 'Focus list' },
];

const DEPTHS = [8, 12, 20];

const signed = (value) => (Number(value) > 0 ? `+${value}` : `${value ?? 0}`);

/**
 * Best day-trading stocks: the live tape ranked by intraday tradeability, with
 * the 5-minute engine's BUY / SELL / WAIT call and its trade plan per name.
 * Clicking a row opens that ticker's full intraday read.
 */
export default function DayTradeBoardPage({ go }) {
  const [scope, setScope] = useState('market');
  const [depth, setDepth] = useState(12);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async ({ refresh = false, silent = false } = {}) => {
      if (!silent) {
        if (refresh) setRefreshing(true);
        else setLoading(true);
      }
      setError('');
      try {
        setData(await api.dayTradeBoard({ scope, depth, refresh }));
      } catch (err) {
        if (!silent) setError(err.message);
      } finally {
        if (!silent) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [scope, depth],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // Same cadence as the single-ticker read: the bars are cached for 60s.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load({ silent: true });
    }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const rows = data?.rows || [];
  const session = rows[0]?.session || null;

  return (
    <div className="page day-page">
      <section className="page-head">
        <div>
          <div className="eyebrow">DAY TRADING</div>
          <h1>
            Best day-trade <span className="muted">setups</span>
          </h1>
          <p className="page-sub">
            The live US tape ranked by what is actually tradable today — movement (ATR), relative volume and the strength
            of the 5-minute signal. Each row carries the engine&apos;s BUY / SELL / WAIT call and its trade plan.
          </p>
        </div>
        <div className="head-actions">
          <SearchBox compact onSelect={(next) => go(`/daytrade/${next}`)} placeholder="Open a ticker…" />
          <button type="button" className="btn btn-ghost" onClick={() => load({ refresh: true })} disabled={refreshing}>
            <span className={refreshing ? 'spin' : ''}>↻</span> Rescan
          </button>
        </div>
      </section>

      <section className="panel day-board-controls">
        <div className="hot-scope" role="group" aria-label="Scan scope">
          {SCOPES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={scope === option.id ? 'active' : ''}
              onClick={() => setScope(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="hot-depth">
          Names
          <select value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
            {DEPTHS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        {data && (
          <div className="day-board-meta">
            {data.marketState && <span className="badge badge-state">{data.marketState}</span>}
            {session && <span>Session {session}</span>}
            <span>
              {data.scanned}/{data.requested} read
              {data.universeSize ? ` · ${data.universeSize} screened` : ''}
            </span>
            <span>Updated {timeAgo(data.generatedAt)}</span>
          </div>
        )}
      </section>

      {data && rows.length > 0 && (
        <section className="day-board-summary">
          <div className="day-board-count buy">
            <span>Buy setups</span>
            <strong>{data.buyCount}</strong>
          </div>
          <div className="day-board-count sell">
            <span>Sell setups</span>
            <strong>{data.sellCount}</strong>
          </div>
          <div className="day-board-count wait">
            <span>No trade</span>
            <strong>{data.waitCount}</strong>
          </div>
          <div className="day-board-count">
            <span>Names read</span>
            <strong>{data.scanned}</strong>
          </div>
        </section>
      )}

      {error && (
        <div className="alert alert-error">
          <strong>Could not build the day-trade board.</strong> {error}
        </div>
      )}

      {loading && (
        <div className="analyzer-loading">
          <div className="loading-orbit" />
          <h2>Scanning the tape for the best intraday setups…</h2>
          <p className="muted">Reading 5-minute bars, session VWAP, the opening range and relative volume.</p>
        </div>
      )}

      {!loading && data && rows.length > 0 && (
        <section className="panel day-board-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">RANKED BY TRADEABILITY</div>
              <h2>
                {data.buyCount + data.sellCount} actionable setups
                <span className="muted"> · {data.waitCount} waiting for a break</span>
              </h2>
            </div>
            <span className="muted small">Click a row for the full intraday chart and AI desk call</span>
          </div>

          <div className="table-wrap">
            <table className="signal-table day-board">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Ticker</th>
                  <th>Set-up</th>
                  <th>Last</th>
                  <th>Day</th>
                  <th>Signal</th>
                  <th title="Mechanical signal score: + is a long read, − is a short read">Score</th>
                  <th>Entry</th>
                  <th>Stop</th>
                  <th title="Profit targets on a long plan, downside targets on a short plan">Targets</th>
                  <th>VWAP</th>
                  <th title="Today's volume versus the name's average volume">Rel vol</th>
                  <th title="Movement × participation × signal strength">Tradeability</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.symbol}
                    className="clickable"
                    onClick={() => go(`/daytrade/${row.symbol}`)}
                    title={`Open the ${row.symbol} intraday read`}
                  >
                    <td className="rank-cell">{row.rank}</td>
                    <td>
                      <div className="ticker-cell">
                        <span className="ticker-symbol">{row.symbol}</span>
                        <span className="ticker-name">{row.name}</span>
                      </div>
                    </td>
                    <td className="day-board-setup">
                      {row.setup}
                      <span className="day-board-why">{row.why}</span>
                    </td>
                    <td className="mono">{money(row.price)}</td>
                    <td className={`mono ${toneForChange(row.changePercent)}`}>{pct(row.changePercent)}</td>
                    <td>
                      <span className={`signal-pill ${row.action}`}>{row.action === 'wait' ? 'Wait' : row.actionLabel}</span>
                    </td>
                    <td className="mono">{signed(row.score)}</td>
                    <td className="mono">{row.plan ? money(row.plan.entry) : <span className="muted">—</span>}</td>
                    <td className={`mono ${row.plan ? 'down' : ''}`}>
                      {row.plan ? money(row.plan.stopLoss) : <span className="muted">—</span>}
                    </td>
                    <td>
                      {row.plan?.targets?.length ? (
                        <span className="day-board-targets">
                          {row.plan.targets.slice(0, 2).map((target) => (
                            <span key={`${row.symbol}-${target.label}`} className="target-chip">
                              {target.label} {money(target.price)}
                              {target.movePct !== null ? ` (${pct(target.movePct, 1)})` : ''}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="day-board-trigger">
                          ↑ {money(row.triggers.buyAbove)} · ↓ {money(row.triggers.sellBelow)}
                        </span>
                      )}
                    </td>
                    <td className="mono">{money(row.levels.vwap)}</td>
                    <td className="mono">{row.relativeVolume ? `${row.relativeVolume}×` : '—'}</td>
                    <td>
                      <span className={`score-chip ${scoreTone(row.tradeability)}`} title={row.why}>
                        {row.tradeability}
                      </span>
                    </td>
                    <td className="day-board-open">→</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="day-board-note muted small">
            Tradeability is a ranking aid, not a probability: it rewards names that move, trade volume and have a decisive
            5-minute read. A high score on a WAIT row still means no trade — use the breakout levels. Times are New York
            (ET); the board refreshes every 60 seconds.
          </p>
        </section>
      )}

      {!loading && data && !rows.length && (
        <section className="panel hot-empty">
          <div className="hot-empty-icon">⚡</div>
          <h2>No intraday setups right now</h2>
          <p className="muted">
            {data.note ||
              'The screen returned no readable session. The board needs an open US session with at least a few 5-minute bars per name.'}
          </p>
          <div className="hot-empty-actions">
            <button type="button" className="btn btn-ghost" onClick={() => load({ refresh: true })}>
              Scan again
            </button>
            <button type="button" className="btn btn-primary" onClick={() => go('/daytrade/NVDA')}>
              Open NVDA
            </button>
          </div>
        </section>
      )}

      {data?.errors?.length > 0 && (
        <div className="alert alert-info tiny">
          Some names could not be read: {data.errors.join(' · ')}
        </div>
      )}

      <div className="dashboard-footnote">
        Educational intraday ranking, not investment advice. A BUY or SELL call describes the current 5-minute signal;
        intraday prices can reverse through the stop and the levels are not forecasts.
      </div>
    </div>
  );
}
