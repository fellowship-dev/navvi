import { Actor } from "apify";
import { causeChain, isLaunchFailure, RETIRE_AFTER_PAGE_COUNT_ENV, SESSION_MAX_ERROR_SCORE_ENV, SESSION_MAX_USAGE_COUNT_ENV } from "./browser/relaunch.js";
import { ZodError } from "zod";
import { parseInput, defaultBrowser, resolveSources, type RunInput } from "./input/schema.js";
import { promptToInput } from "./input/prompt.js";
import { NavviError, NeedsHumanError } from "./billing/budget.js";
import { zeroCharges, type ChargeCounts } from "./billing/charge.js";
import { createChooser, type Chooser } from "./chooser/index.js";
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
  /** Replay pages that were a bot challenge: no row, no healing; the first is kept as BLOCKED_PAGE. */
  blockedPages?: number;
  /** Replay pages (records or listings) that still answered 5xx after the retry (the first 50 by name); no row, no healing. */
  transientPages?: { count: number; urls: string[] };
  /** Replay pages (records or listings) the site answered 404/410, or that redirected off the template: dead URLs in the start list (the first 50 by name); no row, no healing. */
  deadPages?: { count: number; urls: string[] };
  /** Replay pages that still read as a weak challenge (a captcha widget on a page that renders almost nothing) after waiting up to 5 s for the scraper's anchor: a page still rendering, not a block (the first 50 by name); no row, no healing. */
  unsettledPages?: { count: number; urls: string[] };
  /** Record pages whose every failed field reads a payload that never arrived (the first 50 by name): the site did not feed the page; no row, no healing, not `unhealed`. */
  noPayloadPages?: { count: number; urls: string[] };
  /** Optional fields that filled on some pages with items and were empty on others: `pages` empty, `filled` filled. A layout the selector no longer reads, or a value absent by design; never healed. */
  optionalDrift?: Array<{ field: string; pages: number; filled: number }>;
  /** List start URLs whose first page had no item under the compiled anchor, a search that found nothing (the first 50 by name); no row, no healing. */
  emptyListings?: { count: number; urls: string[] };
  /** A pinned run: start URLs of other shapes, reported and never compiled (the first 50 by name). */
  offTemplate?: { count: number; urls: string[] };
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
 * U11 / R14, KTD11: the input keys the published actor accepts -- the
 * properties of `.actor/input_schema.json` less the actor-only keys
 * `actorInput` has already moved into the run's environment. A maintained
 * list rather than a runtime read of the schema file, which the image need
 * not ship; tests/input-schema.test.ts fails when the two disagree.
 */
export const PLATFORM_INPUT_KEYS = [
  "prompt", "startUrls", "mode", "description", "fields", "goal", "followDetailPages", "detailFields",
  "maxPages", "maxPagesPerStart", "maxItems", "maxConcurrency", "minConcurrency", "settleMs", "browser", "proxy",
  "allowedDomains", "chooser", "decider", "writer", "deciderTransport", "scriptId", "forceRecompile",
  "profile", "freshProfile",
] as const;

/** True when the run is on the Apify platform, where the input is the published surface only (KTD11). */
export function isOnPlatform(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.APIFY_IS_AT_HOME);
}

/**
 * U11 / R14: on the platform, a key the published schema does not declare is
 * refused with configuration_error naming every such key. Refused rather than
 * stripped: `allowPrivateHosts`, `secrets`, `headed`, `allowMutations` and
 * `urlLists` are CLI-only because they widen what a run may reach or do, and
 * a caller who sent one must learn the run did not honour it instead of
 * getting a quietly different run. The Console only ever sends declared keys,
 * so only an API caller can meet this. `startUrls` entries may still be
 * `{ requestsFromUrl }`; those become `urlLists` after this check. Returns
 * the input unchanged (not a copy) when it passes.
 */
export function lockPlatformInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const allowed = new Set<string>(PLATFORM_INPUT_KEYS);
  const refused = Object.keys(raw).filter((key) => !allowed.has(key)).sort();
  if (refused.length > 0) {
    throw new NavviError(
      "configuration_error",
      `invalid input\nnot accepted on the platform (CLI only or unknown): ${refused.join(", ")}`,
    );
  }
  return raw;
}

/** What `prepareInput` hands the crawler, or the summary of a run that stopped before it. */
export type PreparedInput = { input: RunInput; chooser: Chooser } | { summary: RunSummary };

/**
 * Validation, the platform lock (KTD11), the prompt parse (KTD11 of the
 * prompt plan) and the defaults: everything `run` does before the crawler.
 * On the platform the profile is forced to `store` after the prompt is
 * parsed, since a prompt that expects secrets would otherwise pick `local`.
 */
export async function prepareInput(raw: unknown, deps: CrawlDeps = {}): Promise<PreparedInput> {
  const env = deps.env ?? process.env;
  const onPlatform = isOnPlatform(env);
  if (onPlatform) raw = lockPlatformInput(raw);
  let input: RunInput;
  try {
    input = parseInput(raw);
  } catch (error) {
    if (error instanceof ZodError) throw new InvalidInputError(error);
    throw error;
  }
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
        return { summary: { ...summaryFor("needs_human", input, error.message), needsHuman: { token: error.token, questionsFile: error.questionsFile } } };
      }
      // The prompt-derived input is validated like the raw one: a failure is a configuration error, not a crash.
      if (error instanceof ZodError) throw new InvalidInputError(error);
      throw error;
    }
  }
  if (onPlatform) input.profile = "store";
  input.chooser ??= sources.decider;
  input.decider ??= sources.decider;
  input.browser ??= defaultBrowser(env);
  return { input, chooser };
}

/**
 * Run entry: validates the input, applies the defaults, parses a prompt-only
 * input through the run's chooser (KTD11) and runs the crawler. `deps` is for
 * tests and the CLI; the chooser built here is the one the crawler uses.
 */
export async function run(raw: unknown, deps: CrawlDeps = {}): Promise<RunSummary> {
  const prepared = await prepareInput(raw, deps);
  if ("summary" in prepared) return prepared.summary;
  return runCrawl(prepared.input, { ...deps, chooser: prepared.chooser });
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
 * U12 / R16: true when the actor input carries a non-empty caller key, the
 * same test `actorInput` applies before moving one into the run's env. Such a
 * run is bring-your-own-key and is charged no `decision`: the caller pays
 * their provider for the questions. Without one the run answers on the
 * operator's key and every answered question is a `decision`.
 */
export function hasCallerKey(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return Object.keys(CALLER_KEY_ENV).some((key) => typeof record[key] === "string" && (record[key] as string).trim().length > 0);
}


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
    const summary = await run(input, { env, callerKey: hasCallerKey(raw) });
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
