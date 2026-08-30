/**
 * `antigravity-mcp-server deinit` — the inverse of `init`.
 *
 * npm v7+ does not run any uninstall lifecycle script, so `npm uninstall -g
 * antigravity-mcp-server` cannot clean up after itself. Run this first (some
 * package managers wire it to `preuninstall` for you; npm does not). It removes
 * the MCP server registration from every client, strips the managed skill block
 * from every global instructions file, and drops the agy permission rule.
 *
 * Everything it edits is backed up to `<file>.bak-antigravity-mcp` first, same
 * as `init`.
 */

import fs from "node:fs";
import path from "node:path";
import { CLIENTS, AGY_SETTINGS, serverKey } from "./clients.js";
import { backup, readJson, writeJson, readText } from "./init.js";
import { stripSkillBlock, hasSkillBlock } from "./skill.js";

/** Remove one `[<table>.<name>]` block from a TOML file. Mirrors writeTomlServer's block scan. */
function removeTomlServer(file, table, name) {
  let existing;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const header = `[${table}.${name}]`;
  const out = [];
  let skipping = false;
  let existed = false;
  for (const line of existing.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === header) {
      skipping = true;
      existed = true;
      continue;
    }
    if (skipping && trimmed.startsWith("[")) skipping = false;
    if (!skipping) out.push(line);
  }
  if (!existed) return false;
  fs.writeFileSync(file, out.join("\n").replace(/\s+$/, "") + "\n");
  return true;
}

/** Drop `mcp(coop/*)` from agy's allow-list. */
function removeAgyRule({ dryRun }) {
  const rule = "mcp(coop/*)";
  let cfg;
  try {
    cfg = readJson(AGY_SETTINGS);
  } catch (e) {
    return { ok: false, detail: e.message };
  }
  const allow = cfg.permissions?.allow;
  if (!Array.isArray(allow) || !allow.includes(rule)) {
    return { ok: true, detail: "not present" };
  }
  if (dryRun) return { ok: true, detail: `would remove ${rule}` };
  cfg.permissions.allow = allow.filter((r) => r !== rule);
  backup(AGY_SETTINGS);
  writeJson(AGY_SETTINGS, cfg);
  return { ok: true, detail: `removed ${rule}` };
}

/** Strip the managed skill block from every client's global instructions file. */
function removeSkill({ dryRun, only, all }) {
  const byFile = new Map();
  for (const client of CLIENTS) {
    if (!client.memoryFile) continue;
    if (only && !only.includes(client.id)) continue;
    const present = fs.existsSync(client.file) || fs.existsSync(path.dirname(client.file));
    if (!present && !all) continue;
    const entry = byFile.get(client.memoryFile) || { file: client.memoryFile, clients: [] };
    entry.clients.push(client.label);
    byFile.set(client.memoryFile, entry);
  }

  const results = [];
  for (const { file, clients } of byFile.values()) {
    try {
      const existing = readText(file);
      if (!hasSkillBlock(existing)) {
        results.push({ file, clients, status: "absent", detail: "no managed block" });
        continue;
      }
      if (dryRun) {
        results.push({ file, clients, status: "would remove", detail: file });
        continue;
      }
      const stripped = stripSkillBlock(existing);
      backup(file);
      // If the block was the entire file (we created it), remove the file
      // rather than leave an empty stub behind.
      if (!stripped.trim()) {
        fs.rmSync(file, { force: true });
        results.push({ file, clients, status: "removed (file deleted)", detail: file });
      } else {
        fs.writeFileSync(file, stripped);
        results.push({ file, clients, status: "removed", detail: file });
      }
    } catch (e) {
      results.push({ file, clients, status: "error", detail: e.message });
    }
  }
  return { results };
}

export function deinit({ dryRun = false, only = null, all = false, skillOnly = false } = {}) {
  const results = [];

  if (!skillOnly) {
    for (const client of CLIENTS) {
      if (only && !only.includes(client.id)) continue;
      if (!fs.existsSync(client.file)) {
        results.push({ client: client.label, status: "skipped", detail: "no config file" });
        continue;
      }
      const key = serverKey(client);
      try {
        if (client.format === "toml") {
          const had = fs.readFileSync(client.file, "utf8").includes(`[${client.key}.${key}]`);
          if (!had) {
            results.push({ client: client.label, status: "not registered", detail: client.file });
            continue;
          }
          if (dryRun) {
            results.push({ client: client.label, status: "would remove", detail: client.file });
            continue;
          }
          backup(client.file);
          removeTomlServer(client.file, client.key, key);
          results.push({ client: client.label, status: "removed", detail: client.file });
          continue;
        }

        const cfg = readJson(client.file);
        if (!cfg[client.key] || !cfg[client.key][key]) {
          results.push({ client: client.label, status: "not registered", detail: client.file });
          continue;
        }
        if (dryRun) {
          results.push({ client: client.label, status: "would remove", detail: client.file });
          continue;
        }
        delete cfg[client.key][key];
        backup(client.file);
        writeJson(client.file, cfg);
        results.push({ client: client.label, status: "removed", detail: client.file });
      } catch (e) {
        results.push({ client: client.label, status: "error", detail: e.message });
      }
    }
  }

  const skill = removeSkill({ dryRun, only, all });
  const permission = skillOnly ? { ok: true, detail: "left in place" } : removeAgyRule({ dryRun });

  return { results, skill, permission, skillOnly };
}

export function printDeinit(res) {
  console.log("\n  antigravity-mcp-server — removing what `init` added\n");
  if (!res.skillOnly) {
    for (const r of res.results) {
      const mark = r.status === "error" ? "x" : r.status.startsWith("removed") || r.status.startsWith("would") ? "+" : "-";
      console.log(`  ${mark} ${r.client.padEnd(22)} ${r.status.padEnd(16)} ${r.detail}`);
    }
    console.log(`\n  agy permission rule: ${res.permission.detail}`);
  }

  console.log("\n  skill — managed instructions block:");
  if (!res.skill.results.length) {
    console.log("    (no client with a global instructions file detected)");
  }
  for (const r of res.skill.results) {
    const mark = r.status === "error" ? "x" : r.status === "absent" ? "-" : "+";
    console.log(`    ${mark} ${r.status.padEnd(22)} ${r.file}  [${r.clients.join(", ")}]`);
  }

  const errored = [...res.results, ...res.skill.results].some((r) => r.status === "error");
  console.log(
    errored
      ? "\n  Some files could not be edited — see the x lines above.\n"
      : "\n  Done. Each edited file was backed up to <file>.bak-antigravity-mcp (safe to delete).\n" +
        "  You can now `npm uninstall -g antigravity-mcp-server`.\n"
  );
  return errored ? 1 : 0;
}
