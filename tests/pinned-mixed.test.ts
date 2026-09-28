import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { runCrawl } from "../src/replay/crawler.js";
import { F, datasetItems, fixtureInput, makeActor, makeDeps } from "./helpers.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * A pinned scraper replays every URL of its template even when the start list
 * mixes shapes. Found on a trial run, 2026-09-24: a list with one page of
 * another shape made two templates, the pin was dropped (it applied only to a
 * one-template list) and the run recompiled instead of replaying.
 */

let server: FixtureServer;
let dir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), "navvi-pinned-"));
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const PRODUCTS = ["amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema"];
const productUrls = () => PRODUCTS.map((s) => `${server.baseUrl}/demo/pharmacy-v1/producto/${s}.html`);

describe("a pinned scraper on a mixed start list", () => {
  it("replays every URL of its template with zero chooser questions and reports the other shapes without compiling them", async () => {
    const actor = makeActor(dir);
    const raw = { mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
    const compiled = await runCrawl(fixtureInput({ ...raw, startUrls: productUrls() }), makeDeps(dir, actor, new RecordedChooser({ fixture: "compile/pharmacy-v1" })));
    expect(compiled.status).toBe("succeeded");

    const listing = `${server.baseUrl}/demo/pharmacy-v1/index.html`;
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const replayed = await runCrawl(fixtureInput({ ...raw, startUrls: [listing, ...productUrls()], scriptId: compiled.scriptId }), makeDeps(dir, actor, empty));
    expect(replayed.cacheHit).toBe(true);
    expect(replayed.templates).toBe(1);
    expect(replayed.requests.compile).toBe(0);
    expect(replayed.items).toBe(3);
    expect(empty.usage().questions).toBe(0);
    expect(replayed.offTemplate).toEqual({ count: 1, urls: [listing] });
    const sources = (await datasetItems(actor)).slice(3).map((i) => i._source);
    expect(new Set(sources)).toEqual(new Set(productUrls()));
  }, 60_000);

  it("a challenge page on a pinned replay yields no row, asks nothing, and is kept as evidence", async () => {
    const actor = makeActor(dir);
    const raw = { mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
    const compiled = await runCrawl(fixtureInput({ ...raw, startUrls: productUrls() }), makeDeps(dir, actor, new RecordedChooser({ fixture: "compile/pharmacy-v1" })));
    const challenged = `${server.baseUrl}/demo/pharmacy-v1/producto/challenge-ejemplo-10-mg.html`;
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const replayed = await runCrawl(fixtureInput({ ...raw, startUrls: [...productUrls(), challenged], scriptId: compiled.scriptId }), makeDeps(dir, actor, empty));
    expect(replayed.status).toBe("succeeded");
    expect(replayed.items).toBe(3);
    expect(replayed.blockedPages).toBe(1);
    expect(empty.usage().questions).toBe(0);
    const store = await actor.openKeyValueStore();
    expect(String(await store.getValue("BLOCKED_PAGE"))).toMatch(/Verify you are human/);
    expect(await store.getValue("BLOCKED_PAGE_META")).toMatchObject({ url: challenged, status: 503, during: "replay" });

    const onlyBlocked = await runCrawl(fixtureInput({ ...raw, startUrls: [challenged], scriptId: compiled.scriptId }), makeDeps(dir, actor, new RecordedChooser({ fixture: "crawler/empty" })));
    expect(onlyBlocked.status).toBe("blocked_bot_detection");
    expect(onlyBlocked.items).toBe(0);
  }, 60_000);

  it("a page the site answers 404 is a dead URL: no row, no healing, counted and listed", async () => {
    const actor = makeActor(dir);
    const raw = { mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
    const compiled = await runCrawl(fixtureInput({ ...raw, startUrls: productUrls() }), makeDeps(dir, actor, new RecordedChooser({ fixture: "compile/pharmacy-v1" })));
    const gone = `${server.baseUrl}/demo/pharmacy-v1/producto/descontinuado-10-mg.html`;
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const replayed = await runCrawl(fixtureInput({ ...raw, startUrls: [...productUrls(), gone], scriptId: compiled.scriptId }), makeDeps(dir, actor, empty));
    expect(replayed.status).toBe("succeeded");
    expect(replayed.items).toBe(3);
    expect(replayed.deadPages).toEqual({ count: 1, urls: [gone] });
    expect(replayed.blockedPages).toBeUndefined();
    expect(replayed.healingEvents).toEqual([]);
    expect(empty.usage().questions).toBe(0);
  }, 60_000);

  it("an optional field empty on a healthy page is not drift: no healing, the row goes out with it null", async () => {
    const actor = makeActor(dir);
    const raw = { mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
    const compiled = await runCrawl(fixtureInput({ ...raw, startUrls: productUrls() }), makeDeps(dir, actor, new RecordedChooser({ fixture: "compile/pharmacy-v1" })));
    const priceless = `${server.baseUrl}/demo/pharmacy-v1/producto/sin-precio-${PRODUCTS[0]}.html`;
    const optional = { ...raw, fields: [...F("name", "laboratory", "stock"), { name: "price", optional: true }] };
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const replayed = await runCrawl(fixtureInput({ ...optional, startUrls: [...productUrls(), priceless], scriptId: compiled.scriptId }), makeDeps(dir, actor, empty));
    expect(replayed.status).toBe("succeeded");
    expect(replayed.items).toBe(4);
    expect(replayed.healingEvents).toEqual([]);
    expect(replayed.unhealed).toBe(0);
    expect(empty.usage().questions).toBe(0);
    const row = (await datasetItems(actor)).find((i) => i._source === priceless);
    expect(row?.price).toBeNull();
    expect(row?.name).toBeTruthy();
  }, 60_000);

  it("a pin whose template matches no start URL ends the run without compiling", async () => {
    const actor = makeActor(dir);
    const raw = { mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
    const compiled = await runCrawl(fixtureInput({ ...raw, startUrls: productUrls() }), makeDeps(dir, actor, new RecordedChooser({ fixture: "compile/pharmacy-v1" })));
    // two shapes, so the one-template fallback (a pin keeps a list of one shape, as before) does not apply
    const other = [`${server.baseUrl}/demo/pharmacy-v1/index.html`, `${server.baseUrl}/demo/index.html`];
    const replayed = await runCrawl(fixtureInput({ ...raw, startUrls: other, scriptId: compiled.scriptId }), makeDeps(dir, actor, new RecordedChooser({ fixture: "crawler/empty" })));
    expect(replayed.status).toBe("no_items_found");
    expect(replayed.requests.compile).toBe(0);
    expect(replayed.message).toMatch(/pinned scraper's template/);
  }, 60_000);
});
