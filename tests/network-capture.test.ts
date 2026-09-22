import { describe, expect, it } from "vitest";
import { extractCaptured, pickResponse, readPath, type CapturedResponse } from "../src/browser/network-capture.js";

/**
 * Tier 2 of the extraction cascade, and the thing that settles Store B.
 *
 * Its rendered page shows three prices styled alike, which is how a compiled
 * selector caught the Club price instead of the list price; three increasingly
 * precise prompts could not separate them, because in the DOM they are not
 * separable. The payload the page fetches for itself names them outright.
 */

const storeBBody = {
  productData: {
    id: "880330",
    name: "Aspirina Infantil Ácido Acetilsalicilico 100 mg 30 Comprimidos",
    prices: { "price-list-std": 3690, "price-sale-std": 3321 },
    laboratory: "MILAB",
    stock: 1,
    hasClubPromotion: true,
    activeIngredient: "Ácido Acetilsalicílico",
  },
};

const ok = (body: unknown, url = "https://api.store-b.example/catalog-svc/products/detail/880330"): CapturedResponse => ({ url, status: 200, body });

describe("reading a captured payload", () => {
  it("addresses a key containing a dot through brackets", () => {
    // `price-list-std` is fine as a plain segment; the bracket form is what a
    // key with a dot in it would need, and both resolve the same way.
    expect(readPath(storeBBody, "productData.prices[price-list-std]")).toBe(3690);
    expect(readPath(storeBBody, "productData.prices.price-sale-std")).toBe(3321);
  });

  it("returns undefined rather than throwing on a path that is not there", () => {
    expect(readPath(storeBBody, "productData.prices.price-club-std")).toBeUndefined();
    expect(readPath(storeBBody, "nope.deeper.still")).toBeUndefined();
    expect(readPath(null, "a.b")).toBeUndefined();
    expect(readPath({ a: 1 }, "a.b")).toBeUndefined();
  });

  it("maps every field in one pass", () => {
    const got = extractCaptured([ok(storeBBody)], {
      productName: "productData.name",
      sku: "productData.id",
      listPrice: "productData.prices[price-list-std]",
      promoPrice: "productData.prices[price-sale-std]",
      // The lab, which the DOM scraper never had a field for at all.
      brand: "productData.laboratory",
      stock: "productData.stock",
    });

    expect(got).toMatchObject({
      productName: "Aspirina Infantil Ácido Acetilsalicilico 100 mg 30 Comprimidos",
      sku: "880330",
      listPrice: 3690,
      promoPrice: 3321,
      brand: "MILAB",
      stock: 1,
    });
  });
});

/**
 * Store B calls its detail endpoint twice: once before the anonymous session
 * exists, answering 401, and once after, carrying the product. Taking the first
 * match would take the failure every time.
 */
describe("picking among several calls to the same endpoint", () => {
  const failed: CapturedResponse = { url: "https://api.store-b.example/catalog-svc/products/detail/880330", status: 401, body: { error: "Unauthorized", errorCode: 401 } };

  it("skips the failed call and reads the one that succeeded", () => {
    const picked = pickResponse([failed, ok(storeBBody)], "productData.prices[price-list-std]");
    expect(picked?.status).toBe(200);
    expect(readPath(picked!.body, "productData.prices[price-list-std]")).toBe(3690);
  });

  it("prefers the newest response that actually carries the field", () => {
    const stale = ok({ productData: { prices: { "price-list-std": 1 } } });
    const fresh = ok({ productData: { prices: { "price-list-std": 2 } } });
    // A later response that lacks the field must not shadow an earlier one that has it.
    const unrelated = ok({ recommendations: [] });
    expect(readPath(pickResponse([stale, fresh, unrelated], "productData.prices[price-list-std]")!.body, "productData.prices[price-list-std]")).toBe(2);
  });

  it("reports nothing rather than guessing when no call carried the field", () => {
    expect(pickResponse([failed], "productData.name")).toBeNull();
    expect(extractCaptured([failed], { productName: "productData.name" })).toEqual({ productName: undefined });
  });

  it("never returns a 4xx or 5xx body as data", () => {
    // The 401 body has an `error` key; asking for it must still refuse.
    expect(pickResponse([failed], "error")).toBeNull();
  });
});
