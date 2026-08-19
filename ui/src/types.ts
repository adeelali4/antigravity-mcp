/**
 * Data layer. Nothing here knows about pixels, canvas, or React.
 * This is the shape a real backend/WebSocket feed would need to match.
 */

export type ConnectionStatus = "connected" | "disconnected";

/**
 * Known states get a dedicated sprite/badge. Anything else still renders --
 * see render/sprites.ts's fallback -- so an unfamiliar string from a future
 * backend can never break the UI.
 */
export const KNOWN_STATUSES = [
  "idle",
  "developing",
  "testing",
  "reviewing",
  "debugging",
  "blocked",
  "offline",
] as const;
export type KnownStatus = (typeof KNOWN_STATUSES)[number];
export type AgentStatus = KnownStatus | (string & {});

export interface AgentInteraction {
  withAgentId: string;
  kind?: string;
}

export interface Agent {
  id: string;
  name: string;
  connectionStatus: ConnectionStatus;
  status: AgentStatus;
  currentTask: string | null;
  /** A location id from office/layout.ts, e.g. "desk-2", "meeting", "lounge". */
  location: string;
  targetLocation: string | null;
  interaction: AgentInteraction | null;
  lastUpdated: number;
  /** Deterministic per-agent hue, assigned once on first connect, kept for life of session. */
  hue: number;
}

export type AgentEvent =
  | { type: "AGENT_CONNECTED"; agentId: string; name: string; location?: string }
  | { type: "AGENT_DISCONNECTED"; agentId: string }
  | { type: "AGENT_STATUS_CHANGED"; agentId: string; status: string }
  | { type: "AGENT_TASK_CHANGED"; agentId: string; task: string | null }
  | { type: "AGENT_LOCATION_CHANGED"; agentId: string; location: string }
  | { type: "AGENT_INTERACTION_STARTED"; agentId: string; withAgentId: string; kind?: string }
  | { type: "AGENT_INTERACTION_ENDED"; agentId: string };

/** The event/data layer's contract -- a mock source and a WebSocket source can both implement this. */
export interface AgentEventSource {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  start(): void;
  stop(): void;
}
