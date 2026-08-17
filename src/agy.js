/** Locating, launching and reaping the Antigravity CLI (`agy`). */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HOME, runsDir, ensureDirs } from "./store.js";

const WIN = process.platform === "win32";

function candidates() {
  return [
    process.env.AGY_BIN,
    WIN && path.join(HOME, "AppData", "Local", "agy", "bin", "agy.exe"),
    path.join(HOME, ".local", "bin", WIN ? "agy.exe" : "agy"),
    path.join(HOME, ".agy", "bin", WIN ? "agy.exe" : "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
  ].filter(Boolean);
}

let cached = null;

export function findAgy({ required = true } = {}) {
  if (cached && fs.existsSync(cached)) return cached;
  for (const c of candidates()) {
    if (c && fs.existsSync(c)) return (cached = c);
  }
  // Fall back to PATH.
  const probe = spawnSync(WIN ? "where" : "which", ["agy"], { encoding: "utf8" });
  const hit = (probe.stdout || "").split(/\r?\n/).find((l) => l.trim());
  if (hit && fs.existsSync(hit.trim())) return (cached = hit.trim());
  if (!required) return null;
  throw new Error(
    "Antigravity CLI (agy) not found. Install Antigravity, or set AGY_BIN to the " +
      "full path of the agy binary."
  );
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
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  return child.pid;
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function killTree(pid) {
  if (!pid) return;
  try {
    if (WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGTERM");
  } catch {
    /* already dead */
  }
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
