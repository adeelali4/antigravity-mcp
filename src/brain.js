/**
 * The "brain": durable, cross-project memory that survives a board reset.
 *
 * The shared board (store.js) is deliberately ephemeral -- pruned finished
 * tasks, pruned read notes, presence that expires after a week. That's the
 * right lifecycle for coordination state, but it means anything worth
 * remembering long-term (a decision, a gotcha, "here's where this stands")
 * only ever lived in a presence detail string until it aged out. The actual
 * goal isn't just a durable log -- it's that a BRAND NEW session, with none
 * of a prior session's context, can find out where a project currently
 * stands without inferring it from history. See writeBrainNote()'s "status"
 * section for the concrete mechanism.
 *
 * Storage: ANTIGRAVITY_MCP_BRAIN if set, else <stateDir()>/brain/ -- always
 * available, zero dependency. Plain markdown files, one per project. That
 * folder happens to also be an openable Obsidian vault (any folder is, with
 * "Open folder as vault" -- no pre-existing .obsidian/ config needed) or
 * readable by any other markdown tool, purely as an incidental property of
 * being plain files -- this module never detects, prefers, or writes
 * anywhere else.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir, norm, createLock, readFileRetrying, writeFileAtomic } from "./store.js";

export function brainRoot() {
  return process.env.ANTIGRAVITY_MCP_BRAIN
    ? path.resolve(process.env.ANTIGRAVITY_MCP_BRAIN)
    : path.join(stateDir(), "brain");
}

function projectsDir() {
  return path.join(brainRoot(), "Projects");
}

function indexPath() {
  return path.join(brainRoot(), "MEMORY.md");
}

function lockPath() {
  return path.join(brainRoot(), ".brain.lock");
}

/**
 * A stable, filesystem- and Obsidian-safe id for one project, built from its
 * cwd. Not just the folder's basename: "backend", "api" and "web" are some
 * of the most common repo/package names there are, and a broad audience of
 * users running this across many different projects will collide on them
 * constantly if the slug is only the basename -- silently merging two
 * unrelated projects' memory into one file. The hash suffix keeps that from
 * ever happening while the basename prefix keeps the filename readable.
 */
// Capped well short of Windows' ~260-char MAX_PATH: brainRoot() + "/Projects/"
// + base + "-" + 8 hex chars + ".md" all has to fit, and an unusually long
// project directory name would otherwise make every write to it throw
// ENAMETOOLONG/ENOENT. The hash is computed from the FULL normalized path
// before truncation, so collision-safety is unaffected by cutting the base.
const MAX_SLUG_BASE_CHARS = 40;

export function projectSlug(cwd) {
  const normalized = norm(cwd);
  const base = (path.basename(normalized).replace(/[^a-zA-Z0-9_-]+/g, "-") || "project").slice(0, MAX_SLUG_BASE_CHARS);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

// norm()'s case-folding exists purely for lock/hash stability ("Windows
// drive-letter casing can't defeat a lock" -- see store.js), not for
// display. Reusing it for human-facing text would silently lowercase a real
// folder name (MyApp -> myapp) everywhere a person or agent reads it, even
// though the slug's hash already disambiguates correctly by full path
// underneath. These two stay separate from projectSlug() on purpose.
function displayName(cwd) {
  return path.basename(path.resolve(cwd)) || "project";
}
function displayPath(cwd) {
  return path.resolve(cwd);
}

function projectFile(cwd) {
  return path.join(projectsDir(), `${projectSlug(cwd)}.md`);
}

function ensureRoot() {
  fs.mkdirSync(projectsDir(), { recursive: true });
}

const STATUS_HEADING = "## Current Status";
const DECISIONS_HEADING = "## Key Decisions";
const LOG_HEADING = "## Log";
const STATUS_COMMENT =
  "<!-- kept current by whichever agent last updated it -- edit freely, the next write replaces this section -->";

function newProjectFile(cwd) {
  const name = displayName(cwd);
  const now = new Date().toISOString();
  return (
    `---\n` +
    `project: ${name}\n` +
    `path: ${displayPath(cwd)}\n` +
    `created: ${now}\n` +
    `updated: ${now}\n` +
    `---\n` +
    `# ${name}\n\n` +
    `${STATUS_HEADING}\n` +
    `${STATUS_COMMENT}\n\n\n` +
    `${DECISIONS_HEADING}\n\n` +
    `${LOG_HEADING}\n`
  );
}

/** Bump the frontmatter `updated:` line in place -- the one field this ever overwrites. */
function touchUpdated(content) {
  const now = new Date().toISOString();
  if (/^updated: .*$/m.test(content)) {
    return content.replace(/^updated: .*$/m, `updated: ${now}`);
  }
  return content; // no frontmatter (a hand-edited file, say) -- leave it alone
}

/** The line range of one `## Heading` section: [start, end) of its body, exclusive of the heading itself. */
function sectionRange(lines, heading) {
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) return null;
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { headingIdx, start: headingIdx + 1, end };
}

