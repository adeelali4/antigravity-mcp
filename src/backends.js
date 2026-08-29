/**
 * Which CLIs can be delegated to, and how to drive each one.
 *
 * Every backend answers the same four questions -- where's the binary, how do
 * I run it headlessly with a prompt, how do I read its answer, how do I resume
 * its session -- so they live here as data rather than as one near-identical
 * module apiece.
 *
 * That matters because this ships on npm: whichever CLIs happen to be
 * installed on THIS machine is not the set anyone else has. Hard-coding a
 * fixed list would make every unlisted CLI a feature request. Instead the
 * built-ins below are just the presets, and `~/.antigravity-mcp/backends.json`
 * can add or override any of them without touching this file -- see
 * loadUserBackends().
 *
 * The three original backends keep their own hand-written parsers, because
 * each has a real quirk (agy prints banner lines before its JSON, copilot's
 * answer is in the last assistant.message rather than its result event) and
 * those parsers are proven. Declarative specs cover everything else.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME, ensureDirs, stateDir, outPath, errPath, promptPath, readStderr } from "./store.js";
import { findBinary, launchSpec, standardCandidates, isAlive } from "./proc.js";
import { readResult as readAgyResult, findAgy } from "./agy.js";
import { readResult as readCopilotResult, findCopilot } from "./copilot.js";
import { readResult as readClaudeResult, findClaude } from "./claude.js";

// Re-exported for callers that only ever knew these as backends.js exports
// (commands.js in particular) -- the definitions themselves now live in
// store.js, next to runsDir(), which is what they're built from.
export { outPath, errPath, promptPath };

/**
 * Separates the caller's actual task from the wrapper briefingFor() puts
 * around it. Written once here so the brief can be recovered from disk and
 * handed to a different backend later, instead of a delegating agent having
 * to regenerate a multi-thousand-token brief it already wrote once.
 */
export const TASK_MARKER = "--- TASK ---";

/** The original task text for a run, recovered from its saved brief. */
export function recoverTask(id) {
  let brief;
  try {
    brief = fs.readFileSync(promptPath(id), "utf8");
  } catch {
    return null;
  }
  const at = brief.indexOf(TASK_MARKER);
  // No marker means a brief written before the marker existed; the whole file
  // is still a usable prompt, just with the old wrapper attached.
  return at === -1 ? brief.trim() : brief.slice(at + TASK_MARKER.length).trim();
}

/**
 * Built-in presets.
 *
 * `verified` says whether this project has actually round-tripped a real task
 * through that CLI, and doctor reports it. The three originals have; the rest
 * are written from each CLI's own documented flags but could not be exercised
 * here (no install, dead auth, or broken local config). They are presets, not
 * promises -- if one is wrong, `backends.json` fixes it without a release.
 */
