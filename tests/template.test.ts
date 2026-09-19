import { describe, expect, it } from "vitest";
import { cacheKey, type CompiledScraper } from "../src/scraper/schema.js";
import {
  groupByTemplate,
  pickSampleRows,
  pickSampleUrls,
  templateGrowth,
  templateKey,
  urlPattern,
} from "../src/template/index.js";
import { loginFixture } from "./scraper-schema.test.js";

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

  it("gives version one and version two of the demo (same URLs) the same cache key", () => {
    const input = { goal: "prices", description: "pharmacy catalog", fields: ["name", "price"], profile: "local" as const };
    const v1 = [...groupByTemplate(demoProducts).keys()];
    const v2 = [...groupByTemplate([...demoProducts].reverse()).keys()];
    expect(v1).toHaveLength(1);
    expect(v2).toEqual(v1);
    expect(cacheKey(v1[0] ?? "", input)).toBe(cacheKey(v2[0] ?? "", input));
    expect(cacheKey(v1[0] ?? "", input)).not.toContain("ibuprofeno");
  });
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
