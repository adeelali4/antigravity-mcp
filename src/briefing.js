/**
 * The brief every delegated agent actually receives: the caller's task text,
 * wrapped in project/contract framing and a working agreement.
 *
 * Pulled out on its own because it has no dependency on anything else in
 * server.js (no board access, no AGENT identity) but was only ever used
 * there -- so the CLI delegation path (commands.js) built its own raw,
 * unwrapped prompt instead, meaning a delegate started via
 * `antigravity-mcp-server delegate` got none of this framing that an
 * MCP-tool delegate always gets. One implementation, both callers.
 */

/**
 * Prepended to every delegated brief. Each line below is here because its
 * absence costs real tokens or real rework: a delegate that gold-plates a
 * one-file fix burns a whole session on work nobody asked for, one that
 * reports "done" without checking sends the delegator off to verify from
 * scratch, and one that stops silently strands the task with no way to pick
 * it up. Kept deliberately short -- it is paid on every single delegation,
 * and padding it would contradict the last rule in it.
 */
const WORKING_AGREEMENT =
  `HOW TO WORK THIS TASK\n` +
  `- Scope: do what was asked and stop. Spot something else worth doing? Report it, don't fix it.\n` +
  `- Decide and act: the files listed as yours are yours to edit. Don't stop to ask permission.\n` +
  `- Verify before you claim done: run the build, test, or command that proves it. Unchecked is not done.\n` +
  `- Stuck or out of room? Say what you did, what's left, and what you learned, so it can be handed off.\n` +
  `- Your final message IS the handoff: what changed, where, what to check. No narration, no transcript.\n`;

export function briefingFor(owner, cwd, claim, prompt) {
  return (
    `PROJECT ROOT: ${cwd}\n` +
    `Do all work inside that directory using absolute paths. Do not create a scratch project elsewhere.\n` +
    `You are the '${owner}' agent working in parallel with another AI agent on this project. ` +
    `It has assigned you the task below and is working on other parts of the codebase at the same time.\n` +
    (claim.length ? `PATHS RESERVED FOR YOU: ${claim.join(", ")}\n` : "") +
    `If the coordination MCP server is available to you, call coop_status first and ` +
    `claim_paths before editing; stay off paths another agent holds.\n\n` +
    `${WORKING_AGREEMENT}\n--- TASK ---\n${prompt}`
  );
}
