import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileFromReconciliation } from "../src/compile/index.js";
import { flatten, type Leaf } from "../src/investigate/leaves.js";
import type { FieldRecord, InventoryRecord, Manuscript } from "../src/investigate/manuscript.js";
import { outputSchema, reconcile, render, summarize, tracedAlternatives } from "../src/reconcile/index.js";
import { judgeAlternatives, judgeDeterminism, summarizeDeterminism, type AlternativesReading, type UrlAlternatives } from "../src/replay/determinism.js";
import type { Spec } from "../src/spec/schema.js";

/**
 * U6b: two alternatives of one field that disagree are two fields.
 *
 * The case this file is built on is the one the plan says no prompt wording
 * could have found. A compile gave `promoPrice` two alternatives — the payload
 * leaf it was bound to and a DOM node that read the same number on all three
 * binding samples, which is what made the selector an honest fallback and let
 * it through the gate. On the first Monday the node read a different number,
 * because the club promotion had gone live. **Neither alternative is wrong.**
 * A ranking would have committed one of them and thrown away a price the page
 * states; dropping the "bad" one would have done the same thing silently.
 *
 * So the three assertions that matter here are not "does the code run":
 *
 *  1. the two readings each trace to their own leaf and come out as **two
 *     columns**, and both reach the compiled scraper bound to their own leaf;
 *  2. alternatives that agree produce nothing at all — no record, no column,
 *     no sentence — because a stage that reports on the quiet case teaches a
 *     reader to skip it;
 *  3. a value with **no leaf behind it** is reported and never bound. That is
 *     the confident direction the 2026-09-22 defects went in, and it is the
 *     one this file would rather fail than pass.
 *
 * The fixtures are synthetic. The *shape* is the one investigated on
 * 2026-09-22 — a `prices` map keyed by dashed currency codes carrying a list
 * and a sale price, an `appliedPromotions` block restating the sale price, and
 * a `promotions` array whose entries carry `isClubPromotion` — and the names,
 * values and endpoint are invented, because navvi is a public repository and a
 * client's catalogue is not test data.
 */

const DIR = join(import.meta.dirname, "fixtures", "split");
const MATCH = "catalog-service/products/detail";
const AT = new Date("2026-09-23T15:04:05.000Z");

const payloads = [1, 2, 3].map((n) => JSON.parse(readFileSync(join(DIR, `detail-${n}.json`), "utf8")) as unknown);
const samples: Leaf[][] = payloads.map((payload) => flatten(payload));

/** The leaf the requested column is bound to, the leaf behind the other reading, and the numbers on the page the block names. */
const SALE_PATH = "productData.prices[price-sale-std]";
const CLUB_PATH = "productData.promotions[1].promotionalPrice";
const SALE = [3321, 10392, 6741];
const CLUB = [2952, 9990, 5990];

/**
 * The leaf catalogue `Manuscript.inventory` carries: every path present on
 * every answering sample, with no type filter.
 *
 * Unanchored on purpose. Anchoring is U4's signal for "available but not
 * requested" and has nothing to say about a trace — the trace asks which leaf
 * of this call carried this value, and a leaf the page never showed a reader
 * is still a leaf this call returned.
 */
