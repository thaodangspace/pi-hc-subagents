import assert from "node:assert/strict";
import test from "node:test";

import hcSubagentsExtension from "../../index.ts";

interface RecordedRegistration {
  kind: "tool" | "command" | "handler";
  name: string;
}

function createMockPi(): { pi: any; registrations: RecordedRegistration[] } {
  const registrations: RecordedRegistration[] = [];
  const pi = {
    on(name: string) {
      registrations.push({ kind: "handler", name });
      return () => {};
    },
    registerTool(definition: { name: string }) {
      registrations.push({ kind: "tool", name: definition.name });
    },
    registerCommand(name: string) {
      registrations.push({ kind: "command", name });
    },
    registerMessageRenderer() {},
    appendEntry() {},
    sendMessage() {},
  };
  return { pi, registrations };
}

test("the extension module loads with a mock pi API and registers no tools up front", () => {
  const { pi, registrations } = createMockPi();
  assert.doesNotThrow(() => hcSubagentsExtension(pi));
  assert.deepEqual(registrations, [
    { kind: "command", name: "hc-subagents" },
    { kind: "handler", name: "session_start" },
    { kind: "handler", name: "agent_settled" },
    { kind: "handler", name: "session_before_compact" },
    { kind: "handler", name: "session_compact" },
    { kind: "handler", name: "session_compact_failed" },
    { kind: "handler", name: "session_shutdown" },
  ]);
  assert.equal(registrations.some((registration) => registration.kind === "tool"), false);
});
