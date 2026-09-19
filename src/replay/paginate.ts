import type { Locator, Page } from "playwright";
import { waitForSettle, type SettleOptions } from "../browser/guards.js";
import { isOnAllowedDomain } from "../browser/policy.js";
import type { CompiledScraper, LocatorAlternative } from "../scraper/schema.js";
import type { PaginateHook } from "./crawler.js";

/**
 * In-page pagination (R15). A compiled next link is followed by its locator
 * alternatives; without one, replay scrolls to the bottom and treats each
 * growth of the item container as a page, up to `MAX_SCROLL_ROUNDS`. No model
 * is involved. A next link whose target reproduces the same listing (the last
 * page linking to itself) ends pagination.
 */

export const MAX_SCROLL_ROUNDS = 10;
/** How long a scroll round waits for the item container to grow. */
export const SCROLL_GROWTH_TIMEOUT_MS = 2_000;
/** How long a next-link click waits for the page to change. */
export const NEXT_LINK_TIMEOUT_MS = 10_000;

export interface PaginateOptions {
  settle?: SettleOptions | undefined;
  growthTimeoutMs?: number | undefined;
  nextLinkTimeoutMs?: number | undefined;
}

type Role = Parameters<Page["getByRole"]>[0];

/** Item count and a signature over the first rows' text, for growth and same-listing checks. */
interface ItemState {
  count: number;
  signature: string;
}

function readItems(page: Page, anchorSelector: string): Promise<ItemState> {
  return page
    .evaluate((selector) => {
      let rows: Element[] = [];
      try {
        rows = Array.from(document.querySelectorAll(selector));
      } catch {
        rows = [];
      }
      const signature = rows
        .slice(0, 50)
        .map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim())
        .join("\n");
      return { count: rows.length, signature };
    }, anchorSelector)
    .catch(() => ({ count: 0, signature: "" }));
}

/** Scrolls to the bottom and fires a scroll event too: a viewport taller than the page never scrolls, yet its loader still listens. */
async function scrollToBottom(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      window.dispatchEvent(new Event("scroll"));
    })
    .catch(() => undefined);
}

/** One scroll round: to the bottom, then wait for the container to grow. True when it grew. */
export async function scrollForMore(page: Page, anchorSelector: string, options: PaginateOptions = {}): Promise<boolean> {
  const before = await readItems(page, anchorSelector);
  const deadline = Date.now() + (options.growthTimeoutMs ?? SCROLL_GROWTH_TIMEOUT_MS);
  await scrollToBottom(page);
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const now = await readItems(page, anchorSelector);
    if (now.count > before.count) {
      await waitForSettle(page, { idleMs: 300, maxMs: 2_000, ...options.settle });
      return true;
    }
    // some feeds only load once the bottom is reached after layout
    await scrollToBottom(page);
  }
  return false;
}

async function resolveNextLink(page: Page, alternatives: readonly LocatorAlternative[]): Promise<Locator | null> {
  for (const alt of alternatives) {
    const locator = page.getByRole(alt.role as Role, { name: alt.name, exact: alt.exact }).first();
    if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) return locator;
  }
  return null;
}

/**
 * Follows the compiled next link once. False when no alternative resolves,
 * the target is off the page's domain (R25), or the listing did not change.
 */
export async function followNextLink(page: Page, scraper: CompiledScraper, options: PaginateOptions = {}): Promise<boolean> {
  const alternatives = scraper.pagination.locator ?? [];
  const anchorSelector = scraper.item?.anchorSelector ?? "";
  const locator = await resolveNextLink(page, alternatives);
  if (!locator) return false;
  const href = await locator.getAttribute("href").catch(() => null);
  const urlBefore = page.url();
  if (href) {
    let target: string;
    try {
      target = new URL(href, urlBefore).href;
    } catch {
      return false;
    }
    if (!isOnAllowedDomain(target, [urlBefore, scraper.entry.url], [])) return false;
  }
  const before = await readItems(page, anchorSelector);
  await locator.click({ timeout: options.nextLinkTimeoutMs ?? NEXT_LINK_TIMEOUT_MS }).catch(() => undefined);

  const deadline = Date.now() + (options.nextLinkTimeoutMs ?? NEXT_LINK_TIMEOUT_MS);
  let changed = false;
  while (Date.now() < deadline) {
    if (page.url() !== urlBefore) {
      changed = true;
      break;
    }
    const now = await readItems(page, anchorSelector);
    if (now.signature !== before.signature) {
      changed = true;
      break;
    }
    await page.waitForTimeout(100);
  }
  if (!changed) return false;
  await waitForSettle(page, { idleMs: 300, maxMs: 5_000, ...options.settle });
  const after = await readItems(page, anchorSelector);
  // the last page of many sites links to itself: the same non-empty listing is no new page
  if (after.signature !== "" && after.signature === before.signature) return false;
  return true;
}

/** Moves a list scraper to its next page. Record scrapers and `none` never paginate. */
export async function paginate(page: Page, scraper: CompiledScraper, pageIndex: number, options: PaginateOptions = {}): Promise<boolean> {
  if (scraper.mode !== "list" || !scraper.item) return false;
  switch (scraper.pagination.mode) {
    case "none":
      return false;
    case "scroll":
      if (pageIndex > MAX_SCROLL_ROUNDS) return false;
      return scrollForMore(page, scraper.item.anchorSelector, options);
    case "next_link":
      return followNextLink(page, scraper, options);
  }
}

export const defaultPaginate: PaginateHook = (page, scraper, pageIndex) => paginate(page, scraper, pageIndex);
