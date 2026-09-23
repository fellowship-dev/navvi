import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPLAYS,
  DEFAULT_SAMPLE_URLS,
  isUnstable,
  judgeDeterminism,
  measureDeterminism,
  readingOf,
  summarizeDeterminism,
  unstableFields,
  type AlternativeDisagreement,
  type ItemValues,
  type PageReading,
  type UrlReadings,
} from "../src/replay/determinism.js";
import type { PageExtraction } from "../src/scraper/extract.js";

/**
 * U6a: the same page, read N times.
 *
 * The unit is worth one sentence: on 2026-09-22 a replay reported **33 repairs
 * and 3 failures** against pages that had not changed and a scraper that had
 * not broken, and every one of those 36 findings was the measurement moving.
 * The verification is therefore not "does the code run" but "does that exact
 * shape now come out as measurement rather than as findings", and both halves
 * of that have to be pinned: the phantom findings are rejected, **and** a field
 * that holds still still passes, **and** a page that genuinely changed is not
 * called instability.
 *
 * A rule that rejects everything would pass the first assertion alone, which is
 * why it is never asserted alone in this file.
 */

const CLOCK = new Date("2026-09-23T15:04:05.000Z");
const FIELDS = ["sku", "listPrice", "promoPrice", "stock"] as const;

interface Fixture {
  note: string[];
  urls: UrlReadings[];
}

function phantom(): Fixture {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "determinism", "phantom-2026-09-22.json"), "utf8")) as Fixture;
}

/**
 * What replay did on 2026-09-22, and the only reason it lives in this file:
 * without it, 33 and 3 are magic numbers and the fixture could quietly stop
 * being the incident.
 *
 * It is the arithmetic of the fixture rather than a second spelling of anything
 * `src` owns today — the committed reading against the next one, where a
 * differing non-empty value is a repair and a required field that came back
 * empty is a failure. That is the comparison the healer makes, and it is right
 * about a page that changed. It is wrong here because the page did not.
 */
function asFindings(sample: readonly UrlReadings[], required: readonly string[]): { repairs: number; failures: number } {
  let repairs = 0;
  let failures = 0;
  for (const { readings } of sample) {
    const committed = readings[0]?.[0];
    const live = readings[1]?.[0];
    if (committed === undefined || live === undefined) continue;
    for (const field of new Set([...Object.keys(committed), ...Object.keys(live)])) {
      const was = committed[field];
      const now = live[field];
      if (Object.is(was, now)) continue;
      if (required.includes(field) && (now === null || now === undefined || now === "")) failures++;
      else repairs++;
    }
  }
  return { repairs, failures };
}

// ------------------------------------------------- the incident, both readings

