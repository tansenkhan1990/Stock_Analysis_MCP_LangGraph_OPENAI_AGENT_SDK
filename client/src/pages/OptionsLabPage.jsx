import { useCallback, useEffect, useMemo, useState } from 'react';
import PayoffChart from '../components/PayoffChart.jsx';
import SearchBox from '../components/SearchBox.jsx';
import Stat from '../components/Stat.jsx';
import { api } from '../lib/api.js';
import { compact, expiryLabel, money, num, pct } from '../lib/format.js';

const nearest = (contracts, target, side = 'nearest') =>
  [...(contracts || [])]
    .filter((contract) => contract.strike > 0 && (contract.mid > 0 || contract.lastPrice > 0))
    .sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))
    .filter((contract) => {
      if (side === 'above') return contract.strike >= target;
      if (side === 'below') return contract.strike <= target;
      return true;
    })[0] || null;

const toLeg = (contract, kind, action) => ({
  kind,
  action,
  strike: contract.strike,
  premium: contract.mid || contract.lastPrice || 0,
  iv: contract.impliedVolatility,
  qty: 1,
  contractSymbol: contract.contractSymbol,
});

const PRESETS = [
  {
    id: 'long-call',
    label: 'Long call',
    build: (chain) => {
      const call = nearest(chain.calls, chain.spot);
      return call ? [toLeg(call, 'call', 'buy')] : [];
    },
  },
  {
    id: 'bull-call',
    label: 'Bull call spread',
    build: (chain) => {
      const long = nearest(chain.calls, chain.spot, 'above');
      const short = nearest(chain.calls, chain.spot * 1.06, 'above');
      return long && short && short.strike > long.strike ? [toLeg(long, 'call', 'buy'), toLeg(short, 'call', 'sell')] : [];
    },
  },
  {
    id: 'long-put',
    label: 'Long put',
    build: (chain) => {
      const put = nearest(chain.puts, chain.spot);
      return put ? [toLeg(put, 'put', 'buy')] : [];
    },
  },
  {
    id: 'bear-put',
    label: 'Bear put spread',
    build: (chain) => {
      const long = nearest(chain.puts, chain.spot, 'below');
      const short = nearest(chain.puts, chain.spot * 0.94, 'below');
      return long && short && short.strike < long.strike ? [toLeg(long, 'put', 'buy'), toLeg(short, 'put', 'sell')] : [];
    },
  },
  {
    id: 'bull-put',
    label: 'Bull put spread',
    build: (chain) => {
      const short = nearest(chain.puts, chain.spot * 0.97, 'below');
      const long = nearest(chain.puts, chain.spot * 0.92, 'below');
      return short && long && long.strike < short.strike ? [toLeg(short, 'put', 'sell'), toLeg(long, 'put', 'buy')] : [];
    },
  },
  {
    id: 'iron-condor',
    label: 'Iron condor',
    build: (chain) => {
      const shortPut = nearest(chain.puts, chain.spot * 0.95, 'below');
      const longPut = nearest(chain.puts, chain.spot * 0.9, 'below');
      const shortCall = nearest(chain.calls, chain.spot * 1.05, 'above');
      const longCall = nearest(chain.calls, chain.spot * 1.1, 'above');
      if (!shortPut || !longPut || !shortCall || !longCall) return [];
      return [
        toLeg(longPut, 'put', 'buy'),
        toLeg(shortPut, 'put', 'sell'),
        toLeg(shortCall, 'call', 'sell'),
        toLeg(longCall, 'call', 'buy'),
      ];
    },
  },
];

