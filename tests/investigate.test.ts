import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bank } from "../src/heuristics/index.js";
import { bindField } from "../src/investigate/bind.js";
import { investigate, type Capture, type Sources } from "../src/investigate/investigate.js";
import { anchors, flatten, narrow, typeMatches, type Leaf } from "../src/investigate/leaves.js";
import type { Manuscript, RequestedField } from "../src/investigate/manuscript.js";
import { chooseSample, type UrlProbe } from "../src/investigate/sample.js";

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
const detail = (n: "" | "-2" | "-3" = ""): unknown => JSON.parse(readFileSync(join(DIR, `store-b-detail${n}.json`), "utf8"));

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

  it("refuses a digit run no page shows a reader rather than building a pattern out of it", () => {
    // A live catalogue page, 2026-09-23: one leaf was a long string with digits
    // scattered through it, the separator grouping inserted an optional
    // separator every three of ~21,000 digits, and the pattern threw
    // `SyntaxError: Invalid regular expression` — out of `anchors`, out of
    // `investigate`, and out of the run. The question this function asks is
    // about one formatted number, so a run that could not be one is refused.
    // ~21,000 digits, the size the live leaf actually was. `new RegExp` alone
    // does not throw — V8 compiles lazily — so the overflow arrives on `.test`,
    // which is why the stack trace pointed at `anchors` and not at a builder.
    const blob = `sess-${"1234567890".repeat(2_100)}-end`;
    expect(() => anchors(blob, "el precio es $ 4.990 hoy")).not.toThrow();
    expect(anchors(blob, "el precio es $ 4.990 hoy")).toBe(false);
    // A barcode is 13 digits and still gets the separator treatment, so the
    // bound refuses the blob without refusing a real number.
    expect(anchors(7801234567890, "codigo 7.801.234.567.890")).toBe(true);
    // And a value the page does show verbatim is still found, bound or not:
    // the plain `includes` check runs first.
    expect(anchors(blob, `el codigo es ${blob}`)).toBe(true);
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
      [{ path: "a.brand", value: "Store A" }, { path: "a.name", value: "Paracetamol" }],
      [{ path: "a.brand", value: "Store A" }, { path: "a.name", value: "Ibuprofeno" }],
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

// ------------------------------- tier 2, end to end: the call one render missed

/**
 * The third defect of 2026-09-22, in the half of the rule it was not applied to.
 *
 * That fix taught tier 2 that a sample which *could not answer* must be left
 * out of the endpoint's comparison rather than allowed to delete it for
 * everyone. It left "asked by every sample" strict, and a live render does not
 * only fail to answer — sometimes it never gets round to asking. A fetch still
 * in flight when the capture closed, a lazy component that never came into
 * view, and `catalog-svc/products/detail` is missing from one capture
 * while the page that produced it rendered perfectly well. Before 2026-09-23
 * that deleted the endpoint for all three samples and the run bound nothing:
 * a live smoke run against Store B returned `0 of 5 bound` instead of
 * `3 of 5` three times on 2026-09-23.
 *
 * The fixture is that run and not the 2026-09-22 one, and the difference is
 * the point: there is no 401-then-500 here and no chrome-only page. Every
 * sample rendered its own product and showed a reader its own prices. One of
 * them simply has no detail response in its capture at all.
 *
 * It runs through `investigate` rather than through `agree`, because what
 * failed in the live run was the *wiring* — which samples tier 2 offers the
 * comparison, and which endpoint keys it even considers. `tests/agree.test.ts`
 * pins the rule; this pins tier 2 asking for it.
 */
describe("tier 2 — an endpoint one render never asked for", () => {
  const ids = ["100001", "100002", "100003"] as const;
  const urls = ids.map((id) => `https://example.test/p/${id}`);
  const sample = chooseSample(
    urls.map((url) => ({ url, status: 200, hasDeclaredProduct: undefined, priceCount: 2, inStock: true }) satisfies UrlProbe),
    { size: 3 },
  );
  const pages = Object.fromEntries(urls.map((url) => [url, readFileSync(join(DIR, "store-b-shell.html"), "utf8")]));

  const FIELDS: RequestedField[] = [
    { name: "productName", type: "text" },
    { name: "listPrice", type: "money" },
    { name: "promoPrice", type: "money" },
  ];

  const API = "https://api.example.test";
  const DETAIL = "catalog-svc/products/detail";

  /** What every Store B page loads for itself, answering the same bytes each time. */
  const shared = (): Capture["responses"] => [
    { url: `${API}/cart-svc/basket`, status: 200, body: { total: 0, currency: "CLP", lines: 0 } },
    { url: `${API}/settings-svc/coverage`, status: 200, body: { coverage: [{ comuna: "Centro", despacho: true }] } },
  ];

  /** The product endpoint, with the 401 the page always gets before its anonymous session exists. */
  const detailCalls = (id: string, body: unknown): Capture["responses"] => [
    { url: `${API}/catalog-svc/products/detail/${id}`, status: 401, body: { error: "La sesion ha expirado", errorCode: "INVALID_SESSION" } },
    { url: `${API}/catalog-svc/products/detail/${id}?inventoryId=Zona0001`, status: 200, body },
  ];

  /** What each page showed a reader. All three rendered their own product: nothing here is a shell. */
  const TEXT = [
    "Ejemplo Comprimidos 100 mg 30 Comprimidos $ 4.990 $ 4.491 Club Store B $ 3.992 Laboratorio Ejemplo",
    "Otro Jarabe 120 ml $ 12.990 $ 11.691 Laboratorio Otro",
    "Tercero Capsulas 500 mg 16 Capsulas $ 7.490 $ 6.741 Laboratorio Tercero",
  ];
  const BODIES = [detail(), detail("-2"), detail("-3")];
  const LIST = [4990, 12990, 7490];
  const PROMO = [4491, 11691, 6741];
  const NAMES = ["Ejemplo Comprimidos 100 mg 30 Comprimidos", "Otro Jarabe 120 ml", "Tercero Capsulas 500 mg 16 Capsulas"];

  /**
   * `missed` is the sample whose capture holds no `products/detail` response
   * at all — not a refusal, not an empty body: the call is absent.
   *
   * The first sample also carries a recommendations widget nobody else loads.
   * It is the case the strict rule was protecting — an endpoint that is a
   * page's own furniture rather than a source — and the floor, not the veto,
   * is what has to keep it out now.
   */
  function capturesOf(missed: number | undefined): Record<string, Capture> {
    return Object.fromEntries(
      urls.map((url, index) => [
        url,
        {
          responses: [
            ...shared(),
            ...(index === 0 ? [{ url: `${API}/catalog-svc/products/recommendations/${ids[0]}`, status: 200, body: { products: [{ name: "Sugerido Gotas 10 ml", price: 1990 }] } }] : []),
            ...(index === missed ? [] : detailCalls(ids[index]!, BODIES[index])),
          ],
          text: TEXT[index]!,
        } satisfies Capture,
      ]),
    );
  }

  async function runMissing(missed: number | undefined): Promise<Manuscript> {
    const captures = capturesOf(missed);
    const sources: Sources = {
      fetch: (url: string) => Promise.resolve({ url, status: 200, body: pages[url] ?? "" }),
      capture: (url: string) => Promise.resolve(captures[url] ?? { responses: [] }),
    };
    return investigate({ site: "store-b.example", fields: FIELDS, sample, sources, now: new Date("2026-09-23T18:00:00.000Z") });
  }

  const tier2 = (manuscript: Manuscript): Manuscript["tiers"][number] => manuscript.tiers.find((entry) => entry.tier === 2)!;
  const field = (manuscript: Manuscript, name: string): Manuscript["fields"][number] => manuscript.fields.find((entry) => entry.field === name)!;
  const kept = <T>(values: readonly T[], missed: number): T[] => values.filter((_, index) => index !== missed);

  for (const missed of [0, 1, 2]) {
    it(`binds from the two samples that asked when sample ${missed + 1}'s render never called the endpoint`, async () => {
      const manuscript = await runMissing(missed);

      // The endpoint survives: asked by two, answered by two, floor of two met.
      const payloads = tier2(manuscript).sources.filter((source) => source.match === DETAIL);
      expect(payloads).toHaveLength(2);
      for (const source of payloads) expect(source.status).toBe(200);

      // And it is bound, over exactly the samples that have it — which is the
      // `0 of 5` that made this a bug rather than a preference.
      for (const name of ["productName", "listPrice", "promoPrice"]) {
        expect(field(manuscript, name).tier, name).toBe(2);
        expect(field(manuscript, name).match, name).toBe(DETAIL);
      }
      expect(field(manuscript, "listPrice").path).toBe("productData.prices[price-list-std]");
      expect(field(manuscript, "listPrice").values).toEqual(kept(LIST, missed));
      expect(field(manuscript, "promoPrice").values).toEqual(kept(PROMO, missed));
      expect(field(manuscript, "productName").values).toEqual(kept(NAMES, missed));
      expect(manuscript.uncovered).toEqual([]);
    });

    it(`says which sample never asked, at the tier and at the source, for sample ${missed + 1}`, async () => {
      const manuscript = await runMissing(missed);

      // The tier-level index: which endpoints rested on fewer than all the
      // samples, and who was not there. A run that quietly bound over two of
      // three would be the same silence the 2026-09-22 fix was written to end.
      expect(tier2(manuscript).because).toContain(`${DETAIL} (sample ${missed + 1} never asked it)`);
      expect(tier2(manuscript).because).toContain("were not called by every sample");

      // And `agree`'s own sentence, on the endpoint's sources, naming the same sample.
      const payloads = tier2(manuscript).sources.filter((source) => source.match === DETAIL);
      for (const source of payloads) expect(source.because).toContain(`sample ${missed + 1} (never asked it)`);
    });
  }

  it("still refuses the endpoint only one sample ever called", async () => {
    // Tolerating `asked` does not mean tolerating a comparison of one. The
    // floor is `min(2, samples)` and a sample that answered necessarily asked,
    // so a widget one page carries is still not a source — which is the case
    // `requireAskedByAll: true` used to be carrying.
    const manuscript = await runMissing(1);
    expect(tier2(manuscript).sources.some((source) => (source.match ?? "").includes("recommendations"))).toBe(false);
    expect(manuscript.fields.some((entry) => entry.match?.includes("recommendations"))).toBe(false);
  });

  it("says nothing about missing calls when every sample made all of them", async () => {
    const manuscript = await runMissing(undefined);
    const payloads = tier2(manuscript).sources.filter((source) => source.match === DETAIL);
    expect(payloads).toHaveLength(3);
    expect(field(manuscript, "listPrice").values).toEqual(LIST);
    expect(tier2(manuscript).because).not.toContain("never asked it");
    for (const source of payloads) expect(source.because).not.toContain("got no answer");
  });

  /**
   * A1, deferred by months and one line wide.
   *
   * The canary is fingerprinted off the render, and the only question asked of
   * that render was whether it produced any bytes at all. A page caught
   * half-drawn produces plenty. Its fingerprint then sits in `scraper.json` for
   * the life of the scraper, every later replay compares a finished page
   * against it, and every one of them reports drift — a false "the site
   * changed" bought with one busy machine at compile time. Under Phase F's
   * gate that false mismatch is also what licenses healing, so the cheapest
   * mistake available here ends in a healer recompiling a field that worked.
   *
   * The plain fetches in this fixture are shells, so the render is the only
   * page that could be fingerprinted: what these two tests separate is
   * "nothing here was a page a reader was served" from "navvi did not stay
   * long enough to find out".
   */
  describe("the canary, and a render that did not finish", () => {
    const rendered = (index: number): string => `<html><body><h1>${NAMES[index]}</h1><p>${TEXT[index]}</p></body></html>`;

    async function withSettle(settle: Capture["settle"]): Promise<Manuscript> {
      const base = capturesOf(undefined);
      const captures = Object.fromEntries(
        urls.map((url, index) => [url, { ...base[url]!, html: rendered(index), ...(settle === undefined ? {} : { settle }) } satisfies Capture]),
      );
      const sources: Sources = {
        fetch: (url: string) => Promise.resolve({ url, status: 200, body: pages[url] ?? "" }),
        capture: (url: string) => Promise.resolve(captures[url] ?? { responses: [] }),
      };
      return investigate({ site: "store-b.example", fields: FIELDS, sample, sources, now: new Date("2026-09-23T18:00:00.000Z") });
    }

    it("fingerprints a render that settled", async () => {
      const manuscript = await withSettle({ outcome: "quiesced" });
      expect(manuscript.canary).toBeDefined();
      expect(manuscript.canaryBecause).toContain("fingerprinted");
    });

    it("records no canary off a capped render, and says the render was starved rather than that the page was empty", async () => {
      const manuscript = await withSettle({ outcome: "capped", because: "the text was still growing (3,219 to 11,190 characters) when the budget ran out" });

      expect(manuscript.canary, "a fingerprint of a frame is worse than no fingerprint: it is wrong on every replay from here on").toBeUndefined();
      expect(manuscript.canaryBecause).toContain("the render did not finish");
      expect(manuscript.canaryBecause).toContain("the text was still growing");
      // And it is not the shell sentence: nothing here was empty.
      expect(manuscript.canaryBecause).not.toContain("was a page a reader was served");
    });

    it("keeps the shell sentence when the render finished and there was simply nothing to fingerprint", async () => {
      // No `settle` at all — a capture imported from a HAR, where nobody
      // watched the page and nobody may claim it settled either way.
      const manuscript = await withSettle(undefined);
      expect(manuscript.canary).toBeDefined();
      expect(manuscript.canaryBecause).not.toContain("the render did not finish");
    });
  });
});

// -------------------------- tier 2: a payload must be this page's, and one path is one fact

/**
 * U3, from a live run on 2026-09-23: on a real pharmacy site `make` bound `sku`
 * **and** `stock` to one leaf — `total` on a *recommendations* endpoint, the
 * count of other products the page suggested — and every gate downstream
 * passed, because every gate asks "did it extract?" and it did.
 *
 * Two defects, and this fixture carries both. The endpoint describes other
 * products, and nothing asked whether the payload was about *this* page at all;
 * and two fields settled on one path, and nothing asked whether that path had
 * already been spent. The mechanism is exactly the live one: the product
 * endpoint names `productName` and leaves `sku` and `stock` to a model (several
 * survivors, no key naming them), while the recommendations endpoint has one
 * anchored, varying leaf — `total` — and a lone survivor is accepted without a
 * rule, for any text field that asks.
 *
 * Synthetic: Store A, `example.test`, invented values.
 */
describe("tier 2 — the payload has to be this page's, and one path is one fact", () => {
  const ids = ["200001", "200002"] as const;
  const urls = ids.map((id) => `https://example.test/p/${id}`);
  const sample = chooseSample(
    urls.map((url) => ({ url, status: 200, hasDeclaredProduct: undefined, priceCount: 1, inStock: true }) satisfies UrlProbe),
    { size: 2 },
  );
  const pages = Object.fromEntries(urls.map((url) => [url, readFileSync(join(DIR, "store-b-shell.html"), "utf8")]));

  const FIELDS: RequestedField[] = [
    { name: "productName", type: "text" },
    { name: "sku", type: "text" },
    { name: "stock", type: "text" },
  ];

  const API = "https://api.example.test";
  const NAMES = ["Ejemplo Gel Frio 30 g", "Otro Jarabe Infantil 60 ml"];
  const PRICES = [5990, 8490];
  /** The count of *suggested* products: a number the page shows, about other products. */
  const TOTALS = [8, 12];
  /** A request id per render: shaped like a token, varying, and shown to nobody. */
  const TRACES = ["k3x9q2m7z4w8p1v6", "a7f2c9e4b1d8g5h3"];
  /**
   * The id is deliberately **not** in the page text. That keeps `productData.id`
   * out of every text field's candidates, so the product endpoint leaves `sku`
   * and `stock` unsettled — which is what hands them to the recommendations
   * endpoint's lone survivor today — while it still anchors the payload to the
   * page through the URL.
   */
  const TEXT = [
    `${NAMES[0]} $ 5.990 Tambien te puede interesar ${TOTALS[0]} productos`,
    `${NAMES[1]} $ 8.490 Tambien te puede interesar ${TOTALS[1]} productos`,
  ];

  const detailOf = (index: number): unknown => ({ productData: { id: ids[index], name: NAMES[index], price: PRICES[index] }, meta: { trace: TRACES[index] } });
  const recommendationsOf = (index: number): unknown => ({
    total: TOTALS[index],
    products: [
      { id: `30010${index}`, name: `Sugerido Uno ${index}`, price: 1990 + index },
      { id: `30020${index}`, name: `Sugerido Dos ${index}`, price: 2990 + index },
    ],
  });

  async function runWith(extra: (index: number) => Capture["responses"]): Promise<Manuscript> {
    const captures = Object.fromEntries(
      urls.map((url, index) => [
        url,
        {
          responses: [{ url: `${API}/catalog-svc/products/detail/${ids[index]}`, status: 200, body: detailOf(index) }, ...extra(index)],
          text: TEXT[index]!,
        } satisfies Capture,
      ]),
    );
    const sources: Sources = {
      fetch: (url: string) => Promise.resolve({ url, status: 200, body: pages[url] ?? "" }),
      capture: (url: string) => Promise.resolve(captures[url] ?? { responses: [] }),
    };
    return investigate({ site: "store-a.example", fields: FIELDS, sample, sources, now: new Date("2026-09-23T18:00:00.000Z") });
  }

  const withRecommendations = (): Promise<Manuscript> =>
    runWith((index) => [{ url: `${API}/catalog-svc/products/recommendations/${ids[index]}`, status: 200, body: recommendationsOf(index) }]);
  const field = (manuscript: Manuscript, name: string): Manuscript["fields"][number] => manuscript.fields.find((entry) => entry.field === name)!;
  const tier2 = (manuscript: Manuscript): Manuscript["tiers"][number] => manuscript.tiers.find((entry) => entry.tier === 2)!;

  it("binds nothing from a recommendations endpoint that never names this page", async () => {
    const manuscript = await withRecommendations();
    for (const name of ["sku", "stock"]) {
      expect(field(manuscript, name).match, `${name} came out of ${field(manuscript, name).match}:${field(manuscript, name).path}`).toBeUndefined();
      expect(field(manuscript, name).path, name).toBeUndefined();
    }
    expect(manuscript.fields.some((entry) => entry.match?.includes("recommendations"))).toBe(false);
    // Recorded, not silently dropped: the rejection says why the endpoint was refused.
    const refused = field(manuscript, "sku").rejected.find((rejection) => rejection.path === "catalog-svc/products/recommendations:total");
    expect(refused?.because).toContain("not this page's");
    expect(tier2(manuscript).because).toContain("catalog-svc/products/recommendations");
    expect(manuscript.uncovered).toEqual(["sku", "stock"]);
  });

  it("still binds from the product endpoint whose id is the URL's id", async () => {
    const manuscript = await withRecommendations();
    expect(field(manuscript, "productName").tier).toBe(2);
    expect(field(manuscript, "productName").match).toBe("catalog-svc/products/detail");
    expect(field(manuscript, "productName").path).toBe("productData.name");
    expect(field(manuscript, "productName").values).toEqual(NAMES);
  });

  it("unbinds both fields when their best readings are one path, and says which path", async () => {
    // An endpoint that *is* this page's — its `productId` is the URL's id — and
    // whose one anchored, varying leaf is the best reading for two fields at
    // once. Being the right endpoint does not make one leaf two facts.
    const manuscript = await runWith((index) => [
      { url: `${API}/inventory-svc/availability/${ids[index]}`, status: 200, body: { productId: ids[index], units: TOTALS[index] } },
    ]);
    for (const name of ["sku", "stock"]) {
      const record = field(manuscript, name);
      expect(record.path, name).toBeUndefined();
      expect(record.because, name).toContain("shared path");
      expect(record.because, name).toContain("inventory-svc/availability:units");
      const rejection = record.rejected.find((entry) => entry.path === "inventory-svc/availability:units");
      expect(rejection?.because, name).toContain("shared path");
    }
    expect(field(manuscript, "sku").because).toContain("stock");
    expect(field(manuscript, "stock").because).toContain("sku");
    expect(manuscript.uncovered).toEqual(["sku", "stock"]);
    expect(manuscript.tiers.find((entry) => entry.tier === 3)!.asked).toEqual(["sku", "stock"]);
  });

  it("rejects a machine value at bind, naming the rule that refused it", async () => {
    const manuscript = await withRecommendations();
    const record = field(manuscript, "sku");
    const rejection = record.rejected.find((entry) => entry.path === "catalog-svc/products/detail:meta.trace");
    expect(rejection, JSON.stringify(record.rejected, null, 2)).toBeDefined();
    expect(rejection!.heuristic).toBe("machine-value-is-not-a-fact");
    expect(record.verdicts.some((entry) => entry.id === "machine-value-is-not-a-fact" && entry.verdict.fires)).toBe(true);
  });
});

describe("bindField — machine-value-is-not-a-fact runs at bind", () => {
  it("refuses a token no page showed, by rule id, and leaves the real value bound", () => {
    const leaves: Leaf[][] = [
      [{ path: "a.name", value: "Ejemplo Gel Frio 30 g" }, { path: "a.requestId", value: "k3x9q2m7z4w8p1v6" }],
      [{ path: "a.name", value: "Otro Jarabe Infantil 60 ml" }, { path: "a.requestId", value: "a7f2c9e4b1d8g5h3" }],
    ];
    const binding = bindField("productName", leaves, { type: "text", pageText: ["Ejemplo Gel Frio 30 g", "Otro Jarabe Infantil 60 ml"] });
    expect(binding.path).toBe("a.name");
    expect(binding.machinery.map((entry) => entry.path)).toEqual(["a.requestId"]);
    expect(binding.verdicts.find((entry) => entry.id === "machine-value-is-not-a-fact")?.verdict.fires).toBe(true);
  });

  it("stays silent without rendered text: nobody looked, which is not the same as nobody was shown", () => {
    const leaves: Leaf[][] = [[{ path: "a.requestId", value: "k3x9q2m7z4w8p1v6" }], [{ path: "a.requestId", value: "a7f2c9e4b1d8g5h3" }]];
    expect(bindField("productName", leaves, { type: "text" }).machinery).toEqual([]);
  });
});
