import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bank } from "../src/heuristics/index.js";
import { bindField } from "../src/investigate/bind.js";
import { anchors, flatten, narrow, typeMatches, type Leaf } from "../src/investigate/leaves.js";

/**
 * U2b: the payload a page fetches for itself, flattened into candidates, and
 * the bank's first consumer.
 *
 * The fixtures are synthetic with a shape probed off Store B on 2026-09-22:
 * `prices` keyed by dashed currency codes, `appliedPromotions` keyed the same
 * way, a `promotions` array carrying `isClubPromotion`, and a pile of
 * telemetry and SEO leaves that have to be filtered out without being named.
 */

const DIR = join(import.meta.dirname, "fixtures", "investigate");
const detail = (n: "" | "-2" = ""): unknown => JSON.parse(readFileSync(join(DIR, `storeb-detail${n}.json`), "utf8"));

/** What each sample page showed a reader, near enough to anchor against. */
const PAGE_TEXT = [
  "Ejemplo Comprimidos 100 mg 30 Comprimidos $ 4.990 $ 4.491 Club Store B $ 3.992 Precio por Unidad Fraccionada: $ 166 por Comprimido Laboratorio Ejemplo",
  "Otro Jarabe 120 ml $ 12.990 $ 11.691 Precio por Unidad Fraccionada: $ 108 por ml Laboratorio Otro",
];

function samples(): Leaf[][] {
  return [flatten(detail()), flatten(detail("-2"))];
}

describe("flatten", () => {
  it("emits paths the compiled scraper can read back, brackets and all", () => {
    const paths = flatten(detail()).map((leaf) => leaf.path);
    expect(paths).toContain("productData.prices[price-list-std]");
    expect(paths).toContain("productData.prices[price-sale-std]");
    expect(paths).toContain("productData.appliedPromotions[price-sale-std].promotionalPrice");
    expect(paths).toContain("productData.promotions[1].isClubPromotion");
    expect(paths).toContain("productData.name");
  });

  it("reaches every scalar and stops at scalars", () => {
    const leaves = flatten({ a: { b: [1, "two", null, true] } });
    expect(leaves).toEqual([
      { path: "a.b[0]", value: 1 },
      { path: "a.b[1]", value: "two" },
      { path: "a.b[2]", value: null },
      { path: "a.b[3]", value: true },
    ]);
  });

  it("survives a payload that points at itself, and honours the caps", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    expect(() => flatten(cyclic)).not.toThrow();
    expect(flatten(detail(), { maxLeaves: 3 })).toHaveLength(3);
  });
});

describe("anchors", () => {
  it("matches a number through the page's own thousands separator", () => {
    expect(anchors(4990, "el precio es $ 4.990 hoy")).toBe(true);
    expect(anchors(4990, "el precio es $ 4,990 hoy")).toBe(true);
    expect(anchors(4990, "el precio es $ 4990 hoy")).toBe(true);
  });

  it("rejects a value the page never shows", () => {
    expect(anchors(1758560000000, "el precio es $ 4.990 hoy")).toBe(false);
    expect(anchors("a1b2c3", "el precio es $ 4.990 hoy")).toBe(false);
    expect(anchors(null, "anything")).toBe(false);
  });
});

describe("typeMatches", () => {
  it("reads a money value out of a number or a formatted string, never out of a sentence", () => {
    expect(typeMatches(4990, "money")).toBe(true);
    expect(typeMatches("$ 4.990", "money")).toBe(true);
    expect(typeMatches("Club Store B", "money")).toBe(false);
  });
});

