import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { extractPage, fingerprintMatches, resolveUrl, shapeOf } from "../src/scraper/extract.js";
import { validateScraper, type CompiledScraper } from "../src/scraper/schema.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

let server: FixtureServer;
let browser: LaunchedBrowser;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launch({ browser: "chromium", headed: false });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function withPage<T>(url: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.context.newPage();
  try {
    await page.goto(`${server.baseUrl}${url}`);
    return await fn(page);
  } finally {
    await page.close();
  }
}

function scraper(partial: Partial<CompiledScraper>): CompiledScraper {
  return validateScraper({
    version: 1,
    templateKey: "t",
    cacheKey: "c",
    profile: "store",
    chooser: "agent",
    mode: "record",
    entry: { mode: "direct", url: "http://127.0.0.1/" },
    trace: [],
    fields: { name: { alternatives: [{ selector: "h1", fingerprint: { samples: ["x"], shape: "text" } }] } },
    pagination: { mode: "none" },
    detail: null,
    createdAt: "2026-09-19T00:00:00.000Z",
    ...partial,
  });
}

describe("fingerprintMatches (KTD6 shapes)", () => {
  it("money accepts common price spellings and rejects words", () => {
    const money = { samples: ["$ 2.490"], shape: "money" as const };
    for (const v of ["$ 12.990", "12.990", "$12,990.00", "CLP 12.990", "€ 9,99", "US$ 1,200"]) expect(fingerprintMatches(v, money), v).toBe(true);
    for (const v of ["Sin stock", "", "  ", "Disponible", null]) expect(fingerprintMatches(v, money), String(v)).toBe(false);
  });

  it("int accepts digits with thousands separators (as the snapshot classifies them) and rejects prose", () => {
    const int = { samples: ["12"], shape: "int" as const };
    for (const v of ["12", "-3", "12.990", "1,000,000"]) expect(fingerprintMatches(v, int), v).toBe(true);
    for (const v of ["12 points", "$ 12.990", "twelve", "12.5"]) expect(fingerprintMatches(v, int), v).toBe(false);
  });

  it("url accepts only http(s) and rejects javascript:", () => {
    const url = { samples: ["https://a.b/c"], shape: "url" as const };
    expect(fingerprintMatches("http://127.0.0.1:1/fixtures/jobs/1.html", url)).toBe(true);
    expect(fingerprintMatches("https://example.org/story/1", url)).toBe(true);
    expect(fingerprintMatches("javascript:x", url)).toBe(false);
    expect(fingerprintMatches("/fixtures/jobs/1.html", url)).toBe(false);
    expect(fingerprintMatches("mailto:a@b.c", url)).toBe(false);
  });

  it("date accepts ISO, slashed, month names and relative forms", () => {
    const date = { samples: ["2026-08-28"], shape: "date" as const };
    for (const v of ["2026-08-28", "2026-09-10T10:00:00", "28/08/2026", "28 Aug 2026", "Aug 28, 2026", "3 de septiembre de 2026", "2 hours ago", "hace 3 días"]) {
      expect(fingerprintMatches(v, date), v).toBe(true);
    }
    for (const v of ["Remote", "12.990", "Dic gel"]) expect(fingerprintMatches(v, date), v).toBe(false);
  });

  it("text accepts any non-empty value", () => {
    const text = { samples: ["a"], shape: "text" as const };
    expect(fingerprintMatches("Sin stock", text)).toBe(true);
    expect(fingerprintMatches("", text)).toBe(false);
    expect(fingerprintMatches(null, text)).toBe(false);
  });

  it("shapeOf mirrors the snapshot classifier", () => {
    expect(shapeOf("$ 2.490")).toBe("money");
    expect(shapeOf("12.990")).toBe("int");
    expect(shapeOf("2026-08-28")).toBe("date");
    expect(shapeOf("28 Aug 2026")).toBe("date");
    expect(shapeOf("Diclofenaco 1% gel 60 g")).toBe("text");
    expect(shapeOf("/x", "href")).toBe("url");
    expect(shapeOf("2026-08-28", "datetime")).toBe("date");
  });
});

describe("resolveUrl (R4)", () => {
  const base = "http://127.0.0.1:8080/fixtures/python-jobs.html";
  it("makes relative hrefs absolute and keeps http(s)", () => {
    expect(resolveUrl("/fixtures/jobs/100.html", base)).toBe("http://127.0.0.1:8080/fixtures/jobs/100.html");
    expect(resolveUrl("jobs/1.html", base)).toBe("http://127.0.0.1:8080/fixtures/jobs/1.html");
    expect(resolveUrl("https://example.org/story/1", base)).toBe("https://example.org/story/1");
  });
  it("replaces javascript:, data:, mailto:, tel: and garbage with null", () => {
    for (const raw of ["javascript:alert(1)", "data:text/html,hi", "mailto:a@b.c", "tel:+56", "", "http://[bad"]) {
      expect(resolveUrl(raw, base), raw).toBeNull();
    }
    expect(resolveUrl(null, base)).toBeNull();
  });
});

