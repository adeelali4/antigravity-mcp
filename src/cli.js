#!/usr/bin/env node
/**
 * antigravity-mcp-server
 *
 * With no subcommand this speaks MCP over stdio — that is how MCP clients
 * launch it. Nothing may be written to stdout in that mode; diagnostics go to
 * stderr or the protocol breaks.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runStdio } from "./server.js";
import { init, printInit } from "./init.js";
import { update, printUpdate } from "./update.js";
import { doctor, printDoctor } from "./doctor.js";
import { reset, printReset } from "./reset.js";
import { restart, printRestart } from "./restart.js";
import { startUiServer, DEFAULT_UI_PORT } from "./uiServer.js";

import {
  printStatus,
  printTasks,
  delegateFromCli,
  printLogs,
  cancelFromCli,
  unlockFromCli,
  lockFromCli,
  reassignFromCli,
  sendNoteFromCli,
  readNotesFromCli,
} from "./commands.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Read from package.json so this can never drift from what's actually installed. */
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};

const HELP = `
  antigravity-mcp-server — delegate to AI coding agents and coordinate with them

  Server & Management
    antigravity-mcp-server                 Run the MCP server on stdio (how clients launch it)
    antigravity-mcp-server ui              Open the office visualization (agents, tasks, board)
    antigravity-mcp-server restart         Restart coordination state, kill stale UI/workers, clean board
    antigravity-mcp-server init            Register the server into every MCP client found
    antigravity-mcp-server doctor          Check that every link in the chain works
    antigravity-mcp-server update          Update globally-installed server to latest version
    antigravity-mcp-server reset           Wipe the shared board to recover from stuck state
    antigravity-mcp-server version         Print the installed version (also: v, -v, --version)
    antigravity-mcp-server --help

  Developer & AI CLI Control
    antigravity-mcp-server status [--json] Show agents, tasks, locks, notes (--json for scripts)
    antigravity-mcp-server tasks [--json]  List tasks on the board (--all for history, --owner <id>)
    antigravity-mcp-server delegate <cli> <prompt>
                                           Run a detached task (e.g. ag, copilot, claude)
    antigravity-mcp-server logs <id> [-f]  Print output for a task (-f follow, --err, --prompt)
    antigravity-mcp-server cancel <id>     Cancel a running task and release its path locks
    antigravity-mcp-server reassign <id> <to>
                                           Rerun a task's brief on another CLI without re-prompting
    antigravity-mcp-server lock <paths...> Lock files/dirs before editing (--note <text>)
    antigravity-mcp-server unlock [path]   Release path locks (--all to drop all locks)
    antigravity-mcp-server note <to> <msg> Leave a message on the board for an agent
    antigravity-mcp-server inbox [--unread] Read messages addressed to you or all

  delegate options
    --title <label>           Short label for the board
    --cwd <path>              Project root directory (default: current directory)
    --claim <p1,p2>           Comma-separated file/dir paths to lock
    --model <name>            Model override for the backend
    --effort <level>          Effort level (low, medium, high)
    --timeout <seconds>       Task timeout

  init options
    --dry-run                 Show what would change, write nothing
    --all                     Also write configs for clients that are not installed
    --only <ids>              Comma-separated client ids (e.g. claude-code,cursor)
    --global | --npx | --local  Force the launch form written into configs
                               (default: auto-detects a global install, else npx)

  doctor options
    --probe         Also run a live agy round trip (slower, uses agy quota)

  reset options
    --yes, -y       Actually perform the wipe (without this, acts as a dry-run)

  restart options
    --ui            Also start/restart the office UI dashboard
    --yes, -y       Also wipe all tasks, locks, and history (full board reset)
    --init          Also re-register the server into all detected MCP clients
    --port <n>      Port to serve on for UI (default ${DEFAULT_UI_PORT})
    --open          Open UI in default browser

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
  const child = spawn(cmd, args, { shell: platform === "win32", stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

function positionalArgs(startIndex = 1) {
  const flagsWithValue = new Set([
    "--note", "--claim", "--cwd", "--title", "--owner",
    "--model", "--effort", "--timeout", "--limit", "--only", "--port", "--path"
  ]);
  const out = [];
  for (let i = startIndex; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith("-")) {
      if (flagsWithValue.has(item)) i++;
    } else {
      out.push(item);
    }
  }
  return out;
}

async function main() {
  if (has("--help") || has("-h") || cmd === "help") {
    console.log(HELP);
    return;
  }
  if (has("--version") || has("-v") || cmd === "version" || cmd === "v") {
    console.log(PKG_VERSION);
    return;
  }

  switch (cmd) {
    case "status":
    case "ps": {
      process.exitCode = printStatus({ json: has("--json") });
      return;
    }
    case "tasks":
    case "board": {
      const owner = valueOf("--owner");
      const limit = valueOf("--limit");
      process.exitCode = printTasks({
        all: has("--all"),
        owner,
        limit: limit ? Number(limit) : 25,
        json: has("--json"),
      });
      return;
    }
    case "delegate": {
      const [backend, ...restPrompt] = positionalArgs(1);
      const prompt = restPrompt.join(" ") || valueOf("--prompt");
      process.exitCode = await delegateFromCli({
        backend,
        prompt,
        title: valueOf("--title"),
        cwd: valueOf("--cwd") || process.cwd(),
        claim: valueOf("--claim") ? valueOf("--claim").split(",") : [],
        model: valueOf("--model"),
        effort: valueOf("--effort"),
        timeout: valueOf("--timeout"),
      });
      return;
    }
    case "logs":
    case "tail": {
      const [taskId] = positionalArgs(1);
      process.exitCode = await printLogs(taskId, {
        err: has("--err"),
        prompt: has("--prompt"),
        raw: has("--raw"),
        follow: has("-f") || has("--follow"),
      });
      return;
    }
    case "reassign": {
      const [taskId, toBackend] = positionalArgs(1);
      const note = valueOf("--note");
      process.exitCode = await reassignFromCli({ taskIdArg: taskId, toBackend, note });
      return;
    }
    case "lock":
    case "claim": {
      const paths = positionalArgs(1);
      const note = valueOf("--note") || "";
      process.exitCode = await lockFromCli(paths, { note });
      return;
    }
    case "cancel":
    case "kill": {
      const [taskId] = positionalArgs(1);
      process.exitCode = await cancelFromCli(taskId);
      return;
    }
    case "unlock":
    case "release": {
      const [unlockPath] = positionalArgs(1);
      process.exitCode = await unlockFromCli({
        path: unlockPath || valueOf("--path"),
        all: has("--all"),
        owner: valueOf("--owner"),
      });
      return;
    }
    case "note":
    case "msg": {
      const [to, ...bodyParts] = positionalArgs(1);
      const body = bodyParts.join(" ") || valueOf("--body");
      process.exitCode = await sendNoteFromCli(to, body);
      return;
    }
    case "inbox":
    case "notes": {
      process.exitCode = readNotesFromCli({
        unreadOnly: has("--unread"),
        markRead: has("--mark-read"),
        limit: valueOf("--limit") ? Number(valueOf("--limit")) : 20,
        json: has("--json"),
      });
      return;
    }
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
    case "update": {
      process.exitCode = printUpdate(await update()) ? 1 : 0;
      return;
    }
    case "doctor": {
      process.exitCode = printDoctor(await doctor({ probe: has("--probe") })) ? 1 : 0;
      return;
    }
    case "reset": {
      process.exitCode = printReset(await reset({ yes: has("--yes") || has("-y") })) ? 1 : 0;
      return;
    }
    case "restart": {
      const portArg = valueOf("--port");
      const port = portArg ? Number(portArg) : DEFAULT_UI_PORT;
      process.exitCode = printRestart(
        await restart({
          yes: has("--yes") || has("-y"),
          ui: has("--ui"),
          init: has("--init"),
          port,
          open: has("--open"),
        })
      ) ? 1 : 0;
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
