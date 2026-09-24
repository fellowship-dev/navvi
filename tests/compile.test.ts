import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import type { Answer, Chooser, Question } from "../src/chooser/chooser.js";
import {
  CHUNK_BUDGET_CHARS,
  applyFieldAnswers,
  batchChars,
  buildFieldQuestions,
  chunkQuestions,
  compile,
  nextLinkCandidates,
  probeEntry,
  toAlternative,
  type CompileOptions,
  type CompileResult,
  type FieldCandidate,
} from "../src/compile/index.js";
import { extractPage, fingerprintMatches, validateScraper } from "../src/scraper/index.js";
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

async function openPages(urls: readonly string[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const url of urls) {
    const page = await browser.context.newPage();
    await page.goto(`${server.baseUrl}${url}`);
    pages.push(page);
  }
  return pages;
}

async function closePages(pages: readonly Page[]): Promise<void> {
  for (const page of pages) await page.close();
}

/** Records every question batch a chooser was asked, answering through the wrapped chooser. */
class SpyChooser implements Chooser {
  readonly name;
  readonly batches: Question[][] = [];
  constructor(private readonly inner: Chooser) {
    this.name = inner.name;
  }
  async ask(batch: Question[]): Promise<Answer[]> {
    this.batches.push(batch);
    return this.inner.ask(batch);
  }
  usage() {
    return this.inner.usage();
  }
}

const F = (...names: string[]) => names.map((name) => ({ name }));

function options(pages: Page[], fixture: string, partial: Partial<CompileOptions> = {}): CompileOptions {
  return {
    mode: "list",
    pages,
    fields: F("title"),
    templateKey: "127.0.0.1/fixtures/x",
    cacheKey: "cache-key",
    profile: "store",
    chooser: new RecordedChooser({ fixture: `compile/${fixture}` }),
    startUrls: [pages[0]!.url()],
    allowedDomains: [],
    ...partial,
  };
}

