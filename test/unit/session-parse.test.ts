import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseSessionFile } from "../../src/child/session-read.ts";
import { parseSessionText } from "../../src/child/session-parse.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/sessions");
const BASE = 1_700_000_000_000;
const TURN_START = BASE + 500;

async function parseFixture(name: string, final = true) {
  const text = await readFile(path.join(fixtures, name), "utf8");
  return parseSessionText(text, { turnStartedAtMs: TURN_START, final });
}

test("stop result yields the final assistant text and usage", async () => {
  const result = await parseFixture("stop.jsonl");
  assert.equal(result.state, "completed");
  assert.equal(result.outcome, "stop");
  assert.equal(result.text, "Final answer.");
  assert.equal(result.stopReason, "stop");
  assert.equal(result.assistantCount, 1);
  assert.equal(result.usage?.input, 10);
  assert.equal(result.usage?.totalTokens, 15);
  assert.equal(result.branchUncertain, false);
});

test("length and aborted map to their expected outcomes", async () => {
  const length = await parseFixture("length.jsonl");
  assert.equal(length.state, "completed");
  assert.equal(length.outcome, "length");
  assert.equal(length.text, "Partial answer");

  const aborted = await parseFixture("aborted.jsonl");
  assert.equal(aborted.state, "cancelled");
  assert.equal(aborted.outcome, "aborted");
  assert.equal(aborted.text, "partial");
});

test("error uses the error message and never falls back to an earlier success", async () => {
  const result = await parseFixture("error.jsonl");
  assert.equal(result.state, "failed");
  assert.equal(result.outcome, "error");
  assert.equal(result.error, "provider exploded");
  assert.equal(result.text, "");
});

test("pending tool use is incomplete only once the turn is final", async () => {
  const pending = await parseFixture("tooluse.jsonl", false);
  assert.equal(pending.state, "pending");
  assert.equal(pending.outcome, "pending");

  const final = await parseFixture("tooluse.jsonl", true);
  assert.equal(final.state, "failed");
  assert.equal(final.outcome, "incomplete");
  assert.match(final.incompleteReason ?? "", /toolUse/);
});

test("empty text is no_text, not an error", async () => {
  const result = await parseFixture("empty.jsonl");
  assert.equal(result.state, "completed");
  assert.equal(result.outcome, "no_text");
  assert.equal(result.text, "");
});

test("a partial final line is ignored", async () => {
  const result = await parseFixture("partial-last-line.jsonl");
  assert.equal(result.state, "completed");
  assert.equal(result.text, "Survives a partial tail.");
});

test("compaction entries are skipped but later messages are parsed", async () => {
  const result = await parseFixture("compaction.jsonl");
  assert.equal(result.state, "completed");
  assert.equal(result.text, "After compaction.");
});

test("the active branch wins over a newer abandoned assistant", async () => {
  const result = await parseFixture("abandoned-branch.jsonl");
  assert.equal(result.text, "Active final answer");
  assert.equal(result.branchUncertain, false);
});

test("usage aggregates assistant messages on the turn, including costs", async () => {
  const result = await parseFixture("usage.jsonl");
  assert.equal(result.text, "Done with usage.");
  assert.equal(result.assistantCount, 2);
  assert.deepEqual(result.usage, {
    input: 300,
    output: 40,
    cacheRead: 20,
    cacheWrite: 5,
    totalTokens: 365,
    cost: { input: 0.03, output: 0.06, cacheRead: 0.003, cacheWrite: 0.001, total: 0.094 },
  });
});

test("timestamps exclude a previous turn", async () => {
  const result = await parseFixture("previous-turn.jsonl");
  assert.equal(result.text, "Current turn answer");
  assert.equal(result.assistantCount, 1);
});

test("a tail read drops only its leading partial line", () => {
  const text = `garbage-before-newline\n${JSON.stringify({
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: new Date(BASE + 2000).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "tail answer" }], stopReason: "stop", timestamp: BASE + 2000 },
  })}\n`;
  const result = parseSessionText(text, { turnStartedAtMs: TURN_START, dropLeadingPartial: true, final: true });
  assert.equal(result.text, "tail answer");
});

test("entries without ids fall back to file order and mark the branch uncertain", () => {
  const text = [
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "one" }], stopReason: "stop", timestamp: BASE + 1000 } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "two" }], stopReason: "stop", timestamp: BASE + 2000 } }),
  ].join("\n");
  const result = parseSessionText(text, { turnStartedAtMs: TURN_START, final: true });
  assert.equal(result.text, "two");
  assert.equal(result.branchUncertain, true);
});

test("no assistant for the turn is incomplete when final", () => {
  const result = parseSessionText("", { turnStartedAtMs: TURN_START, final: true });
  assert.equal(result.state, "failed");
  assert.equal(result.outcome, "incomplete");
});

test("large sessions are read by expanding tail windows", async () => {
  const dir = path.join(fixtures, "..", "sessions-large");
  const fs = await import("node:fs/promises");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "large.jsonl");
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "session", version: 3, id: "sess-large", timestamp: new Date(BASE).toISOString(), cwd: "/repo" }));
  lines.push(JSON.stringify({ type: "message", id: "s1", parentId: null, message: { role: "system", content: "", timestamp: BASE } }));
  lines.push(JSON.stringify({ type: "message", id: "u1", parentId: "s1", message: { role: "user", content: "go", timestamp: BASE + 1000 } }));
  const filler = "x".repeat(20_000);
  for (let i = 0; i < 60; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `f${i}`,
        parentId: i === 0 ? "u1" : `f${i - 1}`,
        message: { role: "assistant", content: [{ type: "text", text: filler }], stopReason: "toolUse", timestamp: BASE + 1100 + i },
      }),
    );
  }
  const finalText = `large final answer ${"y".repeat(6000)}`;
  lines.push(
    JSON.stringify({
      type: "message",
      id: "final",
      parentId: "f59",
      message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop", timestamp: BASE + 5000 },
    }),
  );
  await fs.writeFile(file, `${lines.join("\n")}\n`);
  try {
    const result = await parseSessionFile(file, {
      turnStartedAtMs: TURN_START,
      final: true,
      initialTailBytes: 300,
      maxTailBytes: 4 * 1024 * 1024,
    });
    assert.equal(result.text, finalText);
    assert.ok(result.readBytes > 2_000);
    assert.ok(result.fileSize > result.readBytes);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
