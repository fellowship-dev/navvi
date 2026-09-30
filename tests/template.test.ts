import { describe, expect, it } from "vitest";
import { cacheKey, type CompiledScraper } from "../src/scraper/schema.js";
import {
  groupByTemplate,
  matchesTemplate,
  pickSampleRows,
  pickSampleUrls,
  templateGrowth,
  templateKey,
  urlPattern,
} from "../src/template/index.js";
import { loginFixture } from "./helpers.js";

const DEMO = "http://127.0.0.1:4321/demo/pharmacy";
const SLUGS = [
  "ibuprofeno-400",
  "paracetamol-500",
  "amoxicilina-500",
  "loratadina-10",
  "omeprazol-20",
  "losartan-50",
  "metformina-850",
  "atorvastatina-20",
  "salbutamol-100",
  "diclofenaco-50",
  "cetirizina-10",
  "aspirina-100",
];
const demoProducts = SLUGS.map((s) => `${DEMO}/producto/${s}.html`);
const demoListing = `${DEMO}/index.html`;

describe("urlPattern (KTD15)", () => {
  it("blanks the varying leaf and keeps the .html suffix", () => {
    expect(urlPattern(demoProducts)).toBe("/demo/pharmacy/producto/{slug}.html");
  });

  it("classifies numeric and slug segments", () => {
    expect(urlPattern(["https://site.cl/p/123/ibuprofeno-400", "https://site.cl/p/456/paracetamol"])).toBe("/p/{n}/{slug}");
  });

  it("handles a single URL sensibly", () => {
    expect(urlPattern(["https://site.cl/p/123"])).toBe("/p/{n}");
    expect(urlPattern(["https://site.cl/item/3f2504e0-4f89-11d3-9a0c-0305e82c3301"])).toBe("/item/{id}");
    expect(urlPattern(["https://site.cl/item/9f86d081884c7d659a2feaa0c55ad015"])).toBe("/item/{id}");
    expect(urlPattern(["https://site.cl/producto/ibuprofeno-400.html"])).toBe("/producto/{slug}.html");
    expect(urlPattern(["https://site.cl/jobs"])).toBe("/jobs");
    expect(urlPattern(["https://site.cl/"])).toBe("/");
    expect(urlPattern([demoListing])).toBe("/demo/pharmacy/index.html");
  });

  it("keeps a segment that is identical across all URLs literally, even when numeric", () => {
    expect(urlPattern(["https://site.cl/v2/p/1", "https://site.cl/v2/p/2"])).toBe("/v2/p/{n}");
  });

  it("drops query strings except known pagination keys", () => {
    expect(urlPattern(["https://site.cl/jobs?page=2"])).toBe("/jobs?page={page}");
    expect(urlPattern(["https://site.cl/jobs?utm_source=x"])).toBe("/jobs");
    expect(urlPattern(["https://site.cl/jobs?utm_source=x&offset=40&sort=asc"])).toBe("/jobs?offset={offset}");
    expect(urlPattern(["https://site.cl/jobs?p=1&start=10"])).toBe("/jobs?p={p}&start={start}");
    expect(urlPattern(["https://site.cl/jobs#top"])).toBe("/jobs");
  });

  it("ignores a trailing slash", () => {
    expect(urlPattern(["https://site.cl/jobs/", "https://site.cl/jobs"])).toBe("/jobs");
  });

  it("rejects an empty or invalid input", () => {
    expect(() => urlPattern([])).toThrow(/at least one URL/);
    expect(() => urlPattern(["not a url"])).toThrow(/invalid URL/);
  });
});

describe("templateKey", () => {
  it("is host plus pattern, never the URL", () => {
    expect(templateKey("127.0.0.1:4321", "/demo/pharmacy/producto/{slug}.html")).toBe(
      "127.0.0.1:4321/demo/pharmacy/producto/{slug}.html",
    );
    expect(templateKey("Site.CL", "/jobs")).toBe("site.cl/jobs");
  });
});