describe("the 33 phantom repairs and 3 phantom failures of 2026-09-22", () => {
  it("the fixture really is that shape: a replay that trusts its second reading finds 33 repairs and 3 failures", () => {
    const { urls } = phantom();
    expect(urls).toHaveLength(36);
    // Every URL is read three times, and nobody edited a page in between.
    expect(new Set(urls.map((entry) => entry.readings.length))).toEqual(new Set([3]));
    expect(asFindings(urls, ["stock"])).toEqual({ repairs: 33, failures: 3 });
  });

  it("determinism calls all 36 measurement: two fields rejected, nothing repaired and nothing failed", () => {
    const determinism = judgeDeterminism(phantom().urls, { site: "farmacia.ejemplo.cl", fields: [...FIELDS], now: CLOCK });

    expect(determinism.verdict).toBe("unstable");
    expect(unstableFields(determinism)).toEqual(["listPrice", "stock"]);

    // The 33 and the 3 are still both there, and they are both counts of URLs
    // on which a field would not hold still — not counts of findings.
    const moved = Object.fromEntries(determinism.fields.map((field) => [field.field, field]));
    expect(moved.listPrice!.outcome).toBe("moved");
    expect(moved.listPrice!.movedOn).toBe(33);
    expect(moved.listPrice!.readOn).toBe(36);
    expect(moved.stock!.outcome).toBe("moved");
    expect(moved.stock!.movedOn).toBe(3);
    expect(moved.stock!.readOn).toBe(36);

    // And the artifact has nowhere to put a finding even if something wanted
    // to: no repair, no failure, no drift, no healed alternative. The 36 that
    // were findings are 36 URLs on which a field would not hold still, and the
    // only decision recorded about any of them is the rejection of two fields.
    expect(Object.keys(determinism).sort()).toEqual(["because", "fields", "recordedAt", "replays", "site", "urls", "verdict", "version"]);
    for (const field of determinism.fields) expect(["held", "moved", "absent"]).toContain(field.outcome);
    expect(determinism.fields.reduce((total, field) => total + field.movedOn, 0)).toBe(36);
    expect(determinism.fields.filter((field) => field.rejected)).toHaveLength(2);
    const json = JSON.stringify(determinism);
    for (const finding of ["repairs", "failures", "healed", "drift"]) expect(json).not.toContain(`"${finding}"`);
  });

  it("and a healer asking about a rejected field is told no", () => {
    const determinism = judgeDeterminism(phantom().urls, { fields: [...FIELDS], now: CLOCK });
    expect(isUnstable(determinism, "listPrice")).toBe(true);
    expect(isUnstable(determinism, "stock")).toBe(true);
    // The converse in the same breath, because a predicate that always says
    // "unstable" would satisfy the two lines above on its own.
    expect(isUnstable(determinism, "sku")).toBe(false);
    expect(isUnstable(determinism, "promoPrice")).toBe(false);
    expect(isUnstable(determinism, "neverHeardOfIt")).toBe(false);
  });

  it("the rejection names what moved, what it moved between, and on how many URLs", () => {
    const determinism = judgeDeterminism(phantom().urls, { site: "farmacia.ejemplo.cl", fields: [...FIELDS], now: CLOCK });
    const listPrice = determinism.fields.find((field) => field.field === "listPrice")!;

    expect(listPrice.movements[0]!.url).toBe("https://farmacia.ejemplo.cl/producto/1");
    // Two forms, and the flicker is visible in the counts: 1037 twice, 299 once.
    expect(listPrice.movements[0]!.forms).toEqual([
      { values: [1037], readings: 2 },
      { values: [299], readings: 1 },
    ]);
    expect(listPrice.because).toContain("moved on 33 of the 36 URLs");
    expect(listPrice.because).toContain("the measurement and not the site");

    const stock = determinism.fields.find((field) => field.field === "stock")!;
    expect(stock.movements[0]!.forms).toEqual([
      { values: [true], readings: 2 },
      { values: [null], readings: 1 },
    ]);
  });

  it("holding still is still possible on the same sample", () => {
    const determinism = judgeDeterminism(phantom().urls, { fields: [...FIELDS], now: CLOCK });
    for (const name of ["sku", "promoPrice"]) {
      const field = determinism.fields.find((entry) => entry.field === name)!;
      expect(field.outcome).toBe("held");
      expect(field.rejected).toBe(false);
      expect(field.movements).toEqual([]);
      expect(field.readOn).toBe(36);
    }
  });
});

// ----------------------------------------------------------- the two questions

