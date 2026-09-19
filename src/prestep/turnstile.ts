import type { Page } from "playwright";

/**
 * Turnstile pre-step (R9). A visible Cloudflare Turnstile checkbox is clicked
 * exactly once per document; then the step waits a bounded time for the
 * widget to produce a `cf-turnstile-response` value or the page to navigate.
 * It never loops and never solves anything: a checkbox that stays unchecked
 * is left for classification (and, locally, a person).
 */

export const TURNSTILE_SELECTORS = ["#cf-turnstile", ".cf-turnstile", 'iframe[src*="challenges.cloudflare.com"]', 'input[name="cf-turnstile-response"]'] as const;

const TURNSTILE_IFRAME = 'iframe[src*="challenges.cloudflare.com"]';
const TURNSTILE_BOX = "#cf-turnstile, .cf-turnstile";
const TURNSTILE_RESPONSE = 'input[name="cf-turnstile-response"]';
const CHECKBOX = 'input[type="checkbox"], [role="checkbox"]';

declare global {
  interface Window {
    /** Set on the document after the one allowed click; navigation clears it. */
    __navviTurnstileClicked?: true;
  }
}

export interface TurnstileOptions {
  /** Upper bound on the wait for a response token or a navigation after the click. Default 5000. */
  waitMs?: number | undefined;
}

export interface TurnstileResult {
  clicked: boolean;
  /** The control clicked, for the trace. */
  control?: { role: string; name: string };
  /** True when a response token appeared or the page navigated within the wait. */
  passed?: boolean;
}

interface Located {
  /** A checkbox lives inside the widget box (else the box itself is clicked). */
  checkbox: boolean;
  name: string;
}

function describeTurnstile(args: { box: string; checkbox: string }): Located | null {
  if (window.__navviTurnstileClicked) return null;
  const box = document.querySelector(args.box);
  if (!box) return null;
  const style = getComputedStyle(box);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const inner = box.querySelector(args.checkbox);
  const label = inner?.closest("label") ?? box.querySelector("label");
  const aria = inner?.getAttribute("aria-label") ?? box.getAttribute("aria-label");
  const name = (aria ?? label?.textContent ?? box.textContent ?? "").replace(/\s+/g, " ").trim();
  return { checkbox: inner !== null, name };
}

async function waitForPass(page: Page, startUrl: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (page.url() !== startUrl) return true;
    const token = await page
      .evaluate((sel) => {
        const input = document.querySelector<HTMLInputElement>(sel);
        return input ? input.value.length > 0 : false;
      }, TURNSTILE_RESPONSE)
      .catch(() => true); // the document went away: a navigation is under way
    if (token) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))));
  }
  return false;
}

/** Clicks a visible Turnstile checkbox once (per document). Never loops. */
export async function clickTurnstile(page: Page, opts: TurnstileOptions = {}): Promise<TurnstileResult> {
  const waitMs = opts.waitMs ?? 5_000;
  const startUrl = page.url();

  const alreadyClicked = await page.evaluate(() => window.__navviTurnstileClicked === true).catch(() => false);
  if (alreadyClicked) return { clicked: false };

  const iframe = page.locator(TURNSTILE_IFRAME).first();
  if ((await iframe.count()) > 0 && (await iframe.isVisible().catch(() => false))) {
    const inner = page.frameLocator(TURNSTILE_IFRAME).first().locator(CHECKBOX).first();
    await page.evaluate(() => {
      window.__navviTurnstileClicked = true;
    });
    try {
      await inner.click({ timeout: 2_000 });
    } catch {
      await iframe.click({ timeout: 2_000, position: { x: 28, y: 32 } }).catch(() => undefined);
    }
    const passed = await waitForPass(page, startUrl, waitMs);
    return { clicked: true, control: { role: "checkbox", name: "Verify you are human" }, passed };
  }

  const located = await page.evaluate(describeTurnstile, { box: TURNSTILE_BOX, checkbox: CHECKBOX }).catch(() => null);
  if (!located) return { clicked: false };

  await page.evaluate(() => {
    window.__navviTurnstileClicked = true;
  });
  const target = located.checkbox ? page.locator(TURNSTILE_BOX).first().locator(CHECKBOX).first() : page.locator(TURNSTILE_BOX).first();
  try {
    await target.click({ timeout: 2_000 });
  } catch {
    await target.dispatchEvent("click").catch(() => undefined);
  }
  const passed = await waitForPass(page, startUrl, waitMs);
  return { clicked: true, control: { role: "checkbox", name: located.name || "Verify you are human" }, passed };
}
