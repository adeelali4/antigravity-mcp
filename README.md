<div align="center">

# antigravity-mcp-server

**Let multiple AI agents build your app at the same time — without stepping on each other.**

Hand work to Antigravity or GitHub Copilot, keep working yourself, and none of you break each other's files.

[![npm](https://img.shields.io/npm/v/antigravity-mcp-server.svg)](https://www.npmjs.com/package/antigravity-mcp-server)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue.svg)](https://modelcontextprotocol.io)

</div>

---

## The problem

Running two AI coding agents on one project sounds great — until they both edit
the same file and quietly destroy each other's work.

They can't see each other. That's the whole issue.

## The fix

One small server every agent plugs into. It gives them a shared memory: who is
doing what, which files are taken, and what they need to tell each other — plus
the ability to hand work to Antigravity or Copilot as a background job.

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

## Install

```bash
npm install -g antigravity-mcp-server
antigravity-mcp-server init
```

`init` does the rest:

- finds every AI tool on your computer
- adds the server to each one
- turns on the permission Antigravity needs

Now restart your AI tools so they pick it up.

A global install is worth the extra step over `npx`: your editor spawns this
server on every session, and `npx` re-checks the registry on each launch and
can silently pull a newer version mid-session — which matters here, since both
agents need to speak the same board schema. A global install starts instantly
and only changes version when you run `npm update -g` yourself. `init` detects
a global install automatically and writes the direct command into every
config; it only falls back to `npx` if it can't find one.

No install, if you just want to try it once:

```bash
npx antigravity-mcp-server init
```

Other commands:

```bash
antigravity-mcp-server doctor           # is everything working?
antigravity-mcp-server doctor --probe   # same, plus a real round trip through agy
antigravity-mcp-server init --dry-run   # show changes, write nothing
antigravity-mcp-server init --all       # also write configs for tools you haven't installed
antigravity-mcp-server init --only claude-code,cursor
antigravity-mcp-server init --global    # force the direct-command form
antigravity-mcp-server init --npx       # force npx, even with a global install present
```

**You need:** Node 18.17 or newer, and at least one delegation target —
[Antigravity](https://antigravity.google) (`agy`), the
[GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
(`copilot`), or Claude Code itself (`claude`, for delegating to another Claude
instance). You get the shared board either way — a missing CLI just means you
can't hand work to that one.

---

## How you use it

You don't learn any commands. You just talk to your agent:

> *"Have Antigravity build the checkout page while you do the payments API."*
> *"Get Copilot to write tests for the parser while you fix the bug."*

A delegated agent isn't limited to any one kind of work — UI, backend, tests,
docs, a refactor, whatever the task actually is. Your agent takes it from
there. Here is what actually happens:

```
  time ──────────────────────────────────────────────────────►

  your agent   ███ writes brief ███│████ payments API ████│ checks result
                                   │                      │
  Antigravity                      │███ checkout page ███ │
                                   │                      │
                                   └── both work at once ─┘
```

Your agent writes a full brief, locks its own files, starts the delegated
agent in the background, and **keeps working**. Nobody waits.

---

## Why the shared board matters

### 1. File locks

Before an agent edits a file, it claims it. Locking a folder locks everything
inside it. Whatever the split ends up being (this example happens to be
backend vs. UI, but it doesn't have to be):

```
  my-app/
  ├── api/           [locked] your agent    ← Antigravity is told "taken"
  ├── db.ts          [locked] your agent
  ├── components/    [locked] Antigravity   ← your agent stays away
  └── styles/        [locked] Antigravity
```

If an agent tries to take a locked file, it gets a clear **conflict** back. No
silent overwrite.

### 2. Notes

When two agents are building against a shared interface that **doesn't exist
yet**, they pass the contract back and forth:

> *"POST /api/orders is ready. It returns `{ id, status }`. Hook the form to it."*

This is the thing that keeps both sides fitting together.

### 3. Presence

Each agent can check what the other is doing before it starts, so it picks work
that doesn't clash.

---

## The tools

Your agent picks these on its own. You never type them.

| Group | Tools |
|---|---|
| **Hand off to Antigravity** | `ag_delegate` · `ag_task_status` · `ag_task_wait` · `ag_followup` · `ag_cancel` |
| **Hand off to Copilot** | `copilot_delegate` · `copilot_task_status` · `copilot_task_wait` · `copilot_followup` · `copilot_cancel` |
| **Hand off to another Claude** | `claude_delegate` · `claude_task_status` · `claude_task_wait` · `claude_followup` · `claude_cancel` |
| **Shared board** | `coop_status` · `board_post` · `board_update` · `board_list` |
| **File locks** | `claim_paths` · `release_paths` · `check_paths` |
| **Talking** | `notes_send` · `notes_read` · `presence_set` · `activity` |
| **Admin** | `coop_reset` |

The three delegation lanes are symmetric — same shape, same behavior — so your
agent picks whichever CLI you named. `claude_delegate` launches a fully
independent `claude` CLI process, not a subagent inside the calling session —
and because it's a plain `claude` invocation, it automatically inherits
whatever MCP servers are registered at user scope, this one included, so a
delegated Claude can call `coop_status` / `claim_paths` on itself with no
extra setup.

Two worth knowing about:

**`coop_status`** — one call answers everything: who's online, what's running,
what's locked, what's unread.

**`ag_followup` / `copilot_followup` / `claude_followup`** — carries on the *same* conversation. So
*"now make it work on mobile"* keeps all the context instead of starting cold.

---

## How it works inside

### Files on disk

```
~/.antigravity-mcp/
├── board.json                    shared state, written under a lock
└── runs/
    ├── <task_id>.json            agy's raw result
    ├── <task_id>.prompt.txt      the brief that was sent
    └── <task_id>.err             stderr, if the run failed
```

`board.json` holds `tasks`, `locks`, `notes`, `events`, and `presence`. Every
write takes an exclusive lock (an atomically created directory — the one
primitive that behaves the same on Windows and POSIX), then lands via
write-temp-and-rename, so a crash can't leave a half-written board. Stale locks
older than 20s are broken automatically.

There's no SQLite. A native build would break `npx` on machines without a
compiler, and `node:sqlite` is still experimental and Node 22+. The board takes
a handful of small writes per minute, so a JSON file is the right size of tool.

### Delegation

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

All three children are spawned **detached**, with output redirected straight
to `runs/<task_id>.json`. That means a long job survives the MCP server being
restarted — status is recovered by reading the run file and checking the PID,
not by holding a child handle. agy and claude each emit one JSON object;
copilot emits JSONL (one event per line, terminated by a `type: "result"`
line) — all three get normalised to the same
`{status, response, conversation_id, usage}` shape before landing on the
board, so the rest of the server doesn't care which backend produced them.

`ag_followup` reuses agy's `conversation_id` via `--conversation`;
`copilot_followup` reuses Copilot's session id via `--resume`; `claude_followup`
does the same via `claude`'s own `--resume`. Either way, context carries across
calls. Note: copilot and claude have no session-level timeout flag (`agy`'s
`--print-timeout` has no equivalent on either) — a hung job just stays
"running" until it exits on its own or the matching `*_cancel` kills it.

### Path locks

Paths are normalised with `path.resolve` and case-folded on Windows, so
`C:\Proj` and `c:\proj` can't defeat the same lock. Overlap is checked in both
directions — claiming `api/routes.ts` conflicts with a held `api/`, and claiming
`api/` conflicts with a held `api/routes.ts`.

### Agent identity

Each side runs the same binary with a different `--agent <id>`. That id is what
every board entry is attributed to. Two clients sharing one id makes their locks
invisible to each other, which defeats the whole point.

---

## Where configs get written

`init` only touches tools it finds, and backs up any file it edits to
`<file>.bak-antigravity-mcp`.

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

---

## Good to know

**Long jobs are safe.** Both backends run detached. If your editor or the
server restarts, the job keeps going.

**Delegated agents edit without asking.** `ag_delegate` passes
`--dangerously-skip-permissions`; `copilot_delegate` passes `--allow-all-tools`
(the documented minimum Copilot needs to write files in non-interactive mode).
Pass `auto_approve: false` on either to make it stop at prompts instead.

**One trap `init` handles for you, for agy.** In headless mode `agy` auto-denies
every MCP call unless allow-listed in `~/.gemini/antigravity-cli/settings.json`.
If that rule is missing, delegation still runs but coordination silently does
nothing — the worst kind of failure, because it looks like it works. `init`
adds `mcp(coop/*)`; `doctor` checks for it. Copilot has no equivalent trap: it
was verified working with a plain `copilot mcp add --transport http` and no
extra permission rule.

**Both work in their own scratch project** unless the target directory is in
their workspace. Every hand-off passes `--add-dir <cwd>` and states the project
root in the brief.

---

## Settings

| | |
|---|---|
| `AGY_BIN` | Path to the `agy` binary |
| `COPILOT_BIN` | Path to the `copilot` binary |
| `CLAUDE_BIN` | Path to the `claude` binary |
| `ANTIGRAVITY_MCP_HOME` | Board location (default `~/.antigravity-mcp`) |
| `--agent <id>` | The name this instance uses on the board |

---

## Setting it up by hand

With a global install (`npm install -g antigravity-mcp-server`), add this to
your tool's MCP config:

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

On the Antigravity side, name the server `coop`, use `--agent antigravity`, and
add this to `~/.gemini/antigravity-cli/settings.json`:

```json
{ "permissions": { "allow": ["mcp(coop/*)"] } }
```

The server key must match the allow-rule — `coop` here, `mcp(coop/*)` there.

---

## Working on the code

```bash
git clone https://github.com/adeelali4/antigravity-mcp
cd antigravity-mcp
npm install

npm test                             # 16 checks, two live stdio clients, no CLI credits used
node test/delegation.js              # real end-to-end run through agy (uses agy credits)
node test/delegation-copilot.js      # real end-to-end run through copilot (uses Copilot credits)
node test/delegation-claude.js       # real end-to-end run through another claude (uses API usage)
node src/cli.js init --local --dry-run
```

`npm test` spawns two real MCP clients as separate processes against one board,
so cross-process locking and messaging are covered for real rather than mocked.

---

<div align="center">

MIT · built by [adeelali4](https://github.com/adeelali4)

</div>
