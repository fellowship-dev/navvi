import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bank } from "../src/heuristics/index.js";
import { visibleText } from "../src/heuristics/rules/investigate.js";
import type { Capture, Sources } from "../src/investigate/investigate.js";
import { investigate } from "../src/investigate/investigate.js";
import { render, type Manuscript, type RequestedField } from "../src/investigate/manuscript.js";
import { acceptedRoles, roleOfDeclared, roleOfField } from "../src/investigate/roles.js";
import { importHar } from "../src/investigate/har.js";
import { chooseSample, type UrlProbe } from "../src/investigate/sample.js";

/**
 * U2c and U2f: the cascade, and the manuscript it writes.
 *
 * Every test here is offline by construction — `investigate` never fetches or
 * renders anything, it asks the two callbacks it was handed — and that is the
 * point rather than a convenience. The value of a cascade is the call it does
 * **not** make, so the StoreA test below asserts that `capture` was never
 * invoked, which is only assertable because `capture` is something the test owns.
 *
 * The three store shapes the plan names are the three `describe` blocks:
 * StoreA stops at tier 1, Store B skips tier 1 as a shell and binds from
 * the payload, and a blocked run reports `blocked` without binding anything.
 */

const DIR = join(import.meta.dirname, "fixtures", "investigate");
const page = (name: string): string => readFileSync(join(DIR, `${name}.html`), "utf8");
const detail = (n: "" | "-2" = ""): unknown => JSON.parse(readFileSync(join(DIR, `storeb-detail${n}.json`), "utf8"));

/** The clock, injected: a manuscript that moves between two identical runs is not diffable. */
const NOW = new Date("2026-09-22T18:00:00.000Z");

const FIELDS: RequestedField[] = [
  { name: "productName", type: "text" },
  { name: "sku", type: "text" },
  { name: "listPrice", type: "money" },
  { name: "promoPrice", type: "money" },
  { name: "stock", type: "text" },
];

/** A probe of a live page, as one cheap GET would have established it. */
function live(url: string, extra: Partial<UrlProbe> = {}): UrlProbe {
  return { url, status: 200, hasDeclaredProduct: true, ...extra };
}

/** `fetch` off a fixed table, with a counter, so a test can say what was and was not requested. */
function sourcesOf(pages: Readonly<Record<string, string>>, captures?: Readonly<Record<string, Capture>>): Sources & { fetched: string[]; captured: string[] } {
  const fetched: string[] = [];
  const captured: string[] = [];
  const sources: Sources & { fetched: string[]; captured: string[] } = {
    fetched,
    captured,
    fetch: (url: string) => {
      fetched.push(url);
      return Promise.resolve({ url, status: 200, body: pages[url] ?? "" });
    },
  };
  if (captures) {
    sources.capture = (url: string): Promise<Capture> => {
      captured.push(url);
      return Promise.resolve(captures[url] ?? { responses: [] });
    };
  }
  return sources;
}

const field = (manuscript: Manuscript, name: string): Manuscript["fields"][number] => manuscript.fields.find((entry) => entry.field === name)!;
const tier = (manuscript: Manuscript, n: 1 | 2 | 3): Manuscript["tiers"][number] => manuscript.tiers.find((entry) => entry.tier === n)!;

// ---------------------------------------------------------------- vocabulary

