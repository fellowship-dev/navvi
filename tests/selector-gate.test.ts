import { describe, expect, it } from "vitest";
import { FAMILIES, REFUSE_FALLBACK, REFUSE_SOLE, auditSelector, gateAlternative } from "../src/compile/gate.js";

/**
 * U7b: the selector gate.
 *
 * The three scrapers of 2026-09-22 reached 27-44% product coverage and all
 * three failed the same way — the compiler selected on presentation rather
 * than on meaning. Every case below is one of those families or a value the
 * gate must **not** refuse, because a gate that refuses a good selector costs
 * a column and is switched off by the next person who trips over it.
 *
 * The rule the whole unit exists to make executable: **a rotten selector is a
 * recompile, not a commit.**
 */

/** Judged as a field's only reading, which is the permissive bar. */
const sole = (selector: string) => gateAlternative(selector, "dom", { sole: true });
/** Judged as a fallback behind an alternative that already answers. */
const fallback = (selector: string) => gateAlternative(selector, "dom", { sole: false });

describe("the four families of a rotten selector", () => {
  it("refuses a modal-state class: the selector names the moment the sample was taken", () => {
    const decision = sole("body.modal-open > div.page:nth-of-type(1) > div:nth-of-type(3) > span.value");
    expect(decision.ok).toBe(false);
    expect(decision.refusedBy).toContain("transient-state-class");
    expect(decision.because).toContain("modal-open");
    // And the reason is legible without opening the scraper, which is the point.
    expect(decision.because).toContain("the UI state the sample was captured in");
  });

  it("refuses a seasonal class: correct in December, gone in January", () => {
    const decision = sole(":scope > body.one-col.christmas-pattern > div.wrap > div.desc:nth-of-type(2)");
    expect(decision.ok).toBe(false);
    expect(decision.refusedBy).toContain("campaign-class");
    expect(decision.because).toContain("christmas-pattern");
  });

  it("refuses a class carrying a year, which is dated by construction", () => {
    expect(sole("div.promo-2025 > span").refusedBy).toContain("campaign-class");
  });

  it("refuses a selector made only of styling utilities: anything styled alike matches it", () => {
    const decision = sole("p.font-semibold.leading-16");
    expect(decision.ok).toBe(false);
    expect(decision.refusedBy).toContain("presentation-only");
    expect(decision.because).toContain("anything styled alike");
  });

  it("refuses a generated class name, which the next build renames", () => {
    for (const selector of ["div.css-1x2y3z > span", "div.Price_root__aB3dE", "span.sc-bdVaJaXz", "p.jsx-1839204722"]) {
      expect(sole(selector).refusedBy, selector).toContain("generated-class");
    }
  });
});

describe("what the gate must not refuse", () => {
  it("passes an attribute selector that names what it selects", () => {
    for (const selector of ['meta[property="product:retailer_item_id"]', '[itemprop="price"]', '[data-testid="list-price"]', "#product-price"]) {
      const decision = sole(selector);
      expect(decision.ok, `${selector}: ${decision.because}`).toBe(true);
      expect(auditSelector(selector).score, selector).toBe(0);
    }
  });

  it("passes a class that names the thing rather than describing it", () => {
    for (const selector of ["span.price-list-std", ".product-card .price-tag", "div.stock-indicator"]) {
      expect(sole(selector).ok, selector).toBe(true);
    }
  });

  /**
   * The false positive a word scan produces, and the reason the transient
   * lexicon is exact tokens plus two shapes rather than a substring search:
   * `active` is inside `active-ingredient`, which is a real class on a real
   * product page and has nothing to do with UI state.
   */
  it("does not read a state word out of the middle of a content class", () => {
    const audit = auditSelector("span.active-ingredient");
    expect(audit.risks.map((risk) => risk.family)).not.toContain("transient-state-class");
    expect(sole("span.active-ingredient").ok).toBe(true);
  });

  it("passes a bare element selector, which is fragile and not rotten", () => {
    expect(sole("h1").ok).toBe(true);
    expect(fallback("h1").ok).toBe(true);
  });
});

