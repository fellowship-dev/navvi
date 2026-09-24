import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import type { Answer, Chooser, ChooserUsage, Question } from "../src/chooser/chooser.js";
import { compileTemplate, renderRationale, type RenderPages, type TemplateCompile, type TemplateSources } from "../src/compile/index.js";
import { chooseSample, probeFrom, type PageResponse, type RequestedField, type SampleChoice } from "../src/investigate/index.js";
import { extractPage } from "../src/scraper/extract.js";
import type { Spec } from "../src/spec/schema.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U4: the compile core, `src/compile/template.ts`, against real pages.
 *
 * The defect it closes was found by a fresh-eyes run on 2026-09-23: `navvi
 * make` on a books demo whose title, price and stock sit in plain markup
 * classified every URL dead, handed tier 3 "0 sample URLs", and exited 1 --
 * while the plain command compiled the same page through a second compiler.
 * These tests run the whole cascade on fixture pages of the three shapes that
 * matter: nothing declared (tier 3 binds everything), half declared (tier 3 is
 * asked only for the rest), and a selector the gate will not ship.
 *
 * The chooser is scripted rather than recorded: it answers each field question
 * by the first option whose label matches a pattern, and keeps every batch it
 * was asked. That is what lets a test assert *which* questions tier 3 asked,
 * which is the whole of KTD2.
 */

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

const NOW = new Date("2026-09-23T18:00:00.000Z");
const url = (name: string): string => `${server.baseUrl}/fixtures/template/${name}.html`;

/** Picks, per field, the first option whose label matches; `none` when nothing does. Records every batch. */
class PatternChooser implements Chooser {
  readonly name = "recorded" as const;
  readonly batches: Question[][] = [];
  constructor(private readonly patterns: Record<string, RegExp>) {}
  async ask(batch: Question[]): Promise<Answer[]> {
    this.batches.push(batch);
    return batch.map((question) => {
      const field = question.id.replace(/^field\./, "").replace(/\.retry$/, "");
      const pattern = this.patterns[field];
      const index = pattern === undefined ? -1 : (question.options ?? []).findIndex((option) => pattern.test(option));
      return { id: question.id, index: index < 0 ? null : index };
    });
  }
  questions(): Question[] {
    return this.batches.flat();
  }
  usage(): ChooserUsage {
    const questions = this.questions().length;
    return { chooser: this.name, questions, textQuestions: 0, batches: this.batches.length, inputTokens: 0, outputTokens: 0, waitMs: 0, costUsd: 0, zeroDataRetention: "not_applicable" };
  }
}

async function plain(target: string): Promise<PageResponse> {
  const res = await fetch(target, { redirect: "follow" });
  return { url: res.url, status: res.status, body: await res.text() };
}

/** Live pages from the fixture server, closed after `use` -- what `Pages.render` does, minus the settle. */
const render: RenderPages = async (urls, use) => {
  const pages: Page[] = [];
  try {
    for (const target of urls) {
      const page = await browser.context.newPage();
      pages.push(page);
      await page.goto(target);
    }
    return await use(pages);
  } finally {
    for (const page of pages) await page.close().catch(() => undefined);
  }
};

function sources(over: Partial<TemplateSources> = {}): TemplateSources & { rendered: string[][] } {
  const rendered: string[][] = [];
  return {
    rendered,
    fetch: plain,
    render: (urls, use) => {
      rendered.push([...urls]);
      return render(urls, use);
    },
    ...over,
  };
}

async function sampleOf(urls: readonly string[]): Promise<SampleChoice> {
  const probes = [];
  for (const target of urls) probes.push(probeFrom(target, await plain(target)));
  return chooseSample(probes);
}

function specFor(fields: readonly RequestedField[], rubrics: Spec["rubrics"] = []): Spec {
  return {
    version: 1,
    brief: `Extract ${fields.map((field) => field.name).join(", ")}`,
    target: { site: "fixtures.example", pageKind: "product", provenance: "brief" },
    entity: { name: "book", provenance: "brief" },
    inputs: { shape: "url_list", description: "product pages", provenance: "brief" },
    fields: fields.map((field) => ({ name: field.name, provenance: "brief" as const, ...(field.type === undefined ? {} : { type: field.type }) })),
    constraints: { freshness: { stated: false }, volume: { stated: false }, cadence: { stated: false }, budget: { stated: false } },
    rubrics,
    openQuestions: [],
  };
}

