import { describe, expect, it } from "vitest";
import { buildCrawleeLaunchContext } from "../src/browser/launch.js";

/**
 * Regression for the 2026-09-21 client shadow runs, where two Apify runs ended
 * with `Failed to launch browser ... /pw-browsers/chrome` *after* the crawler
 * had finished cleanly ("Total 50 requests: 50 succeeded, 0 failed").
 *
 * The cause was here: the generous browser-pool options were applied only when
 * the run had a persistent profile. A `store` run -- which is every unattended
 * run, including every client price scrape -- fell through to Crawlee's defaults,
 * whose `retireBrowserAfterPageCount` is 100. `record` mode opens an extra
 * sample page per request, so ~50 requests reaches ~100 pages, the pool retires
 * the browser and launches a replacement, and that relaunch fails on the Apify
 * Chrome image.
 *
 * A run has no reason to churn browsers whether or not it keeps a profile, so
 * the options no longer depend on it.
 */
describe("browser pool options", () => {
  const generous = (pool: Record<string, unknown>) => {
    expect(pool.retireBrowserAfterPageCount).toBeGreaterThanOrEqual(100_000);
    expect(pool.maxOpenPagesPerBrowser).toBeGreaterThanOrEqual(1_000);
    expect(pool.closeInactiveBrowserAfterSecs).toBeGreaterThanOrEqual(3_600);
  };

  it("never lets the pool retire a browser mid-run, with or without a profile", async () => {
    const withProfile = await buildCrawleeLaunchContext({
      browser: "chromium",
      headed: false,
      profileDomain: "example.com",
      storageDir: "/tmp/navvi-pool-test",
    });
    generous(withProfile.browserPoolOptions as Record<string, unknown>);

    // The store profile: no userDataDir. This is the case that was falling
    // through to Crawlee's defaults and killing long unattended runs.
    const storeProfile = await buildCrawleeLaunchContext({ browser: "chromium", headed: false });
    generous(storeProfile.browserPoolOptions as Record<string, unknown>);
  });

  it("applies the same bound under camoufox", async () => {
    const storeProfile = await buildCrawleeLaunchContext({ browser: "camoufox", headed: false });
    generous(storeProfile.browserPoolOptions as Record<string, unknown>);
    expect(storeProfile.browserPoolOptions.useFingerprints).toBe(false);
  });

  it("keeps the fingerprint choice each browser needs", async () => {
    const chromium = await buildCrawleeLaunchContext({ browser: "chromium", headed: false });
    expect(chromium.browserPoolOptions.useFingerprints).toBe(true);
    expect(chromium.userDataDir).toBeUndefined();
  });
});
