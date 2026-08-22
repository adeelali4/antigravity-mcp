/**
 * antigravity-mcp-server — an MCP server that does two things:
 *
 *  1. Delegation: runs the Antigravity CLI (`agy`) or the GitHub Copilot CLI
 *     (`copilot`) headlessly as a detached background job, so the calling
 *     agent hands off work and keeps going.
 *  2. Coordination: a shared board (tasks, path locks, notes, presence) that
 *     every connected agent shares, so none of them walk into each other's
 *     files.
 *
 * The same executable is registered on every side with a different `--agent`
 * id; that id is the identity everything on the board is attributed to. Two
 * concurrent processes launched with the SAME id get auto-disambiguated at
 * startup (see resolveAgentIdentity()) rather than silently sharing one
 * presence slot.
 */

import path from "node:path";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  mutate, read, ago, norm, overlaps, logEvent, nextId, taskId, ensureDirs,
} from "./store.js";
import { isAlive, killTree } from "./proc.js";
import { loadBackends, spawnBackend, recoverTask } from "./backends.js";
import { classifyFailure, localUsage, isExhausted, isExpired, untilReset } from "./limits.js";

/**
 * Every delegation target, loaded from the registry (built-in presets plus
 * anything the user declared in ~/.antigravity-mcp/backends.json). A task's
 * `owner` doubles as the lookup key, so reap() needs no second field to stay
 * in sync with it.
 *
 * Each owner is suffixed "-agent" so it can never equal a HOST's own board
 * identity. That matters because the same CLIs sit on both sides of the
 * board: `init` registers agy as a host under "antigravity" and Copilot under
 * "copilot" (see clients.js), and those were once the owner keys for work
 * delegated TO them. One string for both roles meant an agy host delegating
 * to agy overwrote its own presence slot, and its own locks were
 * indistinguishable from its delegate's -- so releasing its own released the
 * delegate's too.
 */
export const ALL_BACKENDS = loadBackends();

/**
 * Only backends whose binary actually resolves get tools registered. Two
 * reasons, both real: a `codex_delegate` on a machine with no codex is a
 * promise this server can't keep, and every registered tool costs the calling
 * agent context at connect time whether or not it's ever usable. `doctor`
 * lists the whole roster, installed or not, so nothing is hidden.
 */
export const BACKENDS_LIST = ALL_BACKENDS.filter((s) => {
  try {
    return Boolean(s.findBin({ required: false }));
  } catch {
    return false;
  }
});

// Lookup stays over ALL backends: a task delegated before a CLI was uninstalled
// still needs its result reaped, even though its tools are no longer offered.
const BY_OWNER = new Map(ALL_BACKENDS.map((s) => [s.owner, s]));

/**
 * Tasks recorded before the owners were suffixed still say "antigravity" or
 * "copilot". Without this, reap() would find no backend for them and mark
 * every in-flight one failed the moment this version starts up.
 */
const LEGACY_OWNER = { antigravity: "antigravity-agent", copilot: "copilot-agent" };
const backendFor = (owner) => BY_OWNER.get(owner) || BY_OWNER.get(LEGACY_OWNER[owner]);

export let AGENT = (() => {
  const i = process.argv.indexOf("--agent");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  // Neutral, not "claude": `init` always writes an explicit --agent, so this
  // only fires for a hand-rolled or misconfigured launch -- and labelling an
  // unidentified host "claude" is actively wrong when it's just as likely to
  // be agy, Copilot, Cursor or anything else on the board.
  return process.env.COOP_AGENT || "agent";
})();

/**
 * Two real processes both launched with the same --agent id (e.g. two editor
 * windows both configured as "claude-code") would otherwise silently share
 * one presence slot and one set of lock ownership -- whichever last touched
 * presence wins, clobbering the other, with no indication anything went
 * wrong. Auto-disambiguate at startup instead, the same way a second copy of
 * a file or window commonly gets "(2)" appended: if this identity's presence
 * slot is currently held by a DIFFERENT, still-alive process, claim the next
 * free "<id>-2", "<id>-3", ... suffix instead. The check-and-reserve happens
 * in one mutate() call so two processes starting at the same instant can't
 * both pick the same candidate.
 */
async function resolveAgentIdentity() {
  const base = AGENT;
  AGENT = await mutate((b) => {
    let candidate = base;
    for (let n = 2; n <= 50; n++) {
      const existing = b.presence[candidate];
      // Recency matters as much as liveness: pids get recycled (aggressively
      // so on Windows), so isAlive() alone will happily report a long-dead
      // session's slot as "held" by whatever unrelated process inherited its
      // pid, permanently renaming this identity for no reason. A genuinely
      // live peer heartbeats every 15s, so anything this stale is not one.
      const fresh = Date.now() - (existing?.ts || 0) < 60_000;
      const heldByOther = existing?.pid && existing.pid !== process.pid && fresh && isAlive(existing.pid);
      if (!heldByOther) {
        // Reserve immediately, in this same critical section -- a heartbeat
        // will overwrite this moments later, but it must not be possible for
        // a second process racing to start right now to see this slot as free.
        b.presence[candidate] = {
          status: existing?.status ?? "idle", detail: existing?.detail ?? "",
          model: existing?.model ?? null, pid: process.pid, cwd: process.cwd(), ts: Date.now(),
        };
        return candidate;
      }
      candidate = `${base}-${n}`;
    }
    // Pathological case (50 concurrent sessions of one identity) -- pid is
    // always unique, so this can never collide, even if it isn't pretty.
    const fallback = `${base}-${process.pid}`;
    b.presence[fallback] = { status: "idle", detail: "", model: null, pid: process.pid, cwd: process.cwd(), ts: Date.now() };
    return fallback;
  });
}

// Compact, not pretty-printed: this text is read by an LLM, not a human at a
// terminal, and every tool call pays for the indentation whitespace in
// tokens -- across every tool response, for the life of the session.
const ok = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj) }],
});

/**
 * Drop every lock tied to a finished task and log it, if any were held.
 * Delegated agents are told to release_paths themselves when done, but that
 * depends on them remembering to -- in practice they sometimes don't (a
 * finished task can sit on a lock indefinitely otherwise). The board is the
 * source of truth for "is this path free," so it releases its own stale
 * locks the instant it learns a task is over, rather than trusting the
 * delegate's cooperation.
 */
function releaseTaskLocks(b, taskId) {
  const before = b.locks.length;
  b.locks = b.locks.filter((l) => l.taskId !== taskId);
  const released = before - b.locks.length;
  if (released) logEvent(b, AGENT, "locks.auto-release", `${released} released for finished task ${taskId}`);
  return released;
}

