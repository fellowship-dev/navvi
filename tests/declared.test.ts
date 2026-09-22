import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bank } from "../src/heuristics/index.js";
import { coversSpec, declaredFrom, jsonLdBlocks, readDeclared, type DeclaredSource } from "../src/investigate/declared.js";

/**
 * U2a: tier 1, the declared extractor. One plain HTTP fetch, no browser, no
 * model — so every test here is a string in and a list out.
 *
 * The fixtures are synthetic with shapes probed live on 2026-09-22. navvi is a
 * public repository and a client's catalogue is not test data; the shape is
 * what the code has to handle, and the shape is public the moment you open the
 * page.
 */

const DIR = join(import.meta.dirname, "fixtures", "investigate");
const page = (name: string): string => readFileSync(join(DIR, `${name}.html`), "utf8");

/** The value at a path, whichever declaration stated it. */
const at = (sources: readonly DeclaredSource[], path: string): DeclaredSource | undefined => sources.find((source) => source.path === path);
const paths = (sources: readonly DeclaredSource[]): string[] => sources.map((source) => source.path);

describe("declaredFrom — StoreA, the encounter", () => {
  const sources = declaredFrom(page("storea-product"));

  /**
   * The verification the plan asks for: the five fields the client scraper was
   * hunting through `body.one-col.christmas-pattern` for, all of them out of
   * one HTTP request. No browser was opened to produce this list.
   */
  it("returns all five requested fields from one plain fetch", () => {
    expect(at(sources, "og:title")?.value).toBe("Ejemplo Complejo B 30 Comprimidos");
    expect(at(sources, "product:retailer_item_id")?.value).toBe("8820237");
    expect(at(sources, "product:price:amount")?.value).toBe("14990");
    expect(at(sources, "product:sale_price:amount")?.value).toBe("10493");
    expect(at(sources, "product:availability")?.value).toBe("in stock");
  });

  it("reads the Product node of the @graph and nothing else in it", () => {
    expect(at(sources, "name")?.value).toBe("Ejemplo Complejo B 30 Comprimidos");
    expect(at(sources, "sku")?.value).toBe("8820237");
    expect(at(sources, "brand.name")?.value).toBe("Laboratorio Ejemplo");
    expect(at(sources, "offers.price")?.value).toBe("10493");
    // The Organization and the WebSite in the same @graph are also named
    // "StoreA". Neither is read, so neither can become a product name.
    expect(sources.some((source) => source.value === "StoreA")).toBe(false);
  });

  it("spells a json-ld finding the way the compiled scraper reads it back", () => {
    const price = at(sources, "offers.price")!;
    expect(price.kind).toBe("json-ld");
    expect(price.source).toBe("json-ld");
    expect(price.entity).toBe("Product");
    expect(price.selector).toBe('script[type="application/ld+json"]');
  });

  /**
   * FIELD_SOURCES is dom | json-ld | network and this unit does not add to it.
   * A <meta> tag is an element of the document the plain fetch already
   * returned, so OpenGraph rides in as a `dom` alternative — an exact attribute
   * match on a <head> element, which is the opposite of the seasonal body class
   * it replaces.
   */
  it("hands a meta finding over as a dom alternative, ready to compile", () => {
    const sale = at(sources, "product:sale_price:amount")!;
    expect(sale.kind).toBe("meta");
    expect(sale.source).toBe("dom");
    expect(sale.selector).toBe('meta[property="product:sale_price:amount"]');
    expect(sale.attr).toBe("content");
  });

  it("ignores schema.org bookkeeping and the head's ordinary SEO boilerplate", () => {
    expect(paths(sources).some((path) => path.includes("@"))).toBe(false);
    expect(paths(sources)).not.toContain("description");
    expect(paths(sources)).not.toContain("viewport");
  });
});

