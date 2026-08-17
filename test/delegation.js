/**
 * Live delegation test. Spends real agy quota, so it is not part of `npm test`.
 * Run with: node test/delegation.js
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const PROJ = path.join(os.tmpdir(), "agmcp-deleg");
fs.rmSync(PROJ, { recursive: true, force: true });
fs.mkdirSync(PROJ, { recursive: true });

const client = new Client({ name: "delegation-test", version: "0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [CLI, "--agent", "claude"] })
);
const call = async (n, a = {}) =>
  JSON.parse((await client.callTool({ name: n, arguments: a })).content[0].text);

const d = await call("ag_delegate", {
  title: "node port probe",
  prompt: "Create a file named ok.txt containing exactly: node port works",
  cwd: PROJ,
  timeout_seconds: 240,
});
console.log("delegate  ->", d.task_id || d.error, "pid", d.pid);

const w = await call("ag_task_wait", { task_id: d.task_id, timeout_seconds: 240 });
console.log("status    ->", w.status);
console.log("conversat ->", w.conversationId);
console.log("result    ->", (w.result || w.error || "").slice(0, 160).replace(/\n/g, " "));

const f = path.join(PROJ, "ok.txt");
console.log("file      ->", fs.existsSync(f) ? JSON.stringify(fs.readFileSync(f, "utf8").trim()) : "MISSING");

await client.close();
process.exit(w.status === "done" && fs.existsSync(f) ? 0 : 1);
