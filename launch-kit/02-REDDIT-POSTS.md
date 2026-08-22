# Reddit Launch Posts Kit

---

## 1. r/ClaudeAI (and r/Anthropic)

**Title:** I built an MCP server to let Claude Code delegate background tasks to Antigravity and Copilot without file collisions (plus a retro pixel office UI)

**Post Body:**

Hey everyone,

If you use Claude Code alongside other AI CLIs (like Google Antigravity `agy` or GitHub Copilot CLI), you've probably run into the issue where running multiple agents on one repo leads to silent file overwrites and broken code.

I built an open-source MCP server called **`antigravity-mcp-server`** to solve this:
- **GitHub:** https://github.com/adeelali4/antigravity-mcp
- **npm:** https://www.npmjs.com/package/antigravity-mcp-server

### How It Works:
1. **Automated Setup:** Just run `npm install -g antigravity-mcp-server && antigravity-mcp-server init`. It automatically scans your system for Claude Code, Claude Desktop, Cursor, etc., and registers the MCP server.
2. **File Locking (`claim_paths`):** Agents claim exclusive locks before modifying folders. If Antigravity is working on the frontend in `/components`, Claude Code will be blocked from touching it until Antigravity finishes.
3. **Background Delegation:** You can tell Claude Code: *"Have Antigravity build the CSS for the checkout page while you and I write the Stripe webhook."* Claude delegates it in the background while your terminal stays completely interactive.
4. **Token Compression:** Inter-agent messages and board queries are heavily compressed (~27% to 90% smaller payloads) to prevent burning Claude's token limits.
5. **Retro Office Dashboard (`antigravity-mcp-server ui`):** Opens a browser window showing a pixel-art office where you can watch Claude Code, Antigravity, and Copilot working at their respective desks in real time.

Check it out on GitHub, it's 100% MIT open source!

---

## 2. r/Cursor

**Title:** How to delegate tasks from Cursor to background CLIs (Antigravity, Copilot, Claude) with MCP file locking

**Post Body:**

Hey Cursor devs,

I built an MCP server that turns Cursor into a multi-agent orchestrator:
**`antigravity-mcp-server`** (https://github.com/adeelali4/antigravity-mcp)

### What it solves:
Cursor is great as your main driver, but sometimes you want background tasks (like generating unit tests, writing API docs, or refactoring boilerplate) handed off to a headless CLI like Antigravity (`agy`), Copilot CLI, or Claude Code.

### Setup:
1. Install globally:
   ```bash
   npm install -g antigravity-mcp-server
   antigravity-mcp-server init
   ```
2. Or add to `~/.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "antigravity": {
         "command": "npx",
         "args": ["-y", "antigravity-mcp-server", "--agent", "cursor"]
       }
     }
   }
   ```

### Features:
- **File Concurrency Mutexes:** Agents lock files so nobody edits the same file simultaneously.
- **Shared Task Board:** Cursor can post tasks, read status, and receive completion handoffs.
- **Visual Office UI:** Run `antigravity-mcp-server ui` to see a pixel-art dashboard showing your active agents.

---

## 3. r/webdev & r/LocalLLaMA

**Title:** Show: Multi-agent pair programming coordinator with file locks, shared task board, and a pixel-art retro office (MCP)

**Post Body:**

Link: https://github.com/adeelali4/antigravity-mcp
npm: https://www.npmjs.com/package/antigravity-mcp-server

Most multi-agent coding experiments fail because of concurrency issues—two LLMs editing `routes.ts` at the same time will overwrite each other every single time.

We built `antigravity-mcp-server` as a lightweight Node.js coordination daemon communicating over the Model Context Protocol (MCP).

**Key highlights:**
- **Zero-DB File Mutexes:** Uses atomic OS directory primitives that work reliably across Windows and POSIX to lock files during active edits.
- **Detached Execution:** Background tasks survive editor restarts.
- **Token Efficiency:** Cached state and payload compression saves context window space.
- **Live Pixel-Art Dashboard:** Real-time WebSockets feed a retro office view showing who is working, idle, or blocked.

Feedback and PRs welcome!
