/**
 * Test hooks. These are environment switches used only by the test suite; they
 * are documented as test-only and are never required in production.
 */

export const TEST_CHILD_ENV = "PI_HC_SUBAGENTS_TEST_CHILD";
export const TEST_CHILD_MODE_ENV = "PI_HC_TEST_CHILD_MODE";
export const TEST_RUNS_ROOT_ENV = "PI_HC_SUBAGENTS_RUNS_ROOT";
export const LIVE_MODEL_ENV = "PI_HC_SUBAGENTS_LIVE_MODEL";

export type FakeChildMode =
  | "success"
  | "error"
  | "blocked"
  | "startup-idle"
  | "empty"
  | "length"
  | "aborted"
  | "tooluse"
  | "silent"
  | "exit-early";

export function isTestChildEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env[TEST_CHILD_ENV] === "string" && env[TEST_CHILD_ENV].length > 0;
}

export function fakeChildMode(env: NodeJS.ProcessEnv = process.env): FakeChildMode {
  const value = env[TEST_CHILD_MODE_ENV];
  switch (value) {
    case "error":
    case "blocked":
    case "startup-idle":
    case "empty":
    case "length":
    case "aborted":
    case "tooluse":
    case "silent":
    case "exit-early":
      return value;
    default:
      return "success";
  }
}

export function liveModelTestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_MODEL_ENV] === "1";
}
