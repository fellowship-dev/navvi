import { Actor } from "apify";
import { ZodError } from "zod";
import { parseInput, defaultChooser, defaultBrowser, type RunInput } from "./input/schema.js";
import { runCrawl } from "./replay/crawler.js";

import type { Status } from "./scraper/schema.js";

export type { Status };

export interface RunSummary {
  status: Status;
  items: number;
  pages: number;
  templates: number;
  cacheHit: boolean;
  healingEvents: unknown[];
  unmappedCandidates: unknown[];
  fieldsNotFound: string[];
  chooser: { name: string; questions: number; inputTokens: number; waitMs: number; costUsd: number } | null;
  input: RunInput | null;
  error?: string;
}

export function formatValidationError(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("\n");
}

/** Run entry. The crawler is wired in U8; until then the run validates and summarizes. */
export async function run(raw: unknown): Promise<RunSummary> {
  let input: RunInput;
  try {
    input = parseInput(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`invalid input\n${formatValidationError(error)}`);
    }
    throw error;
  }
  input.chooser ??= defaultChooser();
  input.browser ??= defaultBrowser();

  return runCrawl(input);
}

async function main() {
  await Actor.init();
  const raw = (await Actor.getInput()) ?? {};
  try {
    const summary = await run(raw);
    await Actor.setValue("SUMMARY", summary);
    await Actor.exit({ statusMessage: summary.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Actor.setValue("SUMMARY", { status: "no_items_found", error: message });
    await Actor.fail(message);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
