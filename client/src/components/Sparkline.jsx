import { useId } from 'react';

export default function Sparkline({ values = [], width = 96, height = 32, positive = true, strokeWidth = 1.6 }) {
  const gradientId = useId().replace(/:/g, '');
  if (!values?.length) return <div className="sparkline-empty" style={{ width, height }} />;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const padding = 2;
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * (width - padding * 2) + padding;
    const y = height - padding - ((value - min) / spread) * (height - padding * 2);
    return [x, y];
  });
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${padding},${height} ${line} ${width - padding},${height}`;
  const color = positive ? 'var(--up)' : 'var(--down)';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="sparkline" aria-hidden>
      <defs>
        <linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={positive ? 'rgba(52,211,153,0.28)' : 'rgba(248,113,113,0.28)'} />
          <stop offset="100%" stopColor="transparent" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#spark-${gradientId})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
