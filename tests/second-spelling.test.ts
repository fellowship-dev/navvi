import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { extractCaptured, isUsableResponse, newestUsableResponse, pickResponse, type CapturedResponse } from "../src/browser/network-capture.js";
import { declares, declaredTypes, readDeclared, typedNodes } from "../src/declared/json.js";
import { bank } from "../src/heuristics/index.js";
import { injectedShapeOf } from "../src/browser/snapshot.js";
import { RecordedChooser, RecordedOptionsMismatchError, RECORD_OPTIONS_ENV, type RecordedAnswerFile } from "../src/chooser/recorded.js";
import { shapeOf } from "../src/scraper/extract.js";
import type { Question } from "../src/chooser/chooser.js";
import type { Shape } from "../src/scraper/schema.js";

/**
 * The second spelling (2026-09-22 test audit, §6.1).
 *
 * Four defects reached a live run past ~720 green tests, and all four were the
 * same shape: **a rule written once in `src`, written again somewhere else,
 * with only one copy pinned**. Each module passed its own tests forever while
 * the other copy drifted — a shell classified two ways, a capture walked four
 * ways, a helper copied "verbatim" from the consumer it was standing in for.
 *
 * > A test may not contain a second spelling of a rule `src` owns. If a test
 * > needs the rule, it imports it. If two `src` modules need it, one imports
 * > the other or a shared module. Where that is genuinely impossible — an
 * > injected page script, a recorded answer in a JSON file — a differential
 * > test over a corpus is **mandatory**, not optional.
 *
 * This file is that mandatory half, kept together so the guard is one visible
 * thing rather than a habit. Everything else was closed by deletion: the walk,
 * the summary literal and the premise strings now import what they used to
 * copy, and there is nothing left here to test about them beyond the source
 * guard below.
 */

// ------------------------------------------------------------------ shapeOf

/**
 * `shapeOf` in `src/scraper/extract.ts` is commented "Mirror of `shapeOf` in
 * snapshot.inject.js", and the injected copy cannot import from `src`: it is
 * evaluated as text inside a page. So the two are run over one corpus and have
 * to agree on every entry.
 *
 * The old test was named "shapeOf mirrors the snapshot classifier" and asserted
 * only the `src` side — the archetype of a name that outruns its assertion.
 */