const BUILTIN = [
  {
    id: "ag", label: "Antigravity", owner: "antigravity-agent", verified: true,
    bin: { envVar: "AGY_BIN", name: "agy", find: findAgy },
    modelHint: "e.g. gemini-3.1-pro-high for hard UI work",
    build: ({ prompt, cwd, model, mode, effort, addDirs, autoApprove, timeoutSeconds, resume }) => {
      const args = ["--print", prompt, "--output-format", "json", "--print-timeout", `${timeoutSeconds ?? 1800}s`];
      if (resume) args.push("--conversation", resume);
      if (model) args.push("--model", model);
      if (mode ?? "accept-edits") args.push("--mode", mode ?? "accept-edits");
      if (effort) args.push("--effort", effort);
      for (const d of [cwd, ...(addDirs || [])]) args.push("--add-dir", path.resolve(d));
      if (autoApprove) args.push("--dangerously-skip-permissions");
      return args;
    },
    parse: readAgyResult,
  },
  {
    id: "copilot", label: "Copilot", owner: "copilot-agent", verified: true,
    bin: { envVar: "COPILOT_BIN", name: "copilot", find: findCopilot },
    modelHint: "e.g. gpt-5.4, claude-sonnet-5; 'auto' lets Copilot pick",
    sessionNote: "(Copilot session id)",
    note: "Copilot has no session-level timeout -- hung jobs persist until they exit or copilot_cancel kills them.",
    build: ({ prompt, cwd, model, effort, addDirs, autoApprove, resume }) => {
      const args = ["-p", prompt, "--output-format", "json"];
      if (resume) args.push("--resume", resume);
      if (model) args.push("--model", model);
      if (effort) args.push("--reasoning-effort", effort);
      for (const d of [cwd, ...(addDirs || [])]) args.push("--add-dir", path.resolve(d));
      if (autoApprove) args.push("--allow-all-tools");
      return args;
    },
    parse: readCopilotResult,
  },
  {
    id: "claude", label: "Claude", owner: "claude-agent", verified: true,
    bin: { envVar: "CLAUDE_BIN", name: "claude", find: findClaude },
    sessionNote: "(session id)",
    build: ({ prompt, cwd, model, addDirs, autoApprove, resume }) => {
      const args = [prompt, "--print", "--output-format", "json"];
      if (resume) args.push("--resume", resume);
      if (model) args.push("--model", model);
      for (const d of [cwd, ...(addDirs || [])]) args.push("--add-dir", path.resolve(d));
      if (autoApprove) args.push("--dangerously-skip-permissions");
      return args;
    },
    parse: readClaudeResult,
  },
  {
    // openai/codex. `exec` is its headless mode; --json emits JSONL events.
    id: "codex", label: "Codex", owner: "codex-agent", verified: false,
    bin: {
      envVar: "CODEX_BIN", name: "codex",
      candidates: standardCandidates("codex"),
    },
    modelHint: "e.g. gpt-5.4-codex",
    build: ({ prompt, cwd, model, autoApprove, resume }) => {
      const args = ["exec"];
      if (resume) args.push("resume", resume);
      args.push("--json", "--cd", path.resolve(cwd));
      if (model) args.push("--model", model);
      if (autoApprove) args.push("--dangerously-bypass-approvals-and-sandbox");
      args.push(prompt);
      return args;
    },
    output: { format: "jsonl", response: "msg.message", session: "session_id" },
  },
  {
    // Cursor's headless agent. -p is print mode, like claude's.
    id: "cursor", label: "Cursor", owner: "cursor-agent", verified: false,
    bin: {
      envVar: "CURSOR_AGENT_BIN", name: "cursor-agent",
      candidates: standardCandidates("cursor-agent"),
    },
    build: ({ prompt, model, autoApprove, resume }) => {
      const args = ["-p", prompt, "--output-format", "json"];
      if (resume) args.push("--resume", resume);
      if (model) args.push("--model", model);
      if (autoApprove) args.push("--force");
      return args;
    },
    output: { format: "json", response: "result", session: "chatId" },
  },
  {
    // Google's gemini CLI. Flags below are read straight off its --help.
    // No resume-by-id: -r takes "latest" or an index, so followup can't target
    // a specific session -- hence resume:false rather than a guessed flag.
    id: "gemini", label: "Gemini", owner: "gemini-agent", verified: false, resume: false,
    bin: {
      envVar: "GEMINI_BIN", name: "gemini",
      candidates: standardCandidates("gemini"),
    },
    build: ({ prompt, cwd, model, addDirs, autoApprove }) => {
      const args = ["-p", prompt, "-o", "json"];
      if (model) args.push("-m", model);
      const dirs = [cwd, ...(addDirs || [])].map((d) => path.resolve(d));
      if (dirs.length) args.push("--include-directories", dirs.join(","));
      if (autoApprove) args.push("--approval-mode", "yolo");
      return args;
    },
    output: { format: "json", response: "response", session: "sessionId" },
  },
  {
    // opencode. Flags below are read straight off `opencode run --help`.
    id: "opencode", label: "OpenCode", owner: "opencode-agent", verified: false,
    bin: {
      envVar: "OPENCODE_BIN", name: "opencode",
      candidates: standardCandidates("opencode"),
    },
    modelHint: "provider/model, e.g. anthropic/claude-sonnet-5",
    build: ({ prompt, cwd, model, autoApprove, resume }) => {
      const args = ["run", prompt, "--format", "json", "--dir", path.resolve(cwd)];
      if (resume) args.push("--session", resume);
      if (model) args.push("--model", model);
      if (autoApprove) args.push("--dangerously-skip-permissions");
      return args;
    },
    output: { format: "jsonl", response: "text", session: "sessionID" },
  },
];

const dig = (obj, dotted) =>
  dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Turn a spec's declarative `output` block into the same shape the hand-written parsers return. */