describe("extractPage", () => {
  it("record mode extracts document-scoped fields, tries alternatives in order and null-fills missing fields", async () => {
    const doc = scraper({
      fields: {
        name: { alternatives: [{ selector: "h1.producto-nombre", fingerprint: { samples: [], shape: "text" } }] },
        price: {
          alternatives: [
            { selector: "div.gone > span.precio", fingerprint: { samples: [], shape: "money" } },
            { selector: "div.producto-precio > span.precio", fingerprint: { samples: [], shape: "money" } },
          ],
        },
        logo: { alternatives: [{ selector: "a.logo", attr: "href", fingerprint: { samples: [], shape: "url" } }] },
      },
    });
    await withPage("/demo/pharmacy-v1/producto/paracetamol-500-mg.html", async (page) => {
      const out = await extractPage(page, doc, { sourceUrl: page.url(), fields: ["name", "price", "logo", "isbn"] });
      expect(out.items).toHaveLength(1);
      expect(out.values).toEqual({
        name: "Paracetamol 500 mg x 16 comprimidos",
        price: "$ 2.490",
        logo: `${server.baseUrl}/demo/pharmacy-v1/index.html`,
        isbn: null,
      });
      expect(out.resolvedBy).toEqual({ name: 0, price: 1, logo: 0, isbn: null });
      expect(out.sourceUrl).toBe(page.url());
      expect(fingerprintMatches(out.values.price ?? null, doc.fields.price!.alternatives[1]!.fingerprint)).toBe(true);
    });
  });

  it("list mode iterates item anchors with a row span and resolves hrefs to absolute URLs", async () => {
    const doc = scraper({
      mode: "list",
      item: { anchorSelector: "table.itemlist > tbody > tr.athing", span: 3 },
      fields: {
        title: { alternatives: [{ selector: "a.titlelink", fingerprint: { samples: [], shape: "text" } }] },
        link: { alternatives: [{ selector: "a.titlelink", attr: "href", fingerprint: { samples: [], shape: "url" } }] },
        points: { alternatives: [{ selector: "span.score", fingerprint: { samples: [], shape: "text" } }] },
      },
    });
    await withPage("/fixtures/hackernews.html", async (page) => {
      const out = await extractPage(page, doc, { sourceUrl: page.url() });
      expect(out.items).toHaveLength(30);
      expect(out.items[0]!.values).toEqual({ title: "Show HN: A self-healing scraper compiler", link: "https://example.org/story/45000000", points: "12 points" });
      expect(out.items[0]!.resolvedBy).toEqual({ title: 0, link: 0, points: 0 });
      expect(out.items.every((i) => i.values.points !== null && /^\d+ points$/.test(i.values.points))).toBe(true);
      expect(out.items.every((i) => i.sourceUrl === page.url())).toBe(true);
      expect(out.values).toEqual(out.items[0]!.values);
    });
  });

  it("a javascript: href yields null for the link field; the text field still resolves", async () => {
    const doc = scraper({
      mode: "list",
      item: { anchorSelector: "ul > li", span: 1 },
      fields: {
        title: { alternatives: [{ selector: "a", fingerprint: { samples: [], shape: "text" } }] },
        link: { alternatives: [{ selector: "a", attr: "href", fingerprint: { samples: [], shape: "url" } }] },
      },
    });
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent(`<ul><li><a href="javascript:alert(1)">One</a></li><li><a href="/two.html">Two</a></li><li><a href="mailto:x@y.z">Three</a></li></ul>`);
      const out = await extractPage(page, doc, { sourceUrl: page.url() });
      expect(out.items.map((i) => i.values.link)).toEqual([null, "http://127.0.0.1/two.html".replace("http://127.0.0.1", new URL(page.url()).origin), null]);
      expect(out.items.map((i) => i.values.title)).toEqual(["One", "Two", "Three"]);
      expect(out.items[0]!.resolvedBy.link).toBeNull();
    });
  });

  it("a drifted first alternative whose value has the wrong shape does not shadow a later alternative that fits the fingerprint (R17)", async () => {
    const doc = scraper({
      fields: {
        price: {
          alternatives: [
            { selector: "span.precio", fingerprint: { samples: ["$ 1.990"], shape: "money" } },
            { selector: "span.precio-nuevo", fingerprint: { samples: ["$ 2.490"], shape: "money" } },
          ],
        },
        name: {
          alternatives: [
            { selector: "h1", fingerprint: { samples: ["x"], shape: "text" } },
            { selector: "h2", fingerprint: { samples: ["y"], shape: "text" } },
          ],
        },
      },
    });
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent(`<h1>Producto</h1><h2>Otro</h2><span class="precio">Consultar</span><span class="precio-nuevo">$ 12.990</span>`);
      const out = await extractPage(page, doc, { sourceUrl: page.url() });
      expect(out.values).toEqual({ price: "$ 12.990", name: "Producto" });
      expect(out.resolvedBy).toEqual({ price: 1, name: 0 });
      expect(fingerprintMatches(out.values.price, doc.fields.price!.alternatives[out.resolvedBy.price!]!.fingerprint)).toBe(true);
      // when no alternative fits the shape, the first non-empty value is still reported (the caller decides)
      await page.setContent(`<span class="precio">Consultar</span><span class="precio-nuevo">Agotado</span>`);
      const none = await extractPage(page, doc, { sourceUrl: page.url() });
      expect(none.values.price).toBe("Consultar");
      expect(none.resolvedBy.price).toBe(0);
    });
  });

  it("list mode with no anchors returns no items and null-filled top-level values", async () => {
    const doc = scraper({
      mode: "list",
      item: { anchorSelector: "ul.jobs > li.job", span: 1 },
      fields: { title: { alternatives: [{ selector: "h2", fingerprint: { samples: [], shape: "text" } }] } },
    });
    await withPage("/fixtures/login-wall.html", async (page) => {
      const out = await extractPage(page, doc, { sourceUrl: page.url() });
      expect(out.items).toEqual([]);
      expect(out.values).toEqual({ title: null });
      expect(out.resolvedBy).toEqual({ title: null });
    });
  });
});
