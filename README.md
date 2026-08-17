<div align="center">

# antigravity-mcp

**Let two AI agents build your app at the same time — without stepping on each other.**

Your agent does the backend. Antigravity does the UI. Neither one breaks the other's files.

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
              │        antigravity-mcp          │
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
npx antigravity-mcp init
```

That's it. This one command:

- finds every AI tool on your computer
- adds the server to each one
- turns on the permission Antigravity needs

Now restart your AI tools so they pick it up.

```bash
npx antigravity-mcp doctor      # is everything working?
npx antigravity-mcp init --dry-run   # show changes, write nothing
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

Everything lives in `~/.antigravity-mcp/board.json`. No database to install.

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

## Good to know

**Long jobs are safe.** Antigravity runs detached. If your editor or the server
restarts, the job keeps going. Results are saved in
`~/.antigravity-mcp/runs/<task_id>.json`.

**Antigravity edits without asking.** That's the point — it works while you do
something else. To make it ask first, your agent can pass
`auto_approve: false`.

**One trap `init` handles for you.** In headless mode `agy` blocks all MCP calls
unless allowed. If that rule is missing, work still happens but the two agents
go blind to each other. `init` adds it. `doctor` checks it.

**Antigravity needs to be told where your project is.** Otherwise it works in its
own scratch folder. Every hand-off passes the project path automatically.

---

## Settings

| | |
|---|---|
| `AGY_BIN` | Where the `agy` program is |
| `ANTIGRAVITY_MCP_HOME` | Where the board is saved (default `~/.antigravity-mcp`) |
| `--agent <id>` | The name this agent uses on the board |

The `--agent` name is how the board tells the two sides apart. `init` sets it for
you. If you set things up by hand, **give each tool a different name** — same
name on both sides makes locks stop working.

---

## Setting it up by hand

Add this to your tool's MCP config:

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "npx",
      "args": ["-y", "antigravity-mcp", "--agent", "claude-code"]
    }
  }
}
```

On the Antigravity side, name it `coop`, use `--agent antigravity`, and add this
to `~/.gemini/antigravity-cli/settings.json`:

```json
{ "permissions": { "allow": ["mcp(coop/*)"] } }
```

---

## Working on the code

```bash
npm test                    # 16 checks, two live agents, no Antigravity credits used
node test/delegation.js     # real end-to-end run (uses Antigravity credits)
```

---

<div align="center">

MIT · built by [adeelali4](https://github.com/adeelali4)

</div>
