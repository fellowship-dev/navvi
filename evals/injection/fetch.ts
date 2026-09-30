/**
 * Fetch the pinned injection corpora into evals/injection/.cache (gitignored).
 *
 *   npx tsx evals/injection/fetch.ts              # dev and test sources
 *   npx tsx evals/injection/fetch.ts --held-out   # also the held-out benchmark
 *
 * Every file comes from raw.githubusercontent.com at the commit corpora.json
 * pins, so a re-fetch is byte-identical and the report stays reproducible.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const EVAL_DIR = import.meta.dirname;
export const CACHE_DIR = join(EVAL_DIR, ".cache");

export interface Source {
  name: string;
  repository: string;
  commit: string;
  licence: string;
  files: string[];
  role: string;
  heldOut?: boolean;
}

export function sources(): Source[] {
  return (JSON.parse(readFileSync(join(EVAL_DIR, "corpora.json"), "utf8")) as { sources: Source[] }).sources;
}

export function cachedPath(source: Source, file: string): string {
  return join(CACHE_DIR, source.name, file);
}

function rawUrl(source: Source, file: string): string {
  const repo = source.repository.replace("https://github.com/", "");
  return `https://raw.githubusercontent.com/${repo}/${source.commit}/${file}`;
}

async function main(): Promise<void> {
  const heldOut = process.argv.includes("--held-out");
  for (const source of sources()) {
    if (source.heldOut && !heldOut) {
      console.log(`skip ${source.name} (held out; pass --held-out)`);
      continue;
    }
    for (const file of source.files) {
      const target = cachedPath(source, file);
      if (existsSync(target)) continue;
      const response = await fetch(rawUrl(source, file));
      if (!response.ok) throw new Error(`${source.name}/${file}: HTTP ${response.status}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      console.log(`fetched ${source.name}/${file} @ ${source.commit.slice(0, 7)}`);
    }
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) await main();
