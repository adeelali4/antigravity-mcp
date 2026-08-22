# Show HN: Antigravity MCP – Multi-agent coding with file locking and a retro pixel office

### Link / Text Submission for news.ycombinator.com:

**Title:**
Show HN: Antigravity MCP – Multi-agent pair programming with file locks & pixel office

**URL (if link post):** https://github.com/adeelali4/antigravity-mcp
**Or Text (if Ask/Show post):**

Hey HN,

I built **antigravity-mcp-server** ([GitHub](https://github.com/adeelali4/antigravity-mcp) | [npm](https://www.npmjs.com/package/antigravity-mcp-server)), an open-source MCP server that lets multiple AI coding assistants (Claude Code, Antigravity CLI, GitHub Copilot CLI, Cursor, Windsurf, OpenCode, and Codex) work on the same codebase simultaneously without stepping on each other.

### The Problem
Running two AI agents on one project sounds great until they both edit the same file, quietly overwrite each other's changes, and break your build. AI agents have no shared context or concurrency primitives by default.

### How It Works
`antigravity-mcp-server` acts as a shared coordination runtime over MCP (Model Context Protocol):

1. **Exclusive File Locking (`claim_paths`):** Before an agent touches a directory or file, it claims an exclusive path lock. If another agent attempts to modify it, it gets a clear conflict and waits.
2. **Shared Task Board & Inter-Agent Notes (`board.json`):** Tracks active tasks, presence, and allows agents to send async messages (e.g. *"Auth endpoint is ready at /api/login, connect the form to it"*).
3. **Multi-CLI Background Delegation:** You talk to whichever host you prefer (e.g. Claude Code in your terminal). It spins up background tasks on `agy` (Antigravity), `copilot`, or another `claude` instance while you keep coding in the main window.
4. **Token Optimization:** Standard multi-agent polling floods context windows. We strip pretty-printing, compress cost reports by ~90%, use sequence-based ETags (`{unchanged: true}`), and replay prompts directly from disk on rate-limit failover so a 4,000-token brief moves for zero extra token cost.
5. **Retro Pixel-Art Office UI (`antigravity-mcp-server ui`):** Launches a live visual dashboard at `http://localhost:49321` where every agent is rendered as a desk in a pixel-art office with real-time status and task monitors.

### Quickstart
```bash
npm install -g antigravity-mcp-server
antigravity-mcp-server init
```
The `init` command automatically discovers your installed editors/CLIs (Claude Code, Cursor, Windsurf, Claude Desktop, VS Code, Antigravity) and writes the configuration.

Source is MIT licensed on GitHub: https://github.com/adeelali4/antigravity-mcp

Would love feedback, feature ideas, and bug reports from anyone experimenting with multi-agent workflows!
