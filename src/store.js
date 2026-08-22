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

const EMPTY = { tasks: [], locks: [], notes: [], events: [], presence: {}, limits: {}, seq: 0 };

export function ensureDirs() {
  fs.mkdirSync(runsDir(), { recursive: true });
}

const LOCK_STALE_MS = 20_000;

/**
 * EEXIST is the ordinary "someone else holds it" answer. Windows also returns
 * EPERM/EACCES for the same situation when the holder is releasing the lock at
 * that exact moment: a directory being deleted lingers in a pending-delete
 * state, and mkdir against that name fails with EPERM until it clears. Treated
 * as a hard error, that surfaces as a failed tool call under nothing worse than
 * normal multi-agent contention -- so they all mean "retry", and only the
 * deadline below is allowed to give up.
 */
const CONTENDED = ["EEXIST", "EPERM", "EACCES"];

async function acquire() {
  const lock = lockPath();
  const deadline = Date.now() + LOCK_STALE_MS + 5_000;
  let lastErr = null;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      return;
    } catch (err) {
      if (!CONTENDED.includes(err.code)) throw err;
      lastErr = err;
      // Break a lock left behind by a process that died mid-write.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Usually just lost a race with the holder releasing the lock. Fall
        // through to the deadline check and the backoff below rather than
        // retrying immediately: a stat that keeps failing while the directory
        // keeps existing (a permissions or AV interaction) would otherwise
        // spin here forever, with no await to yield the event loop and no
        // deadline to stop it.
      }
      if (Date.now() > deadline) {
        // Carrying the last code matters: a genuine permissions problem now
        // looks like contention until the deadline, and "EACCES" is the only
        // thing that tells that apart from a real peer holding the lock.
        throw new Error(`timed out waiting for board lock at ${lock} (last error: ${lastErr?.code ?? "none"})`);
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
  let raw;
  try {
    raw = fs.readFileSync(boardPath(), "utf8");
  } catch {
    return structuredClone(EMPTY); // no board yet: an empty one is the right answer
  }
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(raw) };
  } catch (e) {
    // A board that exists but won't parse is NOT the same as no board. Falling
    // back to empty here would hand mutate() a blank board to write straight
    // over the real one -- silently destroying every task, lock and note
    // instead of reporting the problem. Refuse instead, and say where it is.
    throw new Error(
      `board at ${boardPath()} is not valid JSON (${e.message}). ` +
        `Move or delete that file to start clean -- refusing to overwrite it.`
    );
  }
}

/**
 * Board growth is otherwise unbounded, and every read parses the whole file --
 * on every tool call, and once per poll while a *_task_wait blocks. Tasks and
 * notes that are finished and read are history nothing queries again, so they
 * get the same treatment `events` already had. Anything still live (open or
 * running tasks, unread notes) is never dropped, regardless of count.
 */
const KEEP_FINISHED_TASKS = 40;
const KEEP_READ_NOTES = 50;
const TERMINAL = ["done", "failed", "cancelled"];

function prune(board) {
  const finished = board.tasks.filter((t) => TERMINAL.includes(t.status));
  if (finished.length > KEEP_FINISHED_TASKS) {
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED_TASKS).map((t) => t.id));
    board.tasks = board.tasks.filter((t) => !drop.has(t.id));
  }
  const read_ = board.notes.filter((n) => n.readAt);
  if (read_.length > KEEP_READ_NOTES) {
    const drop = new Set(read_.slice(0, read_.length - KEEP_READ_NOTES).map((n) => n.id));
    board.notes = board.notes.filter((n) => !drop.has(n.id));
  }
}

function write(board) {
  ensureDirs();
  prune(board);
  const tmp = `${boardPath()}.${process.pid}.tmp`;
  // Compact: nothing reads this file by eye, and the indentation is pure
  // bytes on every write and pure parse cost on every read.
  fs.writeFileSync(tmp, JSON.stringify(board));
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

/**
 * Replace the board with a fresh empty one, still under the lock but WITHOUT
 * reading the old one first. Everything else deliberately refuses to touch an
 * unparseable board; this is the one operation that has to work anyway, since
 * "wipe it and start over" is the answer to a board in that state.
 */
export async function resetBoard(stamp) {
  ensureDirs();
  await acquire();
  try {
    const board = structuredClone(EMPTY);
    if (stamp) stamp(board);
    write(board);
    return board;
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
