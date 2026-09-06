/**
 * The persistent "skill" block `init` writes into every AI CLI's global
 * instructions file (~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md, ~/.codex/AGENTS.md,
 * and so on).
 *
 * Registering the MCP server makes the tools callable, but the agent still only
 * learns what they are for from the short `instructions` string the SDK delivers
 * at connect time -- easy to lose in a long session, and it names no tools. This
 * block lives in the file the CLI loads on every run, so the knowledge sticks.
 *
 * All the fiddly text handling (fenced-example safety, torn blocks, duplicates,
 * CRLF) lives in markerBlock.js; this file is just the markers, the body, and
 * thin wrappers that bind them.
 */

import {
  upsertBlock,
  stripBlock,
  hasBlock,
  countMarkers,
  MalformedBlockError,
} from "./markerBlock.js";

export { MalformedBlockError };

export const SKILL_MARK_BEGIN =
  "<!-- BEGIN antigravity-mcp-server (managed by `antigravity-mcp-server init`) -->";
export const SKILL_MARK_END = "<!-- END antigravity-mcp-server -->";

const MARKERS = { begin: SKILL_MARK_BEGIN, end: SKILL_MARK_END };

/**
 * Kept compact -- it is loaded into context on every run of every CLI it is
 * written to -- but it must carry what only this block can say: the tool names,
 * and the coordination rules that a long session drops from the SDK
 * `instructions` string. Overlaps deliberately kept minimal with the
 * WORKING_AGREEMENT in briefing.js (which delegates receive with every task).
 */
export const SKILL_BODY = `## antigravity-mcp-server

\`antigravity-mcp-server\` is an MCP server in this environment. It runs other AI coding
CLIs (Claude Code, GitHub Copilot, Codex, Gemini, Cursor, OpenCode, Antigravity) on the
same repository at once and coordinates them so no two overwrite each other.

**Coordinate before you edit.** Call \`coop_status\` first. \`claim_paths\` to reserve the
files or directories you are about to change, \`release_paths\` when done. Never edit a
path another agent holds -- \`notes_send\` them and wait, or work elsewhere. \`check_paths\`
tests without claiming. \`presence_set\` announces what you are doing; \`notes_read\` checks
your inbox.

**Delegate work.** Each installed backend has a lane: \`<backend>_delegate\` starts a
detached task and returns a task_id at once; then \`<backend>_task_status\` /
\`<backend>_task_wait\` / \`<backend>_followup\` (same session) / \`<backend>_cancel\`.
Prefixes are \`ag_\` (Antigravity), \`copilot_\`, \`claude_\`, \`codex_\`, \`gemini_\`,
\`cursor_\`, \`opencode_\` -- only the backends you actually have installed are registered.
If a backend hits its usage limit the task reroutes to another on its own; the brief is
replayed from disk, so \`task_reassign\` and failover cost no tokens.

**A delegate starts cold.** It cannot see your conversation. Brief it with the outcome,
the project root as an absolute path, the conventions in use, the files it owns, and what
NOT to touch. Check its actual diff before you trust its "done".

**Track work on the board.** \`board_post\` hands out a task without running it;
\`board_update\` moves it to \`running\` when someone picks it up and \`done\` when it is
finished, so an assignment can't be silently missed. \`board_list\` shows the board.

**Durable memory.** \`brain_write\` / \`brain_read\` / \`brain_search\` persist notes across
sessions and board resets.

Run \`antigravity-mcp-server ui\` for a live dashboard of every agent. This block is managed:
re-run \`antigravity-mcp-server init\` to refresh it, or \`antigravity-mcp-server deinit\` to
remove it (also delete it by hand if the package is already gone).`;

/** The full managed block, markers included, for a given body (LF; the writer re-flows to the file's EOL). */
export function skillBlock(body = SKILL_BODY) {
  return `${SKILL_MARK_BEGIN}\n${String(body).trim()}\n${SKILL_MARK_END}`;
}

/**
 * `existingText` with the skill block inserted or refreshed in place.
 * Throws MalformedBlockError if the file has a torn block -- the caller reports
 * that as an error rather than writing over the user's content.
 */
export function upsertSkillBlock(existingText = "", body = SKILL_BODY) {
  return upsertBlock(existingText, { ...MARKERS, body });
}

/** `existingText` with every skill block removed and the gap tidied. */
export function stripSkillBlock(existingText = "") {
  return stripBlock(existingText, MARKERS);
}

/** Does this text carry a well-formed skill block? */
export function hasSkillBlock(existingText = "") {
  return hasBlock(existingText, MARKERS);
}

/**
 * `{ ok, begin, end }` -- whether the BEGIN/END markers pair up. `ok: false`
 * means a torn or duplicated block that needs a human, which `doctor` surfaces
 * instead of reporting green.
 */
export function skillMarkersBalanced(existingText = "") {
  const c = countMarkers(existingText, MARKERS);
  return { ok: c.begin === c.end, ...c };
}
