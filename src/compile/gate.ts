/**
 * U7b: the selector gate.
 *
 * Three scrapers reached 27-44% product coverage on 2026-09-22, and all three
 * failed the same way: **the compiler selected on presentation, not on
 * meaning.** One keyed a price on a class that exists only while a modal is
 * open, so the selector matched on the sample page and nowhere else. One keyed
 * stock on a seasonal campaign class, correct in December and gone in January.
 * One selected a price by Tailwind line-height, which is how it read the club
 * price instead of the list price: the two are styled alike, and styling was
 * all it was looking at. Generated class names are the fourth family — a build
 * hash is renamed by the next deploy, and nobody is told.
 *
 * A `dom` alternative whose selector is rotten is worse than no alternative.
 * It compiles, it extracts on the sample, it passes every "did it extract?"
 * check, and then it either matches nothing or matches the wrong element on
 * every page that was not the one it was compiled from. The ruling this unit
 * ships with is short: **a rotten selector is a recompile, not a commit.**
 *
 * ## Where this comes from, and why it is being written again
 *
 * The taxonomy below is not invented here. A selector auditor scoring these
 * same families lives in the client repository that produced the three
 * failures, where it was written against the committed scrapers and found all
 * three in about ten seconds without touching the network. Phase G's U10 is
 * "move the general machinery out of the client repo and back into navvi", so
 * this file is a piece of U10 taken early — the families and their relative
 * weights come across because they are field-tested, and nothing else does.
 * The rest of that file (a shell test, a JSON-LD block walk, struck-price
 * markup) is **already spelled in navvi** — `shell-skips-tier-1`,
 * `src/declared/json.ts`, `struck-price-is-previous` — and bringing it over
 * would be a second spelling of three rules `src/` already owns.
 *
 * ## Why this is not a heuristic in the bank
 *
 * It looks like one: a named rule, an encounter, a fixture. It is not, for two
 * reasons that are about shape rather than taste.
 *
 * A `Verdict` is `{ fires, because, action?, pick? }` — one boolean and some
 * prose. This gate has to answer **which family refused, and how badly**,
 * because the plan's acceptance is that a refused alternative is named in the
 * rationale *with the family that refused it*; encoding a family into a
 * sentence and parsing it back out at the renderer would be a second spelling
 * of the taxonomy. And the answer is a score summed over several risks, not a
 * single fire: the same selector may be refused as a fallback and kept as a
 * field's only reading, which no `fires: boolean` can express.
 *
 * So it lives here, beside its one caller, and borrows the bank's discipline
 * without joining it: every family carries the encounter that produced it, and
 * `tests/selector-gate.test.ts` pins each one.
 */

/** A family of selector risk, named so the rationale can say which one refused. */
export type RiskFamily =
  | "transient-state-class"
  | "campaign-class"
  | "generated-class"
  | "presentation-only"
  | "absolute-path"
  | "positional"
  | "deep-path"
  | "no-semantic-hook";

/**
 * The families, with the weight each carries and the encounter behind it.
 *
 * The weights are a **policy**, not a measurement, so they are stated once,
 * here, next to the thresholds they feed. The three at 5 are the ones where
 * the class is not a fact about the record at all — it is a fact about the
 * moment the sample was taken, about the month, or about the build id — and
 * each is certain to be wrong the next time any of those changes. The rest are
 * reasons a selector is *fragile*; they add up, and two of them together reach
 * the same bar as one certainty, which is the intended arithmetic.
 */
export interface FamilyPolicy {
  family: RiskFamily;
  weight: number;
  title: string;
  encounter: string;
}

