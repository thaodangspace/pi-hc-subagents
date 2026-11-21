import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  discoverAgents,
  effectiveAgentTools,
  formatAgentList,
  resolveAgent,
  validateAgentForSpawn,
} from "../../src/agents/agents.ts";
import { HcSubagentError } from "../../src/core/error.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/agents");
const userAgentDir = path.join(fixtures, "user");
const projectCwd = path.join(fixtures, "project");
const packageDir = path.join(fixtures, "package", "agents");

async function discover(overrides: Partial<Parameters<typeof discoverAgents>[0]> = {}) {
  return discoverAgents({
    cwd: projectCwd,
    scope: "both",
    trusted: true,
    agentDir: userAgentDir,
    packageDir,
    ...overrides,
  });
}

test("merges package, user, and project sources with project > user > package", async () => {
  const result = await discover();
  const names = result.agents.map((agent) => agent.name);
  assert.ok(names.includes("scout"));
  assert.ok(names.includes("reviewer"));
  assert.ok(names.includes("logger"));

  const scout = resolveAgent(result, "scout");
  assert.equal(scout.source, "user");
  assert.match(scout.description, /User scout/);

  const reviewer = resolveAgent(result, "reviewer");
  assert.equal(reviewer.source, "project");
  assert.match(reviewer.description, /Project reviewer/);
  assert.equal(reviewer.access, "read-only");

  const logger = resolveAgent(result, "logger");
  assert.equal(logger.source, "package");
  assert.equal(logger.name, "logger", "name defaults to the filename stem");
});

test("string and array tools are both accepted", async () => {
  const result = await discover();
  const stringTools = resolveAgent(result, "string-tools");
  assert.deepEqual(stringTools.tools, ["read", "write", "grep"]);
  assert.equal(stringTools.thinking, "high");
  assert.equal(stringTools.model, "anthropic/claude-sonnet-4-5");
  assert.deepEqual(stringTools.skills, ["one", "two"]);
  assert.deepEqual(stringTools.extensions, ["./ext-a.ts"]);
  assert.equal(stringTools.cwd, "sub");
  assert.equal(stringTools.access, "write");

  const inferred = resolveAgent(result, "inferred-read");
  assert.deepEqual(inferred.tools, ["read", "grep"]);
  assert.equal(inferred.access, "read-only");
});

test("access inference follows the approved rules", async () => {
  const result = await discover();
  assert.equal(resolveAgent(result, "inferred-write").access, "write");
  assert.equal(resolveAgent(result, "inferred-read").access, "read-only");
  assert.equal(resolveAgent(result, "string-tools").access, "write");
  assert.deepEqual(effectiveAgentTools(resolveAgent(result, "inferred-read")), ["read", "grep"]);
});

test("disallowedTools narrows the effective tool set and allowedCommands is parsed", async () => {
  const result = await discover();
  const guarded = resolveAgent(result, "guarded");
  assert.deepEqual(guarded.disallowedTools, ["edit", "write"]);
  assert.deepEqual(guarded.allowedCommands, ["git status", "npm test"]);
  assert.equal(guarded.access, "write");
  assert.deepEqual(effectiveAgentTools(guarded), ["read", "bash", "grep"]);
  assert.doesNotThrow(() => validateAgentForSpawn(guarded, { trusted: true }));

  const listing = formatAgentList(result.agents, 40).text;
  assert.match(listing, /- guarded \(user\): Write agent with a deny list/);
  assert.match(listing, /- scout \(user, read-only\):/);
});

test("validateAgentForSpawn uses the tool set after disallowedTools", () => {
  const base = {
    name: "guarded-reader",
    description: "guarded",
    systemPrompt: "",
    tools: ["read", "bash"],
    access: "read-only" as const,
    source: "user" as const,
    filePath: "/tmp/guarded-reader.md",
  };
  assert.doesNotThrow(() =>
    validateAgentForSpawn({ ...base, disallowedTools: ["bash"] }, { trusted: true }),
  );
  assert.throws(
    () => validateAgentForSpawn({ ...base, disallowedTools: ["read", "grep", "find", "ls"] }, { trusted: true }),
    (error: unknown) => error instanceof HcSubagentError && error.code === "validation",
  );

  // A write agent with an explicit allowlist cannot fall back to pi defaults.
  assert.throws(
    () =>
      validateAgentForSpawn(
        {
          ...base,
          access: "write",
          tools: ["edit"],
          disallowedTools: ["edit"],
        },
        { trusted: true },
      ),
    (error: unknown) => error instanceof HcSubagentError && /no tools left/.test(error.message),
  );
});

test("malformed files, missing descriptions, bad names, and invalid thinking do not break discovery", async () => {
  const result = await discover();
  const names = result.agents.map((agent) => agent.name);
  assert.ok(!names.includes("no-description"));
  assert.ok(!names.includes("Bad_Name"));

  const invalidThinking = resolveAgent(result, "invalid-thinking");
  assert.equal(invalidThinking.thinking, undefined);
  assert.ok(result.warnings.some((warning) => warning.filePath?.endsWith("broken.md")));
  assert.ok(result.warnings.some((warning) => warning.field === "description"));
  assert.ok(result.warnings.some((warning) => warning.field === "thinking"));
  // Valid agents still load despite the broken siblings.
  assert.ok(names.includes("inferred-write"));
});

test("project agents are not loaded when the project is untrusted", async () => {
  const result = await discover({ trusted: false });
  assert.equal(result.projectAgentsSkipped, true);
  assert.throws(
    () => resolveAgent(result, "reviewer"),
    (error: unknown) => error instanceof HcSubagentError && error.code === "not_found",
  );
});

test("user scope excludes project agents", async () => {
  const result = await discover({ scope: "user" });
  assert.equal(result.projectAgentsDir, null);
  assert.throws(() => resolveAgent(result, "reviewer"));
  assert.ok(result.agents.some((agent) => agent.name === "scout"));
});

test("validateAgentForSpawn rejects read-only agents with write tools", () => {
  const agent = {
    name: "bad",
    description: "bad",
    systemPrompt: "",
    tools: ["read", "bash"],
    access: "read-only" as const,
    source: "user" as const,
    filePath: "/tmp/bad.md",
  };
  assert.throws(
    () => validateAgentForSpawn(agent, { trusted: true }),
    (error: unknown) => error instanceof HcSubagentError && error.code === "validation",
  );
  assert.doesNotThrow(() => validateAgentForSpawn({ ...agent, tools: ["read"] }, { trusted: true }));
});

test("unknown agents list the available names", async () => {
  const result = await discover();
  assert.throws(
    () => resolveAgent(result, "missing"),
    (error: unknown) =>
      error instanceof HcSubagentError && error.code === "not_found" && /available:/.test(error.message),
  );
});

test("formatAgentList bounds long lists", async () => {
  const result = await discover();
  const formatted = formatAgentList(result.agents, 2);
  assert.equal(formatted.remaining, result.agents.length - 2);
  assert.equal(formatAgentList([]).text, "none");
});