describe("declaredFrom — the JSON-LD gate", () => {
  /**
   * StoreA's 33 redirect URLs. The @graph holds an Organization and a
   * WebSite and no Product; a graph walk that keeps walking until something has
   * a name bound productName to "StoreA" on every one of them.
   */
  it("returns no declared product when the graph declares none", () => {
    const { sources, verdicts } = readDeclared(page("storea-redirect"));
    expect(sources.filter((source) => source.kind === "json-ld")).toEqual([]);
    expect(sources.some((source) => source.value === "StoreA" && source.kind !== "meta")).toBe(false);

    const gate = verdicts.find((entry) => entry.id === "json-ld-needs-product-node")!;
    expect(gate.verdict.fires).toBe(true);
    expect(gate.verdict.because).toContain("no Product node");
  });

  /**
   * And the other half of that encounter: the product: price meta survived the
   * redirect, which is how those 33 rows got a price to sit beside the wrong
   * name. Tier 1 returning a meta finding is not proof of a product page — the
   * variation check in `leaves.ts` still has to run over several samples.
   */
  it("still reports the meta tag that survived the redirect, because it is there", () => {
    const sources = declaredFrom(page("storea-redirect"));
    expect(at(sources, "product:price:amount")?.value).toBe("14990");
    expect(at(sources, "og:title")?.value).toBe("StoreA");
  });

  it("reports the gate as not firing on a page that does declare one", () => {
    const { verdicts } = readDeclared(page("storec-product"));
    const gate = verdicts.find((entry) => entry.id === "json-ld-needs-product-node")!;
    expect(gate.verdict.fires).toBe(false);
  });

  it("honours a case override: a silenced gate says so rather than going quiet", () => {
    const view = bank({ "json-ld-needs-product-node": { enabled: false, note: "client: this store's graph is hand-written" } });
    const { verdicts } = readDeclared(page("storea-redirect"), { view });
    const gate = verdicts.find((entry) => entry.id === "json-ld-needs-product-node")!;
    expect(gate.verdict.fires).toBe(false);
    expect(gate.verdict.because).toContain("disabled for this case");
  });
});

describe("declaredFrom — StoreC, a bare Product block", () => {
  const sources = declaredFrom(page("storec-product"));

  it("reads a top-level Product with no @graph around it", () => {
    expect(at(sources, "name")?.value).toBe("Ejemplo Ibuprofeno 400 mg 20 Comprimidos");
    expect(at(sources, "sku")?.value).toBe("300123");
    expect(at(sources, "offers.price")?.value).toBe("5490");
    expect(at(sources, "offers.availability")?.value).toBe("https://schema.org/InStock");
  });

  it("ignores a block of the wrong type and survives one the site broke", () => {
    // Three blocks: a Product, a BreadcrumbList, and one that is not JSON.
    expect(jsonLdBlocks(page("storec-product"))).toHaveLength(2);
    expect(paths(sources)).not.toContain("itemListElement");
  });
});

describe("declaredFrom — microdata", () => {
  const sources = declaredFrom(page("microdata-product"));

  it("reads a nested item under the same path a json-ld offer would have", () => {
    expect(at(sources, "name")?.value).toBe("Ejemplo Paracetamol 500 mg 16 Comprimidos");
    expect(at(sources, "sku")?.value).toBe("410077");
    expect(at(sources, "offers.price")?.value).toBe("7490");
    expect(at(sources, "offers.availability")?.value).toBe("https://schema.org/InStock");
    expect(at(sources, "brand.name")?.value).toBe("Laboratorio Ejemplo");
  });

  /**
   * The footer declares its own Organization item whose itemprop="name" is
   * "Farmacia Ejemplo". An itemprop belongs to its nearest enclosing itemscope
   * and to nothing else, so it never reaches the Product.
   */
  it("honours the itemscope stack, so the footer's name is not the product's", () => {
    expect(sources.some((source) => source.value === "Farmacia Ejemplo")).toBe(false);
    expect(paths(sources)).not.toContain("telephone");
  });

  it("emits the machine attribute, not the rendered price beside it", () => {
    const price = at(sources, "offers.price")!;
    expect(price.source).toBe("dom");
    expect(price.attr).toBe("content");
    expect(price.selector).toBe('[itemtype*="/Product"] [itemprop="offers"] [itemprop="price"]');
    // "$ 7.490" is the same number formatted for a person; a decimal reading
    // makes it seven, and the content attribute cannot be misread.
    expect(sources.some((source) => String(source.value).includes("$"))).toBe(false);
  });

  it("takes the element's text when the element declares no value attribute", () => {
    expect(at(sources, "name")?.attr).toBeUndefined();
  });

  /**
   * `brand.name` and the product's own `name` are both `itemprop="name"`. A
   * selector built from the last path segment alone binds the brand to the
   * <h1>, which is the microdata spelling of the Organization-node defect.
   */
  it("nests the selector the way the item nests, so brand.name is not the h1", () => {
    expect(at(sources, "brand.name")?.selector).toBe('[itemtype*="/Product"] [itemprop="brand"] [itemprop="name"]');
    expect(at(sources, "name")?.selector).toBe('[itemtype*="/Product"] [itemprop="name"]');
  });
});

