<div align="center">

# antigravity-mcp-server

**Let multiple AI agents build your app at the same time — without stepping on each other.**

Hand work to Antigravity, GitHub Copilot, or another Claude, keep working yourself, and none of you break each other's files.

[![npm](https://img.shields.io/npm/v/antigravity-mcp-server.svg)](https://www.npmjs.com/package/antigravity-mcp-server)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue.svg)](https://modelcontextprotocol.io)

</div>

---

## The problem

Running two AI coding agents on one project sounds like a superpower—right up until they both blindly edit the same file, quietly overwrite each other's work, and gaslight you about who broke the build. 

They can't see each other. That's the whole issue.

## The fix

One small server every agent plugs into. It acts as their shared brain, tracking who is doing what and which files are claimed. It gives your primary agent the ability to spin up Antigravity, Copilot, or another Claude instance to do its chores in the background, all while you keep coding together in your main window.

```
   Your AI agent                            Antigravity        Copilot
   Claude Code · Cursor · Windsurf           (agy CLI)        (copilot CLI)
   VS Code · Gemini CLI · OpenCode
          │                                       │                │
          │  MCP                              MCP │            MCP │
          └──────────────┐         ┌──────────────┘   ┌────────────┘
                         ▼         ▼                  ▼
              ┌─────────────────────────────────┐
              │     antigravity-mcp-server      │
              │                                 │
              │ board.json                      │
              │  ├─ tasks ..... who does what   │
              │  ├─ locks ..... files taken     │
              │  ├─ notes ..... messages        │
              │  └─ presence .. who is online   │
              └─────────────────────────────────┘
                              │
                              └──► starts agy / copilot in the background
```

---

## Install in seconds

It takes just two commands to get going:

```bash
npm install -g antigravity-mcp-server
antigravity-mcp-server init
```

`init` does the heavy lifting for you: it finds every AI tool on your computer and automatically wires them up to the shared board. Just restart your AI tools, and you're ready to go!

---

## Two things you need, and neither is "all of them"

**A host.** This is whichever AI coding tool you actually type into day to day — Claude Code, Cursor, Windsurf, Gemini CLI, Claude Desktop, VS Code with Copilot, OpenCode, or even the Antigravity or Copilot CLIs themselves. You need at least one of these already installed; that's what `init` is looking for when it says it "finds every AI tool on your computer." No host, nothing to plug into.

**Delegation backends.** This is who your host can actually hand work *off* to: Antigravity's `agy`, the GitHub `copilot` CLI, or another Claude Code CLI. You do **not** need all three — any combination works, including just one:

- Only Copilot CLI and Antigravity installed, no separate Claude CLI? Fine — `ag_delegate` and `copilot_delegate` both work. `claude_delegate` just isn't available until you add another Claude Code CLI.
- Only a second Claude Code CLI and Antigravity, no Copilot? Same idea — you get `ag_delegate` and `claude_delegate`, minus the Copilot one.
- None installed yet? You still get the shared board — presence, locks, notes — your agent just can't delegate anywhere until you add a backend.

**When to run `init`:** right after you install this package, and again any time your setup changes — a new host editor, or a new delegation backend CLI you didn't have before. It's safe to run as often as you like: it only touches tools it actually finds on your machine, and it backs up anything it edits first.

---

## 💡 How you use it: Just talk to your agent

**You will never need to read the technical tables or learn any new commands.** 

You simply talk to your agent normally: *"Hey, have Antigravity build X while you do Y."* 

Your agent figures out which tools to call, writes a meticulous brief, politely locks its own files so nobody steps on its toes, fires up the delegated agent in the background, and **keeps working with you**. Nobody is stuck twiddling their thumbs.

---

## Here's what a normal day looks like

This tool lets you stay in the flow by parallelizing your work. Here is how it makes your life easier:

**Work on the backend while another agent builds the UI.**
Instead of waiting for one agent to finish before starting the next task, split the work.
> *"Have Antigravity build out the responsive CSS for the header. You stay here and wire up the auth middleware."*

**Never context-switch to write tests again.**
You can keep your momentum on feature work and let Copilot handle the tedious parts in the background.
> *"I need comprehensive unit tests for `store.js`. Delegate that to Copilot, and let me know when it's done."*

**Follow up without repeating yourself.**
Because the delegated agents keep conversation context, you don't have to write a fresh prompt if something needs tweaking.
> *"Tell Antigravity to make those buttons we just added actually click properly."*

**Always know what's happening.**
If you're curious about a background task, just ask your agent instead of digging through logs.
> *"What's agy up to right now? Check its status."*

**Tackle massive tasks with a team of agents.**
You can delegate anything—not just UI work. Let another agent handle docs, refactors, or backend chores.
> *"Spin up another Claude instance to document all the public methods in the `/api` folder."*
> *"This controller is a mess. Have Antigravity refactor it to use the new service pattern while you and I look at the database migrations."*

**Avoid editing the same files.**
The shared board automatically prevents collisions. If you change a core file, you can easily tell the other agent what changed so it adapts.
> *"We're changing the user schema. Leave a note for the other agent telling it that `id` is now a string."*

---

## Watch it happen — the office UI

Want to see your agents actually working? Open the live dashboard:

```bash
antigravity-mcp-server ui
```

This opens a retro pixel-art office at `http://localhost:49321`. You get a little digital floorplan with one desk per agent identity. You can literally watch them work: their live status, their current task, and who's bossing who around, all driven by the live board.

---

## Why the shared board matters

### 1. File locks prevent broken builds
Before an agent edits a folder, it claims it. If an agent tries to take a claimed file, it gets a clear conflict back. No silent overwrites, no broken builds.

```
  my-app/
  ├── api/           [locked] your agent    ← Antigravity is told "taken"
  ├── db.ts          [locked] your agent
  ├── components/    [locked] Antigravity   ← your agent stays away
  └── styles/        [locked] Antigravity
```

### 2. Notes keep everyone aligned
When two agents are building against a shared interface that doesn't exist yet, they can pass messages to each other:
> *"POST /api/orders is ready. It returns `{ id, status }`. Hook the form to it."*

### 3. Presence avoids clashes
Each agent checks what the other is doing before it starts, so it always picks work that fits into the bigger picture.

### 4. Agents look out for each other
A finished task releases its own locks automatically — nobody has to remember to clean up after themselves. And if one ever slips through anyway, the next agent to check in sees it immediately: locks tied to work that's already over are called out by name, so it gets fixed instead of silently getting in the way.

---

## Under the hood

*The sections below are for developers and the incurably curious. You do not need to read any of this to use the tool!*

### The tools reference

Your agent picks these on its own using MCP. 

| Group | Tools |
|---|---|
| **Hand off to Antigravity** | `ag_delegate` · `ag_task_status` · `ag_task_wait` · `ag_followup` · `ag_cancel` |
| **Hand off to Copilot** | `copilot_delegate` · `copilot_task_status` · `copilot_task_wait` · `copilot_followup` · `copilot_cancel` |
| **Hand off to another Claude** | `claude_delegate` · `claude_task_status` · `claude_task_wait` · `claude_followup` · `claude_cancel` |
| **Shared board** | `coop_status` · `board_post` · `board_update` · `board_list` |
| **File locks** | `claim_paths` · `release_paths` · `check_paths` |
| **Talking** | `notes_send` · `notes_read` · `presence_set` · `activity` |
| **Admin** | `coop_reset` |

The three delegation lanes are symmetric — same shape, same behavior — so your agent picks whichever CLI you named. `claude_delegate` launches a fully independent `claude` CLI process, not a subagent inside the calling session — and because it's a plain `claude` invocation, it automatically inherits whatever MCP servers are registered at user scope, this one included, so a delegated Claude can call `coop_status` / `claim_paths` on itself with no extra setup.

Two worth knowing about:
- **`coop_status`** — one call answers everything: who's online, what's running, what's locked, what's unread. It also reaps every running task's real status first, and any lock still standing for a task that's already over is flagged `orphaned` with the reason why -- a finished task releases its own locks automatically, so a flag here means something slipped through (an old lock claimed without a task_id, say), not routine cleanup.
- **`ag_followup` / `copilot_followup` / `claude_followup`** — carries on the *same* conversation. 

### How it works inside

#### Files on disk

```
~/.antigravity-mcp/
├── board.json                    shared state, written under a lock
└── runs/
    ├── <task_id>.json            agy's raw result
    ├── <task_id>.prompt.txt      the brief that was sent
    └── <task_id>.err             stderr, if the run failed
```

`board.json` holds `tasks`, `locks`, `notes`, `events`, and `presence`. Every write takes an exclusive lock (an atomically created directory — the one primitive that behaves the same on Windows and POSIX), then lands via write-temp-and-rename, so a crash can't leave a half-written board. Stale locks older than 20s are broken automatically.

There's no SQLite. A native build would break `npx` on machines without a compiler, and `node:sqlite` is still experimental and Node 22+. The board takes a handful of small writes per minute, so a JSON file is the right size of tool.

#### Delegation

`ag_delegate` shells out to:
```bash
agy --print <brief> --output-format json --print-timeout <n>s \
    --add-dir <cwd> --mode accept-edits --dangerously-skip-permissions
```

`copilot_delegate` shells out to:
```bash
copilot -p <brief> --output-format json --add-dir <cwd> --allow-all-tools
```

`claude_delegate` shells out to:
```bash
claude <brief> --print --output-format json --add-dir <cwd> --dangerously-skip-permissions
```

All three children are spawned **detached**, with output redirected straight to `runs/<task_id>.json`. That means a long job survives the MCP server being restarted — status is recovered by reading the run file and checking the PID, not by holding a child handle. agy and claude each emit one JSON object; copilot emits JSONL (one event per line, terminated by a `type: "result"` line) — all three get normalised to the same `{status, response, conversation_id, usage}` shape before landing on the board, so the rest of the server doesn't care which backend produced them.

`ag_followup` reuses agy's `conversation_id` via `--conversation`; `copilot_followup` reuses Copilot's session id via `--resume`; `claude_followup` does the same via `claude`'s own `--resume`. Context carries across calls. Note: copilot and claude have no session-level timeout flag (`agy`'s `--print-timeout` has no equivalent on either) — a hung job just stays "running" until it exits on its own or the matching `*_cancel` kills it.

#### Path locks
Paths are normalised with `path.resolve` and case-folded on Windows, so `C:\Proj` and `c:\proj` can't defeat the same lock. Overlap is checked in both directions — claiming `api/routes.ts` conflicts with a held `api/`, and claiming `api/` conflicts with a held `api/routes.ts`.

#### Agent identity
Each side runs the same binary with a different `--agent <id>`. That id is what every board entry is attributed to. Two clients sharing one id makes their locks invisible to each other, which defeats the whole point.

### Config generation

`init` only touches tools it finds, and backs up any file it edits to `<file>.bak-antigravity-mcp`.

| Tool | Config path | Key |
|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json`<br>`~/Library/Application Support/Claude/…` | `mcpServers` |
| VS Code (Copilot) | `%APPDATA%/Code/User/mcp.json` | `servers` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp` |
| Antigravity CLI | `~/.gemini/config/mcp_config.json` | `mcpServers` |
| Antigravity IDE | `~/.gemini/antigravity-ide/mcp_config.json` | `mcpServers` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `mcpServers` |

You can also run these variations:
```bash
antigravity-mcp-server init --dry-run   # show changes, write nothing
antigravity-mcp-server init --all       # also write configs for tools you haven't installed
antigravity-mcp-server init --only claude-code,cursor
antigravity-mcp-server init --global    # force the direct-command form
antigravity-mcp-server init --npx       # force npx, even with a global install present
```

A global install is worth the extra step over `npx`: your editor spawns this server on every session, and `npx` re-checks the registry on each launch and can silently pull a newer version mid-session — which matters here, since both agents need to speak the same board schema. A global install starts instantly and only changes version when you run `npm update -g` yourself. `init` detects a global install automatically and writes the direct command into every config; it only falls back to `npx` if it can't find one. No install (`npx antigravity-mcp-server init`) is fine if you just want to try it once.

### Good to know

**Long jobs are safe.** Both backends run detached. If your editor or the server restarts, the job keeps going.

**Delegated agents edit without asking.** `ag_delegate` passes `--dangerously-skip-permissions`; `copilot_delegate` passes `--allow-all-tools` (the documented minimum Copilot needs to write files in non-interactive mode). Pass `auto_approve: false` on either to make it stop at prompts instead.

**One trap `init` handles for you, for agy.** In headless mode `agy` auto-denies every MCP call unless allow-listed in `~/.gemini/antigravity-cli/settings.json`. If that rule is missing, delegation still runs but coordination silently does nothing — the worst kind of failure, because it looks like it works. `init` adds `mcp(coop/*)`; `doctor` checks for it. Copilot has no equivalent trap: it was verified working with a plain `copilot mcp add --transport http` and no extra permission rule.

**Both work in their own scratch project** unless the target directory is in their workspace. Every hand-off passes `--add-dir <cwd>` and states the project root in the brief.

**You need:** Node 18.17 or newer, and at least one delegation target (`agy`, `copilot`, or `claude`). You get the shared board either way — a missing CLI just means you can't hand work to that one.

```bash
antigravity-mcp-server doctor           # is everything working?
antigravity-mcp-server doctor --probe   # same, plus a real round trip through agy
antigravity-mcp-server update           # forgot the npm command? this finds your global install and updates it
```

`update` figures out how you're running this and does the right thing: a real global install gets `npm install -g` to the latest version (with live output, so you can watch it happen); running via `npx` already re-fetches latest on every launch, so it just tells you there's nothing to do; running from a git checkout (like this one) tells you to `git pull` instead, since there's no package to update.

### Settings

| | |
|---|---|
| `AGY_BIN` | Path to the `agy` binary |
| `COPILOT_BIN` | Path to the `copilot` binary |
| `CLAUDE_BIN` | Path to the `claude` binary |
| `ANTIGRAVITY_MCP_HOME` | Board location (default `~/.antigravity-mcp`) |
| `--agent <id>` | The name this instance uses on the board |

### Setting it up by hand

With a global install (`npm install -g antigravity-mcp-server`), add this to your tool's MCP config:

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "antigravity-mcp-server",
      "args": ["--agent", "claude-code"]
    }
  }
}
```

Without a global install, use `npx` instead:

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "npx",
      "args": ["-y", "antigravity-mcp-server", "--agent", "claude-code"]
    }
  }
}
```

On the Antigravity side, name the server `coop`, use `--agent antigravity`, and add this to `~/.gemini/antigravity-cli/settings.json`:

```json
{ "permissions": { "allow": ["mcp(coop/*)"] } }
```

The server key must match the allow-rule — `coop` here, `mcp(coop/*)` there.

### Working on the code

```bash
git clone https://github.com/adeelali4/antigravity-mcp
cd antigravity-mcp
npm install

npm test                             # 26 checks, two live stdio clients, no CLI credits used
node test/delegation.js              # real end-to-end run through agy (uses agy credits)
node test/delegation-copilot.js      # real end-to-end run through copilot (uses Copilot credits)
node test/delegation-claude.js       # real end-to-end run through another claude (uses API usage)
node src/cli.js init --local --dry-run
```

`npm test` spawns two real MCP clients as separate processes against one board, so cross-process locking and messaging are covered for real rather than mocked.

---

<div align="center">

MIT · built by [adeelali4](https://github.com/adeelali4)

</div>
