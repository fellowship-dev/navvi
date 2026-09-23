import type { BrowserContext, Page } from "playwright";
import { captureJson } from "../browser/network-capture.js";
import { launch, type LaunchedBrowser } from "../browser/launch.js";
import { visibleText } from "../heuristics/rules/investigate.js";
import { dismissConsent } from "../prestep/consent.js";
import { extractPage, fieldTypesOf, type PageExtraction } from "../scraper/extract.js";
import type { CompiledScraper } from "../scraper/schema.js";
import { readingOf, type PageReading } from "../replay/determinism.js";
import type { BrowserName } from "../input/schema.js";
import type { Capture, Obstacle, PageResponse } from "../investigate/index.js";

/**
 * U11: the only part of the driver that opens anything.
 *
 * Everything else in `src/make/` is pure or file IO, which is deliberate:
 * `tests/make.test.ts` drives the whole pipeline with a synthetic `Pages`
 * implementation and never launches a browser. This file is the seam that
 * makes that possible, and it is also the file that cannot be unit-tested,
 * which is why it contains decisions and no logic.
 *
 * ## It is a transcription of `scripts/live-investigate.ts`, on purpose
 *
 * That script is the only thing in this repository that has ever driven the
 * cascade against real pages, and every line of its capture sequence was
 * bought by a failure:
 *
 *  - **`captureJson` rather than a hand-rolled `page.on("response")`.** The
 *    first version of the script pushed from inside an async handler and closed
 *    the page without draining it, so `products/detail` — the endpoint Cruz
 *    Verde's entire answer lives in — was still being parsed when the run moved
 *    on. The manuscript reported ten endpoints and none of them was the right
 *    one. `captureJson` has the drain (`settled()`); a second capture written
 *    here would be the same race a third time.
 *  - **`match: /./`.** `captureJson` was built for replay, where the endpoint
 *    is known. Discovery does not know it, and keeping everything is the whole
 *    point of tier 2.
 *  - **The consent click before the second settle.** On Store B it is the
 *    click that releases the product calls at all.
 *  - **Waiting for the render to stop growing rather than for a fixed three
 *    seconds.** Across nine runs of the fixed wait the verdict tracked exactly
 *    one thing: whether the page had finished rendering. 11,107 characters
 *    bound three fields, ~3,200 bound none — same tree, same endpoints — because
 *    tier 2 anchors candidate values against the rendered text and there was no
 *    text to anchor against. A gate that reports failure when the harness was
 *    impatient teaches you to ignore the gate.
 *
 * The one thing it does *not* copy is the consent selector. The script clicks
 * `Aceptar|Acepto|Entendido` by hand; this uses `prestep`'s `dismissConsent`,
 * which owns the consent rule table for the whole repository and hands back
 * every control it clicked — which is what turns a dismissed banner into an
 * `Obstacle` the manuscript and then `reconcile.md` can cost.
 */

/** Chrome on macOS. The pharmacies serve a different page to an unrecognised agent. */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const LOCALE = "es-CL";

/** How long the render is given to stop growing before the run reads it anyway. */
export const SETTLE_CAP_MS = 25_000;
/** How many payloads one page may contribute. Tier 2 narrows them; it does not need all of them. */
export const CAPTURE_LIMIT = 200;

/**
 * What the driver needs a page for. Three verbs, one per stage that reads the
 * web: `fetch` for the sample probes and tier 1, `capture` for tier 2, and
 * `read` for the determinism replays and the verify replay.
 *
 * An interface rather than a class so the tests can answer all three from
 * fixtures, and so `--offline` can refuse to build one at all rather than
 * building one that quietly answers nothing.
 */
export interface Pages {
  fetch(url: string): Promise<PageResponse>;
  capture(url: string): Promise<Capture>;
  /** One reading of one URL through a compiled scraper, exactly as a replay would take it. */
  read(scraper: CompiledScraper, url: string): Promise<PageReading>;
  /** The full extraction, for the verify stage's fill rate. */
  extract(scraper: CompiledScraper, url: string): Promise<PageExtraction>;
  close(): Promise<void>;
}

export interface PagesOptions {
  browser: BrowserName;
  headed: boolean;
  storageDir: string;
  /** Injectable so a test can answer a plain fetch without a network. */
  fetchImpl?: typeof fetch | undefined;
  settleCapMs?: number | undefined;
}

