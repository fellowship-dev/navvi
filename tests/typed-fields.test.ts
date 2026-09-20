import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { parseArgs } from "../src/cli/args.js";
import { FIELD_TYPES, parseFieldSpecs, parseInput } from "../src/input/schema.js";
import { loadListSources, runCrawl } from "../src/replay/crawler.js";
import { coerceValue, coerceValues } from "../src/scraper/extract.js";
import { appendFieldAlternative, validateScraper } from "../src/scraper/schema.js";
import { ScraperStore } from "../src/scraper/store.js";
import { F, datasetItems, fixtureInput, makeActor, makeDeps } from "./helpers.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U3 / R4, R5 (client plan), master plan R34: a field may declare an output
 * type that replay coerces to, recorded in the compiled scraper; a start
 * list may be a URL answering URLs as text or JSON, through the actor input's
 * `{ requestsFromUrl }` entries.
 */

let server: FixtureServer;
let dir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), "navvi-typed-"));
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const PRODUCTS = ["amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema"];
const productUrls = () => PRODUCTS.map((s) => `${server.baseUrl}/demo/pharmacy-v1/producto/${s}.html`);

function startHelperServer(routes: Record<string, { type: string; body: string; status?: number }>): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const route = routes[new URL(req.url ?? "/", "http://127.0.0.1").pathname];
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(route.status ?? 200, { "Content-Type": route.type });
    res.end(route.body);
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

describe("coerceValue (R5)", () => {
  it("money strips currency, spaces and Chilean dot grouping; a decimal comma is honoured; prose is null", () => {
    expect(coerceValue("$ 6.990", "money")).toBe(6990);
    expect(coerceValue("$6.990", "money")).toBe(6990);
    expect(coerceValue("CLP 12.990", "money")).toBe(12990);
    expect(coerceValue("$ 12.990,50", "money")).toBe(12990.5);
    expect(coerceValue("$12,990.00", "money")).toBe(12990);
    expect(coerceValue("US$ 1,234.5", "money")).toBe(1234.5);
    expect(coerceValue("6.99 €", "money")).toBe(6.99);
    expect(coerceValue("1990", "money")).toBe(1990);
    expect(coerceValue("-5,00 €", "money")).toBe(-5);
    expect(coerceValue("Precio no disponible", "money")).toBeNull();
    expect(coerceValue("", "money")).toBeNull();
    expect(coerceValue(null, "money")).toBeNull();
  });

  it("integer takes the first whole number and refuses a fraction; number keeps the fraction", () => {
    expect(coerceValue("98 comprimidos", "integer")).toBe(98);
    expect(coerceValue("1.234", "integer")).toBe(1234);
    expect(coerceValue("12,5 mg", "integer")).toBeNull();
    expect(coerceValue("12,5 mg", "number")).toBe(12.5);
    expect(coerceValue("3.75", "number")).toBe(3.75);
    expect(coerceValue("sin datos", "number")).toBeNull();
  });

  it("boolean maps stock phrases in Spanish and English and leaves unrelated text null", () => {
    for (const yes of ["En Stock", "en stock", "Disponible", "Hay stock", "In Stock", "Available", "Sí", "yes", "true"]) expect(coerceValue(yes, "boolean"), yes).toBe(true);
    for (const no of ["Agotado", "AGOTADO", "Sin stock", "No disponible", "Out of stock", "Sold out", "Unavailable", "no", "false"]) expect(coerceValue(no, "boolean"), no).toBe(false);
    expect(coerceValue("Consultar en tienda", "boolean")).toBeNull();
    expect(coerceValue("Paracetamol 500 mg", "boolean")).toBeNull();
    expect(coerceValue(null, "boolean")).toBeNull();
  });

  it("url resolves to an absolute http(s) URL against the page and refuses other schemes; text is untouched", () => {
    expect(coerceValue("/producto/1", "url", "https://shop.example/catalogo/")).toBe("https://shop.example/producto/1");
    expect(coerceValue("https://shop.example/x", "url")).toBe("https://shop.example/x");
    expect(coerceValue("javascript:void(0)", "url", "https://shop.example/")).toBeNull();
    expect(coerceValue("  Paracetamol  ", "text")).toBe("  Paracetamol  ");
    expect(coerceValue("$ 6.990", undefined)).toBe("$ 6.990");
  });

  it("coerceValues applies each field's type and leaves untyped fields as they were", () => {
    const out = coerceValues({ name: "Aspirina", price: "$ 6.990", stock: "Agotado", link: "/p/1", note: "x" }, { price: "money", stock: "boolean", link: "url" }, "https://shop.example/");
    expect(out).toEqual({ name: "Aspirina", price: 6990, stock: false, link: "https://shop.example/p/1", note: "x" });
  });
});

