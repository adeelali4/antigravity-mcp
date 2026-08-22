/**
 * Board state -> AgentEvent stream, for the bundled UI. Pure functions, no
 * I/O -- uiServer.js supplies the board (via store.js's read()) and owns the
 * polling loop and the actual WebSocket broadcast.
 */

import fs from "node:fs";
import path from "node:path";
import { isAlive } from "../proc.js";
import { runsDir, HOME } from "../store.js";

/** An agent whose presence heartbeat (or active task) is older than this reads as disconnected. */
const STALE_MS = 45_000;
/** An agent with activity/events within this window is treated as actively working. */
const ACTIVE_ACTIVITY_MS = 30_000;

function humanize(id) {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function getTail(filePath, maxBytes = 8192) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size === 0) return "";
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, length, start);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Check Antigravity brain transcripts for active host agent actions
 * (finding, reading, bashing, searching, developing, planning).
 */
export function getAntigravityActivity() {
  const brainRoots = [
    path.join(HOME, ".gemini", "antigravity-cli", "brain"),
    path.join(HOME, ".gemini", "antigravity-ide", "brain"),
    path.join(HOME, ".gemini", "brain"),
  ];

  const now = Date.now();
  let newestFile = null;
  let newestMtime = 0;

  for (const root of brainRoots) {
    if (!fs.existsSync(root)) continue;
    let convDirs = [];
    try {
      convDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const d of convDirs) {
      if (!d.isDirectory()) continue;
      const transcriptFile = path.join(root, d.name, ".system_generated", "logs", "transcript.jsonl");
      try {
        if (fs.existsSync(transcriptFile)) {
          const stat = fs.statSync(transcriptFile);
          if (stat.mtimeMs > newestMtime) {
            newestMtime = stat.mtimeMs;
            newestFile = transcriptFile;
          }
        }
      } catch {}
    }
  }

  if (!newestFile || now - newestMtime > STALE_MS) {
    return null;
  }

  const tail = getTail(newestFile, 16384);
  if (!tail.trim()) return null;

  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
        const tc = obj.tool_calls[0];
        const name = (tc.name || "").toLowerCase();
        const action = tc.args?.toolAction || tc.args?.toolSummary || "";
        const cleanAction = typeof action === "string" ? action.replace(/^"|"$/g, "") : "";

        if (name === "run_command") {
          const cmd = tc.args?.CommandLine || "";
          const cleanCmd = typeof cmd === "string" ? cmd.replace(/^"|"$/g, "").slice(0, 45) : "";
          return {
            status: "bashing",
            detail: cleanAction || (cleanCmd ? `Running: ${cleanCmd}` : "Running command"),
            ts: newestMtime,
          };
        }
        if (name === "find_by_name" || name === "list_dir") {
          const pat = tc.args?.Pattern || "";
          const cleanPat = typeof pat === "string" ? pat.replace(/^"|"$/g, "") : "";
          return {
            status: "finding",
            detail: cleanAction || (cleanPat ? `Finding: ${cleanPat}` : "Finding files"),
            ts: newestMtime,
          };
        }
        if (name === "view_file" || name === "read_url_content" || name === "read_resource") {
          const p = tc.args?.AbsolutePath || "";
          const base = typeof p === "string" ? path.basename(p.replace(/^"|"$/g, "")) : "";
          return {
            status: "reading",
            detail: cleanAction || (base ? `Reading: ${base}` : "Reading file"),
            ts: newestMtime,
          };
        }
        if (name === "grep_search" || name === "search_web") {
          const q = tc.args?.Query || tc.args?.query || "";
          const cleanQ = typeof q === "string" ? q.replace(/^"|"$/g, "") : "";
          return {
            status: "searching",
            detail: cleanAction || (cleanQ ? `Searching: ${cleanQ}` : "Searching codebase"),
            ts: newestMtime,
          };
        }
        if (name === "replace_file_content" || name === "write_to_file") {
          const f = tc.args?.TargetFile || "";
          const base = typeof f === "string" ? path.basename(f.replace(/^"|"$/g, "")) : "";
          return {
            status: "developing",
            detail: cleanAction || (base ? `Editing: ${base}` : "Editing code"),
            ts: newestMtime,
          };
        }
      }

      if (obj.type === "PLANNER_RESPONSE" || obj.source === "MODEL") {
        return {
          status: "working",
          detail: "Thinking & planning",
          ts: newestMtime,
        };
      }
    } catch {
      continue;
    }
  }

  return { status: "working", detail: "Active in Antigravity", ts: newestMtime };
}

