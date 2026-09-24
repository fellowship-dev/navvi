import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bank } from "../src/heuristics/index.js";
import { investigate, type Sources } from "../src/investigate/investigate.js";
import { anchors, flatten } from "../src/investigate/leaves.js";
import type { Manuscript, RequestedField } from "../src/investigate/manuscript.js";
import { chooseSample, type UrlProbe } from "../src/investigate/sample.js";

/**
 * U6c: the two rules that reject a value without being told what the web is.
 *
 * The defect they answer is one row. A store's product page had gone, the store
 * answered with itself, and what came back still had a name, a sku and a price
 * on it — so it passed every "did it extract?" check and would have entered a
 * price index as a product called after the shop.
 *
 * There are two ways to catch that. One is to know the vocabulary the page is
 * written in and read only the node that is typed as a product; that is a
 * different unit, it lives in `tests/declared.test.ts`, and it is worth having.
 * The other is the claim this file is here to prove: **you do not need the
 * vocabulary at all.** A value that is the same on every sample is describing
 * the site, the session or the build rather than the record, and that is
 * decidable from the samples alone.
 *
 * So nothing below names a vocabulary, a node type or a markup dialect — there
 * is a test at the bottom that reads this file and fails if it starts to. What
 * it names instead is two addresses, three requested fields and which of them
 * survived.
 */

const DIR = join(import.meta.dirname, "fixtures", "not-a-field");

/**
 * Two addresses that answer with the store's landing page, carrying the sku of
 * the address that was asked for. See `fixtures/not-a-field/README.md`.
 */
const SKUS = ["883052", "883099"] as const;
const URLS = SKUS.map((sku) => `https://tienda.ejemplo.test/p/${sku}`);

const FIELDS: RequestedField[] = [
  { name: "sku", type: "text" },
  { name: "productName", type: "text" },
  { name: "listPrice", type: "money" },
];

/**
 * The real cascade, from the sample choice down. Tier 1 only: one plain HTTP
 * request per address and no `capture`, which is what these pages cost in the
 * live run too.
 */
async function run(): Promise<Manuscript> {
  const sample = chooseSample(
    URLS.map((url) => ({ url, status: 200, hasDeclaredProduct: undefined, priceCount: 1, inStock: true }) satisfies UrlProbe),
    { size: 2 },
  );
  const bodies = new Map(SKUS.map((sku, index) => [URLS[index]!, readFileSync(join(DIR, `store-landing-${sku}.html`), "utf8")]));
  const sources: Sources = { fetch: (url: string) => Promise.resolve({ url, status: 200, body: bodies.get(url) ?? "" }) };
  return investigate({ site: "tienda.ejemplo.test", fields: FIELDS, sample, sources, now: new Date("2026-09-23T18:00:00.000Z") });
}

const field = (manuscript: Manuscript, name: string): Manuscript["fields"][number] => manuscript.fields.find((entry) => entry.field === name)!;

describe('U6c: "Store A" on every sample, rejected', () => {
  it("refuses the name, and says which rule refused it and why", async () => {
    const name = field(await run(), "productName");

    // Not bound at any tier. This is the whole verification: the row that would
    // have been indexed has no name on it.
    expect(name.tier).toBeUndefined();
    expect(name.path).toBeUndefined();

    const rejection = name.rejected.find((entry) => entry.values.length === 2)!;
    expect(rejection.tier).toBe(1);
    expect(rejection.values).toEqual(["Store A", "Store A"]);

    const verdict = name.verdicts.find((entry) => entry.id === "no-variation-no-field")!.verdict;
    expect(verdict.fires).toBe(true);
    expect(verdict.because).toBe('productName is "Store A" on all 2 samples');
    expect(verdict.action).toBe("reject this candidate: it is describing the site, not the record");
    // The manuscript carries the reason, not just the outcome: the rejection is
    // written in the rule's words rather than restated in the cascade's.
    expect(rejection.because).toBe(verdict.because);
  });

  it("refuses the price that survived on the same two pages", async () => {
    const price = field(await run(), "listPrice");
    expect(price.tier).toBeUndefined();
    const verdict = price.verdicts.find((entry) => entry.id === "no-variation-no-field")!.verdict;
    expect(verdict.fires).toBe(true);
    expect(verdict.because).toBe('listPrice is "14990" on all 2 samples');
  });

  /**
   * And the half that makes it a rule rather than a refusal to answer. The sku
   * comes off the same two pages, through the same tier, in the same pass — and
   * it is different on each, so it is allowed through. A filter that rejected
   * all three would prove nothing at all.
   */
  it("lets the sku through, because the sku is the one thing that varies", async () => {
    const sku = field(await run(), "sku");
    expect(sku.tier).toBe(1);
    expect(sku.values).toEqual([...SKUS]);
    const verdict = sku.verdicts.find((entry) => entry.id === "no-variation-no-field")!.verdict;
    expect(verdict.fires).toBe(false);
    expect(verdict.because).toContain("2 distinct values");
  });

  /**
   * The claim, made checkable. If a future edit reaches for the vocabulary to
   * explain this rejection, the explanation stops being the one U6c proves and
   * this fails. The patterns are assembled at run time so the guard is not
   * itself a match — the guard has to cover the guard.
   */
  it("never mentions the vocabulary the page happens to be written in", () => {
    const source = readFileSync(join(import.meta.dirname, "not-a-field.test.ts"), "utf8");
    const forbidden = ["schema" + ".org", "@" + "type", "@" + "graph", "json" + "-ld", "micro" + "data", "Open" + "Graph"];
    expect(forbidden.filter((pattern) => source.includes(pattern))).toEqual([]);
  });
});

