/** End-to-end smoke test: real stdio MCP clients, two agent identities, one board. */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { printUpdate } from "../src/update.js";
import { init, installSkill } from "../src/init.js";
import { deinit } from "../src/deinit.js";
import {
  upsertSkillBlock, stripSkillBlock, hasSkillBlock, skillMarkersBalanced,
  SKILL_MARK_BEGIN, SKILL_MARK_END, SKILL_BODY, MalformedBlockError,
} from "../src/skill.js";
import { editManagedFile } from "../src/fileEdit.js";
import { restart, printRestart } from "../src/restart.js";
import { lockFromCli, unlockFromCli, sendNoteFromCli, readNotesFromCli } from "../src/commands.js";
import { read as readBoard, mutate as mutateBoard, promptPath } from "../src/store.js";
import { pickFailover, BACKENDS_LIST } from "../src/server.js";
import { writeBrainNote, readBrainNote, brainPreview, searchBrain, projectSlug, brainRoot } from "../src/brain.js";
import {
  computeAgents, inferLiveActivity, getAntigravityActivity, getClaudeActivity,
  claudeProjectDir, resetHostScanCache,
} from "../src/ui/bridgeState.js";
import { runUnits } from "./units.js";

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

// --- token frugality: since_seq delta, and stale presence must not ship every call ---
const s1 = await call(alice, "coop_status");
const cached = await call(alice, "coop_status", { since_seq: s1.seq });
check("coop_status returns {unchanged} when the board has not moved", cached.unchanged === true && cached.seq === s1.seq);
await call(alice, "notes_send", { to: "antigravity", body: "seq bump" });
check("coop_status sends the full payload once seq advances",
  !(await call(alice, "coop_status", { since_seq: s1.seq })).unchanged);
await call(bob, "notes_read", {});

await mutateBoard((b) => {
  const stale = Date.now() - 3 * 60 * 60 * 1000; // 3h ago
  b.presence["ghost-idle"] = { status: "idle", detail: "", ts: stale };
  b.presence["ghost-locker"] = { status: "working", detail: "still holds a lock", ts: stale };
  b.locks.push({ path: path.join(SANDBOX, "ghost-held.txt"), owner: "ghost-locker", created: Date.now() });
});
const filtered = await call(alice, "coop_status");
const shown = filtered.presence.map((p) => p.agent);
check("stale idle agent is dropped from the presence payload", !shown.includes("ghost-idle"));
check("stale agent that still holds a lock is kept", shown.includes("ghost-locker"));
check("caller's own presence is always shown", shown.includes("claude"));
check("dropped agents are counted, not silently gone", filtered.stale_agents >= 1, String(filtered.stale_agents));
await mutateBoard((b) => {
  delete b.presence["ghost-idle"];
  delete b.presence["ghost-locker"];
  b.locks = b.locks.filter((l) => l.owner !== "ghost-locker");
});

// --- prune: an abandoned unread note is reaped once it is clearly stale ---
const old = Date.now() - 20 * 24 * 60 * 60 * 1000; // 20 days
await mutateBoard((b) => {
  b.notes.push(
    { id: "pr-unread-old", from: "ghost", to: "nobody-home", body: "ancient unread", created: old, readAt: null },
    { id: "pr-read-old", from: "ghost", to: "nobody-home", body: "ancient read", created: old, readAt: old },
    { id: "pr-unread-new", from: "ghost", to: "nobody-home", body: "recent unread", created: Date.now(), readAt: null }
  );
});
const notesNow = readBoard().notes.map((n) => n.id);
check("prune reaps an unread note past the age cap", !notesNow.includes("pr-unread-old"));
check("prune keeps a recent unread note", notesNow.includes("pr-unread-new"));
check("prune does not age-drop a read note", notesNow.includes("pr-read-old"));
await mutateBoard((b) => { b.notes = b.notes.filter((n) => !String(n.id).startsWith("pr-")); });

// --- briefs are kept OFF the board (so failover can replay them for free) ---
check("task records never carry the brief text",
  readBoard().tasks.every((t) => !("prompt" in t) && !("brief" in t)));
check("brief lives in the runs dir, not the board", promptPath("abc").includes("runs"));

