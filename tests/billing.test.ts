import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "apify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHARGE_EVENTS, Charger, type ChargeEvent, type ChargingActor } from "../src/billing/charge.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { runCrawl, type CrawlActor } from "../src/replay/crawler.js";
import { cacheKey } from "../src/scraper/schema.js";
import { groupByTemplate } from "../src/template/index.js";
import { F, RoutingChooser, datasetItems, fixtureInput, makeActor, makeDeps } from "./helpers.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U9 / R20, KTD10: the four pay-per-event events, the charge-limit check
 * before every page, and the summary's charge counts. The platform's
 * ChargingManager is replaced by a fake with the SDK's semantics: a price per
 * event, a total budget, and a charge that fulfils fewer events than asked
 * when the budget runs out.
 */

let server: FixtureServer;
let dir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), "navvi-billing-"));
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const PRODUCTS = ["amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema", "diclofenaco-gel", "ibuprofeno-400-mg", "loratadina-10-mg"];
const productUrls = () => PRODUCTS.map((s) => `${server.baseUrl}/demo/pharmacy-v1/producto/${s}.html`);

/** The SDK's ChargingManager, reduced to what the charger reads: prices, a budget, partial fulfilment. */
class FakeCharging {
  readonly calls: Array<{ eventName: string; count: number }> = [];
  readonly charged: Record<string, number> = {};
  constructor(
    private readonly prices: Record<string, number>,
    private readonly maxUsd: number,
    private readonly payPerEvent = true,
  ) {}
  private total(): number {
    return Object.entries(this.charged).reduce((sum, [event, n]) => sum + n * (this.prices[event] ?? 0), 0);
  }
  room(eventName: string): number {
    const price = this.prices[eventName] ?? 0;
    if (!price) return Infinity;
    return Math.max(0, Math.floor((this.maxUsd - this.total()) / price + 1e-9));
  }
  actor(base: Actor): CrawlActor {
    return {
      openKeyValueStore: (name) => base.openKeyValueStore(name),
      openDataset: (name) => base.openDataset(name),
      isAtHome: () => true,
      config: base.config,
      charge: async ({ eventName, count = 1 }) => {
        this.calls.push({ eventName, count });
        const n = Math.min(count, this.room(eventName));
        this.charged[eventName] = (this.charged[eventName] ?? 0) + n;
        return { eventChargeLimitReached: this.room(eventName) <= 0, chargedCount: n, chargeableWithinLimit: {} };
      },
      getChargingManager: () => ({
        getPricingInfo: () => ({ isPayPerEvent: this.payPerEvent, maxTotalChargeUsd: this.maxUsd, perEventPrices: this.prices }),
        calculateMaxEventChargeCountWithinLimit: (eventName: string) => this.room(eventName),
      }),
    };
  }
}

const UNIT_PRICES: Record<ChargeEvent, number> = { "actor-start": 1, "scraper-compiled": 1, "page-scraped": 1, "result-item": 1 };
const zeroCounts = () => Object.fromEntries(CHARGE_EVENTS.map((e) => [e, 0]));

