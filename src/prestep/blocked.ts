import type { Page } from "playwright";
import {
  BOT_CHALLENGE_SELECTORS,
  BOT_CHALLENGE_TEXT,
  CHALLENGE_MARKERS,
  DECISIVE_CHALLENGE_SELECTORS,
  WIDGET_CHALLENGE_SELECTORS,
  WIDGET_MARKERS,
  readChallenge,
} from "../blocked/challenge.js";
import { getCandidates } from "../browser/snapshot.js";
import { bank, type Bank } from "../heuristics/index.js";
import { declaresProduct } from "../heuristics/index.js";

/**
 * Blocked-page classification (R9, R13). Code-only: title, body text, known
 * challenge containers and markers decide between a bot challenge and a login
 * wall. Nothing here is asked of a model.
 *
 * The lexicon and the decisive/corroboration split are **not** here: they live
 * in `src/blocked/challenge.ts`, which `src/investigate/blocked.ts` reads too.
 * The two modules ask different questions — this one about one live `Page`
 * mid-navigation, that one about a finished run, offline — and they used to
 * answer them with two different rules. On 2026-09-22 a Chilean store with
 * reCAPTCHA in its login modal and one rate-limited 403 was
 * `blocked_bot_detection` here and healthy there. What is left in this file is
 * only what a live page can say and a stored body cannot: a rendered `innerText`
 * that no interstitial has, a visible password field, a repeated list.
 */

export type BlockedStatus = "blocked_bot_detection" | "blocked_login_required";

export { BOT_CHALLENGE_SELECTORS, BOT_CHALLENGE_TEXT, DECISIVE_CHALLENGE_SELECTORS, WIDGET_CHALLENGE_SELECTORS } from "../blocked/challenge.js";

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

/** Fewer same-signature repeated items than this means "no list content". */
export const MIN_LIST_ITEMS = 4;

/** A regex the page can rebuild, so the lexicon is passed in rather than restated in the browser. */
interface SerializedPattern {
  source: string;
  flags: string;
}

const serialize = (patterns: readonly RegExp[]): SerializedPattern[] => patterns.map((pattern) => ({ source: pattern.source, flags: pattern.flags }));

interface PageFacts {
  url: string;
  title: string;
  /** Visible body text, whitespace collapsed, capped. */
  text: string;
  textLength: number;
  /** The first mitigation-only container or source marker found, if any. */
  decisive: string | null;
  /** The first captcha widget or WAF injection found, if any. */
  widget: string | null;
  /**
   * Only the part of the serialized DOM that can declare a product: the
   * JSON-LD blocks, the `property=` meta tags and the `itemtype` attributes.
   * Small enough to carry, and it is read by the *real* `declaresProduct`
   * rather than by a second copy of it written for the browser.
   */
  declaration: string;
  hasPasswordField: boolean;
}