describe("roles — a declared property is a lookup, not a search", () => {
  it("places the client's words on the published vocabulary, including the two key names cannot reach", () => {
    // `stock` and `availability` share no token at all; key-name ranking scores
    // every declared property zero and sends the cheapest field to a model.
    expect(roleOfField("stock")).toBe("availability");
    expect(roleOfField("disponibilidad")).toBe("availability");
    // The longest matching term wins, so `promo price` beats a bare `price`.
    expect(roleOfField("listPrice")).toBe("listPrice");
    expect(roleOfField("promoPrice")).toBe("salePrice");
    expect(roleOfField("price")).toBe("listPrice");
    // `brandName` matches `name` and `brand` on one token each; the two-token
    // term is what keeps the brand from becoming the product name.
    expect(roleOfField("brandName")).toBe("brand");
    expect(roleOfField("productName")).toBe("name");
    expect(roleOfField("bioequivalence")).toBeUndefined();
  });

  it("reads schema.org and the product namespace, and tells brand.name from name", () => {
    expect(roleOfDeclared({ kind: "json-ld", path: "name" })).toBe("name");
    expect(roleOfDeclared({ kind: "json-ld", path: "brand.name" })).toBe("brand");
    expect(roleOfDeclared({ kind: "json-ld", path: "offers[0].price" })).toBe("price");
    expect(roleOfDeclared({ kind: "meta", path: "product:price:amount" })).toBe("listPrice");
    expect(roleOfDeclared({ kind: "meta", path: "product:sale_price:amount" })).toBe("salePrice");
    expect(roleOfDeclared({ kind: "meta", path: "product:retailer_item_id" })).toBe("sku");
    expect(roleOfDeclared({ kind: "meta", path: "og:site_name" })).toBeUndefined();
  });

  it("spends the unqualified price once: on what you pay today, not on both prices", () => {
    expect(acceptedRoles("promoPrice", new Set())).toEqual(["salePrice", "price"]);
    // Once the sale-sense field has taken `offers.price`, the list price has to
    // come from somewhere else or stay uncovered — which is the Store B
    // collapse (two fields, one node) refused a tier earlier.
    expect(acceptedRoles("listPrice", new Set(["price"]))).toEqual(["listPrice"]);
  });
});

// ------------------------------------------------- shape 1: stop at tier 1

