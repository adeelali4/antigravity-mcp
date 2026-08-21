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
 * id; that id is the identity everything on the board is attributed to.
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
import { spawnAgy, readResult as readAgyResult, readStderr as readAgyStderr, findAgy } from "./agy.js";
import {
  spawnCopilot, readResult as readCopilotResult, readStderr as readCopilotStderr, findCopilot,
} from "./copilot.js";
import {
  spawnClaude, readResult as readClaudeResult, readStderr as readClaudeStderr, findClaude,
} from "./claude.js";

/**
 * One entry per delegation target, keyed by the `owner` string recorded on the
 * task -- that string doubles as the backend selector so reap() does not need
 * a second field to stay in sync with `owner`.
 */
const BACKENDS = {
  antigravity: { findBin: findAgy, spawn: spawnAgy, readResult: readAgyResult, readStderr: readAgyStderr },
  copilot: { findBin: findCopilot, spawn: spawnCopilot, readResult: readCopilotResult, readStderr: readCopilotStderr },
  // Not "claude" -- the calling agent's own board identity is sometimes that
  // literal string, and owner doubles as the BACKENDS key, so a collision
  // there would make a delegated task look like it belongs to the caller.
  "claude-agent": { findBin: findClaude, spawn: spawnClaude, readResult: readClaudeResult, readStderr: readClaudeStderr },
};

export const AGENT = (() => {
  const i = process.argv.indexOf("--agent");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.COOP_AGENT || "claude";
})();

const ok = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});

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

  const backend = BACKENDS[t.owner];
  const payload = backend?.readResult(id);
  if (payload) {
    return await mutate((b) => {
      const task = b.tasks.find((x) => x.id === id);
      task.status = payload.status === "SUCCESS" ? "done" : "failed";
      task.result = payload.response || "";
      task.conversationId = payload.conversation_id || task.conversationId;
      task.usage = payload.usage;
      task.durationSeconds = payload.duration_seconds;
      task.updated = Date.now();
      logEvent(b, AGENT, `task.${task.status}`, `${id} ${task.title}`);
      return task;
    });
  }

  if (!isAlive(t.pid)) {
    return await mutate((b) => {
      const task = b.tasks.find((x) => x.id === id);
      task.status = "failed";
      task.error = backend?.readStderr(id) || `${t.owner} exited without producing output`;
      task.updated = Date.now();
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
 * Shared core of every `*_delegate` tool: validate cwd + bin, check for path
 * conflicts, spawn, and record the task + locks + presence on the board.
 */
async function delegateTask({ owner, toolPrefix, id, briefing, cwd, spawnExtra, claim, findBin, spawn, title, prompt }) {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return { error: `cwd is not a directory: ${cwd}` };
  }
  try {
    findBin();
  } catch (e) {
    return { error: e.message };
  }

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

  await mutate((b) => {
    const now = Date.now();
    b.tasks.push({
      id, title, detail: prompt, owner, assignedBy: AGENT,
      status: "running", cwd, kind: "delegated", pid, created: now, updated: now,
    });
    for (const p of claim) {
      b.locks = b.locks.filter((l) => l.path !== p);
      b.locks.push({ path: p, owner, taskId: id, note: title, created: now });
    }
    b.presence[owner] = { status: "working", detail: title, ts: now };
    logEvent(b, AGENT, "task.delegated", `${id} ${title}`);
  });

  return {
    task_id: id, status: "running", pid, cwd, claimed: claim,
    next: `Keep working on your own part; check ${toolPrefix}_task_status(task_id) later.`,
  };
}

function briefingFor(owner, cwd, claim, prompt) {
  return (
    `PROJECT ROOT: ${cwd}\n` +
    `Do all work inside that directory using absolute paths. Do not create a scratch project elsewhere.\n` +
    `You are the '${owner}' agent working in parallel with another AI agent on this project. ` +
    `It has assigned you the task below and is working on other parts of the codebase at the same time.\n` +
    (claim.length ? `PATHS RESERVED FOR YOU: ${claim.join(", ")}\n` : "") +
    `If the coordination MCP server is available to you, call coop_status first and ` +
    `claim_paths before editing; stay off paths another agent holds.\n\n--- TASK ---\n${prompt}`
  );
}

async function followupTask({ owner, task_id, prompt, spawn, buildExtra }) {
  const parent = await reap(task_id);
  if (parent.error) return parent;
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
      id, title: `follow-up: ${parent.title}`, detail: prompt, owner,
      assignedBy: AGENT, status: "running", cwd: parent.cwd, kind: "delegated",
      conversationId: parent.conversationId, pid, created: now, updated: now,
    });
    logEvent(b, AGENT, "task.followup", `${id} <- ${task_id}`);
  });
  return { task_id: id, status: "running", conversation_id: parent.conversationId, pid };
}