export const FAMILIES: readonly FamilyPolicy[] = [
  {
    family: "transient-state-class",
    weight: 5,
    title: "A class naming a UI state names the moment the sample was taken, not the record.",
    encounter: "2026-09-22: a list price compiled fourteen levels deep from `body.modal-open`. The sample was captured with a dialog covering the product; every page without one matches nothing.",
  },
  {
    family: "campaign-class",
    weight: 5,
    title: "A seasonal or campaign class changes on a schedule nobody scraping the site is told about.",
    encounter: "2026-09-22: a stock field rooted on `christmas-pattern`. Correct in December, gone in January, and the scraper reports drift in a month nobody is looking.",
  },
  {
    family: "generated-class",
    weight: 5,
    title: "A generated or hashed class name is a build artifact, renamed by the next deploy.",
    encounter: "The fourth family of the same 2026-09-22 audit: CSS-in-JS and CSS-module hashes (`css-1x2y3z`, `Price_root__aB3dE`) survive exactly as long as the bundle that emitted them.",
  },
  {
    family: "presentation-only",
    weight: 4,
    title: "A selector made only of utility classes says how a thing looks and never what it is.",
    encounter: "2026-09-22: a list price selected by Tailwind line-height bound the club price instead. The two are styled alike, and styling was all the selector was looking at.",
  },
  {
    family: "absolute-path",
    weight: 4,
    title: "A path anchored at `body` breaks on any wrapper inserted anywhere above the target.",
    encounter: "All three 2026-09-22 selectors were `:scope > body > ...` chains produced by walking up from the chosen element.",
  },
  {
    family: "positional",
    weight: 3,
    title: "A positional index changes meaning when a sibling is inserted or reordered, silently.",
    encounter: "2026-09-22: `:nth-of-type(2)` on a description block read the shipping blurb rather than any stock indicator, and still extracted a value.",
  },
  {
    family: "deep-path",
    weight: 2,
    title: "Six or more combinators is six or more chances to drift.",
    encounter: "2026-09-22: the shortest of the three committed price selectors was nine combinators long.",
  },
  {
    family: "no-semantic-hook",
    weight: 2,
    title: "No id, `data-*`, `itemprop` or meaningful class anywhere in the path.",
    encounter: "The common factor across all three: nothing in the selector named the thing it was selecting, so nothing about it could be checked by reading it.",
  },
];

const WEIGHT: Record<RiskFamily, number> = Object.fromEntries(FAMILIES.map((entry) => [entry.family, entry.weight])) as Record<RiskFamily, number>;

// ------------------------------------------------------------------ lexicons

/**
 * Classes naming a transient UI state.
 *
 * Exact tokens plus two shapes (`is-`/`has-` prefixes, `-open`/`-active`
 * suffixes) rather than a word scan, because a word scan reads `active` inside
 * `active-ingredient` — a class a pharmacy page genuinely carries — and
 * refusing a field for a substring is how a gate stops being trusted.
 */
const TRANSIENT_EXACT: ReadonlySet<string> = new Set([
  "open", "active", "show", "shown", "expanded", "collapsed", "selected", "hover", "focus",
  "loading", "loaded", "scrolled", "disabled", "dragging", "modal-open", "menu-open",
  "drawer-open", "nav-open", "sidebar-open", "no-scroll", "overflow-hidden", "body-fixed",
]);
const TRANSIENT_SHAPE = /^(?:is|has)-|-(?:open|active|shown|expanded|collapsed|selected|visible)$/;

/** Marketing seasons and campaigns, plus any token carrying a four-digit year: dated by construction. */
const CAMPAIGN = /\b(?:christmas|navidad|xmas|holiday|halloween|cyber|cybermonday|blackfriday|black-friday|easter|pascua|dieciocho|fiestas-patrias|valentine|san-valentin|summer|winter|verano|invierno|sale-season|campaign|promo-banner)/i;
const DATED = /(?:^|[-_])(?:19|20)\d{2}(?:[-_]|$)/;

/**
 * Utility classes. Two lists because half of them are meaningless without a
 * value (`text-`, `p-`, `w-`) and half stand alone (`flex`, `truncate`).
 */
const UTILITY_PREFIX =
  /^(?:text|font|leading|tracking|decoration|p[xytrbl]?|m[xytrbl]?|w|h|min|max|gap|items|justify|self|place|order|col|row|bg|border|rounded|shadow|ring|opacity|z|top|left|right|bottom|inset|space|divide|overflow|grid|flex|basis|grow|shrink|aspect|object|translate|scale|rotate|transition|duration|ease|delay|cursor|select|pointer|whitespace|break|list|align|content|float|fs|fw|d)-/;
const UTILITY_EXACT: ReadonlySet<string> = new Set([
  "flex", "grid", "block", "inline", "inline-block", "inline-flex", "hidden", "absolute",
  "relative", "fixed", "static", "sticky", "truncate", "uppercase", "lowercase", "capitalize",
  "italic", "underline", "antialiased", "container", "sr-only", "rounded", "border", "shadow",
  "ring", "transition", "clearfix",
]);