/**
 * Presence is a single "what am I doing" slot per identity, set to "working"
 * the moment delegateTask() starts a job -- nothing ever cleared it back to
 * idle when the job finished, so a completed agent showed "working" in the
 * office UI forever (the UI's own live-task check correctly falls back to
 * this stale value once no genuinely running task exists). Reset it once
 * this task is done, unless the same owner still has another task running.
 */
function settlePresence(b, owner, finishedTaskId) {
  const stillBusy = b.tasks.some(
    (t) => t.id !== finishedTaskId && t.owner === owner && t.kind === "delegated" && ["running", "queued"].includes(t.status)
  );
  if (!stillBusy && b.presence[owner]?.status === "working") {
    // Spread, not a fresh object: model/pid/cwd are that agent's own
    // self-reported facts and outlive any one task -- rebuilding the record
    // from scratch here would silently drop them.
    b.presence[owner] = { ...b.presence[owner], status: "idle", detail: "", ts: Date.now() };
  }
}

/**
 * Record that a backend can't take work, so the next delegation is refused
 * before it spawns instead of failing the same way. Also parks that agent as
 * "blocked" on the board, which is what the office UI reads -- it's the same
 * state a human would set by hand after being told an agent is out of budget.
 */
function markLimited(b, owner, info) {
  b.limits ||= {};
  b.limits[owner] = { ...info, since: Date.now() };
  b.presence[owner] = {
    ...b.presence[owner],
    status: "blocked",
    detail: info.kind === "auth" ? "not usable: sign-in/access problem" : "at its usage limit",
    ts: Date.now(),
  };
  logEvent(b, AGENT, `backend.${info.kind}`, `${owner}${info.resets_at ? ` until ${info.resets_at}` : ""}`);
}

/** Live limits only -- anything whose reset time has passed is dropped as it's read. */
function activeLimits(b) {
  const out = {};
  for (const [owner, entry] of Object.entries(b.limits || {})) {
    if (!isExpired(entry)) out[owner] = entry;
  }
  return out;
}

/**
 * Reconcile a delegated task with what its backend actually left on disk.
 * Called before any read of task state, which is what makes status survive a
 * server restart.
 */
async function reap(id) {
  const board = read();
  const t = board.tasks.find((x) => x.id === id);
  if (!t) return { error: `no such task: ${id}` };
  if (t.kind !== "delegated" || !["running", "queued"].includes(t.status)) return t;

  const backend = backendFor(t.owner);
  const payload = backend?.readResult(id);
  if (payload) {
    return await mutate((b) => {
      const task = b.tasks.find((x) => x.id === id);
      // The board is re-read under the lock, so the task can legitimately be
      // gone by now -- a `reset` or coop_reset between our read and this
      // write. Reporting that beats a TypeError on a missing object.
      if (!task) return { error: `no such task: ${id}` };
      task.status = payload.status === "SUCCESS" ? "done" : "failed";
      // A backend can report failure in its own output rather than by dying,
      // so the limit check belongs on both failure paths, not just the crash one.
      if (task.status === "failed") {
        const why = classifyFailure(`${payload.response || ""}\n${backend?.readStderr(id) || ""}`);
        if (why) {
          task.limit = why;
          markLimited(b, task.owner, why);
        }
      }
      task.result = payload.response || "";
      task.conversationId = payload.conversation_id || task.conversationId;
      task.usage = payload.usage;
      task.durationSeconds = payload.duration_seconds;
      task.updated = Date.now();
      releaseTaskLocks(b, id);
      settlePresence(b, task.owner, id);
      logEvent(b, AGENT, `task.${task.status}`, `${id} ${task.title}`);
      return task;
    });
  }

  if (!isAlive(t.pid)) {
    return await mutate((b) => {
      const task = b.tasks.find((x) => x.id === id);
      if (!task) return { error: `no such task: ${id}` };
      task.status = "failed";
      task.error = backend?.readStderr(id) || `${t.owner} exited without producing output`;
      const why = classifyFailure(task.error);
      if (why) {
        task.limit = why;
        // Said on the task itself, because this is where the caller looks
        // when it discovers the failure -- and re-typing the brief is the
        // expensive mistake it would otherwise make next.
        task.next = `${task.owner} is unavailable (${why.kind}). Move this work with task_reassign("${id}", to) rather than re-writing the brief.`;
        markLimited(b, task.owner, why);
      }
      task.updated = Date.now();
      releaseTaskLocks(b, id);
      settlePresence(b, task.owner, id);
      logEvent(b, AGENT, "task.failed", `${id} ${task.title}`);
      return task;
    });
  }
  return t;
}

function slim(t) {
  if (!t || t.error) return t;
  const { detail, ...rest } = t;
  return { ...rest, age: ago(t.created) };
}

/**
 * Backend usage objects are wildly inconsistent in shape and, for claude and
 * agy, can carry a full per-iteration cache/tool-use breakdown -- passed
 * through verbatim from readResult(), it can run to hundreds of tokens for
 * something a caller checking on a task almost always just wants a total
 * for. Reduced to the handful of numbers actually useful for "how much did
 * this cost" by default; the raw breakdown is still available on request.
 */
function summarizeUsage(usage) {
  if (!usage || typeof usage !== "object") return usage;
  const summary = {};
  if (typeof usage.input_tokens === "number") summary.input_tokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") summary.output_tokens = usage.output_tokens;
  if (typeof usage.total_tokens === "number") {
    summary.total_tokens = usage.total_tokens;
  } else if (typeof summary.input_tokens === "number" && typeof summary.output_tokens === "number") {
    summary.total_tokens = summary.input_tokens + summary.output_tokens;
  }
  if (typeof usage.totalApiDurationMs === "number") summary.api_duration_ms = usage.totalApiDurationMs;
  if (typeof usage.premiumRequests === "number") summary.premium_requests = usage.premiumRequests;
  // A shape this function doesn't recognize is more useful whole than empty.
  return Object.keys(summary).length ? summary : usage;
}

const PREVIEW_HEAD = 1200;
const PREVIEW_TAIL = 400;

/**
 * A delegated agent's final response can run to thousands of characters for
 * a real coding task -- fine when the caller actually wants the full text,
 * pure waste when it's just polling "is this done yet" and happens to catch
 * it right as it flips to done. Head+tail keeps both the opening explanation
 * and any closing summary, which is usually enough to judge success without
 * the whole transcript; the caller can always ask for output_mode:"full".
 */
