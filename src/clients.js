/**
 * Where each MCP client keeps its server registry.
 *
 * `key` is the JSON property holding the server map — most clients use
 * `mcpServers`, VS Code uses `servers`, OpenCode uses its own `mcp` shape.
 * `shape` selects how an entry is rendered for that client.
 */

import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");

const appSupport = (...p) =>
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
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    file: path.join(HOME, ".gemini", "settings.json"),
    key: "mcpServers",
    shape: "standard",
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
    file: path.join(
      process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"),
      "opencode",
      "opencode.json"
    ),
    key: "mcp",
    shape: "opencode",
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
  },
  {
    id: "antigravity-ide",
    label: "Antigravity IDE",
    file: path.join(HOME, ".gemini", "antigravity-ide", "mcp_config.json"),
    key: "mcpServers",
    shape: "standard",
    workerAgent: "antigravity",
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
