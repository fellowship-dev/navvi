import { installSnapshot } from "../browser/snapshot.js";
import { createHash, randomUUID } from "node:crypto";
import { Actor } from "apify";
import { PlaywrightCrawler, ProxyConfiguration, type Configuration, type Dataset, type KeyValueStore, type PlaywrightCrawlingContext } from "crawlee";
import type { BrowserContext, Page } from "playwright";
import { Charger, type ChargingActor } from "../billing/charge.js";
import { buildCrawleeLaunchContext, restoreProfileCookies, saveProfileCookies } from "../browser/launch.js";
import { createLaunchCounter, formatLaunchFailure, isLaunchFailure, launchFailureReport, resolveRelaunchKnobs, type RelaunchKnobs } from "../browser/relaunch.js";
import { captureJson, describeSkips, type Capture, type CapturedResponse } from "../browser/network-capture.js";
import { hostOf, isAllowedRequestUrl, registrableDomain } from "../browser/policy.js";
import { ConfigurationError, createChooser, NavviError, NeedsHumanError, StateTooLargeError, summarizeUsage, type Chooser } from "../chooser/index.js";
import { compile, compileTemplate, type CompileRationale, type RenderPages, type TemplateCompile } from "../compile/index.js";
import { LIMITS, isAllowedUrl, resolveSources, type FieldType, type Mode, type Profile, type ProxyInput, type RunInput } from "../input/schema.js";
import { chooseSample, probeFrom, type Capture as PageCapture, type Manuscript, type SampleChoice } from "../investigate/index.js";
import type { Reconciliation } from "../reconcile/index.js";
import { specFromInput } from "../spec/input.js";
import type { Rubric, Spec } from "../spec/schema.js";
import { continueWithoutRevalidation, waitForSettle } from "../browser/guards.js";
import type { RunSummary } from "../main.js";
import { dismissConsent, runPreSteps, type Notifier } from "../prestep/index.js";
import { coerceValues, extractPage, fieldTypesOf, fingerprintMatches, type ItemExtraction } from "../scraper/extract.js";
import { cacheKey, canaryOrigin, promoteFieldAlternative, validateScraper, type CompiledScraper, type Status, type TraceStep } from "../scraper/schema.js";
import { ScraperStore, ScraperStoreError } from "../scraper/store.js";
import { findPlaceholders, MASK, maskUrlCredentials, MissingSecretError, redactRunInput, resolveSecrets, type CommandRunner, type Secret } from "../secrets/resolve.js";
import { groupByTemplate, pickSampleUrls } from "../template/index.js";
import { recordCanary, type CanaryFingerprint, type FieldFill, type PageResponse } from "../investigate/blocked.js";
import { compileDetail, DETAIL_LINK_FIELD, detailLinkOf, extractDetail, hasDetailTemplate, mergeDetail, withDetailLink } from "./detail.js";
import type { Determinism } from "./determinism.js";
import { entryModeFor, replayTrace, type ReplayPolicy, type StepFailureAction } from "./entry.js";
import {
  createHealer,
  findUnmappedCandidates,
  judgePromotions,
  licenseToHeal,
  observeResolutions,
  type HealingEvent,
  type PromotionEvent,
  type ResolutionTally,
  type UnmappedCandidate,
} from "./heal.js";
import { defaultNavigator } from "./navigator.js";
import { defaultPaginate } from "./paginate.js";

/**
 * Crawlee retires a Session after `maxUsageCount` requests, which defaults to
 * **50**, and BrowserCrawler retires the *browser* when a session retires
 * (`EVENT_SESSION_RETIRED` -> `browserPool.retireBrowserController`). So an
 * unconfigured run tears the browser down and relaunches it every 50 requests.
 *
 * On the Apify Chrome image that relaunch fails: two client runs died with
 * `Failed to launch browser ... /pw-browsers/chrome` at 50 and 49 requests,
 * while a third that only reached 10 requests survived. Raising the browser
 * pool's own `retireBrowserAfterPageCount` changed nothing, which is what
 * proved the session pool was the trigger rather than the browser pool.
 *
 * A run replaying a pinned scraper has no reason to rotate sessions: it is not
 * evading a block, and a fresh session buys nothing but a browser restart.
 */
export function buildSessionPoolOptions(singleSession: boolean, knobs: RelaunchKnobs = resolveRelaunchKnobs()) {
  const sessionOptions: { maxUsageCount: number; maxErrorScore?: number } = { maxUsageCount: knobs.sessionMaxUsageCount };
  // U16: left at Crawlee's default (3) unless a repro run lowers it. The error
  // score is the remaining known path to a retirement, and this build is meant
  // to reproduce that path deliberately, not to paper over it.
  if (knobs.sessionMaxErrorScore !== undefined) sessionOptions.maxErrorScore = knobs.sessionMaxErrorScore;
  return {
    maxPoolSize: singleSession ? 1 : 4,
    sessionOptions,
  };
}


/**
 * The crawler shell (U8, KTD4): one PlaywrightCrawler owns the browser for
 * every phase. A `compile` request runs the pre-steps, the optional
 * navigator, the compiler and stores the scraper; `record` and `list`
 * requests replay on selectors and, in trace mode, on the recorded trace once
 * per session. The route guard (R26) and the click policy (R24/R25) run on
 * every page. Healing and pagination (U13) and navigation (U7) enter through
 * hooks with defaults from `heal.ts`, `paginate.ts` and `navigator.ts`.
 */

export const REQUEST_HANDLER_TIMEOUT_SECS = 180;
export const LIST_SOURCE_EXTENSIONS = [".txt", ".json", ".csv"] as const;

export type RequestLabel = "compile" | "list" | "record";

/**
 * The proxy options the crawler actually passes to `Actor.createProxyConfiguration`.
 * A subset of Apify's `ProxyConfigurationOptions`
 * (`node_modules/apify/dist/proxy_configuration.d.ts`, which extends
 * `@crawlee/core`'s `{ proxyUrls, newUrlFunction, tieredProxyUrls }`), named
 * the way the SDK asks crawler code to name them: `groups` and `countryCode`
 * rather than the input-schema spellings `apifyProxyGroups` /
 * `apifyProxyCountry`. `useApifyProxy` is carried through because the SDK
 * treats `{ useApifyProxy: false }` as "no proxy at all".
 */
export interface CrawlProxyOptions {
  useApifyProxy?: boolean;
  /** Apify Proxy groups, e.g. `["RESIDENTIAL"]` or `["BUYPROXIES94952"]`. */
  groups?: string[];
  /** Two-letter ISO 3166-1 country code the exit IPs are geolocated to. */
  countryCode?: string;
  /** A caller's own proxies, rotated by Crawlee; never combined with Apify Proxy. */
  proxyUrls?: string[];
}

/** What the crawler needs from `Actor`; the static class and an instance both satisfy it. Charging is optional (R20). */
export interface CrawlActor extends ChargingActor {
  openKeyValueStore(storeIdOrName?: string | null): Promise<KeyValueStore>;
  openDataset(datasetIdOrName?: string | null): Promise<Dataset>;
  isAtHome(): boolean;
  readonly config: Configuration;
  createProxyConfiguration?(options?: CrawlProxyOptions): Promise<ProxyConfiguration | undefined>;
}

export interface NavigateContext {
  chooser: Chooser;
  profile: Profile;
  startUrls: readonly string[];
  allowedDomains: readonly string[];
  allowMutations: readonly string[];
  /** Resolved secrets; the navigator types them only through secret steps. */
  secrets: ReadonlyMap<string, Secret>;
  description?: string | undefined;
  fields: readonly string[];
}

export type NavigateOutcome = { ok: true; steps: TraceStep[] } | { ok: false; status: Status; reason: string };

/** U7: drives the page from the start URL to the target using the chooser; returns the recorded steps. */
export type NavigatorHook = (page: Page, goal: string, ctx: NavigateContext) => Promise<NavigateOutcome>;

export type HealFailure = { kind: "fields"; fields: string[] } | { kind: "step"; stepIndex: number; reason: string };

export interface HealContext {
  page: Page;
  scraper: CompiledScraper;
  chooser: Chooser;
  failure: HealFailure;
  /** The run's mutation allowlist, for the control policy during step healing (R42). */
  allowMutations?: readonly string[] | undefined;
}

export type HealOutcome =
  | { healed: true; scraper: CompiledScraper; event: HealingEvent; unmapped?: UnmappedCandidate[] | undefined }
  | { healed: false; reason: string; unmapped?: UnmappedCandidate[] | undefined };

/** U13: repairs a scraper after drift; the crawler stores the result and re-extracts. */
export type HealerHook = (ctx: HealContext) => Promise<HealOutcome>;

/** U13: moves the listing to its next page in-page; resolves false when there is none. */
export type PaginateHook = (page: Page, scraper: CompiledScraper, pageIndex: number) => Promise<boolean>;

export interface CrawlDeps {
  /** Observe each actual crawler page before navigation (e.g. recording compile and replay). */
  onPage?: ((page: Page) => Promise<void>) | undefined;
  chooser?: Chooser | undefined;
  actor?: CrawlActor | undefined;
  store?: ScraperStore | undefined;
  navigator?: NavigatorHook | undefined;
  healer?: HealerHook | undefined;
  paginate?: PaginateHook | undefined;
  notify?: Notifier | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Root for `profiles/<domain>/<profile>`; defaults to ./storage. */
  storageDir?: string | undefined;
  runCommand?: CommandRunner | undefined;
  /** A person is present for bot-challenge handoffs (R41). Defaults to `input.headed`. */
  attended?: boolean | undefined;
  maxConcurrency?: number | undefined;
  /** Requests running from the start (Crawlee scales up from one otherwise); never above `maxConcurrency`. */
  minConcurrency?: number | undefined;
  fetchText?: ((url: string) => Promise<{ contentType: string; body: string }>) | undefined;
  /**
   * Where the crawler's diagnostic sentences go — a skipped list, a healing
   * that found nothing, a launch failure. Defaults to stderr. A caller that
   * collects its own output must pass this, or it will be diagnosing from
   * symptoms while the cause goes somewhere it cannot read.
   */
  log?: ((message: string) => void) | undefined;
  /**
   * U9c: the canary for this run, overriding the one recorded beside the
   * scraper when it was compiled.
   *
   * It exists so the gate can be driven from a fixture — "a run whose canary
   * failed does not heal" is a sentence a test has to be able to arrange — and
   * so a caller that recorded its own canary at investigation time (`navvi
   * make` does) can hand it over rather than letting the crawler re-record a
   * weaker one.
   */
  canary?: CanaryFingerprint | undefined;
  /**
   * U6a's artifact. A field this rejected as unstable is never repaired: the
   * 2026-09-22 replay reported 33 repairs against pages that had not moved,
   * and every one of them would have appended whichever form the page happened
   * to show that second.
   */
  determinism?: Determinism | undefined;
  /**
   * U5: the case's rubrics, carried into the spec a record-mode compile is
   * run against (`specFromInput`), so a competing-readings question quotes
   * them the way `navvi make`'s does. `RunInput` has no field for them: they
   * are the CLI's `--rubric` and `--rubrics-file`, not part of an actor input.
   */
  rubrics?: readonly Rubric[] | undefined;
  /**
   * U5: told about every template this run compiled, as it was compiled --
   * the spec, and in record mode the whole record the compile core kept.
   * `navvi "<prompt>" <url> --work <dir>` writes it out as `navvi make`'s
   * artifact set; nothing in the crawler reads it back.
   */
  onCompiled?: ((compiled: CompiledTemplate) => Promise<void> | void) | undefined;
}

