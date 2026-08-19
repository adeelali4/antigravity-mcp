/**
 * Board state -> AgentEvent stream, for the bundled UI. Pure functions, no
 * I/O -- uiServer.js supplies the board (via store.js's read()) and owns the
 * polling loop and the actual WebSocket broadcast.
 */

/** An agent whose presence heartbeat (or active task) is older than this reads as disconnected. */
const STALE_MS = 45_000;

function humanize(id) {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Normalise raw board state into one row per agent identity. Real presence
 * status values (idle/working/blocked/offline, from presence_set's schema)
 * are passed through as-is -- this never invents a richer status the backend
 * didn't actually report.
 */
export function computeAgents(board) {
  const now = Date.now();
  const info = new Map();

  for (const [id, p] of Object.entries(board.presence || {})) {
    info.set(id, { status: p.status, detail: p.detail, ts: p.ts });
  }
  // An agent can be meaningfully "present" via activity alone, even before
  // its first presence_set heartbeat lands.
  for (const t of board.tasks || []) {
    if (t.assignedBy && !info.has(t.assignedBy)) {
      info.set(t.assignedBy, { status: "idle", detail: "", ts: t.created });
    }
    if (t.kind === "delegated" && t.owner && !info.has(t.owner)) {
      info.set(t.owner, { status: "idle", detail: "", ts: t.created });
    }
  }
  for (const n of board.notes || []) {
    if (n.from && !info.has(n.from)) info.set(n.from, { status: "idle", detail: "", ts: n.created });
  }

  const runningByOwner = new Map();
  for (const t of board.tasks || []) {
    if (t.kind === "delegated" && (t.status === "running" || t.status === "queued")) {
      const prev = runningByOwner.get(t.owner);
      if (!prev || (t.updated ?? 0) > (prev.updated ?? 0)) runningByOwner.set(t.owner, t);
    }
  }

  const agents = [];
  for (const id of Array.from(info.keys()).sort()) {
    const p = info.get(id);
    const running = runningByOwner.get(id);
    const lastTs = Math.max(p.ts || 0, running?.updated || 0, running?.created || 0);
    agents.push({
      id,
      name: humanize(id),
      connected: now - lastTs < STALE_MS,
      // A running delegated task means real, visible work -- surfaces even if
      // presence_set was never called for this identity.
      status: running ? "working" : p.status || "idle",
      task: running ? running.title : p.detail || null,
      interactingWith: running ? running.assignedBy : null,
    });
  }
  return agents;
}

export function toEvents(id, agent) {
  const events = [{ type: "AGENT_CONNECTED", agentId: id, name: agent.name }];
  if (!agent.connected) events.push({ type: "AGENT_DISCONNECTED", agentId: id });
  if (agent.status !== "idle") events.push({ type: "AGENT_STATUS_CHANGED", agentId: id, status: agent.status });
  if (agent.task) events.push({ type: "AGENT_TASK_CHANGED", agentId: id, task: agent.task });
  if (agent.interactingWith) {
    events.push({ type: "AGENT_INTERACTION_STARTED", agentId: id, withAgentId: agent.interactingWith });
  }
  return events;
}

/** Diff two agent snapshots into the minimal set of events that gets one from the other. */
export function diffAgents(prevMap, nextList) {
  const events = [];
  const nextMap = new Map(nextList.map((a) => [a.id, a]));

  for (const [id, agent] of nextMap) {
    const prev = prevMap.get(id);
    if (!prev) {
      events.push(...toEvents(id, agent));
      continue;
    }
    if (prev.connected !== agent.connected) {
      events.push(
        agent.connected
          ? { type: "AGENT_CONNECTED", agentId: id, name: agent.name }
          : { type: "AGENT_DISCONNECTED", agentId: id }
      );
    }
    if (prev.status !== agent.status) events.push({ type: "AGENT_STATUS_CHANGED", agentId: id, status: agent.status });
    if (prev.task !== agent.task) events.push({ type: "AGENT_TASK_CHANGED", agentId: id, task: agent.task });
    if (prev.interactingWith !== agent.interactingWith) {
      if (prev.interactingWith) events.push({ type: "AGENT_INTERACTION_ENDED", agentId: id });
      if (agent.interactingWith) {
        events.push({ type: "AGENT_INTERACTION_STARTED", agentId: id, withAgentId: agent.interactingWith });
      }
    }
  }
  return { events, nextMap };
}