describe("groupByTemplate (R29, R30)", () => {
  it("puts twelve demo products under one key and the listing under a second", () => {
    const groups = groupByTemplate([demoListing, ...demoProducts]);
    expect([...groups.keys()].sort()).toEqual([
      "127.0.0.1:4321/demo/pharmacy/index.html",
      "127.0.0.1:4321/demo/pharmacy/producto/{slug}.html",
    ]);
    expect(groups.get("127.0.0.1:4321/demo/pharmacy/producto/{slug}.html")).toEqual(demoProducts);
    expect(groups.get("127.0.0.1:4321/demo/pharmacy/index.html")).toEqual([demoListing]);
  });

  it("separates the same path shape on two hosts by host", () => {
    const a = ["https://farmacia-a.cl/producto/ibuprofeno-400.html", "https://farmacia-a.cl/producto/paracetamol-500.html"];
    const b = ["https://farmacia-b.cl/producto/ibuprofeno-400.html", "https://farmacia-b.cl/producto/paracetamol-500.html"];
    const groups = groupByTemplate([...a, ...b]);
    expect([...groups.keys()].sort()).toEqual([
      "farmacia-a.cl/producto/{slug}.html",
      "farmacia-b.cl/producto/{slug}.html",
    ]);
    expect(groups.get("farmacia-a.cl/producto/{slug}.html")).toEqual(a);
    expect(groups.get("farmacia-b.cl/producto/{slug}.html")).toEqual(b);
  });

  it("splits different literal route prefixes on one host into different templates", () => {
    const groups = groupByTemplate([
      "https://site.cl/p/123/ibuprofeno-400",
      "https://site.cl/jobs/456/backend-dev-2",
      "https://site.cl/p/789/paracetamol",
    ]);
    expect([...groups.keys()].sort()).toEqual(["site.cl/jobs/{n}/{slug}", "site.cl/p/{n}/{slug}"]);
  });

  it("keeps a paginated listing apart from its first page by the documented convention", () => {
    const groups = groupByTemplate(["https://site.cl/jobs", "https://site.cl/jobs?page=2", "https://site.cl/jobs?page=3"]);
    expect([...groups.keys()].sort()).toEqual(["site.cl/jobs", "site.cl/jobs?page={page}"]);
    expect(groups.get("site.cl/jobs?page={page}")).toEqual(["https://site.cl/jobs?page=2", "https://site.cl/jobs?page=3"]);
  });

  it("dedupes repeated URLs and drops invalid ones", () => {
    const groups = groupByTemplate([demoListing, demoListing, "nope"]);
    expect(groups.get("127.0.0.1:4321/demo/pharmacy/index.html")).toEqual([demoListing]);
    expect(groups.size).toBe(1);
  });

  it("is stable across two calls and independent of input order", () => {
    const urls = [demoListing, ...demoProducts, "https://site.cl/p/123/ibuprofeno-400", "https://site.cl/p/456/paracetamol"];
    const first = groupByTemplate(urls);
    const second = groupByTemplate(urls);
    const reversed = groupByTemplate([...urls].reverse());
    expect([...second.keys()]).toEqual([...first.keys()]);
    expect([...reversed.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [key, members] of first) {
      expect([...(reversed.get(key) ?? [])].sort()).toEqual([...members].sort());
    }
  });

  // It passed the same URL array forward and reversed, so "version two" was never
  // exercised: the order half is the test above, and the blanked slug is
  // `urlPattern (KTD15) :: blanks the varying leaf and keeps the .html suffix`.
});

describe("templateGrowth (R29 summary)", () => {
  function withExtraTitle(doc: CompiledScraper): CompiledScraper {
    const title = doc.fields.title;
    if (!title) throw new Error("fixture has a title field");
    return {
      ...doc,
      fields: {
        ...doc.fields,
        title: { alternatives: [...title.alternatives, { selector: "h3 a", fingerprint: { samples: ["x"], shape: "text" } }] },
      },
    };
  }

  it("reports no growth without a previous scraper or when counts are equal", () => {
    const doc = loginFixture();
    expect(templateGrowth(undefined, doc)).toEqual({ grew: false, fields: [], steps: [] });
    expect(templateGrowth(loginFixture(), doc)).toEqual({ grew: false, fields: [], steps: [] });
  });

  it("names the field whose alternatives grew", () => {
    const previous = loginFixture();
    const current = withExtraTitle(previous);
    expect(templateGrowth(previous, current)).toEqual({ grew: true, fields: ["title"], steps: [] });
  });

  it("names the trace step whose alternatives grew", () => {
    const previous = loginFixture();
    const step0 = previous.trace[0];
    if (!step0) throw new Error("fixture has a trace");
    const current: CompiledScraper = {
      ...previous,
      trace: [{ ...step0, alternatives: [...step0.alternatives, { role: "textbox", name: "E-mail", exact: false }] }, ...previous.trace.slice(1)],
    };
    expect(templateGrowth(previous, current)).toEqual({ grew: true, fields: [], steps: [0] });
  });

  it("does not count a shrink as growth", () => {
    const previous = withExtraTitle(loginFixture());
    expect(templateGrowth(previous, loginFixture())).toEqual({ grew: false, fields: [], steps: [] });
  });
});

describe("sample selection (R30)", () => {
  it("pickSampleUrls dedupes, keeps order and caps at three", () => {
    expect(pickSampleUrls(["a", "b", "a", "c", "d"])).toEqual(["a", "b", "c"]);
    expect(pickSampleUrls(["a"])).toEqual(["a"]);
    expect(pickSampleUrls(["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
    expect(pickSampleUrls([])).toEqual([]);
  });

  it("pickSampleRows returns the first indices", () => {
    expect(pickSampleRows(2)).toEqual([0, 1]);
    expect(pickSampleRows(10)).toEqual([0, 1, 2]);
    expect(pickSampleRows(0)).toEqual([]);
  });
});

describe("single-URL literal words (KTD15)", () => {
  it("keeps a dashed word without digits literal; only letters+digits with a dash is slug-like alone", () => {
    expect(urlPattern(["https://site.cl/account/my-account"])).toBe("/account/my-account");
    expect(urlPattern(["https://site.cl/jobs/456/backend-dev"])).toBe("/jobs/{n}/backend-dev");
  });
});

describe("a dotted slug (stores abbreviate inside slugs)", () => {
  it("groups with its siblings instead of becoming a template of its own", () => {
    const urls = ["https://site.cl/amoxicilina-500-mg-x-14-caps-1234.html", "https://site.cl/atorvastatina-20-mg-caja-30-comp.-recubiertos-86371.html", "https://site.cl/paracetamol-500mg.-caja-16-comp.-2757.html"];
    expect([...groupByTemplate(urls).entries()]).toEqual([["site.cl/{slug}.html", urls]]);
  });
});

describe("matchesTemplate", () => {
  it("matches literal segments exactly, {n} a number, {slug}/{id} any segment, on the same host, depth, extension and pagination", () => {
    expect(matchesTemplate("site.cl/{slug}.html", "https://site.cl/a-dotted-slug-30-comp.-86371.html")).toBe(true);
    expect(matchesTemplate("site.cl/{slug}/{n}.html", "https://site.cl/ibuprofeno-400/123.html?x=1")).toBe(true);
    expect(matchesTemplate("site.cl/{slug}/{n}.html", "https://site.cl/ibuprofeno-400/abc.html")).toBe(false);
    expect(matchesTemplate("site.cl/products/{slug}", "https://site.cl/products/any-thing?default=1")).toBe(true);
    expect(matchesTemplate("site.cl/products/{slug}", "https://site.cl/t/a/b")).toBe(false);
    expect(matchesTemplate("site.cl/products/{slug}", "https://other.cl/products/x-1")).toBe(false);
    expect(matchesTemplate("site.cl/{slug}.html", "https://site.cl/x-1")).toBe(false);
    expect(matchesTemplate("site.cl/jobs?page={page}", "https://site.cl/jobs?page=2")).toBe(true);
    expect(matchesTemplate("site.cl/jobs?page={page}", "https://site.cl/jobs")).toBe(false);
    expect(matchesTemplate("site.cl/jobs", "not a url")).toBe(false);
  });

  it("matches every URL of the template groupByTemplate made", () => {
    const urls = ["https://site.cl/p/123/ibuprofeno-400", "https://site.cl/p/456/paracetamol", "https://site.cl/p/9/x.y-1"];
    for (const [key, members] of groupByTemplate(urls)) for (const url of members) expect(matchesTemplate(key, url)).toBe(true);
  });
});

describe("a path segment that echoes the URL's own query is the query (search pages that put the term in the path)", () => {
  const a = "https://tienda.example/paracetamol?_q=paracetamol&map=ft";
  const b = "https://tienda.example/acido%20acetil?_q=acido%20acetil&map=ft";
  const category = "https://tienda.example/medicamentos";
  it("groups searches for different terms into one template, apart from a plain page of the same depth", () => {
    const grouped = groupByTemplate([a, b, category]);
    expect(grouped.get("tienda.example/{q}")).toEqual([a, b]);
    expect(grouped.get("tienda.example/medicamentos")).toEqual([category]);
  });
  it("names one search URL's template {q} on its own too, and matches every search of it", () => {
    const [key] = [...groupByTemplate([a]).keys()];
    expect(key).toBe("tienda.example/{q}");
    expect(matchesTemplate(key!, b)).toBe(true);
    expect(matchesTemplate(key!, "https://tienda.example/ibuprofeno?_q=ibuprofeno")).toBe(true);
  });
});

describe("the query-echo rule is narrow: only the last, non-numeric path segment echoing a query value of 3+ characters", () => {
  it("does not read a language prefix that repeats a lang parameter as the query", () => {
    const withQuery = ["https://shop.example/es/producto/abc?lang=es", "https://shop.example/es/producto/def?lang=es"];
    const plain = ["https://shop.example/es/producto/abc", "https://shop.example/es/producto/def"];
    expect([...groupByTemplate(withQuery).keys()]).toEqual([...groupByTemplate(plain).keys()]);
    expect([...groupByTemplate(withQuery).keys()][0]).not.toContain("{q}");
  });
  it("does not read a numeric id repeated in a sku parameter as the query", () => {
    const withQuery = ["https://shop.example/p/123?sku=123", "https://shop.example/p/456?sku=456"];
    const plain = ["https://shop.example/p/123", "https://shop.example/p/456"];
    expect([...groupByTemplate(withQuery).keys()]).toEqual([...groupByTemplate(plain).keys()]);
    expect([...groupByTemplate(withQuery).keys()][0]).not.toContain("{q}");
  });
});
