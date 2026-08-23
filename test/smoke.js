/** End-to-end smoke test: real stdio MCP clients, two agent identities, one board. */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { printUpdate } from "../src/update.js";
import { restart, printRestart } from "../src/restart.js";
import { lockFromCli, unlockFromCli, sendNoteFromCli, readNotesFromCli } from "../src/commands.js";
import { read as readBoard, mutate as mutateBoard } from "../src/store.js";
import { pickFailover, BACKENDS_LIST } from "../src/server.js";
import {
  computeAgents, inferLiveActivity, getAntigravityActivity, getClaudeActivity,
  claudeProjectDir, resetHostScanCache,
} from "../src/ui/bridgeState.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const SANDBOX = path.join(os.tmpdir(), "antigravity-mcp-test");
// Both of these must point into the sandbox before anything reads them.
// ANTIGRAVITY_MCP_HOST_HOME in particular: without it, host-activity detection
// reads the developer's REAL ~/.claude and ~/.gemini, and the assertions below
// come out different depending on what they happen to be running at the time.
const HOST_HOME = path.join(SANDBOX, "host-home");
process.env.ANTIGRAVITY_MCP_HOME = SANDBOX;
process.env.ANTIGRAVITY_MCP_HOST_HOME = HOST_HOME;
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
      env: { ...process.env, ANTIGRAVITY_MCP_HOME: SANDBOX, ANTIGRAVITY_MCP_HOST_HOME: HOST_HOME },
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

// coop_restart is scoped to the calling agent: bob's lock and presence must
// survive alice restarting herself.
await call(bob, "claim_paths", { paths: [path.join(SANDBOX, "bob-only.txt")], note: "bob's" });
await call(bob, "presence_set", { status: "working", detail: "bob is busy" });
await call(alice, "claim_paths", { paths: [path.join(SANDBOX, "alice-only.txt")], note: "alice's" });

const restartToolRes = await call(alice, "coop_restart", {});
check("coop_restart works", restartToolRes.restarted === true);

// Assert against the lock list itself, not a substring of the whole status
// payload -- that also carries the event log, which mentions both paths.
const locksAfterRestart = readBoard().locks.map((l) => l.path);
check("coop_restart releases the caller's locks", !locksAfterRestart.some((p) => p.endsWith("alice-only.txt")),
  locksAfterRestart.join(",") || "none");
check("coop_restart leaves other agents' locks alone", locksAfterRestart.some((p) => p.endsWith("bob-only.txt")));
check("coop_restart leaves other agents' presence alone",
  Boolean(readBoard().presence["antigravity"]));

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

// The vocabulary is closed on purpose -- the UI renders per-status sprites,
// and a free-text field just fills the board with unrenderable near-misses.
const badStatus = await alice.callTool({ name: "presence_set", arguments: { status: "Working On Stuff" } });
check("presence_set rejects an unknown status", badStatus.isError === true);

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

// Delegated Copilot/Cursor tasks must show real activity too, and must not
// depend on any guessed project cwd the way the old getClaudeActivity did --
// inferLiveActivity reads only runsDir(), this server's own state dir, so it
// can never be affected by which directory the office UI happens to be
// running from. Proven here by asserting it against a cwd that matches
// nothing real on the machine.
for (const [ownerId, taskFile] of [["copilot-agent", "copilot-task"], ["cursor-agent", "cursor-task"]]) {
  fs.writeFileSync(path.join(mockRunDir, `${taskFile}.json`), JSON.stringify({ name: "grep_search", Query: "handleSubmit" }));
  const board = {
    presence: {},
    tasks: [{
      id: taskFile, kind: "delegated", owner: ownerId, status: "running", pid: process.pid,
      title: "wire up the form", created: Date.now(), updated: Date.now(),
    }],
    locks: [], notes: [], events: [],
  };
  const row = computeAgents(board).find((a) => a.id === ownerId);
  check(`delegated ${ownerId} task shows real activity, not idle`, row?.status === "searching", row?.status);
}

// Host-transcript detection, against fixtures under the sandboxed host home
// rather than whatever the developer's real ~/.gemini and ~/.claude contain.
const agyTranscript = path.join(
  HOST_HOME, ".gemini", "antigravity-cli", "brain", "conv-1", ".system_generated", "logs", "transcript.jsonl"
);
fs.mkdirSync(path.dirname(agyTranscript), { recursive: true });
fs.writeFileSync(
  agyTranscript,
  JSON.stringify({ tool_calls: [{ name: "grep_search", args: { Query: "useAuth" } }] }) + "\n"
);
resetHostScanCache();
const act = getAntigravityActivity();
check("getAntigravityActivity reads the newest transcript", act?.status === "searching", act?.detail || "null");

