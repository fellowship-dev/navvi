import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actor } from "apify";
import { MemoryStorage } from "crawlee";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { ScraperStore } from "../src/scraper/store.js";
import type { CompiledScraper } from "../src/scraper/schema.js";
import { loginFixture } from "./helpers.js";
import { storageAdditions } from "./storage-guard.js";

let dir: string;
let store: ScraperStore;
let actor: Actor;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "navvi-store-"));
  actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: dir, persistStorage: true }) });
  store = await ScraperStore.open({ actor });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withKey(key: string, profile: CompiledScraper["profile"] = "store"): CompiledScraper {
  return { ...loginFixture(), cacheKey: key, profile };
}

describe("ScraperStore (R5)", () => {
  it("round-trips a document through put and get, and mirrors it under SCRAPER", async () => {
    const doc = withKey("example.com_jobs-round", "local");
    await store.put(doc);
    expect(await store.get(doc.cacheKey)).toEqual(doc);
    const mirror = await (await actor.openKeyValueStore()).getValue("SCRAPER");
    expect(mirror).toEqual(doc);
  });

  it("returns null for a missing key", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("reports cacheHit on a second load, forceRecompile bypasses, scriptId overrides", async () => {
    const key = "example.com_jobs-hit";
    expect(await store.load({ cacheKey: key, profile: "store" })).toEqual({ scraper: null, cacheHit: false });
    await store.put(withKey(key));
    const hit = await store.load({ cacheKey: key, profile: "store" });
    expect(hit.cacheHit).toBe(true);
    expect(hit.scraper?.cacheKey).toBe(key);
    expect(await store.load({ cacheKey: key, profile: "store", forceRecompile: true })).toEqual({ scraper: null, cacheHit: false });
    const byId = await store.load({ cacheKey: "something-else", profile: "store", scriptId: key });
    expect(byId.cacheHit).toBe(true);
    expect(byId.scraper?.cacheKey).toBe(key);
    await expect(store.load({ cacheKey: key, profile: "store", scriptId: "missing-id" })).rejects.toThrow(/missing-id/);
  });

  it("refuses a local scraper for a store run with status blocked_login_required", async () => {
    const key = "example.com_jobs-local";
    await store.put(withKey(key, "local"));
    await expect(store.load({ cacheKey: key, profile: "store" })).rejects.toMatchObject({ status: "blocked_login_required" });
    expect((await store.load({ cacheKey: key, profile: "local" })).cacheHit).toBe(true);
  });

  it("rejects an unknown version on read", async () => {
    const raw = await actor.openKeyValueStore("scraper-cache");
    await raw.setValue("bad-version", { ...withKey("bad-version"), version: 2 });
    await expect(store.get("bad-version")).rejects.toThrow(/version 2/);
  });

  // Not "./storage is empty": a developer who has run the product locally has a
  // real cache there. The invariant is that the *tests* add nothing to it.
  it("adds nothing to the project storage directory", () => {
    const added = storageAdditions(inject("projectStorageBefore"));
    expect(added, `the tests wrote into ./storage: ${added.join(", ")}`).toEqual([]);
  });
});
