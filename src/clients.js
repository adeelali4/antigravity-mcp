/**
 * Where each MCP client keeps its server registry.
 *
 * `key` is the JSON property holding the server map — most clients use
 * `mcpServers`, VS Code uses `servers`, OpenCode uses its own `mcp` shape.
 * `shape` selects how an entry is rendered for that client.
 *
 * `memoryFile`, when set, is the client's global instructions file. `init`
 * writes a managed "skill" block into it (see skill.js) so the agent keeps
 * knowing what this server is for. Clients with no stable global file (Cursor,
 * Claude Desktop, VS Code) leave it unset and rely on the MCP `instructions`
 * string alone.
 */

import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");

/** ~/.gemini/GEMINI.md — the global context file gemini-cli and Antigravity both load. */
const GEMINI_MD = path.join(HOME, ".gemini", "GEMINI.md");

export const appSupport = (...p) =>
  MAC ? path.join(HOME, "Library", "Application Support", ...p)
  : WIN ? path.join(APPDATA, ...p)
  : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), ...p);

export const CLIENTS = [
  {
    id: "claude-code",
    label: "Claude Code",
    file: path.join(HOME, ".claude.json"),
    key: "mcpServers",
    shape: "standard",
    memoryFile: path.join(HOME, ".claude", "CLAUDE.md"),
  },
  {
    id: "cursor",
    label: "Cursor",
    file: path.join(HOME, ".cursor", "mcp.json"),
    key: "mcpServers",
    shape: "standard",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    file: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
    key: "mcpServers",
    shape: "standard",
    memoryFile: path.join(HOME, ".codeium", "windsurf", "memories", "global_rules.md"),
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    file: path.join(HOME, ".gemini", "settings.json"),
    key: "mcpServers",
    shape: "standard",
    memoryFile: GEMINI_MD,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    file: appSupport("Claude", "claude_desktop_config.json"),
    key: "mcpServers",
    shape: "standard",
  },
  {
    id: "vscode",
    label: "VS Code (Copilot)",
    file: appSupport("Code", "User", "mcp.json"),
    key: "servers",
    shape: "standard",
  },
  {
    id: "opencode",
    label: "OpenCode",
    file: path.join(XDG_CONFIG, "opencode", "opencode.json"),
    key: "mcp",
    shape: "opencode",
    memoryFile: path.join(XDG_CONFIG, "opencode", "AGENTS.md"),
  },
  // Antigravity itself — registered as a worker, with agent id "antigravity".
  // Two files: the CLI (agy) and the IDE read different configs.
  {
    id: "antigravity-cli",
    label: "Antigravity CLI (agy)",
    file: path.join(HOME, ".gemini", "config", "mcp_config.json"),
    key: "mcpServers",
    shape: "standard",
    workerAgent: "antigravity",
    memoryFile: GEMINI_MD,
  },
  {
    id: "antigravity-ide",
    label: "Antigravity IDE",
    file: path.join(HOME, ".gemini", "antigravity-ide", "mcp_config.json"),
    key: "mcpServers",
    shape: "standard",
    workerAgent: "antigravity",
    memoryFile: GEMINI_MD,
  },
  // OpenAI Codex CLI. Configured in TOML, not JSON, so it carries format:"toml"
  // and init writes it with a targeted block edit rather than a JSON rewrite.
  // Registering it matters for symmetry: codex is already a delegation TARGET,
  // and every target should also be able to delegate outward.
  {
    id: "codex-cli",
    label: "OpenAI Codex CLI",
    file: path.join(HOME, ".codex", "config.toml"),
    key: "mcp_servers",
    shape: "standard",
    format: "toml",
    memoryFile: path.join(HOME, ".codex", "AGENTS.md"),
  },
  // GitHub Copilot CLI — also a worker, agent id "copilot". Its own `copilot
  // mcp add` command writes this exact shape, so this mirrors that rather
  // than shelling out to a binary that may not be on PATH at init time.
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    file: path.join(HOME, ".copilot", "mcp-config.json"),
    key: "mcpServers",
    shape: "copilot",
    workerAgent: "copilot",
  },
];

/** agy refuses MCP calls in headless mode unless allow-listed here. */
export const AGY_SETTINGS = path.join(HOME, ".gemini", "antigravity-cli", "settings.json");

/** Server key: peers see "antigravity"; the worker side sees the board as "coop". */
export const serverKey = (client) => (client.workerAgent ? "coop" : "antigravity");

export function entryFor(client, command, args, shape = client.shape) {
  if (shape === "opencode") {
    return { type: "local", command: [command, ...args], enabled: true };
  }
  if (shape === "copilot") {
    return { type: "local", command, args, tools: ["*"] };
  }
  return { command, args };
}