// getClaudeActivity() is deliberately unscoped -- see its doc comment. The
// office UI is a long-running background server with no reliable way to know
// which project the viewer currently cares about, and a scoped version that
// guesses wrong silently shows Claude as idle while it's actively working
// (a bug this project shipped once already). So: any session, anywhere,
// freshest wins -- same policy as getAntigravityActivity() -- verified here
// by writing the session into a directory that looks nothing like the
// "current" project.
//
// Fixture lines use Claude Code's REAL transcript shape (message.content[]
// with a tool_use block), sampled directly from live session files on this
// machine while building this -- not guessed. getClaudeActivity() used to
// regex-match "tool_use...name":"Bash" against the raw byte tail and return
// one of five hardcoded strings ("Running terminal command") regardless of
// what actually ran; these checks are here specifically to pin the
// regression -- the detail must name the real command, file, or query.
const claudeDir = claudeProjectDir(path.join(SANDBOX, "some-other-project-entirely"));
fs.mkdirSync(claudeDir, { recursive: true });
const claudeSession = path.join(claudeDir, "session.jsonl");
const claudeLine = (content) => JSON.stringify({ message: { role: "assistant", content: [content] } }) + "\n";

fs.writeFileSync(
  claudeSession,
  claudeLine({ type: "tool_use", name: "Bash", input: { command: "npm test", description: "Run the test suite" } })
);
resetHostScanCache();
const claudeBash = getClaudeActivity();
check("getClaudeActivity finds a session regardless of project", claudeBash?.status === "bashing", claudeBash?.status);
check("getClaudeActivity surfaces the actual command description, not a canned string",
  claudeBash?.detail === "Run the test suite", claudeBash?.detail);

fs.appendFileSync(claudeSession, claudeLine({ type: "tool_use", name: "Read", input: { file_path: "C:\\proj\\src\\auth.ts" } }));
resetHostScanCache();
const claudeRead = getClaudeActivity();
check("getClaudeActivity names the actual file being read", claudeRead?.detail === "Reading: auth.ts", claudeRead?.detail);

fs.appendFileSync(claudeSession, claudeLine({ type: "tool_use", name: "Grep", input: { pattern: "handleSubmit" } }));
resetHostScanCache();
const claudeGrep = getClaudeActivity();
check("getClaudeActivity names the actual search pattern", claudeGrep?.detail === "Searching: handleSubmit", claudeGrep?.detail);

fs.appendFileSync(claudeSession, claudeLine({ type: "text", text: "Let me think about this differently." }));
resetHostScanCache();
const claudeThinking = getClaudeActivity();
check("getClaudeActivity reads text-only turns as active, not idle",
  claudeThinking?.status === "working" && claudeThinking?.detail === "Thinking & responding", claudeThinking?.detail);

// computeAgents check: a status the agent reported itself outranks anything
// inferred from a transcript.
const board = {
  presence: {
    claude: { status: "blocked", detail: "waiting on an API key", ts: Date.now(), pid: process.pid, cwd: process.cwd() },
  },
  tasks: [],
  locks: [],
  notes: [],
  events: [],
};
const claudeAgent = computeAgents(board).find((a) => a.id === "claude");
check("presence_set status wins over inferred activity", claudeAgent?.status === "blocked", claudeAgent?.status);

// Overwrite (not append) so this doesn't depend on whatever the earlier
// getClaudeActivity() checks left as the file's last line.
fs.writeFileSync(claudeSession, claudeLine({ type: "tool_use", name: "Bash", input: { description: "Run the test suite" } }));
resetHostScanCache();
board.presence.claude.status = "idle";
board.presence.claude.detail = "";
const inferredAgent = computeAgents(board).find((a) => a.id === "claude");
check("idle presence falls back to inferred activity", inferredAgent?.status === "bashing", inferredAgent?.status);

// --- failover: a limited backend must hand its work to one that can take it ---
const prefixes = BACKENDS_LIST.map((b) => b.prefix);
check("more than one backend installed (failover is testable)", prefixes.length > 1, prefixes.join(","));

const allOwners = BACKENDS_LIST.map((b) => b.owner);
const emptyBoard = { tasks: [], locks: [], notes: [], events: [], presence: {}, limits: {} };
const firstPick = pickFailover(emptyBoard, []);
check("pickFailover finds an available backend", Boolean(firstPick), firstPick?.prefix);
check("pickFailover prefers a verified lane", firstPick?.verified === true, String(firstPick?.verified));

// Exclude the one it picked: it must move on rather than repeat itself.
const secondPick = pickFailover(emptyBoard, [firstPick.owner]);
check("pickFailover skips what was already tried", secondPick && secondPick.owner !== firstPick.owner,
  secondPick?.prefix || "none");

// A backend marked limited on the board is not a candidate.
const limitedBoard = {
  ...emptyBoard,
  limits: { [firstPick.owner]: { kind: "limit", resets_at: new Date(Date.now() + 3600_000).toISOString() } },
};
check("pickFailover skips a limited backend", pickFailover(limitedBoard, [])?.owner !== firstPick.owner);

// Everything limited -> nothing to fail over to, and it must say so rather than guess.
const allLimited = { ...emptyBoard, limits: {} };
for (const o of allOwners) allLimited.limits[o] = { kind: "limit", resets_at: new Date(Date.now() + 3600_000).toISOString() };
check("pickFailover returns null when every backend is limited", pickFailover(allLimited, []) === null);

