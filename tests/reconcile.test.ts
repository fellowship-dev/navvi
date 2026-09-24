import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchors, flatten, narrow, type Leaf } from "../src/investigate/leaves.js";
import type { FieldRecord, InventoryRecord, Manuscript } from "../src/investigate/manuscript.js";
import type { TypedValue } from "../src/scraper/extract.js";
import { outputSchema, reconcile, render, renderOutputSchema, summarize } from "../src/reconcile/index.js";
import type { Spec } from "../src/spec/schema.js";

/**
 * U4 and U5: the manuscript argued, and the schema that argument proves.
 *
 * Offline, and the fixtures are the synthetic Store-B-shaped payloads that
 * already live in `tests/fixtures/investigate/` — real key names, invented
 * values, because navvi is a public repository and a client's catalogue is not
 * test data. The manuscript below is built by hand from those payloads rather
 * than by running `investigate`, so this file tests the argument and not the
 * cascade; the values in it come out of `flatten` and `narrow`, so it cannot
 * quietly disagree with what a real run would have recorded.
 */

const DIR = join(import.meta.dirname, "fixtures", "investigate");
const MATCH = "catalog-svc/products/detail";

const payloads = (["", "-2", "-3"] as const).map((n) => JSON.parse(readFileSync(join(DIR, `store-b-detail${n}.json`), "utf8")) as unknown);
const samples: Leaf[][] = payloads.map((payload) => flatten(payload));

/**
 * What each sample page showed a reader. Synthetic and written to agree with
 * the payload above it, because anchoring is the signal that separates a fact
 * about the product from a fact about the session, and a test that supplies no
 * page text is testing the weaker half of the rule.
 */
const PAGE_TEXT = [
  "Ejemplo Comprimidos 100 mg 30 Comprimidos $ 4.990 $ 4.491 Precio por Unidad Fraccionada: $ 166 por Comprimido Laboratorio Ejemplo",
  "Otro Jarabe 120 ml $ 12.990 $ 11.691 Precio por Unidad Fraccionada: $ 108 por ml Laboratorio Otro",
  "Tercero Capsulas 500 mg 16 Capsulas $ 7.490 $ 6.741 Precio por Unidad Fraccionada: $ 468 por Capsula Laboratorio Tercero",
];

/**
 * The leaf catalogue `Manuscript.inventory` carries, built the way
 * `investigate.ts` has to build it: every path present on every answering
 * sample, with the anchor question answered where the rendered text is.
 *
 * No type filter. That is the whole difference between this and the rejection
 * set, and the reason `bioequivalence` and `stock` are visible at all.
 */