function previewResult(text) {
  const total = text.length;
  if (total <= PREVIEW_HEAD + PREVIEW_TAIL + 200) return text; // not worth truncating
  const head = text.slice(0, PREVIEW_HEAD);
  const tail = text.slice(-PREVIEW_TAIL);
  return `${head}\n\n...[truncated -- ${total} chars total; call again with output_mode:"full" for everything]...\n\n${tail}`;
}

/**
 * Shared core of every `*_delegate` tool: validate cwd + bin, check for path
 * conflicts, spawn, and record the task + locks + presence on the board.
 */
async function delegateTask({ owner, toolPrefix, specId, id, briefing, cwd, spawnExtra, claim, findBin, spawn, title, prompt }) {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return { error: `cwd is not a directory: ${cwd}` };
  }
  try {
    findBin();
  } catch (e) {
    return { error: e.message };
  }

  // Refuse before spawning if this backend already can't work. Two sources:
  // what a previous task discovered the hard way, and (where a CLI publishes
  // it) its own local usage cache. Spawning anyway costs a process, a failed
  // task, and usually a retry -- all of it avoidable from information already
  // on hand. `alternatives` matters as much as the refusal: the point is to
  // send the work somewhere that can take it, not just to say no.
  const limited = activeLimits(read())[owner];
  const usage = specId ? localUsage(specId) : null;
  const spent = isExhausted(usage) ? usage : null;
  if (limited || spent) {
    const info = limited || { kind: "limit", resets_at: spent.resets_at, detail: `${spent.percent}% of its ${spent.window || "usage"} limit` };
    const eta = untilReset(info.resets_at);
    return {
      error: `${owner} is unavailable (${info.kind === "auth" ? "sign-in/access problem" : "at its usage limit"})`,
      detail: info.detail || undefined,
      resets_at: info.resets_at || undefined,
      resets_in: eta || undefined,
      alternatives: BACKENDS_LIST.map((s) => s.prefix).filter((p) => p !== toolPrefix),
      next: eta
        ? `Delegate to one of the alternatives, or retry in ${eta}. Don't re-delegate here until then.`
        : "Delegate to one of the alternatives instead of retrying this one.",
      // Only relevant to work that already exists, so it's mentioned rather
      // than assumed: a brand-new delegation has nothing to reassign.
      moving_existing_work: "task_reassign(task_id, to) replays a failed task's brief elsewhere without resending it",
    };
  }

  // Fast-path check before spawning, so an obvious conflict doesn't cost a
  // spawn -- advisory only. The authoritative check-and-set happens inside
  // mutate() below, under the board lock, closing the race where two
  // *_delegate calls for an overlapping path both pass this check before
  // either has recorded its lock (same pattern claim_paths already uses).
  const conflicts = read().locks
    .filter((l) => l.owner !== owner && claim.some((c) => overlaps(c, l.path)))
    .map((l) => ({ path: l.path, held_by: l.owner }));
  if (conflicts.length) return { error: "path conflict; resolve before delegating", conflicts };

  let pid;
  try {
    pid = spawn(id, briefing, { cwd, ...spawnExtra });
  } catch (e) {
    return { error: `failed to launch ${owner}: ${e.message}` };
  }

  const raceLoss = await mutate((b) => {
    const now = Date.now();
    const raceConflicts = b.locks
      .filter((l) => l.owner !== owner && claim.some((c) => overlaps(c, l.path)))
      .map((l) => ({ path: l.path, held_by: l.owner }));
    if (raceConflicts.length) return raceConflicts;

    b.tasks.push({
      // The full brief is deliberately NOT stored here. Every spawn already
      // writes it to runs/<id>.prompt.txt, nothing ever reads it back off the
      // board (slim() strips `detail` from every response), and briefs run to
      // multiple KB -- which the board then re-parsed on every single read,
      // including once per poll for the life of a *_task_wait.
      id, title, owner, assignedBy: AGENT, model: spawnExtra?.model || null,
      // Just the paths, not the brief: small enough not to bloat the board,
      // and without them a reassignment can't reserve what the original held.
      ...(claim.length && { claim }),
      status: "running", cwd, kind: "delegated", pid, created: now, updated: now,
    });
    for (const p of claim) {
      b.locks = b.locks.filter((l) => l.path !== p);
      b.locks.push({ path: p, owner, taskId: id, note: title, created: now });
    }
    // Spread, for the same reason settlePresence() does: if this delegate runs
    // its own copy of this server, model/pid/cwd are facts it reported about
    // itself, not ours to overwrite just because we handed it a task.
    b.presence[owner] = { ...b.presence[owner], status: "working", detail: title, ts: now };
    logEvent(b, AGENT, "task.delegated", `${id} ${title}`);
    return null;
  });

  if (raceLoss) {
    // Someone else's *_delegate call won the same path between our check and
    // now -- the child is already running, but it must not be left believing
    // it owns paths another agent actually holds, so kill it and surface the
    // conflict same as the pre-spawn check would have.
    killTree(pid);
    return { error: "path conflict; resolve before delegating", conflicts: raceLoss };
  }

  return {
    task_id: id, status: "running", pid, cwd, claimed: claim,
    next: `Keep working on your own part; check ${toolPrefix}_task_status(task_id) later.`,
  };
}

/**
 * Prepended to every delegated brief. Each line below is here because its
 * absence costs real tokens or real rework: a delegate that gold-plates a
 * one-file fix burns a whole session on work nobody asked for, one that
 * reports "done" without checking sends the delegator off to verify from
 * scratch, and one that stops silently strands the task with no way to pick
 * it up. Kept deliberately short -- it is paid on every single delegation,
 * and padding it would contradict the last rule in it.
 */
const WORKING_AGREEMENT =
  `HOW TO WORK THIS TASK\n` +
  `- Scope: do what was asked and stop. Spot something else worth doing? Report it, don't fix it.\n` +
  `- Decide and act: the files listed as yours are yours to edit. Don't stop to ask permission.\n` +
  `- Verify before you claim done: run the build, test, or command that proves it. Unchecked is not done.\n` +
  `- Stuck or out of room? Say what you did, what's left, and what you learned, so it can be handed off.\n` +
  `- Your final message IS the handoff: what changed, where, what to check. No narration, no transcript.\n`;