function inventory(): InventoryRecord[] {
  const byPath = new Map<string, Leaf["value"][]>();
  for (const [index, leaves] of samples.entries()) {
    for (const leaf of leaves) {
      let values = byPath.get(leaf.path);
      if (!values) byPath.set(leaf.path, (values = Array.from({ length: samples.length }, () => undefined as never)));
      values[index] = leaf.value;
    }
  }
  return [...byPath]
    .filter(([, values]) => values.every((value) => value !== undefined))
    .map(([path, values]) => ({ match: MATCH, path, values }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

const LEAVES = inventory();

function valuesAt(path: string): Leaf["value"][] {
  return LEAVES.find((leaf) => leaf.path === path)!.values;
}

function record(over: Partial<FieldRecord> & { field: string }): FieldRecord {
  return { aliases: [], because: "", askModel: false, rejected: [], verdicts: [], ...over };
}

function manuscript(over: Partial<Manuscript> = {}): Manuscript {
  return {
    version: 1,
    site: "tienda.ejemplo.cl",
    recordedAt: "2026-09-23T12:00:00.000Z",
    requested: [
      { name: "productName", type: "text" },
      { name: "listPrice", type: "money" },
      { name: "promoPrice", type: "money" },
    ],
    sample: { because: "three articles off one template", considered: 91, picks: [], unfilled: [], excluded: [] },
    tiers: [
      {
        tier: 2,
        name: "payload",
        outcome: "ran",
        because: "1 endpoint the page fetched for itself, over 3 rendered sample(s)",
        asked: ["productName", "listPrice", "promoPrice"],
        covered: ["productName", "listPrice", "promoPrice"],
        sources: [{ url: `https://tienda.ejemplo.cl/${MATCH}`, kind: "payload", status: 200, match: MATCH, found: samples[0]!.length, because: "the page fetched this for itself" }],
        verdicts: [],
      },
    ],
    fields: [
      record({
        field: "productName",
        type: "text",
        tier: 2,
        source: "network",
        match: MATCH,
        path: "productData.name",
        values: valuesAt("productData.name"),
        because: "key-names-carry-the-signal fired on productData.name",
      }),
      record({
        field: "listPrice",
        type: "money",
        tier: 2,
        source: "network",
        match: MATCH,
        path: "productData.prices[price-list-std]",
        values: valuesAt("productData.prices[price-list-std]"),
        aliases: ["productData.price"],
        because: "key-names-carry-the-signal fired on price-list-std",
      }),
      record({
        field: "promoPrice",
        type: "money",
        tier: 2,
        source: "network",
        match: MATCH,
        path: SALE_PATH,
        values: valuesAt(SALE_PATH),
        // The payload states the sale price twice and the two agree on every
        // sample, so this is a free alternative and not a second reading.
        aliases: ["productData.appliedPromotions[price-sale-std].promotionalPrice"],
        because: "key-names-carry-the-signal fired on price-sale-std",
      }),
    ],
    uncovered: [],
    inventory: LEAVES,
    obstacles: [],
    canaryBecause: "recorded off the first sample",
    verdict: "covered",
    because: "3 of 3 requested fields bound",
    ...over,
  };
}

const SPEC: Spec = {
  version: 1,
  brief: "I need the price of a dynamic set of articles.",
  target: { site: "tienda.ejemplo.cl", pageKind: "product", provenance: "brief" },
  entity: { name: "article", provenance: "brief" },
  inputs: { shape: "url_list", description: "a dynamic set of articles", provenance: "brief" },
  fields: [
    { name: "productName", provenance: "inferred" },
    { name: "listPrice", provenance: "inferred" },
    { name: "promoPrice", provenance: "inferred" },
  ],
  constraints: { freshness: { stated: false }, volume: { stated: false }, cadence: { stated: false }, budget: { stated: false } },
  rubrics: [],
  openQuestions: [],
};

// ------------------------------------------------------- the replay observation

/**
 * Six URLs, read three times each, with **every** alternative resolved rather
 * than stopping at the first that answers.
 *
 * Six and three are U6a's own defaults, so the counts in the block are the
 * counts the plan's transcript shows. The first URL is the article in
 * `detail-1.json`, which is what makes 3321 and 2952 traceable numbers rather
 * than decoration.
 */
function monday(dom: readonly number[] = CLUB): UrlAlternatives[] {
  const network = [SALE[0]!, SALE[1]!, SALE[2]!, SALE[0]!, SALE[1]!, SALE[2]!];
  const shown = [dom[0]!, dom[1]!, dom[2]!, dom[0]!, dom[1]!, dom[2]!];
  return network.map((value, index) => ({
    url: `https://tienda.ejemplo.cl/a/${200001 + index}`,
    readings: Array.from(
      { length: 3 },
      (): AlternativesReading => ({
        promoPrice: [
          { source: "network", value },
          { source: "dom", value: shown[index]! },
        ],
        listPrice: [{ source: "network", value: 4290 + index }],
      }),
    ),
  }));
}

describe("the replay observation: alternatives of one field, resolved together", () => {
  it("reports a disagreement that is repeatable, on the count of URLs and not of findings", () => {
    const [disagreement, ...rest] = judgeAlternatives(monday(), { fields: ["listPrice", "promoPrice"] });

    expect(rest).toEqual([]);
    expect(disagreement!.field).toBe("promoPrice");
    expect(disagreement!.readings).toEqual([
      { source: "network", value: 3321 },
      { source: "dom", value: 2952 },
    ]);
    expect(disagreement!.disagreedOn).toBe(6);
    expect(disagreement!.readOn).toBe(6);
    expect(disagreement!.because).toContain("neither of them is wrong");
    // Nothing here is a finding about a broken scraper, so the words a healer
    // reacts to are not in the record at all.
    const json = JSON.stringify(disagreement);
    for (const finding of ["repairs", "failures", "healed", "drift", "rejected"]) expect(json).not.toContain(`"${finding}"`);
  });

  it("says nothing at all when the alternatives agree, and nothing about a field carrying one", () => {
    // `listPrice` carries a single alternative on every page, which is the
    // ordinary case: there is nothing for two readings to disagree about.
    expect(judgeAlternatives(monday(SALE), { fields: ["listPrice", "promoPrice"] })).toEqual([]);
  });

  it("leaves a field whose readings move between replays to U6a, which rejects it", () => {
    // The same page read three times, with the DOM alternative flipping. That
    // is the measurement moving — U6a's axis — and a field cannot be both
    // unstable and a source of two facts, so U6b stands down.
    const flaky: UrlAlternatives[] = [
      {
        url: "https://tienda.ejemplo.cl/a/200001",
        readings: [
          { promoPrice: [{ source: "network", value: 3321 }, { source: "dom", value: 2952 }] },
          { promoPrice: [{ source: "network", value: 3321 }, { source: "dom", value: 3321 }] },
          { promoPrice: [{ source: "network", value: 3321 }, { source: "dom", value: 2952 }] },
        ],
      },
    ];
    expect(judgeAlternatives(flaky, { fields: ["promoPrice"] })).toEqual([]);

    const moved = judgeDeterminism(
      [{ url: "https://tienda.ejemplo.cl/a/200001", readings: [[{ promoPrice: 2952 }], [{ promoPrice: 3321 }], [{ promoPrice: 2952 }]] }],
      { fields: ["promoPrice"], now: AT },
    );
    expect(moved.verdict).toBe("unstable");
  });
});

// ----------------------------------------------------------------- the split

describe("the split: each reading traced back to its own leaf", () => {
  const split = () => reconcile(manuscript(), SPEC, { now: AT, disagreements: judgeAlternatives(monday(), { fields: ["promoPrice"] }) });

  it("emits a second column bound to the club entry in promotions[], and keeps the first one where it was", () => {
    const result = split();

    expect(result.obtainable.map((field) => field.field)).toEqual(["productName", "listPrice", "promoPrice", "clubPrice"]);

    const promo = result.obtainable.find((field) => field.field === "promoPrice")!;
    expect(promo.path).toBe(SALE_PATH);
    expect(promo.values).toEqual(SALE);
    expect(promo.splitFrom).toBeUndefined();

    const club = result.obtainable.find((field) => field.field === "clubPrice")!;
    expect(club.path).toBe(CLUB_PATH);
    expect(club.match).toBe(MATCH);
    expect(club.source).toBe("network");
    expect(club.values).toEqual(CLUB);
    expect(club.type).toBe("money");
    expect(club.typeInferred).toBe(false);
    expect(club.splitFrom).toBe("promoPrice");
  });

  it("names it out of the payload's own words: the flag on the array entry, and the client's noun", () => {
    const club = split().obtainable.find((field) => field.field === "clubPrice")!;
    // `promotions[1]` is a position and names nothing; `isClubPromotion` is
    // what the payload calls that entry, minus the word the container already
    // said. `Price` is the client's own last word for the column it asked for.
    expect(club.where).toBe(`network ${MATCH} ${CLUB_PATH}`);
    expect(club.because).toContain("a field nobody had asked for");
  });

  it("does not rank, does not drop, and leaves nothing for a person to decide", () => {
    const result = split();
    const disagreement = result.disagreements!.find((entry) => entry.field === "promoPrice")!;

    expect(disagreement.readings.map((reading) => reading.outcome)).toEqual(["requested", "split"]);
    expect(disagreement.readings[0]!.leaf).toBe(SALE_PATH);
    expect(disagreement.readings[1]!.leaf).toBe(CLUB_PATH);
    expect(disagreement.emitted).toEqual(["clubPrice"]);
    expect(disagreement.unaccounted).toBe(false);
    expect(disagreement.decision).toBeUndefined();
    expect(disagreement.because).toContain("Neither reading was ranked and neither was dropped.");
    expect(result.verdict).not.toBe("open");
  });

  it("stops calling the leaf 'available but not requested' once it is a column", () => {
    expect(reconcile(manuscript(), SPEC, { now: AT }).available.map((leaf) => leaf.path)).toContain(CLUB_PATH);
    expect(split().available.map((leaf) => leaf.path)).not.toContain(CLUB_PATH);
  });

  it("reads the sale price's second spelling as one fact rather than a third field", () => {
    // `appliedPromotions[price-sale-std].promotionalPrice` carries 3321 too. It
    // agrees with the bound leaf on every sample, so it is that leaf's alias
    // and the trace resolves to the binding rather than refusing.
    const disagreement = split().disagreements!.find((entry) => entry.field === "promoPrice")!;
    expect(disagreement.readings[0]!.outcome).toBe("requested");
    expect(split().obtainable.map((field) => field.field)).not.toContain("promotionalPrice");
  });

  it("counts the requested fields, not the rows, so a split does not read as coverage", () => {
    expect(summarize(split())).toContain("obtainable          3 of 3 + 1 split");
    expect(render(split())).toContain("## Obtainable (3 of 3, plus 1 split out of a disagreement)");
  });
});

// ------------------------------------------------- a value with no leaf behind it

describe("a value with no leaf behind it is itself the finding", () => {
  const unaccounted = () =>
    reconcile(manuscript(), SPEC, { now: AT, disagreements: judgeAlternatives(monday([2499, 9199, 5499]), { fields: ["promoPrice"] }) });

  it("reports it, and invents no binding for it", () => {
    const result = unaccounted();
    const disagreement = result.disagreements!.find((entry) => entry.field === "promoPrice")!;

    expect(disagreement.unaccounted).toBe(true);
    expect(disagreement.readings[1]!.outcome).toBe("unaccounted");
    expect(disagreement.readings[1]!.leaf).toBeUndefined();
    expect(disagreement.emitted).toEqual([]);
    expect(result.obtainable.map((field) => field.field)).toEqual(["productName", "listPrice", "promoPrice"]);
    // Nothing anywhere in the artifact binds 2499.
    expect(JSON.stringify(result.obtainable)).not.toContain("2499");
  });

  it("says what a person has to do, and holds the reconciliation open until they do it", () => {
    const result = unaccounted();
    const disagreement = result.disagreements!.find((entry) => entry.field === "promoPrice")!;

    expect(disagreement.readings[1]!.because).toContain("The page is showing something this call did not return");
    expect(disagreement.decision).toContain("a capture of the page's own traffic");
    expect(result.verdict).toBe("open");
  });

  it("refuses to trace at all when the manuscript carries no leaf catalogue", () => {
    const { inventory: _drop, ...thin } = manuscript();
    const result = reconcile(thin as Manuscript, SPEC, { now: AT, disagreements: judgeAlternatives(monday(), { fields: ["promoPrice"] }) });
    const disagreement = result.disagreements!.find((entry) => entry.field === "promoPrice")!;

    expect(disagreement.readings.every((reading) => reading.outcome === "refused")).toBe(true);
    expect(disagreement.emitted).toEqual([]);
    // Not `unaccounted`: answering "no leaf" off a catalogue that cannot see
    // the leaf would be the loudest finding navvi has, produced by an accident
    // of which types the brief happened to name.
    expect(disagreement.unaccounted).toBe(false);
    expect(disagreement.decision).toContain("no leaf catalogue");
  });

  it("refuses when the derived name is already a column, rather than renaming or overwriting", () => {
    const asked: Spec = { ...SPEC, fields: [...SPEC.fields, { name: "clubPrice", provenance: "inferred" }] };
    const taken = manuscript({ requested: [...manuscript().requested, { name: "clubPrice", type: "money" }] });
    const result = reconcile(taken, asked, { now: AT, disagreements: judgeAlternatives(monday(), { fields: ["promoPrice"] }) });
    const disagreement = result.disagreements!.find((entry) => entry.field === "promoPrice")!;

    expect(disagreement.emitted).toEqual([]);
    expect(disagreement.readings[1]!.outcome).toBe("refused");
    expect(disagreement.readings[1]!.because).toContain("is already a column");
    expect(result.verdict).toBe("open");
  });
});

// ------------------------------------------------------------ the compile reach

describe("the split reaches the compiled scraper", () => {
  it("compiles promoPrice and clubPrice as two columns, each bound to its own leaf", () => {
    const reconciliation = reconcile(manuscript(), SPEC, { now: AT, disagreements: judgeAlternatives(monday(), { fields: ["promoPrice"] }) });
    const { scraper, unbound } = compileFromReconciliation(reconciliation, manuscript(), SPEC, {
      templateKey: "tienda.ejemplo.cl/a/{id}",
      entry: { mode: "direct", url: "https://tienda.ejemplo.cl/a/200001" },
      now: AT,
    });

    expect(unbound).toEqual([]);
    expect(Object.keys(scraper.fields).sort()).toEqual(["clubPrice", "listPrice", "productName", "promoPrice"]);

    const promo = scraper.fields.promoPrice!.alternatives[0]!;
    expect(promo.source).toBe("network");
    expect(promo.match).toBe(MATCH);
    expect(promo.path).toBe(SALE_PATH);

    const club = scraper.fields.clubPrice!.alternatives[0]!;
    expect(club.source).toBe("network");
    expect(club.match).toBe(MATCH);
    expect(club.path).toBe(CLUB_PATH);
    // Two leaves, two fingerprints, and neither is the other's fallback.
    expect(club.fingerprint.samples).toEqual(["2952", "9990", "5990"]);
    expect(promo.fingerprint.samples).toEqual(["3321", "10392", "6741"]);
    expect(scraper.fields.clubPrice!.type).toBe("money");
  });

  it("puts both in the output schema, so the client's columns say what they now have", () => {
    const reconciliation = reconcile(manuscript(), SPEC, { now: AT, disagreements: judgeAlternatives(monday(), { fields: ["promoPrice"] }) });
    const schema = outputSchema(reconciliation, SPEC, { now: AT });

    expect(schema.fields.map((field) => field.name)).toEqual(["productName", "listPrice", "promoPrice", "clubPrice"]);
    expect(schema.fields.at(-1)!.path).toBe(CLUB_PATH);
    expect(schema.fields.at(-1)!.example).toBe(2952);
  });
});

// ------------------------------------------------------------- the stage block

describe("the stage block the plan's transcript shows", () => {
  it("prints the disagreement and the trace under the determinism stage", () => {
    const observed = judgeAlternatives(monday(), { fields: ["promoPrice"] });
    const reconciliation = reconcile(manuscript(), SPEC, { now: AT, disagreements: observed });
    const determinism = judgeDeterminism(
      monday().map(({ url }) => ({ url, readings: Array.from({ length: 3 }, () => [{ promoPrice: 3321 }]) })),
      { fields: ["promoPrice"], now: AT },
    );

    const block = summarizeDeterminism({ ...determinism, alternatives: tracedAlternatives(reconciliation, observed) }, "work/tienda/determinism.json").split("\n");

    expect(block[0]).toBe("determinism   3 replays x 6 URLs, 0 fields moved      work/tienda/determinism.json");
    expect(block[1]).toBe("  ! promoPrice  network 3321 vs dom 2952 on 6 of 6 - alternatives disagree");
    expect(block[2]).toBe(`                traced: network 3321 is ${SALE_PATH}, dom 2952 is ${CLUB_PATH}`);
    expect(block[3]).toBe("                -> split into promoPrice and clubPrice, both bound to their leaf");
  });

  it("names the untraceable reading in the same block rather than in a second one", () => {
    const observed = judgeAlternatives(monday([2499, 9199, 5499]), { fields: ["promoPrice"] });
    const reconciliation = reconcile(manuscript(), SPEC, { now: AT, disagreements: observed });
    const traced = tracedAlternatives(reconciliation, observed);

    expect(traced[0]!.traced).toEqual([
      `traced: network 3321 is ${SALE_PATH}, dom 2499 is nothing this call returned`,
      "-> the page is showing something this call did not return; nothing is bound to it",
    ]);
  });

  it("leaves `traced` absent when nobody traced anything", () => {
    const observed = judgeAlternatives(monday(), { fields: ["promoPrice"] });
    // A reconciliation that was never handed the observation has no trace to
    // give, and saying so is not the same as saying the values matched nothing.
    expect(tracedAlternatives(reconcile(manuscript(), SPEC, { now: AT }), observed)[0]!.traced).toBeUndefined();
  });

  it("puts the new column on the reconcile block and in reconcile.md", () => {
    const reconciliation = reconcile(manuscript(), SPEC, { now: AT, disagreements: judgeAlternatives(monday(), { fields: ["promoPrice"] }) });

    expect(summarize(reconciliation)).toContain("split               promoPrice: network 3321 vs dom 2952");
    expect(summarize(reconciliation)).toContain("-> clubPrice from promotionalPrice, bound to its own leaf");
    const markdown = render(reconciliation);
    expect(markdown).toContain("## Alternatives that disagreed (1)");
    expect(markdown).toContain("**1 new column(s):** `clubPrice`");
    expect(markdown).toContain(`\`${CLUB_PATH}\``);
  });
});

// --------------------------------------------------------- the two disciplines

describe("the artifact's two disciplines still hold with a split in it", () => {
  const split = () => reconcile(manuscript(), SPEC, { now: AT, disagreements: judgeAlternatives(monday(), { fields: ["promoPrice"] }) });

  it("is JSON-serialisable, with no Map, Date or class instance in it", () => {
    const result = split();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("is stable: the same manuscript, observation and clock produce the same bytes", () => {
    expect(JSON.stringify(split())).toBe(JSON.stringify(split()));
    expect(render(split())).toBe(render(split()));
  });

  it("tells absent from empty: nobody asked, against asked and nothing disagreed", () => {
    expect(reconcile(manuscript(), SPEC, { now: AT }).disagreements).toBeUndefined();
    expect(reconcile(manuscript(), SPEC, { now: AT, disagreements: [] }).disagreements).toEqual([]);
    expect(render(reconcile(manuscript(), SPEC, { now: AT, disagreements: [] }))).toContain("Every field's alternatives returned the same value");
  });
});
