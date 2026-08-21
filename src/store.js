/**
 * Shared board persisted as a single JSON file.
 *
 * Several agent processes read and write this concurrently, so every mutation
 * goes through an exclusive lock (an atomically-created directory, which is the
 * one primitive that behaves the same on Windows and POSIX) and lands via
 * write-temp-then-rename so a crash can never leave a half-written board.
 *
 * Deliberately dependency-free: a native SQLite build would break `npx` on any
 * machine without a toolchain, and the board sees a handful of small writes per
 * minute, not thousands per second.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME = os.homedir();

export function stateDir() {
  return process.env.ANTIGRAVITY_MCP_HOME
    ? path.resolve(process.env.ANTIGRAVITY_MCP_HOME)
    : path.join(HOME, ".antigravity-mcp");
}

export function runsDir() {
  return path.join(stateDir(), "runs");
}

function boardPath() {
  return path.join(stateDir(), "board.json");
}

function lockPath() {
  return path.join(stateDir(), "board.lock");
}

const EMPTY = { tasks: [], locks: [], notes: [], events: [], presence: {}, seq: 0 };

export function ensureDirs() {
  fs.mkdirSync(runsDir(), { recursive: true });
}

const LOCK_STALE_MS = 20_000;

async function acquire() {
  const lock = lockPath();
  const deadline = Date.now() + LOCK_STALE_MS + 5_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Break a lock left behind by a process that died mid-write.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for board lock at ${lock}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function release() {
  try {
    fs.rmSync(lockPath(), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

export function read() {
  try {
    const raw = fs.readFileSync(boardPath(), "utf8");
    return { ...structuredClone(EMPTY), ...JSON.parse(raw) };
  } catch {
    return structuredClone(EMPTY);
  }
}

function write(board) {
  ensureDirs();
  const tmp = `${boardPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
  fs.renameSync(tmp, boardPath());
}

/** Run `fn` against the board under an exclusive lock and persist the result. */
export async function mutate(fn) {
  ensureDirs();
  await acquire();
  try {
    const board = read();
    const out = await fn(board);
    write(board);
    return out;
  } finally {
    release();
  }
}

export function nextId(board) {
  board.seq = (board.seq || 0) + 1;
  return board.seq;
}

export function logEvent(board, agent, kind, detail = "") {
  board.events.push({ id: nextId(board), ts: Date.now(), agent, kind, detail });
  if (board.events.length > 500) board.events.splice(0, board.events.length - 500);
}

export function taskId() {
  return Math.random().toString(16).slice(2, 8) + Date.now().toString(16).slice(-6);
}

export function ago(ts) {
  if (!ts) return "never";
  const d = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h${Math.floor((d % 3600) / 60)}m ago`;
}

/** Case-folded absolute path, so Windows drive-letter casing can't defeat a lock. */
export function norm(p) {
  let out = p.startsWith("~") ? path.join(HOME, p.slice(1)) : p;
  out = path.resolve(out);
  return process.platform === "win32" ? out.toLowerCase() : out;
}

/** True when `a` is the same path as `b` or nested under it (either direction). */
export function overlaps(a, b) {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
