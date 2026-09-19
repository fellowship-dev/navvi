import path from "node:path";
import { chromium, type Browser, type BrowserContext, type LaunchOptions } from "playwright";
import type { BrowserName } from "../input/schema.js";

export interface LaunchSpec {
  browser: BrowserName;
  headed: boolean;
  /** Registrable domain the persistent profile is keyed by (R40). */
  profileDomain?: string;
  profileName?: string;
  storageDir?: string;
  freshProfile?: boolean;
  proxyUrl?: string;
}

export interface LaunchedBrowser {
  browser: BrowserName;
  context: BrowserContext;
  /** Present when a non-persistent browser was launched. */
  raw?: Browser;
  userAgentFamily: "firefox" | "chromium";
  close(): Promise<void>;
}

export function profileDir(spec: LaunchSpec): string | undefined {
  if (!spec.profileDomain) return undefined;
  const root = spec.storageDir ?? path.resolve("storage");
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9.-]/g, "_");
  return path.join(root, "profiles", safe(spec.profileDomain), safe(spec.profileName ?? "default"));
}

/**
 * KTD4 / R43: one launch function for both browsers. Camoufox runs with
 * fingerprints off (it has its own); Chromium relies on Crawlee's
 * fingerprint injection when driven by the crawler.
 */
export async function launch(spec: LaunchSpec): Promise<LaunchedBrowser> {
  const dir = profileDir(spec);
  if (dir && spec.freshProfile) {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  }
  const proxy = spec.proxyUrl ? { server: spec.proxyUrl } : undefined;

  if (spec.browser === "camoufox") {
    const { launchOptions } = await import("camoufox-js");
    const { firefox } = await import("playwright");
    const options = (await launchOptions({ headless: !spec.headed, proxy: spec.proxyUrl, geoip: false })) as LaunchOptions;
    if (dir) {
      const context = await firefox.launchPersistentContext(dir, options);
      return { browser: "camoufox", context, userAgentFamily: "firefox", close: () => context.close() };
    }
    const raw = await firefox.launch(options);
    const context = await raw.newContext();
    return { browser: "camoufox", context, raw, userAgentFamily: "firefox", close: () => raw.close() };
  }

  const options: LaunchOptions = { headless: !spec.headed, proxy };
  if (dir) {
    const context = await chromium.launchPersistentContext(dir, options);
    return { browser: "chromium", context, userAgentFamily: "chromium", close: () => context.close() };
  }
  const raw = await chromium.launch(options);
  const context = await raw.newContext();
  return { browser: "chromium", context, raw, userAgentFamily: "chromium", close: () => raw.close() };
}

/** Crawlee launch context pieces shared by the crawler shell (U8). */
export function crawleeLaunchOptions(browser: BrowserName, headed: boolean): { launcher: unknown; launchOptions: LaunchOptions; useFingerprints: boolean } {
  if (browser === "camoufox") {
    return { launcher: undefined, launchOptions: { headless: !headed }, useFingerprints: false };
  }
  return { launcher: chromium, launchOptions: { headless: !headed }, useFingerprints: true };
}
