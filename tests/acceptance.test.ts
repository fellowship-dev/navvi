import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import type { Chooser } from "../src/chooser/chooser.js";
import { RecordedChooser, RecordedOptionsMismatchError } from "../src/chooser/recorded.js";
import { compile, type CompileOptions } from "../src/compile/index.js";
import type { HealOutcome } from "../src/replay/crawler.js";
import { createHealer, isFieldHealingEvent } from "../src/replay/heal.js";
import type { CompiledScraper } from "../src/scraper/schema.js";
import { DEMO_DESCRIPTION, DEMO_PRODUCTS, HEAL_FIXTURE_BY_PAGE, healFirstPages, recordedChooser, runDemo } from "../scripts/demo.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U19 acceptance: the README demo (`npm run demo`) is the AE8 proof end to
 * end, and every positive recorded compile fixture still compiles to the
 * field map stored next to its answers (`expected.json`).
 */

const RECORDED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "recorded");
const RECORDED_COMPILE_DIR = join(RECORDED_DIR, "compile");
const FIELDS = ["name", "laboratory", "price", "stock"];
const OUT_OF_STOCK = ["ibuprofeno-400-mg", "losartan-50-mg"];

describe("the demo proof (U19, AE8)", () => {
  it("compiles on v1, heals on v2 with price null on the two out-of-stock pages, and replays v1 with zero questions", async () => {
    const lines: string[] = [];
    const result = await runDemo({ log: (line) => lines.push(line) });

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.runs).toHaveLength(3);
    const [first, second, third] = result.runs;

    expect(first!.version).toBe("v1");
    expect(first!.summary.status).toBe("succeeded");
    expect(first!.summary.cacheHit).toBe(false);
    expect(first!.summary.templates).toBe(1);
    expect(first!.summary.chooser?.questions).toBe(4);
    expect(first!.summary.items).toBe(12);
    expect(first!.rows).toHaveLength(12);
    expect(first!.line).toMatch(/compiled 1 template, 4 questions, 12 records, \d+ ms/);

    expect(second!.version).toBe("v2");
    expect(second!.summary.status).toBe("succeeded");
    expect(second!.summary.cacheHit).toBe(true);
    expect(second!.summary.items).toBe(12);
    expect(second!.rows).toHaveLength(12);
    expect(second!.summary.healingEvents.length).toBeGreaterThanOrEqual(1);
    expect(second!.summary.healingEvents.every(isFieldHealingEvent)).toBe(true);
    expect(second!.summary.chooser!.questions).toBeGreaterThanOrEqual(4);
    const nullPrices = second!.rows.filter((row) => row.price === null);
    expect(nullPrices).toHaveLength(2);
    expect(nullPrices.map((row) => String(row._source).split("/").pop()!.replace(".html", "")).sort()).toEqual(OUT_OF_STOCK);
    const unmapped = second!.summary.unmappedCandidates.map((c) => c.text);
    expect(unmapped).toContain("Sin stock");
    expect(unmapped).toContain("Precio oferta");
    expect(second!.line).toMatch(/^cache hit, drift detected on .+, healed with \d+ questions, 12 records, price null on 2, unmapped: Sin stock, Precio oferta( \(\+\d+ more\))?, \d+ ms$/);

    expect(third!.version).toBe("v1");
    expect(third!.summary.status).toBe("succeeded");
    expect(third!.summary.cacheHit).toBe(true);
    expect(third!.summary.items).toBe(12);
    expect(third!.rows).toHaveLength(12);
    expect(third!.summary.healingEvents).toEqual([]);
    expect(third!.summary.chooser?.questions ?? 0).toBe(0);
    for (const row of third!.rows) expect(row.price).toMatch(/^\$ [\d.]+$/);
    expect(third!.line).toMatch(/0 questions, 12 records, \d+ ms/);

    expect(result.stored).not.toBeNull();
    expect(Object.keys(result.stored!.fields)).toEqual(FIELDS);
    expect(result.stored!.healedAt).toBeDefined();
    expect(lines.length).toBeGreaterThan(3);
  }, 120_000);
});

/**
 * A8: a heal batch is answered by the recording made on the page it is healing.
 *
 * `rankHealCandidates` puts a candidate whose value equals an earlier sample
 * first, so the *order* of the options a heal question offers is a function of
 * what is on that page. `tests/recorded/heal/pharmacy` was recorded on
 * amoxicilina; the same question on atorvastatina — the one product carrying
 * two price spans — offers a different list, and a recorded index against it
 * answers a different question. Which of the two the crawler reaches first is
 * a race, so the demo failed about one full-suite run in three and passed
 * alone, which is exactly the shape a repeat count cannot measure.
 *
 * So these two tests are what the repeat count could not be. The first drives
 * the heal onto atorvastatina deterministically and shows the single-fixture
 * chooser refusing it and the routed one healing; the second runs the whole
 * demo with atorvastatina taking the heal.
 */
