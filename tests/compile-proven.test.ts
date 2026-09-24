import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import type { CapturedResponse } from "../src/browser/network-capture.js";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { NothingCompilableError, compileFromReconciliation, renderRationale } from "../src/compile/index.js";
import { REFUSE_FALLBACK, REFUSE_SOLE, auditSelector } from "../src/compile/gate.js";import type { FieldAlias, FieldRecord, InventoryRecord, Manuscript } from "../src/investigate/manuscript.js";
import { reconcile } from "../src/reconcile/index.js";
import { coerceValues, extractPage, fieldTypesOf } from "../src/scraper/extract.js";
import type { Spec } from "../src/spec/schema.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U7a: the seam, and the proof that it is one.
 *
 * Until this file, `src/investigate/` and the declared half of
 * `src/scraper/extract.ts` were two programs. The investigation proved where a
 * value is stated and wrote it into a manuscript; the cascade resolved
 * `json-ld` and `network` alternatives at replay; and nothing in `src/` ever
 * turned the first into the second — the only producer of a declared
 * alternative in the whole repository was a literal in
 * `tests/cascade-extract.test.ts`. Two halves, each green on its own fixture,
 * which is the exact shape of all four defects of 2026-09-22.
 *
 * So the test that matters here is not "does the compiler emit the object I
 * expect". It is **the round trip**: a manuscript is reconciled, the
 * reconciliation is compiled, and the compiled scraper is then run through the
 * real `extractPage` against a real browser, a real page and real captured
 * responses — and it has to give back the values the investigation recorded.
 * Anything less would be a third program.
 *
 * The fixtures are synthetic. The *shapes* are the ones investigated on
 * 2026-09-22 — a JSON-LD `@graph` with the store's Organization ahead of the
 * Product, a detail endpoint that answers 401 before its session exists, a
 * payload keyed by dashed currency codes — and the content is invented, because
 * navvi is a public repository and a client's catalogue is not test data.
 */

const DIR = join(import.meta.dirname, "fixtures", "compile");
const PAYLOAD = JSON.parse(readFileSync(join(DIR, "detail-payload.json"), "utf8")) as unknown;
const MATCH = "catalog-svc/products/detail";
const LD_JSON = 'script[type="application/ld+json"]';

/**
 * Sample 1 is the page and the payload in `tests/fixtures/compile/`; samples 2
 * and 3 are two more products off the same template, written here as literals.
 *
 * They are literals on purpose. Deriving them from the fixture with the same
 * reader replay uses would make the round trip below assert that a function
 * agrees with itself. What has to be proved is that a value written into the
 * manuscript by the investigation comes back out of `extractPage` — so the
 * value is written twice, once in the fixture and once here, and the compiled
 * scraper is the only thing connecting them.
 */
const NAMES = ["Antigripal Comprimidos 500 mg 20 Comprimidos", "Jarabe Ejemplo 120 ml", "Capsulas Ejemplo 500 mg 16 Capsulas"];
const SKUS = ["100001", "100002", "100003"];
const LIST = [4990, 12990, 7490];
const SALE = [4491, 11691, 6741];
const STOCK = [412, 57, 33];

/** Tier-2 aliases: other leaves of the endpoint the binding came out of. */
const netAliases = (...paths: string[]): FieldAlias[] => paths.map((path) => ({ path, source: "network", match: MATCH }));

function record(over: Partial<FieldRecord> & { field: string }): FieldRecord {
  return { aliases: [], because: "", askModel: false, rejected: [], verdicts: [], ...over };
}

/**
 * The leaf catalogue tier 2 committed, trimmed to what this file argues about:
 * the integer `stock` the declared `boolean` refused before it was ever a
 * candidate, and one leaf nobody asked for.
 */
function inventory(): InventoryRecord[] {
  return [
    { match: MATCH, path: "productData.stock", values: STOCK, anchored: false },
    { match: MATCH, path: "productData.laboratory", values: ["Laboratorio Ejemplo", "Laboratorio Otro", "Laboratorio Tercero"], anchored: true },
  ];
}

