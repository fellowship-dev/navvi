import { describe, expect, it } from "vitest";
import { CompiledScraperSchema, FieldAlternativeSchema, SCRAPER_VERSION } from "../src/scraper/schema.js";
import { readDeclared } from "../src/declared/json.js";

/**
 * The extraction cascade, at the schema boundary.
 *
 * The client scrapers reached 27-44% product coverage selecting on a modal-state
 * class, a seasonal class and a Tailwind line-height. Reading what the page
 * declares instead put all three at or near 100%. A field can now say where it
 * looked, and a scraper written before it still parses.
 */
describe("field sources", () => {
  // The positive shapes of every source are asserted once, through a whole
  // scraper, by "a scraper may mix sources" below: parsing each alternative on
  // its own only echoed the literal the test had just passed in.
  const fingerprint = { samples: ["$3.690"], shape: "money" as const };

  it("refuses a declared alternative that does not say what to read", () => {
    expect(() => FieldAlternativeSchema.parse({ selector: "x", source: "json-ld", fingerprint })).toThrow(/needs a path/);
    expect(() => FieldAlternativeSchema.parse({ selector: "x", source: "network", path: "a.b", fingerprint })).toThrow(/needs a match/);
  });

  it("a scraper may mix sources, declared first and DOM as the fallback", () => {
    const scraper = CompiledScraperSchema.parse({
      version: SCRAPER_VERSION,
      templateKey: "www.store-b.example/{slug}/{n}.html",
      cacheKey: "cv-test",
      profile: "store",
      chooser: "jev",
      mode: "record",
      entry: { mode: "direct", url: "https://www.store-b.example/x/1.html" },
      trace: [],
      fields: {
        listPrice: {
          type: "money",
          alternatives: [
            // The key carries dashes, so it is addressed in brackets.
            { selector: "catalog-svc/products/detail", source: "network", match: "catalog-svc/products/detail", path: "productData.prices[price-list-std]", fingerprint },
            { selector: 'script[type="application/ld+json"]', source: "json-ld", path: "offers.price", entity: "Product", fingerprint },
            // Kept deliberately: the DOM answer is worse, not absent, and a
            // fallback that is worse still beats no value at all.
            { selector: "p.font-semibold", fingerprint },
          ],
        },
      },
      pagination: { mode: "none" },
      detail: null,
      createdAt: new Date().toISOString(),
    });

    const [network, jsonLd, dom] = scraper.fields.listPrice!.alternatives;
    expect(scraper.fields.listPrice!.alternatives).toHaveLength(3);
    expect(network).toMatchObject({ source: "network", match: "catalog-svc/products/detail", path: "productData.prices[price-list-std]" });
    // The entity is the half that stops the Store A Organization answering as the Product.
    expect(jsonLd).toMatchObject({ source: "json-ld", path: "offers.price", entity: "Product" });
    // No source at all is a DOM selector, exactly as before.
    expect(dom!.source).toBeUndefined();
  });
});

/**
 * The bug that a platform run caught and no unit test would have.
 *
 * Store A's JSON-LD is an `@graph` holding Organization, WebSite and
 * Product. Searching it for the first node where `name` resolves finds the
 * Organization and returns "Store A" -- as the *product name*, on all 33
 * URLs that redirect away from their product page. Those rows carried a name, a
 * SKU taken from the URL and a price from a surviving meta tag, so they passed
 * every "did it extract?" check and would have gone into a price index as real
 * products at invented prices.
 *
 * Reproducing a blank is parity. Inventing a product is worse than the bug
 * being replaced.
 */
describe("reading a value out of a JSON-LD graph", () => {
  const storeaGraph = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": ["Organization", "OnlineStore"], name: "Store A", url: "https://store-a.example/" },
      { "@type": "WebSite", name: "Store A" },
      { "@type": "Product", name: "Norvasc (R) Amlodipino 5mg 30 Comprimidos", sku: "2562507" },
    ],
  };

  // The real resolver replay calls, not a copy of it: a second spelling of the
  // rule goes on passing on its own terms while the one that runs against live
  // pages drifts -- and it was a live run, not a unit test, that caught the bug
  // below in the first place.
  const declared = (body: unknown, path: string, entity?: string) => readDeclared(body, path, entity);

  it("takes the name from the Product, not from the store that sells it", () => {
    expect(declared(storeaGraph, "name", "Product")).toBe("Norvasc (R) Amlodipino 5mg 30 Comprimidos");
    expect(declared(storeaGraph, "sku", "Product")).toBe("2562507");
  });

  it("without an entity the graph is not walked at all", () => {
    // The top-level object has no `name`, and guessing is what caused the bug.
    expect(declared(storeaGraph, "name")).toBeUndefined();
  });

  it("a page with no Product node yields nothing, which is the honest answer", () => {
    const redirected = { "@context": "https://schema.org", "@graph": [{ "@type": "Organization", name: "Store A" }] };
    expect(declared(redirected, "name", "Product")).toBeUndefined();
  });

  it("a bare top-level Product block still reads without any graph", () => {
    const bare = { "@context": "https://schema.org", "@type": "Product", name: "Norvasc", offers: { price: "3690" } };
    expect(declared(bare, "name", "Product")).toBe("Norvasc");
    expect(declared(bare, "offers.price", "Product")).toBe("3690");
  });

  /**
   * The remaining half of the same rule.
   *
   * Requiring the node be typed `Product` stops the Organization from
   * answering, but a walk that descends into every value still finds the
   * Products a page hangs off `isSimilarTo`, `isRelatedTo` or
   * `isAccessoryOrSparePartFor`, and the ones a `BreadcrumbList` carries as
   * items. Those are *other* products. Binding to one yields a row with a real
   * name at a price that is not this page's -- plausible, unfalsifiable at a
   * glance, and worse than the blank it replaces. `@graph` is the only nesting
   * a declared block may hide this page's own Product in, which is what the
   * `json-ld-needs-product-node` gate and `typedNodes` already assume — and
   * since 0001 they assume it by calling the same walk rather than by comment.
   */
  it("a Product hung off isSimilarTo is a different product and is not read", () => {
    const withRelated = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", name: "Store A" },
        {
          "@type": "WebPage",
          isSimilarTo: { "@type": "Product", name: "Losartan 50mg", offers: { price: "1990" } },
        },
      ],
    };
    expect(declared(withRelated, "name", "Product")).toBeUndefined();
    expect(declared(withRelated, "offers.price", "Product")).toBeUndefined();
  });

  it("a Product sitting in a BreadcrumbList item is not read either", () => {
    const crumbs = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, item: { "@type": "Product", name: "Ibuprofeno 400mg" } },
      ],
    };
    expect(declared(crumbs, "name", "Product")).toBeUndefined();
  });

  it("the page's own Product still wins when a related one sits beside it", () => {
    const both = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", isRelatedTo: { "@type": "Product", name: "Losartan 50mg" } },
        { "@type": "Product", name: "Norvasc (R) Amlodipino 5mg 30 Comprimidos" },
      ],
    };
    expect(declared(both, "name", "Product")).toBe("Norvasc (R) Amlodipino 5mg 30 Comprimidos");
  });

});
