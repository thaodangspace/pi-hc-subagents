import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { formatConfigDiagnostics, loadConfig } from "../../src/config/config.ts";
import { DEFAULT_CONFIG, envOverrides, validateConfig } from "../../src/config/schema.ts";

async function scratch(): Promise<string> {
  return mkdtemp(path.join("/tmp", "hc-cfg-"));
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf8");
}

test("defaults match the approved configuration", () => {
  assert.equal(DEFAULT_CONFIG.maxConcurrency, 4);
  assert.equal(DEFAULT_CONFIG.defaultMode, "sync");
  assert.equal(DEFAULT_CONFIG.startupTimeoutMs, 60_000);
  assert.equal(DEFAULT_CONFIG.waitTimeoutMs, 600_000);
  assert.equal(DEFAULT_CONFIG.pollIntervalMs, 750);
  assert.equal(DEFAULT_CONFIG.killOnAbort, true);
  assert.equal(DEFAULT_CONFIG.killOnTimeout, false);
  assert.equal(DEFAULT_CONFIG.agentScope, "user");
  assert.equal(DEFAULT_CONFIG.parallelWrites, false);
  assert.equal(DEFAULT_CONFIG.cleanup, "keep");
  assert.equal(DEFAULT_CONFIG.retentionDays, 14);
  assert.deepEqual(DEFAULT_CONFIG.excludeTools, ["hc_subagent", "hc_subagent_control"]);
  assert.equal(DEFAULT_CONFIG.exposure, "direct");
  assert.deepEqual(DEFAULT_CONFIG.intertool, {
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  });
});

test("precedence is env > project > global > defaults", async () => {
  const root = await scratch();
  try {
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    await writeJson(path.join(agentDir, "hc-subagents.json"), {
      maxConcurrency: 2,
      waitTimeoutMs: 120_000,
      defaultMode: "async",
    });
    await writeJson(path.join(cwd, ".pi", "hc-subagents.json"), {
      maxConcurrency: 3,
      cleanup: "remove",
    });

    const loaded = await loadConfig({
      cwd,
      trusted: true,
      agentDir,
      env: { PI_HC_SUBAGENTS_MAX_CONCURRENCY: "5" },
    });
    assert.equal(loaded.config.maxConcurrency, 5);
    assert.equal(loaded.config.waitTimeoutMs, 120_000);
    assert.equal(loaded.config.defaultMode, "async");
    assert.equal(loaded.config.cleanup, "remove");
    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.paths.projectIgnored, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an untrusted project config is ignored", async () => {
  const root = await scratch();
  try {
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    await writeJson(path.join(agentDir, "hc-subagents.json"), { maxConcurrency: 2 });
    await writeJson(path.join(cwd, ".pi", "hc-subagents.json"), { maxConcurrency: 9, cleanup: "remove" });

    const loaded = await loadConfig({ cwd, trusted: false, agentDir, env: {} });
    assert.equal(loaded.config.maxConcurrency, 2);
    assert.equal(loaded.config.cleanup, "keep");
    assert.equal(loaded.paths.projectIgnored, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid known fields warn once and keep the lower-precedence value", async () => {
  const root = await scratch();
  try {
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    await writeJson(path.join(agentDir, "hc-subagents.json"), {
      maxConcurrency: 99,
      pollIntervalMs: "fast",
      agentScope: "everyone",
      excludeTools: ["a", 3, "a"],
      intertool: { exposeService: "yes", emitEvents: false },
      unknownField: true,
    });

    const loaded = await loadConfig({ cwd, trusted: true, agentDir, env: {} });
    assert.equal(loaded.config.maxConcurrency, DEFAULT_CONFIG.maxConcurrency);
    assert.equal(loaded.config.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs);
    assert.equal(loaded.config.agentScope, DEFAULT_CONFIG.agentScope);
    assert.deepEqual(loaded.config.excludeTools, ["a"]);
    assert.equal(loaded.config.intertool.exposeService, true);
    assert.equal(loaded.config.intertool.emitEvents, false);
    const fields = loaded.warnings.map((warning) => warning.field).sort();
    assert.deepEqual(fields, ["agentScope", "excludeTools", "intertool.exposeService", "maxConcurrency", "pollIntervalMs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed config files warn without crashing", async () => {
  const root = await scratch();
  try {
    const agentDir = path.join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "hc-subagents.json"), "{not json", "utf8");
    const loaded = await loadConfig({ cwd: root, trusted: true, agentDir, env: {} });
    assert.equal(loaded.config.maxConcurrency, DEFAULT_CONFIG.maxConcurrency);
    assert.equal(loaded.warnings[0]?.source, "global");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment overrides accept valid values and warn about invalid ones", () => {
  const valid = envOverrides({
    PI_HC_SUBAGENTS_MAX_CONCURRENCY: "8",
    PI_HC_SUBAGENTS_WAIT_TIMEOUT_MS: "900000",
    PI_HC_SUBAGENTS_AGENT_SCOPE: "both",
  });
  assert.deepEqual(valid.warnings, []);
  assert.equal(valid.value.maxConcurrency, 8);
  assert.equal(valid.value.waitTimeoutMs, 900_000);
  assert.equal(valid.value.agentScope, "both");

  const invalid = envOverrides({
    PI_HC_SUBAGENTS_MAX_CONCURRENCY: "0",
    PI_HC_SUBAGENTS_POLL_MS: "5",
    PI_HC_SUBAGENTS_AGENT_SCOPE: "all",
  });
  assert.equal(invalid.value.maxConcurrency, undefined);
  assert.equal(invalid.value.pollIntervalMs, undefined);
  assert.equal(invalid.value.agentScope, undefined);
  assert.equal(invalid.warnings.length, 3);
});

test("validateConfig ignores unknown fields and deep-merges intertool", () => {
  const result = validateConfig({ intertool: { emitEvents: false }, nothing: 1 }, "global");
  assert.deepEqual(result.value, { intertool: { emitEvents: false } });
  assert.deepEqual(result.warnings, []);
});

test("config diagnostics include paths, warnings, and flags", async () => {
  const root = await scratch();
  try {
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    await writeJson(path.join(agentDir, "hc-subagents.json"), { maxConcurrency: 99 });
    const loaded = await loadConfig({ cwd, trusted: false, agentDir, env: {} });
    const text = formatConfigDiagnostics(loaded, { "agents.user": "/x" });
    assert.match(text, /global: .*hc-subagents\.json/);
    assert.match(text, /project: .*\(absent\)/);
    assert.match(text, /agents\.user: \/x/);
    assert.match(text, /maxConcurrency/);
    assert.match(text, /warnings:/);
    assert.match(text, /global\.maxConcurrency/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
