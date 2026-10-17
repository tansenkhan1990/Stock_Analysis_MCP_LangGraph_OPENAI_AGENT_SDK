import { useCallback, useEffect, useState } from 'react';
import Markdown from '../components/Markdown.jsx';
import SearchBox from '../components/SearchBox.jsx';
import Stat from '../components/Stat.jsx';
import { api } from '../lib/api.js';
import { money, num, pct, shortDate, timeAgo, toneForChange } from '../lib/format.js';

const ACTION_CLASS = {
  buy: 'action-buy',
  accumulate: 'action-accumulate',
  hold: 'action-hold',
  reduce: 'action-reduce',
  sell: 'action-sell',
};

const DIRECTION_CLASS = { bullish: 'up', bearish: 'down', neutral: 'muted' };

function ConvictionBar({ value }) {
  return (
    <div className="conviction">
      <div className="conviction-track">
        <div className="conviction-fill" style={{ width: `${Math.min(100, value || 0)}%` }} />
      </div>
      <span className="mono small">{value}% conviction</span>
    </div>
  );
}

function CatalystList({ items = [], emptyLabel = 'No classified catalysts' }) {
  if (!items.length) return <div className="empty-note tiny">{emptyLabel}</div>;
  return (
    <ul className="catalyst-list">
      {items.map((item, index) => (
        <li key={`${item.detail || item.title}-${index}`}>
          <span className={`catalyst-type ${item.type || 'news'}`}>{item.type || 'news'}</span>
          <span className={`catalyst-arrow ${DIRECTION_CLASS[item.direction] || 'muted'}`}>
            {item.direction === 'bearish' ? '▼' : item.direction === 'bullish' ? '▲' : '■'}
          </span>
          <span className="catalyst-text">
            {item.detail || item.title}
            {item.link && (
              <a href={item.link} target="_blank" rel="noreferrer" className="catalyst-link">
                source
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DecisionPanel({ research, onClose, onOpenAnalyzer, onOpenOptions }) {
  const { decision, combined, news, analyst, event, decisionMeta, decisionError, technical } = research;
  const isLlm = decision.generatedBy === 'llm';

  return (
    <div className="decision-panel">
      <div className="decision-head">
        <div className="decision-action">
          <span className={`action-pill ${ACTION_CLASS[decision.action]}`}>{decision.actionLabel}</span>
          <span className="mono small">{decision.horizon}</span>
          <span className={`ai-badge ${isLlm ? 'live' : ''}`}>
            {isLlm ? `✦ ${decisionMeta?.model || 'LLM'}` : '⚙ rule engine'}
          </span>
          {decisionMeta?.cached && <span className="badge">cached</span>}
          {decisionMeta?.latencyMs && <span className="muted small">{Math.round(decisionMeta.latencyMs / 100) / 10}s</span>}
        </div>
        <div className="decision-head-right">
          <span className="mono small">
            quality {combined.score}/100 · technical {technical.score} · conviction {decision.conviction}%
          </span>
          <button type="button" className="icon-btn" onClick={onClose} title="Collapse">
            ×
          </button>
        </div>
      </div>

      {decisionError && <div className="alert alert-info tiny">{decisionError}</div>}

      {(decision.setupLabel || decision.alertSetup) && (
        <div className="alert-setup">
          <span className="eyebrow">SETUP</span>
          <strong>{decision.setupLabel || decision.alertSetup}</strong>
          {decision.alert?.riskControl && <span className="setup-chip risk">risk exit, not a forecast</span>}
          {decision.alertDisagrees && (
            <span className="setup-chip warn">AI disagrees: {decision.actionLabel}</span>
          )}
        </div>
      )}

      <p className="decision-thesis">{decision.thesis}</p>

      <div className="decision-levels">
        <Stat label="Entry" value={money(decision.keyLevels?.entry)} />
        <Stat label="Primary target" value={money(decision.keyLevels?.target)} tone="up" />
        <Stat label="Stop" value={money(decision.keyLevels?.stop)} tone="down" />
        <Stat label="Reward : risk" value={`${technical.riskReward ?? '—'} : 1`} />
        <Stat label="News read" value={`${news ? `${news.sentiment > 0 ? '+' : ''}${news.sentiment}` : '—'}`} hint={news?.label} />
        <Stat label="Street tilt" value={num(analyst?.tilt ?? 0, 2)} hint={`${analyst?.upgrades ?? 0} up / ${analyst?.downgrades ?? 0} down`} />
      </div>

      <div className="decision-columns">
        <div>
          <h4 className="decision-sub">Upside drivers</h4>
          <ul className="driver-list up">
            {decision.upsideDrivers.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="decision-sub">Downside risks</h4>
          <ul className="driver-list down">
            {decision.downsideRisks.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="decision-columns">
        <div>
          <h4 className="decision-sub">Catalysts & deals</h4>
          <CatalystList items={decision.catalysts} />
        </div>
        <div>
          <h4 className="decision-sub">What invalidates it</h4>
          <ul className="driver-list muted-list">
            {decision.invalidations.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          {decision.whatWouldChangeMyMind && (
            <div className="flip-note">
              <span>⟲</span> {decision.whatWouldChangeMyMind}
            </div>
          )}
        </div>
      </div>

      {decision.optionsIdea && (
        <div className="option-idea">
          <div className="option-idea-head">
            <span className="eyebrow">OPTIONS EXPRESSION</span>
            <strong>{decision.optionsIdea.name}</strong>
            {decision.optionsIdea.expiration && <span className="muted small">exp {decision.optionsIdea.expiration}</span>}
          </div>
          <div className="leg-list">
            {(decision.optionsIdea.legs || []).map((leg, index) => (
              <span key={index} className="leg-chip">
                {leg}
              </span>
            ))}
          </div>
          <div className="option-idea-metrics">
            <Stat label="Max loss" value={decision.optionsIdea.maxLoss ? money(decision.optionsIdea.maxLoss, 0) : '—'} tone="down" />
            <Stat
              label="Est. PoP"
              value={decision.optionsIdea.probabilityOfProfit !== null ? `${decision.optionsIdea.probabilityOfProfit}%` : '—'}
            />
          </div>
          {decision.optionsIdea.reasoning && <p className="option-idea-note">{decision.optionsIdea.reasoning}</p>}
        </div>
      )}

      {news && (
        <div className="news-evidence">
          <div className="news-evidence-head">
            <span className="eyebrow">YAHOO FINANCE EVIDENCE</span>
            <span className="muted small">
              {news.headlineCount} headlines · {news.deals?.length || 0} deals · {news.excerpts?.length || 0} articles read
              {research.newsHistory
                ? ` · 7d sentiment ${research.newsHistory.sentiment7 > 0 ? '+' : ''}${research.newsHistory.sentiment7} (${research.newsHistory.direction}, ${research.newsHistory.coverageDays}d archived, ${research.newsHistory.deals30d} deals/30d)`
                : ''}
            </span>
          </div>

          {news.deals?.length > 0 && (
            <div className="deal-block">
              <strong className="small">Business deals detected</strong>
              {news.deals.slice(0, 3).map((deal, index) => (
                <a key={index} className="deal-row" href={deal.link} target="_blank" rel="noreferrer">
                  <span className={`mono ${DIRECTION_CLASS[deal.direction]}`}>{deal.score > 0 ? '+' : ''}{deal.score}</span>
                  <span>{deal.title}</span>
                </a>
              ))}
            </div>
          )}

          <div className="headline-list">
            {(news.headlines || []).slice(0, 6).map((headline, index) => (
              <a key={index} className="headline-row" href={headline.link} target="_blank" rel="noreferrer">
                <span className={`mono ${DIRECTION_CLASS[headline.direction]}`}>
                  {headline.score > 0 ? '+' : ''}
                  {headline.score}
                </span>
                <span className="headline-title">{headline.title}</span>
                <span className="headline-tags">{headline.tags?.slice(0, 2).join(' · ')}</span>
                <span className="muted small">{shortDate(headline.publishedAt)}</span>
              </a>
            ))}
          </div>

          {(news.excerpts || []).length > 0 && (
            <details className="excerpt-block">
              <summary>Article text the model read ({news.excerpts.length})</summary>
              {news.excerpts.map((excerpt, index) => (
                <div key={index} className="excerpt">
                  <div className="excerpt-title">
                    {excerpt.title}
                    <a href={excerpt.link} target="_blank" rel="noreferrer">
                      open
                    </a>
                  </div>
                  <p>{excerpt.content.slice(0, 700)}…</p>
                </div>
              ))}
            </details>
          )}

          {event?.hasEarnings && <div className="alert alert-warn tiny">{event.label} — size positions accordingly.</div>}
        </div>
      )}

      <div className="decision-actions">
        <button type="button" className="btn btn-mini" onClick={() => onOpenAnalyzer(research.symbol)}>
          Full analyzer
        </button>
        <button type="button" className="btn btn-mini" onClick={() => onOpenOptions(research.symbol)}>
          Options lab
        </button>
        <button type="button" className="btn btn-mini" onClick={() => onOpenAnalyzer(research.symbol)}>
          Read all headlines
        </button>
      </div>

      <div className="decision-disclaimer">
        <Markdown
          text={`_Education only — not investment advice. The call is generated from Yahoo Finance data (${isLlm ? 'LLM reasoning over the dossier' : 'rule engine'}) and can be wrong. Verify quotes before trading._`}
        />
      </div>
    </div>
  );
}

function SignalCard({ row, research, busy, removing, onRunAi, onOpenAnalyzer, onOpenOptions, onClose, onRemove }) {
  const { decision, technical, news, analyst } = row;
  const catalyst = news?.catalysts?.[0];
  const risk = news?.risks?.[0];

  return (
    <article className={`signal-card ${ACTION_CLASS[decision.action]}`}>
      <header className="signal-card-head">
        <div className="signal-identity">
          <button type="button" className="signal-symbol mono" onClick={() => onOpenAnalyzer(row.symbol)}>
            {row.symbol}
          </button>
          <span className="signal-theme">{row.theme}</span>
          <span className={`badge badge-type ${row.kind === 'etf' ? 'etf' : ''}`}>{row.kind.toUpperCase()}</span>
        </div>
        <div className="signal-head-actions">
          <div className="signal-price">
            <span className="mono">{money(row.price)}</span>
            <span className={`mono ${toneForChange(row.changePercent)}`}>{pct(row.changePercent)}</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            title={`Remove ${row.symbol} from your focus list`}
            onClick={() => onRemove(row.symbol)}
            disabled={removing}
          >
            ×
          </button>
        </div>
      </header>        <div className="signal-decision">
        <span className={`action-pill ${ACTION_CLASS[decision.action]}`}>{decision.actionLabel}</span>
        {decision.setupLabel && (
          <span className="setup-chip" title={decision.alert?.setupNote || decision.setupLabel}>
            {decision.setupLabel}
          </span>
        )}
        {decision.aiGenerated === 'llm' && (
          <span className="ai-badge live" title={decision.aiModel || 'LLM decision'}>
            ✦ AI
          </span>
        )}
        <div className="signal-score">
          <div className="signal-score-row">
            <span className="mono">{decision.score}</span>
            <span className="muted small">/100 quality</span>
          </div>
          <ConvictionBar value={decision.conviction} />
        </div>
      </div>

      <div className="signal-metrics">
        <Stat label="Quality" value={`${technical.score} · ${technical.signalLabel}`} hint={`confidence ${technical.confidence}%`} />
        <Stat
          label="News flow"
          value={news ? `${news.sentiment > 0 ? '+' : ''}${news.sentiment} · ${news.label}` : '—'}
          tone={news ? (news.sentiment > 5 ? 'up' : news.sentiment < -5 ? 'down' : '') : ''}
          hint={
            news
              ? `${news.headlineCount} headlines, ${news.dealCount} deals${
                  row.newsHistory && row.newsHistory.direction !== 'flat'
                    ? ` · 7d ${row.newsHistory.direction}`
                    : ''
                }`
              : ''
          }
        />
        <Stat
          label="Street"
          value={analyst ? `${analyst.tilt > 0 ? '+' : ''}${num(analyst.tilt, 2)}` : '—'}
          hint={analyst ? `${analyst.upgrades} upgrades / ${analyst.downgrades} downgrades (${analyst.window})` : ''}
        />
        <Stat
          label="Event"
          value={row.event?.hasEarnings ? `Earnings ${row.event.daysUntil}d` : row.event?.date ? shortDate(row.event.date) : '—'}
          tone={row.event?.hasEarnings ? 'down' : ''}
          hint={row.event?.label}
        />
      </div>

      {technical.triggers && (
        <div className="signal-triggers">
          <div className="trigger trigger-buy">
            <span className="trigger-tag">BUY ABOVE</span>
            <span className="mono">{money(technical.triggers.buyAbove)}</span>
            <span className="muted small">
              {technical.triggers.inBuyZone ? 'in zone now' : `${pct(technical.triggers.distanceToBuyPct)} away`}
            </span>
          </div>
          <div className="trigger trigger-sell">
            <span className="trigger-tag">SELL BELOW</span>
            <span className="mono">{money(technical.triggers.sellBelow)}</span>
            <span className="muted small">
              {technical.triggers.inSellZone ? 'in zone now' : `${pct(technical.triggers.distanceToSellPct)} away`}
            </span>
          </div>
        </div>
      )}

      <div className="signal-levels">
        <div>
          <span className="plan-label">{technical.direction === 'long' ? 'Buy zone' : 'Trim / short zone'}</span>
          <span className="mono">
            {technical.buyZone
              ? `${money(technical.buyZone.low, 0)}–${money(technical.buyZone.high, 0)}`
              : technical.shortZone
                ? `${money(technical.shortZone.low, 0)}–${money(technical.shortZone.high, 0)}`
                : '—'}
          </span>
        </div>
        <div>
          <span className="plan-label">Targets</span>
          <span className="mono up">
            {technical.targets.slice(0, 3).map((target) => money(target.price, 0)).join(' / ')}
          </span>
        </div>
        <div>
          <span className="plan-label">Stop</span>
          <span className="mono down">{money(technical.stopLoss, 0)}</span>
        </div>
        <div>
          <span className="plan-label">R:R</span>
          <span className="mono">{technical.riskReward ?? '—'}</span>
        </div>
      </div>

      {(catalyst || risk) && (
        <div className="signal-signals">
          {catalyst && (
            <div className={`signal-line ${DIRECTION_CLASS[catalyst.direction]}`}>
              <span>▲</span> {catalyst.title}
            </div>
          )}
          {risk && (
            <div className="signal-line down">
              <span>▼</span> {risk.title}
            </div>
          )}
        </div>
      )}

      <footer className="signal-card-foot">
        <button type="button" className="btn btn-primary btn-mini" onClick={() => onRunAi(row.symbol)} disabled={busy}>
          {busy ? 'Researching…' : research ? '↻ Re-run AI call' : '✦ Run AI call'}
        </button>
        <button type="button" className="btn btn-mini" onClick={() => onOpenAnalyzer(row.symbol)}>
          Analyzer
        </button>
        <button type="button" className="btn btn-mini" onClick={() => onOpenOptions(row.symbol)}>
          Options
        </button>
        {research && (
          <button type="button" className="btn btn-mini" onClick={() => onClose(row.symbol)}>
            Hide call
          </button>
        )}
      </footer>

      {research && (
        <DecisionPanel
          research={research}
          onClose={() => onClose(row.symbol)}
          onOpenAnalyzer={onOpenAnalyzer}
          onOpenOptions={onOpenOptions}
        />
      )}
    </article>
  );
}

export default function FocusPage({ go, health }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [research, setResearch] = useState({});
  const [busySymbol, setBusySymbol] = useState('');
  const [filter, setFilter] = useState('all');
  const [deskRunning, setDeskRunning] = useState(false);
  const [deskNote, setDeskNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingSymbol, setRemovingSymbol] = useState('');
  const [addError, setAddError] = useState('');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const data = await api.focus();
      setBoard(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runAi = async (symbol) => {
    setBusySymbol(symbol);
    setError('');
    try {
      const data = await api.research(symbol, { ai: true });
      setResearch((current) => ({ ...current, [symbol]: data }));
    } catch (err) {
      setError(`${symbol}: ${err.message}`);
    } finally {
      setBusySymbol('');
    }
  };

  /** Merge a desk pass result into the board cards and recompute the mix. */
  const applyDeskDecisions = (payload) => {
    setBoard((current) => {
      if (!current) return current;
      const signals = current.signals
        .map((row) => {
          const hit = payload.decisions?.[row.symbol];
          if (!hit?.decision) return row;
          return {
            ...row,
            decision: {
              ...row.decision,
              action: hit.decision.action,
              actionLabel: hit.decision.actionLabel,
              conviction: hit.decision.conviction,
              thesis: hit.decision.thesis,
              triggers: hit.decision.triggers || row.decision.triggers,
              aiGenerated: hit.decision.generatedBy,
              aiModel: hit.decisionMeta?.model || null,
            },
          };
        })
        .sort((a, b) => b.decision.score - a.decision.score);

      const counts = { ...current.counts };
      for (const key of ['buy', 'accumulate', 'hold', 'reduce', 'sell']) {
        counts[key] = signals.filter((row) => row.decision.action === key).length;
      }

      return {
        ...current,
        counts,
        signals,
        topPick: signals.find((row) => ['buy', 'accumulate'].includes(row.decision.action)) || signals[0] || null,
        topRisk:
          [...signals].reverse().find((row) => ['reduce', 'sell'].includes(row.decision.action)) ||
          signals[signals.length - 1] ||
          null,
      };
    });
  };

  /** Add any stock or ETF by ticker; the board reloads with the new row. */
  const addSymbol = async (symbol) => {
    setAddError('');
    setAdding(true);
    try {
      await api.addWatchlist(symbol);
      await load(true);
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  };

  /** Remove a name from the shared watchlist and drop it from the board. */
  const removeSymbol = async (symbol) => {
    setAddError('');
    setRemovingSymbol(symbol);
    try {
      await api.removeWatchlist(symbol);
      setResearch((current) => {
        const next = { ...current };
        delete next[symbol];
        return next;
      });
      await load(true);
    } catch (err) {
      setAddError(err.message);
    } finally {
      setRemovingSymbol('');
    }
  };

  const runDesk = async () => {
    if (!board?.signals?.length) {
      setDeskNote('Add a ticker to your focus list before running the desk.');
      return;
    }
    setDeskRunning(true);
    setDeskNote('');
    setError('');
    try {
      const payload = await api.deskAi({});
      applyDeskDecisions(payload);
      const failed = Object.values(payload.decisions || {}).filter((item) => !item.decision).length;
      setDeskNote(
        payload.live
          ? `Desk call from ${payload.model} · ${Object.keys(payload.decisions).length} names reviewed${failed ? ` · ${failed} fell back` : ''}`
          : 'No LLM key configured — the desk pass used the rule engine on every name.',
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setDeskRunning(false);
    }
  };

  const closeResearch = (symbol) =>
    setResearch((current) => {
      const next = { ...current };
      delete next[symbol];
      return next;
    });

  const signals = (board?.signals || []).filter((row) =>
    filter === 'all'
      ? true
      : filter === 'long'
        ? ['buy', 'accumulate'].includes(row.decision.action)
        : filter === 'short'
          ? ['reduce', 'sell'].includes(row.decision.action)
          : row.kind === 'etf',
  );

  const llmLive = health?.agent?.live;

  return (
    <div className="page focus-page">
      <section className="page-head">
        <div>
          <div className="eyebrow">FOCUS LIST · AI DESK</div>
          <h1>Buy &amp; sell signals on the names that matter</h1>
          <p className="page-sub">
            Your editable focus list — seeded with AI/semiconductor mega-caps and option-tradable ETFs. Add any stock or ETF by
            ticker and remove it with ×. The action is a regime rule validated on five years of this universe —{' '}
            <strong>buy pullbacks inside an uptrend</strong>, never chase, and exit on a trend break. News flow, deals, Street
            actions and earnings dates act as guardrails, and an LLM can add the desk call on any name.
          </p>
        </div>
        <div className="head-actions">
          {board?.generatedAt && <span className="meta-time">Updated {timeAgo(board.generatedAt)}</span>}
          <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={refreshing || deskRunning}>
            <span className={refreshing ? 'spin' : ''}>↻</span> Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={runDesk} disabled={deskRunning || loading}>
            <span className={deskRunning ? 'spin' : ''}>✦</span>{' '}
            {deskRunning ? 'Desk reviewing…' : 'Run AI desk on all'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => go('/agent')}>
            Ask the agent
          </button>
        </div>
      </section>

      {!llmLive && (
        <div className="alert alert-info">
          <strong>Rule-engine mode.</strong> The fused signal below is live and fully deterministic. Add an LLM key
          (<code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, <code>GEMINI_API_KEY</code> or Ollama) to{' '}
          <code>.env</code> and restart the API so “Run AI call” uses an advanced model to reason over the news, deals and analyst
          actions.
        </div>
      )}

      {deskNote && <div className="alert alert-info tiny">{deskNote}</div>}
      {addError && <div className="alert alert-error tiny">{addError}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="panel focus-loading">
          <div className="loading-orbit" />
          <p className="muted">Pulling prices, headlines, deals and analyst actions for the focus universe…</p>
        </div>
      ) : (
        <>
          {board && (
            <section className="focus-summary">
              <div className="panel summary-tile">
                <span className="eyebrow">SIGNAL MIX</span>
                <div className="mix-row">
                  <span className="mix buy">{board.counts.buy} Buy</span>
                  <span className="mix accumulate">{board.counts.accumulate} Accumulate</span>
                  <span className="mix hold">{board.counts.hold} Hold</span>
                  <span className="mix reduce">{board.counts.reduce} Reduce</span>
                  <span className="mix sell">{board.counts.sell} Sell</span>
                </div>
                <div className="muted small">
                  {board.counts.deals} business-deal headlines tracked · average news sentiment{' '}
                  {board.averageNewsSentiment > 0 ? '+' : ''}
                  {board.averageNewsSentiment}
                </div>
              </div>

              <div className="panel summary-tile">
                <span className="eyebrow">BEST OPPORTUNITY</span>
                {board.topPick ? (
                  <>
                    <div className="pick-row">
                      <button type="button" className="signal-symbol mono" onClick={() => go(`/analyze/${board.topPick.symbol}`)}>
                        {board.topPick.symbol}
                      </button>
                      <span className={`action-pill ${ACTION_CLASS[board.topPick.decision.action]}`}>
                        {board.topPick.decision.actionLabel}
                      </span>
                      <span className="mono small">{board.topPick.decision.score}/100</span>
                    </div>
                    <div className="muted small">
                      {board.topPick.theme} · T1 {money(board.topPick.technical.targets?.[0]?.price, 0)} · stop{' '}
                      {money(board.topPick.technical.stopLoss, 0)}
                    </div>
                    <div className="muted small">{board.topPick.news?.catalysts?.[0]?.title || board.topPick.event?.label}</div>
                  </>
                ) : (
                  <span className="muted small">No signals</span>
                )}
              </div>

              <div className="panel summary-tile">
                <span className="eyebrow">WEAKEST / AVOID</span>
                {board.topRisk ? (
                  <>
                    <div className="pick-row">
                      <button type="button" className="signal-symbol mono" onClick={() => go(`/analyze/${board.topRisk.symbol}`)}>
                        {board.topRisk.symbol}
                      </button>
                      <span className={`action-pill ${ACTION_CLASS[board.topRisk.decision.action]}`}>
                        {board.topRisk.decision.actionLabel}
                      </span>
                      <span className="mono small">{board.topRisk.decision.score}/100</span>
                    </div>
                    <div className="muted small">
                      News {board.topRisk.news ? `${board.topRisk.news.sentiment > 0 ? '+' : ''}${board.topRisk.news.sentiment}` : '—'} ·{' '}
                      technical {board.topRisk.technical.score}
                    </div>
                    <div className="muted small">{board.topRisk.news?.risks?.[0]?.title || board.topRisk.event?.label}</div>
                  </>
                ) : (
                  <span className="muted small">No signals</span>
                )}
              </div>
            </section>
          )}

          <div className="focus-toolbar">
            <div className="chip-row">
              {[
                { id: 'all', label: `All ${board?.signals?.length ?? 0}` },
                { id: 'long', label: 'Long side' },
                { id: 'short', label: 'Trim / avoid' },
                { id: 'etf', label: 'ETFs' },
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`filter-chip ${filter === option.id ? 'active' : ''}`}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="focus-add">
              <SearchBox compact placeholder="Add stock or ETF…" onSelect={addSymbol} />
              {adding && <span className="muted small">Adding…</span>}
            </div>
          </div>
          <div className="muted small focus-formula">
            Fused score = technicals 50% · news 20% · Street 15% · deals 15% · option structures in the Options Lab
          </div>

          <section className="signal-grid">
            {signals.map((row) => (
              <SignalCard
                key={row.symbol}
                row={row}
                research={research[row.symbol]}
                busy={busySymbol === row.symbol}
                removing={removingSymbol === row.symbol}
                onRunAi={runAi}
                onOpenAnalyzer={(symbol) => go(`/analyze/${symbol}`)}
                onOpenOptions={(symbol) => go(`/options/${symbol}`)}
                onClose={closeResearch}
                onRemove={removeSymbol}
              />
            ))}
            {!signals.length && (
              <div className="panel empty-note signal-empty">
                {board?.signals?.length
                  ? 'No names match this filter.'
                  : 'Your focus list is empty. Search a ticker above to add a stock or ETF.'}
              </div>
            )}
          </section>

          <div className="dashboard-footnote">
            Signals are generated from Yahoo Finance data (prices, option chains, company news, analyst actions) and are educational
            research, not advice.
          </div>
        </>
      )}
    </div>
  );
}