/**
 * The other half of U6c, and the rule that had to be written: a value can vary
 * on every sample and still not be a fact about the record.
 *
 * `machine-value-is-not-a-fact` decides that on two observations. One is the
 * value's own shape. The other is whether any page ever showed it to a reader —
 * and that question is answered by `anchors()`, which lives in
 * `src/investigate/leaves.ts`. The heuristic cannot call it: `heuristics` is
 * vocabulary and may not import a stage. So the caller answers it and hands the
 * answer over as a boolean, and this is the test of that seam: `anchors` is
 * imported here, run over the real payload, and its answer — never the page
 * text — is what the bank is given.
 */
describe("U6c: a value that varies, that no reader ever saw", () => {
  const payload = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "investigate", "store-b-detail.json"), "utf8")) as unknown;
  const PAGE_TEXT = "Ejemplo Comprimidos 100 mg 30 Comprimidos $ 4.990 $ 4.491 Club Store B $ 3.992 Laboratorio Ejemplo";

  /** One leaf of the payload, as `InventoryRecord` carries it: path, values, anchored. */
  function observe(path: string): { path: string; values: unknown[]; anchored: boolean } {
    const leaf = flatten(payload).find((entry) => entry.path === path)!;
    return { path, values: [leaf.value], anchored: anchors(leaf.value, PAGE_TEXT) };
  }

  it("rejects the millisecond the response was built", () => {
    const observation = observe("productData.telemetry.renderedAt");
    expect(observation.anchored).toBe(false);
    const verdict = bank().run("machine-value-is-not-a-fact", observation);
    expect(verdict.fires).toBe(true);
    expect(verdict.because).toContain("epoch milliseconds");
    expect(verdict.action).toContain("not a fact about the record");
  });

  it("leaves the price alone: the page showed it to a reader", () => {
    const observation = observe("productData.prices[price-list-std]");
    expect(observation.anchored).toBe(true);
    const verdict = bank().run("machine-value-is-not-a-fact", observation);
    expect(verdict.fires).toBe(false);
    expect(verdict.because).toContain("not the machine talking to itself");
  });

  /**
   * The boundary `src/reconcile/schema.ts` draws and this rule had to live
   * with: reconcile declines to blacklist key names, because "guessing which
   * key names are noise is a word list nobody can check". So a key that says
   * `telemetry.sessionId` in as many words, holding a value too short to be
   * evidence of anything, is *not* rejected. It stays in the catalogue for a
   * reader to dismiss, and the verdict says that is what happened.
   */
  it("will not reject a leaf on the strength of its key name", () => {
    const observation = observe("productData.telemetry.sessionId");
    expect(observation.anchored).toBe(false);
    const verdict = bank().run("machine-value-is-not-a-fact", observation);
    expect(verdict.fires).toBe(false);
    expect(verdict.because).toContain("this rule does not reject on a key name");
    expect(verdict.because).toContain("session");
  });

  /**
   * Tier 1 does not anchor, on purpose: a declared sku is rendered nowhere and
   * an availability renders as a word rather than as its machine reading. So
   * tier 1 hands this rule no anchor evidence at all, and the rule must answer
   * "I have nothing" rather than "no reader saw it".
   */
  it("says it has no evidence when nobody looked, rather than reading that as a no", () => {
    const verdict = bank().run("machine-value-is-not-a-fact", { path: "sku", values: ["8820237", "8820238"] });
    expect(verdict.fires).toBe(false);
    expect(verdict.because).toContain("nothing says whether a reader was shown");
  });
});
