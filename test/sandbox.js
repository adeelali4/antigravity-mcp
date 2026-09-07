/**
 * One source of truth for test isolation.
 *
 * `src/store.js` reads ANTIGRAVITY_MCP_HOME lazily (in stateDir()), so a test
 * that calls mutate()/read() with it unset writes straight to the developer's
 * real ~/.antigravity-mcp/board.json. That once wiped a live delegation task
 * mid-run. Every test entrypoint calls setupSandbox() first; every function
 * that mutates the board calls assertSandboxed() before its first write.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export const SANDBOX = path.join(os.tmpdir(), "antigravity-mcp-test");
export const HOST_HOME = path.join(SANDBOX, "host-home");

/**
 * Point the board and host-scan roots at a temp sandbox. Call before the first
 * mutate()/read()/connect() -- store.js reads these lazily, so it does not have
 * to precede the `../src/*` imports, only the first use.
 *
 * ANTIGRAVITY_MCP_HOST_HOME matters as much as the board path: without it,
 * host-activity detection reads the developer's real ~/.claude and ~/.gemini and
 * the assertions vary by whatever they happen to be running.
 */
export function setupSandbox({ clean = true } = {}) {
  process.env.ANTIGRAVITY_MCP_HOME = SANDBOX;
  process.env.ANTIGRAVITY_MCP_HOST_HOME = HOST_HOME;
  // brainRoot() honours this ambient var before falling back to <stateDir>/brain
  // -- a developer who has it set (e.g. pointed at an Obsidian vault) would
  // otherwise have the brain tests write into it.
  delete process.env.ANTIGRAVITY_MCP_BRAIN;
  if (clean) fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(HOST_HOME, { recursive: true });
  return { SANDBOX, HOST_HOME };
}

/**
 * Hard stop for a board-touching test: refuse to run unless ANTIGRAVITY_MCP_HOME
 * is set and resolves to a subdirectory of the OS temp dir. This is the guard
 * that would have stopped the standalone `runStorePruneTests` run from erasing a
 * live delegation task.
 *
 * Note: this does NOT cover init()/deinit() -- those write real client configs
 * via os.homedir(), so a test exercising them must pass injected `clients` and
 * `agySettings` (as test/smoke.js does), never call them with defaults.
 */
export function assertSandboxed() {
  const home = process.env.ANTIGRAVITY_MCP_HOME;
  if (!home) {
    throw new Error(
      "board-touching test: ANTIGRAVITY_MCP_HOME is unset -- refusing to touch the live board. " +
        "Run via `npm test` or `node test/units.js`, or call setupSandbox() first."
    );
  }
  // Windows: os.tmpdir() and a resolved env path can differ in drive-letter
  // casing or 8.3 short form, so compare case-folded there.
  const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const resolved = fold(path.resolve(home));
  const tmp = fold(path.resolve(os.tmpdir()));
  if (!resolved.startsWith(tmp + path.sep)) {
    throw new Error(
      `board-touching test: ANTIGRAVITY_MCP_HOME (${path.resolve(home)}) is not under os.tmpdir (${os.tmpdir()}) -- refusing to run.`
    );
  }
}
