/** `antigravity-mcp-server restart` — restart coordination state, kill stale servers/processes, and refresh setup. */

import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { read, mutate, resetBoard, logEvent } from "./store.js";
import { isAlive, killTree, WIN } from "./proc.js";
import { init, printInit } from "./init.js";
import { DEFAULT_UI_PORT, readUiPid } from "./uiServer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.js");

/**
 * PID listening on `port`, or null.
 *
 * The port has to be matched exactly, not as a substring: `:7333` is a
 * substring of `:73331`, and it also appears in netstat's *foreign* address
 * column, so a loose match can hand back a completely unrelated process --
 * which this module then kills.
 */
export function findPidOnPort(port) {
  try {
    if (WIN) {
      const res = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      for (const line of (res.stdout || "").split(/\r?\n/)) {
        // proto | local address | foreign address | state | pid
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || parts[3] !== "LISTENING") continue;
        const localPort = Number(parts[1].slice(parts[1].lastIndexOf(":") + 1));
        if (localPort !== Number(port)) continue;
        const pid = Number(parts[4]);
        if (pid && pid !== process.pid) return pid;
      }
    } else {
      const res = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
      const pid = Number((res.stdout || "").trim().split(/\s+/)[0]);
      if (pid && pid !== process.pid) return pid;
    }
  } catch {}
  return null;
}

/**
 * The UI server to stop. Prefers the pid this state directory's own server
 * recorded; the port scan is only a fallback for a server started by a build
 * that predates the pid file.
 */
function findUiServerPid(port) {
  const recorded = readUiPid();
  if (recorded && recorded !== process.pid && isAlive(recorded)) return recorded;
  return findPidOnPort(port);
}

export async function restart({
  yes = false,
  ui = false,
  init: runInit = false,
  port = DEFAULT_UI_PORT,
  open = false,
  killProcesses = true,
} = {}) {
  const killed = [];

  // 1. Check and kill any existing UI server or process on the UI port
  if (killProcesses) {
    const uiPid = findUiServerPid(port);
    if (uiPid) {
      killTree(uiPid);
      killed.push({ type: "UI Server", pid: uiPid, port });
    }
  }

  // 2. Read board to locate any orphaned background worker processes
  let b;
  try {
    b = read();
  } catch {
    b = { tasks: [], locks: [], notes: [], presence: {}, events: [] };
  }

  // Kill running tasks / worker pids. This has to happen BEFORE the board is
  // cleaned: cancelling a task and dropping its locks while its process is
  // still alive leaves a worker writing to files nothing holds a claim on.
  if (killProcesses) {
    for (const t of b.tasks || []) {
      if ((t.status === "running" || t.status === "queued") && t.pid && t.pid !== process.pid && isAlive(t.pid)) {
        killTree(t.pid);
        killed.push({ type: `Task ${t.id} (${t.owner})`, pid: t.pid });
      }
    }
  }

  // 3. Reset or refresh the board
  let boardSummary;
  if (yes) {
    // Full wipe
    await resetBoard((board) => logEvent(board, "cli", "board.restart", "full wipe via restart --yes"));
    boardSummary = { action: "wiped", tasks: (b.tasks || []).length, locks: (b.locks || []).length, notes: (b.notes || []).length };
  } else {
    // Soft clean: clear presence, release every lock, mark in-flight tasks
    // cancelled. Releasing everything is only safe because the processes that
    // held those locks were just killed above.
    await mutate((board) => {
      board.presence = {};
      const releasedCount = (board.locks || []).length;
      board.locks = [];
      let cancelled = 0;
      for (const t of board.tasks || []) {
        if (t.status === "running" || t.status === "queued") {
          t.status = "cancelled";
          t.updated = Date.now();
          cancelled++;
        }
      }
      logEvent(board, "cli", "board.restart", `presence cleared, ${releasedCount} locks released, ${cancelled} tasks cancelled`);
      boardSummary = { action: "cleaned", presenceCleared: true, locksReleased: releasedCount, tasksCancelled: cancelled };
    });
  }

  // 4. If requested, re-run init to refresh client configs
  let initResult = null;
  if (runInit) {
    initResult = init();
  }

  // 5. If --ui requested, spawn a fresh detached UI server
  let uiStarted = false;
  if (ui) {
    const args = [CLI, "ui", "--port", String(port)];
    if (open) args.push("--open");
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    uiStarted = true;
  }

  return {
    state: "success",
    killed,
    boardSummary,
    initResult,
    uiStarted,
    port,
    open,
  };
}

export function printRestart(res) {
  console.log("");
  console.log("  + antigravity-mcp-server restart completed.\n");

  if (res.killed && res.killed.length > 0) {
    console.log("  Stopped running processes:");
    for (const k of res.killed) {
      console.log(`    - ${k.type} (PID ${k.pid}${k.port ? `, port ${k.port}` : ""})`);
    }
    console.log("");
  } else {
    console.log("  - No hanging processes found on UI port or background lanes.\n");
  }

  if (res.boardSummary) {
    if (res.boardSummary.action === "wiped") {
      console.log("  Board status: Full board wiped (all tasks, locks, and history cleared).");
    } else {
      console.log("  Board status: Presence reset, locks released, active tasks cancelled.");
    }
  }

  let failed = res.state !== "success";

  if (res.initResult) {
    console.log("\n  Refreshed MCP Client Configurations:");
    failed = printInit(res.initResult) || failed;
  }

  if (res.uiStarted) {
    console.log(`\n  + Office UI server restarted at http://localhost:${res.port}`);
  }

  console.log("\n  Next steps:");
  console.log("  1. Restart your active AI tool / MCP client sessions to reconnect cleanly.");
  console.log("  2. Run `antigravity-mcp-server status` or `antigravity-mcp-server ui` to view live status.\n");
  return failed;
}
