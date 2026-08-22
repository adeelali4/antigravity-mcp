# MCP Registries & Awesome-Lists Submission Kit

This document contains pre-formatted submission snippets and step-by-step instructions to list **antigravity-mcp-server** on major MCP directories, registries, and curated GitHub lists.

---

## 1. Smithery.ai (Primary MCP Registry)

Smithery automatically indexes repositories with a `smithery.yaml` file (which is already configured in the repo).

* **Registry URL:** https://smithery.ai
* **How to Submit / Claim:**
  1. Visit [https://smithery.ai/submit](https://smithery.ai/submit) or sign in with your GitHub account.
  2. Paste your GitHub repo URL: `https://github.com/adeelali4/antigravity-mcp`.
  3. Smithery will validate `smithery.yaml` and generate a 1-click install page.
  4. Users will be able to install via:
     ```bash
     npx -y @smithery/cli install antigravity-mcp-server --client claude
     ```

---

## 2. Glama.ai (MCP Directory)

* **Registry URL:** https://glama.ai/mcp/servers
* **Submission Process:**
  1. Go to [https://glama.ai/mcp/servers](https://glama.ai/mcp/servers) and click **"Add MCP Server"**.
  2. Provide:
     * **Name:** `antigravity-mcp-server`
     * **Description:** Multi-agent orchestration MCP server allowing Claude Code, Cursor, Copilot, and Antigravity to coordinate tasks with file locking, shared task boards, and a live retro-office dashboard.
     * **Repository:** `https://github.com/adeelali4/antigravity-mcp`
     * **npm Package:** `https://www.npmjs.com/package/antigravity-mcp-server`
     * **Tags:** `multi-agent`, `orchestration`, `antigravity`, `claude-code`, `cursor`, `developer-tools`

---

## 3. Pull Request for `punkpeye/awesome-mcp-servers`

* **Repository:** https://github.com/punkpeye/awesome-mcp-servers
* **Target File:** `README.md`
* **Target Section:** `### 🤖 AI Agent & Orchestration` (or `### 🛠️ Developer Tools`)
* **PR Title:** `Add antigravity-mcp-server (multi-agent coordination & retro-office UI)`

### Markdown Entry to Insert:
```markdown
- [antigravity-mcp-server](https://github.com/adeelali4/antigravity-mcp) - Multi-agent MCP server enabling Claude Code, Cursor, and Copilot to orchestrate Antigravity tasks in parallel with file locking, shared task boards, and a live retro pixel-art office UI.
```

### PR Description:
```markdown
### What does this PR do?
Adds `antigravity-mcp-server`, an open-source MCP server that enables multiple AI coding agents (Claude Code, Antigravity agy, GitHub Copilot CLI, Cursor, etc.) to collaborate on the same repository without file collisions.

### Key Features:
- Multi-agent background delegation and session resumption
- Exclusive file/path locking (`claim_paths`) to prevent race conditions
- Shared real-time task board & inter-agent notes
- Bundled retro pixel-art office dashboard
- Zero-token brief replays on rate limits
```

---

## 4. Pull Request for `wong2/awesome-mcp-servers`

* **Repository:** https://github.com/wong2/awesome-mcp-servers
* **Target File:** `README.md`
* **Target Section:** `## Aggregators / Multi-Agent` or `## Development`
* **PR Title:** `Add antigravity-mcp-server`

### Markdown Entry to Insert:
```markdown
- [adeelali4/antigravity-mcp](https://github.com/adeelali4/antigravity-mcp) - MCP server for multi-agent delegation across Antigravity, Claude Code, and Copilot with path locking and a live pixel-office dashboard.
```

---

## 5. Pull Request for `appcypher/awesome-mcp-servers`

* **Repository:** https://github.com/appcypher/awesome-mcp-servers
* **Target File:** `README.md`
* **Target Section:** `### Agent Orchestration & Workflow`

### Markdown Entry to Insert:
```markdown
- [antigravity-mcp-server](https://github.com/adeelali4/antigravity-mcp) - Multi-agent MCP server with file mutexes, shared task boards, and live visual office UI for Antigravity, Claude Code, and Copilot.
```

---

## 6. PulseMCP & MCP.so

* **PulseMCP:** https://www.pulsemcp.com/submit
  * Submit package name and GitHub repo for inclusion in the weekly MCP newsletter and directory.
* **mcp.so:** https://mcp.so/submit
  * Add your npm package tag `antigravity-mcp-server`.