function ok(result: TemplateCompile): Extract<TemplateCompile, { ok: true }> {
  if (!result.ok) throw new Error(`expected a compiled scraper, got ${result.status}: ${result.because}`);
  return result;
}

const BOOK_FIELDS: RequestedField[] = [{ name: "title" }, { name: "price" }, { name: "availability" }];
const BOOK_PATTERNS = { title: /^[^=]*h1 = /, price: /price_color/, availability: /availability/ };

describe("a page that declares nothing: tier 3 binds every field", () => {
  it("samples the books-like pages as undeclared, binds all three fields at tier 3, and replays with no chooser", async () => {
    const urls = ["books-1", "books-2", "books-3"].map(url);
    const sample = await sampleOf(urls);
    expect(sample.picks.map((pick) => pick.url).sort()).toEqual([...urls].sort());
    expect(sample.picks.every((pick) => pick.because.includes("declares no Product"))).toBe(true);

    const chooser = new PatternChooser(BOOK_PATTERNS);
    const src = sources();
    const result = ok(
      await compileTemplate({ spec: specFor(BOOK_FIELDS), fields: BOOK_FIELDS, sample, sources: src, chooser, now: NOW, templateKey: "fixtures/template/{slug}", entry: { mode: "direct", url: urls[0]! } }),
    );

    const { manuscript, compiled } = result;
    expect(manuscript.sample.picks.every((pick) => pick.bound)).toBe(true);
    const tier3 = manuscript.tiers.find((tier) => tier.tier === 3)!;
    expect(tier3.outcome, tier3.because).toBe("ran");
    expect(tier3.asked).toEqual(["title", "price", "availability"]);
    expect(tier3.covered).toEqual(["title", "price", "availability"]);
    expect(manuscript.verdict).toBe("covered");
    for (const field of manuscript.fields) {
      expect(field.tier, field.field).toBe(3);
      expect(field.source).toBe("dom");
      expect(field.decision?.answeredBy).toBe("recorded");
      expect(field.decision?.question).toBe(`field.${field.field}`);
    }
    // One batch, one question per field, and nothing about a field twice.
    expect(chooser.questions().map((question) => question.id)).toEqual(["field.title", "field.price", "field.availability"]);
    expect(src.rendered).toHaveLength(1);

    const scraper = compiled.scraper;
    expect(Object.keys(scraper.fields)).toEqual(["title", "price", "availability"]);
    expect(scraper.fields.price!.alternatives[0]!.selector).toBe("p.price_color");
    expect(scraper.fields.price!.alternatives[0]!.source).toBeUndefined();

    // The rationale names the question and who answered it, and stops claiming
    // no model was involved in a scraper a model chose.
    const rationale = renderRationale(compiled.rationale);
    expect(rationale).toContain("Decided by **recorded**, asked `field.price`");
    expect(rationale).toContain("tier-3 column(s) (title, price, availability) were chosen during the investigation by recorded");

    // Replay: a fresh page through the compiled scraper, and not one more question.
    const asked = chooser.questions().length;
    const page = await browser.context.newPage();
    try {
      await page.goto(url("books-2"));
      const extraction = await extractPage(page, scraper, { sourceUrl: url("books-2") });
      expect(extraction.values).toEqual({ title: "The Salt Orchard", price: "£23.88", availability: "In stock (3 available)" });
    } finally {
      await page.close();
    }
    expect(chooser.questions()).toHaveLength(asked);
  });
});