/**
 * Check Claude Code session activity in ~/.claude/projects/
 */
export function getClaudeActivity() {
  const claudeProjects = path.join(HOME, ".claude", "projects");
  const now = Date.now();
  if (!fs.existsSync(claudeProjects)) return null;

  let newestFile = null;
  let newestMtime = 0;

  try {
    const projDirs = fs.readdirSync(claudeProjects, { withFileTypes: true });
    for (const d of projDirs) {
      if (!d.isDirectory()) continue;
      const dirPath = path.join(claudeProjects, d.name);
      const files = fs.readdirSync(dirPath);
      for (const f of files) {
        const fullPath = path.join(dirPath, f);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > newestMtime) {
            newestMtime = stat.mtimeMs;
            newestFile = fullPath;
          }
        } catch {}
      }
    }
  } catch {
    return null;
  }

  if (!newestFile || now - newestMtime > STALE_MS) return null;

  const tail = getTail(newestFile, 8192);
  if (!tail.trim()) return null;

  if (/tool_use.*"name"\s*:\s*"Bash/i.test(tail)) {
    return { status: "bashing", detail: "Running terminal command", ts: newestMtime };
  }
  if (/tool_use.*"name"\s*:\s*"(Glob|Find)"/i.test(tail)) {
    return { status: "finding", detail: "Finding files", ts: newestMtime };
  }
  if (/tool_use.*"name"\s*:\s*"Read"/i.test(tail)) {
    return { status: "reading", detail: "Reading file", ts: newestMtime };
  }
  if (/tool_use.*"name"\s*:\s*"(Grep|Search)"/i.test(tail)) {
    return { status: "searching", detail: "Searching codebase", ts: newestMtime };
  }
  if (/tool_use.*"name"\s*:\s*"(Edit|Write)"/i.test(tail)) {
    return { status: "developing", detail: "Editing files", ts: newestMtime };
  }

  return { status: "working", detail: "Active in Claude session", ts: newestMtime };
}

/**
 * Scan the live log tails of a running task to detect active operations:
 * finding, reading, bashing, searching, developing.
 */
export function inferLiveActivity(task) {
  if (!task || !task.id) return null;
  const jsonPath = path.join(runsDir(), `${task.id}.json`);
  const errPath = path.join(runsDir(), `${task.id}.err`);
  const jsonTail = getTail(jsonPath, 8192);
  const errTail = getTail(errPath, 4096);
  const combined = `${jsonTail}\n${errTail}`;
  if (!combined.trim()) return null;

  const lines = combined.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();

  for (const line of lines) {
    // 1. Bash / command execution
    if (
      /("name"\s*:\s*"(run_command|bash|exec|terminal|pwsh|sh|command)"|tool_use.*"name"\s*:\s*"Bash|`run_command`|Executing:|Running command:|\$\s+[a-z0-9_.-]+)/i.test(
        line
      )
    ) {
      const match =
        line.match(/(?:CommandLine|command|cmd|input)["']?\s*:\s*["']?([^"',}\]]+)/i) ||
        line.match(/(?:\$\s+|Running command:\s*)([^\r\n]+)/i);
      const cmd = match ? match[1].trim().slice(0, 45) : "";
      return { status: "bashing", detail: cmd ? `Bashing: ${cmd}` : "Bashing (running command)" };
    }

    // 2. File search / finding
    if (
      /("name"\s*:\s*"(find_by_name|glob|locate|file_search|Glob|Find)"|tool_use.*"name"\s*:\s*"(Glob|Find)"|Finding files|Locating)/i.test(
        line
      )
    ) {
      const match = line.match(/(?:Pattern|pattern|query|path)["']?\s*:\s*["']?([^"',}\]]+)/i);
      const pat = match ? match[1].trim().slice(0, 45) : "";
      return { status: "finding", detail: pat ? `Finding: ${pat}` : "Finding files" };
    }

    // 3. Text / grep / web searching
    if (
      /("name"\s*:\s*"(grep_search|search_web|grep|ripgrep|rg|Search|Grep)"|tool_use.*"name"\s*:\s*"(Grep|Search|WebSearch)"|Searching for|grep\s+)/i.test(
        line
      )
    ) {
      const match = line.match(/(?:Query|query|pattern|q)["']?\s*:\s*["']?([^"',}\]]+)/i);
      const q = match ? match[1].trim().slice(0, 45) : "";
      return { status: "searching", detail: q ? `Searching: ${q}` : "Searching codebase" };
    }

    // 4. Reading files / resources
    if (
      /("name"\s*:\s*"(view_file|read_file|read_resource|cat|Read)"|tool_use.*"name"\s*:\s*"Read"|Reading |Viewing file)/i.test(
        line
      )
    ) {
      const match = line.match(/(?:AbsolutePath|path|file|TargetFile)["']?\s*:\s*["']?([^"',}\]]+)/i);
      const file = match ? path.basename(match[1].trim().slice(0, 45)) : "";
      return { status: "reading", detail: file ? `Reading: ${file}` : "Reading file" };
    }

    // 5. Editing / writing files
    if (
      /("name"\s*:\s*"(write_to_file|replace_file_content|edit|write|patch|Edit|Write)"|tool_use.*"name"\s*:\s*"(Edit|Write)"|Editing |Writing )/i.test(
        line
      )
    ) {
      const match = line.match(/(?:TargetFile|path|file)["']?\s*:\s*["']?([^"',}\]]+)/i);
      const file = match ? path.basename(match[1].trim().slice(0, 45)) : "";
      return { status: "developing", detail: file ? `Editing: ${file}` : "Developing" };
    }
  }

  return null;
}

