import type { Page } from "playwright";
import { waitForSettle } from "../browser/guards.js";

/**
 * Consent pre-step (R9, KTD8). Rule-based and code-only: a table of known
 * consent-manager selectors, then one generic rule for a visible accept
 * button inside a fixed, sticky or dialog container. No chooser is asked; a
 * banner the rules miss is left to navigation. At most two rounds of clicks.
 */

export interface ConsentRule {
  vendor: string;
  selector: string;
}

/** Known consent managers, tried in order before the generic name rule. */
export const CONSENT_RULES: readonly ConsentRule[] = [
  { vendor: "OneTrust", selector: "#onetrust-accept-btn-handler" },
  { vendor: "Cookiebot", selector: "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll" },
  { vendor: "Cookiebot", selector: "#CybotCookiebotDialogBodyButtonAccept" },
  { vendor: "Quantcast", selector: ".qc-cmp2-summary-buttons button[mode=primary]" },
  { vendor: "Didomi", selector: "#didomi-notice-agree-button" },
  { vendor: "TrustArc", selector: "#truste-consent-button" },
  { vendor: "Usercentrics", selector: "button[data-testid=uc-accept-all-button]" },
  { vendor: "Klaro", selector: ".cm-btn-success" },
  { vendor: "Osano", selector: ".osano-cm-accept-all" },
];

/** Generic rule: the accessible name of an accept control, whole string, either language. */
export const CONSENT_NAME_PATTERN = /^(accept( all)?( cookies)?|agree|allow all|got it|i agree|ok|aceptar( todo| todas)?|acepto|entendido|de acuerdo)$/i;

/** Rounds of "find a rule hit, click it, settle"; a second banner (e.g. a vendor + a site one) gets one more. */
export const CONSENT_MAX_ROUNDS = 2;

const MARK = "data-navvi-consent";

export interface ConsentClick {
  role: string;
  name: string;
}

export interface ConsentResult {
  dismissed: boolean;
  /** Every control clicked, in order, so the caller can record them in the trace. */
  clicked: ConsentClick[];
}

interface FoundControl {
  role: string;
  name: string;
  vendor: string;
}

/**
 * Runs in the page. Finds the first visible rule hit (vendor selectors first,
 * then the generic name rule), marks it with `data-navvi-consent` and returns
 * its role and name. Nothing is clicked here.
 */
function findConsentControl(args: { rules: ConsentRule[]; namePattern: string; mark: string }): FoundControl | null {
  const namePattern = new RegExp(args.namePattern, "i");

  const isVisible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      if (text) return text.replace(/\s+/g, " ");
    }
    if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button")) return el.value.trim();
    const title = el.getAttribute("title");
    return (el.textContent ?? "").replace(/\s+/g, " ").trim() || (title ?? "").trim();
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (el instanceof HTMLAnchorElement && el.hasAttribute("href")) return "link";
    return "button";
  };

  const inOverlay = (el: Element): boolean => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      if (tag === "dialog" || node.getAttribute("role") === "dialog" || node.getAttribute("role") === "alertdialog") return true;
      if (node.getAttribute("aria-modal") === "true") return true;
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky") return true;
    }
    return false;
  };

  for (const el of Array.from(document.querySelectorAll(`[${args.mark}]`))) el.removeAttribute(args.mark);

  for (const rule of args.rules) {
    let hits: Element[];
    try {
      hits = Array.from(document.querySelectorAll(rule.selector));
    } catch {
      continue;
    }
    for (const el of hits) {
      if (!isVisible(el)) continue;
      el.setAttribute(args.mark, "1");
      return { role: roleOf(el), name: nameOf(el), vendor: rule.vendor };
    }
  }

  const candidates = Array.from(document.querySelectorAll("button, a[href], [role=button], input[type=button], input[type=submit]"));
  for (const el of candidates) {
    // Name first: an attribute/text read is far cheaper than the computed-style checks.
    const name = nameOf(el);
    if (!namePattern.test(name)) continue;
    if (!isVisible(el)) continue;
    if (!inOverlay(el)) continue;
    el.setAttribute(args.mark, "1");
    return { role: roleOf(el), name, vendor: "generic" };
  }
  return null;
}

async function clickMarked(page: Page): Promise<void> {
  const locator = page.locator(`[${MARK}="1"]`).first();
  try {
    await locator.click({ timeout: 2_000 });
  } catch {
    // Occluded by something the hit test dislikes: dispatch the click straight to the element.
    await locator.dispatchEvent("click").catch(() => undefined);
  }
  await page.evaluate((mark) => {
    for (const el of Array.from(document.querySelectorAll(`[${mark}]`))) el.removeAttribute(mark);
  }, MARK).catch(() => undefined);
}

/**
 * Dismisses a consent prompt with the rule table. Returns every control clicked
 * so the caller can record `{ op: "click" }` steps; `dismissed` is false when
 * no rule matched (the banner, if any, is left to navigation).
 */
export async function dismissConsent(page: Page): Promise<ConsentResult> {
  const clicked: ConsentClick[] = [];
  const args = { rules: [...CONSENT_RULES], namePattern: CONSENT_NAME_PATTERN.source, mark: MARK };
  for (let round = 0; round < CONSENT_MAX_ROUNDS; round++) {
    const found = await page.evaluate(findConsentControl, args).catch(() => null);
    if (!found) break;
    const previous = clicked[clicked.length - 1];
    // The same control still visible after its click did nothing: leave it to navigation.
    if (previous && previous.role === found.role && previous.name === found.name) break;
    await clickMarked(page);
    clicked.push({ role: found.role, name: found.name });
    await waitForSettle(page, { idleMs: 300, maxMs: 3_000 });
  }
  return { dismissed: clicked.length > 0, clicked };
}
