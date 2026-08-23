/**
 * Board state -> AgentEvent stream, for the bundled UI. Pure functions, no
 * I/O -- uiServer.js supplies the board (via store.js's read()) and owns the
 * polling loop and the actual WebSocket broadcast.
 */

import fs from "node:fs";
import path from "node:path";
import { isAlive } from "../proc.js";
import { runsDir, hostHome } from "../store.js";

/** An agent whose presence heartbeat (or active task) is older than this reads as disconnected. */
const STALE_MS = 45_000;
/** An agent with activity/events within this window is treated as actively working. */
const ACTIVE_ACTIVITY_MS = 30_000;
/** A full transcript-directory walk runs at most this often; ticks in between re-stat known files only. */
const RESCAN_MS = 30_000;
/** How many recently-touched files a full scan remembers for the cheap per-tick path. */
const WATCH_CANDIDATES = 8;

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

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

const scanCache = new Map(); // cache key -> { at, candidates: string[] }

/** Drop remembered scan results. Tests use this after writing fixtures. */
export function resetHostScanCache() {
  scanCache.clear();
}

/**
 * Newest-file lookup that doesn't walk the whole tree on every poll tick.
 *
 * The UI polls once a second and these directories accumulate one file per
 * session forever, so a naive readdir+stat sweep is O(every session ever) per
 * second. Instead a full walk runs at most once per RESCAN_MS and remembers
 * only the few newest files; every tick in between just re-stats those. A
 * session started after the last walk shows up on the next one -- at worst
 * RESCAN_MS late, comfortably inside the STALE_MS window it feeds.
 */
function newestFile(key, listFiles) {
  const now = Date.now();
  let entry = scanCache.get(key);
  if (!entry || now - entry.at > RESCAN_MS) {
    const found = [];
    for (const file of listFiles()) {
      const m = mtimeOf(file);
      if (m) found.push({ file, m });
    }
    found.sort((a, b) => b.m - a.m);
    entry = { at: now, candidates: found.slice(0, WATCH_CANDIDATES).map((f) => f.file) };
    scanCache.set(key, entry);
  }

  let best = null;
  let bestMtime = 0;
  for (const file of entry.candidates) {
    const m = mtimeOf(file);
    if (m > bestMtime) {
      bestMtime = m;
      best = file;
    }
  }
  return best ? { file: best, mtime: bestMtime } : null;
}

