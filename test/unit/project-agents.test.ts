import assert from "node:assert/strict";
import test from "node:test";

import type { AgentDefinition } from "../../src/agents/agents.ts";
import { authorizeProjectAgent } from "../../src/agents/project-policy.ts";

function agent(source: AgentDefinition["source"], name = "reviewer"): AgentDefinition {
  return {
    name,
    description: "test agent",
    systemPrompt: "be useful",
    access: "read-only",
    source,
    filePath: `/repo/.pi/agents/${name}.md`,
  };
}

test("user and package agents need no project confirmation", async () => {
  await authorizeProjectAgent(agent("user"), { trusted: false, allowWithoutPrompt: false, hasUI: false });
  await authorizeProjectAgent(agent("package"), { trusted: false, allowWithoutPrompt: false, hasUI: false });
});

test("an untrusted project agent is rejected even when pre-approved", async () => {
  await assert.rejects(
    authorizeProjectAgent(agent("project"), { trusted: false, allowWithoutPrompt: true, hasUI: true }),
    /trusted project/,
  );
});

test("a trusted project agent with explicit pre-approval needs no prompt", async () => {
  let prompted = false;
  await authorizeProjectAgent(agent("project"), {
    trusted: true,
    allowWithoutPrompt: true,
    hasUI: true,
    confirm: async () => {
      prompted = true;
      return false;
    },
  });
  assert.equal(prompted, false);
});

test("a trusted project agent prompts and can be declined", async () => {
  await authorizeProjectAgent(agent("project"), {
    trusted: true,
    allowWithoutPrompt: false,
    hasUI: true,
    confirm: async () => true,
  });
  await assert.rejects(
    authorizeProjectAgent(agent("project"), {
      trusted: true,
      allowWithoutPrompt: false,
      hasUI: true,
      confirm: async () => false,
    }),
    /was not confirmed/,
  );
});

test("a project agent without UI and without pre-approval is rejected explicitly", async () => {
  await assert.rejects(
    authorizeProjectAgent(agent("project"), { trusted: true, allowWithoutPrompt: false, hasUI: false }),
    /requires confirmation, but no UI is available/,
  );
});
