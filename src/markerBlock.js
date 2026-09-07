/**
 * Robust editing of a marker-delimited managed block inside an otherwise
 * hand-written text file (~/.claude/CLAUDE.md and friends).
 *
 * Pure -- no I/O. The tricky parts, each of which broke a real file in review:
 *   - a torn or hand-mangled block (BEGIN with no END) must never be "repaired"
 *     by appending a second block; that turns one bad state into silent data
 *     loss on the next write.
 *   - the markers must not match when they appear inside a fenced code example
 *     (someone pasting this project's own README into their rules file).
 *   - duplicate blocks (copy/paste, a merge) must all be reconciled, not just
 *     the first one the regex happens to find.
 *   - CRLF files stay CRLF; `$&` / `$1` in the body stay literal.
 */

export class MalformedBlockError extends Error {
  constructor(message) {
    super(message);
    this.name = "MalformedBlockError";
  }
}

/** Majority line ending in `text`; `\n` when it is a toss-up or there are none. */
export function detectEol(text = "") {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Byte ranges covered by fenced code blocks (``` or ~~~), so markers inside an
 * example are left alone. A fence opened and never closed runs to end of text
 * -- same as a Markdown renderer treats it.
 */
export function fenceRanges(text = "") {
  const ranges = [];
  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
  let open = null;
  let m;
  while ((m = fence.exec(text))) {
    if (!open) {
      open = { start: m.index, marker: m[1][0], len: m[1].length };
    } else if (m[1][0] === open.marker && m[1].length >= open.len) {
      ranges.push([open.start, m.index + m[0].length]);
      open = null;
    }
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

const inRanges = (idx, ranges) => ranges.some(([s, e]) => idx >= s && idx < e);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A line-anchored, non-global matcher for one literal marker line. */
function markerRe(marker) {
  return new RegExp(`^[ \\t]*${escapeRe(marker)}[ \\t]*$`, "gm");
}

function markerOffsets(text, marker, fences) {
  const re = markerRe(marker);
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    if (!inRanges(m.index, fences)) out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Every well-formed managed block in `text` (outside fences), as `{start,end}`
 * offsets spanning BEGIN line through END line. Throws MalformedBlockError if
 * the BEGIN and END markers do not pair up cleanly (unequal counts, or an END
 * before its BEGIN) -- the caller must stop, not guess.
 */
export function findBlocks(text, begin, end) {
  const fences = fenceRanges(text);
  const begins = markerOffsets(text, begin, fences);
  const ends = markerOffsets(text, end, fences);
  if (begins.length !== ends.length) {
    throw new MalformedBlockError(
      `unbalanced antigravity-mcp markers (${begins.length} BEGIN, ${ends.length} END) -- ` +
        `fix the file by hand (the block is delimited by "${begin}" and "${end}"), then re-run`
    );
  }
  const blocks = [];
  for (let i = 0; i < begins.length; i++) {
    const b = begins[i];
    const e = ends[i];
    if (e.start < b.start) {
      throw new MalformedBlockError(
        "antigravity-mcp END marker appears before its BEGIN -- fix the file by hand, then re-run"
      );
    }
    blocks.push({ start: b.start, end: e.end });
  }
  return blocks;
}

export function hasBlock(text = "", { begin, end }) {
  try {
    return findBlocks(text, begin, end).length > 0;
  } catch {
    return false; // malformed: not a usable block
  }
}

/** `{ begin, end }` marker counts outside fences -- for a health check that wants to report imbalance rather than throw. */
export function countMarkers(text = "", { begin, end }) {
  const fences = fenceRanges(text);
  return {
    begin: markerOffsets(text, begin, fences).length,
    end: markerOffsets(text, end, fences).length,
  };
}

/**
 * Return `text` with exactly one managed block present and current:
 *   - the first existing block is replaced in place (surrounding bytes intact),
 *   - any further blocks are removed,
 *   - if there were none, the block is appended after one blank line.
 * Throws MalformedBlockError on a torn block -- never appends over the top of one.
 */
export function upsertBlock(text = "", { begin, end, body }) {
  const eol = detectEol(text);
  const block = `${begin}${eol}${String(body).trim().replace(/\r?\n/g, eol)}${eol}${end}`;
  const blocks = findBlocks(text, begin, end); // throws if malformed

  if (blocks.length === 0) {
    const base = text.replace(/\s+$/, "");
    return (base ? base + eol + eol : "") + block + eol;
  }

  // Rebuild: keep everything, swap the first block's span for `block`, drop the rest.
  let out = "";
  let cursor = 0;
  blocks.forEach((b, i) => {
    out += text.slice(cursor, b.start);
    if (i === 0) {
      out += block;
    } else {
      // Also swallow a blank-line gap left in front of a duplicate.
      out = out.replace(/(\r?\n){2,}$/, eol + eol);
    }
    cursor = b.end;
  });
  out += text.slice(cursor);
  return tidyGaps(out, eol);
}

/** Return `text` with every managed block removed and the gap it left tidied. */
export function stripBlock(text = "", { begin, end }) {
  let blocks;
  try {
    blocks = findBlocks(text, begin, end);
  } catch {
    // Malformed: fall back to removing whole lines that are our markers, so a
    // torn block can still be cleared out rather than left forever.
    const fences = fenceRanges(text);
    const kill = [...markerOffsets(text, begin, fences), ...markerOffsets(text, end, fences)]
      .sort((a, b) => b.start - a.start);
    let out = text;
    for (const k of kill) out = out.slice(0, k.start) + out.slice(k.end);
    return tidyGaps(out, detectEol(text));
  }
  if (!blocks.length) return text;
  let out = "";
  let cursor = 0;
  for (const b of blocks) {
    out += text.slice(cursor, b.start);
    cursor = b.end;
  }
  out += text.slice(cursor);
  return tidyGaps(out, detectEol(text));
}

/** Collapse a 3+ newline run (the hole a removed block leaves) to one blank line; trim trailing ws and leading blank lines. */
function tidyGaps(text, eol) {
  return text
    .replace(/(\r?\n[ \t]*){3,}/g, eol + eol)
    .replace(/^(\r?\n)+/, "")
    .replace(/\s+$/, "") + (text.trim() ? eol : "");
}