function manuscript(over: Partial<Manuscript> = {}): Manuscript {
  return {
    version: 1,
    site: "tienda.ejemplo.test",
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
      {
        tier: 1,
        name: "declared",
        outcome: "ran",
        because: "the plain fetch declares a Product",
        asked: ["productName", "sku", "listPrice", "promoPrice", "stock"],
        covered: ["productName", "sku"],
        sources: [{ url: "https://tienda.ejemplo.test/p/100001", kind: "plain-fetch", status: 200, found: 9, because: "the page states what it is in its own head" }],
        verdicts: [],
      },
      {
        tier: 2,
        name: "payload",
        outcome: "ran",
        because: "1 endpoint the page fetched for itself, over 3 rendered sample(s)",
        asked: ["listPrice", "promoPrice", "stock"],
        covered: ["listPrice", "promoPrice"],
        sources: [{ url: `https://api.ejemplo.test/${MATCH}/100001`, kind: "payload", status: 200, match: MATCH, found: 14, because: "the page fetched this for itself" }],
        verdicts: [],
      },
      { tier: 3, name: "dom", outcome: "requested", because: "stock survived both cheap tiers", asked: ["stock"], covered: [], sources: [], verdicts: [] },
    ],
    fields: [
      record({
        field: "productName",
        type: "text",
        tier: 1,
        source: "json-ld",
        path: "name",
        entity: "Product",
        selector: LD_JSON,
        values: NAMES,
        because: "the page declares productName as json-ld name off its Product node, stated about itself in one plain HTTP request",
        verdicts: [{ id: "json-ld-needs-product-node", verdict: { fires: false, because: "the block declares a Product node; read it" } }],
      }),
      record({
        field: "sku",
        type: "text",
        tier: 1,
        source: "dom",
        path: "product:retailer_item_id",
        selector: 'meta[property="product:retailer_item_id"]',
        attr: "content",
        values: SKUS,
        because: "the page declares sku as meta product:retailer_item_id, which rides in as a dom alternative because a meta tag is an element of the document",
      }),
      record({
        field: "listPrice",
        type: "money",
        tier: 2,
        source: "network",
        match: MATCH,
        path: "productData.prices[price-list-std]",
        values: LIST,
        aliases: netAliases("productData.price", "productData.listing.price", "productData.appliedPromotions[price-list-std].previousPrice"),
        because: "key-names-carry-the-signal fired on price-list-std",
        verdicts: [
          {
            id: "key-names-carry-the-signal",
            verdict: {
              fires: true,
              because: "productData.prices[price-list-std] names listPrice, ahead of productData.prices[price-sale-std]",
              action: "bind listPrice to productData.prices[price-list-std] without asking a model to search a DOM for it",
            },
          },
        ],
        rejected: [{ tier: 2, path: `${MATCH}:productData.prices[price-sale-std]`, values: SALE, because: "productData.prices[price-list-std] was bound instead" }],
      }),
      record({
        field: "promoPrice",
        type: "money",
        tier: 2,
        source: "network",
        match: MATCH,
        path: "productData.prices[price-sale-std]",
        values: SALE,
        aliases: netAliases("productData.appliedPromotions[price-sale-std].promotionalPrice"),
        because: "key-names-carry-the-signal fired on price-sale-std",
        rejected: [{ tier: 2, path: `${MATCH}:productData.prices[price-list-std]`, values: LIST, because: "productData.prices[price-sale-std] was bound instead" }],
      }),
      record({ field: "stock", type: "boolean", because: "no tier that ran offered a candidate for this field" }),
    ],
    uncovered: ["stock"],
    inventory: inventory(),
    obstacles: [],
    canaryBecause: "recorded off the first sample",
    verdict: "partial",
    because: "4 of 5 requested fields bound",
    ...over,
  };
}