// --- brain tools over the real stdio connection ---
// cwdA/cwdB declared here (not down by the direct-checks block below, closer
// to where projectSlug() is exercised) because these round-trip checks need
// them first in file-execution order.
const cwdA = path.join(SANDBOX, "workspaces", "teamA", "backend");
const cwdB = path.join(SANDBOX, "workspaces", "teamB", "backend");
const slugA = projectSlug(cwdA);
const slugB = projectSlug(cwdB);
const bw1 = await call(alice, "brain_write", { note: "Chose SQLite-free JSON storage for the board.", section: "decision" });
check("brain_write creates a new project file on first write", bw1.created === true, JSON.stringify(bw1));

const br1 = await call(alice, "brain_read", {});
check("brain_read returns the just-written decision", br1.content?.includes("Chose SQLite-free JSON storage"));

const indexContent = fs.readFileSync(path.join(brainRoot(), "MEMORY.md"), "utf8");
check("MEMORY.md indexes the new project", indexContent.includes(`[[${bw1.slug}|`), bw1.slug);

// Append-only: a second write must not clobber the first.
const bw2 = await call(alice, "brain_write", { note: "Log entry: shipped brain_write tool." });
check("second write to the same project does not re-create it", bw2.created === false);
const br2 = await call(alice, "brain_read", {});
check("append-only: original decision survives a second write", br2.content.includes("Chose SQLite-free JSON storage"));
check("append-only: new log line is present", br2.content.includes("shipped brain_write tool"));

// section:"status" behaves differently on purpose: it REPLACES, not appends.
await call(alice, "brain_write", { note: "First status: brain.js written.", section: "status" });
await call(alice, "brain_write", { note: "Second status: server.js wired in.", section: "status" });
const br3 = await call(alice, "brain_read", {});
check("status write replaces the previous status", !br3.content.includes("First status: brain.js written"));
check("status write keeps the latest status", br3.content.includes("Second status: server.js wired in"));
check("replacing status does not touch Key Decisions", br3.content.includes("Chose SQLite-free JSON storage"));
check("replacing status does not touch the Log", br3.content.includes("shipped brain_write tool"));

// coop_status surfaces project_memory once this project has notes, status first.
const statusWithMemory = await call(alice, "coop_status");
check("coop_status surfaces project_memory for a project with notes", Boolean(statusWithMemory.project_memory));
check("project_memory preview includes the current status",
  statusWithMemory.project_memory?.preview?.includes("Second status: server.js wired in"));
check("project_memory shows status before decisions/log",
  statusWithMemory.project_memory?.preview?.indexOf("Second status") <
    statusWithMemory.project_memory?.preview?.indexOf("Chose SQLite-free"));

// brain_search: scoped to one project by default, using the collision-safe-slug
// pair from the direct checks above -- cross-project search must be opt-in.
await call(alice, "brain_write", { note: "note for team A backend", cwd: cwdA });
await call(alice, "brain_write", { note: "note for team B backend", cwd: cwdB });
const readA = await call(alice, "brain_read", { cwd: cwdA });
const readB = await call(alice, "brain_read", { cwd: cwdB });
check("teamA file does not contain teamB's note", !readA.content.includes("team B backend"));
check("teamB file does not contain teamA's note", !readB.content.includes("team A backend"));

// updateIndex() must be additive, never destructive: a naive "treat any read
// failure as ENOENT" bug would reset MEMORY.md to just the newest entry and
// silently wipe every earlier project's line.
const indexAfterThree = fs.readFileSync(path.join(brainRoot(), "MEMORY.md"), "utf8");
check("MEMORY.md keeps every project's entry, not just the newest",
  indexAfterThree.includes(`[[${bw1.slug}|`) && indexAfterThree.includes(`[[${slugA}|`) && indexAfterThree.includes(`[[${slugB}|`));

const scopedToA = await call(alice, "brain_search", { query: "team A backend", cwd: cwdA });
check("brain_search scoped to a project finds only that project",
  scopedToA.hits.length > 0 && scopedToA.hits.every((h) => h.slug === slugA));

const scopedToB = await call(alice, "brain_search", { query: "team A backend", cwd: cwdB });
check("brain_search scoped to a different project does not find a note that lives elsewhere",
  scopedToB.hits.length === 0);

const searchAll = await call(alice, "brain_search", { query: "team A backend", all_projects: true });
check("brain_search with all_projects:true finds the right project across the whole brain",
  searchAll.hits.some((h) => h.slug === slugA));

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

