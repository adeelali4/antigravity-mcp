/** Locating, launching and reaping the Antigravity CLI (`agy`). */

import fs from "node:fs";
import path from "node:path";
import { HOME, runsDir } from "./store.js";
import { WIN, findBinary, standardCandidates } from "./proc.js";

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
      // Antigravity's own installer locations, then every standard one.
      WIN && path.join(HOME, "AppData", "Local", "agy", "bin", "agy.exe"),
      path.join(HOME, ".agy", "bin", WIN ? "agy.exe" : "agy"),
      ...standardCandidates("agy"),
    ].filter(Boolean),
  });
  return found ? (cached = found) : null;
}

export const outPath = (id) => path.join(runsDir(), `${id}.json`);
export const errPath = (id) => path.join(runsDir(), `${id}.err`);
export const promptPath = (id) => path.join(runsDir(), `${id}.prompt.txt`);

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