/**
 * U5: one template's compile, as `CrawlDeps.onCompiled` hears about it.
 *
 * `core` is present in record mode only: list mode compiles through
 * `compileList`, which keeps no manuscript, reconciliation or rationale, so a
 * list-mode `--work` directory holds the spec and the scraper and says the
 * rest is absent rather than writing an empty stand-in for it.
 */
export interface CompiledTemplate {
  templateKey: string;
  mode: Mode;
  spec: Spec;
  /** The scraper as stored, trace and canary included. Null when the compile stopped short; `because` says why. */
  scraper: CompiledScraper | null;
  because?: string | undefined;
  core?:
    | {
        sample: SampleChoice;
        manuscript: Manuscript;
        reconciliation?: Reconciliation | undefined;
        rationale?: CompileRationale | undefined;
      }
    | undefined;
}

// ---------------------------------------------------------------- policy

/**
 * R26 as the run's request guard. An allowlisted private host is allowed only
 * on the ports the run's URLs use, so a fixture host on one port never opens
 * the same machine's other services.
 */
export function makeRequestGuard(allowPrivateHosts: readonly string[], urls: readonly string[]): (url: string) => boolean {
  const allowedOrigins = new Set<string>();
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      if (allowPrivateHosts.includes(url.hostname)) allowedOrigins.add(url.origin);
    } catch {
      // not a URL; the schema already refused it
    }
  }
  return (raw) => {
    if (!isAllowedRequestUrl(raw, allowPrivateHosts)) return false;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (!allowPrivateHosts.includes(url.hostname)) return true;
    return allowedOrigins.has(url.origin);
  };
}

// ---------------------------------------------------------------- list sources (R34)

async function defaultFetchText(url: string): Promise<{ contentType: string; body: string }> {
  const response = await fetch(url, { redirect: "manual" });
  if (!response.ok) throw new Error(`list source ${url} answered ${response.status}`);
  return { contentType: response.headers.get("content-type") ?? "", body: await response.text() };
}

/** A list entry's URL: a string, `{ url }`, or Strapi's `{ attributes: { url } }`. */
function entryUrl(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return undefined;
  const o = entry as { url?: unknown; attributes?: { url?: unknown } };
  if (typeof o.url === "string") return o.url;
  return typeof o.attributes?.url === "string" ? o.attributes.url : undefined;
}

/** A JSON list: an array, or an object whose `urls`, `data` or `items` is one. */
function parseJsonList(body: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  let list: unknown[] | null = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (typeof parsed === "object" && parsed !== null) {
    const o = parsed as Record<string, unknown>;
    for (const key of ["urls", "data", "items"]) {
      if (Array.isArray(o[key])) {
        list = o[key] as unknown[];
        break;
      }
    }
  }
  if (!list) return null;
  return list.map(entryUrl).filter((u): u is string => typeof u === "string");
}

