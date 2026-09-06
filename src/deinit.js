/**
 * `antigravity-mcp-server deinit` — the inverse of `init`.
 *
 * npm v7+ runs no uninstall lifecycle script, and no other package manager
 * cleans up either. Run this by hand before `npm uninstall`. It unregisters the
 * server from every client config, strips the managed skill block from every
 * global instructions file, and drops the agy permission rule.
 *
 * Every file goes through the same locked, atomic editor `init` uses, and the
 * pristine pre-antigravity version of each is kept at `<file>.bak-antigravity-mcp`.
 */

import fs from "node:fs";
import { CLIENTS, AGY_SETTINGS, serverKey, clientPresent } from "./clients.js";
import { stripSkillBlock, hasSkillBlock, skillMarkersBalanced } from "./skill.js";
import { stripTomlSection } from "./init.js";
import { editManagedFile, editJsonFile } from "./fileEdit.js";

/** Drop `mcp(coop/*)` from agy's allow-list. */
async function removeAgyRule({ dryRun, agySettings = AGY_SETTINGS }) {
  const rule = "mcp(coop/*)";
  try {
    let present = false;
    const res = await editJsonFile(
      agySettings,
      (cfg) => {
        const allow = cfg.permissions?.allow;
        present = Array.isArray(allow) && allow.includes(rule);
        if (present) cfg.permissions.allow = allow.filter((r) => r !== rule);
      },
      { dryRun }
    );
    if (!present || res.status === "unchanged") return { ok: true, detail: "not present" };
    return { ok: true, detail: dryRun ? `would remove ${rule}` : `removed ${rule}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

/** Strip the managed skill block from every client's global instructions file. */
async function removeSkill({ dryRun, only, all, clients = CLIENTS }) {
  const byFile = new Map();
  for (const client of clients) {
    if (!client.memoryFile) continue;
    if (only && !only.includes(client.id)) continue;
    if (!all && !clientPresent(client)) continue;
    const entry = byFile.get(client.memoryFile) || { file: client.memoryFile, clients: [] };
    entry.clients.push(client.label);
    byFile.set(client.memoryFile, entry);
  }

  const results = [];
  for (const { file, clients: labels } of byFile.values()) {
    try {
      let acted = false;
      let emptied = false;
      const res = await editManagedFile(
        file,
        (cur) => {
          if (cur === null) return undefined;
          if (!hasSkillBlock(cur) && skillMarkersBalanced(cur).ok) return undefined;
          acted = true;
          // Never delete the file: an empty stub is harmless, deleting a file the
          // user may have created is not. Emptied files just stay empty.
          const stripped = stripSkillBlock(cur);
          emptied = !stripped.trim();
          return stripped;
        },
        { dryRun }
      );
      const status = !acted
        ? "absent"
        : dryRun
        ? "would remove"
        : emptied
        ? "removed (file left empty)"
        : "removed";
      results.push({ file, clients: labels, status, detail: acted ? file : "no managed block" });
    } catch (e) {
      results.push({ file, clients: labels, status: "error", detail: e.message });
    }
  }
  return { results };
}

async function unregisterClient(client, dryRun) {
  const key = serverKey(client);

  if (client.format === "toml") {
    let existed = false;
    await editManagedFile(
      client.file,
      (cur) => {
        if (cur === null) return undefined;
        const { text, existed: e } = stripTomlSection(cur, `[${client.key}.${key}]`);
        existed = e;
        return e ? text : undefined;
      },
      { dryRun }
    );
    if (!existed) return { client: client.label, status: "not registered", detail: client.file };
    return { client: client.label, status: dryRun ? "would remove" : "removed", detail: client.file };
  }

  let existed = false;
  await editJsonFile(
    client.file,
    (cfg) => {
      if (cfg[client.key] && cfg[client.key][key]) {
        existed = true;
        delete cfg[client.key][key];
      }
    },
    { dryRun }
  );
  if (!existed) return { client: client.label, status: "not registered", detail: client.file };
  return { client: client.label, status: dryRun ? "would remove" : "removed", detail: client.file };
}

export async function deinit({
  dryRun = false, only = null, all = false, skillOnly = false,
  clients = CLIENTS, agySettings = AGY_SETTINGS,
} = {}) {
  const results = [];

  if (!skillOnly) {
    for (const client of clients) {
      if (only && !only.includes(client.id)) continue;
      if (!fs.existsSync(client.file)) {
        results.push({ client: client.label, status: "skipped", detail: "no config file" });
        continue;
      }
      try {
        results.push(await unregisterClient(client, dryRun));
      } catch (e) {
        results.push({ client: client.label, status: "error", detail: e.message });
      }
    }
  }

  const skill = await removeSkill({ dryRun, only, all, clients });
  const permission = skillOnly ? { ok: true, detail: "left in place" } : await removeAgyRule({ dryRun, agySettings });

  const touchesClaudeJson =
    !skillOnly && clients.some((c) => c.id === "claude-code" && (!only || only.includes("claude-code")));

  return { results, skill, permission, skillOnly, touchesClaudeJson };
}

const MARK = { error: "x", absent: "-", "not registered": "-", skipped: "-" };

export function printDeinit(res) {
  console.log("\n  antigravity-mcp-server — removing what `init` added\n");
  if (res.touchesClaudeJson) {
    console.log("  Close Claude Code and other editors first — this edits their live config files.\n");
  }
  if (!res.skillOnly) {
    for (const r of res.results) {
      console.log(`  ${MARK[r.status] ?? "+"} ${r.client.padEnd(22)} ${r.status.padEnd(16)} ${r.detail}`);
    }
    console.log(`\n  agy permission rule: ${res.permission.detail}`);
  }

  console.log("\n  skill — managed instructions block:");
  if (!res.skill.results.length) {
    console.log("    (no client with a global instructions file detected)");
  }
  for (const r of res.skill.results) {
    console.log(`    ${MARK[r.status] ?? "+"} ${r.status.padEnd(24)} ${r.detail}`);
  }

  const errored = [...res.results, ...res.skill.results].some((r) => r.status === "error");
  console.log(
    errored
      ? "\n  Some files could not be edited — see the x lines above.\n"
      : "\n  Done. The pristine pre-antigravity copy of each modified file is at\n" +
        "  <file>.bak-antigravity-mcp (safe to delete). You can now uninstall the package.\n"
  );
  return errored ? 1 : 0;
}
