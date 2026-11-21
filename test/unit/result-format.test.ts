import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { ParsedSessionFile } from "../../src/child/session-read.ts";
import type { TerminalRecord } from "../../src/core/hc-types.ts";
import { finalizeFromSession } from "../../src/runtime/finalize.ts";
import { Registry } from "../../src/runtime/registry.ts";
import {
  ASYNC_CONTENT_MAX_BYTES,
  FULL_CONTENT_MAX_BYTES,
  FULL_CONTENT_MAX_LINES,
  PREVIOUS_TASK_MAX_BYTES,
  RESULT_CONTENT_MAX_BYTES,
  RESULT_CONTENT_MAX_LINES,
  type ResultContentInput,
  condenseByLines,
  extractHandoff,
  formatAsyncResultContent,
  formatResultContent,
  modelFacingResult,
} from "../../src/runtime/result-format.ts";
import type { SubagentRecord } from "../../src/runtime/types.ts";
import type { ToolSession } from "../../src/tools/session.ts";

const MARKER =
  /\[\.\.\. report condensed for the caller: \d+ lines dropped, \d+ KiB withheld; full text in the session file \.\.\.\]/;
const CODE_PLACEHOLDER = /\[code block removed: \d+ lines\]/;

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

/** A narration-heavy report with no handoff, the FR7 fallback fixture. */
function narration(lineCount: number): string {
  const out: string[] = [];
  for (let i = 1; i <= lineCount; i += 1) {
    out.push(`Step ${i}: the child narrated at length. ${"observed output and reasoned about it ".repeat(6)}`);
  }
  return out.join("\n");
}

const THREE_MIB = narration(12_500);

const CONDENSED_NOTE = /^note: the child's report was condensed from \d+ KiB\/\d+ lines; full text is in the session file \(hc_subagent_control result verbosity:"full"\)$/;
const RAW_FALLBACK_NOTE =
  /^note: the child did not include a ## Handoff section; this is its raw final message, condensed to the caller budget$/;
const FULL_BUDGET_NOTE = /^note: the child's report was truncated at the full budget \(\d+ KiB\/\d+ lines\); the session file has the complete text$/;

const PREAMBLE_LINE = "PREAMBLE NARRATION the child narrated at length about reading files";

/** A report whose only useful content is the trailing `## Handoff`. */
function reportWithHandoff(): string {
  const preamble = Array.from({ length: 120 }, (_, index) => `${PREAMBLE_LINE} (${index})`);
  return [
    ...preamble,
    "",
    "## Handoff",
    "### Status",
    "done",
    "### Changed",
    "- src/runtime/result-format.ts:513 — wired the choke point",
    "### Findings",
    "- HANDOFF-FINDING the helper is the only path now",
    "### Next step",
    "none",
  ].join("\n");
}

/** A handoff body larger than the summary budget but far below the full one. */
function bigHandoff(findingCount = 400): string {
  const findings = Array.from({ length: findingCount }, (_, index) => `- finding ${index} ${"detail ".repeat(12)}`);
  return [
    PREAMBLE_LINE,
    "",
    "## Handoff",
    "### Status",
    "done",
    "### Findings",
    ...findings,
    "### Next step",
    "HANDOFF-TAIL ship it",
  ].join("\n");
}

function syncInput(text: string, overrides: Partial<ResultContentInput> = {}): ResultContentInput {
  return {
    agent: "reviewer",
    state: "completed",
    outcome: "stop",
    durationMs: 65_000,
    turns: 1,
    terminal: "t12",
    terminalName: "rev-1",
    sessionFile: "/runs/r1/sessions/child-1.jsonl",
    resultFile: "/runs/r1/result.json",
    text,
    ...overrides,
  };
}

function noteLines(content: string): string[] {
  return content.split("\n").filter((line) => line.startsWith("note: "));
}

// --- extraction -----------------------------------------------------------

test("extractHandoff returns the trimmed body of a ## Handoff section", () => {
  const text = ["Some preamble.", "", "## Handoff", "### Status", "done", "", "## Work log", "log noise."].join(
    "\n",
  );
  assert.equal(extractHandoff(text), "### Status\ndone");
});

test("extractHandoff keeps subsections and ends at the next same-or-higher heading", () => {
  const text = ["## Handoff", "### Status", "done", "### Changed", "- a.ts:1 — x", "## Findings", "not part of it"].join(
    "\n",
  );
  assert.equal(extractHandoff(text), "### Status\ndone\n### Changed\n- a.ts:1 — x");
});

