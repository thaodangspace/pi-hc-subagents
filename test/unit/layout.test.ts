import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

test("package.json declares the extension entry point", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi, { extensions: ["./index.ts"] });
  assert.equal(pkg.type, "module");
  assert.match(pkg.engines.node, />=\s*22/);
});

test("src/core never imports the pi coding agent package", async () => {
  const files = await sourceFiles(path.join(repoRoot, "src/core"));
  assert.ok(files.length > 0);
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (/from\s+["']@earendil-works\/pi-coding-agent["']/.test(text)) {
      offenders.push(path.relative(repoRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});
