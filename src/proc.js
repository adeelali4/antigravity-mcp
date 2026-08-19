/** OS-process helpers shared by every delegation backend (agy, copilot, ...). */

import fs from "node:fs";
import { spawnSync } from "node:child_process";

export const WIN = process.platform === "win32";

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

/** Resolve a binary: explicit env override, a list of known install paths, then PATH. */
export function findBinary({ envVar, candidates = [], binName, required = true, label }) {
  const tried = [process.env[envVar], ...candidates].filter(Boolean);
  for (const c of tried) {
    if (fs.existsSync(c)) return c;
  }
  const probe = spawnSync(WIN ? "where" : "which", [binName], { encoding: "utf8" });
  const hit = (probe.stdout || "").split(/\r?\n/).find((l) => l.trim());
  if (hit) return hit.trim();
  if (!required) return null;
  throw new Error(`${label} not found. Set ${envVar} to its full path.`);
}
