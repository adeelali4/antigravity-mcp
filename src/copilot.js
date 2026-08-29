/** Locating, launching and reaping the GitHub Copilot CLI (`copilot`). */

import fs from "node:fs";
import path from "node:path";
import { HOME, outPath } from "./store.js";
import { WIN, findBinary, standardCandidates } from "./proc.js";

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
      // winget puts it somewhere nothing else would guess; then the standard set.
      WIN &&
        path.join(
          HOME, "AppData", "Local", "Microsoft", "WinGet", "Packages",
          "GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe", "copilot.exe"
        ),
      ...standardCandidates("copilot"),
    ].filter(Boolean),
  });
  return found ? (cached = found) : null;
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
  // Unlike agy and claude, copilot streams this file for the whole run, so a
  // poll lands mid-transcript far more often than not -- and without this,
  // every one of those polls JSON.parses every line of an ever-growing
  // transcript only to conclude the run isn't finished. No terminal result
  // line means exactly that, and a substring scan settles it far cheaper. A
  // false positive (the text appearing inside a message) just falls through
  // to the real parse below, which still returns null correctly.
  if (!/"type"\s*:\s*"result"/.test(raw)) return null;

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