function inventory(): InventoryRecord[] {
  const byPath = new Map<string, Array<Leaf["value"]>>();
  for (const [index, leaves] of samples.entries()) {
    for (const leaf of leaves) {
      let values = byPath.get(leaf.path);
      if (!values) byPath.set(leaf.path, (values = Array.from({ length: samples.length }, () => undefined as never)));
      values[index] = leaf.value;
    }
  }
  const out: InventoryRecord[] = [];
  for (const [path, values] of byPath) {
    if (values.some((value) => value === undefined)) continue;
    out.push({ match: MATCH, path, values, anchored: values.every((value, index) => anchors(value, PAGE_TEXT[index]!)) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The money candidates a real tier-2 run would have had for a price field. */
function moneyCandidates() {
  return narrow(samples, { type: "money", pageText: PAGE_TEXT });
}

function record(over: Partial<FieldRecord> & { field: string }): FieldRecord {
  return { aliases: [], because: "", askModel: false, rejected: [], verdicts: [], ...over };
}

function manuscript(over: Partial<Manuscript> = {}): Manuscript {
  const money = moneyCandidates();
  /**
   * `narrow` leads each fact with its shallowest spelling, so the money table
   * comes back led by `productData.price` with `prices[price-list-std]` as its
   * alias. A real tier-2 run then re-leads it on the key name, which is what
   * `key-names-carry-the-signal` is for, so the fixture binds the named path
   * and keeps the shallow one as the free alternative.
   */
  const fact = (path: string) => money.find((candidate) => candidate.path === path || candidate.aliases.includes(path))!;
  // A tier-2 alias is another leaf of the same payload, so it is read through
  // the same endpoint as the binding - which is the one case where the old bare
  // path was a complete alternative, and is now said rather than assumed.
  const lead = (path: string, candidate: { path: string; values: TypedValue[]; aliases: string[] }) => ({
    path,
    values: candidate.values,
    aliases: [candidate.path, ...candidate.aliases]
      .filter((alias) => alias !== path)
      .map((alias) => ({ path: alias, source: "network" as const, match: MATCH })),
  });
  const listPrice = lead("productData.prices[price-list-std]", fact("productData.prices[price-list-std]"));
  const salePrice = lead("productData.prices[price-sale-std]", fact("productData.prices[price-sale-std]"));
  const pum = lead("productData.pum.value", fact("productData.pum.value"));
  const name = samples.map((leaves) => leaves.find((leaf) => leaf.path === "productData.name")!.value);

  return {
    version: 1,
    site: "store-b.example",
    recordedAt: "2026-09-23T12:00:00.000Z",
    requested: [
      { name: "productName", type: "text" },
      { name: "sku", type: "text" },
      { name: "listPrice", type: "money" },
      { name: "promoPrice", type: "money" },
      { name: "stock", type: "boolean" },
    ],
    sample: { because: "three products spanning discounted and undiscounted", considered: 108, picks: [], unfilled: [], excluded: [] },
    tiers: [
      { tier: 1, name: "declared", outcome: "skipped", because: "shell-skips-tier-1 fired", asked: [], covered: [], sources: [], verdicts: [] },
      {
        tier: 2,
        name: "payload",
        outcome: "ran",
        because: "1 endpoint the page fetched for itself, over 3 rendered sample(s)",
        asked: ["productName", "sku", "listPrice", "promoPrice", "stock"],
        covered: ["productName", "listPrice", "promoPrice"],
        sources: [{ url: `https://example.test/${MATCH}`, kind: "payload", status: 200, match: MATCH, found: samples[0]!.length, because: "the page fetched this for itself" }],
        verdicts: [],
      },
      { tier: 3, name: "dom", outcome: "requested", because: "sku, stock survived both cheap tiers", asked: ["sku", "stock"], covered: [], sources: [], verdicts: [] },
    ],
    fields: [
      record({
        field: "productName",
        type: "text",
        tier: 2,
        source: "network",
        match: MATCH,
        path: "productData.name",
        values: name,
        because: "key-names-carry-the-signal fired on productData.name",
      }),
      record({ field: "sku", type: "text", because: "no tier that ran offered a candidate for this field" }),
      record({
        field: "listPrice",
        type: "money",
        tier: 2,
        source: "network",
        match: MATCH,
        path: listPrice.path,
        values: listPrice.values,
        aliases: listPrice.aliases,
        because: "key-names-carry-the-signal fired on price-list-std",
        rejected: [
          { tier: 2, path: `${MATCH}:${salePrice.path}`, values: salePrice.values, because: "productData.prices[price-list-std] was bound instead" },
          { tier: 2, path: `${MATCH}:${pum.path}`, values: pum.values, because: "productData.prices[price-list-std] was bound instead" },
        ],
      }),
      record({
        field: "promoPrice",
        type: "money",
        tier: 2,
        source: "network",
        match: MATCH,
        path: salePrice.path,
        values: salePrice.values,
        aliases: salePrice.aliases,
        because: "key-names-carry-the-signal fired on price-sale-std",
        rejected: [{ tier: 2, path: `${MATCH}:${pum.path}`, values: pum.values, because: "productData.prices[price-sale-std] was bound instead" }],
      }),
      record({ field: "stock", type: "boolean", because: "no tier that ran offered a candidate for this field" }),
    ],
    uncovered: ["sku", "stock"],
    inventory: inventory(),
    obstacles: [
      { kind: "consent", url: "https://example.test/", because: 'a consent dialog labelled "Aceptar" stood between the fetch and the page', blocking: false },
      { kind: "shell", because: "312 chars of visible text and 4 script bundles: the plain fetch returns no product", blocking: false },
    ],
    canaryBecause: "recorded off the first sample",
    verdict: "partial",
    because: "3 of 5 requested fields bound",
    ...over,
  };
}

const SPEC: Spec = {
  version: 1,
  brief: "I need the product info of a dynamic set of products in Store B.",
  target: { site: "store-b.example", pageKind: "product", provenance: "brief" },
  entity: { name: "product", provenance: "brief" },
  inputs: { shape: "url_list", description: "a dynamic set of products", provenance: "brief" },
  fields: [
    { name: "productName", provenance: "inferred" },
    { name: "sku", provenance: "inferred" },
    { name: "listPrice", provenance: "inferred" },
    { name: "promoPrice", provenance: "inferred" },
    { name: "stock", provenance: "inferred" },
  ],
  constraints: { freshness: { stated: false }, volume: { stated: false }, cadence: { stated: false }, budget: { stated: false } },
  rubrics: [{ id: "client/list-price", rule: "the list price is the crossed-out one and never Precio Club", source: "client/rubrics.json" }],
  openQuestions: [],
};

const AT = new Date("2026-09-23T15:04:05.000Z");

describe("reconcile: obtainable and not obtainable", () => {
  it("names each bound field with where it came from, and each unbound one with why", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });

    expect(result.obtainable.map((field) => field.field)).toEqual(["productName", "listPrice", "promoPrice"]);
    const listPrice = result.obtainable.find((field) => field.field === "listPrice")!;
    expect(listPrice.where).toBe("network catalog-svc/products/detail productData.prices[price-list-std]");
    expect(listPrice.type).toBe("money");
    expect(listPrice.typeInferred).toBe(false);
    expect(listPrice.values).toEqual([4990, 12990, 7490]);
    // `productData.price` states the same fact; the compile gets it for free.
    // Each alias says how it is read, not only where: for a tier-2 binding
    // that is the endpoint the leaf came out of.
    expect(listPrice.aliases).toContainEqual({ path: "productData.price", source: "network", match: MATCH });

    const sku = result.notObtainable.find((field) => field.field === "sku")!;
    expect(sku.kind).toBe("no-candidate");
    expect(sku.because).toBe("no tier that ran offered a candidate for this field");
    // Tier 3 was handed it, so "not obtainable" is not yet "impossible".
    expect(sku.stillAsked).toBe(true);
  });
});

/**
 * U3 (R4) at the artifact the compile reads. `investigate` no longer writes a
 * manuscript that binds two fields to one path, but `make` reuses a current
 * `investigation.json`, and one written before 2026-09-23 — the live run that
 * bound `sku` and `stock` both to a recommendations `total` — would otherwise
 * compile the collision it recorded.
 */
describe("reconcile: one reading is one fact", () => {
  const collided = (): Manuscript => {
    const base = manuscript();
    const shared = { tier: 2 as const, source: "network" as const, match: "catalog-svc/products/recommendations", path: "total", values: [8, 12, 9] };
    return {
      ...base,
      fields: base.fields.map((entry) =>
        entry.field === "sku" || entry.field === "stock" ? record({ field: entry.field, type: entry.type!, ...shared, because: "total is the only value that survived the filter" }) : entry,
      ),
    };
  };

  it("names both fields not obtainable, with the path they shared, and binds neither", () => {
    const result = reconcile(collided(), SPEC, { now: AT });
    expect(result.obtainable.map((field) => field.field)).toEqual(["productName", "listPrice", "promoPrice"]);
    for (const [name, other] of [
      ["sku", "stock"],
      ["stock", "sku"],
    ] as const) {
      const field = result.notObtainable.find((entry) => entry.field === name)!;
      expect(field.kind, name).toBe("shared-path");
      expect(field.because, name).toContain("catalog-svc/products/recommendations:total");
      expect(field.because, name).toContain(other);
    }
    expect(render(result)).toContain("shared path");
  });

  it("does not offer a leaf a bank rule refused as a second reading of a bound field", () => {
    const base = manuscript();
    const withMachinery: Manuscript = {
      ...base,
      fields: base.fields.map((entry) =>
        entry.field === "productName"
          ? {
              ...entry,
              rejected: [
                {
                  tier: 2,
                  path: `${MATCH}:meta.trace`,
                  values: ["k3x9q2m7z4w8p1v6", "a7f2c9e4b1d8g5h3", "m4n8p2q6r1s5t9v3"],
                  because: "machine-value-is-not-a-fact: no page showed productName at meta.trace to a reader",
                  heuristic: "machine-value-is-not-a-fact",
                },
              ],
            }
          : entry,
      ),
    };
    const result = reconcile(withMachinery, SPEC, { now: AT });
    expect(result.ambiguities.some((ambiguity) => ambiguity.field === "productName")).toBe(false);
  });
});

describe("reconcile: available but not requested", () => {
  it("names laboratory, activeIngredient, bioequivalence and pum, none of which was asked for", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });
    const paths = result.available.map((leaf) => leaf.path);

    expect(paths).toContain("productData.laboratory");
    expect(paths).toContain("productData.activeIngredient");
    expect(paths).toContain("productData.bioequivalence");
    expect(paths).toContain("productData.pum.value");
    expect(paths).toContain("productData.pum.unit");
    expect(result.availableEvidence).toBe("inventory");
  });

  it("keeps a bound field and its aliases out, and the requested-but-unbound out too", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });
    const paths = result.available.map((leaf) => leaf.path);

    expect(paths).not.toContain("productData.name");
    expect(paths).not.toContain("productData.prices[price-list-std]");
    // An alias of a bound field is the same fact, not a second offer.
    expect(paths).not.toContain("productData.price");
    // `stock` was asked for; it is a type gap below, never "nobody wanted it".
    expect(paths).not.toContain("productData.stock");
  });

  it("orders by evidence rather than by name, so what a reader saw sorts above telemetry", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });
    const at = (path: string): number => result.available.findIndex((leaf) => leaf.path === path);

    expect(at("productData.laboratory")).toBeLessThan(at("productData.telemetry.sessionId"));
    expect(result.available.find((leaf) => leaf.path === "productData.laboratory")!.anchored).toBe(true);
    // Surfaced and labelled rather than hidden by a word list nobody can check.
    expect(result.available.find((leaf) => leaf.path === "productData.telemetry.sessionId")!.anchored).toBe(false);
  });

  it("names productData.id, which is the sku the spec could not bind", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });
    expect(result.available.map((leaf) => leaf.path)).toContain("productData.id");
  });

  /**
   * U6c. `machine-value-is-not-a-fact` was the twelfth heuristic in the bank
   * and, until this, the only one nothing in `src/` executed.
   * `telemetry.renderedAt` reached the bottom of this list by a bare
   * arithmetic rank — not anchored, so one point — which is the same rank an
   * ordinary declared leaf gets on a tier that never anchored anything, and
   * the row carried no sentence a client could disagree with. The rank *was*
   * the judgement "this is the machine talking to itself", and it was made
   * silently.
   */
  it("says why a leaf is the machine's bookkeeping instead of only sorting it last", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });
    const at = (path: string): number => result.available.findIndex((leaf) => leaf.path === path);
    const renderedAt = result.available.find((leaf) => leaf.path === "productData.telemetry.renderedAt");

    expect(renderedAt, "the leaf is still offered to the client; the rule ranks it, it does not delete it").toBeDefined();
    expect(renderedAt!.machinery?.heuristic).toBe("machine-value-is-not-a-fact");
    expect(renderedAt!.machinery?.because).toContain("epoch milliseconds");
    // The path agreeing is said after the evidence, never instead of it.
    expect(renderedAt!.machinery?.because).toContain('the path names "telemetry" too');
    expect(renderedAt!.machinery?.action).toContain("not a fact about the record");
    expect(renderedAt!.because).toContain("the machine's own bookkeeping");

    // It sorts below every leaf the rule did not fire on — including the
    // session id, which the rule deliberately declines on because its value is
    // six characters and a key name decides nothing here.
    const sessionId = result.available.find((leaf) => leaf.path === "productData.telemetry.sessionId")!;
    expect(sessionId.machinery, "declining is not firing, and the row must not claim a reason it was not given").toBeUndefined();
    expect(at("productData.telemetry.sessionId")).toBeLessThan(at("productData.telemetry.renderedAt"));
    expect(at("productData.laboratory")).toBeLessThan(at("productData.telemetry.renderedAt"));
  });

  it("puts the rule's sentence in reconcile.md, which is where a client dismisses the row", () => {
    const md = render(reconcile(manuscript(), SPEC, { now: AT }));
    expect(md).toContain("| `machine-value-is-not-a-fact` |");
    expect(md).toContain("The last rows are there because a rule said so, not because the count came out low:");
    expect(md).toContain("epoch milliseconds");
  });

  it("a case that switches the rule off ranks the leaf like any other, and claims no reason it was not given", () => {
    const off = reconcile(manuscript(), SPEC, {
      now: AT,
      heuristics: { "machine-value-is-not-a-fact": { enabled: false, note: "this case ranks every payload leaf alike" } },
    });
    const renderedAt = off.available.find((leaf) => leaf.path === "productData.telemetry.renderedAt")!;
    expect(renderedAt.machinery).toBeUndefined();
    expect(renderedAt.because).not.toContain("bookkeeping");
    expect(render(off)).not.toContain("The last rows are there because a rule said so");
  });

  it("drops a leaf that neither moves nor was ever shown", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });
    const paths = result.available.map((leaf) => leaf.path);
    // `promotionId` is "SALE-10" on all three samples and is nowhere in the
    // rendered text: nothing says it describes this product rather than the site.
    expect(paths).not.toContain("productData.appliedPromotions[price-sale-std].promotionId");
  });
});

