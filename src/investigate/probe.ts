import { bank, type Bank } from "../heuristics/index.js";
import { declaresProduct, visibleText } from "../heuristics/index.js";
import type { PageResponse } from "./blocked.js";
import type { UrlProbe } from "./sample.js";
import { sameTemplate } from "../template/key.js";

/**
 * U2d's missing half: what turns a real response into a `UrlProbe`.
 *
 * `chooseSample` and `classify` were well covered and every input they had ever
 * been given was a hand-written literal. The only code in the repo that
 * produced a probe from an actual page lived in a live smoke script,
 * outside `src/`, with no test — and it spelled the shell rule itself:
 *
 *     isShell: visibleText(body).length < 400 && /<script[^>]+src=/i.test(body) && !declared
 *
 * `400` is `SHELL_TEXT_CHARS` in `src/heuristics/rules/investigate.ts`, where
 * `shell-skips-tier-1` owns it and is free to move it. That is the same shape
 * as the defect the same rule was written to fix: two spellings of one rule,
 * one of them pinned by a fixture and the other by nothing. So the rule is
 * **asked**, through the bank, rather than restated — a probe's `isShell` is
 * `shell-skips-tier-1`'s own verdict, by construction, forever.
 *
 * Nothing here fetches. A probe is a reading of a response the caller already
 * has, which is what makes it testable against a stored page and what keeps
 * `sample.ts` pure.
 */

export interface ProbeOptions {
  /** A case's heuristic overrides; the default bank when omitted. */
  view?: Bank | undefined;
}

/**
 * Distinct price-looking amounts on the page.
 *
 * Deliberately crude and deliberately currency-shaped: `classify` only ever
 * asks whether this is 0, 1, or 2-or-more — "is a discount visible" — so
 * precision here would be precision nobody reads. `Set` rather than a count
 * because a template that repeats one price in the tile and the sticky bar is
 * still an undiscounted page.
 */
function priceCount(body: string): number {
  return new Set(body.match(/\$\s?[\d.]{3,}/g) ?? []).size;
}

/** A URL's last path segment, extension dropped, as words and numbers: "x-30-comp.-25mg" -> words [comp, mg], numbers [30, 25]. */
function slugParts(url: string): { words: string[]; numbers: string[] } {
  let last = "";
  try {
    last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    return { words: [], numbers: [] };
  }
  const runs = last.toLowerCase().replace(/\.[a-z]{2,5}$/, "").match(/[a-z]+|\d+/g) ?? [];
  return { words: runs.filter((r) => /^[a-z]{3,}$/.test(r)), numbers: runs.filter((r) => /^\d+$/.test(r)) };
}

/** An abbreviation reads as its word: "comp" is "comprimidos". */
const sameWord = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/**
 * A redirect to the same product under a renamed slug. A store that renames
 * products rewrites the descriptive words ("caja-30-comp" becomes
 * "x-30-comprimidos") and appends an id, but keeps the product: so the landed
 * URL must be in the requested URL's template, start with the same name word,
 * carry every number of the requested slug (the dose and the pack size: a
 * redirect to another strength is another product), and share at least half
 * of its words, an abbreviation counting as its word. A category, search or
 * home page fails the template test; another product fails the name or the
 * numbers. The caller also requires the landed page to declare a Product.
 */
export function isRenamedProduct(requested: string, landed: string): boolean {
  if (!sameTemplate(requested, landed)) return false;
  const asked = slugParts(requested);
  const found = slugParts(landed);
  const [name] = asked.words;
  if (name === undefined || found.words[0] === undefined || !sameWord(name, found.words[0])) return false;
  if (!asked.numbers.every((n) => found.numbers.includes(n))) return false;
  const shared = asked.words.filter((w) => found.words.some((f) => sameWord(w, f))).length;
  return shared * 2 >= asked.words.length;
}

/**
 * One cheap look at a URL, read into the shape `chooseSample` consumes.
 *
 * `requested` is the URL that was asked for and `response.url` is where the
 * answer came from; when they differ the probe carries `redirectedTo`, which is
 * what lets `classify` tell "302 to a category page" (dead) from "302 that only
 * added a trailing slash" (not dead). Both readings matter: roughly 73% of
 * the client's Store A URLs move.
 */
export function probeFrom(requested: string, response: PageResponse, options: ProbeOptions = {}): UrlProbe {
  const body = response.body ?? "";
  const view = options.view ?? bank();
  const declared = declaresProduct(body);
  return {
    url: requested,
    // A probe that never answered reports 0, and `classify` reads that as
    // transient rather than dead: one silent fetch is not evidence the
    // catalogue lost the URL.
    status: response.status ?? 0,
    ...(response.url !== requested ? { redirectedTo: response.url, sameProduct: declared && isRenamedProduct(requested, response.url) } : {}),
    hasDeclaredProduct: declared,
    isShell: view.run("shell-skips-tier-1", { html: body }).fires,
    priceCount: priceCount(body),
    // `visibleText` is the heuristics module's own reading of "what a person
    // sees", the same one `shell-skips-tier-1` counts; a second spelling of it
    // here could call a page empty that the shell rule calls short.
    textChars: visibleText(body).length,
  };
}
