export default function ScoreRing({ score = 0, label = '', confidence, size = 132, stroke = 10 }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(100, Math.max(0, score)) / 100);
  const tone = score >= 66 ? 'good' : score >= 56 ? 'ok' : score >= 45 ? 'neutral' : 'bad';
  const color =
    tone === 'good' ? 'var(--up)' : tone === 'ok' ? 'var(--accent)' : tone === 'neutral' ? 'var(--warn)' : 'var(--down)';

  return (
    <div className={`score-ring tone-${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(148,163,184,0.12)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="score-ring-progress"
        />
      </svg>
      <div className="score-ring-label">
        <span className="score-value">{Math.round(score)}</span>
        <span className="score-sub">{label || 'score'}</span>
        {confidence !== undefined && <span className="score-confidence">{confidence}% conf.</span>}
      </div>
    </div>
  );
}