const SPEC: Spec = {
  version: 1,
  brief: "I need the product info of a dynamic set of products.",
  target: { site: "tienda.ejemplo.test", pageKind: "product", provenance: "brief" },
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

function compiled(over: Partial<Manuscript> = {}, spec: Spec = SPEC) {
  const book = manuscript(over);
  const reconciliation = reconcile(book, spec, { now: AT });
  return compileFromReconciliation(reconciliation, book, spec, {
    templateKey: "tienda.ejemplo.test/p/{id}",
    entry: { mode: "direct", url: "https://tienda.ejemplo.test/p/100001" },
    now: AT,
  });
}

// ----------------------------------------------------------- the compile

describe("compiling what the investigation proved", () => {
  it("emits one alternative per reading, with the declared source the scraper has never carried before", () => {
    const { scraper } = compiled();

    expect(Object.keys(scraper.fields).sort()).toEqual(["listPrice", "productName", "promoPrice", "sku"]);

    const name = scraper.fields.productName!.alternatives[0]!;
    expect(name).toMatchObject({ source: "json-ld", path: "name", entity: "Product", selector: LD_JSON });
    // The entity is the half that stops the store's own Organization node
    // answering as the product; it comes out of the manuscript, not a guess.
    expect(name.entity).toBe("Product");

    const list = scraper.fields.listPrice!.alternatives[0]!;
    expect(list).toMatchObject({ source: "network", match: MATCH, path: "productData.prices[price-list-std]" });
    // For a network alternative `selector` is a label, and the endpoint is it:
    // tier 2 records a match and never a selector.
    expect(list.selector).toBe(MATCH);

    const sku = scraper.fields.sku!.alternatives[0]!;
    expect(sku.source).toBeUndefined();
    expect(sku).toMatchObject({ selector: 'meta[property="product:retailer_item_id"]', attr: "content" });

    // R5: replay coerces to the type the reconciliation proved.
    expect(scraper.fields.listPrice!.type).toBe("money");
    expect(scraper.fields.productName!.type).toBe("text");
  });

  it("builds the fingerprint out of the values that were actually read", () => {
    const { scraper } = compiled();
    expect(scraper.fields.listPrice!.alternatives[0]!.fingerprint).toEqual({ samples: ["4990", "12990", "7490"], shape: "int" });
    expect(scraper.fields.productName!.alternatives[0]!.fingerprint.shape).toBe("text");
  });

  /**
   * One null in the sample set is the difference between a fingerprint that
   * detects drift and one that accepts anything: `commonShape` given two
   * shapes answers `text`, and `text` matches every non-empty string there is.
   */
  it("drops a null sample rather than letting it widen the fingerprint to text", () => {
    const book = manuscript();
    const listPrice = book.fields.find((entry) => entry.field === "listPrice")!;
    listPrice.values = [4990, null, 7490];
    const reconciliation = reconcile(book, SPEC, { now: AT });
    const { scraper } = compileFromReconciliation(reconciliation, book, SPEC, {
      templateKey: "t",
      entry: { mode: "direct", url: "https://tienda.ejemplo.test/p/100001" },
      now: AT,
    });
    expect(scraper.fields.listPrice!.alternatives[0]!.fingerprint).toEqual({ samples: ["4990", "7490"], shape: "int" });
  });

  it("refuses a field whose every sample read null, because a fingerprint built from nothing accepts everything", () => {
    const book = manuscript();
    const listPrice = book.fields.find((entry) => entry.field === "listPrice")!;
    listPrice.values = [null, null, null];
    const reconciliation = reconcile(book, SPEC, { now: AT });
    const result = compileFromReconciliation(reconciliation, book, SPEC, {
      templateKey: "t",
      entry: { mode: "direct", url: "https://tienda.ejemplo.test/p/100001" },
      now: AT,
    });
    expect(result.scraper.fields.listPrice).toBeUndefined();
    expect(result.unbound.map((entry) => entry.field)).toEqual(["listPrice"]);
    expect(result.unbound[0]!.refused[0]!.because).toContain("accepts every non-empty string");
  });

  it("opens no page, launches no browser and asks no chooser", () => {
    // The whole call is synchronous, which is the cheapest possible proof: a
    // function that returns a value rather than a promise has not awaited a
    // page load, a chooser or a network round trip.
    const result = compiled();
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.scraper.trace).toEqual([]);
  });

  it("throws rather than emitting a scraper with no field", () => {
    const empty = manuscript({ fields: [record({ field: "stock", type: "boolean", because: "nothing offered a candidate" })], requested: [{ name: "stock", type: "boolean" }] });
    const reconciliation = reconcile(empty, SPEC, { now: AT });
    expect(() => compileFromReconciliation(reconciliation, empty, SPEC, { templateKey: "t", entry: { mode: "direct", url: "https://x.test/" }, now: AT })).toThrow(NothingCompilableError);
  });
});

