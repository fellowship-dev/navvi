import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { runCrawl } from "../src/replay/crawler.js";
import { ScraperStore } from "../src/scraper/store.js";
import { SCRAPER_VERSION, cacheKey, type CompiledScraper } from "../src/scraper/schema.js";
import { groupByTemplate } from "../src/template/index.js";
import { F, datasetItems, fixtureInput, makeActor, makeDeps } from "./helpers.js";
import { SEARCH_PAGES, startFixtureServer, type FixtureServer } from "./server.js";

/**
 * List mode at scale: one pinned search scraper replayed over many search URLs
 * of one template (the same search, a different `q`). Every row says which
 * start URL produced it, every start URL is read however small `maxPages` is,
 * pagination depth is capped per start URL, and a search URL the site answers
 * with an error, a redirect, a challenge or "no results" yields no row and is
 * counted, never healed.
 */

let server: FixtureServer;
let dir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), "navvi-list-scale-"));
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const FIELDS = ["name", "link"];
const WORDS = ["amoxicilina", "atorvastatina", "clotrimazol", "diclofenaco", "ibuprofeno", "loratadina", "losartan", "metformina", "omeprazol", "paracetamol"];
const search = (q: string) => `${server.baseUrl}/demo/buscador/buscar?q=${encodeURIComponent(q)}`;
/** `n` distinct queries of one template. */
const queries = (n: number) => Array.from({ length: n }, (_, i) => `${WORDS[i % WORDS.length]}-${Math.floor(i / WORDS.length) + 1}`);

/** Seeds the search scraper and returns its scriptId: a pinned run replays it with zero chooser questions. */
async function seedSearch(actor: ReturnType<typeof makeActor>): Promise<string> {
  const urls = [search("amoxicilina")];
  const templateKey = [...groupByTemplate(urls).keys()][0]!;
  const key = cacheKey(templateKey, { fields: FIELDS, profile: "store" });
  const scraper: CompiledScraper = {
    version: SCRAPER_VERSION,
    templateKey,
    cacheKey: key,
    profile: "store",
    chooser: "agent",
    mode: "list",
    entry: { mode: "direct", url: urls[0]! },
    trace: [],
    item: { anchorSelector: "ul.resultados > li.producto", span: 1 },
    pagination: { mode: "next_link", locator: [{ role: "link", name: "Siguiente", exact: true }] },
    detail: null,
    createdAt: new Date().toISOString(),
    fields: {
      name: { alternatives: [{ selector: "h2 > a", fingerprint: { samples: ["amoxicilina 10 mg"], shape: "text" } }] },
      link: { alternatives: [{ selector: "h2 > a", attr: "href", fingerprint: { samples: [`${server.baseUrl}/demo/buscador/producto/amoxicilina-10-mg.html`], shape: "url" } }] },
    },
  };
  await (await ScraperStore.open({ actor })).put(scraper);
  return key;
}

const run = async (actor: ReturnType<typeof makeActor>, scriptId: string, startUrls: string[], over: Record<string, unknown> = {}) => {
  const chooser = new RecordedChooser({ fixture: "crawler/empty" });
  const summary = await runCrawl(fixtureInput({ mode: "list", fields: F(...FIELDS), startUrls, scriptId, ...over }), makeDeps(dir, actor, chooser, { maxConcurrency: 4 }));
  return { summary, chooser, rows: await datasetItems(actor) };
};

