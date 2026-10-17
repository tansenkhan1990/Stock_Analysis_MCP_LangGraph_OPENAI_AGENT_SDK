import { useCallback, useEffect, useState } from 'react';
import IntradayChart from '../components/IntradayChart.jsx';
import SearchBox from '../components/SearchBox.jsx';
import Stat from '../components/Stat.jsx';
import { api } from '../lib/api.js';
import { money, pct, timeAgo, toneForChange } from '../lib/format.js';

export default function DayTradePage({ symbol, go }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (refresh = false, silent = false) => {
      if (!silent) {
        if (refresh) setRefreshing(true);
        else setLoading(true);
      }
      setError('');
      try {
        setData(await api.dayTrade(symbol, { refresh }));
      } catch (err) {
        if (!silent) setError(err.message);
      } finally {
        if (!silent) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [symbol],
  );

  useEffect(() => {
    setData(null);
    load(false);
  }, [load]);

  useEffect(() => {
    // The bar cache is 60 seconds, so a silent poll picks up the latest candles
    // without busting the LLM desk call (which is cached for 10 minutes).
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(false, true);
    }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) {
    return (
      <div className="page day-page">
        <div className="analyzer-loading">
          <div className="loading-orbit" />
          <h2>Reading the {symbol} intraday chart…</h2>
          <p className="muted">Fetching 5-minute bars, session VWAP, EMAs and the opening range.</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="page day-page">
        <section className="page-head">
          <div>
            <div className="eyebrow">DAY TRADING</div>
            <h1>Intraday buy / sell read</h1>
            <p className="page-sub">Pick a liquid ticker and the engine reads the 5-minute chart: VWAP, EMA9/20, RSI, opening range and volume.</p>
          </div>
        </section>
        <div className="analyzer-search-panel panel">
          <SearchBox onSelect={(next) => go(`/daytrade/${next}`)} autoFocus placeholder={`Search a ticker (currently ${symbol})…`} />
        </div>
        {error && (
          <div className="alert alert-error">
            <strong>Could not build the intraday read.</strong> {error}
          </div>
        )}
      </div>
    );
  }

  const { plan, levels, indicators, triggers, session } = data;
  const context = data.context || null;
  const daily = context?.technical || null;
  const ai = data.ai || null;
  const waiting = data.action === 'wait';
  const tone = data.action === 'buy' ? 'buy' : data.action === 'sell' ? 'sell' : 'wait';
  const dailyTrend =
    daily?.sma50 && daily?.sma200 ? (daily.sma50 >= daily.sma200 ? 'Up' : 'Down') : null;

  return (
    <div className="page day-page">
      <section className="page-head">
        <div>
          <div className="eyebrow">DAY TRADING</div>
          <h1>
            {data.symbol} <span className="muted">intraday read</span>
          </h1>
          <p className="page-sub">
            {data.name} · 5-minute bars · session {data.session.date} · updates every 60 seconds. Times are New York (ET).
          </p>
        </div>
        <div className="head-actions">
          <SearchBox compact onSelect={(next) => go(`/daytrade/${next}`)} placeholder="Ticker…" />
          <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={refreshing}>
            <span className={refreshing ? 'spin' : ''}>↻</span> Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={() => go(`/analyze/${data.symbol}`)}>
            Full analysis
          </button>
        </div>
      </section>

      <section className={`panel day-signal ${tone}`}>
        <div className="day-signal-main">
          <div className="day-signal-action">
            <span className="day-action-label">{waiting ? 'NO TRADE' : data.actionLabel.toUpperCase()}</span>
            <span className="day-signal-symbol mono">{data.symbol}</span>
          </div>
          <div className="day-signal-copy">
            <div className="day-signal-price mono">
              {money(data.price)}
              <span className={`day-signal-change ${toneForChange(data.changePercent)}`}>{pct(data.changePercent)}</span>
              {data.marketState && <span className="badge badge-state">{data.marketState}</span>}
            </div>
            <p className="day-signal-text">
              {waiting
                ? `Mixed signals — wait for a break above ${money(triggers.buyAbove)} or below ${money(triggers.sellBelow)} on volume.`
                : plan
                  ? `${data.actionLabel} setup: entry near ${money(plan.entry)}, stop ${money(plan.stopLoss)}, first target ${money(plan.targets[0]?.price)}.`
                  : 'No valid setup on the current candles.'}
            </p>
            <div className="day-signal-meta">
              <span className={`day-source-chip ${data.source === 'ai' ? 'ai' : 'engine'}`}>
                {data.source === 'ai'
                  ? `✦ AI desk · ${data.decisionMeta?.model || 'model'}${data.decisionMeta?.cached ? ' (cached)' : ''}`
                  : '⚙ Mechanical engine'}
              </span>
              <span>Engine score {data.engine?.score > 0 ? `+${data.engine?.score}` : data.engine?.score}</span>
              <span>Updated {timeAgo(data.generatedAt)}</span>
              <span>{session.bars} bars this session</span>
              {!session.openingRangeComplete && <span className="warn">opening range still forming</span>}
            </div>
          </div>
          <div className="day-confidence">
            <span className="day-confidence-value mono">{data.confidence}%</span>
            <span className="muted small">confidence</span>
            <div className="meter">
              <div
                className={`meter-fill ${data.confidence >= 70 ? 'good' : data.confidence >= 55 ? 'ok' : 'neutral'}`}
                style={{ width: `${data.confidence}%` }}
              />
            </div>
          </div>
        </div>

        <ul className="day-reasons">
          {data.reasons.slice(0, 6).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>

        {data.decisionError && <div className="alert alert-info tiny">{data.decisionError}</div>}
        {data.source === 'ai' && ai && ai.agreesWithEngine === false && (
          <div className="alert alert-info tiny">
            The AI desk disagrees with the mechanical read: engine says {data.engine?.actionLabel}, the model says {ai.actionLabel}.
            Both are shown below.
          </div>
        )}
      </section>

      <div className="day-grid">
        <section className="panel day-chart-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">5-MINUTE CHART</div>
              <h2>Price action & trade levels</h2>
            </div>
            <div className="chip-row">
              <span className="chip">VWAP</span>
              <span className="chip">EMA9 / EMA20</span>
              <span className="chip">Opening range</span>
            </div>
          </div>
          <IntradayChart
            bars={data.chart.bars}
            overlays={data.chart.overlays}
            levels={levels}
            plan={plan}
            action={data.action}
            sessionStarts={data.chart.sessionStarts}
          />
          <div className="chart-foot">
            <span>5m bars · times New York (ET) · auto-refresh 60s</span>
            <span className="muted">ORH / ORL = opening-range high / low · PDC = prior close</span>
          </div>
        </section>

        <aside className="day-rail">
          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="eyebrow">TRADE PLAN</div>
                <h2>{waiting ? 'Waiting for a trigger' : `${data.actionLabel} setup`}</h2>
              </div>
            </div>

            {plan ? (
              <>
                <div className="day-plan-grid">
                  <Stat label="Entry" value={money(plan.entry)} />
                  <Stat label="Stop" value={money(plan.stopLoss)} tone="down" />
                  {plan.targets.map((target) => (
                    <Stat
                      key={target.label}
                      label={`${target.label} · ${target.rMultiple}R`}
                      value={`${money(target.price)} (${pct(target.movePct, 1)})`}
                      tone="up"
                    />
                  ))}
                  <Stat label="Risk / share" value={money(plan.riskPerShare)} />
                  <Stat label="R:R to T2" value={`${plan.riskReward}:1`} />
                </div>
                <p className="option-note">{plan.invalidation}</p>
              </>
            ) : (
              <>
                <div className="day-triggers">
                  <div className="trigger trigger-buy">
                    <span className="trigger-tag">BUY ABOVE</span>
                    <span className="mono">{money(triggers.buyAbove)}</span>
                  </div>
                  <div className="trigger trigger-sell">
                    <span className="trigger-tag">SELL BELOW</span>
                    <span className="mono">{money(triggers.sellBelow)}</span>
                  </div>
                </div>
                <p className="option-note">{triggers.note}</p>
              </>
            )}
          </section>

          <section className="panel">
            <div className="eyebrow">SESSION LEVELS</div>
            <div className="day-level-grid">
              <Stat label="VWAP" value={money(levels.vwap)} />
              <Stat label="EMA9" value={money(levels.ema9)} />
              <Stat label="EMA20" value={money(levels.ema20)} />
              <Stat label="OR high" value={money(levels.openingRangeHigh)} />
              <Stat label="OR low" value={money(levels.openingRangeLow)} />
              <Stat label="Prior close" value={money(levels.priorClose)} />
              <Stat label="Session high" value={money(levels.sessionHigh)} />
              <Stat label="Session low" value={money(levels.sessionLow)} />
            </div>
          </section>

          <section className="panel">
            <div className="eyebrow">INDICATORS</div>
            <div className="day-level-grid">
              <Stat label="RSI (14)" value={indicators.rsi14 ?? '—'} tone={indicators.rsi14 > 70 ? 'down' : indicators.rsi14 < 30 ? 'up' : ''} />
              <Stat label="ATR %" value={`${indicators.atrPct ?? '—'}%`} />
              <Stat label="Volume ratio" value={indicators.volumeRatio ? `${indicators.volumeRatio}×` : '—'} />
              <Stat label="VWAP distance" value={pct(indicators.vwapDistancePct, 2)} />
              <Stat label="Trend" value={indicators.ema9Above20 ? 'Up' : 'Down'} tone={indicators.ema9Above20 ? 'up' : 'down'} />
              <Stat label="vs prior close" value={pct(((data.price - levels.priorClose) / levels.priorClose) * 100, 2)} />
            </div>
          </section>

          <section className="panel day-risk-panel">
            <div className="eyebrow">READ THIS</div>
            <ul className="risk-list">
              {data.risks.map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ul>
          </section>

          <section className="panel day-engine-panel">
            <div className="eyebrow">MECHANICAL CROSS-CHECK</div>
            <div className="day-level-grid">
              <Stat label="Engine call" value={data.engine?.actionLabel} />
              <Stat label="Engine score" value={data.engine?.score > 0 ? `+${data.engine?.score}` : data.engine?.score} />
              <Stat label="Engine confidence" value={`${data.engine?.confidence ?? '—'}%`} />
              <Stat
                label="Agreement"
                value={ai ? (ai.agreesWithEngine === null ? '—' : ai.agreesWithEngine ? 'Same call' : 'Different') : 'Engine only'}
                tone={ai?.agreesWithEngine === false ? 'down' : ''}
              />
            </div>
            <ul className="day-reasons tight">
              {(data.engine?.reasons || []).slice(0, 5).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      {ai && (
        <section className={`panel day-ai-panel ${ai.action}`}>
          <div className="panel-head">
            <div>
              <div className="eyebrow">AI DESK CALL</div>
              <h2>
                {ai.actionLabel === 'Wait' ? 'No trade — stand aside' : `${ai.actionLabel} · ${ai.sessionBias} bias`}
              </h2>
            </div>
            <div className="chip-row">
              <span className="chip">{data.decisionMeta?.provider || 'ai'} · {data.decisionMeta?.model || 'model'}</span>
              {data.decisionMeta?.latencyMs ? <span className="chip">{(data.decisionMeta.latencyMs / 1000).toFixed(1)}s</span> : null}
              {data.decisionMeta?.cached ? <span className="chip">cached</span> : null}
              <span className="chip">conviction {ai.conviction}%</span>
            </div>
          </div>
          <div className="day-ai-grid">
            <div className="day-ai-copy">
              {ai.thesis && <p className="day-ai-thesis">{ai.thesis}</p>}
              {ai.reasons?.length > 0 && (
                <ul className="day-ai-list">
                  {ai.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              {ai.invalidation && <p className="option-note">Invalidation: {ai.invalidation}</p>}
              {ai.whatWouldChangeMyMind && (
                <p className="option-note">Would change the call: {ai.whatWouldChangeMyMind}</p>
              )}
            </div>
            <div className="day-ai-side">
              {ai.plan ? (
                <div className="day-plan-grid">
                  <Stat label="AI entry" value={money(ai.plan.entry)} />
                  <Stat label="AI stop" value={money(ai.plan.stopLoss)} tone="down" />
                  {ai.plan.targets.map((target) => (
                    <Stat
                      key={target.label}
                      label={`${target.label} · ${target.rMultiple}R`}
                      value={`${money(target.price)} (${pct(target.movePct, 1)})`}
                      tone="up"
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-note">
                  The desk is flat today — no entry, stop and target to publish. The levels in the trade plan panel are the ones it would
                  need to see traded.
                </div>
              )}
              {ai.catalysts?.length > 0 && (
                <div className="day-catalysts">
                  {ai.catalysts.slice(0, 5).map((catalyst, index) => (
                    <div key={`${catalyst.detail}-${index}`} className={`catalyst ${catalyst.direction}`}>
                      <span className="catalyst-tag">{catalyst.type}</span>
                      <span>{catalyst.detail}</span>
                    </div>
                  ))}
                </div>
              )}
              {ai.risks?.length > 0 && (
                <ul className="risk-list tight">
                  {ai.risks.slice(0, 4).map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {context && (
        <section className="panel day-context-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">FULL CONTEXT</div>
              <h2>Everything behind the {data.symbol} call</h2>
            </div>
            <span className="muted small">Daily regime · news · events · option positioning · fundamentals</span>
          </div>
          <div className="day-context-grid">
            <div className="context-block">
              <h3>Daily regime</h3>
              {daily ? (
                <div className="day-level-grid">
                  <Stat label="Verdict" value={daily.verdict || '—'} hint={daily.action ? `Engine alert: ${daily.action}` : ''} />
                  <Stat label="Quality" value={daily.score ?? '—'} />
                  <Stat label="Trend" value={dailyTrend || '—'} tone={dailyTrend === 'Up' ? 'up' : dailyTrend === 'Down' ? 'down' : ''} />
                  <Stat label="50-day" value={money(daily.sma50)} />
                  <Stat label="200-day" value={money(daily.sma200)} />
                  <Stat label="RSI (14)" value={daily.rsi14 ?? '—'} tone={daily.rsi14 > 70 ? 'down' : daily.rsi14 < 30 ? 'up' : ''} />
                  <Stat label="ADX (14)" value={daily.adx14 ?? '—'} />
                  <Stat label="Daily ATR" value={`${daily.atrPct ?? '—'}%`} />
                  <Stat label="Support" value={money(daily.nearestSupport)} />
                  <Stat label="Resistance" value={money(daily.nearestResistance)} />
                  <Stat label="Daily stop" value={money(daily.stopLoss)} tone="down" />
                </div>
              ) : (
                <p className="muted small">Daily history unavailable for this symbol right now.</p>
              )}
            </div>

            <div className="context-block">
              <h3>News &amp; events</h3>
              {context.event && <p className="context-line">{context.event.label}</p>}
              {context.news ? (
                <>
                  <p className="context-line">
                    Flow reads <strong>{context.news.label}</strong> ({context.news.sentiment > 0 ? '+' : ''}
                    {context.news.sentiment}) across {context.news.headlineCount} headlines.
                  </p>
                  <ul className="context-list">
                    {(context.news.headlines || []).slice(0, 6).map((headline, index) => (
                      <li key={`${headline.title}-${index}`}>
                        <span className={`catalyst-tag ${headline.direction}`}>{headline.direction}</span> {headline.title}
                      </li>
                    ))}
                  </ul>
                  {context.news.deals?.length > 0 && (
                    <p className="context-line">
                      Deals tracked: {context.news.deals.map((deal) => deal.title).join(' · ')}
                    </p>
                  )}
                </>
              ) : (
                <p className="muted small">No headline flow available for this symbol.</p>
              )}
            </div>

            <div className="context-block">
              <h3>Option positioning</h3>
              {context.options ? (
                <div className="day-level-grid">
                  <Stat label="Expiry" value={context.options.expiration} />
                  <Stat label="ATM IV" value={`${context.options.atmIv ?? '—'}%`} />
                  <Stat label="IV state" value={context.options.ivState} tone={context.options.ivState === 'rich' ? 'down' : 'up'} />
                  <Stat label="Expected move" value={`±${context.options.expectedMovePct ?? '—'}%`} />
                  <Stat label="Range" value={`${money(context.options.expectedLow)} – ${money(context.options.expectedHigh)}`} />
                  <Stat label="Max pain" value={money(context.options.maxPain)} />
                  <Stat label="P/C OI" value={context.options.pcrOi ?? '—'} />
                  <Stat label="Positioning" value={context.options.positioning} />
                </div>
              ) : (
                <p className="muted small">No listed option chain for this symbol — trade the shares only.</p>
              )}
            </div>

            <div className="context-block">
              <h3>Fundamentals</h3>
              {context.fundamentals ? (
                <div className="day-level-grid">
                  <Stat label="Sector" value={context.fundamentals.sector || '—'} />
                  <Stat label="Trailing P/E" value={context.fundamentals.trailingPE?.toFixed?.(1) ?? '—'} />
                  <Stat label="Forward P/E" value={context.fundamentals.forwardPE?.toFixed?.(1) ?? '—'} />
                  <Stat label="Street target" value={money(context.fundamentals.analystTarget)} />
                  <Stat
                    label="Revenue growth"
                    value={context.fundamentals.revenueGrowth !== null ? pct(context.fundamentals.revenueGrowth * 100, 1) : '—'}
                  />
                  <Stat
                    label="Earnings growth"
                    value={context.fundamentals.earningsGrowth !== null ? pct(context.fundamentals.earningsGrowth * 100, 1) : '—'}
                  />
                  <Stat
                    label="Profit margin"
                    value={context.fundamentals.profitMargin !== null ? pct(context.fundamentals.profitMargin * 100, 1, false) : '—'}
                  />
                </div>
              ) : (
                <p className="muted small">No fundamentals on file for this symbol.</p>
              )}
            </div>
          </div>
        </section>
      )}

      <div className="dashboard-footnote">
        Educational intraday read, not investment advice. 5-minute signals are noisy and can flip quickly; use the stop and size
        positions to your own risk budget.
      </div>
    </div>
  );
}