/**
 * Normalise raw board state into one row per agent identity.
 * Accurately surfaces rich live activities (finding, reading, bashing, searching,
 * developing, working, etc.) so agents do not falsely appear idle.
 */
export function computeAgents(board) {
  const now = Date.now();
  const info = new Map();

  const agyLive = getAntigravityActivity();
  if (agyLive && !info.has("antigravity")) {
    info.set("antigravity", { status: agyLive.status, detail: agyLive.detail, ts: agyLive.ts });
  }

  const claudeLive = getClaudeActivity();
  if (claudeLive && !info.has("claude") && !info.has("claude-code")) {
    info.set("claude-code", { status: claudeLive.status, detail: claudeLive.detail, ts: claudeLive.ts });
  }

  for (const [id, p] of Object.entries(board.presence || {})) {
    info.set(id, { status: p.status, detail: p.detail, ts: p.ts, model: p.model, pid: p.pid, cwd: p.cwd });
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

  // Worker id -> its most-recently-updated genuinely-alive running task.
  const runningByOwner = new Map();
  for (const t of board.tasks || []) {
    if (t.kind !== "delegated" || (t.status !== "running" && t.status !== "queued")) continue;
    if (!isAlive(t.pid)) continue;
    const prev = runningByOwner.get(t.owner);
    if (!prev || (t.updated ?? 0) > (prev.updated ?? 0)) runningByOwner.set(t.owner, t);
  }

  // The delegator's own status/task stay theirs -- delegating doesn't change
  // what THEY'RE doing, only where they are and who they're paired with.
  const delegatorPartner = new Map(); // assignedBy id -> worker id it's currently visiting
  for (const t of runningByOwner.values()) {
    if (t.assignedBy) delegatorPartner.set(t.assignedBy, t.owner);
  }

  const agents = [];
  for (const id of Array.from(info.keys()).sort()) {
    const p = info.get(id);
    const running = runningByOwner.get(id);
    const visiting = delegatorPartner.get(id);
    const inMeeting = Boolean(running || visiting);

    let activeStatus = "idle";
    let activeDetail = p.detail || null;

    if (running) {
      const live = inferLiveActivity(running);
      if (live) {
        activeStatus = live.status;
        activeDetail = live.detail;
      } else {
        activeStatus = "working";
        activeDetail = running.title;
      }
    } else {
      // Check host activity first for Antigravity and Claude
      if ((id === "antigravity" || id.startsWith("antigravity") || id === "agy") && agyLive) {
        activeStatus = agyLive.status;
        activeDetail = agyLive.detail;
      } else if ((id === "claude" || id.startsWith("claude") || id === "claude-code") && claudeLive) {
        activeStatus = claudeLive.status;
        activeDetail = claudeLive.detail;
      } else {
        // Check explicit status reported by presence_set
        const hasExplicitNonIdle = p.status && p.status !== "idle";
        const isFresh = now - (p.ts || 0) < STALE_MS;

        if (hasExplicitNonIdle && isFresh) {
          activeStatus = p.status;
          activeDetail = p.detail || null;
        } else {
          // Check if holding active locks
          const heldLocks = (board.locks || []).filter((l) => l.owner === id);
          if (heldLocks.length > 0 && isFresh) {
            activeStatus = "developing";
            activeDetail = `Editing: ${heldLocks.map((l) => path.basename(l.path)).join(", ")}`;
          } else {
            // Check recent events for this agent
            const recentEvent = (board.events || [])
              .slice(-20)
              .reverse()
              .find((e) => e.agent === id && now - e.ts < ACTIVE_ACTIVITY_MS);

            if (recentEvent) {
              if (recentEvent.kind === "paths.check") {
                activeStatus = "finding";
                activeDetail = recentEvent.detail || "Checking files";
              } else if (recentEvent.kind === "locks.claim") {
                activeStatus = "developing";
                activeDetail = recentEvent.detail || "Claiming locks";
              } else if (recentEvent.kind === "note.read") {
                activeStatus = "reading";
                activeDetail = recentEvent.detail || "Reading notes";
              } else if (recentEvent.kind === "task.delegate" || recentEvent.kind === "task.followup") {
                activeStatus = "working";
                activeDetail = recentEvent.detail || "Delegating work";
              } else {
                activeStatus = inMeeting ? "working" : p.status || "idle";
              }
            } else {
              activeStatus = inMeeting ? "working" : p.status || "idle";
            }
          }
        }
      }
    }

    const hostTs = (id === "antigravity" || id.startsWith("antigravity") || id === "agy") && agyLive ? agyLive.ts : (id === "claude" || id.startsWith("claude")) && claudeLive ? claudeLive.ts : 0;
    const lastTs = Math.max(p.ts || 0, running?.updated || 0, hostTs);
    agents.push({
      id,
      name: humanize(id),
      connected: now - lastTs < STALE_MS,
      status: activeStatus,
      task: activeDetail,
      model: running ? running.model || null : p.model || null,
      pid: p.pid || null,
      cwd: p.cwd || null,
      interactingWith: running ? running.assignedBy : visiting || null,
      location: inMeeting ? "meeting" : "home",
    });
  }
  return agents;
}

export function toEvents(id, agent) {
  const events = [{ type: "AGENT_CONNECTED", agentId: id, name: agent.name }];
  if (!agent.connected) events.push({ type: "AGENT_DISCONNECTED", agentId: id });
  if (agent.status !== "idle") events.push({ type: "AGENT_STATUS_CHANGED", agentId: id, status: agent.status });
  // pid/cwd ride on this event too, so an agent that has them but no task and
  // no model (a live session that never called presence_set) would otherwise
  // never send them to a newly-connected client -- and diffAgents only ever
  // re-sends this event on a *change*, so they'd never arrive at all.
  if (agent.task || agent.model || agent.pid) {
    events.push({ type: "AGENT_TASK_CHANGED", agentId: id, task: agent.task, model: agent.model, pid: agent.pid, cwd: agent.cwd });
  }
  if (agent.location !== "home") events.push({ type: "AGENT_LOCATION_CHANGED", agentId: id, location: agent.location });
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
    if (prev.task !== agent.task || prev.model !== agent.model || prev.pid !== agent.pid || prev.cwd !== agent.cwd) {
      events.push({ type: "AGENT_TASK_CHANGED", agentId: id, task: agent.task, model: agent.model, pid: agent.pid, cwd: agent.cwd });
    }
    if (prev.location !== agent.location) {
      events.push({ type: "AGENT_LOCATION_CHANGED", agentId: id, location: agent.location });
    }
    if (prev.interactingWith !== agent.interactingWith) {
      if (prev.interactingWith) events.push({ type: "AGENT_INTERACTION_ENDED", agentId: id });
      if (agent.interactingWith) {
        events.push({ type: "AGENT_INTERACTION_STARTED", agentId: id, withAgentId: agent.interactingWith });
      }
    }
  }
  return { events, nextMap };
}