describe("the two thresholds", () => {
  /**
   * The policy in one case. A six-deep path with nothing naming what it
   * selects scores 4: not certain to be wrong, so it stands as a field's only
   * reading — a blank column is not obviously better than one that works until
   * the page moves — and it is dropped as a fallback, where it costs nothing
   * to drop and is only ever reached on the page whose markup already moved.
   */
  // Reached through a real compile in `tests/compile-proven.test.ts` ("holds a
  // dom alias behind a declared binding to the fallback bar"): a selector
  // handed to `gateAlternative` here proves the policy, and proves nothing
  // about whether anything in navvi can produce an alternative held to it.
  it("keeps a merely fragile selector as a sole reading and drops it as a fallback", () => {
    const selector = "article > div > div > div > div > div > span";
    const audit = auditSelector(selector);
    expect(audit.score).toBe(REFUSE_FALLBACK);
    expect(audit.score).toBeLessThan(REFUSE_SOLE);
    expect(sole(selector).ok).toBe(true);
    expect(fallback(selector).ok).toBe(false);
    expect(fallback(selector).because).toContain("a fallback behind an alternative that already answers");
  });

  it("refuses a certainty at either bar, because refusing it is not a matter of cost", () => {
    for (const selector of ["body.modal-open span", "div.christmas-banner span", "p.font-semibold.leading-16"]) {
      expect(sole(selector).ok, selector).toBe(false);
      expect(fallback(selector).ok, selector).toBe(false);
    }
  });

  it("two fragilities reaching the bar together refuse as well, which is the intended arithmetic", () => {
    // A positional index plus nothing naming the target: the shape all three
    // 2026-09-22 selectors had once their class names are taken away.
    const audit = auditSelector("ul > li:nth-child(2) > span");
    expect(audit.risks.map((risk) => risk.family).sort()).toEqual(["no-semantic-hook", "positional"]);
    expect(audit.score).toBe(REFUSE_SOLE);
    expect(sole("ul > li:nth-child(2) > span").ok).toBe(false);
  });
});

describe("a declared alternative carries a label, not a selector", () => {
  /**
   * `FieldAlternative.selector` is required on all three sources so every
   * alternative says where it looked, but for `json-ld` and `network` it is
   * the script tag or the endpoint rather than a CSS selector. Auditing one
   * would refuse the cascade's own best source for not naming what it selects.
   */
  it("is not audited at all", () => {
    const label = 'script[type="application/ld+json"]';
    // The auditor does have an opinion about that string...
    expect(auditSelector(label).risks.length).toBeGreaterThan(0);
    // ...and the gate never asks for it.
    for (const source of ["json-ld", "network"] as const) {
      const decision = gateAlternative(label, source, { sole: true });
      expect(decision.ok).toBe(true);
      expect(decision.audit.risks).toEqual([]);
      expect(decision.because).toContain("label rather than a CSS selector");
    }
  });
});

describe("the taxonomy itself", () => {
  it("every family carries the encounter that produced it, the way the heuristic bank does", () => {
    for (const family of FAMILIES) {
      expect(family.encounter.length, family.family).toBeGreaterThan(40);
      expect(family.title.length, family.family).toBeGreaterThan(20);
      expect(family.weight).toBeGreaterThan(0);
    }
    expect(new Set(FAMILIES.map((family) => family.family)).size).toBe(FAMILIES.length);
  });

  it("every family is reachable, so none of them is a rule nobody can trip", () => {
    const corpus = [
      "body.modal-open span",
      "div.christmas-banner span",
      "div.css-1x2y3z span",
      "p.font-semibold.leading-16",
      ":scope > body > main > span.value",
      "ul > li:nth-child(2) > span.value",
      "a > b > c > d > e > f > g.value",
      "h1",
    ];
    const reached = new Set(corpus.flatMap((selector) => auditSelector(selector).risks.map((risk) => risk.family)));
    expect([...reached].sort()).toEqual([...FAMILIES.map((family) => family.family)].sort());
  });

  it("risks come back worst first, so two audits of one selector read the same", () => {
    const risks = auditSelector("body.modal-open > div:nth-of-type(2) > span").risks;
    expect(risks.map((risk) => risk.weight)).toEqual([...risks.map((risk) => risk.weight)].sort((a, b) => b - a));
  });
});