describe("the aliases, which are free alternatives and weak evidence", () => {
  it("keeps the shallowest two behind the binding and says why the rest are not there", () => {
    const { scraper, rationale } = compiled();
    const alternatives = scraper.fields.listPrice!.alternatives;

    expect(alternatives.map((alternative) => alternative.path)).toEqual([
      "productData.prices[price-list-std]",
      "productData.price",
      "productData.listing.price",
    ]);
    // Every one of them is a complete, resolvable network alternative: the
    // same endpoint, a different path into the same payload.
    for (const alternative of alternatives) {
      expect(alternative.source).toBe("network");
      expect(alternative.match).toBe(MATCH);
    }

    const field = rationale.fields.find((entry) => entry.field === "listPrice")!;
    expect(field.uncompiled.map((entry) => entry.path)).toEqual(["productData.appliedPromotions[price-list-std].previousPrice"]);
    expect(field.uncompiled[0]!.because).toContain("cap");
  });

  /**
   * A6. A tier-1 alias used to be a bare path whose source the manuscript never
   * recorded — a JSON-LD path and an OpenGraph property are both just strings
   * in `FieldRecord.aliases` and they resolve in completely different ways, so
   * the compile refused every one of them and the rationale reported it as
   * "stated elsewhere, not compiled". That is a fact about the record's shape
   * printed as a fact about the site.
   *
   * `FieldAlias` closed it, and this is the case it closed: `productName` is
   * bound to a JSON-LD path and the same page states it again in a `<meta>`
   * tag, which rides in as `dom` with its own selector and `content`
   * attribute. Both compile, in the cascade's order.
   */
  it("compiles a tier-1 alias of a different source than its binding, in the cascade's order", () => {
    const book = manuscript();
    book.fields.find((entry) => entry.field === "productName")!.aliases = [
      { path: "og:title", source: "dom", selector: 'meta[property="og:title"]', attr: "content" },
    ];
    const reconciliation = reconcile(book, SPEC, { now: AT });
    const { scraper, rationale } = compileFromReconciliation(reconciliation, book, SPEC, {
      templateKey: "t",
      entry: { mode: "direct", url: "https://tienda.ejemplo.test/p/100001" },
      now: AT,
    });

    const alternatives = scraper.fields.productName!.alternatives;
    expect(alternatives).toHaveLength(2);
    // The declared reading leads: `TIER_RANK` is no longer a no-op, because a
    // field can now carry readings from two tiers.
    expect(alternatives[0]!.source).toBe("json-ld");
    // And the alias is emitted as what it actually is, not as a json-ld path
    // under the binding's script tag — which is the alternative that could
    // never have resolved.
    expect(alternatives[1]).toMatchObject({ selector: 'meta[property="og:title"]', attr: "content", path: "og:title" });
    expect(alternatives[1]!.source).toBeUndefined();

    const field = rationale.fields.find((entry) => entry.field === "productName")!;
    expect(field.uncompiled).toEqual([]);
    expect(field.alternatives.map((entry) => entry.source)).toEqual(["json-ld", "dom"]);
  });

  /**
   * The reading is still refused when it carries nothing to resolve itself
   * through — and the sentence says so about the alias rather than about the
   * manuscript's shape, because the shape is no longer the problem.
   */
  it("refuses an alias that names no selector of its own rather than borrowing the binding's", () => {
    const book = manuscript();
    book.fields.find((entry) => entry.field === "productName")!.aliases = [{ path: "og:title", source: "dom" }];
    const reconciliation = reconcile(book, SPEC, { now: AT });
    const { scraper, rationale } = compileFromReconciliation(reconciliation, book, SPEC, {
      templateKey: "t",
      entry: { mode: "direct", url: "https://tienda.ejemplo.test/p/100001" },
      now: AT,
    });
    expect(scraper.fields.productName!.alternatives).toHaveLength(1);
    const field = rationale.fields.find((entry) => entry.field === "productName")!;
    expect(field.uncompiled.map((entry) => entry.path)).toEqual(["og:title"]);
    expect(field.uncompiled[0]!.because).toContain("carries no selector of its own");
  });

  /**
   * Compatibility: an `investigation.json` written before `FieldAlias` spells
   * its aliases as bare strings. Nothing validates a manuscript with a schema,
   * so the file still parses, and `aliasesOf` reads a bare string as the
   * assumption the old code made silently — the binding's own source. For the
   * tier-2 case that was the only one the old compile emitted, so an old
   * artifact compiles to exactly what it always did.
   */
  it("reads an older manuscript's bare-string aliases as readings of the binding's own source", () => {
    const book = manuscript();
    const legacy = book.fields.find((entry) => entry.field === "promoPrice")!;
    (legacy as unknown as { aliases: string[] }).aliases = ["productData.appliedPromotions[price-sale-std].promotionalPrice"];
    const reconciliation = reconcile(book, SPEC, { now: AT });
    expect(reconciliation.obtainable.find((entry) => entry.field === "promoPrice")!.aliases).toEqual([
      { path: "productData.appliedPromotions[price-sale-std].promotionalPrice", source: "network", match: MATCH },
    ]);

    const { scraper } = compileFromReconciliation(reconciliation, book, SPEC, {
      templateKey: "t",
      entry: { mode: "direct", url: "https://tienda.ejemplo.test/p/100001" },
      now: AT,
    });
    expect(scraper.fields.promoPrice!.alternatives).toHaveLength(2);
    expect(scraper.fields.promoPrice!.alternatives[1]).toMatchObject({
      source: "network",
      match: MATCH,
      path: "productData.appliedPromotions[price-sale-std].promotionalPrice",
    });
  });
});

