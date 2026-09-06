/** `antigravity-mcp-server init` — register this server into every MCP client found. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CLIENTS, AGY_SETTINGS, serverKey, entryFor, clientPresent } from "./clients.js";
import { findAgy } from "./agy.js";
import { upsertSkillBlock, hasSkillBlock, MalformedBlockError } from "./skill.js";
import { detectEol } from "./markerBlock.js";
import { editManagedFile, editJsonFile } from "./fileEdit.js";

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
  return (
    /[\\/](_npx|npm-cache)[\\/]/.test(resolved) ||
    /[\\/](tmp|Temp|var[\\/]folders)[\\/]/i.test(resolved)
  );
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

/** TOML basic string. Everything written here is a path or a flag, so this is enough. */
function tomlString(v) {
  return JSON.stringify(String(v));
}

/**
 * Remove one `[<table>.<name>]` block (and any `[<table>.<name>.*]` sub-table)
 * from TOML text, preserving the file's line endings and everything else.
 * Returns `{ text, existed }`.
 */
export function stripTomlSection(existing, header) {
  const eol = detectEol(existing || "\n");
  const subPrefix = header.slice(0, -1) + "."; // "[table.name]" -> "[table.name."
  const out = [];
  let skipping = false;
  let existed = false;
  for (const line of (existing || "").split(/\r?\n/)) {
    const t = line.trim();
    if (t === header || (t.startsWith(subPrefix) && t.endsWith("]"))) {
      skipping = true;
      existed = true;
      continue;
    }
    if (t.startsWith("[")) skipping = false; // any other section header ends the skip
    if (!skipping) out.push(line);
  }
  const text = out.join(eol).replace(/\s+$/, "");
  return { text: text ? text + eol : "", existed };
}

/**
 * Add or replace one `[<table>.<name>]` block in TOML text. Codex is the only
 * client on TOML, and a full parser would be a dependency for one file; a block
 * edit that preserves every byte outside the block is enough. Returns
 * `{ text, existed }`.
 */
export function upsertTomlSection(existing, table, name, command, args) {
  const eol = detectEol(existing || "\n");
  const header = `[${table}.${name}]`;
  const { text: without, existed } = stripTomlSection(existing || "", header);
  const body = [
    header,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
  ].join(eol);
  const before = without.replace(/\s+$/, "");
  return { text: (before ? before + eol + eol : "") + body + eol, existed };
}

