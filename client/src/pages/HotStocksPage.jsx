import { useCallback, useEffect, useRef, useState } from 'react';
import Sparkline from '../components/Sparkline.jsx';
import Stat from '../components/Stat.jsx';
import { api } from '../lib/api.js';
import { money, pct, scoreTone, shortDate, timeAgo, toneForChange } from '../lib/format.js';
import { CHANCE_FILTERS, chanceOfHotRow, growthBand } from '../lib/growth.js';

const ACTION_CLASS = { buy: 'action-buy', accumulate: 'action-accumulate' };

/** The full risk ladder, for the ETF desk's model call pill. */
const SIGNAL_CLASS = {
  buy: 'action-buy',
  accumulate: 'action-accumulate',
  hold: 'action-hold',
  reduce: 'action-reduce',
  sell: 'action-sell',
};

/**
 * One ETF on the desk: the model's call, the levels it is measured against, and
 * the evidence the call had to work from — market data, news and deal flow,
 * Street activity, event risk and the archive.
 */
export function EtfCard({ row, go, onFavorite, saved = false, saving = false }) {
  const decision = row.decision || {};
  const triggers = decision.triggers || {};
  const levels = decision.keyLevels || {};
  const news = row.news || null;
  const analyst = row.analyst || null;
  const event = row.event || null;
  const archive = row.archive || null;

  return (
    <article className={`etf-card ${SIGNAL_CLASS[decision.action] || 'action-hold'}`}>
      <header className="etf-head">
        <div className="signal-identity">
          <button type="button" className="signal-symbol mono" onClick={() => go(`/analyze/${row.symbol}`)}>
            {row.symbol}
          </button>
          <span className="signal-theme">{row.name}</span>
          <span className="badge badge-type etf">ETF</span>
          {Number.isFinite(row.growthProbability) && (
            <span
              className={`growth-chip ${row.growthBand || ''}`}
              title="Blended chance to rise: primary-target probability, conviction, quality, trend and archive follow-through."
            >
              ↑ {row.growthProbability}% chance
            </span>
          )}
        </div>
        <div className="signal-price">
          <span className="mono">{money(row.price)}</span>
          <span className={`mono ${toneForChange(row.changePercent)}`}>{pct(row.changePercent)}</span>
        </div>
      </header>

      <div className="etf-call">
        <span className={`action-pill ${SIGNAL_CLASS[decision.action] || 'action-hold'}`}>{decision.actionLabel || 'Hold'}</span>
        {row.llm ? (
          <span className="chip ai" title={`Call made by ${row.decisionMeta?.model || 'the model'}`}>
            ✦ {row.decisionMeta?.model || 'LLM'}
          </span>
        ) : (
          <span className="chip" title="No model call for this fund yet">
            ⚙ engine
          </span>
        )}
        <span className="muted small">{decision.conviction ?? 0}% conviction</span>
      </div>

      {decision.thesis && <p className="etf-thesis">{decision.thesis}</p>}

      <div className="etf-levels">
        <Stat label="Entry" value={money(levels.entry)} />
        <Stat label="Target" value={money(levels.target)} tone="up" />
        <Stat label="Stop" value={money(levels.stop)} tone="down" />
      </div>

      {(triggers.buyAbove || triggers.sellBelow) && (
        <div className="etf-triggers">
          <span>
            Buy above <b className="mono">{money(triggers.buyAbove)}</b>
          </span>
          <span>
            Exit below <b className="mono down">{money(triggers.sellBelow)}</b>
          </span>
        </div>
      )}

      <div className="etf-evidence">
        <span className="chip" title="Technical score and regime">
          📊 {row.technical?.score ?? '—'}/100 · {row.technical?.signalLabel || 'no signal'}
        </span>
        <span className="chip" title="News flow and business/macro deals the model read">
          📰 {news ? `${news.sentiment > 0 ? '+' : ''}${news.sentiment} ${news.label}` : 'no news'} · {news?.dealCount ?? 0} deal
          {(news?.dealCount ?? 0) === 1 ? '' : 's'}
        </span>
        <span className="chip" title="Street activity">
          🏦 {analyst ? `${analyst.tilt > 0 ? '+' : ''}${analyst.tilt}` : '—'}
        </span>
        <span className="chip" title="Event risk in the horizon">
          📅 {event?.hasEarnings ? `earnings ${event.daysUntil}d` : event?.date ? shortDate(event.date) : 'no event'}
        </span>
        {archive && (
          <span className="chip" title={`Daily archive: ${archive.coverageDays} sessions, previous calls followed through ${archive.hitRate ?? '—'}%`}>
            🗄 {archive.coverageDays}d · {archive.hitRate ?? '—'}%
          </span>
        )}
      </div>

      <footer className="etf-foot">
        <button type="button" className="btn btn-mini" onClick={() => go(`/analyze/${row.symbol}`)}>
          Analyze
        </button>
        <button type="button" className="btn btn-mini" onClick={() => go(`/options/${row.symbol}`)}>
          Options
        </button>
        <button
          type="button"
          className={`btn btn-mini fav-btn ${saved ? 'saved' : ''}`}
          onClick={() => onFavorite?.(row.symbol)}
          disabled={saved || saving}
          title={saved ? `${row.symbol} is already on your focus list` : `Add ${row.symbol} to your focus list`}
        >
          {saved ? '★' : saving ? '…' : '☆'}
        </button>
      </footer>

      {row.decisionError && <div className="alert alert-info tiny">{row.decisionError}</div>}
    </article>
  );
}