describe("across runs is not across samples", () => {
  /** Six different products, three identical readings each: exactly what a healthy sample looks like. */
  function healthy(): UrlReadings[] {
    return Array.from({ length: DEFAULT_SAMPLE_URLS }, (_unused, index) => {
      const item: ItemValues = { sku: `900${index}`, listPrice: 1000 + index * 110, stock: index !== 4 };
      return { url: `https://farmacia.ejemplo.cl/p/${index}`, readings: Array.from({ length: DEFAULT_REPLAYS }, () => [{ ...item }]) };
    });
  }

  it("values that differ from URL to URL are not movement", () => {
    const determinism = judgeDeterminism(healthy(), { site: "farmacia.ejemplo.cl", fields: ["sku", "listPrice", "stock"], now: CLOCK });
    expect(determinism.verdict).toBe("stable");
    expect(unstableFields(determinism)).toEqual([]);
    expect(determinism.fields.map((field) => field.outcome)).toEqual(["held", "held", "held"]);
    // listPrice takes six distinct values across the six URLs and that is the
    // point of a sample. The across-samples question — a value identical on
    // every URL — belongs to `no-variation-no-field`, and nothing here answers
    // it in either direction.
    expect(determinism.because).toContain("says the same thing twice");
  });

  it("a field identical on every URL is not this stage's problem either", () => {
    // The StoreA defect: productName is the site's name on all of them.
    // It holds still across runs, which is all U6a is entitled to say.
    const sample = healthy().map((entry) => ({ ...entry, readings: entry.readings.map((reading) => reading.map((item) => ({ ...item, productName: "Farmacia Ejemplo" }))) }));
    const determinism = judgeDeterminism(sample, { now: CLOCK });
    expect(determinism.fields.find((field) => field.field === "productName")!.outcome).toBe("held");
    expect(determinism.verdict).toBe("stable");
  });

  it("a page that genuinely changed is not called instability", () => {
    // Every reading of every URL agrees with itself; every one of them
    // disagrees with what was committed last month. That is drift, it is the
    // healer's finding, and this stage is silent about it by construction: it
    // never sees the committed values and has no way to ask.
    const committed = { sku: "9000", listPrice: 1000, stock: true };
    const today = { sku: "9000", listPrice: 4990, stock: false };
    const sample: UrlReadings[] = [{ url: "https://farmacia.ejemplo.cl/p/0", readings: [[{ ...today }], [{ ...today }], [{ ...today }]] }];
    const determinism = judgeDeterminism(sample, { fields: ["sku", "listPrice", "stock"], now: CLOCK });

    expect(determinism.verdict).toBe("stable");
    expect(unstableFields(determinism)).toEqual([]);
    expect(determinism.fields.every((field) => field.outcome === "held")).toBe(true);
    // And the committed values are genuinely nowhere in the artifact, so the
    // silence is structural rather than a threshold that happened not to fire.
    expect(JSON.stringify(determinism)).not.toContain(String(committed.listPrice));
  });
});

// ------------------------------------------------------- what "moved" means

describe("what counts as movement", () => {
  const judge = (a: ItemValues, b: ItemValues) =>
    judgeDeterminism([{ url: "https://farmacia.ejemplo.cl/p/0", readings: [[a], [b]] }], { now: CLOCK }).fields[0]!;

  it("whitespace, letter case and accents are formatting, not movement", () => {
    expect(judge({ name: "  Paracetamol   500 mg " }, { name: "Paracetamol 500 mg" }).outcome).toBe("held");
    expect(judge({ name: "SIN STOCK" }, { name: "sin stock" }).outcome).toBe("held");
    expect(judge({ name: "Ibuprofeno jarabe" }, { name: "Ibuprofeno járabe" }).outcome).toBe("held");
  });

  it("a re-ordered listing is the site shuffling rows, not a field moving", () => {
    const first: PageReading = [{ price: 1990 }, { price: 2990 }, { price: 3990 }];
    const shuffled: PageReading = [{ price: 3990 }, { price: 1990 }, { price: 2990 }];
    const determinism = judgeDeterminism([{ url: "https://farmacia.ejemplo.cl/listado", readings: [first, shuffled] }], { now: CLOCK });
    expect(determinism.fields[0]!.outcome).toBe("held");

    // But a row whose value changed is movement, at the same row count.
    const changed: PageReading = [{ price: 3990 }, { price: 1990 }, { price: 2491 }];
    expect(judgeDeterminism([{ url: "https://farmacia.ejemplo.cl/listado", readings: [first, changed] }], { now: CLOCK }).fields[0]!.outcome).toBe("moved");
  });

  it("a listing that emptied is movement, which is the phantom failure at page scale", () => {
    const rows: PageReading = [{ price: 1990 }, { price: 2990 }];
    const determinism = judgeDeterminism([{ url: "https://farmacia.ejemplo.cl/listado", readings: [rows, []] }], { fields: ["price"], now: CLOCK });
    expect(determinism.fields[0]!.outcome).toBe("moved");
    expect(determinism.fields[0]!.movements[0]!.forms.map((form) => form.values.length)).toEqual([2, 0]);
    expect(summarizeDeterminism(determinism)).toContain("no items");
  });

  it("this errs strict: the same quantity written two ways is movement, and the declared type is what settles it", () => {
    // A field left as text ships the string, so the string moving moves the
    // client's column. Nothing here re-parses it back into agreement.
    expect(judge({ listPrice: "$ 6.990" }, { listPrice: "$6,990" }).outcome).toBe("moved");
    // The same field declared `money` was coerced before this saw it, and then
    // there is nothing to disagree about. The type decides, not this file.
    expect(judge({ listPrice: 6990 }, { listPrice: 6990 }).outcome).toBe("held");
    // And the coercion itself moving is movement: a number one run and its own
    // text the next is the harder half of the same defect to see.
    expect(judge({ listPrice: 6990 }, { listPrice: "6990" }).outcome).toBe("moved");
  });

  it("null, absent and false are three things", () => {
    expect(judge({ stock: null }, { stock: false }).outcome).toBe("moved");
    expect(judge({ stock: null }, {}).outcome).toBe("moved");
    expect(judge({ stock: "null" }, { stock: null }).outcome).toBe("moved");
    expect(judge({ stock: null }, { stock: null }).outcome).toBe("held");
  });
});

