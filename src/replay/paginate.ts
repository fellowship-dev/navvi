import type { Page } from "playwright";
import { waitForSettle } from "../browser/guards.js";
import { isOnAllowedDomain } from "../browser/policy.js";
import { resolveUrl } from "../scraper/extract.js";
import type { CompiledScraper } from "../scraper/schema.js";
import type { PaginateHook } from "./crawler.js";
import { resolveLocator, scrollToBottom } from "./entry.js";

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

/** One scroll round: to the bottom, then wait for the container to grow. True when it grew. */
export async function scrollForMore(page: Page, anchorSelector: string): Promise<boolean> {
  const before = await readItems(page, anchorSelector);
  const deadline = Date.now() + SCROLL_GROWTH_TIMEOUT_MS;
  await scrollToBottom(page);
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const now = await readItems(page, anchorSelector);
    if (now.count > before.count) {
      await waitForSettle(page, { idleMs: 300, maxMs: 2_000 });
      return true;
    }
    // some feeds only load once the bottom is reached after layout
    await scrollToBottom(page);
  }
  return false;
}

/**
 * Follows the compiled next link once. False when no alternative resolves,
 * the target is off the page's domain (R25), or the listing did not change.
 */
export async function followNextLink(page: Page, scraper: CompiledScraper): Promise<boolean> {
  const alternatives = scraper.pagination.locator ?? [];
  const anchorSelector = scraper.item?.anchorSelector ?? "";
  const locator = await resolveLocator(page, alternatives, 0);
  if (!locator) return false;
  const href = await locator.getAttribute("href").catch(() => null);
  const urlBefore = page.url();
  if (href) {
    const target = resolveUrl(href, urlBefore);
    if (!target || !isOnAllowedDomain(target, [urlBefore, scraper.entry.url], [])) return false;
  }
  const before = await readItems(page, anchorSelector);
  await locator.click({ timeout: NEXT_LINK_TIMEOUT_MS }).catch(() => undefined);

  const deadline = Date.now() + NEXT_LINK_TIMEOUT_MS;
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
  await waitForSettle(page, { idleMs: 300, maxMs: 5_000 });
  const after = await readItems(page, anchorSelector);
  // the last page of many sites links to itself: the same non-empty listing is no new page
  if (after.signature !== "" && after.signature === before.signature) return false;
  return true;
}

/** Moves a list scraper to its next page. Record scrapers and `none` never paginate. */
export async function paginate(page: Page, scraper: CompiledScraper, pageIndex: number): Promise<boolean> {
  if (scraper.mode !== "list" || !scraper.item) return false;
  switch (scraper.pagination.mode) {
    case "none":
      return false;
    case "scroll":
      if (pageIndex > MAX_SCROLL_ROUNDS) return false;
      return scrollForMore(page, scraper.item.anchorSelector);
    case "next_link":
      return followNextLink(page, scraper);
  }
}

export const defaultPaginate: PaginateHook = paginate;
