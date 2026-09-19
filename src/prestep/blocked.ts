import type { Page } from "playwright";
import { getCandidates } from "../browser/snapshot.js";

/**
 * Blocked-page classification (R9, R13). Code-only: title, body text, known
 * challenge containers and the response status decide between a bot
 * challenge and a login wall. Nothing here is asked of a model.
 */

export type BlockedStatus = "blocked_bot_detection" | "blocked_login_required";

/** Challenge interstitial text, matched against the title and the visible body text. */
export const BOT_CHALLENGE_TEXT: readonly RegExp[] = [
  /checking your browser/i,
  /just a moment/i,
  /verify(ing)? (that )?you are (a )?human/i,
  /verify you are not a (ro)?bot/i,
  /access denied/i,
  /attention required/i,
  /un momento/i,
  /verifica que eres humano/i,
  /comprueba que eres humano/i,
  /confirma que eres humano/i,
  /acceso denegado/i,
  /enable javascript and cookies to continue/i,
  /please enable cookies/i,
  /request unsuccessful\. incapsula/i,
  /pardon our interruption/i,
  /performance & security by cloudflare/i,
  /datadome/i,
  /perimeterx/i,
  /press & hold/i,
];

/** Containers of known challenge and captcha widgets. */
export const BOT_CHALLENGE_SELECTORS: readonly string[] = [
  "#cf-turnstile",
  ".cf-turnstile",
  'iframe[src*="challenges.cloudflare.com"]',
  "#challenge-running",
  "#challenge-form",
  "#challenge-error-text",
  "#cf-challenge-running",
  "#px-captcha",
  "[id^='px-captcha']",
  "#datadome",
  "iframe[src*='captcha-delivery.com']",
  "iframe[src*='geo.captcha-delivery.com']",
  ".h-captcha",
  "iframe[src*='hcaptcha.com']",
  ".g-recaptcha",
  "#recaptcha",
  "iframe[src*='recaptcha']",
  "#captcha-form",
  "form[action*='captcha']",
];

/** Login wording, matched against the URL, title and body text. */
export const LOGIN_HINTS: readonly RegExp[] = [
  /\blog ?in\b/i,
  /\bsign ?in\b/i,
  /\bsignin\b/i,
  /iniciar sesi[oó]n/i,
  /inicia sesi[oó]n/i,
  /\bingresar\b/i,
  /\bingresa\b/i,
  /\bacceso\b/i,
  /\bacceder\b/i,
  /\bmembers only\b/i,
  /\bauthenticate\b/i,
  /\bautenticar\b/i,
];

export const CHALLENGE_STATUSES: ReadonlySet<number> = new Set([403, 429, 503]);

/** Interstitials carry little text; a body under this length can be classified on text alone. */
const SHORT_BODY_CHARS = 1_500;

/** Fewer same-signature repeated items than this means "no list content". */
export const MIN_LIST_ITEMS = 4;

interface PageFacts {
  url: string;
  title: string;
  /** Visible body text, whitespace collapsed, capped. */
  text: string;
  textLength: number;
  challengeSelector: string | null;
  hasPasswordField: boolean;
}

function collectFacts(args: { selectors: string[]; textCap: number }): PageFacts {
  const body = document.body?.innerText ?? "";
  const text = body.replace(/\s+/g, " ").trim();
  let challengeSelector: string | null = null;
  for (const sel of args.selectors) {
    try {
      if (document.querySelector(sel)) {
        challengeSelector = sel;
        break;
      }
    } catch {
      // invalid selector in this engine: skip
    }
  }
  const isVisible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const hasPasswordField = Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible);
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, args.textCap),
    textLength: text.length,
    challengeSelector,
    hasPasswordField,
  };
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function isBotChallenge(facts: PageFacts, status: number | undefined): boolean {
  const titleHit = matchesAny(facts.title, BOT_CHALLENGE_TEXT);
  const textHit = matchesAny(facts.text, BOT_CHALLENGE_TEXT);
  const selectorHit = facts.challengeSelector !== null;
  if (status !== undefined && CHALLENGE_STATUSES.has(status) && (titleHit || textHit || selectorHit)) return true;
  if (titleHit) return true;
  // A captcha container plus challenge wording is a challenge whatever the status.
  if (textHit && selectorHit) return true;
  // Challenge wording on a page with almost nothing else: an interstitial.
  return textHit && facts.textLength < SHORT_BODY_CHARS;
}

async function hasListContent(page: Page): Promise<boolean> {
  try {
    const { groups } = await getCandidates(page, { minGroupItems: MIN_LIST_ITEMS, maxGroups: 1, maxLeaves: 0, maxLinks: 0 });
    return groups.length > 0;
  } catch {
    return false;
  }
}

/**
 * `blocked_bot_detection` for a challenge interstitial, `blocked_login_required`
 * for a login wall (password field, no list content, login wording), null for
 * anything else. `response.status` is the navigation response when the caller
 * has it; after a person or a redirect changed the document, pass nothing.
 */
export async function classifyBlocked(page: Page, response?: { status?: number | undefined }): Promise<BlockedStatus | null> {
  const facts = await page
    .evaluate(collectFacts, { selectors: [...BOT_CHALLENGE_SELECTORS], textCap: 5_000 })
    .catch(() => null);
  if (!facts) return null;

  if (isBotChallenge(facts, response?.status)) return "blocked_bot_detection";

  if (facts.hasPasswordField) {
    const wording = `${facts.url} ${facts.title} ${facts.text}`;
    if (matchesAny(wording, LOGIN_HINTS) && !(await hasListContent(page))) return "blocked_login_required";
  }
  return null;
}
