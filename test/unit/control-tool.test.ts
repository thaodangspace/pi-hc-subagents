/**
 * Control read paths reuse the persisted summary.
 *
 * Phase 4 of the result-summarizer plan: a settle summarizes once, and every
 * later `result`/`wait` reads `result.json` without a second model call. The
 * summarizer is fake, so nothing here needs credentials or a network.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import type { ParsedSessionFile } from "../../src/child/session-read.ts";
import { DEFAULT_CONFIG } from "../../src/config/schema.ts";
import type { TerminalRecord } from "../../src/core/hc-types.ts";
import { finalizeFromSession } from "../../src/runtime/finalize.ts";
import { Registry } from "../../src/runtime/registry.ts";
import {
  FULL_CONTENT_MAX_BYTES,
  RESULT_CONTENT_MAX_BYTES,
  type SubagentResultDetails,
} from "../../src/runtime/result-format.ts";
import type { ExtensionRuntime } from "../../src/runtime/runtime.ts";
import type { SubagentRecord, Usage } from "../../src/runtime/types.ts";
import { registerControlTool } from "../../src/tools/control-tool.ts";
import type { ToolSession } from "../../src/tools/session.ts";
import { fakeSummarizer, type FakeSummarizer } from "./fakes/summarizer.ts";

const CHILD_USAGE: Usage = {
  input: 1200,
  output: 300,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1500,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
};

const SUMMARY = [
  "Status: done.",
  "Changed: src/runtime/finalize.ts:120 — reused the persisted summary.",
  "Next: none.",
].join("\n");

const SUMMARIZED_NOTE =
  /^note: the child's report was summarized for the caller from \d+ KiB\/\d+ lines; full text is in the session file \(hc_subagent_control result verbosity:"full"\)$/;
const RAW_FALLBACK_NOTE =
  /^note: the child did not include a ## Handoff section; this is its raw final message, condensed to the caller budget$/;

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Handoff-less narration well above the 8 KiB model-facing budget. */
function narration(lineCount: number): string {
  const out: string[] = [];
  for (let i = 1; i <= lineCount; i += 1) {
    out.push(`Step ${i}: the child narrated at length. ${"observed output and reasoned about it ".repeat(6)}`);
  }
  return out.join("\n");
}

const OVER_BUDGET = narration(120);

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

/**
 * Two hours and thirty seconds old: `formatDuration` renders `2h` for the whole
 * test, so re-read content stays byte-identical instead of ticking on a second.
 */
function stableCreatedAt(): string {
  return new Date(Date.now() - (2 * 3600 + 30) * 1000).toISOString();
}

function recordFixture(resultFile: string): SubagentRecord {
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
    runDir: path.dirname(resultFile),
    resultFile,
    state: "working",
    terminalState: "live",
    coreStatus: "working",
    slug: "reviewer-a1b2",
    turn: 1,
    turns: [],
    createdAt: stableCreatedAt(),
    updatedAt: stableCreatedAt(),
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
    usage: CHILD_USAGE,
    sessionFile: "/runs/r1/sessions/child-1.jsonl",
    readBytes: 0,
    fileSize: 0,
  };
}

interface ControlHarness {
  session: ToolSession;
  record: SubagentRecord;
  resultFile: string;
  execute: (params: Record<string, unknown>) => Promise<AgentToolResult<SubagentResultDetails>>;
  cleanup: () => Promise<void>;
}

