import { createHash } from "node:crypto";
import type { Page, Route } from "playwright";
import { ensureSnapshotScript } from "./snapshot.js";

/**
 * Page guards (U4): a freshness token so a step acts on the page it was chosen
 * for, a settle wait for pages that hydrate after load, and the refusal that
 * keeps a reused browser cache from answering a request navvi needs to see.
 */

// --------------------------------------------------------- revalidation

/**
 * The headers with which a browser asks "has this changed since I last saw
 * it?". A request carrying one of them can be answered `304 Not Modified`,
 * which is a header block and no body at all.
 */
export const REVALIDATION_HEADERS = ["if-none-match", "if-modified-since"] as const;

/**
 * Continue one routed request with its conditional headers removed, so the
 * answer is a body rather than a `304`.
 *
 * This is the price of a reused context. Measured on store-b.example, 2026-09-23,
 * twelve visits to three product URLs through one Camoufox context:
 *
 * ```
 * visit  1 884669.html  json=56  detail=200  values={"productName":"Acido…","listPrice":"4690"}
 * visit  4 884669.html  json=7   detail=304  values={"productName":null,"listPrice":null}
 * ```
 *
 * The first visit bound three fields; every later visit to the same URL sent
 * back the ETag it had been given, was answered `304`, and bound nothing —
 * while the page rendered perfectly, off the copy in the browser's cache that
 * navvi cannot see.
 *
 * It cannot be paid at the capture instead. A 304 carries no `content-type`,
 * so `captureJson`'s JSON filter drops it, and reading it anyway is not on
 * offer: Playwright counts 304 among the redirect statuses and answers
 * `response.json()` with *"Response body is unavailable for redirect
 * responses"* on both engines. So the request has to be one the cache cannot
 * satisfy.
 *
 * Half the work is done by routing the request at all, and that half is worth
 * naming because it is not what the code appears to say: a request Playwright
 * is routing is a request the browser's HTTP cache does not get to answer, so
 * a payload sent `Cache-Control: max-age=600` crosses the network on every
 * visit instead of being reused unasked. Stripping the validators is the other
 * half, for the endpoints that do ask.
 *
 * **It lives here, in `browser/`, because both drivers need it and only one
 * had it.** `make/pages.ts` installed it per page on 2026-09-23 (89e9633);
 * `replay/crawler.ts` routed every request for the URL policy and continued it
 * untouched, so the crawler had the cache-bypass half and not the
 * validator-stripping half — and every `network`-source field read null on the
 * second visit to a URL under the default browser. Chromium hid it: Playwright
 * reports a revalidated resource to the `response` event as the 200 the
 * browser assembled, body and `content-type` included, while Firefox — which
 * Camoufox is built on — reports the raw 304. That is how the same defect read
 * as a fingerprinting story twice.
 *
 * The surgery is the smallest that works. A request with no conditional header
 * is continued untouched rather than re-sent with a header list navvi rebuilt:
 * `route.continue({ headers })` replaces the whole block, and a rebuilt block
 * is a different client to anything that fingerprints header order. On a Store
 * B product page that is every request but one.
 *
 * What it costs was measured rather than argued, and it does not show: two
 * passes over two store-b.example product pages, twice each, returned the same
 * page to the character in 25.9 s, 9.0 s, 9.9 s and 9.4 s with it against
 * 25.2 s, 9.2 s, 9.8 s and 9.6 s without. A visit like that waits on its
 * settle, not on its bytes.
 */
export async function continueWithoutRevalidation(route: Route): Promise<void> {
  try {
    const headers = await route.request().allHeaders();
    const conditional = REVALIDATION_HEADERS.filter((name) => name in headers);
    if (conditional.length === 0) return await route.continue();
    for (const name of conditional) delete headers[name];
    return await route.continue({ headers });
  } catch {
    // The page navigated away or closed mid-interception. The request went
    // with it; letting it through unmodified is the only thing left to try,
    // and failing at that is not a fact about the site.
    await route.continue().catch(() => undefined);
  }
}

/**
 * `continueWithoutRevalidation` over every request of one page, for a caller
 * that has no route handler of its own. A caller that already routes `**\/*`
 * — the crawler, which routes for the URL policy — calls
 * `continueWithoutRevalidation` from inside that handler instead: Playwright
 * hands a request to one handler, so a second registration would not be a
 * second chance.
 */
export async function refuseRevalidation(page: Page): Promise<void> {
  await page.route("**/*", continueWithoutRevalidation);
}

/** Document URL plus a hash of the visible text and the safe form values. */
export async function freshnessToken(page: Page): Promise<string> {
  await ensureSnapshotScript(page);
  const state = await page.evaluate(() => window.__navvi!.freshness());
  const digest = createHash("sha256").update(state.text).update("\x00").update(JSON.stringify(state.values)).digest("hex").slice(0, 16);
  return `${state.url}#${digest}`;
}

export async function isStale(page: Page, token: string): Promise<boolean> {
  return (await freshnessToken(page)) !== token;
}

export interface SettleOptions {
  /** Quiet period with no DOM mutations before the page counts as settled. */
  idleMs?: number | undefined;
  /** Upper bound; returns false when the DOM never went quiet for idleMs. */
  maxMs?: number | undefined;
}

declare global {
  interface Window {
    __navviMutations?: { last: number; count: number };
  }
}

/**
 * Runs in the page: installs the mutation observer on first call (and again
 * after a navigation replaced the document) and reports whether the DOM has
 * been quiet for `idleMs`.
 */
function quietFor(idleMs: number): boolean {
  let state = window.__navviMutations;
  if (!state) {
    state = { last: performance.now(), count: 0 };
    window.__navviMutations = state;
    const observer = new MutationObserver((records) => {
      state!.count += records.length;
      state!.last = performance.now();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  }
  return performance.now() - state.last >= idleMs;
}

/**
 * Waits until the DOM has had no mutations for `idleMs` (default 500) or
 * `maxMs` (default 5000) elapsed. Resolves true when quiet, false on timeout.
 * One in-page poll (`waitForFunction`) instead of a round trip per tick; a
 * navigation destroys the context, in which case the poll restarts in the new
 * document within the remaining budget.
 */
export async function waitForSettle(page: Page, opts: SettleOptions = {}): Promise<boolean> {
  const idleMs = opts.idleMs ?? 500;
  const maxMs = opts.maxMs ?? 5_000;
  const started = Date.now();
  const polling = Math.min(100, idleMs);
  await page.waitForLoadState("domcontentloaded");
  for (;;) {
    const remaining = maxMs - (Date.now() - started);
    if (remaining <= 0) return false;
    try {
      await page.waitForFunction(quietFor, idleMs, { timeout: remaining, polling });
      return true;
    } catch (error) {
      if (isTimeout(error)) return false;
      // Navigation replaced the document (context destroyed) or the page closed.
      if (page.isClosed()) return false;
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || /Timeout \d+ms exceeded/.test(error.message));
}