/** A hook that names the thing rather than describing it. */
const SEMANTIC_ATTR = /\[itemprop|\[data-|\[aria-|\[name=|\[property=|\[id=|#[A-Za-z]/;
const SEMANTIC_CLASS = /^(?:product|price|precio|sku|stock|name|nombre|title|titulo|brand|marca|amount|monto|currency|moneda|value|valor|code|codigo|item|offer|oferta)[\w-]*$/i;

// -------------------------------------------------------------- the analysis

/** Class tokens of a selector, with any variant prefix (`md:`, `hover:`, `!`) stripped. */
function classesOf(selector: string): string[] {
  const raw = selector.match(/\.(?:\\.|[A-Za-z_])(?:\\.|[\w-])*/g) ?? [];
  return raw.map((token) =>
    token
      .slice(1)
      .replace(/\\/g, "")
      .replace(/^!+/, "")
      .replace(/^(?:[\w-]+:)+/, ""),
  );
}

/**
 * Combinators in the path. Attribute brackets are removed first so a selector
 * such as `meta[property="og:title"]` is not read as two steps.
 */
function combinators(selector: string): number {
  const stripped = selector.replace(/\[[^\]]*\]/g, "").trim();
  return (stripped.match(/\s*[>+~]\s*|\s+/g) ?? []).length;
}

/**
 * A class token carrying a build hash.
 *
 * Two named conventions, then one generic tail test: the last segment is at
 * least five characters and mixes digits with letters (or mixes case), which is
 * what a hash looks like and what an English or Spanish word does not.
 * `price-list-std`, `product-card` and `font-semibold` all fall through it.
 */
function looksGenerated(token: string): boolean {
  if (/^(?:css|sc|jsx|emotion|styles?)-[A-Za-z0-9]{5,}$/.test(token)) return true;
  const tail = /(?:^|[-_])([A-Za-z0-9]{5,})$/.exec(token)?.[1];
  if (tail === undefined) return false;
  const digits = (tail.match(/\d/g) ?? []).length;
  const letters = (tail.match(/[A-Za-z]/g) ?? []).length;
  const mixedCase = /[a-z]/.test(tail) && /[A-Z]/.test(tail);
  return digits >= 1 && letters >= 2 && (mixedCase || digits >= 2);
}

export interface SelectorRisk {
  family: RiskFamily;
  weight: number;
  /** Stated in terms of this selector, because it is printed into the rationale verbatim. */
  because: string;
}

export interface SelectorAudit {
  selector: string;
  /** Combinators in the path; every one of them is a chance to drift. */
  depth: number;
  /** Highest weight first, then by family, so two audits of one selector read the same. */
  risks: SelectorRisk[];
  score: number;
}

/** Scores one CSS selector. Higher is worse; zero means nothing here objects to it. */
export function auditSelector(selector: string): SelectorAudit {
  const text = String(selector ?? "");
  const depth = combinators(text);
  const classes = classesOf(text);
  const risks: SelectorRisk[] = [];
  const add = (family: RiskFamily, because: string): void => {
    risks.push({ family, weight: WEIGHT[family], because });
  };

  if (/^\s*(?::scope\s*[>\s]\s*)?(?:html|body)\b/i.test(text)) {
    add("absolute-path", "anchored at the document root, so any wrapper inserted anywhere above the target breaks it");
  }
  if (depth >= 6) {
    add("deep-path", `${depth} combinators deep; every one of them is a chance to drift`);
  }
  const positions = (text.match(/:nth-(?:of-type|child|last-child|last-of-type)/g) ?? []).length;
  if (positions > 0) {
    add("positional", `${positions} positional index(es); inserting or reordering a sibling silently changes the match`);
  }

  const transient = classes.filter((token) => TRANSIENT_EXACT.has(token) || TRANSIENT_SHAPE.test(token));
  if (transient.length > 0) {
    add("transient-state-class", `depends on the UI state the sample was captured in: ${transient.join(", ")}`);
  }
  const campaign = classes.filter((token) => CAMPAIGN.test(token) || DATED.test(token));
  if (campaign.length > 0) {
    add("campaign-class", `depends on a seasonal or campaign class: ${campaign.join(", ")}`);
  }
  const generated = classes.filter((token) => looksGenerated(token));
  if (generated.length > 0) {
    add("generated-class", `depends on a generated class name the next build renames: ${generated.join(", ")}`);
  }
  if (classes.length > 0 && classes.every((token) => UTILITY_PREFIX.test(token) || UTILITY_EXACT.has(token))) {
    add("presentation-only", `selects by styling only (${classes.join(", ")}); anything styled alike matches it just as well`);
  }
  if (!SEMANTIC_ATTR.test(text) && !classes.some((token) => SEMANTIC_CLASS.test(token))) {
    add("no-semantic-hook", "no id, data-*, itemprop, aria-* or meaningful class anywhere in the path");
  }

  risks.sort((a, b) => b.weight - a.weight || a.family.localeCompare(b.family));
  return { selector: text, depth, risks, score: risks.reduce((total, risk) => total + risk.weight, 0) };
}

// ------------------------------------------------------------- the thresholds

/**
 * The bar a selector has to clear to be a field's **only** reading.
 *
 * Five, which is exactly one certainty: transient state, campaign, or a
 * generated name. Refusing here costs the field — it comes back unbound and a
 * person has to recompile — so only a family that is certain to be wrong may
 * do it. Fragility alone does not: a nine-deep positional path is a bad
 * selector and still the only statement of the value anybody has, and a blank
 * column is not obviously better than a column that works until the page moves.
 *
 * Two fragilities reaching five together (a deep path *and* a positional
 * index) refuse as well, and that is the intended arithmetic rather than an
 * accident: that pair is the shape all three 2026-09-22 selectors had.
 */
export const REFUSE_SOLE = 5;

/**
 * The bar for an alternative that sits **behind** one that already answers.
 *
 * Four, and lower on purpose. Dropping a fallback costs nothing while the
 * alternative ahead of it holds, and a fallback is only ever reached on a page
 * where that one already failed — which is precisely the page whose markup
 * moved, and precisely where a presentation-only or root-anchored selector is
 * most likely to match the wrong element rather than nothing at all. A
 * plausible wrong row is worse than a blank one, so the cheap refusal is taken.
 */
export const REFUSE_FALLBACK = 4;

export interface GateDecision {
  /** May this alternative be compiled? */
  ok: boolean;
  audit: SelectorAudit;
  /** Which bar was applied. */
  threshold: number;
  /** The families that refused it, for the rationale. Empty when it passed. */
  refusedBy: RiskFamily[];
  /** One line naming the decision, printed into `rationale.md` as it stands. */
  because: string;
}

export interface GateOptions {
  /**
   * Is this the field's only reading? A sole reading is held to `REFUSE_SOLE`;
   * anything with a surviving alternative ahead of it to `REFUSE_FALLBACK`.
   */
  sole: boolean;
}

/**
 * The gate. `source` decides whether it runs at all: for `json-ld` and
 * `network` the `selector` is a **label** — the script tag being read, or the
 * endpoint being matched — and running a CSS-selector audit over
 * `script[type="application/ld+json"]` would refuse the cascade's own best
 * source for having no semantic hook.
 */
export function gateAlternative(selector: string, source: "dom" | "json-ld" | "network", options: GateOptions): GateDecision {
  const audit = auditSelector(selector);
  if (source !== "dom") {
    return {
      ok: true,
      audit: { selector, depth: 0, risks: [], score: 0 },
      threshold: 0,
      refusedBy: [],
      because: `a ${source} alternative carries a label rather than a CSS selector; the gate does not audit it`,
    };
  }
  const threshold = options.sole ? REFUSE_SOLE : REFUSE_FALLBACK;
  const ok = audit.score < threshold;
  const refusedBy = ok ? [] : audit.risks.map((risk) => risk.family);
  const role = options.sole ? "the field's only reading" : "a fallback behind an alternative that already answers";
  return {
    ok,
    audit,
    threshold,
    refusedBy,
    because: ok
      ? audit.risks.length === 0
        ? `\`${selector}\` names what it selects and carries no risk the gate scores`
        : `\`${selector}\` scores ${audit.score}, under the ${threshold} this alternative is held to as ${role}: ${audit.risks.map((risk) => risk.because).join("; ")}`
      : `\`${selector}\` scores ${audit.score} against the ${threshold} this alternative is held to as ${role} — ${audit.risks.map((risk) => `${risk.family} (${risk.weight}): ${risk.because}`).join("; ")}`,
  };
}
