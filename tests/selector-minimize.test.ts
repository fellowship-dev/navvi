import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { getCandidates, resolveLeaf } from "../src/browser/snapshot.js";
import type { Answer, Chooser, ChooserUsage, Question } from "../src/chooser/chooser.js";
import { chooseRecordFields } from "../src/compile/compile.js";
import { auditSelector, gateAlternative } from "../src/compile/gate.js";
import { domTier } from "../src/compile/template.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * Selector minimization (2026-09-24). A record compile on a product page with
 * several prices reached tier 3 for a list price; the chooser picked the right
 * element -- the struck-through list price -- and its selector was a
 * fourteen-step `:scope > body > …` path, because the snapshot tried one
 * ancestor and then gave up to the document root. The gate refused it as the
 * field's only reading, and the field ended unbound with the right node picked.
 *
 * The fixtures under `tests/fixtures/minimize/` are synthetic: a recently
 * viewed strip of tiles whose prices use the same `span.strike-through.list >
 * span.value` markup, ahead of the main block's `div.prices > div.price > del
 * > span.strike-through.list > span.value` and its sale `span.sales >
 * span.value`. `product-bundle.html` adds a second `div.prices` (a bundle
 * offer) ahead of the main one, so a selector unique on the other samples is
 * ambiguous there.
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

const PRODUCTS = ["/fixtures/minimize/product-1.html", "/fixtures/minimize/product-2.html", "/fixtures/minimize/product-3.html"];
const LIST_PRICES = ["$12.990", "$8.490", "$23.500"];

async function open(path: string): Promise<Page> {
  const page = await browser.context.newPage();
  await page.goto(`${server.baseUrl}${path}`);
  return page;
}

/** Answers each field by a pattern over the offered option labels, `none` otherwise. */
class PatternChooser implements Chooser {
  readonly name = "recorded" as const;
  readonly batches: Question[][] = [];
  constructor(private readonly patterns: Record<string, RegExp>) {}
  async ask(batch: Question[]): Promise<Answer[]> {
    this.batches.push(batch);
    return batch.map((question) => {
      const key = question.id.replace(/^(field|list)\./, "").replace(/\.retry$/, "");
      const pattern = this.patterns[key];
      const index = pattern === undefined ? -1 : (question.options ?? []).findIndex((option) => pattern.test(option));
      return { id: question.id, index: index < 0 ? null : index };
    });
  }
  usage(): ChooserUsage {
    return { chooser: this.name, questions: this.batches.flat().length, textQuestions: 0, batches: this.batches.length, inputTokens: 0, outputTokens: 0, waitMs: 0, costUsd: 0, zeroDataRetention: "not_applicable" };
  }
}

const count = (page: Page, selector: string): Promise<number> => page.evaluate((s) => document.documentElement.querySelectorAll(s).length, selector);

describe("leaf selectors are minimized, not anchored at the document root", () => {
  it("the struck list price among three price blocks gets a short, unique, gate-passing selector", async () => {
    const page = await open(PRODUCTS[0]!);
    try {
      const { leaves } = await getCandidates(page);
      const list = leaves.find((l) => l.text === "$12.990" && !l.attr)!;
      expect(list).toBeDefined();
      expect(list.selector).not.toMatch(/^:scope|\bbody\b/);
      expect(list.selector).not.toMatch(/nth-of-type/);
      expect(auditSelector(list.selector).depth).toBeLessThanOrEqual(3);
      expect(gateAlternative(list.selector, "dom", { sole: true }).ok).toBe(true);
      expect(await count(page, list.selector)).toBe(1);
      expect(await resolveLeaf(page, { selector: list.selector })).toBe("$12.990");

      const sale = leaves.find((l) => l.text === "$9.990" && !l.attr)!;
      expect(sale.selector).not.toMatch(/^:scope|nth-of-type/);
      expect(await count(page, sale.selector)).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("tier 3 binds the chosen list price on three samples instead of the gate refusing it", async () => {
    const pages = await Promise.all(PRODUCTS.map(open));
    try {
      const chooser = new PatternChooser({ listPrice: new RegExp(` = ${LIST_PRICES.map((v) => v.replace(/[$.]/g, "\\$&")).join(" \\| ")}$`) });
      const tier = domTier({ render: (_urls, use) => use(pages), chooser });
      const answer = await tier({ fields: [{ name: "listPrice" }], urls: pages.map((p) => p.url()) });
      expect(answer.refused).toEqual([]);
      expect(answer.bindings.map((b) => b.field)).toEqual(["listPrice"]);
      const binding = answer.bindings[0]!;
      expect(binding.values).toEqual(LIST_PRICES);
      expect(binding.selector).not.toMatch(/^:scope|\bbody\b|nth-of-type/);
      for (const [i, page] of pages.entries()) {
        expect(await count(page, binding.selector)).toBe(1);
        expect(await resolveLeaf(page, { selector: binding.selector })).toBe(LIST_PRICES[i]);
      }
    } finally {
      for (const page of pages) await page.close();
    }
  });

  it("a selector unique on one sample but ambiguous on another is not offered as that sample's value", async () => {
    const pages = await Promise.all([PRODUCTS[0]!, PRODUCTS[1]!, "/fixtures/minimize/product-bundle.html"].map(open));
    try {
      const chooser = new PatternChooser({});
      const choice = (await chooseRecordFields({ pages, fields: [{ name: "listPrice" }], chooser }))!;
      expect(choice).not.toBeNull();
      // The main block's list price reads $23.500 on the bundle page; the bundle's $44.000 comes first in the document.
      const leaked = choice.candidates.filter((c) => !c.multiple && c.values.includes("$44.000") && c.values[0] === "$12.990");
      expect(leaked.map((c) => c.selector)).toEqual([]);
      expect(await resolveLeaf(pages[2]!, { selector: "div.prices span.value", unique: true })).toBeNull();
    } finally {
      for (const page of pages) await page.close();
    }
  });
});
