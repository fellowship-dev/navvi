import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actor } from "apify";
import { MemoryStorage } from "crawlee";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelUnavailableError } from "../src/billing/budget.js";
import type { Answer, Chooser, ChooserUsage, Question } from "../src/chooser/chooser.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { LIMITS, parseInput, type RunInput } from "../src/input/schema.js";
import { runCrawl, type CrawlDeps, type HealerHook } from "../src/replay/crawler.js";
import { isFieldHealingEvent, isStepHealingEvent, type UnmappedCandidate } from "../src/replay/heal.js";
import { SCRAPER_VERSION, cacheKey, markHealed, type CompiledScraper, type TraceStep } from "../src/scraper/schema.js";
import { ScraperStore } from "../src/scraper/store.js";
import { groupByTemplate } from "../src/template/index.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U13 healing (R17, R19, R31, R32, R33, R42): AE8 is the MVP proof — the
 * pharmacy demo changes its markup under the same URLs and the cached scraper
 * heals by appending alternatives; AE15 heals a renamed trace step.
 */

let server: FixtureServer;
let dir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), "navvi-heal-"));
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  server.switchDemo("v1");
  server.switchLogin("normal");
});

const PRODUCTS = [
  "amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema", "diclofenaco-gel", "ibuprofeno-400-mg", "loratadina-10-mg",
  "losartan-50-mg", "metformina-850-mg", "omeprazol-20-mg", "paracetamol-500-mg", "salbutamol-inhalador", "vitamina-c-1-g",
];
const OUT_OF_STOCK = ["ibuprofeno-400-mg", "losartan-50-mg"];
/** The version-switched demo path: the same URLs serve v1 or v2 markup. */
const productUrls = () => PRODUCTS.map((s) => `${server.baseUrl}/demo/pharmacy/producto/${s}.html`);
const FIELDS = ["name", "laboratory", "price", "stock"];
const F = (...names: string[]) => names.map((name) => ({ name }));

function makeActor(): Actor {
  return new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false }) });
}

function makeDeps(actor: Actor, chooser: Chooser, over: Partial<CrawlDeps> = {}): CrawlDeps {
  return { actor, chooser, env: {}, storageDir: mkdtempSync(join(dir, "st-")), attended: false, maxConcurrency: 1, ...over };
}

function input(over: Record<string, unknown>): RunInput {
  return parseInput({ browser: "chromium", allowPrivateHosts: ["127.0.0.1"], ...over });
}

async function datasetItems(actor: Actor): Promise<Array<Record<string, unknown>>> {
  const dataset = await actor.openDataset();
  return (await dataset.getData()).items as Array<Record<string, unknown>>;
}

function seeded(over: Partial<CompiledScraper> & { templateKey: string; cacheKey: string }): CompiledScraper {
  return {
    version: SCRAPER_VERSION,
    profile: "store",
    chooser: "agent",
    mode: "record",
    entry: { mode: "direct", url: "" },
    trace: [],
    pagination: { mode: "none" },
    detail: null,
    createdAt: new Date().toISOString(),
    fields: {},
    ...over,
  };
}

function keyFor(urls: string[], input: { goal?: string; description?: string; fields: string[]; profile: "store" | "local" }): { templateKey: string; cacheKey: string } {
  const templateKey = [...groupByTemplate(urls).keys()][0]!;
  return { templateKey, cacheKey: cacheKey(templateKey, input) };
}

/** Records every batch and routes each to a recorded fixture chosen by a predicate over the batch. */
class RoutingSpy implements Chooser {
  readonly name = "recorded" as const;
  readonly batches: Question[][] = [];
  private readonly inner = new Map<string, RecordedChooser>();
  constructor(private readonly route: (batch: Question[]) => string) {}
  async ask(batch: Question[]): Promise<Answer[]> {
    this.batches.push(batch);
    const fixture = this.route(batch);
    let chooser = this.inner.get(fixture);
    if (!chooser) this.inner.set(fixture, (chooser = new RecordedChooser({ fixture })));
    return chooser.ask(batch);
  }
  usage(): ChooserUsage {
    const all = [...this.inner.values()].map((c) => c.usage());
    const sum = (k: "questions" | "textQuestions" | "batches" | "inputTokens" | "outputTokens" | "waitMs" | "costUsd") => all.reduce((n, u) => n + u[k], 0);
    return { chooser: "recorded", questions: sum("questions"), textQuestions: sum("textQuestions"), batches: sum("batches"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), waitMs: sum("waitMs"), costUsd: sum("costUsd"), zeroDataRetention: "not_applicable" };
  }
}

