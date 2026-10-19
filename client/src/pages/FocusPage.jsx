import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from '../components/Markdown.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { useMoneyText } from '../components/CurrencyProvider.jsx';
import Stat from '../components/Stat.jsx';
import { api } from '../lib/api.js';
import { money, num, pct, shortDate, timeAgo, toneForChange, usd } from '../lib/format.js';
import { CHANCE_FILTERS, chanceOfFocusRow, growthBand } from '../lib/growth.js';

const ACTION_CLASS = {
  buy: 'action-buy',
  accumulate: 'action-accumulate',
  hold: 'action-hold',
  reduce: 'action-reduce',
  sell: 'action-sell',
};

const DIRECTION_CLASS = { bullish: 'up', bearish: 'down', neutral: 'muted' };

/** How the board can be ordered. "Chance to rise" is the default. */
const SORTS = [
  { id: 'chance', label: 'Best chance to rise' },
  { id: 'action', label: 'Suggested action' },
  { id: 'confidence', label: 'Conviction' },
  { id: 'quality', label: 'Quality score' },
];

const SORTERS = {
  chance: (a, b) =>
    (b.growthProbability ?? -1) - (a.growthProbability ?? -1) ||
    (ACTION_RANK[a.decision.action] ?? 5) - (ACTION_RANK[b.decision.action] ?? 5) ||
    b.decision.conviction - a.decision.conviction,
  action: (a, b) =>
    (ACTION_RANK[a.decision.action] ?? 5) - (ACTION_RANK[b.decision.action] ?? 5) ||
    b.decision.conviction - a.decision.conviction,
  confidence: (a, b) => b.decision.conviction - a.decision.conviction,
  quality: (a, b) => b.technical.score - a.technical.score,
};

/**
 * Distance to a trigger, worded from spot. The sell trigger always sits below
 * spot, so a signed print read "-1.56% away" — nonsense. State the side and the
 * size, and fall back to "at spot" if a level ever lands on the wrong side.
 */
function triggerDistance(value, side) {
  if (!Number.isFinite(value)) return '';
  const onSide = side === 'buy' ? value > 0 : value < 0;
  if (!onSide) return 'at spot';
  return `${pct(Math.abs(value), 2, false)} ${side === 'buy' ? 'above' : 'below'}`;
}

