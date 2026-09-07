/**
 * Adversarial unit tests for new/changed modules:
 * 1. src/markerBlock.js (pure, no I/O)
 * 2. src/fileEdit.js (atomic, locked file editing)
 * 3. src/store.js prune() (board pruning on save)
 * 4. src/server.js coop_status (stale presence filtering & delta seq)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { assertSandboxed, setupSandbox } from "./sandbox.js";
import {
  detectEol,
  fenceRanges,
  countMarkers,
  findBlocks,
  hasBlock,
  upsertBlock,
  stripBlock,
  MalformedBlockError,
} from "../src/markerBlock.js";
import {
  firstBackup,
  detectIndent,
  editManagedFile,
  editJsonFile,
} from "../src/fileEdit.js";
import { mutate, read } from "../src/store.js";

const B = "<!-- BEGIN test-block -->";
const E = "<!-- END test-block -->";

export function runMarkerBlockTests(check) {
  // --- EOL edge cases ---
  check("detectEol empty string defaults to LF", detectEol("") === "\n");
  check("detectEol single newline defaults to LF", detectEol("\n") === "\n");
  check("detectEol 1-line no-newline string defaults to LF", detectEol("hello world") === "\n");
  check("detectEol pure LF detected", detectEol("foo\nbar\nbaz\n") === "\n");
  check("detectEol pure CRLF detected", detectEol("foo\r\nbar\r\nbaz\r\n") === "\r\n");
  check("detectEol mixed: majority CRLF", detectEol("a\r\nb\r\nc\n") === "\r\n");
  check("detectEol mixed: majority LF", detectEol("a\r\nb\nc\nd\n") === "\n");
  check("detectEol mixed: toss-up defaults to LF", detectEol("a\r\nb\n") === "\n");
  check("detectEol consecutive LFs counted accurately (no consumed adjacent newlines)", detectEol("\r\n\r\n\n\n\n") === "\n");

  // upsert into CRLF file must emit CRLF block
  const crlfSample = "Intro line 1\r\nIntro line 2\r\n";
  const crlfUpserted = upsertBlock(crlfSample, { begin: B, end: E, body: "body 1\nbody 2" });
  check(
    "upsertBlock into CRLF emits CRLF block without bare LFs",
    crlfUpserted.includes(`${B}\r\nbody 1\r\nbody 2\r\n${E}\r\n`) &&
      !/(^|[^\r])\n/.test(crlfUpserted.slice(crlfUpserted.indexOf(B)))
  );

  // stripBlock(upsertBlock(crlfText)) byte-identical round-trips
  const crlfCases = [
    ["single-line CRLF", "Only one line.\r\n"],
    ["multi-line CRLF", "Line 1\r\nLine 2\r\nLine 3\r\n"],
    ["markdown headings with blank lines", "# Title\r\n\r\nParagraph 1.\r\n\r\nParagraph 2.\r\n"],
    ["markdown list CRLF", "# Rules\r\n\r\n- Rule 1\r\n- Rule 2\r\n- Rule 3\r\n"],
  ];
  for (const [desc, text] of crlfCases) {
    const up = upsertBlock(text, { begin: B, end: E, body: "managed content" });
    const stripped = stripBlock(up, { begin: B, end: E });
    check(`stripBlock(upsertBlock(crlfText)) byte-identical: ${desc}`, stripped === text);
  }

  // --- Fenced code edge cases ---
  const backtickFence = "```markdown\n" + B + "\ninside backtick\n" + E + "\n```\n";
  check("fenced ```: hasBlock returns false for marker inside fence", !hasBlock(backtickFence, { begin: B, end: E }));
  check("fenced ```: stripBlock ignores markers inside fence", stripBlock(backtickFence, { begin: B, end: E }) === backtickFence);
  const backtickUpsert = upsertBlock(backtickFence, { begin: B, end: E, body: "outside fence" });
  check("fenced ```: upsertBlock leaves fenced example intact and appends outside",
    backtickUpsert.startsWith(backtickFence) && backtickUpsert.split(B).length === 3);

  const tildeFence = "~~~markdown\n" + B + "\ninside tilde\n" + E + "\n~~~\n";
  check("fenced ~~~: hasBlock returns false for marker inside fence", !hasBlock(tildeFence, { begin: B, end: E }));
  check("fenced ~~~: stripBlock ignores markers inside fence", stripBlock(tildeFence, { begin: B, end: E }) === tildeFence);
  const tildeUpsert = upsertBlock(tildeFence, { begin: B, end: E, body: "outside tilde" });
  check("fenced ~~~: upsertBlock leaves tilde example intact and appends outside",
    tildeUpsert.startsWith(tildeFence) && tildeUpsert.split(B).length === 3);

  // Indented fences (spaces and tabs)
  const indentedFenceSpaces = "   ```\n" + B + "\nindented spaces\n" + E + "\n   ```\n";
  check("indented fence (spaces) ignores markers inside", !hasBlock(indentedFenceSpaces, { begin: B, end: E }));

  const indentedFenceTabs = "\t```\n" + B + "\nindented tabs\n" + E + "\n\t```\n";
  check("indented fence (tabs) ignores markers inside", !hasBlock(indentedFenceTabs, { begin: B, end: E }));

  const indentedTilde = "  ~~~\n" + B + "\nindented tilde\n" + E + "\n  ~~~\n";
  check("indented fence (tilde) ignores markers inside", !hasBlock(indentedTilde, { begin: B, end: E }));

  // Unclosed fence runs to EOF
  const unclosedFence = "```\n" + B + "\nunclosed runs to eof\n" + E + "\n";
  check("unclosed fence runs to EOF: hasBlock is false", !hasBlock(unclosedFence, { begin: B, end: E }));
  check("unclosed fence runs to EOF: countMarkers is 0", countMarkers(unclosedFence, { begin: B, end: E }).begin === 0);

  // Fence closing length rules
  const longerClosing = "```\n" + B + "\n" + E + "\n`````\n\noutside\n";
  check("fence closed with more backticks closes fence", fenceRanges(longerClosing).length === 1);

  const shorterClosing = "````\n" + B + "\n" + E + "\n```\nstill inside\n";
  check("fence closed with fewer backticks does NOT close fence (runs to EOF)",
    !hasBlock(shorterClosing, { begin: B, end: E }));

  // One marker inside fence, one outside -> unbalanced outside, throws MalformedBlockError
  const beginInsideEndOutside = "```\n" + B + "\n```\n" + E + "\n";
  let threwFenceMismatch1 = false;
  try {
    findBlocks(beginInsideEndOutside, B, E);
  } catch (e) {
    threwFenceMismatch1 = e instanceof MalformedBlockError;
  }
  check("one marker inside fence (BEGIN) and pair outside (END) throws MalformedBlockError", threwFenceMismatch1);

  const beginOutsideEndInside = B + "\n```\n" + E + "\n```\n";
  let threwFenceMismatch2 = false;
  try {
    upsertBlock(beginOutsideEndInside, { begin: B, end: E, body: "x" });
  } catch (e) {
    threwFenceMismatch2 = e instanceof MalformedBlockError;
  }
  check("one marker outside fence (BEGIN) and pair inside (END) throws MalformedBlockError", threwFenceMismatch2);

  // stripBlock on torn fenced pair clears orphaned outside marker without touching fenced marker
  const strippedTornOutside = stripBlock(beginInsideEndOutside, { begin: B, end: E });
  check("stripBlock clears orphaned outside marker while preserving fenced marker",
    strippedTornOutside.includes(B) && !strippedTornOutside.includes(E));

  // --- Malformed block edge cases ---
  let threwNoEnd = false;
  try {
    findBlocks("Intro\n" + B + "\nBody without end\n", B, E);
  } catch (e) {
    threwNoEnd = e instanceof MalformedBlockError;
  }
  check("findBlocks: BEGIN with no END throws MalformedBlockError", threwNoEnd);

  let threwEndBeforeBegin = false;
  try {
    findBlocks("Intro\n" + E + "\n" + B + "\n", B, E);
  } catch (e) {
    threwEndBeforeBegin = e instanceof MalformedBlockError;
  }
  check("findBlocks: END before BEGIN throws MalformedBlockError", threwEndBeforeBegin);

  let threwUpsertEndBeforeBegin = false;
  try {
    upsertBlock("Intro\n" + E + "\n" + B + "\n", { begin: B, end: E, body: "test" });
  } catch (e) {
    threwUpsertEndBeforeBegin = e instanceof MalformedBlockError;
  }
  check("upsertBlock: END before BEGIN throws MalformedBlockError, does not append", threwUpsertEndBeforeBegin);

  let threwTwoBeginOneEnd = false;
  try {
    findBlocks("Intro\n" + B + "\n" + B + "\n" + E + "\n", B, E);
  } catch (e) {
    threwTwoBeginOneEnd = e instanceof MalformedBlockError;
  }
  check("findBlocks: two BEGIN + one END throws MalformedBlockError", threwTwoBeginOneEnd);

  let threwOneBeginTwoEnd = false;
  try {
    upsertBlock("Intro\n" + B + "\n" + E + "\n" + E + "\n", { begin: B, end: E, body: "test" });
  } catch (e) {
    threwOneBeginTwoEnd = e instanceof MalformedBlockError;
  }
  check("upsertBlock: one BEGIN + two END throws MalformedBlockError", threwOneBeginTwoEnd);

  // countMarkers outside fences
  const counts = countMarkers("Intro\n" + B + "\n" + B + "\n" + E + "\n", { begin: B, end: E });
  check("countMarkers reports exact counts for unbalanced markers", counts.begin === 2 && counts.end === 1);

  // --- Duplicate blocks: 2 and 3 duplicate blocks ---
  const twoBlocks = "Intro\n\n" + B + "\nblock 1\n" + E + "\n\nMiddle\n\n" + B + "\nblock 2\n" + E + "\n\nOutro\n";
  const upTwo = upsertBlock(twoBlocks, { begin: B, end: E, body: "collapsed" });
  check("upsertBlock collapses 2 blocks into exactly one", upTwo.split(B).length === 2 && upTwo.includes("collapsed"));
  check("upsertBlock preserving non-block sections with 2 blocks", upTwo.includes("Intro") && upTwo.includes("Middle") && upTwo.includes("Outro"));
  const stripTwo = stripBlock(twoBlocks, { begin: B, end: E });
  check("stripBlock removes both blocks on 2-block input", !hasBlock(stripTwo, { begin: B, end: E }));

  const threeBlocks =
    "Head\n\n" + B + "\n1\n" + E + "\n\nMid 1\n\n" + B + "\n2\n" + E + "\n\nMid 2\n\n" + B + "\n3\n" + E + "\n\nTail\n";
  const upThree = upsertBlock(threeBlocks, { begin: B, end: E, body: "only one left" });
  check("upsertBlock collapses 3 blocks into exactly one", upThree.split(B).length === 2 && upThree.includes("only one left"));
  const stripThree = stripBlock(threeBlocks, { begin: B, end: E });
  check("stripBlock removes all 3 blocks", !hasBlock(stripThree, { begin: B, end: E }));
  check("stripBlock preserves Head, Mid 1, Mid 2, Tail",
    stripThree.includes("Head") && stripThree.includes("Mid 1") && stripThree.includes("Mid 2") && stripThree.includes("Tail"));

  // --- Placement: start, end, middle ---
  const atStart = B + "\nstart block\n" + E + "\n\nRemaining content here.\n";
  const upStart = upsertBlock(atStart, { begin: B, end: E, body: "new start" });
  check("placement start: upsert preserves following content",
    upStart.startsWith(B) && upStart.includes("Remaining content here."));
  const stripStart = stripBlock(atStart, { begin: B, end: E });
  check("placement start: strip preserves following content", stripStart === "Remaining content here.\n");

  const atEnd = "Preceding content here.\n\n" + B + "\nend block\n" + E + "\n";
  const upEnd = upsertBlock(atEnd, { begin: B, end: E, body: "new end" });
  check("placement end: upsert preserves preceding content",
    upEnd.startsWith("Preceding content here.") && upEnd.includes("new end"));
  const stripEnd = stripBlock(atEnd, { begin: B, end: E });
  check("placement end: strip preserves preceding content", stripEnd === "Preceding content here.\n");

  const atMiddle = "Header text.\n\n" + B + "\nmiddle block\n" + E + "\n\nFooter text.\n";
  const upMiddle = upsertBlock(atMiddle, { begin: B, end: E, body: "new middle" });
  check("placement middle: upsert preserves both sides",
    upMiddle.includes("Header text.") && upMiddle.includes("Footer text.") && upMiddle.includes("new middle"));
  const stripMiddle = stripBlock(atMiddle, { begin: B, end: E });
  check("placement middle: strip preserves both sides cleanly",
    stripMiddle === "Header text.\n\nFooter text.\n");

  // --- Body edge cases ---
  const specialTokensBody = "Tokens: $& (amp), $1 (group), $` (before), $' (after), $$ (double dollar)";
  const upSpecialTokens = upsertBlock("", { begin: B, end: E, body: specialTokensBody });
  check("body with regex replacement tokens ($&, $1, $`, $', $$) preserved literally",
    upSpecialTokens.includes(specialTokensBody));

  const newlineBody = "line 1\nline 2\nline 3";
  const upNewline = upsertBlock("", { begin: B, end: E, body: newlineBody });
  check("body with literal \\n formats properly with eol",
    upNewline.includes(`${B}\nline 1\nline 2\nline 3\n${E}\n`));

  // End marker as substring of a longer line in body
  const bodyWithSubstringMarker = "Important: The " + E + " marker must not be removed!";
  const upSubstring = upsertBlock("", { begin: B, end: E, body: bodyWithSubstringMarker });
  check("body containing end marker as substring does not break block bounds",
    hasBlock(upSubstring, { begin: B, end: E }));
  check("body containing end marker as substring findBlocks returns 1 block",
    findBlocks(upSubstring, B, E).length === 1);

  // Leading and trailing whitespace in body
  const paddedBody = "   \n\t  padded content here  \t\n   ";
  const upPadded = upsertBlock("", { begin: B, end: E, body: paddedBody });
  check("leading/trailing whitespace in body is trimmed",
    upPadded.includes(`${B}\npadded content here\n${E}\n`));

  // --- Inputs: empty, whitespace-only, marker as substring of line ---
  const upEmpty = upsertBlock("", { begin: B, end: E, body: "empty target" });
  check("upsertBlock on empty string creates block cleanly", upEmpty === `${B}\nempty target\n${E}\n`);

  const upWs = upsertBlock("   \n\t  \n  ", { begin: B, end: E, body: "whitespace target" });
  check("upsertBlock on whitespace-only string creates block cleanly",
    upWs === `${B}\nwhitespace target\n${E}\n`);

  const lineWithSubstringMarker = "Prefix text " + B + " suffix text\n";
  check("marker as substring of longer line is ignored by countMarkers",
    countMarkers(lineWithSubstringMarker, { begin: B, end: E }).begin === 0);
  check("marker as substring of longer line is ignored by hasBlock",
    !hasBlock(lineWithSubstringMarker, { begin: B, end: E }));
}

export async function runFileEditTests(check, sandboxRoot) {
  const dir = path.join(sandboxRoot, "file-edit-units");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // --- detectIndent ---
  check("detectIndent on empty string defaults to 2 spaces", detectIndent("") === "  ");
  check("detectIndent on minified JSON defaults to 2 spaces", detectIndent('{"a":1}') === "  ");
  check("detectIndent on 2-space indented JSON returns '  '", detectIndent('{\n  "a": 1\n}') === "  ");
  check("detectIndent on 4-space indented JSON returns '    '", detectIndent('{\n    "a": 1\n}') === "    ");
  check("detectIndent on tab-indented JSON returns tab", detectIndent('{\n\t"a": 1\n}') === "\t");
  check("detectIndent on CRLF 4-space indented JSON returns '    '", detectIndent('{\r\n    "a": 1\r\n}') === "    ");

  // --- firstBackup ---
  const fBackupTarget = path.join(dir, "backup-target.txt");
  fs.writeFileSync(fBackupTarget, "original version\n");
  const b1 = firstBackup(fBackupTarget);
  check("firstBackup creates backup file on first call", fs.existsSync(`${fBackupTarget}.bak-antigravity-mcp`));
  check("firstBackup returns backup path", b1 === `${fBackupTarget}.bak-antigravity-mcp`);

  fs.writeFileSync(fBackupTarget, "modified version 2\n");
  const b2 = firstBackup(fBackupTarget);
  check("firstBackup second call returns null (does not overwrite)", b2 === null);
  check("firstBackup preserves original pristine content",
    fs.readFileSync(`${fBackupTarget}.bak-antigravity-mcp`, "utf8") === "original version\n");

  const fMissing = path.join(dir, "missing-file.txt");
  check("firstBackup returns null on missing file", firstBackup(fMissing) === null);

  const fZero = path.join(dir, "zero-bytes.txt");
  fs.writeFileSync(fZero, "");
  check("firstBackup returns null on zero-byte file", firstBackup(fZero) === null);
  check("firstBackup does not create backup for zero-byte file", !fs.existsSync(`${fZero}.bak-antigravity-mcp`));

  // --- editManagedFile: create, update, unchanged, delete, throw ---
  const mf = path.join(dir, "managed.txt");

  // Create on missing file: transform receives null
  let receivedCur = "NOT_CALLED";
  const rCreated = await editManagedFile(mf, (cur) => {
    receivedCur = cur;
    return "version 1\n";
  });
  check("editManagedFile passes null to transform when file is absent", receivedCur === null);
  check("editManagedFile status is created on absent file", rCreated.status === "created");
  check("editManagedFile existedBefore is false on absent file", rCreated.existedBefore === false);
  check("editManagedFile writes returned string to file", fs.readFileSync(mf, "utf8") === "version 1\n");

  // Update on existing file
  const rUpdated = await editManagedFile(mf, (cur) => cur + "version 2\n");
  check("editManagedFile status is updated on existing file", rUpdated.status === "updated");
  check("editManagedFile existedBefore is true on existing file", rUpdated.existedBefore === true);
  check("editManagedFile updates file content", fs.readFileSync(mf, "utf8") === "version 1\nversion 2\n");

  // Unchanged via undefined
  const rUnchangedUndef = await editManagedFile(mf, () => undefined);
  check("editManagedFile returns unchanged when transform returns undefined", rUnchangedUndef.status === "unchanged");

  // Unchanged via === current
  const rUnchangedSame = await editManagedFile(mf, (cur) => cur);
  check("editManagedFile returns unchanged when transform returns current string", rUnchangedSame.status === "unchanged");

  // TypeError on invalid transform return value
  let threwType = false;
  try {
    await editManagedFile(mf, () => 12345);
  } catch (e) {
    threwType = e instanceof TypeError;
  }
  check("editManagedFile rejects with TypeError when transform returns invalid type", threwType);

  // Transform throws: promise rejects, file unchanged, lock released
  const preThrowMtime = fs.statSync(mf).mtimeMs;
  let threwCustom = false;
  try {
    await editManagedFile(mf, () => {
      throw new Error("deliberate transform failure");
    });
  } catch (e) {
    threwCustom = e.message === "deliberate transform failure";
  }
  check("editManagedFile propagates error thrown in transform", threwCustom);
  check("editManagedFile leaves file untouched after throw",
    fs.readFileSync(mf, "utf8") === "version 1\nversion 2\n" && fs.statSync(mf).mtimeMs === preThrowMtime);
  check("editManagedFile releases lock directory after throw", !fs.existsSync(`${mf}.antigravity-lock`));

  // Subsequent call works immediately (proves lock was released in finally)
  const rSubsequent = await editManagedFile(mf, (cur) => (cur ?? "") + "post-throw\n");
  check("subsequent editManagedFile succeeds after error in previous transform", rSubsequent.status === "updated");

  // Missing parent directory: createLock recursively creates parent directories
  const nestedFile = path.join(dir, "deep", "nested", "path", "nested-target.txt");
  const rNested = await editManagedFile(nestedFile, () => "deep nested content\n");
  check("editManagedFile creates lock and writes file when parent directory does not exist yet",
    fs.existsSync(nestedFile) && rNested.status === "created");

  // Concurrency: 8 concurrent appends under lock
  const concurPath = path.join(dir, "concurrency-test.txt");
  fs.writeFileSync(concurPath, "");
  const N = 8;
  const tokens = Array.from({ length: N }, (_, i) => `concurrent-token-${i}\n`);
  const settled = await Promise.allSettled(
    tokens.map((tok) => editManagedFile(concurPath, (cur) => (cur ?? "") + tok))
  );
  check(`concurrency: all ${N} concurrent editManagedFile appends fulfilled`,
    settled.every((s) => s.status === "fulfilled"));
  const finalConcur = fs.readFileSync(concurPath, "utf8");
  check(`concurrency: no lost updates across all ${N} concurrent operations`,
    tokens.every((tok) => finalConcur.includes(tok)));

  // Dry run: does not write, no lock left
  const dryTarget = path.join(dir, "dry-target.txt");
  fs.writeFileSync(dryTarget, "initial content\n");
  const dryMtime = fs.statSync(dryTarget).mtimeMs;
  const rDry = await editManagedFile(dryTarget, () => "new dry content\n", { dryRun: true });
  check("dryRun returns 'would updated' status", rDry.status === "would updated");
  check("dryRun leaves file content and mtime untouched",
    fs.readFileSync(dryTarget, "utf8") === "initial content\n" && fs.statSync(dryTarget).mtimeMs === dryMtime);
  check("dryRun does not leave lock directory behind", !fs.existsSync(`${dryTarget}.antigravity-lock`));

  // Dry run delete
  const rDryDel = await editManagedFile(dryTarget, () => null, { dryRun: true });
  check("dryRun delete returns 'would deleted'", rDryDel.status === "would deleted");
  check("dryRun delete does not delete the file", fs.existsSync(dryTarget));

  // Real delete via return null
  const rDelete = await editManagedFile(dryTarget, () => null);
  check("editManagedFile delete returns 'deleted' status", rDelete.status === "deleted");
  check("editManagedFile delete removes file from disk", !fs.existsSync(dryTarget));
  check("editManagedFile delete takes backup before deletion",
    fs.existsSync(`${dryTarget}.bak-antigravity-mcp`));

  // No leftover temp files (*.tmp or *.<pid>.tmp)
  const dirFiles = fs.readdirSync(dir);
  const leftoverTmp = dirFiles.filter((f) => f.includes(".tmp"));
  check("no leftover *.tmp or *.<pid>.tmp sibling files after edits",
    leftoverTmp.length === 0, leftoverTmp.join(", "));

  // --- editJsonFile ---
  const jsonPath = path.join(dir, "config.json");

  // Missing file where mutate does nothing -> must NOT create a bare {} file
  const rJsonNoop = await editJsonFile(jsonPath, () => {});
  check("editJsonFile on missing file with no changes does NOT create a bare {} file", !fs.existsSync(jsonPath));
  check("editJsonFile on missing file with no changes returns unchanged", rJsonNoop.status === "unchanged");

  // Missing file where mutate adds properties -> creates with indent + trailing newline
  const rJsonCreate = await editJsonFile(jsonPath, (obj) => {
    obj.server = "antigravity";
    obj.port = 8080;
  });
  check("editJsonFile creates missing file when mutated", fs.existsSync(jsonPath) && rJsonCreate.status === "created");
  const createdRaw = fs.readFileSync(jsonPath, "utf8");
  check("editJsonFile created file ends with newline", createdRaw.endsWith("\n"));
  check("editJsonFile created file uses 2-space indent by default", createdRaw.includes('{\n  "server": "antigravity",\n  "port": 8080\n}'));

  // Existing file modified preserves file's own 4-space indent
  const fourSpaceJson = path.join(dir, "four-space.json");
  fs.writeFileSync(fourSpaceJson, '{\n    "name": "four-spaces",\n    "version": 1\n}\n');
  const rFourSpace = await editJsonFile(fourSpaceJson, (obj) => { obj.version = 2; });
  check("editJsonFile returns updated status on change", rFourSpace.status === "updated");
  const fourSpaceRaw = fs.readFileSync(fourSpaceJson, "utf8");
  check("editJsonFile preserves existing 4-space indent",
    fourSpaceRaw === '{\n    "name": "four-spaces",\n    "version": 2\n}\n');

  // Existing file with no change -> status unchanged, content untouched
  const rFourSpaceNoop = await editJsonFile(fourSpaceJson, (obj) => {});
  check("editJsonFile on existing file with no change returns unchanged", rFourSpaceNoop.status === "unchanged");

  // Parse error on malformed JSON throws Error mentioning "not valid JSON"
  const corruptJson = path.join(dir, "corrupt.json");
  fs.writeFileSync(corruptJson, "{ not valid json: 123");
  let jsonParseErr = null;
  try {
    await editJsonFile(corruptJson, (obj) => { obj.x = 1; });
  } catch (e) {
    jsonParseErr = e;
  }
  check("editJsonFile throws on parse error mentioning 'not valid JSON'",
    jsonParseErr !== null && jsonParseErr.message.includes("not valid JSON"));
}

export async function runStorePruneTests(check) {
  assertSandboxed(); // never mutate the real ~/.antigravity-mcp board
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  let origNotes = [];
  let origTasks = [];

  await mutate((b) => {
    origNotes = [...b.notes];
    origTasks = [...b.tasks];
    // 60 read notes (55 older than 20 days)
    b.notes = [];
    for (let i = 0; i < 60; i++) {
      b.notes.push({
        id: `prune-read-${i}`,
        from: "sender",
        to: "recipient",
        body: `read note ${i}`,
        created: now - 25 * DAY,
        readAt: now - 25 * DAY,
      });
    }

    // Unread notes: 1 recent, 1 older than 14 days
    b.notes.push({
      id: "prune-unread-recent",
      from: "sender",
      to: "recipient",
      body: "recent unread",
      created: now - 2 * DAY,
      readAt: null,
    });
    b.notes.push({
      id: "prune-unread-old",
      from: "sender",
      to: "recipient",
      body: "old unread",
      created: now - 16 * DAY,
      readAt: null,
    });

    // 50 finished tasks (done, failed, cancelled) and 5 running tasks
    b.tasks = [];
    for (let i = 0; i < 50; i++) {
      const status = i % 3 === 0 ? "done" : i % 3 === 1 ? "failed" : "cancelled";
      b.tasks.push({
        id: `prune-finished-${i}`,
        title: `task ${i}`,
        owner: "test-agent",
        kind: "delegated",
        status,
        created: now - 1000 * i,
        updated: now,
      });
    }
    for (let i = 0; i < 5; i++) {
      b.tasks.push({
        id: `prune-active-${i}`,
        title: `active task ${i}`,
        owner: "test-agent",
        kind: "delegated",
        status: "running",
        created: now - 1000 * i,
        updated: now,
      });
    }

    // Presence: 1 older than 7 days, 1 recent
    b.presence["prune-stale-presence"] = { status: "idle", detail: "", ts: now - 8 * DAY };
    b.presence["prune-fresh-presence"] = { status: "idle", detail: "", ts: now - 1 * DAY };

    // Limits: 1 expired, 1 active
    b.limits ||= {};
    b.limits["prune-expired-limit"] = { kind: "limit", resets_at: new Date(now - 5000).toISOString() };
    b.limits["prune-active-limit"] = { kind: "limit", resets_at: new Date(now + 3600_000).toISOString() };
  });

  const bAfter = read();

  // Read notes capped at KEEP_READ_NOTES = 50
  const readNotes = bAfter.notes.filter((n) => n.readAt && n.id.startsWith("prune-read-"));
  check("prune: read notes capped at KEEP_READ_NOTES (50)", readNotes.length === 50, `${readNotes.length}`);
  check("prune: oldest read notes dropped", !bAfter.notes.some((n) => n.id === "prune-read-0"));
  check("prune: newest read notes kept", bAfter.notes.some((n) => n.id === "prune-read-59"));
  check("prune: read notes older than 14d not dropped by age alone",
    bAfter.notes.some((n) => n.id === "prune-read-50" && now - n.created > 14 * DAY));

  // Unread notes: age check
  check("prune: recent unread note survives", bAfter.notes.some((n) => n.id === "prune-unread-recent"));
  check("prune: unread note older than 14d is reaped", !bAfter.notes.some((n) => n.id === "prune-unread-old"));

  // Tasks: finished capped at 40, active never dropped
  const finishedTasks = bAfter.tasks.filter((t) => t.id.startsWith("prune-finished-"));
  check("prune: finished tasks capped at KEEP_FINISHED_TASKS (40)", finishedTasks.length === 40, `${finishedTasks.length}`);
  check("prune: oldest finished tasks dropped", !bAfter.tasks.some((t) => t.id === "prune-finished-0"));
  check("prune: newest finished tasks kept", bAfter.tasks.some((t) => t.id === "prune-finished-49"));
  const activeTasks = bAfter.tasks.filter((t) => t.id.startsWith("prune-active-"));
  check("prune: active tasks are never dropped by task count cap", activeTasks.length === 5, `${activeTasks.length}`);

  // Presence older than 7 days pruned
  check("prune: presence older than 7 days is pruned", !bAfter.presence["prune-stale-presence"]);
  check("prune: fresh presence survives", Boolean(bAfter.presence["prune-fresh-presence"]));

  // Limits expired pruned
  check("prune: expired limit is pruned from board.limits", !bAfter.limits["prune-expired-limit"]);
  check("prune: active limit is preserved in board.limits", Boolean(bAfter.limits["prune-active-limit"]));

  // Clean up
  await mutate((b) => {
    b.notes = origNotes;
    b.tasks = origTasks;
    delete b.presence["prune-fresh-presence"];
    delete b.limits["prune-active-limit"];
  });
}

export async function runCoopStatusAdversarialTests(check, { alice, bob, call, sandbox }) {
  assertSandboxed(); // never mutate the real ~/.antigravity-mcp board
  const stale = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago

  await mutate((b) => {
    // Stale agent with an ACTIVE task (status: "running") -> must be KEPT as busy
    b.presence["stale-with-active-task"] = { status: "working", detail: "busy working", ts: stale };
    b.tasks.push({
      id: "active-task-stale-owner",
      title: "running task",
      owner: "stale-with-active-task",
      status: "running",
      kind: "delegated",
      created: stale,
      updated: stale,
    });

    // Stale agent whose task is TERMINAL ("done") and holds no lock -> must be EXCLUDED
    b.presence["stale-with-done-task"] = { status: "idle", detail: "finished", ts: stale };
    b.tasks.push({
      id: "done-task-stale-owner",
      title: "completed task",
      owner: "stale-with-done-task",
      status: "done",
      kind: "delegated",
      created: stale,
      updated: stale,
    });

    // Make caller's own presence timestamp stale (3h ago), no task, no lock -> must ALWAYS be kept
    b.presence["claude"] = {
      status: "idle",
      detail: "stale caller",
      ts: stale,
    };

    // Orphaned locks: one tied to a finished task, one tied to a deleted task, one with no task
    b.locks.push(
      { path: path.join(sandbox, "orphaned-done.txt"), owner: "ghost", taskId: "done-task-stale-owner", created: Date.now() },
      { path: path.join(sandbox, "orphaned-missing.txt"), owner: "ghost", taskId: "no-such-task-id", created: Date.now() },
      { path: path.join(sandbox, "not-orphaned.txt"), owner: "ghost", created: Date.now() }
    );
  });

  const status = await call(alice, "coop_status");
  const shownAgents = status.presence.map((p) => p.agent);

  check("coop_status: stale agent with active task is kept in presence", shownAgents.includes("stale-with-active-task"));
  check("coop_status: stale agent with only done task is excluded from presence", !shownAgents.includes("stale-with-done-task"));
  check("coop_status: caller's own identity is always in presence even if timestamp is 3h stale", shownAgents.includes("claude"));

  // Orphaned locks check in locked_paths
  const lockDone = status.locked_paths.find((l) => l.path.endsWith("orphaned-done.txt"));
  check("coop_status: lock tied to finished task is flagged orphaned: true", lockDone?.orphaned === true);
  check("coop_status: lock tied to finished task has orphan_reason mentioning 'already done'",
    /already done/.test(lockDone?.orphan_reason || ""));

  const lockMissing = status.locked_paths.find((l) => l.path.endsWith("orphaned-missing.txt"));
  check("coop_status: lock tied to nonexistent task is flagged orphaned: true", lockMissing?.orphaned === true);
  check("coop_status: lock tied to nonexistent task has orphan_reason mentioning 'no longer exists'",
    /no longer exists/.test(lockMissing?.orphan_reason || ""));

  const lockNormal = status.locked_paths.find((l) => l.path.endsWith("not-orphaned.txt"));
  check("coop_status: lock without taskId is not orphaned", !lockNormal?.orphaned);

  // my_open_assignments lifecycle
  const postRes = await call(bob, "board_post", { title: "Open assignment for claude", owner: "claude" });
  const statusWithAssignment = await call(alice, "coop_status");
  check("coop_status: my_open_assignments includes open board task assigned to caller",
    statusWithAssignment.my_open_assignments?.some((a) => a.id === postRes.task_id));

  // Move task to running -> no longer in my_open_assignments
  await call(alice, "board_update", { task_id: postRes.task_id, status: "running" });
  const statusAfterStarted = await call(alice, "coop_status");
  check("coop_status: my_open_assignments excludes task once moved off 'open'",
    !statusAfterStarted.my_open_assignments?.some((a) => a.id === postRes.task_id));

  // since_seq invalidation after note sent
  const seqNow = statusAfterStarted.seq;
  const cachedCheck = await call(alice, "coop_status", { since_seq: seqNow });
  check("coop_status: returns unchanged when seq matches", cachedCheck.unchanged === true && cachedCheck.seq === seqNow);

  await call(alice, "notes_send", { to: "antigravity", body: "invalidation test" });
  const freshAfterEvent = await call(alice, "coop_status", { since_seq: seqNow });
  check("coop_status: returns full payload when seq advances after event",
    freshAfterEvent.unchanged !== true && freshAfterEvent.seq > seqNow);
  await call(bob, "notes_read", {});

  // Clean up
  await mutate((b) => {
    delete b.presence["stale-with-active-task"];
    delete b.presence["stale-with-done-task"];
    b.tasks = b.tasks.filter(
      (t) => !["active-task-stale-owner", "done-task-stale-owner", postRes.task_id].includes(t.id)
    );
    b.locks = b.locks.filter(
      (l) => !["orphaned-done.txt", "orphaned-missing.txt", "not-orphaned.txt"].some((p) => l.path.endsWith(p))
    );
  });
}

/** The guard that stops a board-touching test from ever hitting ~/.antigravity-mcp again. */
export function runSandboxGuardTests(check) {
  const saved = process.env.ANTIGRAVITY_MCP_HOME;
  const throws = (val) => {
    if (val === undefined) delete process.env.ANTIGRAVITY_MCP_HOME;
    else process.env.ANTIGRAVITY_MCP_HOME = val;
    try { assertSandboxed(); return false; } catch { return true; }
  };
  check("assertSandboxed: rejects unset ANTIGRAVITY_MCP_HOME", throws(undefined));
  check("assertSandboxed: rejects the real board path", throws(path.join(os.homedir(), ".antigravity-mcp")));
  check("assertSandboxed: rejects os.tmpdir() root itself", throws(os.tmpdir()));
  check("assertSandboxed: accepts a subdir of os.tmpdir()", !throws(path.join(os.tmpdir(), "antigravity-mcp-test")));
  check("assertSandboxed: case-insensitive on the tmp prefix (win32 drive casing)",
    !throws(os.tmpdir().toLowerCase() + path.sep + "amcp-x"));
  process.env.ANTIGRAVITY_MCP_HOME = saved; // restore for the tests that follow
}

export async function runUnits(check, { alice, bob, call, sandbox }) {
  console.log("\n--- Running sandbox-guard unit tests ---");
  runSandboxGuardTests(check);

  console.log("\n--- Running markerBlock unit tests ---");
  runMarkerBlockTests(check);

  console.log("\n--- Running fileEdit unit tests ---");
  await runFileEditTests(check, sandbox);

  console.log("\n--- Running store prune unit tests ---");
  await runStorePruneTests(check);

  if (alice && bob && call) {
    console.log("\n--- Running coop_status adversarial tests ---");
    await runCoopStatusAdversarialTests(check, { alice, bob, call, sandbox });
  }
}

// Standalone: `node test/units.js` runs the pure + board tests (no stdio
// clients, so coop_status is skipped) against a fresh temp sandbox. This is the
// fast-feedback path -- reaching for it WITHOUT a sandbox is what wiped a live
// task once, so it now self-sandboxes before touching anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { SANDBOX } = setupSandbox();
  let failures = 0;
  const check = (name, cond, extra = "") => {
    console.log(`  ${cond ? "+" : "x"} ${name}${extra ? ` — ${extra}` : ""}`);
    if (!cond) failures++;
  };
  await runUnits(check, { sandbox: SANDBOX });
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
}
