import { useCallback, useEffect, useState } from 'react';
import SearchBox from '../components/SearchBox.jsx';
import { api } from '../lib/api.js';
import { money, pct, scoreTone, timeAgo, toneForChange } from '../lib/format.js';

const SCOPES = [
  { id: 'market', label: 'Curated large caps + ETFs' },
  { id: 'focus', label: 'Focus list' },
];

const DEPTHS = [8, 12, 20];

const signed = (value) => (Number(value) > 0 ? `+${value}` : `${value ?? 0}`);

const RISER_DEPTHS = [6, 10, 16];
const chanceTone = (chance) => (chance >= 55 ? 'up' : chance <= 45 ? 'down' : 'flat');
const chanceArrow = (chance) => (chance >= 55 ? '↑' : chance <= 45 ? '↓' : '◆');

/**
 * Next-move risers: a deeper daily read of the same liquid universe the intraday
 * board scans. Each name is scored from its last month (pattern + analog
 * replay), Yahoo headline sentiment, the engine quality score and 3-month
 * relative strength vs SPY. The 1-hour call from the board above is shown as
 * confirmation, not folded into the daily chance.
 */
function NextMoveRisers({ go, intradayRows = [] }) {
  const [depth, setDepth] = useState(10);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        setData(await api.forecastBoard({ scope: 'daytrade', depth, refresh }));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [depth],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const intraday = new Map(intradayRows.map((row) => [row.symbol, row]));
  const rows = [...(data?.rows || [])].sort(
    (a, b) => b.day.chance - a.day.chance || b.week.chance - a.week.chance,
  );

  return (
    <section className="panel forecast-board-panel">
      <div className="panel-head">
        <div>
          <div className="eyebrow">NEXT-MOVE RISERS · 1 MONTH + NEWS</div>
          <h2>Most likely to rise next session</h2>
        </div>
        <div className="head-actions">
          <label className="hot-depth">
            Names
            <select value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
              {RISER_DEPTHS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={refreshing}>
            <span className={refreshing ? 'spin' : ''}>↻</span> Rescan
          </button>
        </div>
      </div>

      <p className="muted small">
        A deep read of the last month per name — trend, RSI, MACD, volume, range and the analog replay — blended
        with Yahoo headline sentiment, the engine quality score and 3-month relative strength vs SPY. The 1-hour call
        from the board above is confirmation, not part of the daily chance.
      </p>

      {data && (
        <div className="day-board-summary">
          <div className="day-board-count buy">
            <span>Could rise next session</span>
            <strong>{data.dayRisingCount}</strong>
          </div>
          <div className="day-board-count buy">
            <span>Could rise in 1 week</span>
            <strong>{data.risingCount}</strong>
          </div>
          <div className="day-board-count">
            <span>Names scored</span>
            <strong>{data.scanned}</strong>
          </div>
          <div className="day-board-count">
            <span>Updated</span>
            <strong className="fc-updated">{timeAgo(data.generatedAt)}</strong>
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-error">
          <strong>Could not build the next-move list.</strong> {error}
        </div>
      )}

      {loading && (
        <div className="analyzer-loading">
          <div className="loading-orbit" />
          <h2>Reading the last month and the news…</h2>
          <p className="muted">Pattern, analog replay, headline sentiment, quality and relative strength per name.</p>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="table-wrap">
          <table className="signal-table forecast-board">
            <thead>
              <tr>
                <th>#</th>
                <th>Ticker</th>
                <th title="Blended chance of a rise over the next trading session">Next session</th>
                <th title="Blended chance of a rise over the next five sessions">1 week</th>
                <th title="1-hour day-trade call from the board above">1-hour</th>
                <th title="1-month composite pattern score">Pattern</th>
                <th title="Yahoo headline sentiment and count">News</th>
                <th title="3-month relative strength vs SPY">RS</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const trade = intraday.get(row.symbol);
                return (
                  <tr
                    key={row.symbol}
                    className="clickable"
                    onClick={() => go(`/forecast/${row.symbol}`)}
                    title={`Open the ${row.symbol} forecast`}
                  >
                    <td className="rank-cell">{index + 1}</td>
                    <td>
                      <div className="ticker-cell">
                        <span className="ticker-symbol">{row.symbol}</span>
                        <span className="ticker-name">{row.name}</span>
                        <span className="fc-why">{row.why}</span>
                      </div>
                    </td>
                    <td>
                      <span
                        className={`fc-chance ${chanceTone(row.day.chance)}`}
                        title={`Pattern ${row.day.patternProbability}% · ${row.day.confidence}% confidence`}
                      >
                        {chanceArrow(row.day.chance)} {row.day.chance}%
                      </span>
                    </td>
                    <td>
                      <span
                        className={`fc-chance ${chanceTone(row.week.chance)}`}
                        title={`Pattern ${row.week.patternProbability}% · ${row.week.confidence}% confidence`}
                      >
                        {chanceArrow(row.week.chance)} {row.week.chance}%
                      </span>
                    </td>
                    <td>
                      {trade ? (
                        <span className={`signal-pill ${trade.action}`}>
                          {trade.action === 'wait' ? 'Wait' : trade.actionLabel}
                        </span>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`score-chip ${scoreTone(row.pattern.score)}`}>
                        {row.pattern.score > 0 ? `+${row.pattern.score}` : row.pattern.score}
                      </span>
                    </td>
                    <td>
                      {row.news ? (
                        <span
                          className={`chip ${row.news.sentiment > 0 ? 'long' : row.news.sentiment < 0 ? 'short' : ''}`}
                          title={row.news.topHeadline || 'Headline sentiment'}
                        >
                          📰 {row.news.sentiment > 0 ? '+' : ''}
                          {row.news.sentiment} {row.news.label} · {row.news.headlineCount}
                        </span>
                      ) : (
                        <span className="muted small">no headlines</span>
                      )}
                    </td>
                    <td
                      className={`mono ${
                        row.relativeStrength > 0 ? 'up' : row.relativeStrength < 0 ? 'down' : 'flat'
                      }`}
                    >
                      {row.relativeStrength === null
                        ? '—'
                        : `${row.relativeStrength > 0 ? '+' : ''}${row.relativeStrength}pp`}
                    </td>
                    <td className="day-board-open">→</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && data && rows.length === 0 && (
        <div className="empty-note">No names could be scored right now.</div>
      )}

      {data?.errors?.length > 0 && (
        <div className="alert alert-info tiny">Some names could not be read: {data.errors.join(' · ')}</div>
      )}
    </section>
  );
}

/**
 * Best day-trading stocks: a curated universe of liquid US large caps and ETFs
 * ranked by intraday tradeability, with the 1-hour engine's BUY / SELL / WAIT
 * call and its trade plan per name.
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
            Curated liquid US stocks and ETFs only — no penny stocks or leveraged products. Each name is ranked by what is
            actually tradable today: movement (ATR), relative volume and the strength of the read. The LLM desk reads the
            whole-day pattern — gap, opening drive, where the high and low printed, VWAP hold and the day type — and makes
            the BUY / SELL / WAIT call, with the mechanical engine kept beside it.
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
            {data.ai && (
              <span className={`day-source-chip ${data.ai.enabled ? 'ai' : 'engine'}`}>
                {data.ai.enabled ? `✦ AI desk · ${data.ai.model}` : '⚙ Mechanical engine'}
              </span>
            )}
            {session && <span>Session {session}</span>}
            <span>
              {data.scanned}/{data.requested} read
              {data.universeSize ? ` · ${data.universeSize} in the quality universe` : ''}
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

      {data?.ai?.note && <div className="alert alert-info tiny">{data.ai.note}</div>}

      {error && (
        <div className="alert alert-error">
          <strong>Could not build the day-trade board.</strong> {error}
        </div>
      )}

      {loading && (
        <div className="analyzer-loading">
          <div className="loading-orbit" />
          <h2>Scanning the quality universe for the best intraday setups…</h2>
          <p className="muted">Reading 1-hour bars, session VWAP, the first-hour range, ADX and relative volume.</p>
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
                      {row.sessionPattern && <span className="day-board-why">{row.sessionPattern.label}</span>}
                    </td>
                    <td className="mono">{money(row.price)}</td>
                    <td className={`mono ${toneForChange(row.changePercent)}`}>{pct(row.changePercent)}</td>
                    <td title={row.aiThesis || row.why}>
                      {row.source === 'ai' && <span className="muted small">✦ </span>}
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
            read. A high score on a WAIT row still means no trade — use the breakout levels. A ✦ marks a row where the LLM
            desk made the call; without a model key the mechanical engine decides. Signals follow the US regular session
            (09:30–16:00 New York); chart times are shown in German local time (CET/CEST). The board refreshes every 60
            seconds.
          </p>
        </section>
      )}

      {!loading && data && !rows.length && (
        <section className="panel hot-empty">
          <div className="hot-empty-icon">⚡</div>
          <h2>No intraday setups right now</h2>
          <p className="muted">
            {data.note ||
              'The board needs an open US session and the first hour closed before it reads a name.'}
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

      {!loading && <NextMoveRisers go={go} intradayRows={rows} />}

      {data?.errors?.length > 0 && (
        <div className="alert alert-info tiny">
          Some names could not be read: {data.errors.join(' · ')}
        </div>
      )}

      <div className="dashboard-footnote">
        Educational intraday ranking, not investment advice. A BUY or SELL call describes the current 1-hour signal;
        intraday prices can reverse through the stop and the levels are not forecasts.
      </div>
    </div>
  );
}
