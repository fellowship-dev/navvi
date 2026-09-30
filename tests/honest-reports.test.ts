import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { runCrawl } from "../src/replay/crawler.js";
import { cacheKey, validateScraper } from "../src/scraper/schema.js";
import { ScraperStore } from "../src/scraper/store.js";
import { groupByTemplate } from "../src/template/index.js";
import { F, datasetItems, fixtureInput, makeActor, makeDeps } from "./helpers.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U9: the three counters that told a replay's owner something other than what
 * happened. A single-page app still rendering (a spinner, a location modal
 * with a reCAPTCHA widget) was counted `blockedPages`; a record page whose
 * payload never came was `unhealed` and asked for a repair; an optional field
 * that broke on one layout and kept filling on another was silent.
 */

let server: FixtureServer;
let dir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), "navvi-honest-"));
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const PRODUCTS = ["amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema"];
const product = (slug: string) => `${server.baseUrl}/demo/pharmacy-v1/producto/${slug}.html`;
const productUrls = () => PRODUCTS.map(product);
const raw = { mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };

async function compiledPharmacy(actor: ReturnType<typeof makeActor>): Promise<string> {
  const compiled = await runCrawl(fixtureInput({ ...raw, startUrls: productUrls() }), makeDeps(dir, actor, new RecordedChooser({ fixture: "compile/pharmacy-v1" })));
  expect(compiled.status).toBe("succeeded");
  return compiled.scriptId!;
}

describe("a page still rendering", () => {
  it("is read once it settles: a spinner and a captcha widget that become the product are a row, not a block", async () => {
    const actor = makeActor(dir);
    const scriptId = await compiledPharmacy(actor);
    const late = product(`tardio-${PRODUCTS[1]}`);
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const replayed = await runCrawl(fixtureInput({ ...raw, startUrls: [...productUrls(), late], scriptId }), makeDeps(dir, actor, empty));
    expect(replayed.status).toBe("succeeded");
    expect(replayed.items).toBe(4);
    expect(replayed.blockedPages).toBeUndefined();
    expect(replayed.unsettledPages).toBeUndefined();
    expect(empty.usage().questions).toBe(0);
    const row = (await datasetItems(actor)).find((i) => i._source === late);
    expect(row?.name).toMatch(/Atorvastatina/);
  }, 90_000);

  it("that never settles is counted unsettled, not blocked: no row, no healing", async () => {
    const actor = makeActor(dir);
    const scriptId = await compiledPharmacy(actor);
    const stuck = product(`cargando-${PRODUCTS[1]}`);
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const replayed = await runCrawl(fixtureInput({ ...raw, startUrls: [...productUrls(), stuck], scriptId }), makeDeps(dir, actor, empty));
    expect(replayed.status).toBe("succeeded");
    expect(replayed.items).toBe(3);
    expect(replayed.unsettledPages).toEqual({ count: 1, urls: [stuck] });
    expect(replayed.blockedPages).toBeUndefined();
    expect(replayed.unhealed).toBe(0);
    expect(replayed.healingEvents).toEqual([]);
    expect(empty.usage().questions).toBe(0);
  }, 90_000);
});

describe("a record page whose payload never came", () => {
  it("is counted noPayloadPages, not unhealed, and asks nothing", async () => {
    const FIELDS = ["productName", "listPrice"];
    const urls = [`${server.baseUrl}/demo/ficha-red/producto.html?sku=900401`, `${server.baseUrl}/demo/ficha-red/producto.html?sku=sin-carga-900402`];
    const templateKey = [...groupByTemplate(urls).keys()][0]!;
    expect(groupByTemplate(urls).get(templateKey)).toHaveLength(2);
    const actor = makeActor(dir);
    const store = await ScraperStore.open({ actor });
    const alternative = (path: string, shape: "text" | "int", sample: string) => ({
      selector: "payload-<sku>.json",
      source: "network" as const,
      path,
      match: "ficha-red/payload-",
      fingerprint: { samples: [sample], shape },
    });
    const key = cacheKey(templateKey, { fields: FIELDS, profile: "store" });
    await store.put(
      validateScraper({
        version: 1,
        templateKey,
        cacheKey: key,
        profile: "store",
        chooser: "agent",
        mode: "record",
        entry: { mode: "direct", url: urls[0]! },
        trace: [],
        pagination: { mode: "none" },
        detail: null,
        createdAt: "2026-09-30T12:00:00.000Z",
        fields: {
          productName: { alternatives: [alternative("productData.name", "text", "Producto 900401")] },
          listPrice: { alternatives: [alternative("productData.prices.list", "int", "4690")] },
        },
      }),
    );
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const replayed = await runCrawl(
      fixtureInput({ mode: "record", profile: "store", fields: F(...FIELDS), startUrls: urls, scriptId: key }),
      makeDeps(dir, actor, empty, { maxConcurrency: 1 }),
    );
    expect(replayed.status).toBe("succeeded");
    expect(replayed.items).toBe(1);
    expect(replayed.noPayloadPages).toEqual({ count: 1, urls: [urls[1]] });
    expect(replayed.unhealed).toBe(0);
    expect(replayed.healingEvents).toEqual([]);
    expect(empty.usage().questions).toBe(0);
  }, 90_000);
});

describe("an optional field that breaks on one layout", () => {
  it("is reported as optionalDrift with the pages it filled and the pages it did not", async () => {
    const actor = makeActor(dir);
    const scriptId = await compiledPharmacy(actor);
    const redesigned = [product(`rediseno-${PRODUCTS[0]}`), product(`rediseno-${PRODUCTS[2]}`)];
    const optional = { ...raw, fields: [...F("name", "laboratory", "stock"), { name: "price", optional: true }] };
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const replayed = await runCrawl(fixtureInput({ ...optional, startUrls: [...productUrls(), ...redesigned], scriptId }), makeDeps(dir, actor, empty));
    expect(replayed.status).toBe("succeeded");
    expect(replayed.items).toBe(5);
    expect(replayed.healingEvents).toEqual([]);
    expect(empty.usage().questions).toBe(0);
    expect(replayed.optionalDrift).toEqual([{ field: "price", pages: 2, filled: 3 }]);
  }, 90_000);

  it("is not reported when it filled on every page", async () => {
    const actor = makeActor(dir);
    const scriptId = await compiledPharmacy(actor);
    const optional = { ...raw, fields: [...F("name", "laboratory", "stock"), { name: "price", optional: true }] };
    const replayed = await runCrawl(fixtureInput({ ...optional, startUrls: productUrls(), scriptId }), makeDeps(dir, actor, new RecordedChooser({ fixture: "crawler/empty" })));
    expect(replayed.items).toBe(3);
    expect(replayed.optionalDrift).toBeUndefined();
  }, 90_000);
});
