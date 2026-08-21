/** Locating, launching and reaping the Antigravity CLI (`agy`). */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME, runsDir, ensureDirs } from "./store.js";
import { WIN, findBinary } from "./proc.js";

export { isAlive, killTree } from "./proc.js";

let cached = null;

export function findAgy({ required = true } = {}) {
  if (cached && fs.existsSync(cached)) return cached;
  const found = findBinary({
    envVar: "AGY_BIN",
    binName: "agy",
    label: "Antigravity CLI (agy)",
    required,
    candidates: [
      WIN && path.join(HOME, "AppData", "Local", "agy", "bin", "agy.exe"),
      path.join(HOME, ".local", "bin", WIN ? "agy.exe" : "agy"),
      path.join(HOME, ".agy", "bin", WIN ? "agy.exe" : "agy"),
      "/usr/local/bin/agy",
      "/opt/homebrew/bin/agy",
    ].filter(Boolean),
  });
  return found ? (cached = found) : null;
}

export const outPath = (id) => path.join(runsDir(), `${id}.json`);
export const errPath = (id) => path.join(runsDir(), `${id}.err`);
export const promptPath = (id) => path.join(runsDir(), `${id}.prompt.txt`);

/**
 * Launch agy detached, streaming its result straight to disk. Detaching means a
 * long job survives this MCP server being restarted; status is recovered later
 * by reading the run files rather than by holding a child handle.
 */
export function spawnAgy(id, prompt, opts = {}) {
  const {
    cwd,
    model,
    mode = "accept-edits",
    effort,
    conversationId,
    addDirs = [],
    autoApprove = true,
    timeoutSeconds = 1800,
  } = opts;

  const args = ["--print", prompt, "--output-format", "json", "--print-timeout", `${timeoutSeconds}s`];
  if (conversationId) args.push("--conversation", conversationId);
  if (model) args.push("--model", model);
  if (mode) args.push("--mode", mode);
  if (effort) args.push("--effort", effort);
  // agy resolves work against its own scratch project unless the target is in
  // the workspace, so the project root is always added explicitly.
  for (const d of [cwd, ...addDirs]) args.push("--add-dir", path.resolve(d));
  if (autoApprove) args.push("--dangerously-skip-permissions");

  ensureDirs();
  fs.writeFileSync(promptPath(id), prompt);
  const out = fs.openSync(outPath(id), "w");
  const err = fs.openSync(errPath(id), "w");

  const child = spawn(findAgy(), args, {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, err],
  });
  // Detached + unref'd, so nothing else observes this child -- without a
  // listener, a post-spawn failure (e.g. the binary vanishes between
  // findAgy() and spawn()) emits an unhandled 'error' that kills this
  // process. reap()'s isAlive(pid) check already handles a dead/undefined
  // pid, so this can just swallow the event.
  child.on("error", () => {});
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  return child.pid;
}

/** agy may print banner lines before its JSON object, so scan for the object. */
export function readResult(id) {
  let raw = "";
  try {
    raw = fs.readFileSync(outPath(id), "utf8").trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  const start = raw.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

export function readStderr(id) {
  try {
    return fs.readFileSync(errPath(id), "utf8").slice(-4000);
  } catch {
    return "";
  }
}
