import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeChildFiles, writeFileAtomic } from "../../src/child/child-files.ts";
import { createRunPaths } from "../../src/child/paths.ts";

test("run files are written atomically with 0600 and directories 0700", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-files-"));
  try {
    const paths = createRunPaths({
      agentName: "reviewer",
      runsRoot: path.join(root, "runs"),
      runId: "r1",
      childId: "11111111-2222-4333-8444-555555555555",
      randomSuffix: () => "abcd",
    });
    await writeChildFiles(paths, { task: "# Task\n", system: "# System\n" });

    assert.equal(await readFile(paths.taskFile, "utf8"), "# Task\n");
    assert.equal(await readFile(paths.systemFile, "utf8"), "# System\n");
    assert.equal((await stat(paths.taskFile)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.systemFile)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.runDir)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.sessionDir)).mode & 0o777, 0o700);

    const entries = await readdir(paths.runDir);
    assert.deepEqual(entries.sort(), ["sessions", "system.md", "task.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeFileAtomic replaces content without leaving temp files", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-atomic-"));
  try {
    const file = path.join(root, "value.json");
    await writeFileAtomic(file, '{"a":1}');
    await writeFileAtomic(file, '{"a":2}');
    assert.equal(await readFile(file, "utf8"), '{"a":2}');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), ["value.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
