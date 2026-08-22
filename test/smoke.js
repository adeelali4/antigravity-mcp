/** End-to-end smoke test: real stdio MCP clients, two agent identities, one board. */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { printUpdate } from "../src/update.js";
import { restart, printRestart } from "../src/restart.js";
import { computeAgents, inferLiveActivity, getAntigravityActivity } from "../src/ui/bridgeState.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const SANDBOX = path.join(os.tmpdir(), "antigravity-mcp-test");
process.env.ANTIGRAVITY_MCP_HOME = SANDBOX;
fs.rmSync(SANDBOX, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "+" : "x"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

async function connect(agent) {
  const client = new Client({ name: `test-${agent}`, version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "--agent", agent],
      env: { ...process.env, ANTIGRAVITY_MCP_HOME: SANDBOX },
    })
  );
  return client;
}

const call = async (c, name, args = {}) =>
  JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

console.log("\nantigravity-mcp-server smoke test\n");

const alice = await connect("claude");
const bob = await connect("antigravity");

const tools = (await alice.listTools()).tools;
const names = new Set(tools.map((t) => t.name));
// Not a fixed count: delegation tools are only registered for CLIs actually
// installed, so the total legitimately differs per machine. Assert the shape
// instead -- every coordination tool present, and every delegation lane that
// IS offered offering its full set.
const COORDINATION = [
  "coop_status", "board_post", "board_update", "board_list",
  "claim_paths", "release_paths", "check_paths",
  "notes_send", "notes_read", "presence_set", "activity", "coop_reset",
];
check("stdio handshake + tools/list", tools.length >= COORDINATION.length, `${tools.length} tools`);
check("every coordination tool present", COORDINATION.every((n) => names.has(n)),
  COORDINATION.filter((n) => !names.has(n)).join(",") || "all");

const lanes = [...names].filter((n) => n.endsWith("_delegate")).map((n) => n.replace("_delegate", ""));
check("at least one delegation backend offered", lanes.length > 0, lanes.join(","));
check("each backend offers a complete lane",
  lanes.every((p) => ["_task_status", "_task_wait", "_cancel"].every((s) => names.has(p + s))),
  lanes.map((p) => `${p}${names.has(p + "_followup") ? "+followup" : ""}`).join(" "));
check("every tool documented", tools.every((t) => t.description?.length > 40));

// Path locks must hold across two separate server processes.
const claimed = await call(alice, "claim_paths", {
  paths: ["~/proj/api", "~/proj/db.ts"],
  note: "orders endpoint",
});
check("claude claims two paths", claimed.granted.length === 2);

const contested = await call(bob, "claim_paths", { paths: ["~/proj/api/routes.ts", "~/proj/ui"] });
check("nested path conflict detected", contested.conflicts.length === 1, contested.conflicts[0]?.held_by);
check("free path still granted", contested.granted.length === 1);

// Messaging and presence, in both directions.
await call(alice, "notes_send", { to: "antigravity", body: "POST /api/orders -> {id,status}" });
const inbox = await call(bob, "notes_read", {});
check("note crosses processes", inbox.count === 1 && /api\/orders/.test(inbox.notes[0].body));
check("note is not echoed to sender", (await call(alice, "notes_read", {})).count === 0);

await call(bob, "presence_set", { status: "working", detail: "building the order form" });
const status = await call(alice, "coop_status");
check("presence visible to peer", status.presence.some((p) => p.agent === "antigravity"));
check("peer sees locked paths", status.locked_paths.length === 3);
check("identity is per-process", status.you_are === "claude");

// Board lifecycle.
const posted = await call(alice, "board_post", { title: "Build order form", owner: "antigravity" });
await call(bob, "board_update", { task_id: posted.task_id, status: "running", note: "started" });
const listed = await call(alice, "board_list", { owner: "antigravity" });
check("board item visible to owner", listed.items.some((i) => i.id === posted.task_id && i.status === "running"));
check(
  "board_update nonexistent task is handled",
  (await call(alice, "board_update", { task_id: "missing-task", status: "done" })).error !== undefined
);

await call(bob, "board_update", { task_id: posted.task_id, status: "done", note: "completed" });
const listedDefault = await call(alice, "board_list", { owner: "antigravity" });
const listedWithDone = await call(alice, "board_list", { owner: "antigravity", include_done: true });
check("board_list excludes done by default", !listedDefault.items.some((i) => i.id === posted.task_id));
check("board_list include_done includes done", listedWithDone.items.some((i) => i.id === posted.task_id));

const unlockedPath = await call(alice, "check_paths", { paths: ["~/proj/free.ts"] });
check("check_paths shows unlocked path as free", unlockedPath.paths[0]?.free === true);

await call(alice, "claim_paths", { paths: ["~/proj/self-lock.ts"], note: "self-lock test" });
const selfHeld = await call(alice, "check_paths", { paths: ["~/proj/self-lock.ts"] });
check("check_paths reports own lock as free", selfHeld.paths[0]?.free === true);

await call(alice, "notes_send", { to: "all", body: "broadcast: sync point" });
await call(alice, "notes_send", { to: "antigravity", body: "targeted: antigravity-only" });
const aliceInbox = await call(alice, "notes_read", { mark_read: false });
check("notes_send to all does not auto-send to sender inbox", !aliceInbox.notes.some((n) => /broadcast: sync point/.test(n.body)));
const bobInbox = await call(bob, "notes_read", { mark_read: false });
check(
  "notes_send targeted + all reaches target",
  bobInbox.count >= 2 &&
    bobInbox.notes.some((n) => /broadcast: sync point/.test(n.body)) &&
    bobInbox.notes.some((n) => /targeted: antigravity-only/.test(n.body))
);
const bobUnreadAgain = await call(bob, "notes_read", { unread_only: true });
check(
  "notes_read mark_read false keeps notes unread",
  bobUnreadAgain.count >= 2 &&
    bobUnreadAgain.notes.some((n) => /broadcast: sync point/.test(n.body)) &&
    bobUnreadAgain.notes.some((n) => /targeted: antigravity-only/.test(n.body))
);
await call(bob, "notes_read", {});

