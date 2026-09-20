import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { TestProject } from "vitest/node";

/**
 * The tests must never write into the project's own `./storage` directory:
 * every test gets an in-memory Apify storage client and a temp storageDir.
 *
 * Asserting `./storage/...` is simply absent would be wrong — a developer who
 * has run the product locally (`npx apify run`, or the CLI with the default
 * `--storage ./storage`) legitimately has scraper caches, datasets and browser
 * profiles there, and they persist. So this records what `./storage` holds
 * before the suite starts and the assertion is "the tests added nothing".
 */

export const PROJECT_STORAGE = join(process.cwd(), "storage");

declare module "vitest" {
  interface ProvidedContext {
    /** Every path under ./storage, relative to it, as it was before the suite ran. */
    projectStorageBefore: string[];
  }
}

/** Every path under `root`, relative and sorted; `[]` when the directory does not exist. */
export function listProjectStorage(root: string = PROJECT_STORAGE): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable: nothing to compare against
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      found.push(relative(root, child));
      if (entry.isDirectory()) walk(child);
    }
  };
  walk(root);
  return found.sort();
}

/** Paths present now that were not in `before`. */
export function storageAdditions(before: readonly string[], root: string = PROJECT_STORAGE): string[] {
  const was = new Set(before);
  return listProjectStorage(root).filter((path) => !was.has(path));
}

export default function setup(project: TestProject) {
  const before = listProjectStorage();
  project.provide("projectStorageBefore", before);
  return () => {
    // Backstop for whatever ran after store.test.ts made the same assertion.
    const added = storageAdditions(before);
    if (added.length > 0) throw new Error(`the tests wrote into ./storage: ${added.join(", ")}`);
  };
}
