# antigravity-mcp

Let your AI coding agent delegate work to **Antigravity** and stay out of its way.

One MCP server, registered on both sides. Your agent (Claude Code, Cursor,
Windsurf, VS Code, Gemini CLI, OpenCode — anything that speaks MCP) hands a task
to the Antigravity CLI, keeps working on its own half, and both sides share a
board so they never edit the same files.

```
   your agent ──┐                       ┌── delegates via `agy --print`
                ├── antigravity-mcp ────┤
  Antigravity ──┘     shared board      └── locks · notes · presence · status
```

## Install

```bash
npx antigravity-mcp init
```

That detects every MCP client on your machine, registers the server into each
one, and adds the permission rule Antigravity needs. Then restart your clients.

```bash
npx antigravity-mcp doctor      # check every link in the chain
npx antigravity-mcp init --dry-run
```

Requires Node >= 18.17 and the [Antigravity](https://antigravity.google) CLI
(`agy`) on your machine. Without `agy` the coordination tools still work; only
delegation needs it.

## Use it

Just talk to your agent. It has the tools; it works out the calls.

> "Have Antigravity build the checkout page while you do the payments API."

Under the hood your agent writes a self-contained brief, locks its own files,
launches `agy` as a **detached background job**, and carries on — no blocking.

## Why a shared board

Two agents in one repo collide. This gives them the minimum they need not to:

- **Path locks** — claim files before editing. A directory lock covers
  everything under it, and a claim on a path another agent holds comes back as a
  conflict instead of a silent overwrite.
- **Notes** — pass the contract across. *"POST /api/orders returns `{id, status}`
  — wire the form to it."* The UI half is written against an API that does not
  exist yet, so this is what keeps the halves compatible.
- **Presence and activity** — each agent can see what the other is doing before
  it starts.

State lives in `~/.antigravity-mcp/board.json`, written under a cross-process
lock. No native modules, so `npx` works everywhere.

## Tools

| | |
|---|---|
| **Delegation** | `ag_delegate` · `ag_task_status` · `ag_task_wait` · `ag_followup` · `ag_cancel` |
| **Board** | `coop_status` · `board_post` · `board_update` · `board_list` |
| **Locks** | `claim_paths` · `release_paths` · `check_paths` |
| **Comms** | `notes_send` · `notes_read` · `presence_set` · `activity` |
| **Admin** | `coop_reset` |

`coop_status` is the one to reach for first — it answers who is online, what is
running, what is locked, and what is unread in a single call.

`ag_followup` continues an existing Antigravity conversation rather than
starting cold, so *"now make it responsive"* keeps all the context of the
original task.

## Notes and gotchas

- **Delegated jobs are detached.** A long task survives an MCP server restart;
  status is recovered from `~/.antigravity-mcp/runs/<task_id>.json`.
- **`ag_delegate` auto-approves by default** (`--dangerously-skip-permissions`)
  so Antigravity can edit unattended. Pass `auto_approve: false` for
  prompt-on-write.
- **`agy` auto-denies MCP calls in headless mode** unless allow-listed. `init`
  adds `mcp(coop/*)` to `~/.gemini/antigravity-cli/settings.json`; without it,
  delegation runs but coordination silently does nothing. `doctor` checks this.
- **`agy` works in its own scratch project** unless the target directory is in
  its workspace, so every delegation passes `--add-dir <cwd>` and states the
  project root in the brief.

## Configuration

| | |
|---|---|
| `AGY_BIN` | Path to the `agy` binary |
| `ANTIGRAVITY_MCP_HOME` | Board location (default `~/.antigravity-mcp`) |
| `--agent <id>` | Identity this instance uses on the board |

The `--agent` id is how the board tells the two sides apart. `init` sets it per
client; if you register by hand, give each client a distinct id or lock
conflicts become invisible.

## Manual registration

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

On the Antigravity side use the key `coop` and `--agent antigravity`, and add
`"permissions": { "allow": ["mcp(coop/*)"] }` to
`~/.gemini/antigravity-cli/settings.json`.

## Development

```bash
npm test                    # 16 checks, two live stdio clients, no agy quota
node test/delegation.js     # live end-to-end delegation (spends agy quota)
```

MIT
