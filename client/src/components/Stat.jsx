export default function Stat({ label, value, tone = '', hint = '', className = '' }) {
  return (
    <div className={`stat ${className}`} title={hint || ''}>
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone}`}>{value ?? '—'}</span>
    </div>
  );
}