describe("typed fields in the input and the compiled scraper", () => {
  it("the input accepts every field type and refuses an unknown one; parseFieldSpecs reads name:type", () => {
    const input = parseInput({ startUrls: ["https://example.org/"], mode: "record", fields: FIELD_TYPES.map((type) => ({ name: `f_${type}`, type })) });
    expect(input.fields?.map((f) => f.type)).toEqual([...FIELD_TYPES]);
    expect(() => parseInput({ startUrls: ["https://example.org/"], mode: "record", fields: [{ name: "price", type: "float" }] })).toThrow(/type/);
    expect(parseFieldSpecs(["name", "price:money", "stock:boolean"])).toEqual([{ name: "name" }, { name: "price", type: "money" }, { name: "stock", type: "boolean" }]);
    expect(() => parseFieldSpecs(["price:decimal"])).toThrow(/decimal/);
    const parsed = parseArgs(["--mode", "record", "--fields", "name,price:money", "--detail-fields", "stock:boolean", "https://example.org/"]);
    expect(parsed.ok && parsed.args.fields).toEqual(["name", "price:money"]);
    expect(parsed.ok && parsed.args.detailFields).toEqual(["stock:boolean"]);
  });

  it("the compiled scraper records the type next to the fingerprint and healing keeps it", () => {
    const doc = validateScraper({
      version: 1,
      templateKey: "t",
      cacheKey: "c",
      profile: "store",
      chooser: "agent",
      mode: "record",
      entry: { mode: "direct", url: "https://example.org/" },
      trace: [],
      pagination: { mode: "none" },
      detail: null,
      createdAt: new Date().toISOString(),
      fields: { price: { type: "money", alternatives: [{ selector: ".price", fingerprint: { samples: ["$ 6.990"], shape: "money" } }] } },
    });
    expect(doc.fields.price?.type).toBe("money");
    const healed = appendFieldAlternative(doc, "price", { selector: ".precio", fingerprint: { samples: ["$ 7.990"], shape: "money" } });
    expect(healed.fields.price?.type).toBe("money");
    expect(healed.fields.price?.alternatives).toHaveLength(2);
  });

  it("a compile with typed fields stores the types and the dataset carries coerced values; the replay coerces the same way with zero chooser calls", async () => {
    const actor = makeActor(dir);
    const chooser = new RecordedChooser({ fixture: "compile/pharmacy-v1" });
    const raw = {
      startUrls: productUrls(),
      mode: "record",
      fields: [{ name: "name" }, { name: "laboratory" }, { name: "price", type: "money" }, { name: "stock", type: "boolean" }],
      description: "pharmacy product",
    };
    const summary = await runCrawl(fixtureInput(raw), makeDeps(dir, actor, chooser));
    expect(summary.status).toBe("succeeded");
    expect(summary.items).toBe(3);
    const items = await datasetItems(actor);
    for (const item of items) {
      expect(typeof item.name).toBe("string");
      expect(typeof item.price, String(item.price)).toBe("number");
      expect(typeof item.stock, String(item.stock)).toBe("boolean");
    }
    const store = await ScraperStore.open({ actor });
    const stored = await store.get(summary.scriptId!);
    expect(stored?.fields.price?.type).toBe("money");
    expect(stored?.fields.stock?.type).toBe("boolean");
    expect(stored?.fields.name?.type).toBeUndefined();

    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const replayed = await runCrawl(fixtureInput({ ...raw, scriptId: summary.scriptId }), makeDeps(dir, actor, empty));
    expect(replayed.cacheHit).toBe(true);
    expect(replayed.items).toBe(3);
    expect(empty.usage().questions).toBe(0);
    const again = await datasetItems(actor);
    expect(again.slice(3).map((i) => [i.price, i.stock])).toEqual(items.map((i) => [i.price, i.stock]));
  }, 60_000);

  it("untyped fields behave exactly as before: strings in the dataset", async () => {
    const actor = makeActor(dir);
    const chooser = new RecordedChooser({ fixture: "compile/pharmacy-v1" });
    const raw = { startUrls: productUrls(), mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
    const summary = await runCrawl(fixtureInput(raw), makeDeps(dir, actor, chooser));
    expect(summary.status).toBe("succeeded");
    for (const item of await datasetItems(actor)) {
      expect(item.price).toMatch(/^\$ [\d.]+$/);
      expect(typeof item.stock).toBe("string");
    }
  }, 40_000);
});

describe("URL start lists through the actor input (R4, R34)", () => {
  it("startUrls accepts strings, { url } and { requestsFromUrl } entries and refuses private hosts in each", () => {
    const input = parseInput({ startUrls: ["https://example.org/a", { url: "https://example.org/b" }, { requestsFromUrl: "https://api.example.org/list" }], mode: "record", fields: F("x") });
    expect(input.startUrls).toEqual(["https://example.org/a", "https://example.org/b"]);
    expect(input.urlLists).toEqual(["https://api.example.org/list"]);
    expect(() => parseInput({ startUrls: [{ requestsFromUrl: "http://10.0.0.5/list" }], mode: "record", fields: F("x") })).toThrow(/allowed public/);
    // a list alone is a valid start
    expect(parseInput({ startUrls: [{ requestsFromUrl: "https://api.example.org/list" }], mode: "record", fields: F("x") }).startUrls).toEqual([]);
  });

  it("a list URL answering newline text enqueues three, JSON two, an object with data rows one each; private hosts are dropped; a failing list is skipped", async () => {
    const helper = await startHelperServer({
      "/three.txt": { type: "text/plain", body: "https://example.org/1\nhttps://example.org/2\r\nhttps://example.org/3\n" },
      "/two": { type: "application/json", body: JSON.stringify(["https://example.org/u1", "https://example.org/u2", "http://10.0.0.5/private", "http://localhost/x"]) },
      "/strapi": { type: "application/json; charset=utf-8", body: JSON.stringify({ data: [{ id: 1, attributes: { url: "https://example.org/s1" } }, { url: "https://example.org/s2" }] }) },
      "/down": { type: "text/plain", body: "nope", status: 500 },
      "/html": { type: "text/html", body: "<html><body>not a list</body></html>" },
    });
    try {
      const urls = await loadListSources(["https://example.org/page"], [`${helper.baseUrl}/three.txt`, `${helper.baseUrl}/two`, `${helper.baseUrl}/strapi`, `${helper.baseUrl}/down`, `${helper.baseUrl}/html`], ["127.0.0.1"]);
      expect(urls).toEqual(["https://example.org/page", "https://example.org/1", "https://example.org/2", "https://example.org/3", "https://example.org/u1", "https://example.org/u2", "https://example.org/s1", "https://example.org/s2"]);
    } finally {
      await helper.close();
    }
  });

  it("a crawl whose only start is a list URL without a file extension records every listed page", async () => {
    const helper = await startHelperServer({ "/api/get-prices-list": { type: "application/json; charset=utf-8", body: JSON.stringify(productUrls().map((url) => ({ url }))) } });
    try {
      const actor = makeActor(dir);
      const chooser = new RecordedChooser({ fixture: "compile/pharmacy-v1" });
      const raw = { startUrls: [{ requestsFromUrl: `${helper.baseUrl}/api/get-prices-list` }], mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
      const summary = await runCrawl(fixtureInput(raw), makeDeps(dir, actor, chooser));
      expect(summary.status).toBe("succeeded");
      expect(summary.items).toBe(3);
      expect(new Set((await datasetItems(actor)).map((i) => i._source))).toEqual(new Set(productUrls()));
    } finally {
      await helper.close();
    }
  }, 40_000);
});
