/**
 * Developer & AI facing CLI commands for direct terminal control of the coordination board.
 */

import fs from "node:fs";
import path from "node:path";
import { read, mutate, ago, norm, overlaps, logEvent, nextId, taskId, ensureDirs } from "./store.js";
import { isAlive, killTree } from "./proc.js";
import { loadBackends, spawnBackend, outPath, errPath, promptPath, recoverTask } from "./backends.js";
import { classifyFailure, untilReset } from "./limits.js";
import { briefingFor } from "./briefing.js";

const ACTOR = process.env.COOP_AGENT || process.env.USER || process.env.USERNAME || "human";

/**
 * A count from the command line, or the default. Guards the NaN path: a bad
 * `--limit abc` reaches Math.max(1, NaN) as NaN, and slice(-NaN) is slice(0),
 * which quietly returns everything instead of the limit that was asked for.
 */
function clampLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export function printStatus({ json = false } = {}) {
  const b = read();
  if (json) {
    console.log(JSON.stringify(b, null, 2));
    return 0;
  }

  console.log("\n  === Antigravity Coordination Board ===\n");

  // Agents & Presence
  const agents = Object.entries(b.presence || {});
  console.log("  AGENTS & PRESENCE:");
  if (!agents.length) {
    console.log("    (no active or known agents)");
  } else {
    for (const [id, p] of agents) {
      const alive = p.pid ? isAlive(p.pid) : false;
      const statusMark = p.status === "working" ? "*" : p.status === "blocked" ? "!" : "o";
      const pidInfo = p.pid ? ` [PID ${p.pid}${alive ? " alive" : " dead"}]` : "";
      const modelInfo = p.model ? ` (${p.model})` : "";
      console.log(`    ${statusMark} ${id.padEnd(20)} ${p.status.padEnd(10)} ${p.detail || ""}${modelInfo}${pidInfo} — seen ${ago(p.ts)}`);
    }
  }

  // Locked Paths
  console.log("\n  PATH LOCKS:");
  if (!b.locks || !b.locks.length) {
    console.log("    (no locked paths)");
  } else {
    for (const l of b.locks) {
      const taskInfo = l.taskId ? ` (task: ${l.taskId})` : "";
      console.log(`    # ${l.path} [owner: ${l.owner}] — held ${ago(l.created)}${taskInfo}${l.note ? ` "${l.note}"` : ""}`);
    }
  }

  // Active Tasks
  const activeTasks = (b.tasks || []).filter((t) => ["open", "running", "queued", "blocked"].includes(t.status));
  console.log("\n  ACTIVE TASKS:");
  if (!activeTasks.length) {
    console.log("    (no active tasks)");
  } else {
    for (const t of activeTasks) {
      const kindInfo = t.kind === "delegated" ? `[${t.owner}]` : `[board -> ${t.owner}]`;
      console.log(`    > ${t.id} ${t.status.padEnd(10)} ${kindInfo.padEnd(22)} "${t.title}" — started ${ago(t.created)}`);
    }
  }

  // Unread Notes
  const unread = (b.notes || []).filter((n) => !n.readAt);
  if (unread.length) {
    console.log("\n  UNREAD NOTES:");
    for (const n of unread) {
      console.log(`    @ [${n.from} -> ${n.to}] "${n.body}" (${ago(n.created)})`);
    }
  }

  // Limits
  const limits = b.limits || {};
  const activeLimits = Object.entries(limits).filter(([, l]) => !l.resets_at || Date.parse(l.resets_at) > Date.now());
  if (activeLimits.length) {
    console.log("\n  UNAVAILABLE BACKENDS:");
    for (const [owner, l] of activeLimits) {
      const reset = l.resets_at ? ` (resets in ${untilReset(l.resets_at)})` : "";
      console.log(`    ! ${owner}: ${l.kind}${reset} ${l.detail || ""}`);
    }
  }

  console.log("");
  return 0;
}

export function printTasks({ all = false, owner = null, limit = 25, json = false } = {}) {
  const b = read();
  let tasks = b.tasks || [];
  if (owner) tasks = tasks.filter((t) => t.owner === owner);
  if (!all) tasks = tasks.filter((t) => ["open", "running", "queued", "blocked"].includes(t.status));
  tasks = tasks.slice(-clampLimit(limit, 25));

  if (json) {
    console.log(JSON.stringify(tasks, null, 2));
    return 0;
  }

  console.log(`\n  Tasks (${tasks.length}${all ? " total" : " active"}):\n`);
  if (!tasks.length) {
    console.log("    (no matching tasks)");
  } else {
    for (const t of tasks) {
      const statusMark = t.status === "done" ? "+" : t.status === "failed" ? "x" : t.status === "running" ? "*" : "-";
      console.log(`    ${statusMark} ${t.id}  ${t.status.padEnd(10)} ${(t.owner || "unassigned").padEnd(18)} "${t.title}" (${ago(t.created)})`);
    }
  }
  console.log("");
  return 0;
}