describe("the heal is answered by the page it is healing (A8)", () => {
  let server: FixtureServer;
  let browser: LaunchedBrowser;

  beforeAll(async () => {
    server = await startFixtureServer();
    browser = await launch({ browser: "chromium", headed: false });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  const productUrl = (slug: string) => `${server.baseUrl}/demo/pharmacy/producto/${slug}.html`;

  /**
   * The scraper the demo's first run compiles, rebuilt here.
   *
   * `runCrawl` compiles a record-mode template from `pickSampleUrls(urls, 3)`,
   * so the samples are the first three products in crawl order and the answers
   * are the `field.*` recordings in `heal/pharmacy`. Replaying those verifies
   * their options, which is what makes this a reconstruction of the demo's own
   * scraper rather than a lookalike: a drift in either would fail here first.
   */
  async function demoScraper(): Promise<CompiledScraper> {
    server.switchDemo("v1");
    const pages: Page[] = [];
    try {
      for (const slug of DEMO_PRODUCTS.slice(0, 3)) {
        const page = await browser.context.newPage();
        await page.goto(productUrl(slug));
        pages.push(page);
      }
      const result = await compile({
        mode: "record",
        pages,
        fields: FIELDS.map((name) => ({ name })),
        description: DEMO_DESCRIPTION,
        templateKey: "127.0.0.1/demo/pharmacy/producto/*",
        cacheKey: "a8",
        profile: "store",
        chooser: new RecordedChooser({ fixture: "heal/pharmacy" }),
        startUrls: [pages[0]!.url()],
        allowedDomains: [],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`the demo's v1 compile no longer reproduces: ${result.status}`);
      return result.scraper;
    } finally {
      for (const page of pages) await page.close();
    }
  }

  async function healWith(slug: string, chooser: Chooser, scraper: CompiledScraper): Promise<HealOutcome> {
    const page = await browser.context.newPage();
    try {
      await page.goto(productUrl(slug));
      return await createHealer()({ page, scraper, chooser, failure: { kind: "fields", fields: [...FIELDS] } });
    } finally {
      await page.close();
    }
  }

  it("refuses the amoxicilina recording on atorvastatina, and heals once the batch is routed by page", async () => {
    const scraper = await demoScraper();
    server.switchDemo("v2");

    // The control: the recording still answers the page it was recorded on.
    const onItsOwnPage = await healWith("amoxicilina-500-mg", new RecordedChooser({ fixture: "heal/pharmacy" }), scraper);
    expect(onItsOwnPage.healed, onItsOwnPage.healed ? "" : onItsOwnPage.reason).toBe(true);

    // Before: every heal batch went to the one fixture, whatever page it came
    // from. The index no longer points where it pointed, and `RecordedChooser`
    // says so — which is the failure `acceptance.test.ts` saw one run in three.
    await expect(healWith("atorvastatina-20-mg", new RecordedChooser({ fixture: "heal/pharmacy" }), scraper)).rejects.toThrow(RecordedOptionsMismatchError);

    // After: the batch is answered by the recording made on this page.
    const routed = await healWith("atorvastatina-20-mg", recordedChooser(), scraper);
    expect(routed.healed, routed.healed ? "" : routed.reason).toBe(true);
    if (!routed.healed || !isFieldHealingEvent(routed.event)) throw new Error("expected a field healing event");
    expect([...routed.event.fields].sort()).toEqual([...FIELDS].sort());
  }, 60_000);

  it("has a recording for every page that can take the heal first", () => {
    for (const slug of healFirstPages()) {
      const fixture = HEAL_FIXTURE_BY_PAGE[slug];
      expect(fixture, `${slug} can take the first heal and has no fixture in HEAL_FIXTURE_BY_PAGE`).toBeDefined();
      for (const field of FIELDS) {
        expect(existsSync(join(RECORDED_DIR, fixture!, `heal.${field}.json`)), `${slug} -> ${fixture}/heal.${field}.json`).toBe(true);
      }
    }
  });

  it("runs the whole demo with atorvastatina taking the heal", async () => {
    const products = ["atorvastatina-20-mg", ...DEMO_PRODUCTS.filter((slug) => slug !== "atorvastatina-20-mg")];
    // One page at a time, so the page that takes the heal is the first one and
    // not whichever of two won a race: the point here is the answer, not the race.
    const result = await runDemo({ products, maxConcurrency: 1, server, log: () => undefined });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    const healed = result.runs[1]!.summary.healingEvents.filter(isFieldHealingEvent);
    expect(healed.some((event) => (event.url ?? "").includes("atorvastatina-20-mg") && event.fields.length === FIELDS.length)).toBe(true);
  }, 120_000);
});

describe("recorded compile fixtures", () => {
  let server: FixtureServer;
  let browser: LaunchedBrowser;

  beforeAll(async () => {
    server = await startFixtureServer();
    browser = await launch({ browser: "chromium", headed: false });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  const F = (...names: string[]) => names.map((name) => ({ name }));
  const V1_SAMPLES = ["paracetamol-500-mg", "ibuprofeno-400-mg", "omeprazol-20-mg"].map((s) => `/demo/pharmacy-v1/producto/${s}.html`);
  const V2_SAMPLES = ["paracetamol-500-mg", "omeprazol-20-mg", "loratadina-10-mg"].map((s) => `/demo/pharmacy-v2/producto/${s}.html`);

  interface Fixture {
    name: string;
    paths: string[];
    options: (pages: Page[]) => Partial<CompileOptions>;
  }

  /** Every positive fixture under tests/recorded/compile; none-group and pharmacy-isbn record negative scenarios and are skipped. */
  const FIXTURES: Fixture[] = [
    { name: "python-jobs", paths: ["/fixtures/python-jobs.html"], options: () => ({ fields: F("title", "company", "location", "date", "link"), description: "python job listing", context: browser.context }) },
    { name: "hackernews", paths: ["/fixtures/hackernews.html"], options: () => ({ fields: F("title", "link", "points", "comments"), description: "story" }) },
    { name: "placeholder-board", paths: ["/fixtures/placeholder-board.html"], options: () => ({ fields: F("title", "owner", "points"), description: "card", settle: { idleMs: 1_000, maxMs: 5_000 } }) },
    { name: "python-jobs-detail", paths: ["/fixtures/python-jobs.html"], options: () => ({ fields: F("title"), description: "python job listing", followDetailPages: true, entryMode: "direct" }) },
    { name: "pharmacy-v1", paths: V1_SAMPLES, options: () => ({ mode: "record", fields: F(...FIELDS), description: "pharmacy product", templateKey: "127.0.0.1/demo/pharmacy-v1/producto/*" }) },
    { name: "pharmacy-v2", paths: V2_SAMPLES, options: () => ({ mode: "record", fields: F(...FIELDS), description: "pharmacy product", templateKey: "127.0.0.1/demo/pharmacy-v2/producto/*" }) },
  ];

  /** The fixture server binds a random port: absolute sample URLs are stored with a stable placeholder. */
  function portable(fields: CompiledScraper["fields"]): CompiledScraper["fields"] {
    return JSON.parse(JSON.stringify(fields).split(server.baseUrl).join("{{base}}")) as CompiledScraper["fields"];
  }

  it("every positive fixture compiles to the field map in its expected.json (generated on the first run)", async () => {
    const recordedDirs = FIXTURES.map((f) => f.name);
    for (const skipped of ["none-group", "pharmacy-isbn"]) expect(recordedDirs).not.toContain(skipped);
    for (const fixture of FIXTURES) {
      const pages: Page[] = [];
      try {
        for (const path of fixture.paths) {
          const page = await browser.context.newPage();
          await page.goto(`${server.baseUrl}${path}`);
          pages.push(page);
        }
        const result = await compile({
          mode: "list",
          pages,
          fields: F("title"),
          templateKey: "127.0.0.1/fixtures/x",
          cacheKey: "cache-key",
          profile: "store",
          chooser: new RecordedChooser({ fixture: `compile/${fixture.name}` }),
          startUrls: [pages[0]!.url()],
          allowedDomains: [],
          ...fixture.options(pages),
        });
        expect(result.ok, fixture.name).toBe(true);
        if (!result.ok) continue;
        const actual = portable(result.scraper.fields);
        const file = join(RECORDED_COMPILE_DIR, fixture.name, "expected.json");
        if (!existsSync(file)) {
          writeFileSync(file, JSON.stringify({ fields: actual }, null, 2) + "\n");
          console.error(`acceptance: generated ${file}`);
        }
        const expected = JSON.parse(readFileSync(file, "utf8")) as { fields: CompiledScraper["fields"] };
        expect(actual, fixture.name).toEqual(expected.fields);
      } finally {
        for (const page of pages) await page.close();
      }
    }
  }, 120_000);
});