await call(alice, "claim_paths", { paths: ["~/proj/release-a.ts", "~/proj/release-b.ts"], note: "selective release test" });
const selectiveRelease = await call(alice, "release_paths", { paths: ["~/proj/release-a.ts"] });
check("release_paths explicit path releases one", selectiveRelease.released === 1);
const afterSelective = await call(bob, "check_paths", { paths: ["~/proj/release-a.ts", "~/proj/release-b.ts"] });
check(
  "release_paths explicit path leaves other held",
  afterSelective.paths[0]?.free === true && afterSelective.paths[1]?.free === false
);

const released = await call(alice, "release_paths", { all_mine: true });
check("release drops only my locks", released.released === 4);
check("other agent keeps its lock", (await call(bob, "check_paths", { paths: ["~/proj/ui"] })).paths[0].free);

check("unknown task handled", (await call(alice, "ag_task_status", { task_id: "nope" })).error !== undefined);
check("reset is guarded", (await call(alice, "coop_reset", {})).error !== undefined);
check("reset works with confirm", (await call(alice, "coop_reset", { confirm: true })).reset === true);

const restartToolRes = await call(alice, "coop_restart", {});
check("coop_restart works", restartToolRes.restarted === true);

const restartToolWipe = await call(alice, "coop_restart", { reset_board: true });
check("coop_restart with reset_board works", restartToolWipe.restarted === true && restartToolWipe.reset_board === true);

// rich presence statuses: finding, reading, bashing, searching
const pFinding = await call(alice, "presence_set", { status: "finding", detail: "finding project files" });
check("presence_set accepts finding status", pFinding.status === "finding");

const pBashing = await call(alice, "presence_set", { status: "bashing", detail: "running npm test" });
check("presence_set accepts bashing status", pBashing.status === "bashing");

const pReading = await call(alice, "presence_set", { status: "reading", detail: "reading README.md" });
check("presence_set accepts reading status", pReading.status === "reading");

const pSearching = await call(alice, "presence_set", { status: "searching", detail: "searching for auth" });
check("presence_set accepts searching status", pSearching.status === "searching");

// inferLiveActivity check
const mockRunDir = path.join(SANDBOX, "runs");
fs.mkdirSync(mockRunDir, { recursive: true });
fs.writeFileSync(path.join(mockRunDir, "testtask.json"), JSON.stringify({ name: "run_command", CommandLine: "npm test" }));
const inferred = inferLiveActivity({ id: "testtask" });
check("inferLiveActivity detects bashing", inferred?.status === "bashing");

fs.writeFileSync(path.join(mockRunDir, "testtask2.json"), JSON.stringify({ name: "find_by_name", Pattern: "*.ts" }));
const inferredFind = inferLiveActivity({ id: "testtask2" });
check("inferLiveActivity detects finding", inferredFind?.status === "finding");

fs.writeFileSync(path.join(mockRunDir, "testtask3.json"), JSON.stringify({ name: "grep_search", Query: "foobar" }));
const inferredSearch = inferLiveActivity({ id: "testtask3" });
check("inferLiveActivity detects searching", inferredSearch?.status === "searching");

fs.writeFileSync(path.join(mockRunDir, "testtask4.json"), JSON.stringify({ name: "view_file", AbsolutePath: "/a/b/index.ts" }));
const inferredRead = inferLiveActivity({ id: "testtask4" });
check("inferLiveActivity detects reading", inferredRead?.status === "reading");

// computeAgents check
const agents = computeAgents({
  presence: {
    claude: { status: "searching", detail: "searching for auth", ts: Date.now(), pid: process.pid, cwd: process.cwd() },
  },
  tasks: [],
  locks: [],
  notes: [],
});
const claudeAgent = agents.find((a) => a.id === "claude");
check("computeAgents reflects searching status", claudeAgent?.status === "searching");

// getAntigravityActivity check (detects live Antigravity transcripts)
const act = getAntigravityActivity();
check("getAntigravityActivity detects active host transcript", act !== null && ["bashing", "finding", "reading", "searching", "developing", "working"].includes(act.status));

// restart command checks
const restartRes = await restart({});
check("restart() returns success", restartRes.state === "success");

const restartResWipe = await restart({ yes: true });
check("restart({ yes: true }) returns wiped board", restartResWipe.boardSummary?.action === "wiped");

const origLog2 = console.log;
let restartOutput = "";
console.log = (...args) => { restartOutput += args.join(" ") + "\n"; };
printRestart(restartRes);
console.log = origLog2;
check("printRestart outputs summary", restartOutput.includes("restart completed"));

// printUpdate output prompt checks
const origLog = console.log;
let captured = "";
console.log = (...args) => { captured += args.join(" ") + "\n"; };
printUpdate({ state: "success", versionBefore: "0.6.0", versionAfter: "0.6.1" });
console.log = origLog;
check("update prompts for init", captured.includes("init"));
check("update prompts for reset", captured.includes("reset --yes"));
check("update prompts for restart", captured.includes("restart"));

await alice.close();
await bob.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(failures ? `\n${failures} failure(s)\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
