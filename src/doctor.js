/** `antigravity-mcp-server doctor` — check every link in the chain and say what is broken. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CLIENTS, AGY_SETTINGS, serverKey, clientPresent } from "./clients.js";
import { hasSkillBlock, skillMarkersBalanced } from "./skill.js";
import { findAgy } from "./agy.js";
import { loadBackends } from "./backends.js";
import { launchSpec } from "./proc.js";
import { stateDir, mutate } from "./store.js";
import { brainRoot } from "./brain.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PASS = "ok", FAIL = "FAIL", WARN = "warn";

export async function doctor({ probe = false } = {}) {
  const checks = [];
  const add = (name, state, detail) => checks.push({ name, state, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 18 ? PASS : FAIL, `v${process.versions.node}${major >= 18 ? "" : " (need >= 18.17)"}`);

  // The whole delegation roster, installed or not: a backend with no binary
  // gets no tools registered, so without this its absence is invisible.
  for (const spec of loadBackends()) {
    let bin = null;
    try {
      bin = spec.findBin({ required: false });
    } catch { /* treat a resolver that throws as simply not installed */ }
    const origin = spec.userDefined ? "your backends.json" : spec.verified ? "built-in" : "built-in, unverified";
    add(
      `delegate: ${spec.label}`,
      bin ? PASS : WARN,
      bin ? `${bin} (${origin})` : `not installed — no ${spec.prefix}_* tools (${origin})`
    );
  }

  const agy = findAgy({ required: false });
  if (agy) {
    const l = launchSpec(agy, ["--version"]);
    const v = spawnSync(l.file, l.args, { encoding: "utf8", timeout: 20000, ...l.options });
    const line = ((v.stdout || "") + (v.stderr || "")).split(/\r?\n/).find((l) => l.trim());
    add("agy runs", v.error ? FAIL : PASS, v.error ? v.error.message : (line || "responded").trim());
  }

  // The failure that silently breaks delegation: agy auto-denies MCP calls in
  // headless mode unless the server is allow-listed.
  let allow = [];
  try {
    allow = JSON.parse(fs.readFileSync(AGY_SETTINGS, "utf8")).permissions?.allow || [];
  } catch { /* missing file is itself the finding */ }
  const allowed = allow.some((r) => /^mcp\((coop|\*)/.test(r));
  add(
    "agy mcp permission",
    allowed ? PASS : FAIL,
    allowed
      ? "mcp(coop/*) present"
      : `missing mcp(coop/*) in ${AGY_SETTINGS} — agy will auto-deny coordination calls in headless mode. Run: antigravity-mcp-server init`
  );

  try {
    await mutate((b) => b);
    add("shared board", PASS, stateDir());
  } catch (e) {
    add("shared board", FAIL, `${stateDir()} — ${e.message} — run: antigravity-mcp-server reset --yes`);
  }

  const brainSource = process.env.ANTIGRAVITY_MCP_BRAIN ? "ANTIGRAVITY_MCP_BRAIN" : "default";
  add("brain", PASS, `${brainRoot()} (${brainSource})`);

  const uiDist = path.join(HERE, "..", "ui-dist", "index.html");
  add(
    "ui build",
    fs.existsSync(uiDist) ? PASS : FAIL,
    fs.existsSync(uiDist) ? "ui-dist present" : "missing — run: npm run ui:build"
  );

  for (const c of CLIENTS) {
    if (!fs.existsSync(c.file)) continue;
    let registered = false;
    try {
      const raw = fs.readFileSync(c.file, "utf8");
      // Codex's config is TOML, not JSON -- JSON.parse on it always throws,
      // which the catch below swallowed silently, so Codex reported
      // "not registered" even when init.js had written it correctly. Match
      // the same substring check init.js's own dry-run path already uses.
      registered = c.format === "toml"
        ? raw.includes(`[${c.key}.${serverKey(c)}]`)
        : Boolean(JSON.parse(raw || "{}")[c.key]?.[serverKey(c)]);
    } catch { /* unparseable config */ }
    add(`client: ${c.label}`, registered ? PASS : WARN, registered ? "registered" : "config found, server not registered — run: antigravity-mcp-server init");
  }

  // The managed instructions block, deduped over present clients (GEMINI.md is
  // shared). all present -> PASS; a torn/duplicated block -> WARN with the fix;
  // some present -> WARN (partial install); none -> stay quiet (could be
  // --no-skill, or a version that predates the feature).
  const memList = [...new Set(CLIENTS.filter((c) => c.memoryFile && clientPresent(c)).map((c) => c.memoryFile))];
  if (memList.length) {
    let withBlock = 0;
    const torn = [];
    for (const f of memList) {
      let text = "";
      try { text = fs.readFileSync(f, "utf8"); } catch { /* absent */ }
      if (!skillMarkersBalanced(text).ok) torn.push(f);
      else if (hasSkillBlock(text)) withBlock++;
    }
    if (torn.length) {
      add("skill blocks", WARN, `${torn.length} file(s) have a torn/duplicated block — fix by hand: ${torn.join(", ")}`);
    } else if (withBlock === memList.length) {
      add("skill blocks", PASS, `present in all ${memList.length} global memory files`);
    } else if (withBlock > 0) {
      add("skill blocks", WARN, `${withBlock}/${memList.length} global memory files have the block — run: antigravity-mcp-server init`);
    }
  }

  if (probe && agy) {
    const l = launchSpec(agy, [
      "--print", "Call the coop_status MCP tool and reply with SUCCESS or FAILED only.",
      "--output-format", "json", "--print-timeout", "120s",
    ]);
    const r = spawnSync(l.file, l.args, { encoding: "utf8", timeout: 150000, ...l.options });
    const raw = r.stdout || "";
    const i = raw.indexOf("{");
    let response = "";
    try { response = JSON.parse(raw.slice(i)).response || ""; } catch { /* no json */ }
    const good = /success/i.test(response);
    add("live round trip", good ? PASS : FAIL, good ? "agy called coop_status" : (response.trim() || raw.trim() || "no response").slice(0, 200));
  }

  return checks;
}

export function printDoctor(checks) {
  console.log("");
  for (const c of checks) {
    const mark = c.state === PASS ? "+" : c.state === WARN ? "-" : "x";
    console.log(`  ${mark} ${c.name.padEnd(24)} ${c.detail}`);
  }
  const failed = checks.filter((c) => c.state === FAIL).length;
  console.log(failed ? `\n  ${failed} check(s) failed.\n` : "\n  All checks passed.\n");
  return failed;
}
