import { create } from "zustand";
import type { Agent, AgentEvent } from "../types";
import { PREDEFINED_DESK_COUNT, nextOverflowId } from "../office/layout";

interface AgentStoreState {
  agents: Record<string, Agent>;
  /** Sticky for the life of the session -- a desk belongs to an agent even while it's offline. */
  deskAssignments: Record<string, string>;
  /** Connection order, used only to keep desk assignment deterministic. */
  connectionOrder: string[];
  handleEvent: (event: AgentEvent) => void;
  reset: () => void;
}

function hueFor(agentId: string): number {
  let h = 0;
  for (let i = 0; i < agentId.length; i++) h = (h * 31 + agentId.charCodeAt(i)) % 360;
  return h;
}

function assignDesk(agentId: string, deskAssignments: Record<string, string>): string {
  const existing = deskAssignments[agentId];
  if (existing) return existing;
  const used = new Set(Object.values(deskAssignments));
  for (let i = 0; i < PREDEFINED_DESK_COUNT; i++) {
    const id = `desk-${i}`;
    if (!used.has(id)) return id;
  }
  let n = 0;
  while (used.has(nextOverflowId(n))) n++;
  return nextOverflowId(n);
}

/**
 * "home" is a sentinel any event source can use to mean "this agent's own
 * desk" without needing to know its literal id -- the live bridge relies on
 * this since desk assignment is entirely a frontend concept.
 */
function resolveLocation(location: string, agentId: string, deskAssignments: Record<string, string>): string {
  return location === "home" ? assignDesk(agentId, deskAssignments) : location;
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  agents: {},
  deskAssignments: {},
  connectionOrder: [],

  handleEvent(event) {
    const now = Date.now();

    set((state) => {
      const agents = { ...state.agents };
      const deskAssignments = { ...state.deskAssignments };
      let connectionOrder = state.connectionOrder;

      const touch = (id: string, patch: Partial<Agent>) => {
        const existing = agents[id];
        if (!existing) return; // Event for an unknown agent: ignore rather than crash.
        agents[id] = { ...existing, ...patch, lastUpdated: now };
      };

      switch (event.type) {
        case "AGENT_CONNECTED": {
          const desk = assignDesk(event.agentId, deskAssignments);
          deskAssignments[event.agentId] = desk;
          if (!connectionOrder.includes(event.agentId)) {
            connectionOrder = [...connectionOrder, event.agentId];
          }
          const prior = agents[event.agentId];
          agents[event.agentId] = {
            id: event.agentId,
            name: event.name || prior?.name || event.agentId,
            connectionStatus: "connected",
            status: prior?.status ?? "idle",
            currentTask: prior?.currentTask ?? null,
            model: prior?.model ?? null,
            pid: prior?.pid ?? null,
            cwd: prior?.cwd ?? null,
            // Reconnect resumes at its desk rather than wherever it was mid-walk.
            location: event.location ? resolveLocation(event.location, event.agentId, deskAssignments) : desk,
            targetLocation: null,
            interaction: null,
            lastUpdated: now,
            hue: prior?.hue ?? hueFor(event.agentId),
          };
          break;
        }
        case "AGENT_DISCONNECTED": {
          touch(event.agentId, { connectionStatus: "disconnected", interaction: null, targetLocation: null });
          break;
        }
        case "AGENT_STATUS_CHANGED": {
          touch(event.agentId, { status: event.status || "idle" });
          break;
        }
        case "AGENT_TASK_CHANGED": {
          touch(event.agentId, { currentTask: event.task ?? null, model: event.model ?? null, pid: event.pid ?? null, cwd: event.cwd ?? null });
          break;
        }
        case "AGENT_LOCATION_CHANGED": {
          const resolved = resolveLocation(event.location, event.agentId, deskAssignments);
          touch(event.agentId, { targetLocation: resolved, location: resolved });
          break;
        }
        case "AGENT_INTERACTION_STARTED": {
          touch(event.agentId, { interaction: { withAgentId: event.withAgentId, kind: event.kind } });
          break;
        }
        case "AGENT_INTERACTION_ENDED": {
          touch(event.agentId, { interaction: null });
          break;
        }
      }

      return { agents, deskAssignments, connectionOrder };
    });
  },

  reset() {
    set({ agents: {}, deskAssignments: {}, connectionOrder: [] });
  },
}));
