/**
 * Knowing when a backend can't take work right now.
 *
 * Two ways to find out, and the cheap one matters most:
 *
 *  1. After the fact -- a task failed, and its stderr says "rate limit" rather
 *     than anything about the code. Without telling those apart, a delegator
 *     reads "failed", assumes a bad brief, and re-delegates into the same wall.
 *     That retry loop is the expensive failure mode this file exists to stop.
 *  2. Before the fact -- some CLIs cache their own usage standing locally, so
 *     an exhausted backend can be caught before a process is even spawned.
 *
 * Everything here is opt-in cost: nothing is read unless a delegation is about
 * to happen or a task actually failed, and nothing lands in a tool response
 * unless a backend is genuinely limited.
 */

import fs from "node:fs";
import path from "node:path";
import { hostHome } from "./store.js";

/**
 * Failure text that means "this backend is out of capacity", not "your task
 * was wrong". Deliberately generic -- every provider words it differently and
 * changes the wording over time, so these match the phrases that have stayed
 * stable across all of them rather than any one CLI's exact string.
 */
const LIMIT_PATTERNS = [
  /rate[ _-]?limit/i,
  /usage limit reached/i,
  /\blimit reached\b/i,
  /quota (?:exceeded|exhausted|reached)/i,
  /out of (?:credits|quota|tokens)/i,
  /insufficient (?:credits|quota|balance)/i,
  /too many requests/i,
  /\b429\b/,
];

/** Can't work for a different reason: not signed in, plan ineligible, no access. */
const AUTH_PATTERNS = [
  /ineligible/i,
  /not authenticated/i,
  /unauthorized/i,
  /\b401\b/,
  /please (?:log ?in|sign ?in|authenticate)/i,
  /no longer supported for/i,
];

/** Pull a reset time out of the message if one is quoted, in any of the usual shapes. */
function resetsAtFrom(text) {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})/);
  if (iso) return iso[0];
  // Claude Code has emitted "Claude AI usage limit reached|<epoch>".
  const epoch = text.match(/limit reached\|(\d{10,13})/i);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  return null;
}

/**
 * Decide whether a failed task failed because the backend is unavailable
 * rather than because the work was bad. Returns null for ordinary failures,
 * which is the common case -- callers should treat null as "a normal error".
 */
export function classifyFailure(text) {
  if (!text || typeof text !== "string") return null;
  const sample = text.slice(-4000); // errors land at the end of a run
  const kind = LIMIT_PATTERNS.some((r) => r.test(sample))
    ? "limit"
    : AUTH_PATTERNS.some((r) => r.test(sample))
      ? "auth"
      : null;
  if (!kind) return null;
  const line = sample.split(/\r?\n/).find((l) => [...LIMIT_PATTERNS, ...AUTH_PATTERNS].some((r) => r.test(l)));
  return {
    kind,
    resets_at: kind === "limit" ? resetsAtFrom(sample) : null,
    // One line, not the whole stderr: enough to act on, cheap to carry.
    detail: (line || "").trim().slice(0, 180),
  };
}

/**
 * Where a backend keeps its own usage standing on disk, if it keeps one at
 * all. Only Claude Code is known to -- `~/.claude.json` caches the same
 * percentages the CLI shows itself. Everything else returns null, and the
 * only cost of that is falling back to detection-after-failure.
 */
const USAGE_SOURCES = {
  claude: () => path.join(hostHome(), ".claude.json"),
};

const usageCache = new Map(); // file -> { mtimeMs, value }

export function localUsage(specId) {
  const locate = USAGE_SOURCES[specId];
  if (!locate) return null;
  const file = locate();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  // Re-parse only when the file actually changed: it is ~100KB and a
  // delegation shouldn't pay for that twice in a row for no reason.
  const hit = usageCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value;

  let value = null;
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")).cachedUsageUtilization;
    const active = (cached?.utilization?.limits || []).filter((l) => l.is_active !== false);
    // The tightest active window is the one that will actually stop the work.
    const worst = active.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
    if (worst) {
      value = {
        percent: worst.percent ?? null,
        // Carried so isExhausted() has a second, self-describing opinion --
        // see the reasoning there.
        severity: worst.severity ?? null,
        resets_at: worst.resets_at ?? null,
        window: worst.kind || null,
      };
    }
  } catch {
    value = null; // unreadable or a shape we don't know: just don't pre-check
  }
  usageCache.set(file, { mtimeMs: stat.mtimeMs, value });
  return value;
}

/** At/over this, treat the backend as spent rather than spawning into a wall. */
export const EXHAUSTED_PERCENT = 100;

/**
 * Is this backend actually out of capacity?
 *
 * `percent` is consumption, not headroom -- the field is named `utilization`,
 * it sits beside separate `used_dollars`/`remaining_dollars` siblings, and 98
 * carries severity "critical" while 64 carries "normal". But that reading is
 * the kind of thing that's easy to have backwards, and getting it backwards
 * would refuse work to a *fully available* backend, which is a far worse
 * failure than missing a real limit. So severity gets a veto: whatever the
 * number says, a window the provider itself calls "normal" is not exhausted.
 */
export function isExhausted(usage) {
  if (!usage || typeof usage.percent !== "number") return false;
  if (usage.percent < EXHAUSTED_PERCENT) return false;
  if (usage.severity && String(usage.severity).toLowerCase() === "normal") return false;
  return !isExpired(usage);
}

export function isExpired(entry) {
  return Boolean(entry?.resets_at) && Date.parse(entry.resets_at) <= Date.now();
}

/** Human-ish "in 42m" for a reset time, so a caller can decide whether waiting is sane. */
export function untilReset(resetsAt) {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`;
}
