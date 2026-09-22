import { describe, expect, it } from "vitest";
import { CompiledScraperSchema, FieldAlternativeSchema, SCRAPER_VERSION } from "../src/scraper/schema.js";

/**
 * The extraction cascade, at the schema boundary.
 *
 * The client scrapers reached 27-44% product coverage selecting on a modal-state
 * class, a seasonal class and a Tailwind line-height. Reading what the page
 * declares instead put all three at or near 100%. A field can now say where it
 * looked, and a scraper written before it still parses.
 */
describe("field sources", () => {
  const fingerprint = { samples: ["$3.690"], shape: "money" as const };

  it("an alternative with no source is a DOM selector, exactly as before", () => {
    const parsed = FieldAlternativeSchema.parse({ selector: "h1.product-name", fingerprint });
    expect(parsed.source).toBeUndefined();
  });

  it("accepts a json-ld alternative with a path", () => {
    const parsed = FieldAlternativeSchema.parse({
      selector: 'script[type="application/ld+json"]',
      source: "json-ld",
      path: "offers.price",
      fingerprint,
    });
    expect(parsed.path).toBe("offers.price");
  });

  it("accepts a network alternative with a match and a path", () => {
    const parsed = FieldAlternativeSchema.parse({
      selector: "catalog-svc/products/detail",
      source: "network",
      match: "catalog-svc/products/detail",
      // The key carries dashes, so it is addressed in brackets.
      path: "productData.prices[price-list-std]",
      fingerprint,
    });
    expect(parsed.match).toBeTruthy();
  });

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
            { selector: "catalog-svc/products/detail", source: "network", match: "catalog-svc/products/detail", path: "productData.prices[price-list-std]", fingerprint },
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

    expect(scraper.fields.listPrice!.alternatives).toHaveLength(2);
    expect(scraper.fields.listPrice!.alternatives[0]!.source).toBe("network");
    expect(scraper.fields.listPrice!.alternatives[1]!.source).toBeUndefined();
  });
});
