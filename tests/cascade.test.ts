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
const detail = (n: "" | "-2" | "-3" = ""): unknown => JSON.parse(readFileSync(join(DIR, `storeb-detail${n}.json`), "utf8"));

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

// ------------------ shape 1a: a mixed sample — two real pages and one shell

/**
 * The fourth instance of one cause (2026-09-23), and the first with a test.
 *
 * `investigate` decides once, deliberately, that a site serving a real page
 * *sometimes* is still worth the cheapest request: tier 1 is skipped only when
 * `shell-skips-tier-1` fires on **every** binding URL. Having decided that, it
 * then built the tier 1 comparison set from every fetch with no shell filter at
 * all — while `pickCanary`, twenty lines further down the same function,
 * filtered the same list by the same shell set.
 *
 * A shell declares nothing, so it contributes an empty `sources` list, and
 * `bindRole` opens with "every sample must declare this role". One shell among
 * N real pages therefore returned `undefined` for every role of every field,
 * and the fallback `bindField` -> `narrow` deleted the rest for the same
 * reason. Tier 1 bound nothing on a site the code had just decided was worth
 * trying — the `bindingUrls` defect one layer down, and the tier 2 "answered by
 * every sample" defect one layer up, for the third time.
 *
 * It was never observed because no test had a mixed sample. This is that test.
 */
