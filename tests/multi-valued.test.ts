import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import type { Answer, Chooser, ChooserUsage, Question } from "../src/chooser/chooser.js";
import { compile, listCandidatesFromLeaves, listSelectorOf, looksPlural, type CompileOptions, type CompileResult } from "../src/compile/index.js";
import { domTier } from "../src/compile/template.js";
import { toCsv } from "../src/cli/output.js";
import { runCrawl } from "../src/replay/crawler.js";
import { coerceRow, coerceValues, extractPage, fingerprintMatches } from "../src/scraper/extract.js";
import { SCRAPER_VERSION, validateScraper, type CompiledScraper } from "../src/scraper/schema.js";
import { ScraperStore } from "../src/scraper/store.js";
import { exitCodeFor } from "../bin/cli.js";
import { datasetItems, fixtureInput, makeActor, makeDeps } from "./helpers.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * Multi-valued fields (2026-09-24). A fresh-eyes run of list mode on a quotes
 * site asked for "quote text, author and tags" and got `tags: null` on every
 * row with exit 0 `succeeded`, or -- with the fields spelled out -- only the
 * second tag of each quote, compiled as `a.tag:nth-of-type(2)`. The fixtures
 * under `tests/fixtures/multi/` are synthetic: quotes with one to four tags,
 * a drinks menu with one to three sized prices, and three product pages with
 * breadcrumbs and a photo gallery of different lengths.
 */

let server: FixtureServer;
let browser: LaunchedBrowser;
let dir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launch({ browser: "chromium", headed: false });
  dir = mkdtempSync(join(tmpdir(), "navvi-multi-"));
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Tag counts of the ten quotes in `quotes.html`, in page order. */
const TAG_COUNTS = [4, 2, 3, 1, 2, 4, 1, 3, 2, 4];

/**
 * Answers by pattern over the offered option labels: `group` by the item
 * selector, each field by its own pattern, anything else `none`. Records every
 * question so a test can read what was offered.
 */
class ScriptedChooser implements Chooser {
  readonly name = "recorded" as const;
  readonly batches: Question[][] = [];
  constructor(private readonly patterns: Record<string, RegExp>) {}
  async ask(batch: Question[]): Promise<Answer[]> {
    this.batches.push(batch);
    return batch.map((question) => {
      const key = question.id.replace(/^(field|list)\./, "").replace(/\.retry$/, "");
      const pattern = this.patterns[key];
      const index = pattern === undefined ? -1 : (question.options ?? []).findIndex((option) => pattern.test(option));
      return { id: question.id, index: index < 0 ? null : index };
    });
  }
  questions(): Question[] {
    return this.batches.flat();
  }
  usage(): ChooserUsage {
    return { chooser: this.name, questions: this.questions().length, textQuestions: 0, batches: this.batches.length, inputTokens: 0, outputTokens: 0, waitMs: 0, costUsd: 0, zeroDataRetention: "not_applicable" };
  }
}

const LIST_OPTION = /\(every match, as a list\)/;

async function open(path: string): Promise<Page> {
  const page = await browser.context.newPage();
  await page.goto(`${server.baseUrl}${path}`);
  return page;
}

function options(pages: Page[], chooser: Chooser, partial: Partial<CompileOptions>): CompileOptions {
  return {
    mode: "list",
    pages,
    fields: [],
    templateKey: "127.0.0.1/fixtures/multi",
    cacheKey: "cache-key",
    profile: "store",
    chooser,
    startUrls: [pages[0]!.url()],
    allowedDomains: [],
    ...partial,
  };
}

