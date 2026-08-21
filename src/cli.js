#!/usr/bin/env node
/**
 * antigravity-mcp-server
 *
 * With no subcommand this speaks MCP over stdio — that is how MCP clients
 * launch it. Nothing may be written to stdout in that mode; diagnostics go to
 * stderr or the protocol breaks.
 */

import { spawn } from "node:child_process";
import { runStdio } from "./server.js";
import { init, printInit } from "./init.js";
import { doctor, printDoctor } from "./doctor.js";
import { startUiServer, DEFAULT_UI_PORT } from "./uiServer.js";

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};

const HELP = `
  antigravity-mcp-server — delegate to the Antigravity CLI and coordinate with it

  Usage
    antigravity-mcp-server                 Run the MCP server on stdio (how clients launch it)
    antigravity-mcp-server ui              Open the office visualization (agents, tasks, board)
    antigravity-mcp-server init            Register the server into every MCP client found
    antigravity-mcp-server doctor          Check that every link in the chain works
    antigravity-mcp-server --help

  init options
    --dry-run                 Show what would change, write nothing
    --all                     Also write configs for clients that are not installed
    --only <ids>              Comma-separated client ids (e.g. claude-code,cursor)
    --global | --npx | --local  Force the launch form written into configs
                               (default: auto-detects a global install, else npx)

  doctor options
    --probe         Also run a live agy round trip (slower, uses agy quota)

  ui options
    --port <n>      Port to serve on (default ${DEFAULT_UI_PORT})
    --open          Open the URL in your default browser

  serve options
    --agent <id>    Identity this instance uses on the shared board

  Environment
    AGY_BIN                 Path to the agy binary
    COPILOT_BIN              Path to the copilot binary
    CLAUDE_BIN               Path to the claude binary
    ANTIGRAVITY_MCP_HOME    Shared board location (default ~/.antigravity-mcp)
`;

function openInBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "win32" ? "start" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["", url] : [url];
  spawn(cmd, args, { shell: platform === "win32", stdio: "ignore", detached: true }).unref();
}

async function main() {
  if (has("--help") || has("-h") || cmd === "help") {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "init": {
      const only = valueOf("--only");
      printInit(
        init({
          dryRun: has("--dry-run"),
          all: has("--all"),
          only: only ? only.split(",").map((s) => s.trim()) : null,
          launchMode: has("--global") ? "global" : has("--npx") ? "npx" : has("--local") ? "local" : "auto",
        })
      );
      return;
    }
    case "doctor": {
      process.exitCode = printDoctor(await doctor({ probe: has("--probe") })) ? 1 : 0;
      return;
    }
    case "ui": {
      const portArg = valueOf("--port");
      const port = portArg ? Number(portArg) : DEFAULT_UI_PORT;
      try {
        await startUiServer({ port });
      } catch (e) {
        if (e.code === "EADDRINUSE") {
          console.error(`Port ${port} is already in use. Pick another with --port, or something's already running here.`);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
      const url = `http://localhost:${port}`;
      console.log(`Agent Office running at ${url}`);
      console.log("Press Ctrl+C to stop.");
      if (has("--open")) openInBrowser(url);
      return;
    }
    case "serve":
      await runStdio();
      return;
    default:
      console.error(`unknown command: ${cmd}\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`antigravity-mcp-server: ${err.stack || err.message}`);
  process.exitCode = 1;
});