describe("shapeOf: extract.ts and snapshot.inject.js classify the same corpus the same way", () => {
  const injected = injectedShapeOf();

  /**
   * Real values, not invented ones: every `fingerprint.samples` entry in the
   * compiled scrapers this repository ships. These are strings the compiler
   * actually captured from a rendered page and wrote into a scraper, which is
   * exactly the population the two classifiers have to agree about.
   */
  function capturedSamples(): string[] {
    const root = join(import.meta.dirname, "recorded", "compile");
    const out = new Set<string>();
    for (const fixture of readdirSync(root, { withFileTypes: true })) {
      if (!fixture.isDirectory()) continue;
      let text: string;
      try {
        text = readFileSync(join(root, fixture.name, "expected.json"), "utf8");
      } catch {
        continue;
      }
      JSON.parse(text, (key, value: unknown) => {
        if (key === "samples" && Array.isArray(value)) for (const v of value) if (typeof v === "string") out.add(v);
        return value;
      });
    }
    return [...out];
  }

  /**
   * Boundaries the shipped fixtures do not reach: every branch of both
   * classifiers, and the cases where a small edit to one regex would move a
   * string across a boundary in one copy only. Literals are the input here,
   * never the expected answer — nothing below says what shape any of these is.
   */
  const BOUNDARIES: readonly string[] = [
    "",
    " ",
    "\n  $ 1.000 \t",
    "42",
    " 42 ",
    "007",
    "-5",
    "+1,000",
    "1.234",
    "12.345.678",
    "1,5",
    "1.234,56",
    "1,234.56",
    "1.2345",
    "1.000.00",
    "1.2.3",
    "$ 6.990",
    "$12,990.00",
    "CLP 12.990",
    "USD 5",
    "US$ 5",
    "R$ 5",
    "(€10)",
    "5€",
    "12 pesos",
    "12.500 KWD",
    "precio: $ 990",
    "2026-09-22",
    "2026-09-22T18:04:09Z",
    "22/09/2026",
    "9/9/26",
    "Sep 3",
    "sept. 3, 2026",
    "3 de septiembre de 2026",
    "22 de mayo",
    "Marzo",
    "mayo 5",
    "3 days ago",
    "hace 3 días",
    "hace un rato",
    "https://tienda.ejemplo.cl/p/1",
    "HTTPS://TIENDA.EJEMPLO.CL/P/1",
    "http://a b",
    "ftp://x.cl/a",
    "/producto/paracetamol-500-mg",
    "Paracetamol 500 mg x 16 comprimidos",
    "Sin stock",
    "−5",
    "١٢٣",
  ];

  const ATTRS: readonly (string | undefined)[] = [undefined, "href", "src", "datetime", "title"];

  it("agrees on every value the shipped scrapers actually captured", () => {
    const samples = capturedSamples();
    // A corpus that silently emptied would make this test a no-op.
    expect(samples.length).toBeGreaterThan(20);
    const disagreements = samples.filter((text) => shapeOf(text) !== injected(text));
    expect(disagreements.map((text) => [text, shapeOf(text), injected(text)])).toEqual([]);
  });

  it("agrees on every boundary, for every attribute either copy special-cases", () => {
    const disagreements: Array<[string, string | undefined, Shape, Shape]> = [];
    for (const text of [...BOUNDARIES, ...capturedSamples()]) {
      for (const attr of ATTRS) {
        const mine = shapeOf(text, attr);
        const theirs = injected(text, attr);
        if (mine !== theirs) disagreements.push([text, attr, mine, theirs]);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("the corpus reaches every shape, so agreement is not agreement on one branch", () => {
    const reached = new Set<Shape>();
    for (const text of [...BOUNDARIES, ...capturedSamples()]) for (const attr of ATTRS) reached.add(shapeOf(text, attr));
    expect([...reached].sort()).toEqual(["date", "int", "money", "text", "url"]);
  });
});

// ------------------------------------------- the newest usable captured response

/**
 * There were four spellings of "the newest usable captured response": the walk
 * inside `resolveDeclared`, `pickResponse`, tier 2's `newestUsable`, and a copy
 * in `tests/har.test.ts` whose comment said "copied verbatim, because that is
 * the consumer". All four encoded the same Store B encounter — a detail
 * endpoint answering 401 before the page's anonymous session exists and 200
 * after — and no test compared any two.
 *
 * There is now one spelling, in `network-capture.ts`, and everything else calls
 * it. What is left to pin is that the callers that remain separate entry points
 * still resolve the same capture, and that no fifth copy grows back.
 */
describe("newest usable captured response: one rule, every consumer", () => {
  const detail = "https://api.store-b.example/catalog-svc/products/detail/880330";
  const stock = "https://api.store-b.example/stock-svc/inventory/880330";
  const responses: CapturedResponse[] = [
    { url: detail, status: 401, body: { error: "Unauthorized", errorCode: 401 } },
    { url: stock, status: 200, body: { stock: { available: 7 } } },
    { url: detail, status: 200, body: { productData: { prices: { "price-list-std": 3690 } } } },
    { url: detail, status: 503, body: { fault: "retry" } },
  ];

  it("a refusal is never an answer, whichever entry point asks", () => {
    // Unconstrained (tier 2's endpoint intersection): the 503 is skipped and
    // the 200 wins over the older 401, by recency among usable responses.
    expect(newestUsableResponse(responses)?.body).toEqual({ productData: { prices: { "price-list-std": 3690 } } });
    // Constrained by URL (a compiled `network` alternative's `match`).
    expect(newestUsableResponse(responses, { match: "/catalog-svc/products/detail/" })?.status).toBe(200);
    // Constrained by payload (`pickResponse`, and `extractCaptured` over it).
    expect(pickResponse(responses, "productData.prices[price-list-std]")?.url).toBe(detail);
    expect(extractCaptured(responses, { price: "productData.prices[price-list-std]", stock: "stock.available" })).toEqual({ price: 3690, stock: 7 });
    // And they all agree on the one thing that made the four copies dangerous.
    expect(responses.filter(isUsableResponse).map((r) => r.status)).toEqual([200, 200]);
  });

  it("an endpoint that only ever refused has no answer at all", () => {
    const refused: CapturedResponse[] = [
      { url: detail, status: 401, body: { errorCode: 401 } },
      { url: detail, status: 403, body: { errorCode: 403 } },
    ];
    expect(newestUsableResponse(refused)).toBeNull();
    expect(newestUsableResponse(refused, { match: "/catalog-svc/" })).toBeNull();
    expect(pickResponse(refused, "errorCode")).toBeNull();
    // A body the caller cannot read is not an answer either, even on a 200.
    expect(pickResponse([{ url: detail, status: 200, body: { other: 1 } }], "productData.price")).toBeNull();
  });

  it("no module writes the walk out again", () => {
    // The four copies were four `response.status` against `400` comparisons.
    // `isUsableResponse` is the only place that test may be written; a new copy
    // anywhere under src/, tests/, scripts/ or bin/ fails here rather than in a
    // live run. The pattern is assembled at run time so this file's own source
    // is not itself a match — the guard has to cover the guard.
    const copy = new RegExp("\\.status\\s*(?:>=|<)\\s*" + "4" + "00");
    const root = join(import.meta.dirname, "..");
    const owner = join("src", "browser", "network-capture.ts");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "recorded" && entry.name !== "fixtures") walk(rel);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
          if (rel === owner) continue;
          if (copy.test(readFileSync(join(root, rel), "utf8"))) offenders.push(rel);
        }
      }
    };
    for (const dir of ["src", "tests", "scripts", "bin", "tools"]) walk(dir);
    expect(offenders).toEqual([]);
    // And the owner really does still carry it, so an emptied regex reads as a
    // broken guard rather than a clean repository.
    expect(copy.test(readFileSync(join(root, owner), "utf8"))).toBe(true);
  });
});