// ------------------------------------------------------- a sample that cannot tell

describe("a sample that could not disagree with itself", () => {
  it("one reading each is insufficient, which is neither stable nor a rejection", () => {
    const sample: UrlReadings[] = [{ url: "https://farmacia.ejemplo.cl/p/0", readings: [[{ listPrice: 1990 }]] }];
    const determinism = judgeDeterminism(sample, { fields: ["listPrice"], now: CLOCK });
    expect(determinism.verdict).toBe("insufficient");
    expect(unstableFields(determinism)).toEqual([]);
    expect(determinism.fields[0]!.outcome).toBe("held");
    expect(determinism.fields[0]!.because).toContain("it has not been asked");
    expect(determinism.because).toContain("This is not stability");
    // Unreadable in the block would be indistinguishable from the one-line
    // stable case, so the block says it.
    expect(summarizeDeterminism(determinism)).toContain("insufficient");
  });

  it("an empty sample is insufficient too, rather than vacuously stable", () => {
    expect(judgeDeterminism([], { now: CLOCK }).verdict).toBe("insufficient");
  });

  it("a URL read once does not vote for agreement alongside URLs read three times", () => {
    const moving: PageReading[] = [[{ listPrice: 1990 }], [{ listPrice: 2990 }], [{ listPrice: 1990 }]];
    const sample: UrlReadings[] = [
      { url: "https://farmacia.ejemplo.cl/p/0", readings: moving },
      { url: "https://farmacia.ejemplo.cl/p/1", readings: [[{ listPrice: 3990 }]] },
    ];
    const determinism = judgeDeterminism(sample, { fields: ["listPrice"], now: CLOCK });
    expect(determinism.verdict).toBe("unstable");
    // Read on both, moved on the only one that could answer.
    expect(determinism.fields[0]!.readOn).toBe(2);
    expect(determinism.fields[0]!.movedOn).toBe(1);
    expect(determinism.urls).toEqual([
      { url: "https://farmacia.ejemplo.cl/p/0", readings: 3 },
      { url: "https://farmacia.ejemplo.cl/p/1", readings: 1 },
    ]);
  });
});

// ------------------------------------------------------------- the artifact