test("extractHandoff does not end at a deeper heading", () => {
  const text = ["# Handoff", "body", "## Sub", "still inside", "# Other", "dropped"].join("\n");
  assert.equal(extractHandoff(text), "body\n## Sub\nstill inside");
});

test("extractHandoff takes the last match", () => {
  const text = ["## Handoff", "first", "", "## Handoff", "second"].join("\n");
  assert.equal(extractHandoff(text), "second");
});

test("extractHandoff accepts the ## Summary alias and case variants", () => {
  assert.equal(extractHandoff(["## Summary", "- a", "- b"].join("\n")), "- a\n- b");
  assert.equal(extractHandoff(["### handoff:", "done"].join("\n")), "done");
  assert.equal(extractHandoff(["## HANDOFF", "done"].join("\n")), "done");
  assert.equal(extractHandoff(["##  Summary  ", "done"].join("\n")), "done");
  assert.equal(extractHandoff(["# Handoff", "done"].join("\n")), "done");
});

test("extractHandoff ignores level-4 handoff headings", () => {
  assert.equal(extractHandoff(["#### Handoff", "body"].join("\n")), null);
  assert.equal(extractHandoff(["#### Summary", "body"].join("\n")), null);
});

test("extractHandoff ignores headings inside fenced code blocks", () => {
  const text = [
    "Here is the contract you asked me to follow:",
    "",
    "```md",
    "## Handoff",
    "### Status",
    "done",
    "```",
    "",
    "That is all.",
  ].join("\n");
  assert.equal(extractHandoff(text), null);
});

test("extractHandoff only closes a fence on the same character with at least the opener length", () => {
  const tildeFence = ["~~~~", "```", "## Handoff", "body", "```", "~~~~", "after"].join("\n");
  assert.equal(extractHandoff(tildeFence), null);

  const shortClose = ["````", "## Handoff", "body", "```", "still fenced", "````"].join("\n");
  assert.equal(extractHandoff(shortClose), null);

  const realHandoff = ["````", "code", "````", "## Handoff", "body"].join("\n");
  assert.equal(extractHandoff(realHandoff), "body");
});

test("extractHandoff ignores a heading inside a fence that lives inside the handoff body", () => {
  const text = ["## Handoff", "### Findings", "```md", "## Findings", "```", "- real finding"].join("\n");
  assert.equal(extractHandoff(text), "### Findings\n```md\n## Findings\n```\n- real finding");
});

test("extractHandoff treats a heading at EOF or an empty body as not found", () => {
  assert.equal(extractHandoff(["intro", "## Handoff"].join("\n")), null);
  assert.equal(extractHandoff(["intro", "## Handoff", "   ", ""].join("\n")), null);
  assert.equal(extractHandoff("## Handoff\n"), null);
  assert.equal(extractHandoff(""), null);
  assert.equal(extractHandoff(["## Handoff", "first", "## Handoff", ""].join("\n")), null);
});

test("extractHandoff normalizes CRLF and lone CR input", () => {
  assert.equal(extractHandoff("intro\r\n## Handoff\r\n### Status\r\ndone\r\n"), "### Status\ndone");
  assert.equal(extractHandoff("intro\r## Handoff\r### Status\rdone"), "### Status\ndone");
});

test("extractHandoff picks the last of several candidate sections", () => {
  const text = [
    "## Summary",
    "first summary",
    "",
    "## Work log",
    "- lots",
    "",
    "## Summary",
    "final summary",
  ].join("\n");
  assert.equal(extractHandoff(text), "final summary");
});

// --- condensation ---------------------------------------------------------

test("condenseByLines replaces fenced blocks with a line-count placeholder", () => {
  const filler = Array.from({ length: 300 }, (_, index) => `filler line ${index} ${"f".repeat(50)}`);
  const text = [...filler, "```ts", "const a = 1;", "const b = 2;", "```", "TRAILING LINE"].join("\n");
  const out = condenseByLines(text, { maxBytes: 4096, maxLines: 60 });
  assert.equal(out.droppedCodeBlocks, 1);
  assert.match(out.text, /\[code block removed: 2 lines\]/);
  assert.match(out.text, /TRAILING LINE/);
  assert.ok(out.droppedLines > 0);
});

