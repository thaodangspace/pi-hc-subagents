/**
 * Children default to the parent's model and thinking level.
 *
 * pi's `--model` is only added when the agent pins one; without this default a
 * child quietly ran on pi's ambient model, which can be a different provider
 * and fail on its first turn.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createRuntime, modelRef } from "../../src/runtime/runtime.ts";

test("modelRef builds the provider/id reference pi accepts", () => {
  assert.equal(modelRef({ provider: "deepseek", id: "deepseek-flash" }), "deepseek/deepseek-flash");
  assert.equal(modelRef({ id: "solo-id" }), "solo-id");
  assert.equal(modelRef({ provider: "p", id: "  " }), null);
  assert.equal(modelRef(null), null);
  assert.equal(modelRef(undefined), null);
});

test("createRuntime records the parent model and thinking defaults", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-defaults-"));
  try {
    const runtime = await createRuntime({
      cwd: root,
      trusted: false,
      parentSessionId: "parent-session",
      env: { PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: root },
      agentDir: root,
      parentModel: "deepseek/deepseek-flash",
      parentThinking: "high",
    });
    assert.equal(runtime.parentModel, "deepseek/deepseek-flash");
    assert.equal(runtime.parentThinking, "high");
    assert.equal(runtime.available, false, "no core env means setup mode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