// claim_paths' task_id is caller-supplied and never validated against a real
// task, so a lock I hold directly can carry a task_id that names nothing in
// my own running-task list. Gating release on "this lock has no task_id"
// missed exactly that lock -- it must still be mine to release purely by
// ownership, regardless of what task_id (if any) it happens to carry.
await call(alice, "claim_paths", {
  paths: [path.join(SANDBOX, "alice-stale-taskid.txt")],
  note: "alice's, tagged with a task_id that names no real task",
  task_id: "not-a-real-task-id",
});
await call(alice, "coop_restart", {});
check("coop_restart releases my own lock even when its task_id matches no running task",
  !readBoard().locks.some((l) => l.path.endsWith("alice-stale-taskid.txt")),
  readBoard().locks.map((l) => l.path).join(",") || "none");

// A delegated task's OWNER is a shared worker identity (e.g. "antigravity-agent")
// that every agent delegating to that backend uses -- not unique per delegator.
// coop_restart used to drop every lock/presence entry owned by that shared
// identity just because ONE of my own tasks happened to run on it, even when a
// completely different agent had its own separate task still running there.
await mutateBoard((b) => {
  const now = Date.now();
  // pid: 0 -- coop_restart's kill loop guards on `t.pid && ...`, so a falsy
  // pid short-circuits before ever calling isAlive/killTree. process.pid
  // would be wrong here anyway: it's this TEST SCRIPT's own pid, not the
  // server child process alice/bob actually run as, so coop_restart's
  // "never kill myself" check (comparing against ITS OWN process.pid) would
  // not have recognized it and would have genuinely killTree'd this test.
  b.tasks.push(
    { id: "shared-mine", kind: "delegated", owner: "shared-worker", assignedBy: "claude",
      status: "running", pid: 0, title: "alice's job", cwd: SANDBOX, created: now, updated: now },
    { id: "shared-theirs", kind: "delegated", owner: "shared-worker", assignedBy: "antigravity",
      status: "running", pid: 0, title: "bob's job", cwd: SANDBOX, created: now, updated: now }
  );
  b.locks.push(
    { path: path.join(SANDBOX, "mine.txt"), owner: "shared-worker", taskId: "shared-mine", created: now },
    { path: path.join(SANDBOX, "theirs.txt"), owner: "shared-worker", taskId: "shared-theirs", created: now }
  );
  b.presence["shared-worker"] = { status: "working", detail: "bob's job", ts: now };
});
await call(alice, "coop_restart", {});
const afterShared = readBoard();
check("coop_restart cancels only my own task on a shared worker",
  afterShared.tasks.find((t) => t.id === "shared-mine")?.status === "cancelled");
check("coop_restart leaves another agent's task on the same shared worker running",
  afterShared.tasks.find((t) => t.id === "shared-theirs")?.status === "running");
check("coop_restart releases only my own lock on the shared worker",
  !afterShared.locks.some((l) => l.taskId === "shared-mine"));
check("coop_restart leaves the other agent's lock on the same shared worker",
  afterShared.locks.some((l) => l.taskId === "shared-theirs"));
check("coop_restart does not delete a shared worker's presence while another task still uses it",
  Boolean(afterShared.presence["shared-worker"]));
await mutateBoard((b) => {
  b.tasks = b.tasks.filter((t) => !["shared-mine", "shared-theirs"].includes(t.id));
  b.locks = b.locks.filter((l) => !["shared-mine", "shared-theirs"].includes(l.taskId));
  delete b.presence["shared-worker"];
});

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

// --- brain: durable, cross-project memory ---

// Bug regression pin: writeBrainNote is a real async function using the real
// lock (createLock/acquire), not a nonexistent sync lock -- this simply
// resolving at all is most of the proof.
const truncCwd = path.join(SANDBOX, "workspaces", "trunc-test");
const longNote = "x".repeat(2500);
const wTrunc = await writeBrainNote({ cwd: truncCwd, note: longNote, agent: "test" });
check("writeBrainNote resolves (real async lock)", wTrunc.created === true);
check("writeBrainNote flags truncation on a too-long note", wTrunc.truncated === true);
const rTrunc = readBrainNote({ cwd: truncCwd });
check("long note is capped in storage, not stored in full", rTrunc.content.length < longNote.length);
check("truncation is announced in the stored text, not silently cut", /truncated/i.test(rTrunc.content));