const isHealBatch = (batch: Question[]): boolean => batch.some((q) => q.id.startsWith("heal."));

describe("field healing (AE8, R17, R31, R32, R33)", () => {
  it("AE8: v2 markup under the same URLs heals one alternative per field in at most two batches; v1 still replays on the originals with no chooser call", async () => {
    const actor = makeActor();
    const urls = productUrls();
    const raw = { startUrls: urls, mode: "record", fields: F(...FIELDS), description: "pharmacy product" };
    // the out-of-stock pages offer no price candidate: the chooser answers none there
    const chooser = new RoutingSpy((batch) => (isHealBatch(batch) && batch.every((q) => q.id === "heal.price") ? "heal/pharmacy-nostock" : "heal/pharmacy"));

    server.switchDemo("v1");
    const first = await runCrawl(input(raw), makeDeps(actor, chooser));
    expect(first.status).toBe("succeeded");
    expect(first.cacheHit).toBe(false);
    expect(first.items).toBe(12);
    expect(first.healingEvents).toEqual([]);
    expect(chooser.batches.filter(isHealBatch)).toHaveLength(0);

    server.switchDemo("v2");
    const second = await runCrawl(input(raw), makeDeps(actor, chooser));
    expect(second.cacheHit).toBe(true);
    expect(second.status).toBe("succeeded");
    expect(second.items).toBe(12);
    expect(second.requests).toEqual({ compile: 0, list: 0, record: 12 });
    expect(second.healingEvents.length).toBeGreaterThanOrEqual(1);
    expect(second.healingEvents.every(isFieldHealingEvent)).toBe(true);
    const healBatches = chooser.batches.filter(isHealBatch);
    expect(healBatches.length).toBeGreaterThanOrEqual(1);
    expect(healBatches.length).toBeLessThanOrEqual(2);
    expect(healBatches[0]!.map((q) => q.id).sort()).toEqual(["heal.laboratory", "heal.name", "heal.price", "heal.stock"]);
    for (const q of healBatches[0]!) expect(q.options!.length).toBeGreaterThan(10);

    const rows = (await datasetItems(actor)).slice(12);
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      const slug = String(row._source).split("/").pop()!.replace(".html", "");
      expect(row.name, slug).not.toBeNull();
      expect(row.laboratory, slug).not.toBeNull();
      expect(row.stock, slug).not.toBeNull();
      if (OUT_OF_STOCK.includes(slug)) {
        expect(row.price, slug).toBeNull();
        expect(row.stock, slug).toBe("Agotado");
      } else {
        expect(row.price, slug).toMatch(/^\$ [\d.]+$/);
      }
    }
    const unmapped = second.unmappedCandidates as UnmappedCandidate[];
    const unmappedTexts = unmapped.map((c) => c.text);
    expect(unmappedTexts).toContain("Sin stock");
    expect(unmappedTexts).toContain("Precio oferta");
    for (const c of unmapped) expect(c.selector.length).toBeGreaterThan(0);

    const store = await ScraperStore.open({ actor });
    const key = keyFor(urls, { description: raw.description, fields: FIELDS, profile: "store" });
    const healed = await store.get(key.cacheKey);
    expect(healed).not.toBeNull();
    expect(Object.keys(healed!.fields)).toEqual(FIELDS);
    expect(healed!.healedAt).toBeDefined();
    for (const name of FIELDS) {
      expect(healed!.fields[name]!.alternatives, name).toHaveLength(2);
      expect(healed!.fields[name]!.alternatives[0]!.selector, name).toMatch(/producto|stock/);
    }
    expect(healed!.fields.price!.alternatives[1]!.fingerprint.shape).toBe("money");

    // third run on v1 again: the original alternatives resolve first, no chooser call
    server.switchDemo("v1");
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const third = await runCrawl(input(raw), makeDeps(actor, empty));
    expect(third.status).toBe("succeeded");
    expect(third.cacheHit).toBe(true);
    expect(third.items).toBe(12);
    expect(third.healingEvents).toEqual([]);
    expect(third.unhealed).toBe(0);
    expect(empty.usage().questions).toBe(0);
    const v1Rows = (await datasetItems(actor)).slice(24);
    expect(v1Rows).toHaveLength(12);
    for (const row of v1Rows) expect(row.price).toMatch(/^\$ [\d.]+$/);
  }, 60_000);

  it("a required field absent from the page with no candidate: the healer answers none, the record carries null and nothing is stored", async () => {
    const actor = makeActor();
    const urls = [`${server.baseUrl}/demo/pharmacy-v1/producto/paracetamol-500-mg.html`];
    const key = keyFor(urls, { fields: ["name", "isbn"], profile: "store" });
    const store = await ScraperStore.open({ actor });
    await store.put(
      seeded({
        ...key,
        entry: { mode: "direct", url: urls[0]! },
        fields: {
          name: { alternatives: [{ selector: "h1.producto-nombre", fingerprint: { samples: ["Paracetamol 500 mg x 16 comprimidos"], shape: "text" } }] },
          isbn: { alternatives: [{ selector: "span.isbn", fingerprint: { samples: ["978-3-16-148410-0"], shape: "text" } }] },
        },
      }),
    );
    const chooser = new RoutingSpy(() => "heal/pharmacy-isbn");
    const summary = await runCrawl(input({ startUrls: urls, mode: "record", fields: F("name", "isbn") }), makeDeps(actor, chooser));
    expect(summary.items).toBe(1);
    expect(summary.healingEvents).toEqual([]);
    expect(summary.unhealed).toBe(1);
    expect(chooser.batches).toHaveLength(1);
    expect(chooser.batches[0]!.map((q) => q.id)).toEqual(["heal.isbn"]);
    expect((await datasetItems(actor))[0]).toMatchObject({ name: "Paracetamol 500 mg x 16 comprimidos", isbn: null });
    const stored = await store.get(key.cacheKey);
    expect(stored?.healedAt).toBeUndefined();
    expect(stored?.fields.isbn?.alternatives).toHaveLength(1);
  }, 30_000);

  it("the healing budget: the sixth healing event ends the run with drift and the items so far in the dataset", async () => {
    const actor = makeActor();
    const urls = productUrls();
    const key = keyFor(urls, { fields: ["name", "price"], profile: "store" });
    const store = await ScraperStore.open({ actor });
    await store.put(
      seeded({
        ...key,
        entry: { mode: "direct", url: urls[0]! },
        fields: {
          name: { alternatives: [{ selector: "h1.producto-nombre", fingerprint: { samples: ["x"], shape: "text" } }] },
          price: { alternatives: [{ selector: "span.no-such-price", fingerprint: { samples: ["$ 1"], shape: "money" } }] },
        },
      }),
    );
    let calls = 0;
    // a healer that always "heals" without fixing anything: every page costs one event
    const healer: HealerHook = async ({ scraper }) => {
      calls += 1;
      return { healed: true, scraper: markHealed(scraper), event: { kind: "field", fields: ["price"], at: new Date().toISOString() } };
    };
    const summary = await runCrawl(input({ startUrls: urls, mode: "record", fields: F("name", "price") }), makeDeps(actor, new RecordedChooser({ fixture: "crawler/empty" }), { healer }));
    expect(summary.status).toBe("drift");
    expect(summary.message).toMatch(/healing/i);
    expect(summary.healingEvents).toHaveLength(LIMITS.healingEvents);
    expect(calls).toBe(LIMITS.healingEvents + 1);
    expect(summary.items).toBe(LIMITS.healingEvents);
    expect(await datasetItems(actor)).toHaveLength(LIMITS.healingEvents);
  }, 40_000);

  it("R19: a chooser error during healing logs a warning, counts the page unhealed and the crawl goes on", async () => {
    const actor = makeActor();
    const urls = productUrls().slice(0, 3);
    const key = keyFor(urls, { fields: ["name", "price"], profile: "store" });
    const store = await ScraperStore.open({ actor });
    await store.put(
      seeded({
        ...key,
        entry: { mode: "direct", url: urls[0]! },
        fields: {
          name: { alternatives: [{ selector: "h1.producto-nombre", fingerprint: { samples: ["x"], shape: "text" } }] },
          price: { alternatives: [{ selector: "span.no-such-price", fingerprint: { samples: ["$ 1"], shape: "money" } }] },
        },
      }),
    );
    const down: Chooser = {
      name: "recorded",
      async ask(batch) {
        if (isHealBatch(batch)) throw new ModelUnavailableError("chooser down during healing");
        return batch.map((q) => ({ id: q.id, index: null }));
      },
      usage: () => ({ chooser: "recorded", questions: 0, textQuestions: 0, batches: 0, inputTokens: 0, outputTokens: 0, waitMs: 0, costUsd: 0, zeroDataRetention: "not_applicable" }),
    };
    const logs: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    });
    try {
      const summary = await runCrawl(input({ startUrls: urls, mode: "record", fields: F("name", "price") }), makeDeps(actor, down));
      expect(summary.requests.record).toBe(3);
      expect(summary.items).toBe(3);
      expect(summary.unhealed).toBe(3);
      expect(summary.healingEvents).toEqual([]);
      expect(summary.status).not.toBe("model_unavailable");
      expect(logs.some((l) => /healing skipped/i.test(l) && /chooser down/.test(l))).toBe(true);
      for (const row of await datasetItems(actor)) expect(row).toMatchObject({ price: null });
      expect((await datasetItems(actor))[0]!.name).not.toBeNull();
    } finally {
      stderr.mockRestore();
    }
  }, 30_000);
});