describe("the selector gate, reached through the compile", () => {
  /**
   * A6's third half. `REFUSE_FALLBACK` is the bar for an alternative sitting
   * **behind** one that already answers, and until an alias carried its own
   * source no compile could produce such a thing: a `FieldRecord` held one
   * source for a field and its aliases alike, so every alternative this compile
   * emitted was the field's first and was judged at the permissive bar. The bar
   * was asserted only by handing `gateAlternative` a selector directly, which
   * tests the gate and says nothing about whether the compile can reach it.
   *
   * A `dom` alias behind a declared binding is exactly the alternative the bar
   * was written for: reached only on the page whose markup has already moved,
   * which is where a hookless six-deep path matches the wrong element rather
   * than nothing at all.
   */
  it("holds a dom alias behind a declared binding to the fallback bar, which no compile could reach before", () => {
    // Scores 4: six combinators and nothing naming what it selects. Fragile,
    // not certain to be wrong — so the two bars disagree about it, which is the
    // only way to tell which one was applied.
    const fragile = "article > div > div > div > div > div > span";
    expect(auditSelector(fragile).score).toBe(REFUSE_FALLBACK);
    expect(auditSelector(fragile).score).toBeLessThan(REFUSE_SOLE);

    const book = manuscript();
    book.fields.find((entry) => entry.field === "productName")!.aliases = [{ path: "name", source: "dom", selector: fragile }];
    const reconciliation = reconcile(book, SPEC, { now: AT });
    const { scraper, rationale } = compileFromReconciliation(reconciliation, book, SPEC, {
      templateKey: "t",
      entry: { mode: "direct", url: "https://tienda.ejemplo.test/p/100001" },
      now: AT,
    });

    // The json-ld binding answers, so the alias is a fallback and is dropped.
    expect(scraper.fields.productName!.alternatives).toHaveLength(1);
    const field = rationale.fields.find((entry) => entry.field === "productName")!;
    expect(field.refused).toHaveLength(1);
    expect(field.refused[0]!.threshold, "the fallback bar, not the sole bar").toBe(REFUSE_FALLBACK);
    expect(field.refused[0]!.because).toContain("a fallback behind an alternative that already answers");
    // Not dropped silently: the field is still compiled and the rationale names
    // what was refused and why.
    expect(field.refused[0]!.families.sort()).toEqual(["deep-path", "no-semantic-hook"]);
  });

  it("and the same selector compiles when it is the only reading anybody has", () => {
    // The other side of the policy, through the same compile: refusing here
    // costs the column, so only a certainty may do it.
    const fragile = "article > div > div > div > div > div > span";
    const book = manuscript();
    const sku = book.fields.find((entry) => entry.field === "sku")!;
    sku.selector = fragile;
    delete sku.attr;
    const reconciliation = reconcile(book, SPEC, { now: AT });
    const { scraper } = compileFromReconciliation(reconciliation, book, SPEC, {
      templateKey: "t",
      entry: { mode: "direct", url: "https://tienda.ejemplo.test/p/100001" },
      now: AT,
    });
    expect(scraper.fields.sku!.alternatives).toHaveLength(1);
    expect(scraper.fields.sku!.alternatives[0]!.selector).toBe(fragile);
  });

  /** The same investigation with tier 1 having bound the sku off a state-class path. */
  function withRottenSku(): Manuscript {
    const book = manuscript();
    const sku = book.fields.find((entry) => entry.field === "sku")!;
    sku.selector = "body.modal-open > div.page:nth-of-type(1) > span.value";
    delete sku.attr;
    return book;
  }

  it("refuses the alternative and reports the field rather than dropping it", () => {
    const book = withRottenSku();
    const reconciliation = reconcile(book, SPEC, { now: AT });
    const result = compileFromReconciliation(reconciliation, book, SPEC, {
      templateKey: "t",
      entry: { mode: "direct", url: "https://tienda.ejemplo.test/p/100001" },
      now: AT,
    });

    expect(result.scraper.fields.sku).toBeUndefined();
    expect(result.unbound.map((entry) => entry.field)).toEqual(["sku"]);
    const refusal = result.unbound[0]!.refused[0]!;
    expect(refusal.families).toContain("transient-state-class");
    expect(refusal.because).toContain("modal-open");
    // A recompile, not a commit — and visible enough that somebody does one.
    expect(renderRationale(result.rationale)).toContain("transient-state-class");
  });

  it("leaves the other three fields compiled, because one rotten selector is not a broken run", () => {
    const book = withRottenSku();
    const reconciliation = reconcile(book, SPEC, { now: AT });
    const result = compileFromReconciliation(reconciliation, book, SPEC, {
      templateKey: "t",
      entry: { mode: "direct", url: "https://tienda.ejemplo.test/p/100001" },
      now: AT,
    });
    expect(Object.keys(result.scraper.fields).sort()).toEqual(["listPrice", "productName", "promoPrice"]);
  });
});