export async function delegateFromCli({ backend, prompt, title, cwd = process.cwd(), claim = [], model, effort, timeout }) {
  if (!backend || !prompt) {
    console.error("Usage: antigravity-mcp-server delegate <backend> <prompt> [--title <title>] [--claim <paths>]");
    return 1;
  }
  const backends = loadBackends();
  const spec = backends.find((s) => s.prefix === backend || s.id === backend || s.owner === backend);
  if (!spec) {
    console.error(`\n  Unknown backend: "${backend}". Available: ${backends.map((s) => s.prefix).join(", ")}\n`);
    return 1;
  }

  const targetCwd = path.resolve(cwd);
  if (!fs.existsSync(targetCwd) || !fs.statSync(targetCwd).isDirectory()) {
    console.error(`\n  Invalid CWD: ${targetCwd}\n`);
    return 1;
  }

  const claimPaths = (Array.isArray(claim) ? claim : String(claim).split(",")).map((p) => p.trim()).filter(Boolean).map(norm);
  const taskTitle = title || prompt.slice(0, 60).replace(/\r?\n/g, " ");
  const id = taskId();

  // Check conflicts
  const conflicts = read().locks
    .filter((l) => l.owner !== spec.owner && claimPaths.some((c) => overlaps(c, l.path)))
    .map((l) => ({ path: l.path, held_by: l.owner }));
  if (conflicts.length) {
    console.error(`\n  Cannot delegate: path conflict on ${conflicts.map((c) => `${c.path} (held by ${c.held_by})`).join(", ")}\n`);
    return 1;
  }

  let pid;
  try {
    pid = spawnBackend(spec, id, briefingFor(spec.owner, targetCwd, claimPaths, prompt), {
      cwd: targetCwd,
      model,
      effort,
      timeoutSeconds: timeout ? Number(timeout) : undefined,
      autoApprove: true,
    });
  } catch (e) {
    console.error(`\n  Failed to spawn ${spec.label}: ${e.message}\n`);
    return 1;
  }

  await mutate((b) => {
    const now = Date.now();
    b.tasks.push({
      id, title: taskTitle, owner: spec.owner, assignedBy: ACTOR,
      status: "running", cwd: targetCwd, kind: "delegated", pid, model: model || null,
      claim: claimPaths, created: now, updated: now,
    });
    for (const p of claimPaths) {
      b.locks = b.locks.filter((l) => l.path !== p);
      b.locks.push({ path: p, owner: spec.owner, taskId: id, note: taskTitle, created: now });
    }
    b.presence[spec.owner] = { ...b.presence[spec.owner], status: "working", detail: taskTitle, ts: now };
    logEvent(b, ACTOR, "task.delegated", `${id} [${spec.owner}] ${taskTitle}`);
  });

  console.log(`\n  + Delegated task to ${spec.label}`);
  console.log(`    Task ID:  ${id}`);
  console.log(`    PID:      ${pid}`);
  console.log(`    Target:   ${targetCwd}`);
  if (claimPaths.length) console.log(`    Claimed:  ${claimPaths.join(", ")}`);
  console.log(`\n  Check output:  antigravity-mcp-server logs ${id}`);
  console.log(`  Cancel task:   antigravity-mcp-server cancel ${id}\n`);
  return 0;
}