function collectFacts(args: {
  decisiveSelectors: string[];
  widgetSelectors: string[];
  decisivePatterns: SerializedPattern[];
  widgetPatterns: SerializedPattern[];
  textCap: number;
}): PageFacts {
  const body = document.body?.innerText ?? "";
  const text = body.replace(/\s+/g, " ").trim();
  const source = document.documentElement?.outerHTML ?? "";

  const firstSelector = (selectors: string[]): string | null => {
    for (const selector of selectors) {
      try {
        if (document.querySelector(selector)) return selector;
      } catch {
        // invalid selector in this engine: skip
      }
    }
    return null;
  };
  const firstPattern = (patterns: SerializedPattern[]): string | null => {
    for (const pattern of patterns) {
      try {
        const hit = new RegExp(pattern.source, pattern.flags).exec(source);
        if (hit) return hit[0];
      } catch {
        // unsupported pattern in this engine: skip
      }
    }
    return null;
  };

  const declaration: string[] = [];
  for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"], meta[property], [itemtype]'))) {
    if (node.tagName === "SCRIPT" || node.tagName === "META") {
      declaration.push(node.outerHTML);
    } else {
      declaration.push(`<div itemtype="${node.getAttribute("itemtype") ?? ""}"></div>`);
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
    decisive: firstSelector(args.decisiveSelectors) ?? firstPattern(args.decisivePatterns),
    widget: firstSelector(args.widgetSelectors) ?? firstPattern(args.widgetPatterns),
    declaration: declaration.join("\n"),
    hasPasswordField,
  };
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

async function hasListContent(page: Page): Promise<boolean> {
  try {
    const { groups } = await getCandidates(page, { minGroupItems: MIN_LIST_ITEMS, maxGroups: 1, maxLeaves: 0, maxLinks: 0 });
    return groups.length > 0;
  } catch {
    return false;
  }
}

export interface ClassifyBlockedOptions {
  /** A case's heuristic overrides; the default bank when omitted. */
  view?: Bank | undefined;
}

/**
 * `blocked_bot_detection` for a challenge interstitial, `blocked_login_required`
 * for a login wall (password field, no list content, login wording), null for
 * anything else. `response.status` is the navigation response when the caller
 * has it; after a person or a redirect changed the document, pass nothing.
 *
 * The status is recorded and reported, and it decides nothing: see the note in
 * `src/blocked/challenge.ts`. A 403 on a page that is serving a product is the
 * site refusing *this request*, which is a run-level reading
 * (`BLOCKING_STATUSES`, weighed over many URLs) and not a reason to call the
 * page a captcha.
 */
export async function classifyBlocked(
  page: Page,
  response?: { status?: number | undefined },
  options: ClassifyBlockedOptions = {},
): Promise<BlockedStatus | null> {
  const facts = await page
    .evaluate(collectFacts, {
      decisiveSelectors: [...DECISIVE_CHALLENGE_SELECTORS],
      widgetSelectors: [...WIDGET_CHALLENGE_SELECTORS],
      decisivePatterns: serialize(CHALLENGE_MARKERS),
      widgetPatterns: serialize(WIDGET_MARKERS),
      textCap: 5_000,
    })
    .catch(() => null);
  if (!facts) return null;

  const reading = readChallenge({
    title: facts.title,
    text: facts.text,
    textLength: facts.textLength,
    declaresProduct: declaresProduct(facts.declaration),
    decisive: facts.decisive === null ? null : { evidence: facts.decisive, because: `the page carries ${facts.decisive}` },
    widget: facts.widget,
  });

  // A decisive reading settles it: those markers appear when, and only when, a
  // request was mitigated.
  if (reading !== null && reading.corroborated !== true) return "blocked_bot_detection";

  /**
   * The login wall is asked **before** the corroborated half, and the reason is
   * the same one that keeps a captcha off a product page: a container inside a
   * login form is furniture. Plenty of stores put reCAPTCHA on their account
   * form, and a login wall that came back `blocked_bot_detection` would stop a
   * `local` run that has the secrets to walk straight through it.
   */
  if (facts.hasPasswordField) {
    const wording = `${facts.url} ${facts.title} ${facts.text}`;
    if (matchesAny(wording, LOGIN_HINTS) && !(await hasListContent(page))) return "blocked_login_required";
  }

  if (reading !== null) {
    /**
     * A corroborated reading is only as strong as the page being empty of its
     * own accord, and a JS shell is empty by construction — Store B's plain
     * fetch is 2,863 characters of bundle loader with Imperva's always-on
     * resource in its head, and the store answers perfectly. `classifyRun`
     * holds exactly this signal back and answers `deferred`; the equivalent
     * here is to keep navigating.
     *
     * The trade-off, stated rather than hidden: a genuine captcha interstitial
     * that ships its own bundle and renders no text is a shell by this rule and
     * is missed here. That costs a run that finds nothing and is reported as
     * such. Being wrong the other way aborts a healthy store mid-crawl, which
     * is the mistake this repository has already made once and the reason
     * `DeferredVerdict` exists.
     */
    const html = await page.content().catch(() => "");
    const view = options.view ?? bank();
    if (html !== "" && view.run("shell-skips-tier-1", { html }).fires) return null;
    return "blocked_bot_detection";
  }

  return null;
}
