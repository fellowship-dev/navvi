import { Actor } from "apify";
import { causeChain, isLaunchFailure, RETIRE_AFTER_PAGE_COUNT_ENV, SESSION_MAX_ERROR_SCORE_ENV, SESSION_MAX_USAGE_COUNT_ENV } from "./browser/relaunch.js";
import { ZodError } from "zod";
import { parseInput, defaultBrowser, resolveSources, type RunInput } from "./input/schema.js";
import { promptToInput } from "./input/prompt.js";
import { NavviError, NeedsHumanError } from "./billing/budget.js";
import { zeroCharges, type ChargeCounts } from "./billing/charge.js";
import { createChooser } from "./chooser/index.js";
import { runCrawl, type CrawlDeps } from "./replay/crawler.js";
import { redactRunInput } from "./secrets/resolve.js";

import type { Status } from "./scraper/schema.js";
import type { HealingEvent, UnmappedCandidate } from "./replay/heal.js";
import type { UsageSummary, ZeroDataRetentionState } from "./chooser/chooser.js";

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
  /**
   * U14: the run's chooser usage. `name` and the totals are the whole run (the
   * decider plus anything it delegated); `writer` is the second source's share
   * of those totals, present only when a different source answered the
   * free-text questions, so each kind of question is attributable.
   */
  chooser: UsageSummary | null;
  input: RunInput | null;
  /** Requests the crawler ran, by handler. */
  requests: { compile: number; list: number; record: number };
  /** Trace replays this run (at most one per crawler session, R14). */
  traceReplays: number;
  /** Requests the route guard aborted (R26). */
  blockedRequests: number;
  /** Pages whose fingerprint check failed and no healer repaired. */
  unhealed: number;
  /** The scraper to pin next time: the given `scriptId`, else the one scraper this run used, else null (several templates). */
  scriptId: string | null;
  /** R20: events charged this run; all zero off the platform. */
  charges: ChargeCounts;
  /** Zero-data-retention state the chooser reported; null when no chooser ran. */
  zeroDataRetention: ZeroDataRetentionState | null;
  /** Why the run stopped short, for every status but succeeded. */
  message?: string;
  /** needs_human: how to resume once the questions are answered. */
  needsHuman?: { token: string | undefined; questionsFile: string | undefined };
  error?: string;
}

export function formatValidationError(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("\n");
}

/** The input failed validation; `message` lists every issue, one per line. The CLI maps it to exit code 2. */
export class InvalidInputError extends NavviError {
  readonly issues: ZodError["issues"];
  constructor(error: ZodError) {
    super("configuration_error", `invalid input\n${formatValidationError(error)}`, { cause: error });
    this.issues = error.issues;
  }
}

/** The summary of a run that ended `status` before the crawler produced one; secret values are masked (R39). */
export function summaryFor(status: Status, input: RunInput | null, message: string): RunSummary {
  return {
    status,
    items: 0,
    pages: 0,
    templates: 0,
    cacheHit: false,
    healingEvents: [],
    unmappedCandidates: [],
    fieldsNotFound: [],
    chooser: null,
    input: input && redactRunInput(input),
    requests: { compile: 0, list: 0, record: 0 },
    traceReplays: 0,
    blockedRequests: 0,
    unhealed: 0,
    scriptId: input?.scriptId ?? null,
    charges: zeroCharges(),
    zeroDataRetention: null,
    message,
  };
}

/**
 * Run entry: validates the input, applies the defaults, parses a prompt-only
 * input through the run's chooser (KTD11) and runs the crawler. `deps` is for
 * tests and the CLI; the chooser built here is the one the crawler uses.
 */
export async function run(raw: unknown, deps: CrawlDeps = {}): Promise<RunSummary> {
  let input: RunInput;
  try {
    input = parseInput(raw);
  } catch (error) {
    if (error instanceof ZodError) throw new InvalidInputError(error);
    throw error;
  }
  const env = deps.env ?? process.env;
  // U14: `chooser` names the decider and only the decider; `decider`/`writer` win over it.
  const sources = resolveSources(input, env);
  const chooser = deps.chooser ?? createChooser({ ...sources, env });

  if (input.prompt && (!input.mode || !input.fields?.length)) {
    // The validated raw input (not the defaulted one) is the base, so the prompt may still set profile, pagination and detail pages.
    // A parked question batch (needs_human) here is thrown outside any crawler request handler.
    try {
      input = (await promptToInput(input.prompt, raw as Partial<RunInput>, chooser, deps.actor ?? Actor)).input;
    } catch (error) {
      if (error instanceof NeedsHumanError) {
        return { ...summaryFor("needs_human", input, error.message), needsHuman: { token: error.token, questionsFile: error.questionsFile } };
      }
      // The prompt-derived input is validated like the raw one: a failure is a configuration error, not a crash.
      if (error instanceof ZodError) throw new InvalidInputError(error);
      throw error;
    }
  }
  input.chooser ??= sources.decider;
  input.decider ??= sources.decider;
  input.browser ??= defaultBrowser(env);
  return runCrawl(input, { ...deps, chooser });
}

