import type { Agent } from "../types";
import { statusColor } from "../render/palette";

interface Props {
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function Sidebar({ agents, selectedId, onSelect }: Props) {
  const sorted = [...agents].sort((a, b) => {
    if (a.connectionStatus !== b.connectionStatus) return a.connectionStatus === "connected" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const online = agents.filter((a) => a.connectionStatus === "connected").length;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        Agents <span className="sidebar-count">{online}/{agents.length} online</span>
      </div>
      <ul className="sidebar-list">
        {sorted.map((a) => (
          <li
            key={a.id}
            className={`sidebar-row ${a.id === selectedId ? "selected" : ""} ${a.connectionStatus}`}
            onClick={() => onSelect(a.id)}
          >
            <span className="sidebar-dot" style={{ background: statusColor(a.status) }} />
            <div className="sidebar-row-text">
              <div className="sidebar-row-name">{a.name}</div>
              <div className="sidebar-row-sub">
                {a.connectionStatus === "connected" ? (
                  <>
                    {a.status}
                    {a.currentTask ? ` · ${a.currentTask}` : ""}
                  </>
                ) : (
                  "offline"
                )}
              </div>
            </div>
          </li>
        ))}
        {agents.length === 0 && <li className="sidebar-empty">No agents yet…</li>}
      </ul>
    </aside>
  );
}
