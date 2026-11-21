/**
 * Runner tests for the gated summarizer. Every case uses an injected fake, so
 * no network, credentials, or real 10 s waits are involved.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { modelFacingResult } from "../../src/runtime/result-format.ts";
import {
  SUMMARIZER_INPUT_MAX_BYTES,
  SUMMARIZER_OUTPUT_MAX_BYTES,
  summarizeReport,
  type ResultSummarizer,
  type SummarizeReportOptions,
  type SummarizeReportResult,
  type SummarizeState,
} from "../../src/runtime/summarizer.ts";
import { fakeSummarizer } from "./fakes/summarizer.ts";

/** Narration with no handoff: `modelFacingResult` condenses it by default. */
function narration(lines: number): string {
  const line = `Step: ${"observed output and reasoned about it ".repeat(3)}`;
  return Array.from({ length: lines }, (_, index) => `${line}${index}`).join("\n");
}

const OVER_BUDGET = narration(200);

/** A handoff body far above the default budget, so `handoff && condensed`. */
function bigHandoff(): string {
  const findings = Array.from(
    { length: 300 },
    (_, index) => `- finding ${index}: ${"detail ".repeat(10)}`,
  );
  return ["preamble", "", "## Handoff", "### Findings", ...findings].join("\n");
}

function makeState(overrides: Partial<SummarizeState> = {}): SummarizeState {
  return { enabled: true, failed: false, ...overrides };
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function assertP0Digest(result: SummarizeReportResult, text: string): void {
  const facing = modelFacingResult(text, { verbosity: "summary" });
  assert.equal(result.summarized, false);
  assert.equal(result.facing.text, facing.text);
  assert.equal(result.facing.handoff, facing.handoff);
  assert.equal(result.facing.condensed, facing.condensed);
  assert.equal(result.facing.withheldBytes, facing.withheldBytes);
  assert.equal(result.usage, undefined);
}

function baseOptions(overrides: Partial<SummarizeReportOptions> = {}): SummarizeReportOptions {
  return {
    text: OVER_BUDGET,
    verbosity: "summary",
    summarizer: fakeSummarizer().summarizer,
    state: makeState(),
    ...overrides,
  };
}

// --- gates ----------------------------------------------------------------

interface GateCase {
  name: string;
  text: string;
  state: SummarizeState;
  summarizer?: ResultSummarizer | null;
}

const GATES: GateCase[] = [
  { name: "config off", text: OVER_BUDGET, state: makeState({ enabled: false }) },
  { name: "no gateway", text: OVER_BUDGET, state: makeState(), summarizer: null },
  { name: "failed turn", text: OVER_BUDGET, state: makeState({ failed: true }) },
  { name: "empty text", text: "", state: makeState() },
  { name: "whitespace text", text: " \n\t ", state: makeState() },
  { name: "handoff present", text: bigHandoff(), state: makeState() },
  { name: "content not condensed", text: "done", state: makeState() },
];

for (const gate of GATES) {
  test(`gate: ${gate.name} skips the summarizer`, async () => {
    const fake = fakeSummarizer();
    const result = await summarizeReport(
      baseOptions({
        text: gate.text,
        state: gate.state,
        summarizer: gate.summarizer === undefined ? fake.summarizer : gate.summarizer,
      }),
    );

    assert.equal(fake.callCount(), 0, "the summarizer must not be called");
    assertP0Digest(result, gate.text);
    assert.equal(result.error, undefined, "a closed gate is not a failure");
  });
}

test("gate: a precomputed facing is reused and still gated", async () => {
  const facing = modelFacingResult(OVER_BUDGET, { verbosity: "summary" });
  const fake = fakeSummarizer();
  const result = await summarizeReport(
    baseOptions({
      state: makeState({ facing: { ...facing, handoff: true } }),
      summarizer: fake.summarizer,
    }),
  );

  assert.equal(fake.callCount(), 0);
  assert.equal(result.summarized, false);
  assert.equal(result.facing.handoff, true);
});

// --- success --------------------------------------------------------------

test("success returns the summary, marks the content summarized, and records usage", async () => {
  const summary = "Status: done. Changed src/a.ts:12. Next: none.";
  const fake = fakeSummarizer({
    text: summary,
    usage: { inputTokens: 900, outputTokens: 42, costUsd: 0.0007, model: "provider/model-a" },
  });
  const result = await summarizeReport(baseOptions({ summarizer: fake.summarizer }));
  const request = fake.lastRequest();

  assert.equal(fake.callCount(), 1, "exactly one call per settled turn");
  assert.ok(request, "the request was recorded");
  assert.equal(request.text, OVER_BUDGET, "small text is sent untouched");
  assert.equal(result.summarized, true);
  assert.equal(result.error, undefined);
  assert.equal(result.facing.text, summary);
  assert.equal(result.facing.handoff, false);
  assert.equal(result.facing.condensed, true);
  assert.equal(result.usage?.inputTokens, 900);
  assert.equal(result.usage?.outputTokens, 42);
  assert.equal(result.usage?.costUsd, 0.0007);
  assert.equal(result.usage?.model, "provider/model-a");
  assert.ok((result.usage?.durationMs ?? -1) >= 0);
});

// --- failures -------------------------------------------------------------

test("a throwing summarizer leaves the P0 digest and reports \"error\"", async () => {
  const fake = fakeSummarizer({ fail: new Error("provider exploded") });
  const result = await summarizeReport(baseOptions({ summarizer: fake.summarizer }));

  assert.equal(fake.callCount(), 1);
  assertP0Digest(result, OVER_BUDGET);
  assert.equal(result.error, "error");
});

test("a never-resolving summarizer times out via the injected timeout", async () => {
  const fake = fakeSummarizer({ hang: true });
  const started = Date.now();
  const result = await summarizeReport(
    baseOptions({ summarizer: fake.summarizer, timeoutMs: 1 }),
  );
  const elapsed = Date.now() - started;

  assert.equal(fake.callCount(), 1);
  assertP0Digest(result, OVER_BUDGET);
  assert.equal(result.error, "timeout");
  assert.ok(elapsed < 2000, `returned in ${elapsed}ms, not a real 10 s wait`);
});

test("an abort signal returns \"aborted\" without awaiting the call forever", async () => {
  const fake = fakeSummarizer({ hang: true });
  const controller = new AbortController();
  const started = Date.now();
  const pending = summarizeReport(
    baseOptions({ summarizer: fake.summarizer, signal: controller.signal }),
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const result = await pending;
  const elapsed = Date.now() - started;

  assert.equal(fake.callCount(), 1);
  assertP0Digest(result, OVER_BUDGET);
  assert.equal(result.error, "aborted");
  assert.ok(elapsed < 2000, `returned in ${elapsed}ms`);
});

test("an already-aborted signal does not invoke the summarizer", async () => {
  const fake = fakeSummarizer();
  const controller = new AbortController();
  controller.abort();
  const result = await summarizeReport(
    baseOptions({ summarizer: fake.summarizer, signal: controller.signal }),
  );

  assert.equal(fake.callCount(), 0);
  assertP0Digest(result, OVER_BUDGET);
  assert.equal(result.error, "aborted");
});

test("an empty or whitespace summary is \"empty\" and keeps the digest", async () => {
  for (const text of ["", "   \n\t  "]) {
    const fake = fakeSummarizer({ text });
    const result = await summarizeReport(baseOptions({ summarizer: fake.summarizer }));

    assert.equal(fake.callCount(), 1);
    assertP0Digest(result, OVER_BUDGET);
    assert.equal(result.error, "empty");
  }
});

test("a summary identical to the input is \"empty\"", async () => {
  const fake = fakeSummarizer({ text: (request) => request.text });
  const result = await summarizeReport(baseOptions({ summarizer: fake.summarizer }));

  assert.equal(fake.callCount(), 1);
  assertP0Digest(result, OVER_BUDGET);
  assert.equal(result.error, "empty");
});

// --- budgets --------------------------------------------------------------

test("an oversized summary is condensed to the output budget, not failed", async () => {
  const fake = fakeSummarizer({ text: narration(400) });
  const result = await summarizeReport(baseOptions({ summarizer: fake.summarizer }));

  assert.equal(result.summarized, true);
  assert.equal(result.error, undefined);
  assert.ok(bytes(result.facing.text) <= SUMMARIZER_OUTPUT_MAX_BYTES);
  assert.match(result.facing.text, /report condensed for the caller/);
});

test("an oversized input reaches the summarizer at no more than 128 KiB", async () => {
  const text = narration(6000);
  assert.ok(bytes(text) > SUMMARIZER_INPUT_MAX_BYTES, "fixture is larger than the input budget");
  const fake = fakeSummarizer();
  const result = await summarizeReport(baseOptions({ text, summarizer: fake.summarizer }));
  const request = fake.lastRequest();

  assert.ok(request, "the summarizer was called");
  assert.ok(
    bytes(request.text) <= SUMMARIZER_INPUT_MAX_BYTES,
    `request was ${bytes(request.text)} bytes`,
  );
  assert.equal(result.summarized, true);
  assert.equal(result.error, undefined);
});

// --- error classification and privacy ------------------------------------

test("auth failures are classified from the status, not the message", async () => {
  for (const status of [401, 403]) {
    const failure = Object.assign(new Error("invalid key sk-secret"), { status });
    const fake = fakeSummarizer({ fail: failure });
    const result = await summarizeReport(baseOptions({ summarizer: fake.summarizer }));

    assert.equal(result.error, "auth");
    assertP0Digest(result, OVER_BUDGET);
  }
});

test("network/unavailable failures are classified from the code", async () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
    const failure = Object.assign(new Error(`connect ${code} 127.0.0.1`), { code });
    const fake = fakeSummarizer({ fail: failure });
    const result = await summarizeReport(baseOptions({ summarizer: fake.summarizer }));

    assert.equal(result.error, "unavailable", code);
    assertP0Digest(result, OVER_BUDGET);
  }
});

test("a provider 5xx is a plain \"error\"", async () => {
  const fake = fakeSummarizer({ fail: Object.assign(new Error("upstream"), { status: 503 }) });
  const result = await summarizeReport(baseOptions({ summarizer: fake.summarizer }));

  assert.equal(result.error, "error");
});

test("no provider error message text appears in the result", async () => {
  const marker = "PROVIDER-SECRET-TEXT-should-never-leak";
  const fake = fakeSummarizer({ fail: new Error(`${marker} original provider message`) });
  const result = await summarizeReport(baseOptions({ summarizer: fake.summarizer }));

  assert.equal(result.error, "error");
  assert.ok(!JSON.stringify(result).includes(marker));
  assert.ok(!JSON.stringify(result).includes("original provider message"));
});
