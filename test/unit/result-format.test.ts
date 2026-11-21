import assert from "node:assert/strict";
import test from "node:test";

import {
  FULL_CONTENT_MAX_BYTES,
  FULL_CONTENT_MAX_LINES,
  PREVIOUS_TASK_MAX_BYTES,
  RESULT_CONTENT_MAX_BYTES,
  RESULT_CONTENT_MAX_LINES,
  condenseByLines,
  extractHandoff,
  modelFacingResult,
} from "../../src/runtime/result-format.ts";

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
