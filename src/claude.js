/** Locating, launching and reaping another Claude Code CLI (`claude`) instance. */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME, runsDir, ensureDirs } from "./store.js";
import { WIN, findBinary } from "./proc.js";

export { isAlive, killTree } from "./proc.js";

let cached = null;

export function findClaude({ required = true } = {}) {
  if (cached && fs.existsSync(cached)) return cached;
  const found = findBinary({
    envVar: "CLAUDE_BIN",
    binName: "claude",
    label: "Claude Code CLI (claude)",
    required,
    candidates: [
      path.join(HOME, ".local", "bin", WIN ? "claude.exe" : "claude"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ],
  });
  return found ? (cached = found) : null;
}

export const outPath = (id) => path.join(runsDir(), `${id}.json`);
export const errPath = (id) => path.join(runsDir(), `${id}.err`);
export const promptPath = (id) => path.join(runsDir(), `${id}.prompt.txt`);

/**
 * Launch another `claude` instance detached, streaming its result straight to
 * disk. Detaching means a long job survives this MCP server being restarted;
 * status is recovered later by reading the run file rather than by holding a
 * child handle. This is a fully independent CLI process with its own session
 * -- not a subagent inside the calling session.
 */
export function spawnClaude(id, prompt, opts = {}) {
  const { cwd, model, resumeSessionId, addDirs = [], autoApprove = true } = opts;

  const args = [prompt, "--print", "--output-format", "json"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (model) args.push("--model", model);
  for (const d of [cwd, ...addDirs]) args.push("--add-dir", path.resolve(d));
  if (autoApprove) args.push("--dangerously-skip-permissions");

  ensureDirs();
  fs.writeFileSync(promptPath(id), prompt);
  const out = fs.openSync(outPath(id), "w");
  const err = fs.openSync(errPath(id), "w");

  const child = spawn(findClaude(), args, {
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
 * claude --output-format json prints one JSON object with the final text
 * directly in `result` (unlike copilot's JSONL), normalised here to the same
 * {status, response, conversation_id, usage} shape agy.js and copilot.js
 * produce so the rest of the server can stay backend-agnostic.
 */
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
  let payload;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  return {
    status: !payload.is_error && payload.subtype === "success" ? "SUCCESS" : "FAILURE",
    response: payload.result || "",
    conversation_id: payload.session_id,
    usage: payload.usage,
  };
}

export function readStderr(id) {
  try {
    return fs.readFileSync(errPath(id), "utf8").slice(-4000);
  } catch {
    return "";
  }
}