function parseTextList(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.split(",")[0]!.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * `strict` (a declared list URL, R34): JSON by content type or by shape, else
 * lines; an HTML answer yields nothing. Otherwise (a start URL by extension)
 * only a JSON or plain-text answer is a list.
 */
function parseListSource(contentType: string, body: string, strict = false): string[] | null {
  const type = contentType.toLowerCase();
  if (type.includes("json")) return parseJsonList(body);
  if (type.includes("text/plain") || type.includes("text/csv")) return parseTextList(body);
  if (!strict || type.includes("html")) return null;
  return parseJsonList(body) ?? parseTextList(body);
}

function looksLikeListSource(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return LIST_SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

/**
 * R34: a start URL whose path ends in .txt/.json/.csv is fetched outside the
 * browser; when it answers JSON or plain text it is replaced by the URLs it
 * lists (a page answering HTML stays a start URL). A `urlLists` entry
 * (`{ requestsFromUrl }` in the actor input, `--from-url` on the CLI) is
 * always a list: fetched, parsed as JSON or lines, never opened as a page; one
 * that fails or lists nothing is skipped with a log line. Every URL is
 * policy-checked; refused ones are dropped.
 */
export async function loadListSources(
  startUrls: readonly string[],
  urlLists: readonly string[],
  allowPrivateHosts: readonly string[],
  fetchText: (url: string) => Promise<{ contentType: string; body: string }> = defaultFetchText,
  log: (message: string) => void = defaultCtxLog,
): Promise<string[]> {
  const out: string[] = [];
  const push = (url: string) => {
    if (isAllowedUrl(url, allowPrivateHosts) && !out.includes(url)) out.push(url);
  };
  for (const url of startUrls) {
    if (!looksLikeListSource(url) || !isAllowedUrl(url, allowPrivateHosts)) {
      push(url);
      continue;
    }
    let listed: string[] | null = null;
    try {
      const { contentType, body } = await fetchText(url);
      listed = parseListSource(contentType, body);
    } catch {
      listed = null;
    }
    if (listed === null) push(url);
    else for (const entry of listed) push(entry);
  }
  for (const url of urlLists) {
    if (!isAllowedUrl(url, allowPrivateHosts)) continue;
    let listed: string[] | null = null;
    try {
      const { contentType, body } = await fetchText(url);
      listed = parseListSource(contentType, body, true);
    } catch (error) {
      log(`list ${url} skipped: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (listed === null || listed.length === 0) {
      log(`list ${url} skipped: no URLs in the answer`);
      continue;
    }
    for (const entry of listed) push(entry);
  }
  return out;
}

// ---------------------------------------------------------------- run state

interface TemplatePlan {
  templateKey: string;
  cacheKey: string;
  urls: string[];
  scraper: CompiledScraper | null;
  cacheHit: boolean;
  /** R20: `scraper-compiled` is charged once per template, after its first page passes the fingerprint check. */
  compileCharged: boolean;
  /**
   * U9c: the fingerprint this run checks against, which is the scraper's own
   * (`CompiledScraper.canary`) unless the caller overrode it. `null` covers
   * both absences — a scraper that predates the field and one whose compile
   * page carried no fingerprint worth keeping — because the gate treats them
   * the same way: unchecked, and a total collapse is not licensed.
   * `canaryOrigin` is what separates them, and only `backfillCanary` cares.
   */
  canary: CanaryFingerprint | null;
  /**
   * U9c: the evidence the repair gate weighs, per template.
   *
   * Per template and not per run, because a template is the unit a scraper is
   * compiled and repaired for: two templates of one run are two page shapes,
   * and a field that a listing does not carry would otherwise read as a field
   * that stopped filling. `pages`, `fills` and `values` are one measurement
   * over one set of pages and have to stay that way — the machine's
   * requirement is that the field stopped filling *while the rest of the run
   * kept answering*, which is only a comparison if both halves are about the
   * same pages.
   */
  evidence: {
    /** The pages of this template that failed their fingerprint check, with their bodies, oldest first. */
    pages: PageResponse[];
    /** Fill counts per field over those same pages, as the scraper stood when each was read. */
    fills: Record<string, FieldFill>;
    /** The values each field produced on them, so `no-variation-no-field` runs on real readings and not on a fill rate. */
    values: Record<string, Array<string | number | null>>;
  };
  /** U9b: how many items each alternative of each field answered, this run. */
  tally: ResolutionTally;
  /** U9b: fields repaired this run, which may not be promoted from it — see `PromotionOptions.healed`. */
  healedFields: Set<string>;
}

interface Stop {
  status: Status;
  message: string;
  needsHuman?: { token: string | undefined; questionsFile: string | undefined } | undefined;
}

interface RunState {
  stop: Stop | null;
  /** A configuration error raised inside a request handler (a chooser that is not signed in): the crawl stops and the error is rethrown after it. */
  fatal: NavviError | null;
  items: number;
  pages: number;
  unhealed: number;
  failedItems: number;
  traceReplays: number;
  blockedRequests: number;
  requests: Record<RequestLabel, number>;
  healingEvents: HealingEvent[];
  /** U9b: alternatives reordered after the crawl, kept apart so a promotion never spends the healing budget. */
  promotions: PromotionEvent[];
  unmappedCandidates: UnmappedCandidate[];
  fieldsNotFound: Set<string>;
  /** R16: dedupe keys of every record pushed this run (list rows dedupe within their listing crawl). */
  seen: Set<string>;
  /** R14: `session:startUrl` pairs whose trace already replayed; every start URL of a trace template gets its own replay. */
  replayed: Set<string>;
  /** The guard install per context, memoized in flight so a concurrent request waits for it instead of navigating past it (R26). */
  guardedContexts: Map<BrowserContext, Promise<void>>;
}

interface CompileUserData {
  label: "compile";
  templateKey: string;
  sampleUrls: string[];
}

interface ReplayUserData {
  label: "list" | "record";
  templateKey: string;
}

type UserData = CompileUserData | ReplayUserData;

function summaryOf(input: RunInput, state: RunState, plans: readonly TemplatePlan[], chooser: Chooser | null, charger: Charger): RunSummary {
  const usage = chooser?.usage();
  const status: Status = state.stop
    ? state.stop.status
    : state.items > 0 && !(state.unhealed > 0 && state.failedItems >= state.items)
      ? "succeeded"
      : state.unhealed > 0
        ? "drift"
        : "no_items_found";
  const summary: RunSummary = {
    status,
    items: state.items,
    pages: state.pages,
    templates: plans.length,
    cacheHit: plans.length > 0 && plans.every((p) => p.cacheHit),
    // U9b: promotions go out in the same list a person already reads to find
    // out what this run changed about the scraper, and last, because they are
    // decided after the crawl. They are kept in their own array until here so
    // that nothing during the crawl — the healing budget, `driftSeen` —
    // mistakes a reordering for a repair.
    healingEvents: [...state.healingEvents, ...state.promotions],
    unmappedCandidates: state.unmappedCandidates,
    fieldsNotFound: [...state.fieldsNotFound].sort(),
    // U14: the totals are the run's; `writer` names the second source and its share of them.
    chooser: usage ? summarizeUsage(usage) : null,
    // R39: every secret value and proxy credential masked
    input: redactRunInput(input),
    requests: { ...state.requests },
    traceReplays: state.traceReplays,
    blockedRequests: state.blockedRequests,
    unhealed: state.unhealed,
    // the scraper a caller pins next time: the given id, else the one scraper this run used
    scriptId: input.scriptId ?? (plans.length === 1 && plans[0]!.scraper ? plans[0]!.scraper.cacheKey : null),
    charges: { ...charger.counts },
    zeroDataRetention: usage?.zeroDataRetention ?? null,
  };
  if (state.stop) {
    summary.message = state.stop.message;
    if (state.stop.needsHuman) summary.needsHuman = state.stop.needsHuman;
  }
  return summary;
}

function stopWith(state: RunState, crawler: PlaywrightCrawler, stop: Stop): void {
  if (state.stop) return;
  state.stop = stop;
  crawler.stop(`navvi: ${stop.status}: ${stop.message}`);
}

function stopFromError(state: RunState, crawler: PlaywrightCrawler, error: unknown): boolean {
  if (error instanceof NeedsHumanError) {
    stopWith(state, crawler, { status: "needs_human", message: error.message, needsHuman: { token: error.token, questionsFile: error.questionsFile } });
    return true;
  }
  if (error instanceof NavviError && error.status === "configuration_error") {
    // Not a run status: Crawlee would retry and swallow it, so stop now and rethrow once the crawler has ended.
    state.fatal ??= error;
    stopWith(state, crawler, { status: "no_items_found", message: error.message });
    return true;
  }
  if (error instanceof NavviError && error.status !== "configuration_error") {
    stopWith(state, crawler, { status: error.status, message: error.message });
    return true;
  }
  return false;
}

/**
 * A critical section for a concurrent crawl: the calls handed to the returned
 * function run one at a time, in call order, and a rejection never breaks the
 * chain. Two of them exist per run — healing a template (R33) and claiming the
 * item budget (R20) — because both read shared state, await, and then write it.
 */
function serialize(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
}

// ---------------------------------------------------------------- the proxy

/** The proxy options for a run, or undefined when the run wants no proxy at all. */
export function proxyOptionsFor(proxy: ProxyInput | undefined): CrawlProxyOptions | undefined {
  if (proxy?.useApifyProxy) {
    const groups = proxy.apifyProxyGroups?.filter((g) => g.length > 0) ?? [];
    return {
      useApifyProxy: true,
      // The SDK's own advice: the input-schema names `apifyProxyGroups` /
      // `apifyProxyCountry` become `groups` / `countryCode` in crawler code.
      ...(groups.length > 0 ? { groups } : {}),
      ...(proxy.apifyProxyCountry ? { countryCode: proxy.apifyProxyCountry } : {}),
    };
  }
  const own = proxy?.proxyUrls?.filter((url) => url.length > 0) ?? [];
  return own.length > 0 ? { useApifyProxy: false, proxyUrls: own } : undefined;
}

/** `text` with the userinfo of any of `urls` masked, so a proxy password never reaches a message (R39). */
function maskProxyUrlsIn(text: string, urls: readonly string[]): string {
  let out = text;
  for (const url of urls) {
    out = out.split(url).join(maskUrlCredentials(url));
    try {
      const password = new URL(url).password;
      if (password.length >= 3) out = out.split(password).join(MASK);
    } catch {
      // not a URL: the whole-string replacement above is all there is to do
    }
  }
  return out;
}

/**
 * The run's single proxy source, resolved once before the browser opens.
 *
 * Apify Proxy (`useApifyProxy`, with `apifyProxyGroups` and
 * `apifyProxyCountry`) and a caller's own `proxyUrls` are one choice, not two
 * layers: `parseInput` refuses the combination, mirroring Apify's own
 * "Cannot combine custom proxies with Apify Proxy". It has to be refused
 * rather than merged, because a launch-level `proxyUrl` silently wins:
 * Crawlee only assigns a rotated proxy `if (this.proxyConfiguration &&
 * !launchContext.proxyUrl)` (`@crawlee/browser` `_extendLaunchContext`), so
 * passing both would pin one exit IP and quietly skip the rotation asked for.
 * Whichever branch is live, Crawlee's `ProxyConfiguration` owns rotation for
 * every browser the pool launches, and nothing is pinned into the launch
 * context alongside it.
 * `launchProxyUrl` is the fallback for a `CrawlActor` with no
 * `createProxyConfiguration` (a minimal fake, or a caller embedding the
 * crawler without the Apify SDK): own proxies then go straight to the browser
 * launch, first URL only, unrotated.
 */
export async function resolveProxy(
  proxy: ProxyInput | undefined,
  actor: Pick<CrawlActor, "createProxyConfiguration">,
  log: (message: string) => void = defaultCtxLog,
): Promise<{ proxyConfiguration?: ProxyConfiguration | undefined; launchProxyUrl?: string | undefined }> {
  const options = proxyOptionsFor(proxy);
  if (!options) return {};
  const fallback = options.proxyUrls?.[0];
  if (!actor.createProxyConfiguration) return fallback ? { launchProxyUrl: fallback } : {};
  // Names what was asked for, so an unavailable group is legible instead of an opaque proxy error.
  const asked = [options.groups?.length ? `proxy groups ${options.groups.join(", ")}` : "the automatically selected proxy groups", options.countryCode ? `country ${options.countryCode}` : null]
    .filter(Boolean)
    .join(", ");
  let proxyConfiguration: ProxyConfiguration | undefined;
  try {
    proxyConfiguration = await actor.createProxyConfiguration(options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (options.proxyUrls) {
      throw new NavviError("configuration_error", `input.proxy.proxyUrls was refused: ${maskProxyUrlsIn(reason, options.proxyUrls)}`);
    }
    // The platform's own reason is appended verbatim; it is the only authority on why.
    throw new NavviError("configuration_error", `Apify Proxy with ${asked} is not usable on this account: ${reason}`);
  }
  if (proxyConfiguration) return { proxyConfiguration };
  // The SDK declines to build one rather than throwing when Apify Proxy is
  // asked for off the platform (no proxy password): say so instead of crawling
  // from the local IP without a word.
  if (options.useApifyProxy) log(`Apify Proxy was requested (${asked}) but no configuration was created; the run continues with no proxy`);
  return fallback ? { launchProxyUrl: fallback } : {};
}

// ---------------------------------------------------------------- the run

export async function runCrawl(input: RunInput, deps: CrawlDeps = {}): Promise<RunSummary> {
  // Shadows the module default for the whole run, so every sentence below
  // reaches whoever is collecting this run's output rather than only stderr.
  const ctxLog = deps.log ?? defaultCtxLog;
  const env = deps.env ?? process.env;
  const actor: CrawlActor = deps.actor ?? Actor;
  const chooser = deps.chooser ?? createChooser({ ...resolveSources(input, env), env });
  const navigator: NavigatorHook = deps.navigator ?? defaultNavigator;
  const healer: HealerHook = deps.healer ?? createHealer();
  const paginateHook: PaginateHook = deps.paginate ?? defaultPaginate;
  const fields = (input.fields ?? []).map((f) => f.name);
  const detailFields = input.followDetailPages ? (input.detailFields ?? []) : [];
  // R5: the run's declared types win over the ones recorded at compile time, so a pinned scraper compiled without types still coerces.
  const inputTypes: Record<string, FieldType | undefined> = {};
  for (const f of [...(input.fields ?? []), ...detailFields]) if (f.type) inputTypes[f.name] = f.type;
  const detailFieldNames = detailFields.map((f) => f.name);
  const mode = input.mode ?? "list";
  const state: RunState = {
    stop: null,
    fatal: null,
    items: 0,
    pages: 0,
    unhealed: 0,
    failedItems: 0,
    traceReplays: 0,
    blockedRequests: 0,
    requests: { compile: 0, list: 0, record: 0 },
    healingEvents: [],
    promotions: [],
    unmappedCandidates: [],
    fieldsNotFound: new Set(),
    seen: new Set(),
    replayed: new Set(),
    guardedContexts: new Map(),
  };
  const plans: TemplatePlan[] = [];
  const charger = Charger.for(actor);
  const fail = (status: Status, message: string): RunSummary => {
    state.stop = { status, message };
    return summaryOf(input, state, plans, chooser, charger);
  };

  // R20: actor-start is the first charge of the run; a budget that cannot cover it ends the run before anything else.
  const started = await charger.charge("actor-start");
  if (started.limitReached && started.charged === 0) return fail("charge_limit", "charge limit reached before actor-start");

  // R34: list sources, then the policy on every URL.
  const urls = await loadListSources(input.startUrls ?? [], input.urlLists, input.allowPrivateHosts, deps.fetchText, ctxLog);
  if (urls.length === 0) return fail("no_items_found", "no allowed start URL");
  const guard = makeRequestGuard(input.allowPrivateHosts, urls);

  // Cache lookup per template (R5, R38) before any browser work.
  const store = deps.store ?? (await ScraperStore.open({ actor }));
  const grouped = groupByTemplate(urls);
  try {
    for (const [templateKey, templateUrls] of grouped) {
      const key = cacheKey(templateKey, { goal: input.goal, description: input.description, fields, profile: input.profile });
      const loaded = await store.load({
        cacheKey: key,
        profile: input.profile,
        scriptId: grouped.size === 1 ? input.scriptId : undefined,
        forceRecompile: input.forceRecompile,
      });
      plans.push({
        templateKey,
        cacheKey: key,
        urls: templateUrls,
        scraper: loaded.scraper,
        cacheHit: loaded.cacheHit,
        compileCharged: loaded.cacheHit,
        // U9c: the canary travels on the scraper, so a cache hit brings its
        // own. `deps.canary` overrides it — a fixture arranging the gate, or a
        // caller that recorded a stronger one at investigation time.
        canary: deps.canary ?? loaded.scraper?.canary ?? null,
        evidence: { pages: [], fills: {}, values: {} },
        tally: {},
        healedFields: new Set(),
      });
    }
  } catch (error) {
    if (error instanceof ScraperStoreError) return fail(error.status, error.message);
    throw error;
  }

  // R39: every secret resolves before the browser opens.
  const placeholders = findPlaceholders([input.goal, input.description, input.prompt, ...plans.map((p) => p.scraper)]);
  for (const name of Object.keys(input.secrets)) if (!placeholders.includes(name)) placeholders.push(name);
  let secrets: Map<string, Secret>;
  try {
    secrets = await resolveSecrets(placeholders, {
      input: input.secrets,
      env,
      runCommand: deps.runCommand,
      apify: actor.isAtHome() ? async (name) => readApifySecret(actor, name) : undefined,
    });
  } catch (error) {
    if (error instanceof MissingSecretError) return fail(error.status, error.message);
    throw error;
  }

  const policy: ReplayPolicy = {
    profile: input.profile,
    startUrls: urls,
    allowedDomains: input.allowedDomains,
    allowMutations: input.allowMutations,
    isAllowedRequest: guard,
  };
  const navigateContext: NavigateContext = {
    chooser,
    profile: input.profile,
    startUrls: urls,
    allowedDomains: input.allowedDomains,
    allowMutations: input.allowMutations,
    secrets,
    description: input.description,
    fields,
  };
  const dataset = await actor.openDataset();
  const runId = randomUUID().slice(0, 8);
  const anyTrace = plans.some((p) => p.scraper && entryModeFor(p.scraper) === "trace");
  const singleSession = mode === "list" && (anyTrace || plans.some((p) => !p.scraper));

  const { proxyConfiguration, launchProxyUrl } = await resolveProxy(input.proxy, actor);

  // R40: one persistent profile per registrable domain and profile name --
  // but only for a run that has something to persist.
  //
  // U16: a persistent profile means `launchPersistentContext`, and Chromium
  // guards a user data directory with a ProcessSingleton lock. When the pool
  // retires a browser it launches the replacement before the old process has
  // released that lock, and the replacement dies with "Failed to create a
  // ProcessSingleton for your profile directory ... already in use by another
  // instance of Chromium" -- surfaced by Crawlee as the opaque "Failed to
  // launch browser ... /pw-browsers/chrome" that cost three builds and three
  // wrong hypotheses. The path was never wrong; the directory was occupied.
  //
  // The `store` profile is the read-only one: no logins, no secrets, no form
  // submits, and on the platform its storage does not outlive the run. It had
  // nothing to persist and was paying for a profile with every relaunch. Only
  // a `local` run gets one now, so an unattended run's relaunch is just a
  // launch.
  const wantsProfile = input.profile !== "store";
  const firstHost = wantsProfile ? hostOf(urls[0]!) : null;
  // U16: one set of knobs for the pool and the session pool, and one counter
  // so a launch failure can say whether it was the first launch or a relaunch.
  const relaunchKnobs = resolveRelaunchKnobs(env);
  const launchCounter = createLaunchCounter(ctxLog, env);
  const launch = await buildCrawleeLaunchContext(
    {
      browser: input.browser ?? "chromium",
      headed: input.headed,
      profileDomain: firstHost ? registrableDomain(firstHost) : undefined,
      profileName: input.profile,
      storageDir: deps.storageDir,
      freshProfile: input.freshProfile,
      proxyUrl: launchProxyUrl,
    },
    { knobs: relaunchKnobs, counter: launchCounter },
  );

  const profileDir = launch.userDataDir;
  const installGuard = async (context: BrowserContext): Promise<void> => {
    await installSnapshot(context);
    // One handler, two jobs, because Playwright gives a request to one handler
    // and a second `context.route("**/*")` would never see it. The URL policy
    // decides whether the request goes out at all; `continueWithoutRevalidation`
    // decides what it may be answered with -- without it the crawler had the
    // cache-bypass half of 89e9633 and not the validator-stripping half, and a
    // second visit to a URL in one context read every `network` field null on
    // the default browser. See that function's header.
    await context.route("**/*", (route) => {
      if (guard(route.request().url())) return continueWithoutRevalidation(route);
      state.blockedRequests += 1;
      return route.abort("blockedbyclient");
    });
    if (profileDir) await restoreProfileCookies(profileDir, context);
  };
  const guardContext = (context: BrowserContext): Promise<void> => {
    let pending = state.guardedContexts.get(context);
    if (!pending) {
      pending = installGuard(context);
      state.guardedContexts.set(context, pending);
    }
    return pending;
  };

  const requestFor = (label: RequestLabel, url: string, userData: UserData): { url: string; uniqueKey: string; label: string; userData: UserData; noRetry?: boolean } => {
    state.requests[label] += 1;
    const request = { url, uniqueKey: `${runId}:${label}:${url}`, label, userData };
    return label === "compile" ? { ...request, noRetry: true } : request;
  };

  /**
   * The pages a compiled scraper replays on. A list scraper that entered
   * `direct` after a goal was compiled on the listing the navigator reached,
   * so that URL (`entry.url`) is the request, not the start URL it set out from.
   */
  const replayRequests = (plan: TemplatePlan, scraper: CompiledScraper) => {
    const userData: ReplayUserData = { label: scraper.mode === "record" ? "record" : "list", templateKey: plan.templateKey };
    const navigatedListing = scraper.mode === "list" && input.goal && scraper.entry.mode === "direct" ? scraper.entry.url : null;
    const targets = scraper.mode === "record" ? plan.urls.slice(0, input.maxItems) : plan.urls.slice(0, input.maxPages);
    const urls = navigatedListing && targets.length > 0 ? [navigatedListing] : targets;
    return urls.map((url) => requestFor(userData.label, url, userData));
  };

  const crawler = new PlaywrightCrawler(
    {
      launchContext: launch.launchContext,
      browserPoolOptions: launch.browserPoolOptions,
      headless: !input.headed,
      proxyConfiguration,
      maxConcurrency: deps.maxConcurrency ?? (singleSession ? 1 : 4),
      ...(deps.minConcurrency !== undefined ? { minConcurrency: deps.minConcurrency } : {}),
      maxRequestRetries: 1,
      requestHandlerTimeoutSecs: REQUEST_HANDLER_TIMEOUT_SECS,
      navigationTimeoutSecs: 60,
      useSessionPool: true,
      persistCookiesPerSession: false,
      sessionPoolOptions: buildSessionPoolOptions(singleSession, relaunchKnobs),
      preNavigationHooks: [async ({ page, request }) => {
        await guardContext(page.context());
        // U5: a record-mode compile runs the payload tier, which reads what
        // the page fetched for itself; the capture has to be listening before
        // the page asks.
        startCapture(page, mode === "record" && (request.userData as UserData | undefined)?.label === "compile");
        await deps.onPage?.(page);
      }],
      requestHandler: async (ctx) => {
        if (state.stop) return;
        // R20 / R28: the charge limit is checked before every page proceeds.
        if (!charger.canAfford("page-scraped")) {
          stopWith(state, crawler, { status: "charge_limit", message: `charge limit reached before ${ctx.request.url}` });
          return;
        }
        const data = ctx.request.userData as UserData;
        try {
          if (data.label === "compile") await handleCompile(ctx, data);
          else if (data.label === "record") await handleRecord(ctx, data);
          else await handleList(ctx, data);
        } catch (error) {
          if (!stopFromError(state, crawler, error)) throw error;
        } finally {
          if (profileDir) await saveProfileCookies(profileDir, ctx.page.context());
        }
      },
      failedRequestHandler: async ({ request }, error) => {
        ctxLog(`request ${request.url} failed: ${error.message}`);
      },
    },
    actor.config,
  );

  /** R14: one trace replay per session and start URL. */
  const replayKey = (ctx: PlaywrightCrawlingContext): string => `${ctx.session?.id ?? "default"}:${ctx.request.url}`;
  const planFor = (templateKey: string): TemplatePlan => {
    const plan = plans.find((p) => p.templateKey === templateKey);
    if (!plan) throw new Error(`unknown template ${templateKey}`);
    return plan;
  };

  async function handleCompile(ctx: PlaywrightCrawlingContext, data: CompileUserData): Promise<void> {
    const { page, request, response } = ctx;
    const plan = planFor(data.templateKey);
    const pre = await runPreSteps(page, {
      goal: input.goal,
      description: input.description,
      prompt: input.prompt,
      profile: input.profile,
      attended: deps.attended ?? input.headed,
      hasSecrets: secrets.size > 0,
      notify: deps.notify,
      response: { status: response?.status() },
      env,
    });
    if (pre.status !== null) {
      stopWith(state, crawler, { status: pre.status, message: pre.reason });
      return;
    }
    const trace: TraceStep[] = [...pre.steps];
    if (input.goal) {
      const nav = await navigator(page, input.goal, navigateContext);
      if (!nav.ok) {
        stopWith(state, crawler, { status: nav.status, message: nav.reason });
        return;
      }
      trace.push(...nav.steps);
    }

    /** Every sample page opened, for cleanup; `extra` below keeps sample order. */
    const opened: Page[] = [];
    let compiled: CompiledScraper;
    /** Record mode: what the compile core kept, for `--work`. */
    let core: CompiledTemplate["core"];
    try {
      if (mode === "record") {
        // the other samples are independent pages of one context: open them together
        const extra = await Promise.all(
          data.sampleUrls.slice(1).map(async (url) => {
            const sample = await page.context().newPage();
            opened.push(sample);
            // Listening before the page asks, as the crawler's own page is (U5).
            startCapture(sample, true);
            const answered = await sample.goto(url, { waitUntil: "domcontentloaded" });
            await dismissConsent(sample).catch(() => undefined);
            return { page: sample, status: answered?.status() };
          }),
        );
        const outcome = await compileRecord(plan, data, [{ page, status: response?.status() }, ...extra]);
        for (const name of outcome.fieldsNotFound) state.fieldsNotFound.add(name);
        if (outcome.stop) {
          stopWith(state, crawler, outcome.stop);
          return;
        }
        if (outcome.scraper === null) return;
        compiled = outcome.scraper;
        core = outcome.core;
      } else {
        const result = await compile({
          mode,
          pages: [page],
          fields: input.fields ?? [],
          description: input.description,
          templateKey: plan.templateKey,
          cacheKey: plan.cacheKey,
          profile: input.profile,
          chooser,
          chooserId: input.chooser,
          startUrls: urls,
          allowedDomains: input.allowedDomains,
          followDetailPages: input.followDetailPages,
          context: page.context(),
        });
        for (const name of result.fieldsNotFound) state.fieldsNotFound.add(name);
        if (!result.ok) {
          ctxLog(`template ${plan.templateKey}: ${result.status}`);
          return;
        }
        compiled = input.followDetailPages && result.detailLink ? withDetailLink(result.scraper, result.detailLink) : result.scraper;
      }
    } finally {
      for (const p of opened) await p.close().catch(() => undefined);
    }
    const entry = trace.length > 0 && compiled.entry.mode === "trace" ? { mode: "trace" as const, url: request.url } : compiled.entry;
    // U9c: this page compiled, so the site served it — which is the whole
    // definition of a page worth fingerprinting. Recorded now because a run
    // that heals is a run that has nothing working left to take a fingerprint
    // from: a cache hit never opens a good page, and asking the *drifted* run
    // for a known-good page is the circularity the canary exists to break.
    //
    // It goes into the document rather than beside it, so a recompile that
    // fails cannot leave yesterday's canary next to today's scraper.
    const canary = await recordPageCanary(request.url, response?.status(), page, ctxLog);
    const scraper = validateScraper({ ...compiled, trace, entry, canary });
    await store.put(scraper);
    await deps.onCompiled?.({ templateKey: plan.templateKey, mode, spec: specFor(plan), scraper, ...(core === undefined ? {} : { core }) });
    plan.scraper = scraper;
    plan.canary = deps.canary ?? canary ?? plan.canary;
    if (entryModeFor(scraper) === "trace") {
      // The session already stands on the listing: this start URL's replay is done (R14).
      state.replayed.add(replayKey(ctx));
      await listPages(ctx, plan);
      return;
    }
    await crawler.addRequests(replayRequests(plan, scraper));
  }

  /** U5: the spec a template is compiled against -- the run input, written down (`specFromInput`). */
  const specFor = (plan: TemplatePlan): Spec => specFromInput(input, { urls: plan.urls, rubrics: deps.rubrics });

  interface RecordOutcome {
    scraper: CompiledScraper | null;
    fieldsNotFound: string[];
    /** The run stops here: an open decision nobody could make. */
    stop?: Stop | undefined;
    core?: CompiledTemplate["core"];
  }

  /**
   * U5 (R2, KTD1): a record-mode first compile, through the one compile core.
   *
   * ## What changed
   *
   * Until U5 this was `compile({ mode: "record" })`: every requested field was
   * a question to the chooser about DOM candidates, whatever the page said
   * about itself, while `navvi make` ran the declared and payload tiers first.
   * Two compilers behind one scraper format. It is now `compileTemplate`, the
   * cascade `navvi make` runs: tier 1 reads what the pages declare, tier 2 the
   * payloads they fetched for themselves, and only the fields both left
   * uncovered reach tier 3 -- which is `chooseRecordFields`, the flow this
   * branch always ran, with the same question ids, options and recordings. A
   * page that declares nothing therefore compiles to the selectors it did
   * before, and one that declares everything asks no DOM question at all.
   *
   * ## What it hands the core
   *
   * The pages the crawler already has open, and nothing it would have to open
   * again: `fetch` is a sample page's rendered HTML (settled first, so what a
   * script declares is declared), `capture` is the JSON the page fetched while
   * it loaded, `render` gives tier 3 the same pages back and never closes them
   * -- the crawler owns their lifetime, and closes them after this returns.
   *
   * List mode does not come here: tiers 1 and 2 read one record per page, and
   * a listing is many, so `compileList` stays its compiler. Neither do detail
   * pages (`compileDetail`), which compile a record template inside a list
   * run under their own question prefix.
   */
  async function compileRecord(plan: TemplatePlan, data: CompileUserData, samples: ReadonlyArray<{ page: Page; status: number | undefined }>): Promise<RecordOutcome> {
    const requested = input.fields ?? [];
    const names = requested.map((field) => field.name);
    const spec = specFor(plan);

    const sampleOf = (url: string): { page: Page; status: number | undefined } | undefined => {
      const at = data.sampleUrls.indexOf(url);
      return at >= 0 ? samples[at] : samples.find((entry) => entry.page.url() === url);
    };
    const fetched = new Map<string, PageResponse>();
    const fetchFrom = async (url: string): Promise<PageResponse> => {
      const known = fetched.get(url);
      if (known !== undefined) return known;
      const sample = sampleOf(url);
      // The core only asks about the URLs it was handed as the sample, and
      // those are this template's open pages. Anything else is answered as a
      // fetch that never came back, which `classify` reads as transient rather
      // than as evidence against the URL.
      if (sample === undefined) return { url, status: 0, body: "" };
      await waitForSettle(sample.page).catch(() => false);
      const answer: PageResponse = { url: sample.page.url(), status: sample.status, body: await sample.page.content() };
      fetched.set(url, answer);
      return answer;
    };
    const captureFrom = async (url: string): Promise<PageCapture> => {
      const sample = sampleOf(url);
      if (sample === undefined) return { responses: [] };
      await waitForSettle(sample.page).catch(() => false);
      const capture = captures.get(sample.page);
      await capture?.settled();
      return {
        responses: capture?.responses ?? [],
        text: await sample.page.evaluate(() => document.body?.innerText ?? ""),
        html: await sample.page.content(),
      };
    };
    const render: RenderPages = (targets, use) =>
      use(
        targets.map((url) => {
          const sample = sampleOf(url);
          if (sample === undefined) throw new Error(`the compile core asked to render ${url}, which is not one of template ${plan.templateKey}'s sample pages`);
          return sample.page;
        }),
      );

    // The sample, in the crawler's own order: `pickSampleUrls` already chose
    // these pages, and the page order is the order tier 3's options list their
    // values in -- which is what a recorded answer is checked against.
    const probes = [];
    for (const url of data.sampleUrls) probes.push(probeFrom(url, await fetchFrom(url)));
    const chosen = chooseSample(probes, { size: data.sampleUrls.length });
    const position = (url: string): number => data.sampleUrls.indexOf(url);
    const sample: SampleChoice = { ...chosen, picks: [...chosen.picks].sort((a, b) => position(a.url) - position(b.url)) };

    const result: TemplateCompile = await compileTemplate({
      spec,
      fields: requested.map((field) => (field.type === undefined ? { name: field.name } : { name: field.name, type: field.type })),
      sample,
      sources: { fetch: fetchFrom, capture: captureFrom, render },
      chooser,
      templateKey: plan.templateKey,
      cacheKey: plan.cacheKey,
      profile: input.profile,
      entry: { mode: "direct", url: samples[0]!.page.url() },
    });

    if (result.ok) {
      const scraper = result.compiled.scraper;
      return {
        scraper,
        fieldsNotFound: names.filter((name) => !(name in scraper.fields)),
        core: { sample, manuscript: result.manuscript, reconciliation: result.reconciliation, rationale: result.compiled.rationale },
      };
    }

    const core: CompiledTemplate["core"] = { sample, manuscript: result.manuscript, ...(result.reconciliation === undefined ? {} : { reconciliation: result.reconciliation }) };
    await deps.onCompiled?.({ templateKey: plan.templateKey, mode, spec, scraper: null, because: result.because, core });
    const open = result.status === "open" ? (result.open?.questions ?? []) : [];
    if (open.length > 0) {
      // R4: an open ambiguity does not silently compile. The core already put
      // every choice among readings to the chooser; what is left is a decision
      // no choice question can take (a type gap, a disagreement), or one no
      // chooser could be opened for. Exit 3, like any other question owed.
      return {
        scraper: null,
        fieldsNotFound: [],
        core,
        stop: {
          status: "needs_human",
          message:
            `template ${plan.templateKey}: ${open.length} open decision(s) nobody here could make (${open.map((item) => item.id).join(", ")}) — ${result.because}. ` +
            `A --rubric or a declared type (--fields name:type) that settles it, or \`navvi make --work <dir>\` with --answer, decides it; nothing compiles an open ambiguity on a guess.`,
        },
      };
    }
    ctxLog(`template ${plan.templateKey}: ${result.status} — ${result.because}`);
    return { scraper: null, fieldsNotFound: names, core };
  }

  function checkFields(scraper: CompiledScraper, item: ItemExtraction): string[] {
    const failed: string[] = [];
    for (const [name, field] of Object.entries(scraper.fields)) {
      const by = item.resolvedBy[name];
      const alt = by === null || by === undefined ? undefined : field.alternatives[by];
      if (!alt || !fingerprintMatches(item.values[name], alt.fingerprint)) {
        failed.push(name);
        item.values[name] = null;
      }
    }
    return failed;
  }

  /** Healing runs one page at a time, so concurrent pages share the first repair instead of each asking (R33). */
  const withHealLock = serialize();
  /** R20: one page at a time claims rows — reads the room, charges it and counts them (see `pushItems`). */
  const withItemLock = serialize();

  function noteUnmapped(found: readonly UnmappedCandidate[] | undefined): void {
    for (const candidate of found ?? []) {
      if (state.unmappedCandidates.length >= 50) return;
      if (!state.unmappedCandidates.some((u) => u.selector === candidate.selector && u.text === candidate.text)) state.unmappedCandidates.push(candidate);
    }
  }

  const driftSeen = (): boolean => state.healingEvents.length > 0 || state.unhealed > 0;

  /** Every scraped page (a listing, a paginated page, a detail page) is counted and charged `page-scraped`; resolves false when the limit stops the run. */
  async function countPages(n: number, where: string): Promise<boolean> {
    if (n <= 0) return true;
    const outcome = await charger.charge("page-scraped", n);
    state.pages += charger.enabled ? outcome.charged : n;
    if (outcome.limitReached && outcome.charged < n) {
      stopWith(state, crawler, { status: "charge_limit", message: `charge limit reached while scraping ${where}` });
      return false;
    }
    return true;
  }

  /** R20: `scraper-compiled` once per template, the first time a page extracted with a scraper compiled this run passes the fingerprint check. */
  async function chargeCompiled(plan: TemplatePlan, extracted: Extracted, where: string): Promise<boolean> {
    if (plan.compileCharged || extracted.items.length === 0 || needsHealing(extracted)) return true;
    plan.compileCharged = true;
    const outcome = await charger.charge("scraper-compiled");
    if (outcome.limitReached && outcome.charged === 0) {
      stopWith(state, crawler, { status: "charge_limit", message: `charge limit reached before scraper-compiled on ${where}` });
      return false;
    }
    return true;
  }

  /**
   * U9c: the page in front of the healer, kept as this template's evidence.
   *
   * Only pages that failed their fingerprint check get here, and that is the
   * right population rather than a saving: the question `classifyRun` is being
   * asked is "may a repair be learned from this page", so the corpus is the
   * pages a repair would be learned from. Store C's 111 failures are 111
   * copies of one apology and the apology shape sees that; a redesign's
   * failures are as many different pages as the run read and it does not.
   */
  const observe = async (ctx: PlaywrightCrawlingContext, plan: TemplatePlan): Promise<PageResponse> => {
    const url = ctx.page.url();
    let body = "";
    try {
      body = await ctx.page.content();
    } catch {
      // The page can go out from under a repair (a navigation, a closed
      // context). An empty body reads as `unchecked` everywhere downstream,
      // never as a refusal, so a failure to read is not evidence of one.
    }
    const observed: PageResponse = { url, status: ctx.response?.status(), body };
    const pages = plan.evidence.pages;
    const at = pages.findIndex((page) => page.url === url);
    if (at >= 0) pages[at] = observed;
    else if (pages.length < HEAL_CORPUS_PAGES) pages.push(observed);
    return observed;
  };

  /**
   * U9c's migration: give a scraper compiled before the `canary` field existed
   * one, off the first page it replays cleanly.
   *
   * `canaryOrigin` separates the two absences and this is the reason it has
   * to. A cache hit never recompiles, so a scraper whose canary was never
   * looked for would never acquire one, and every scraper written before
   * 2026-09-23 would be permanently unable to tell a redesign from a refusal —
   * the exact question the field was added to answer. A `canary: null` is left
   * alone: that page was looked at and judged, and looking again at a
   * different page is a different decision.
   *
   * The warrant is the clean page. A page whose every field resolved and whose
   * values passed their fingerprint check is a page the site served you, which
   * is the same evidence the compile-time recording rests on — and, unlike the
   * compile-time one, it is evidence this run actually has.
   */
  async function backfillCanary(ctx: PlaywrightCrawlingContext, plan: TemplatePlan, extracted: Extracted): Promise<void> {
    if (state.stop || extracted.failed.size > 0 || extracted.items.length === 0) return;
    if (plan.scraper === null || canaryOrigin(plan.scraper) !== "unrecorded") return;
    // Under the heal lock: this writes `plan.scraper`, and so does a repair.
    await withHealLock(async () => {
      const scraper = plan.scraper;
      if (!scraper || canaryOrigin(scraper) !== "unrecorded") return;
      const canary = await recordPageCanary(ctx.page.url(), ctx.response?.status(), ctx.page, ctxLog);
      let filled: CompiledScraper;
      try {
        filled = validateScraper({ ...scraper, canary });
        await store.put(filled);
      } catch (error) {
        // A canary that will not store is not a reason to stop scraping: the
        // run goes on with no canary, exactly as it did before the field.
        ctxLog(`canary not stored for ${plan.templateKey}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      plan.scraper = filled;
      plan.canary = deps.canary ?? canary ?? plan.canary;
      ctxLog(
        canary
          ? `canary recorded for ${plan.templateKey} off ${ctx.page.url()}: this scraper predates the field and replayed clean, so the page it read is the known-good one`
          : `canary refused for ${plan.templateKey}: the page it replayed clean on carries no fingerprint that could fail`,
      );
    });
  }

  async function heal(ctx: PlaywrightCrawlingContext, plan: TemplatePlan, failure: HealFailure): Promise<CompiledScraper | null> {
    if (!plan.scraper || state.stop) return null;

    /**
     * **U9c: the gate.** Until this line existed `createHealer()` was called
     * unconditionally and `classifyRun` had no importer in `src/replay/` at
     * all — `mayHeal` was a guarantee in the type system that the run did not
     * keep, and a recompile against Store C's "¡Lo sentimos!" page was
     * reachable from a blocked verdict in the code.
     *
     * The seam the plan flagged — `classifyRun` is offline and run-wide, the
     * crawler is at one live page — is resolved by re-asking at every repair
     * over everything the run has accumulated, rather than classifying once.
     * The verdict sharpens as the corpus grows and the page about to be
     * learned from is always its newest member, which is the only ordering
     * under which the answer is about the right page.
     */
    const observed = await observe(ctx, plan);
    const licence = licenseToHeal(failure, {
      pages: plan.evidence.pages,
      fields: plan.evidence.fills,
      values: plan.evidence.values,
      observed,
      ...(plan.canary ? { canary: plan.canary } : {}),
      ...(deps.determinism ? { determinism: deps.determinism } : {}),
    });
    if (!licence.licensed) {
      ctxLog(`healing refused on ${observed.url}: ${licence.because}`);
      // A refused repair is the moment a person most needs to see what was on
      // the page, so the scan still runs. It costs no chooser call and stores
      // nothing — `UnmappedCandidate` is reported and never written into a
      // scraper — which is exactly why refusing the repair is no reason to
      // refuse the diagnosis too.
      noteUnmapped(await findUnmappedCandidates(ctx.page, plan.scraper).catch(() => []));
      return null;
    }
    ctxLog(`healing licensed on ${observed.url}: ${licence.because}`);
    const licensed: HealFailure = failure.kind === "fields" ? { kind: "fields", fields: licence.fields } : failure;

    let outcome: HealOutcome;
    try {
      outcome = await healer({ page: ctx.page, scraper: plan.scraper, chooser, failure: licensed, allowMutations: input.allowMutations });
    } catch (error) {
      /**
       * R19: a chooser failure skips healing; the page counts as unhealed and
       * the crawl goes on.
       *
       * **R19 is about a page, and every error that carries a run status is
       * about the run.** That distinction was made one class at a time —
       * `NeedsHumanError`, then `ConfigurationError` (a544e96) — and each time
       * it was made for the same reason, which is the reason to stop making it
       * one class at a time. A `BudgetExhaustedError` or a
       * `ModelUnavailableError` swallowed here becomes `unhealed += 1`, and
       * `summaryOf` calls a run `succeeded` whenever any field on the page
       * filled: a run that ran out of chooser budget on page 3 of 4,000 came
       * back green with nulls down one column. The status union exists so that
       * a run can say which of those happened, and this line was throwing the
       * answer away.
       *
       * So the test is `NavviError`, which is exactly "this error names a run
       * status". `stopFromError` already knows what to do with every one of
       * them; nothing new is decided here.
       */
      if (error instanceof NavviError) throw error;
      /**
       * `StateTooLargeError` needed its own line here until 2026-09-23,
       * because it extended plain `Error`. It extends `NavviError` now, so the
       * test above catches it and this is one rule rather than two.
       *
       * `InvalidAnswerError` is the fourth of that family and needs no line:
       * no chooser throws it out, `BaseChooser.fail` wraps it as the `cause`
       * of a `NeedsHumanError` or a `ModelUnavailableError`, and it arrives
       * here as one of those.
       */
      ctxLog(`healing skipped on ${ctx.page.url()}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    noteUnmapped(outcome.unmapped);
    if (!outcome.healed) {
      ctxLog(`healing found nothing on ${ctx.page.url()}: ${outcome.reason}`);
      return null;
    }
    if (state.healingEvents.length >= LIMITS.healingEvents) {
      stopWith(state, crawler, { status: "drift", message: `healing budget of ${LIMITS.healingEvents} events per run exhausted at ${ctx.page.url()}` });
      return null;
    }
    state.healingEvents.push(outcome.event);
    if (outcome.event.kind === "field") for (const name of outcome.event.fields) plan.healedFields.add(name);
    await store.put(outcome.scraper);
    plan.scraper = outcome.scraper;
    return outcome.scraper;
  }

  /**
   * The JSON a page fetches about itself, for `network` field alternatives.
   *
   * A single-page app ships a shell: there is nothing to read in the HTML and
   * the rendered DOM is the hardest place to read it from -- Store B shows
   * three prices styled alike, which is how a compiled selector caught the Club
   * price. The payload names them (`price-list-std`, `price-sale-std`).
   *
   * Capture starts before navigation so the first responses are not missed, and
   * every response is kept: a page that retries leaves its failure behind too,
   * and Store B's detail endpoint answers 401 before its session exists.
   *
   * Only a scraper that actually declares a `network` alternative pays for
   * this, so nothing changes for a scraper that does not.
   */
  const captures = new WeakMap<Page, Capture>();
  /**
   * Asked per page rather than once per run. A scraper compiled *this* run can
   * read payloads too since U5 put the record compile on the payload tier, and
   * a flag computed before the compile would leave every replay page after it
   * without a capture, reading each `network` field null.
   */
  const wantsNetwork = (): boolean => plans.some((p) => p.scraper && Object.values(p.scraper.fields).some((f) => f.alternatives.some((a) => a.source === "network")));

  const startCapture = (page: Page, compiling = false): void => {
    if ((!compiling && !wantsNetwork()) || captures.has(page)) return;
    captures.set(page, captureJson(page, { match: /./, limit: 40 }));
  };
  const capturedFor = (page: Page): CapturedResponse[] => captures.get(page)?.responses ?? [];
  /**
   * Once per run, when the capture came back with nothing: an empty capture
   * and a capture that discarded forty responses look identical from here, and
   * the difference is the whole diagnosis. Once, because the second page's
   * answer is the first page's answer.
   */
  let skipsReported = false;
  /**
   * The payloads a scraper's `network` alternatives are compiled against, by
   * the substring they are matched on. A scraper that reads no payload has
   * none and waits for nothing.
   */
  const payloadMatchesOf = (scraper: CompiledScraper): string[] => {
    const matches = new Set<string>();
    for (const field of Object.values(scraper.fields)) {
      for (const alternative of field.alternatives) {
        if (alternative.source === "network") matches.add(alternative.match ?? "");
      }
    }
    return [...matches];
  };

  /**
   * Wait for the payloads this scraper reads to actually arrive.
   *
   * `Capture.settled()` drains body reads that have *started*; it is not a wait
   * for a response to turn up. So a page whose `fetch` had not yet returned
   * when the crawler reached it was extracted against an empty capture, and
   * every `network`-source field came back null -- on a page that was served
   * perfectly, with the payload arriving milliseconds later.
   *
   * It is the same defect as the driver's 25 s settle cap, one driver over, and
   * it read the same way: a field that was there and was not waited for is
   * indistinguishable from a field the site stopped serving. `make/pages.ts`
   * requires the payload *count* to hold still before it believes a render;
   * this is the crawler's smaller version of that, and it can be smaller
   * because a compiled scraper already says which payloads it reads, so the
   * wait is for those rather than for quiet in general.
   *
   * Bounded, and it says when the bound was reached: a payload that never
   * arrived is a fact worth logging, and it is not the same fact as a payload
   * that arrived and disagreed.
   */
  const PAYLOAD_WAIT_MS = 10_000;
  const PAYLOAD_POLL_MS = 100;
  const awaitPayloads = async (page: Page, capture: Capture, wanted: readonly string[]): Promise<void> => {
    if (wanted.length === 0) return;
    const has = (match: string): boolean => capture.responses.some((response) => response.url.includes(match));
    const deadline = Date.now() + PAYLOAD_WAIT_MS;
    while (Date.now() < deadline) {
      if (wanted.every(has)) return;
      await page.waitForTimeout(PAYLOAD_POLL_MS).catch(() => undefined);
    }
    const missing = wanted.filter((match) => !has(match));
    if (missing.length > 0) {
      ctxLog(
        `waited ${PAYLOAD_WAIT_MS} ms on ${page.url()} and ${missing.length} of ${wanted.length} compiled payload(s) never arrived ` +
          `(${missing.map((match) => `"${match}"`).join(", ")}): the fields read from them are unread, not absent`,
      );
    }
  };

  /** Body reads are async: a response that arrived is not yet one that can be read. */
  const settleCaptures = async (page: Page, scraper?: CompiledScraper): Promise<void> => {
    const capture = captures.get(page);
    if (!capture) return;
    if (scraper) await awaitPayloads(page, capture, payloadMatchesOf(scraper));
    await capture.settled();
    if (skipsReported || capture.responses.length > 0) return;
    const dropped = describeSkips(capture.skipped);
    if (!dropped) return;
    skipsReported = true;
    ctxLog(`captured no JSON on ${page.url()}: ${dropped}`);
  };

  interface Extracted {
    scraper: CompiledScraper;
    items: ItemExtraction[];
    /** Fields that failed on at least one item (R17). */
    failed: Set<string>;
  }

  async function extractChecked(page: Page, scraper: CompiledScraper, sourceUrl: string): Promise<Extracted> {
    await settleCaptures(page, scraper);
    const extraction = await extractPage(page, scraper, {
      sourceUrl,
      fields: [...fields, ...detailFieldNames],
      captured: capturedFor(page),
    });
    const items = scraper.mode === "record" && extraction.items.length === 0 ? [extraction] : extraction.items;
    const failed = new Set<string>();
    for (const item of items) for (const name of checkFields(scraper, item)) failed.add(name);
    return { scraper, items, failed };
  }

  /**
   * U9c: one failing page's reading, folded into the evidence the gate weighs.
   *
   * **Only pages that asked for a repair are counted, and that is the whole
   * measurement rather than a saving.** The machine's requirement is that "the
   * field stopped filling *while the rest of the run kept answering*", which is
   * a comparison between fields on the pages that are failing — not a
   * comparison between this page and the run's history. Counting every page
   * read would answer a different question and answer it wrongly in both
   * directions: a thousand good pages followed by a redesign would keep the
   * broken field's rate above the floor forever and no repair would ever be
   * licensed, and a run that started broken would look no different from one
   * that broke at the end.
   *
   * Both halves are needed and neither is enough. The counts are what
   * `every-field-collapsed-is-blocking` weighs; the values are what
   * `no-variation-no-field` weighs, and without them Store C reads as healthy
   * — its `product_name` was 111 of 111 filled, every one of them
   * "¡Lo sentimos!". A fill rate cannot see a column that filled perfectly
   * with one wrong answer, and that is the exact page a repair would have
   * learned from.
   */
  function countFields(plan: TemplatePlan, e: Extracted): void {
    if (e.items.length === 0) return;
    for (const name of Object.keys(e.scraper.fields)) {
      const fill = (plan.evidence.fills[name] ??= { filled: 0, total: 0 });
      const values = (plan.evidence.values[name] ??= []);
      for (const item of e.items) {
        const value = item.values[name] ?? null;
        fill.total += 1;
        if (value !== null && value !== "") fill.filled += 1;
        if (values.length < FIELD_VALUE_SAMPLES) values.push(value);
      }
    }
  }

  /** R33: a page whose every item leaves a compiled field empty asks for healing; an empty listing is an end, not drift. */
  const needsHealing = (e: Extracted): boolean =>
    e.items.length > 0 && Object.keys(e.scraper.fields).length > 0 && e.items.every((item) => Object.keys(e.scraper.fields).some((n) => item.values[n] === null));

  /** R16: source URL in record mode, the detail link in list mode, else a hash of every field. Rows with no value at all are never collapsed. */
  function dedupeKey(scraper: CompiledScraper, item: ItemExtraction, sourceUrl: string): string | null {
    if (scraper.mode === "record") return `url:${sourceUrl}`;
    const link = detailLinkOf(scraper, item);
    if (link) return `link:${link}`;
    const names = Object.keys(item.values)
      .filter((n) => n !== DETAIL_LINK_FIELD)
      .sort();
    if (names.every((n) => item.values[n] === null)) return null;
    return `hash:${createHash("sha256").update(JSON.stringify(names.map((n) => [n, item.values[n]]))).digest("hex")}`;
  }

  /**
   * R18: compiles the detail template on first use, then merges each item's
   * detail page; every detail page is a scraped page. Always returns one row
   * per item given, in order — `pushItems` has already charged for them.
   */
  async function mergeDetails(ctx: PlaywrightCrawlingContext, plan: TemplatePlan, scraper: CompiledScraper, items: ItemExtraction[]): Promise<ItemExtraction[]> {
    let live = scraper;
    const samples = new Map<string, ItemExtraction>();
    const links = items.map((item) => detailLinkOf(live, item));
    if (!hasDetailTemplate(live)) {
      const room = input.maxPages - state.pages;
      const sampleLinks = [...new Set(links.filter((l): l is string => l !== null))].slice(0, Math.max(0, room));
      if (sampleLinks.length === 0) return items.map((item) => mergeDetail(item, null, detailFieldNames));
      const result = await compileDetail({
        context: ctx.page.context(),
        scraper: live,
        links: sampleLinks,
        detailFields,
        description: input.description,
        chooser,
        chooserId: input.chooser,
        profile: input.profile,
        startUrls: urls,
        allowedDomains: input.allowedDomains,
        prepare: (page) => dismissConsent(page).then(() => undefined),
      });
      const counted = await countPages(result.pagesOpened, `detail samples of ${ctx.page.url()}`);
      for (const name of result.fieldsNotFound) state.fieldsNotFound.add(name);
      if (!counted || !result.ok) return items.map((item) => mergeDetail(item, null, detailFieldNames));
      live = result.scraper;
      await store.put(live);
      plan.scraper = live;
      for (const [url, sample] of result.samples) samples.set(url, sample);
    }
    const out: ItemExtraction[] = [];
    let detailPage: Page | null = null;
    /** The page budget ran out mid-merge: no further detail page is opened. */
    let pagesSpent = false;
    try {
      for (const [i, item] of items.entries()) {
        const link = links[i] ?? null;
        let detail = link ? (samples.get(link) ?? null) : null;
        if (link && !detail && !pagesSpent && state.pages < input.maxPages && !state.stop) {
          detailPage ??= await ctx.page.context().newPage();
          // A row already charged as a `result-item` is never dropped for want of a
          // detail page: past either budget it goes out with its detail columns
          // empty, exactly as it does past `maxPages`.
          if (await countPages(1, link)) detail = await extractDetail(detailPage, live, link, detailFieldNames);
          else pagesSpent = true;
        }
        out.push(mergeDetail(item, detail, detailFieldNames));
      }
    } finally {
      await detailPage?.close().catch(() => undefined);
    }
    return out;
  }

  /** Extracts, heals, dedupes against `seen`, and pushes one page; resolves to the rows it added. */
  async function pushItems(ctx: PlaywrightCrawlingContext, plan: TemplatePlan, scraper: CompiledScraper, sourceUrl: string, seen: Set<string>): Promise<number> {
    const { page } = ctx;
    let current = await extractChecked(page, scraper, sourceUrl);
    let healAttempted = false;
    if (needsHealing(current)) {
      await withHealLock(async () => {
        // another page may have healed the template meanwhile: re-check on the live scraper first
        if (plan.scraper && plan.scraper !== current.scraper) current = await extractChecked(page, plan.scraper, sourceUrl);
        if (!needsHealing(current)) return;
        // U9c: the reading *before* the repair, and only from a page that
        // asked for one. Counting the post-repair reading would hand
        // `classifyRun` a fill rate that already contains the repair it is
        // being asked to license; counting the pages that did not ask would
        // answer a different question — see `countFields`.
        countFields(plan, current);
        healAttempted = true;
        const healed = await heal(ctx, plan, { kind: "fields", fields: [...current.failed] });
        if (healed) current = await extractChecked(page, healed, sourceUrl);
        else if (!state.stop) state.unhealed += 1;
      });
    }
    else await backfillCanary(ctx, plan, current);
    // U9b: the resolution votes are the *settled* reading — after a repair,
    // not before — because the alternative that answered is the one that put
    // the value in the row.
    for (const item of current.items) observeResolutions(plan.tally, item.resolvedBy);
    if (state.stop) return 0;
    if (!healAttempted && driftSeen()) noteUnmapped(await findUnmappedCandidates(page, current.scraper).catch(() => []));
    if (!(await chargeCompiled(plan, current, sourceUrl))) return 0;
    if (!(await countPages(1, sourceUrl))) return 0;
    const live = current.scraper;
    const fresh: ItemExtraction[] = [];
    for (const item of current.items) {
      const key = dedupeKey(live, item, sourceUrl);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      fresh.push(item);
    }
    // R20 / AE13: the rows are claimed before any of them is pushed — charged
    // first, counted second, pushed last — so a row reaches the dataset only
    // when it was paid for, and a push can never have to be retracted.
    //
    // The claim is one critical section. Reading the room, spending it and
    // counting the rows against `maxItems` must not interleave with another
    // page doing the same, or two pages both slice a room only one of them can
    // have. Even so, the room is only a forecast: the Apify budget is a single
    // pot, so a `page-scraped` charged meanwhile (a detail page of another
    // listing) can shrink it. The charge's own count is therefore the
    // authority on how many rows may go out. Detail merging and the push stay
    // outside the lock: concurrency loses one charge call, never a page.
    const claim = await withItemLock(async () => {
      const itemRoom = input.maxItems - state.items;
      const chargeRoom = charger.room("result-item");
      const want = Math.max(0, Math.min(itemRoom, chargeRoom, fresh.length));
      const outcome = await charger.charge("result-item", want);
      const granted = charger.enabled ? Math.min(want, outcome.charged) : want;
      state.items += granted;
      return { granted, limitReached: outcome.limitReached || (fresh.length > granted && chargeRoom < itemRoom) };
    });
    let rows = fresh.slice(0, claim.granted);
    if (live.mode === "list" && live.detail && detailFieldNames.length > 0 && rows.length > 0) rows = await mergeDetails(ctx, plan, live, rows);
    for (const item of rows) {
      if (Object.keys(live.fields).some((n) => item.values[n] === null)) state.failedItems += 1;
    }
    if (rows.length > 0) {
      // R5: declared types are applied after the fingerprint check, on the row that goes out
      const types = { ...fieldTypesOf(live), ...inputTypes };
      await dataset.pushData(
        rows.map((item) => {
          const { [DETAIL_LINK_FIELD]: _hidden, ...values } = item.values;
          return { ...coerceValues(values, types, sourceUrl), _source: sourceUrl };
        }),
      );
    }
    if (claim.limitReached) {
      stopWith(state, crawler, { status: "charge_limit", message: `charge limit reached after ${state.items} items on ${sourceUrl}` });
    }
    return rows.length;
  }

  async function handleRecord(ctx: PlaywrightCrawlingContext, data: ReplayUserData): Promise<void> {
    const plan = planFor(data.templateKey);
    if (!plan.scraper || state.items >= input.maxItems) return;
    await dismissConsent(ctx.page).catch(() => undefined);
    await pushItems(ctx, plan, plan.scraper, ctx.request.url, state.seen);
  }

  async function handleList(ctx: PlaywrightCrawlingContext, data: ReplayUserData): Promise<void> {
    const plan = planFor(data.templateKey);
    const scraper = plan.scraper;
    if (!scraper || state.items >= input.maxItems) return;
    const { page } = ctx;
    await dismissConsent(page).catch(() => undefined);

    if (entryModeFor(scraper) === "trace") {
      const key = replayKey(ctx);
      if (!state.replayed.has(key)) {
        state.replayed.add(key);
        state.traceReplays += 1;
        if (page.url() !== scraper.entry.url) await page.goto(scraper.entry.url, { waitUntil: "domcontentloaded" });
        const onStepFailed = async (stepIndex: number, failedPage: Page, reason: string): Promise<StepFailureAction> => {
          const healed = await heal(ctx, plan, { kind: "step", stepIndex, reason });
          // the retry runs the healed step, with its appended alternative (R42)
          if (healed) return { action: "retry", step: healed.trace[stepIndex] };
          if (input.goal) {
            // the navigator starts from the page the steps before this one reached (logged in, say): those steps stay
            const nav = await navigator(failedPage, input.goal, navigateContext);
            if (nav.ok) {
              const renavigated = validateScraper({ ...plan.scraper!, trace: [...plan.scraper!.trace.slice(0, stepIndex), ...nav.steps] });
              await store.put(renavigated);
              plan.scraper = renavigated;
              return { action: "done" };
            }
          }
          return { action: "fail" };
        };
        const replay = await replayTrace(page, scraper, { secrets, policy, onStepFailed });
        if (!replay.ok) {
          stopWith(state, crawler, { status: replay.status, message: `trace step ${replay.stepIndex}: ${replay.reason}` });
          return;
        }
      }
    }

    await listPages(ctx, plan);
  }

  /** Extracts the listing the page stands on, then follows the paginate hook (R15); two consecutive empty pages end the listing (R16). */
  async function listPages(ctx: PlaywrightCrawlingContext, plan: TemplatePlan): Promise<void> {
    let pageIndex = 0;
    let emptyStreak = 0;
    // R16: rows repeated across the pages of one listing are pushed once
    const seen = new Set<string>();
    for (;;) {
      const scraper = plan.scraper;
      if (!scraper) return;
      // Dynamic lists may still contain only skeletons after navigation. Wait
      // for the compiled anchor, bounded so genuinely empty lists still finish.
      if (scraper.item) {
        await ctx.page.locator(scraper.item.anchorSelector).first().waitFor({ state: "attached", timeout: 5_000 }).catch((error: unknown) => {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        });
      }
      const pushed = await pushItems(ctx, plan, scraper, ctx.page.url(), seen);
      if (state.stop) return;
      pageIndex += 1;
      emptyStreak = pushed === 0 ? emptyStreak + 1 : 0;
      if (emptyStreak >= 2 || state.items >= input.maxItems || state.pages >= input.maxPages) return;
      const moved = await paginateHook(ctx.page, plan.scraper ?? scraper, pageIndex);
      if (!moved) return;
    }
  }

  // Initial requests: compile on a miss, replay on a hit.
  const initial = plans.flatMap((plan) => {
    if (plan.scraper) return replayRequests(plan, plan.scraper);
    const sampleUrls = pickSampleUrls(plan.urls, mode === "record" ? 3 : 1);
    return [requestFor("compile", sampleUrls[0]!, { label: "compile", templateKey: plan.templateKey, sampleUrls })];
  });

  try {
    await crawler.run(initial);
  } catch (error) {
    // U16: the decisive evidence is the `cause` chain, which the Apify run log
    // truncates. Record it before the error leaves this frame, and keep it in
    // the key-value store so it survives the log.
    if (isLaunchFailure(error)) {
      const report = launchFailureReport(error, launchCounter.launches, relaunchKnobs, env);
      ctxLog(formatLaunchFailure(report));
      await actor
        .openKeyValueStore()
        .then((store) => store.setValue("LAUNCH_FAILURE", report))
        .catch(() => undefined);
    }
    throw error;
  }
  if (state.fatal) throw state.fatal;
  await promoteAlternatives();
  return summaryOf(input, state, plans, chooser, charger);

  /**
   * **U9b: an alternative that keeps working outranks one that keeps failing.**
   *
   * After the crawl, not during it. A promotion is a claim about a whole run —
   * this alternative answered every item and the ones ahead of it answered
   * none — and mid-crawl there is no such thing as a whole run. It is also the
   * only honest moment: `judgePromotions` needs the counts to be final, and a
   * reorder applied to a template another page is still extracting against
   * would change the cascade under it.
   *
   * A run that stopped short promotes nothing. Its counts are a prefix of a
   * measurement rather than one, and a charge limit or a block is exactly the
   * kind of thing that makes a good alternative look like a failing one.
   */
  async function promoteAlternatives(): Promise<void> {
    if (state.stop) return;
    for (const plan of plans) {
      const scraper = plan.scraper;
      if (!scraper) continue;
      const promotions = judgePromotions(scraper, plan.tally, { healed: plan.healedFields });
      if (promotions.length === 0) continue;
      let promoted = scraper;
      for (const promotion of promotions) promoted = promoteFieldAlternative(promoted, promotion.field, promotion.from);
      const at = new Date().toISOString();
      try {
        await store.put(validateScraper(promoted));
      } catch (error) {
        // A reorder that will not validate is a defect in the reorder, not a
        // reason to ship it: the stored scraper is left exactly as it was.
        ctxLog(`promotion skipped for ${plan.templateKey}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      plan.scraper = promoted;
      for (const promotion of promotions) {
        ctxLog(`promoted ${promotion.field} on ${plan.templateKey}: ${promotion.because}`);
        state.promotions.push({ kind: "promotion", field: promotion.field, from: promotion.from, observations: promotion.observations, at, because: promotion.because });
      }
    }
  }
}

/**
 * How many failed pages the repair gate keeps bodies for.
 *
 * The corpus is only there so the apology shape has something to compare
 * against, and that shape is decided by whether the *same document* comes back
 * on different URLs — a question two dozen pages answer as well as a thousand.
 * Store C's run was 111 URLs of one page and would have been settled by the
 * second. The cap is what stops a long crawl of a genuinely broken template
 * from carrying its whole HTML in memory.
 */
const HEAL_CORPUS_PAGES = 24;

/** How many readings of one field the gate keeps for the variation check. Enough to be a sample, bounded so a long run is not a leak. */
const FIELD_VALUE_SAMPLES = 200;

/**
 * How many words a canary has to carry before it is worth recording.
 *
 * `checkCanary` reads an empty word list as full overlap, so a fingerprint
 * taken off a page with nothing on it resolves against every page there will
 * ever be — including the refusal it exists to catch. A canary that always
 * resolves is worse than none: none reads `unchecked` and refuses to license a
 * total collapse, and that one reads `resolved` and licenses a repair against
 * an error page.
 */
const MIN_CANARY_WORDS = 8;

/**
 * Fingerprint the page in front of us, or say why not.
 *
 * `null` is a decision and is stored as one (`CompiledScraper.canary: null`):
 * this page was looked at and judged unable to disprove anything. It is not
 * the same as a scraper that carries no `canary` key, which is one compiled
 * before the field existed — see `canaryOrigin`.
 *
 * Everything here fails quietly toward `null`. A page that could not be read
 * is not evidence that the site is refusing you.
 */
async function recordPageCanary(url: string, status: number | undefined, page: Page, log: (message: string) => void): Promise<CanaryFingerprint | null> {
  try {
    const canary = recordCanary({ url, status: status ?? 200, body: await page.content() });
    if (canary.words.length < MIN_CANARY_WORDS) {
      log(`no canary recorded for ${url}: ${canary.words.length} words is not a fingerprint that could fail`);
      return null;
    }
    return canary;
  } catch (error) {
    log(`no canary recorded for ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** On the platform a secret may also be a `SECRET_<NAME>` record in the run's default store. */
async function readApifySecret(actor: CrawlActor, name: string): Promise<string | null> {
  const store = await actor.openKeyValueStore();
  const value = await store.getValue<unknown>(`SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Where the crawler's own sentences go when nobody asked for them.
 *
 * `CrawlDeps.log` overrides this per run. That seam exists because on
 * 2026-09-23 `tests/acceptance.test.ts` failed with four null fields on one
 * page and no cause anywhere the test could reach: the sentence naming the
 * cause was written here, to stderr, while `runDemo` collects its lines
 * through its own sink. The same week, `tools/measure/scenarios.ts` was found
 * to have been discarding this stream through `log: () => undefined`, and
 * restoring it was what finally named a flake that had been misdiagnosed for
 * weeks. A diagnostic only counts if it reaches whoever is diagnosing.
 */
function defaultCtxLog(message: string): void {
  process.stderr.write(`navvi: ${message}\n`);
}
