import type { Agent } from "../types";
import { hueColor, statusColor } from "../render/palette";
import { getLocation } from "../office/layout";

interface Props {
  agent: Agent | null;
  otherAgentName: string | null;
  onClose: () => void;
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

export function AgentDetailPanel({ agent, otherAgentName, onClose }: Props) {
  if (!agent) return null;
  const loc = getLocation(agent.location);

  return (
    <div className="detail-panel">
      <button className="detail-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="detail-header">
        <span className="detail-avatar" style={{ background: hueColor(agent.hue) }} />
        <div>
          <div className="detail-name">{agent.name}</div>
          <div className="detail-conn">{agent.connectionStatus}</div>
        </div>
      </div>

      <dl className="detail-fields">
        <dt>Status</dt>
        <dd>
          <span className="detail-status-dot" style={{ background: statusColor(agent.status) }} />
          {agent.status}
        </dd>

        <dt>Task</dt>
        <dd>{agent.currentTask ?? <em className="detail-muted">no active task</em>}</dd>

        {agent.model && (
          <>
            <dt>Model</dt>
            <dd className="detail-model">{agent.model}</dd>
          </>
        )}

        <dt>Location</dt>
        <dd>{loc.label}</dd>

        {agent.interaction && (
          <>
            <dt>Interacting with</dt>
            <dd>{otherAgentName ?? agent.interaction.withAgentId}</dd>
          </>
        )}

        <dt>Updated</dt>
        <dd>{timeAgo(agent.lastUpdated)}</dd>
      </dl>
    </div>
  );
}
