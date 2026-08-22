/** `antigravity-mcp-server reset` — direct way to reset the board from the CLI. */

import { resetBoard, read, logEvent } from "./store.js";

export async function reset({ yes = false }) {
  // A board too corrupt to parse is exactly when someone reaches for this
  // command, so it must not be the one thing that can't run then. Counts are
  // only for the summary; not having them is no reason to refuse the wipe.
  let b;
  try {
    b = read();
  } catch {
    b = { tasks: [], locks: [], notes: [], unreadable: true };
  }
  const summary = {
    tasks: b.tasks.length,
    locks: b.locks.length,
    notes: b.notes.length,
    ...(b.unreadable && { unreadable: true }),
  };

  if (!yes) {
    return { state: "dry-run", summary };
  }

  // resetBoard, not mutate: mutate reads the existing board first, which is
  // precisely what fails when the board is the thing that's broken.
  await resetBoard((b) => logEvent(b, "cli", "board.reset", "cleared via CLI"));

  return { state: "success", summary };
}

export function printReset(res) {
  console.log("");
  if (res.state === "dry-run") {
    console.log(`  - Running without --yes does not change anything.`);
    console.log(`    A reset would clear: ${res.summary.tasks} task(s), ${res.summary.locks} lock(s), ${res.summary.notes} note(s).`);
    console.log(`    Run \`antigravity-mcp-server reset --yes\` to actually wipe the board.\n`);
    return false;
  } else if (res.state === "success") {
    console.log(`  + Board reset complete.`);
    console.log(`    Cleared ${res.summary.tasks} task(s), ${res.summary.locks} lock(s), and ${res.summary.notes} note(s).\n`);
    console.log("  IMPORTANT: You must now restart your AI tools/sessions:");
    console.log("  1. Close and reopen (or otherwise restart) any active AI sessions.");
    console.log("     An already-running session is still holding its old in-memory connection");
    console.log("     and will recreate stale state on the board if it isn't restarted.");
    console.log("  2. Check for and close any duplicate/leftover background sessions.");
    console.log("     If a hidden background process next touches presence, it will");
    console.log("     repopulate stale data.\n");
    return false;
  }
}
