/**
 * Live delegation test against another real `claude` CLI instance. Spends
 * real API usage, so it is not part of `npm test`.
 * Run with: node test/delegation-claude.js
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const PROJ = path.join(os.tmpdir(), "agmcp-claude-deleg");
fs.rmSync(PROJ, { recursive: true, force: true });
fs.mkdirSync(PROJ, { recursive: true });

const client = new Client({ name: "claude-delegation-test", version: "0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [CLI, "--agent", "claude-code"] })
);
const call = async (n, a = {}) =>
  JSON.parse((await client.callTool({ name: n, arguments: a })).content[0].text);

const d = await call("claude_delegate", {
  title: "claude-to-claude delegation probe",
  prompt: "Create a file named ok.txt containing exactly: claude delegation works",
  cwd: PROJ,
});
console.log("delegate  ->", d.task_id || d.error, "pid", d.pid);
if (!d.task_id) process.exit(1);

const w = await call("claude_task_wait", { task_id: d.task_id, timeout_seconds: 180 });
console.log("status    ->", w.status);
console.log("conversat ->", w.conversationId);
console.log("result    ->", (w.result || w.error || "").slice(0, 160).replace(/\n/g, " "));

const f = path.join(PROJ, "ok.txt");
console.log("file      ->", fs.existsSync(f) ? JSON.stringify(fs.readFileSync(f, "utf8").trim()) : "MISSING");

await client.close();
process.exit(w.status === "done" && fs.existsSync(f) ? 0 : 1);