describe("Charger", () => {
  it("is a no-op without pay-per-event pricing: canAfford is true, nothing is called, counts stay zero", async () => {
    const fake = new FakeCharging(UNIT_PRICES, 1, false);
    const charger = Charger.for(fake.actor(makeActor(dir)));
    expect(charger.enabled).toBe(false);
    expect(charger.canAfford("page-scraped")).toBe(true);
    expect(charger.room("result-item")).toBe(Infinity);
    expect(await charger.charge("result-item", 5)).toEqual({ charged: 0, limitReached: false });
    expect(fake.calls).toEqual([]);
    expect(charger.counts).toEqual(zeroCounts());
  });

  it("is a no-op for an actor without a charge method or whose pricing cannot be read", () => {
    const base = makeActor(dir);
    const bare: ChargingActor = {};
    expect(Charger.for(bare).enabled).toBe(false);
    // a real Actor instance that was never initialised throws from getChargingManager
    expect(Charger.for(base).enabled).toBe(false);
  });

  it("counts every charged event, fulfils partially at the budget and records the reached limit", async () => {
    const fake = new FakeCharging(UNIT_PRICES, 3);
    const charger = Charger.for(fake.actor(makeActor(dir)));
    expect(charger.enabled).toBe(true);
    expect(await charger.charge("actor-start")).toEqual({ charged: 1, limitReached: false });
    expect(charger.room("result-item")).toBe(2);
    expect(await charger.charge("result-item", 5)).toEqual({ charged: 2, limitReached: true });
    expect(charger.limitReached).toBe(true);
    expect(charger.canAfford("page-scraped")).toBe(false);
    expect(charger.room("page-scraped")).toBe(0);
    expect(charger.counts).toEqual({ ...zeroCounts(), "actor-start": 1, "result-item": 2 });
    // nothing more is charged once the limit is reached
    expect(await charger.charge("page-scraped")).toEqual({ charged: 0, limitReached: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("an event with no price is free: infinite room, still counted", async () => {
    const fake = new FakeCharging({ "actor-start": 1 }, 1);
    const charger = Charger.for(fake.actor(makeActor(dir)));
    expect(charger.room("page-scraped")).toBe(Infinity);
    expect(await charger.charge("page-scraped", 3)).toEqual({ charged: 3, limitReached: false });
    expect(charger.counts["page-scraped"]).toBe(3);
  });
});

describe("charging through a crawl (R20, AE13)", () => {
  it("AE13: the limit reached after 10 of 25 items keeps the 10 items, ends charge_limit and schedules no further page", async () => {
    const base = makeActor(dir);
    // 1 actor-start + 1 scraper-compiled + 1 page-scraped + 10 result-items
    const fake = new FakeCharging(UNIT_PRICES, 13);
    const chooser = new RecordedChooser({ fixture: "compile/python-jobs" });
    const raw = { startUrls: [`${server.baseUrl}/fixtures/python-jobs.html`], mode: "list", fields: F("title", "company", "location", "date", "link"), description: "python job listing", maxItems: 50 };
    const summary = await runCrawl(fixtureInput(raw), makeDeps(dir, fake.actor(base), chooser));
    expect(summary.status).toBe("charge_limit");
    expect(summary.items).toBe(10);
    expect(summary.pages).toBe(1);
    expect(summary.requests).toEqual({ compile: 1, list: 1, record: 0 });
    expect(summary.charges).toEqual({ "actor-start": 1, "scraper-compiled": 1, "page-scraped": 1, "result-item": 10 });
    expect(await datasetItems(base)).toHaveLength(10);
    expect(summary.message).toMatch(/charge limit/);
  });

  it("a blocked run charges actor-start only and the summary still reports chooser usage", async () => {
    const base = makeActor(dir);
    const fake = new FakeCharging(UNIT_PRICES, 100);
    const chooser = new RecordedChooser({ fixture: "crawler/empty" });
    const raw = { startUrls: [`${server.baseUrl}/fixtures/challenge.html`], mode: "list", fields: F("title"), description: "anything" };
    const summary = await runCrawl(fixtureInput(raw), makeDeps(dir, fake.actor(base), chooser));
    expect(summary.status).toBe("blocked_bot_detection");
    expect(summary.charges).toEqual({ ...zeroCounts(), "actor-start": 1 });
    expect(fake.calls.map((c) => c.eventName)).toEqual(["actor-start"]);
    expect(summary.chooser).toMatchObject({ name: "recorded", questions: 0 });
    expect(summary.zeroDataRetention).toBe("not_applicable");
  });

  it("two templates charge scraper-compiled twice; the cache-hit rerun charges it zero times", async () => {
    const base = makeActor(dir);
    const fake = new FakeCharging(UNIT_PRICES, 1000);
    const chooser = new RoutingChooser([
      ["/demo/pharmacy-v1/", "compile/pharmacy-v1"],
      ["/fixtures/python-jobs", "crawler/python-jobs-record"],
    ]);
    const urls = [...productUrls(), `${server.baseUrl}/fixtures/python-jobs.html`];
    const raw = { startUrls: urls, mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
    const first = await runCrawl(fixtureInput(raw), makeDeps(dir, fake.actor(base), chooser));
    expect(first.templates).toBe(2);
    expect(first.charges["scraper-compiled"]).toBe(2);
    expect(first.charges["actor-start"]).toBe(1);
    expect(first.charges["page-scraped"]).toBe(first.pages);
    expect(first.charges["result-item"]).toBe(first.items);
    // two templates: no single scraper to pin
    expect(first.scriptId).toBeNull();

    const again = new FakeCharging(UNIT_PRICES, 1000);
    const rerun = await runCrawl(fixtureInput(raw), makeDeps(dir, again.actor(base), new RecordedChooser({ fixture: "crawler/empty" })));
    expect(rerun.cacheHit).toBe(true);
    expect(rerun.charges["scraper-compiled"]).toBe(0);
    expect(rerun.charges["actor-start"]).toBe(1);
    expect(rerun.charges["result-item"]).toBe(rerun.items);
  }, 60_000);

  it("locally (no pay-per-event pricing) no charge call happens and every count is zero", async () => {
    const base = makeActor(dir);
    const fake = new FakeCharging(UNIT_PRICES, 0, false);
    const chooser = new RecordedChooser({ fixture: "compile/python-jobs" });
    const raw = { startUrls: [`${server.baseUrl}/fixtures/python-jobs.html`], mode: "list", fields: F("title", "company", "location", "date", "link"), description: "python job listing" };
    const summary = await runCrawl(fixtureInput(raw), makeDeps(dir, fake.actor(base), chooser));
    expect(summary.status).toBe("succeeded");
    expect(summary.items).toBe(25);
    expect(fake.calls).toEqual([]);
    expect(summary.charges).toEqual(zeroCounts());
    // one template: the summary names the scraper to pin next time
    const templateKey = [...groupByTemplate(raw.startUrls).keys()][0]!;
    expect(summary.scriptId).toBe(cacheKey(templateKey, { description: raw.description, fields: raw.fields.map((f) => f.name), profile: "store" }));
  });

  it("a budget that cannot afford actor-start ends charge_limit before the browser opens", async () => {
    const base = makeActor(dir);
    const fake = new FakeCharging(UNIT_PRICES, 0);
    const chooser = new RecordedChooser({ fixture: "crawler/empty" });
    const raw = { startUrls: [`${server.baseUrl}/fixtures/python-jobs.html`], mode: "list", fields: F("title"), description: "python job listing" };
    const summary = await runCrawl(fixtureInput(raw), makeDeps(dir, fake.actor(base), chooser));
    expect(summary.status).toBe("charge_limit");
    expect(summary.pages).toBe(0);
    expect(summary.requests).toEqual({ compile: 0, list: 0, record: 0 });
    expect(summary.charges).toEqual(zeroCounts());
  });

  it("the page-scraped check gates the next page: a budget for one page ends charge_limit with that page's items kept", async () => {
    const base = makeActor(dir);
    // 1 actor-start + 1 scraper-compiled + 1 page-scraped, unlimited items: the second product page cannot be charged
    const fake = new FakeCharging({ ...UNIT_PRICES, "result-item": 0 }, 3);
    const chooser = new RecordedChooser({ fixture: "compile/pharmacy-v1" });
    const raw = { startUrls: productUrls(), mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
    const summary = await runCrawl(fixtureInput(raw), makeDeps(dir, fake.actor(base), chooser, { maxConcurrency: 1 }));
    expect(summary.status).toBe("charge_limit");
    expect(summary.pages).toBe(1);
    expect(summary.items).toBe(1);
    expect(summary.charges["page-scraped"]).toBe(1);
    expect(await datasetItems(base)).toHaveLength(1);
  });
});