describe("list mode at scale", () => {
  it("50 search URLs of one template replay with one scraper and no question; every row carries its start URL, even with maxPages below the start list", async () => {
    const actor = makeActor(dir);
    const scriptId = await seedSearch(actor);
    const qs = queries(50);
    const startUrls = qs.map(search);
    const { summary, chooser, rows } = await run(actor, scriptId, startUrls, { maxPages: 1, maxPagesPerStart: 1 });
    expect(summary.status).toBe("succeeded");
    expect(summary.templates).toBe(1);
    expect(summary.requests).toEqual({ compile: 0, list: 50, record: 0 });
    expect(chooser.usage().questions).toBe(0);
    expect(summary.pages).toBe(50);
    expect(summary.items).toBe(150);
    expect(rows).toHaveLength(150);
    expect(new Set(rows.map((r) => r._startUrl))).toEqual(new Set(startUrls));
    for (const [i, q] of qs.entries()) {
      const mine = rows.filter((r) => r._startUrl === startUrls[i]);
      expect(mine.map((r) => r.name).sort()).toEqual([`${q} 10 mg`, `${q} 15 mg`, "Suero fisiológico"].sort());
    }
  }, 120_000);

  it("the per-start cap limits pagination depth of each start URL; the default follows the listing as before", async () => {
    const actor = makeActor(dir);
    const scriptId = await seedSearch(actor);
    const startUrls = ["amoxicilina", "omeprazol", "losartan"].map(search);
    const capped = await run(actor, scriptId, startUrls, { maxPages: 100, maxPagesPerStart: 2 });
    expect(capped.summary.pages).toBe(6);
    expect(capped.summary.items).toBe(15);
    for (const url of startUrls) {
      const mine = capped.rows.filter((r) => r._startUrl === url);
      expect(mine).toHaveLength(5);
      // `_source` is the page the row was read on; `_startUrl` the listing it came from
      expect(new Set(mine.map((r) => r._source))).toEqual(new Set([url, `${url}&page=2`]));
    }

    const actor2 = makeActor(dir);
    const scriptId2 = await seedSearch(actor2);
    const whole = await run(actor2, scriptId2, [search("amoxicilina")]);
    expect(whole.summary.pages).toBe(SEARCH_PAGES);
    expect(whole.summary.items).toBe(1 + 2 * SEARCH_PAGES);
    expect(new Set(whole.rows.map((r) => r._startUrl))).toEqual(new Set([search("amoxicilina")]));
  }, 60_000);

  it("the same product found by two queries is two rows, one per start URL", async () => {
    const actor = makeActor(dir);
    const scriptId = await seedSearch(actor);
    const startUrls = [search("amoxicilina"), search("omeprazol")];
    const { rows } = await run(actor, scriptId, startUrls, { maxPagesPerStart: 1 });
    const both = rows.filter((r) => r.name === "Suero fisiológico");
    expect(both).toHaveLength(2);
    expect(new Set(both.map((r) => r._startUrl))).toEqual(new Set(startUrls));
  }, 60_000);

  it("a search URL answering 404, 500, a challenge or a redirect off the template yields no row, no healing, and is counted", async () => {
    const actor = makeActor(dir);
    const scriptId = await seedSearch(actor);
    const good = [search("amoxicilina"), search("omeprazol")];
    const gone = search("gone-ejemplo");
    const failing = search("error-ejemplo");
    const retired = search("retirado-ejemplo");
    const challenged = search("challenge-ejemplo");
    const { summary, chooser, rows } = await run(actor, scriptId, [...good, gone, failing, retired, challenged], { maxPagesPerStart: 1 });
    expect(summary.status).toBe("succeeded");
    expect(summary.items).toBe(6);
    expect(new Set(rows.map((r) => r._startUrl))).toEqual(new Set(good));
    expect(summary.deadPages?.count).toBe(2);
    expect(new Set(summary.deadPages?.urls)).toEqual(new Set([gone, retired]));
    expect(summary.transientPages).toEqual({ count: 1, urls: [failing] });
    expect(summary.blockedPages).toBe(1);
    expect(summary.healingEvents).toEqual([]);
    expect(summary.unhealed).toBe(0);
    expect(chooser.usage().questions).toBe(0);
  }, 60_000);

  it("a no-results page whose recommendations sit outside the results yields no row and is counted as an empty listing", async () => {
    const actor = makeActor(dir);
    const scriptId = await seedSearch(actor);
    const empty = search("sin-resultados-ejemplo");
    const { summary, chooser, rows } = await run(actor, scriptId, [search("amoxicilina"), empty], { maxPagesPerStart: 1 });
    expect(summary.status).toBe("succeeded");
    expect(rows.filter((r) => r._startUrl === empty)).toEqual([]);
    expect(summary.items).toBe(3);
    expect(summary.emptyListings).toEqual({ count: 1, urls: [empty] });
    expect(summary.healingEvents).toEqual([]);
    expect(chooser.usage().questions).toBe(0);
  }, 60_000);
});
