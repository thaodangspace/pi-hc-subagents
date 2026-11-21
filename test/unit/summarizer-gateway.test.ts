/**
 * Gateway builder tests. Every pi-touching input (model, auth, generate,
 * thinking level, stream) is a fake, so no network, credentials, or model
 * access is involved.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SUMMARIZER_INSTRUCTIONS,
  createSummarizerGateway,
  type SummarizerGenerateRequest,
} from "../../src/runtime/summarizer-gateway.ts";
import { summarizeReport } from "../../src/runtime/summarizer.ts";

const MODEL = { provider: "test-provider", id: "model-a" } as const;

/** Narration with no handoff: `modelFacingResult` condenses it by default. */
function narration(lines: number): string {
  const line = `Step: ${"observed output and reasoned about it ".repeat(3)}`;
  return Array.from({ length: lines }, (_, index) => `${line}${index}`).join("\n");
}

// --- building the gateway --------------------------------------------------

test("no auth yields null plus exactly one warning", async () => {
  const authCalls: unknown[] = [];
  const gateway = await createSummarizerGateway({
    model: MODEL,
    getAuth: (model) => {
      authCalls.push(model);
      return { ok: false, error: "PROVIDER-SECRET-should-never-leak" };
    },
    generate: () => {
      throw new Error("generate must not be called without auth");
    },
  });

  assert.equal(gateway.summarizer, null);
  assert.equal(gateway.warnings.length, 1);
  assert.equal(gateway.warnings[0]?.field, "resultSummarizer");
  assert.equal(gateway.warnings[0]?.reason, "no-auth");
  assert.ok(
    !gateway.warnings[0]?.message.includes("PROVIDER-SECRET-should-never-leak"),
    "auth error text must not reach a warning",
  );
  assert.deepEqual(authCalls, [MODEL], "the auth lookup is asked about the parent model");
});

test("resolved auth builds a summarizer function", async () => {
  const gateway = await createSummarizerGateway({
    model: MODEL,
    getAuth: () => ({ ok: true, apiKey: "api-key-123", headers: { "x-test": "1" } }),
    generate: async () => ({ text: "compressed" }),
  });

  assert.equal(typeof gateway.summarizer, "function");
  assert.deepEqual(gateway.warnings, []);
});

test("a missing parent model yields null plus one warning", async () => {
  for (const model of [undefined, null]) {
    let called = false;
    const gateway = await createSummarizerGateway({
      model,
      getAuth: () => {
        called = true;
        return { ok: true, apiKey: "api-key-123" };
      },
      generate: async () => ({ text: "compressed" }),
    });

    assert.equal(gateway.summarizer, null);
    assert.equal(gateway.warnings.length, 1);
    assert.equal(gateway.warnings[0]?.reason, "no-model");
    assert.equal(called, false, "no model means no auth lookup");
  }
});

test("a throwing auth lookup is a soft failure, not a rejection", async () => {
  const gateway = await createSummarizerGateway({
    model: MODEL,
    getAuth: () => {
      throw new Error("credential store exploded");
    },
    generate: async () => ({ text: "compressed" }),
  });

  assert.equal(gateway.summarizer, null);
  assert.equal(gateway.warnings.length, 1);
  assert.equal(gateway.warnings[0]?.reason, "no-auth");
  assert.ok(!gateway.warnings[0]?.message.includes("credential store exploded"));
});

// --- the summarizer the gateway returns ------------------------------------

test("the request carries the instructions, the model, and the caller's signal", async () => {
  const requests: SummarizerGenerateRequest<typeof MODEL, "high", string>[] = [];
  const gateway = await createSummarizerGateway<typeof MODEL, "high", string>({
    model: MODEL,
    getAuth: async () => ({ ok: true, apiKey: "api-key-123", headers: { "x-test": "1" } }),
    generate: async (request) => {
      requests.push(request);
      return {
        text: "compressed report",
        usage: { input: 1200, output: 180, cost: { total: 0.0004 } },
      };
    },
    thinkingLevel: "high",
    streamFn: "stream-fake",
  });
  const summarizer = gateway.summarizer;
  assert.ok(summarizer, "auth resolved, so a summarizer exists");

  const controller = new AbortController();
  const response = await summarizer({ text: "child report", signal: controller.signal });

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.instructions, SUMMARIZER_INSTRUCTIONS);
  assert.deepEqual(request.model, MODEL);
  assert.equal(request.text, "child report");
  assert.equal(request.apiKey, "api-key-123");
  assert.deepEqual(request.headers, { "x-test": "1" });
  assert.equal(request.signal, controller.signal, "the caller's signal is forwarded untouched");
  assert.equal(request.thinkingLevel, "high");
  assert.equal(request.streamFn, "stream-fake");

  assert.deepEqual(response, {
    text: "compressed report",
    usage: {
      inputTokens: 1200,
      outputTokens: 180,
      costUsd: 0.0004,
      model: "test-provider/model-a",
    },
  });
});

test("missing provider usage maps to zeros, keeping the model reference", async () => {
  const gateway = await createSummarizerGateway({
    model: MODEL,
    getAuth: () => ({ ok: true, apiKey: "api-key-123" }),
    generate: async () => ({ text: "compressed report" }),
  });
  const summarizer = gateway.summarizer;
  assert.ok(summarizer);

  const response = await summarizer({ text: "child report", signal: new AbortController().signal });

  assert.equal(response.text, "compressed report");
  assert.deepEqual(response.usage, {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    model: "test-provider/model-a",
  });
});

test("a generate throw rejects and the runner turns it into one stable code", async () => {
  const marker = "PROVIDER-SECRET-should-never-leak";
  const gateway = await createSummarizerGateway({
    model: MODEL,
    getAuth: () => ({ ok: true, apiKey: "api-key-123" }),
    generate: () => Promise.reject(new Error(`${marker} upstream exploded`)),
  });
  assert.ok(gateway.summarizer);

  const result = await summarizeReport({
    text: narration(200),
    verbosity: "summary",
    summarizer: gateway.summarizer,
    state: { enabled: true, failed: false },
  });

  assert.equal(result.summarized, false);
  assert.equal(result.error, "error");
  assert.ok(!JSON.stringify(result).includes(marker));
});

// --- instructions ----------------------------------------------------------

test("SUMMARIZER_INSTRUCTIONS stays extract-only and forbids invention and code", () => {
  assert.match(SUMMARIZER_INSTRUCTIONS, /never invent/i);
  assert.match(SUMMARIZER_INSTRUCTIONS, /code fences/i);
  assert.match(SUMMARIZER_INSTRUCTIONS, /no preamble/i);
  assert.match(SUMMARIZER_INSTRUCTIONS, /do not add recommendations, opinions, or analysis/i);
  assert.match(SUMMARIZER_INSTRUCTIONS, /at most 900 words/i);
  assert.ok(
    !SUMMARIZER_INSTRUCTIONS.includes("```"),
    "the prompt itself contains no code fence",
  );
  assert.ok(SUMMARIZER_INSTRUCTIONS.split(/\s+/).length <= 900);
});