describe("determinism.json", () => {
  it("is JSON-serialisable and survives a round trip unchanged", () => {
    const determinism = judgeDeterminism(phantom().urls, { site: "farmacia.ejemplo.cl", fields: [...FIELDS], now: CLOCK });
    expect(JSON.parse(JSON.stringify(determinism))).toEqual(determinism);
    expect(determinism.version).toBe(1);
  });

  it("is stable: the same readings produce the same artifact, and the clock is the only thing a re-run moves", () => {
    const options = { site: "farmacia.ejemplo.cl", fields: [...FIELDS] };
    const first = judgeDeterminism(phantom().urls, { ...options, now: CLOCK });
    const again = judgeDeterminism(phantom().urls, { ...options, now: CLOCK });
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));

    const later = judgeDeterminism(phantom().urls, { ...options, now: new Date("2026-10-01T00:00:00.000Z") });
    expect(later.recordedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(JSON.stringify({ ...later, recordedAt: first.recordedAt })).toBe(JSON.stringify(first));
  });

  it("keeps the spec's field order, and never re-sorts by outcome", () => {
    const determinism = judgeDeterminism(phantom().urls, { fields: [...FIELDS], now: CLOCK });
    // listPrice and stock moved; they stay where the client asked for them, so
    // a diff between two determinism runs is a real change and not a re-rank.
    expect(determinism.fields.map((field) => field.field)).toEqual([...FIELDS]);
  });

  it("appends a field the spec did not declare rather than dropping it", () => {
    const sample: UrlReadings[] = [{ url: "https://farmacia.ejemplo.cl/p/0", readings: [[{ listPrice: 1, bonus: 2, alpha: 3 }], [{ listPrice: 1, bonus: 2, alpha: 3 }]] }];
    expect(judgeDeterminism(sample, { fields: ["listPrice"], now: CLOCK }).fields.map((field) => field.field)).toEqual(["listPrice", "alpha", "bonus"]);
  });

  it("a declared field nothing offered is absent, not unstable", () => {
    const sample: UrlReadings[] = [{ url: "https://farmacia.ejemplo.cl/p/0", readings: [[{ listPrice: 1 }], [{ listPrice: 1 }]] }];
    const determinism = judgeDeterminism(sample, { fields: ["listPrice", "bioequivalence"], now: CLOCK });
    const missing = determinism.fields[1]!;
    expect(missing.outcome).toBe("absent");
    expect(missing.rejected).toBe(false);
    expect(missing.because).toContain("coverage question");
    expect(determinism.verdict).toBe("stable");
  });
});

// ------------------------------------------------------------ the stage block

describe("the stage block", () => {
  it("a stable run is the one line the plan's transcript shows", () => {
    const sample: UrlReadings[] = Array.from({ length: 6 }, (_unused, index) => ({
      url: `https://farmacia.ejemplo.cl/p/${index}`,
      readings: Array.from({ length: 3 }, () => [{ listPrice: 1000 + index }]),
    }));
    const determinism = judgeDeterminism(sample, { fields: ["listPrice"], now: CLOCK });
    expect(summarizeDeterminism(determinism, "work/storeb/determinism.json")).toBe(
      "determinism   3 replays x 6 URLs, 0 fields moved      work/storeb/determinism.json\n",
    );
  });

  it("an unstable run names every field that will not be committed", () => {
    const determinism = judgeDeterminism(phantom().urls, { fields: [...FIELDS], now: CLOCK });
    const block = summarizeDeterminism(determinism, "work/farmacia/determinism.json").split("\n");
    expect(block[0]).toBe("determinism   3 replays x 36 URLs, 2 fields moved     work/farmacia/determinism.json");
    expect(block[1]).toBe("  ! listPrice   1037 then 299 on 33 of 36 - rejected, not repaired");
    expect(block[2]).toBe("  ! stock       true then null on 3 of 36 - rejected, not repaired");
    expect(block[3]).toBe("");
  });

  it("U6b's finding has somewhere to live, and U6a does not invent one", () => {
    const stable = judgeDeterminism(
      [{ url: "https://storeb.ejemplo.cl/p/880330", readings: [[{ promoPrice: 3321 }], [{ promoPrice: 3321 }]] }],
      { fields: ["promoPrice"], now: CLOCK },
    );
    // The alternatives are perfectly repeatable and each is right about a
    // different thing, so U6a has nothing to say and says nothing.
    expect(stable.verdict).toBe("stable");
    expect(stable.alternatives).toBeUndefined();

    const alternatives: AlternativeDisagreement[] = [
      {
        field: "promoPrice",
        readings: [
          { source: "network", value: 3321 },
          { source: "dom", value: 2952 },
        ],
        disagreedOn: 6,
        readOn: 6,
        because: "two alternatives of one field return different values on the same page",
        traced: ["traced: the dom value is the club promotion in promotions[],", "live only on Mondays and Thursdays, not a key under prices"],
      },
    ];
    const block = summarizeDeterminism({ ...stable, alternatives }, "work/storeb/determinism.json").split("\n");
    expect(block[0]).toBe("determinism   2 replays x 1 URLs, 0 fields moved      work/storeb/determinism.json");
    expect(block[1]).toBe("  ! promoPrice  network 3321 vs dom 2952 on 6 of 6 - alternatives disagree");
    expect(block[2]).toBe("                traced: the dom value is the club promotion in promotions[],");
    expect(block[3]).toBe("                live only on Mondays and Thursdays, not a key under prices");
  });
});

