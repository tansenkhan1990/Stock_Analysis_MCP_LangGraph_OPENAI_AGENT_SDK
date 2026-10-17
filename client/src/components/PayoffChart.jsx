import { useCurrency } from './CurrencyProvider.jsx';
import { money, usd } from '../lib/format.js';

const WIDTH = 900;
const HEIGHT = 300;
const LEFT = 8;
const RIGHT = 68;
const TOP = 16;
const BOTTOM = 262;

function signedSegments(curve) {
  const positive = [];
  const negative = [];
  let current = [];
  let sign = null;

  const pushPoint = (point) => current.push(point);

  for (let i = 0; i < curve.length; i += 1) {
    const point = curve[i];
    const nextSign = point.profit >= 0 ? 1 : -1;
    if (sign === null) sign = nextSign;
    if (nextSign !== sign && current.length) {
      const prev = curve[i - 1];
      const ratio = Math.abs(prev.profit) / (Math.abs(prev.profit) + Math.abs(point.profit) || 1);
      const zeroPrice = prev.price + (point.price - prev.price) * ratio;
      const zero = { price: zeroPrice, profit: 0 };
      current.push(zero);
      (sign > 0 ? positive : negative).push(current);
      current = [zero, point];
      sign = nextSign;
    } else {
      pushPoint(point);
    }
  }
  if (current.length) (sign > 0 ? positive : negative).push(current);
  return { positive, negative };
}

export default function PayoffChart({
  curve = [],
  breakevens = [],
  spot,
  height = 230,
  compact = false,
  nativeCurrency = false,
}) {
  // Subscribe to the display currency so labels re-render on toggle.
  useCurrency();
  const fmt = nativeCurrency ? usd : money;

  if (!curve?.length) return <div className="chart-empty">Build a strategy to see the payoff</div>;

  const profits = curve.map((point) => point.profit);
  const minProfit = Math.min(...profits, 0);
  const maxProfit = Math.max(...profits, 0);
  const pad = (maxProfit - minProfit) * 0.12 || 100;
  const yMin = minProfit - pad;
  const yMax = maxProfit + pad;
  const xMin = curve[0].price;
  const xMax = curve[curve.length - 1].price;

  const xFor = (price) => LEFT + ((price - xMin) / (xMax - xMin || 1)) * (WIDTH - LEFT - RIGHT);
  const yFor = (profit) => BOTTOM - ((profit - yMin) / (yMax - yMin || 1)) * (BOTTOM - TOP);
  const zeroY = yFor(0);
  const step = (xMax - xMin) / Math.max(1, curve.length - 1);

  const pathFor = (points, closeAtZero) => {
    if (!points.length) return '';
    let d = `M${xFor(points[0].price)},${yFor(points[0].profit)}`;
    for (let i = 1; i < points.length; i += 1) d += ` L${xFor(points[i].price)},${yFor(points[i].profit)}`;
    if (closeAtZero) {
      d += ` L${xFor(points[points.length - 1].price)},${zeroY} L${xFor(points[0].price)},${zeroY} Z`;
    }
    return d;
  };

  const segments = signedSegments(curve);
  const yTicks = [yMin, (yMin + yMax) / 2, 0, yMax];
  const xTicks = Array.from({ length: 6 }, (_, i) => xMin + ((xMax - xMin) * i) / 5);

  return (
    <svg
      className="payoff-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      style={{ height }}
      preserveAspectRatio="none"
      role="img"
      aria-label="Option strategy payoff at expiration"
    >
      <defs>
        <linearGradient id="profit-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(52,211,153,0.35)" />
          <stop offset="100%" stopColor="rgba(52,211,153,0.03)" />
        </linearGradient>
        <linearGradient id="loss-fill" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="rgba(248,113,113,0.35)" />
          <stop offset="100%" stopColor="rgba(248,113,113,0.03)" />
        </linearGradient>
      </defs>

      {yTicks.map((value, index) => (
        <g key={`y-${index}`}>
          <line
            x1={LEFT}
            x2={WIDTH - RIGHT}
            y1={yFor(value)}
            y2={yFor(value)}
            stroke={value === 0 ? 'rgba(226,232,240,0.5)' : 'rgba(148,163,184,0.1)'}
            strokeDasharray={value === 0 ? '' : '3 5'}
          />
          <text x={WIDTH - RIGHT + 8} y={yFor(value) + 3.5} className="chart-axis-label">
            {value >= 0 ? '+' : '−'}
            {fmt(Math.abs(Math.round(value)), 0)}
          </text>
        </g>
      ))}

      {segments.positive.map((points, index) => (
        <path key={`pos-${index}`} d={pathFor(points, false) + ` L${xFor(points[points.length - 1].price)},${zeroY} L${xFor(points[0].price)},${zeroY} Z`} fill="url(#profit-fill)" />
      ))}
      {segments.negative.map((points, index) => (
        <path key={`neg-${index}`} d={pathFor(points, false) + ` L${xFor(points[points.length - 1].price)},${zeroY} L${xFor(points[0].price)},${zeroY} Z`} fill="url(#loss-fill)" />
      ))}

      <path d={pathFor(curve, false)} fill="none" stroke="#e2e8f0" strokeWidth="2" strokeLinejoin="round" />

      {spot && (
        <g>
          <line
            x1={xFor(spot)}
            x2={xFor(spot)}
            y1={TOP}
            y2={BOTTOM}
            stroke="rgba(56,189,248,0.65)"
            strokeDasharray="4 4"
          />
          <text x={xFor(spot) + 5} y={TOP + 10} className="chart-zone-label support">
            spot {fmt(spot, 0)}
          </text>
        </g>
      )}

      {breakevens.map((price) => (
        <g key={`be-${price}`}>
          <circle cx={xFor(price)} cy={zeroY} r="4" fill="#0b1220" stroke="#fbbf24" strokeWidth="2" />
          <text x={xFor(price)} y={zeroY + 17} textAnchor="middle" className="chart-zone-label" fill="#fbbf24">
            BE {fmt(price, 0)}
          </text>
        </g>
      ))}

      {!compact &&
        xTicks.map((price, index) => (
          <text key={`x-${index}`} x={xFor(price)} y={HEIGHT - 8} textAnchor="middle" className="chart-axis-label">
            {fmt(price, 0)}
          </text>
        ))}

      {step > 0 && !compact && (
        <text x={LEFT + 4} y={TOP + 2} className="chart-panel-label">
          P/L AT EXPIRY
        </text>
      )}
    </svg>
  );
}
