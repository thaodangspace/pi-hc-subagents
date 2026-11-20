import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createRuntime } from "../../src/runtime/runtime.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();

test("createRuntime returns available inside an isolated hc terminal", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const agentDir = await mkdtemp(path.join("/tmp", "hcr-"));
  try {
    const runtime = await createRuntime({
      cwd: isolated.root,
      trusted: true,
      parentSessionId: "it-session",
      env: isolated.env,
      agentDir,
    });
    assert.equal(runtime.available, true);
    assert.equal(runtime.mode, "ready");
    assert.equal(runtime.prerequisites.reason, "ok");
    assert.equal(runtime.parentTerminalId, isolated.parentTerminal?.address);
    assert.match(runtime.prerequisites.coreVersion ?? "", /^0\.1\./);
    assert.equal(runtime.config.maxConcurrency, 4);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await isolated.cleanup();
  }
});

test("createRuntime selects setup mode outside hc", async () => {
  const root = await mkdtemp(path.join("/tmp", "hcr-"));
  try {
    const runtime = await createRuntime({
      cwd: root,
      trusted: false,
      parentSessionId: "it-session",
      env: { PATH: process.env.PATH ?? "" },
      agentDir: root,
    });
    assert.equal(runtime.available, false);
    assert.equal(runtime.mode, "setup");
    assert.equal(runtime.prerequisites.reason, "missing_env");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
