import { Actor } from "apify";
import { ZodError } from "zod";
import { parseInput, defaultChooser, defaultBrowser, type RunInput } from "./input/schema.js";
import { NeedsHumanError } from "./billing/budget.js";
import { runCrawl, type CrawlDeps } from "./replay/crawler.js";

import type { Status } from "./scraper/schema.js";
import type { HealingEvent, UnmappedCandidate } from "./replay/heal.js";

export type { Status };

export interface RunSummary {
  status: Status;
  items: number;
  pages: number;
  templates: number;
  cacheHit: boolean;
  healingEvents: HealingEvent[];
  unmappedCandidates: UnmappedCandidate[];
  fieldsNotFound: string[];
  chooser: { name: string; questions: number; inputTokens: number; waitMs: number; costUsd: number } | null;
  input: RunInput | null;
  /** Requests the crawler ran, by handler. */
  requests: { compile: number; list: number; record: number };
  /** Trace replays this run (at most one per crawler session, R14). */
  traceReplays: number;
  /** Requests the route guard aborted (R26). */
  blockedRequests: number;
  /** Pages whose fingerprint check failed and no healer repaired. */
  unhealed: number;
  /** Why the run stopped short, for every status but succeeded. */
  message?: string;
  /** needs_human: how to resume once the questions are answered. */
  needsHuman?: { token: string | undefined; questionsFile: string | undefined };
  error?: string;
}

export function formatValidationError(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("\n");
}

/** Run entry: validates the input, applies the defaults and runs the crawler. `deps` is for tests and the CLI. */
export async function run(raw: unknown, deps?: CrawlDeps): Promise<RunSummary> {
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

  try {
    return await runCrawl(input, deps);
  } catch (error) {
    if (error instanceof NeedsHumanError) {
      return {
        status: "needs_human",
        items: 0,
        pages: 0,
        templates: 0,
        cacheHit: false,
        healingEvents: [],
        unmappedCandidates: [],
        fieldsNotFound: [],
        chooser: null,
        input,
        requests: { compile: 0, list: 0, record: 0 },
        traceReplays: 0,
        blockedRequests: 0,
        unhealed: 0,
        message: error.message,
        needsHuman: { token: error.token, questionsFile: error.questionsFile },
      };
    }
    throw error;
  }
}

async function main() {
  await Actor.init();
  const raw = (await Actor.getInput()) ?? {};
  try {
    const summary = await run(raw);
    await Actor.setValue("SUMMARY", summary);
    const message = summary.message ? `${summary.status}: ${summary.message}` : summary.status;
    // needs_human is a hold, not a failure: the CLI (U17) maps it to exit code 3.
    await Actor.exit({ statusMessage: message, exitCode: summary.status === "needs_human" ? 3 : 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Actor.setValue("SUMMARY", { status: "no_items_found", error: message });
    await Actor.fail(message);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
