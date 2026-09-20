import http from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actor } from "apify";
import { MemoryStorage } from "crawlee";
import { chromium, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCrawleeLaunchContext, profileDir } from "../src/browser/launch.js";
import type { Answer, Chooser, ChooserUsage, Question } from "../src/chooser/chooser.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { parseInput, type RunInput } from "../src/input/schema.js";
import { loadListSources, makeRequestGuard, runCrawl, type CrawlDeps } from "../src/replay/crawler.js";
import { ScraperStore } from "../src/scraper/store.js";
import { SCRAPER_VERSION, cacheKey, type CompiledScraper, type TraceStep } from "../src/scraper/schema.js";
import { groupByTemplate } from "../src/template/index.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

let server: FixtureServer;
let dir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), "navvi-crawler-"));
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const PRODUCTS = [
  "amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema", "diclofenaco-gel", "ibuprofeno-400-mg", "loratadina-10-mg",
  "losartan-50-mg", "metformina-850-mg", "omeprazol-20-mg", "paracetamol-500-mg", "salbutamol-inhalador", "vitamina-c-1-g",
];
const productUrls = () => PRODUCTS.map((s) => `${server.baseUrl}/demo/pharmacy-v1/producto/${s}.html`);
const F = (...names: string[]) => names.map((name) => ({ name }));

/** One isolated Actor per test: in-memory storage, nothing under ./storage. */
function makeActor(): Actor {
  return new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false }) });
}

function makeDeps(actor: Actor, chooser: Chooser, over: Partial<CrawlDeps> = {}): CrawlDeps {
  return { actor, chooser, env: {}, storageDir: join(dir, "st"), attended: false, maxConcurrency: 2, ...over };
}

function input(over: Record<string, unknown>): RunInput {
  return parseInput({ browser: "chromium", allowPrivateHosts: ["127.0.0.1"], ...over });
}

/** Picks the recorded fixture by the sample URL in the question state, so one run can compile two templates. */
class RoutingChooser implements Chooser {
  readonly name = "recorded" as const;
  private readonly inner = new Map<string, RecordedChooser>();
  constructor(private readonly routes: Array<[string, string]>) {}
  async ask(batch: Question[]): Promise<Answer[]> {
    const state = batch[0]?.state ?? "";
    const route = this.routes.find(([needle]) => state.includes(needle));
    if (!route) throw new Error(`no recorded fixture routes to a batch whose state starts with ${state.slice(0, 80)}`);
    let chooser = this.inner.get(route[1]);
    if (!chooser) this.inner.set(route[1], (chooser = new RecordedChooser({ fixture: route[1] })));
    return chooser.ask(batch);
  }
  usage(): ChooserUsage {
    const all = [...this.inner.values()].map((c) => c.usage());
    const sum = (k: "questions" | "textQuestions" | "batches" | "inputTokens" | "outputTokens" | "waitMs" | "costUsd") => all.reduce((n, u) => n + u[k], 0);
    return { chooser: "recorded", questions: sum("questions"), textQuestions: sum("textQuestions"), batches: sum("batches"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), waitMs: sum("waitMs"), costUsd: sum("costUsd"), zeroDataRetention: "not_applicable" };
  }
}

async function datasetItems(actor: Actor): Promise<Array<Record<string, unknown>>> {
  const dataset = await actor.openDataset();
  return (await dataset.getData()).items as Array<Record<string, unknown>>;
}

/** A tiny server in the test: a JSON list source and a page with a subresource on a private port. */
function startHelperServer(routes: Record<string, { type: string; body: string }>): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const route = routes[new URL(req.url ?? "/", "http://127.0.0.1").pathname];
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": route.type });
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