describe("step healing (AE15, R42)", () => {
  const loginTrace: TraceStep[] = [
    { op: "type", text: "max@example.com", alternatives: [{ role: "textbox", name: "Email", exact: true }] },
    { op: "type", secret: "password", alternatives: [{ role: "textbox", name: "Password", exact: true }] },
    { op: "click", alternatives: [{ role: "button", name: "Log in", exact: true }], target: { form: { method: "post", action: "/login" } }, expect: { role: "heading", name: "Orders" } },
  ];

  it("AE15: a renamed login button is re-decided with the chooser, the locator is appended and the original still works", async () => {
    const actor = makeActor();
    const store = await ScraperStore.open({ actor });
    const loginUrls = [`${server.baseUrl}/login/`];
    const key = keyFor(loginUrls, { fields: ["order", "total"], profile: "local" });
    await store.put(
      seeded({
        ...key,
        profile: "local",
        mode: "list",
        entry: { mode: "trace", url: loginUrls[0]! },
        trace: loginTrace,
        item: { anchorSelector: "ul.orders > li.order", span: 1 },
        fields: {
          order: { alternatives: [{ selector: "a", fingerprint: { samples: ["Order #1001"], shape: "text" } }] },
          total: { alternatives: [{ selector: "span.total", fingerprint: { samples: ["$ 45.990"], shape: "money" } }] },
        },
      }),
    );
    const storageDir = mkdtempSync(join(dir, "login-"));
    const env = { NAVVI_SECRET_PASSWORD: "hunter2-secret" };

    server.switchLogin("renamed");
    const chooser = new RoutingSpy(() => "heal/login");
    const healedRun = await runCrawl(input({ startUrls: loginUrls, mode: "list", fields: F("order", "total"), profile: "local" }), makeDeps(actor, chooser, { env, storageDir }));
    expect(healedRun.status).toBe("succeeded");
    expect(healedRun.items).toBe(5);
    expect(healedRun.traceReplays).toBe(1);
    expect(healedRun.healingEvents).toHaveLength(1);
    const event = healedRun.healingEvents[0];
    expect(isStepHealingEvent(event)).toBe(true);
    if (isStepHealingEvent(event)) expect(event.stepIndex).toBe(2);
    expect(chooser.batches).toHaveLength(1);
    expect(chooser.batches[0]!.map((q) => q.id)).toEqual(["heal.step.2"]);
    expect(chooser.batches[0]![0]!.options!.some((o) => o.includes("Sign in"))).toBe(true);
    // text inputs never fit a click step: the password field is not offered
    expect(chooser.batches[0]![0]!.options!.every((o) => !o.startsWith("textbox"))).toBe(true);
    expect(chooser.batches[0]![0]!.premise).toContain("Log in");
    expect(JSON.stringify(chooser.batches)).not.toContain("hunter2");

    const stored = await store.get(key.cacheKey);
    expect(stored?.healedAt).toBeDefined();
    expect(stored?.trace[2]!.alternatives).toEqual([
      { role: "button", name: "Log in", exact: true },
      { role: "button", name: "Sign in", exact: true },
    ]);
    expect(stored?.trace.map((s) => s.op)).toEqual(["type", "type", "click"]);

    server.switchLogin("normal");
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const normalRun = await runCrawl(input({ startUrls: loginUrls, mode: "list", fields: F("order", "total"), profile: "local" }), makeDeps(actor, empty, { env, storageDir }));
    expect(normalRun.status).toBe("succeeded");
    expect(normalRun.items).toBe(5);
    expect(normalRun.healingEvents).toEqual([]);
    expect(empty.usage().questions).toBe(0);
    expect(await datasetItems(actor)).toHaveLength(10);
  }, 45_000);
});