/**
 * Insert a new line at the end of one section, before the next `## ` heading
 * or end of file. Append-only by construction: this never touches any other
 * section, and never rewrites existing lines -- a human's own edits to this
 * file, or anything hand-added under a DIFFERENT heading, are never at risk
 * of being clobbered.
 */
function appendUnderHeading(content, heading, line) {
  const lines = content.split("\n");
  const range = sectionRange(lines, heading);
  if (!range) {
    // Heading doesn't exist (an older file, or a hand-edited one) -- add it
    // at the end rather than silently dropping the note.
    const sep = content.endsWith("\n") ? "" : "\n";
    return `${content}${sep}\n${heading}\n${line}\n`;
  }
  let insertAt = range.end;
  // Trim trailing blank lines within the section before appending, so
  // repeated writes don't accumulate blank padding.
  while (insertAt > range.start && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}

/**
 * Replace an entire section's body with `text`, keeping the heading (and, for
 * Current Status specifically, the explanatory comment line right after it)
 * in place. The one deliberate exception to append-only in this module:
 * "current status" is inherently a single value, not a growing history, and
 * a session with zero prior context needs the LATEST status, not a log of
 * every status that was ever true.
 */
function replaceUnderHeading(content, heading, text) {
  const lines = content.split("\n");
  const range = sectionRange(lines, heading);
  if (!range) {
    const sep = content.endsWith("\n") ? "" : "\n";
    return `${content}${sep}\n${heading}\n${text}\n`;
  }
  const keepComment = heading === STATUS_HEADING && lines[range.start]?.trim() === STATUS_COMMENT;
  const bodyStart = keepComment ? range.start + 1 : range.start;
  const kept = lines.slice(0, bodyStart);
  const rest = lines.slice(range.end);
  // A blank line before the next `## ` heading is what every other section
  // already has; range.end pointed straight at that heading (or past
  // whatever blank padding the ORIGINAL scaffold reserved there), so without
  // this the replaced section runs directly into "## Key Decisions" with no
  // separator. Only add one when there IS a next section -- not at EOF.
  const sep = rest.length && rest[0].trim() !== "" ? [""] : [];
  return [...kept, text, ...sep, ...rest].join("\n");
}

const MAX_NOTE_CHARS = 2000;

/**
 * Record something worth remembering about a project. Creates the project's
 * file and index entry if this is the first note for it.
 *
 * `section: "log"` (default) and `"decision"` append -- never overwrite or
 * truncate existing content. `section: "status"` REPLACES the Current
 * Status section instead: that's the answer to "where does this project
 * stand right now" for a session with no prior context, and a growing log
 * of every past status wouldn't serve that -- only the latest one would.
 */
export async function writeBrainNote({ cwd, note, agent, section = "log" }) {
  // Collapsed to one logical line, not just trimmed: log/decision entries are
  // markdown bullets (a real multi-line bullet needs continuation-indent
  // syntax this doesn't implement), and more importantly a note containing
  // its own "\n## something" line would, on a LATER read, be misread as a
  // real section boundary by sectionRange() -- the file's own structure
  // parses on exactly that pattern.
  const trimmed = String(note ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error("note must not be empty");
  const truncated = trimmed.length > MAX_NOTE_CHARS;
  const text = truncated
    ? `${trimmed.slice(0, MAX_NOTE_CHARS)} ...[truncated -- ${trimmed.length} chars total]...`
    : trimmed;
  ensureRoot();

  const lock = createLock(lockPath());
  await lock.acquire();
  try {
    const file = projectFile(cwd);
    // readFileRetrying (not a plain existsSync + readFileSync) so a transient
    // Windows file-sharing miss on an EXISTING file gets retried instead of
    // throwing straight out of a write, and null unambiguously means "no
    // file yet" (ENOENT) rather than "couldn't read it right now."
    const existing = readFileRetrying(file);
    const isNew = existing === null;
    let content = isNew ? newProjectFile(cwd) : existing;

    const stamp = `[${new Date().toISOString().replace("T", " ").slice(0, 16)}] [${agent || "agent"}]`;
    if (section === "status") {
      content = replaceUnderHeading(content, STATUS_HEADING, `${stamp} ${text}`);
    } else {
      const heading = section === "decision" ? DECISIONS_HEADING : LOG_HEADING;
      content = appendUnderHeading(content, heading, `- ${stamp} ${text}`);
    }
    content = touchUpdated(content);

    // Atomic (tmp + rename), not a direct writeFileSync: a crash or transient
    // I/O error mid-write must never leave this project's Log/Key Decisions
    // truncated -- those sections are supposed to be append-only in practice,
    // not just in the API.
    writeFileAtomic(file, content);
    if (isNew) updateIndex(cwd);
    return { project: displayName(cwd), slug: projectSlug(cwd), file, created: isNew, truncated };
  } finally {
    lock.release();
  }
}

/** Append (or leave alone, if already present) one line in MEMORY.md for this project. */
function updateIndex(cwd) {
  const slug = projectSlug(cwd);
  const name = displayName(cwd);
  const line = `- [[${slug}|${name}]] -- ${displayPath(cwd)}`;
  // readFileRetrying, not a blanket try/catch around readFileSync: the old
  // version treated ANY read failure -- including a transient EBUSY/EACCES
  // from an AV scanner or indexer, which is common on Windows -- as "the
  // index doesn't exist yet," then overwrote it with just this one line,
  // destroying every other project's entry. null here means genuinely
  // ENOENT; anything else propagates instead of pretending the file is gone.
  const existing = readFileRetrying(indexPath());
  const content = existing ?? `# Project Memory Index\n\nOne line per project. Full history in Projects/<slug>.md.\n\n`;
  if (content.includes(`[[${slug}|`)) return; // already indexed
  const sep = content.endsWith("\n") ? "" : "\n";
  writeFileAtomic(indexPath(), `${content}${sep}${line}\n`);
}

/** Full memory file for one project, or null if it has none yet. */
export function readBrainNote({ cwd }) {
  const file = projectFile(cwd);
  const content = readFileRetrying(file);
  if (content === null) return null;
  return { project: displayName(cwd), slug: projectSlug(cwd), content };
}

const PREVIEW_CHARS = 600;

/**
 * A small, bounded preview for ambient display (coop_status): current status
 * first (the direct answer to "where are we"), then the curated Key
 * Decisions section, then the last few Log lines -- not a raw head/tail of
 * the whole file. A head/tail dump of an append-only log is mostly the
 * OLDEST entries, exactly the ones least likely to still be relevant, and
 * this rides on a tool called on nearly every turn, so it has to stay small.
 * Returns null when there's nothing to show, so callers can omit the field
 * entirely rather than send an empty one.
 */
export function brainPreview(cwd, { logLines = 3 } = {}) {
  const note = readBrainNote({ cwd });
  if (!note) return null;

  const body = note.content.replace(/^---\n[\s\S]*?\n---\n/, ""); // strip frontmatter
  const status = sectionBody(body, STATUS_HEADING)
    .split("\n")
    .filter((l) => l.trim() && l.trim() !== STATUS_COMMENT)
    .join("\n")
    .trim();
  const decisions = sectionBody(body, DECISIONS_HEADING).trim();
  const log = sectionBody(body, LOG_HEADING)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .slice(-logLines);

  const parts = [];
  if (status) parts.push(`Status: ${status}`);
  if (decisions) parts.push(decisions);
  if (log.length) parts.push(log.join("\n"));
  if (!parts.length) return null;

  const text = parts.join("\n\n");
  return {
    project: note.project,
    preview: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}...` : text,
  };
}

function sectionBody(body, heading) {
  const lines = body.split("\n");
  const range = sectionRange(lines, heading);
  if (!range) return "";
  return lines.slice(range.start, range.end).join("\n");
}

const SEARCH_LIMIT = 20;
const SNIPPET_RADIUS = 80;

/**
 * Substring search over durable memory. Deliberately a plain case-insensitive
 * scan, not a real index -- the dataset here is a handful of markdown files
 * per user, not a corpus that needs one, and a dependency to search a few
 * hundred KB of text would cost more than it's worth.
 *
 * Scoped to one project by default (`cwd`), matching writeBrainNote()'s and
 * readBrainNote()'s own default scope -- being "in" a project shouldn't
 * surface another, unrelated project's notes unasked. Pass allProjects:true
 * to explicitly search everything this brain knows about.
 */
export function searchBrain(query, { limit = SEARCH_LIMIT, cwd, allProjects = false } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const needle = q.toLowerCase();

  let files = [];
  if (allProjects) {
    try {
      files = fs.readdirSync(projectsDir()).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
  } else {
    const file = `${projectSlug(cwd)}.md`;
    files = fs.existsSync(path.join(projectsDir(), file)) ? [file] : [];
  }

  const hits = [];
  for (const f of files) {
    if (hits.length >= limit) break;
    // A search is best-effort across potentially many files: skip one that
    // fails to read (even after readFileRetrying's own retries) rather than
    // aborting the whole search over a single transient lock.
    let content;
    try {
      content = readFileRetrying(path.join(projectsDir(), f));
      if (content === null) continue;
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    let idx = lower.indexOf(needle);
    while (idx !== -1 && hits.length < limit) {
      const start = Math.max(0, idx - SNIPPET_RADIUS);
      const end = Math.min(content.length, idx + needle.length + SNIPPET_RADIUS);
      const snippet = (start > 0 ? "..." : "") + content.slice(start, end).replace(/\s+/g, " ").trim() + (end < content.length ? "..." : "");
      hits.push({ slug: f.replace(/\.md$/, ""), snippet });
      idx = lower.indexOf(needle, idx + needle.length);
    }
  }
  return hits;
}
