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
