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

/**
 * Home directory for reading OTHER agents' files -- Claude's session
 * transcripts, its cached usage standing, Antigravity's brain logs.
 *
 * Separate from HOME so a test (or a sandboxed run) can point host inspection
 * somewhere harmless. Without it, behaviour depends on whatever the developer
 * happens to be running at the time, which is not something a test can pin
 * down. ANTIGRAVITY_MCP_HOME is this server's own state; this is everyone
 * else's.
 */
export function hostHome() {
  return process.env.ANTIGRAVITY_MCP_HOST_HOME || HOME;
}

export function stateDir() {
  return process.env.ANTIGRAVITY_MCP_HOME
    ? path.resolve(process.env.ANTIGRAVITY_MCP_HOME)
    : path.join(HOME, ".antigravity-mcp");
}

export function runsDir() {
  return path.join(stateDir(), "runs");
}

/**
 * Where one delegated task's output/error/prompt live. Defined once here
 * rather than in backends.js and, redundantly, in each of agy.js/claude.js/
 * copilot.js -- all four copies were identical, and only outPath()'s ever
 * used anywhere but the file that defined it (via backends.js re-exporting
 * these same three names for commands.js).
 */
export const outPath = (id) => path.join(runsDir(), `${id}.json`);
export const errPath = (id) => path.join(runsDir(), `${id}.err`);
export const promptPath = (id) => path.join(runsDir(), `${id}.prompt.txt`);

/** A task's stderr, tail only -- errors land at the end of a run. */
export function readStderr(id) {
  try {
    return fs.readFileSync(errPath(id), "utf8").slice(-4000);
  } catch {
    return "";
  }
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

/**
 * An exclusive lock backed by an atomically-created directory -- the one
 * primitive that behaves the same on Windows and POSIX. Parametrized on the
 * lock's own path so the board (below) and anything else that needs the same
 * guarantee (brain.js's memory files) can each get their own independent
 * lock, rather than serializing behind one shared one for no reason.
 */
export function createLock(lockFile) {
  async function acquire() {
    const deadline = Date.now() + LOCK_STALE_MS + 5_000;
    let lastErr = null;
    for (;;) {
      try {
        fs.mkdirSync(lockFile);
        return;
      } catch (err) {
        if (!CONTENDED.includes(err.code)) throw err;
        lastErr = err;
        // Break a lock left behind by a process that died mid-write.
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lockFile, { recursive: true, force: true });
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
          throw new Error(`timed out waiting for lock at ${lockFile} (last error: ${lastErr?.code ?? "none"})`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  function release() {
    try {
      fs.rmSync(lockFile, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }

  return { acquire, release };
}

// NOT `createLock(lockPath())` at module top level: lockPath() resolves
// through stateDir(), which reads ANTIGRAVITY_MCP_HOME from process.env --
// and other modules (this one included, transitively) get imported, and
// fully evaluated, before whatever set that env var for a sandboxed run
// (e.g. test/smoke.js's own top-level code) ever runs, per ES module
// evaluation order. A lock built eagerly here would bind to the real,
// unsandboxed board.lock instead. Building it fresh on every mutate()/
// resetBoard() call, exactly like the un-refactored acquire()/release()
// used to call lockPath() fresh each time, keeps that laziness intact.
function boardLock() {
  return createLock(lockPath());
}

/** Shared by read() and write()'s rename: how many times to retry a transient Windows file-sharing miss. */
export const CONTENTION_ATTEMPTS = 3;
/** How long to back off between those retries. */
export const CONTENTION_RETRY_MS = 15;

/** Block the thread briefly. Sync on purpose -- read() is sync for every caller. */
export function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable: skip the backoff and just retry */
  }
}

/**
 * Read `file`, retrying a transient Windows file-sharing miss
 * (EBUSY/EPERM/EACCES) instead of taking it at face value. Returns null if
 * the file genuinely doesn't exist (ENOENT); throws if every retry is
 * exhausted against some other, persistent error rather than silently
 * reporting "missing" -- a caller that treats "unreadable right now" the
 * same as "doesn't exist" can end up overwriting content that was only ever
 * transiently locked, not actually gone (exactly what brain.js's index used
 * to do before this existed).
 */
export function readFileRetrying(file) {
  for (let attempt = 0; attempt < CONTENTION_ATTEMPTS; attempt++) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      const isLast = attempt === CONTENTION_ATTEMPTS - 1;
      if (isLast || !["EBUSY", "EPERM", "EACCES"].includes(err.code)) throw err;
      pause(CONTENTION_RETRY_MS);
    }
  }
}

/**
 * Write `content` to `file` atomically: write to a sibling temp file, then
 * rename over the target, retrying the rename on a transient Windows
 * file-sharing miss -- a concurrent reader holding the target open can make
 * the rename fail even though nothing is actually wrong. Never leaves the
 * target partially written (a crash or I/O error mid-write only ever loses
 * the temp file, not the original), and cleans the temp file up on genuine
 * failure rather than leaving it behind for a human to puzzle over.
 */
export function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  for (let attempt = 0; attempt < CONTENTION_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const isLast = attempt === CONTENTION_ATTEMPTS - 1;
      if (isLast || !["EBUSY", "EPERM", "EACCES"].includes(err.code)) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* best effort */
        }
        throw err;
      }
      pause(CONTENTION_RETRY_MS);
    }
  }
}