function briefingFor(owner, cwd, claim, prompt) {
  return (
    `PROJECT ROOT: ${cwd}\n` +
    `Do all work inside that directory using absolute paths. Do not create a scratch project elsewhere.\n` +
    `You are the '${owner}' agent working in parallel with another AI agent on this project. ` +
    `It has assigned you the task below and is working on other parts of the codebase at the same time.\n` +
    (claim.length ? `PATHS RESERVED FOR YOU: ${claim.join(", ")}\n` : "") +
    `If the coordination MCP server is available to you, call coop_status first and ` +
    `claim_paths before editing; stay off paths another agent holds.\n\n` +
    `${WORKING_AGREEMENT}\n--- TASK ---\n${prompt}`
  );
}

async function followupTask({ owner, task_id, prompt, spawn, buildExtra }) {
  const parent = await reap(task_id);
  // Same distinction as task_reassign: a failed task carries its stderr in
  // `.error`, so only a missing-task envelope (no id) is a lookup failure.
  // A task that failed but still has a session id is legitimately resumable.
  if (!parent.id) return parent;
  // Each backend resumes by its OWN id format (agy --conversation, copilot and
  // claude --resume), so following up on another backend's task would hand a
  // session id to a CLI that has never heard of it. Nothing else catches this:
  // the caller picks the tool, and the task_id alone doesn't imply the tool.
  if (parent.owner !== owner) {
    return {
      error: `task ${task_id} belongs to ${parent.owner}, not ${owner}; use that backend's followup tool instead`,
    };
  }
  if (["running", "queued"].includes(parent.status)) {
    return { error: `task ${task_id} is still running; wait for it before following up` };
  }
  if (!parent.conversationId) {
    return { error: `task ${task_id} has no conversation_id (status=${parent.status})` };
  }
  const id = taskId();
  let pid;
  try {
    pid = spawn(id, prompt, { cwd: parent.cwd, ...buildExtra(parent.conversationId) });
  } catch (e) {
    return { error: `failed to launch ${owner}: ${e.message}` };
  }
  await mutate((b) => {
    const now = Date.now();
    b.tasks.push({
      // Same as delegateTask: the prompt lives in runs/<id>.prompt.txt, not here.
      id, title: `follow-up: ${parent.title}`, owner,
      assignedBy: AGENT, status: "running", cwd: parent.cwd, kind: "delegated",
      // A follow-up continues the same conversation/session, so it's the
      // same model even though nothing about model choice is re-specified.
      conversationId: parent.conversationId, model: parent.model ?? null, pid, created: now, updated: now,
    });
    // A follow-up is real work by that agent, same as the original delegation
    // -- without this it runs while the board still shows the agent idle, and
    // settlePresence() later has nothing to settle.
    b.presence[owner] = { ...b.presence[owner], status: "working", detail: `follow-up: ${parent.title}`, ts: now };
    logEvent(b, AGENT, "task.followup", `${id} <- ${task_id}`);
  });
  return { task_id: id, status: "running", conversation_id: parent.conversationId, pid };
}

async function cancelTask(task_id) {
  const t = read().tasks.find((x) => x.id === task_id);
  if (!t) return { error: `no such task: ${task_id}` };
  killTree(t.pid);
  const gone = await mutate((b) => {
    const task = b.tasks.find((x) => x.id === task_id);
    // Same re-read race as reap(): the process is dead either way, which is
    // the part that matters, but there's no record left to mark cancelled.
    if (!task) return true;
    task.status = "cancelled";
    task.updated = Date.now();
    releaseTaskLocks(b, task_id);
    settlePresence(b, task.owner, task_id);
    logEvent(b, AGENT, "task.cancelled", task_id);
    return false;
  });
  if (gone) return { task_id, status: "cancelled", note: "process killed; task record was already gone from the board" };
  return { task_id, status: "cancelled", released_locks: true };
}

/**
 * task_status, task_wait and cancel are byte-for-byte identical logic across
 * all three backends -- only the tool name prefix and the label used in
 * generated titles/descriptions differ. Factored out so the three copies
 * can't drift out of sync the way they had started to (agy/claude/copilot's
 * conversation_id wording had already diverged before this refactor).
 */
