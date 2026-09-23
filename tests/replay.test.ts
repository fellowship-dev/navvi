import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actor } from "apify";
import { MemoryStorage } from "crawlee";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import type { Chooser } from "../src/chooser/chooser.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { parseInput, type RunInput } from "../src/input/schema.js";
import { urlPatternFor } from "../src/navigate/trace.js";
import { runCrawl, type CrawlDeps } from "../src/replay/crawler.js";
import { replayTrace, resolveLocator, type ReplayPolicy } from "../src/replay/entry.js";
import { SCRAPER_VERSION, cacheKey, type CompiledScraper, type TraceStep } from "../src/scraper/schema.js";
import { ScraperStore } from "../src/scraper/store.js";
import { Secret } from "../src/secrets/resolve.js";
import { groupByTemplate } from "../src/template/index.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U13 replay (R15, R16, R18): pagination by next link and by scroll, dedupe
 * across pages, the two-empty-pages stop, and detail pages merged into list
 * items. Every run here replays a seeded scraper: no chooser call, except the
 * detail compile.
 */

let server: FixtureServer;
let dir: string;
let browser: LaunchedBrowser;

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), "navvi-replay-"));
  browser = await launch({ browser: "chromium", headed: false });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const F = (...names: string[]) => names.map((name) => ({ name }));

function makeActor(): Actor {
  return new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false }) });
}

