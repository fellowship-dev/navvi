import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fillLine, openPages, renderScorecard, scorecard, type Pages } from "../src/make/index.js";
import type { PageExtraction } from "../src/scraper/extract.js";
import type { CompiledScraper } from "../src/scraper/schema.js";
import type { Reconciliation } from "../src/reconcile/index.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U11: the verify stage's fill rate, against pages whose values exist only in
 * the payload they fetch for themselves.
 *
 * This is the only check in the pipeline that runs the finished `scraper.json`
 * against a real page, which makes it the only thing standing between navvi
 * and shipping a deliverable nobody ever asked to do anything. So the number it
 * reports has to be the number it measured, in **both** directions, and neither
 * direction is arguable from a stub: a fixture `Pages` that answers from a
 * table proves the arithmetic and says nothing about whether the stage hands
 * `extractPage` the captured responses a `network` alternative resolves
 * against. These drive the real driver, the real extraction and the real
 * scorecard against `tests/fixtures/verify/`.
 *
 * ## What was reported, and what it turned out to be
 *
 * On 2026-09-23 a `navvi make` against three real product URLs compiled three
 * payload-bound fields, and the two stages that replay the compiled scraper
 * appeared to contradict each other through the same `Pages` driver:
 *
 * ```
 * determinism   3 replays x 3 URLs, 0 fields moved
 * verify        3 of 3 compiled, fill 0 of 3
 * ```
 *
 * The suspicion was that `verify` replays without the captured payloads, which
 * would make every `network` alternative resolve to null and produce exactly
 * that zero. It does not — `Pages.read` and `Pages.extract` are one function —
 * and the first test here is what says so: a scraper whose every field is
 * payload-bound, replayed through the verify stage against pages that state
 * their prices nowhere else, reports the fill it achieved.
 *
 * The contradiction was not one. `determinism` cannot report a fill: its
 * `readOn` counts the presence of a field's *key*, `extractPage` null-fills
 * every compiled field, and a replay that reads nothing therefore lands as
 * `held` on every field with verdict `stable`. Both stages had measured the
 * same nothing and only `verify` could say so. `tests/make.test.ts` covers
 * that half, where the whole driver runs and the transcript is the assertion.
 */

const NOW = new Date("2026-09-23T12:00:00.000Z");

let server: FixtureServer;
let pages: Pages;
let storageDir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  storageDir = mkdtempSync(join(tmpdir(), "navvi-verify-fill-"));
  pages = await openPages({ browser: "chromium", headed: false, storageDir });
});

afterAll(async () => {
  await pages?.close();
  await server?.close();
});

const product = (query: string): string => `${server.baseUrl}/fixtures/verify/payload-product.html${query}`;

/**
 * The three fields as `compileFromReconciliation` emits them for a payload
 * binding: a `network` source, a URL substring to match the response by, and
 * the dotted path into its body. `selector` carries the endpoint rather than a
 * CSS selector, which is what the compiled schema means by a label.
 */
