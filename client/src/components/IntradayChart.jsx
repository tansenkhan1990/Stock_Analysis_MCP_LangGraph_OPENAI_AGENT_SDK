import { useMemo } from 'react';
import { useCurrency } from './CurrencyProvider.jsx';
import { money } from '../lib/format.js';

const WIDTH = 1000;
const HEIGHT = 430;
const PRICE_TOP = 14;
const PRICE_BOTTOM = 296;
const VOL_TOP = 314;
const VOL_BOTTOM = 358;
const PAD_LEFT = 6;
const PAD_RIGHT = 76;

const TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
});

const timeLabel = (iso) => TIME.format(new Date(iso));
const dayLabel = (iso) => DAY.format(new Date(iso));

function linePath(values, xFor, yFor) {
  let path = '';
  let started = false;
  values.forEach((value, index) => {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      started = false;
      return;
    }
    path += `${started ? 'L' : 'M'}${xFor(index).toFixed(2)},${yFor(value).toFixed(2)} `;
    started = true;
  });
  return path.trim();
}

const fmtPrice = (value, digits = 2) => money(value, digits);

export default function IntradayChart({
  bars = [],
  overlays = {},
  levels = {},
  plan = null,
  action = 'wait',
  sessionStarts = [],
  height = 430,
}) {
  // Subscribe so price labels re-render when the display currency changes.
  useCurrency();

  const chart = useMemo(() => {
    if (!bars.length) return null;
    const levelValues = [
      levels.openingRangeHigh,
      levels.openingRangeLow,
      levels.priorClose,
      plan?.entry,
      plan?.stopLoss,
      ...(plan?.targets || []).map((target) => target.price),
    ].filter((value) => Number.isFinite(value));

    const priceValues = bars.flatMap((bar) => [bar.high, bar.low]);
    const overlayValues = [overlays.vwap, overlays.ema9, overlays.ema20]
      .flat()
      .filter((value) => Number.isFinite(value));

    const min = Math.min(...priceValues, ...overlayValues, ...levelValues);
    const max = Math.max(...priceValues, ...overlayValues, ...levelValues);
    const pad = (max - min) * 0.05 || 0.5;
    const low = min - pad;
    const high = max + pad;

    const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
    const step = plotWidth / bars.length;
    const bodyWidth = Math.max(1, step * 0.62);
    const xFor = (index) => PAD_LEFT + step * index + step / 2;
    const yFor = (price) => PRICE_BOTTOM - ((price - low) / (high - low || 1)) * (PRICE_BOTTOM - PRICE_TOP);

    const maxVolume = Math.max(...bars.map((bar) => bar.volume || 0), 1);
    const yVolume = (volume) => VOL_BOTTOM - (volume / maxVolume) * (VOL_BOTTOM - VOL_TOP);

    const gridPrices = Array.from({ length: 5 }, (_, index) => low + ((high - low) * index) / 4);
    const labelEvery = Math.max(1, Math.ceil(bars.length / 8));
    const last = bars[bars.length - 1];

    return {
      low,
      high,
      step,
      bodyWidth,
      xFor,
      yFor,
      yVolume,
      gridPrices,
      labelEvery,
      last,
      vwapPath: linePath(overlays.vwap || [], xFor, yFor),
      ema9Path: linePath(overlays.ema9 || [], xFor, yFor),
      ema20Path: linePath(overlays.ema20 || [], xFor, yFor),
    };
  }, [bars, overlays, levels, plan]);

  if (!chart) return <div className="chart-empty">No intraday data</div>;

  const { xFor, yFor, yVolume, gridPrices, labelEvery, last, step, bodyWidth } = chart;
  const inProfit = action === 'buy';
  const signalColor = action === 'buy' ? 'var(--up)' : action === 'sell' ? 'var(--down)' : 'var(--warn)';
  // The opening range only exists for the latest session — start those levels there.
  const latestSessionIndex = sessionStarts.filter((index) => index > 0).at(-1) ?? 0;
  const latestSessionX = xFor(latestSessionIndex) - step / 2;

  const levelLine = (value, color, label, dashed = true, fromX = PAD_LEFT) => {
    if (!Number.isFinite(value)) return null;
    return (
      <g key={`level-${label}-${value}`}>
        <line
          x1={fromX}
          x2={WIDTH - PAD_RIGHT}
          y1={yFor(value)}
          y2={yFor(value)}
          stroke={color}
          strokeWidth="1"
          strokeDasharray={dashed ? '5 4' : ''}
          opacity="0.75"
        />
        <text x={WIDTH - PAD_RIGHT + 5} y={yFor(value) + 3} className="chart-axis-label">
          {label} {fmtPrice(value)}
        </text>
      </g>
    );
  };

  return (
    <svg
      className="intraday-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      style={{ height }}
      preserveAspectRatio="none"
      role="img"
      aria-label="Intraday candlestick chart with VWAP, EMAs and trade levels"
    >
      <defs>
        <linearGradient id="intraday-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(56,189,248,0.08)" />
          <stop offset="100%" stopColor="rgba(56,189,248,0)" />
        </linearGradient>
      </defs>

      <rect x={PAD_LEFT} y={PRICE_TOP} width={WIDTH - PAD_LEFT - PAD_RIGHT} height={PRICE_BOTTOM - PRICE_TOP} fill="url(#intraday-fade)" />

      {Number.isFinite(levels.openingRangeHigh) && Number.isFinite(levels.openingRangeLow) && (
        <rect
          x={latestSessionX}
          y={yFor(levels.openingRangeHigh)}
          width={Math.max(0, WIDTH - PAD_RIGHT - latestSessionX)}
          height={Math.max(1, yFor(levels.openingRangeLow) - yFor(levels.openingRangeHigh))}
          fill="rgba(148,163,184,0.06)"
        />
      )}

      {gridPrices.map((price, index) => (
        <g key={`grid-${index}`}>
          <line
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={yFor(price)}
            y2={yFor(price)}
            stroke="rgba(148,163,184,0.10)"
            strokeDasharray="3 5"
          />
          <text x={WIDTH - PAD_RIGHT + 5} y={yFor(price) + 3.5} className="chart-axis-label">
            {fmtPrice(price, price > 100 ? 0 : 2)}
          </text>
        </g>
      ))}

      {levelLine(levels.openingRangeHigh, 'rgba(148,163,184,0.65)', 'ORH', true, latestSessionX)}
      {levelLine(levels.openingRangeLow, 'rgba(148,163,184,0.65)', 'ORL', true, latestSessionX)}
      {levelLine(levels.priorClose, 'rgba(226,232,240,0.4)', 'PDC')}
      {plan && levelLine(plan.entry, 'rgba(226,232,240,0.75)', 'ENTRY', false)}
      {plan && levelLine(plan.stopLoss, 'var(--down)', 'STOP')}
      {plan && (plan.targets || []).map((target) => levelLine(target.price, 'var(--up)', target.label, false))}

      <path d={chart.vwapPath} fill="none" stroke="#fbbf24" strokeWidth="1.6" strokeDasharray="6 4" opacity="0.9" />
      <path d={chart.ema9Path} fill="none" stroke="#38bdf8" strokeWidth="1.5" opacity="0.9" />
      <path d={chart.ema20Path} fill="none" stroke="#a78bfa" strokeWidth="1.5" opacity="0.85" />

      {bars.map((bar, index) => {
        const up = bar.close >= bar.open;
        const color = up ? 'var(--up)' : 'var(--down)';
        const x = xFor(index);
        const bodyTop = yFor(Math.max(bar.open, bar.close));
        const bodyBottom = yFor(Math.min(bar.open, bar.close));
        return (
          <g key={bar.date}>
            <line x1={x} x2={x} y1={yFor(bar.high)} y2={yFor(bar.low)} stroke={color} strokeWidth="1" opacity="0.8" />
            <rect
              x={x - bodyWidth / 2}
              y={bodyTop}
              width={bodyWidth}
              height={Math.max(1, bodyBottom - bodyTop)}
              fill={color}
              opacity="0.9"
            />
            <rect
              x={x - bodyWidth / 2}
              y={yVolume(bar.volume || 0)}
              width={bodyWidth}
              height={Math.max(1, VOL_BOTTOM - yVolume(bar.volume || 0))}
              fill={color}
              opacity="0.3"
            />
            <title>{`${timeLabel(bar.date)}  O ${fmtPrice(bar.open)} H ${fmtPrice(bar.high)} L ${fmtPrice(bar.low)} C ${fmtPrice(bar.close)}`}</title>
          </g>
        );
      })}

      {sessionStarts
        .filter((index) => index > 0 && index < bars.length)
        .map((index) => (
          <g key={`session-${index}`}>
            <line
              x1={xFor(index) - step / 2}
              x2={xFor(index) - step / 2}
              y1={PRICE_TOP}
              y2={VOL_BOTTOM}
              stroke="rgba(148,163,184,0.28)"
              strokeDasharray="4 4"
            />
            <text x={xFor(index) + step} y={PRICE_TOP + 10} className="chart-panel-label">
              {dayLabel(bars[index].date)}
            </text>
          </g>
        ))}

      {bars.map((bar, index) =>
        index % labelEvery === 0 || index === bars.length - 1 ? (
          <text key={`x-${bar.date}`} x={xFor(index)} y={HEIGHT - 22} textAnchor="middle" className="chart-axis-label">
            {timeLabel(bar.date)}
          </text>
        ) : null,
      )}

      {action !== 'wait' && (
        <g>
          <circle cx={xFor(bars.length - 1)} cy={yFor(last.close)} r="3.5" fill={signalColor} />
          <path
            d={
              inProfit
                ? `M${xFor(bars.length - 1) - 7},${yFor(last.close) + 14} L${xFor(bars.length - 1) + 7},${yFor(last.close) + 14} L${xFor(bars.length - 1)},${yFor(last.close) + 4} Z`
                : `M${xFor(bars.length - 1) - 7},${yFor(last.close) - 14} L${xFor(bars.length - 1) + 7},${yFor(last.close) - 14} L${xFor(bars.length - 1)},${yFor(last.close) - 4} Z`
            }
            fill={signalColor}
          />
        </g>
      )}

      <text x={PAD_LEFT + 4} y={VOL_TOP + 9} className="chart-panel-label">
        VOLUME
      </text>

      <g className="chart-legend">
        <line x1={WIDTH - 300} x2={WIDTH - 284} y1={22} y2={22} stroke="#fbbf24" strokeWidth="2" strokeDasharray="5 3" />
        <text x={WIDTH - 280} y={25} className="chart-axis-label">
          VWAP
        </text>
        <line x1={WIDTH - 220} x2={WIDTH - 204} y1={22} y2={22} stroke="#38bdf8" strokeWidth="2" />
        <text x={WIDTH - 200} y={25} className="chart-axis-label">
          EMA9
        </text>
        <line x1={WIDTH - 145} x2={WIDTH - 129} y1={22} y2={22} stroke="#a78bfa" strokeWidth="2" />
        <text x={WIDTH - 125} y={25} className="chart-axis-label">
          EMA20
        </text>
      </g>
    </svg>
  );
}