// ------------------------------------------------------------ U8: the rubric

describe("the rubric reaches the compile", () => {
  it("quotes the rule verbatim beside the binding it settled", () => {
    const { rationale } = compiled();
    const field = rationale.fields.find((entry) => entry.field === "listPrice")!;
    const ambiguity = field.ambiguities.find((entry) => entry.id === "listPrice/competing-values")!;

    expect(ambiguity.settledBy).toHaveLength(1);
    expect(ambiguity.settledBy[0]!.rule).toBe("the list price is the crossed-out one and never Precio Club");
    expect(ambiguity.resolved).toBe("productData.prices[price-list-std]");

    const markdown = renderRationale(rationale);
    // Verbatim, never paraphrased: that is the rule `src/reconcile/schema.ts`
    // states in bold, and the only reason the binding is checkable in one line.
    expect(markdown).toContain('"the list price is the crossed-out one and never Precio Club"');
    expect(markdown).toContain("client/list-price");
    expect(markdown).toContain("Without the rule this stops.");
  });

  it("says so, and says what a person would have to decide, when nothing settled it", () => {
    const { rationale } = compiled({}, { ...SPEC, rubrics: [] });
    const field = rationale.fields.find((entry) => entry.field === "listPrice")!;
    expect(field.ambiguities[0]!.settledBy).toEqual([]);

    const markdown = renderRationale(rationale);
    expect(markdown).toContain("**Nothing in the spec settles this, and the compile bound one reading anyway.**");
    expect(markdown).toContain("A client decides:");
  });

  it("carries the type gap the compile refused to guess at", () => {
    const { rationale } = compiled();
    const stock = rationale.notCompiled.find((entry) => entry.field === "stock")!;
    expect(stock.ambiguity).toBe("stock/type-gap");
    expect(renderRationale(rationale)).toContain("a decision, not an absence");
  });
});