export async function printLogs(taskIdArg, { err = false, prompt = false, raw = false, follow = false } = {}) {
  if (!taskIdArg) {
    console.error("Usage: antigravity-mcp-server logs <task-id> [--err] [--prompt] [--raw] [-f|--follow]");
    return 1;
  }
  const id = taskIdArg.trim();
  const file = prompt ? promptPath(id) : err ? errPath(id) : outPath(id);

  if (!fs.existsSync(file)) {
    console.error(`\n  Log file not found for task ${id} (${file})\n`);
    return 1;
  }

  if (follow) {
    console.log(`\n=== Following Task ${id} (${path.basename(file)}) — Press Ctrl+C to stop ===\n`);
    let lastSize = 0;

    /**
     * Write everything appended since the last drain.
     *
     * Deliberately not pipe(): pipe calls dest.end() when the source stream
     * finishes, which closes stdout after the very first chunk and silently
     * swallows the rest of the follow. `end` is inclusive, so the last byte to
     * read is size - 1.
     */
    const drain = async () => {
      if (!fs.existsSync(file)) return;
      const { size } = fs.statSync(file);
      if (size <= lastSize) return;
      const start = lastSize;
      lastSize = size;
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file, { start, end: size - 1 });
        stream.on("data", (chunk) => process.stdout.write(chunk));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    };

    while (true) {
      await drain();
      const board = read();
      const task = (board.tasks || []).find((t) => t.id === id);
      if (task && ["done", "failed", "cancelled"].includes(task.status)) {
        // The backend can still be flushing its last write when the board
        // flips status, so drain once more before signing off.
        await new Promise((r) => setTimeout(r, 500));
        await drain();
        console.log(`\n\n=== Task ${id} finished with status: ${task.status} ===\n`);
        return 0;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const content = fs.readFileSync(file, "utf8");
  if (!content.trim()) {
    console.log(`\n  Task ${id} has produced no ${err ? "stderr" : prompt ? "prompt" : "stdout"} output yet.\n`);
    return 0;
  }

  console.log(`\n=== Task ${id} (${path.basename(file)}) ===\n`);
  if (raw || prompt || err) {
    console.log(content);
  } else {
    try {
      const parsed = JSON.parse(content);
      if (parsed.response) {
        console.log(parsed.response);
      } else {
        console.log(JSON.stringify(parsed, null, 2));
      }
    } catch {
      console.log(content);
    }
  }
  console.log("");
  return 0;
}

export async function lockFromCli(pathsArg, { note = "", owner = ACTOR } = {}) {
  if (!pathsArg || !pathsArg.length) {
    console.error("Usage: antigravity-mcp-server lock <paths...> [--note <text>]");
    return 1;
  }
  const paths = (Array.isArray(pathsArg) ? pathsArg : [pathsArg]).map((p) => p.split(",")).flat().map((p) => p.trim()).filter(Boolean).map(norm);

  const out = await mutate((b) => {
    const granted = [], conflicts = [];
    for (const p of paths) {
      const clash = b.locks.find((l) => l.owner !== owner && overlaps(p, l.path));
      if (clash) {
        conflicts.push({ path: p, held_by: clash.owner, note: clash.note });
      } else {
        b.locks = b.locks.filter((l) => l.path !== p);
        b.locks.push({ path: p, owner, note, created: Date.now() });
        granted.push(p);
      }
    }
    logEvent(b, owner, "locks.claim", `${granted.length} granted, ${conflicts.length} conflicts`);
    return { granted, conflicts };
  });

  if (out.granted.length) {
    console.log(`\n  + Granted ${out.granted.length} lock(s):`);
    for (const p of out.granted) console.log(`    # ${p}`);
  }
  if (out.conflicts.length) {
    console.log(`\n  ! ${out.conflicts.length} conflict(s):`);
    for (const c of out.conflicts) console.log(`    x ${c.path} (held by ${c.held_by}${c.note ? ` "${c.note}"` : ""})`);
  }
  console.log("");
  return out.conflicts.length ? 1 : 0;
}

export async function unlockFromCli({ path: unlockPath, all = false, owner = null } = {}) {
  if (!all && !unlockPath) {
    console.error("Usage: antigravity-mcp-server unlock <path> | --all [--owner <agent>]");
    return 1;
  }

  const released = await mutate((b) => {
    const before = b.locks.length;
    const target = unlockPath ? norm(unlockPath) : null;
    // `owner` narrows which locks to drop; it is not an independent condition.
    // Treating it as one made `unlock <path> --owner X` release every lock X
    // held, not just the one at that path.
    b.locks = b.locks.filter((l) => {
      const matchesPath = all || l.path === target;
      const matchesOwner = !owner || l.owner === owner;
      return !(matchesPath && matchesOwner);
    });
    const n = before - b.locks.length;
    logEvent(b, ACTOR, "locks.release", `${n} released via CLI`);
    return n;
  });

  console.log(`\n  + Released ${released} path lock(s).\n`);
  return 0;
}

export async function cancelFromCli(taskIdArg) {
  if (!taskIdArg) {
    console.error("Usage: antigravity-mcp-server cancel <task-id>");
    return 1;
  }
  const id = taskIdArg.trim();
  const board = read();
  const t = (board.tasks || []).find((x) => x.id === id);
  if (!t) {
    console.error(`\n  No such task: "${id}"\n`);
    return 1;
  }

  if (t.pid) killTree(t.pid);

  await mutate((b) => {
    const task = b.tasks.find((x) => x.id === id);
    if (task) {
      task.status = "cancelled";
      task.updated = Date.now();
    }
    b.locks = b.locks.filter((l) => l.taskId !== id);
    logEvent(b, ACTOR, "task.cancelled", id);
  });

  console.log(`\n  + Task ${id} cancelled and locks released.\n`);
  return 0;
}

export async function reassignFromCli({ taskIdArg, toBackend, note }) {
  if (!taskIdArg || !toBackend) {
    console.error("Usage: antigravity-mcp-server reassign <task-id> <to-backend> [--note <text>]");
    return 1;
  }
  const id = taskIdArg.trim();
  const board = read();
  const original = (board.tasks || []).find((x) => x.id === id);
  if (!original) {
    console.error(`\n  No such task: "${id}"\n`);
    return 1;
  }

  const backends = loadBackends();
  const spec = backends.find((s) => s.prefix === toBackend || s.id === toBackend || s.owner === toBackend);
  if (!spec) {
    console.error(`\n  Unknown backend "${toBackend}". Available: ${backends.map((s) => s.prefix).join(", ")}\n`);
    return 1;
  }

  const brief = recoverTask(id);
  if (!brief) {
    console.error(`\n  Original prompt file for task ${id} is no longer on disk.\n`);
    return 1;
  }

  const prompt = note ? `${brief}\n\n--- ALSO ---\n${note}` : brief;
  const newId = taskId();
  const cwd = original.cwd || process.cwd();
  const claim = (original.claim || []).map(norm);

  let pid;
  try {
    pid = spawnBackend(spec, newId, briefingFor(spec.owner, cwd, claim, prompt), { cwd, autoApprove: true });
  } catch (e) {
    console.error(`\n  Failed to spawn ${spec.label}: ${e.message}\n`);
    return 1;
  }

  await mutate((b) => {
    const now = Date.now();
    b.tasks.push({
      id: newId, title: `reassigned: ${original.title}`, owner: spec.owner,
      assignedBy: ACTOR, status: "running", cwd, kind: "delegated", pid,
      claim, reassignedFrom: id, created: now, updated: now,
    });
    const prev = b.tasks.find((x) => x.id === id);
    if (prev) prev.reassignedTo = newId;
    for (const p of claim) {
      b.locks = b.locks.filter((l) => l.path !== p);
      b.locks.push({ path: p, owner: spec.owner, taskId: newId, note: `reassigned: ${original.title}`, created: now });
    }
    b.presence[spec.owner] = { ...b.presence[spec.owner], status: "working", detail: `reassigned: ${original.title}`, ts: now };
    logEvent(b, ACTOR, "task.reassigned", `${id} -> ${newId} (${spec.prefix})`);
  });

  console.log(`\n  + Reassigned task ${id} -> ${newId} on ${spec.label}`);
  console.log(`    PID:     ${pid}`);
  console.log(`    Check:   antigravity-mcp-server logs ${newId}\n`);
  return 0;
}

export async function sendNoteFromCli(to, body) {
  if (!to || !body) {
    console.error("Usage: antigravity-mcp-server note <to-agent|all> <message>");
    return 1;
  }
  const nid = await mutate((b) => {
    const id = nextId(b);
    b.notes.push({ id, from: ACTOR, to, body, created: Date.now(), readAt: null });
    logEvent(b, ACTOR, "note.sent", `-> ${to}: ${body.slice(0, 80)}`);
    return id;
  });

  console.log(`\n  + Note #${nid} sent to "${to}".\n`);
  return 0;
}

export async function readNotesFromCli({ unreadOnly = false, markRead = false, limit = 20, json = false } = {}) {
  const take = clampLimit(limit, 20);
  // Marking read is a write, so it can't ride on read(). Both paths select the
  // same slice; only the write path takes the board lock.
  const select = (b) => {
    let got = b.notes || [];
    if (unreadOnly) got = got.filter((n) => !n.readAt);
    return got.slice(-take);
  };

  let notes;
  if (markRead) {
    notes = await mutate((b) => {
      const got = select(b);
      // Snapshot first: the listing below shows whether each note was unread
      // when you fetched it, which is the useful thing to see.
      const snapshot = got.map((n) => ({ ...n }));
      const now = Date.now();
      for (const n of got) if (!n.readAt) n.readAt = now;
      logEvent(b, ACTOR, "note.read", `${got.length} note(s)`);
      return snapshot;
    });
  } else {
    notes = select(read());
  }

  if (json) {
    console.log(JSON.stringify(notes, null, 2));
    return 0;
  }

  console.log(`\n  Notes (${notes.length}${unreadOnly ? " unread" : ""}):\n`);
  if (!notes.length) {
    console.log("    (inbox is empty)");
  } else {
    for (const n of notes) {
      const readMark = n.readAt ? " " : "*";
      console.log(`    ${readMark} #${n.id} [${n.from} -> ${n.to}] "${n.body}" (${ago(n.created)})`);
    }
  }
  console.log("");
  return 0;
}
