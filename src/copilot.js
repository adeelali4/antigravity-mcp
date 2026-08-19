/** Locating, launching and reaping the GitHub Copilot CLI (`copilot`). */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME, runsDir, ensureDirs } from "./store.js";
import { WIN, findBinary } from "./proc.js";

export { isAlive, killTree } from "./proc.js";

let cached = null;

export function findCopilot({ required = true } = {}) {
  if (cached && fs.existsSync(cached)) return cached;
  const found = findBinary({
    envVar: "COPILOT_BIN",
    binName: "copilot",
    label: "GitHub Copilot CLI (copilot)",
    required,
    candidates: [
      WIN &&
        path.join(
          HOME, "AppData", "Local", "Microsoft", "WinGet", "Packages",
          "GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe", "copilot.exe"
        ),
      path.join(HOME, ".local", "bin", WIN ? "copilot.exe" : "copilot"),
      "/usr/local/bin/copilot",
      "/opt/homebrew/bin/copilot",
    ].filter(Boolean),
  });
  return found ? (cached = found) : null;
}

export const outPath = (id) => path.join(runsDir(), `${id}.json`);
export const errPath = (id) => path.join(runsDir(), `${id}.err`);
export const promptPath = (id) => path.join(runsDir(), `${id}.prompt.txt`);

/**
 * Launch copilot detached, streaming its JSONL event stream straight to disk.
 * Detaching means a long job survives this MCP server being restarted; status
 * is recovered later by reading the run file rather than by holding a child
 * handle. Unlike agy, copilot has no session-level timeout flag -- a hung job
 * just stays "running" until it exits on its own or ag_cancel kills it.
 */
export function spawnCopilot(id, prompt, opts = {}) {
  const { cwd, model, effort, resumeSessionId, addDirs = [], autoApprove = true } = opts;

  const args = ["-p", prompt, "--output-format", "json"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--reasoning-effort", effort);
  for (const d of [cwd, ...addDirs]) args.push("--add-dir", path.resolve(d));
  // --allow-all-tools is the documented minimum for non-interactive mode to
  // write files at all; it does not also bypass path/URL confirmation the way
  // agy's --dangerously-skip-permissions does.
  if (autoApprove) args.push("--allow-all-tools");

  ensureDirs();
  fs.writeFileSync(promptPath(id), prompt);
  const out = fs.openSync(outPath(id), "w");
  const err = fs.openSync(errPath(id), "w");

  const child = spawn(findCopilot(), args, {
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

/**
 * copilot --output-format json emits JSONL (one event per line), terminated by
 * a {"type":"result", sessionId, exitCode, usage} line. The response text is
 * not in that line -- it's the content of the last assistant.message event,
 * normalised here to the same {status, response, conversation_id, usage} shape
 * agy.js produces so the rest of the server can stay backend-agnostic.
 */
export function readResult(id) {
  let raw;
  try {
    raw = fs.readFileSync(outPath(id), "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  let resultEvent = null;
  let lastMessage = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt.type === "assistant.message" && typeof evt.data?.content === "string") {
      lastMessage = evt.data.content;
    } else if (evt.type === "result") {
      resultEvent = evt;
    }
  }
  if (!resultEvent) return null;

  return {
    status: resultEvent.exitCode === 0 ? "SUCCESS" : "FAILURE",
    response: lastMessage,
    conversation_id: resultEvent.sessionId,
    usage: resultEvent.usage,
  };
}

export function readStderr(id) {
  try {
    return fs.readFileSync(errPath(id), "utf8").slice(-4000);
  } catch {
    return "";
  }
}