export function HotCard({ stock, go, ai = null, outlook = null, onFavorite, saved = false, saving = false }) {
  const target = stock.primaryTarget;
  const aiDecision = ai?.decision || null;
  const aiLive = Boolean(ai?.decisionMeta && ai.decisionMeta.provider !== 'rule-engine');
  // The model owns the call once a desk pass has produced one; the mechanical
  // verdict stays visible in the AI row as the cross-check.
  const modelCall = aiLive && aiDecision ? aiDecision : null;
  const call = modelCall || { action: stock.action, actionLabel: stock.actionLabel };
  const callIsLong = ['buy', 'accumulate'].includes(call.action);
  const isWatch = Boolean(stock.watch) && !modelCall;
  const belowZone = stock.price < stock.buyZone.low;
  const aboveZone = stock.price > stock.buyZone.high;
  const entryHint = isWatch
    ? belowZone
      ? `needs a reclaim of ${money(stock.buyZone.low)} first`
      : aboveZone
        ? `watch for a pullback to ${money(stock.buyZone.high)}`
        : 'price is in the band — waiting for a trigger'
    : stock.buyNow
      ? aboveZone
        ? 'just above the band — still usable'
        : 'price is in the band now'
      : belowZone
        ? `below the band — reclaim ${money(stock.waitFor)} first`
        : `wait for ${money(stock.waitFor)}`;
  const isEtf = stock.quoteType === 'ETF';

  return (
    <article className={`hot-card ${ACTION_CLASS[call.action] || ''} ${callIsLong ? 'is-now' : 'is-wait'}`}>
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
        <span className={`hot-badge ${callIsLong ? 'now' : isWatch ? 'watch' : 'wait'}`}>
          {modelCall ? call.actionLabel.toUpperCase() : isWatch ? 'WATCH' : stock.buyNow ? 'BUY NOW' : 'WAIT'}
        </span>
        <span className="setup-chip" title={modelCall ? 'Rule-engine setup context' : undefined}>
          {modelCall ? `⚙ ${stock.setupLabel || stock.actionLabel}` : stock.setupLabel || stock.actionLabel}
        </span>
        <span
          className={`score-chip ${scoreTone(stock.hotScore)}`}
          title="Hot score starts with 60% quality + 25% conviction, then adds up to 15 points when the price is near the buy band"
        >
          {stock.hotScore} hot
        </span>
        {Number.isFinite(stock.growthProbability) && (
          <span
            className={`growth-chip ${stock.growthBand || ''}`}
            title="Blended chance to rise: primary-target probability, conviction, quality, trend and archive follow-through."
          >
            ↑ {stock.growthProbability}% chance
          </span>
        )}
        {outlook && (
          <span
            className={`ai-outlook-chip ${outlook.direction}`}
            title={`${outlook.source === 'llm' ? 'LLM' : 'Engine'} outlook: ${outlook.reason || outlook.direction}`}
          >
            {outlook.direction === 'up' ? '▲' : outlook.direction === 'down' ? '▼' : '■'} AI {outlook.confidence}%
          </span>
        )}
      </div>

      {stock.why && <p className="hot-why">{stock.why}</p>}

      <div className="hot-levels">
        <div className="hot-level buy">
          <span className="hot-level-label">Buy zone</span>
          <strong className="mono">
            {money(stock.buyZone.low, 0)}–{money(stock.buyZone.high, 0)}
          </strong>
          <span className="muted small">{entryHint}</span>
        </div>
        <div className="hot-level sell">
          <span className="hot-level-label">Take profit</span>
          {target ? (
            <>
              <strong className="mono">
                {money(target.price, 0)}
                {target.upsidePct !== null && target.upsidePct !== undefined && (
                  <span className="hot-upside"> +{target.upsidePct}%</span>
                )}
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
          <span className="hot-level-label">Profit targets</span>
          <div className="hot-target-row">
            {stock.sellPlan.map((item) => (
              <span key={item.label || item.price} className="hot-target">
                <span className="target-badge">{item.label || '—'}</span>
                <span className="mono">{money(item.price, 0)}</span>
                {item.upsidePct !== null && item.upsidePct !== undefined && (
                  <span className="mono up">+{item.upsidePct}%</span>
                )}
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
        <span
          title={`Measured from the ${money(stock.entryRef)} reference entry (middle of the buy band) to the main target (T2)`}
        >
          R:R <b className="mono">{stock.riskReward ?? '—'}:1</b>
          {stock.entryRef ? <span className="muted small"> to T2 from {money(stock.entryRef, 0)}</span> : null}
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
              <span title={aiDecision.triggers.buyHint || ''}>
                {aiDecision.triggers.side !== 'short' && ['reduce', 'sell'].includes(aiDecision.action)
                  ? 'Reclaim above'
                  : aiDecision.triggers.buyLabel || 'Buy above'}{' '}
                <b className="mono">{money(aiDecision.triggers.buyAbove)}</b>
              </span>
              <span title={aiDecision.triggers.sellHint || ''}>
                {aiDecision.triggers.sellLabel || 'Exit below'}{' '}
                <b className="mono down">{money(aiDecision.triggers.sellBelow)}</b>
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
          <button
            type="button"
            className={`btn btn-mini fav-btn ${saved ? 'saved' : ''}`}
            onClick={() => onFavorite?.(stock.symbol)}
            disabled={saved || saving}
            title={saved ? `${stock.symbol} is already on your focus list` : `Add ${stock.symbol} to your focus list`}
          >
            {saved ? '★ Favorite' : saving ? 'Adding…' : '☆ Add favorite'}
          </button>
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

export function OutlookRow({ pick, go, onFavorite, saved = false, saving = false }) {
  const up = pick.direction === 'up';
  const move = Number(pick.expectedMovePct);
  return (
    <div className={`outlook-row ${pick.direction}`}>
      <div className="outlook-identity">
        <button type="button" className="signal-symbol mono" onClick={() => go(`/analyze/${pick.symbol}`)}>
          {pick.symbol}
        </button>
        <span className="outlook-name">{pick.name}</span>
        <span className={`chip ${pick.source === 'llm' ? 'ai' : ''}`}>
          {pick.source === 'llm' ? '✦ LLM' : '⚙ engine'}
        </span>
      </div>
      <div className="outlook-call">
        <span className={`hot-badge ${up ? 'now' : pick.direction}`}>
          {up ? 'WILL RISE' : pick.direction === 'down' ? 'EXPECTED DOWN' : 'FLAT'}
        </span>
        <span className="mono small">{pick.confidence}% confidence</span>
        {Number.isFinite(move) && (
          <span className={`mono ${move >= 0 ? 'up' : 'down'}`}>
            {move >= 0 ? '+' : ''}
            {move}%
          </span>
        )}
        <span className="muted small">{pick.horizon}</span>
      </div>
      {pick.reason && <p className="outlook-reason">{pick.reason}</p>}
      <div className="outlook-actions">
        <button type="button" className="btn btn-mini" onClick={() => go(`/analyze/${pick.symbol}`)}>
          Analyze
        </button>
        <button
          type="button"
          className={`btn btn-mini fav-btn ${saved ? 'saved' : ''}`}
          onClick={() => onFavorite?.(pick.symbol)}
          disabled={saved || saving}
          title={saved ? `${pick.symbol} is already on your focus list` : `Add ${pick.symbol} to your focus list`}
        >
          {saved ? '★' : saving ? '…' : '☆'}
        </button>
      </div>
    </div>
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

export default function HotStocksPage({ go, health }) {
  const [data, setData] = useState(null);
  const [scope, setScope] = useState('market');
  const [depth, setDepth] = useState(100);
  const [tapeRows, setTapeRows] = useState(TAPE_PAGE);
  // Rank by the blended chance to rise by default, and let the user demand a
  // minimum chance instead of reading a wall of cards.
  const [sortBy, setSortBy] = useState('chance');
  const [minChance, setMinChance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  // LLM desk verdicts, keyed by symbol, added on demand (one model call per name).
  const [aiDecisions, setAiDecisions] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  // Symbols already on the focus list (the app's favorites), so a card can
  // offer a one-click add without waiting for the hot scan to include it.
  const [favorites, setFavorites] = useState(() => new Set());
  const [favoriteBusy, setFavoriteBusy] = useState('');
  const [favoriteNote, setFavoriteNote] = useState('');
  // Model verdicts for every analysed name: which ones it expects to rise.
  const [outlook, setOutlook] = useState(null);
  const [outlookLoading, setOutlookLoading] = useState(false);
  const [outlookError, setOutlookError] = useState('');
  const outlookRequested = useRef(false);
  // ETF desk: the curated funds + the user's own ETFs, ranked by chance to rise
  // and called by the model from market data, news/deals and every indicator.
  const [etfDesk, setEtfDesk] = useState(null);
  const [etfLoading, setEtfLoading] = useState(false);
  const [etfError, setEtfError] = useState('');
  const etfReadRequested = useRef(false);
  const etfAiRequested = useRef(false);

  const runEtfDesk = useCallback(async ({ ai = false, refresh = false } = {}) => {
    setEtfLoading(true);
    setEtfError('');
    try {
      setEtfDesk(await api.etfDesk({ ai, refresh }));
    } catch (err) {
      setEtfError(err.message);
    } finally {
      setEtfLoading(false);
    }
  }, []);

  // Cheap read first (curated ETFs + any desk call already cached), then one
  // model pass as soon as the health payload says an LLM is reachable.
  useEffect(() => {
    if (etfReadRequested.current) return;
    etfReadRequested.current = true;
    runEtfDesk({});
  }, [runEtfDesk]);

  useEffect(() => {
    if (etfAiRequested.current || !health?.agent?.live) return;
    etfAiRequested.current = true;
    runEtfDesk({ ai: true });
  }, [health?.agent?.live, runEtfDesk]);

  const runOutlook = useCallback(
    async (refresh = false) => {
      setOutlookLoading(true);
      setOutlookError('');
      try {
        setOutlook(await api.hotStocksAi({ scope, depth, refresh }));
      } catch (err) {
        setOutlookError(err.message);
      } finally {
        setOutlookLoading(false);
      }
    },
    [scope, depth],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .watchlist()
      .then((payload) => {
        if (!cancelled) setFavorites(new Set((payload?.items || []).map((item) => item.symbol)));
      })
      .catch(() => {
        /* the save button still works; it just cannot show the filled star */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addFavorite = async (symbol) => {
    if (!symbol || favorites.has(symbol)) return;
    setFavoriteBusy(symbol);
    setFavoriteNote('');
    try {
      await api.addWatchlist(symbol);
      setFavorites((current) => new Set([...current, symbol]));
      setFavoriteNote(`${symbol} added to your focus list — open Focus list to see it.`);
    } catch (err) {
      setFavoriteNote(`Could not add ${symbol}: ${err.message}`);
    } finally {
      setFavoriteBusy('');
    }
  };

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError('');
      setAiDecisions(null);
      setAiError('');
      // A new board re-arms one automatic outlook pass (the effect below), so a
      // scope/depth change or a scan refresh re-asks the model exactly once.
      outlookRequested.current = false;
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

  // Ask the model which of the freshly analysed names should rise. The server
  // caches the pass for 30 minutes, so a scope change usually reuses it.
  useEffect(() => {
    if (!data || outlookRequested.current) return;
    outlookRequested.current = true;
    runOutlook(false);
  }, [data, runOutlook]);

  // Ensure every analysed row has a chance to rise before filtering/sorting,
  // even if a cached payload predates the field.
  const stocks = (data?.stocks || []).map((stock) => {
    if (Number.isFinite(stock.growthProbability)) return stock;
    const probability = chanceOfHotRow(stock);
    return { ...stock, growthProbability: probability, growthBand: growthBand(probability) };
  });
  const tape = data?.tape || [];
  const chanceOk = (stock) => minChance === 0 || (stock.growthProbability ?? 0) >= minChance;
  const sorter =
    sortBy === 'hot'
      ? (a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0)
      : (a, b) => (b.growthProbability ?? -1) - (a.growthProbability ?? -1) || (b.hotScore ?? 0) - (a.hotScore ?? 0);
  const buyNow = stocks
    .filter((stock) => (stock.bucket === 'buy-now' || (!stock.bucket && stock.buyNow)) && chanceOk(stock))
    .sort(sorter);
  const waiting = stocks
    .filter((stock) => (stock.bucket === 'waiting' || (!stock.bucket && !stock.buyNow)) && chanceOk(stock))
    .sort(sorter);
  const watch = stocks.filter((stock) => (stock.watch || stock.bucket === 'watch') && chanceOk(stock)).sort(sorter);
  const hiddenByChance = stocks.length - buyNow.length - waiting.length - watch.length;
  const top = buyNow[0] || waiting[0] || watch[0] || stocks[0] || null;
  const outlookBySymbol = new Map((outlook?.picks || []).map((pick) => [pick.symbol, pick]));
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
            Every good name with a chance to go up — buy signals ready now, quality uptrends waiting for a pullback, and
            constructive holds that need a trigger before they earn a buy. The hottest {data?.depth ?? depth} get a full plan:
            a price range to buy in, three prices to take profit at, and a stop. Every other name still shows its live quote on
            the market tape below, and each card has a ☆ button to add the name to your focus list.
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
          <label className="hot-depth">
            <span>Min chance</span>
            <select value={minChance} onChange={(event) => setMinChance(Number(event.target.value))}>
              {CHANCE_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="hot-depth">
            <span>Sort</span>
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
              <option value="chance">Best chance to rise</option>
              <option value="hot">Hot score</option>
            </select>
          </label>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={runAiDesk}
            disabled={aiLoading || loading || !aiUniverse.length}
            title={`Run the deep LLM desk call on the top ${aiUniverse.length} names (one model call each, cached 30 minutes)`}
          >
            <span className={aiLoading ? 'spin' : ''}>✦</span> {aiLoading ? 'AI desk running…' : 'Deep AI desk (top 20)'}
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
            value={data?.signals ?? data?.scanned ?? '—'}
            hint="Names with a scored plan: buy zone, T1/T2/T3 sell prices and a stop"
          />
          <Stat
            label="On the market tape"
            value={data?.universeSize ?? '—'}
            hint="Every name the Yahoo screens returned for this scan"
          />
          <Stat
            label="Waiting for price"
            value={data?.waitingCount ?? '—'}
            hint="Long setups whose price is outside the buy band — above it, or below it after a breakdown"
          />
          <Stat
            label="Watch — no trigger"
            value={data?.watchCount ?? watch.length}
            hint="Good quality names in an uptrend that are not a buy yet: the chart is constructive, but the entry signal has not fired"
          />
          <Stat
            label="AI says rising"
            value={outlook ? outlook.risingCount : outlookLoading ? '…' : '—'}
            hint={
              outlook?.live
                ? `${outlook.model} read all ${outlook.analysed} analysed names and expects these to rise`
                : outlook
                  ? 'No LLM key configured — this is the deterministic engine ranking'
                  : 'Asking the model for a read on every analysed name'
            }
          />
        </div>
        <p className="hot-method">
          The hot score starts with 60% quality + 25% conviction, then adds up to 15 points when an actionable long setup is
          inside or just above the buy band. <strong>Buy now</strong> means an engine buy/accumulate call with the price inside
          that band (or within 0.5% above its top). Actionable names outside the band are listed with the price to wait for.
          <strong> Watch</strong> is the rest of the good pile: quality in the bullish half, price above the 50-day, and a real
          long plan — but no entry trigger yet. Those names stay visible instead of disappearing from the board.
          <strong> All market</strong> pulls the live Yahoo screens
          ({data?.screens?.map((screen) => screen.id.replace(/_/g, ' ')).join(', ') || 'most actives, gainers, growth, value'})
          — {data?.universeSize ?? 0} names — and gives the hottest {data?.depth ?? depth} a full plan; the rest stay on the
          market tape with their live quote. <strong>Curated board</strong> scans the ~40-name liquid list,{' '}
          <strong>My list</strong> only your focus list. <strong>Run AI desk (top 20)</strong> asks the configured model for a full
          per-name call on the top names; the <strong>AI outlook</strong> below asks it about every analysed name at once and lists
          the ones it expects to rise.
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
      {favoriteNote && (
        <div className={`alert ${favoriteNote.startsWith('Could not') ? 'alert-error' : 'alert-success'} tiny`}>
          {favoriteNote}{' '}
          {!favoriteNote.startsWith('Could not') && (
            <button type="button" className="link-btn" onClick={() => go('/')}>
              Open focus list
            </button>
          )}
        </div>
      )}

      {hiddenByChance > 0 && (
        <div className="alert alert-info tiny">
          {hiddenByChance} analysed name{hiddenByChance === 1 ? '' : 's'} hidden by the Min chance filter.{' '}
          <button type="button" className="link-btn" onClick={() => setMinChance(0)}>
            Show any chance
          </button>
        </div>
      )}

      {(outlook || outlookLoading || outlookError) && (
        <section className="panel hot-panel hot-outlook-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">AI OUTLOOK · LIKELY TO RISE</div>
              <h2>
                {outlook
                  ? `${outlook.risingCount} name${outlook.risingCount === 1 ? '' : 's'} the model expects to rise`
                  : 'Reading every analysed name…'}
              </h2>
            </div>
            <div className="outlook-meta">
              {outlook?.live ? (
                <span className="chip ai" title="Provider and model behind these verdicts">
                  ✦ {outlook.provider} · {outlook.model}
                </span>
              ) : outlook ? (
                <span className="chip" title="No LLM key configured — deterministic engine ranking">⚙ rule engine</span>
              ) : null}
              {outlook && (
                <span className="muted small">
                  {outlook.modelRising} model · {outlook.engineRising} engine of {outlook.analysed} analysed
                  {outlook.cached ? ' · cached' : ''}
                </span>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => runOutlook(true)}
                disabled={outlookLoading || loading}
                title="Re-run the model pass on every analysed name"
              >
                <span className={outlookLoading ? 'spin' : ''}>✦</span> {outlookLoading ? 'Reading the tape…' : 'Re-run AI outlook'}
              </button>
            </div>
          </div>

          {outlook?.errors?.length > 0 && (
            <div className="alert alert-info tiny">
              Some batches fell back to the engine: {outlook.errors.join(' · ')}
            </div>
          )}
          {outlookError && <div className="alert alert-error">AI outlook failed — {outlookError}</div>}
          {outlookLoading && !outlook && (
            <div className="outlook-loading muted small">Scoring every analysed name with the model…</div>
          )}
          {outlook && !outlook.rising.length && (
            <div className="empty-note">The model sees no clear risers in this scan right now.</div>
          )}
          {outlook?.rising?.length > 0 && (
            <div className="outlook-list">
              {outlook.rising.map((pick) => (
                <OutlookRow
                  key={pick.symbol}
                  pick={pick}
                  go={go}
                  onFavorite={addFavorite}
                  saved={favorites.has(pick.symbol)}
                  saving={favoriteBusy === pick.symbol}
                />
              ))}
            </div>
          )}
          <p className="hot-method">
            The model reads the compact evidence for every fully analysed name — not just the top 20 — in batches, and returns a
            verdict per candidate. <strong>Will rise</strong> means it expects an advance over roughly the next 1–4 weeks with a
            constructive structure and a clean entry; names it calls flat or down are left off the list. Verdicts are cached for
            30 minutes; engine rows appear when a batch fails or no LLM key is configured.
          </p>
        </section>
      )}

      {loading ? (
        <div className="hot-grid">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="skeleton-card hot-card-skeleton" />
          ))}
        </div>
      ) : !stocks.length ? (
        <section className="panel hot-empty">
          <div className="hot-empty-icon">⇗</div>
          <h2>No long setups or watch names right now</h2>
          <p className="muted">
            None of the {data?.signals ?? data?.scanned ?? 0} fully analysed names has a constructive long plan today. That is a valid
            answer — raise the analysis depth above, check the market tape below for the day's movers, or analyze a different ticker.
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
                <span className="muted small">Take profits at the targets · stop below the buy zone</span>
              </div>
              <div className="hot-grid">
                {buyNow.map((stock) => (
                  <HotCard
                    key={stock.symbol}
                    stock={stock}
                    go={go}
                    ai={aiDecisions?.[stock.symbol] || null}
                    outlook={outlookBySymbol.get(stock.symbol) || null}
                    onFavorite={addFavorite}
                    saved={favorites.has(stock.symbol)}
                    saving={favoriteBusy === stock.symbol}
                  />
                ))}
              </div>
            </section>
          )}

          {waiting.length > 0 && (
            <section className="panel hot-panel">
              <div className="panel-head">
                <div>
                  <div className="eyebrow">WAITING FOR PRICE</div>
                  <h2>{waiting.length} waiting for a better price</h2>
                </div>
                <span className="muted small">Outside the buy band — wait for the price to come to you</span>
              </div>
              <div className="hot-grid">
                {waiting.map((stock) => (
                  <HotCard
                    key={stock.symbol}
                    stock={stock}
                    go={go}
                    ai={aiDecisions?.[stock.symbol] || null}
                    outlook={outlookBySymbol.get(stock.symbol) || null}
                    onFavorite={addFavorite}
                    saved={favorites.has(stock.symbol)}
                    saving={favoriteBusy === stock.symbol}
                  />
                ))}
              </div>
            </section>
          )}

          {watch.length > 0 && (
            <section className="panel hot-panel">
              <div className="panel-head">
                <div>
                  <div className="eyebrow">UPTREND · WATCH</div>
                  <h2>{watch.length} good names waiting for a trigger</h2>
                </div>
                <span className="muted small">Quality uptrends and a real long plan — but not a buy signal yet</span>
              </div>
              <div className="hot-grid">
                {watch.map((stock) => (
                  <HotCard
                    key={stock.symbol}
                    stock={stock}
                    go={go}
                    ai={aiDecisions?.[stock.symbol] || null}
                    outlook={outlookBySymbol.get(stock.symbol) || null}
                    onFavorite={addFavorite}
                    saved={favorites.has(stock.symbol)}
                    saving={favoriteBusy === stock.symbol}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {(etfDesk || etfLoading || etfError) && (
        <section className="panel hot-panel etf-desk-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">ETF DESK · BUY / HOLD / SELL</div>
              <h2>
                {etfDesk ? `${etfDesk.count} ETFs, highest chance to rise first` : 'Reading the ETF tape…'}
              </h2>
            </div>
            <div className="outlook-meta">
              {etfDesk?.llmCalls > 0 ? (
                <span className="chip ai" title="The model made these calls">
                  ✦ {etfDesk.provider} · {etfDesk.model}
                </span>
              ) : etfDesk ? (
                <span className="chip" title="No LLM key configured — the rule engine stands in">
                  ⚙ engine calls
                </span>
              ) : null}
              {etfDesk && (
                <span className="muted small">
                  {etfDesk.llmCalls}/{etfDesk.count} calls by the model
                </span>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => runEtfDesk({ ai: true, refresh: true })}
                disabled={etfLoading}
                title="Run the model over every ETF now"
              >
                <span className={etfLoading ? 'spin' : ''}>✦</span> {etfLoading ? 'Desk reviewing…' : 'Run ETF desk'}
              </button>
            </div>
          </div>

          {etfError && <div className="alert alert-error">ETF desk failed — {etfError}</div>}
          {etfLoading && !etfDesk && (
            <div className="outlook-loading muted small">
              The model is reading each fund's market data, news and deal flow, Street activity, event risk and indicators…
            </div>
          )}
          {etfDesk?.etfs?.length > 0 && (
            <div className="etf-grid">
              {etfDesk.etfs.map((row) => (
                <EtfCard
                  key={row.symbol}
                  row={row}
                  go={go}
                  onFavorite={addFavorite}
                  saved={favorites.has(row.symbol)}
                  saving={favoriteBusy === row.symbol}
                />
              ))}
            </div>
          )}
          {etfDesk && !etfDesk.etfs.length && <div className="empty-note">No ETFs to review.</div>}
          <p className="hot-method">
            Only ETFs, ranked by the blended <strong>chance to rise</strong>. The call is the model's own: it reads the fund's
            market data — trend, RSI, volatility, relative strength and the option chain — plus the news and business/macro deal
            flow that reaches it, Street activity, event risk and the archive, and fuses that with the mechanical plan. Levels come
            from the same plan engine; no model key means the engine's call stands in.
          </p>
        </section>
      )}

      {stocks.length > 0 && !buyNow.length && !waiting.length && !watch.length && (
        <section className="panel hot-empty">
          <div className="hot-empty-icon">⇗</div>
          <h2>Nothing at or above {minChance}% chance</h2>
          <p className="muted">
            Lower the <strong>Min chance</strong> filter to bring back the weaker names, or raise the analysis depth for a bigger
            pool to rank.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => setMinChance(0)}>
            Show any chance
          </button>
        </section>
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
                  <th aria-label="Focus list">☆</th>
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
                          {row.watch && <span className="hot-badge watch">WATCH</span>}
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
                    <td className="fav-cell">
                      <button
                        type="button"
                        className={`icon-btn fav-btn ${favorites.has(row.symbol) ? 'saved' : ''}`}
                        title={
                          favorites.has(row.symbol)
                            ? `${row.symbol} is on your focus list`
                            : `Add ${row.symbol} to your focus list`
                        }
                        aria-label={
                          favorites.has(row.symbol)
                            ? `${row.symbol} is a favorite`
                            : `Add ${row.symbol} to favorites`
                        }
                        disabled={favorites.has(row.symbol) || favoriteBusy === row.symbol}
                        onClick={(event) => {
                          event.stopPropagation();
                          addFavorite(row.symbol);
                        }}
                      >
                        {favorites.has(row.symbol) ? '★' : '☆'}
                      </button>
                    </td>
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
