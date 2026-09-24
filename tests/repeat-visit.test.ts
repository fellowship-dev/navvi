import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actor } from "apify";
import { MemoryStorage } from "crawlee";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { parseInput } from "../src/input/schema.js";
import { openPages, type Pages } from "../src/make/index.js";
import { runCrawl, type CrawlDeps } from "../src/replay/crawler.js";
import { cacheKey, validateScraper, type CompiledScraper } from "../src/scraper/schema.js";
import { ScraperStore } from "../src/scraper/store.js";
import { groupByTemplate } from "../src/template/index.js";

/**
 * U11: the driver reading the same URL more than once through one context.
 *
 * `tests/verify-fill.test.ts` drives real Chromium against pages whose prices
 * exist only in the payload they fetch for themselves, which is the shape this
 * needs — but its fixture server answers everything `Cache-Control: no-store`,
 * so no page it serves has ever been read twice out of a browser cache. That
 * is the case the pipeline spends most of its visits in: `navvi make` captures
 * each sampled URL once and then replays it four more times (three for
 * determinism, one for verify), all in the one context `openPages` opens.
 *
 * ## What that missed
 *
 * Measured on store-b.example on 2026-09-23, twelve visits to three product URLs
 * through one Camoufox context:
 *
 * ```
 * visit  1 884669.html  json=56  detail=200  values={"productName":"Acido…","listPrice":"4690"}
 * visit  4 884669.html  json=7   detail=304  values={"productName":null,"listPrice":null}
 * visit  7 884669.html  json=8   detail=304  values={"productName":null,"listPrice":null}
 * visit 10 884669.html  json=7   detail=304  values={"productName":null,"listPrice":null}
 * ```
 *
 * The first visit to a URL was answered `200 application/json` and bound every
 * field. Every later visit to the same URL sent back the ETag it had been
 * given, was answered `304 Not Modified`, and bound nothing — while the page
 * rendered exactly as before, from the copy in the browser's cache that navvi
 * could not see. A 304 carries no `content-type`, so `captureJson` drops it,
 * and reading it anyway is not available: Playwright counts 304 among the
 * redirect statuses and answers `response.json()` with "Response body is
 * unavailable for redirect responses". So `src/make/pages.ts` takes the
 * conditional headers off every request, and this is what says so.
 *
 * ## Why this file carries its own server
 *
 * The condition is a caching contract between a server and a browser, and
 * `tests/server.ts` exists to have no such contract — every fixture it serves
 * is `no-store` precisely so that no test accidentally depends on one. A
 * fixture that reproduces revalidation has to state the opposite contract, and
 * has to count what it was asked, so that "the driver read it three times" is
 * separable from "the fixture never made it hard". Hence `payloadServer`: an
 * ETag, `Cache-Control: no-cache`, a 304 shaped like Store B's (no
 * `content-type`), and a tally of both.
 */

interface PayloadServer {
  baseUrl: string;
  /** How the payload for one sku has been answered so far, newest last. */
  answered(sku: string): number[];
  /** How many requests for one sku's payload arrived carrying `If-None-Match`. */
  conditional(sku: string): number;
  close(): Promise<void>;
}

const PRODUCTS: Record<string, { name: string; list: number; sale: number; cache: string }> = {
  // `no-cache` is "you may keep this, and you must ask before using it", which
  // is what Store B's API serves and what makes the second visit a
  // revalidation rather than a fresh download.
  "900301": { name: "Ejemplo Jarabe Expectorante 120 ml", list: 4690, sale: 4221, cache: "no-cache" },
  "900302": { name: "Ejemplo Antiacido 20 mg 14 Capsulas", list: 3690, sale: 3321, cache: "no-cache" },
  // The neighbouring contract, which asks nothing at all for ten minutes. It
  // is the harder one: there is no request to strip a header from.
  "900303": { name: "Ejemplo Analgesico 500 mg 16 Comprimidos", list: 8990, sale: 8990, cache: "max-age=600" },
  // The crawler's copy of the same contract. Kept separate so the two drivers'
  // request tallies cannot be read for one another.
  "900304": { name: "Ejemplo Descongestionante 10 mg 20 Comprimidos", list: 5290, sale: 4761, cache: "no-cache" },
};

