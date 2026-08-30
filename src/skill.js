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
 * It is delimited by the two markers below and is idempotent: re-running `init`
 * replaces whatever is between them, and `stripSkillBlock` removes it cleanly.
 */

export const SKILL_MARK_BEGIN =
  "<!-- BEGIN antigravity-mcp-server (managed by `antigravity-mcp-server init`) -->";
export const SKILL_MARK_END = "<!-- END antigravity-mcp-server -->";

/**
 * Kept deliberately compact -- it is loaded into context on every single run of
 * every CLI it is written to. The wording mirrors the MCP `instructions` string
 * in server.js and the WORKING_AGREEMENT in briefing.js, which are already tuned.
 */
export const SKILL_BODY = `## antigravity-mcp-server

\`antigravity-mcp-server\` is an MCP server available in this environment. It runs other
AI coding CLIs (Claude Code, GitHub Copilot, Codex, Gemini, Cursor, OpenCode, Antigravity)
on the same repository in parallel and coordinates them so no two overwrite each other.

**Delegate work.** Each installed backend exposes a lane of tools: \`<backend>_delegate\`
(starts a detached task, returns a task_id at once), \`<backend>_task_status\`,
\`<backend>_task_wait\`, \`<backend>_followup\` (continue in the same session),
\`<backend>_cancel\`. \`task_reassign\` replays a brief on another backend at no token cost.
Lane prefixes: \`ag_*\` (Antigravity), \`copilot_*\`, \`claude_*\`, \`codex_*\`, \`gemini_*\`,
\`cursor_*\`, \`opencode_*\`.

**Coordinate.** Call \`coop_status\` before you start editing. \`claim_paths\` to reserve
files or directories before touching them; \`release_paths\` when done. Never edit a path
another agent holds -- \`notes_send\` them instead. \`check_paths\` tests without claiming.

**Brief a delegate fully.** It starts cold and cannot see your conversation. Give it the
goal as an outcome, the project root as an absolute path, the conventions actually in use,
the files it owns, and what NOT to touch. When you split one feature, spell out the exact
contract: endpoints, payload shapes, prop names, filenames.

**Verify.** Check a delegate's actual diff before trusting its "done" -- a confident
summary is not evidence.

**Durable memory.** \`brain_write\` / \`brain_read\` / \`brain_search\` persist notes across
sessions and board resets.

Run \`antigravity-mcp-server ui\` for a live dashboard of every agent. This block is managed:
re-run \`antigravity-mcp-server init\` to refresh it, or \`antigravity-mcp-server deinit\` to
remove it (also delete it by hand if the package is already gone).`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BLOCK_RE = new RegExp(
  `${escapeRe(SKILL_MARK_BEGIN)}[\\s\\S]*?${escapeRe(SKILL_MARK_END)}`
);

/** The full managed block, markers included, for a given body. */
export function skillBlock(body = SKILL_BODY) {
  return `${SKILL_MARK_BEGIN}\n${body.trim()}\n${SKILL_MARK_END}`;
}

/**
 * Return `existingText` with the managed block inserted or replaced in place.
 * Pure -- no I/O. If the file already has a block it is swapped where it sits so
 * the user's own ordering is preserved; otherwise the block is appended after a
 * blank line.
 */
export function upsertSkillBlock(existingText = "", body = SKILL_BODY) {
  const block = skillBlock(body);
  if (BLOCK_RE.test(existingText)) {
    return existingText.replace(BLOCK_RE, block);
  }
  const base = existingText.replace(/\s+$/, "");
  return (base ? `${base}\n\n` : "") + block + "\n";
}

/** Return `existingText` with the managed block (and its trailing gap) removed. */
export function stripSkillBlock(existingText = "") {
  if (!BLOCK_RE.test(existingText)) return existingText;
  return existingText.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "").replace(/\s+$/, "") + "\n";
}

/** Does this text already carry the managed block? */
export function hasSkillBlock(existingText = "") {
  return BLOCK_RE.test(existingText);
}
