import { bank, type Bank } from "../heuristics/index.js";
import { declaresProduct } from "../heuristics/rules/investigate.js";
import type { PageResponse } from "./blocked.js";
import type { UrlProbe } from "./sample.js";

/**
 * U2d's missing half: what turns a real response into a `UrlProbe`.
 *
 * `chooseSample` and `classify` were well covered and every input they had ever
 * been given was a hand-written literal. The only code in the repo that
 * produced a probe from an actual page lived in `scripts/live-investigate.ts`,
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

/**
 * One cheap look at a URL, read into the shape `chooseSample` consumes.
 *
 * `requested` is the URL that was asked for and `response.url` is where the
 * answer came from; when they differ the probe carries `redirectedTo`, which is
 * what lets `classify` tell "302 to a category page" (dead) from "302 that only
 * added a trailing slash" (not dead). Both readings matter: roughly 73% of
 * client's StoreA URLs move.
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
    ...(response.url !== requested ? { redirectedTo: response.url } : {}),
    hasDeclaredProduct: declared,
    isShell: view.run("shell-skips-tier-1", { html: body }).fires,
    priceCount: priceCount(body),
  };
}