describe("StoreA — the run stops at tier 1", () => {
  const probes: UrlProbe[] = [
    live("https://example.test/p/complejo-b", { priceCount: 2, inStock: true }),
    live("https://example.test/p/vitamina-c", { priceCount: 2, inStock: false }),
    { url: "https://example.test/p/descontinuado", status: 200, redirectedTo: "https://example.test/", hasDeclaredProduct: false },
  ];
  const sample = chooseSample(probes, { size: 3 });
  const pages = {
    "https://example.test/p/complejo-b": page("storea-product"),
    "https://example.test/p/vitamina-c": page("storea-product-2"),
    "https://example.test/p/descontinuado": page("storea-redirect"),
  };

  async function run(): Promise<{ manuscript: Manuscript; sources: ReturnType<typeof sourcesOf> }> {
    // A capture is supplied and must go unused: the assertion is that the
    // cascade never reached for it, not that it had nothing to reach for.
    const sources = sourcesOf(pages, {});
    return { manuscript: await investigate({ site: "store-a.example", fields: FIELDS, sample, sources, now: NOW }), sources };
  }

  it("covers every requested field from one plain fetch per sample, and never opens a browser", async () => {
    const { manuscript, sources } = await run();
    expect(manuscript.verdict).toBe("covered");
    expect(tier(manuscript, 1).outcome).toBe("ran");
    expect(tier(manuscript, 1).covered.sort()).toEqual(["listPrice", "productName", "promoPrice", "sku", "stock"]);
    expect(sources.captured).toEqual([]);
  });

  it("stops because declared-covers-spec said to, and says so in the manuscript", async () => {
    const { manuscript } = await run();
    const verdict = tier(manuscript, 1).verdicts.find((entry) => entry.id === "declared-covers-spec")!;
    expect(verdict.verdict.fires).toBe(true);
    expect(verdict.verdict.action).toContain("no render, no capture, no compile");
    expect(tier(manuscript, 2).outcome).toBe("skipped");
    expect(tier(manuscript, 2).because).toContain("declared-covers-spec");
    expect(tier(manuscript, 3).outcome).toBe("skipped");
    expect(tier(manuscript, 3).asked).toEqual([]);
    expect(manuscript.uncovered).toEqual([]);
  });

  it("binds each field to the declaration that was vouched for, with the other spelling as a free alternative", async () => {
    const { manuscript } = await run();
    // JSON-LD first: it is the only declaration `json-ld-needs-product-node`
    // gated. The meta tag saying the same thing rides along as an alias.
    expect(field(manuscript, "productName").path).toBe("name");
    expect(field(manuscript, "productName").source).toBe("json-ld");
    expect(field(manuscript, "productName").entity).toBe("Product");
    expect(field(manuscript, "productName").aliases).toContain("og:title");
    expect(field(manuscript, "sku").path).toBe("sku");
    // The two prices are the ones the committed scraper was reading a seasonal
    // CSS class for, and only the `product:` namespace spells them apart.
    expect(field(manuscript, "listPrice").path).toBe("product:price:amount");
    expect(field(manuscript, "listPrice").selector).toBe('meta[property="product:price:amount"]');
    expect(field(manuscript, "listPrice").attr).toBe("content");
    expect(field(manuscript, "promoPrice").path).toBe("product:sale_price:amount");
    expect(field(manuscript, "stock").path).toBe("offers.availability");
    for (const entry of manuscript.fields) expect(entry.askModel).toBe(false);
  });

  it("keeps the dead URL in the sample and out of the binding set", async () => {
    const { manuscript, sources } = await run();
    const dead = manuscript.sample.picks.find((pick) => pick.stratum === "dead")!;
    expect(dead.url).toBe("https://example.test/p/descontinuado");
    expect(dead.bound).toBe(false);
    // Fetching it would have cost nothing; *binding* from it deletes every
    // candidate for every field, because `narrow` keeps only leaves present on
    // every sample. It is in the sample for parity and nothing else.
    expect(sources.fetched).not.toContain(dead.url);
    expect(sources.fetched).toHaveLength(2);
  });

  it("records the canary off a page that declared a product", async () => {
    const { manuscript } = await run();
    expect(manuscript.canary?.declaredProduct).toBe(true);
    expect(manuscript.canary?.recordedAt).toBe("2026-09-22");
    expect(manuscript.canary?.words.length).toBeGreaterThan(0);
    expect(manuscript.canaryBecause).toContain("declaring a product");
  });

  it("produces the same manuscript twice, and survives the round trip it is committed through", async () => {
    const first = await run();
    const second = await run();
    expect(JSON.stringify(second.manuscript)).toBe(JSON.stringify(first.manuscript));
    // It is written next to the scraper and read back by a run months later,
    // so nothing in it may be a Map, a Date or a class instance.
    expect(JSON.parse(JSON.stringify(first.manuscript))).toEqual(first.manuscript);
  });

  it("renders the stage block a person reads on stderr", async () => {
    const { manuscript } = await run();
    const text = render(manuscript, "work/storea/investigation.json");
    expect(text).toContain("store-a.example");
    expect(text).toContain("work/storea/investigation.json");
    expect(text).toContain("tier 1      declared: 5 of 5 fields covered");
    expect(text).toContain("tier 3      dom: skipped");
    expect(text).toContain("product:price:amount");
  });
});

// -------------------------------------------- shape 2: a shell, then payload

