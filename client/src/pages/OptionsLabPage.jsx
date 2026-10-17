import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCurrency } from '../components/CurrencyProvider.jsx';
import PayoffChart from '../components/PayoffChart.jsx';
import SearchBox from '../components/SearchBox.jsx';
import Stat from '../components/Stat.jsx';
import { api } from '../lib/api.js';
import { compact, expiryLabel, money, num, pct, usd } from '../lib/format.js';

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
  const { code, live } = useCurrency();
  const displayCode = code === 'USD' || !live ? 'USD' : code;
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
  const [desk, setDesk] = useState(null);
  const [deskError, setDeskError] = useState('');
  const [aiNote, setAiNote] = useState('');
  const [ideas, setIdeas] = useState([]);
  const [ideasSource, setIdeasSource] = useState('engine');
  const [ideasLoading, setIdeasLoading] = useState(true);
  const [ideasAiLoading, setIdeasAiLoading] = useState(false);

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
    setDesk(null);
    setDeskError('');
    setAiNote('');
    loadChain('');
    // The desk call is the AI buy/sell read for this symbol; the chain itself
    // stays mechanical so the page renders even while the model is thinking.
    api
      .optionsDesk(symbol)
      .then(setDesk)
      .catch((err) => setDeskError(err.message));
    setIdeasLoading(true);
    api
      .optionsIdeas()
      .then((data) => {
        setIdeas(data.ideas || []);
        setIdeasSource(data.source || 'engine');
      })
      .catch(() => setIdeas([]))
      .finally(() => setIdeasLoading(false));
  }, [symbol, loadChain]);

  const loadIdeas = useCallback(async (ai) => {
    if (ai) setIdeasAiLoading(true);
    else setIdeasLoading(true);
    setAiNote('');
    try {
      const data = await api.optionsIdeas(undefined, { ai });
      setIdeas(data.ideas || []);
      setIdeasSource(data.source || 'engine');
    } catch (err) {
      setAiNote(err.message);
    } finally {
      setIdeasAiLoading(false);
      setIdeasLoading(false);
    }
  }, []);

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

  const applyStructure = (structure, label) => {
    if (!structure?.legs?.length) return;
    setLegs(
      structure.legs.map((leg) => ({
        kind: leg.kind,
        action: leg.action,
        strike: leg.strike,
        premium: leg.premium,
        iv: leg.iv,
        qty: leg.qty || 1,
        contractSymbol: leg.contractSymbol,
      })),
    );
    if (structure.dte) setDte(structure.dte);
    setAiNote(`${structure.name} loaded into the builder${label ? ` (${label})` : ''}.`);
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
          <div className="control-value mono">
            {money(spot)}
            {displayCode !== 'USD' && <span className="muted small"> ({usd(spot)})</span>}
          </div>
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
              <div className="control-value mono">{usd(summary.maxPain, 0)}</div>
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

      {!desk && !deskError && (
        <section className="panel options-desk-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">AI OPTIONS DESK</div>
              <h2>Reading the chain and choosing a structure…</h2>
            </div>
            <span className="muted small">The model weighs the technical plan, IV state, positioning and event risk</span>
          </div>
          <div className="ideas-grid">
            {[0, 1].map((index) => (
              <div key={index} className="idea-card skeleton-card" />
            ))}
          </div>
        </section>
      )}

      {desk && (
        <section className={`panel options-desk-panel ${desk.decision?.action || 'hold'}`}>
          <div className="panel-head">
            <div>
              <div className="eyebrow">
                AI OPTIONS DESK · {expiryLabel(desk.expiration)} · {desk.dte} DTE
              </div>
              <h2>
                {desk.decision?.actionLabel} · {desk.decision?.optionBias} expression
              </h2>
            </div>
            <div className="chip-row">
              <span className="chip">
                {desk.source === 'ai'
                  ? `${desk.decisionMeta?.provider || 'ai'} · ${desk.decisionMeta?.model || 'model'}`
                  : 'engine-priced structure'}
              </span>
              <span className="chip">conviction {desk.decision?.conviction ?? '—'}%</span>
              {desk.decisionMeta?.cached && <span className="chip">cached</span>}
              {desk.decision?.agreesWithEngine === false && (
                <span className="chip warn">engine alert says {desk.engine?.actionLabel}</span>
              )}
            </div>
          </div>

          <div className="options-desk-grid">
            <div className="options-desk-copy">
              {desk.decision?.thesis && <p className="day-ai-thesis">{desk.decision.thesis}</p>}
              {desk.decision?.management && <p className="option-note">Management: {desk.decision.management}</p>}
              {desk.decision?.whatWouldChangeMyMind && (
                <p className="option-note">Would change the call: {desk.decision.whatWouldChangeMyMind}</p>
              )}
              {desk.decision?.risks?.length > 0 && (
                <ul className="risk-list tight">
                  {desk.decision.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              )}
              {desk.decision?.invalidations?.length > 0 && (
                <ul className="context-list">
                  {desk.decision.invalidations.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              {desk.decision?.catalysts?.length > 0 && (
                <div className="day-catalysts">
                  {desk.decision.catalysts.map((catalyst, index) => (
                    <div key={`${catalyst.detail}-${index}`} className={`catalyst ${catalyst.direction}`}>
                      <span className="catalyst-tag">{catalyst.type}</span>
                      <span>{catalyst.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="options-desk-structure">
              {desk.decision?.structure ? (
                <>
                  <div className="structure-head">
                    <strong>{desk.decision.structure.name}</strong>
                    <span className="chip">{desk.decision.structure.bias}</span>
                    <span className="muted small">
                      {desk.decision.structure.dte ?? desk.dte} DTE ·{' '}
                      {expiryLabel(desk.decision.structure.expiration || desk.expiration)}
                    </span>
                  </div>
                  <ul className="leg-list">
                    {desk.decision.structure.legs.map((leg, index) => (
                      <li key={`${leg.contractSymbol || leg.strike}-${index}`} className="leg-chip">
                        <span className={`leg-action ${leg.action}`}>{leg.action}</span>
                        <span>
                          {leg.kind.toUpperCase()} {usd(leg.strike)}
                        </span>
                        <span className="muted">@ {usd(leg.premium)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="metric-grid">
                    <Stat
                      label={desk.decision.structure.metrics.isCredit ? 'Net credit' : 'Net debit'}
                      value={usd(Math.abs(desk.decision.structure.metrics.netPremium), 0)}
                    />
                    <Stat
                      label="Max profit"
                      value={
                        desk.decision.structure.metrics.maxProfitUnbounded
                          ? 'Unlimited'
                          : usd(desk.decision.structure.metrics.maxProfit, 0)
                      }
                      tone="up"
                    />
                    <Stat label="Max loss" value={usd(Math.abs(desk.decision.structure.metrics.maxLoss), 0)} tone="down" />
                    <Stat
                      label="Breakeven"
                      value={(desk.decision.structure.metrics.breakevens || []).map((value) => usd(value)).join(' / ') || '—'}
                    />
                    <Stat
                      label="Est. PoP"
                      value={desk.decision.probabilityOfProfit !== null && desk.decision.probabilityOfProfit !== undefined ? `${desk.decision.probabilityOfProfit}%` : '—'}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-mini wide"
                    onClick={() =>
                      applyStructure(
                        desk.decision.structure,
                        desk.source === 'ai' ? desk.decisionMeta?.model : 'engine structure',
                      )
                    }
                  >
                    Load into builder
                  </button>
                </>
              ) : (
                <div className="empty-note">
                  {desk.decision?.structureNote ||
                    'No defined-risk structure expresses this call, so the desk is standing aside.'}
                </div>
              )}
            </div>
          </div>

          {desk.decisionError && <div className="alert alert-info tiny">{desk.decisionError}</div>}
          {desk.candidates?.length > 0 && (
            <p className="option-note">
              Structures priced for this expiry: {desk.candidates.map((candidate) => candidate.name).join(' · ')} — the desk picks
              the one that fits the call.
            </p>
          )}
        </section>
      )}

      {deskError && <div className="alert alert-error">AI options desk unavailable — {deskError}</div>}

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
              <div className="eyebrow">{ideasSource === 'ai' ? 'AI OPTIONS IDEAS' : 'ENGINE-SCANNED IDEAS'}</div>
              <h2>{ideasSource === 'ai' ? 'Model-picked structure per name' : 'Best defined-risk structure per name'}</h2>
            </div>
            <div className="head-actions">
              <span className="muted small">
                {ideasSource === 'ai'
                  ? 'The LLM options desk chose each structure · loads into the builder'
                  : 'Engine scan — run the AI desk to let the model decide'}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => loadIdeas(ideasSource !== 'ai')}
                disabled={ideasAiLoading || ideasLoading}
              >
                {ideasSource === 'ai' ? 'Use engine scan' : 'Run AI desk'}
              </button>
            </div>
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
                  {idea.source === 'ai' && <span className="badge ai-badge">✦ {idea.model || 'AI'}</span>}
                </div>
                <div className="idea-name">{idea.plan.name}</div>
                <div className="idea-stats">
                  <Stat label="IV state" value={idea.ivState} tone={idea.ivState === 'rich' ? 'down' : 'up'} />
                  <Stat label="Exp. move" value={`±${idea.expectedMovePct ?? '—'}%`} />
                  <Stat label={idea.plan.isCredit ? 'Net credit' : 'Net debit'} value={usd(Math.abs(idea.plan.netPremium), 0)} />
                  <Stat label="Max loss" value={usd(Math.abs(idea.plan.maxLoss), 0)} tone="down" />
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
                        <td className="mono">{row.call?.impliedVolatility != null ? `${(row.call.impliedVolatility * 100).toFixed(0)}%` : '—'}</td>
                        <td className="mono">{row.call ? compact(row.call.openInterest) : '—'}</td>
                        <td className={`strike-cell mono ${atm ? 'atm' : ''}`}>
                          {row.strike}
                          {atm && <span className="atm-tag">ATM</span>}
                        </td>
                        <td className="mono">{row.put ? compact(row.put.openInterest) : '—'}</td>
                        <td className="mono">{row.put?.impliedVolatility != null ? `${(row.put.impliedVolatility * 100).toFixed(0)}%` : '—'}</td>
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
              <span>ITM shading · IV annualised · OI = open interest · strikes, bid and ask in USD</span>
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

            {desk?.decision?.structure && (
              <button
                type="button"
                className="ai-plan-button"
                onClick={() =>
                  applyStructure(
                    desk.decision.structure,
                    desk.source === 'ai' ? desk.decisionMeta?.model : 'engine structure',
                  )
                }
              >
                <span>✦</span>
                <span>
                  Use {desk.source === 'ai' ? 'AI' : 'engine'} structure
                  <small>
                    {desk.decision.structure.name} · {desk.decision.structure.dte ?? desk.dte} DTE
                  </small>
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
                      title="Strike (USD)"
                    />
                    <span className="leg-at">@</span>
                    <input
                      type="number"
                      step="0.01"
                      className="premium-input"
                      value={leg.premium}
                      onChange={(event) => updateLeg(index, { premium: Number(event.target.value) })}
                      title="Premium (USD)"
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
                  <Stat label={metrics.isCredit ? 'Net credit' : 'Net debit'} value={usd(Math.abs(metrics.netPremium), 0)} />
                  <Stat label="Max profit" value={metrics.maxProfitUnbounded ? 'Unlimited' : usd(metrics.maxProfit, 0)} tone="up" />
                  <Stat label="Max loss" value={usd(Math.abs(metrics.maxLoss), 0)} tone="down" />
                  <Stat label="Return on risk" value={metrics.returnOnRisk ? `${metrics.returnOnRisk}×` : '—'} />
                  <Stat label="Breakeven" value={metrics.breakevens.map((value) => usd(value)).join(' / ') || '—'} />
                  <Stat label="Est. PoP" value={metrics.probabilityOfProfit !== null ? `${metrics.probabilityOfProfit}%` : '—'} />
                  <Stat label="Delta (per share)" value={num(metrics.greeks.delta, 2)} />
                  <Stat label="Theta / day (1 contract)" value={usd(metrics.greeks.theta * 100, 2)} />
                  {metrics.stockCost ? <Stat label="Stock cost" value={usd(metrics.stockCost, 0)} /> : null}
                  <Stat label="Vega (1 contract, per vol pt)" value={usd(metrics.greeks.vega * 100, 2)} />
                </div>
                <PayoffChart curve={metrics.curve} breakevens={metrics.breakevens} spot={spot} height={210} nativeCurrency />
                <p className="builder-disclaimer">
                  Expiry P/L per contract in USD. This desk quotes the US contract in USD (strikes, premiums and P/L); the stock spot above
                  is shown in {displayCode}, with the USD quote in brackets. Fees, commissions and early assignment are excluded.
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