/** A control tool over a real registry and result file; no core, no network. */
async function harness(
  options: { mode?: "off" | "model"; summarizer?: FakeSummarizer } = {},
): Promise<ControlHarness> {
  const root = await mkdtemp(path.join("/tmp", "hc-control-summary-"));
  const resultFile = path.join(root, "result.json");
  const registry = new Registry();
  const record = registry.create(recordFixture(resultFile));
  const config = { ...DEFAULT_CONFIG, resultSummarizer: options.mode ?? "model" };
  const runtime = {
    available: true,
    mode: "ready",
    config,
    loadedConfig: { config, warnings: [], paths: {} },
    parentSessionId: "parent-1",
  } as unknown as ExtensionRuntime;
  const session: ToolSession = {
    runtime,
    registry,
    scheduler: null as unknown as ToolSession["scheduler"],
    summarizer: options.summarizer?.summarizer ?? null,
  };

  const tools = new Map<
    string,
    { execute: (...args: unknown[]) => Promise<AgentToolResult<SubagentResultDetails>> }
  >();
  const pi = {
    registerTool(definition: {
      name: string;
      execute: (...args: unknown[]) => Promise<AgentToolResult<SubagentResultDetails>>;
    }) {
      tools.set(definition.name, definition);
    },
  } as never;
  registerControlTool(pi, () => session);
  const tool = tools.get("hc_subagent_control");
  assert.ok(tool, "the control tool is registered");

  return {
    session,
    record,
    resultFile,
    execute: (params) => tool.execute("call-1", params),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Settle one turn, publishing `text` and (when enabled) its summary. */
async function settle(h: ControlHarness, text = OVER_BUDGET): Promise<string> {
  const finalized = await finalizeFromSession({
    session: h.session,
    record: h.record,
    terminal: TERMINAL_FIXTURE,
    parsed: parsedFixture(text),
    turnStartedAtMs: 0,
    resultFile: h.resultFile,
    fallbackOutcome: "incomplete",
    fallbackError: "unused",
  });
  return contentOf(finalized.result);
}

function contentOf(result: AgentToolResult<SubagentResultDetails>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function noteLines(content: string): string[] {
  return content.split("\n").filter((line) => line.startsWith("note: "));
}

test("result and wait reuse the persisted summary without a second call", async () => {
  const fake = fakeSummarizer({ text: SUMMARY });
  const h = await harness({ summarizer: fake });
  try {
    const settled = await settle(h);
    assert.equal(fake.callCount(), 1, "the settle turn summarizes exactly once");
    assert.ok(settled.endsWith(SUMMARY), "the settle content is the summary");
    assert.match(noteLines(settled)[0] ?? "", SUMMARIZED_NOTE);

    const results = [
      await h.execute({ action: "result", id: h.record.childId }),
      await h.execute({ action: "result", id: h.record.childId }),
      await h.execute({ action: "result", id: h.record.childId }),
      await h.execute({ action: "wait", id: h.record.childId }),
    ];

    assert.equal(fake.callCount(), 1, "no read path calls the summarizer again");
    const contents = results.map(contentOf);
    for (const content of contents) {
      assert.equal(content, contents[0], "every read returns byte-identical content");
      assert.ok(content.endsWith(SUMMARY), "the body is the persisted summary");
      assert.ok(!content.includes("Step 1: the child narrated"), "the raw narration is not re-admitted");
      assert.match(noteLines(content)[0] ?? "", SUMMARIZED_NOTE);
      assert.ok(bytes(content) <= RESULT_CONTENT_MAX_BYTES + 512);
    }

    for (const result of results) {
      assert.equal(result.details.summarized, true);
      assert.equal(result.details.summary, SUMMARY);
      assert.equal(result.details.summarizer?.costUsd, 0.0004);
      assert.equal(result.details.summarizer?.model, "test/model");
      assert.deepEqual(result.details.usage, CHILD_USAGE, "the child's usage is unchanged");
    }
  } finally {
    await h.cleanup();
  }
});

test('verbosity: "full" ignores the persisted summary and returns the child text', async () => {
  const fake = fakeSummarizer({ text: SUMMARY });
  const h = await harness({ summarizer: fake });
  try {
    await settle(h);
    const full = await h.execute({ action: "result", id: h.record.childId, verbosity: "full" });
    const content = contentOf(full);

    assert.equal(fake.callCount(), 1);
    assert.ok(content.includes("Step 1: the child narrated"), "the escape hatch returns the child's words");
    assert.ok(!content.includes(SUMMARY), "the summary is not in the full content");
    assert.ok(bytes(OVER_BUDGET) > RESULT_CONTENT_MAX_BYTES, "fixture is over the summary budget");
    assert.ok(bytes(OVER_BUDGET) < FULL_CONTENT_MAX_BYTES, "fixture fits the full budget");
    assert.ok(content.endsWith(OVER_BUDGET), "nothing is withheld under the full budget");
    assert.equal(noteLines(content).length, 0, "no note: nothing was condensed");
    assert.equal(full.details.summarized, undefined);
    assert.equal(full.details.summary, undefined);
    assert.equal(full.details.contentCondensed, false);
  } finally {
    await h.cleanup();
  }
});

test("a result without a summary keeps today's digest on read", async () => {
  const h = await harness({ mode: "off" });
  try {
    await settle(h);
    const read = await h.execute({ action: "result", id: h.record.childId });
    const content = contentOf(read);

    assert.ok(content.includes("Step 1: the child narrated"));
    assert.match(noteLines(content)[0] ?? "", RAW_FALLBACK_NOTE);
    assert.equal(read.details.summarized, undefined);
    assert.equal(read.details.summary, undefined);
  } finally {
    await h.cleanup();
  }
});