function ok(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a compiled scraper, got ${result.status} (fieldsNotFound: ${result.fieldsNotFound.join(",")})`);
  return result;
}

const V1_SAMPLES = ["paracetamol-500-mg", "ibuprofeno-400-mg", "omeprazol-20-mg"].map((s) => `/demo/pharmacy-v1/producto/${s}.html`);
const V1_ALL = [
  "amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema", "diclofenaco-gel", "ibuprofeno-400-mg", "loratadina-10-mg",
  "losartan-50-mg", "metformina-850-mg", "omeprazol-20-mg", "paracetamol-500-mg", "salbutamol-inhalador", "vitamina-c-1-g",
].map((s) => `/demo/pharmacy-v1/producto/${s}.html`);
const V2_SAMPLES = ["paracetamol-500-mg", "omeprazol-20-mg", "loratadina-10-mg"].map((s) => `/demo/pharmacy-v2/producto/${s}.html`);

describe("list mode (AE1, AE2, AE3)", () => {
  it("AE1: python-jobs compiles five fields in two batches and extracts 25 rows with absolute links", async () => {
    const pages = await openPages(["/fixtures/python-jobs.html"]);
    try {
      const spy = new SpyChooser(new RecordedChooser({ fixture: "compile/python-jobs" }));
      const result = ok(
        await compile(
          options(pages, "python-jobs", {
            fields: F("title", "company", "location", "date", "link"),
            description: "python job listing",
            chooser: spy,
            context: browser.context,
          }),
        ),
      );
      expect(spy.batches).toHaveLength(2);
      expect(spy.batches[0]!.map((q) => q.id)).toEqual(["group"]);
      expect(spy.batches[1]!.map((q) => q.id)).toEqual(["field.title", "field.company", "field.location", "field.date", "field.link", "link.next"]);
      // one state per batch: the description travels once
      expect(new Set(spy.batches[1]!.map((q) => q.state)).size).toBe(1);
      expect(spy.batches[1]![0]!.state).toContain("python job listing");
      expect(spy.usage().questions).toBe(7);
      expect(spy.usage().batches).toBe(2);
      expect(result.fieldsNotFound).toEqual([]);

      const scraper = validateScraper(result.scraper);
      expect(scraper.mode).toBe("list");
      expect(scraper.item).toEqual({ anchorSelector: "ul.jobs > li.job", span: 1 });
      expect(scraper.entry).toEqual({ mode: "direct", url: pages[0]!.url() });
      expect(scraper.pagination).toEqual({ mode: "next_link", locator: [{ role: "link", name: "Next", exact: true }] });
      expect(Object.keys(scraper.fields)).toEqual(["title", "company", "location", "date", "link"]);
      expect(scraper.fields.link!.alternatives[0]).toMatchObject({ attr: "href", fingerprint: { shape: "url" } });
      expect(scraper.fields.link!.alternatives[0]!.fingerprint.samples[0]).toBe(`${server.baseUrl}/fixtures/jobs/100.html`);
      expect(scraper.fields.date!.alternatives[0]!.fingerprint.shape).toBe("date");
      expect(scraper.fields.title!.alternatives[0]!.fingerprint.samples).toHaveLength(3);
      // the next link is never a per-item link and is always on-domain
      const next = spy.batches[1]!.find((q) => q.id === "link.next")!;
      expect(next.options!.some((o) => o.includes("Next"))).toBe(true);
      expect(next.options!.some((o) => o.includes("Previous"))).toBe(true);
      expect(next.options!.some((o) => o.includes("Senior Python Engineer"))).toBe(false);

      const out = await extractPage(pages[0]!, scraper, { sourceUrl: pages[0]!.url() });
      expect(out.items).toHaveLength(25);
      for (const item of out.items) {
        for (const name of ["title", "company", "location", "date", "link"]) expect(item.values[name], name).not.toBeNull();
        expect(item.values.link).toMatch(new RegExp(`^${server.baseUrl}/fixtures/jobs/\\d+\\.html$`));
        expect(item.resolvedBy).toEqual({ title: 0, company: 0, location: 0, date: 0, link: 0 });
      }
      expect(out.items[1]!.values).toMatchObject({ title: "Backend Developer (Django)", company: "Canonical", location: "Berlin, Germany", date: "2026-08-27" });
    } finally {
      await closePages(pages);
    }
  });

  it("AE2: hackernews compiles points and comments from the subtext row and extracts 30 items", async () => {
    const pages = await openPages(["/fixtures/hackernews.html"]);
    try {
      const spy = new SpyChooser(new RecordedChooser({ fixture: "compile/hackernews" }));
      const result = ok(await compile(options(pages, "hackernews", { fields: F("title", "link", "points", "comments"), description: "story", chooser: spy })));
      const scraper = result.scraper;
      expect(scraper.item!.span).toBe(3);
      expect(scraper.item!.anchorSelector).toContain("tr.athing");
      const pointsQuestion = spy.batches[1]!.find((q) => q.id === "field.points")!;
      expect(pointsQuestion.options!.some((o) => o.startsWith("+1/") && o.includes("12 points"))).toBe(true);
      expect(scraper.pagination).toEqual({ mode: "next_link", locator: [{ role: "link", name: "More", exact: true }] });
      const out = await extractPage(pages[0]!, scraper);
      expect(out.items).toHaveLength(30);
      expect(out.items[0]!.values).toEqual({ title: "Show HN: A self-healing scraper compiler", link: "https://example.org/story/45000000", points: "12 points", comments: "3 comments" });
      expect(out.items[29]!.values).toMatchObject({ points: "285 points", comments: "180 comments" });
      expect(scraper.fields.link!.alternatives[0]!.fingerprint.samples.every((s) => s.startsWith("https://example.org/"))).toBe(true);
    } finally {
      await closePages(pages);
    }
  });

  it("AE3: placeholder-board waits for settle so the hydrated group is the one offered and chosen", async () => {
    const pages = await openPages(["/fixtures/placeholder-board.html"]);
    try {
      const spy = new SpyChooser(new RecordedChooser({ fixture: "compile/placeholder-board" }));
      const result = ok(await compile(options(pages, "placeholder-board", { fields: F("title", "owner", "points"), description: "card", chooser: spy, settle: { idleMs: 1_000, maxMs: 5_000 } })));
      const groupQuestion = spy.batches[0]![0]!;
      expect(groupQuestion.options!.some((o) => o.includes("Loading"))).toBe(false);
      expect(groupQuestion.options!.some((o) => o.includes("Card 1: Fix login"))).toBe(true);
      expect(result.scraper.item).toEqual({ anchorSelector: "#root > div.row", span: 1 });
      expect(result.scraper.pagination).toEqual({ mode: "scroll" });
      const out = await extractPage(pages[0]!, result.scraper);
      expect(out.items).toHaveLength(10);
      expect(out.items[9]!.values).toEqual({ title: "Card 10: Plan Q4", owner: "elena", points: "28" });
      expect(result.scraper.fields.points!.alternatives[0]!.fingerprint.shape).toBe("int");
    } finally {
      await closePages(pages);
    }
  });

  it("followDetailPages asks link.detail over per-item href candidates in the same batch and returns the chosen alternative", async () => {
    const pages = await openPages(["/fixtures/python-jobs.html"]);
    try {
      const spy = new SpyChooser(new RecordedChooser({ fixture: "compile/python-jobs-detail" }));
      const result = ok(await compile(options(pages, "python-jobs-detail", { fields: F("title"), description: "python job listing", chooser: spy, followDetailPages: true, entryMode: "direct" })));
      expect(spy.batches[1]!.map((q) => q.id)).toEqual(["field.title", "link.next", "link.detail"]);
      const detail = spy.batches[1]![2]!;
      expect(detail.options).toEqual([`h2.job-title/a/@href = /fixtures/jobs/100.html | /fixtures/jobs/101.html | /fixtures/jobs/102.html`]);
      expect(result.detailLink).toEqual({
        selector: "a",
        attr: "href",
        fingerprint: { samples: [100, 101, 102].map((n) => `${server.baseUrl}/fixtures/jobs/${n}.html`), shape: "url" },
      });
      expect(result.scraper.detail).toBeNull();
      expect(result.scraper.entry.mode).toBe("direct");
    } finally {
      await closePages(pages);
    }
  });

  it("no group chosen twice: python-jobs with none answers scrolls, retries with a lower threshold, then no_items_found", async () => {
    const pages = await openPages(["/fixtures/python-jobs.html"]);
    try {
      const spy = new SpyChooser(new RecordedChooser({ fixture: "compile/none-group" }));
      const result = await compile(options(pages, "none-group", { fields: F("title"), description: "job", chooser: spy }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe("no_items_found");
      expect(result.fieldsNotFound).toEqual(["title"]);
      expect(spy.batches.map((b) => b.map((q) => q.id))).toEqual([["group"], ["group.retry"]]);
      expect(spy.usage().questions).toBe(2);
      const scrolled = await pages[0]!.evaluate(() => window.scrollY > 0 || document.documentElement.scrollHeight <= window.innerHeight);
      expect(scrolled).toBe(true);
    } finally {
      await closePages(pages);
    }
  });

  it("login-wall has no repeated group at either threshold: no question is asked and the outcome is no_items_found", async () => {
    const pages = await openPages(["/fixtures/login-wall.html"]);
    try {
      const spy = new SpyChooser(new RecordedChooser({ fixture: "compile/none-group" }));
      const result = await compile(options(pages, "none-group", { fields: F("title", "price"), description: "product", chooser: spy }));
      expect(result).toMatchObject({ ok: false, status: "no_items_found", fieldsNotFound: ["title", "price"] });
      expect(spy.batches).toEqual([]);
      expect(spy.usage().questions).toBe(0);
    } finally {
      await closePages(pages);
    }
  });
});

describe("record mode (AE7)", () => {
  it("AE7: three v1 product pages compile four fields in one batch; a candidate on only two samples is never offered", async () => {
    const pages = await openPages(V1_SAMPLES);
    try {
      // an element present on two of the three samples must not reach the chooser (R30)
      for (const page of pages.slice(0, 2)) {
        await page.evaluate(() => {
          const p = document.createElement("p");
          p.className = "promo";
          p.textContent = "Envío gratis sobre $ 20.000";
          document.querySelector("article.producto")!.appendChild(p);
        });
      }
      const spy = new SpyChooser(new RecordedChooser({ fixture: "compile/pharmacy-v1" }));
      const result = ok(
        await compile(
          options(pages, "pharmacy-v1", { mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product", chooser: spy, templateKey: "127.0.0.1/demo/pharmacy-v1/producto/*" }),
        ),
      );
      expect(spy.batches).toHaveLength(1);
      expect(spy.batches[0]!.map((q) => q.id)).toEqual(["field.name", "field.laboratory", "field.price", "field.stock"]);
      for (const q of spy.batches[0]!) {
        expect(q.options!.some((o) => o.includes("Envío gratis") || o.includes("promo"))).toBe(false);
        expect(q.options!.length).toBeGreaterThan(10);
      }
      expect(batchChars(spy.batches[0]!)).toBeLessThan(CHUNK_BUDGET_CHARS);
      expect(spy.usage().batches).toBe(1);
      expect(spy.usage().questions).toBe(4);
      const scraper = result.scraper;
      expect(scraper.mode).toBe("record");
      expect(scraper.item).toBeUndefined();
      expect(scraper.pagination).toEqual({ mode: "none" });
      expect(scraper.trace).toEqual([]);
      expect(scraper.fields.price!.alternatives[0]).toEqual({
        selector: "div.producto-precio > span.precio",
        fingerprint: { samples: ["$ 2.490", "$ 3.990", "$ 5.490"], shape: "money" },
      });
      expect(scraper.fields.name!.alternatives[0]!.selector).toBe("h1.producto-nombre");

      const all = await openPages(V1_ALL);
      try {
        for (const page of all) {
          const out = await extractPage(page, scraper);
          for (const name of ["name", "laboratory", "price", "stock"]) expect(out.values[name], `${name} on ${page.url()}`).not.toBeNull();
          expect(out.values.price).toMatch(/^\$ [\d.]+$/);
        }
      } finally {
        await closePages(all);
      }
    } finally {
      await closePages(pages);
    }
  });

  it("the same recorded answers produce the same field map from two chooser instances", async () => {
    const pages = await openPages(V1_SAMPLES);
    try {
      const opts = (): CompileOptions =>
        options(pages, "pharmacy-v1", { mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" });
      const a = ok(await compile(opts()));
      const b = ok(await compile(opts()));
      expect(a.scraper.fields).toEqual(b.scraper.fields);
    } finally {
      await closePages(pages);
    }
  });

  it("a field with no candidate (isbn) is null in extraction, listed in fieldsNotFound, and the scraper still validates", async () => {
    const pages = await openPages(V1_SAMPLES);
    try {
      const spy = new SpyChooser(new RecordedChooser({ fixture: "compile/pharmacy-isbn" }));
      const result = ok(await compile(options(pages, "pharmacy-isbn", { mode: "record", fields: F("name", "isbn"), description: "pharmacy product", chooser: spy })));
      expect(result.fieldsNotFound).toEqual(["isbn"]);
      expect(Object.keys(result.scraper.fields)).toEqual(["name"]);
      expect(() => validateScraper(result.scraper)).not.toThrow();
      const out = await extractPage(pages[0]!, result.scraper, { fields: ["name", "isbn"] });
      expect(out.values).toEqual({ name: "Paracetamol 500 mg x 16 comprimidos", isbn: null });
      // the field batch, then the list follow-up an unbound field is offered
      // (2026-09-24); a list is not the isbn either, so it stays unbound
      expect(spy.batches.map((batch) => batch.map((q) => q.id))).toEqual([["field.name", "field.isbn"], ["list.isbn"]]);
    } finally {
      await closePages(pages);
    }
  });

  it("v2 pages: hashed class names are dropped from the selectors, which still resolve on every sample", async () => {
    const pages = await openPages(V2_SAMPLES);
    try {
      const result = ok(await compile(options(pages, "pharmacy-v2", { mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" })));
      const scraper = result.scraper;
      for (const [name, field] of Object.entries(scraper.fields)) {
        const selector = field.alternatives[0]!.selector;
        expect(selector, name).not.toMatch(/prc-|ttl-|lbl-|val-|stk-|lab-|compra-4b2e91f|prod-8f3a2c1|enc-3b9d7e2/);
      }
      expect(scraper.fields.price!.alternatives[0]!.fingerprint.shape).toBe("money");
      for (const page of pages) {
        const out = await extractPage(page, scraper);
        for (const name of ["name", "laboratory", "price", "stock"]) expect(out.values[name], `${name} on ${page.url()}`).not.toBeNull();
      }
    } finally {
      await closePages(pages);
    }
  });
});

describe("entry probe (R14)", () => {
  it("returns direct for python-jobs and trace for the search form", async () => {
    const item = { anchorSelector: "ul.jobs > li.job", span: 1 };
    expect(await probeEntry(browser.context, `${server.baseUrl}/fixtures/python-jobs.html`, item, 4)).toBe("direct");
    expect(await probeEntry(browser.context, `${server.baseUrl}/fixtures/search-form.html`, item, 4)).toBe("trace");
    expect(browser.context.pages().length).toBeLessThanOrEqual(1);
  });
});

describe("pure helpers", () => {
  const candidate = (i: number): FieldCandidate => ({
    key: `sel-${i}`,
    path: `main/div.block/span.value-${i}`,
    selector: `div.block > span.value-${i}`,
    values: [`sample one ${i}`, `sample two ${i}`, `sample three ${i}`],
    shape: "text",
  });

  it("chunks eight fields over sixty candidates into two batches under the budget and merges a complete map", () => {
    const candidates = Array.from({ length: 60 }, (_, i) => candidate(i));
    const fields = Array.from({ length: 8 }, (_, i) => ({ name: `f${i}` }));
    const questions = buildFieldQuestions(fields, candidates, "Records: things");
    expect(questions).toHaveLength(8);
    expect(questions[0]!.options).toHaveLength(60);
    expect(batchChars(questions)).toBeGreaterThan(CHUNK_BUDGET_CHARS);
    const batches = chunkQuestions(questions);
    expect(batches).toHaveLength(2);
    for (const batch of batches) expect(batchChars(batch)).toBeLessThanOrEqual(CHUNK_BUDGET_CHARS);
    expect(batches.flat().map((q) => q.id)).toEqual(fields.map((f) => `field.${f.name}`));
    const answers: Answer[] = batches.flat().map((q, i) => ({ id: q.id, index: i % 60 }));
    const map = applyFieldAnswers(fields, candidates, answers);
    expect(map.size).toBe(8);
    expect([...map.values()].every((c) => c !== null)).toBe(true);
    expect(map.get("f7")!.key).toBe("sel-7");
    const none = applyFieldAnswers(fields, candidates, [{ id: "field.f0", index: null }]);
    expect(none.get("f0")).toBeNull();
    expect(none.get("f1")).toBeNull();
  });

  it("a small fan-out stays in one batch", () => {
    const questions = buildFieldQuestions([{ name: "a" }, { name: "b" }], [candidate(1), candidate(2)], "Records: things");
    expect(chunkQuestions(questions)).toHaveLength(1);
  });

  it("next-link candidates drop off-domain hrefs and per-item links (R25)", () => {
    const base = "http://127.0.0.1:8080/fixtures/python-jobs.html";
    const links = [
      { id: "k1", selector: "a.next", text: "Next", href: "http://127.0.0.1:8080/fixtures/python-jobs.html?page=2", count: 1 },
      { id: "k2", selector: "a.evil", text: "Next", href: "https://evil.example/next", count: 1 },
      { id: "k3", selector: "a.item", text: "Senior Python Engineer", href: "http://127.0.0.1:8080/fixtures/jobs/100.html", count: 25 },
      { id: "k4", selector: "a.partner", text: "Partner next", href: "https://jobs.partner.example/page/2", count: 1 },
      { id: "k5", selector: "a.js", text: "Next", href: "javascript:go()", count: 1 },
    ];
    expect(nextLinkCandidates(links, [base], []).map((l) => l.id)).toEqual(["k1"]);
    expect(nextLinkCandidates(links, [base], ["partner.example"]).map((l) => l.id)).toEqual(["k1", "k4"]);
  });

  it("an attribute leaf's fingerprint shape comes from its sample values, not the attribute name (KTD6)", () => {
    const base = "http://127.0.0.1:8080/fixtures/python-jobs.html";
    const year: FieldCandidate = { key: "time@datetime", path: "main/time", selector: "time", attr: "datetime", values: ["2026"], shape: "date" };
    const alt = toAlternative(year, [base]);
    expect(alt.fingerprint.shape).toBe("int");
    expect(alt.fingerprint.samples).toEqual(["2026"]);
    expect(fingerprintMatches("2026", alt.fingerprint)).toBe(true);

    const iso: FieldCandidate = { ...year, values: ["2026-09-19"] };
    expect(toAlternative(iso, [base]).fingerprint.shape).toBe("date");

    const link: FieldCandidate = { key: "a@href", path: "main/a", selector: "a", attr: "href", values: ["/jobs/100.html"], shape: "url" };
    expect(toAlternative(link, [base]).fingerprint).toEqual({ samples: ["http://127.0.0.1:8080/jobs/100.html"], shape: "url" });

    // a src whose every sample is a data: URI keeps the attribute's shape: replay yields null for it (R4), never a wrong-shaped match
    const data: FieldCandidate = { key: "img@src", path: "main/img", selector: "img", attr: "src", values: ["data:image/png;base64,AAAA"], shape: "url" };
    expect(toAlternative(data, [base]).fingerprint).toEqual({ samples: [], shape: "url" });
  });

  // Round-tripping a compiled document is owned by `scraper-schema.test.ts ::
  // round-trips a valid v1 document with a login trace unchanged`, which compares
  // the whole document rather than one field being defined.
});

