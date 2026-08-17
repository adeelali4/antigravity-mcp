/** `antigravity-mcp doctor` — check every link in the chain and say what is broken. */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { CLIENTS, AGY_SETTINGS, serverKey } from "./clients.js";
import { findAgy } from "./agy.js";
import { stateDir, mutate, read } from "./store.js";

const PASS = "ok", FAIL = "FAIL", WARN = "warn";

export function doctor({ probe = false } = {}) {
  const checks = [];
  const add = (name, state, detail) => checks.push({ name, state, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 18 ? PASS : FAIL, `v${process.versions.node}${major >= 18 ? "" : " (need >= 18.17)"}`);

  const agy = findAgy({ required: false });
  add("agy binary", agy ? PASS : FAIL, agy || "not found — set AGY_BIN, or install Antigravity");

  if (agy) {
    const v = spawnSync(agy, ["--version"], { encoding: "utf8", timeout: 20000 });
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
      : `missing mcp(coop/*) in ${AGY_SETTINGS} — agy will auto-deny coordination calls in headless mode. Run: antigravity-mcp init`
  );

  try {
    mutate((b) => b);
    add("shared board", PASS, stateDir());
  } catch (e) {
    add("shared board", FAIL, `${stateDir()} — ${e.message}`);
  }

  for (const c of CLIENTS) {
    if (!fs.existsSync(c.file)) continue;
    let registered = false;
    try {
      registered = Boolean(JSON.parse(fs.readFileSync(c.file, "utf8") || "{}")[c.key]?.[serverKey(c)]);
    } catch { /* unparseable config */ }
    add(`client: ${c.label}`, registered ? PASS : WARN, registered ? "registered" : "config found, server not registered");
  }

  if (probe && agy) {
    const r = spawnSync(
      agy,
      ["--print", "Call the coop_status MCP tool and reply with SUCCESS or FAILED only.",
       "--output-format", "json", "--print-timeout", "120s"],
      { encoding: "utf8", timeout: 150000 }
    );
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
