import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { PlaywrightCrawlerOptions } from "crawlee";
import { chromium, type Browser, type BrowserContext, type LaunchOptions } from "playwright";
import type { BrowserName } from "../input/schema.js";

export interface LaunchSpec {
  browser: BrowserName;
  headed: boolean;
  /** Registrable domain the persistent profile is keyed by (R40). */
  profileDomain?: string | undefined;
  profileName?: string | undefined;
  storageDir?: string | undefined;
  freshProfile?: boolean | undefined;
  proxyUrl?: string | undefined;
  /** Explicit profile directory; wins over the domain and name. */
  userDataDir?: string | undefined;
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
  if (spec.userDataDir) return spec.userDataDir;
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
  const dir = await prepareProfileDir(spec);
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

/** The profile directory after `freshProfile` handling; undefined when the run has no profile. */
export async function prepareProfileDir(spec: LaunchSpec): Promise<string | undefined> {
  const dir = profileDir(spec);
  if (dir && spec.freshProfile) await rm(dir, { recursive: true, force: true });
  return dir;
}

/**
 * R40: browsers drop session cookies (no expiry) on restart, so the profile
 * keeps its own jar next to the user data directory and the crawler restores
 * it into every context it opens and saves it after every page.
 */
export const PROFILE_COOKIES_FILE = "cookies.json";

type Cookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];

export async function restoreProfileCookies(dir: string, context: BrowserContext): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, PROFILE_COOKIES_FILE), "utf8");
  } catch {
    return 0;
  }
  let cookies: Cookie[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return 0;
    cookies = parsed as Cookie[];
  } catch {
    return 0;
  }
  if (cookies.length === 0) return 0;
  await context.addCookies(cookies);
  return cookies.length;
}

export async function saveProfileCookies(dir: string, context: BrowserContext): Promise<void> {
  const cookies = await context.cookies().catch(() => null);
  if (!cookies) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, PROFILE_COOKIES_FILE), JSON.stringify(cookies), { mode: 0o600 });
}

export type CrawleeLaunchContext = NonNullable<PlaywrightCrawlerOptions["launchContext"]>;
export type CrawleeBrowserPoolOptions = NonNullable<PlaywrightCrawlerOptions["browserPoolOptions"]>;

export interface CrawleeLaunchPieces {
  launchContext: CrawleeLaunchContext;
  browserPoolOptions: CrawleeBrowserPoolOptions;
  userAgentFamily: "firefox" | "chromium";
  /** The persistent profile directory, when the run has one. */
  userDataDir: string | undefined;
}

/**
 * KTD4: the Crawlee `launchContext` and `browserPoolOptions` for the one
 * PlaywrightCrawler. Camoufox: the firefox launcher with camoufox-js launch
 * options and Crawlee fingerprints off (Camoufox ships its own). Chromium:
 * Crawlee fingerprints on. A persistent profile becomes `userDataDir`; with
 * one it, only one browser may own the directory, so the pool never opens a
 * second one.
 */
export async function buildCrawleeLaunchContext(spec: LaunchSpec): Promise<CrawleeLaunchPieces> {
  const userDataDir = await prepareProfileDir(spec);
  const pool: CrawleeBrowserPoolOptions = userDataDir
    ? { maxOpenPagesPerBrowser: 1_000, retireBrowserAfterPageCount: 1_000_000, closeInactiveBrowserAfterSecs: 3_600 }
    : {};
  if (spec.browser === "camoufox") {
    const { launchOptions } = await import("camoufox-js");
    const { firefox } = await import("playwright");
    const options = (await launchOptions({ headless: !spec.headed, proxy: spec.proxyUrl, geoip: false })) as LaunchOptions;
    const launchContext: CrawleeLaunchContext = { launcher: firefox, launchOptions: options, useIncognitoPages: false };
    if (userDataDir) launchContext.userDataDir = userDataDir;
    return { launchContext, browserPoolOptions: { ...pool, useFingerprints: false }, userAgentFamily: "firefox", userDataDir };
  }
  const launchContext: CrawleeLaunchContext = { launcher: chromium, launchOptions: { headless: !spec.headed }, useIncognitoPages: false };
  if (spec.proxyUrl) launchContext.proxyUrl = spec.proxyUrl;
  if (userDataDir) launchContext.userDataDir = userDataDir;
  return { launchContext, browserPoolOptions: { ...pool, useFingerprints: true }, userAgentFamily: "chromium", userDataDir };
}