test("condenseByLines keeps whole head and tail lines and drops the middle", () => {
  const middle = Array.from({ length: 400 }, (_, index) => `middle line ${index} ${"m".repeat(60)}`);
  const text = ["HEAD-FIRST", ...middle, "TAIL-LAST"].join("\n");
  const out = condenseByLines(text, { maxBytes: 2048, maxLines: 50 });
  const outLines = splitLines(out.text);
  assert.equal(outLines[0], "HEAD-FIRST");
  assert.equal(outLines.at(-2), "TAIL-LAST");
  assert.match(outLines.at(-1) ?? "", MARKER);
  assert.doesNotMatch(out.text, /middle line 200/);
  assert.equal(out.droppedLines, 402 - (outLines.length - 1));
});

test("condenseByLines appends a marker naming dropped lines and withheld KiB", () => {
  const text = narration(400);
  const out = condenseByLines(text, { maxBytes: 2048, maxLines: 40 });
  assert.match(out.text, MARKER);
  assert.ok(/withheld; full text in the session file/.test(out.text));
  assert.ok(out.droppedLines > 0);
});

test("condenseByLines never exceeds the byte or line budget", () => {
  const inputs = [
    THREE_MIB,
    "日本語のテキスト".repeat(9000),
    ["```", "a", "b", "c", "```", narration(300)].join("\n"),
    narration(5000),
  ];
  const budgets = [
    { maxBytes: 512, maxLines: 8 },
    { maxBytes: 4096, maxLines: 40 },
    { maxBytes: RESULT_CONTENT_MAX_BYTES, maxLines: RESULT_CONTENT_MAX_LINES },
    { maxBytes: FULL_CONTENT_MAX_BYTES, maxLines: FULL_CONTENT_MAX_LINES },
  ];
  for (const input of inputs) {
    for (const budget of budgets) {
      const out = condenseByLines(input, budget);
      assert.ok(
        bytes(out.text) <= budget.maxBytes,
        `bytes ${bytes(out.text)} > ${budget.maxBytes} for input of ${bytes(input)}`,
      );
      assert.ok(splitLines(out.text).length <= budget.maxLines, `lines ${splitLines(out.text).length}`);
      assert.doesNotMatch(out.text, /\uFFFD/);
    }
  }
});

test("condenseByLines leaves text that already fits untouched", () => {
  const text = "short\ntext";
  const out = condenseByLines(text, { maxBytes: 4096, maxLines: 40 });
  assert.equal(out.text, text);
  assert.equal(out.droppedLines, 0);
  assert.equal(out.droppedCodeBlocks, 0);
});

test("condenseByLines cuts a single oversized line at a character boundary with an ellipsis", () => {
  const giant = "z".repeat(200_000);
  const out = condenseByLines(giant, { maxBytes: 1024, maxLines: 10 });
  assert.ok(bytes(out.text) <= 1024);
  const outLines = splitLines(out.text);
  assert.match(outLines.at(-1) ?? "", MARKER);
  const cut = outLines[0] ?? "";
  assert.ok(cut.endsWith("…"));
  assert.ok(giant.startsWith(cut.slice(0, -1)));
  assert.equal(out.droppedLines, 0);
});

test("condenseByLines cuts multi-byte text without splitting a character", () => {
  const giant = "日本語のテキスト".repeat(3000);
  const out = condenseByLines(giant, { maxBytes: 1000, maxLines: 10 });
  assert.ok(bytes(out.text) <= 1000);
  assert.doesNotMatch(out.text, /\uFFFD/);
  const cut = splitLines(out.text)[0] ?? "";
  assert.ok(cut.endsWith("…"));
  assert.ok(giant.startsWith(cut.slice(0, -1)));
});

test("condenseByLines still respects a budget smaller than its marker", () => {
  const out = condenseByLines(narration(100), { maxBytes: 20, maxLines: 2 });
  assert.ok(bytes(out.text) <= 20);
  assert.equal(splitLines(out.text).length, 1);
  assert.deepEqual(Buffer.from(out.text, "utf8").toString("utf8"), out.text);
});

// --- budget selection -----------------------------------------------------

test("modelFacingResult leaves an exact-budget report untouched", () => {
  const exactBytes = "a".repeat(RESULT_CONTENT_MAX_BYTES);
  const byBytes = modelFacingResult(exactBytes);
  assert.equal(byBytes.text, exactBytes);
  assert.equal(byBytes.condensed, false);
  assert.equal(byBytes.handoff, false);
  assert.equal(byBytes.withheldBytes, 0);

  const exactLines = Array.from({ length: RESULT_CONTENT_MAX_LINES }, (_, index) => `line ${index}`).join("\n");
  const byLines = modelFacingResult(exactLines);
  assert.equal(byLines.text, exactLines);
  assert.equal(byLines.condensed, false);
});

