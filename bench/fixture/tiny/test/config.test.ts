import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, loadConfig, validateConfig } from "../src/config.ts";

test("loads defaults when env is empty", () => {
  const config = loadConfig({});
  assert.equal(config.port, 8080);
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(config.retries, DEFAULT_RETRIES);
});

test("rejects a negative timeout", () => {
  assert.throws(() => loadConfig({ TIMEOUT_MS: "-1" }), /non-negative integer/);
});

test("validateConfig rejects an out of range port", () => {
  assert.throws(() => validateConfig({ port: 0, timeoutMs: 1, retries: 1 }), /port out of range/);
});
