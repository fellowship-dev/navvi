import { describe, expect, it } from "vitest";
import {
  causeChain,
  createLaunchCounter,
  DEFAULT_RETIRE_AFTER_PAGE_COUNT,
  DEFAULT_SESSION_MAX_USAGE_COUNT,
  formatLaunchFailure,
  isForcedRepro,
  isLaunchFailure,
  launchFailureReport,
  resolveRelaunchKnobs,
  RETIRE_AFTER_PAGE_COUNT_ENV,
  SESSION_MAX_ERROR_SCORE_ENV,
  SESSION_MAX_USAGE_COUNT_ENV,
} from "../src/browser/relaunch.js";
import { buildSessionPoolOptions } from "../src/replay/crawler.js";
import { buildCrawleeLaunchContext } from "../src/browser/launch.js";

/**
 * U16. Three builds guessed at which mechanism retires a browser; every one of
 * them ended at the same unexplained relaunch failure. This is the
 * instrumentation that replaces the fourth guess: the cause chain the Apify
 * run log truncates, the paths a launch actually resolved, and knobs that make
 * the failure reproducible in a minute.
 *
 * The load-bearing property of these knobs is that they change nothing by
 * default -- a diagnostics build that also alters production behaviour cannot
 * be trusted to have measured production.
 */
describe("relaunch knobs", () => {
  it("defaults to one browser and one session for the whole run", () => {
    const knobs = resolveRelaunchKnobs({});
    expect(knobs.retireBrowserAfterPageCount).toBe(DEFAULT_RETIRE_AFTER_PAGE_COUNT);
    expect(knobs.sessionMaxUsageCount).toBe(DEFAULT_SESSION_MAX_USAGE_COUNT);
    // Crawlee's default (3) is deliberately left in place: this build is meant
    // to reproduce the error-score path, not to paper over it.
    expect(knobs.sessionMaxErrorScore).toBeUndefined();
    expect(isForcedRepro(knobs)).toBe(false);
  });

  it("takes the repro thresholds from the environment", () => {
    const knobs = resolveRelaunchKnobs({
      [RETIRE_AFTER_PAGE_COUNT_ENV]: "5",
      [SESSION_MAX_USAGE_COUNT_ENV]: "5",
      [SESSION_MAX_ERROR_SCORE_ENV]: "1",
    });
    expect(knobs).toMatchObject({ retireBrowserAfterPageCount: 5, sessionMaxUsageCount: 5, sessionMaxErrorScore: 1 });
    expect(isForcedRepro(knobs)).toBe(true);
  });

  it("ignores a malformed value rather than crawling with a broken threshold", () => {
    for (const bad of ["", "0", "-3", "abc", "2.5"]) {
      const knobs = resolveRelaunchKnobs({ [SESSION_MAX_USAGE_COUNT_ENV]: bad });
      expect(knobs.sessionMaxUsageCount).toBe(DEFAULT_SESSION_MAX_USAGE_COUNT);
    }
  });

  it("reaches the session pool and the browser pool", async () => {
    const knobs = resolveRelaunchKnobs({ [SESSION_MAX_USAGE_COUNT_ENV]: "5", [SESSION_MAX_ERROR_SCORE_ENV]: "1", [RETIRE_AFTER_PAGE_COUNT_ENV]: "7" });
    const session = buildSessionPoolOptions(false, knobs);
    expect(session.sessionOptions.maxUsageCount).toBe(5);
    expect(session.sessionOptions.maxErrorScore).toBe(1);

    const pieces = await buildCrawleeLaunchContext({ browser: "chromium", headed: false }, { knobs });
    expect(pieces.browserPoolOptions.retireBrowserAfterPageCount).toBe(7);
  });

  it("leaves maxErrorScore unset when no repro asked for it", () => {
    const session = buildSessionPoolOptions(false, resolveRelaunchKnobs({}));
    expect(session.sessionOptions.maxErrorScore).toBeUndefined();
  });
});