describe("Store B — tier 1 is skipped as a shell and the payload answers", () => {
  const probes: UrlProbe[] = [
    live("https://example.test/p/100001", { hasDeclaredProduct: false, priceCount: 2, inStock: true }),
    live("https://example.test/p/100002", { hasDeclaredProduct: false, priceCount: 1, inStock: true }),
  ];
  /**
   * `hasDeclaredProduct: false` is what a probe of a shell reports, and
   * `classify` reads it as dead — correctly, for a catalogue built from
   * declarations. A site whose content arrives later is investigated from its
   * payloads instead, so the probes here say nothing about declarations rather
   * than denying them.
   */
  const sample = chooseSample(
    probes.map((probe) => ({ ...probe, hasDeclaredProduct: undefined })),
    { size: 2 },
  );

  const pages = {
    "https://example.test/p/100001": page("storeb-shell"),
    "https://example.test/p/100002": page("storeb-shell"),
  };
  /** What each rendered page showed a reader, near enough to anchor against. */
  const TEXT = [
    "Ejemplo Comprimidos 100 mg 30 Comprimidos $ 4.990 $ 4.491 Club Store B $ 3.992 Precio por Unidad Fraccionada: $ 166 por Comprimido Laboratorio Ejemplo",
    "Otro Jarabe 120 ml $ 12.990 $ 11.691 Precio por Unidad Fraccionada: $ 108 por ml Laboratorio Otro",
  ];
  const captures: Record<string, Capture> = {
    "https://example.test/p/100001": {
      // The 401 the endpoint answers before the anonymous session exists, kept
      // in call order and skipped for the 200 behind it.
      responses: [
        { url: "https://api.example.test/catalog-svc/products/detail/100001?token=SECRET-1", status: 401, body: { error: "unauthorized" } },
        { url: "https://api.example.test/catalog-svc/products/detail/100001?token=SECRET-1", status: 200, body: detail() },
        { url: "https://api.example.test/tracking/events", status: 204, body: { ok: true } },
      ],
      text: TEXT[0]!,
      obstacles: [{ kind: "consent", because: 'a consent dialog was dismissed by clicking "Aceptar"', evidence: "Aceptar", blocking: false }],
    },
    "https://example.test/p/100002": {
      responses: [
        { url: "https://api.example.test/catalog-svc/products/detail/100002", status: 200, body: detail("-2") },
        { url: "https://api.example.test/tracking/events", status: 204, body: { ok: true } },
      ],
      text: TEXT[1]!,
    },
  };

  async function run(): Promise<{ manuscript: Manuscript; sources: ReturnType<typeof sourcesOf> }> {
    const sources = sourcesOf(pages, captures);
    return { manuscript: await investigate({ site: "store-b.example", fields: FIELDS, sample, sources, now: NOW }), sources };
  }

  it("skips tier 1 because every plain fetch came back a shell", async () => {
    const { manuscript } = await run();
    expect(tier(manuscript, 1).outcome).toBe("skipped");
    expect(tier(manuscript, 1).because).toContain("shell-skips-tier-1");
    expect(tier(manuscript, 1).covered).toEqual([]);
    const fired = tier(manuscript, 1).verdicts.filter((entry) => entry.id === "shell-skips-tier-1" && entry.verdict.fires);
    expect(fired).toHaveLength(2);
    expect(fired[0]!.verdict.because).toContain("script bundle");
  });

  it("binds the two prices to the keys the page's own API names them by", async () => {
    const { manuscript } = await run();
    expect(field(manuscript, "listPrice").path).toBe("productData.prices[price-list-std]");
    expect(field(manuscript, "listPrice").source).toBe("network");
    expect(field(manuscript, "listPrice").match).toBe("catalog-svc/products/detail");
    expect(field(manuscript, "promoPrice").path).toBe("productData.prices[price-sale-std]");
    expect(field(manuscript, "promoPrice").aliases).toContain("productData.appliedPromotions[price-sale-std].promotionalPrice");
    expect(field(manuscript, "productName").path).toBe("productData.name");
    expect(tier(manuscript, 2).outcome).toBe("ran");
    expect(tier(manuscript, 2).covered.sort()).toEqual(["listPrice", "productName", "promoPrice"]);
  });

  it("reads the newest answer of each endpoint and prints no token anywhere", async () => {
    const { manuscript } = await run();
    const payloads = tier(manuscript, 2).sources.filter((source) => source.match === "catalog-svc/products/detail");
    expect(payloads).toHaveLength(2);
    for (const source of payloads) expect(source.status).toBe(200);
    expect(JSON.stringify(manuscript)).not.toContain("SECRET-1");
    expect(payloads[0]!.url).toContain("?…");
  });

  it("asks tier 3 for the two fields the payload could not settle, and nothing else", async () => {
    const { manuscript } = await run();
    expect(manuscript.uncovered).toEqual(["sku", "stock"]);
    expect(tier(manuscript, 3).outcome).toBe("requested");
    expect(tier(manuscript, 3).asked).toEqual(["sku", "stock"]);
    expect(tier(manuscript, 3).because).toContain("selector gate");
    expect(manuscript.verdict).toBe("partial");
    // The payload holds `productData.stock`, and the anchor threw it out
    // because 412 is nowhere on the page a reader saw. That is the filter
    // working, not a miss: what the page never showed, the scraper cannot check.
    expect(field(manuscript, "stock").path).toBeUndefined();
  });

  it("refuses to fingerprint a shell as its canary, and says why", async () => {
    const { manuscript } = await run();
    expect(manuscript.canary).toBeUndefined();
    expect(manuscript.canaryBecause).toContain("turns every future refusal into drift");
  });

  it("keeps the consent dialog as an obstacle that did not stop anything", async () => {
    const { manuscript } = await run();
    const consent = manuscript.obstacles.find((obstacle) => obstacle.kind === "consent")!;
    expect(consent.because).toContain("Aceptar");
    expect(consent.blocking).toBe(false);
    expect(manuscript.obstacles.some((obstacle) => obstacle.kind === "shell" && !obstacle.blocking)).toBe(true);
    expect(manuscript.obstacles.every((obstacle) => !obstacle.blocking)).toBe(true);
  });

  it("records every rejected candidate with the values that lost", async () => {
    const { manuscript } = await run();
    const rejected = field(manuscript, "listPrice").rejected;
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((entry) => entry.path.startsWith("catalog-svc/products/detail:"))).toBe(true);
    expect(rejected.some((entry) => entry.path.includes("price-sale-std"))).toBe(true);
  });
});

