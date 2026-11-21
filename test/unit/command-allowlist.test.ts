import assert from "node:assert/strict";
import test from "node:test";

import {
  isCommandAllowed,
  parseAllowedCommands,
  validateAllowedCommand,
} from "../../src/child/command-allowlist.ts";

test("a prefix allows the exact command or one with arguments", () => {
  const allowed = ["git status", "npm test"];
  assert.equal(isCommandAllowed("git status", allowed), true);
  assert.equal(isCommandAllowed("git status --short", allowed), true);
  assert.equal(isCommandAllowed("npm test -- --runInBand", allowed), true);
  assert.equal(isCommandAllowed("git statusX", allowed), false);
  assert.equal(isCommandAllowed("git stash", allowed), false);
});

test("chaining, redirection, substitution, and control characters are rejected", () => {
  const allowed = ["git status"];
  for (const command of [
    "git status; rm -rf /",
    "git status && rm -rf /",
    "git status || true",
    "git status | tee out",
    "git status > out",
    "git status $(whoami)",
    "git status `whoami`",
    "git status\nrm -rf /",
    "git status &",
    "git status \\\n rm -rf /",
  ]) {
    assert.equal(isCommandAllowed(command, allowed), false, command);
  }
});

test("allowed command prefixes are validated and bounded", () => {
  assert.equal(validateAllowedCommand("git status"), null);
  assert.equal(validateAllowedCommand("  npm test  "), null);
  assert.match(validateAllowedCommand("git status; rm -rf /") ?? "", /metacharacters/);
  assert.match(validateAllowedCommand("") ?? "", /empty/);
  assert.match(validateAllowedCommand("x".repeat(201)) ?? "", /exceeds/);
  assert.notEqual(validateAllowedCommand(42), null);
});

test("the child env marker fails closed when it is malformed", () => {
  assert.deepEqual(parseAllowedCommands(undefined), { allowed: [], valid: true });
  assert.deepEqual(parseAllowedCommands(""), { allowed: [], valid: true });
  assert.deepEqual(parseAllowedCommands('["git status"]'), { allowed: ["git status"], valid: true });
  assert.deepEqual(parseAllowedCommands('{"allowed":["git status"]}'), { allowed: [], valid: false });
  assert.deepEqual(parseAllowedCommands("not json"), { allowed: [], valid: false });
  assert.deepEqual(parseAllowedCommands('["git status; rm -rf /"]'), { allowed: [], valid: false });
});