// Same risk ladder as the server: buys first, sells last. After an AI desk pass
// the board must stay ranked by the NEW action, not by the quality score.
const ACTION_RANK = { buy: 0, accumulate: 1, hold: 2, reduce: 3, sell: 4 };

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
  const moneyText = useMoneyText();
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
            {moneyText(item.detail || item.title)}
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
  const moneyText = useMoneyText();
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
          {/* The setup is the engine's reading of the tape; the model owns the
              action, so say whose read this is instead of presenting it as
              the model's own. */}
          <strong>{isLlm ? `⚙ ${decision.setupLabel || decision.alertSetup}` : decision.setupLabel || decision.alertSetup}</strong>
          {decision.alert?.riskControl && <span className="setup-chip risk">risk exit, not a forecast</span>}
          {decision.alertDisagrees && (
            <span className="setup-chip warn">
              engine cross-check: {decision.alertActionLabel || decision.alertAction}
            </span>
          )}
        </div>
      )}

      <p className="decision-thesis">{moneyText(decision.thesis)}</p>

      <div className="decision-levels">
        <Stat label="Entry" value={money(decision.keyLevels?.entry)} />
        <Stat
          label="Main target (T2)"
          value={money(decision.keyLevels?.target)}
          tone={technical.direction === 'long' ? 'up' : 'down'}
        />
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
              <li key={index}>{moneyText(item)}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="decision-sub">Downside risks</h4>
          <ul className="driver-list down">
            {decision.downsideRisks.map((item, index) => (
              <li key={index}>{moneyText(item)}</li>
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
              <li key={index}>{moneyText(item)}</li>
            ))}
          </ul>
          {decision.whatWouldChangeMyMind && (
            <div className="flip-note">
              <span>⟲</span> {moneyText(decision.whatWouldChangeMyMind)}
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
            <span className="muted small">· legs &amp; P/L in USD</span>
          </div>
          <div className="leg-list">
            {(decision.optionsIdea.legs || []).map((leg, index) => (
              <span key={index} className="leg-chip">
                {leg}
              </span>
            ))}
          </div>
          <div className="option-idea-metrics">
            <Stat label="Max loss" value={decision.optionsIdea.maxLoss ? usd(decision.optionsIdea.maxLoss, 0) : '—'} tone="down" />
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
  // An AI / desk pass may override the mechanical levels, so the card must show
  // the triggers that belong to the call it is displaying.
  const triggers = decision.triggers || technical.triggers;
  // The model owns the call; the mechanical read stays visible as a cross-check
  // instead of being silently swapped out.
  const deskOwned = row.decisionSource === 'llm' || decision.generatedBy === 'llm' || decision.aiGenerated === 'llm';
  const engine = row.engineDecision || null;
  // The label has to follow the call being DISPLAYED. When the model overrides
  // the engine (e.g. it calls Sell in an uptrend), the upper level is a reclaim
  // that would cancel that call, not a buy trigger — and price sitting in the
  // engine's buy zone is no longer a reason to say "in buy zone".
  const exitCall = ['reduce', 'sell'].includes(decision.action);
  const entryCall = ['buy', 'accumulate'].includes(decision.action);
  const upperLabel =
    triggers?.side === 'short'
      ? triggers?.buyLabel || 'STOP ABOVE'
      : exitCall
        ? 'RECLAIM ABOVE'
        : entryCall
          ? triggers?.buyLabel || 'BUY ABOVE'
          : 'WATCH ABOVE';

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
          <span
            className="setup-chip"
            title={
              deskOwned
                ? `Rule-engine setup context: ${decision.alert?.setupNote || decision.setupLabel}`
                : decision.alert?.setupNote || decision.setupLabel
            }
          >
            {deskOwned ? `⚙ ${decision.setupLabel}` : decision.setupLabel}
          </span>
        )}
        {deskOwned ? (
          <span
            className="ai-badge live"
            title={`${decision.aiModel || row.decisionMeta?.model || 'LLM'} decision — the mechanical call is kept as a cross-check`}
          >
            ✦ AI
          </span>
        ) : null}
        {deskOwned && engine && engine.action !== decision.action && (
          <span className="setup-chip warn" title={`The rule engine reads ${engine.setupLabel || engine.actionLabel}`}>
            engine: {engine.actionLabel}
          </span>
        )}
        {Number.isFinite(row.growthProbability) && (
          <span
            className={`growth-chip ${row.growthBand || ''}`}
            title="Blended chance to rise: primary-target probability, conviction, quality score, trend and archive follow-through. A working bearish plan scores low on purpose."
          >
            ↑ {row.growthProbability}% chance
          </span>
        )}
        {row.archive && (
          <span
            className="setup-chip archive"
            title={`Daily MongoDB archive: ${row.archive.coverageDays} session${row.archive.coverageDays === 1 ? '' : 's'} stored (last ${row.archive.lastDate}). Archived call ${row.archive.label} for ${row.archive.streak} session${row.archive.streak === 1 ? '' : 's'}${
              row.archive.scoreDelta5 === null ? '' : `, quality score ${row.archive.scoreDelta5 > 0 ? '+' : ''}${row.archive.scoreDelta5} over five sessions`
            }${row.archive.hitRate === null ? '' : `, previous calls followed through ${row.archive.hitRate}%`}.`}
          >
            🗄 {row.archive.coverageDays}d · {row.archive.label} ×{row.archive.streak}
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

      {triggers && (
        <div className="signal-triggers">
          {triggers.inBuyZone && technical.buyZone && entryCall ? (
            // Price is already inside the accumulation range, so the actionable
            // line is the zone itself; the reference entry the plan is built
            // around is on the level strip right below.
            <div className="trigger trigger-buy">
              <span className="trigger-tag">IN BUY ZONE</span>
              <span className="mono">
                {money(technical.buyZone.low, 0)}–{money(technical.buyZone.high, 0)}
              </span>
            </div>
          ) : (
            <div
              className={`trigger ${triggers.side === 'short' ? 'trigger-sell' : 'trigger-buy'}`}
              title={triggers.buyHint || ''}
            >
              <span className="trigger-tag">{upperLabel}</span>
              <span className="mono">{money(triggers.buyAbove)}</span>
              <span className="muted small">{triggerDistance(triggers.distanceToBuyPct, 'buy')}</span>
            </div>
          )}
          {/* On a long this is the stop-loss exit, not a price to sell a winner
              at: naming it "sell below" made a Buy card read as buy-then-sell-
              lower. The label says what the level does to the position. */}
          <div className="trigger trigger-sell" title={triggers.sellHint || ''}>
            <span className="trigger-tag">{triggers.sellLabel || 'EXIT BELOW'}</span>
            <span className="mono">{money(triggers.sellBelow)}</span>
            <span className="muted small">{triggerDistance(triggers.distanceToSellPct, 'sell')}</span>
          </div>
        </div>
      )}

      <div className="signal-levels">
        <div>
          <span className="plan-label">
            {technical.buyZone
              ? exitCall
                ? 'Engine buy zone'
                : 'Buy zone'
              : technical.shortZone
                ? technical.direction === 'short'
                  ? 'Short zone'
                  : 'Trim zone'
                : 'No zone'}
          </span>
          <span className="mono">
            {technical.buyZone
              ? `${money(technical.buyZone.low, 0)}–${money(technical.buyZone.high, 0)}`
              : technical.shortZone
                ? `${money(technical.shortZone.low, 0)}–${money(technical.shortZone.high, 0)}`
                : '—'}
          </span>
          {/* Every other number on this strip — the targets, the stop and the
              R:R — is measured from this reference entry. Without it the
              ratios cannot be checked against the prices shown. */}
          {(technical.buyZone || technical.shortZone) && (
            <span className="muted small" title="Reference entry: the middle of the range above. The targets, the stop and the R:R are all measured from here.">
              entry {money(technical.entryRef)}
            </span>
          )}
        </div>
        <div>
          {/* On a short-side plan the tiers are below spot, and on an exit call
              they are places to sell into, not targets for a new long. */}
          <span className="plan-label">
            {technical.direction === 'short'
              ? 'Downside levels'
              : ['reduce', 'sell'].includes(decision.action)
                ? 'Trim targets'
                : 'Profit targets'}
          </span>
          <span className="mono up">
            {technical.targets.slice(0, 3).map((target) => money(target.price, 0)).join(' / ')}
          </span>
        </div>
        <div>
          <span className="plan-label">Stop</span>
          <span className="mono down">{money(technical.stopLoss, 0)}</span>
        </div>
        <div>
          <span className="plan-label">R:R (to T2)</span>
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

/**
 * Manage the focus list directly: add any ticker and remove any tracked name.
 * The list is the server's watchlist, so it includes names whose quote or scan
 * failed too — the board cannot show those, but they still need a delete.
 */
export function FocusListManager({ items = [], onRemove, onAdd, adding = false, removingSymbol = '', error = '' }) {
  return (
    <section className="panel focus-manage">
      <div className="panel-head">
        <div>
          <div className="eyebrow">MANAGE FOCUS LIST</div>
          <h2>
            {items.length} name{items.length === 1 ? '' : 's'} tracked
          </h2>
        </div>
        <span className="muted small">Add any stock or ETF, and remove the names you no longer want to follow</span>
      </div>

      <div className="focus-manage-add">
        <span className="focus-add-label">☆ Add a stock</span>
        <SearchBox compact submitLabel="+ Add" placeholder="Ticker or company…" onSelect={onAdd} />
        {adding && <span className="muted small">Adding…</span>}
      </div>
      {error && <div className="alert alert-error tiny">{error}</div>}

      {items.length ? (
        <ul className="focus-manage-list">
          {items.map((item) => {
            const removing = removingSymbol === item.symbol;
            return (
              <li key={item.symbol} className={`focus-manage-item ${removing ? 'removing' : ''}`}>
                <span className="mono focus-manage-symbol">{item.symbol}</span>
                <span className="focus-manage-name">{item.name || item.symbol}</span>
                {item.quoteType && (
                  <span className={`badge badge-type ${item.quoteType === 'ETF' ? 'etf' : ''}`}>{item.quoteType}</span>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  title={`Remove ${item.symbol} from your focus list`}
                  aria-label={`Remove ${item.symbol} from your focus list`}
                  disabled={removing}
                  onClick={() => onRemove?.(item.symbol)}
                >
                  {removing ? '…' : '×'}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty-note tiny">Your focus list is empty — add a ticker above to start tracking it.</div>
      )}
    </section>
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
  // Rank by the blended chance to rise by default, and let the user demand a
  // minimum chance instead of eyeballing a long board.
  const [sortMode, setSortMode] = useState('chance');
  const [minChance, setMinChance] = useState(0);
  const [deskRunning, setDeskRunning] = useState(false);
  const [deskNote, setDeskNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingSymbol, setRemovingSymbol] = useState('');
  const [addError, setAddError] = useState('');
  // The raw tracked list, independent of whether the board could price a name.
  const [tracked, setTracked] = useState([]);
  const [trackedError, setTrackedError] = useState('');
  const [managing, setManaging] = useState(false);
  const llmLive = health?.agent?.live;

  const loadTracked = useCallback(async () => {
    try {
      const payload = await api.watchlist();
      setTracked(payload?.items || []);
      setTrackedError('');
    } catch (err) {
      setTrackedError(err.message);
    }
  }, []);

  useEffect(() => {
    loadTracked();
  }, [loadTracked]);

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
          if (!hit?.decision) {
            const probability = chanceOfFocusRow(row, { preferServer: false });
            return { ...row, growthProbability: probability, growthBand: growthBand(probability) };
          }
          return {
            ...row,
            // The model's fields own the call; the engine keeps supplying the
            // fused quality score and the setup context it did not return.
            decision: {
              ...row.decision,
              ...hit.decision,
              triggers: hit.decision.triggers || row.decision.triggers,
              aiGenerated: hit.decision.generatedBy,
              aiModel: hit.decisionMeta?.model || null,
            },
            decisionSource: 'llm',
            decisionMeta: hit.decisionMeta || row.decisionMeta,
          };
        })
        // The model replaced conviction, so re-derive the chance to rise from
        // the new call rather than keeping the number the server last sent.
        .map((row) => {
          const probability = chanceOfFocusRow(row, { preferServer: false });
          return { ...row, growthProbability: probability, growthBand: growthBand(probability) };
        })
        .sort(
          (a, b) =>
            (ACTION_RANK[a.decision.action] ?? 5) - (ACTION_RANK[b.decision.action] ?? 5) ||
            b.decision.conviction - a.decision.conviction,
        );

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
      await Promise.all([load(true), loadTracked()]);
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
      await Promise.all([load(true), loadTracked()]);
    } catch (err) {
      setAddError(err.message);
    } finally {
      setRemovingSymbol('');
    }
  };

  /** Run the desk pass for `symbols` (defaults to the whole board). */
  const runDesk = async (symbols) => {
    const targets = symbols ?? board?.signals?.map((row) => row.symbol) ?? [];
    if (!targets.length) {
      setDeskNote('Add a ticker to your focus list before running the desk.');
      return;
    }
    setDeskRunning(true);
    setDeskNote('');
    setError('');
    try {
      const payload = await api.deskAi({ symbols: targets });
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

  /**
   * The buy / sell call belongs to the model, not to a hardcoded rule, so once
   * the board is in and a provider is reachable, fill in the names that have no
   * model call yet. Each call is cached server-side for 30 minutes, so this
   * only spends tokens on genuinely stale names — and it runs once per visit.
   */
  const deskRequested = useRef(false);
  useEffect(() => {
    if (!board || !llmLive || deskRequested.current) return;
    const pending = board.signals
      .filter((row) => row.decisionSource !== 'llm')
      .map((row) => row.symbol);
    if (!pending.length) return;
    deskRequested.current = true;
    runDesk(pending);
    // Only a new board (or a provider becoming reachable) can re-arm this; the
    // ref keeps a re-render from firing a second pass.
  }, [board, llmLive]);

  // Ensure every row has a chance to rise before filtering/sorting: the API
  // sends it, but a stale board should still rank by a real number.
  const boardRows = (board?.signals || []).map((row) => {
    if (Number.isFinite(row.growthProbability)) return row;
    const probability = chanceOfFocusRow(row);
    return { ...row, growthProbability: probability, growthBand: growthBand(probability) };
  });

  const signals = boardRows
    .filter((row) =>
      filter === 'all'
        ? true
        : filter === 'long'
          ? ['buy', 'accumulate'].includes(row.decision.action)
          : filter === 'short'
            ? ['reduce', 'sell'].includes(row.decision.action)
            : row.kind === 'etf',
    )
    .filter((row) => (minChance === 0 ? true : (row.growthProbability ?? 0) >= minChance))
    .sort(SORTERS[sortMode] || SORTERS.chance);

  return (
    <div className="page focus-page">
      <section className="page-head">
        <div>
          <div className="eyebrow">FOCUS LIST · AI DESK</div>
          <h1>Buy &amp; sell signals on the names that matter</h1>
          <p className="page-sub">
            Your favorites — this focus list starts with the large AI and semiconductor names plus a few ETFs. Add any stock or ETF
            with <strong>☆ Add a favorite</strong> (type a ticker, press + Add), remove one with the × on its card, or open{' '}
            <strong>Manage list</strong> to add and delete every tracked name in one place. Each name gets one simple call:{' '}
            <strong>Buy</strong> when an uptrend pulls back,{' '}
            <strong>Accumulate</strong> to build slowly, <strong>Hold</strong> when the price is stretched, and{' '}
            <strong>Reduce</strong> or <strong>Sell</strong> when the trend breaks. News, deals, analyst actions and earnings dates
            can block a new buy, and the AI desk can add its own call on any name.
          </p>
        </div>
        <div className="head-actions">
          {board?.generatedAt && <span className="meta-time">Updated {timeAgo(board.generatedAt)}</span>}
          <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={refreshing || deskRunning}>
            <span className={refreshing ? 'spin' : ''}>↻</span> Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={() => runDesk()} disabled={deskRunning || loading}>
            <span className={deskRunning ? 'spin' : ''}>✦</span>{' '}
            {deskRunning ? 'Desk reviewing…' : 'Run AI desk on all'}
          </button>
          <button
            type="button"
            className={managing ? 'btn btn-primary' : 'btn btn-ghost'}
            onClick={() => setManaging((open) => !open)}
            aria-pressed={managing}
            title="Add or delete names on your focus list"
          >
            ★ Manage list ({tracked.length})
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

      {managing && (
        <FocusListManager
          items={tracked}
          onAdd={addSymbol}
          onRemove={removeSymbol}
          adding={adding}
          removingSymbol={removingSymbol}
          error={trackedError}
        />
      )}

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
                <span className="eyebrow">MIX OF CALLS</span>
                <div className="mix-row">
                  <span className="mix buy">{board.counts.buy} Buy</span>
                  <span className="mix accumulate">{board.counts.accumulate} Accumulate</span>
                  <span className="mix hold">{board.counts.hold} Hold</span>
                  <span className="mix reduce">{board.counts.reduce} Reduce</span>
                  <span className="mix sell">{board.counts.sell} Sell</span>
                </div>
                <div className="muted small">
                  {board.counts.deals} deal headlines tracked · average news mood{' '}
                  {board.averageNewsSentiment > 0 ? '+' : ''}
                  {board.averageNewsSentiment}
                </div>
                {board.decisions && (
                  <div className="muted small">
                    {board.decisions.llm} model call{board.decisions.llm === 1 ? '' : 's'}
                    {board.decisions.ruleEngine
                      ? ` · ${board.decisions.ruleEngine} on the rule-engine fallback`
                      : ' · rule engine kept as the cross-check'}
                  </div>
                )}
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
                <span className="eyebrow">WEAKEST NAME</span>
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
                { id: 'long', label: 'Buy side' },
                { id: 'short', label: 'Reduce / sell' },
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
            <div className="focus-controls">
              <label className="focus-control">
                <span>Min chance</span>
                <select value={minChance} onChange={(event) => setMinChance(Number(event.target.value))}>
                  {CHANCE_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="focus-control">
                <span>Sort</span>
                <select value={sortMode} onChange={(event) => setSortMode(event.target.value)}>
                  {SORTS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="muted small">
                Showing {signals.length} of {board?.signals?.length ?? 0}
              </span>
            </div>
            <div className="focus-add">
              <span className="focus-add-label">☆ Add a favorite</span>
              <SearchBox compact submitLabel="+ Add" placeholder="Ticker or company…" onSelect={addSymbol} />
              {adding && <span className="muted small">Adding…</span>}
            </div>
          </div>
          <div className="muted small focus-formula">
            Quality score = price trend &amp; plan 50% · news mood 20% · analyst actions 15% · deals &amp; catalysts 15%. The Buy /
            Hold / Sell call comes from the price trend, not from the score — a high-quality name can still be a Hold.{' '}
            <strong>Chance to rise</strong> blends the primary-target probability (45%), conviction (30%), quality (15%), trend
            (10%) and archive follow-through (10%), and the board is ranked by it by default; the Min chance filter hides
            everything below the level you pick. A bearish plan scores low on purpose.
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
                  : 'Your focus list is empty. Use ☆ Add a favorite above to add a stock or ETF.'}
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
