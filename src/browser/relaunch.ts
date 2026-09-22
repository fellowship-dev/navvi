import { existsSync } from "node:fs";
import { chromium } from "playwright";

/**
 * U16: instrumentation for the Apify browser-relaunch failure.
 *
 * Three builds tried to stop browsers being retired -- the browser pool's page
 * count (3.0.9), the session pool's usage count (3.0.10) -- and every one of
 * them ended at the same wall:
 *
 *   Failed to launch browser. Please check the following:
 *   - Check whether the provided executable path "/pw-browsers/chrome" is correct.
 *   ... The original error is available in the `cause` property.
 *
 * Enumerating the paths that retire a browser is unbounded; the relaunch is one
 * question. So this module does not guess again. It does two things:
 *
 * 1. Captures the evidence the run log truncates -- the `cause` chain, the
 *    executable path Playwright actually resolves, and the browser-related
 *    environment -- so the next failure explains itself.
 * 2. Makes the retirement thresholds settable per run, so the failure can be
 *    forced in a minute over ~20 URLs instead of waited out for fifteen. Every
 *    knob defaults to today's shipped behaviour: this build changes nothing
 *    about how a normal run behaves.
 */

/** Browser retirement thresholds, overridable per run for a forced repro. */
export interface RelaunchKnobs {
  /** Pages one browser serves before the pool retires it. */
  retireBrowserAfterPageCount: number;
  /** Requests one session serves before it retires -- and retires the browser with it. */
  sessionMaxUsageCount: number;
  /** Error score at which `markBad()` retires a session. `undefined` leaves Crawlee's default (3). */
  sessionMaxErrorScore: number | undefined;
}

/** One browser for the whole run, which is what ships today. */
export const DEFAULT_RETIRE_AFTER_PAGE_COUNT = 1_000_000;
export const DEFAULT_SESSION_MAX_USAGE_COUNT = 1_000_000;

export const RETIRE_AFTER_PAGE_COUNT_ENV = "NAVVI_RETIRE_BROWSER_AFTER_PAGES";
export const SESSION_MAX_USAGE_COUNT_ENV = "NAVVI_SESSION_MAX_USAGE_COUNT";
export const SESSION_MAX_ERROR_SCORE_ENV = "NAVVI_SESSION_MAX_ERROR_SCORE";

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

/**
 * The knobs for this run. An unset or unparseable value keeps the default, so
 * a typo in a task input degrades to normal behaviour rather than to a crawl
 * that retires its browser every request.
 */
export function resolveRelaunchKnobs(env: NodeJS.ProcessEnv = process.env): RelaunchKnobs {
  return {
    retireBrowserAfterPageCount: positiveInt(env[RETIRE_AFTER_PAGE_COUNT_ENV]) ?? DEFAULT_RETIRE_AFTER_PAGE_COUNT,
    sessionMaxUsageCount: positiveInt(env[SESSION_MAX_USAGE_COUNT_ENV]) ?? DEFAULT_SESSION_MAX_USAGE_COUNT,
    sessionMaxErrorScore: positiveInt(env[SESSION_MAX_ERROR_SCORE_ENV]),
  };
}

/** True when any knob was moved off its default, i.e. this is a deliberate repro run. */
export function isForcedRepro(knobs: RelaunchKnobs): boolean {
  return (
    knobs.retireBrowserAfterPageCount !== DEFAULT_RETIRE_AFTER_PAGE_COUNT ||
    knobs.sessionMaxUsageCount !== DEFAULT_SESSION_MAX_USAGE_COUNT ||
    knobs.sessionMaxErrorScore !== undefined
  );
}

/**
 * The environment variables that decide which binary a launch resolves to on
 * the Apify images. Values are paths and flags, never credentials.
 */
export const BROWSER_ENV_KEYS = [
  "APIFY_DEFAULT_BROWSER_PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
  "CRAWLEE_HEADLESS",
  "APIFY_HEADLESS",
  "APIFY_XVFB",
  "NAVVI_BROWSER",
  "APIFY_MEMORY_MBYTES",
  "CRAWLEE_AVAILABLE_MEMORY_RATIO",
] as const;

export interface BrowserFacts {
  /** What `chromium.executablePath()` resolves to in this process, and whether it is there. */
  playwrightExecutablePath: string | null;
  playwrightExecutableExists: boolean | null;
  /** The path the error message quotes, when the environment names one. */
  apifyBrowserPath: string | null;
  apifyBrowserPathExists: boolean | null;
  env: Record<string, string>;
}

/**
 * What this process believes about its browser binary, right now. Collected at
 * failure time rather than at start: the open question is whether the
 * *replacement* launch resolves differently from the first one.
 */
