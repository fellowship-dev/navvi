import { installSnapshot } from "../browser/snapshot.js";
import { createHash, randomUUID } from "node:crypto";
import { Actor } from "apify";
import { PlaywrightCrawler, ProxyConfiguration, type Configuration, type Dataset, type KeyValueStore, type PlaywrightCrawlingContext } from "crawlee";
import type { BrowserContext, Page } from "playwright";
import { Charger, type ChargingActor } from "../billing/charge.js";
import { buildCrawleeLaunchContext, restoreProfileCookies, saveProfileCookies } from "../browser/launch.js";
import { createLaunchCounter, formatLaunchFailure, isLaunchFailure, launchFailureReport, resolveRelaunchKnobs, type RelaunchKnobs } from "../browser/relaunch.js";
import { hostOf, isAllowedRequestUrl, registrableDomain } from "../browser/policy.js";
import { createChooser, NavviError, NeedsHumanError, type Chooser } from "../chooser/index.js";
import { compile, type CompileResult } from "../compile/index.js";
import { LIMITS, isAllowedUrl, resolveSources, type FieldType, type Profile, type ProxyInput, type RunInput } from "../input/schema.js";
import type { RunSummary } from "../main.js";
import { dismissConsent, runPreSteps, type Notifier } from "../prestep/index.js";
import { coerceValues, extractPage, fieldTypesOf, fingerprintMatches, type ItemExtraction } from "../scraper/extract.js";
import { cacheKey, validateScraper, type CompiledScraper, type Status, type TraceStep } from "../scraper/schema.js";
import { ScraperStore, ScraperStoreError } from "../scraper/store.js";
import { findPlaceholders, MASK, maskUrlCredentials, MissingSecretError, redactRunInput, resolveSecrets, type CommandRunner, type Secret } from "../secrets/resolve.js";
import { groupByTemplate, pickSampleUrls } from "../template/index.js";
import { compileDetail, DETAIL_LINK_FIELD, detailLinkOf, extractDetail, hasDetailTemplate, mergeDetail, withDetailLink } from "./detail.js";
import { entryModeFor, replayTrace, type ReplayPolicy, type StepFailureAction } from "./entry.js";
import { createHealer, findUnmappedCandidates, type HealingEvent, type UnmappedCandidate } from "./heal.js";
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
      ctxLog(`list ${url} skipped: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (listed === null || listed.length === 0) {
      ctxLog(`list ${url} skipped: no URLs in the answer`);
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
    healingEvents: state.healingEvents,
    unmappedCandidates: state.unmappedCandidates,
    fieldsNotFound: [...state.fieldsNotFound].sort(),
    // U14: the totals are the run's; `writer` names the second source and its share of them.
    chooser: usage
      ? {
          name: usage.chooser,
          questions: usage.questions,
          inputTokens: usage.inputTokens,
          waitMs: usage.waitMs,
          costUsd: usage.costUsd,
          textQuestions: usage.textQuestions,
          ...(usage.writer
            ? { writer: { name: usage.writer.chooser, textQuestions: usage.writer.textQuestions, inputTokens: usage.writer.inputTokens, waitMs: usage.writer.waitMs, costUsd: usage.writer.costUsd } }
            : {}),
        }
      : null,
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
  if (options.useApifyProxy) ctxLog(`Apify Proxy was requested (${asked}) but no configuration was created; the run continues with no proxy`);
  return fallback ? { launchProxyUrl: fallback } : {};
}

// ---------------------------------------------------------------- the run

export async function runCrawl(input: RunInput, deps: CrawlDeps = {}): Promise<RunSummary> {
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
  const urls = await loadListSources(input.startUrls ?? [], input.urlLists, input.allowPrivateHosts, deps.fetchText);
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
      plans.push({ templateKey, cacheKey: key, urls: templateUrls, scraper: loaded.scraper, cacheHit: loaded.cacheHit, compileCharged: loaded.cacheHit });
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
    await context.route("**/*", (route) => {
      if (guard(route.request().url())) return route.continue();
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
      preNavigationHooks: [async ({ page }) => {
        await guardContext(page.context());
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
    let result: CompileResult;
    try {
      let extra: Page[] = [];
      if (mode === "record") {
        // the other samples are independent pages of one context: open them together
        extra = await Promise.all(
          data.sampleUrls.slice(1).map(async (url) => {
            const sample = await page.context().newPage();
            opened.push(sample);
            await sample.goto(url, { waitUntil: "domcontentloaded" });
            await dismissConsent(sample).catch(() => undefined);
            return sample;
          }),
        );
      }
      result = await compile({
        mode,
        pages: [page, ...extra],
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
    } finally {
      for (const p of opened) await p.close().catch(() => undefined);
    }
    for (const name of result.fieldsNotFound) state.fieldsNotFound.add(name);
    if (!result.ok) {
      ctxLog(`template ${plan.templateKey}: ${result.status}`);
      return;
    }
    const compiled = input.followDetailPages && result.detailLink ? withDetailLink(result.scraper, result.detailLink) : result.scraper;
    const entry = trace.length > 0 && compiled.entry.mode === "trace" ? { mode: "trace" as const, url: request.url } : compiled.entry;
    const scraper = validateScraper({ ...compiled, trace, entry });
    await store.put(scraper);
    plan.scraper = scraper;
    if (entryModeFor(scraper) === "trace") {
      // The session already stands on the listing: this start URL's replay is done (R14).
      state.replayed.add(replayKey(ctx));
      await listPages(ctx, plan);
      return;
    }
    await crawler.addRequests(replayRequests(plan, scraper));
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

  async function heal(ctx: PlaywrightCrawlingContext, plan: TemplatePlan, failure: HealFailure): Promise<CompiledScraper | null> {
    if (!plan.scraper || state.stop) return null;
    let outcome: HealOutcome;
    try {
      outcome = await healer({ page: ctx.page, scraper: plan.scraper, chooser, failure, allowMutations: input.allowMutations });
    } catch (error) {
      // R19: a chooser failure skips healing; the page counts as unhealed and the crawl goes on.
      if (error instanceof NeedsHumanError) throw error;
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
    await store.put(outcome.scraper);
    plan.scraper = outcome.scraper;
    return outcome.scraper;
  }

  interface Extracted {
    scraper: CompiledScraper;
    items: ItemExtraction[];
    /** Fields that failed on at least one item (R17). */
    failed: Set<string>;
  }

  async function extractChecked(page: Page, scraper: CompiledScraper, sourceUrl: string): Promise<Extracted> {
    const extraction = await extractPage(page, scraper, { sourceUrl, fields: [...fields, ...detailFieldNames] });
    const items = scraper.mode === "record" && extraction.items.length === 0 ? [extraction] : extraction.items;
    const failed = new Set<string>();
    for (const item of items) for (const name of checkFields(scraper, item)) failed.add(name);
    return { scraper, items, failed };
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
        healAttempted = true;
        const healed = await heal(ctx, plan, { kind: "fields", fields: [...current.failed] });
        if (healed) current = await extractChecked(page, healed, sourceUrl);
        else if (!state.stop) state.unhealed += 1;
      });
    }
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
  return summaryOf(input, state, plans, chooser, charger);
}

/** On the platform a secret may also be a `SECRET_<NAME>` record in the run's default store. */
async function readApifySecret(actor: CrawlActor, name: string): Promise<string | null> {
  const store = await actor.openKeyValueStore();
  const value = await store.getValue<unknown>(`SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ctxLog(message: string): void {
  process.stderr.write(`navvi: ${message}\n`);
}