function seeded(over: Partial<CompiledScraper> & { templateKey: string; cacheKey: string }): CompiledScraper {
  return {
    version: SCRAPER_VERSION,
    profile: "store",
    chooser: "agent",
    mode: "list",
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

describe("launch context (KTD4)", () => {
  it("camoufox sets useFingerprints false with the firefox launcher; chromium sets it true", async () => {
    // Building the Camoufox context reads the fetched browser's version file; CI installs only Chromium.
    let camoufox: Awaited<ReturnType<typeof buildCrawleeLaunchContext>> | null = null;
    try {
      camoufox = await buildCrawleeLaunchContext({ browser: "camoufox", headed: false, storageDir: dir, profileDomain: "example.com", profileName: "store" });
    } catch (error) {
      if (!/camoufox fetch/i.test(String(error))) throw error;
      console.warn("camoufox not installed here; skipping the camoufox half of the launch-context test");
    }
    if (camoufox) {
      expect(camoufox.browserPoolOptions.useFingerprints).toBe(false);
      expect(camoufox.launchContext.launcher?.name()).toBe("firefox");
      expect(camoufox.launchContext.userDataDir).toBe(profileDir({ browser: "camoufox", headed: false, storageDir: dir, profileDomain: "example.com", profileName: "store" }));
      expect(camoufox.launchContext.launchOptions?.headless).toBe(true);
    }

    const chrome = await buildCrawleeLaunchContext({ browser: "chromium", headed: true });
    expect(chrome.browserPoolOptions.useFingerprints).toBe(true);
    expect(chrome.launchContext.launcher?.name()).toBe("chromium");
    expect(chrome.launchContext.userDataDir).toBeUndefined();
    expect(chrome.launchContext.launchOptions?.headless).toBe(false);
  });
});

describe("request guard (R26)", () => {
  it("allows the fixture host only on the ports the run was given; refuses other private hosts and ports", () => {
    const guard = makeRequestGuard(["127.0.0.1"], [`${server.baseUrl}/fixtures/redirect-private.html`]);
    expect(guard(`${server.baseUrl}/fixtures/python-jobs.html`)).toBe(true);
    expect(guard("http://127.0.0.1:9/")).toBe(false);
    expect(guard("http://localhost:9222/json")).toBe(false);
    expect(guard("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(guard("https://example.org/a")).toBe(true);
    expect(guard("data:text/plain,x")).toBe(true);
    expect(guard("file:///etc/passwd")).toBe(false);
  });
});

describe("list sources (R34)", () => {
  it("expands a JSON or plain-text URL list and policy-checks every entry", async () => {
    const helper = await startHelperServer({
      "/urls.json": { type: "application/json", body: JSON.stringify(["https://example.org/a", { url: "https://example.org/b" }, "http://10.0.0.5/private"]) },
      "/urls.txt": { type: "text/plain; charset=utf-8", body: "# comment\nhttps://example.org/c\n\nhttps://example.org/d\nftp://example.org/e\n" },
    });
    try {
      const urls = await loadListSources([`${helper.baseUrl}/urls.json`, `${helper.baseUrl}/urls.txt`, "https://example.org/page.html"], [], ["127.0.0.1"]);
      expect(urls).toEqual(["https://example.org/a", "https://example.org/b", "https://example.org/c", "https://example.org/d", "https://example.org/page.html"]);
    } finally {
      await helper.close();
    }
  });
});

describe("crawler runs", () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
  afterEach(() => {
    for (const s of consoleSpies.splice(0)) s.mockRestore();
  });

  it("compiles python-jobs once, runs one direct list request and stores the scraper", async () => {
    const actor = makeActor();
    const chooser = new RecordedChooser({ fixture: "compile/python-jobs" });
    const raw = { startUrls: [`${server.baseUrl}/fixtures/python-jobs.html`], mode: "list", fields: F("title", "company", "location", "date", "link"), description: "python job listing" };
    const observed: string[] = [];
    const onPage = async (page: import("playwright").Page) => { observed.push(page.url()); };
    const summary = await runCrawl(input(raw), { ...makeDeps(actor, chooser), onPage });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((url) => url === "about:blank")).toBe(true);
    const observedBeforeReplay = observed.length;
    expect(summary.status).toBe("succeeded");
    expect(summary.templates).toBe(1);
    expect(summary.cacheHit).toBe(false);
    expect(summary.requests).toEqual({ compile: 1, list: 1, record: 0 });
    expect(summary.traceReplays).toBe(0);
    expect(summary.items).toBe(25);
    expect(summary.pages).toBe(1);
    expect(summary.chooser?.questions).toBe(7);

    const items = await datasetItems(actor);
    expect(items).toHaveLength(25);
    for (const item of items) {
      expect(item.link).toMatch(new RegExp(`^${server.baseUrl}/fixtures/jobs/\\d+\\.html$`));
      expect(item._source).toBe(`${server.baseUrl}/fixtures/python-jobs.html`);
    }

    const store = await ScraperStore.open({ actor });
    const key = keyFor(raw.startUrls, { description: raw.description, fields: raw.fields.map((f) => f.name), profile: "store" });
    const stored = await store.get(key.cacheKey);
    expect(stored?.entry.mode).toBe("direct");
    expect(stored?.mode).toBe("list");

    // second run, same store: no chooser call, cache hit
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const again = await runCrawl(input(raw), { ...makeDeps(actor, empty), onPage });
    expect(observed.length).toBeGreaterThan(observedBeforeReplay);
    expect(again.cacheHit).toBe(true);
    expect(again.status).toBe("succeeded");
    expect(again.items).toBe(25);
    expect(again.requests).toEqual({ compile: 0, list: 1, record: 0 });
    expect(empty.usage().questions).toBe(0);
  }, 40_000);

  it("AE12: a JSON list source of twelve product URLs compiles once and records twelve items", async () => {
    const helper = await startHelperServer({ "/products.json": { type: "application/json", body: JSON.stringify(productUrls()) } });
    try {
      const actor = makeActor();
      const chooser = new RecordedChooser({ fixture: "compile/pharmacy-v1" });
      const raw = { startUrls: [`${helper.baseUrl}/products.json`], mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
      const summary = await runCrawl(input(raw), makeDeps(actor, chooser));
      expect(summary.status).toBe("succeeded");
      expect(summary.requests).toEqual({ compile: 1, list: 0, record: 12 });
      expect(summary.templates).toBe(1);
      expect(summary.items).toBe(12);
      const items = await datasetItems(actor);
      expect(items).toHaveLength(12);
      for (const item of items) {
        for (const name of ["name", "laboratory", "price", "stock"]) expect(item[name], name).not.toBeNull();
        expect(item.price).toMatch(/^\$ [\d.]+$/);
      }
      expect(new Set(items.map((i) => i._source)).size).toBe(12);
    } finally {
      await helper.close();
    }
  }, 40_000);

  it("two templates produce two compile requests and two stored scrapers", async () => {
    const actor = makeActor();
    const chooser = new RoutingChooser([
      ["/demo/pharmacy-v1/", "compile/pharmacy-v1"],
      ["/fixtures/python-jobs", "crawler/python-jobs-record"],
    ]);
    const urls = [...productUrls(), `${server.baseUrl}/fixtures/python-jobs.html`];
    const raw = { startUrls: urls, mode: "record", fields: F("name", "laboratory", "price", "stock"), description: "pharmacy product" };
    const summary = await runCrawl(input(raw), makeDeps(actor, chooser));
    expect(summary.templates).toBe(2);
    expect(summary.requests.compile).toBe(2);
    expect(summary.requests.record).toBe(13);
    expect(summary.fieldsNotFound).toEqual(["laboratory", "price", "stock"]);
    const store = await ScraperStore.open({ actor });
    const fields = raw.fields.map((f) => f.name);
    let stored = 0;
    for (const templateKey of groupByTemplate(urls).keys()) {
      const doc = await store.get(cacheKey(templateKey, { description: raw.description, fields, profile: "store" }));
      if (doc) stored += 1;
    }
    expect(stored).toBe(2);
    expect(summary.items).toBe(13);
  }, 60_000);

  it("waits for hydrated compiled rows before declaring a cached list empty", async () => {
    const delayed = await startHelperServer({ "/jobs": { type: "text/html", body: `<h1>Jobs</h1><ul id="jobs"><li class="placeholder">Loading</li></ul><script>setTimeout(() => document.querySelector('#jobs').innerHTML = '<li class="result"><b>Python engineer</b></li>', 900)</script>` } });
    try {
      const actor = makeActor();
      const startUrls = [`${delayed.baseUrl}/jobs`];
      const store = await ScraperStore.open({ actor });
      await store.put(seeded({
        ...keyFor(startUrls, { fields: ["title"], profile: "store" }),
        entry: { mode: "direct", url: startUrls[0]! },
        item: { anchorSelector: "li.result", span: 1 },
        fields: { title: { alternatives: [{ selector: "b", fingerprint: { samples: ["Python engineer"], shape: "text" } }] } },
      }));
      const chooser = new RecordedChooser({ fixture: "crawler/empty" });
      const summary = await runCrawl(input({ startUrls, mode: "list", fields: F("title"), maxPages: 1 }), makeDeps(actor, chooser));
      expect(summary.status).toBe("succeeded");
      expect(summary.cacheHit).toBe(true);
      expect(summary.items).toBe(1);
      expect((await datasetItems(actor))[0]).toMatchObject({ title: "Python engineer" });
      expect(chooser.usage().questions).toBe(0);
    } finally { await delayed.close(); }
  }, 20_000);

  it("trace mode replays the trace once per session and start URL, and paginates in-page", async () => {
    const actor = makeActor();
    // two start URLs of one template, both the search form: each gets its own replay (R14)
    const startUrls = [`${server.baseUrl}/fixtures/search-form.html`, `${server.baseUrl}/fixtures/search-form.html?src=2`];
    const key = keyFor(startUrls, { fields: ["title", "company"], profile: "store" });
    const trace: TraceStep[] = [
      { op: "type", text: "python", alternatives: [{ role: "searchbox", name: "Search jobs", exact: true }] },
      {
        op: "click",
        alternatives: [{ role: "button", name: "Search", exact: true }],
        target: { form: { method: "get", action: "/fixtures/results.html" } },
        expect: { role: "heading", name: "Results for python" },
      },
    ];
    const store = await ScraperStore.open({ actor });
    await store.put(
      seeded({
        ...key,
        entry: { mode: "trace", url: startUrls[0]! },
        trace,
        item: { anchorSelector: "ul.results > li.result", span: 1 },
        fields: {
          title: { alternatives: [{ selector: "a", fingerprint: { samples: ["python role 1"], shape: "text" } }] },
          company: { alternatives: [{ selector: "span.company", fingerprint: { samples: ["Company 1"], shape: "text" } }] },
        },
      }),
    );
    const chooser = new RecordedChooser({ fixture: "crawler/empty" });
    const summary = await runCrawl(input({ startUrls, mode: "list", fields: F("title", "company") }), makeDeps(actor, chooser));
    expect(summary.status).toBe("succeeded");
    expect(summary.cacheHit).toBe(true);
    expect(summary.traceReplays).toBe(2);
    expect(summary.requests).toEqual({ compile: 0, list: 2, record: 0 });
    expect(summary.pages).toBe(2);
    expect(summary.items).toBe(12);
    const items = await datasetItems(actor);
    expect(items.filter((i) => i._source === `${server.baseUrl}/fixtures/results.html?q=python`)).toHaveLength(12);
    expect(items[0]).toMatchObject({ title: "python role 1", company: "Company 1" });
    expect(items[6]).toMatchObject({ title: "python role 1", company: "Company 1" });
  }, 40_000);

  it("direct entry after a goal: the list request opens the compiled entry URL (the navigated listing), not the start URL", async () => {
    const actor = makeActor();
    const startUrls = [`${server.baseUrl}/fixtures/search-form.html`];
    const listing = `${server.baseUrl}/fixtures/results.html?q=python`;
    const goal = "search for python jobs";
    const key = keyFor(startUrls, { goal, fields: ["title", "company"], profile: "store" });
    const store = await ScraperStore.open({ actor });
    await store.put(
      seeded({
        ...key,
        entry: { mode: "direct", url: listing },
        trace: [
          { op: "type", text: "python", alternatives: [{ role: "searchbox", name: "Search jobs", exact: true }] },
          { op: "click", alternatives: [{ role: "button", name: "Search", exact: true }], target: { form: { method: "get", action: "/fixtures/results.html" } } },
        ],
        item: { anchorSelector: "ul.results > li.result", span: 1 },
        fields: {
          title: { alternatives: [{ selector: "a", fingerprint: { samples: ["python role 1"], shape: "text" } }] },
          company: { alternatives: [{ selector: "span.company", fingerprint: { samples: ["Company 1"], shape: "text" } }] },
        },
      }),
    );
    const chooser = new RecordedChooser({ fixture: "crawler/empty" });
    const summary = await runCrawl(input({ startUrls, goal, mode: "list", fields: F("title", "company") }), makeDeps(actor, chooser));
    expect(summary.status).toBe("succeeded");
    expect(summary.cacheHit).toBe(true);
    expect(summary.traceReplays).toBe(0);
    expect(summary.requests).toEqual({ compile: 0, list: 1, record: 0 });
    expect(summary.items).toBe(6);
    const items = await datasetItems(actor);
    expect(items.map((i) => i._source)).toEqual(Array<string>(6).fill(listing));
    expect(items[0]).toMatchObject({ title: "python role 1", company: "Company 1" });
    expect(chooser.usage().questions).toBe(0);
  }, 40_000);

  it("AE11: a cached click whose recorded href is off-domain is refused and the run ends blocked_no_progress", async () => {
    const actor = makeActor();
    const startUrls = [`${server.baseUrl}/fixtures/search-form.html`];
    const key = keyFor(startUrls, { fields: ["title"], profile: "store" });
    const store = await ScraperStore.open({ actor });
    await store.put(
      seeded({
        ...key,
        entry: { mode: "trace", url: startUrls[0]! },
        trace: [{ op: "click", alternatives: [{ role: "link", name: "Browse all jobs", exact: true }], target: { href: "http://evil.example/" } }],
        item: { anchorSelector: "ul.jobs > li.job", span: 1 },
        fields: { title: { alternatives: [{ selector: "h2", fingerprint: { samples: ["x"], shape: "text" } }] } },
      }),
    );
    const summary = await runCrawl(input({ startUrls, mode: "list", fields: F("title") }), makeDeps(actor, new RecordedChooser({ fixture: "crawler/empty" })));
    expect(summary.status).toBe("blocked_no_progress");
    expect(summary.message).toMatch(/evil\.example/);
    expect(summary.items).toBe(0);
    expect(summary.traceReplays).toBe(1);
  }, 40_000);

  it("the route guard aborts a subresource on a private port while the fixture host passes", async () => {
    const helper = await startHelperServer({
      "/tools.html": { type: "text/html; charset=utf-8", body: `<!doctype html><title>Tools</title><h1 id="h">Internal tools</h1><img src="http://127.0.0.1:9/x.png" alt=""><p><a href="${server.baseUrl}/fixtures/redirect-private.html">Fixture</a></p>` },
    });
    try {
      const actor = makeActor();
      const startUrls = [`${helper.baseUrl}/tools.html`];
      const key = keyFor(startUrls, { fields: ["heading"], profile: "store" });
      const store = await ScraperStore.open({ actor });
      await store.put(
        seeded({
          ...key,
          mode: "record",
          entry: { mode: "direct", url: startUrls[0]! },
          fields: { heading: { alternatives: [{ selector: "h1", fingerprint: { samples: ["Internal tools"], shape: "text" } }] } },
        }),
      );
      const summary = await runCrawl(input({ startUrls, mode: "record", fields: F("heading") }), makeDeps(actor, new RecordedChooser({ fixture: "crawler/empty" })));
      expect(summary.status).toBe("succeeded");
      expect(summary.blockedRequests).toBe(1);
      expect((await datasetItems(actor))[0]).toMatchObject({ heading: "Internal tools" });
    } finally {
      await helper.close();
    }
  }, 40_000);

  it("two requests that open concurrently on one context both navigate behind the route guard (R26)", async () => {
    const blockedImg = `<img src="http://127.0.0.1:9/x.png" alt="">`;
    const helper = await startHelperServer({
      "/tools-1.html": { type: "text/html; charset=utf-8", body: `<!doctype html><title>One</title><h1>Internal tools one</h1>${blockedImg}` },
      "/tools-2.html": { type: "text/html; charset=utf-8", body: `<!doctype html><title>Two</title><h1>Internal tools two</h1>${blockedImg}` },
    });
    // the prototypes every crawler page and context share, for the spies below
    const probe = await chromium.launch();
    const probeContext = await probe.newContext();
    const contextProto = Object.getPrototypeOf(probeContext) as BrowserContext;
    const pageProto = Object.getPrototypeOf(await probeContext.newPage()) as Page;
    await probe.close();
    const guarded = new WeakSet<BrowserContext>();
    const gotos: Array<{ url: string; guarded: boolean }> = [];
    const originalRoute = contextProto.route;
    const routeSpy = vi.spyOn(contextProto, "route").mockImplementation(async function (this: BrowserContext, ...args: Parameters<BrowserContext["route"]>) {
      // a slow guard install: the second request must wait for it instead of navigating past it
      await new Promise((resolve) => setTimeout(resolve, 500));
      await originalRoute.apply(this, args);
      guarded.add(this);
    });
    const originalGoto = pageProto.goto;
    const gotoSpy = vi.spyOn(pageProto, "goto").mockImplementation(function (this: Page, ...args: Parameters<Page["goto"]>) {
      gotos.push({ url: args[0], guarded: guarded.has(this.context()) });
      return originalGoto.apply(this, args);
    });
    try {
      const actor = makeActor();
      const startUrls = [`${helper.baseUrl}/tools-1.html`, `${helper.baseUrl}/tools-2.html`];
      const key = keyFor(startUrls, { fields: ["heading"], profile: "store" });
      const store = await ScraperStore.open({ actor });
      await store.put(
        seeded({
          ...key,
          mode: "record",
          entry: { mode: "direct", url: startUrls[0]! },
          fields: { heading: { alternatives: [{ selector: "h1", fingerprint: { samples: ["Internal tools"], shape: "text" } }] } },
        }),
      );
      const summary = await runCrawl(
        input({ startUrls, mode: "record", fields: F("heading") }),
        makeDeps(actor, new RecordedChooser({ fixture: "crawler/empty" }), { maxConcurrency: 2, minConcurrency: 2 }),
      );
      expect(summary.status).toBe("succeeded");
      expect(summary.items).toBe(2);
      const crawled = gotos.filter((g) => g.url.startsWith(helper.baseUrl));
      expect(crawled).toHaveLength(2);
      expect(crawled.filter((g) => g.guarded)).toHaveLength(2);
      expect(summary.blockedRequests).toBe(2);
    } finally {
      routeSpy.mockRestore();
      gotoSpy.mockRestore();
      await helper.close();
    }
  }, 60_000);

  it("the summary's echoed input masks the credentials of a proxy URL as well as the secrets (R39)", async () => {
    const actor = makeActor();
    const store = await ScraperStore.open({ actor });
    const loginUrls = [`${server.baseUrl}/login/`];
    const key = keyFor(loginUrls, { fields: ["order"], profile: "local" });
    await store.put(
      seeded({
        ...key,
        profile: "local",
        entry: { mode: "trace", url: loginUrls[0]! },
        trace: [{ op: "type", secret: "password", alternatives: [{ role: "textbox", name: "Password", exact: true }] }],
        item: { anchorSelector: "li.order", span: 1 },
        fields: { order: { alternatives: [{ selector: "a", fingerprint: { samples: ["Order #1001"], shape: "text" } }] } },
      }),
    );
    const proxyUrls = ["http://proxy-user:hunter2-proxy@127.0.0.1:1", "http://127.0.0.1:2"];
    const summary = await runCrawl(
      input({ startUrls: loginUrls, mode: "list", fields: F("order"), profile: "local", proxy: { proxyUrls } }),
      makeDeps(actor, new RecordedChooser({ fixture: "crawler/empty" }), { storageDir: mkdtempSync(join(dir, "proxy-")), env: {} }),
    );
    expect(summary.status).toBe("blocked_login_required");
    expect(summary.input?.proxy?.proxyUrls).toHaveLength(2);
    expect(summary.input?.proxy?.proxyUrls?.[0]).not.toContain("hunter2-proxy");
    expect(summary.input?.proxy?.proxyUrls?.[0]).not.toContain("proxy-user");
    expect(summary.input?.proxy?.proxyUrls?.[0]).toMatch(/^http:\/\/.*127\.0\.0\.1:1\/?$/);
    expect(summary.input?.proxy?.proxyUrls?.[1]).toBe("http://127.0.0.1:2");
    expect(JSON.stringify(summary)).not.toContain("hunter2-proxy");
  });

  it("a login trace under local keeps its cookie in the profile for the next run, and freshProfile discards it", async () => {
    const actor = makeActor();
    const store = await ScraperStore.open({ actor });
    const loginUrls = [`${server.baseUrl}/login/`];
    const loginKey = keyFor(loginUrls, { fields: ["order", "total"], profile: "local" });
    await store.put(
      seeded({
        ...loginKey,
        profile: "local",
        entry: { mode: "trace", url: loginUrls[0]! },
        trace: [
          { op: "type", text: "max@example.com", alternatives: [{ role: "textbox", name: "Email", exact: true }] },
          { op: "type", secret: "password", alternatives: [{ role: "textbox", name: "Password", exact: true }] },
          { op: "click", alternatives: [{ role: "button", name: "Log in", exact: true }], target: { form: { method: "post", action: "/login" } }, expect: { role: "heading", name: "Orders" } },
        ],
        item: { anchorSelector: "ul.orders > li.order", span: 1 },
        fields: {
          order: { alternatives: [{ selector: "a", fingerprint: { samples: ["Order #1001"], shape: "text" } }] },
          total: { alternatives: [{ selector: "span.total", fingerprint: { samples: ["$ 45.990"], shape: "money" } }] },
        },
      }),
    );
    const accountUrls = [`${server.baseUrl}/login/account.html`];
    const accountKey = keyFor(accountUrls, { fields: ["who"], profile: "local" });
    await store.put(
      seeded({
        ...accountKey,
        profile: "local",
        mode: "record",
        entry: { mode: "direct", url: accountUrls[0]! },
        fields: { who: { alternatives: [{ selector: "#who", fingerprint: { samples: ["customer"], shape: "text" } }] } },
      }),
    );

    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      consoleSpies.push(vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))));
    }
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    });
    consoleSpies.push(stderr);

    const chooser = new RecordedChooser({ fixture: "crawler/empty" });
    const one = await runCrawl(input({ startUrls: loginUrls, mode: "list", fields: F("order", "total"), profile: "local" }), makeDeps(actor, chooser, { env: { NAVVI_SECRET_PASSWORD: "hunter2-secret" } }));
    expect(one.status).toBe("succeeded");
    expect(one.items).toBe(5);
    expect(one.traceReplays).toBe(1);
    expect(existsSync(join(dir, "st", "profiles", "127.0.0.1", "local"))).toBe(true);

    const two = await runCrawl(input({ startUrls: accountUrls, mode: "record", fields: F("who"), profile: "local", secrets: { password: "hunter2-input" } }), makeDeps(actor, chooser));
    expect(two.status).toBe("succeeded");
    expect(two.input?.secrets).toEqual({ password: "[secret]" });
    const afterTwo = await datasetItems(actor);
    expect(afterTwo.at(-1)).toMatchObject({ who: "customer", _source: accountUrls[0] });

    const three = await runCrawl(input({ startUrls: accountUrls, mode: "record", fields: F("who"), profile: "local", freshProfile: true }), makeDeps(actor, chooser));
    expect(three.status).toBe("drift");
    expect((await datasetItems(actor)).at(-1)).toMatchObject({ who: null });

    // the capture saw the crawler's own log lines, so a leak would have shown up here
    expect(logs.some((l) => /PlaywrightCrawler|Final request statistics/.test(l))).toBe(true);
    expect(logs.some((l) => l.includes("hunter2"))).toBe(false);
    expect(JSON.stringify([one, two, three])).not.toContain("hunter2");
  }, 60_000);

  it("a missing secret ends the run before the browser opens, naming the placeholder", async () => {
    const actor = makeActor();
    const store = await ScraperStore.open({ actor });
    const loginUrls = [`${server.baseUrl}/login/`];
    const key = keyFor(loginUrls, { fields: ["order"], profile: "local" });
    await store.put(
      seeded({
        ...key,
        profile: "local",
        entry: { mode: "trace", url: loginUrls[0]! },
        trace: [{ op: "type", secret: "password", alternatives: [{ role: "textbox", name: "Password", exact: true }] }],
        item: { anchorSelector: "li.order", span: 1 },
        fields: { order: { alternatives: [{ selector: "a", fingerprint: { samples: ["Order #1001"], shape: "text" } }] } },
      }),
    );
    const profiles = mkdtempSync(join(dir, "missing-"));
    const launchSpy = vi.spyOn(chromium, "launchPersistentContext");
    try {
      const summary = await runCrawl(input({ startUrls: loginUrls, mode: "list", fields: F("order"), profile: "local" }), makeDeps(actor, new RecordedChooser({ fixture: "crawler/empty" }), { storageDir: profiles, env: {} }));
      expect(summary.status).toBe("blocked_login_required");
      expect(summary.message).toMatch(/\{\{secret:password\}\}/);
      expect(summary.requests).toEqual({ compile: 0, list: 0, record: 0 });
      expect(launchSpy).not.toHaveBeenCalled();
      expect(existsSync(join(profiles, "profiles"))).toBe(false);
    } finally {
      launchSpy.mockRestore();
    }
  });
});