describe("a mixed sample — one shell must not delete tier 1 for the pages that declared", () => {
  const REAL = ["https://example.test/p/complejo-b", "https://example.test/p/vitamina-c"];
  const SHELL = "https://example.test/p/render-later";
  const probes: UrlProbe[] = [
    live(REAL[0]!, { priceCount: 2, inStock: true }),
    live(REAL[1]!, { priceCount: 2, inStock: false }),
    // A shell is not dead, and `classify` is the only module that says so: it
    // takes `isShell === false` for the no-Product rule to fire. So this URL is
    // in the sample *and* in the binding set, which is the whole premise.
    { url: SHELL, status: 200, hasDeclaredProduct: false, isShell: true, priceCount: 1, inStock: true },
  ];
  const sample = chooseSample(probes, { size: 3 });
  const pages = {
    [REAL[0]!]: page("storea-product"),
    [REAL[1]!]: page("storea-product-2"),
    [SHELL]: page("storeb-shell"),
  };

  async function run(): Promise<{ manuscript: Manuscript; sources: ReturnType<typeof sourcesOf> }> {
    const sources = sourcesOf(pages, {});
    return { manuscript: await investigate({ site: "mixed.test", fields: FIELDS, sample, sources, now: NOW }), sources };
  }

  it("fetches all three, because one real page is enough to be worth the cheapest request", async () => {
    const { manuscript, sources } = await run();
    expect(sources.fetched.sort()).toEqual([...REAL, SHELL].sort());
    expect(manuscript.sample.picks).toHaveLength(3);
    expect(manuscript.sample.picks.every((pick) => pick.bound)).toBe(true);
    // Tier 1 is skipped only when the shell rule fires on *all* of them.
    expect(tier(manuscript, 1).outcome).toBe("ran");
  });

  it("still binds every field the two real pages agree on", async () => {
    const { manuscript } = await run();
    expect(tier(manuscript, 1).covered.sort()).toEqual(["listPrice", "productName", "promoPrice", "sku", "stock"]);
    expect(field(manuscript, "productName").path).toBe("name");
    expect(field(manuscript, "productName").tier).toBe(1);
    expect(field(manuscript, "sku").path).toBe("sku");
    expect(field(manuscript, "listPrice").path).toBe("product:price:amount");
    expect(field(manuscript, "promoPrice").path).toBe("product:sale_price:amount");
    expect(field(manuscript, "stock").path).toBe("offers.availability");
    expect(manuscript.uncovered).toEqual([]);
    expect(manuscript.verdict).toBe("covered");
  });

  it("reads the two pages that declared, and says the shell was left out of the comparison", async () => {
    const { manuscript } = await run();
    // The shell is still fetched, still recorded, still an obstacle — it is
    // only the *binding comparison* it is kept out of.
    expect(manuscript.obstacles.some((obstacle) => obstacle.kind === "shell" && obstacle.url === SHELL && !obstacle.blocking)).toBe(true);
    expect(tier(manuscript, 1).sources).toHaveLength(3);
    expect(tier(manuscript, 1).because).toContain("2 plain fetch");
    // And the canary comes off a page a reader was served, as it already did.
    expect(manuscript.canary?.declaredProduct).toBe(true);
    expect(manuscript.canary?.url).not.toContain("render-later");
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

// ------------------- shape 2a: one sample the store cannot serve, and 92 payloads of noise

/**
 * The second live run of the cascade, 2026-09-22, and the defect *it* found.
 *
 * Three Store B URLs rendered 92, 86 and 50 payloads. The third,
 * `paracetamol-500-mg-16-comprimidos/881926.html`, is a product the store
 * itself cannot serve: `catalog-svc/products/detail/881926` answered 401
 * and then 500 twice, and the page rendered nothing but its own chrome. Tier 2
 * demanded a usable response from *every* sample before an endpoint was a
 * source, so that one broken product deleted `products/detail` — the endpoint
 * Store B's entire answer lives in — for all three. The manuscript reported
 * ten endpoints, every one of them basket, zones, coverage and Contentful
 * noise that every page loads identically, and bound 0 of 5 fields.
 *
 * It is the same defect `bindingUrls` already names one layer up: a sample with
 * nothing in it does not fail to contribute, it deletes every candidate for
 * every field, because every filter below tier 2 is an intersection.
 *
 * So the fixture is shaped like the run: three samples, a 401 before every
 * detail call because the anonymous session does not exist yet, a dozen shared
 * endpoints whose payloads are identical on every page, and one sample whose
 * detail call never gets past the 500.
 */
describe("Store B, three samples — one product the store cannot serve must not delete the endpoint", () => {
  const ids = ["100001", "100002", "100003"] as const;
  const urls = ids.map((id) => `https://example.test/p/${id}`);
  const sample = chooseSample(
    urls.map((url) => live(url, { hasDeclaredProduct: undefined, priceCount: 2, inStock: true })),
    { size: 3 },
  );
  const pages = Object.fromEntries(urls.map((url) => [url, page("storeb-shell")]));

  /**
   * The dozen endpoints every Store B page loads for itself, answering the
   * same bytes each time — the basket, the delivery zones, the coverage table,
   * the CMS. They are the ones that survived the broken grouping, so they are
   * the ones the product endpoint has to be found among.
   */
  function noise(basketId: string): Capture["responses"] {
    const api = "https://api.example.test";
    return [
      { url: `${api}/customer-svc/login`, status: 200, body: { authType: "guest", locale: "es-CL" } },
      { url: "https://profiles.example.test/identity/v1/client/auth", status: 200, body: { granted: true, scope: "anonymous" } },
      { url: `${api}/catalog-svc/categories/category-tree`, status: 200, body: { categories: [{ id: "medicamentos", name: "Medicamentos" }] } },
      { url: `${api}/catalog-svc/zones`, status: 200, body: { zones: [{ id: "Zona0001", name: "Centro" }] } },
      { url: `${api}/settings-svc/coverage`, status: 200, body: { coverage: [{ comuna: "Centro", despacho: true }] } },
      { url: `${api}/shopping-basket-svc/basket`, status: 200, body: { total: 0, currency: "CLP", lines: 0 } },
      { url: `${api}/shopping-basket-svc/basket/detail/${basketId}`, status: 200, body: { id: basketId, total: 0, savings: 0 } },
      { url: `${api}/shopping-basket-svc/config/preferences`, status: 200, body: { pickup: true } },
      { url: "https://cdn.example.test/spaces/abc123/environments/master/entries", status: 200, body: { items: [{ headline: "Club" }] } },
      { url: "https://connect.example.test/app_config/json/244320463907739/", status: 200, body: { enabled: true } },
      { url: `${api}/catalog-svc/products/breadcrumbs/${ids[0]}`, status: 200, body: { crumbs: ["Medicamentos"] } },
      { url: `${api}/tracking/events`, status: 204, body: { ok: true } },
    ];
  }

  /** The detail endpoint, with the 401 the page always gets first. */
  function detailCalls(id: string, answer: unknown | undefined): Capture["responses"] {
    const url = `https://api.example.test/catalog-svc/products/detail/${id}`;
    return [
      { url, status: 401, body: { error: "La sesion ha expirado", errorCode: "INVALID_SESSION" } },
      answer === undefined
        ? { url, status: 500, body: { error: "Ocurrio un error en el servidor", errorCode: "INTERNAL_ERROR" } }
        : { url: `${url}?inventoryId=Zona0001`, status: 200, body: answer },
    ];
  }

  /** What each page showed a reader. The third is the site chrome and nothing else, as the broken product rendered. */
  const TEXT = [
    "Ejemplo Comprimidos 100 mg 30 Comprimidos $ 4.990 $ 4.491 Club Store B $ 3.992 Precio por Unidad Fraccionada: $ 166 por Comprimido Laboratorio Ejemplo",
    "Otro Jarabe 120 ml $ 12.990 $ 11.691 Precio por Unidad Fraccionada: $ 108 por ml Laboratorio Otro",
    "Tercero Capsulas 500 mg 16 Capsulas $ 7.490 $ 6.741 Precio por Unidad Fraccionada: $ 468 por Capsula Laboratorio Tercero",
  ];
  const CHROME = "Menu de Categorias Centro Bienvenid@ Iniciar sesion Bolsa de compras Ahorro $ 0 Total Productos (0) $ 0 Sub Total $ 0 Volver Continuar Club Store B Inscribete Preguntas frecuentes";
  const basketIds = ["0b5e1f00a00000000000000001", "0b5e1f00a00000000000000002", "0b5e1f00a00000000000000003"];

  /** `third` undefined is the live encounter: the store answered 401 then 500 and the page rendered chrome. */
  function capturesOf(third: unknown | undefined): Record<string, Capture> {
    const bodies = [detail(), detail("-2"), third];
    return Object.fromEntries(
      urls.map((url, index) => [
        url,
        {
          responses: [...noise(basketIds[index]!), ...detailCalls(ids[index]!, bodies[index])],
          text: bodies[index] === undefined ? CHROME : TEXT[index]!,
        } satisfies Capture,
      ]),
    );
  }

  const runWith = async (third: unknown | undefined): Promise<Manuscript> =>
    investigate({ site: "store-b.example", fields: FIELDS, sample, sources: sourcesOf(pages, capturesOf(third)), now: NOW });

  it("keeps the detail endpoint the third sample never got an answer from, and binds over the two that did", async () => {
    const manuscript = await runWith(undefined);

    // The endpoint survives grouping: it was asked by all three and answered by two.
    const payloads = tier(manuscript, 2).sources.filter((source) => source.match === "catalog-svc/products/detail");
    expect(payloads).toHaveLength(2);
    for (const source of payloads) expect(source.status).toBe(200);
    expect(payloads[0]!.because).toContain("got no answer");
    // And the 500 is nowhere in the manuscript as a source, because it is not one.
    expect(tier(manuscript, 2).sources.some((source) => (source.status ?? 0) >= 400)).toBe(false);

    // Which is the whole point: the three fields the payload names bind from it.
    for (const name of ["productName", "listPrice", "promoPrice"]) {
      expect(field(manuscript, name).source, name).toBe("network");
      expect(field(manuscript, name).match, name).toBe("catalog-svc/products/detail");
      expect(field(manuscript, name).tier, name).toBe(2);
    }
    expect(field(manuscript, "listPrice").path).toBe("productData.prices[price-list-std]");
    expect(field(manuscript, "listPrice").values).toEqual([4990, 12990]);
    expect(field(manuscript, "promoPrice").path).toBe("productData.prices[price-sale-std]");
    expect(field(manuscript, "productName").path).toBe("productData.name");
    expect(tier(manuscript, 2).covered.sort()).toEqual(["listPrice", "productName", "promoPrice"]);
    expect(manuscript.verdict).toBe("partial");

    // None of the twelve shared endpoints is a source of a field: they answer
    // every page identically, which is `no-variation-no-field` word for word.
    expect(manuscript.fields.every((entry) => entry.match === undefined || entry.match === "catalog-svc/products/detail")).toBe(true);
  });

  it("anchors each endpoint against the pages that answered it, not against a page that did not", async () => {
    // The third page showed a reader nothing but chrome. Anchoring the detail
    // payload against it deletes every price in the other two, which is the
    // second half of the same defect: the comparison has to be like with like.
    const manuscript = await runWith(undefined);
    const because = field(manuscript, "listPrice").because;
    expect(because).toContain("price-list-std");
    expect(field(manuscript, "listPrice").values).not.toContain(null);
  });

  it("still binds over all three when the third product is one the store can serve", async () => {
    const manuscript = await runWith(detail("-3"));
    const payloads = tier(manuscript, 2).sources.filter((source) => source.match === "catalog-svc/products/detail");
    expect(payloads).toHaveLength(3);
    expect(payloads.every((source) => !source.because.includes("got no answer"))).toBe(true);
    expect(field(manuscript, "listPrice").values).toEqual([4990, 12990, 7490]);
    expect(field(manuscript, "promoPrice").values).toEqual([4491, 11691, 6741]);
    expect(field(manuscript, "productName").values).toEqual([
      "Ejemplo Comprimidos 100 mg 30 Comprimidos",
      "Otro Jarabe 120 ml",
      "Tercero Capsulas 500 mg 16 Capsulas",
    ]);
  });

  it("drops an endpoint only two of the three pages ever asked for", async () => {
    // `products/recommendations` is on two Store B pages and not the third.
    // Relaxing "answered by every sample" must not relax "asked by every
    // sample" with it, or a page's own furniture becomes a source.
    const captures = capturesOf(detail("-3"));
    for (const url of urls.slice(0, 2)) {
      captures[url] = {
        ...captures[url]!,
        responses: [...captures[url]!.responses, { url: "https://api.example.test/catalog-svc/products/recommendations/product-to-product", status: 200, body: { recommended: [1, 2, 3] } }],
      };
    }
    const manuscript = await investigate({ site: "store-b.example", fields: FIELDS, sample, sources: sourcesOf(pages, captures), now: NOW });
    expect(tier(manuscript, 2).sources.some((source) => (source.match ?? "").includes("recommendations"))).toBe(false);
  });
});

// -------------------------- shape 2b: a shell behind a WAF, which is not a refusal

/**
 * The first live run of the cascade, 2026-09-22, and the defect it found.
 *
 * Three Store B product URLs, driven from a Mac the store answers perfectly.
 * Each plain fetch came back ~2,800 characters of JS shell with Imperva's
 * always-on resource in the head — no declared product, ~0 characters of visible
 * text — and `blocked.ts`'s corroboration rule reads that, word for word, as a
 * challenge interstitial. The cascade reported:
 *
 *   verdict: blocked — 3 of 3 URLs answered with a refusal (challenge):
 *   a page with no declared product and 0 characters of text loads
 *   _Incapsula_Resource; the remedy is enable-proxy
 *
 * Every field unbound, every tier skipped, no canary, on a store that renders
 * 86 JSON payloads to a browser on the same machine. A shell and an interstitial
 * are the same bytes to a plain fetch. The render is what tells them apart, and
 * the point of these three tests is that it now gets to.
 */
describe("Store B behind Imperva — the plain fetch looks refused and the render disproves it", () => {
  const URLS = ["https://example.test/p/100001", "https://example.test/p/100002", "https://example.test/p/100003"];
  const sample = chooseSample(
    URLS.map((url, index) => ({ url, status: 200, priceCount: index === 1 ? 1 : 2, inStock: index !== 2 })),
    { size: 3 },
  );
  /** Every binding URL answers the same shell, marker and all. 3 of 3, as the live run did. */
  const pages = Object.fromEntries(URLS.map((url) => [url, page("storeb-shell-waf")]));

  /** A third payload, by substitution: what is under test is the cascade, not a third JSON file. */
  const THIRD: unknown = JSON.parse(
    readFileSync(join(DIR, "storeb-detail.json"), "utf8")
      .replace(/100001/g, "100003")
      .replace(/Ejemplo Comprimidos 100 mg 30 Comprimidos/g, "Tercero Comprimidos 50 mg 10 Comprimidos")
      .replace(/4990/g, "8990")
      .replace(/4491/g, "8091"),
  );
  const TEXT = [
    "Ejemplo Comprimidos 100 mg 30 Comprimidos $ 4.990 $ 4.491 Club Store B $ 3.992 Laboratorio Ejemplo",
    "Otro Jarabe 120 ml $ 12.990 $ 11.691 Laboratorio Otro",
    "Tercero Comprimidos 50 mg 10 Comprimidos $ 8.990 $ 8.091 Laboratorio Ejemplo",
  ];
  const payloads = [detail(), detail("-2"), THIRD];
  const answered: Record<string, Capture> = Object.fromEntries(
    URLS.map((url, index) => [
      url,
      {
        responses: [
          { url: `https://api.example.test/catalog-svc/products/detail/10000${index + 1}`, status: 200, body: payloads[index] },
          { url: "https://api.example.test/tracking/events", status: 204, body: { ok: true } },
        ],
        text: TEXT[index]!,
      } satisfies Capture,
    ]),
  );

  it("is not blocked, and binds the payload's fields at tier 2", async () => {
    const sources = sourcesOf(pages, answered);
    const manuscript = await investigate({ site: "store-b.example", fields: FIELDS, sample, sources, now: NOW });

    expect(manuscript.verdict).not.toBe("blocked");
    expect(tier(manuscript, 2).outcome).toBe("ran");
    expect(field(manuscript, "productName").tier).toBe(2);
    expect(field(manuscript, "productName").path).toBe("productData.name");
    expect(field(manuscript, "listPrice").tier).toBe(2);
    expect(field(manuscript, "listPrice").path).toBe("productData.prices[price-list-std]");
    expect(field(manuscript, "promoPrice").path).toBe("productData.prices[price-sale-std]");
    // One render per binding URL, and not one per question: the capture taken
    // to settle the refusal is the capture tier 2 binds from.
    expect([...sources.captured].sort()).toEqual([...URLS].sort());
  });

  it("writes down that the plain fetch looked like a refusal and the render disproved it", async () => {
    const manuscript = await investigate({ site: "store-b.example", fields: FIELDS, sample, sources: sourcesOf(pages, answered), now: NOW });
    const deferred = manuscript.obstacles.find((obstacle) => obstacle.kind === "deferred")!;
    expect(deferred.blocking).toBe(false);
    expect(deferred.because).toContain("look refused");
    expect(deferred.because).toContain("_Incapsula_Resource");
    expect(deferred.because).toContain("the render disproved it");
    // Sitting behind a WAF is still a fact worth committing — it is the cost
    // line in "can we run this daily from a datacenter" — but it stopped nothing.
    expect(manuscript.obstacles.some((obstacle) => obstacle.kind === "challenge" && !obstacle.blocking)).toBe(true);
    expect(manuscript.obstacles.every((obstacle) => !obstacle.blocking)).toBe(true);
    expect(render(manuscript)).toContain("the render disproved it");
  });

  it("still reports blocked when the render produces nothing, and binds nothing", async () => {
    // The same three shells, and this time the site really is refusing: the
    // browser gets past no further than the plain fetch did.
    const sources = sourcesOf(pages, Object.fromEntries(URLS.map((url) => [url, { responses: [] } satisfies Capture])));
    const manuscript = await investigate({ site: "store-b.example", fields: FIELDS, sample, sources, now: NOW });

    expect(manuscript.verdict).toBe("blocked");
    expect(manuscript.because).toContain("enable-proxy");
    expect(manuscript.because).toContain("neither a page nor a payload");
    expect(manuscript.fields.every((entry) => entry.path === undefined)).toBe(true);
    expect(manuscript.uncovered).toEqual(FIELDS.map((entry) => entry.name));
    for (const n of [1, 2, 3] as const) expect(tier(manuscript, n).outcome).toBe("skipped");
    expect(tier(manuscript, 2).because).toContain("destroyed by its own repair");
    expect(manuscript.obstacles.some((obstacle) => obstacle.kind === "deferred" && obstacle.blocking)).toBe(true);
    expect(manuscript.canary).toBeUndefined();
  });

  it("still reports blocked when the render produces an apology, and binds nothing", async () => {
    // The StoreC shape arriving one tier later: the shell fills, with the
    // store's error page. Substantial text, no declared product, the same
    // document on every URL — and `apologySignals` has it.
    const apology = page("apology");
    const sources = sourcesOf(
      pages,
      Object.fromEntries(URLS.map((url) => [url, { responses: [], html: apology, text: visibleText(apology) } satisfies Capture])),
    );
    const manuscript = await investigate({ site: "store-b.example", fields: FIELDS, sample, sources, now: NOW });

    expect(manuscript.verdict).toBe("blocked");
    expect(manuscript.because).toContain("the render confirmed it");
    expect(manuscript.because).toContain("enable-proxy");
    expect(manuscript.fields.every((entry) => entry.path === undefined)).toBe(true);
    expect(manuscript.obstacles.some((obstacle) => obstacle.kind === "apology" && obstacle.blocking)).toBe(true);
    // A fingerprint of the page a blocked site serves is a fingerprint of the refusal.
    expect(manuscript.canary).toBeUndefined();
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
