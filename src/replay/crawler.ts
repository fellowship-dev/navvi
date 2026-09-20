import { installSnapshot } from "../browser/snapshot.js";
import { createHash, randomUUID } from "node:crypto";
import { Actor } from "apify";
import { PlaywrightCrawler, ProxyConfiguration, type Configuration, type Dataset, type KeyValueStore, type PlaywrightCrawlingContext } from "crawlee";
import type { BrowserContext, Page } from "playwright";
import { Charger, type ChargingActor } from "../billing/charge.js";
import { buildCrawleeLaunchContext, restoreProfileCookies, saveProfileCookies } from "../browser/launch.js";
import { hostOf, isAllowedRequestUrl, registrableDomain } from "../browser/policy.js";
import { createChooser, NavviError, NeedsHumanError, type Chooser } from "../chooser/index.js";
import { compile, type CompileResult } from "../compile/index.js";
import { LIMITS, isAllowedUrl, type Profile, type RunInput } from "../input/schema.js";
import type { RunSummary } from "../main.js";
import { dismissConsent, runPreSteps, type Notifier } from "../prestep/index.js";
import { extractPage, fingerprintMatches, type ItemExtraction } from "../scraper/extract.js";
import { cacheKey, validateScraper, type CompiledScraper, type Status, type TraceStep } from "../scraper/schema.js";
import { ScraperStore, ScraperStoreError } from "../scraper/store.js";
import { findPlaceholders, MissingSecretError, redactRunInput, resolveSecrets, type CommandRunner, type Secret } from "../secrets/resolve.js";
import { groupByTemplate, pickSampleUrls } from "../template/index.js";
import { compileDetail, DETAIL_LINK_FIELD, detailLinkOf, extractDetail, hasDetailTemplate, mergeDetail, withDetailLink } from "./detail.js";
import { entryModeFor, replayTrace, type ReplayPolicy, type StepFailureAction } from "./entry.js";
import { createHealer, findUnmappedCandidates, type HealingEvent, type UnmappedCandidate } from "./heal.js";
import { defaultNavigator } from "./navigator.js";
import { defaultPaginate } from "./paginate.js";

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

/** What the crawler needs from `Actor`; the static class and an instance both satisfy it. Charging is optional (R20). */
export interface CrawlActor extends ChargingActor {
  openKeyValueStore(storeIdOrName?: string | null): Promise<KeyValueStore>;
  openDataset(datasetIdOrName?: string | null): Promise<Dataset>;
  isAtHome(): boolean;
  readonly config: Configuration;
  createProxyConfiguration?(options?: { proxyUrls?: string[] }): Promise<ProxyConfiguration | undefined>;
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

function parseListSource(contentType: string, body: string): string[] | null {
  const type = contentType.toLowerCase();
  if (type.includes("json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const list = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { urls?: unknown }).urls) ? (parsed as { urls: unknown[] }).urls : null;
    if (!list) return null;
    return list
      .map((entry) => (typeof entry === "string" ? entry : typeof entry === "object" && entry !== null ? (entry as { url?: unknown }).url : undefined))
      .filter((u): u is string => typeof u === "string");
  }
  if (type.includes("text/plain") || type.includes("text/csv")) {
    return body
      .split(/\r?\n/)
      .map((line) => line.split(",")[0]!.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  }
  return null;
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
 * lists (a page answering HTML stays a start URL). Every URL is
 * policy-checked; refused ones are dropped.
 */
export async function loadListSources(
  startUrls: readonly string[],
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
    chooser: usage ? { name: usage.chooser, questions: usage.questions, inputTokens: usage.inputTokens, waitMs: usage.waitMs, costUsd: usage.costUsd } : null,
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

// ---------------------------------------------------------------- the run

export async function runCrawl(input: RunInput, deps: CrawlDeps = {}): Promise<RunSummary> {
  const env = deps.env ?? process.env;
  const actor: CrawlActor = deps.actor ?? Actor;
  const chooser = deps.chooser ?? createChooser({ chooser: input.chooser, env });
  const navigator: NavigatorHook = deps.navigator ?? defaultNavigator;
  const healer: HealerHook = deps.healer ?? createHealer();
  const paginateHook: PaginateHook = deps.paginate ?? defaultPaginate;
  const fields = (input.fields ?? []).map((f) => f.name);
  const detailFields = input.followDetailPages ? (input.detailFields ?? []) : [];
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
  const urls = await loadListSources(input.startUrls ?? [], input.allowPrivateHosts, deps.fetchText);
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

  // R40: one persistent profile per registrable domain and profile name.
  const firstHost = hostOf(urls[0]!);
  const launch = await buildCrawleeLaunchContext({
    browser: input.browser ?? "chromium",
    headed: input.headed,
    profileDomain: firstHost ? registrableDomain(firstHost) : undefined,
    profileName: input.profile,
    storageDir: deps.storageDir,
    freshProfile: input.freshProfile,
    proxyUrl: input.proxy?.proxyUrls?.[0],
  });
  const proxyConfiguration = input.proxy?.useApifyProxy && actor.createProxyConfiguration ? await actor.createProxyConfiguration() : undefined;

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
      sessionPoolOptions: { maxPoolSize: singleSession ? 1 : 4 },
      preNavigationHooks: [async ({ page }) => guardContext(page.context())],
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
  let healChain: Promise<unknown> = Promise.resolve();
  function withHealLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = healChain.then(fn, fn);
    healChain = run.catch(() => undefined);
    return run;
  }

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

  /** R18: compiles the detail template on first use, then merges each item's detail page; every detail page is a scraped page. */
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
    try {
      for (const [i, item] of items.entries()) {
        const link = links[i] ?? null;
        let detail = link ? (samples.get(link) ?? null) : null;
        if (link && !detail && state.pages < input.maxPages && !state.stop) {
          detailPage ??= await ctx.page.context().newPage();
          if (!(await countPages(1, link))) break;
          detail = await extractDetail(detailPage, live, link, detailFieldNames);
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
    // R20 / AE13: rows beyond the charge room are never pushed; the run ends charge_limit with the rows before them.
    const itemRoom = input.maxItems - state.items;
    const chargeRoom = charger.room("result-item");
    const room = Math.max(0, Math.min(itemRoom, chargeRoom));
    let rows = fresh.slice(0, room);
    if (live.mode === "list" && live.detail && detailFieldNames.length > 0 && rows.length > 0) rows = await mergeDetails(ctx, plan, live, rows);
    for (const item of rows) {
      if (Object.keys(live.fields).some((n) => item.values[n] === null)) state.failedItems += 1;
    }
    if (rows.length > 0) {
      await dataset.pushData(
        rows.map((item) => {
          const { [DETAIL_LINK_FIELD]: _hidden, ...values } = item.values;
          return { ...values, _source: sourceUrl };
        }),
      );
    }
    state.items += rows.length;
    const charged = await charger.charge("result-item", rows.length);
    const droppedByCharge = fresh.length > rows.length && chargeRoom < itemRoom;
    if (droppedByCharge || charged.limitReached) {
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

  await crawler.run(initial);
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