export default function OptionsLabPage({ symbol, go }) {
  const [chain, setChain] = useState(null);
  const [expiration, setExpiration] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [legs, setLegs] = useState([]);
  const [ivPct, setIvPct] = useState(30);
  const [dte, setDte] = useState(30);
  const [metrics, setMetrics] = useState(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState('');
  const [aiPlan, setAiPlan] = useState(null);
  const [aiNote, setAiNote] = useState('');
  const [ideas, setIdeas] = useState([]);
  const [ideasLoading, setIdeasLoading] = useState(true);

  const loadChain = useCallback(
    async (expiry) => {
      setLoading(true);
      setError('');
      try {
        const data = await api.chain(symbol, expiry || undefined);
        setChain(data);
        setExpiration(data.expiration);
        setDte(data.summary?.dte ?? 30);
        if (data.summary?.atmIv) setIvPct(data.summary.atmIv);
      } catch (err) {
        setError(err.message);
        setChain(null);
      } finally {
        setLoading(false);
      }
    },
    [symbol],
  );

  useEffect(() => {
    setLegs([]);
    setMetrics(null);
    setAiPlan(null);
    setAiNote('');
    loadChain('');
    api
      .analysis(symbol)
      .then((analysis) => {
        const plan = analysis.options?.plans?.[0];
        if (plan) setAiPlan({ plan, analysis });
      })
      .catch(() => setAiPlan(null));
    setIdeasLoading(true);
    api
      .optionsIdeas()
      .then((data) => setIdeas(data.ideas || []))
      .catch(() => setIdeas([]))
      .finally(() => setIdeasLoading(false));
  }, [symbol, loadChain]);

  useEffect(() => {
    if (!legs.length) {
      setMetrics(null);
      return undefined;
    }
    const controller = { cancelled: false };
    setEvaluating(true);
    setEvalError('');
    const timer = setTimeout(async () => {
      try {
        const payload = {
          symbol,
          dte,
          iv: ivPct / 100,
          legs: legs.map((leg) => ({
            kind: leg.kind,
            action: leg.action,
            strike: leg.strike,
            premium: leg.premium,
            qty: leg.qty,
            iv: leg.iv,
          })),
        };
        const result = await api.evaluate(payload);
        if (!controller.cancelled) setMetrics(result);
      } catch (err) {
        if (!controller.cancelled) {
          setEvalError(err.message);
          setMetrics(null);
        }
      } finally {
        if (!controller.cancelled) setEvaluating(false);
      }
    }, 220);
    return () => {
      controller.cancelled = true;
      clearTimeout(timer);
    };
  }, [legs, ivPct, dte, symbol]);

  const rows = useMemo(() => {
    if (!chain) return [];
    const spot = chain.spot;
    const strikes = [...new Set([...chain.calls, ...chain.puts].map((contract) => contract.strike))]
      .filter((strike) => Math.abs(strike - spot) / spot <= 0.15)
      .sort((a, b) => a - b);
    const byCall = new Map(chain.calls.map((contract) => [contract.strike, contract]));
    const byPut = new Map(chain.puts.map((contract) => [contract.strike, contract]));
    return strikes.map((strike) => ({ strike, call: byCall.get(strike), put: byPut.get(strike) }));
  }, [chain]);

  const applyPreset = (preset) => {
    if (!chain) return;
    const next = preset.build(chain);
    if (!next.length) {
      setEvalError('Not enough liquid strikes for that preset.');
      return;
    }
    setEvalError('');
    setAiNote('');
    setLegs(next);
  };

  const applyAiPlan = () => {
    if (!aiPlan) return;
    const { plan } = aiPlan;
    setLegs(
      plan.legs.map((leg) => ({
        kind: leg.kind,
        action: leg.action,
        strike: leg.strike,
        premium: leg.premium,
        iv: leg.iv,
        qty: leg.qty || 1,
        contractSymbol: leg.contractSymbol,
      })),
    );
    setDte(plan.dte);
    setAiNote(`Loaded ${plan.name} from the MarketPilot engine (${plan.expiration}).`);
  };

  const applyIdea = (idea) => {
    setLegs(
      idea.plan.legs.map((leg) => ({
        kind: leg.kind,
        action: leg.action,
        strike: leg.strike,
        premium: leg.premium,
        iv: leg.iv,
        qty: leg.qty || 1,
        contractSymbol: leg.contractSymbol,
      })),
    );
    if (idea.dte) setDte(idea.dte);
    if (idea.atmIv) setIvPct(idea.atmIv);
    setAiNote(`${idea.symbol} ${idea.plan.name} loaded — expiry ${idea.expiration}, IV ${idea.atmIv}%.`);
  };

  const addContract = (contract, kind) => {
    if (!contract) return;
    setLegs((current) => [...current, toLeg(contract, kind, 'buy')]);
    setAiNote('');
  };

  const updateLeg = (index, patch) => {
    setLegs((current) => current.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)));
  };

  const removeLeg = (index) => {
    setLegs((current) => current.filter((_, i) => i !== index));
  };

  const summary = chain?.summary;
  const spot = chain?.spot ?? 0;

  return (
    <div className="page options-lab">
      <section className="page-head">
        <div>
          <div className="eyebrow">OPTIONS LAB</div>
          <h1>
            {symbol} <span className="muted">option chain</span>
          </h1>
          <p className="page-sub">
            Read the volatility surface, then build and stress-test defined-risk structures before you send an order.
          </p>
        </div>
        <div className="head-actions">
          <SearchBox compact onSelect={(next) => go(`/options/${next}`)} placeholder="Ticker…" />
          <button type="button" className="btn btn-primary" onClick={() => go(`/analyze/${symbol}`)}>
            Full analysis
          </button>
        </div>
      </section>

      <section className="panel chain-controls">
        <div className="control">
          <label htmlFor="expiration">Expiration</label>
          <select
            id="expiration"
            value={expiration}
            onChange={(event) => {
              const next = event.target.value;
              setExpiration(next);
              setLegs([]);
              setMetrics(null);
              loadChain(next);
            }}
            disabled={loading}
          >
            {(chain?.expirations || []).map((date) => (
              <option key={date} value={date}>
                {expiryLabel(date)}
              </option>
            ))}
          </select>
        </div>
        <div className="control">
          <label>Spot</label>
          <div className="control-value mono">{money(spot)}</div>
        </div>
        <div className="control">
          <label>DTE</label>
          <div className="control-value mono">{summary?.dte ?? dte}</div>
        </div>
        {summary && (
          <>
            <div className="control">
              <span className="control-label">ATM IV</span>
              <div className="control-value mono">{summary.atmIv ?? '—'}%</div>
            </div>
            <div className="control">
              <span className="control-label">IV state</span>
              <div className={`control-value ${summary.ivState === 'rich' ? 'down' : summary.ivState === 'cheap' ? 'up' : ''}`}>
                {summary.ivState}
              </div>
            </div>
            <div className="control">
              <span className="control-label">Expected move</span>
              <div className="control-value mono">
                ±{summary.expectedMovePct ?? '—'}%
              </div>
            </div>
            <div className="control">
              <span className="control-label">Max pain</span>
              <div className="control-value mono">{money(summary.maxPain, 0)}</div>
            </div>
            <div className="control">
              <span className="control-label">P/C OI</span>
              <div className="control-value mono">{num(summary.pcrOi)}</div>
            </div>
            <div className="control">
              <span className="control-label">Liquidity</span>
              <div className="control-value mono">{summary.liquidity}%</div>
            </div>
          </>
        )}
      </section>

      {ideasLoading && !ideas.length && (
        <section className="panel ideas-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">AI OPTIONS IDEAS</div>
              <h2>Scanning your watchlist…</h2>
            </div>
            <span className="muted small">Scoring each name and pricing its best defined-risk structure</span>
          </div>
          <div className="ideas-grid">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="idea-card skeleton-card" />
            ))}
          </div>
        </section>
      )}

      {ideas.length > 0 && (
        <section className="panel ideas-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">AI OPTIONS IDEAS</div>
              <h2>Best defined-risk structure per name</h2>
            </div>
            <span className="muted small">Only structures that match the alert · loads into the builder</span>
          </div>
          <div className="ideas-grid">
            {ideas.map((idea) => (
              <div key={idea.symbol} className="idea-card">
                <div className="idea-head">
                  <strong className="mono">{idea.symbol}</strong>
                  <span className={`signal-pill ${idea.action || idea.signal}`}>
                    {idea.actionLabel}
                  </span>
                  {idea.setupLabel && <span className="setup-chip">{idea.setupLabel}</span>}
                  <span className="muted small">{idea.score}/100 quality</span>
                </div>
                <div className="idea-name">{idea.plan.name}</div>
                <div className="idea-stats">
                  <Stat label="IV state" value={idea.ivState} tone={idea.ivState === 'rich' ? 'down' : 'up'} />
                  <Stat label="Exp. move" value={`±${idea.expectedMovePct ?? '—'}%`} />
                  <Stat label={idea.plan.isCredit ? 'Net credit' : 'Net debit'} value={money(Math.abs(idea.plan.netPremium), 0)} />
                  <Stat label="Max loss" value={money(Math.abs(idea.plan.maxLoss), 0)} tone="down" />
                  <Stat label="Est. PoP" value={idea.plan.probabilityOfProfit !== null ? `${idea.plan.probabilityOfProfit}%` : '—'} />
                  <Stat label="Expiry" value={expiryLabel(idea.expiration)} />
                </div>
                <button type="button" className="btn btn-mini wide" onClick={() => applyIdea(idea)}>
                  Load into builder
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="panel chain-loading">
          <div className="loading-orbit" />
          <p className="muted">Loading option chain…</p>
        </div>
      ) : (
        <div className="options-layout">
          <section className="panel chain-panel">
            <div className="panel-head">
              <div>
                <div className="eyebrow">CHAIN · {expiryLabel(chain?.expiration)}</div>
                <h2>Strikes around spot</h2>
              </div>
              <span className="muted small">Click + to add a leg</span>
            </div>

            <div className="table-wrap">
              <table className="chain-table">
                <thead>
                  <tr>
                    <th />
                    <th colSpan="4" className="call-head">
                      Calls
                    </th>
                    <th className="strike-head">Strike</th>
                    <th colSpan="4" className="put-head">
                      Puts
                    </th>
                    <th />
                  </tr>
                  <tr className="sub-head">
                    <th />
                    <th>Bid</th>
                    <th>Ask</th>
                    <th>IV</th>
                    <th>OI</th>
                    <th />
                    <th>OI</th>
                    <th>IV</th>
                    <th>Bid</th>
                    <th>Ask</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const atm = Math.abs(row.strike - spot) / spot < 0.005;
                    return (
                      <tr key={row.strike} className={atm ? 'atm-row' : ''}>
                        <td>
                          <button type="button" className="icon-btn add" onClick={() => addContract(row.call, 'call')} title="Add call leg">
                            +
                          </button>
                        </td>
                        <td className={`mono ${row.call?.inTheMoney ? 'itm' : ''}`}>{row.call ? num(row.call.bid) : '—'}</td>
                        <td className="mono">{row.call ? num(row.call.ask) : '—'}</td>
                        <td className="mono">{row.call ? `${(row.call.impliedVolatility * 100).toFixed(0)}%` : '—'}</td>
                        <td className="mono">{row.call ? compact(row.call.openInterest) : '—'}</td>
                        <td className={`strike-cell mono ${atm ? 'atm' : ''}`}>
                          {row.strike}
                          {atm && <span className="atm-tag">ATM</span>}
                        </td>
                        <td className="mono">{row.put ? compact(row.put.openInterest) : '—'}</td>
                        <td className="mono">{row.put ? `${(row.put.impliedVolatility * 100).toFixed(0)}%` : '—'}</td>
                        <td className={`mono ${row.put?.inTheMoney ? 'itm' : ''}`}>{row.put ? num(row.put.bid) : '—'}</td>
                        <td className="mono">{row.put ? num(row.put.ask) : '—'}</td>
                        <td>
                          <button type="button" className="icon-btn add" onClick={() => addContract(row.put, 'put')} title="Add put leg">
                            +
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="chain-foot">
              <span>ITM shading · IV annualised · OI = open interest</span>
              <span className="muted">Quotes may be delayed</span>
            </div>
          </section>

          <aside className="panel builder-panel">
            <div className="panel-head">
              <div>
                <div className="eyebrow">STRATEGY BUILDER</div>
                <h2>Legs & payoff</h2>
              </div>
              {legs.length > 0 && (
                <button type="button" className="btn btn-mini" onClick={() => setLegs([])}>
                  Clear
                </button>
              )}
            </div>

            {aiPlan && (
              <button type="button" className="ai-plan-button" onClick={applyAiPlan}>
                <span>✦</span>
                <span>
                  Use AI structure
                  <small>{aiPlan.plan.name} · {aiPlan.plan.dte} DTE</small>
                </span>
              </button>
            )}
            {aiNote && <div className="alert alert-success tiny">{aiNote}</div>}

            <div className="preset-grid">
              {PRESETS.map((preset) => (
                <button key={preset.id} type="button" className="preset-btn" onClick={() => applyPreset(preset)}>
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="builder-inputs">
              <label>
                IV
                <div className="input-suffix">
                  <input
                    type="number"
                    min="5"
                    max="200"
                    value={ivPct}
                    onChange={(event) => setIvPct(Number(event.target.value))}
                  />
                  <span>%</span>
                </div>
              </label>
              <label>
                DTE
                <input type="number" min="1" max="730" value={dte} onChange={(event) => setDte(Number(event.target.value))} />
              </label>
            </div>

            <div className="leg-editor">
              {legs.map((leg, index) => (
                <div key={index} className="leg-row">
                  <div className="leg-row-top">
                    <select value={leg.action} onChange={(event) => updateLeg(index, { action: event.target.value })}>
                      <option value="buy">Buy</option>
                      <option value="sell">Sell</option>
                    </select>
                    <span className={`leg-kind ${leg.kind}`}>{leg.kind.toUpperCase()}</span>
                    <input
                      type="number"
                      className="strike-input"
                      value={leg.strike}
                      onChange={(event) => updateLeg(index, { strike: Number(event.target.value) })}
                      title="Strike"
                    />
                    <span className="leg-at">@</span>
                    <input
                      type="number"
                      step="0.01"
                      className="premium-input"
                      value={leg.premium}
                      onChange={(event) => updateLeg(index, { premium: Number(event.target.value) })}
                      title="Premium"
                    />
                    <input
                      type="number"
                      className="qty-input"
                      min="1"
                      value={leg.qty}
                      onChange={(event) => updateLeg(index, { qty: Math.max(1, Number(event.target.value)) })}
                      title="Quantity"
                    />
                    <button type="button" className="icon-btn" onClick={() => removeLeg(index)} title="Remove leg">
                      ×
                    </button>
                  </div>
                </div>
              ))}
              {!legs.length && (
                <div className="empty-note">
                  Add contracts from the chain or pick a preset. Every leg uses the mid price by default — edit the premium to match your fill.
                </div>
              )}
            </div>

            {evalError && <div className="alert alert-error tiny">{evalError}</div>}

            {metrics ? (
              <>
                <div className="metric-grid">
                  <Stat label={metrics.isCredit ? 'Net credit' : 'Net debit'} value={money(Math.abs(metrics.netPremium), 0)} />
                  <Stat label="Max profit" value={metrics.maxProfitUnbounded ? 'Unlimited' : money(metrics.maxProfit, 0)} tone="up" />
                  <Stat label="Max loss" value={money(Math.abs(metrics.maxLoss), 0)} tone="down" />
                  <Stat label="Return on risk" value={metrics.returnOnRisk ? `${metrics.returnOnRisk}×` : '—'} />
                  <Stat label="Breakeven" value={metrics.breakevens.map((value) => money(value)).join(' / ') || '—'} />
                  <Stat label="Est. PoP" value={metrics.probabilityOfProfit !== null ? `${metrics.probabilityOfProfit}%` : '—'} />
                  <Stat label="Delta" value={num(metrics.greeks.delta, 2)} />
                  <Stat label="Theta / day" value={money(metrics.greeks.theta, 2)} />
                  {metrics.stockCost ? <Stat label="Stock cost" value={money(metrics.stockCost, 0)} /> : null}
                  <Stat label="Vega" value={num(metrics.greeks.vega, 2)} />
                </div>
                <PayoffChart curve={metrics.curve} breakevens={metrics.breakevens} spot={spot} height={210} />
                <p className="builder-disclaimer">
                  Expiry P/L per contract. Fees, commissions and early assignment are excluded.
                </p>
              </>
            ) : (
              <div className="empty-note">{evaluating ? 'Evaluating…' : 'Your payoff diagram will appear here.'}</div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
