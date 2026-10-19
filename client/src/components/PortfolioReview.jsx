import { useState } from 'react';
import { money, num, pct } from '../lib/format.js';

const ACTION_META = {
  exit: { label: 'Exit', tone: 'down', hint: 'Cut or hedge' },
  trim: { label: 'Trim', tone: 'warn', hint: 'Reduce size' },
  add: { label: 'Add', tone: 'up', hint: 'Room to build' },
  hold: { label: 'Hold', tone: 'flat', hint: 'Keep' },
  review: { label: 'Review', tone: 'muted', hint: 'Check the ticker' },
};

const toneFor = (value) => (Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat');

/**
 * Structured result of an uploaded portfolio: live totals, concentration,
 * and the specific action on every line. Rendered inside the agent chat so
 * the user sees the priced book — not only the model's prose about it.
 */
export default function PortfolioReview({ data }) {
  const [expanded, setExpanded] = useState(false);
  if (!data?.totals) return null;

  const { totals, concentration, exposure = [], flags = [], positions = [], warnings = [] } = data;
  const visible = expanded ? positions : positions.slice(0, 10);
  const actionable = positions.filter((row) => ['exit', 'trim', 'add'].includes(row.recommendation));
  const topSectors = exposure.slice(0, 3);

  return (
    <section className="pf-review">
      <header className="pf-head">
        <div className="pf-title">
          <span className="pf-file">📄 {data.fileName}</span>
          <span className="pf-sub">
            {totals.positions} position{totals.positions === 1 ? '' : 's'} · {totals.analysed} engine plan
            {totals.analysed === 1 ? '' : 's'} · live quotes
          </span>
        </div>
        <span className="pf-stamp">
          {new Date(data.generatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </header>

      <div className="pf-metrics">
        <div className="pf-metric">
          <span>Portfolio value</span>
          <strong>{money(totals.totalValue, 0)}</strong>
          <small>
            {money(totals.grossInvested, 0)} invested · {num(totals.cashPct, 1)}% cash
          </small>
        </div>
        <div className="pf-metric">
          <span>Unrealized P/L</span>
          <strong className={toneFor(totals.unrealizedPnl)}>
            {totals.unrealizedPnl === null ? '—' : money(totals.unrealizedPnl, 0)}
          </strong>
          <small className={toneFor(totals.unrealizedPnlPct)}>{pct(totals.unrealizedPnlPct)}</small>
        </div>
        <div className="pf-metric">
          <span>Today</span>
          <strong className={toneFor(totals.dayChange)}>{totals.dayChange === null ? '—' : money(totals.dayChange, 0)}</strong>
          <small className={toneFor(totals.dayChangePct)}>{pct(totals.dayChangePct)}</small>
        </div>
        <div className="pf-metric">
          <span>Largest position</span>
          <strong>{concentration.largest ?? '—'}</strong>
          <small>
            {num(concentration.top1Pct, 1)}% · top {Math.min(5, positions.length)} {num(concentration.top5Pct, 1)}%
          </small>
        </div>
      </div>

      {(topSectors.length > 0 || concentration.effectiveHoldings) && (
        <div className="pf-exposure">
          <span className="pf-exposure-label">Exposure</span>
          {topSectors.map((sector) => (
            <span key={sector.key} className="pf-chip">
              {sector.label} {num(sector.weightPct, 0)}%
            </span>
          ))}
          <span className="pf-chip muted">
            effective {num(concentration.effectiveHoldings, 1)} name
            {concentration.effectiveHoldings === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {flags.length > 0 && (
        <ul className="pf-flags">
          {flags.slice(0, 4).map((flag) => (
            <li key={flag.code} className={`pf-flag ${flag.severity}`}>
              <strong>{flag.title}</strong>
              <span>{flag.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="pf-table-wrap">
        <table className="pf-table">
          <thead>
            <tr>
              <th>Holding</th>
              <th className="num">Weight</th>
              <th className="num">P/L</th>
              <th>Call</th>
              <th className="num">Stop</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const meta = ACTION_META[row.recommendation] || ACTION_META.hold;
              return (
                <tr key={`${row.symbol}-${row.currency}`} title={row.recommendationReason}>
                  <td>
                    <strong>{row.symbol}</strong>
                    {row.name && row.name !== row.symbol && <span className="pf-name">{row.name}</span>}
                  </td>
                  <td className="num">{num(row.weightPct, 1)}%</td>
                  <td className={`num ${toneFor(row.unrealizedPnlPct)}`}>
                    {row.unrealizedPnl === null ? '—' : money(row.unrealizedPnl, 0)}
                    <span className="pf-pnl-pct">{pct(row.unrealizedPnlPct)}</span>
                  </td>
                  <td>
                    <span className={`pf-call ${String(row.call || 'none')}`}>{row.callLabel ?? '—'}</span>
                    {row.setupLabel && <span className="pf-setup">{row.setupLabel}</span>}
                  </td>
                  <td className="num">
                    {row.stopLoss === null ? '—' : money(row.stopLoss)}
                    {row.stopDistancePct !== null && (
                      <span className={`pf-stop-dist ${row.stopBreached ? 'down' : ''}`}>
                        {num(row.stopDistancePct, 1)}% away
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`pf-action ${meta.tone}`}>{meta.label}</span>
                    {row.trimShares ? (
                      <span className="pf-shares">
                        {row.recommendation === 'exit'
                          ? row.short
                            ? 'cover'
                            : 'sell'
                          : row.short
                            ? 'buy back'
                            : 'trim'}{' '}
                        {num(row.trimShares, 0)} sh
                      </span>
                    ) : (
                      <span className="pf-shares muted">{meta.hint}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {positions.length > 10 && (
        <button type="button" className="link-btn pf-more" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show fewer' : `Show all ${positions.length} positions`}
        </button>
      )}

      {actionable.length > 0 && (
        <div className="pf-notes">
          <div className="eyebrow">WHY</div>
          <ul>
            {actionable.slice(0, 5).map((row) => (
              <li key={row.symbol}>
                <strong>{row.symbol}</strong> — {row.recommendationReason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="pf-warnings">
          {warnings.slice(0, 3).map((warning) => (
            <div key={warning}>· {warning}</div>
          ))}
        </div>
      )}

      <p className="pf-foot">
        P/L is unrealized and excludes fees and taxes. Cash is included only when the export contains a cash row. Not investment
        advice.
      </p>
    </section>
  );
}
