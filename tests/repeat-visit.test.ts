import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { openPages, type Pages } from "../src/make/index.js";
import type { CompiledScraper } from "../src/scraper/schema.js";

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
      res.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ productData: { name: product.name, prices: { "price-list-std": product.list, "price-sale-std": product.sale } } }));
      return;
    }

    if (url.pathname === "/product.html") {
      const sku = url.searchParams.get("sku") ?? "";
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
      fetch("/payload-${sku}.json")
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