export function read() {
  const file = boardPath();
  let lastParseError = null;

  for (let attempt = 0; attempt < CONTENTION_ATTEMPTS; attempt++) {
    const isLast = attempt === CONTENTION_ATTEMPTS - 1;
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return structuredClone(EMPTY); // no board yet: an empty one is the right answer
      // Windows NTFS momentarily returns EBUSY/EPERM/EACCES while an atomic
      // rename lands. That's a transient miss, not an absent board.
      if (!isLast && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES")) {
        pause(CONTENTION_RETRY_MS);
        continue;
      }
      return structuredClone(EMPTY);
    }

    try {
      return { ...structuredClone(EMPTY), ...JSON.parse(raw) };
    } catch (e) {
      lastParseError = e;
      // Same story on the parse side: a read that caught the file mid-flush
      // yields an empty or truncated string. Retry before concluding the
      // board is genuinely corrupt.
      if (!isLast) {
        pause(CONTENTION_RETRY_MS);
        continue;
      }
    }
  }

  // A board that exists but won't parse is NOT the same as no board. Falling
  // back to empty here would hand mutate() a blank board to write straight
  // over the real one -- silently destroying every task, lock and note
  // instead of reporting the problem. Refuse instead, and say where it is.
  throw new Error(
    `board at ${file} is not valid JSON (${lastParseError?.message}). ` +
      `Run \`antigravity-mcp-server reset --yes\` or move/delete that file to start clean -- refusing to overwrite it.`
  );
}

/**
 * Board growth is otherwise unbounded, and every read parses the whole file --
 * on every tool call, and once per poll while a *_task_wait blocks. Tasks and
 * notes that are finished and read are history nothing queries again, so they
 * get the same treatment `events` already had. Live tasks are never dropped by
 * count; an unread note is only dropped once it is old enough that its
 * addressee is plainly never coming back for it (it re-echoes in that agent's
 * coop_status until then).
 */
const KEEP_FINISHED_TASKS = 40;
const KEEP_READ_NOTES = 50;
const NOTE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
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
  const now = Date.now();
  // An unread note to an agent that never connects (a mis-typed `to`, a backend
  // that was never started) is dead weight that re-echoes in that addressee's
  // coop_status forever. Reap it once it is clearly abandoned; read notes stay
  // governed by count above, not age.
  board.notes = board.notes.filter((n) => n.readAt || !n.created || now - n.created < NOTE_MAX_AGE_MS);
  if (board.limits) {
    for (const [owner, entry] of Object.entries(board.limits)) {
      if (entry?.resets_at && Date.parse(entry.resets_at) <= now) {
        delete board.limits[owner];
      }
    }
  }
  const PRESENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  if (board.presence) {
    for (const [id, p] of Object.entries(board.presence)) {
      if (p.ts && now - p.ts > PRESENCE_MAX_AGE_MS) {
        delete board.presence[id];
      }
    }
  }
}

function write(board) {
  ensureDirs();
  prune(board);
  // Compact: nothing reads this file by eye, and the indentation is pure
  // bytes on every write and pure parse cost on every read.
  writeFileAtomic(boardPath(), JSON.stringify(board));
}

/** Run `fn` against the board under an exclusive lock and persist the result. */
export async function mutate(fn) {
  ensureDirs();
  const lock = boardLock();
  await lock.acquire();
  try {
    const board = read();
    const out = await fn(board);
    write(board);
    return out;
  } finally {
    lock.release();
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
  const lock = boardLock();
  await lock.acquire();
  try {
    const board = structuredClone(EMPTY);
    if (stamp) stamp(board);
    write(board);
    return board;
  } finally {
    lock.release();
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
  if (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) {
    out = out.slice(0, -1);
  }
  return process.platform === "win32" ? out.toLowerCase() : out;
}

/** True when `a` is the same path as `b` or nested under it (either direction). */
export function overlaps(a, b) {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
