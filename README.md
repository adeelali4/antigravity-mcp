<div align="center">

# antigravity-mcp-server

**Let two AI agents build your app at the same time — without stepping on each other.**

Your agent does the backend. Antigravity does the UI. Neither one breaks the other's files.

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

One small server that both agents plug into. It gives them a shared memory:
who is doing what, which files are taken, and what they need to tell each other.

```
   Your AI agent                                    Antigravity
   Claude Code · Cursor · Windsurf                  (agy CLI)
   VS Code · Gemini CLI · OpenCode
          │                                              │
          │  MCP                                     MCP │
          └──────────────┐                ┌──────────────┘
                         ▼                ▼
              ┌─────────────────────────────────┐
              │        antigravity-mcp-server          │
              │                                 │
              │   board.json                    │
              │    ├─ tasks .... who does what  │
              │    ├─ locks .... files taken    │
              │    ├─ notes .... messages       │
              │    └─ presence . who is online  │
              └─────────────────────────────────┘
                              │
                              └──► starts `agy` in the background
```

---

## Install

```bash
npx antigravity-mcp-server init
```

That's it. This one command:

- finds every AI tool on your computer
- adds the server to each one
- turns on the permission Antigravity needs

Now restart your AI tools so they pick it up.

Prefer it installed permanently instead of fetched each run:

```bash
npm install -g antigravity-mcp-server
antigravity-mcp-server init
```

Other commands:

```bash
antigravity-mcp-server doctor           # is everything working?
antigravity-mcp-server doctor --probe   # same, plus a real round trip through agy
antigravity-mcp-server init --dry-run   # show changes, write nothing
antigravity-mcp-server init --all       # also write configs for tools you haven't installed
antigravity-mcp-server init --only claude-code,cursor
```

**You need:** Node 18.17 or newer, and the [Antigravity](https://antigravity.google)
CLI (`agy`). Without `agy` you still get the shared board — you just can't hand
work to Antigravity.

---

## How you use it

You don't learn any commands. You just talk to your agent:

> *"Build the checkout page with Antigravity while you do the payments API."*

Your agent takes it from there. Here is what actually happens:

```
  time ──────────────────────────────────────────────────────►

  your agent   ███ writes brief ███│████ payments API ████│ checks result
                                   │                      │
  Antigravity                      │███ checkout page ███ │
                                   │                      │
                                   └── both work at once ─┘
```

Your agent writes a full brief, locks its own files, starts Antigravity in the
background, and **keeps working**. Nobody waits.

---

## Why the shared board matters

### 1. File locks

Before an agent edits a file, it claims it. Locking a folder locks everything
inside it.

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

The UI is being built against an API that **does not exist yet**. So the two
agents pass the plan back and forth:

> *"POST /api/orders is ready. It returns `{ id, status }`. Hook the form to it."*

This is the thing that keeps both halves fitting together.

### 3. Presence

Each agent can check what the other is doing before it starts, so it picks work
that doesn't clash.

---

## The tools

Your agent picks these on its own. You never type them.

| Group | Tools |
|---|---|
| **Hand off work** | `ag_delegate` · `ag_task_status` · `ag_task_wait` · `ag_followup` · `ag_cancel` |
| **Shared board** | `coop_status` · `board_post` · `board_update` · `board_list` |
| **File locks** | `claim_paths` · `release_paths` · `check_paths` |
| **Talking** | `notes_send` · `notes_read` · `presence_set` · `activity` |
| **Admin** | `coop_reset` |

Two worth knowing about:

**`coop_status`** — one call answers everything: who's online, what's running,
what's locked, what's unread.

**`ag_followup`** — carries on the *same* Antigravity conversation. So *"now make
it work on mobile"* keeps all the context instead of starting cold.

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

The child is spawned **detached**, with stdout redirected straight to
`runs/<task_id>.json`. That means a long job survives the MCP server being
restarted — status is recovered by reading the run file and checking the PID,
not by holding a child handle.

`ag_followup` reuses the `conversation_id` from agy's JSON output via
`--conversation`, so context carries across calls.

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

**Long jobs are safe.** Antigravity runs detached. If your editor or the server
restarts, the job keeps going.

**Antigravity edits without asking.** `ag_delegate` passes
`--dangerously-skip-permissions` so it can work unattended. Pass
`auto_approve: false` to make it stop at prompts instead.

**One trap `init` handles for you.** In headless mode `agy` auto-denies every MCP
call unless allow-listed in `~/.gemini/antigravity-cli/settings.json`. If that
rule is missing, delegation still runs but coordination silently does nothing —
the worst kind of failure, because it looks like it works. `init` adds
`mcp(coop/*)`; `doctor` checks for it.

**Antigravity works in its own scratch project** unless the target directory is
in its workspace. Every hand-off passes `--add-dir <cwd>` and states the project
root in the brief.

---

## Settings

| | |
|---|---|
| `AGY_BIN` | Path to the `agy` binary |
| `ANTIGRAVITY_MCP_HOME` | Board location (default `~/.antigravity-mcp`) |
| `--agent <id>` | The name this instance uses on the board |

---

## Setting it up by hand

Add this to your tool's MCP config:

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

npm test                    # 16 checks, two live stdio clients, no agy credits used
node test/delegation.js     # real end-to-end run (uses agy credits)
node src/cli.js init --local --dry-run
```

`npm test` spawns two real MCP clients as separate processes against one board,
so cross-process locking and messaging are covered for real rather than mocked.

---

<div align="center">

MIT · built by [adeelali4](https://github.com/adeelali4)

</div>
