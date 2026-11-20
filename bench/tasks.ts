/**
 * Task suites and deterministic answer verification.
 *
 * A verifier is a literal check over the final assistant message. There is no
 * model judge: a run is `resolved` only when every `all` string, at least one
 * `any` string, and none of the `none` strings appear.
 */
import { readFile } from "node:fs/promises";

import type { ExpectSpec, TaskSpec, TaskSuite } from "./types.ts";

export interface Verification {
  resolved: boolean;
  missing: string[];
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+/g, " ");
}

function appears(haystack: string, needle: string): boolean {
  return haystack.includes(normalize(needle).trim().toLowerCase());
}

export function verifyAnswer(answer: string, expect: ExpectSpec): Verification {
  const haystack = normalize(answer).toLowerCase();
  const missing: string[] = [];

  for (const entry of expect.all ?? []) {
    if (!appears(haystack, entry)) missing.push(entry);
  }

  const any = expect.any ?? [];
  if (any.length > 0 && !any.some((entry) => appears(haystack, entry))) {
    missing.push(`(any of) ${any.join(" | ")}`);
  }

  for (const entry of expect.none ?? []) {
    if (appears(haystack, entry)) missing.push(`(forbidden) ${entry}`);
  }

  return { resolved: missing.length === 0, missing };
}

function fail(message: string): never {
  throw new Error(`invalid task suite: ${message}`);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    fail(`${field} must be a non-empty array of strings`);
  }
  return value as string[];
}

export function parseSuite(raw: unknown): TaskSuite {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("suite must be an object");
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) fail("id is required");
  if (typeof record.fixture !== "string" || record.fixture.length === 0) fail("fixture is required");
  if (typeof record.agent !== "string" || record.agent.length === 0) fail("agent is required");
  if (!Array.isArray(record.tasks) || record.tasks.length === 0) fail("tasks must be a non-empty array");

  const tasks: TaskSpec[] = [];
  const seen = new Set<string>();
  for (const entry of record.tasks) {
    if (typeof entry !== "object" || entry === null) fail("each task must be an object");
    const task = entry as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) fail("task id is required");
    if (seen.has(task.id)) fail(`duplicate task id ${task.id}`);
    seen.add(task.id);
    if (typeof task.prompt !== "string" || task.prompt.trim().length === 0) fail(`task ${task.id} needs a prompt`);
    const expect = task.expect;
    if (typeof expect !== "object" || expect === null) fail(`task ${task.id} needs expect`);
    const spec = expect as Record<string, unknown>;
    const parsed: ExpectSpec = {};
    if (spec.all !== undefined) parsed.all = stringList(spec.all, `task ${task.id} expect.all`);
    if (spec.any !== undefined) parsed.any = stringList(spec.any, `task ${task.id} expect.any`);
    if (spec.none !== undefined) parsed.none = stringList(spec.none, `task ${task.id} expect.none`);
    if ((parsed.all?.length ?? 0) + (parsed.any?.length ?? 0) + (parsed.none?.length ?? 0) === 0) {
      fail(`task ${task.id} has an empty expect block`);
    }
    tasks.push({
      id: task.id,
      prompt: task.prompt,
      expect: parsed,
      ...(typeof task.timeoutMs === "number" ? { timeoutMs: task.timeoutMs } : {}),
    });
  }

  const timeoutMs = typeof record.timeoutMs === "number" ? record.timeoutMs : 240_000;
  return {
    id: record.id,
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    fixture: record.fixture,
    ...(record.exclude === undefined ? {} : { exclude: stringList(record.exclude, "exclude") }),
    agent: record.agent,
    tools: stringList(record.tools, "tools"),
    timeoutMs,
    tasks,
  };
}

export async function loadSuite(file: string): Promise<TaskSuite> {
  const text = await readFile(file, "utf8");
  return parseSuite(JSON.parse(text) as unknown);
}