/**
 * A product page whose name and prices are stated only in the JSON it fetches
 * for itself, served so that a browser holding a copy must ask about it again
 * rather than take it straight from cache.
 */
async function payloadServer(): Promise<PayloadServer> {
  const answers = new Map<string, number[]>();
  const conditionals = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const payload = /^\/payload-(\d+)\.json$/.exec(url.pathname);
    if (payload) {
      const sku = payload[1]!;
      const product = PRODUCTS[sku];
      if (!product) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const etag = `"${sku}-v1"`;
      const headers = { ETag: etag, "Cache-Control": product.cache };
      const record = (status: number): void => {
        answers.set(sku, [...(answers.get(sku) ?? []), status]);
      };
      if (req.headers["if-none-match"] !== undefined) bump(conditionals, sku);
      if (req.headers["if-none-match"] === etag) {
        // Shaped like the real one: a 304 is a header block, and `content-type`
        // is not among the headers it carries.
        record(304);
        res.writeHead(304, headers);
        res.end();
        return;
      }
      record(200);
      // `?slow=<ms>`: answer late, the way a real product endpoint does when the
      // page is one of forty things a loaded machine is rendering. The document
      // has already loaded by then, so a driver that extracts on load sees
      // nothing and a driver that waits for the payload sees everything.
      const slow = Number(url.searchParams.get("slow") ?? 0);
      const answer = (): void => {
        res.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ productData: { name: product.name, prices: { "price-list-std": product.list, "price-sale-std": product.sale } } }));
      };
      if (slow > 0) setTimeout(answer, slow);
      else answer();
      return;
    }

    if (url.pathname === "/product.html") {
      const sku = url.searchParams.get("sku") ?? "";
      // `?revalidate=1`: the page asks its own conditional question instead of
      // waiting for the browser's cache to ask one for it. See the crawler
      // suite at the foot of this file for why that distinction is the test.
      const conditional = url.searchParams.get("revalidate") === "1" ? `, { headers: { "If-None-Match": '"${sku}-v1"' } }` : "";
      const slow = url.searchParams.get("slow");
      const slowQuery = slow === null ? "" : `?slow=${encodeURIComponent(slow)}`;
      // The document itself is never cached, so a repeated visit is always a
      // real navigation and the only thing the browser can reuse is the
      // payload — which is the whole subject here.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8" /><title>Producto — Ejemplo Farmacia</title></head>
  <body>
    <h1 id="name">Cargando…</h1>
    <p>Los precios de esta ficha viven únicamente en la respuesta que la página pide para sí misma.</p>
    <script>
      fetch("/payload-${sku}.json${slowQuery}"${conditional})
        .then((response) => response.json())
        .then((payload) => { document.getElementById("name").textContent = payload.productData.name; })
        .catch(() => { document.getElementById("name").textContent = "Ficha sin respuesta"; });
    </script>
  </body>
</html>`);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("payload server did not bind a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    answered: (sku) => answers.get(sku) ?? [],
    conditional: (sku) => conditionals.get(sku) ?? 0,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const NOW = new Date("2026-09-23T12:00:00.000Z");

let server: PayloadServer;
let pages: Pages;
let plain: LaunchedBrowser;
let storageDir: string;

beforeAll(async () => {
  server = await payloadServer();
  storageDir = mkdtempSync(join(tmpdir(), "navvi-repeat-visit-"));
  pages = await openPages({ browser: "chromium", headed: false, storageDir });
  plain = await launch({ browser: "chromium", headed: false });
});

afterAll(async () => {
  await pages?.close();
  await plain?.close();
  await server?.close();
});

const product = (sku: string): string => `${server.baseUrl}/product.html?sku=${sku}`;

/** The three fields as `compileFromReconciliation` emits them for a payload binding. */
function payloadScraper(sku: string): CompiledScraper {
  const alternative = (path: string, shape: "text" | "int") => ({
    selector: "payload-<sku>.json",
    source: "network" as const,
    path,
    match: "payload-",
    fingerprint: { samples: [], shape },
  });
  return {
    version: 1,
    templateKey: "product.html",
    cacheKey: "repeat-visit",
    profile: "local",
    chooser: "model",
    mode: "record",
    entry: { mode: "direct", url: product(sku) },
    trace: [],
    fields: {
      productName: { alternatives: [alternative("productData.name", "text")] },
      listPrice: { alternatives: [alternative("productData.prices[price-list-std]", "int")] },
      promoPrice: { alternatives: [alternative("productData.prices[price-sale-std]", "int")] },
    },
    pagination: { mode: "none" },
    detail: null,
    createdAt: NOW.toISOString(),
  } as CompiledScraper;
}

describe("the fixture's caching contract", () => {
  it("answers a browser that keeps its copy with a bodiless 304, which is the condition under test", async () => {
    // The premise, stated as a fact about the fixture rather than assumed —
    // a test that pins repeated reads against a server nobody could cache
    // would pass for the wrong reason forever. This is a plain browser, not
    // navvi's driver: it does what a browser does.
    const sku = "900302";
    for (let visit = 0; visit < 2; visit += 1) {
      const page = await plain.context.newPage();
      try {
        await page.goto(product(sku), { waitUntil: "networkidle" });
        await page.waitForFunction(() => document.getElementById("name")?.textContent !== "Cargando…");
        // The page shows the name on both visits, which is the other half of
        // the trap: nothing is broken from the page's side.
        expect(await page.locator("#name").textContent()).toBe(PRODUCTS[sku]!.name);
      } finally {
        await page.close();
      }
    }

    expect(server.conditional(sku)).toBeGreaterThan(0);
    expect(server.answered(sku)).toEqual([200, 304]);
  });
});

describe("a payload-bound scraper replayed through the driver", () => {
  it("reads its values on the second and later visit to one URL in one context", async () => {
    // Four visits, because that is what one `navvi make` takes of a sampled
    // URL: one to capture it and three to replay it. Under the defect this
    // covers, the first was the only one that read anything.
    const sku = "900301";
    const readings = [];
    for (let visit = 0; visit < 4; visit += 1) readings.push(await pages.extract(payloadScraper(sku), product(sku)));

    expect(readings.map((reading) => reading.items[0]?.values.productName)).toEqual(Array(4).fill(PRODUCTS[sku]!.name));
    expect(readings.map((reading) => reading.items[0]?.values.listPrice)).toEqual(["4690", "4690", "4690", "4690"]);
    expect(readings.map((reading) => reading.items[0]?.values.promoPrice)).toEqual(["4221", "4221", "4221", "4221"]);

    // And the reason it could, which is the assertion that actually fails
    // when the driver stops paying for its reused context: every visit was
    // answered with a body. Without `refuseRevalidation` this reads
    // `[200, 304, 304, 304]`.
    //
    // It has to be asserted separately, because on Chromium the three lines
    // above keep passing through the defect. Playwright reports a revalidated
    // resource to the `response` event as the 200 the browser assembled, body
    // and `content-type` included, so the capture still sees it. Firefox
    // reports the raw 304 instead, and that is the engine the default browser
    // is built on — which is how a defect that made every replay read null on
    // `camoufox` looked like a 2-of-3 pass on `--browser chromium`, and why a
    // fixture assertion about values alone would pin nothing here.
    expect(server.answered(sku)).toEqual([200, 200, 200, 200]);
    expect(server.conditional(sku)).toBe(0);
  });

  it("reads a payload the browser was told it could reuse for ten minutes without asking", async () => {
    // The neighbouring caching contract, and the one no stripped header can
    // help with: a fresh `max-age` entry is reused with no request at all, so
    // there is nothing to take a validator off. Four visits answered once is
    // what that looks like from the server, and it is what this fixture
    // reports without `refuseRevalidation`. The route handler is what makes
    // the request happen anyway — see that function's header.
    const sku = "900303";
    const readings = [];
    for (let visit = 0; visit < 4; visit += 1) readings.push(await pages.extract(payloadScraper(sku), product(sku)));

    expect(readings.map((reading) => reading.items[0]?.values.listPrice)).toEqual(["8990", "8990", "8990", "8990"]);
    expect(server.answered(sku)).toEqual([200, 200, 200, 200]);
  });

  it("takes the same reading through `read`, which is the verb the determinism stage replays with", async () => {
    // `Pages.read` and `Pages.extract` are one function, and the determinism
    // stage is the one that reported `stable` over the blank extraction. The
    // values it hands `measureDeterminism` are the assertion.
    const sku = "900301";
    const first = await pages.read(payloadScraper(sku), product(sku));
    const second = await pages.read(payloadScraper(sku), product(sku));

    expect(first).toEqual(second);
    expect(second[0]?.listPrice).toBe("4690");
    expect(second[0]?.productName).toBe(PRODUCTS[sku]!.name);
  });
});

/**
 * The same defect, one driver over.
 *
 * 89e9633 fixed `make`'s driver and nothing else. `replay/crawler.ts` already
 * routed every request — for the URL policy — and continued it untouched, so
 * it had the half of the fix that comes free with routing (the browser's cache
 * never gets to answer) and not the half that has to be written (the request
 * goes out without its validators). A crawl that visits two pages sharing one
 * payload endpoint therefore read that payload once and revalidated it after,
 * and on the default browser every `network`-source field on the second page
 * came back null.
 *
 * Nothing caught it because nothing looked: `tests/server.ts` never sends an
 * ETag, so no page the suite serves has ever been revalidated, and the tests
 * above exercise `openPages`, which had the fix.
 *
 * The request tally is the assertion that matters. On Chromium the values pass
 * straight through the defect — Playwright reports a revalidated resource to
 * the `response` event as the 200 the browser assembled — so a test that only
 * read the rows would pin nothing.
 */
describe("the crawler's second visit to a payload endpoint", () => {
  const FIELDS = ["productName", "listPrice"];
  let dir: string;

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "navvi-crawl-revalidate-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("goes out without its validators, so every visit is answered with a body", async () => {
    const sku = "900304";
    const product = PRODUCTS[sku]!;
    // Two pages of one template that fetch the same payload, and the second
    // visit is the one the live defect was about. But the browser's cache is
    // not what this can assert against: a request Playwright routes is a
    // request the cache does not get to answer, and the crawler has routed
    // every request since long before 89e9633 — so on Chromium no validator is
    // ever sent and the missing half is invisible. `?revalidate=1` makes the
    // page ask the conditional question itself, which is the same request the
    // cache would have sent, minus the engine's opinion about when to send it.
    // That is exactly the half the crawler was missing, and it fails on every
    // engine without it.
    const urls = [`${server.baseUrl}/product.html?sku=${sku}&revalidate=1`, `${server.baseUrl}/product.html?sku=${sku}&revalidate=1&again=1`];
    const templateKey = [...groupByTemplate(urls).keys()][0]!;
    expect(groupByTemplate(urls).get(templateKey)).toHaveLength(2);

    const actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false }) });
    const store = await ScraperStore.open({ actor });
    const key = cacheKey(templateKey, { fields: FIELDS, profile: "store" });
    const alternative = (path: string, shape: "text" | "int", sample: string) => ({
      selector: `payload-${sku}.json`,
      source: "network" as const,
      path,
      match: "payload-",
      fingerprint: { samples: [sample], shape },
    });
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
        createdAt: NOW.toISOString(),
        fields: {
          productName: { alternatives: [alternative("productData.name", "text", product.name)] },
          listPrice: { alternatives: [alternative("productData.prices[price-list-std]", "int", String(product.list))] },
        },
      }),
    );

    const log: string[] = [];
    const deps: CrawlDeps = {
      actor,
      chooser: new RecordedChooser({ fixture: "crawler/empty" }),
      env: {},
      storageDir: mkdtempSync(join(dir, "st-")),
      attended: false,
      // One at a time, or the two visits race and the second may go out before
      // the first has taught the cache anything.
      maxConcurrency: 1,
      // This test is about revalidation, and healing is not part of its
      // subject. It has to say so, because `crawler/empty` is the fixture that
      // refuses *every* question: under load a field occasionally reads null,
      // the crawler licenses a repair, the fixture refuses it, and since
      // 2026-09-23 that refusal is rethrown rather than swallowed — so the run
      // stopped on its first page and the revalidation tally was never taken.
      // A declining healer keeps the subject fixed. (The same fixture was
      // being asked the same accidental question in `tests/crawler.test.ts`'s
      // login-trace test, found the same day.)
      healer: async () => ({ healed: false, reason: "this test is about revalidation, not repair" }),
      log: (message) => log.push(message),
    };
    const summary = await runCrawl(
      parseInput({ browser: "chromium", allowPrivateHosts: ["127.0.0.1"], mode: "record", profile: "store", fields: FIELDS.map((name) => ({ name })), startUrls: urls }),
      deps,
    );

    // Under the defect this reads [304, 304]: the request goes out with the
    // validator the page attached, the server answers with a header block and
    // no body, `captureJson` drops it for want of a content-type, and both
    // rows come back null.
    expect(server.answered(sku)).toEqual([200, 200]);
    expect(server.conditional(sku)).toBe(0);

    const items = (await (await actor.openDataset()).getData()).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.productName)).toEqual([product.name, product.name]);
    expect(items.map((item) => item.listPrice)).toEqual([String(product.list), String(product.list)]);
    expect(summary.status).toBe("succeeded");
  }, 60_000);

  it("waits for the payload its scraper reads instead of extracting against an empty capture", async () => {
    // `Capture.settled()` drains body reads that have *started*; it is not a
    // wait for a response to arrive. So a page whose `fetch` had not yet
    // returned when the crawler reached it was extracted against an empty
    // capture and every `network`-source field came back null — on a page that
    // was served perfectly, with the payload arriving moments later. That is
    // the 25 s settle cap's defect one driver over, and it reads the same way:
    // a field that was there and was not waited for is indistinguishable from a
    // field the site stopped serving.
    //
    // A compiled scraper already names the payloads it reads, so the wait is
    // for those rather than for quiet in general. `?slow=2000` is what a loaded
    // machine does to a real product endpoint.
    const sku = "900301";
    const product = PRODUCTS[sku]!;
    const urls = [`${server.baseUrl}/product.html?sku=${sku}&slow=2000`];
    const templateKey = [...groupByTemplate(urls).keys()][0]!;

    const actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-slow-")), persistStorage: false }) });
    const store = await ScraperStore.open({ actor });
    const alternative = (path: string, shape: "text" | "int", sample: string) => ({
      selector: `payload-${sku}.json`,
      source: "network" as const,
      path,
      match: "payload-",
      fingerprint: { samples: [sample], shape },
    });
    await store.put(
      validateScraper({
        version: 1,
        templateKey,
        cacheKey: cacheKey(templateKey, { fields: FIELDS, profile: "store" }),
        profile: "store",
        chooser: "agent",
        mode: "record",
        entry: { mode: "direct", url: urls[0]! },
        trace: [],
        pagination: { mode: "none" },
        detail: null,
        createdAt: NOW.toISOString(),
        fields: {
          productName: { alternatives: [alternative("productData.name", "text", product.name)] },
          listPrice: { alternatives: [alternative("productData.prices[price-list-std]", "int", String(product.list))] },
        },
      }),
    );

    const summary = await runCrawl(
      parseInput({ browser: "chromium", allowPrivateHosts: ["127.0.0.1"], mode: "record", profile: "store", fields: FIELDS.map((name) => ({ name })), startUrls: urls }),
      {
        actor,
        chooser: new RecordedChooser({ fixture: "crawler/empty" }),
        env: {},
        storageDir: mkdtempSync(join(dir, "st-slow-")),
        attended: false,
        maxConcurrency: 1,
        // The subject is the wait, not the repair: `crawler/empty` refuses every
        // question, so an unwaited null would ask one and stop the run rather
        // than produce the null this test is about.
        healer: async () => ({ healed: false, reason: "this test is about waiting, not repair" }),
        log: () => undefined,
      },
    );

    // Without the wait these are both null: the document has loaded, the
    // capture is empty, and `extractPage` has nothing to read.
    const items = (await (await actor.openDataset()).getData()).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.productName).toBe(product.name);
    expect(items[0]?.listPrice).toBe(String(product.list));
    expect(summary.status).toBe("succeeded");
  }, 60_000);
});
