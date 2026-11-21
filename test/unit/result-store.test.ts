import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  MAX_RESULT_TEXT_BYTES,
  buildResultJson,
  boundResultText,
  readResultFile,
  writeResultFile,
} from "../../src/runtime/result-store.ts";

test("result.json is written atomically with mode 0600 and readable", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-result-"));
  try {
    const file = path.join(root, "result.json");
    const result = buildResultJson({
      childId: "child-1",
      turn: 1,
      state: "completed",
      outcome: "stop",
      text: "final text",
      sessionFile: "/runs/s1/sessions/x_child-1.jsonl",
      terminal: "t12",
      startedAt: "2026-11-20T03:40:00.000Z",
      settledAt: "2026-11-20T03:41:00.000Z",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 10,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
      },
    });
    await writeResultFile(file, result);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.childId, "child-1");
    assert.equal(raw.sessionFile, result.sessionFile);
    assert.equal(raw.text, "final text");
    assert.equal(raw.textTruncated, false);
    const read = await readResultFile(file);
    assert.deepEqual(read, result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized results keep head and tail and set textTruncated", () => {
  const text = `${"a".repeat(4000)}MIDDLE${"z".repeat(4000)}`;
  const bounded = boundResultText(text, 1024);
  assert.equal(bounded.textTruncated, true);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 1024 + 16);
  assert.match(bounded.text, /result truncated/);
  assert.ok(bounded.text.startsWith("a"));
  assert.ok(bounded.text.endsWith("z"));

  const result = buildResultJson({
    childId: "c",
    turn: 1,
    state: "completed",
    outcome: "stop",
    text,
    sessionFile: null,
    terminal: "t1",
    startedAt: "a",
    settledAt: "b",
    maxTextBytes: 1024,
  });
  assert.equal(result.textTruncated, true);
  assert.equal(result.text.length < text.length, true);
  assert.equal(result.usage.totalTokens, 0);
});

test("the default cap is 10 MiB", () => {
  assert.equal(MAX_RESULT_TEXT_BYTES, 10 * 1024 * 1024);
});

test("a summary and its usage are additive optional fields at version 1", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-result-"));
  try {
    const file = path.join(root, "result.json");
    const summary = "Status: done. Changed src/a.ts:12.";
    const summaryUsage = {
      inputTokens: 1200,
      outputTokens: 180,
      costUsd: 0.0004,
      model: "provider/model-a",
      durationMs: 900,
    };
    const result = buildResultJson({
      childId: "child-1",
      turn: 1,
      state: "completed",
      outcome: "stop",
      text: "final text",
      sessionFile: null,
      terminal: "t12",
      startedAt: "2026-11-20T03:40:00.000Z",
      settledAt: "2026-11-20T03:41:00.000Z",
      summary,
      summaryUsage,
    });

    assert.equal(result.version, 1, "additive fields do not bump the version");
    assert.equal(result.summary, summary);
    assert.deepEqual(result.summaryUsage, summaryUsage);

    await writeResultFile(file, result);
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.summary, summary);
    assert.deepEqual(raw.summaryUsage, summaryUsage);
    assert.deepEqual(await readResultFile(file), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without a summary the optional keys stay absent", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-result-"));
  try {
    const file = path.join(root, "result.json");
    const result = buildResultJson({
      childId: "child-1",
      turn: 1,
      state: "completed",
      outcome: "stop",
      text: "final text",
      sessionFile: null,
      terminal: "t12",
      startedAt: "a",
      settledAt: "b",
    });

    assert.ok(!("summary" in result));
    assert.ok(!("summaryUsage" in result));
    await writeResultFile(file, result);
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.ok(!("summary" in raw), "the off path writes no summary key");
    assert.ok(!("summaryUsage" in raw));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown fields are ignored on read, so old and new writers interoperate", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-result-"));
  try {
    const file = path.join(root, "result.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        childId: "child-1",
        turn: 1,
        text: "final text",
        summary: "a summary from a newer writer",
        futureField: { nested: true },
      }),
      "utf8",
    );
    const read = await readResultFile(file);
    assert.ok(read, "required fields are enough to read the file");
    assert.equal(read.summary, "a summary from a newer writer");
    assert.deepEqual((read as unknown as Record<string, unknown>).futureField, { nested: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or corrupt result files read as null", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-result-"));
  try {
    assert.equal(await readResultFile(path.join(root, "missing.json")), null);
    const corrupt = path.join(root, "corrupt.json");
    await writeFile(corrupt, "{nope", "utf8");
    assert.equal(await readResultFile(corrupt), null);
    await writeFile(corrupt, JSON.stringify({ version: 2 }), "utf8");
    assert.equal(await readResultFile(corrupt), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