function makeDeps(actor: Actor, chooser: Chooser = new RecordedChooser({ fixture: "crawler/empty" }), over: Partial<CrawlDeps> = {}): CrawlDeps {
  return { actor, chooser, env: {}, storageDir: join(dir, "st"), attended: false, maxConcurrency: 1, ...over };
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

const JOB_FIELDS = ["title", "company", "link"];

/** A list scraper for the paginated python-jobs-N fixtures. */
async function seedJobs(actor: Actor, urls: string[]): Promise<void> {
  const store = await ScraperStore.open({ actor });
  await store.put(
    seeded({
      ...keyFor(urls, { fields: JOB_FIELDS, profile: "store" }),
      entry: { mode: "direct", url: urls[0]! },
      item: { anchorSelector: "ul.jobs > li.job", span: 1 },
      pagination: { mode: "next_link", locator: [{ role: "link", name: "Next", exact: true }] },
      fields: {
        title: { alternatives: [{ selector: "h2.job-title > a", fingerprint: { samples: ["Senior Python Engineer II"], shape: "text" } }] },
        company: { alternatives: [{ selector: "span.company", fingerprint: { samples: ["Anaconda"], shape: "text" } }] },
        link: { alternatives: [{ selector: "h2.job-title > a", attr: "href", fingerprint: { samples: [`${server.baseUrl}/fixtures/jobs/100.html`], shape: "url" } }] },
      },
    }),
  );
}

describe("pagination (R15)", () => {
  it("AE9: scroll pagination treats each growth of the item container as a page and stops when the feed stops growing", async () => {
    const actor = makeActor();
    const urls = [`${server.baseUrl}/fixtures/infinite-scroll.html`];
    const store = await ScraperStore.open({ actor });
    await store.put(
      seeded({
        ...keyFor(urls, { fields: ["title", "likes"], profile: "store" }),
        entry: { mode: "direct", url: urls[0]! },
        item: { anchorSelector: "#feed > li.post", span: 1 },
        pagination: { mode: "scroll" },
        fields: {
          title: { alternatives: [{ selector: "a", fingerprint: { samples: ["Post 1"], shape: "text" } }] },
          likes: { alternatives: [{ selector: "span.likes", fingerprint: { samples: ["7 likes"], shape: "text" } }] },
        },
      }),
    );
    const chooser = new RecordedChooser({ fixture: "crawler/empty" });
    const summary = await runCrawl(input({ startUrls: urls, mode: "list", fields: F("title", "likes") }), makeDeps(actor, chooser));
    expect(summary.status).toBe("succeeded");
    expect(summary.pages).toBe(4);
    expect(summary.items).toBe(40);
    expect(summary.requests).toEqual({ compile: 0, list: 1, record: 0 });
    expect(chooser.usage().questions).toBe(0);
    const items = await datasetItems(actor);
    expect(items).toHaveLength(40);
    expect(new Set(items.map((i) => i.title)).size).toBe(40);
    expect(items[39]).toMatchObject({ title: "Post 40", likes: "280 likes" });

    const capped = await runCrawl(input({ startUrls: urls, mode: "list", fields: F("title", "likes"), maxPages: 2 }), makeDeps(makeActor(), chooser, { store }));
    expect(capped.pages).toBe(2);
    expect(capped.items).toBe(20);
  });

  it("a compiled next link crawls three pages and stops at maxPages; a lower maxPages stops earlier", async () => {
    const actor = makeActor();
    const urls = [`${server.baseUrl}/fixtures/python-jobs-1.html`];
    await seedJobs(actor, urls);
    const three = await runCrawl(input({ startUrls: urls, mode: "list", fields: F(...JOB_FIELDS), maxPages: 3 }), makeDeps(actor));
    expect(three.status).toBe("succeeded");
    expect(three.pages).toBe(3);
    // page 2 repeats one row of page 1 (R16): 5 + 4 + 5
    expect(three.items).toBe(14);
    const items = await datasetItems(actor);
    expect(items).toHaveLength(14);
    expect(items.filter((i) => i.title === "ML Engineer")).toHaveLength(1);
    expect(items.map((i) => i._source)).toEqual([
      ...Array<string>(5).fill(`${server.baseUrl}/fixtures/python-jobs-1.html`),
      ...Array<string>(4).fill(`${server.baseUrl}/fixtures/python-jobs-2.html`),
      ...Array<string>(5).fill(`${server.baseUrl}/fixtures/python-jobs-3.html`),
    ]);
    expect(items[13]).toMatchObject({ title: "Python Tooling Engineer", company: "Astral", link: `${server.baseUrl}/fixtures/jobs/113.html` });

    const two = await runCrawl(input({ startUrls: urls, mode: "list", fields: F(...JOB_FIELDS), maxPages: 2 }), makeDeps(makeActor(), undefined, { store: await ScraperStore.open({ actor }) }));
    expect(two.pages).toBe(2);
    expect(two.items).toBe(9);
  });

  it("two consecutive empty pages end a list crawl with succeeded even though the next links keep going (R16)", async () => {
    const actor = makeActor();
    const urls = [`${server.baseUrl}/fixtures/python-jobs-1.html`];
    await seedJobs(actor, urls);
    const summary = await runCrawl(input({ startUrls: urls, mode: "list", fields: F(...JOB_FIELDS), maxPages: 10 }), makeDeps(actor));
    expect(summary.status).toBe("succeeded");
    expect(summary.items).toBe(14);
    expect(summary.pages).toBe(5);
    expect(summary.unhealed).toBe(0);
  });

  it("a next link that reproduces the same listing ends pagination (the original python-jobs fixture)", async () => {
    const actor = makeActor();
    const urls = [`${server.baseUrl}/fixtures/python-jobs.html`];
    await seedJobs(actor, urls);
    const summary = await runCrawl(input({ startUrls: urls, mode: "list", fields: F(...JOB_FIELDS) }), makeDeps(actor));
    expect(summary.status).toBe("succeeded");
    expect(summary.pages).toBe(1);
    expect(summary.items).toBe(25);
  });
});

describe("dedupe (R16)", () => {
  it("duplicate start URLs in record mode are fetched once", async () => {
    const actor = makeActor();
    const url = `${server.baseUrl}/demo/pharmacy-v1/producto/paracetamol-500-mg.html`;
    const store = await ScraperStore.open({ actor });
    await store.put(
      seeded({
        ...keyFor([url], { fields: ["name"], profile: "store" }),
        mode: "record",
        entry: { mode: "direct", url },
        fields: { name: { alternatives: [{ selector: "h1.producto-nombre", fingerprint: { samples: ["x"], shape: "text" } }] } },
      }),
    );
    const summary = await runCrawl(input({ startUrls: [url, url, `${url}`], mode: "record", fields: F("name") }), makeDeps(actor));
    expect(summary.requests.record).toBe(1);
    expect(summary.items).toBe(1);
    expect(await datasetItems(actor)).toHaveLength(1);
  });
});

describe("detail pages (R18)", () => {
  it("compiles a detail template from three detail pages, merges the fields into the list items and counts each detail page toward maxPages", async () => {
    const actor = makeActor();
    const urls = [`${server.baseUrl}/fixtures/python-jobs.html`];
    const chooser = new RecordedChooser({ fixture: "replay/python-jobs-detail" });
    const raw = { startUrls: urls, mode: "list", fields: F("title"), description: "python job listing", followDetailPages: true, detailFields: F("description"), maxPages: 4 };
    const summary = await runCrawl(input(raw), makeDeps(actor, chooser));
    expect(summary.status).toBe("succeeded");
    expect(summary.items).toBe(25);
    // the listing plus three detail pages
    expect(summary.pages).toBe(4);
    expect(summary.requests).toEqual({ compile: 1, list: 1, record: 0 });
    expect(summary.fieldsNotFound).toEqual([]);
    expect(chooser.usage().questions).toBe(5);

    const items = await datasetItems(actor);
    expect(items).toHaveLength(25);
    expect(items[0]).toMatchObject({ title: "Senior Python Engineer II", description: "Own the packaging pipeline for conda and lead a team of four engineers." });
    expect(items[1]).toMatchObject({ title: "Backend Developer (Django)", description: "Build the Django services behind Ubuntu Pro subscriptions." });
    expect(items[2]).toMatchObject({ title: "Data Engineer", description: "Design the telemetry warehouse that powers Firefox release decisions." });
    for (const item of items.slice(3)) expect(item.description).toBeNull();
    for (const item of items) expect(Object.keys(item).sort()).toEqual(["_source", "description", "title"]);

    const store = await ScraperStore.open({ actor });
    const key = keyFor(urls, { description: raw.description, fields: ["title"], profile: "store" });
    const stored = await store.get(key.cacheKey);
    expect(stored?.detail).not.toBeNull();
    expect(Object.keys(stored!.detail!.fields)).toEqual(["description"]);
    expect(stored!.detail!.fields.description!.alternatives[0]!.selector).toBe("p.description");
    expect(stored!.detail!.linkField in stored!.fields).toBe(true);
    expect(stored!.fields[stored!.detail!.linkField]!.alternatives[0]).toMatchObject({ attr: "href" });

    // a second run replays the stored detail template with no chooser call
    const empty = new RecordedChooser({ fixture: "crawler/empty" });
    const again = await runCrawl(input(raw), makeDeps(makeActor(), empty, { store }));
    expect(again.cacheHit).toBe(true);
    expect(again.status).toBe("succeeded");
    expect(again.items).toBe(25);
    expect(again.pages).toBe(4);
    expect(empty.usage().questions).toBe(0);
  });
});

describe("replayTrace (R24, R25, R42)", () => {
  async function withPage<T>(path: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await browser.context.newPage();
    try {
      await page.goto(`${server.baseUrl}${path}`);
      return await fn(page);
    } finally {
      await page.close();
    }
  }

  function policyFor(profile: "store" | "local" = "store"): ReplayPolicy {
    return { profile, startUrls: [`${server.baseUrl}/`], allowedDomains: [], allowMutations: [] };
  }

  function traced(trace: TraceStep[], profile: "store" | "local" = "store"): CompiledScraper {
    return seeded({ templateKey: "t", cacheKey: "c", profile, entry: { mode: "trace", url: `${server.baseUrl}/` }, trace });
  }

  it("rejects a CSS target whose live name changed before replay", async () => {
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent('<div id="suggestion" onclick="document.body.dataset.deleted=1">Delete account</div>');
      const locator = await resolveLocator(page, [{ role: "button", name: "Python", exact: true, css: "#suggestion" }], 0);
      expect(locator).toBeNull();
      expect(await page.locator("body").getAttribute("data-deleted")).toBeNull();
    });
  });

  it("replays keyboard suggestions and selects the recorded custom control over a same-name native button", async () => {
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent(`<input aria-label="Search"><button onclick="document.body.dataset.chosen='wrong'">Python</button><div id="suggestion" style="display:none;cursor:cell" onclick="document.body.dataset.chosen='right'">Python</div><script>document.querySelector('input').addEventListener('keyup',()=>document.querySelector('#suggestion').style.display='block')</script>`);
      const result = await replayTrace(page, traced([
        { op: "type", text: "Python", alternatives: [{ role: "textbox", name: "Search", exact: true }] },
        { op: "click", alternatives: [{ role: "button", name: "Python", exact: true, css: "#suggestion" }] },
      ]), { secrets: new Map(), policy: policyFor() });
      expect(result).toEqual({ ok: true, steps: 2 });
      expect(await page.locator("body").getAttribute("data-chosen")).toBe("right");
    });
  });

  it("a urlPattern expectation recorded by the navigator matches the URL it was captured from, and not another path", async () => {
    const results = `${server.baseUrl}/fixtures/results.html?q=python`;
    const search = (expect: TraceStep["expect"]): TraceStep[] => [
      { op: "type", text: "python", alternatives: [{ role: "searchbox", name: "Search jobs", exact: true }] },
      { op: "click", alternatives: [{ role: "button", name: "Search", exact: true }], target: { form: { method: "get", action: "/fixtures/results.html" } }, expect },
    ];
    await withPage("/fixtures/search-form.html", async (page) => {
      const ok = await replayTrace(page, traced(search({ urlPattern: urlPatternFor(results) })), { secrets: new Map(), policy: policyFor() });
      expect(ok).toEqual({ ok: true, steps: 2 });
      expect(page.url()).toBe(results);
    });
    await withPage("/fixtures/search-form.html", async (page) => {
      const other = await replayTrace(page, traced(search({ urlPattern: urlPatternFor(`${server.baseUrl}/fixtures/python-jobs.html`) })), { secrets: new Map(), policy: policyFor() });
      expect(other.ok).toBe(false);
      if (!other.ok) expect(other.reason).toMatch(/expectation failed/);
    });
  });

  it("a username secret types into an email input and the password secret into the password input; the password secret is refused elsewhere", async () => {
    const secrets = new Map([
      ["username", new Secret("max@example.com")],
      ["password", new Secret("hunter2-secret")],
    ]);
    const email = { role: "textbox", name: "Email", exact: true };
    const password = { role: "textbox", name: "Password", exact: true };
    await withPage("/login/", async (page) => {
      const ok = await replayTrace(
        page,
        traced(
          [
            { op: "type", secret: "username", alternatives: [email] },
            { op: "type", secret: "password", alternatives: [password] },
          ],
          "local",
        ),
        { secrets, policy: policyFor("local") },
      );
      expect(ok).toEqual({ ok: true, steps: 2 });
      expect(await page.locator("#email").inputValue()).toBe("max@example.com");
      expect(await page.locator("#password").inputValue()).toBe("hunter2-secret");
    });
    await withPage("/login/", async (page) => {
      const refused = await replayTrace(page, traced([{ op: "type", secret: "password", alternatives: [email] }], "local"), { secrets, policy: policyFor("local") });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.status).toBe("blocked_no_progress");
        expect(refused.reason).toMatch(/password input/);
      }
      expect(await page.locator("#email").inputValue()).toBe("");
    });
  });

  it("a click whose recorded and live href is javascript: replays without a domain refusal", async () => {
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent(`<h1>Job search</h1><a href="javascript:void(document.title='clicked')">Toggle filters</a>`);
      const result = await replayTrace(
        page,
        traced([{ op: "click", alternatives: [{ role: "link", name: "Toggle filters", exact: true }], target: { href: "javascript:void(document.title='clicked')" } }]),
        { secrets: new Map(), policy: policyFor() },
      );
      expect(result).toEqual({ ok: true, steps: 1 });
      expect(await page.title()).toBe("clicked");
    });
  });
});