// ----------------------------------------------------------------- the driver

describe("the driver", () => {
  it("reads round by round, so two readings of one URL are not served by the same warm cache", async () => {
    const order: string[] = [];
    const determinism = await measureDeterminism(
      ["https://farmacia.ejemplo.cl/a", "https://farmacia.ejemplo.cl/b"],
      {
        read: (url, round) => {
          order.push(`${round}:${url.split("/").at(-1)}`);
          return Promise.resolve([{ listPrice: url.endsWith("a") ? 1990 : 2990 }]);
        },
      },
      { fields: ["listPrice"], now: CLOCK },
    );
    expect(order).toEqual(["0:a", "0:b", "1:a", "1:b", "2:a", "2:b"]);
    expect(determinism.replays).toBe(DEFAULT_REPLAYS);
    expect(determinism.verdict).toBe("stable");
  });

  it("carries a moving field through from the driver to a rejection", async () => {
    let round = 0;
    const determinism = await measureDeterminism(
      ["https://farmacia.ejemplo.cl/a"],
      { read: () => Promise.resolve([{ listPrice: round++ === 1 ? 2952 : 3321 }]) },
      { fields: ["listPrice"], now: CLOCK },
    );
    expect(unstableFields(determinism)).toEqual(["listPrice"]);
  });

  it("a URL listed twice is one page, not two votes", async () => {
    const determinism = await measureDeterminism(
      ["https://farmacia.ejemplo.cl/a", "https://farmacia.ejemplo.cl/a"],
      { read: () => Promise.resolve([{ listPrice: 1990 }]) },
      { replays: 2, now: CLOCK },
    );
    expect(determinism.urls).toEqual([{ url: "https://farmacia.ejemplo.cl/a", readings: 2 }]);
  });

  it("a read that fails is not swallowed into a stable verdict", async () => {
    await expect(
      measureDeterminism(["https://farmacia.ejemplo.cl/a"], { read: () => Promise.reject(new Error("net::ERR_ABORTED")) }, { now: CLOCK }),
    ).rejects.toThrow("net::ERR_ABORTED");
  });

  it("readingOf takes the items and coerces them to the declared types", () => {
    const extraction: PageExtraction = {
      values: { listPrice: "$ 6.990", stock: "Sin stock" },
      resolvedBy: { listPrice: 0, stock: 0 },
      sourceUrl: "https://farmacia.ejemplo.cl/p/0",
      items: [
        { values: { listPrice: "$ 6.990", stock: "Sin stock" }, resolvedBy: { listPrice: 0, stock: 0 }, sourceUrl: "https://farmacia.ejemplo.cl/p/0" },
        { values: { listPrice: "$ 12.990", stock: "Disponible" }, resolvedBy: { listPrice: 0, stock: 0 }, sourceUrl: "https://farmacia.ejemplo.cl/p/0" },
      ],
    };
    // Two items, not three: record mode repeats its one item at the top level
    // and reading both would count it twice.
    expect(readingOf(extraction, { listPrice: "money", stock: "boolean" })).toEqual([
      { listPrice: 6990, stock: false },
      { listPrice: 12990, stock: true },
    ]);
  });
});