/** agy auto-denies MCP tools in headless mode without an explicit allow-rule. */
async function allowAgyMcp({ dryRun, agySettings = AGY_SETTINGS }) {
  const rule = "mcp(coop/*)";
  try {
    let had = false;
    const res = await editJsonFile(
      agySettings,
      (cfg) => {
        cfg.permissions ||= {};
        cfg.permissions.allow ||= [];
        had = cfg.permissions.allow.includes(rule);
        if (!had) cfg.permissions.allow.push(rule);
      },
      { dryRun }
    );
    if (res.status === "unchanged") return { ok: true, detail: `already allow-listed (${rule})` };
    return { ok: true, detail: dryRun ? `would add ${rule}` : `added ${rule}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

/**
 * Write the managed "skill" block (skill.js) into every detected client's global
 * instructions file. Registering the MCP server only makes the tools callable;
 * this is what keeps the agent knowing what they are for across sessions.
 *
 * Several client entries point at the same file (~/.gemini/GEMINI.md is shared by
 * gemini-cli and both Antigravity surfaces), so paths are deduped and written
 * once, each under its own lock and via an atomic replace.
 */
export async function installSkill({ dryRun = false, only = null, all = false, clients = CLIENTS } = {}) {
  const byFile = new Map();
  for (const client of clients) {
    if (!client.memoryFile) continue;
    if (only && !only.includes(client.id)) continue;
    if (!all && !clientPresent(client)) continue;
    const entry = byFile.get(client.memoryFile) || { file: client.memoryFile, clients: [] };
    entry.clients.push(client.label);
    byFile.set(client.memoryFile, entry);
  }

  const WOULD = { create: "would create", add: "would add", update: "would update" };
  const DONE = { create: "created", add: "added", update: "updated" };
  const results = [];
  for (const { file, clients: labels } of byFile.values()) {
    try {
      let verb = null;
      await editManagedFile(
        file,
        (cur) => {
          const before = cur ?? "";
          const next = upsertSkillBlock(before); // throws MalformedBlockError on a torn block
          if (next === before) return undefined;
          verb = cur === null ? "create" : hasSkillBlock(before) ? "update" : "add";
          return next;
        },
        { dryRun }
      );
      results.push({
        file,
        clients: labels,
        status: verb ? (dryRun ? WOULD : DONE)[verb] : "unchanged",
        detail: verb ? file : "block already current",
      });
    } catch (e) {
      const detail =
        e instanceof MalformedBlockError
          ? `${e.message} (left untouched)`
          : e.message;
      results.push({ file, clients: labels, status: "error", detail });
    }
  }
  return { results };
}

async function registerClient(client, command, args, dryRun) {
  const key = serverKey(client);
  const agentId = client.workerAgent || client.id;
  const fullArgs = [...args, "--agent", agentId];

  if (client.format === "toml") {
    let existed = false;
    const res = await editManagedFile(
      client.file,
      (cur) => {
        const { text, existed: e } = upsertTomlSection(cur ?? "", client.key, key, command, fullArgs);
        existed = e;
        return text === (cur ?? "") ? undefined : text;
      },
      { dryRun }
    );
    const status = res.status === "unchanged" ? "unchanged" : dryRun ? (existed ? "would update" : "would add") : existed ? "updated" : "added";
    return { client: client.label, status, detail: client.file };
  }

  let existed = false;
  const res = await editJsonFile(
    client.file,
    (cfg) => {
      cfg[client.key] ||= {};
      existed = Boolean(cfg[client.key][key]);
      cfg[client.key][key] = entryFor(client, command, fullArgs);
    },
    { dryRun }
  );
  const status = res.status === "unchanged" ? "unchanged" : dryRun ? (existed ? "would update" : "would add") : existed ? "updated" : "added";
  return { client: client.label, status, detail: client.file };
}

export async function init({
  dryRun = false, launchMode = "auto", only = null, all = false,
  skill = true, clients = CLIENTS, agySettings = AGY_SETTINGS,
} = {}) {
  const { command, args } = launcher(launchMode);
  const results = [];

  for (const client of clients) {
    if (only && !only.includes(client.id)) continue;
    if (!all && !clientPresent(client)) {
      results.push({ client: client.label, status: "skipped", detail: "not installed" });
      continue;
    }
    try {
      results.push(await registerClient(client, command, args, dryRun));
    } catch (e) {
      results.push({ client: client.label, status: "error", detail: e.message });
    }
  }

  const agyFound = Boolean(findAgy({ required: false }));
  const permission = agyFound ? await allowAgyMcp({ dryRun, agySettings }) : { ok: false, detail: "agy not installed" };

  const skillRes = skill ? await installSkill({ dryRun, only, all, clients }) : null;

  return { command, args, results, agyFound, permission, skill: skillRes };
}

export function printInit(res) {
  const touched = res.results.filter((r) => r.status !== "skipped" && r.status !== "unchanged");
  const via = res.command === "npx" ? `${res.command} ${res.args.join(" ")}` : res.command;
  console.log(`\n  antigravity-mcp-server — launching via: ${via}\n`);
  for (const r of res.results) {
    const mark = r.status === "error" ? "x" : r.status === "skipped" || r.status === "unchanged" ? "-" : "+";
    console.log(`  ${mark} ${r.client.padEnd(22)} ${r.status.padEnd(12)} ${r.detail}`);
  }
  console.log(
    `\n  agy permission rule: ${res.permission.ok ? "ok" : "NOT SET"} — ${res.permission.detail}`
  );

  if (res.skill) {
    console.log("\n  skill — managed instructions block in each CLI's global memory:");
    if (!res.skill.results.length) {
      console.log("    (no client with a global instructions file detected)");
    }
    for (const r of res.skill.results) {
      const mark = r.status === "error" ? "x" : r.status === "unchanged" ? "-" : "+";
      console.log(`    ${mark} ${r.status.padEnd(12)} ${r.file}  [${r.clients.join(", ")}]`);
    }
    console.log("    Re-run init to refresh it; pass --no-skill to skip. Undo with: antigravity-mcp-server deinit");
  }

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
    console.log("\n  Nothing changed. Pass --all to write configs for clients that are not installed.\n");
  }
}
