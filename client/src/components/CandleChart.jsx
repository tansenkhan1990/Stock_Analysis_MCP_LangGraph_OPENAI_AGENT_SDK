import { useMemo } from 'react';
import { shortDate } from '../lib/format.js';

const WIDTH = 1000;
const HEIGHT = 440;
const PRICE_TOP = 12;
const PRICE_BOTTOM = 300;
const VOL_TOP = 316;
const VOL_BOTTOM = 358;
const RSI_TOP = 374;
const RSI_BOTTOM = 424;
const PAD_LEFT = 6;
const PAD_RIGHT = 58;

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

export default function CandleChart({ bars = [], overlays = {}, rsi = [], levels, showSma = true, showRsi = true }) {
  const chart = useMemo(() => {
    if (!bars.length) return null;
    const lows = bars.map((bar) => bar.low);
    const highs = bars.map((bar) => bar.high);
    const overlayValues = showSma
      ? [overlays.sma20, overlays.sma50, overlays.sma200].flat().filter((value) => Number.isFinite(value))
      : [];
    const min = Math.min(...lows, ...(overlayValues.length ? overlayValues : lows));
    const max = Math.max(...highs, ...(overlayValues.length ? overlayValues : highs));
    const pad = (max - min) * 0.04 || 1;
    const low = min - pad;
    const high = max + pad;
    const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
    const step = plotWidth / bars.length;
    const bodyWidth = Math.max(1.2, step * 0.62);
    const xFor = (index) => PAD_LEFT + step * index + step / 2;
    const yFor = (price) => PRICE_BOTTOM - ((price - low) / (high - low || 1)) * (PRICE_BOTTOM - PRICE_TOP);
    const maxVolume = Math.max(...bars.map((bar) => bar.volume || 0), 1);
    const yVolume = (volume) => VOL_BOTTOM - (volume / maxVolume) * (VOL_BOTTOM - VOL_TOP);
    const yRsi = (value) => RSI_BOTTOM - (value / 100) * (RSI_BOTTOM - RSI_TOP);
    const gridPrices = Array.from({ length: 5 }, (_, i) => low + ((high - low) * i) / 4);
    const labelEvery = Math.max(1, Math.ceil(bars.length / 7));
    const last = bars[bars.length - 1];

    const resistance = levels?.resistances?.[0]?.price;
    const support = levels?.supports?.[0]?.price;

    return {
      low,
      high,
      step,
      bodyWidth,
      xFor,
      yFor,
      yVolume,
      yRsi,
      gridPrices,
      labelEvery,
      last,
      support,
      resistance,
      pricePath20: linePath(overlays.sma20 || [], xFor, yFor),
      pricePath50: linePath(overlays.sma50 || [], xFor, yFor),
      pricePath200: linePath(overlays.sma200 || [], xFor, yFor),
      rsiPath: linePath(rsi || [], xFor, yRsi),
    };
  }, [bars, overlays, rsi, showSma, levels]);

  if (!chart) return <div className="chart-empty">No chart data</div>;

  const {
    yFor,
    yVolume,
    yRsi,
    xFor,
    step,
    bodyWidth,
    gridPrices,
    labelEvery,
    pricePath20,
    pricePath50,
    pricePath200,
    rsiPath,
    support,
    resistance,
  } = chart;

  return (
    <svg
      className="candle-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label="Price chart with moving averages, volume and RSI"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="price-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(56,189,248,0.10)" />
          <stop offset="100%" stopColor="rgba(56,189,248,0)" />
        </linearGradient>
      </defs>

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
          <text x={WIDTH - PAD_RIGHT + 8} y={yFor(price) + 3.5} className="chart-axis-label">
            {price.toFixed(price > 100 ? 0 : 2)}
          </text>
        </g>
      ))}

      {support && support > chart.low && (
        <g>
          <line
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={yFor(support)}
            y2={yFor(support)}
            stroke="rgba(52,211,153,0.4)"
            strokeDasharray="6 4"
          />
          <text x={PAD_LEFT + 6} y={yFor(support) - 5} className="chart-zone-label support">
            support {support}
          </text>
        </g>
      )}
      {resistance && resistance < chart.high && (
        <g>
          <line
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={yFor(resistance)}
            y2={yFor(resistance)}
            stroke="rgba(248,113,113,0.4)"
            strokeDasharray="6 4"
          />
          <text x={PAD_LEFT + 6} y={yFor(resistance) - 5} className="chart-zone-label resistance">
            resistance {resistance}
          </text>
        </g>
      )}

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
              rx="0.5"
            />
            <rect
              x={x - bodyWidth / 2}
              y={yVolume(bar.volume || 0)}
              width={bodyWidth}
              height={Math.max(1, VOL_BOTTOM - yVolume(bar.volume || 0))}
              fill={color}
              opacity="0.35"
            />
            <title>
              {`${shortDate(bar.date)}  O ${bar.open} H ${bar.high} L ${bar.low} C ${bar.close}`}
            </title>
          </g>
        );
      })}

      {showSma && (
        <>
          <path d={pricePath200} fill="none" stroke="#a78bfa" strokeWidth="1.6" opacity="0.85" />
          <path d={pricePath50} fill="none" stroke="#38bdf8" strokeWidth="1.6" opacity="0.9" />
          <path d={pricePath20} fill="none" stroke="#fbbf24" strokeWidth="1.3" opacity="0.85" />
        </>
      )}

      <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={(VOL_TOP + VOL_BOTTOM) / 2} y2={(VOL_TOP + VOL_BOTTOM) / 2} stroke="rgba(148,163,184,0.08)" />
      <text x={PAD_LEFT + 4} y={VOL_TOP + 8} className="chart-panel-label">
        VOLUME
      </text>

      {showRsi && (
        <g>
          <rect x={PAD_LEFT} y={RSI_TOP} width={WIDTH - PAD_LEFT - PAD_RIGHT} height={RSI_BOTTOM - RSI_TOP} fill="rgba(56,189,248,0.03)" rx="4" />
          <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={yRsi(70)} y2={yRsi(70)} stroke="rgba(248,113,113,0.3)" strokeDasharray="3 4" />
          <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={yRsi(30)} y2={yRsi(30)} stroke="rgba(52,211,153,0.3)" strokeDasharray="3 4" />
          <path d={rsiPath} fill="none" stroke="#c084fc" strokeWidth="1.6" />
          <text x={WIDTH - PAD_RIGHT + 8} y={yRsi(70) + 3} className="chart-axis-label">
            70
          </text>
          <text x={WIDTH - PAD_RIGHT + 8} y={yRsi(30) + 3} className="chart-axis-label">
            30
          </text>
          <text x={PAD_LEFT + 4} y={RSI_TOP + 9} className="chart-panel-label">
            RSI 14
          </text>
        </g>
      )}

      {bars.map((bar, index) =>
        index % labelEvery === 0 || index === bars.length - 1 ? (
          <text key={`x-${bar.date}`} x={xFor(index)} y={HEIGHT - 4} textAnchor="middle" className="chart-axis-label">
            {shortDate(bar.date)}
          </text>
        ) : null,
      )}

      {showSma && (
        <g className="chart-legend">
          <line x1={WIDTH - 230} x2={WIDTH - 214} y1={20} y2={20} stroke="#fbbf24" strokeWidth="2" />
          <text x={WIDTH - 210} y={23} className="chart-axis-label">
            SMA20
          </text>
          <line x1={WIDTH - 160} x2={WIDTH - 144} y1={20} y2={20} stroke="#38bdf8" strokeWidth="2" />
          <text x={WIDTH - 140} y={23} className="chart-axis-label">
            SMA50
          </text>
          <line x1={WIDTH - 90} x2={WIDTH - 74} y1={20} y2={20} stroke="#a78bfa" strokeWidth="2" />
          <text x={WIDTH - 70} y={23} className="chart-axis-label">
            SMA200
          </text>
        </g>
      )}
    </svg>
  );
}