// --------------------------------------------------- recorded answers and options

/**
 * A recorded answer is an **index**. Replaying it by question id alone assumes
 * the option at that index is still the option the live chooser saw, and
 * nothing checked that: a candidate-ordering change in `src/compile/fields.ts`
 * would have roughly forty recorded tests silently answer a *different*
 * candidate and stay green (audit §5.6). The recording is a second spelling of
 * a decision `src/compile` owns, and a JSON file cannot import anything — so
 * the recording states its options and the replay compares them.
 */
describe("recorded answers are checked against the options offered today", () => {
  const question = (options: string[]): Question => ({
    id: "field.price",
    kind: "choice",
    premise: "Which candidate holds the price value on every sample?",
    options,
    state: "Records: pharmacy product",
  });
  const OFFERED = ["aside/span = $ 6.990", "p/span = Laboratorio:"];

  function fixtureWith(answer: RecordedAnswerFile): { dir: string; file: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "navvi-recorded-"));
    mkdirSync(join(dir, "case"), { recursive: true });
    const file = join(dir, "case", `${answer.id}.json`);
    writeFileSync(file, JSON.stringify(answer, null, 2) + "\n");
    return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async function ask(recorded: RecordedAnswerFile, offered: string[], env: NodeJS.ProcessEnv = {}) {
    const fixture = fixtureWith(recorded);
    const warnings: string[] = [];
    const chooser = new RecordedChooser({ fixture: "case", dir: fixture.dir, env, warn: (m) => warnings.push(m) });
    const answers = await chooser.ask([question(offered)]);
    return { answers, warnings, chooser, ...fixture };
  }

  it("replays the recorded index when the options are the ones it answered", async () => {
    const run = await ask({ id: "field.price", index: 0, options: [...OFFERED] }, [...OFFERED]);
    expect(run.answers[0]!.index).toBe(0);
    expect(run.chooser.verifiedOptions).toBe(1);
    expect(run.chooser.unverifiedOptions).toEqual([]);
    expect(run.warnings).toEqual([]);
    run.cleanup();
  });

  it("refuses to answer when the options were reordered, renamed, added to or dropped", async () => {
    const recorded: RecordedAnswerFile = { id: "field.price", index: 0, options: [...OFFERED] };
    const drifted = [
      [OFFERED[1]!, OFFERED[0]!], // reordered: index 0 now names a different candidate
      ["main/aside/span = $ 6.990", OFFERED[1]!], // the candidate's path changed
      [...OFFERED, "footer/span = $ 1"], // a candidate appeared
      [OFFERED[0]!], // a candidate disappeared
    ];
    for (const offered of drifted) {
      const fixture = fixtureWith(recorded);
      const chooser = new RecordedChooser({ fixture: "case", dir: fixture.dir, env: {}, warn: () => undefined });
      await expect(chooser.ask([question(offered)])).rejects.toThrow(RecordedOptionsMismatchError);
      await expect(chooser.ask([question(offered)])).rejects.toThrow(/re-record with NAVVI_RECORD_OPTIONS=1/);
      fixture.cleanup();
    }
  });

  it("tolerates what is not the candidate: the sampled values and the fixture server's port", async () => {
    // One recorded fixture is replayed by callers that sample different pages
    // of the same site, and the test server binds a new port every run. Neither
    // is a change in which candidate the index names.
    const recorded = ["aside/span = $ 6.990 | $ 12.990", 'link "Next" -> http://127.0.0.1:*/fixtures/python-jobs.html?page=2'];
    const offeredToday = ["aside/span = $ 2.490 | $ 3.990", 'link "Next" -> http://127.0.0.1:53190/fixtures/python-jobs.html?page=2'];
    const run = await ask({ id: "field.price", index: 0, options: recorded }, offeredToday);
    expect(run.answers[0]!.index).toBe(0);
    expect(run.chooser.verifiedOptions).toBe(1);
    run.cleanup();
  });

  it("but not a different candidate wearing the same values", async () => {
    const fixture = fixtureWith({ id: "field.price", index: 0, options: ["aside/span = $ 6.990", "p/span = Laboratorio:"] });
    const chooser = new RecordedChooser({ fixture: "case", dir: fixture.dir, env: {}, warn: () => undefined });
    await expect(chooser.ask([question(["main/aside/span = $ 6.990", "p/span = Laboratorio:"])])).rejects.toThrow(RecordedOptionsMismatchError);
    fixture.cleanup();
  });

  it("a recording that predates the check is unverifiable, and says so once", async () => {
    const run = await ask({ id: "field.price", index: 1, note: "p/span" }, [...OFFERED]);
    // It still replays — the fixtures predate the field, and failing them all
    // would delete the suite rather than guard it.
    expect(run.answers[0]!.index).toBe(1);
    expect(run.chooser.verifiedOptions).toBe(0);
    expect(run.chooser.unverifiedOptions).toEqual(["field.price"]);
    expect(run.warnings.join("\n")).toContain(RECORD_OPTIONS_ENV);
    run.cleanup();
  });

  it(`${RECORD_OPTIONS_ENV}=1 writes today's options back into the recording`, async () => {
    const run = await ask({ id: "field.price", index: 1, note: "p/span" }, [...OFFERED], { [RECORD_OPTIONS_ENV]: "1" });
    const after = JSON.parse(readFileSync(run.file, "utf8")) as RecordedAnswerFile;
    expect(after.options).toEqual(OFFERED);
    // Everything else about the recording survives re-recording.
    expect(after.index).toBe(1);
    expect(after.note).toBe("p/span");
    run.cleanup();
  });

  it("the options never leak into the answer the chooser returns", async () => {
    const run = await ask({ id: "field.price", index: 0, note: "aside/span", options: [...OFFERED] }, [...OFFERED]);
    expect(Object.keys(run.answers[0]!).sort()).toEqual(["id", "index"]);
    run.cleanup();
  });

  /**
   * Every choice or score recording this repository ships either states its
   * options, or belongs to a lane this suite never replays.
   *
   * The two exempt lanes are `recorded/live/` (reachable only from the
   * `NAVVI_LIVE=1` gate) and the `claude`/`jev` chooser lanes of the
   * measurement harness (replayed only when those keys or CLIs are present).
   * Nothing else may be exempt: a new recording written into a lane CI does
   * replay, without its options, fails here rather than quietly replaying an
   * index against options nobody checked.
   */
  it("every recording a CI lane replays carries the options it answered", () => {
    const root = join(import.meta.dirname, "recorded");
    const exempt = (relative: string): boolean =>
      relative.startsWith(`live${sep}`) || /^measure\b.*\b(claude|jev)\b/.test(relative.split(sep).join(" "));
    const withOptions: string[] = [];
    const unchecked: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".json")) continue;
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        // Answer files only; a manifest carries neither `id` nor `kind`.
        if (typeof parsed.id !== "string" || typeof parsed.kind !== "string") continue;
        if (parsed.kind !== "choice" && parsed.kind !== "score") continue;
        const relative = path.slice(root.length + 1);
        if (Array.isArray(parsed.options)) withOptions.push(relative);
        else if (!exempt(relative)) unchecked.push(relative);
      }
    };
    walk(root);
    expect(unchecked).toEqual([]);
    // And the check really is carried by a large body of recordings, so an
    // accidental strip reads as a failure rather than a clean repository.
    expect(withOptions.length).toBeGreaterThanOrEqual(171);
  });
});

