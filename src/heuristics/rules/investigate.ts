import { z } from "zod";
import { normalize } from "../../util/text.js";
import { define, type AnyHeuristic } from "../types.js";

/**
 * Investigation heuristics: which tier to spend, and which tier to skip.
 * They run before a model is asked anything, which is the whole point — the
 * cheapest correct answer is the one that never opens a browser.
 */

/** Visible text of an HTML document, near enough for a shell test: no parser, no browser. */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does the document declare a product to anyone who asks: JSON-LD, microdata or the OpenGraph product namespace? */
export function declaresProduct(html: string): boolean {
  if (/<script[^>]+type\s*=\s*["']application\/ld\+json["'][\s\S]*?"@type"\s*:\s*"?Product/i.test(html)) return true;
  if (/property\s*=\s*["'](?:product:price:amount|og:price:amount)["']/i.test(html)) return true;
  if (/itemtype\s*=\s*["']https?:\/\/schema\.org\/Product["']/i.test(html)) return true;
  return false;
}

/** Below this many characters of visible text, a page is not showing a product to a reader. */
const SHELL_TEXT_CHARS = 400;

const declaredCoversSpec = define({
  id: "declared-covers-spec",
  title: "Declared data covers every spec field → stop. No render, no compile.",
  stage: "investigate",
  decides: "Whether tiers 2 and 3 run at all.",
  encounter:
    "StoreA, 2026-09-22: name, sku, brand, listPrice, promoPrice and stock were all stated in the page's own og:/product: meta tags, " +
    "while the compiled scraper was reading a seasonal CSS class (body.one-col.christmas-pattern) and covering 27-44% of the catalogue.",
  input: z.object({
    requested: z.array(z.string().min(1)).min(1),
    /** Field name to the value the declared sources gave, null when they gave none. */
    declared: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  }),
  evaluate: ({ requested, declared }) => {
    const missing = requested.filter((field) => {
      const value = declared[field];
      return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
    });
    if (missing.length > 0) {
      return { fires: false, because: `declared data misses ${missing.join(", ")}; the uncovered fields still need a page` };
    }
    return {
      fires: true,
      because: `every requested field (${requested.join(", ")}) is stated by the page itself`,
      action: "stop at tier 1: no render, no capture, no compile",
    };
  },
});

const shellSkipsTierOne = define({
  id: "shell-skips-tier-1",
  title: "Plain fetch returns a shell → skip tier 1 entirely, render and capture.",
  stage: "investigate",
  decides: "Whether the plain fetch is worth repeating per URL, or the run should go straight to a browser.",
  encounter: "Store B, 2026-09-22: 25 of 25 plain fetches returned a JS shell, and the page's own products/detail call held the answer.",
  input: z.object({ html: z.string() }),
  evaluate: ({ html }) => {
    const text = visibleText(html);
    const externalScripts = (html.match(/<script[^>]+src\s*=/gi) ?? []).length;
    const declared = declaresProduct(html);
    if (declared) return { fires: false, because: "the plain fetch already declares a product; tier 1 is the cheapest source and it works here" };
    if (text.length >= SHELL_TEXT_CHARS) return { fires: false, because: `the plain fetch returned ${text.length} characters of visible text; it is a page, not a shell` };
    if (externalScripts === 0) return { fires: false, because: `the plain fetch returned ${text.length} characters and no script to fill them: an empty page, not a shell` };
    return {
      fires: true,
      because: `the plain fetch returned ${text.length} characters of visible text, no declared product and ${externalScripts} script bundle(s): the content arrives later`,
      action: "skip tier 1 for this site: render, and capture what the page fetches for itself",
    };
  },
});

const searchMirrorsDetail = define({
  id: "search-mirrors-detail",
  title: "A site's search endpoint usually mirrors its detail endpoint.",
  stage: "investigate",
  decides: "Whether the link finder needs its own investigation, or can reuse the detail binding.",
  encounter: "Store B, 2026-09-22: the search endpoint returned the same structured shape as products/detail, which makes Phase B cheaper for having waited.",
  input: z.object({
    detail: z.object({ path: z.string().min(1), keys: z.array(z.string()).min(1) }),
    candidates: z.array(z.object({ path: z.string().min(1), keys: z.array(z.string()) })).min(1),
  }),
  evaluate: ({ detail, candidates }) => {
    const want = new Set(detail.keys.map((key) => normalize(key)));
    const scored = candidates
      .map((candidate) => {
        const shared = candidate.keys.filter((key) => want.has(normalize(key))).length;
        return { path: candidate.path, shared, overlap: want.size === 0 ? 0 : shared / want.size };
      })
      .sort((a, b) => b.overlap - a.overlap);
    const best = scored[0]!;
    if (best.overlap < 0.5) {
      return { fires: false, because: `the closest candidate (${best.path}) shares ${best.shared} of ${want.size} detail keys; nothing here mirrors the detail shape` };
    }
    return {
      fires: true,
      because: `${best.path} shares ${best.shared} of ${want.size} keys with ${detail.path}`,
      action: "reuse the detail endpoint's field bindings on the search endpoint rather than investigating it from scratch",
      pick: best.path,
    };
  },
});

export const INVESTIGATE_HEURISTICS: readonly AnyHeuristic[] = [declaredCoversSpec, shellSkipsTierOne, searchMirrorsDetail];
