#!/usr/bin/env node
/**
 * antigravity-mcp-server
 *
 * With no subcommand this speaks MCP over stdio — that is how MCP clients
 * launch it. Nothing may be written to stdout in that mode; diagnostics go to
 * stderr or the protocol breaks.
 */

import { runStdio } from "./server.js";
import { init, printInit } from "./init.js";
import { doctor, printDoctor } from "./doctor.js";

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

  serve options
    --agent <id>    Identity this instance uses on the shared board

  Environment
    AGY_BIN                 Path to the agy binary
    ANTIGRAVITY_MCP_HOME    Shared board location (default ~/.antigravity-mcp)
`;

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
      process.exitCode = printDoctor(doctor({ probe: has("--probe") })) ? 1 : 0;
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
