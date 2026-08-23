/** OS-process helpers shared by every delegation backend (agy, copilot, ...). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const WIN = process.platform === "win32";
const HOME = os.homedir();

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
    if (WIN) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {
    /* already dead */
  }
}

/** Quote one argument so cmd.exe hands it to the target program intact. */
function winQuote(s) {
  // CRT rules: a backslash is only special immediately before a quote, so
  // double any run of backslashes that precedes one (or ends the string, where
  // the closing quote we add makes it precede one).
  const escaped = String(s)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * How to launch `bin` with `args`.
 *
 * Windows cannot spawn a .cmd/.bat directly -- it needs a shell. Node's
 * `shell: true` arranges that, but it builds the command line by joining argv
 * with spaces and no quoting whatsoever. Several backends pass the whole
 * prompt as an argument, so under `shell: true` a prompt containing a space
 * splits into separate arguments and one containing `&` or `|` runs as a
 * second command. Invoke cmd.exe directly and do the quoting properly instead.
 *
 * (`%VAR%` inside an argument is still expanded by cmd -- unavoidable on this
 * path, and harmless next to the alternative.)
 */
export function launchSpec(bin, args) {
  if (!WIN || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args, options: {} };
  const line = [bin, ...args].map(winQuote).join(" ");
  return {
    file: process.env.ComSpec || "cmd.exe",
    // /d skips AutoRun scripts, /s makes cmd strip exactly the outer quote
    // pair and leave the rest alone, /c runs the line and exits.
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/**
 * The places a coding CLI actually lands, across every platform this runs on.
 *
 * PATH lookup in findBinary() catches most installs, but not all: a launchd/
 * systemd-started editor, a cron job, or an MCP client spawned from a GUI
 * often has a minimal PATH that omits Homebrew, ~/.local/bin and the npm
 * global prefix entirely. Listing the real install locations means delegation
 * keeps working in those environments instead of reporting the CLI missing.
 */
export function standardCandidates(name) {
  const out = [];
  if (WIN) {
    const appData = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
    out.push(
      // npm/pnpm global shims -- .cmd is what Windows can execute directly.
      path.join(appData, "npm", `${name}.cmd`),
      path.join(appData, "npm", `${name}.exe`),
      path.join(localAppData, "pnpm", `${name}.cmd`),
      path.join(localAppData, "Programs", name, `${name}.exe`),
      path.join(localAppData, name, `${name}.exe`),
      path.join(localAppData, name, "bin", `${name}.exe`),
      path.join(HOME, ".local", "bin", `${name}.exe`),
      path.join(HOME, ".local", "bin", `${name}.cmd`)
    );
  } else {
    out.push(
      path.join(HOME, ".local", "bin", name),
      "/opt/homebrew/bin/" + name,   // macOS on Apple silicon
      "/usr/local/bin/" + name,      // macOS on Intel, and the common Linux prefix
      "/usr/bin/" + name,            // distro packages on Debian/Ubuntu/Fedora
      "/snap/bin/" + name,           // Ubuntu snaps
      path.join(HOME, ".npm-global", "bin", name),
      path.join(HOME, ".bun", "bin", name),
      path.join(HOME, ".volta", "bin", name),
      path.join(HOME, ".asdf", "shims", name)
    );
  }
  return out;
}

/**
 * Rank the hits `where` returns on Windows.
 *
 * An npm-installed CLI drops three files side by side: `foo` (a POSIX shell
 * script), `foo.cmd`, and `foo.ps1`. `where` lists all of them, and the
 * extension-less one often comes first -- spawning that on Windows fails,
 * since it is a bash script. Prefer what Windows can actually execute.
 */
const WIN_EXEC_ORDER = [".exe", ".com", ".cmd", ".bat"];

function preferExecutable(hits) {
  if (!WIN) return hits[0];
  for (const ext of WIN_EXEC_ORDER) {
    const match = hits.find((h) => h.toLowerCase().endsWith(ext));
    if (match) return match;
  }
  // Nothing recognisable: fall back to the first hit rather than reporting the
  // CLI as missing -- a .ps1 at least stands a chance.
  return hits[0];
}

/** Resolve a binary: explicit env override, a list of known install paths, then PATH. */
export function findBinary({ envVar, candidates = [], binName, required = true, label }) {
  const tried = [process.env[envVar], ...candidates].filter(Boolean);
  for (const c of tried) {
    if (fs.existsSync(c)) return c;
  }
  const probe = spawnSync(WIN ? "where" : "which", [binName], { encoding: "utf8" });
  const hits = (probe.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (hits.length) return preferExecutable(hits);
  if (!required) return null;
  throw new Error(`${label} not found. Set ${envVar} to its full path.`);
}
