import { useState } from "react";
import type { Agent, AgentEvent } from "../types";
import { KNOWN_STATUSES } from "../types";

interface Props {
  agents: Agent[];
  dispatch: (event: AgentEvent) => void;
}

export function DebugControls({ agents, dispatch }: Props) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState<string>("");
  const [partnerId, setPartnerId] = useState<string>("");
  const [task, setTask] = useState("");
  const [model, setModel] = useState("");

  const target = agents.find((a) => a.id === targetId) ?? agents[0] ?? null;

  return (
    <div className={`debug-panel ${open ? "open" : ""}`}>
      <button className="debug-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "Debug"} controls
      </button>
      {open && (
        <div className="debug-body">
          <label className="debug-field">
            Agent
            <select value={target?.id ?? ""} onChange={(e) => setTargetId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.connectionStatus})
                </option>
              ))}
            </select>
          </label>

          {target && (
            <>
              <div className="debug-row">
                {target.connectionStatus === "connected" ? (
                  <button onClick={() => dispatch({ type: "AGENT_DISCONNECTED", agentId: target.id })}>
                    Disconnect
                  </button>
                ) : (
                  <button
                    onClick={() => dispatch({ type: "AGENT_CONNECTED", agentId: target.id, name: target.name })}
                  >
                    Reconnect
                  </button>
                )}
              </div>

              <div className="debug-row wrap">
                {[...KNOWN_STATUSES, "mystery-state"].map((s) => (
                  <button key={s} onClick={() => dispatch({ type: "AGENT_STATUS_CHANGED", agentId: target.id, status: s })}>
                    {s}
                  </button>
                ))}
              </div>

              <label className="debug-field">
                Task
                <div className="debug-row">
                  <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Task description" />
                  <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model (optional)" />
                  <button
                    onClick={() =>
                      dispatch({ type: "AGENT_TASK_CHANGED", agentId: target.id, task: task || null, model: model || null })
                    }
                  >
                    Set
                  </button>
                </div>
              </label>

              <div className="debug-row wrap">
                <button onClick={() => dispatch({ type: "AGENT_LOCATION_CHANGED", agentId: target.id, location: "meeting" })}>
                  → Meeting
                </button>
                <button onClick={() => dispatch({ type: "AGENT_LOCATION_CHANGED", agentId: target.id, location: "lounge" })}>
                  → Lounge
                </button>
                <button onClick={() => dispatch({ type: "AGENT_LOCATION_CHANGED", agentId: target.id, location: "desk-0" })}>
                  → Desk 1
                </button>
              </div>

              <label className="debug-field">
                Interact with
                <div className="debug-row">
                  <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
                    <option value="">choose…</option>
                    {agents
                      .filter((a) => a.id !== target.id && a.connectionStatus === "connected")
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                  <button
                    disabled={!partnerId}
                    onClick={() => {
                      if (!partnerId) return;
                      const partner = agents.find((a) => a.id === partnerId);
                      dispatch({ type: "AGENT_LOCATION_CHANGED", agentId: target.id, location: partner?.location ?? "meeting" });
                      dispatch({ type: "AGENT_INTERACTION_STARTED", agentId: target.id, withAgentId: partnerId });
                      dispatch({ type: "AGENT_INTERACTION_STARTED", agentId: partnerId, withAgentId: target.id });
                    }}
                  >
                    Start
                  </button>
                  <button
                    disabled={!target.interaction}
                    onClick={() => {
                      dispatch({ type: "AGENT_INTERACTION_ENDED", agentId: target.id });
                      if (target.interaction) dispatch({ type: "AGENT_INTERACTION_ENDED", agentId: target.interaction.withAgentId });
                    }}
                  >
                    End
                  </button>
                </div>
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}
