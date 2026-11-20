/**
 * Per-trial workspace isolation and fixture identity.
 *
 * Trials never share a workspace: each one gets a copy of the fixture so a
 * child that writes a file cannot change the next trial.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { copyFile, mkdir as mkdirSafe, readlink, symlink } from "node:fs/promises";
import path from "node:path";

/**
 * A pattern without a slash matches any path segment (`node_modules`), and a
 * pattern with a slash matches a prefix relative to the fixture root
 * (`bench/results`). This keeps a repo fixture from copying its own output.
 */
export function isExcluded(relative: string, patterns: string[]): boolean {
  const normalized = relative.split(path.sep).join("/");
  const segments = normalized.split("/");
  for (const pattern of patterns) {
    const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
    if (clean.length === 0) continue;
    if (clean.includes("/")) {
      if (normalized === clean || normalized.startsWith(`${clean}/`)) return true;
    } else if (segments.includes(clean)) {
      return true;
    }
  }
  return false;
}

async function copyTree(source: string, destination: string, root: string, exclude: string[]): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    if (isExcluded(path.relative(root, from), exclude)) continue;
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to, root, exclude);
    } else if (entry.isSymbolicLink()) {
      try {
        await symlink(await readlink(from), to);
      } catch {
        // A broken or unsupported link is not part of the fixture.
      }
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
}

/**
 * Copy a fixture into a trial workspace. `fs.cp` refuses to copy a directory
 * into its own subtree, which happens when the repo itself is the fixture and
 * the results dir lives inside it, so this walks the tree itself.
 */
export async function prepareWorkspace(fixtureDir: string, destination: string, exclude: string[] = []): Promise<void> {
  await mkdirSafe(destination, { recursive: true });
  await copyTree(fixtureDir, destination, fixtureDir, exclude);
}

/** Stable digest of the fixture tree: paths and contents, sorted. */
export async function fixtureDigest(root: string, exclude: string[] = []): Promise<string> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isExcluded(path.relative(root, full), exclude)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(root);
  files.sort();

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Write a file with mode 0600, creating parent directories as needed. */
export async function writePrivateFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, { mode: 0o600 });
}