async function cancelTask(task_id) {
  const t = read().tasks.find((x) => x.id === task_id);
  if (!t) return { error: `no such task: ${task_id}` };
  killTree(t.pid);
  await mutate((b) => {
    const task = b.tasks.find((x) => x.id === task_id);
    task.status = "cancelled";
    task.updated = Date.now();
    b.locks = b.locks.filter((l) => l.taskId !== task_id);
    logEvent(b, AGENT, "task.cancelled", task_id);
  });
  return { task_id, status: "cancelled", released_locks: true };
}

/**
 * task_status, task_wait and cancel are byte-for-byte identical logic across
 * all three backends -- only the tool name prefix and the label used in
 * generated titles/descriptions differ. Factored out so the three copies
 * can't drift out of sync the way they had started to (agy/claude/copilot's
 * conversation_id wording had already diverged before this refactor).
 */
function registerBackendStatusTools(server, { toolPrefix, label, conversationIdNote = "" }) {
  const idNote = conversationIdNote ? ` ${conversationIdNote}` : "";

  server.registerTool(
    `${toolPrefix}_task_status`,
    {
      title: `Check a delegated ${label} task`,
      description:
        `Check a delegated ${label} task: running / done / failed, plus its final ` +
        `response and conversation_id${idNote} once finished.`,
      inputSchema: {
        task_id: z.string(),
        include_output: z.boolean().optional(),
      },
    },
    async ({ task_id, include_output = true }) => {
      const t = slim(await reap(task_id));
      if (!include_output && t) delete t.result;
      return ok(t);
    }
  );

  server.registerTool(
    `${toolPrefix}_task_wait`,
    {
      title: `Wait for a delegated ${label} task`,
      description:
        `Block until a delegated ${label} task finishes, or until timeout. Prefer ` +
        `${toolPrefix}_task_status and doing your own work in between -- only wait when you ` +
        `genuinely cannot proceed without ${label}'s result.`,
      inputSchema: {
        task_id: z.string(),
        timeout_seconds: z.number().int().optional(),
      },
    },
    async ({ task_id, timeout_seconds = 120 }) => {
      const deadline = Date.now() + Math.max(1, timeout_seconds) * 1000;
      for (;;) {
        const t = await reap(task_id);
        if (t.error || ["done", "failed", "cancelled"].includes(t.status)) return ok(slim(t));
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

export function buildServer() {
  ensureDirs();

  // Heartbeat: MCP gives no onDisconnect hook, so a live consumer (e.g. a UI
  // bridge watching the board) has no way to tell "connected but idle" apart
  // from "process exited without a clean disconnect" -- recency of this
  // timestamp is the signal. Touches presence on startup and every 15s.
  const touchPresence = async () => {
    try {
      await mutate((b) => {
        const existing = b.presence[AGENT];
        b.presence[AGENT] = { status: existing?.status ?? "idle", detail: existing?.detail ?? "", ts: Date.now() };
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
        "Shared coordination channel with the Antigravity CLI (agy) and the GitHub " +
        "Copilot CLI (copilot), plus the ability to delegate work to either headlessly.\n\n" +
        "Working agreement:\n" +
        "- Call coop_status at the start of a work session and before touching files.\n" +
        "- Call claim_paths on files you are about to edit, release_paths when done.\n" +
        "- Never edit a path another agent holds; send a note instead.\n" +
        "- No fixed split: a delegated agent can be handed any kind of task -- backend, " +
        "tests, docs, a refactor -- not just UI/UX. Split along whatever contract fits " +
        "the actual feature.",
    }
  );

  server.registerTool(
    "coop_status",
    {
      title: "Coordination status",
      description:
        "One-stop situational awareness: who is online, what each agent is running, " +
        "which paths are locked, open tasks, and unread notes addressed to you. Call " +
        "this before starting work or editing files so you do not collide with the " +
        "other agent.",
      inputSchema: {},
    },
    async () => {
      for (const t of read().tasks.filter((x) => x.kind === "delegated" && ["running", "queued"].includes(x.status))) {
        await reap(t.id);
      }
      const b = read();
      return ok({
        you_are: AGENT,
        presence: Object.entries(b.presence).map(([agent, p]) => ({
          agent, status: p.status, detail: p.detail, last_seen: ago(p.ts),
        })),
        active_tasks: b.tasks
          .filter((t) => ["open", "running", "queued", "blocked"].includes(t.status))
          .map((t) => ({
            id: t.id, title: t.title, owner: t.owner, status: t.status,
            kind: t.kind, cwd: t.cwd, age: ago(t.created),
          })),
        locked_paths: b.locks.map((l) => ({
          path: l.path, owner: l.owner, note: l.note, since: ago(l.created),
        })),
        unread_notes: b.notes
          .filter((n) => [AGENT, "all"].includes(n.to) && n.from !== AGENT && !n.readAt)
          .map((n) => ({ id: n.id, from: n.from, body: n.body, when: ago(n.created) })),
        recent_activity: b.events.slice(-12).reverse().map((e) => ({
          agent: e.agent, kind: e.kind, detail: e.detail, when: ago(e.ts),
        })),
        hint: "Locked paths belong to their owner. Do not edit them; use notes_send instead.",
      });
    }
  );

  server.registerTool(
    "ag_delegate",
    {
      title: "Delegate a task to Antigravity",
      description:
        "Hand a task to Antigravity. Starts `agy` headlessly as a detached background " +
        "job and returns immediately with a task_id -- it does NOT block, so keep " +
        "working on your own part meanwhile.\n\n" +
        "Write `prompt` as a complete, self-contained brief: Antigravity cannot see " +
        "your conversation or your context. State the goal, the stack and conventions " +
        "actually in use, the files it owns, what it must NOT touch, and the API/prop " +
        "contract it must code against.\n\n" +
        "`claim` locks paths for Antigravity up front so you stay off them. " +
        "`auto_approve` passes --dangerously-skip-permissions so it can edit unattended.",
      inputSchema: {
        title: z.string().describe("Short label for the board"),
        prompt: z.string().describe("Self-contained brief; Antigravity starts cold"),
        cwd: z.string().describe("Absolute path to the project root"),
        model: z.string().optional().describe("e.g. gemini-3.1-pro-high for hard UI work"),
        mode: z.enum(["accept-edits", "plan"]).optional(),
        effort: z.enum(["low", "medium", "high"]).optional(),
        add_dirs: z.array(z.string()).optional(),
        claim: z.array(z.string()).optional().describe("Paths Antigravity will own"),
        timeout_seconds: z.number().int().optional(),
        auto_approve: z.boolean().optional(),
      },
    },
    async (a) => {
      const cwd = path.resolve(a.cwd);
      const claim = (a.claim || []).map(norm);
      const id = taskId();
      return ok(
        await delegateTask({
          owner: "antigravity", toolPrefix: "ag", id, cwd, claim, title: a.title, prompt: a.prompt,
          briefing: briefingFor("antigravity", cwd, claim, a.prompt),
          findBin: findAgy, spawn: spawnAgy,
          spawnExtra: {
            model: a.model, mode: a.mode ?? "accept-edits", effort: a.effort,
            addDirs: a.add_dirs || [], autoApprove: a.auto_approve ?? true,
            timeoutSeconds: a.timeout_seconds ?? 1800,
          },
        })
      );
    }
  );

  registerBackendStatusTools(server, { toolPrefix: "ag", label: "Antigravity" });

  server.registerTool(
    "ag_followup",
    {
      title: "Follow up in the same Antigravity conversation",
      description:
        "Send a follow-up into the SAME Antigravity conversation as a finished task, so " +
        "it keeps its context (e.g. 'now make the header responsive'). Use this rather " +
        "than a fresh ag_delegate whenever the request builds on work it just did.",
      inputSchema: {
        task_id: z.string(),
        prompt: z.string(),
        timeout_seconds: z.number().int().optional(),
      },
    },
    async ({ task_id, prompt, timeout_seconds = 1800 }) =>
      ok(
        await followupTask({
          owner: "antigravity", task_id, prompt, spawn: spawnAgy,
          buildExtra: (conversationId) => ({ conversationId, timeoutSeconds: timeout_seconds }),
        })
      )
  );

  server.registerTool(
    "copilot_delegate",
    {
      title: "Delegate a task to GitHub Copilot CLI",
      description:
        "Hand a task to the GitHub Copilot CLI (`copilot`). Starts it headlessly as a " +
        "detached background job and returns immediately with a task_id -- it does NOT " +
        "block, so keep working on your own part meanwhile.\n\n" +
        "Write `prompt` as a complete, self-contained brief: Copilot cannot see your " +
        "conversation or your context. State the goal, the stack and conventions actually " +
        "in use, the files it owns, what it must NOT touch, and the API/prop contract it " +
        "must code against.\n\n" +
        "`claim` locks paths for Copilot up front so you stay off them. `auto_approve` " +
        "passes --allow-all-tools so it can edit unattended. Unlike agy, copilot has no " +
        "session-level timeout -- a hung job just stays 'running' until it exits or " +
        "copilot_cancel kills it.",
      inputSchema: {
        title: z.string().describe("Short label for the board"),
        prompt: z.string().describe("Self-contained brief; Copilot starts cold"),
        cwd: z.string().describe("Absolute path to the project root"),
        model: z.string().optional().describe("e.g. gpt-5.4, claude-sonnet-5; 'auto' lets Copilot pick"),
        effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
        add_dirs: z.array(z.string()).optional(),
        claim: z.array(z.string()).optional().describe("Paths Copilot will own"),
        auto_approve: z.boolean().optional(),
      },
    },
    async (a) => {
      const cwd = path.resolve(a.cwd);
      const claim = (a.claim || []).map(norm);
      const id = taskId();
      return ok(
        await delegateTask({
          owner: "copilot", toolPrefix: "copilot", id, cwd, claim, title: a.title, prompt: a.prompt,
          briefing: briefingFor("copilot", cwd, claim, a.prompt),
          findBin: findCopilot, spawn: spawnCopilot,
          spawnExtra: {
            model: a.model, effort: a.effort,
            addDirs: a.add_dirs || [], autoApprove: a.auto_approve ?? true,
          },
        })
      );
    }
  );

  registerBackendStatusTools(server, {
    toolPrefix: "copilot", label: "Copilot", conversationIdNote: "(Copilot session id)",
  });

  server.registerTool(
    "copilot_followup",
    {
      title: "Follow up in the same Copilot session",
      description:
        "Send a follow-up into the SAME Copilot session as a finished task, so it keeps " +
        "its context (e.g. 'now make the header responsive'). Use this rather than a " +
        "fresh copilot_delegate whenever the request builds on work it just did.",
      inputSchema: {
        task_id: z.string(),
        prompt: z.string(),
      },
    },
    async ({ task_id, prompt }) =>
      ok(
        await followupTask({
          owner: "copilot", task_id, prompt, spawn: spawnCopilot,
          buildExtra: (conversationId) => ({ resumeSessionId: conversationId }),
        })
      )
  );

  server.registerTool(
    "claude_delegate",
    {
      title: "Delegate a task to another Claude Code instance",
      description:
        "Hand a task to a fully independent `claude` CLI process -- another Claude, not " +
        "a subagent inside this session. Starts it headlessly as a detached background " +
        "job and returns immediately with a task_id -- it does NOT block, so keep " +
        "working on your own part meanwhile.\n\n" +
        "Write `prompt` as a complete, self-contained brief: the other instance cannot " +
        "see this conversation or your context. State the goal, the stack and " +
        "conventions actually in use, the files it owns, what it must NOT touch, and the " +
        "contract it must code against, same as delegating to agy or Copilot.\n\n" +
        "`claim` locks paths for it up front so you stay off them. `auto_approve` passes " +
        "--dangerously-skip-permissions so it can edit unattended.",
      inputSchema: {
        title: z.string().describe("Short label for the board"),
        prompt: z.string().describe("Self-contained brief; the other instance starts cold"),
        cwd: z.string().describe("Absolute path to the project root"),
        model: z.string().optional(),
        add_dirs: z.array(z.string()).optional(),
        claim: z.array(z.string()).optional().describe("Paths the other instance will own"),
        auto_approve: z.boolean().optional(),
      },
    },
    async (a) => {
      const cwd = path.resolve(a.cwd);
      const claim = (a.claim || []).map(norm);
      const id = taskId();
      return ok(
        await delegateTask({
          owner: "claude-agent", toolPrefix: "claude", id, cwd, claim, title: a.title, prompt: a.prompt,
          briefing: briefingFor("claude-agent", cwd, claim, a.prompt),
          findBin: findClaude, spawn: spawnClaude,
          spawnExtra: { model: a.model, addDirs: a.add_dirs || [], autoApprove: a.auto_approve ?? true },
        })
      );
    }
  );

  registerBackendStatusTools(server, {
    toolPrefix: "claude", label: "Claude", conversationIdNote: "(session id)",
  });

  server.registerTool(
    "claude_followup",
    {
      title: "Follow up in the same Claude session",
      description:
        "Send a follow-up into the SAME delegated Claude session as a finished task, so " +
        "it keeps its context. Use this rather than a fresh claude_delegate whenever the " +
        "request builds on work it just did.",
      inputSchema: {
        task_id: z.string(),
        prompt: z.string(),
      },
    },
    async ({ task_id, prompt }) =>
      ok(
        await followupTask({
          owner: "claude-agent", task_id, prompt, spawn: spawnClaude,
          buildExtra: (conversationId) => ({ resumeSessionId: conversationId }),
        })
      )
  );

  server.registerTool(
    "board_post",
    {
      title: "Post to the shared board",
      description:
        "Put an item on the shared board WITHOUT executing it -- a plan entry, a " +
        "hand-off, or an announcement that you are about to do something, so the other " +
        "agent can see it. Use ag_delegate instead when you want Antigravity to run it now.",
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
    async ({ owner, include_done = false, limit = 40 }) => {
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
    async ({ unread_only = true, mark_read = true, limit = 30 }) => {
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
        "it. Call when you start and finish a chunk of work.",
      inputSchema: {
        status: z.enum(["idle", "working", "blocked", "offline"]),
        detail: z.string().optional(),
      },
    },
    async ({ status, detail = "" }) => {
      await mutate((b) => {
        b.presence[AGENT] = { status, detail, ts: Date.now() };
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
    async ({ limit = 30 }) => {
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
        b.tasks = []; b.locks = []; b.notes = []; b.events = []; b.presence = {}; b.seq = 0;
        logEvent(b, AGENT, "board.reset", "cleared");
      });
      return ok({ reset: true });
    }
  );

  return server;
}

export async function runStdio() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