export function describeBrowserFacts(env: NodeJS.ProcessEnv = process.env): BrowserFacts {
  let resolved: string | null = null;
  try {
    resolved = chromium.executablePath();
  } catch {
    resolved = null;
  }
  const apifyPath = env.APIFY_DEFAULT_BROWSER_PATH ?? null;
  const present: Record<string, string> = {};
  for (const key of BROWSER_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) present[key] = value;
  }
  return {
    playwrightExecutablePath: resolved,
    playwrightExecutableExists: resolved === null ? null : existsSync(resolved),
    apifyBrowserPath: apifyPath,
    apifyBrowserPathExists: apifyPath === null ? null : existsSync(apifyPath),
    env: present,
  };
}

/**
 * Every message in an error's `cause` chain, outermost first. Crawlee's launch
 * error says "The original error is available in the `cause` property" and the
 * Apify run log then truncates exactly that -- which is why three sessions
 * guessed at the trigger instead of reading the reason.
 */
export function causeChain(error: unknown, maxDepth = 8): string[] {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < maxDepth && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      chain.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      chain.push(String(current));
      break;
    }
  }
  return chain;
}

/** The launch failure Crawlee reports when a browser cannot start. */
export function isLaunchFailure(error: unknown): boolean {
  return causeChain(error).some((line) => /failed to launch browser/i.test(line));
}

export interface LaunchFailureReport {
  kind: "browser-launch-failure";
  message: string;
  causes: string[];
  stack: string | null;
  browser: BrowserFacts;
  launches: number;
  knobs: RelaunchKnobs;
}

/**
 * The record a failed run leaves behind. Written to the key-value store so the
 * cause survives the run log's truncation and can be read over the API.
 */
export function launchFailureReport(error: unknown, launches: number, knobs: RelaunchKnobs, env: NodeJS.ProcessEnv = process.env): LaunchFailureReport {
  const causes = causeChain(error);
  return {
    kind: "browser-launch-failure",
    message: causes[0] ?? String(error),
    causes,
    stack: error instanceof Error ? (error.stack ?? null) : null,
    browser: describeBrowserFacts(env),
    launches,
    knobs,
  };
}

/** The same report as one log line per fact, for the run log. */
export function formatLaunchFailure(report: LaunchFailureReport): string {
  const facts = report.browser;
  const lines = [
    `browser launch failed after ${report.launches} launch(es) in this run`,
    ...report.causes.map((cause, i) => `  cause[${i}]: ${cause}`),
    `  playwright executablePath: ${facts.playwrightExecutablePath ?? "(unresolved)"} exists=${facts.playwrightExecutableExists ?? "unknown"}`,
    `  APIFY_DEFAULT_BROWSER_PATH: ${facts.apifyBrowserPath ?? "(unset)"} exists=${facts.apifyBrowserPathExists ?? "unknown"}`,
    ...Object.entries(facts.env).map(([key, value]) => `  env ${key}=${value}`),
    `  knobs: retireAfterPages=${report.knobs.retireBrowserAfterPageCount} sessionMaxUsage=${report.knobs.sessionMaxUsageCount} sessionMaxErrorScore=${report.knobs.sessionMaxErrorScore ?? "default(3)"}`,
  ];
  return lines.join("\n");
}

/**
 * Counts launches so a failure can say whether it was the first one -- a wrong
 * path fails at launch 1, a relaunch problem fails at launch 2 or later. This
 * is the single fact that separates the remaining hypotheses.
 */
export interface LaunchCounter {
  readonly launches: number;
  /** Crawlee `preLaunchHooks` entry. */
  onPreLaunch(pageId: string, launchContext: unknown): void;
  /** Crawlee `postLaunchHooks` entry. */
  onPostLaunch(pageId: string, controller: unknown): void;
}

export function createLaunchCounter(log: (message: string) => void, env: NodeJS.ProcessEnv = process.env): LaunchCounter {
  let launches = 0;
  return {
    get launches() {
      return launches;
    },
    onPreLaunch(_pageId: string, launchContext: unknown) {
      launches += 1;
      const options = (launchContext as { launchOptions?: { executablePath?: string } } | undefined)?.launchOptions;
      const facts = describeBrowserFacts(env);
      log(
        `browser launch #${launches}: launchOptions.executablePath=${options?.executablePath ?? "(unset)"} ` +
          `resolved=${facts.playwrightExecutablePath ?? "(unresolved)"} exists=${facts.playwrightExecutableExists ?? "unknown"}`,
      );
    },
    onPostLaunch(_pageId: string, _controller: unknown) {
      // Only relaunches are logged on success. The first launch working is not
      // in question -- every failed run scraped dozens of pages first -- and a
      // line per launch would drown the run log of a healthy catalogue crawl.
      if (launches > 1) log(`browser relaunch #${launches} succeeded`);
    },
  };
}