describe("reconcile: the stock type gap", () => {
  it("names both types rather than reporting stock as simply not obtainable", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });

    const gap = result.ambiguities.find((ambiguity) => ambiguity.id === "stock/type-gap")!;
    expect(gap.kind).toBe("type-gap");
    expect(gap.declaredType).toBe("boolean");
    expect(gap.statedType).toBe("integer");
    expect(gap.readings[0]!.path).toBe("productData.stock");
    expect(gap.readings[0]!.values).toEqual([412, 57, 33]);
    expect(gap.decision).toContain("how many?");
    expect(gap.because).toContain("dropped it before it was a candidate");

    const stock = result.notObtainable.find((field) => field.field === "stock")!;
    expect(stock.kind).toBe("type-gap");
    expect(stock.ambiguity).toBe("stock/type-gap");
    expect(stock.because).toContain("not obtainable *as declared*");
  });

  it("does not coerce and does not invent a binding", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });
    expect(result.obtainable.map((field) => field.field)).not.toContain("stock");
    expect(result.verdict).toBe("open");
  });
});

describe("reconcile: ambiguities and the rubric that settled them", () => {
  it("quotes the rule verbatim beside the binding", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });

    const ambiguity = result.ambiguities.find((entry) => entry.id === "listPrice/competing-values")!;
    expect(ambiguity.readings.map((reading) => reading.path)).toEqual([
      "productData.prices[price-list-std]",
      "productData.prices[price-sale-std]",
      "productData.pum.value",
    ]);
    expect(ambiguity.readings[0]!.bound).toBe(true);
    expect(ambiguity.settledBy).toHaveLength(1);
    expect(ambiguity.settledBy[0]!.id).toBe("client/list-price");
    expect(ambiguity.settledBy[0]!.rule).toBe("the list price is the crossed-out one and never Precio Club");
    expect(ambiguity.resolved).toBe("productData.prices[price-list-std]");
    expect(ambiguity.because).toContain("Without the rule this stops.");
  });

  it("leaves an ambiguity open, with the decision named, when the spec carries no rule", () => {
    const result = reconcile(manuscript(), { ...SPEC, rubrics: [] }, { now: AT });

    const ambiguity = result.ambiguities.find((entry) => entry.id === "listPrice/competing-values")!;
    expect(ambiguity.settledBy).toEqual([]);
    expect(ambiguity.decision).toContain("has to say which one they mean");
    expect(result.verdict).toBe("open");
  });

  it("does not call two spellings of one value an ambiguity", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });
    // promoPrice's alias `appliedPromotions[price-sale-std].promotionalPrice`
    // agrees with it on every sample, so it is a free alternative and not a
    // second reading. Only `pum.value` disagrees.
    const ambiguity = result.ambiguities.find((entry) => entry.id === "promoPrice/competing-values")!;
    expect(ambiguity.readings).toHaveLength(2);
    expect(ambiguity.readings.map((reading) => reading.path)).not.toContain("productData.appliedPromotions[price-sale-std].promotionalPrice");
  });
});