// Collision-safe slugs: two different cwds sharing the same basename must
// never merge into one file -- "backend"/"api"/"web" are extremely common
// repo names across a broad user base. (cwdA/cwdB/slugA/slugB were already
// declared earlier, alongside the brain_write round-trip checks that also
// need them.)
check("same-basename cwds get different slugs", slugA !== slugB, `${slugA} vs ${slugB}`);
check("both slugs still start with the shared basename", slugA.startsWith("backend-") && slugB.startsWith("backend-"));

// An unusually long project directory name must not make the slug's file
// path blow past Windows' ~260-char MAX_PATH -- the base gets capped, the
// hash (from the full untruncated path) still keeps it collision-safe.
const longDirName = "a".repeat(200);
const longCwd = path.join(SANDBOX, "workspaces", longDirName);
const longSlug = projectSlug(longCwd);
check("an unusually long project name produces a short, safe slug", longSlug.length < 60, longSlug.length);
const otherLongCwd = path.join(SANDBOX, "other", longDirName);
check("two long, differently-pathed names with the same basename still get different slugs",
  projectSlug(longCwd) !== projectSlug(otherLongCwd));

// Omitted-field proof for coop_status's project_memory: a cwd with no notes
// yet must produce null (not an empty object), so the server-side spread
// omits the key entirely rather than sending an empty one.
const freshCwd = path.join(SANDBOX, "workspaces", "never-written-to");
check("brainPreview returns null for a project with no notes", brainPreview(freshCwd) === null);

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

// alternatives must actually be OTHER backends, not the one that just
// refused: `tried` holds owner strings, and comparing those against the
// prefix strings BACKENDS_LIST.map(x => x.prefix) produces never matched,
// so the exhausted backend always listed itself as its own alternative.
const onlyOneOwner = BACKENDS_LIST[0].owner;
await mutateBoard((b) => {
  b.limits = { [onlyOneOwner]: { kind: "limit", resets_at: resetsAt, detail: "test" } };
});
const singleBlocked = await call(alice, `${lanes[0]}_delegate`, {
  title: "should not run either", prompt: "x", cwd: process.cwd(), failover: false,
});
check("a refused backend does not list itself as its own alternative",
  Array.isArray(singleBlocked.alternatives) && !singleBlocked.alternatives.includes(BACKENDS_LIST[0].prefix),
  JSON.stringify(singleBlocked.alternatives));
check("alternatives still lists genuinely available backends",
  Array.isArray(singleBlocked.alternatives) && singleBlocked.alternatives.length > 0,
  JSON.stringify(singleBlocked.alternatives));
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

// --- markerBlock: the fiddly text handling that broke real files in review ---
const prior = "# My global rules\r\n\r\nAlways write tests.\r\n"; // CRLF on purpose (win32)
const withBlock = upsertSkillBlock(prior);
check("upsert: user content preserved", withBlock.startsWith("# My global rules") && withBlock.includes("Always write tests."));
check("upsert: exactly one block", withBlock.split(SKILL_MARK_BEGIN).length === 2);
check("upsert: CRLF file gets a CRLF block", withBlock.includes(`${SKILL_MARK_BEGIN}\r\n`));
check("upsert: idempotent", upsertSkillBlock(withBlock) === withBlock);
check("strip: CRLF round-trip is byte-exact", stripSkillBlock(withBlock) === prior);
check("strip: markers balanced after strip", skillMarkersBalanced(stripSkillBlock(withBlock)).ok);

// A torn block (BEGIN, no END) must NOT be "repaired" by appending a second one.
let threw = false;
try { upsertSkillBlock(`intro\n\n${SKILL_MARK_BEGIN}\nhalf\n\n# KEEP THIS LINE\n`); }
catch (e) { threw = e instanceof MalformedBlockError; }
check("upsert: torn block throws MalformedBlockError, does not append", threw);
check("markers: torn block reads as unbalanced", !skillMarkersBalanced(`${SKILL_MARK_BEGIN}\nx\n`).ok);

// Duplicate blocks (copy/paste, a merge) all get reconciled.
const dup = withBlock + "\n\n" + withBlock.slice(withBlock.indexOf(SKILL_MARK_BEGIN));
check("upsert: duplicate blocks collapse to one", upsertSkillBlock(dup).split(SKILL_MARK_BEGIN).length === 2);
check("strip: removes every duplicate block", !hasSkillBlock(stripSkillBlock(dup)));

