/**
 * Safe read-modify-write of a file that other processes may touch at the same
 * time -- a user's global rules file, an MCP client's config.
 *
 * `init` and `deinit` are the only writers here, but the whole product premise
 * is several agents on one machine, so two `init` runs (or an `init` and a
 * `deinit`) can overlap, and an editor may hold the file open meanwhile. This
 * reuses the exact primitives the board already relies on: an atomically-created
 * lock directory, write-temp-then-rename, and a retrying reader.
 */

import fs from "node:fs";
import path from "node:path";
import { createLock, writeFileAtomic, readFileRetrying } from "./store.js";

/**
 * Copy `file` to `<file>.bak-antigravity-mcp`, but only if no backup exists yet.
 * The first backup is the pristine, pre-antigravity version -- the one worth
 * keeping. Overwriting it on every run (the old behaviour) meant `deinit`
 * replaced the good copy with a modified one.
 */
export function firstBackup(file) {
  const dest = `${file}.bak-antigravity-mcp`;
  try {
    if (fs.existsSync(dest)) return null;
    if (!fs.statSync(file).size) return null;
  } catch {
    return null; // source missing or empty
  }
  fs.copyFileSync(file, dest);
  return dest;
}

/** The indent string an existing JSON file uses, so a one-key edit reserializes byte-for-byte. */
export function detectIndent(jsonText = "") {
  const m = jsonText.match(/^\{\r?\n([ \t]+)"/);
  return m ? m[1] : "  ";
}

/**
 * Run `transform(current)` under an exclusive lock and persist the result.
 *   current   the file's text, or null if it does not exist
 *   return a string   -> write it (atomic)
 *   return null        -> delete the file
 *   return undefined / === current -> leave it
 *   throw              -> lock released, error propagates to the caller
 *
 * A backup is taken (once, ever) immediately before any write or delete.
 * With `{ dryRun: true }` nothing is read-locked-for-write and nothing is
 * written; the returned status is prefixed "would ".
 *
 * Returns `{ status, existedBefore, content }` where status is one of
 * created | updated | deleted | unchanged (or "would <that>" in a dry run).
 */
export async function editManagedFile(file, transform, { dryRun = false } = {}) {
  const run = async () => {
    const current = readFileRetrying(file); // null on ENOENT
    const next = await transform(current);

    let status;
    if (next === undefined || next === current) status = "unchanged";
    else if (next === null) status = current === null ? "unchanged" : "deleted";
    else if (typeof next !== "string") {
      throw new TypeError(`editManagedFile transform must return a string, null, or undefined (got ${typeof next})`);
    } else status = current === null ? "created" : "updated";

    if (!dryRun && status !== "unchanged") {
      firstBackup(file);
      if (status === "deleted") {
        fs.rmSync(file, { force: true });
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomic(file, next);
      }
    }
    return {
      status: dryRun && status !== "unchanged" ? `would ${status}` : status,
      existedBefore: current !== null,
      content: typeof next === "string" ? next : current,
    };
  };

  if (dryRun) return run(); // read-only: no lock needed
  // The lock is a sibling of the target, so its parent must exist before we can
  // create it -- true when `file` is a not-yet-created config in a not-yet-
  // created dir (~/.codex/AGENTS.md on a machine with no ~/.codex).
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = createLock(`${file}.antigravity-lock`);
  await lock.acquire();
  try {
    return await run();
  } finally {
    lock.release();
  }
}

/**
 * `editManagedFile` for a JSON config: parse (with a friendly error), let
 * `mutate(obj)` change it in place, reserialize with the file's own indent and
 * a trailing newline, and persist only if the serialized form actually changed.
 * A missing file starts from `{}`.
 */
export async function editJsonFile(file, mutate, { dryRun = false } = {}) {
  return editManagedFile(
    file,
    (cur) => {
      let obj;
      try {
        obj = cur && cur.trim() ? JSON.parse(cur) : {};
      } catch (e) {
        throw new Error(`${file} is not valid JSON (${e.message}); fix or move it, then re-run`);
      }
      const before = JSON.stringify(obj);
      mutate(obj);
      const after = JSON.stringify(obj);
      // No change, or a missing file that `mutate` left empty -> don't create a bare `{}`.
      if (after === before && (cur !== null || after === "{}")) return undefined;
      return JSON.stringify(obj, null, detectIndent(cur || "")) + "\n";
    },
    { dryRun }
  );
}