function filesIn(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * Check Antigravity brain transcripts for active host agent actions
 * (finding, reading, bashing, searching, developing, planning).
 *
 * Unlike Claude's, these paths carry no workspace identity, so this cannot be
 * scoped to the current project -- an Antigravity session in another repo will
 * still register here. Scoping it needs a workspace marker inside the brain
 * directory that the format doesn't currently expose.
 */
export function getAntigravityActivity() {
  const home = hostHome();
  const brainRoots = [
    path.join(home, ".gemini", "antigravity-cli", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain"),
    path.join(home, ".gemini", "brain"),
  ];

  const now = Date.now();
  const newest = newestFile(`antigravity:${home}`, () => {
    const out = [];
    for (const root of brainRoots) {
      let convDirs = [];
      try {
        convDirs = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of convDirs) {
        if (!d.isDirectory()) continue;
        out.push(path.join(root, d.name, ".system_generated", "logs", "transcript.jsonl"));
      }
    }
    return out;
  });

  if (!newest || now - newest.mtime > STALE_MS) {
    return null;
  }
  const newestMtime = newest.mtime;

  const tail = getTail(newest.file, 16384);
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
 * Claude Code stores each project's sessions in a directory named after the
 * project cwd with every non-alphanumeric character replaced by "-".
 */
export function claudeProjectDir(cwd) {
  return path.join(hostHome(), ".claude", "projects", String(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * Check Claude Code session activity for one project.
 *
 * Scoped to `projectCwd` on purpose: the office UI shows the agents working on
 * THIS project, and an unscoped sweep reported a Claude session in an
 * unrelated repo as this project's agent being busy.
 */
export function getClaudeActivity(projectCwd = process.cwd()) {
  const dir = claudeProjectDir(projectCwd);
  const now = Date.now();

  const newest = newestFile(`claude:${dir}`, () => filesIn(dir));
  if (!newest || now - newest.mtime > STALE_MS) return null;
  const newestMtime = newest.mtime;

  const tail = getTail(newest.file, 8192);
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
 * What a board event says the agent was doing.
 *
 * The office UI reads "idle" as nobody home, so an agent that is demonstrably
 * mid-task must never land there. Every event kind therefore resolves to a
 * real activity, and anything unrecognised falls back to "working" rather than
 * to idle -- an event exists precisely because the agent did something.
 */
const EVENT_STATUS = {
  "paths.check": ["finding", "Checking files"],
  "locks.claim": ["developing", "Claiming files"],
  "locks.release": ["working", "Wrapping up"],
  "locks.auto-release": ["working", "Wrapping up"],
  "note.read": ["reading", "Reading notes"],
  "note.sent": ["working", "Sending a note"],
  "task.delegated": ["delegating", "Handing off work"],
  "task.failover": ["delegating", "Re-routing work"],
  "task.reassigned": ["delegating", "Re-routing work"],
  "board.post": ["working", "Posting to the board"],
  "presence": ["working", null],
};

function statusFromEvent(event) {
  const [status, detail] = EVENT_STATUS[event.kind] || ["working", null];
  return { status, detail: detail || event.detail || "Active" };
}

const isAntigravityId = (id) => id === "agy" || id === "antigravity" || id.startsWith("antigravity");
const isClaudeId = (id) => id === "claude" || id === "claude-code" || id.startsWith("claude");

/**
 * Normalise raw board state into one row per agent identity.
 *
 * Surfaces rich live activity (finding, reading, bashing, searching,
 * developing) so agents don't falsely read as idle -- but only ever as a
 * fallback. An agent that reported its own status via presence_set is telling
 * us something inference cannot know ("blocked, waiting on an API key"), so
 * that always wins while it's fresh.
 */
export function computeAgents(board, { projectCwd = process.cwd() } = {}) {
  const now = Date.now();
  const info = new Map();

  const agyLive = getAntigravityActivity();
  if (agyLive) {
    info.set("antigravity", { status: agyLive.status, detail: agyLive.detail, ts: agyLive.ts });
  }

  const claudeLive = getClaudeActivity(projectCwd);
  if (claudeLive) {
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
      // This id IS the worker on a live task: read what it is doing from the
      // task's own output, and fall back to the task title, never to idle.
      const live = inferLiveActivity(running);
      if (live) {
        activeStatus = live.status;
        activeDetail = live.detail;
      } else {
        activeStatus = "working";
        activeDetail = running.title;
      }
    } else {
      // Resolution order, most authoritative first. Every branch below yields a
      // real activity: "idle" is only reached when nothing at all says
      // otherwise, because the UI draws idle as an empty desk and an agent that
      // is mid-search must never look like it went home.
      const isFresh = now - (p.ts || 0) < STALE_MS;
      const hasExplicitNonIdle = p.status && p.status !== "idle";
      const hostLive = isAntigravityId(id) ? agyLive : isClaudeId(id) ? claudeLive : null;
      const heldLocks = (board.locks || []).filter((l) => l.owner === id);
      const recentEvent = (board.events || [])
        .slice(-40)
        .reverse()
        .find((e) => e.agent === id && now - e.ts < ACTIVE_ACTIVITY_MS);

      if (hasExplicitNonIdle && isFresh) {
        // 1. What the agent said about itself. It knows things inference can't.
        activeStatus = p.status;
        activeDetail = p.detail || null;
      } else if (hostLive) {
        // 2. Its live transcript -- searching, reading, running a command.
        activeStatus = hostLive.status;
        activeDetail = hostLive.detail;
      } else if (visiting) {
        // 3. It has work running at another agent right now: that is a hand-off
        //    in progress, not idleness, however quiet its own session is.
        activeStatus = "delegating";
        activeDetail = `Handed off to ${humanize(visiting)}`;
      } else if (recentEvent) {
        // 4. Anything it did on the board in the last window.
        const from = statusFromEvent(recentEvent);
        activeStatus = from.status;
        activeDetail = from.detail;
      } else if (heldLocks.length && isFresh) {
        // 5. Still holding files. Quiet, but not finished.
        activeStatus = "developing";
        activeDetail = `Editing: ${heldLocks.map((l) => path.basename(l.path)).join(", ")}`;
      } else {
        activeStatus = inMeeting ? "working" : p.status || "idle";
      }
    }

    const hostTs = (isAntigravityId(id) && agyLive?.ts) || (isClaudeId(id) && claudeLive?.ts) || 0;
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