// Markers inside a fenced code example (someone pasting the README) are left alone.
const fenced = "# Doc\n\n```\n" + SKILL_MARK_BEGIN + "\nexample\n" + SKILL_MARK_END + "\n```\n\nreal text\n";
check("upsert: fenced example is not treated as the block", upsertSkillBlock(fenced).split(SKILL_MARK_BEGIN).length === 3);
check("strip: fenced example survives", stripSkillBlock(upsertSkillBlock(fenced)).includes("```\n" + SKILL_MARK_BEGIN));

// $-patterns in the body stay literal (body is a public parameter).
check("upsert: $& / $1 in body are literal", upsertSkillBlock("", "has $& and $1").includes("has $& and $1"));

// SKILL_BODY drift guard: the tools that matter must be named.
for (const tool of ["coop_status", "claim_paths", "release_paths", "board_update", "notes_send",
  "notes_read", "task_reassign", "<backend>_delegate", "brain_write", "presence_set"]) {
  check(`SKILL_BODY names ${tool}`, SKILL_BODY.includes(tool));
}

// --- installSkill / init / deinit against a synthetic client roster in the sandbox ---
const cRoot = path.join(SANDBOX, "clients");
const mkClient = (id, memName) => {
  const c = {
    id, label: `Client ${id}`,
    file: path.join(cRoot, id, "mcp.json"),
    key: "mcpServers", shape: "standard",
    memoryFile: path.join(cRoot, memName),
    presenceDir: path.join(cRoot, id),
  };
  fs.mkdirSync(path.dirname(c.file), { recursive: true });
  return c;
};
const CL = [mkClient("x", "x/RULES.md"), mkClient("y", "shared/CTX.md"), mkClient("z", "shared/CTX.md")];
fs.mkdirSync(path.join(cRoot, "shared"), { recursive: true });
fs.writeFileSync(CL[0].memoryFile, "# x rules\n\ntabs not spaces\n"); // pre-existing user file

// dry run writes nothing
const preState = fs.readFileSync(CL[0].memoryFile, "utf8");
const dry = await installSkill({ dryRun: true, clients: CL });
check("installSkill dry-run writes nothing", fs.readFileSync(CL[0].memoryFile, "utf8") === preState);
check("installSkill dry-run dedupes the shared file", dry.results.length === 2);
check("installSkill dry-run: no status is 'error'", dry.results.every((r) => r.status !== "error"),
  dry.results.map((r) => r.status).join(","));

// real install
const ins = await installSkill({ clients: CL });
check("installSkill: pre-existing file gets 'added'", ins.results.find((r) => r.file === CL[0].memoryFile).status === "added");
check("installSkill: new shared file gets 'created'", ins.results.find((r) => r.file === CL[1].memoryFile).status === "created");
check("installSkill: user content survives", fs.readFileSync(CL[0].memoryFile, "utf8").includes("tabs not spaces"));
check("installSkill: shared file maps to both clients", ins.results.find((r) => r.file === CL[1].memoryFile).clients.length === 2);
check("installSkill: second run all unchanged", (await installSkill({ clients: CL })).results.every((r) => r.status === "unchanged"));
check("installSkill: pristine backup kept", fs.readFileSync(CL[0].memoryFile + ".bak-antigravity-mcp", "utf8") === "# x rules\n\ntabs not spaces\n");

// a malformed file is reported and left untouched
fs.writeFileSync(CL[0].memoryFile, `# x rules\n\n${SKILL_MARK_BEGIN}\ntorn\n\n# DO NOT LOSE THIS\n`);
const mal = await installSkill({ clients: CL });
check("installSkill: malformed file -> error", mal.results.find((r) => r.file === CL[0].memoryFile).status === "error");
check("installSkill: malformed file untouched", fs.readFileSync(CL[0].memoryFile, "utf8").includes("# DO NOT LOSE THIS"));
fs.writeFileSync(CL[0].memoryFile, "# x rules\n\ntabs not spaces\n");
await installSkill({ clients: CL });

// deinit --skill-only: block removed, file kept, content kept
const dss = await deinit({ skillOnly: true, clients: CL });
check("deinit skill-only: block removed", !hasSkillBlock(fs.readFileSync(CL[0].memoryFile, "utf8")));
check("deinit skill-only: user content kept", fs.readFileSync(CL[0].memoryFile, "utf8").includes("tabs not spaces"));
check("deinit skill-only: file we created is NOT deleted", fs.existsSync(CL[1].memoryFile));
check("deinit skill-only: leaves MCP config alone", dss.results.length === 0);

