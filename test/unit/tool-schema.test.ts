import assert from "node:assert/strict";
import test from "node:test";

import { registerControlTool } from "../../src/tools/control-tool.ts";
import { registerSpawnTool } from "../../src/tools/spawn-tool.ts";

interface VerbositySchema {
  type?: string;
  enum?: string[];
  description?: string;
}

interface ToolDefinition {
  name: string;
  parameters: {
    properties: Record<string, VerbositySchema>;
    required?: string[];
  };
}

/** Register both tools against a stub pi and keep their definitions. */
function toolDefinitions(): Map<string, ToolDefinition> {
  const definitions = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(definition: ToolDefinition) {
      definitions.set(definition.name, definition);
    },
  } as never;
  registerSpawnTool(pi, () => null);
  registerControlTool(pi, () => null);
  return definitions;
}

const definitions = toolDefinitions();

test("hc_subagent exposes verbosity as an optional summary|full enum", () => {
  const definition = definitions.get("hc_subagent");
  assert.ok(definition, "hc_subagent is registered");
  const verbosity = definition.parameters.properties.verbosity;
  assert.ok(verbosity, "verbosity is part of the schema");
  assert.equal(verbosity.type, "string");
  assert.deepEqual(verbosity.enum, ["summary", "full"]);
  assert.equal(definition.parameters.required?.includes("verbosity") ?? false, false);
  assert.match(verbosity.description ?? "", /summary \(default, ~8 KiB, handoff section only\)/);
  assert.match(verbosity.description ?? "", /full \(up to 50 KiB\)/);
});

test("hc_subagent_control exposes the same verbosity enum and documents the ignored actions", () => {
  const definition = definitions.get("hc_subagent_control");
  assert.ok(definition, "hc_subagent_control is registered");
  const verbosity = definition.parameters.properties.verbosity;
  assert.ok(verbosity, "verbosity is part of the schema");
  assert.equal(verbosity.type, "string");
  assert.deepEqual(verbosity.enum, ["summary", "full"]);
  assert.equal(definition.parameters.required?.includes("verbosity") ?? false, false);
  const description = verbosity.description ?? "";
  assert.match(description, /Result detail for wait and result/);
  assert.match(description, /Ignored by list, output, attach, interrupt, kill, and send/);
});