describe("rationale.md explains a binding without opening the scraper JSON", () => {
  it("names, for every field, where it reads from, what that beat, and what is behind it", () => {
    const markdown = renderRationale(compiled().rationale);

    // Where it reads from.
    expect(markdown).toContain("`network catalog-svc/products/detail productData.prices[price-list-std]`");
    expect(markdown).toContain("`json-ld Product name`");
    // A dom alternative is resolved by its selector, so the selector is what
    // the line prints — not the meta property name the manuscript filed it under.
    expect(markdown).toContain('`dom meta[property="product:retailer_item_id"] @content`');
    // What it beat.
    expect(markdown).toContain("What else was tried, and why it lost");
    expect(markdown).toContain("productData.prices[price-sale-std]");
    // Which heuristic decided it.
    expect(markdown).toContain("key-names-carry-the-signal");
    // What is behind it, and that the order is the cascade.
    expect(markdown).toContain("The array **is** the cascade");
    expect(markdown).toContain("fallback");
    // And the fingerprint, so drift can be reasoned about from this file.
    expect(markdown).toContain("int: 4990, 12990, 7490");
  });

  it("is stable: the same investigation renders the same file twice", () => {
    expect(renderRationale(compiled().rationale)).toBe(renderRationale(compiled().rationale));
  });
});

// ------------------------------------------------------- the round trip

/**
 * The proof of the unit.
 *
 * A manuscript is reconciled, compiled, and the compiled scraper is handed to
 * the real `extractPage` — a real Chromium, the fixture page, and the captured
 * responses that page's app would have fetched for itself. Every value the
 * investigation wrote down has to come back.
 */
