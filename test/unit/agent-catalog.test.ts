import assert from "node:assert/strict";
import test from "node:test";

import {
  agentCatalogSection,
  buildAgentCatalog,
  registerAgentCatalogPrompt,
} from "../../src/runtime/agent-catalog.ts";
import type { AgentDefinition } from "../../src/agents/agents.ts";
import type { ToolSession } from "../../src/tools/session.ts";

function agent(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: "reviewer",
    description: "Review code for correctness and security",
    systemPrompt: "",
    tools: ["read", "grep"],
    access: "read-only",
    source: "package",
    filePath: "/agents/reviewer.md",
    ...overrides,
  };
}

test("the catalog lists agent names, descriptions, access, and a bound", () => {
  const catalog = buildAgentCatalog(
    [
      agent({}),
      agent({ name: "worker", description: "Implement changes", access: "write" }),
      agent({ name: "extra", description: "Third" }),
    ],
    "user",
    2,
  );
  assert.equal(catalog.total, 3);
  assert.equal(catalog.remaining, 1);
  const text = agentCatalogSection(catalog);
  assert.match(text, /reviewer \(package, read-only\): Review code/);
  assert.match(text, /worker \(package\): Implement changes/);
  assert.equal(text.includes("extra"), false);
  assert.match(text, /1 more agents are not shown/);
  assert.match(text, /discovery scope: user/);
  assert.match(text, /agentScope: "both"/);
});

test("descriptions are flattened and bounded before they enter the prompt", () => {
  const catalog = buildAgentCatalog(
    [agent({ description: `line one\nline two\t${"x".repeat(300)}` })],
    "both",
  );
  assert.equal(catalog.text.includes("\nline two"), false);
  assert.equal(catalog.text.split("\n").length, 1);
  assert.ok(catalog.text.length < 240);
});

test("before_agent_start injects the section from a fresh cached catalog", async () => {
  let handler: ((event: any) => Promise<void>) | undefined;
  const pi = {
    on(name: string, fn: any) {
      if (name === "before_agent_start") handler = fn;
      return () => {};
    },
  } as any;
  const catalog = buildAgentCatalog([agent({})], "both");
  const session = {
    agentCatalog: catalog,
    agentCatalogAt: Date.now(),
  } as unknown as ToolSession;
  registerAgentCatalogPrompt(pi, () => session);
  assert.ok(handler);

  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  await handler(event);
  const section = event.systemPromptOptions.sections["hc-subagents-agents"] ?? "";
  assert.match(section, /reviewer \(package, read-only\): Review code for correctness and security/);
});