// ------------------------------------------------------ shape 3: refused

describe("a blocked run — reported, never bound from", () => {
  const probes: UrlProbe[] = [
    { url: "https://example.test/p/one", status: 200 },
    { url: "https://example.test/p/two", status: 200 },
  ];
  const sample = chooseSample(probes, { size: 2 });
  const pages = {
    "https://example.test/p/one": page("apology"),
    "https://example.test/p/two": page("apology"),
  };

  it("reports blocked with a remedy and binds nothing", async () => {
    const sources = sourcesOf(pages, {});
    const manuscript = await investigate({ site: "storec.cl", fields: FIELDS, sample, sources, now: NOW });
    expect(manuscript.verdict).toBe("blocked");
    expect(manuscript.because).toContain("enable-proxy");
    // The apology was 111/111 filled on the day this rule was written, and a
    // fill rate alone called it healthy. Nothing below the transport check runs.
    expect(manuscript.fields.every((entry) => entry.path === undefined)).toBe(true);
    expect(manuscript.uncovered).toEqual(FIELDS.map((entry) => entry.name));
    expect(sources.captured).toEqual([]);
  });

  it("skips every tier and says the same reason in each", async () => {
    const sources = sourcesOf(pages, {});
    const manuscript = await investigate({ site: "storec.cl", fields: FIELDS, sample, sources, now: NOW });
    for (const n of [1, 2, 3] as const) expect(tier(manuscript, n).outcome).toBe("skipped");
    expect(tier(manuscript, 2).because).toContain("destroyed by its own repair");
    expect(manuscript.obstacles.some((obstacle) => obstacle.kind === "apology" && obstacle.blocking)).toBe(true);
    expect(manuscript.canary).toBeUndefined();
    expect(manuscript.canaryBecause).toContain("fingerprint of the refusal");
  });
});

// ------------------------------------------- the fourth shape, for the record