describe("reconcile: obstacles with cost", () => {
  it("says what each one keeps charging, not only that it was met", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });

    const consent = result.obstacles.find((obstacle) => obstacle.kind === "consent")!;
    expect(consent.cost).toContain("a prestep on every page");
    const shell = result.obstacles.find((obstacle) => obstacle.kind === "shell")!;
    expect(shell.cost).toContain("every URL pays for a render");
    expect(shell.blocking).toBe(false);
  });

  it("marks a blocking obstacle as blocking in the cost itself", () => {
    const blocked = manuscript({ obstacles: [{ kind: "challenge", because: "Incapsula refused three of three", blocking: true }] });
    const result = reconcile(blocked, SPEC, { now: AT });
    expect(result.obstacles[0]!.cost.startsWith("blocking - ")).toBe(true);
    expect(result.verdict).toBe("open");
  });
});

describe("reconcile: the artifact's two disciplines", () => {
  it("is JSON-serialisable, with no Map, Date or class instance in it", () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("is stable: the same manuscript and the same clock produce the same bytes", () => {
    const one = reconcile(manuscript(), SPEC, { now: AT });
    const two = reconcile(manuscript(), SPEC, { now: AT });
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(render(two)).toBe(render(one));
  });

  it("takes its one moving field from the injected clock", () => {
    expect(reconcile(manuscript(), SPEC, { now: AT }).reconciledAt).toBe("2026-09-23T15:04:05.000Z");
    expect(reconcile(manuscript(), SPEC, { now: new Date("2027-01-01T00:00:00.000Z") }).reconciledAt).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("reconcile.md", () => {
  it("carries the rule verbatim, so a binding is checkable without replaying the site", () => {
    const markdown = render(reconcile(manuscript(), SPEC, { now: AT }));

    expect(markdown).toContain("# Reconciliation: store-b.example");
    expect(markdown).toContain("## Obtainable (3 of 5)");
    expect(markdown).toContain("## Available but not requested");
    expect(markdown).toContain('"the list price is the crossed-out one and never Precio Club"');
    expect(markdown).toContain("**Without the rule this stops.**");
    expect(markdown).toContain("| `boolean` | `integer` |");
    expect(markdown).toContain("productData.laboratory");
  });

  it("prints the stage block the driver shows while the run is happening", () => {
    const block = summarize(reconcile(manuscript(), SPEC, { now: AT }), "work/storeb/reconcile.md");

    expect(block).toContain("work/storeb/reconcile.md");
    expect(block).toContain("obtainable          3 of 5, all from catalog-svc/products/detail");
    // The plan's acceptance case for U4, on one line of the stage block.
    expect(block).toContain("not requested       activeIngredient, laboratory, pum.unit, pum.value, seo.metaTitle, bioequivalence, +5 more");
    expect(block).toContain("ambiguity resolved  listPrice: price-list-std 4990 | price-sale-std 4491 | value 166");
    expect(block).toContain('rubric client/list-price: "the list price is the crossed-out one and never Precio Club"');
    expect(block).toContain("-> price-list-std   (without the rubric this stops)");
    expect(block).toContain("the spec asks for boolean, the site states integer");
  });
});

describe("without Manuscript.inventory", () => {
  /**
   * The honest degradation, pinned so it cannot be mistaken for the real thing.
   *
   * A manuscript with no leaf catalogue can only be read through the rejection
   * set, which holds leaves that lost a competition for a field the brief
   * *did* name. That set is filtered by those fields' declared types before
   * anything is written down, so it cannot see a boolean nobody asked about
   * and cannot see the integer `stock` the type filter dropped.
   */
  const thin = (): Manuscript => {
    const { inventory: _drop, ...rest } = manuscript();
    return rest as Manuscript;
  };

  it("says in the artifact that the catalogue is incomplete", () => {
    const result = reconcile(thin(), SPEC, { now: AT });
    expect(result.availableEvidence).toBe("rejected");
    expect(render(result)).toContain("**Incomplete.**");
    expect(summarize(result)).toContain("! read off the rejection set");
  });

  it("cannot see bioequivalence, because nothing asked for a boolean", () => {
    const paths = reconcile(thin(), SPEC, { now: AT }).available.map((leaf) => leaf.path);
    expect(paths).toContain("productData.pum.value");
    expect(paths).not.toContain("productData.bioequivalence");
    expect(paths).not.toContain("productData.laboratory");
  });

  it("reports stock as a plain absence, which is the fact the inventory exists to fix", () => {
    const result = reconcile(thin(), SPEC, { now: AT });
    expect(result.ambiguities.map((ambiguity) => ambiguity.id)).not.toContain("stock/type-gap");
    expect(result.notObtainable.find((field) => field.field === "stock")!.kind).toBe("no-candidate");
  });
});

describe("U5: the output schema", () => {
  it('resolves "product info" to typed fields, each naming its source', () => {
    const result = reconcile(manuscript(), SPEC, { now: AT });
    const schema = outputSchema(result, SPEC, { now: AT });

    expect(schema.entity).toBe("product");
    expect(schema.fields.map((field) => [field.name, field.type, field.source])).toEqual([
      ["productName", "text", "network"],
      ["listPrice", "money", "network"],
      ["promoPrice", "money", "network"],
    ]);
    for (const field of schema.fields) {
      expect(field.match).toBe(MATCH);
      expect(field.path).toBeDefined();
      expect(field.because).toContain("proved at tier 2");
    }
    expect(schema.fields[1]!.example).toBe(4990);
  });

  it("omits what was not proved, and says so rather than asserting it", () => {
    const schema = outputSchema(reconcile(manuscript(), SPEC, { now: AT }), SPEC, { now: AT });

    expect(schema.fields.map((field) => field.name)).not.toContain("stock");
    expect(schema.omitted.map((field) => field.name)).toEqual(["sku", "stock"]);
    expect(schema.omitted[1]!.because).toContain("not obtainable *as declared*");
  });

  it("is derived from the evidence, not from the spec: an unbound field cannot appear", () => {
    const nothing = manuscript({
      fields: manuscript().fields.map((field) => ({ ...field, tier: undefined, source: undefined, path: undefined })),
    });
    const schema = outputSchema(reconcile(nothing, SPEC, { now: AT }), SPEC, { now: AT });
    expect(schema.fields).toEqual([]);
    expect(schema.omitted).toHaveLength(5);
  });

  it("infers a type off the values when the spec declared none, and never infers money", () => {
    const open = manuscript({ requested: manuscript().requested.map((field) => ({ name: field.name })), fields: manuscript().fields.map((field) => ({ ...field, type: undefined })) });
    const schema = outputSchema(reconcile(open, SPEC, { now: AT }), SPEC, { now: AT });

    const listPrice = schema.fields.find((field) => field.name === "listPrice")!;
    expect(listPrice.type).toBe("integer");
    expect(listPrice.typeInferred).toBe(true);
    expect(listPrice.because).toContain("never `money`");
  });

  it("writes stable JSON with an injected clock", () => {
    const schema = outputSchema(reconcile(manuscript(), SPEC, { now: AT }), SPEC, { now: AT });
    expect(schema.derivedAt).toBe("2026-09-23T15:04:05.000Z");
    expect(renderOutputSchema(schema)).toBe(renderOutputSchema(outputSchema(reconcile(manuscript(), SPEC, { now: AT }), SPEC, { now: AT })));
    expect(JSON.parse(renderOutputSchema(schema))).toEqual(schema);
  });
});