function payloadScraper(): CompiledScraper {
  const alternative = (path: string, shape: "text" | "int") => ({
    selector: "payload-<sku>.json",
    source: "network" as const,
    path,
    match: "payload-",
    fingerprint: { samples: [], shape },
  });
  return {
    version: 1,
    templateKey: "fixtures/verify/payload-product.html",
    cacheKey: "verify-fill",
    profile: "local",
    chooser: "model",
    mode: "record",
    entry: { mode: "direct", url: product("?sku=900201") },
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

/** Enough of a reconciliation for the scorecard's counts; the fill rate reads none of it. */
function reconciliation(): Reconciliation {
  const fields = ["productName", "listPrice", "promoPrice"];
  return {
    version: 1,
    site: "Ejemplo Farmacia",
    recordedAt: NOW.toISOString(),
    obtainable: fields.map((field) => ({ field, because: "payload", alternatives: [] })),
    notObtainable: [],
    obstacles: [],
    because: "three payload-bound fields",
  } as unknown as Reconciliation;
}

/** The verify stage as the driver runs it: replay each URL, then score what came back. */
async function verify(urls: readonly string[]): Promise<{ card: ReturnType<typeof scorecard>; extractions: PageExtraction[] }> {
  const scraper = payloadScraper();
  const extractions: PageExtraction[] = [];
  for (const url of urls) extractions.push(await pages.extract(scraper, url));
  return { card: scorecard(scraper, reconciliation(), [], { site: "Ejemplo Farmacia", now: NOW, extractions }), extractions };
}

describe("a payload-bound scraper replayed through the verify stage", () => {
  it("reports the fill it achieved, rather than the zero a replay without the captured payloads would produce", async () => {
    const { card, extractions } = await verify([product("?sku=900201"), product("?sku=900202"), product("?sku=900203")]);

    // The values first, because a fill count of 3 means nothing if the stage
    // read the right number of wrong things. Nothing on these pages renders a
    // price: every one of these came out of the captured response.
    expect(extractions.map((page) => page.items[0]?.values.listPrice)).toEqual(["4690", "3690", "8990"]);
    expect(extractions.map((page) => page.items[0]?.values.promoPrice)).toEqual(["4221", "3321", "8990"]);
    expect(extractions[0]?.items[0]?.values.productName).toBe("Ejemplo Jarabe Expectorante 120 ml");

    expect(card.fill).toEqual({
      urls: 3,
      fields: [
        { field: "productName", read: 3, of: 3 },
        { field: "listPrice", read: 3, of: 3 },
        { field: "promoPrice", read: 3, of: 3 },
      ],
    });
    expect(fillLine(card)).toBe("fill 3 of 3 fields, 9 of 9 reads");
    expect(renderScorecard(card)).toContain("| productName | 3 of 3 |");
  });

  it("reports the zero it measured when the pages never take delivery of their payload, and says so in the artifact", async () => {
    // The same page with no `sku`: it settles, it has a title and a heading,
    // and it fetches nothing. A stage that reported success here would be
    // reporting a fill it did not measure, which is the worse of the two
    // directions this pair covers.
    const { card, extractions } = await verify([product(""), product("?silent=1"), product("?silent=2")]);

    expect(extractions.map((page) => page.items[0]?.values.listPrice)).toEqual([null, null, null]);
    expect(card.fill?.fields.every((field) => field.read === 0)).toBe(true);
    expect(fillLine(card)).toBe("fill 0 of 3 fields, 0 of 9 reads");

    const artifact = renderScorecard(card);
    expect(artifact).toContain("| listPrice | 0 of 3 |");
    // A page was opened and it answered nothing, which is not the same fact as
    // no page having been opened at all — the distinction this stage's header
    // says the repository keeps confusing. The fill section must be the second
    // sentence and never the first.
    expect(artifact).toContain("the compiled scraper was replayed against 3 of the sample's own URLs");
    expect(artifact).not.toContain("no page was read");
  });

  it("does not print the same headline for a scraper that read nothing and one that read everything on all but one URL", async () => {
    // The report that opened this investigation carried both numbers from the
    // same day: `fill 0 of 3` on the default browser, and `2 of 3` per field
    // on `--browser chromium`. Under the old one-fraction headline those two
    // runs printed the identical line, and the difference between "this
    // scraper reads nothing" and "this scraper reads, and one page did not
    // answer" was recoverable only from the bullets underneath.
    const { card: partial } = await verify([product("?sku=900201"), product("?sku=900202"), product("")]);

    expect(partial.fill?.fields).toEqual([
      { field: "productName", read: 2, of: 3 },
      { field: "listPrice", read: 2, of: 3 },
      { field: "promoPrice", read: 2, of: 3 },
    ]);
    expect(fillLine(partial)).toBe("fill 0 of 3 fields, 6 of 9 reads");

    const { card: nothing } = await verify([product(""), product("?silent=1"), product("?silent=2")]);
    expect(fillLine(nothing)).toBe("fill 0 of 3 fields, 0 of 9 reads");
    expect(fillLine(partial)).not.toBe(fillLine(nothing));
  });
});