function declarativeParse(spec, id, pid) {
  let raw;
  try {
    raw = fs.readFileSync(outPath(id), "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  const { format, response, session, usage = "usage" } = spec.output;

  if (format === "text") {
    return { status: "SUCCESS", response: raw.trim(), conversation_id: null, usage: undefined };
  }

  if (format === "json") {
    const start = raw.indexOf("{");
    if (start === -1) return null;
    let payload;
    try {
      payload = JSON.parse(raw.slice(start));
    } catch {
      return null; // still being written; try again on the next poll
    }
    const text = dig(payload, response);
    if (text === undefined) return null;
    return {
      status: payload.is_error || payload.error ? "FAILURE" : "SUCCESS",
      response: typeof text === "string" ? text : JSON.stringify(text),
      conversation_id: session ? dig(payload, session) ?? null : null,
      usage: dig(payload, usage),
    };
  }

  // jsonl: unlike the "json" branch above, each line is independently valid
  // JSON the moment it's flushed, so a half-written FILE never fails to
  // parse the way a half-written single object does -- there is no free
  // "still running" signal here. A backend that emits progress events
  // carrying the same response field as its final answer (a plausible shape
  // for e.g. codex's per-turn messages) would otherwise have its latest
  // in-progress line mistaken for the finished result, which reap() then
  // trusts to release locks and reset presence while the worker is still
  // actively running. Require the process to have actually exited before
  // treating any of this as final -- if it hasn't, that's "still running,"
  // not "done," no matter how good the last line looks.
  if (pid != null && isAlive(pid)) return null;

  let last = null;
  let sessionId = null;
  let usageVal;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    let evt;
    try {
      evt = JSON.parse(t);
    } catch {
      continue; // a half-written trailing line is normal mid-run
    }
    const text = dig(evt, response);
    if (typeof text === "string" && text) last = text;
    if (session) sessionId = dig(evt, session) ?? sessionId;
    usageVal = dig(evt, usage) ?? usageVal;
  }
  if (last === null) return null;
  return { status: "SUCCESS", response: last, conversation_id: sessionId, usage: usageVal };
}

/**
 * User-defined backends, merged over the built-ins by id. Same shape, minus
 * the JS callbacks -- a JSON file can't carry a `build` function, so it
 * declares flags instead and buildFromFlags() assembles the argv.
 */
export function userBackendsPath() {
  return path.join(stateDir(), "backends.json");
}

function buildFromFlags(spec) {
  return (opts) => {
    const f = spec.flags || {};
    const args = [];
    for (const a of spec.args || []) {
      if (a === "{prompt}") args.push(opts.prompt);
      else if (a === "{cwd}") args.push(path.resolve(opts.cwd));
      else args.push(a);
    }
    if (!(spec.args || []).includes("{prompt}")) args.push(opts.prompt);
    if (f.cwd) args.push(f.cwd, path.resolve(opts.cwd));
    if (f.model && opts.model) args.push(f.model, opts.model);
    if (f.resume && opts.resume) args.push(f.resume, opts.resume);
    if (opts.autoApprove) args.push(...(spec.autoApprove || []));
    for (const d of opts.addDirs || []) if (f.addDir) args.push(f.addDir, path.resolve(d));
    return args;
  };
}

export function loadUserBackends() {
  let raw;
  try {
    raw = fs.readFileSync(userBackendsPath(), "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Loud, not silent: a typo here would otherwise just make a backend
    // quietly not exist, which is a miserable thing to debug.
    throw new Error(`${userBackendsPath()} is not valid JSON (${e.message})`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed.backends || [];
  return list
    .filter((s) => s && s.id)
    .map((s) => ({
      ...s,
      label: s.label || s.id,
      owner: s.owner || `${s.id}-agent`,
      verified: false,
      userDefined: true,
      bin: typeof s.bin === "string" ? { name: s.bin, envVar: `${s.id.toUpperCase()}_BIN` } : s.bin,
      build: buildFromFlags(s),
      output: s.output || { format: "text" },
    }));
}

/** Built-ins with any user overrides applied, keyed by tool prefix. */
export function loadBackends() {
  const byId = new Map(BUILTIN.map((s) => [s.id, s]));
  for (const u of loadUserBackends()) {
    const base = byId.get(u.id);
    byId.set(u.id, base ? { ...base, ...u } : u);
  }
  return [...byId.values()].map((spec) => ({
    ...spec,
    prefix: spec.prefix || spec.id,
    resume: spec.resume !== false,
    findBin: spec.bin?.find
      ? spec.bin.find
      : ({ required = true } = {}) =>
          findBinary({
            envVar: spec.bin?.envVar || `${spec.id.toUpperCase()}_BIN`,
            binName: spec.bin?.name || spec.id,
            candidates: spec.bin?.candidates || [],
            label: `${spec.label} CLI (${spec.bin?.name || spec.id})`,
            required,
          }),
    readResult: spec.parse ? spec.parse : (id, pid) => declarativeParse(spec, id, pid),
    readStderr: spec.readStderr || readStderr,
  }));
}

/**
 * Launch a backend detached, output streaming straight to disk. Detaching is
 * what lets a long job outlive this server; status is recovered later from
 * the run files and the pid, not from a held child handle.
 */
export function spawnBackend(spec, id, prompt, opts = {}) {
  // autoApprove defaults on, matching what the per-backend spawn functions
  // used to do -- a follow-up passes only cwd and the session id, and
  // dropping to interactive approval there would just hang the job forever.
  const args = spec.build({ autoApprove: true, ...opts, prompt });
  ensureDirs();
  fs.writeFileSync(promptPath(id), prompt);
  const out = fs.openSync(outPath(id), "w");
  const err = fs.openSync(errPath(id), "w");
  // findBin()/launchSpec() run AFTER the fds are open, and can throw (binary
  // resolution failing here despite the earlier findBin() check callers
  // already did -- a rare TOCTOU, but not impossible). Without the
  // try/finally, that throw skips both closeSync calls below and leaks the
  // two fds for the life of this server process.
  try {
    const launch = launchSpec(spec.findBin(), args);
    const child = spawn(launch.file, launch.args, {
      cwd: opts.cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err],
      ...launch.options,
    });
    // Detached and unref'd, so nothing else observes this child -- without a
    // listener a post-spawn failure emits an unhandled 'error' that kills this
    // process. reap()'s isAlive(pid) check already handles a dead pid.
    child.on("error", () => {});
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}