// An expired limit is not a limit any more.
const expired = { ...emptyBoard, limits: {} };
for (const o of allOwners) expired.limits[o] = { kind: "limit", resets_at: new Date(Date.now() - 1000).toISOString() };
check("pickFailover ignores an expired limit", Boolean(pickFailover(expired, [])));

// With every backend limited there is nowhere to reroute to, so a delegate must
// refuse -- WITHOUT spawning anything -- and say when it can be retried.
const resetsAt = new Date(Date.now() + 3600_000).toISOString();
await mutateBoard((b) => {
  b.limits = {};
  for (const o of allOwners) b.limits[o] = { kind: "limit", resets_at: resetsAt, detail: "test" };
});
const blocked = await call(alice, `${lanes[0]}_delegate`, {
  title: "should not run",
  prompt: "this must never reach a CLI",
  cwd: process.cwd(),
});
check("delegate refuses when every backend is limited", Boolean(blocked.error), blocked.error || "no error");
check("refusal says when to retry", Boolean(blocked.resets_in), blocked.resets_in || "none");
check("refusal did not create a task", !readBoard().tasks.some((t) => t.title === "should not run"));
await mutateBoard((b) => { b.limits = {}; });

// --- the office UI must never draw an active agent as idle ---
const busyCases = [
  ["holding a lock", { locks: [{ owner: "worker", path: "/p/a.ts", created: Date.now() }] }],
  ["a recent board event", { events: [{ agent: "worker", kind: "paths.check", detail: "a.ts", ts: Date.now() }] }],
  ["an unmapped event kind", { events: [{ agent: "worker", kind: "something.new", detail: "x", ts: Date.now() }] }],
];
for (const [what, extra] of busyCases) {
  const b = {
    presence: { worker: { status: "idle", detail: "", ts: Date.now(), pid: process.pid } },
    tasks: [], locks: [], notes: [], events: [], ...extra,
  };
  const row = computeAgents(b).find((a) => a.id === "worker");
  check(`not idle while ${what}`, row?.status !== "idle", row?.status);
}

// A delegator whose work is running elsewhere reads as handing off, not idle.
const handoffBoard = {
  presence: {
    boss: { status: "idle", detail: "", ts: Date.now(), pid: process.pid },
    "claude-agent": { status: "idle", detail: "", ts: Date.now(), pid: process.pid },
  },
  tasks: [{
    id: "t1", title: "build the form", kind: "delegated", owner: "claude-agent",
    assignedBy: "boss", status: "running", pid: process.pid, created: Date.now(), updated: Date.now(),
  }],
  locks: [], notes: [], events: [],
};
const boss = computeAgents(handoffBoard).find((a) => a.id === "boss");
check("delegator shows as delegating, not idle", boss?.status === "delegating", boss?.status);
check("delegator names who it handed off to", /claude/i.test(boss?.task || ""), boss?.task || "");

// restart command checks. killProcesses is off: the real thing hunts down and
// kills the pid on the UI port, which is not something a test run should do to
// the machine it happens to be running on.
const restartRes = await restart({ killProcesses: false });
check("restart() returns success", restartRes.state === "success");

const restartResWipe = await restart({ yes: true, killProcesses: false });
check("restart({ yes: true }) returns wiped board", restartResWipe.boardSummary?.action === "wiped");

const origLog2 = console.log;
let restartOutput = "";
console.log = (...args) => { restartOutput += args.join(" ") + "\n"; };
printRestart(restartRes);
console.log = origLog2;
check("printRestart outputs summary", restartOutput.includes("restart completed"));

// CLI command layer. These print, so run them with console.log muted.
const quiet = async (fn) => {
  const orig = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = orig;
  }
};

const lockA = path.join(SANDBOX, "cli-a.txt");
const lockB = path.join(SANDBOX, "cli-b.txt");
await quiet(() => lockFromCli([lockA, lockB], { owner: "cli-x" }));
await quiet(() => unlockFromCli({ path: lockA, owner: "cli-x" }));
const heldPaths = readBoard().locks.map((l) => l.path);
check("unlock <path> --owner releases only that path", heldPaths.some((p) => p.endsWith("cli-b.txt")),
  heldPaths.join(",") || "none left");
check("unlock <path> --owner released the named path", !heldPaths.some((p) => p.endsWith("cli-a.txt")));
check("unlock with neither path nor --all is rejected", (await quiet(() => unlockFromCli({}))) === 1);
await quiet(() => unlockFromCli({ all: true }));

await quiet(() => sendNoteFromCli("all", "cli note body"));
await quiet(() => readNotesFromCli({ markRead: false }));
check("reading without --mark-read leaves notes unread", readBoard().notes.every((n) => !n.readAt));
await quiet(() => readNotesFromCli({ markRead: true }));
check("--mark-read actually marks notes read", readBoard().notes.every((n) => n.readAt));

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