describe("launch failure evidence", () => {
  const crawleeLaunchError = () => {
    const cause = new Error("spawn /pw-browsers/chrome ENOENT");
    return new Error(
      'Failed to launch browser. Please check the following:\n- Check whether the provided executable path "/pw-browsers/chrome" is correct.\nThe original error is available in the `cause` property.',
      { cause },
    );
  };

  it("recognises the Crawlee launch failure and unwraps its cause", () => {
    const error = crawleeLaunchError();
    expect(isLaunchFailure(error)).toBe(true);
    const chain = causeChain(error);
    expect(chain).toHaveLength(2);
    expect(chain[1]).toContain("ENOENT");
  });

  it("does not claim an unrelated failure is a launch failure", () => {
    expect(isLaunchFailure(new Error("charge limit reached"))).toBe(false);
  });

  it("survives a cause cycle and a non-Error cause", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(causeChain(a)).toHaveLength(2);
    expect(causeChain(new Error("wrapped", { cause: "a string reason" }))).toEqual(["Error: wrapped", "a string reason"]);
  });

  it("reports how many launches the run had reached, which separates the hypotheses", () => {
    const report = launchFailureReport(crawleeLaunchError(), 2, resolveRelaunchKnobs({}), {});
    // A wrong path fails at launch 1; a relaunch problem fails at 2 or later.
    expect(report.launches).toBe(2);
    expect(report.kind).toBe("browser-launch-failure");
    expect(report.causes[1]).toContain("ENOENT");

    const text = formatLaunchFailure(report);
    expect(text).toContain("after 2 launch(es)");
    expect(text).toContain("cause[1]");
    expect(text).toContain("playwright executablePath:");
  });

  it("records the browser paths the environment names", () => {
    const report = launchFailureReport(crawleeLaunchError(), 1, resolveRelaunchKnobs({}), {
      APIFY_DEFAULT_BROWSER_PATH: "/pw-browsers/chrome",
      PLAYWRIGHT_BROWSERS_PATH: "/pw-browsers",
    });
    expect(report.browser.apifyBrowserPath).toBe("/pw-browsers/chrome");
    expect(report.browser.env.PLAYWRIGHT_BROWSERS_PATH).toBe("/pw-browsers");
    // It exists on the Apify image and not on a laptop; either way the fact is recorded, not assumed.
    expect(typeof report.browser.apifyBrowserPathExists).toBe("boolean");
  });

  it("counts every launch, so the second one is identifiable as a relaunch", () => {
    const lines: string[] = [];
    const counter = createLaunchCounter((m) => lines.push(m), {});
    counter.onPreLaunch("p1", { launchOptions: { executablePath: "/pw-browsers/chrome" } });
    counter.onPostLaunch("p1", {});
    counter.onPreLaunch("p2", { launchOptions: {} });
    counter.onPostLaunch("p2", {});
    expect(counter.launches).toBe(2);
    expect(lines[0]).toContain("browser launch #1");
    expect(lines[0]).toContain("/pw-browsers/chrome");
    expect(lines[1]).toContain("browser launch #2");
    // A healthy first launch is not the question, so it is not logged; a
    // relaunch that works is a finding in its own right.
    expect(lines.filter((l) => l.includes("succeeded"))).toEqual(["browser relaunch #2 succeeded"]);
  });
});

/**
 * U16, the actual cause. Build 3.0.11's forced repro (Apify run
 * beygdybuH6khLp2fx, 5 requests in 62 s with sessionMaxUsageCount: 5) put the
 * reason in the LAUNCH_FAILURE record:
 *
 *   browserType.launchPersistentContext: Failed to create a ProcessSingleton
 *   for your profile directory. This usually means that the profile is already
 *   in use by another instance of Chromium.
 *
 * Not a wrong executable path, not memory, not Crawlee resolving the binary
 * differently on the second launch. Chromium locks a user data directory, the
 * pool launches the replacement before the retiring browser has released the
 * lock, and Crawlee reports the loser as "Failed to launch browser".
 *
 * A `store` run -- every unattended run, every client price scrape -- was taking a
 * persistent profile it has no use for: the store profile does no logins, holds
 * no secrets, and on the platform its storage does not outlive the run. So it
 * gets none, and there is no directory left to contend for.
 */
describe("the store profile takes no persistent directory", () => {
  it("gives a store run no userDataDir, so a relaunch has no lock to lose", async () => {
    const pieces = await buildCrawleeLaunchContext({ browser: "chromium", headed: false, profileDomain: undefined });
    expect(pieces.userDataDir).toBeUndefined();
    expect(pieces.launchContext.userDataDir).toBeUndefined();
  });

  it("still gives a local run its profile, which is what R40 is for", async () => {
    const pieces = await buildCrawleeLaunchContext({
      browser: "chromium",
      headed: false,
      profileDomain: "example.com",
      profileName: "local",
      storageDir: "/tmp/navvi-profile-test",
    });
    expect(pieces.userDataDir).toContain("example.com");
  });
});
