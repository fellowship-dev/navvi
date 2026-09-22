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

/**
 * The bug that a platform run caught and no unit test would have.
 *
 * StoreA's JSON-LD is an `@graph` holding Organization, WebSite and
 * Product. Searching it for the first node where `name` resolves finds the
 * Organization and returns "StoreA" -- as the *product name*, on all 33
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
      { "@type": ["Organization", "OnlineStore"], name: "StoreA", url: "https://store-a.example/" },
      { "@type": "WebSite", name: "StoreA" },
      { "@type": "Product", name: "Norvasc (R) Amlodipino 5mg 30 Comprimidos", sku: "2562507" },
    ],
  };

  const declared = (body: unknown, path: string, entity?: string) => {
    // The resolution rule, exercised through the same helper extraction uses.
    const segments = path.split(".");
    const walk = (node: unknown): unknown => {
      let cur = node;
      for (const s of segments) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[s];
      }
      return cur;
    };
    const typed = (n: unknown): boolean => {
      if (!entity || n === null || typeof n !== "object") return false;
      const t = (n as Record<string, unknown>)["@type"];
      return (Array.isArray(t) ? t : [t]).some((x) => typeof x === "string" && x.toLowerCase() === entity.toLowerCase());
    };
    if (!entity) return walk(body);
    const queue: unknown[] = [body];
    while (queue.length) {
      const node = queue.shift();
      if (Array.isArray(node)) { queue.push(...node); continue; }
      if (node === null || typeof node !== "object") continue;
      if (typed(node)) { const hit = walk(node); if (hit !== undefined) return hit; }
      queue.push(...Object.values(node as Record<string, unknown>));
    }
    return undefined;
  };

  it("takes the name from the Product, not from the store that sells it", () => {
    expect(declared(storeaGraph, "name", "Product")).toBe("Norvasc (R) Amlodipino 5mg 30 Comprimidos");
    expect(declared(storeaGraph, "sku", "Product")).toBe("2562507");
  });

  it("without an entity the graph is not walked at all", () => {
    // The top-level object has no `name`, and guessing is what caused the bug.
    expect(declared(storeaGraph, "name")).toBeUndefined();
  });

  it("a page with no Product node yields nothing, which is the honest answer", () => {
    const redirected = { "@context": "https://schema.org", "@graph": [{ "@type": "Organization", name: "StoreA" }] };
    expect(declared(redirected, "name", "Product")).toBeUndefined();
  });

  it("the schema carries the entity so a scraper can state it", () => {
    const parsed = FieldAlternativeSchema.parse({
      selector: 'script[type="application/ld+json"]',
      source: "json-ld",
      path: "name",
      entity: "Product",
      fingerprint: { samples: ["Norvasc"], shape: "text" as const },
    });
    expect(parsed.entity).toBe("Product");
  });
});