describe("the round trip: manuscript -> reconcile -> compile -> extract", () => {
  let server: FixtureServer;
  let browser: LaunchedBrowser;

  beforeAll(async () => {
    server = await startFixtureServer();
    browser = await launch({ browser: "chromium", headed: false });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  /**
   * What the page fetched for itself, with the shape that made the walk in
   * `network-capture.ts` necessary: the detail endpoint answers 401 before the
   * anonymous session exists and 200 after, and a later retry fails. The
   * compiled alternative has to reach the answer through all of it.
   */
  const captured = (): CapturedResponse[] => [
    { url: `https://api.ejemplo.test/${MATCH}/100001`, status: 401, body: { error: "Unauthorized", errorCode: 401 } },
    { url: `https://api.ejemplo.test/inventory-service/stock/100001`, status: 200, body: { stock: { available: 412 } } },
    { url: `https://api.ejemplo.test/${MATCH}/100001`, status: 200, body: PAYLOAD },
    { url: `https://api.ejemplo.test/${MATCH}/100001`, status: 503, body: { fault: "retry" } },
  ];

  async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await browser.context.newPage();
    try {
      await page.goto(`${server.baseUrl}/fixtures/compile/product-page.html`);
      return await fn(page);
    } finally {
      await page.close();
    }
  }

  it("gives back the values the investigation recorded, through the real cascade", async () => {
    const { scraper } = compiled();
    const extraction = await withPage((page) => extractPage(page, scraper, { captured: captured() }));
    const values = coerceValues(extraction.values, fieldTypesOf(scraper));

    expect(values).toEqual({
      productName: NAMES[0],
      sku: SKUS[0],
      listPrice: LIST[0],
      promoPrice: SALE[0],
    });
  });

  it("resolves each field through the alternative the compile put first", async () => {
    const { scraper } = compiled();
    const extraction = await withPage((page) => extractPage(page, scraper, { captured: captured() }));
    // Index 0 everywhere: nothing fell through to a fallback on a healthy page,
    // which is what makes the fallbacks meaningful when one day something does.
    expect(extraction.resolvedBy).toEqual({ productName: 0, sku: 0, listPrice: 0, promoPrice: 0 });
  });

  /**
   * The Store A defect, riding through the whole pipeline rather than
   * through a unit test of the reader.
   *
   * The fixture page's `@graph` leads with an Organization and a WebSite, both
   * named after the store. A compile that dropped `entity` — or a reader that
   * walked the graph until something answered to `name` — returns the store's
   * name as the product name, on every page that redirects away from its
   * product, with a SKU off the meta tag and a price from the capture. Those
   * rows look extracted.
   */
  it("does not return the store's own name as the product name", async () => {
    const { scraper } = compiled();
    const extraction = await withPage((page) => extractPage(page, scraper, { captured: captured() }));
    expect(extraction.values.productName).not.toBe("Tienda Ejemplo");
  });

  /**
   * The negative half. With no capture, the two price fields have nothing to
   * read: the compiled scraper carries no DOM alternative for them, and the
   * only price rendered on the page is the club price, styled exactly like the
   * heading. A blank is the honest answer; `$ 3.992` would be the 2026-09-22
   * defect reproduced by a scraper that had been told better.
   */
  it("returns null for a field whose source is gone rather than reading the page's nearest number", async () => {
    const { scraper } = compiled();
    const extraction = await withPage((page) => extractPage(page, scraper, { captured: [] }));
    expect(extraction.values.listPrice).toBeNull();
    expect(extraction.values.promoPrice).toBeNull();
    // The two tier-1 fields are stated by the page itself and still answer.
    expect(extraction.values.productName).toBe(NAMES[0]);
    expect(extraction.values.sku).toBe(SKUS[0]);
  });

  it("falls to an alias when the bound path is gone from the payload", async () => {
    const { scraper } = compiled();
    const thinned = captured().map((response) =>
      response.status === 200 && response.url.includes(MATCH)
        ? { ...response, body: { productData: { price: 4990, listing: { price: 4990 } } } }
        : response,
    );
    const extraction = await withPage((page) => extractPage(page, scraper, { captured: thinned }));
    expect(coerceValues(extraction.values, fieldTypesOf(scraper)).listPrice).toBe(LIST[0]);
    // Alternative 1, which is the alias: the array is the cascade.
    expect(extraction.resolvedBy.listPrice).toBe(1);
  });
});