describe("narrow", () => {
  it("takes the payload down to the leaves that could be a price", () => {
    const candidates = narrow(samples(), { type: "money", pageText: PAGE_TEXT });
    const spellings = candidates.flatMap((candidate) => [candidate.path, ...candidate.aliases]);
    expect(spellings).toContain("productData.prices[price-list-std]");
    expect(spellings).toContain("productData.prices[price-sale-std]");
    // Telemetry, SEO strings and ids are gone without anything naming them.
    expect(spellings.some((path) => path.includes("telemetry"))).toBe(false);
    expect(spellings.some((path) => path.includes("seo"))).toBe(false);
    // A product name carrying "100 mg" is not a money candidate.
    expect(spellings).not.toContain("productData.name");
    // Four distinct values survive from 60-odd leaves: list, sale, per-unit, stock.
    expect(candidates.length).toBeLessThanOrEqual(4);
  });

  it("drops a leaf that is not on every sample", () => {
    // The club promotion exists on the first page only.
    const paths = narrow(samples(), { type: "money", pageText: PAGE_TEXT }).map((c) => c.path);
    expect(paths).not.toContain("productData.promotions[1].promotionalPrice");
  });

  it("drops a leaf whose value never changes, which is the rule that catches a site name", () => {
    const constant: Leaf[][] = [
      [{ path: "a.brand", value: "StoreA" }, { path: "a.name", value: "Paracetamol" }],
      [{ path: "a.brand", value: "StoreA" }, { path: "a.name", value: "Ibuprofeno" }],
    ];
    expect(narrow(constant).map((c) => c.path)).toEqual(["a.name"]);
    expect(narrow(constant, { requireVariation: false }).map((c) => c.path)).toEqual(["a.brand", "a.name"]);
  });
});

describe("bindField — the bank's first consumer", () => {
  it("binds the list price to the payload key that names it, with no model call", () => {
    const binding = bindField("listPrice", samples(), { type: "money", pageText: PAGE_TEXT });
    expect(binding.path).toBe("productData.prices[price-list-std]");
    expect(binding.values).toEqual([4990, 12990]);
    expect(binding.askModel).toBe(false);
    expect(binding.verdicts[0]!.id).toBe("key-names-carry-the-signal");
    // The payload states the same number twice; the generic spelling rides along.
    expect(binding.aliases).toContain("productData.price");
  });

  it("binds the promotional price to the other one, from the same table", () => {
    const binding = bindField("promoPrice", samples(), { type: "money", pageText: PAGE_TEXT });
    expect(binding.path).toBe("productData.prices[price-sale-std]");
    expect(binding.values).toEqual([4491, 11691]);
    expect(binding.askModel).toBe(false);
    expect(binding.aliases).toContain("productData.appliedPromotions[price-sale-std].promotionalPrice");
  });

  it("asks a model only when the names do not settle it, and then only over what survived", () => {
    const ambiguous: Leaf[][] = [
      [{ path: "a.amount", value: 4990 }, { path: "b.total", value: 12990 }],
      [{ path: "a.amount", value: 1990 }, { path: "b.total", value: 2990 }],
    ];
    const binding = bindField("listPrice", ambiguous, { type: "money" });
    expect(binding.askModel).toBe(true);
    expect(binding.candidates).toHaveLength(2);
    expect(binding.path).toBeUndefined();
  });

  it("takes a lone survivor without asking anyone", () => {
    const one: Leaf[][] = [[{ path: "a.amount", value: 4990 }], [{ path: "a.amount", value: 1990 }]];
    const binding = bindField("listPrice", one, { type: "money" });
    expect(binding.path).toBe("a.amount");
    expect(binding.askModel).toBe(false);
    expect(binding.because).toContain("the only value that survived");
  });

  it("says so rather than guessing when nothing survives", () => {
    const binding = bindField("listPrice", [[{ path: "a.name", value: "Paracetamol" }]], { type: "money" });
    expect(binding.candidates).toEqual([]);
    expect(binding.askModel).toBe(false);
    expect(binding.because).toContain("no captured leaf survived");
  });

  it("honours a case override: a silenced heuristic sends the table to the model", () => {
    const view = bank({ "key-names-carry-the-signal": { enabled: false, note: "client: key names are misleading on this site" } });
    const binding = bindField("listPrice", samples(), { type: "money", pageText: PAGE_TEXT, view });
    expect(binding.askModel).toBe(true);
    expect(binding.verdicts[0]!.verdict.because).toContain("disabled for this case");
  });
});
