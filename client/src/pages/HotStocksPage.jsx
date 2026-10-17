import { useCallback, useEffect, useState } from 'react';
import Sparkline from '../components/Sparkline.jsx';
import Stat from '../components/Stat.jsx';
import { api } from '../lib/api.js';
import { money, pct, scoreTone, timeAgo, toneForChange } from '../lib/format.js';

const ACTION_CLASS = { buy: 'action-buy', accumulate: 'action-accumulate' };

function HotCard({ stock, go, ai = null }) {
  const target = stock.primaryTarget;
  const aiDecision = ai?.decision || null;
  const aiLive = Boolean(ai?.decisionMeta && ai.decisionMeta.provider !== 'rule-engine');
  const belowZone = stock.price < stock.buyZone.low;
  const aboveZone = stock.price > stock.buyZone.high;
  const entryHint = stock.buyNow
    ? belowZone
      ? 'below the entry band — check the stop'
      : aboveZone
        ? 'just above the zone — still actionable'
        : 'price is in the zone now'
    : `wait for ${money(stock.waitFor)}`;
  const isEtf = stock.quoteType === 'ETF';

  return (
    <article className={`hot-card ${ACTION_CLASS[stock.action] || ''} ${stock.buyNow ? 'is-now' : 'is-wait'}`}>
      <header className="hot-head">
        <span className="hot-rank" title={`Rank ${stock.rank} by hot score`}>
          #{stock.rank}
        </span>
        <div className="signal-identity">
          <button type="button" className="signal-symbol mono" onClick={() => go(`/analyze/${stock.symbol}`)}>
            {stock.symbol}
          </button>
          <span className="signal-theme">{stock.name}</span>
          <span className={`badge badge-type ${isEtf ? 'etf' : ''}`}>{isEtf ? 'ETF' : 'STOCK'}</span>
        </div>
        <div className="signal-price">
          <span className="mono">{money(stock.price)}</span>
          <span className={`mono ${toneForChange(stock.changePercent)}`}>{pct(stock.changePercent)}</span>
        </div>
      </header>

      <div className="hot-status-row">
        <span className={`hot-badge ${stock.buyNow ? 'now' : 'wait'}`}>{stock.buyNow ? 'BUY NOW' : 'WAIT'}</span>
        <span className="setup-chip">{stock.setupLabel || stock.actionLabel}</span>
        <span
          className={`score-chip ${scoreTone(stock.hotScore)}`}
          title="Hot score = 60% quality + 25% conviction + 15% entry timing"
        >
          {stock.hotScore} hot
        </span>
      </div>

      {stock.why && <p className="hot-why">{stock.why}</p>}

      <div className="hot-levels">
        <div className="hot-level buy">
          <span className="hot-level-label">Buy at</span>
          <strong className="mono">
            {money(stock.buyZone.low, 0)}–{money(stock.buyZone.high, 0)}
          </strong>
          <span className="muted small">{entryHint}</span>
        </div>
        <div className="hot-level sell">
          <span className="hot-level-label">Sell at</span>
          {target ? (
            <>
              <strong className="mono">
                {money(target.price, 0)} <span className="hot-upside">+{target.upsidePct}%</span>
              </strong>
              <span className="muted small">
                {target.label || 'primary target'}
                {target.probability ? ` · ${target.probability}% est.` : ''}
                {target.source ? ` · ${target.source}` : ''}
              </span>
            </>
          ) : (
            <strong className="mono muted">No target</strong>
          )}
        </div>
      </div>

      {stock.sellPlan.length > 1 && (
        <div className="hot-sell-plan">
          <span className="hot-level-label">Sell ladder</span>
          <div className="hot-target-row">
            {stock.sellPlan.map((item) => (
              <span key={item.label || item.price} className="hot-target">
                <span className="target-badge">{item.label || '—'}</span>
                <span className="mono">{money(item.price, 0)}</span>
                <span className="mono up">+{item.upsidePct}%</span>
                {item.probability !== null && <span className="muted small">{item.probability}%</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="hot-meta">
        <span>
          Stop <b className="mono down">{money(stock.stopLoss, 0)}</b>
        </span>
        <span>
          R:R <b className="mono">{stock.riskReward ?? '—'}:1</b>
        </span>
        <span>
          Quality <b className="mono">{stock.score}/100</b>
        </span>
        <span>
          RSI <b className="mono">{stock.rsi ?? '—'}</b>
        </span>
        {stock.trend && (
          <span>
            Trend <b className={`mono ${stock.trend === 'up' ? 'up' : 'down'}`}>{stock.trend}</b>
          </span>
        )}
      </div>

      {aiDecision && (
        <div className={`hot-ai-row ${aiDecision.action}`}>
          <div className="hot-ai-head">
            <span className={`chip ${aiLive ? 'ai' : ''}`}>
              {aiLive ? `✦ ${ai.decisionMeta.provider} · ${ai.decisionMeta.model}` : 'engine call'}
            </span>
            <span className={`signal-pill ${aiDecision.action}`}>{aiDecision.actionLabel}</span>
            <span className="muted small">{aiDecision.conviction}% conviction</span>
            {stock.action && aiDecision.action !== stock.action && (
              <span className="chip warn">engine says {stock.actionLabel}</span>
            )}
          </div>
          {aiDecision.thesis && <p className="hot-ai-thesis">{aiDecision.thesis}</p>}
          {aiDecision.triggers && (
            <div className="hot-ai-levels">
              <span>
                Buy above <b className="mono">{money(aiDecision.triggers.buyAbove)}</b>
              </span>
              <span>
                Sell below <b className="mono down">{money(aiDecision.triggers.sellBelow)}</b>
              </span>
              {aiDecision.keyLevels?.target ? (
                <span>
                  Target <b className="mono up">{money(aiDecision.keyLevels.target)}</b>
                </span>
              ) : null}
            </div>
          )}
        </div>
      )}
      {ai?.decisionError && <div className="alert alert-info tiny">{ai.decisionError}</div>}

      <footer className="hot-foot">
        <Sparkline values={stock.sparkline} positive={(stock.changePercent ?? 0) >= 0} width={92} height={30} />
        <div className="hot-actions">
          <button type="button" className="btn btn-mini" onClick={() => go(`/analyze/${stock.symbol}`)}>
            Analyze
          </button>
          <button type="button" className="btn btn-mini" onClick={() => go(`/options/${stock.symbol}`)}>
            Options
          </button>
        </div>
      </footer>
    </article>
  );
}

const SCOPES = [
  { id: 'market', label: 'All market' },
  { id: 'broad', label: 'Curated board' },
  { id: 'focus', label: 'My list' },
];

/** How many of the screened names get the full plan (buy zone + sell ladder). */
const DEPTHS = [
  { value: 100, label: '100 names analysed (default)' },
  { value: 150, label: '150 names analysed (deepest)' },
  { value: 60, label: '60 names analysed (fast)' },
  { value: 40, label: '40 names analysed (fastest)' },
];

const TAPE_PAGE = 40;

export default function HotStocksPage({ go }) {
  const [data, setData] = useState(null);
  const [scope, setScope] = useState('market');
  const [depth, setDepth] = useState(100);
  const [tapeRows, setTapeRows] = useState(TAPE_PAGE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  // LLM desk verdicts, keyed by symbol, added on demand (one model call per name).
  const [aiDecisions, setAiDecisions] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError('');
      setAiDecisions(null);
      setAiError('');
      setTapeRows(TAPE_PAGE);
      try {
        setData(await api.hotStocks({ refresh, scope, depth }));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [scope, depth],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const stocks = data?.stocks || [];
  const tape = data?.tape || [];
  const buyNow = stocks.filter((stock) => stock.buyNow);
  const waiting = stocks.filter((stock) => !stock.buyNow);
  const top = buyNow[0] || stocks[0] || null;
  const visibleTape = tape.slice(0, tapeRows);
  // The desk endpoint caps a pass at 20 names so one click cannot fan out
  // into an unbounded number of model calls.
  const aiUniverse = stocks.slice(0, 20).map((stock) => stock.symbol);
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
    <div className="page hot-page">
      <section className="page-head">
        <div>
          <div className="eyebrow">HOT STOCKS</div>
          <h1>Buy now — and where to sell</h1>
          <p className="page-sub">
            The whole screened US market, live from Yahoo Finance — the most active names, day gainers, growth and value
            screens — ranked with the entry band to buy and the T1/T2/T3 prices to sell into. Every screened name is listed
            on the market tape; the hottest {data?.depth ?? depth} get a full plan.
          </p>
        </div>
        <div className="head-actions">
          {data?.generatedAt && <span className="meta-time">Scanned {timeAgo(data.generatedAt)}</span>}
          <div className="hot-scope" role="group" aria-label="Hot Stocks universe">
            {SCOPES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={scope === item.id ? 'active' : ''}
                aria-pressed={scope === item.id}
                onClick={() => setScope(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {scope === 'market' && (
            <label className="hot-depth">
              <span>Depth</span>
              <select value={depth} onChange={(event) => setDepth(Number(event.target.value))} disabled={loading}>
                {DEPTHS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={runAiDesk}
            disabled={aiLoading || loading || !aiUniverse.length}
            title={`Run the LLM desk call on the top ${aiUniverse.length} names (one model call each, cached 30 minutes)`}
          >
            <span className={aiLoading ? 'spin' : ''}>✦</span> {aiLoading ? 'AI desk running…' : 'Run AI desk'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={refreshing || loading}>
            <span className={refreshing ? 'spin' : ''}>↻</span> Refresh scan
          </button>
          <button type="button" className="btn btn-primary" onClick={() => go('/')}>
            Focus list
          </button>
        </div>
      </section>

      {error && (
        <div className="alert alert-error">
          <strong>Could not load hot stocks.</strong> {error}
        </div>
      )}

      <section className="panel hot-summary-panel">
        <div className="hot-summary">
          <Stat label="Buy-now setups" value={data?.buyNowCount ?? '—'} tone={buyNow.length ? 'up' : ''} />
          <Stat
            label="Top opportunity"
            value={top ? `${top.symbol} · ${top.hotScore}` : '—'}
            hint={top ? `${top.score}/100 quality · ${top.conviction}% conviction` : ''}
          />
          <Stat
            label="Fully analysed"
            value={data?.scanned ?? '—'}
            hint="Names with a scored plan: buy zone, T1/T2/T3 sell prices and a stop"
          />
          <Stat
            label="On the market tape"
            value={data?.universeSize ?? '—'}
            hint="Every name the Yahoo screens returned for this scan"
          />
          <Stat
            label="Waiting for pullback"
            value={data?.waitingCount ?? '—'}
            hint="Long setups whose price is still above the entry band"
          />
        </div>
        <p className="hot-method">
          Hot score = 60% quality + 25% conviction + 15% entry timing. Buy-now means the price is at or below the top of the
          accumulation band; names above it are listed separately with the price to wait for. <strong>All market</strong> pulls the
          live Yahoo screens ({data?.screens?.map((screen) => screen.id.replace(/_/g, ' ')).join(', ') || 'most actives, gainers, growth, value'})
          — {data?.universeSize ?? 0} names — and gives the hottest {data?.depth ?? depth} a full plan; the rest stay on the market
          tape with their live quote. <strong>Curated board</strong> scans the ~40-name liquid list, <strong>My list</strong> only
          your focus list. <strong>Run AI desk</strong> asks the configured model to review the top names and shows its buy/sell
          call next to the engine's.
        </p>
      </section>

      {aiDecisions && (
        <div className="alert alert-success tiny">
          AI desk reviewed {Object.keys(aiDecisions).length} names
          {aiMeta ? ` · ${aiMeta.provider} · ${aiMeta.model}` : ' — no LLM key configured, so each card shows the engine call'}.
          The model's action, conviction, thesis and triggers are shown on every card it covered.
        </div>
      )}
      {aiError && <div className="alert alert-error">AI desk failed — {aiError}</div>}

      {loading ? (
        <div className="hot-grid">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="skeleton-card hot-card-skeleton" />
          ))}
        </div>
      ) : !stocks.length ? (
        <section className="panel hot-empty">
          <div className="hot-empty-icon">⇗</div>
          <h2>No buy-now setups right now</h2>
          <p className="muted">
            None of the {data?.scanned ?? 0} fully analysed names is a buy or accumulate setup today. That is a valid answer —
            raise the analysis depth above, check the market tape below for the day's movers, or analyze a different ticker.
          </p>
          <div className="hot-empty-actions">
            <button type="button" className="btn btn-primary" onClick={() => go('/')}>
              Open focus list
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => load(true)}>
              Scan again
            </button>
          </div>
        </section>
      ) : (
        <>
          {buyNow.length > 0 && (
            <section className="panel hot-panel">
              <div className="panel-head">
                <div>
                  <div className="eyebrow">ENTRY TRIGGERED</div>
                  <h2>{buyNow.length} to buy now</h2>
                </div>
                <span className="muted small">Sell into the ladder · stop below the zone</span>
              </div>
              <div className="hot-grid">
                {buyNow.map((stock) => (
                  <HotCard key={stock.symbol} stock={stock} go={go} ai={aiDecisions?.[stock.symbol] || null} />
                ))}
              </div>
            </section>
          )}

          {waiting.length > 0 && (
            <section className="panel hot-panel">
              <div className="panel-head">
                <div>
                  <div className="eyebrow">PULLBACK WATCH</div>
                  <h2>{waiting.length} waiting for a better price</h2>
                </div>
                <span className="muted small">Long setups above the entry band — do not chase</span>
              </div>
              <div className="hot-grid">
                {waiting.map((stock) => (
                  <HotCard key={stock.symbol} stock={stock} go={go} ai={aiDecisions?.[stock.symbol] || null} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {tape.length > 0 && (
        <section className="panel hot-tape-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">MARKET TAPE · YAHOO SCREENS</div>
              <h2>
                All {tape.length} screened names
                <span className="muted"> · {data?.depth ?? 0} with a full buy/sell plan</span>
              </h2>
            </div>
            <span className="muted small">Live quote for every name · click a row for the full analysis</span>
          </div>
          <div className="table-wrap">
            <table className="signal-table hot-tape">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Last</th>
                  <th>Day</th>
                  <th>Rel vol</th>
                  <th>Heat</th>
                  <th>Call</th>
                  <th>Buy zone</th>
                  <th>Sell targets</th>
                  <th>Stop</th>
                </tr>
              </thead>
              <tbody>
                {visibleTape.map((row) => (
                  <tr key={row.symbol} className="clickable" onClick={() => go(`/analyze/${row.symbol}`)}>
                    <td>
                      <div className="ticker-cell">
                        <span className="ticker-symbol">
                          {row.symbol}
                          {row.curated && <span className="tape-tag" title="Curated focus name">★</span>}
                          {row.watchlist && <span className="tape-tag" title="On your watchlist">●</span>}
                        </span>
                        <span className="ticker-name">{row.name}</span>
                      </div>
                    </td>
                    <td className="mono">{money(row.price)}</td>
                    <td className={`mono ${toneForChange(row.changePercent)}`}>{pct(row.changePercent)}</td>
                    <td className="mono">{row.relativeVolume ? `${row.relativeVolume}×` : '—'}</td>
                    <td>{row.hotScore !== null ? <span className={`score-chip ${scoreTone(row.hotScore)}`}>{row.hotScore}</span> : <span className="muted small">—</span>}</td>
                    <td>
                      {row.action ? (
                        <span className="tape-call">
                          <span className={`signal-pill ${row.action}`}>{row.actionLabel}</span>
                          {row.buyNow && <span className="hot-badge now">BUY NOW</span>}
                        </span>
                      ) : (
                        <span className="muted small" title="Not in the analysed set — open the row to score it now">
                          {row.analysed ? 'no long setup' : 'not analysed'}
                        </span>
                      )}
                    </td>
                    <td className="mono">
                      {row.buyZone ? `${money(row.buyZone.low, 0)}–${money(row.buyZone.high, 0)}` : <span className="muted">—</span>}
                    </td>
                    <td className="mono targets-cell">
                      {row.sellPlan?.length ? (
                        row.sellPlan.map((target) => (
                          <span key={`${row.symbol}-${target.label || target.price}`} className="target-chip">
                            {target.label || 'T'} {money(target.price, 0)}
                            {target.upsidePct !== null ? ` (+${target.upsidePct}%)` : ''}
                          </span>
                        ))
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="mono down">{row.stopLoss ? money(row.stopLoss, 0) : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {tape.length > visibleTape.length && (
            <div className="tape-more">
              <button type="button" className="btn btn-ghost" onClick={() => setTapeRows((count) => count + TAPE_PAGE)}>
                Show {Math.min(TAPE_PAGE, tape.length - visibleTape.length)} more
              </button>
              <button type="button" className="btn btn-mini" onClick={() => setTapeRows(tape.length)}>
                Show all {tape.length}
              </button>
              <span className="muted small">
                Showing {visibleTape.length} of {tape.length}
              </span>
            </div>
          )}
        </section>
      )}

      {data?.errors?.length > 0 && (
        <div className="alert alert-info tiny">
          Some names could not be scanned: {data.errors.join(' · ')}
        </div>
      )}

      <div className="dashboard-footnote">
        Engine levels come from Yahoo Finance data; the AI desk reads the same evidence plus news and event risk. Educational only,
        not investment advice — targets are probabilistic and can gap through stops.
      </div>
    </div>
  );
}