describe("a page that declares half: tier 3 is asked for the other half only", () => {
  it("binds name and sku at tier 1 and asks the chooser about price alone", async () => {
    const urls = ["mixed-1", "mixed-2", "mixed-3"].map(url);
    const fields: RequestedField[] = [{ name: "name" }, { name: "sku" }, { name: "price" }];
    const chooser = new PatternChooser({ name: /h1/, sku: /h1/, price: /price-current/ });
    const result = ok(
      await compileTemplate({ spec: specFor(fields), fields, sample: await sampleOf(urls), sources: sources(), chooser, now: NOW, templateKey: "fixtures/template/{slug}", entry: { mode: "direct", url: urls[0]! } }),
    );
    const byName = new Map(result.manuscript.fields.map((field) => [field.field, field]));
    expect(byName.get("name")?.tier).toBe(1);
    expect(byName.get("sku")?.tier).toBe(1);
    expect(byName.get("price")?.tier).toBe(3);

    // KTD2: exactly the price question, and no DOM question about a field the
    // page already declared.
    expect(chooser.questions().map((question) => question.id)).toEqual(["field.price"]);
    const tier3 = result.manuscript.tiers.find((tier) => tier.tier === 3)!;
    expect(tier3.asked).toEqual(["price"]);

    const scraper = result.compiled.scraper;
    expect(scraper.fields.name!.alternatives[0]!.source).toBe("json-ld");
    expect(scraper.fields.sku!.alternatives[0]!.source).toBe("json-ld");
    expect(scraper.fields.price!.alternatives[0]!.selector).toBe("span.price-current");
    expect(scraper.chooser).toBe("agent");
  });
});

describe("the selector gate has the last word on a tier-3 answer", () => {
  it("refuses a styling-only selector the chooser picked, with the gate's reason, and reports the field not obtainable", async () => {
    const urls = ["styled-1", "styled-2", "styled-3"].map(url);
    const fields: RequestedField[] = [{ name: "title" }, { name: "price" }];
    const chooser = new PatternChooser({ title: /^[^=]*h1 = /, price: /£/ });
    const result = ok(
      await compileTemplate({ spec: specFor(fields), fields, sample: await sampleOf(urls), sources: sources(), chooser, now: NOW, templateKey: "fixtures/template/{slug}", entry: { mode: "direct", url: urls[0]! } }),
    );
    const price = result.manuscript.fields.find((field) => field.field === "price")!;
    expect(price.path).toBeUndefined();
    expect(price.because).toContain("the selector gate refused it");
    expect(price.because).toContain("presentation-only");
    expect(price.rejected.some((rejection) => rejection.tier === 3 && rejection.because.includes("presentation-only"))).toBe(true);

    const notObtainable = result.reconciliation.notObtainable.find((field) => field.field === "price");
    expect(notObtainable?.because).toContain("presentation-only");
    // Tier 3 ran and answered; it is not "still asked".
    expect(notObtainable?.stillAsked).toBe(false);
    expect(Object.keys(result.compiled.scraper.fields)).toEqual(["title"]);
  });
});

describe("tier 3 without a chooser", () => {
  it("is recorded as requested and binds nothing, which is what every run was before U4", async () => {
    const urls = ["books-1", "books-2"].map(url);
    const src = sources();
    const result = await compileTemplate({
      spec: specFor(BOOK_FIELDS),
      fields: BOOK_FIELDS,
      sample: await sampleOf(urls),
      sources: src,
      now: NOW,
      templateKey: "fixtures/template/{slug}",
      entry: { mode: "direct", url: urls[0]! },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("empty");
    const tier3 = result.manuscript.tiers.find((tier) => tier.tier === 3)!;
    expect(tier3.outcome).toBe("requested");
    expect(tier3.because).toContain("no DOM compiler was supplied");
    expect(src.rendered).toHaveLength(0);
    expect(result.reconciliation?.notObtainable.every((field) => field.stillAsked)).toBe(true);
  });

  it("says so when opening the chooser fails, rather than throwing out of the investigation", async () => {
    const urls = ["books-1"].map(url);
    const result = await compileTemplate({
      spec: specFor(BOOK_FIELDS),
      fields: BOOK_FIELDS,
      sample: await sampleOf(urls),
      sources: sources(),
      chooser: () => Promise.reject(new Error("no credential for any chooser")),
      now: NOW,
      templateKey: "fixtures/template/{slug}",
      entry: { mode: "direct", url: urls[0]! },
    });
    const tier3 = result.manuscript.tiers.find((tier) => tier.tier === 3)!;
    expect(tier3.outcome).toBe("requested");
    expect(tier3.because).toContain("no credential for any chooser");
  });
});