test("modelFacingResult condenses one line past the line budget", () => {
  const overLines = Array.from({ length: RESULT_CONTENT_MAX_LINES + 1 }, (_, index) => `line ${index}`).join("\n");
  const result = modelFacingResult(overLines);
  assert.equal(result.condensed, true);
  assert.ok(splitLines(result.text).length <= RESULT_CONTENT_MAX_LINES);
  assert.match(splitLines(result.text).at(-1) ?? "", MARKER);
});

test("modelFacingResult defaults to the 8 KiB result budget and full uses 50 KiB", () => {
  assert.ok(bytes(THREE_MIB) > 3 * 1024 * 1024);
  const summary = modelFacingResult(THREE_MIB);
  assert.ok(bytes(summary.text) <= RESULT_CONTENT_MAX_BYTES);
  assert.ok(bytes(summary.text) > 1024);

  const full = modelFacingResult(THREE_MIB, { verbosity: "full" });
  assert.equal(full.condensed, true);
  assert.ok(bytes(full.text) > RESULT_CONTENT_MAX_BYTES);
  assert.ok(bytes(full.text) <= FULL_CONTENT_MAX_BYTES);
  assert.ok(splitLines(full.text).length <= FULL_CONTENT_MAX_LINES);
});

test("modelFacingResult uses the handoff and drops everything around it", () => {
  const text = [
    "Long preamble narration about the run.",
    "",
    "## Handoff",
    "### Status",
    "done",
    "### Changed",
    "- src/a.ts:10 — wired helper",
    "### Findings",
    "- ok",
    "### Next step",
    "none",
    "",
    "## Work log",
    "trailing log noise",
  ].join("\n");
  const result = modelFacingResult(text);
  assert.equal(result.handoff, true);
  assert.equal(result.condensed, false);
  assert.match(result.text, /^### Status\ndone/);
  assert.doesNotMatch(result.text, /preamble narration/);
  assert.doesNotMatch(result.text, /trailing log noise/);
  assert.ok(result.withheldBytes > 0);
});

test("modelFacingResult condenses inside an over-budget handoff only", () => {
  const findings = Array.from({ length: 400 }, (_, index) => `- finding ${index} ${"f".repeat(50)}`);
  const text = ["PREAMBLE MARKER", "", "## Handoff", "### Status", "done", "### Findings", ...findings].join("\n");
  const result = modelFacingResult(text);
  assert.equal(result.handoff, true);
  assert.equal(result.condensed, true);
  assert.ok(bytes(result.text) <= RESULT_CONTENT_MAX_BYTES);
  assert.match(result.text, /^### Status/);
  assert.doesNotMatch(result.text, /PREAMBLE MARKER/);
  assert.match(splitLines(result.text).at(-1) ?? "", MARKER);
});

test("modelFacingResult honors an explicit notification-sized budget", () => {
  const result = modelFacingResult(THREE_MIB, { maxBytes: 4 * 1024, maxLines: 80 });
  assert.ok(bytes(result.text) <= 4 * 1024);
  assert.ok(splitLines(result.text).length <= 80);
});

test("a 3 MiB narration-heavy report with no handoff stays coherent and bounded", () => {
  const result = modelFacingResult(THREE_MIB);
  assert.equal(result.handoff, false);
  assert.equal(result.condensed, true);
  assert.ok(result.withheldBytes > 2 * 1024 * 1024);

  const outLines = splitLines(result.text);
  assert.ok(bytes(result.text) <= RESULT_CONTENT_MAX_BYTES);
  assert.ok(outLines.length <= RESULT_CONTENT_MAX_LINES);
  assert.match(outLines.at(-1) ?? "", MARKER);

  // No partial last line: every delivered content line is a whole source line.
  const sourceLines = new Set(splitLines(THREE_MIB));
  for (const line of outLines.slice(0, -1)) {
    assert.ok(sourceLines.has(line), `partial or invented line: ${line.slice(0, 40)}`);
  }
  assert.ok(sourceLines.has(outLines.at(-2) ?? ""));
});

test("constants keep the result, full, and chain budgets separate", () => {
  assert.equal(RESULT_CONTENT_MAX_BYTES, 8 * 1024);
  assert.equal(RESULT_CONTENT_MAX_LINES, 200);
  assert.equal(FULL_CONTENT_MAX_BYTES, 50 * 1024);
  assert.equal(FULL_CONTENT_MAX_LINES, 2000);
  assert.equal(PREVIOUS_TASK_MAX_BYTES, 50 * 1024);
});

// --- model-facing content and details flags -------------------------------

test("formatResultContent renders the handoff body and none of the preamble", () => {
  const content = formatResultContent(syncInput(reportWithHandoff()));
  assert.match(content, /HANDOFF-FINDING the helper is the only path now/);
  assert.match(content, /src\/runtime\/result-format\.ts:513/);
  assert.doesNotMatch(content, /PREAMBLE NARRATION/);
  assert.deepEqual(noteLines(content), [], "a fitting handoff needs no note");
});

test("formatResultContent explains raw fallback when a non-handoff report is condensed", () => {
  const text = narration(100);
  assert.ok(bytes(text) > RESULT_CONTENT_MAX_BYTES);
  const content = formatResultContent(syncInput(text));
  assert.ok(bytes(content) <= RESULT_CONTENT_MAX_BYTES + 512);
  assert.equal(noteLines(content).length, 1);
  assert.match(noteLines(content)[0]!, RAW_FALLBACK_NOTE);
  assert.doesNotMatch(content, /the child's report was condensed from/);
});

test("formatResultContent names the byte/line counts and the full escape hatch", () => {
  const content = formatResultContent(syncInput(bigHandoff()));
  const notes = noteLines(content);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, CONDENSED_NOTE);
  assert.match(notes[0]!, /verbosity:"full"/);
  assert.doesNotMatch(content, /finding 200 /, "the middle was dropped");
  assert.match(content.split("\n").at(-2) ?? "", /HANDOFF-TAIL|withheld/);
});

test("verbosity full restores the handoff at the 50 KiB ceiling", () => {
  const text = bigHandoff();
  const handoff = extractHandoff(text) ?? "";
  assert.ok(bytes(handoff) > RESULT_CONTENT_MAX_BYTES);
  assert.ok(bytes(handoff) < FULL_CONTENT_MAX_BYTES);

  const summary = formatResultContent(syncInput(text));
  assert.ok(bytes(summary) <= RESULT_CONTENT_MAX_BYTES + 512);

  const full = formatResultContent(syncInput(text, { verbosity: "full" }));
  assert.ok(full.endsWith(handoff), "the whole handoff is delivered");
  assert.match(full, /HANDOFF-TAIL ship it/);
  assert.match(full, /finding 200 /, "nothing from the handoff was dropped");
  assert.deepEqual(noteLines(full), [], "no note when full fits");
});

test("verbosity full on a 300 KiB report stops at the full budget", () => {
  const text = bigHandoff(4000);
  assert.ok(bytes(text) > 300 * 1024);
  const full = formatResultContent(syncInput(text, { verbosity: "full" }));
  assert.ok(bytes(full) > 40 * 1024, "the escape hatch emits near the ceiling");
  assert.ok(bytes(full) <= FULL_CONTENT_MAX_BYTES + 512);
  assert.ok(full.split("\n").length <= FULL_CONTENT_MAX_LINES + 10);
  assert.equal(noteLines(full).length, 1);
  assert.match(noteLines(full)[0]!, FULL_BUDGET_NOTE);
});

test("formatAsyncResultContent previews the handoff only", () => {
  const content = formatAsyncResultContent({ ...syncInput(reportWithHandoff()), childId: "child-1" });
  assert.match(content, /HANDOFF-FINDING the helper is the only path now/);
  assert.doesNotMatch(content, /PREAMBLE NARRATION/);
  assert.ok(bytes(content) <= ASYNC_CONTENT_MAX_BYTES);
  assert.equal(content.split("\n").at(-1), "none", "the fitting handoff needs no truncation footer");
});

test("formatAsyncResultContent keeps the envelope within 8 KiB for an over-budget handoff", () => {
  const content = formatAsyncResultContent({ ...syncInput(bigHandoff(3000)), childId: "child-1" });
  assert.ok(bytes(content) <= ASYNC_CONTENT_MAX_BYTES);
  assert.ok(content.split("\n").length <= 200);
  assert.doesNotMatch(content, /PREAMBLE NARRATION/);
  assert.match(content, /### Status/);
  assert.equal(content.split("\n").at(-1), 'Full result: hc_subagent_control({ action: "result", id: "child-1" })');
});

const TERMINAL_FIXTURE: TerminalRecord = {
  address: "t12",
  name: "rev-1",
  cwd: "/repo",
  argv: [],
  state: "finished",
  status: null,
  turn: 1,
  exitCode: 0,
  signal: null,
  parent: null,
  labels: {},
  createdMs: 0,
  finishedMs: 1_000,
  statusMs: 1_000,
  reported: false,
  reason: null,
  keep: false,
  rm: false,
  foreground: null,
  pid: null,
  notify: false,
  identity: "fixture",
  screen: "",
};

function recordFixture(): SubagentRecord {
  return {
    version: 1,
    runId: "run-1",
    childId: "child-1",
    parentSessionId: "parent-1",
    agent: "reviewer",
    agentSource: "user",
    agentAccess: "read-only",
    cwd: "/repo",
    terminal: "t12",
    terminalName: "rev-1",
    sessionId: "child-1",
    sessionFile: null,
    state: "working",
    terminalState: "live",
    coreStatus: "working",
    slug: "reviewer-a1b2",
    turn: 1,
    turns: [],
    createdAt: "2026-11-20T03:40:00.000Z",
    updatedAt: "2026-11-20T03:40:00.000Z",
    labels: {},
    background: false,
    origin: "tool",
  };
}

function parsedFixture(text: string): ParsedSessionFile {
  return {
    state: "completed",
    outcome: "stop",
    text,
    assistantCount: 1,
    stopReason: "stop",
    branchUncertain: false,
    lastAssistantTimestamp: Date.now(),
    sessionFile: "/runs/r1/sessions/child-1.jsonl",
    readBytes: 0,
    fileSize: 0,
  };
}

async function finalizeText(text: string) {
  const root = await mkdtemp(path.join("/tmp", "hc-result-format-"));
  try {
    const registry = new Registry();
    const record = registry.create(recordFixture());
    const session = { registry } as unknown as ToolSession;
    return await finalizeFromSession({
      session,
      record,
      terminal: TERMINAL_FIXTURE,
      parsed: parsedFixture(text),
      turnStartedAtMs: 0,
      resultFile: path.join(root, "result.json"),
      fallbackOutcome: "incomplete",
      fallbackError: "unused",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("details keep neither flag for a short result", async () => {
  const finalized = await finalizeText("Looks good.");
  assert.equal(finalized.result.details.handoff, false);
  assert.equal(finalized.result.details.contentCondensed, false);
  assert.equal(finalized.result.details.textTruncated, false);
  assert.equal(finalized.result.details.text, "Looks good.");
});

test("details set handoff for a handoff report and still keep the full text", async () => {
  const text = reportWithHandoff();
  const finalized = await finalizeText(text);
  assert.equal(finalized.result.details.handoff, true);
  assert.equal(finalized.result.details.contentCondensed, false);
  assert.equal(finalized.result.details.textTruncated, false);
  assert.equal(finalized.result.details.text, text, "details.text stays the full child text");
  const content = finalized.result.content[0]!.text;
  assert.match(content, /HANDOFF-FINDING/);
  assert.doesNotMatch(content, /PREAMBLE NARRATION/);
});

test("details set contentCondensed for an over-budget non-handoff report without touching textTruncated", async () => {
  const text = narration(100);
  assert.ok(bytes(text) > RESULT_CONTENT_MAX_BYTES && bytes(text) < 50 * 1024);
  const finalized = await finalizeText(text);
  assert.equal(finalized.result.details.handoff, false);
  assert.equal(finalized.result.details.contentCondensed, true);
  assert.equal(finalized.result.details.textTruncated, false, "details fit the 50 KiB cap");
  assert.equal(finalized.result.details.text, text);
  const content = finalized.result.content[0]!.text;
  assert.ok(bytes(content) <= RESULT_CONTENT_MAX_BYTES + 512);
  assert.match(noteLines(content)[0]!, RAW_FALLBACK_NOTE);

  const oversized = narration(400);
  assert.ok(bytes(oversized) > 50 * 1024);
  const capped = await finalizeText(oversized);
  assert.equal(capped.result.details.contentCondensed, true);
  assert.equal(capped.result.details.textTruncated, true, "textTruncated still means the details cap");
});
