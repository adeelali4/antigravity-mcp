/** `antigravity-mcp init` — register this server into every MCP client found. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENTS, AGY_SETTINGS, serverKey, entryFor } from "./clients.js";
import { findAgy } from "./agy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.js");

/** Read from package.json so renaming the package needs no edits here. */
const PKG_NAME = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")
).name;

/**
 * Published installs launch via npx so they track the latest version; a checkout
 * running outside node_modules launches by absolute path, which is the only form
 * that works before the package is on the registry.
 */
function launcher(mode) {
  const installed = HERE.includes(`${path.sep}node_modules${path.sep}`);
  const useNpx = mode === "npx" || (mode !== "local" && installed);
  return useNpx
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
    const agentId = client.worker ? "antigravity" : client.id;
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
  console.log(`\n  antigravity-mcp — launching via: ${res.command} ${res.args.join(" ")}\n`);
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
  if (touched.length) {
    console.log("\n  Restart your MCP clients to pick up the new server.\n");
  } else {
    console.log("\n  Nothing registered. Pass --all to write configs for clients that are not installed.\n");
  }
}
