import { useCallback, useEffect, useState } from 'react';
import CandleChart from '../components/CandleChart.jsx';
import PayoffChart from '../components/PayoffChart.jsx';
import ScoreRing from '../components/ScoreRing.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { api } from '../lib/api.js';
import {
  bigNumber,
  money,
  num,
  pct,
  scoreTone,
  shortDate,
  timeAgo,
  toneForChange,
} from '../lib/format.js';

const ScoreBar = ({ component }) => {
  const tone = scoreTone(component.score);
  return (
    <div className="score-row" title={component.notes?.join('\n')}>
      <div className="score-row-head">
        <span>{component.label}</span>
        <span className="mono">
          {Math.round(component.score)} <span className="muted">/ 100 · {component.weight}%</span>
        </span>
      </div>
      <div className="meter">
        <div className={`meter-fill ${tone}`} style={{ width: `${Math.min(100, component.score)}%` }} />
      </div>
      {component.notes?.[0] && <div className="score-note">{component.notes[0]}</div>}
    </div>
  );
};

const Stat = ({ label, value, tone, hint }) => (
  <div className="stat" title={hint || ''}>
    <span className="stat-label">{label}</span>
    <span className={`stat-value ${tone || ''}`}>{value}</span>
  </div>
);

function TargetLadder({ analysis }) {
  const { plan } = analysis;
  const price = analysis.price;
  const targets = plan.targets || [];
  const scaleMax = Math.max(price, ...targets.map((target) => target.price)) * 1.01;
  const scaleMin = Math.min(price, plan.stopLoss || price) * 0.99;
  const width = (value) => `${Math.max(4, ((value - scaleMin) / (scaleMax - scaleMin || 1)) * 100)}%`;

  return (
    <div className="target-ladder">
      <div className="ladder-axis">
        <span className="mono">{money(scaleMin, 0)}</span>
        <span className="mono">{money(price, 0)} now</span>
        <span className="mono">{money(scaleMax, 0)}</span>
      </div>
      <div className="ladder-track">
        <div className="ladder-zone" style={{ left: width(plan.buyZone?.low ?? plan.stopLoss), width: `calc(${width(plan.buyZone?.high ?? price)} - ${width(plan.buyZone?.low ?? plan.stopLoss)})` }} />
        <div className="ladder-spot" style={{ left: width(price) }} />
      </div>
      <div className="ladder-targets">
        {targets.map((target) => (
          <div key={target.label} className="ladder-target">
            <div className="ladder-target-top">
              <span className={`target-badge ${target.label.toLowerCase()}`}>{target.label}</span>
              <strong className="mono">{money(target.price)}</strong>
              <span className={`mono ${plan.direction === 'long' ? 'up' : 'down'}`}>
                {plan.direction === 'long' ? '+' : '−'}
                {target.upsidePct}%
              </span>
            </div>
            <div className="target-meter">
              <div style={{ width: width(target.price) }} />
            </div>
            <div className="ladder-target-bottom">
              <span>{target.source}</span>
              <span>{target.probability}% est. probability</span>
            </div>
          </div>
        ))}
        <div className="ladder-target stop">
          <div className="ladder-target-top">
            <span className="target-badge stop">STOP</span>
            <strong className="mono down">{money(plan.stopLoss)}</strong>
            <span className="muted small">invalidation</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AnalyzerPage({ symbol, go }) {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [showSma, setShowSma] = useState(true);
  const [showRsi, setShowRsi] = useState(true);
  const [optionIndex, setOptionIndex] = useState(0);

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError('');
      setSaved('');
      try {
        const data = await api.analysis(symbol, { refresh });
        setAnalysis(data);
        setOptionIndex(0);
      } catch (err) {
        setError(err.message);
        setAnalysis(null);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [symbol],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const save = async () => {
    setSaving(true);
    setSaved('');
    try {
      await api.analysis(symbol, { persist: true });
      setSaved('Analysis saved to research history.');
    } catch (err) {
      setSaved('');
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="page analyzer">
        <div className="analyzer-loading">
          <div className="loading-orbit" />
          <h2>Running the MarketPilot engine on {symbol}…</h2>
          <p className="muted">Fetching 2 years of prices, fundamentals, options chain and news.</p>
        </div>
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="page">
        <div className="analyzer-search-panel panel">
          <h1>Analyze a stock or ETF</h1>
          <p className="muted">Search a ticker or company name to generate a scored trade plan.</p>
          <SearchBox onSelect={(next) => go(`/analyze/${next}`)} autoFocus />
        </div>
        <div className="alert alert-error">
          <strong>Could not analyze {symbol}.</strong> {error}
        </div>
      </div>
    );
  }

  const { plan, indicators, score, levels, fundamentals, options } = analysis;
  const bullish = plan.direction === 'long';
  const optionPlans = options?.plans || [];
  const activePlan = optionPlans[optionIndex];
  const rangePosition = levels.rangePosition ?? 50;

  return (
    <div className="page analyzer">
      <div className="analyzer-toolbar">
        <SearchBox onSelect={(next) => go(`/analyze/${next}`)} placeholder={`Analyze another ticker (currently ${symbol})…`} />
        <div className="toolbar-actions">
          <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={refreshing}>
            <span className={refreshing ? 'spin' : ''}>↻</span> Refresh
          </button>
          <button type="button" className="btn btn-ghost" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save research'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => go(`/options/${symbol}`)}>
            Options Lab
          </button>
          <button type="button" className="btn btn-primary" onClick={() => go(`/agent?symbol=${symbol}`)}>
            ✦ Ask AI
          </button>
        </div>
      </div>

      {saved && <div className="alert alert-success">{saved}</div>}

      <section className="quote-header panel">
        <div className="quote-identity">
          <div className="quote-symbol-row">
            <h1>{analysis.symbol}</h1>
            <span className={`badge badge-type ${analysis.quoteType === 'ETF' ? 'etf' : ''}`}>{analysis.assetClass}</span>
            <span className="badge badge-exchange">{analysis.exchange || '—'}</span>
            {analysis.quote?.marketState && <span className="badge badge-state">{analysis.quote.marketState}</span>}
          </div>
          <div className="quote-name">{analysis.name}</div>
          <div className="quote-tags">
            {fundamentals?.sector && <span>{fundamentals.sector}</span>}
            {fundamentals?.industry && <span>{fundamentals.industry}</span>}
            {analysis.quote?.averageVolume && <span>Avg vol {bigNumber(analysis.quote.averageVolume)}</span>}
            <span>Updated {timeAgo(analysis.generatedAt)}</span>
          </div>
        </div>
        <div className="quote-price-block">
          <div className="quote-price">{money(analysis.price)}</div>
          <div className={`quote-change ${toneForChange(analysis.changePercent)}`}>
            {analysis.change > 0 ? '+' : ''}
            {num(analysis.change)} ({pct(analysis.changePercent)})
          </div>
          <div className="quote-range">
            <span>52w</span>
            <div className="range-bar">
              <div className="range-fill" style={{ width: `${rangePosition}%` }} />
              <div className="range-marker" style={{ left: `${rangePosition}%` }} />
            </div>
            <span className="mono">
              {money(levels.fiftyTwoWeekLow, 0)}–{money(levels.fiftyTwoWeekHigh, 0)}
            </span>
          </div>
        </div>
      </section>

      <div className="analyzer-grid">
        <div className="analyzer-main">
          <section className={`panel verdict-panel ${bullish ? 'bullish' : 'bearish'}`}>
            <div className="verdict-top">
              <div className="verdict-score">
                <ScoreRing score={score.total} label={score.label} confidence={score.confidence} size={148} />
              </div>
              <div className="verdict-copy">
                <div className="eyebrow">MARKETPILOT VERDICT</div>
                <div className="verdict-headline">
                  <span className={`signal-pill ${analysis.alert?.action ?? 'hold'}`}>
                    {analysis.alert?.actionLabel ?? 'Hold'}
                  </span>
                  {analysis.alert?.setupLabel && <span className="setup-chip">{analysis.alert.setupLabel}</span>}
                  <span className="muted small">{plan.horizon}</span>
                </div>
                <p className="verdict-lede">{analysis.alert?.reason || analysis.rationale[0]}</p>
                <div className="verdict-badges">
                  <span className={`score-chip ${scoreTone(score.total)}`}>{score.total}/100</span>
                  <span className="badge">{score.confidence}% confidence</span>
                  <span className="badge">{plan.riskReward ?? '—'}:1 R:R</span>
                  <span className="badge">{indicators.atrPct}% ATR</span>
                </div>
              </div>
            </div>

            <div className="plan-summary">
              <div className={`plan-card ${plan.buyZone ? '' : 'muted-card'}`}>
                <span className="plan-label">Accumulation zone</span>
                {plan.buyZone ? (
                  <>
                    <strong className="plan-value">
                      {money(plan.buyZone.low)} <span>–</span> {money(plan.buyZone.high)}
                    </strong>
                    <span className="plan-foot">Planned entry {money(plan.entryRef)}</span>
                  </>
                ) : (
                  <>
                    <strong className="plan-value muted">No long entry</strong>
                    <span className="plan-foot">
                      {plan.shortZone ? `Trim/short ${money(plan.shortZone.low)}–${money(plan.shortZone.high)}` : 'Wait for confirmation'}
                    </span>
                  </>
                )}
              </div>
              <div className="plan-card">
                <span className="plan-label">Primary target</span>
                <strong className="plan-value up">
                  {money(plan.targets[1]?.price ?? plan.targets[0]?.price)}
                  <span className="plan-upside">{pct(plan.targets[1]?.upsidePct ?? plan.targets[0]?.upsidePct)}</span>
                </strong>
                <span className="plan-foot">{plan.targets[1]?.source || plan.targets[0]?.source || '—'}</span>
              </div>
              <div className="plan-card">
                <span className="plan-label">Stop / invalidation</span>
                <strong className="plan-value down">{money(plan.stopLoss)}</strong>
                <span className="plan-foot">{plan.invalidation}</span>
              </div>
              <div className="plan-card">
                <span className="plan-label">1% risk sizing ($10k)</span>
                <strong className="plan-value">
                  {plan.riskBudgetExample?.shares ?? '—'} <span className="unit">shares</span>
                </strong>
                <span className="plan-foot">
                  {money(plan.riskPerShare)} risk/share · {money(plan.riskBudgetExample?.riskDollars, 0)} budget
                </span>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="eyebrow">TRADE PLAN</div>
                <h2>Target ladder</h2>
              </div>
              <div className="chip-row">
                <span className={`chip ${bullish ? 'long' : 'short'}`}>{bullish ? 'Long bias' : 'Short / avoid'}</span>
                <span className="chip">{plan.horizon}</span>
              </div>
            </div>
            <TargetLadder analysis={analysis} />
            <div className="plan-notes">
              {analysis.rationale.slice(1).map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
          </section>

          <section className="panel chart-panel">
            <div className="panel-head">
              <div>
                <div className="eyebrow">TECHNICALS</div>
                <h2>Price structure</h2>
              </div>
              <div className="chart-toggles">
                <label>
                  <input type="checkbox" checked={showSma} onChange={(event) => setShowSma(event.target.checked)} />
                  Moving averages
                </label>
                <label>
                  <input type="checkbox" checked={showRsi} onChange={(event) => setShowRsi(event.target.checked)} />
                  RSI
                </label>
              </div>
            </div>
            <CandleChart
              bars={analysis.chart.bars}
              overlays={analysis.chart.overlays}
              rsi={analysis.chart.rsi}
              levels={levels}
              showSma={showSma}
              showRsi={showRsi}
            />
            <div className="chart-foot">
              <span>180 sessions · daily</span>
              <span className="muted">Hover candles for OHLC</span>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="eyebrow">SCORE BREAKDOWN</div>
                <h2>Why this score</h2>
              </div>
              <span className="muted small">Weighted composite · 0–100</span>
            </div>
            <div className="score-list">
              {score.components.map((component) => (
                <ScoreBar key={component.key} component={component} />
              ))}
            </div>
          </section>

          <div className="two-col">
            <section className="panel">
              <div className="eyebrow">CONFIRMATION</div>
              <h2>Signal checklist</h2>
              <ul className="checklist">
                {analysis.checklist.map((item) => (
                  <li key={item.label} className={item.passed ? 'pass' : 'fail'}>
                    <span className="check-icon">{item.passed ? '✓' : '✕'}</span>
                    <span>{item.label}</span>
                    <span className="check-detail mono">{item.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="panel">
              <div className="eyebrow">RISK REVIEW</div>
              <h2>What could go wrong</h2>
              <ul className="risk-list">
                {analysis.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </section>
          </div>

          <section className="panel options-panel">
            <div className="panel-head">
              <div>
                <div className="eyebrow">OPTIONS EXPRESSION</div>
                <h2>Defined-risk structures</h2>
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => go(`/options/${symbol}`)}>
                Open chain →
              </button>
            </div>

            {options?.summary && (
              <div className="options-summary-strip">
                <Stat label="Expiry" value={analysis.options.expiration} hint="Target ~35 DTE" />
                <Stat label="ATM IV" value={`${options.summary.atmIv ?? '—'}%`} tone={options.summary.ivState === 'rich' ? 'down' : 'up'} hint="At-the-money implied volatility" />
                <Stat label="IV vs RV" value={`${options.summary.ivPremium ?? '—'}×`} hint={`${options.summary.ivState} vs 20d realised volatility`} />
                <Stat label="Expected move" value={`±${options.summary.expectedMovePct ?? '—'}%`} hint="One standard deviation to expiry" />
                <Stat label="Max pain" value={money(options.summary.maxPain, 0)} />
                <Stat label="Put/Call OI" value={num(options.summary.pcrOi)} />
              </div>
            )}

            {optionPlans.length ? (
              <>
                <div className="option-tabs">
                  {optionPlans.map((candidate, index) => (
                    <button
                      key={candidate.name}
                      type="button"
                      className={`option-tab ${index === optionIndex ? 'active' : ''}`}
                      onClick={() => setOptionIndex(index)}
                    >
                      {candidate.name}
                    </button>
                  ))}
                </div>
                {activePlan && (
                  <div className="option-plan-body">
                    <div className="option-plan-detail">
                      <p className="option-thesis">{activePlan.thesis}</p>
                      <div className="leg-list">
                        {activePlan.legs.map((leg, index) => (
                          <div key={index} className="leg-chip">
                            <span className={`leg-action ${leg.action}`}>{leg.action}</span>
                            <span>{leg.kind === 'stock' ? '100 shares' : `${leg.kind} ${money(leg.strike, 0)}`}</span>
                            {leg.kind !== 'stock' && <span className="mono muted">@ {money(leg.premium)}</span>}
                          </div>
                        ))}
                      </div>
                      <div className="option-metrics">
                        <Stat label={activePlan.metrics.isCredit ? 'Net credit' : 'Net debit'} value={money(Math.abs(activePlan.metrics.netPremium), 0)} />
                        <Stat label="Max profit" value={activePlan.metrics.maxProfitUnbounded ? 'Unlimited' : money(activePlan.metrics.maxProfit, 0)} tone="up" />
                        <Stat label="Max loss" value={money(Math.abs(activePlan.metrics.maxLoss), 0)} tone="down" />
                        <Stat label="Breakeven" value={activePlan.metrics.breakevens.map((value) => money(value)).join(' / ') || '—'} />
                        <Stat label="Est. PoP" value={`${activePlan.metrics.probabilityOfProfit ?? '—'}%`} />
                        <Stat label="Delta" value={num(activePlan.metrics.greeks.delta, 2)} />
                      </div>
                      <div className="option-note">{activePlan.riskNote}</div>
                    </div>
                    <div className="option-plan-chart">
                      <PayoffChart
                        curve={activePlan.metrics.curve}
                        breakevens={activePlan.metrics.breakevens}
                        spot={analysis.price}
                        height={220}
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="empty-note">
                {options?.error
                  ? `Options data unavailable: ${options.error}`
                  : 'No defined-risk structure fits the current signal and volatility regime.'}
              </div>
            )}
          </section>
        </div>

        <aside className="analyzer-rail">
          <section className="panel">
            <div className="eyebrow">KEY STATS</div>
            <div className="stat-grid">
              <Stat label="RSI (14)" value={num(indicators.rsi14, 1)} tone={indicators.rsi14 > 70 ? 'down' : indicators.rsi14 < 30 ? 'up' : ''} />
              <Stat label="ADX (14)" value={num(indicators.adx14, 1)} hint="Trend strength" />
              <Stat label="ATR %" value={`${indicators.atrPct}%`} />
              <Stat label="Ann. vol" value={indicators.annualizedVolatility ? `${indicators.annualizedVolatility}%` : '—'} />
              <Stat label="Beta" value={num(indicators.beta)} />
              <Stat label="Volume ratio" value={`${num((indicators.volumeRatio ?? 0) * 100, 0)}%`} hint="5d vs 50d average" />
              <Stat label="SMA 20" value={money(indicators.sma20)} />
              <Stat label="SMA 50" value={money(indicators.sma50)} />
              <Stat label="SMA 200" value={money(indicators.sma200)} />
              <Stat label="Max drawdown" value={`${indicators.maxDrawdown ?? '—'}%`} />
              <Stat label="Bollinger width" value={`${num(indicators.bollingerWidth, 1)}%`} />
              <Stat label="MACD hist" value={num(indicators.macdHistogram, 2)} tone={indicators.macdHistogram > 0 ? 'up' : 'down'} />
            </div>
          </section>

          <section className="panel">
            <div className="eyebrow">LEVELS</div>
            <h3 className="rail-title">Support & resistance</h3>
            <div className="level-list">
              {levels.resistances.slice(0, 3).map((level) => (
                <div key={`r-${level.price}`} className="level-row resistance">
                  <span className="level-price mono">{money(level.price)}</span>
                  <span>{level.source}</span>
                  <span className="muted small">R</span>
                </div>
              ))}
              <div className="level-now">
                <span className="mono">{money(analysis.price)}</span> spot
              </div>
              {levels.supports.slice(0, 3).map((level) => (
                <div key={`s-${level.price}`} className="level-row support">
                  <span className="level-price mono">{money(level.price)}</span>
                  <span>{level.source}</span>
                  <span className="muted small">S</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="eyebrow">PERFORMANCE</div>
            <table className="mini-table">
              <tbody>
                {[
                  ['1 week', analysis.performance.week],
                  ['1 month', analysis.performance.month],
                  ['3 months', analysis.performance.quarter],
                  ['6 months', analysis.performance.halfYear],
                  ['1 year', analysis.performance.year],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className={`mono ${toneForChange(value)}`}>{pct(value)}</td>
                  </tr>
                ))}
                <tr>
                  <td>vs SPY (3m)</td>
                  <td className={`mono ${toneForChange(analysis.performance.relativeStrength)}`}>
                    {pct(analysis.performance.relativeStrength)}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="panel">
            <div className="eyebrow">FUNDAMENTALS</div>
            {fundamentals ? (
              <table className="mini-table">
                <tbody>
                  {[
                    ['Market cap', analysis.quote?.marketCap ? bigNumber(analysis.quote.marketCap) : null, true],
                    ['P/E (ttm)', num(fundamentals.trailingPE ?? analysis.quote?.trailingPE, 1)],
                    ['Forward P/E', num(fundamentals.forwardPE ?? analysis.quote?.forwardPE, 1)],
                    ['PEG', num(fundamentals.pegRatio, 2)],
                    ['Price/Book', num(fundamentals.priceToBook, 2)],
                    ['Net margin', fundamentals.profitMargin !== null ? pct(fundamentals.profitMargin * 100, 1, false) : null],
                    ['Revenue growth', fundamentals.revenueGrowth !== null ? pct(fundamentals.revenueGrowth * 100, 1) : null],
                    ['ROE', fundamentals.returnOnEquity !== null ? pct(fundamentals.returnOnEquity * 100, 1) : null],
                    ['Debt/Equity', num(fundamentals.debtToEquity, 1)],
                    ['Dividend yield', analysis.quote?.dividendYield ? pct(analysis.quote.dividendYield * 100, 2, false) : null],
                    ['Analyst target', fundamentals.analystTarget ? money(fundamentals.analystTarget) : null],
                    ['Recommendation', fundamentals.recommendationMean ? `${num(fundamentals.recommendationMean, 2)} / 5` : null],
                    ['Expense ratio', fundamentals.expenseRatio !== undefined && fundamentals.expenseRatio !== null ? `${(fundamentals.expenseRatio * 100).toFixed(2)}%` : null],
                    ['Fund family', fundamentals.fundFamily],
                  ]
                    .filter(([, value]) => value !== null && value !== undefined && value !== '—')
                    .map(([label, value]) => (
                      <tr key={label}>
                        <td>{label}</td>
                        <td className="mono">{value}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <div className="empty-note">Fundamental data unavailable for this instrument.</div>
            )}
          </section>

          <section className="panel news-panel">
            <div className="eyebrow">NEWS FLOW</div>
            <h3 className="rail-title">Related headlines</h3>
            {analysis.news?.length ? (
              <div className="news-list">
                {analysis.news.slice(0, 5).map((item) => (
                  <a key={item.link || item.title} href={item.link} target="_blank" rel="noreferrer" className="news-item">
                    <span className="news-title">{item.title}</span>
                    <span className="news-meta">
                      {item.publisher} · {shortDate(item.publishedAt)}
                    </span>
                  </a>
                ))}
              </div>
            ) : (
              <div className="empty-note">No recent headlines.</div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