describe("coversSpec — the stop-at-tier-1 answer", () => {
  const requested = ["productName", "sku", "listPrice", "promoPrice", "stock"];

  it("fires when the page stated every requested field, so tiers 2 and 3 never run", () => {
    const sources = declaredFrom(page("storea-product"));
    const bound = {
      productName: at(sources, "og:title")!.value,
      sku: at(sources, "product:retailer_item_id")!.value,
      listPrice: at(sources, "product:price:amount")!.value,
      promoPrice: at(sources, "product:sale_price:amount")!.value,
      stock: at(sources, "product:availability")!.value,
    };
    const verdict = coversSpec(bound, requested);
    expect(verdict.fires).toBe(true);
    expect(verdict.action).toContain("stop at tier 1");
  });

  it("names what is still missing rather than stopping early", () => {
    const sources = declaredFrom(page("storec-product"));
    const verdict = coversSpec({ productName: at(sources, "name")!.value, sku: at(sources, "sku")!.value, listPrice: null, promoPrice: null, stock: null }, requested);
    expect(verdict.fires).toBe(false);
    expect(verdict.because).toContain("listPrice");
  });
});

describe("declaredFrom — the scanner", () => {
  it("returns nothing for a page that declares nothing", () => {
    expect(declaredFrom("<html><body><h1>Hola</h1><p>$ 4.990</p></body></html>")).toEqual([]);
  });

  it("does not let a < inside a JSON-LD string start a tag", () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Product","name":"Ahorra <50% Ejemplo","sku":"9"}
    </script></head><body></body></html>`;
    expect(at(declaredFrom(html), "name")?.value).toBe("Ahorra <50% Ejemplo");
  });

  it("reads og: out of a name= attribute too, and says which one to select on", () => {
    const html = `<html><head><meta name="og:title" content="Ejemplo"></head></html>`;
    const title = at(declaredFrom(html), "og:title")!;
    expect(title.value).toBe("Ejemplo");
    expect(title.selector).toBe('meta[name="og:title"]');
  });

  it("decodes attribute entities and unquoted attribute values", () => {
    const html = `<html><head><meta property=og:title content="Ejemplo &amp; C&#237;a"></head></html>`;
    expect(at(declaredFrom(html), "og:title")?.value).toBe("Ejemplo & Cía");
  });

  it("skips a commented-out declaration, as a browser does", () => {
    const html = `<html><head><!-- <meta property="og:title" content="Fantasma"> --><meta property="og:url" content="https://example.test/"></head></html>`;
    const sources = declaredFrom(html);
    expect(paths(sources)).toEqual(["og:url"]);
  });

  it("drops a declaration whose value is empty, because that is the page saying nothing", () => {
    const html = `<html><head><meta property="og:title" content="  "><meta property="og:url" content="https://example.test/"></head></html>`;
    expect(paths(declaredFrom(html))).toEqual(["og:url"]);
  });

  it("states the same fact once, however many times the page repeats it", () => {
    const html = `<html><head><meta property="og:title" content="Ejemplo"><meta property="og:title" content="Ejemplo"></head></html>`;
    expect(declaredFrom(html)).toHaveLength(1);
  });

  it("honours the cap on how much it will carry off one page", () => {
    expect(declaredFrom(page("storea-product"), { maxSources: 3 })).toHaveLength(3);
  });

  it("takes any schema.org type, not only Product", () => {
    const html = `<html><head><script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"StoreA","url":"https://example.test/"}]}
    </script></head></html>`;
    expect(at(declaredFrom(html, { want: "Organization" }), "name")?.value).toBe("StoreA");
    expect(declaredFrom(html, { want: "Product" })).toEqual([]);
  });
});
