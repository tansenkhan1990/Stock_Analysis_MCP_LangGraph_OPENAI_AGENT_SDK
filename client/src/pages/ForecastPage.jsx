import { useCallback, useEffect, useState } from 'react';
import CandleChart from '../components/CandleChart.jsx';
import SearchBox from '../components/SearchBox.jsx';
import Stat from '../components/Stat.jsx';
import { api } from '../lib/api.js';
import { money, pct, scoreTone, shortDate, timeAgo } from '../lib/format.js';

const toneFor = (direction) => (direction === 'rise' ? 'up' : direction === 'drop' ? 'down' : 'flat');
const arrowFor = (direction) => (direction === 'rise' ? '▲' : direction === 'drop' ? '▼' : '◆');
const meterTone = (confidence) => (confidence >= 70 ? 'good' : confidence >= 50 ? 'ok' : 'neutral');

function HorizonCard({ horizon }) {
  const tone = toneFor(horizon.direction);
  const chance =
    horizon.direction === 'rise'
      ? 'chance of a rise'
      : horizon.direction === 'drop'
        ? 'chance of a drop'
        : 'no directional edge';

  return (
    <article className={`panel fc-card ${tone}`}>
      <div className="panel-head tight">
        <div>
          <div className="eyebrow">{horizon.label}</div>
          <h2>{horizon.directionLabel}</h2>
        </div>
        <span className="fc-horizon">
          {horizon.horizon === 1 ? '1 session' : `${horizon.horizon} sessions`}
        </span>
      </div>

      <div className="fc-prob">
        <span className="fc-arrow" aria-hidden>
          {arrowFor(horizon.direction)}
        </span>
        <span className="fc-prob-value mono">{horizon.probability}%</span>
        <span className="muted small">{chance}</span>
      </div>

      <div className="fc-levels">
        <Stat
          label="Expected price"
          value={money(horizon.expectedPrice)}
          hint="Live price compounded by the expected move"
        />
        <Stat
          label="Expected move"
          value={pct(horizon.expectedPct)}
          tone={horizon.expectedPct >= 0 ? 'up' : 'down'}
        />
        <Stat label="Typical range" value={`${money(horizon.lowPrice)} – ${money(horizon.highPrice)}`} />
        <Stat label="Confidence" value={`${horizon.confidence}%`} />
      </div>

      <div className="meter">
        <div className={`meter-fill ${meterTone(horizon.confidence)}`} style={{ width: `${horizon.confidence}%` }} />
      </div>

      {horizon.drivers.length > 0 && (
        <ul className="fc-drivers">
          {horizon.drivers.map((driver) => (
            <li key={driver}>{driver}</li>
          ))}
        </ul>
      )}

      {horizon.caveats.length > 0 && (
        <ul className="fc-drivers fc-caveats">
          {horizon.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function AnalogRow({ title, analog }) {
  const matched = analog?.matched || {};
  const baseline = analog?.baseline || {};
  return (
    <div className="fc-analog-row">
      <span>{title}</span>
      <b>{matched.samples ? `${matched.hitRate}% hit · ${matched.samples} setups` : 'no match'}</b>
      <span className="muted small">
        baseline {baseline.hitRate ?? '—'}% of {baseline.samples} sessions
      </span>
    </div>
  );
}

function ForecastCall({ data }) {
  const ai = data.source === 'ai';
  const news = data.news;

  return (
    <section className="panel fc-call">
      <div className="panel-head tight">
        <div>
          <div className="eyebrow">THE CALL · CHART + NEWS + EARNINGS</div>
          <h2>{ai ? 'Forecast desk read' : 'Mechanical 1-month read'}</h2>
        </div>
        <span className={`chip ${ai ? 'ai' : ''}`}>
          {ai
            ? `✦ ${data.decisionMeta?.provider || 'ai'} · ${data.decisionMeta?.model || 'model'}`
            : '⚙ MarketPilot rule engine'}
        </span>
      </div>

      {data.analysis?.thesis ? (
        <p className="fc-thesis">{data.analysis.thesis}</p>
      ) : (
        <p className="fc-thesis muted small">
          {ai
            ? 'The model returned the two calls without a written summary.'
            : 'No LLM key is configured, so these projections come from the mechanical 1-month model. Add one to have the forecast desk read the chart and headlines.'}
        </p>
      )}

      {data.analysis?.newsTakeaway ? <p className="fc-news-takeaway">📰 {data.analysis.newsTakeaway}</p> : null}

      {news?.headlines?.length ? (
        <ul className="fc-news">
          {news.headlines.map((item) => (
            <li key={`${item.title}-${item.publishedAt || ''}`}>
              <span
                className={`chip ${
                  item.direction === 'bullish' ? 'long' : item.direction === 'bearish' ? 'short' : ''
                }`}
              >
                {item.direction || 'neutral'}
              </span>
              <span className="fc-news-title">{item.title}</span>
              {item.publishedAt && <span className="muted small fc-news-date">{shortDate(item.publishedAt)}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No recent headlines were available — this call is chart-only.</p>
      )}

      {news && (
        <p className="muted small">
          Headline sentiment {news.sentiment > 0 ? '+' : ''}
          {news.sentiment} ({news.label}) across {news.headlineCount} stories.
        </p>
      )}

      {data.earnings && (
        <p className="fc-news-takeaway">
          📊 {data.earnings.label ? `${data.earnings.label} · ` : ''}
          {data.earnings.reportedQuarters
            ? `last ${data.earnings.reportedQuarters} quarters: ${data.earnings.beats} beat · ${data.earnings.misses} missed`
            : 'no reported quarters in the feed'}
          {Number.isFinite(data.earnings.revenueGrowthPct)
            ? ` · revenue ${data.earnings.revenueGrowthPct > 0 ? '+' : ''}${data.earnings.revenueGrowthPct}%`
            : ''}
          {Number.isFinite(data.earnings.earningsGrowthPct)
            ? ` · EPS ${data.earnings.earningsGrowthPct > 0 ? '+' : ''}${data.earnings.earningsGrowthPct}%`
            : ''}
          {data.earnings.nextDate ? ` · next report ${shortDate(data.earnings.nextDate)}` : ''}
        </p>
      )}

      {data.analysis?.patternTakeaway ? (
        <p className="fc-news-takeaway">📈 {data.analysis.patternTakeaway}</p>
      ) : null}

      {data.analysis?.dealTakeaway ? (
        <p className="fc-news-takeaway">🤝 {data.analysis.dealTakeaway}</p>
      ) : null}

      {data.analysis?.macroTakeaway ? (
        <p className="fc-news-takeaway">🌍 {data.analysis.macroTakeaway}</p>
      ) : null}

      {data.analysis?.whatWouldChangeMyMind ? (
        <p className="fc-note">What would change the call: {data.analysis.whatWouldChangeMyMind}</p>
      ) : null}
      {data.decisionError && <p className="qa-note">{data.decisionError}</p>}
    </section>
  );
}

const BOARD_SCOPES = [
  { id: 'watchlist', label: 'My list' },
  { id: 'curated', label: 'Curated' },
];
const BOARD_DEPTHS = [6, 10, 16];

const chanceTone = (chance) => (chance >= 55 ? 'up' : chance <= 45 ? 'down' : 'flat');
const chanceArrow = (chance) => (chance >= 55 ? '↑' : chance <= 45 ? '↓' : '◆');

function RisersBoard({ go }) {
  const [scope, setScope] = useState('watchlist');
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
        setData(await api.forecastBoard({ scope, depth, refresh }));
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

  const rows = data?.rows || [];

  return (
    <section className="panel forecast-board-panel">
      <div className="panel-head">
        <div>
          <div className="eyebrow">RISERS BOARD · PATTERN + NEWS + HISTORY</div>
          <h2>Names that could rise today and next week</h2>
        </div>
        <div className="head-actions">
          <div className="hot-scope" role="group" aria-label="Risers board scope">
            {BOARD_SCOPES.map((option) => (
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
              {BOARD_DEPTHS.map((value) => (
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
        Chance to rise blends the 1-month pattern and its analog replay (50%), Yahoo headline sentiment
        (25%), the engine quality score (15%) and 3-month relative strength vs SPY (10%). A name with no headlines is
        scored on the remaining evidence, never treated as bearish.
      </p>

      {data && (
        <div className="day-board-summary">
          <div className="day-board-count buy">
            <span>Could rise today</span>
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
          <strong>Could not build the risers board.</strong> {error}
        </div>
      )}

      {loading && (
        <div className="analyzer-loading">
          <div className="loading-orbit" />
          <h2>Scoring the list with pattern, news and relative strength…</h2>
          <p className="muted">1-month pattern scores, headline sentiment and the engine quality score per name.</p>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="table-wrap">
          <table className="signal-table forecast-board">
            <thead>
              <tr>
                <th>#</th>
                <th>Ticker</th>
                <th title="Blended chance of a rise over the next trading session">Today</th>
                <th title="Blended chance of a rise over the next five sessions">1 week</th>
                <th title="1-month composite pattern score">Pattern</th>
                <th title="Yahoo headline sentiment and count">News</th>
                <th title="3-month relative strength vs SPY">RS</th>
                <th title="Pattern-expected move next week">Expected</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.symbol}
                  className="clickable"
                  onClick={() => go(`/forecast/${row.symbol}`)}
                  title={`Open the ${row.symbol} forecast`}
                >
                  <td className="rank-cell">{row.rank}</td>
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
                  <td className="mono">{pct(row.week.expectedPct)}</td>
                  <td className="day-board-open">→</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && data && rows.length === 0 && (
        <div className="empty-note">No names could be scored. Add tickers to your focus list or try the curated board.</div>
      )}

      {data?.errors?.length > 0 && (
        <div className="alert alert-info tiny">Some names could not be read: {data.errors.join(' · ')}</div>
      )}
    </section>
  );
}

function AskForecast({ symbol, suggestions = [] }) {
  const [question, setQuestion] = useState('');
  const [thread, setThread] = useState([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setThread([]);
    setQuestion('');
    setError('');
  }, [symbol]);

  const ask = async (text) => {
    const value = String(text ?? question).trim();
    if (value.length < 3 || asking) return;
    const prior = thread;
    setThread([...prior, { role: 'user', content: value }]);
    setQuestion('');
    setAsking(true);
    setError('');
    try {
      const payload = await api.forecastAsk(symbol, {
        question: value,
        history: prior.slice(-6).map(({ role, content }) => ({ role, content })),
      });
      setThread([
        ...prior,
        { role: 'user', content: value },
        {
          role: 'assistant',
          content: payload.answer,
          source: payload.source,
          meta: payload.decisionMeta,
          note: payload.decisionError,
        },
      ]);
    } catch (err) {
      setThread(prior);
      setQuestion(value);
      setError(err.message);
    } finally {
      setAsking(false);
    }
  };

  return (
    <section className="panel forecast-qa">
      <div className="panel-head">
        <div>
          <div className="eyebrow">ASK THIS FORECAST</div>
          <h2>Questions about the last month</h2>
        </div>
        <span className="chip">grounded in this page's numbers</span>
      </div>
      <p className="muted small">
        The model only sees this page's data — the deep 1-month chart pattern, both calls, the full headline set, the
        earnings report, the tagged deals and the geopolitical backdrop behind them. It cannot see options, valuation
        multiples or your portfolio.
      </p>

      {suggestions.length > 0 && (
        <div className="qa-suggestions">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="qa-chip"
              onClick={() => ask(suggestion)}
              disabled={asking}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {thread.length > 0 && (
        <div className="qa-thread">
          {thread.map((turn, index) => (
            <div key={`${turn.role}-${index}`} className={`qa-turn ${turn.role}`}>
              <div className="qa-bubble">{turn.content}</div>
              {turn.role === 'assistant' && (
                <div className="qa-meta">
                  {turn.source === 'ai' ? (
                    <span className="chip ai">
                      ✦ {turn.meta?.model || 'LLM'}
                      {turn.meta?.latencyMs ? ` · ${(turn.meta.latencyMs / 1000).toFixed(1)}s` : ''}
                    </span>
                  ) : (
                    <span className="chip">⚙ grounded engine answer</span>
                  )}
                  {turn.note && <span className="qa-note">{turn.note}</span>}
                </div>
              )}
            </div>
          ))}
          {asking && (
            <div className="qa-turn assistant">
              <div className="qa-bubble muted">Reading the forecast numbers…</div>
            </div>
          )}
        </div>
      )}

      {error && <div className="alert alert-error tiny">{error}</div>}

      <form
        className="qa-composer"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="e.g. Why is the week more bearish than the day?"
          maxLength={600}
          disabled={asking}
          aria-label="Ask a question about this forecast"
        />
        <button type="submit" className="btn btn-primary" disabled={asking || question.trim().length < 3}>
          {asking ? 'Asking…' : 'Ask'}
        </button>
        {thread.length > 0 && (
          <button type="button" className="btn btn-ghost" onClick={() => setThread([])} disabled={asking}>
            Clear
          </button>
        )}
      </form>
    </section>
  );
}

function DeepEvidence({ data }) {
  const pattern = data.chartPattern;
  const earnings = data.earnings;
  const geo = data.geopolitics;
  const deals = data.news?.deals || [];
  if (!pattern && !earnings && !geo && !deals.length) return null;

  return (
    <section className="fc-deep">
      {pattern && (
        <article className="panel fc-deep-card">
          <div className="eyebrow">DEEP CHART PATTERN</div>
          <h3>{pattern.label}</h3>
          <p className="muted small">{pattern.summary}</p>
          <div className="fc-kv">
            <div>
              <span>Structure</span>
              <b>{pattern.structure?.label || '—'}</b>
            </div>
            <div>
              <span>Trend slope</span>
              <b>{pct(pattern.trend?.slopePct)}/session</b>
            </div>
            <div>
              <span>Range position</span>
              <b>{pattern.range?.positionPct ?? '—'}%</b>
            </div>
            <div>
              <span>Support</span>
              <b>{pattern.levels?.support ? money(pattern.levels.support) : '—'}</b>
            </div>
            <div>
              <span>Resistance</span>
              <b>{pattern.levels?.resistance ? money(pattern.levels.resistance) : '—'}</b>
            </div>
            <div>
              <span>RSI(14)</span>
              <b>
                {pattern.momentum?.rsi14 ?? '—'} ({pattern.momentum?.rsiTrend || '—'})
              </b>
            </div>
            <div>
              <span>Volatility</span>
              <b>
                {pattern.volatility?.regime || '—'} · ATR {pct(pattern.volatility?.atrPct, 2, false)}
              </b>
            </div>
          </div>
          {pattern.drivers?.length > 0 && (
            <ul className="fc-drivers">
              {pattern.drivers.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </article>
      )}

      {earnings && (
        <article className="panel fc-deep-card">
          <div className="eyebrow">EARNINGS REPORT</div>
          <h3>{earnings.label || 'Earnings backdrop'}</h3>
          <p className="muted small">
            {earnings.reportedQuarters
              ? `Last ${earnings.reportedQuarters} quarters: ${earnings.beats} beat · ${earnings.misses} missed${
                  Number.isFinite(earnings.avgSurprisePct) ? ` · average surprise ${pct(earnings.avgSurprisePct, 1)}` : ''
                }.`
              : 'No reported quarters in the feed.'}
          </p>
          <div className="fc-kv">
            <div>
              <span>Next report</span>
              <b>{earnings.nextDate ? shortDate(earnings.nextDate) : '—'}</b>
            </div>
            <div>
              <span>Revenue growth</span>
              <b>{Number.isFinite(earnings.revenueGrowthPct) ? pct(earnings.revenueGrowthPct, 1) : '—'}</b>
            </div>
            <div>
              <span>EPS growth</span>
              <b>{Number.isFinite(earnings.earningsGrowthPct) ? pct(earnings.earningsGrowthPct, 1) : '—'}</b>
            </div>
            <div>
              <span>Beat streak</span>
              <b>{earnings.beatStreak ?? '—'}</b>
            </div>
            <div>
              <span>Report risk</span>
              <b>{earnings.nextReportRisk || '—'}</b>
            </div>
          </div>
          {earnings.quarters?.length ? (
            <ul className="fc-drivers">
              {earnings.quarters.slice(0, 4).map((quarter) => (
                <li key={quarter.quarter || `${quarter.epsActual}-${quarter.epsEstimate}`}>
                  {quarter.quarter || 'quarter'}: EPS {quarter.epsActual ?? '—'} vs {quarter.epsEstimate ?? '—'} (
                  {pct(quarter.surprisePercent, 1)})
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      )}

      {deals.length > 0 && (
        <article className="panel fc-deep-card">
          <div className="eyebrow">BUSINESS DEAL FLOW</div>
          <h3>
            {deals.length} deal{deals.length === 1 ? '' : 's'} in the news set
          </h3>
          <ul className="fc-drivers">
            {deals.slice(0, 5).map((deal) => (
              <li key={deal.title}>
                <span
                  className={`chip ${deal.direction === 'bullish' ? 'long' : deal.direction === 'bearish' ? 'short' : ''}`}
                >
                  {deal.direction || 'neutral'}
                </span>{' '}
                {deal.title}
              </li>
            ))}
          </ul>
        </article>
      )}

      {geo && (
        <article className="panel fc-deep-card">
          <div className="eyebrow">GEOPOLITICS &amp; MACRO</div>
          <h3>
            {geo.label} · {geo.riskTone || 'neutral'}
          </h3>
          <p className="muted small">{geo.summary}</p>
          {geo.themes?.length > 0 && (
            <div className="fc-kv">
              {geo.themes.slice(0, 5).map((theme) => (
                <div key={theme.key}>
                  <span>{theme.label}</span>
                  <b>
                    {theme.direction} · {theme.headlines}
                  </b>
                </div>
              ))}
            </div>
          )}
          <div className="fc-kv">
            <div>
              <span>VIX</span>
              <b>{geo.market?.vix?.price ?? '—'}</b>
            </div>
            <div>
              <span>S&amp;P 500</span>
              <b>{geo.market?.spy?.price != null ? pct(geo.market.spy.changePercent) : '—'}</b>
            </div>
            <div>
              <span>Oil</span>
              <b>{geo.market?.oil?.price != null ? pct(geo.market.oil.changePercent) : '—'}</b>
            </div>
            <div>
              <span>Dollar index</span>
              <b>{geo.market?.dollar?.price != null ? pct(geo.market.dollar.changePercent) : '—'}</b>
            </div>
          </div>
        </article>
      )}
    </section>
  );
}

export default function ForecastPage({ symbol, go }) {
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
        setData(await api.forecast(symbol, { refresh }));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [symbol],
  );

  useEffect(() => {
    setData(null);
    load(false);
  }, [load]);

  if (loading) {
    return (
      <div className="page forecast-page">
        <div className="analyzer-loading">
          <div className="loading-orbit" />
          <h2>Reading the chart, news, earnings and macro backdrop for {symbol}…</h2>
          <p className="muted">Scoring trend, RSI, MACD, volume and range, then calling the next session and next week.</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="page forecast-page">
        <section className="page-head">
          <div>
            <div className="eyebrow">FORECAST LAB</div>
            <h1>Next session and next week</h1>
            <p className="page-sub">
              Pick a stock or ETF: the forecast desk reads its last month of daily candles, the full news set and the
              earnings report, then calls the next session and the next week with a probability, expected move and
              typical range.
            </p>
          </div>
        </section>
        <div className="analyzer-search-panel panel">
          <SearchBox
            onSelect={(next) => go(`/forecast/${next}`)}
            autoFocus
            placeholder={`Search a ticker (currently ${symbol})…`}
          />
        </div>
        {error && (
          <div className="alert alert-error">
            <strong>Could not build the forecast.</strong> {error}
          </div>
        )}
      </div>
    );
  }

  const { horizons, technicals, window: view, score } = data;
  const scoreTone = score.value > 0 ? 'up' : score.value < 0 ? 'down' : 'flat';

  return (
    <div className="page forecast-page">
      <section className="page-head">
        <div>
          <div className="eyebrow">FORECAST LAB · 1 MONTH · {view.sessions} SESSIONS</div>
          <h1>
            {data.symbol} <span className="muted">next move</span>
          </h1>
          <p className="page-sub">
            {data.name} · {money(data.price)}{' '}
            <span className={`mono ${data.changePercent > 0 ? 'up' : data.changePercent < 0 ? 'down' : 'flat'}`}>
              {pct(data.changePercent)}
            </span>{' '}
            · window {shortDate(view.from)} → {shortDate(view.to)} ({pct(view.changePct)}) · generated{' '}
            {timeAgo(data.generatedAt)}
          </p>
        </div>
        <div className="head-actions">
          <SearchBox compact onSelect={(next) => go(`/forecast/${next}`)} placeholder="Ticker…" />
          <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={refreshing}>
            <span className={refreshing ? 'spin' : ''}>↻</span> Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={() => go(`/analyze/${data.symbol}`)}>
            Full analysis
          </button>
        </div>
      </section>

      <ForecastCall data={data} />

      <div className="forecast-cards">
        <HorizonCard horizon={horizons.day} />
        <HorizonCard horizon={horizons.week} />
      </div>

      <div className="forecast-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">WHAT THE MODEL LEARNED</div>
              <h2>The last month · {view.sessions} sessions</h2>
            </div>
            <span className="chip">
              {view.high !== null && view.low !== null
                ? `${money(view.low)} – ${money(view.high)}`
                : 'window range'}
            </span>
          </div>
          <CandleChart
            bars={data.series}
            overlays={{ sma20: data.series.map((bar) => bar.sma20) }}
            rsi={data.series.map((bar) => bar.rsi14)}
            showSma
            showRsi
          />
          <p className="fc-note">
            Daily candles with the 20-session mean and RSI(14). The projections are probabilities, not levels drawn on
            the chart.
          </p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">MODEL EVIDENCE</div>
              <h2>Setup score</h2>
            </div>
            <span className={`fc-score mono ${scoreTone}`}>
              {score.value > 0 ? '+' : ''}
              {score.value}
            </span>
          </div>
          <p className="muted small">
            {score.label} · {data.analog.note}
          </p>

          <div className="stat-grid">
            <Stat label="RSI(14)" value={technicals.rsi14 ?? '—'} />
            <Stat label="ATR %" value={pct(technicals.atrPct, 2, false)} />
            <Stat label="Daily volatility" value={pct(technicals.volatilityPct, 2, false)} />
            <Stat label="10d slope" value={`${pct(technicals.slopePct, 2)}/session`} />
            <Stat label="20-day mean" value={money(technicals.sma20)} />
            <Stat label="Range position" value={`${technicals.rangePosition ?? '—'}%`} />
            <Stat label="Up-volume bias" value={`${technicals.volumeBias ?? '—'}%`} />
            <Stat label="Close streak" value={technicals.streak ?? '—'} />
          </div>

          <div className="fc-analog">
            <AnalogRow title="Next session analog" analog={horizons.day.analog} />
            <AnalogRow title="Next week analog" analog={horizons.week.analog} />
          </div>

          <p className="fc-note">
            {data.source === 'ai'
              ? 'The desk makes the call; this analog replay is kept as a cross-check. Comparable days inside the window are replayed with their real forward returns and never more than 35% of the mechanical reference.'
              : 'Comparable days inside the window are replayed with their real forward returns, then blended into the model probability (never more than 35%). The baseline is every usable session in the window.'}
          </p>
        </section>
      </div>

      <DeepEvidence data={data} />

      <RisersBoard go={go} />

      <AskForecast symbol={data.symbol} suggestions={data.suggestions || []} />

      <div className="alert alert-info">{data.disclaimer}</div>
    </div>
  );
}