/**
 * U16: the browser-retirement thresholds, as actor-only input keys.
 *
 * They exist so the Apify relaunch failure can be *forced* -- ~20 URLs with
 * `sessionMaxUsageCount: 5` reproduces in a minute what a catalogue run takes
 * fifteen to reach. Input keys rather than actor environment variables because
 * a task sets its own input, while the actor's environment is shared by every
 * run of it. Unset means today's behaviour.
 */
const DEBUG_KEYS = ["retireBrowserAfterPages", "sessionMaxUsageCount", "sessionMaxErrorScore"] as const;

const DEBUG_KEY_ENV: Record<string, string> = {
  retireBrowserAfterPages: RETIRE_AFTER_PAGE_COUNT_ENV,
  sessionMaxUsageCount: SESSION_MAX_USAGE_COUNT_ENV,
  sessionMaxErrorScore: SESSION_MAX_ERROR_SCORE_ENV,
};

/** Actor-only input keys: caller keys (R23) become the run's env, `scraperStore` qualifies a bare `scriptId`. None of them reaches the parsed input. */
export const ACTOR_ONLY_KEYS = ["typesafeApiKey", "gatewayApiKey", "anthropicApiKey", "scraperStore", ...DEBUG_KEYS] as const;

const CALLER_KEY_ENV: Record<string, string> = { typesafeApiKey: "TYPESAFE_API_KEY", gatewayApiKey: "AI_GATEWAY_API_KEY", anthropicApiKey: "ANTHROPIC_API_KEY" };


/**
 * Splits the actor input into the run input and the run's environment. A
 * caller key overrides the operator's for this run only; `scraperStore` with
 * a bare `scriptId` becomes `store/key`. Returns a copy; the raw object and
 * `base` are not modified.
 */
export function actorInput(raw: unknown, base: NodeJS.ProcessEnv = process.env): { input: Record<string, unknown>; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...base };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { input: {}, env };
  const { typesafeApiKey, gatewayApiKey, anthropicApiKey, scraperStore, ...rest } = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries({ typesafeApiKey, gatewayApiKey, anthropicApiKey })) {
    if (typeof value === "string" && value.trim().length > 0) env[CALLER_KEY_ENV[key]!] = value.trim();
  }
  const input: Record<string, unknown> = { ...rest };
  for (const key of DEBUG_KEYS) {
    const value = input[key];
    delete input[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) env[DEBUG_KEY_ENV[key]!] = String(value);
  }
  if (typeof scraperStore === "string" && scraperStore.length > 0) {
    // The run keeps its scrapers there too, reads and writes: a trial against a
    // client's list must not put a scraper into the account's shared scraper-cache.
    env.NAVVI_SCRAPER_STORE = scraperStore;
    if (typeof input.scriptId === "string" && input.scriptId.length > 0 && !input.scriptId.includes("/")) input.scriptId = `${scraperStore}/${input.scriptId}`;
  }
  return { input, env };
}

async function main() {
  await Actor.init();
  const raw = (await Actor.getInput()) ?? {};
  try {
    const { input, env } = actorInput(raw);
    const summary = await run(input, { env });
    await Actor.setValue("SUMMARY", summary);
    const message = summary.message ? `${summary.status}: ${summary.message}` : summary.status;
    // needs_human is a hold, not a failure: the CLI (U17) maps it to exit code 3.
    await Actor.exit({ statusMessage: message, exitCode: summary.status === "needs_human" ? 3 : 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // U16: a launch failure's own message says only "the original error is
    // available in the `cause` property", and the cause is what the run log
    // drops. Put it in the status message, where it cannot be missed. The full
    // record, with the resolved paths, is the LAUNCH_FAILURE key.
    const causes = isLaunchFailure(error) ? causeChain(error).slice(1) : [];
    const detail = causes.length > 0 ? ` | cause: ${causes.join(" <- ")}` : "";
    // A NavviError carries its own status (a store the actor may not open is a
    // configuration_error); only an unexplained throw is reported as no_items_found.
    const status = error instanceof NavviError ? error.status : "no_items_found";
    await Actor.setValue("SUMMARY", { status, error: message, ...(causes.length > 0 ? { causes } : {}) });
    await Actor.fail(`${message}${detail}`.slice(0, 1_000));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