// ------------------------------------------------- reading a declared JSON block

/**
 * There were four spellings of "read a path out of a declared JSON block,
 * optionally only off a node the site typed `Product`": `readJsonPath`/`isType`
 * in `src/scraper/extract.ts`, `typedNodes` in `src/investigate/declared.ts`,
 * the `json-ld-needs-product-node` gate in `src/heuristics/rules/bind.ts`, and
 * `readPath` in `src/browser/network-capture.ts`. Two of them carried comments
 * asserting the others agreed with them, which is the strongest form this
 * defect takes: a second spelling with a note saying it is not one.
 *
 * They disagreed about `@graph`. JSON-LD 1.1 allows its value to be a node
 * object *or* an array of node objects; replay accepted both and the other
 * three required an array. So a block shaped `"@graph": {"@type":"Product"}`
 * was read by replay and refused by the gate that exists to keep replay honest
 * — the gate saying "this page declares no product" about a page replay was
 * already binding. `docs/adr/0001-one-declared-json-reader.md` rules for
 * replay's reading and moves the walk into `src/declared/json.ts`.
 *
 * Both halves are pinned here: the differential over the two `@graph` shapes,
 * and a source guard so a fifth copy cannot grow back.
 */
describe("a declared JSON block: one walk, one answer", () => {
  /** StoreA's real shape: several typed nodes in an array-valued `@graph`. */
  const arrayGraph = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": ["Organization", "OnlineStore"], name: "StoreA", url: "https://store-a.example/" },
      { "@type": "WebSite", name: "StoreA" },
      { "@type": "Product", name: "Norvasc (R) Amlodipino 5mg 30 Comprimidos", sku: "2562507", offers: { price: "3690" } },
    ],
  };

  /** The same declaration with one node, which JSON-LD 1.1 §4.9 permits. */
  const objectGraph = {
    "@context": "https://schema.org",
    "@graph": { "@type": "Product", name: "Norvasc (R) Amlodipino 5mg 30 Comprimidos", sku: "2562507", offers: { price: "3690" } },
  };

  it("an object-valued @graph is a graph, to the gate and the read alike", () => {
    for (const [shape, block] of [["array", arrayGraph], ["object", objectGraph]] as const) {
      expect(declares(block, "Product"), `${shape} @graph: declares`).toBe(true);
      expect(typedNodes(block, "Product"), `${shape} @graph: typedNodes`).toHaveLength(1);
      expect(readDeclared(block, "name", "Product"), `${shape} @graph: name`).toBe("Norvasc (R) Amlodipino 5mg 30 Comprimidos");
      expect(readDeclared(block, "offers.price", "Product"), `${shape} @graph: price`).toBe("3690");
      // The heuristic is the fourth entry point and rides the same walk, so it
      // may not say "no declared product" about a block replay would bind.
      expect(bank().run("json-ld-needs-product-node", { jsonLd: [block], want: "Product" }).fires, `${shape} @graph: gate`).toBe(false);
    }
  });

  it("and a graph of either shape with no Product node is refused by all of them", () => {
    const refusals = [
      { "@context": "https://schema.org", "@graph": [{ "@type": "Organization", name: "StoreA" }, { "@type": "WebSite", name: "StoreA" }] },
      { "@context": "https://schema.org", "@graph": { "@type": "Organization", name: "StoreA" } },
    ];
    for (const block of refusals) {
      expect(declares(block, "Product")).toBe(false);
      expect(typedNodes(block, "Product")).toEqual([]);
      expect(readDeclared(block, "name", "Product")).toBeUndefined();
      const verdict = bank().run("json-ld-needs-product-node", { jsonLd: [block], want: "Product" });
      expect(verdict.fires).toBe(true);
      // The gate describes the block out of the same walk, so it cannot name a
      // type the read does not see.
      expect(declaredTypes(block)).toContain("Organization");
      for (const name of declaredTypes(block)) expect(verdict.because).toContain(name);
    }
  });

  it("neither shape lets the walk leave the graph", () => {
    // The refusal the StoreA encounter bought: a Product under a relation
    // is a *different* product, whichever shape the graph takes.
    const related = {
      "@context": "https://schema.org",
      "@graph": { "@type": "WebPage", isSimilarTo: { "@type": "Product", name: "Losartan 50mg", offers: { price: "1990" } } },
    };
    expect(declares(related, "Product")).toBe(false);
    expect(readDeclared(related, "name", "Product")).toBeUndefined();
    expect(bank().run("json-ld-needs-product-node", { jsonLd: [related], want: "Product" }).fires).toBe(true);
  });

  it("no module writes the graph walk or the @type compare out again", () => {
    // Descending `@graph` and comparing `@type` are the two halves that drifted.
    // Both are spelled as a bracket read off a record, and `src/declared/json.ts`
    // is the only file allowed to write either. The patterns are assembled at
    // run time so this file's own source is not a match — the guard has to
    // cover the guard.
    const bracket = (key: string): RegExp => new RegExp("\\[\\s*[\"']" + key + "[\"']\\s*\\]");
    const rules = [bracket("@" + "graph"), bracket("@" + "type")];
    const root = join(import.meta.dirname, "..");
    const owner = join("src", "declared", "json.ts");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "recorded" && entry.name !== "fixtures") walk(rel);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
          if (rel === owner) continue;
          const text = readFileSync(join(root, rel), "utf8");
          if (rules.some((rule) => rule.test(text))) offenders.push(rel);
        }
      }
    };
    for (const dir of ["src", "tests", "scripts", "bin", "tools"]) walk(dir);
    expect(offenders).toEqual([]);
    // And the owner really does still carry both, so an emptied pattern reads
    // as a broken guard rather than a clean repository.
    const ownerText = readFileSync(join(root, owner), "utf8");
    for (const rule of rules) expect(rule.test(ownerText)).toBe(true);
  });
});
