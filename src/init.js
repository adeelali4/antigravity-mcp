/** `antigravity-mcp-server init` — register this server into every MCP client found. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CLIENTS, AGY_SETTINGS, serverKey, entryFor } from "./clients.js";
import { findAgy } from "./agy.js";

const WIN = process.platform === "win32";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.js");

const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
/** Read from package.json so renaming the package needs no edits here. */
export const PKG_NAME = PKG.name;
export const BIN_NAME = Object.keys(PKG.bin || {})[0] || PKG_NAME;

/**
 * A bin resolved from an npx cache (~/.npm/_npx/... or a temp dir) is not a
 * real global install -- it is this very invocation's throwaway copy.
 */
function isNpxCache(resolved) {
  return /[\\/](_npx|npm-cache)[\\/]/.test(resolved) || /[\\/]Temp[\\/]/i.test(resolved);
}

export function findGlobalBin() {
  try {
    const probe = spawnSync(WIN ? "where" : "which", [BIN_NAME], { encoding: "utf8" });
    const hit = (probe.stdout || "").split(/\r?\n/).find((l) => l.trim());
    if (!hit) return null;
    const resolved = hit.trim();
    return isNpxCache(resolved) ? null : resolved;
  } catch {
    return null;
  }
}

/**
 * Prefer a real global install -- it starts instantly and only changes
 * version when the user explicitly updates it, instead of npx silently
 * pulling latest on every launch (which can skew the two agents' protocol
 * versions if only one side has restarted). Fall back to npx so a bare
 * `npx antigravity-mcp-server init`, with nothing installed yet, still
 * works. A checkout running outside node_modules launches by absolute path,
 * the only form that works before the package is on the registry at all.
 */
function launcher(mode) {
  if (mode === "global") return { command: BIN_NAME, args: [] };
  if (mode === "npx") return { command: "npx", args: ["-y", PKG_NAME] };
  if (mode === "local") return { command: process.execPath, args: [CLI] };

  const globalBin = findGlobalBin();
  if (globalBin) return { command: BIN_NAME, args: [] };
  const installed = HERE.includes(`${path.sep}node_modules${path.sep}`);
  return installed
    ? { command: "npx", args: ["-y", PKG_NAME] }
    : { command: process.execPath, args: [CLI] };
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON (${e.message}); fix or move it, then re-run`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function backup(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return null;
  const dest = `${file}.bak-antigravity-mcp`;
  fs.copyFileSync(file, dest);
  return dest;
}

/** agy auto-denies MCP tools in headless mode without an explicit allow-rule. */
function allowAgyMcp({ dryRun }) {
  const rule = "mcp(coop/*)";
  let cfg;
  try {
    cfg = readJson(AGY_SETTINGS);
  } catch (e) {
    return { ok: false, detail: e.message };
  }
  cfg.permissions ||= {};
  cfg.permissions.allow ||= [];
  if (cfg.permissions.allow.includes(rule)) {
    return { ok: true, detail: `already allow-listed (${rule})` };
  }
  cfg.permissions.allow.push(rule);
  if (dryRun) return { ok: true, detail: `would add ${rule}` };
  backup(AGY_SETTINGS);
  writeJson(AGY_SETTINGS, cfg);
  return { ok: true, detail: `added ${rule}` };
}

export function init({ dryRun = false, launchMode = "auto", only = null, all = false } = {}) {
  const { command, args } = launcher(launchMode);
  const results = [];

  for (const client of CLIENTS) {
    if (only && !only.includes(client.id)) continue;

    // Only touch clients that are actually present, unless --all is given.
    const present = fs.existsSync(client.file) || fs.existsSync(path.dirname(client.file));
    if (!present && !all) {
      results.push({ client: client.label, status: "skipped", detail: "not installed" });
      continue;
    }

    const key = serverKey(client);
    const agentId = client.workerAgent || client.id;
    let cfg;
    try {
      cfg = readJson(client.file);
    } catch (e) {
      results.push({ client: client.label, status: "error", detail: e.message });
      continue;
    }

    cfg[client.key] ||= {};
    const existed = Boolean(cfg[client.key][key]);
    cfg[client.key][key] = entryFor(client, command, [...args, "--agent", agentId]);

    if (dryRun) {
      results.push({ client: client.label, status: existed ? "would update" : "would add", detail: client.file });
      continue;
    }
    try {
      backup(client.file);
      writeJson(client.file, cfg);
      results.push({ client: client.label, status: existed ? "updated" : "added", detail: client.file });
    } catch (e) {
      results.push({ client: client.label, status: "error", detail: e.message });
    }
  }

  const agyFound = Boolean(findAgy({ required: false }));
  const permission = agyFound ? allowAgyMcp({ dryRun }) : { ok: false, detail: "agy not installed" };

  return { command, args, results, agyFound, permission };
}

export function printInit(res) {
  const touched = res.results.filter((r) => r.status !== "skipped");
  const via = res.command === "npx" ? `${res.command} ${res.args.join(" ")}` : res.command;
  console.log(`\n  antigravity-mcp-server — launching via: ${via}\n`);
  for (const r of res.results) {
    const mark = r.status === "error" ? "x" : r.status === "skipped" ? "-" : "+";
    console.log(`  ${mark} ${r.client.padEnd(22)} ${r.status.padEnd(12)} ${r.detail}`);
  }
  console.log(
    `\n  agy permission rule: ${res.permission.ok ? "ok" : "NOT SET"} — ${res.permission.detail}`
  );
  if (!res.agyFound) {
    console.log(
      "\n  ! Antigravity CLI (agy) was not found, so delegation will fail.\n" +
        "    Install Antigravity, or set AGY_BIN to the agy binary path.\n" +
        "    Coordination tools still work without it."
    );
  }
  if (res.command === "npx") {
    console.log(
      `\n  Using npx, so every launch re-checks the registry. For instant startup:\n` +
        `    npm install -g ${PKG_NAME} && ${BIN_NAME} init\n`
    );
  }
  if (touched.length) {
    console.log("\n  Restart your MCP clients to pick up the new server.\n");
  } else {
    console.log("\n  Nothing registered. Pass --all to write configs for clients that are not installed.\n");
  }
}