function ok(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a compiled scraper, got ${result.status}`);
  return result;
}

describe("list mode: a repeated element within one item", () => {
  it("offers the chooser every tag of an item as one list option, next to the positional ones", async () => {
    const page = await open("/fixtures/multi/quotes.html");
    try {
      const chooser = new ScriptedChooser({ group: /div\.quote/, text: /span\.text = /, author: /small\.author = /, tags: LIST_OPTION });
      const result = ok(await compile(options([page], chooser, { fields: [{ name: "text" }, { name: "author" }, { name: "tags" }], description: "quote" })));
      // the field question offers the positional tags, as it always did...
      const field = chooser.questions().find((q) => q.id === "field.tags")!;
      expect(field.options!.some((o) => /^div\.tags\/a\.tag = /.test(o))).toBe(true);
      expect(field.options!.some((o) => LIST_OPTION.test(o))).toBe(false);
      // ...and a field left unbound is then offered every list on the rows: the tag texts and the tag links
      const list = chooser.questions().find((q) => q.id === "list.tags")!;
      expect(list.options!.map((o) => o.split(" = ")[0])).toEqual(["div.tags/a.tag (every match, as a list)", "div.tags/a.tag/@href (every match, as a list)"]);
      expect(list.options![0]).toContain('4 values: "light", "honesty", "night", …');
      expect(list.options![0]).toContain('2 values: "maps", "travel"');
      expect(list.premise).toContain("tags reads as several values");
      // fields that bound a one-value node are asked nothing more
      expect(chooser.questions().map((q) => q.id)).toEqual(["group", "field.text", "field.author", "field.tags", "list.tags"]);
      expect(result.fieldsNotFound).toEqual([]);

      const scraper = validateScraper(result.scraper);
      expect(scraper.fields.tags!.multiple).toBe(true);
      expect(scraper.fields.text!.multiple).toBeUndefined();
      expect(scraper.fields.tags!.alternatives[0]!.selector).not.toMatch(/nth-of-type/);

      const out = await extractPage(page, scraper);
      expect(out.items).toHaveLength(10);
      expect(out.items.map((item) => (item.values.tags as string[]).length)).toEqual(TAG_COUNTS);
      expect(out.items[0]!.values.tags).toEqual(["light", "honesty", "night", "paradox"]);
      expect(out.items[3]!.values.tags).toEqual(["roads"]);
      // single-valued fields are unaffected
      expect(out.items[0]!.values.author).toBe("Ada Quill");
      expect(typeof out.items[0]!.values.text).toBe("string");
      for (const item of out.items) expect(item.resolvedBy.tags).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("a positional pick still compiles as before: one element, the one the chooser named", async () => {
    const page = await open("/fixtures/multi/quotes.html");
    try {
      // The defect's second shape, reproduced: the chooser takes a positional
      // candidate. That stays its decision -- but it was made with the list
      // option in front of it, which is the fix.
      const chooser = new ScriptedChooser({ group: /div\.quote/, tags: /^div\.tags\/a\.tag = honesty/ });
      const scraper = ok(await compile(options([page], chooser, { fields: [{ name: "tags" }] }))).scraper;
      // it was asked whether it meant one tag or all of them, and kept the one
      const followUp = chooser.questions().find((q) => q.id === "list.tags")!;
      expect(followUp.options).toHaveLength(1);
      expect(followUp.options![0]).toMatch(/^div\.tags\/a\.tag \(every match, as a list\) = /);
      expect(followUp.premise).toContain("bound to one element of `div.tags/a.tag`");
      expect(scraper.fields.tags!.multiple).toBeUndefined();
      expect(scraper.fields.tags!.alternatives[0]!.selector).toMatch(/a\.tag:nth-of-type\(2\)$/);
      const out = await extractPage(page, scraper);
      expect(out.items[0]!.values.tags).toBe("honesty");
      expect(out.items[3]!.values.tags).toBeNull();
    } finally {
      await page.close();
    }
  });

  it("a typed multi-valued field (prices:money) coerces each element", async () => {
    const page = await open("/fixtures/multi/menu.html");
    try {
      const chooser = new ScriptedChooser({ group: /article\.drink/, name: /h2\.name = /, prices: LIST_OPTION });
      const scraper = ok(await compile(options([page], chooser, { fields: [{ name: "name" }, { name: "prices", type: "money" }], description: "drink" }))).scraper;
      expect(scraper.fields.prices).toMatchObject({ multiple: true, type: "money" });
      // the middle `li:nth-of-type(k)` was what made each price positional
      expect(scraper.fields.prices!.alternatives[0]!.selector).toMatch(/li > span\.price$/);
      expect(scraper.fields.prices!.alternatives[0]!.fingerprint.shape).toBe("money");
      const out = await extractPage(page, scraper);
      expect(out.items.map((item) => item.values.prices)).toEqual([
        ["$ 2.490", "$ 2.990", "$ 3.490"],
        ["$ 2.190", "$ 2.590"],
        ["$ 2.890", "$ 3.390", "$ 3.890"],
        ["$ 3.190"],
        ["$ 1.590", "$ 1.990"],
        ["$ 1.890", "$ 2.290", "$ 2.690"],
      ]);
      const types = { name: undefined, prices: "money" as const };
      expect(coerceRow(out.items[0]!.values, types).prices).toEqual([2490, 2990, 3490]);
      expect(coerceRow(out.items[3]!.values, types).prices).toEqual([3190]);
    } finally {
      await page.close();
    }
  });
});

describe("record mode: a repeated element on one record page", () => {
  const PRODUCTS = [1, 2, 3].map((n) => `/fixtures/multi/product-${n}.html`);

  it("compile() binds breadcrumbs and gallery images as lists", async () => {
    const pages = await Promise.all(PRODUCTS.map(open));
    try {
      const chooser = new ScriptedChooser({ title: /h1\.title = /, categories: /\/li\/a \(every match, as a list\)/, images: /img\.photo\/@src \(every match, as a list\)/ });
      const result = ok(
        await compile(options(pages, chooser, { mode: "record", fields: [{ name: "title" }, { name: "categories" }, { name: "images", type: "url" }], description: "product" })),
      );
      expect(result.fieldsNotFound).toEqual([]);
      const scraper = result.scraper;
      expect(scraper.fields.categories!.multiple).toBe(true);
      expect(scraper.fields.images!.multiple).toBe(true);
      const read = async (page: Page) => (await extractPage(page, scraper)).items[0]!.values;
      expect((await read(pages[0]!)).categories).toEqual(["Home", "Lighting", "Desk lamps"]);
      expect((await read(pages[2]!)).categories).toEqual(["Home", "Furniture", "Stools", "Small"]);
      const images = (await read(pages[1]!)).images as string[];
      expect(images).toEqual([`${server.baseUrl}/img/towel-flat.jpg`, `${server.baseUrl}/img/towel-folded.jpg`]);
      expect((await read(pages[1]!)).title).toBe("Linen tea towel");
    } finally {
      for (const page of pages) await page.close();
    }
  });

  it("the compile core's tier 3 asks no list follow-up: it cannot carry a list yet (deferred)", async () => {
    const pages = await Promise.all(PRODUCTS.map(open));
    try {
      const chooser = new ScriptedChooser({ title: /h1\.title = /, categories: /\/li\/a \(every match, as a list\)/ });
      const tier = domTier({ render: (_urls, use) => use(pages), chooser });
      const answer = await tier({ fields: [{ name: "title" }, { name: "categories" }], urls: pages.map((p) => p.url()) });
      expect(chooser.questions().map((q) => q.id)).toEqual(["field.title", "field.categories"]);
      expect(chooser.questions().every((q) => (q.options ?? []).every((o) => !LIST_OPTION.test(o)))).toBe(true);
      expect(answer.bindings.map((b) => b.field)).toEqual(["title"]);
      expect(answer.unanswered.map((u) => u.field)).toEqual(["categories"]);
    } finally {
      for (const page of pages) await page.close();
    }
  });
});

describe("backward compatibility", () => {
  it("a scraper written before the flag replays exactly as it did: first match, a string", async () => {
    const page = await open("/fixtures/multi/quotes.html");
    try {
      const old: CompiledScraper = validateScraper({
        version: SCRAPER_VERSION,
        templateKey: "127.0.0.1/fixtures/multi",
        cacheKey: "old",
        profile: "store",
        chooser: "agent",
        mode: "list",
        entry: { mode: "direct", url: page.url() },
        trace: [],
        item: { anchorSelector: "div.col-md-8 > div.quote", span: 1 },
        fields: { tags: { alternatives: [{ selector: "div.tags > a.tag", fingerprint: { samples: ["light"], shape: "text" } }] } },
        pagination: { mode: "none" },
        detail: null,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      expect("multiple" in old.fields.tags!).toBe(false);
      const out = await extractPage(page, old);
      expect(out.items.map((item) => item.values.tags)).toEqual(["light", "maps", "patience", "roads", "gardens", "rain", "craft", "time", "windows", "bread"]);
    } finally {
      await page.close();
    }
  });
});

describe("values and output", () => {
  it("a list fits its fingerprint only when every element does", () => {
    const money = { samples: ["$ 1.990"], shape: "money" as const };
    expect(fingerprintMatches(["$ 1.990", "$ 2.490"], money)).toBe(true);
    expect(fingerprintMatches(["$ 1.990", "ask us"], money)).toBe(false);
    expect(fingerprintMatches([], money)).toBe(false);
  });

  it("the scalar readers (determinism, verification) see a list as its elements joined", () => {
    expect(coerceValues({ prices: ["$ 1.990", "$ 2.490"], name: "Mocha" }, { prices: "money" })).toEqual({ prices: "1990; 2490", name: "Mocha" });
  });

  it("a list selector is the positional one with its innermost position removed", () => {
    expect(listSelectorOf(":scope > div.tags > a.tag:nth-of-type(2)")).toBe(":scope > div.tags > a.tag");
    expect(listSelectorOf(":scope > body > ol > li:nth-of-type(3) > a")).toBe(":scope > body > ol > li > a");
    expect(listSelectorOf("div:nth-of-type(1) > p:nth-of-type(2)")).toBe("div:nth-of-type(1) > p");
    expect(listSelectorOf("span.text")).toBeNull();
  });

  it("healing a list reads its family off one page's leaves, and a lone positional leaf is no family", () => {
    const leaf = (selector: string, path: string, text: string) => ({ id: selector, selector, path, text, label: "", shape: "text" as const });
    const found = listCandidatesFromLeaves([
      leaf("span.text", "span.text", "A quote"),
      leaf(":scope > span:nth-of-type(2)", "span", "by someone"),
      leaf(":scope > div.tags > a.tag:nth-of-type(1)", "div.tags/a.tag", "light"),
      leaf(":scope > div.tags > a.tag:nth-of-type(2)", "div.tags/a.tag", "night"),
    ]);
    expect(found.map((c) => [c.selector, c.lists])).toEqual([[":scope > div.tags > a.tag", [["light", "night"]]]]);
  });

  it("plurality only words the premise", () => {
    expect(looksPlural("tags")).toBe(true);
    expect(looksPlural("categories")).toBe(true);
    expect(looksPlural("imageUrls")).toBe(true);
    expect(looksPlural("address")).toBe(false);
    expect(looksPlural("status")).toBe(false);
    expect(looksPlural("author", "every author credited")).toBe(true);
  });

  it("CSV joins a list with '; ' and JSON keeps it an array", () => {
    const csv = toCsv([{ text: "a", tags: ["light", "night"] }, { text: "b", tags: ["roads"] }, { text: "c", tags: null }]);
    expect(csv).toBe("text,tags\r\na,light; night\r\nb,roads\r\nc,\r\n");
  });
});

describe("crawl: status and replay", () => {
  const quotes = () => ({ startUrls: [`${server.baseUrl}/fixtures/multi/quotes.html`], mode: "list", fields: [{ name: "text" }, { name: "author" }, { name: "tags" }], description: "quote" });

  it("a requested field left unbound is `partial`, and the summary says which", async () => {
    const actor = makeActor(dir);
    // the defect's first shape: the chooser answers none for tags
    const chooser = new ScriptedChooser({ group: /div\.quote/, text: /span\.text = /, author: /small\.author = / });
    const summary = await runCrawl(fixtureInput(quotes()), makeDeps(dir, actor, chooser));
    expect(summary.items).toBe(10);
    expect(summary.fieldsNotFound).toEqual(["tags"]);
    expect(summary.status).toBe("partial");
    expect(summary.message).toContain("fields not found: tags");
    expect(exitCodeFor(summary.status)).toBe(1);
  }, 60_000);

  it("the replay of a scraper compiled without a field is `partial` too, with the same line and exit 1", async () => {
    const actor = makeActor(dir);
    const chooser = new ScriptedChooser({ group: /div\.quote/, text: /span\.text = /, author: /small\.author = / });
    const first = await runCrawl(fixtureInput(quotes()), makeDeps(dir, actor, chooser));
    expect(first.status).toBe("partial");
    const store = await ScraperStore.open({ actor });
    const stored = await store.get(first.scriptId!);
    expect(stored!.fieldsNotFound).toEqual(["tags"]);

    const silent = new ScriptedChooser({});
    const again = await runCrawl(fixtureInput(quotes()), makeDeps(dir, actor, silent));
    expect(again.cacheHit).toBe(true);
    expect(silent.usage().questions).toBe(0);
    expect(again.items).toBe(10);
    expect(again.status).toBe("partial");
    expect(again.fieldsNotFound).toEqual(["tags"]);
    expect(again.message).toBe(first.message);
    expect(exitCodeFor(again.status)).toBe(1);
  }, 60_000);

  it("a scraper written before fieldsNotFound existed replays as it always did", async () => {
    const actor = makeActor(dir);
    const chooser = new ScriptedChooser({ group: /div\.quote/, text: /span\.text = /, author: /small\.author = / });
    const first = await runCrawl(fixtureInput(quotes()), makeDeps(dir, actor, chooser));
    const store = await ScraperStore.open({ actor });
    const { fieldsNotFound: _dropped, ...old } = (await store.get(first.scriptId!))!;
    await store.put(validateScraper(old));
    const again = await runCrawl(fixtureInput(quotes()), makeDeps(dir, actor, new ScriptedChooser({})));
    expect(again.cacheHit).toBe(true);
    expect(again.status).toBe("succeeded");
    expect(again.fieldsNotFound).toEqual([]);
  }, 60_000);

  it("lists go out as arrays, and the second run replays them with no chooser call", async () => {
    const actor = makeActor(dir);
    const chooser = new ScriptedChooser({ group: /div\.quote/, text: /span\.text = /, author: /small\.author = /, tags: LIST_OPTION });
    const first = await runCrawl(fixtureInput(quotes()), makeDeps(dir, actor, chooser));
    expect(first.status).toBe("succeeded");
    expect(first.fieldsNotFound).toEqual([]);
    // Every field bound: the scraper is written exactly as before the key existed.
    expect(Object.keys((await (await ScraperStore.open({ actor })).get(first.scriptId!))!)).not.toContain("fieldsNotFound");
    const items = await datasetItems(actor);
    expect(items.map((item) => (item.tags as string[]).length)).toEqual(TAG_COUNTS);

    const silent = new ScriptedChooser({});
    const again = await runCrawl(fixtureInput(quotes()), makeDeps(dir, actor, silent));
    expect(again.cacheHit).toBe(true);
    expect(again.status).toBe("succeeded");
    expect(silent.usage().questions).toBe(0);
    const all = await datasetItems(actor);
    expect(all.slice(10).map((item) => item.tags)).toEqual(items.map((item) => item.tags));
  }, 60_000);

  it("a typed list is coerced per element on the row that goes out", async () => {
    const actor = makeActor(dir);
    const chooser = new ScriptedChooser({ group: /article\.drink/, name: /h2\.name = /, prices: LIST_OPTION });
    const raw = { startUrls: [`${server.baseUrl}/fixtures/multi/menu.html`], mode: "list", fields: [{ name: "name" }, { name: "prices", type: "money" }], description: "drink" };
    const summary = await runCrawl(fixtureInput(raw), makeDeps(dir, actor, chooser));
    expect(summary.status).toBe("succeeded");
    const items = await datasetItems(actor);
    expect(items.map((item) => item.prices)).toEqual([[2490, 2990, 3490], [2190, 2590], [2890, 3390, 3890], [3190], [1590, 1990], [1890, 2290, 2690]]);
  }, 60_000);
});
