import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BATCH_REQUEST_BYTES,
  MAX_BATCH_TASKS,
  formatBatchContent,
  resolveSpawnMode,
  substitutePrevious,
  type BatchTaskResult,
} from "../../src/tools/batch.ts";

function task(agent = "scout", text = "look") {
  return { agent, task: text };
}

test("exactly one of single, tasks, and chain is accepted", () => {
  assert.deepEqual(resolveSpawnMode({ agent: "scout", task: "look" }), { mode: "single" });
  assert.equal(resolveSpawnMode({ tasks: [task()] }).mode, "parallel");
  assert.equal(resolveSpawnMode({ chain: [task()] }).mode, "chain");
  assert.match(resolveSpawnMode({}).error ?? "", /provide/);
  assert.match(resolveSpawnMode({ agent: "scout", task: "look", tasks: [task()] }).error ?? "", /mutually exclusive/);
  assert.match(resolveSpawnMode({ tasks: [task()], chain: [task()] }).error ?? "", /mutually exclusive/);
  assert.match(resolveSpawnMode({ agent: "scout" }).error ?? "", /must not be empty/);
});

test("batch validation bounds count, emptiness, and total bytes", () => {
  assert.match(resolveSpawnMode({ tasks: [] }).error ?? "", /between 1 and/);
  assert.match(
    resolveSpawnMode({ tasks: Array.from({ length: MAX_BATCH_TASKS + 1 }, () => task()) }).error ?? "",
    /between 1 and/,
  );
  assert.match(resolveSpawnMode({ tasks: [{ agent: "", task: "x" }] }).error ?? "", /agent must not be empty/);
  assert.match(resolveSpawnMode({ tasks: [{ agent: "scout", task: " " }] }).error ?? "", /task must not be empty/);
  assert.match(resolveSpawnMode({ tasks: [task()], background: true }).error ?? "", /background/);
  const huge = "x".repeat(MAX_BATCH_REQUEST_BYTES);
  assert.match(resolveSpawnMode({ tasks: [task("scout", huge)] }).error ?? "", /exceeds/);
});

test("{previous} is replaced with the bounded previous result", () => {
  assert.equal(substitutePrevious("Summarize {previous}", "the answer"), "Summarize the answer");
  assert.equal(substitutePrevious("no placeholder", "ignored"), "no placeholder");
  const bounded = substitutePrevious("{previous}", "x".repeat(200_000));
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 50 * 1024 + 100);
  assert.match(bounded, /truncated/);
});

test("batch content stays compact and names every task", () => {
  const results: BatchTaskResult[] = [
    {
      index: 0,
      childId: "c1",
      runId: "r1",
      agent: "scout",
      cwd: "/repo",
      terminal: "t1",
      terminalName: "hc-scout",
      state: "completed",
      outcome: "stop",
      sessionFile: "/s/1.jsonl",
      resultFile: "/r/1.json",
      turn: 1,
      durationMs: 1200,
      text: "first result ".repeat(1000),
    },
    {
      index: 1,
      childId: "c2",
      runId: "r2",
      agent: "reviewer",
      cwd: "/repo",
      terminal: "t2",
      terminalName: "hc-reviewer",
      state: "failed",
      outcome: "error",
      sessionFile: "/s/2.jsonl",
      resultFile: "/r/2.json",
      turn: 1,
      durationMs: 500,
      error: "provider exploded",
    },
  ];
  const content = formatBatchContent("parallel", results);
  assert.match(content, /Subagent batch/);
  assert.match(content, /2 tasks, 1 completed, 1 failed/);
  assert.match(content, /1\. scout — completed \(stop\)/);
  assert.match(content, /2\. reviewer — failed \(error\)/);
  assert.match(content, /error: provider exploded/);
  assert.ok(Buffer.byteLength(content, "utf8") < 17 * 1024);
  assert.doesNotMatch(content, /child: c1[\s\S]*child: c2[\s\S]*child: c1/);
});

test("skipped chain steps are reported as skipped", () => {
  const content = formatBatchContent("chain", [
    { index: 0, agent: "scout", childId: "c1", runId: "r", cwd: "/", terminal: "t", terminalName: "hc", state: "completed", outcome: "stop", sessionFile: null, resultFile: null, turn: 1, durationMs: 1, text: "ok" },
    { index: 1, agent: "worker", childId: "", runId: "", cwd: "/", terminal: "", terminalName: "", state: "cancelled", outcome: "aborted", sessionFile: null, resultFile: null, turn: 0, durationMs: 0, skipped: true },
  ]);
  assert.match(content, /1 skipped/);
  assert.match(content, /not run because an earlier step failed/);
});
