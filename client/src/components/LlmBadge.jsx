/**
 * The one place the UI names the model that is actually answering.
 * `agent` is the payload from /api/health or /api/agent/status:
 *   { provider, model, live, vision, label }
 */
export default function LlmBadge({ agent }) {
  const live = Boolean(agent?.live);
  const model = live ? agent.model : agent ? 'rule engine' : 'connecting…';
  const provider = live ? agent.provider : 'built-in';
  const title = !agent
    ? 'Checking which model the API is using…'
    : live
      ? [
          `LLM in use: ${agent.provider} · ${agent.model}`,
          `Image input: ${agent.vision ? 'enabled' : 'unavailable for this model'}`,
          agent.label || '',
        ]
          .filter(Boolean)
          .join('\n')
      : 'No LLM key configured — answers come from the built-in rule engine';

  return (
    <span className={`llm-badge ${live ? 'live' : ''}`} title={title} role="status" aria-live="polite">
      <span className="status-dot" />
      <span className="llm-label">{live ? 'LLM' : 'AI'}</span>
      <span className="llm-model">{model}</span>
      <span className="llm-provider">{provider}</span>
    </span>
  );
}
