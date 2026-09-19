import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { compile, type CompileOptions } from "../src/compile/index.js";
import { isFieldHealingEvent } from "../src/replay/heal.js";
import type { CompiledScraper } from "../src/scraper/schema.js";
import { runDemo } from "../scripts/demo.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U19 acceptance: the README demo (`npm run demo`) is the AE8 proof end to
 * end, and every positive recorded compile fixture still compiles to the
 * field map stored next to its answers (`expected.json`).
 */

const RECORDED_COMPILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "recorded", "compile");
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