// deinit must not CREATE files that were never there
const missingAgy = path.join(SANDBOX, "never-existed-agy.json");
await deinit({ clients: [], agySettings: missingAgy });
check("deinit does not create a missing agy settings file", !fs.existsSync(missingAgy));

// full init -> deinit round trip on configs (sandboxed agy settings — never the real one)
const sandboxAgy = path.join(SANDBOX, "agy-settings.json");
await init({ clients: CL, skill: false, agySettings: sandboxAgy });
check("init: client x registered", JSON.parse(fs.readFileSync(CL[0].file, "utf8")).mcpServers?.antigravity !== undefined);
const de = await deinit({ clients: CL, agySettings: sandboxAgy });
check("deinit: client x unregistered", JSON.parse(fs.readFileSync(CL[0].file, "utf8")).mcpServers?.antigravity === undefined);
check("deinit: reports success (no errors)", !de.results.some((r) => r.status === "error") && !de.skill.results.some((r) => r.status === "error"));

// concurrency: two edits on one file must both land (the lock serializes them)
const raceFile = path.join(cRoot, "race.md");
fs.writeFileSync(raceFile, "start\n");
const settled = await Promise.allSettled([
  editManagedFile(raceFile, (t) => (t ?? "") + "A\n"),
  editManagedFile(raceFile, (t) => (t ?? "") + "B\n"),
]);
check("editManagedFile: concurrent edits both resolve", settled.every((s) => s.status === "fulfilled"));
const raced = fs.readFileSync(raceFile, "utf8");
check("editManagedFile: no lost update under contention", raced.includes("A") && raced.includes("B"), JSON.stringify(raced));

// The real-world scenario the cross-process lock exists for: several separate
// `init` PROCESSES writing the same CLAUDE.md at once (two editor windows, an
// init while a `restart --init` runs). In-process promise contention above
// can't prove the on-disk lock; only real child processes can.
const raceHome = path.join(SANDBOX, "race-home");
fs.mkdirSync(path.join(raceHome, ".claude"), { recursive: true });
fs.writeFileSync(path.join(raceHome, ".claude.json"), "{}\n");
const raceBody = "# rules\n\n" + Array.from({ length: 150 }, (_, i) => `- rule ${i}`).join("\n") + "\n";
fs.writeFileSync(path.join(raceHome, ".claude", "CLAUDE.md"), raceBody);
const raceEnv = { ...process.env, USERPROFILE: raceHome, HOME: raceHome, ANTIGRAVITY_MCP_HOME: path.join(SANDBOX, "race-board") };
const { spawn: spawnProc } = await import("node:child_process");
const codes = await Promise.all(
  Array.from({ length: 3 }, () => new Promise((res) => {
    const c = spawnProc(process.execPath, [CLI, "init", "--only", "claude-code"], { env: raceEnv, stdio: "ignore" });
    c.on("exit", (code) => res(code));
  }))
);
const raceMd = fs.readFileSync(path.join(raceHome, ".claude", "CLAUDE.md"), "utf8");
check("concurrent init processes all exit 0", codes.every((c) => c === 0), codes.join(","));
check("concurrent init: user's 150 rules survive intact", raceMd.includes("- rule 0") && raceMd.includes("- rule 149"));
check("concurrent init: exactly one managed block (no interleaved write)",
  (raceMd.match(new RegExp(SKILL_MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length === 1);
check("concurrent init: block is well-formed", raceMd.includes(SKILL_MARK_END) && raceMd.indexOf(SKILL_MARK_BEGIN) < raceMd.indexOf(SKILL_MARK_END));
check("concurrent init: no lock dir or tmp files left behind",
  !fs.existsSync(path.join(raceHome, ".claude", "CLAUDE.md.antigravity-lock")) &&
  !fs.readdirSync(path.join(raceHome, ".claude")).some((f) => f.includes(".tmp")));
check("concurrent init: .claude.json still valid with one server entry",
  Object.keys(JSON.parse(fs.readFileSync(path.join(raceHome, ".claude.json"), "utf8")).mcpServers || {}).length === 1);

await runUnits(check, { alice, bob, call, sandbox: SANDBOX });

await alice.close();
await bob.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(failures ? `\n${failures} failure(s)\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