describe("StoreC — four fields declared, and the list price alone reaches tier 3", () => {
  /**
   * The second sample is the first with its values substituted rather than a
   * second fixture: what is under test is the cascade's arithmetic over two
   * pages, not the parsing of a page `declared.test.ts` already pins. The
   * availability is changed too, because a value identical across every sample
   * is not a field and the rule would rightly refuse it.
   */
  const first = page("storec-product");
  const second = first
    .replace(/Ejemplo Ibuprofeno 400 mg 20 Comprimidos/g, "Ejemplo Paracetamol 500 mg 16 Comprimidos")
    .replace(/300123/g, "300124")
    .replace(/"5490"/g, "7990")
    .replace(/schema\.org\/InStock/g, "schema.org/OutOfStock");

  const probes: UrlProbe[] = [live("https://example.test/a/1", { priceCount: 2, inStock: true }), live("https://example.test/a/2", { priceCount: 2, inStock: false })];
  const sample = chooseSample(probes, { size: 2 });

  it("gives the unqualified offer price to what you pay today and leaves the list price for the DOM", async () => {
    const sources = sourcesOf({ "https://example.test/a/1": first, "https://example.test/a/2": second });
    const manuscript = await investigate({ site: "storec.cl", fields: FIELDS, sample, sources, view: bank(), now: NOW });
    expect(field(manuscript, "promoPrice").path).toBe("offers.price");
    expect(field(manuscript, "productName").path).toBe("name");
    expect(field(manuscript, "sku").path).toBe("sku");
    expect(field(manuscript, "stock").path).toBe("offers.availability");
    // `struck-price-is-previous` is waiting for it there, over the <del> the
    // committed scraper reached through `body.modal-open`.
    expect(manuscript.uncovered).toEqual(["listPrice"]);
    expect(tier(manuscript, 3).asked).toEqual(["listPrice"]);
    expect(tier(manuscript, 2).outcome).toBe("skipped");
    expect(tier(manuscript, 2).because).toContain("no capture was supplied");
  });
});

// --------------------------------------------- a capture stands in for the browser

describe("a HAR compiles the same scraper a live render would", () => {
  /**
   * U2e's whole argument, run end to end: StoreC serves an apology page to a
   * datacenter IP while the same URLs read perfectly from a laptop in
   * Valdivia. A capture taken by hand on the machine the store answers is the
   * same `{url,status,body}` list the live capture makes, so the cascade
   * cannot tell them apart — and this test is the proof, because it drives
   * `investigate` with nothing but a file.
   *
   * One sample, deliberately. `narrow` only demands variation when there is
   * something to vary against, so a single captured page is a legitimate (and
   * weaker) investigation, and the manuscript says so by naming the strata it
   * could not fill.
   */
  const har = importHar(readFileSync(join(DIR, "laptop-capture.har"), "utf8"));
  const url = "https://tienda.ejemplo.cl/producto/jarabe-ejemplo-120ml";
  const sample = chooseSample([live(url, { priceCount: 2, inStock: true })], { size: 1 });

  it("answers tier 1 from the captured document and tiers 2 from the captured calls", async () => {
    const document = har.documents.get(url)!;
    const manuscript = await investigate({
      site: "tienda.ejemplo.cl",
      fields: FIELDS,
      sample,
      now: NOW,
      sources: {
        fetch: (target: string) => Promise.resolve({ url: target, status: 200, body: har.documents.get(target) ?? "" }),
        capture: () => Promise.resolve({ responses: har.responses, text: visibleText(document) }),
      },
    });

    expect(field(manuscript, "productName").path).toBe("name");
    expect(field(manuscript, "productName").tier).toBe(1);
    expect(field(manuscript, "sku").tier).toBe(1);
    // The 401 the detail endpoint answers before the anonymous session exists
    // sits above the 200 in the file; the newest answer that *is* an answer wins.
    expect(field(manuscript, "listPrice").path).toBe("productData.prices[price-list-std]");
    expect(field(manuscript, "listPrice").match).toBe("catalog-svc/products/detail");
    expect(field(manuscript, "promoPrice").path).toBe("productData.prices[price-sale-std]");
    // A second endpoint entirely, and the cascade does not care.
    expect(field(manuscript, "stock").match).toBe("stock-svc/stock");
    expect(manuscript.verdict).toBe("covered");
    expect(tier(manuscript, 3).outcome).toBe("skipped");

    // The HAR's headers, cookies and query string carry SECRET- strings on
    // purpose. None of them has a field to live in, and the URLs are amputated.
    expect(JSON.stringify(manuscript)).not.toContain("SECRET");
    expect(manuscript.sample.unfilled.map((entry) => entry.stratum)).toContain("dead");
  });
});