function registerDelegationTools(server, spec) {
  const toolPrefix = spec.prefix;
  const label = spec.label;
  const idNote = spec.sessionNote ? ` ${spec.sessionNote}` : "";

  server.registerTool(
    `${toolPrefix}_delegate`,
    {
      title: `Delegate a task to ${label}`,
      description:
        `Delegate to ${label}. Starts it detached and returns a task_id immediately. ` +
        `Prompt must be a self-contained brief: goal, stack/conventions, files owned, what NOT to touch, ` +
        `and the contract -- it cannot see your conversation. Use claim to reserve paths; auto_approve ` +
        `enables unattended edits.` + (spec.note ? ` Note: ${spec.note}` : ""),
      inputSchema: {
        title: z.string().describe("Short label for the board"),
        prompt: z.string().describe(`Self-contained brief; ${label} starts cold`),
        cwd: z.string().describe("Absolute path to the project root"),
        model: z.string().optional().describe(spec.modelHint || "Model override"),
        add_dirs: z.array(z.string()).optional(),
        claim: z.array(z.string()).optional().describe(`Paths ${label} will own`),
        auto_approve: z.boolean().optional(),
        // Only offered where the CLI actually has the flag -- advertising an
        // option the backend ignores is worse than not offering it.
        ...(spec.id === "ag" && {
          mode: z.enum(["accept-edits", "plan"]).optional(),
          effort: z.enum(["low", "medium", "high"]).optional(),
          timeout_seconds: z.number().int().optional(),
        }),
        ...(spec.id === "copilot" && {
          effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
        }),
      },
    },
    async (a) => {
      const cwd = path.resolve(a.cwd);
      const claim = (a.claim || []).map(norm);
      const id = taskId();
      return ok(
        await delegateTask({
          owner: spec.owner, toolPrefix, specId: spec.id, id, cwd, claim, title: a.title, prompt: a.prompt,
          briefing: briefingFor(spec.owner, cwd, claim, a.prompt),
          findBin: spec.findBin,
          spawn: (taskId_, briefing, extra) => spawnBackend(spec, taskId_, briefing, extra),
          spawnExtra: {
            model: a.model, mode: a.mode, effort: a.effort,
            addDirs: a.add_dirs || [], autoApprove: a.auto_approve ?? true,
            timeoutSeconds: a.timeout_seconds,
          },
        })
      );
    }
  );

  if (spec.resume) {
    server.registerTool(
      `${toolPrefix}_followup`,
      {
        title: `Follow up in the same ${label} session`,
        description:
          `Send a follow-up into the SAME ${label} session as a finished task, so it keeps its ` +
          `context (e.g. 'now make the header responsive'). Use this rather than a fresh ` +
          `${toolPrefix}_delegate whenever the request builds on work it just did.`,
        inputSchema: { task_id: z.string(), prompt: z.string() },
      },
      async ({ task_id, prompt }) =>
        ok(
          await followupTask({
            owner: spec.owner, task_id, prompt,
            spawn: (taskId_, p, extra) => spawnBackend(spec, taskId_, p, extra),
            buildExtra: (conversationId) => ({ resume: conversationId }),
          })
        )
    );
  }

  // Shared by *_task_status and both return points of *_task_wait, so the
  // trim behaves identically everywhere a task record leaves this server.
  const trim = (t, { include_output, include_usage_detail, output_mode }) => {
    if (!t || t.error) return t;
    if (!include_output) delete t.result;
    else if (output_mode !== "full" && typeof t.result === "string") t.result = previewResult(t.result);
    if (!include_usage_detail && t.usage) t.usage = summarizeUsage(t.usage);
    return t;
  };

  server.registerTool(
    `${toolPrefix}_task_status`,
    {
      title: `Check a delegated ${label} task`,
      description:
        `Check a delegated ${label} task: running / done / failed, plus its final ` +
        `response and conversation_id${idNote} once finished. By default a long response ` +
        `comes back as a head/tail preview, not the whole thing -- pass output_mode:"full" for everything.`,
      inputSchema: {
        task_id: z.string(),
        include_output: z.boolean().optional(),
        include_usage_detail: z.boolean().optional(),
        output_mode: z.enum(["preview", "full"]).optional(),
      },
    },
    async ({ task_id, include_output = true, include_usage_detail = false, output_mode = "preview" }) =>
      ok(trim(slim(await reap(task_id)), { include_output, include_usage_detail, output_mode }))
  );

  server.registerTool(
    `${toolPrefix}_task_wait`,
    {
      title: `Wait for a delegated ${label} task`,
      description:
        `Block until a delegated ${label} task finishes, or until timeout. Prefer ` +
        `${toolPrefix}_task_status and doing your own work in between -- only wait when you ` +
        `genuinely cannot proceed without ${label}'s result. Waiting costs nothing while blocked, ` +
        `so the default timeout is generous -- raise it further rather than re-polling in a loop.`,
      inputSchema: {
        task_id: z.string(),
        timeout_seconds: z.number().int().optional(),
        include_usage_detail: z.boolean().optional(),
        output_mode: z.enum(["preview", "full"]).optional(),
      },
    },
    async ({ task_id, timeout_seconds = 300, include_usage_detail = false, output_mode = "preview" }) => {
      const deadline = Date.now() + Math.max(1, timeout_seconds) * 1000;
      for (;;) {
        const t = await reap(task_id);
        if (t.error || ["done", "failed", "cancelled"].includes(t.status)) {
          return ok(trim(slim(t), { include_output: true, include_usage_detail, output_mode }));
        }
        if (Date.now() >= deadline) {
          return ok({ ...slim(t), timed_out_waiting: true, note: `Still running. Call ${toolPrefix}_task_status later.` });
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  );

  server.registerTool(
    `${toolPrefix}_cancel`,
    {
      title: `Cancel a delegated ${label} task`,
      description: `Stop a running delegated ${label} task and release any paths it held.`,
      inputSchema: { task_id: z.string() },
    },
    async ({ task_id }) => ok(await cancelTask(task_id))
  );
}

export async function buildServer() {
  ensureDirs();
  await resolveAgentIdentity();

  // Heartbeat: MCP gives no onDisconnect hook, so a live consumer (e.g. a UI
  // bridge watching the board) has no way to tell "connected but idle" apart
  // from "process exited without a clean disconnect" -- recency of this
  // timestamp is the signal. Touches presence on startup and every 15s.
  const touchPresence = async () => {
    try {
      await mutate((b) => {
        const existing = b.presence[AGENT];
        // pid/cwd are this process's own, always current; model/status/detail
        // are whatever was last self-reported -- carried forward explicitly
        // since this replaces the whole record every 15s, and a field this
        // loop doesn't know about would otherwise quietly vanish next beat.
        b.presence[AGENT] = {
          status: existing?.status ?? "idle",
          detail: existing?.detail ?? "",
          model: existing?.model ?? null,
          pid: process.pid,
          cwd: process.cwd(),
          ts: Date.now(),
        };
      });
    } catch (e) {
      // Background heartbeat shouldn't crash the server if it fails (e.g. if the lock times out).
    }
  };
  touchPresence();
  const heartbeat = setInterval(touchPresence, 15000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const server = new McpServer(
    { name: "antigravity", version: "0.1.0" },
    {
      instructions:
        "Shared MCP for delegating to agy/copilot/claude and a shared coordination board.\n" +
        "Working rules:\n" +
        "- Call coop_status before starting work; claim_paths before edits and release_paths after.\n" +
        "- Don't edit paths another agent holds; send a note instead.\n" +
        "- Delegations may be any task; split work by clear contract.\n" +
        // Every one of these is a failure this board has actually seen: briefs
        // that assumed shared context the delegate never had, assignments left
        // sitting because nobody claimed them, and a delegate reporting work it
        // had not done.
        "- A delegate starts cold. Brief it with the goal, the conventions in use, the files it owns, " +
        "and what NOT to touch -- it cannot see your conversation.\n" +
        "- Own what you're assigned: board_update to running when you pick it up, done when it's finished.\n" +
        "- Check a delegate's actual diff before trusting its \"done\" -- a confident summary is not evidence.",
    }
  );

  server.registerTool(
    "coop_status",
    {
      title: "Coordination status",
      description:
        "One-stop situational awareness: who's online, active tasks, locked paths, unread notes, and orphaned locks. " +
        "Call before editing to avoid conflicts. Pass since_seq (the seq this call returns) next time to get back " +
        "{unchanged:true} instead of the full payload when nothing has changed. Flags identity_collision if another " +
        "real process is registered under this same --agent id, sharing your presence slot and lock ownership. " +
        "Also surfaces my_open_assignments -- board_post items owned by you that nobody has started -- on every " +
        "call until you move them off \"open\", so an assignment can't get silently missed.",
      inputSchema: { since_seq: z.number().int().optional() },
    },
    async ({ since_seq } = {}) => {
      for (const t of read().tasks.filter((x) => x.kind === "delegated" && ["running", "queued"].includes(x.status))) {
        await reap(t.id);
      }
      const b = read();
      if (since_seq != null && b.seq === since_seq) return ok({ unchanged: true, seq: b.seq });
      const taskById = new Map(b.tasks.map((t) => [t.id, t]));
      const lockedPaths = b.locks.map((l) => {
        const task = l.taskId ? taskById.get(l.taskId) : null;
        // A lock tied to a task that's gone, or already terminal, outlived the
        // work it was reserved for -- reap() releases these itself the moment
        // it next reconciles that task, but nothing forces that to happen
        // promptly, and a lock claimed by hand (no taskId at all) is never
        // orphaned this way, since it was never tied to a task's lifetime.
        const orphaned = !!l.taskId && (!task || !["running", "queued"].includes(task.status));
        return {
          path: l.path, owner: l.owner, note: l.note, since: ago(l.created),
          ...(orphaned && {
            orphaned: true,
            orphan_reason: task ? `its task (${l.taskId}) is already ${task.status}` : `its task (${l.taskId}) no longer exists`,
          }),
        };
      });
      const orphanedCount = lockedPaths.filter((l) => l.orphaned).length;
      // Two real processes registered under the same --agent id (e.g. two
      // Claude Code windows both launched as "claude-code") silently share
      // one presence slot and one set of locks -- whichever last touched
      // presence wins, clobbering the other. Since every heartbeat stamps
      // its own real pid, a mismatch here means exactly that just happened.
      const myPresence = b.presence[AGENT];
      // Same freshness reasoning as resolveAgentIdentity(): pids get recycled
      // (aggressively on Windows), so a stale record could otherwise flag a
      // long-gone sibling as a live collision for up to 15s after it exited.
      const collisionFresh = Date.now() - (myPresence?.ts || 0) < 60_000;
      const identityCollision = myPresence?.pid && myPresence.pid !== process.pid && collisionFresh && isAlive(myPresence.pid);
      const activeTasks = b.tasks
        .filter((t) => ["open", "running", "queued", "blocked"].includes(t.status))
        .map((t) => ({
          id: t.id, title: t.title, owner: t.owner, status: t.status,
          kind: t.kind, cwd: t.cwd, age: ago(t.created),
        }));
      const unreadNotes = b.notes
        .filter((n) => [AGENT, "all"].includes(n.to) && n.from !== AGENT && !n.readAt)
        .map((n) => ({ id: n.id, from: n.from, body: n.body, when: ago(n.created) }));
      // board_post assigns work without running it -- nothing forces the
      // assignee to notice or act on it beyond the one-time note sent when it
      // was posted. Surfacing it here too means it can't get lost: it shows
      // up on every coop_status call (which the working agreement already
      // requires before starting anything) until its status actually moves
      // off "open," not just once and then forgotten.
      const limitedBackends = activeLimits(b);
      const myOpenAssignments = b.tasks
        .filter((t) => t.kind === "board" && t.owner === AGENT && t.status === "open")
        .map((t) => ({ id: t.id, title: t.title, assigned_by: t.assignedBy, age: ago(t.created) }));
      // 6, not 12 -- an LLM reader rarely needs a deep history to orient
      // itself, and this list is included on every single call.
      const recentActivity = b.events.slice(-6).reverse().map((e) => ({
        agent: e.agent, kind: e.kind, detail: e.detail, when: ago(e.ts),
      }));
      return ok({
        you_are: AGENT,
        seq: b.seq,
        presence: Object.entries(b.presence).map(([agent, p]) => ({
          agent, status: p.status, detail: p.detail, last_seen: ago(p.ts),
          ...(p.model && { model: p.model }),
          ...(p.pid && { pid: p.pid, cwd: p.cwd }),
        })),
        // Nothing locked/pending/unread is the common case -- omitting the
        // key entirely reads the same to an LLM as an empty array, for free.
        ...(activeTasks.length && { active_tasks: activeTasks }),
        ...(lockedPaths.length && { locked_paths: lockedPaths }),
        ...(unreadNotes.length && { unread_notes: unreadNotes }),
        ...(myOpenAssignments.length && { my_open_assignments: myOpenAssignments }),
        // Only present when something is actually unavailable -- an agent
        // planning who to hand work to needs this, and nobody should pay for
        // it on the calls where every backend is fine.
        ...(Object.keys(limitedBackends).length && {
          unavailable_backends: Object.entries(limitedBackends).map(([owner, l]) => ({
            owner, reason: l.kind, ...(l.resets_at && { resets_in: untilReset(l.resets_at) }),
          })),
        }),
        ...(recentActivity.length && { recent_activity: recentActivity }),
        ...(identityCollision && {
          identity_collision: {
            agent: AGENT, your_pid: process.pid, your_cwd: process.cwd(),
            other_pid: myPresence.pid, other_cwd: myPresence.cwd,
          },
        }),
        hint:
          "Locked paths belong to their owner. Do not edit them; use notes_send instead." +
          (orphanedCount
            ? ` ${orphanedCount} lock(s) are marked orphaned -- their task is already over. ` +
              "Point it out to that agent (notes_send) rather than editing past it."
            : "") +
          (identityCollision
            ? ` identity_collision: another process is ALSO registered as "${AGENT}" (pid ${myPresence.pid}, ` +
              `cwd ${myPresence.cwd}) -- you're sharing one presence slot and lock ownership with it, which is ` +
              "almost certainly unintended. Give each concurrent session its own --agent id."
            : "") +
          (myOpenAssignments.length
            ? ` You have ${myOpenAssignments.length} open assignment(s) nobody has started yet -- take ` +
              "ownership (board_update status:\"running\") or hand it back with a reason, don't leave it sitting."
            : ""),
      });
    }
  );

  // One delegate + followup + status/wait/cancel per backend, generated from
  // the registry rather than hand-written per CLI -- adding a backend is a
  // spec, not another copy of these five tools.
  for (const spec of BACKENDS_LIST) {
    registerDelegationTools(server, spec);
  }

  server.registerTool(
    "task_reassign",
    {
      title: "Send a failed task to a different backend",
      description:
        "Re-run a finished-or-failed task's ORIGINAL brief on a different backend -- the usual answer " +
        "when one hits its usage limit. The brief is replayed from disk, so you do not resend it and " +
        "pay no tokens for it. Keeps the same project directory and re-reserves the same paths. " +
        "Use this instead of writing the delegation again from memory.",
      inputSchema: {
        task_id: z.string().describe("The task that failed"),
        to: z.string().describe("Backend prefix to run it on instead, e.g. copilot"),
        note: z.string().optional().describe("Anything the new agent should know that the original brief doesn't say"),
      },
    },
    async ({ task_id, to, note }) => {
      const original = await reap(task_id);
      // `.error` on a task is its stderr -- every failed task has one, and a
      // failed task is exactly what gets reassigned. Only a reap envelope with
      // no id means the task genuinely isn't there.
      if (!original.id) return ok(original);
      if (["running", "queued"].includes(original.status)) {
        return ok({ error: `task ${task_id} is still running; cancel it first if you want it moved` });
      }
      const spec = BACKENDS_LIST.find((s) => s.prefix === to || s.id === to);
      if (!spec) {
        return ok({
          error: `no installed backend "${to}"`,
          available: BACKENDS_LIST.map((s) => s.prefix),
        });
      }
      // Replayed from runs/<id>.prompt.txt, which is why this costs the caller
      // nothing: the brief never has to pass through the model again.
      const brief = recoverTask(task_id);
      if (!brief) {
        return ok({ error: `original brief for ${task_id} is no longer on disk; re-delegate it manually` });
      }
      const prompt = note ? `${brief}\n\n--- ALSO ---\n${note}` : brief;
      const cwd = original.cwd || process.cwd();
      const claim = (original.claim || []).map(norm);
      const id = taskId();
      const result = await delegateTask({
        owner: spec.owner, toolPrefix: spec.prefix, specId: spec.id, id, cwd, claim,
        title: `reassigned: ${original.title}`, prompt,
        briefing: briefingFor(spec.owner, cwd, claim, prompt),
        findBin: spec.findBin,
        spawn: (tid, b, extra) => spawnBackend(spec, tid, b, extra),
        spawnExtra: { addDirs: [], autoApprove: true },
      });
      if (result.error) return ok(result);
      await mutate((b) => {
        const from = b.tasks.find((x) => x.id === task_id);
        const to_ = b.tasks.find((x) => x.id === id);
        if (from) from.reassignedTo = id;
        if (to_) to_.reassignedFrom = task_id;
        logEvent(b, AGENT, "task.reassigned", `${task_id} -> ${id} (${spec.prefix})`);
      });
      return ok({ ...result, reassigned_from: task_id, backend: spec.prefix });
    }
  );


  server.registerTool(
    "board_post",
    {
      title: "Post to the shared board",
      description:
        "Put an item on the shared board WITHOUT executing it -- a plan entry, a " +
        "hand-off, or an announcement that you are about to do something, so the other " +
        "agent can see it. Use ag_delegate instead when you want Antigravity to run it now. " +
        "The assignee gets a note automatically, and sees it as an open assignment every " +
        "time they call coop_status until they update its status.",
      inputSchema: {
        title: z.string(),
        owner: z.string().describe("Agent id, or 'unassigned'"),
        detail: z.string().optional(),
        cwd: z.string().optional(),
      },
    },
    async (a) => {
      const id = taskId();
      await mutate((b) => {
        const now = Date.now();
        b.tasks.push({
          id, title: a.title, detail: a.detail || "", owner: a.owner, assignedBy: AGENT,
          status: "open", cwd: a.cwd || "", kind: "board", created: now, updated: now,
        });
        // Posting an assignment doesn't make anyone aware of it by itself --
        // without this, it just sits there until the assignee happens to
        // call board_list on their own initiative, which is exactly how a
        // task gets silently dropped. Notify them directly, the same way any
        // other hand-off would (coop_status backs this up too, below).
        if (a.owner && a.owner !== "unassigned" && a.owner !== AGENT) {
          b.notes.push({
            id: nextId(b), from: AGENT, to: a.owner,
            body: `Assigned to you: "${a.title}" (task ${id}).${a.detail ? ` ${a.detail.slice(0, 200)}` : ""}`,
            created: now, readAt: null,
          });
        }
        logEvent(b, AGENT, "board.post", `${id} [${a.owner}] ${a.title}`);
      });
      return ok({ task_id: id, owner: a.owner, status: "open" });
    }
  );

  server.registerTool(
    "board_update",
    {
      title: "Update a board item",
      description:
        "Update a board item's status or owner, or attach a progress note. Keep your " +
        "own items current here so the other agent is not guessing.",
      inputSchema: {
        task_id: z.string(),
        status: z.enum(["open", "running", "blocked", "done", "failed", "cancelled"]).optional(),
        note: z.string().optional(),
        owner: z.string().optional(),
      },
    },
    async (a) => {
      const out = await mutate((b) => {
        const t = b.tasks.find((x) => x.id === a.task_id);
        if (!t) return { error: `no such task: ${a.task_id}` };
        if (a.status) t.status = a.status;
        if (a.owner) t.owner = a.owner;
        if (a.note) t.result = `${t.result || ""}\n[${AGENT}] ${a.note}`.trim();
        t.updated = Date.now();
        logEvent(b, AGENT, "board.update", `${a.task_id} ${a.status || ""} ${(a.note || "").slice(0, 80)}`);
        return t;
      });
      return ok(slim(out));
    }
  );

  server.registerTool(
    "board_list",
    {
      title: "List board items",
      description: "List board items and delegated tasks. Filter by owner to see just one lane.",
      inputSchema: {
        owner: z.string().optional().describe("Agent id; omit for all"),
        include_done: z.boolean().optional(),
        limit: z.number().int().optional(),
      },
    },
    async ({ owner, include_done = false, limit = 20 }) => {
      let items = read().tasks;
      if (owner) items = items.filter((t) => t.owner === owner);
      if (!include_done) items = items.filter((t) => !["done", "cancelled", "failed"].includes(t.status));
      items = items.slice(-Math.max(1, limit)).map((t) => ({
        id: t.id, title: t.title, owner: t.owner, assigned_by: t.assignedBy,
        status: t.status, kind: t.kind, cwd: t.cwd, age: ago(t.created),
      }));
      return ok({ count: items.length, items });
    }
  );

  server.registerTool(
    "claim_paths",
    {
      title: "Claim paths you are about to edit",
      description:
        "Lock files or directories you are about to edit, so the other agent stays off " +
        "them. A directory lock covers everything under it. Returns granted vs conflicts " +
        "-- if a path is held by the other agent, do NOT edit it; pick different work or " +
        "send a note asking for a hand-off.",
      inputSchema: {
        paths: z.array(z.string()),
        note: z.string().optional(),
        task_id: z.string().optional(),
      },
    },
    async ({ paths, note = "", task_id }) => {
      const out = await mutate((b) => {
        const granted = [], conflicts = [];
        for (const raw of paths) {
          const p = norm(raw);
          const clash = b.locks.find((l) => l.owner !== AGENT && overlaps(p, l.path));
          if (clash) {
            conflicts.push({ path: p, held_by: clash.owner, their_note: clash.note });
          } else {
            b.locks = b.locks.filter((l) => l.path !== p);
            b.locks.push({ path: p, owner: AGENT, taskId: task_id, note, created: Date.now() });
            granted.push(p);
          }
        }
        logEvent(b, AGENT, "locks.claim", `${granted.length} granted, ${conflicts.length} conflicts`);
        return { granted, conflicts };
      });
      return ok({ owner: AGENT, ...out, hint: "Call release_paths when you are done editing." });
    }
  );

  server.registerTool(
    "release_paths",
    {
      title: "Release your path locks",
      description:
        "Release path locks you hold. Pass all_mine=true to drop every lock you own -- " +
        "do this when you finish a chunk of work so the other agent is not blocked.",
      inputSchema: {
        paths: z.array(z.string()).optional(),
        all_mine: z.boolean().optional(),
      },
    },
    async ({ paths = [], all_mine = false }) => {
      const released = await mutate((b) => {
        const before = b.locks.length;
        const targets = paths.map(norm);
        b.locks = b.locks.filter((l) =>
          l.owner !== AGENT ? true : all_mine ? false : !targets.includes(l.path)
        );
        const n = before - b.locks.length;
        logEvent(b, AGENT, "locks.release", `${n} released`);
        return n;
      });
      return ok({ released, owner: AGENT });
    }
  );

  server.registerTool(
    "check_paths",
    {
      title: "Check whether paths are free",
      description:
        "Ask whether specific paths are free before touching them. Cheaper than claiming " +
        "when you only want to read the situation.",
      inputSchema: { paths: z.array(z.string()) },
    },
    async ({ paths }) => {
      const locks = read().locks;
      return ok({
        you_are: AGENT,
        paths: paths.map((raw) => {
          const p = norm(raw);
          const holder = locks.find((l) => overlaps(p, l.path));
          return {
            path: p,
            free: !holder || holder.owner === AGENT,
            held_by: holder ? holder.owner : null,
            note: holder ? holder.note : "",
          };
        }),
      });
    }
  );

  server.registerTool(
    "notes_send",
    {
      title: "Message the other agent",
      description:
        "Leave a message for the other agent -- an interface contract, a hand-off, a " +
        "heads-up that you changed something they depend on. Make it self-contained and " +
        "concrete: 'POST /api/orders is live, returns {id, status}. Wire the form to it.'",
      inputSchema: {
        body: z.string(),
        to: z.string().optional().describe("Agent id, or 'all' (default)"),
      },
    },
    async ({ body, to = "all" }) => {
      const id = await mutate((b) => {
        const nid = nextId(b);
        b.notes.push({ id: nid, from: AGENT, to, body, created: Date.now(), readAt: null });
        logEvent(b, AGENT, "note.sent", `-> ${to}: ${body.slice(0, 80)}`);
        return nid;
      });
      return ok({ note_id: id, from: AGENT, to });
    }
  );

  server.registerTool(
    "notes_read",
    {
      title: "Read messages addressed to you",
      description: "Read messages the other agent left for you.",
      inputSchema: {
        unread_only: z.boolean().optional(),
        mark_read: z.boolean().optional(),
        limit: z.number().int().optional(),
      },
    },
    async ({ unread_only = true, mark_read = true, limit = 10 }) => {
      const notes = await mutate((b) => {
        let got = b.notes.filter((n) => [AGENT, "all"].includes(n.to) && n.from !== AGENT);
        if (unread_only) got = got.filter((n) => !n.readAt);
        got = got.slice(-Math.max(1, limit));
        if (mark_read) for (const n of got) n.readAt = Date.now();
        return got.map((n) => ({ id: n.id, from: n.from, body: n.body, when: ago(n.created) }));
      });
      return ok({ count: notes.length, notes });
    }
  );

  server.registerTool(
    "presence_set",
    {
      title: "Announce what you are doing",
      description:
        "Announce what you are doing right now, so the other agent's coop_status shows " +
        "it. Call when you start and finish a chunk of work. Pass model once at session " +
        "start (e.g. \"claude-sonnet-5\") if you know it -- otherwise this identity shows no " +
        "model while idle, since model is normally only known for an active delegated task.",
      inputSchema: {
        status: z.enum(["idle", "working", "blocked", "offline"]),
        detail: z.string().optional(),
        model: z.string().optional(),
      },
    },
    async ({ status, detail = "", model }) => {
      await mutate((b) => {
        const existing = b.presence[AGENT];
        b.presence[AGENT] = {
          status, detail, model: model ?? existing?.model ?? null,
          pid: process.pid, cwd: process.cwd(), ts: Date.now(),
        };
        logEvent(b, AGENT, "presence", `${status}: ${detail.slice(0, 80)}`);
      });
      return ok({ agent: AGENT, status, detail });
    }
  );

  server.registerTool(
    "activity",
    {
      title: "Recent activity timeline",
      description:
        "Recent timeline of what both agents have done -- delegations, claims, releases, " +
        "notes, status changes.",
      inputSchema: { limit: z.number().int().optional() },
    },
    async ({ limit = 12 }) => {
      const events = read().events.slice(-Math.max(1, limit)).map((e) => ({
        agent: e.agent, kind: e.kind, detail: e.detail, when: ago(e.ts),
      }));
      return ok({ events });
    }
  );

  server.registerTool(
    "coop_reset",
    {
      title: "Clear the shared board",
      description:
        "Clear the whole board -- tasks, locks, notes, events, presence. Destructive; " +
        "requires confirm=true. Use when starting a fresh project.",
      inputSchema: { confirm: z.boolean().optional() },
    },
    async ({ confirm = false }) => {
      if (!confirm) return ok({ error: "pass confirm=true to wipe the board" });
      await mutate((b) => {
        b.tasks = []; b.locks = []; b.notes = []; b.events = []; b.presence = {}; b.limits = {}; b.seq = 0;
        logEvent(b, AGENT, "board.reset", "cleared");
      });
      return ok({ reset: true });
    }
  );

  return server;
}

export async function runStdio() {
  const server = await buildServer();
  await server.connect(new StdioServerTransport());
}
