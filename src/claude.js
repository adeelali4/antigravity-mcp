/** Locating, launching and reaping another Claude Code CLI (`claude`) instance. */

import fs from "node:fs";
import { outPath } from "./store.js";
import { findBinary, standardCandidates } from "./proc.js";

export { isAlive, killTree } from "./proc.js";

let cached = null;

export function findClaude({ required = true } = {}) {
  if (cached && fs.existsSync(cached)) return cached;
  const found = findBinary({
    envVar: "CLAUDE_BIN",
    binName: "claude",
    label: "Claude Code CLI (claude)",
    required,
    candidates: standardCandidates("claude"),
  });
  return found ? (cached = found) : null;
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