/**
 * One plain HTTP request, read into the shape `probeFrom` and tier 1 consume.
 *
 * A probe that never answered comes back `status: 0` rather than throwing.
 * `classify` reads 0 as transient and excludes the URL from the sample, which
 * is the right answer: one silent fetch is not evidence the catalogue lost the
 * URL, and letting the exception out would end an investigation because one of
 * 108 URLs timed out.
 */
export async function plainFetch(url: string, fetchImpl: typeof fetch = fetch): Promise<PageResponse> {
  try {
    const res = await fetchImpl(url, { headers: { "user-agent": UA, "accept-language": `${LOCALE},es;q=0.9` }, redirect: "follow" });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
    return { url: res.url, status: res.status, headers, body: await res.text() };
  } catch {
    return { url, status: 0, body: "" };
  }
}

/** Waits until the rendered text stops growing, or the cap. See the header for the nine runs behind this. */
async function settleRender(page: Page, cap: number): Promise<number> {
  const started = Date.now();
  let previous = -1;
  for (;;) {
    const current = visibleText(await page.content().catch(() => "")).length;
    if (current > 0 && current === previous) return current;
    if (Date.now() - started > cap) return current;
    previous = current;
    await page.waitForTimeout(750);
  }
}

/**
 * Opens a browser and returns the three verbs over it.
 *
 * The context is reused across every URL, which is what makes a consent click
 * on the first page save the click on the rest — and, for the determinism
 * stage, what makes round two of three a real re-navigation of a site that
 * already knows this session rather than a cold first visit.
 */
export async function openPages(options: PagesOptions): Promise<Pages> {
  const settleCap = options.settleCapMs ?? SETTLE_CAP_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let browser: LaunchedBrowser | null = null;

  const context = async (): Promise<BrowserContext> => {
    browser ??= await launch({ browser: options.browser, headed: options.headed, storageDir: options.storageDir });
    return browser.context;
  };

  /** Navigate, dismiss consent, let the render settle, hand back the page and what it fetched. */
  const visit = async <T>(url: string, use: (page: Page, captured: ReturnType<typeof captureJson>, obstacles: Obstacle[]) => Promise<T>): Promise<T> => {
    const page = await (await context()).newPage();
    const obstacles: Obstacle[] = [];
    try {
      const captured = captureJson(page, { match: /./, limit: CAPTURE_LIMIT });
      await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => undefined);
      const consent = await dismissConsent(page);
      for (const click of consent.clicked) {
        obstacles.push({
          kind: "consent",
          url,
          because: `a consent dialog stood between the navigation and the page; navvi clicked ${click.role} "${click.name}"`,
          evidence: click.name,
          blocking: false,
        });
      }
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
      await settleRender(page, settleCap);
      await captured.settled();
      return await use(page, captured, obstacles);
    } finally {
      await page.close().catch(() => undefined);
    }
  };

  return {
    fetch: (url) => plainFetch(url, fetchImpl),

    capture: (url) =>
      visit(url, async (page, captured, obstacles) => {
        const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        const html = await page.content().catch(() => "");
        return { responses: captured.responses, text, html, obstacles };
      }),

    read: async (scraper, url) => readingOf(await readPage(scraper, url), fieldTypesOf(scraper)),

    extract: (scraper, url) => readPage(scraper, url),

    async close() {
      await browser?.close().catch(() => undefined);
      browser = null;
    },
  };

  /**
   * One reading, through the compiled scraper and with the payloads the page
   * fetched for itself.
   *
   * `captured` is not optional decoration: every `network` alternative
   * `compileFromReconciliation` emits resolves against it, so a read taken
   * without it would report every payload-bound field as absent and the
   * determinism stage would call that `absent` rather than `moved` — a clean
   * artifact about a scraper nobody actually ran.
   *
   * A read that throws is not caught. `DeterminismDriver` says so in as many
   * words: a URL that could not be read N times has not been measured, and a
   * stage that swallows load failures reports `stable` about pages it never
   * saw.
   */
  async function readPage(scraper: CompiledScraper, url: string): Promise<PageExtraction> {
    return visit(url, (page, captured) => extractPage(page, scraper, { sourceUrl: url, captured: captured.responses }));
  }
}
