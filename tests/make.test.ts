import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../bin/cli.js";
import { parseArgs } from "../src/cli/args.js";
import { applyAnswers, digestOfParams, LEDGER_FILE, make, matchAnswer, parseAnswer, Work, type Ledger, type MakeDeps, type MakeResult, type Pages, type StageName } from "../src/make/index.js";
import { readingOf } from "../src/replay/determinism.js";
import { fieldTypesOf, type PageExtraction } from "../src/scraper/extract.js";
import { canaryOrigin, type CompiledScraper } from "../src/scraper/schema.js";
import type { Answer, Chooser, ChooserUsage, Question } from "../src/chooser/chooser.js";
import type { Spec } from "../src/spec/schema.js";
import type { Manuscript } from "../src/investigate/index.js";
import type { Reconciliation } from "../src/reconcile/index.js";
import type { Determinism } from "../src/replay/determinism.js";

/**
 * U11: `navvi make`, the driver — the two transcripts in
 * `specs/plans/2026-09-22-008-navvi-remaining-phases.md` under "The flow",
 * which the plan says are the specification, *exactly as written*.
 *
 * Three things this file is deliberately built to be able to assert, because
 * they are the three the plan and this repository's incident history care
 * about and none of them is assertable against a mock that answers everything:
 *
 *  1. **Nothing opens a browser on the first run.** The fixture `Pages` throws
 *     from `capture`, and the first transcript's test supplies no `openPages`
 *     at all — so "a browser was not launched" is a fact about the call graph
 *     rather than a spy that was not called.
 *  2. **A stage that did not run and a stage that found nothing print
 *     different things.** Asserted on the strings, not on a status field: the
 *     block is the thing a person reads.
 *  3. **Editing an artifact recompiles downstream from that artifact.** The
 *     whole staleness rule exists for this one sentence in the plan, and the
 *     test edits a real `reconcile.json` and checks which stages moved.
 *
 * The fixtures under `tests/fixtures/make/` are four synthetic product pages
 * whose shape was read off a live pharmacy and whose every value is invented.
 * Tier 1 covers all five fields on them, which is why `capture` can throw.
 */

const FIXTURES = resolve(import.meta.dirname, "fixtures", "make");
const SITE = "https://example.test";
const NOW = new Date("2026-09-23T12:00:00.000Z");

const CATALOGUE: Record<string, { status: number; file?: string }> = {
  [`${SITE}/p/analgesico.html`]: { status: 200, file: "analgesico.html" },
  [`${SITE}/p/antiacido.html`]: { status: 200, file: "antiacido.html" },
  [`${SITE}/p/antialergico.html`]: { status: 200, file: "antialergico.html" },
  [`${SITE}/p/vitamina-c.html`]: { status: 200, file: "vitamina-c.html" },
  // The catalogue's dead URL. A status, not a document: see the fixture README.
  [`${SITE}/p/descontinuado.html`]: { status: 404 },
};

const URLS = Object.keys(CATALOGUE);

/** What a replay of each page returns. Authored as data — this stands in for a browser, it does not re-implement one. */
const VALUES: Record<string, Record<string, string | null>> = {
  [`${SITE}/p/analgesico.html`]: { productName: "Ejemplo Analgesico 500 mg 16 Comprimidos", sku: "900101", listPrice: "3990", promoPrice: "3591", stock: "https://schema.org/InStock" },
  [`${SITE}/p/antiacido.html`]: { productName: "Ejemplo Antiacido 20 mg 14 Capsulas", sku: "900103", listPrice: "7990", promoPrice: "6392", stock: "https://schema.org/InStock" },
  [`${SITE}/p/antialergico.html`]: { productName: "Ejemplo Antialergico 10 mg 30 Comprimidos", sku: "900102", listPrice: "5490", promoPrice: "5490", stock: "https://schema.org/InStock" },
  [`${SITE}/p/vitamina-c.html`]: { productName: "Ejemplo Vitamina C 1 g 10 Comprimidos", sku: "900104", listPrice: "2490", promoPrice: "2490", stock: "https://schema.org/OutOfStock" },
};

interface FixturePages extends Pages {
  fetched: string[];
  reads: string[];
  /** Overrides applied on the Nth reading of a URL, for the determinism cases. */
  drift: Map<string, (round: number) => Record<string, string | null> | undefined>;
}

/**
 * The page driver, from fixture files.
 *
 * `capture` throws rather than returning an empty capture. An empty capture is
 * a real answer — "the page fetched nothing for itself" — and a test whose
 * stub returns it cannot tell a cascade that stopped at tier 1 from one that
 * reached tier 2 and found nothing, which is the exact confusion
 * `TierRecord.outcome` exists to prevent.
 */
function fixturePages(): FixturePages {
  const fetched: string[] = [];
  const reads: string[] = [];
  const rounds = new Map<string, number>();
  const drift = new Map<string, (round: number) => Record<string, string | null> | undefined>();

  const extract = (scraper: CompiledScraper, url: string): PageExtraction => {
    const round = rounds.get(url) ?? 0;
    rounds.set(url, round + 1);
    reads.push(url);
    const base = VALUES[url] ?? {};
    const moved = drift.get(url)?.(round);
    const all = { ...base, ...(moved ?? {}) };
    const values: Record<string, string | null> = {};
    const resolvedBy: Record<string, number | null> = {};
    for (const name of Object.keys(scraper.fields)) {
      values[name] = all[name] ?? null;
      // `extractPage` records an alternative only when one produced a value, so
      // `resolvedBy` is null for a field the page did not answer — including one
      // the fixture answers with an explicit null. A stub that claimed
      // alternative 0 resolved a null would be claiming the page said something.
      resolvedBy[name] = all[name] === undefined || all[name] === null ? null : 0;
    }
    const item = { values, resolvedBy, sourceUrl: url };
    return { ...item, items: [item] };
  };

  return {
    fetched,
    reads,
    drift,
    fetch(url) {
      fetched.push(url);
      const entry = CATALOGUE[url];
      if (!entry) return Promise.resolve({ url, status: 404, body: "" });
      const body = entry.file ? readFileSync(join(FIXTURES, entry.file), "utf8") : "";
      return Promise.resolve({ url, status: entry.status, body });
    },
    capture() {
      throw new Error("capture was called; tier 1 covers every field on these fixtures, so reaching tier 2 is the finding");
    },
    read(scraper, url) {
      return Promise.resolve(readingOf(extract(scraper, url), fieldTypesOf(scraper)));
    },
    extract(scraper, url) {
      return Promise.resolve(extract(scraper, url));
    },
    close() {
      return Promise.resolve();
    },
  };
}

/** A chooser answering `briefToSpec`'s one text question from a script. */
class ScriptedChooser implements Chooser {
  readonly name = "model" as const;
  asked = 0;
  constructor(private readonly script: string[]) {}
  async ask(batch: Question[]): Promise<Answer[]> {
    this.asked += batch.length;
    return batch.map((question) => {
      const text = this.script.shift();
      if (text === undefined) throw new Error("script exhausted");
      return { id: question.id, index: null, text };
    });
  }
  usage(): ChooserUsage {
    return { chooser: this.name, questions: 0, textQuestions: 0, batches: 0, inputTokens: 0, outputTokens: 0, waitMs: 0, costUsd: 0, zeroDataRetention: "not_applicable" };
  }
}

const BRIEF = "I need the product info of a dynamic set of products in Ejemplo Farmacia.";

/** The draft a model returns for that brief: a bundle word for the fields, and no input shape. */
const DRAFT = JSON.stringify({
  target: { site: "Ejemplo Farmacia", pageKind: "product", briefTerm: "Ejemplo Farmacia" },
  entity: { name: "product", briefTerm: "products" },
  inputs: { shape: "unknown", description: "a dynamic set of products", briefTerm: "a dynamic set of products" },
  fields: [{ name: "product_name" }, { name: "sku" }, { name: "list_price" }, { name: "promo_price" }, { name: "stock" }],
});

let dir: string;
let out: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navvi-make-"));
  out = [];
});

afterEach(() => {
  out = [];
});

const work = (): string => join(dir, "work");
const report = (text: string): void => {
  out.push(text);
};
const transcript = (): string => out.join("");

function deps(over: Partial<MakeDeps> = {}): MakeDeps {
  return { report, now: () => NOW, loadUrls: () => Promise.resolve([...URLS]), ...over };
}

function options(over: Partial<Parameters<typeof make>[0]> = {}): Parameters<typeof make>[0] {
  return { work: work(), rubrics: [], answers: [], urls: [], fromUrls: [], allowPrivateHosts: [], offline: false, force: false, ...over };
}

const outcome = (result: MakeResult, stage: StageName): string => result.stages.find((report) => report.stage === stage)?.outcome ?? "missing";

// --------------------------------------------------------- the first transcript

describe("the first run: the brief alone, and nothing opens a browser", () => {
  it("writes spec.json, names both blocking questions and stops at spec with exit 3", async () => {
    const chooser = new ScriptedChooser([DRAFT]);
    const result = await make(
      options({ brief: BRIEF }),
      // No `openPages` at all. "Nothing has opened a browser" is then a
      // property of the call graph, not of a spy nobody called.
      deps({ openChooser: () => Promise.resolve(chooser) }),
    );

    expect(result.status).toBe("needs_answers");
    expect(result.stoppedAt).toBe("spec");
    expect(chooser.asked).toBe(1);

    const spec = JSON.parse(readFileSync(join(work(), "spec.json"), "utf8")) as Spec;
    expect(spec.brief).toBe(BRIEF);
    expect(spec.openQuestions.filter((question) => question.blocking).map((question) => question.id).sort()).toEqual(["fields-unnamed", "inputs-shape"]);

    const text = transcript();
    expect(text).toContain("spec");
    expect(text).toContain(join(work(), "spec.json"));
    expect(text).toContain("! fields-unnamed");
    expect(text).toContain("! inputs-shape");

    // Every later stage is `not reached`, which is a different word from
    // `skipped` on purpose: nobody decided not to run them.
    for (const stage of ["sample", "investigate", "reconcile", "schema", "determinism", "compile", "verify"] as const) {
      expect(outcome(result, stage), stage).toBe("not reached");
    }
    expect(existsSync(join(work(), "sample.json"))).toBe(false);
  });

  it("through the binary, the stop line carries the exit code the plan prints", async () => {
    // Driven from argv, so the command, the flags and the exit mapping are in
    // the assertion rather than assumed. `--offline` keeps it honest without a
    // chooser: the spec is already there and has a blocking question in it.
    writeFileSync(join(dir, "seed.json"), "{}");
    const seeded = join(dir, "seeded");
    const w = Work.open(seeded);
    w.writeJson("spec.json", blockedSpec());

    const stderr = new Capture();
    const code = await main(["make", "--work", seeded, "--offline"], io({ stderr }));
    expect(code).toBe(3);
    expect(stderr.text).toContain("! inputs-shape");
    expect(stderr.text).toContain("stopped at spec: 1 blocking question (exit 3)");
  });
});

// -------------------------------------------------------- the second transcript

describe("the second run: the questions answered and the list supplied", () => {
  async function full(over: Partial<Parameters<typeof make>[0]> = {}, pages = fixturePages()): Promise<{ result: MakeResult; pages: FixturePages }> {
    const chooser = new ScriptedChooser([DRAFT]);
    await make(options({ brief: BRIEF }), deps({ openChooser: () => Promise.resolve(chooser) }));
    out = [];
    const result = await make(
      options({
        answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"],
        urls: URLS,
        ...over,
      }),
      deps({ openPages: () => Promise.resolve(pages) }),
    );
    return { result, pages };
  }

  it("runs every stage, writes every artifact, and prints them in the plan's order", async () => {
    const { result, pages } = await full();
    expect(result.status, transcript()).toBe("delivered");

    for (const file of ["spec.json", "sample.json", "investigation.json", "reconcile.json", "reconcile.md", "schema.json", "determinism.json", "scraper.json", "rationale.md", "machine.mmd", "scorecard.md", "make.json"]) {
      expect(existsSync(join(work(), file)), file).toBe(true);
    }

    const text = transcript();
    const order = ["spec", "sample", "investigate", "reconcile", "schema", "determinism", "compile", "verify"].map((label) => text.indexOf(`\n${label}`) >= 0 ? text.indexOf(`\n${label}`) : text.indexOf(label));
    expect(order, text).toEqual([...order].sort((a, b) => a - b));

    // The five fields the client named, in the order they named them.
    const spec = JSON.parse(readFileSync(join(work(), "spec.json"), "utf8")) as Spec;
    expect(spec.fields.map((field) => field.name)).toEqual(["productName", "sku", "listPrice", "promoPrice", "stock"]);
    expect(spec.inputs.shape).toBe("url_list");
    expect(spec.openQuestions.filter((question) => question.blocking)).toHaveLength(0);

    // The declared column types have nowhere to live in a spec, so they ride in
    // the ledger and are named in the block. See `applyFields`.
    expect(text).toContain("listPrice:money, promoPrice:money");

    const manuscript = JSON.parse(readFileSync(join(work(), "investigation.json"), "utf8")) as Manuscript;
    expect(manuscript.verdict).toBe("covered");
    // Tier 1 answered, so tier 2 was never spent — and `capture` throwing is
    // what proves it rather than a count.
    expect(pages.fetched.length).toBeGreaterThan(0);

    const scraper = JSON.parse(readFileSync(join(work(), "scraper.json"), "utf8")) as CompiledScraper;
    expect(Object.keys(scraper.fields).sort()).toEqual(["listPrice", "productName", "promoPrice", "sku", "stock"]);

    const determinism = JSON.parse(readFileSync(join(work(), "determinism.json"), "utf8")) as Determinism;
    expect(determinism.verdict).toBe("stable");
    expect(text).toContain("3 replays x");
  });

  it("the sample spans what it can and says which stratum it could not fill", async () => {
    await full();
    const text = transcript();
    expect(text).toMatch(/sample\s+\d+ of 5 URLs, spanning/);
    expect(text).toContain("discounted");
    // `probeFrom` sets no `inStock`, so no probe can stand for out-of-stock. An
    // unfilled stratum is a statement about what the compile was never tested
    // against, and it is printed with a `!`.
    expect(text).toContain("! out-of-stock");
  });

  it("verify reports the measurements and refuses to invent the grade", async () => {
    await full();
    const text = transcript();
    // 3 of 5 from JSON-LD and 2 from `product:` meta tags, which U2a settled as
    // `dom` alternatives on the meta element rather than a fourth source.
    expect(text).toContain("declared 60% · payload 0% · dom 40%");
    expect(text).toContain("0 model calls at replay");
    expect(text).toContain("! no grade");
    const card = readFileSync(join(work(), "scorecard.md"), "utf8");
    expect(card).toContain("## Grade");
    expect(card).toContain("U12");
    expect(card).not.toMatch(/\d+\/100/);
  });

  it("a field that will not hold still is dropped from the scraper, not repaired", async () => {
    const pages = fixturePages();
    // The 2026-09-22 shape: the same page, read twice, answering differently.
    pages.drift.set(`${SITE}/p/analgesico.html`, (round) => (round % 2 === 1 ? { promoPrice: "3592" } : undefined));
    const { result } = await full({}, pages);

    expect(result.status).toBe("delivered");
    const determinism = JSON.parse(readFileSync(join(work(), "determinism.json"), "utf8")) as Determinism;
    expect(determinism.verdict).toBe("unstable");
    expect(determinism.fields.find((field) => field.field === "promoPrice")?.rejected).toBe(true);

    const scraper = JSON.parse(readFileSync(join(work(), "scraper.json"), "utf8")) as CompiledScraper;
    expect(Object.keys(scraper.fields)).not.toContain("promoPrice");
    expect(transcript()).toContain("did not hold still");
  });

  /**
   * Every field null on every reading — what a payload-bound compile looks like
   * at replay when the page never takes delivery of the payload its `network`
   * alternatives resolve against. Driven through `drift` rather than a second
   * stub so the run still goes through the same driver, the same compile and
   * the same two replay stages a real one does.
   */
  const BLANK: Record<string, string | null> = { productName: null, sku: null, listPrice: null, promoPrice: null, stock: null };
  const blankOn = (pages: FixturePages, urls: readonly string[]): FixturePages => {
    for (const url of urls) pages.drift.set(url, () => BLANK);
    return pages;
  };

  it("a replay that read nothing is not allowed to pass as a stable one", async () => {
    // The 2026-09-23 report: `determinism 3 replays x 3 URLs, 0 fields moved`
    // four lines above `verify fill 0 of 3`, read as the two stages
    // contradicting each other about the same pages through the same driver.
    // They agreed. `judgeDeterminism` was asked whether the extraction moved
    // and answered correctly — it did not — but it was asked about a
    // null-filled reading, where `field in item` is a fact about the scraper
    // and never about the page. The verdict stands, and the artifact now says
    // what it is a verdict about.
    const { result } = await full({}, blankOn(fixturePages(), URLS));
    expect(result.status).toBe("delivered");

    const determinism = JSON.parse(readFileSync(join(work(), "determinism.json"), "utf8")) as Determinism;
    expect(determinism.verdict, "the verdict is not downgraded: nothing moved, and that is a true answer to the question asked").toBe("stable");
    // And the record is now falsifiable from itself: `stable` over five fields
    // none of which was read on any of the four URLs is a sentence a reader can
    // catch. Under the null-filled reading every one of these was `held` with
    // `readOn: 4`, and `Stability.absent` was unreachable through this driver.
    expect(determinism.fields.every((field) => field.outcome === "absent"), JSON.stringify(determinism.fields.map((f) => [f.field, f.outcome, f.readOn]))).toBe(true);
    expect(determinism.fields.every((field) => field.readOn === 0), "`readOn` counts the URLs a value came back on, and none did").toBe(true);
    expect(determinism.urls.map((url) => url.readings), "the pages were read, three times each — the fields are absent, the URLs are not").toEqual([3, 3, 3, 3]);

    const text = transcript();
    expect(text).toContain("0 fields moved");
    // 4 bound URLs x 3 replays x 5 fields, counted at the seam that took them,
    // because determinism.json stores no forms for a field that held.
    expect(text).toContain("! read nothing  every one of the 60 field readings came back null");
    expect(text).toContain("`stable` is the stability of a blank extraction");
    expect(text).toContain("fill 0 of 5 fields, 0 of 20 reads");

    // And in the artifact, which outlives the transcript and is where the
    // sentence sits directly above the table of zeroes. The headline number is
    // recounted from `determinism.json`'s own `readOn` — 5 fields x 4 URLs —
    // so a reader with the file can check it; the per-reading count underneath
    // is this session's and is gone on the next run.
    const card = readFileSync(join(work(), "scorecard.md"), "utf8");
    expect(card).toContain("**No field was read on any of the 20 (field, URL) pairs `determinism.json` covers.**");
    expect(card).toContain("What held still was a blank extraction");
    expect(card).toContain("This run took 60 field readings across every replay of every URL, and 0 of them carried a value.");
  });

  /**
   * The guard used to be a closure round this session's readings, so the
   * *second* `navvi make` over the same work directory reused `determinism.json`
   * and printed nothing at all — the whole defect back again one run later, and
   * the run that a person is most likely to be reading. A held field stores no
   * forms, so the recount has to come from `readOn`.
   */
  it("a reused determinism.json still says the replay read nothing", async () => {
    await full({}, blankOn(fixturePages(), URLS));
    out = [];
    const again = await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS }),
      deps({ openPages: () => Promise.resolve(blankOn(fixturePages(), URLS)) }),
    );

    expect(outcome(again, "determinism"), "the point of the test is that it was NOT measured again").toBe("reused");
    const text = transcript();
    expect(text).toContain("determinism   reused");
    expect(text).toContain("! read nothing  none of the 20 (field, URL) pairs this record covers carried a value");
    expect(text).toContain("recounted from the record's own `readOn`");
    expect(text).toContain("`stable` is the stability of a blank extraction");

    const card = readFileSync(join(work(), "scorecard.md"), "utf8");
    expect(card).toContain("**No field was read on any of the 20 (field, URL) pairs `determinism.json` covers.**");
    // This session took no readings, so it claims no per-reading count. Absent
    // is not zero: that distinction is the whole of `determinismValues`.
    expect(card).not.toContain("This run took");
  });

  it("a replay that read everything says nothing of the kind, and the fill says how much", async () => {
    await full();
    const text = transcript();
    expect(text).not.toContain("read nothing");
    expect(text).toContain("fill 5 of 5 fields, 20 of 20 reads");
    expect(readFileSync(join(work(), "scorecard.md"), "utf8")).not.toContain("blank extraction");
  });

  it("the verify head tells a scraper that read nothing from one whose pages mostly answered", async () => {
    // Both numbers in the report came from the same day: `fill 0 of 3` on the
    // default browser and 2 of 3 per field on `--browser chromium`. Under a
    // headline with one fraction in it those two runs printed the same line,
    // and the difference between "this reads nothing" and "this reads, and one
    // page did not answer" was recoverable only from the bullets underneath.
    const { result } = await full({}, blankOn(fixturePages(), [`${SITE}/p/antiacido.html`]));
    expect(result.status).toBe("delivered");

    const text = transcript();
    expect(text).toContain("fill 0 of 5 fields, 15 of 20 reads");
    expect(text).toContain("! productName  read on 3 of 4 replayed URLs");
    // Something was read, so the determinism verdict is about an extraction.
    expect(text).not.toContain("read nothing");
  });

  /**
   * The half the blank case never covered: a replay that read *some* of what it
   * replayed still prints `0 fields moved` and `stable`, and until the reading
   * stopped being null-filled nothing in the stage said how much. One field
   * read on one of four URLs is as good a witness to stability as four of four
   * would have been, which is the same believed sentence with a smaller number
   * behind it.
   */
  it("a replay that read part of what it replayed says which part, in the block and in the artifact", async () => {
    const pages = fixturePages();
    // Three of four URLs answer nothing at all; the fourth answers everything.
    blankOn(pages, [`${SITE}/p/antiacido.html`, `${SITE}/p/antialergico.html`, `${SITE}/p/vitamina-c.html`]);
    const { result } = await full({}, pages);
    expect(result.status).toBe("delivered");

    const determinism = JSON.parse(readFileSync(join(work(), "determinism.json"), "utf8")) as Determinism;
    expect(determinism.verdict).toBe("stable");
    // Every field held — on the one URL that answered. `readOn` is what says so.
    expect(determinism.fields.every((field) => field.outcome === "held")).toBe(true);
    expect(determinism.fields.every((field) => field.readOn === 1), JSON.stringify(determinism.fields.map((f) => [f.field, f.readOn]))).toBe(true);
    expect(determinism.urls).toHaveLength(4);
    const held = determinism.fields[0]!;
    expect(held.because, "the field's own sentence carries the fraction, not just the transcript").toContain("1 URLs");

    const text = transcript();
    expect(text).toContain("0 fields moved");
    // 1 of 4 URLs x 3 replays x 5 fields.
    expect(text).toContain("! read partly  15 of the 60 field readings carried a value");
    expect(text).toContain("says nothing about the other 45");

    const card = readFileSync(join(work(), "scorecard.md"), "utf8");
    expect(card).toContain("**5 of the 20 (field, URL) pairs `determinism.json` covers carried a value.**");
    expect(card).toContain("This run took 60 field readings across every replay of every URL, and 15 of them carried a value.");
    expect(card).not.toContain("blank extraction");
  });

  /**
   * A4. `make` recorded a canary into `Manuscript.canary` and wrote a
   * `scraper.json` with no `canary` key at all, so every scraper this command
   * produced arrived `unrecorded` — "nobody looked" — about a run that had
   * looked, and waited for a clean replay to backfill what was already on disk
   * one file away. A scraper with no canary is one `licenseToHeal` refuses to
   * repair a total collapse for, so it is a bound on every later run.
   */
  it("writes the investigation's canary onto the compiled scraper", async () => {
    await full();
    const manuscript = JSON.parse(readFileSync(join(work(), "investigation.json"), "utf8")) as Manuscript;
    const scraper = JSON.parse(readFileSync(join(work(), "scraper.json"), "utf8")) as CompiledScraper;

    expect(manuscript.canary, "the fixture pages are real documents; the investigation fingerprints one").toBeDefined();
    expect(canaryOrigin(scraper)).toBe("recorded");
    expect(scraper.canary).toEqual(manuscript.canary);
    expect(transcript()).toContain("- canary");
  });

  /**
   * And the other two states are not interchangeable: a run that looked and
   * could not fingerprint anything writes `null` — `refused`, a decision taken
   * against a real page — rather than leaving the key off, which would say
   * nobody looked and invite the next clean replay to mint one. That is the
   * shape a starved render takes: the investigation refuses a canary off a
   * half-drawn page, and a fingerprint of a frame is a false "the site
   * changed" filed against every replay from here on.
   */
  it("writes `refused` rather than nothing when the investigation recorded no canary", async () => {
    await full();
    const file = join(work(), "investigation.json");
    const manuscript = JSON.parse(readFileSync(file, "utf8")) as Manuscript;
    delete manuscript.canary;
    manuscript.canaryBecause = "no canary was recorded: the render did not finish";
    writeFileSync(file, JSON.stringify(manuscript, null, 2) + "\n");

    out = [];
    const result = await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS }),
      deps({ openPages: () => Promise.resolve(fixturePages()) }),
    );
    expect(result.status, transcript()).toBe("delivered");
    expect(outcome(result, "compile")).toBe("ran");

    const scraper = JSON.parse(readFileSync(join(work(), "scraper.json"), "utf8")) as CompiledScraper;
    expect(canaryOrigin(scraper)).toBe("refused");
    expect(scraper.canary).toBeNull();
    expect(transcript()).toContain("! canary");
    expect(transcript()).toContain("a later replay may not backfill one");
  });

  it("says out loud that cross-alternative disagreement was not measured", async () => {
    // U6b's finding lands in this artifact and this block; U6a never fills it.
    // `summarizeDeterminism` prints nothing when `alternatives` is absent, and
    // silence there reads exactly like the clean case — which is the one
    // reading this repository may never allow.
    await full();
    expect(transcript()).toContain("not compared (U6b)");
  });
});

// ------------------------------------------------------------- re-running

describe("re-running", () => {
  async function seeded(): Promise<FixturePages> {
    const pages = fixturePages();
    const chooser = new ScriptedChooser([DRAFT]);
    await make(options({ brief: BRIEF }), deps({ openChooser: () => Promise.resolve(chooser) }));
    await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS }),
      deps({ openPages: () => Promise.resolve(pages) }),
    );
    out = [];
    return pages;
  }

  it("with nothing changed, every stage is reused and says so", async () => {
    await seeded();
    const pages = fixturePages();
    const result = await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS }),
      deps({ openPages: () => Promise.resolve(pages) }),
    );

    expect(result.status).toBe("delivered");
    for (const stage of ["sample", "investigate", "reconcile", "schema", "determinism", "compile"] as const) {
      expect(outcome(result, stage), stage).toBe("reused");
    }
    expect(pages.fetched, "no URL was probed again").toEqual([]);
    expect(transcript()).toContain("reused —");
    // Reuse is never silent, and it never wears the same words as a run.
    expect(transcript()).not.toContain("3 replays x");
  });

  it("editing reconcile.json recompiles from it, and leaves reconcile alone", async () => {
    await seeded();
    const file = join(work(), "reconcile.json");
    const reconciliation = JSON.parse(readFileSync(file, "utf8")) as Reconciliation;
    // A user who disagrees: drop a column they do not want.
    reconciliation.obtainable = reconciliation.obtainable.filter((field) => field.field !== "sku");
    writeFileSync(file, JSON.stringify(reconciliation, null, 2) + "\n");

    const result = await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS }),
      deps({ openPages: () => Promise.resolve(fixturePages()) }),
    );

    expect(result.status).toBe("delivered");
    // Nothing reconcile read changed, so reconcile itself is current — and the
    // block says the bytes are the client's rather than navvi's.
    expect(outcome(result, "reconcile")).toBe("reused");
    expect(transcript()).toContain("is not the bytes navvi wrote");
    // Everything that reads those bytes recompiled.
    expect(outcome(result, "schema")).toBe("ran");
    expect(outcome(result, "compile")).toBe("ran");
    expect(outcome(result, "investigate")).toBe("reused");

    const scraper = JSON.parse(readFileSync(join(work(), "scraper.json"), "utf8")) as CompiledScraper;
    expect(Object.keys(scraper.fields)).not.toContain("sku");
  });

  /**
   * `determinism.json` keeps its shape and its `version: 1` across the reading
   * change, so an artifact written before it is indistinguishable to a reader
   * from one written after — and it says something different, because `readOn`
   * counted the columns the scraper compiled rather than the ones the page
   * answered. Nothing in navvi's code is affected (downstream reads `verdict`
   * and `rejected`), so the break is the human reader's, and the handling is
   * that no work directory mixes the two: the reading is an argument of the
   * stage, so an old record is stale.
   */
  it("a determinism.json recorded under the old reading is re-measured rather than reused", async () => {
    await seeded();
    const determinism = JSON.parse(readFileSync(join(work(), "determinism.json"), "utf8")) as Determinism;
    const scraper = JSON.parse(readFileSync(join(work(), "scraper.json"), "utf8")) as CompiledScraper;
    const urls = determinism.urls.map((url) => url.url);
    // The arguments the driver recorded before the reading was one of them.
    const old = { replays: 3, urls, compile: { templateKey: scraper.templateKey, entry: { mode: "direct", url: urls[0] } } };

    const file = join(work(), LEDGER_FILE);
    const ledger = JSON.parse(readFileSync(file, "utf8")) as Ledger;
    const params = ledger.stages.determinism?.inputs.find((input) => input.name === "params");
    expect(params, "the determinism stage records its arguments").toBeDefined();
    expect(params!.digest, "this run recorded which reading it took; the old one could not have").not.toBe(digestOfParams(old));

    params!.digest = digestOfParams(old);
    writeFileSync(file, JSON.stringify(ledger, null, 2) + "\n");

    const result = await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS }),
      deps({ openPages: () => Promise.resolve(fixturePages()) }),
    );
    expect(result.status, transcript()).toBe("delivered");
    expect(outcome(result, "determinism"), "the old record is not reused under the new sentence").toBe("ran");
    // A stage that re-ran prints its own head, never `reused —`; the reason it
    // was stale is the ledger's, and the ledger is what this test moved.
    expect(transcript()).toContain("3 replays x");
    expect(transcript()).not.toContain("determinism   reused");
  });

  it("refuses to overwrite an edited artifact, and --force is the yes", async () => {
    await seeded();
    // Edit the *investigation*, then move the spec so investigate is stale:
    // re-running would destroy the edit.
    writeFileSync(join(work(), "investigation.json"), readFileSync(join(work(), "investigation.json"), "utf8").replace("\"site\"", "\"site\" "));
    const refused = await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS, sampleSize: 4 }),
      deps({ openPages: () => Promise.resolve(fixturePages()) }),
    );
    expect(refused.status).toBe("configuration");
    expect(refused.because).toContain("--force");

    out = [];
    const forced = await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS, sampleSize: 4, force: true }),
      deps({ openPages: () => Promise.resolve(fixturePages()) }),
    );
    expect(forced.status, transcript()).toBe("delivered");
  });
});

// ------------------------------------------------------------ F7: a throw

/**
 * F7. `StageOutcome` had five values and none of them was "it raised".
 *
 * Only `spec` and `compile` caught anything, so a throw out of any other stage
 * left `make()` entirely: no `MakeResult`, no line in the report, and a bare
 * stack at `bin/cli.ts`. The driver whose whole purpose is that *every stage
 * says whether it ran at all* was silent about the failure most likely to
 * happen, because the stages that throw are the ones that open a browser.
 */
describe("a stage that raised", () => {
  it("names the stage, keeps the stages that already ran, and exits short rather than as a stack", async () => {
    const chooser = new ScriptedChooser([DRAFT]);
    await make(options({ brief: BRIEF }), deps({ openChooser: () => Promise.resolve(chooser) }));
    out = [];

    const pages = fixturePages();
    // The shape a real one takes: the browser dies mid-replay.
    pages.extract = () => Promise.reject(new Error("Target page, context or browser has been closed"));

    const result = await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS }),
      deps({ openPages: () => Promise.resolve(pages) }),
    );

    expect(result.status, transcript()).toBe("short");
    expect(result.stoppedAt).toBe("determinism");
    expect(outcome(result, "determinism")).toBe("threw");
    expect(result.because).toContain("Target page, context or browser has been closed");
    // The stack is kept: a defect in navvi is read by whoever fixes navvi.
    expect(result.because).toContain("make.test.ts");

    // The stages that got there first keep their own outcomes, and the ones
    // after it are `not reached` rather than missing.
    expect(outcome(result, "investigate")).toBe("ran");
    expect(outcome(result, "reconcile")).toBe("ran");
    expect(outcome(result, "compile")).toBe("not reached");
    expect(outcome(result, "verify")).toBe("not reached");

    const text = transcript();
    expect(text).toContain("determinism   threw");
    expect(text).toContain("! threw");
  });
});

// --------------------------------------------------------------- honesty

describe("a stage that did not run does not read like one that found nothing", () => {
  it("--offline skips determinism and verify's fill rate, and names each reason", async () => {
    const chooser = new ScriptedChooser([DRAFT]);
    await make(options({ brief: BRIEF }), deps({ openChooser: () => Promise.resolve(chooser) }));
    await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS }),
      deps({ openPages: () => Promise.resolve(fixturePages()) }),
    );

    // Then disagree with the reconciliation and recompile from it, offline.
    // `--force` is deliberately *not* used: it would re-run `sample` too, and
    // `--offline` would then stop the run at the probes — correct, and not what
    // this test is about.
    const file = join(work(), "reconcile.json");
    const reconciliation = JSON.parse(readFileSync(file, "utf8")) as Reconciliation;
    reconciliation.obtainable = reconciliation.obtainable.filter((field) => field.field !== "stock");
    writeFileSync(file, JSON.stringify(reconciliation, null, 2) + "\n");

    out = [];
    const result = await make(
      options({ answers: ["fields=productName,sku,listPrice:money,promoPrice:money,stock", "inputs=url_list"], urls: URLS, offline: true }),
      deps(),
    );

    expect(result.status, transcript()).toBe("delivered");
    expect(outcome(result, "determinism")).toBe("skipped");

    const text = transcript();
    expect(text).toContain("determinism   skipped — --offline");
    expect(text).toContain("! not measured");
    // The one sentence this whole file is about: a skipped stage must not be
    // able to be mistaken for a clean one.
    expect(text).not.toContain("0 fields moved");
    expect(text).toContain("fill not measured");
    expect(text).toContain("already settled");

    const card = readFileSync(join(work(), "scorecard.md"), "utf8");
    expect(card).toContain("Not measured.");
    expect(card).not.toMatch(/\| \w+ \| 0 of 0 \|/);

    // And the stale determinism.json from the run before is not read back:
    // evidence about a different reconciliation carried forward onto this
    // compile is precisely the phantom finding U6a exists to stop.
    const ledger = JSON.parse(readFileSync(join(work(), "make.json"), "utf8")) as { stages: Record<string, unknown> };
    expect(ledger.stages.determinism).toBeUndefined();
    expect(text).toContain("! unproved");
  });

  it("--offline on a fresh directory stops at sample rather than sampling nothing", async () => {
    const w = Work.open(work());
    w.writeJson("spec.json", answeredSpec());
    const result = await make(options({ urls: URLS, offline: true }), deps());
    expect(result.status).toBe("configuration");
    expect(result.stoppedAt).toBe("sample");
    expect(result.because).toContain("--offline");
    expect(existsSync(join(work(), "sample.json"))).toBe(false);
  });
});

// ----------------------------------------------------------------- answers

describe("--answer", () => {
  const spec = (): Spec => blockedSpec();

  it("matches by question id and by what the question is about", () => {
    expect(matchAnswer(parseAnswer("inputs-shape=url_list"), spec()).by).toBe("id");
    expect(matchAnswer(parseAnswer("inputs=url_list"), spec()).by).toBe("subject");
  });

  it("a key that names no part of a spec is an error that names both lists", () => {
    expect(() => matchAnswer(parseAnswer("colour=blue"), spec())).toThrow(/not a part of a spec/);
    expect(() => matchAnswer(parseAnswer("colour=blue"), spec())).toThrow(/inputs-shape \(inputs\)/);
  });

  it("settles the question it answered and leaves the rest open", () => {
    const applied = applyAnswers(spec(), [parseAnswer("inputs=url_list")]);
    expect(applied.spec.inputs.shape).toBe("url_list");
    expect(applied.spec.openQuestions.map((question) => question.id)).not.toContain("inputs-shape");
  });

  it("carries the column types the spec has no room for", () => {
    const withFields: Spec = { ...spec(), openQuestions: [{ id: "fields-unnamed", about: "fields", question: "which fields?", because: "the brief names none", blocking: true, answeredBy: "client" }] };
    const applied = applyAnswers(withFields, [parseAnswer("fields=laboratory,pum:money,bioequivalent:boolean")]);
    expect(applied.spec.fields.map((field) => field.name)).toEqual(["laboratory", "pum", "bioequivalent"]);
    expect(applied.types).toEqual({ pum: "money", bioequivalent: "boolean" });
    // Nothing claims the brief said these words. `briefContains` matches on a
    // word boundary, which is why this is checkable at all: a plain `includes`
    // finds the field `pum` nowhere and the field `a` in almost every brief
    // there is.
    expect(applied.spec.fields.every((field) => field.briefTerm === undefined)).toBe(true);
  });

  it("refuses a value the vocabulary does not have", () => {
    expect(() => applyAnswers(spec(), [parseAnswer("inputs=a pile of urls")])).toThrow(/url_list/);
  });

  it("the argv layer refuses --answer <file>, which is the flag next door", () => {
    const bad = parseArgs(["make", "--work", "w", "--answer", "answers.json"]);
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain("--answers <file>");
  });
});

// ------------------------------------------------------------- the ledger

describe("the work directory's staleness rule", () => {
  it("is the bytes read, not the file's existence and not its mtime", () => {
    const w = Work.open(join(dir, "w"), { now: () => NOW });
    w.writeJson("spec.json", { version: 1 });
    w.writeJson("sample.json", { picks: [] });
    w.record("sample", ["spec.json"], { size: 5 });

    expect(w.currency("sample", ["spec.json"], { size: 5 }).current).toBe(true);

    // The artifact above it moves: stale, and the message names which one.
    w.writeJson("spec.json", { version: 1, changed: true });
    const moved = w.currency("sample", ["spec.json"], { size: 5 });
    expect(moved.current).toBe(false);
    expect(moved.because).toContain("spec.json");

    // Its own arguments move: also stale, with a different sentence.
    w.writeJson("spec.json", { version: 1 });
    const args = w.currency("sample", ["spec.json"], { size: 6 });
    expect(args.current).toBe(false);
    expect(args.because).toContain("its arguments");

    // Its own output edited: still current — the edit is the client's answer —
    // and reported, because downstream is reading their bytes.
    w.writeJson("sample.json", { picks: ["edited"] });
    const edited = w.currency("sample", ["spec.json"], { size: 5 });
    expect(edited.current).toBe(true);
    expect(edited.edited).toEqual(["sample.json"]);
  });

  it("a deleted artifact is stale however unchanged its inputs are", () => {
    const w = Work.open(join(dir, "w2"), { now: () => NOW });
    w.writeJson("spec.json", { version: 1 });
    w.writeJson("sample.json", { picks: [] });
    w.record("sample", ["spec.json"], {});
    writeFileSync(join(dir, "w2", "sample.json"), "");
    // Emptied rather than removed is an edit; removing it is the missing case.
    expect(w.currency("sample", ["spec.json"], {}).edited).toEqual(["sample.json"]);
  });

  it("an unreadable ledger is treated as an unknown directory, never as a current one", () => {
    const path = join(dir, "w3");
    const w = Work.open(path, { now: () => NOW });
    w.writeJson("spec.json", { version: 1 });
    w.writeJson("sample.json", { picks: [] });
    w.record("sample", ["spec.json"], {});
    writeFileSync(join(path, "make.json"), "{ not json");
    const reopened = Work.open(path, { now: () => NOW });
    expect(reopened.currency("sample", ["spec.json"], {}).current).toBe(false);
  });
});

// ------------------------------------------------------------------ helpers

/** A spec with one blocking question left in it, for the paths that need no chooser. */
function blockedSpec(): Spec {
  return {
    version: 1,
    brief: BRIEF,
    target: { site: "Ejemplo Farmacia", pageKind: "product", provenance: "brief" },
    entity: { name: "product", provenance: "brief" },
    inputs: { shape: "unknown", description: "a dynamic set of products", provenance: "brief" },
    fields: [
      { name: "productName", provenance: "brief" },
      { name: "sku", provenance: "brief" },
      { name: "listPrice", provenance: "brief" },
      { name: "promoPrice", provenance: "brief" },
      { name: "stock", provenance: "brief" },
    ],
    constraints: { freshness: { stated: false }, volume: { stated: false }, cadence: { stated: false }, budget: { stated: false } },
    rubrics: [],
    openQuestions: [
      { id: "inputs-shape", about: "inputs", question: "what varies per run?", because: `the brief says "a dynamic set of products"`, blocking: true, answeredBy: "client" },
    ],
  };
}

function answeredSpec(): Spec {
  const spec = blockedSpec();
  return { ...spec, inputs: { shape: "url_list", description: "the URLs given on the command line", provenance: "brief" }, openQuestions: [] };
}

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

function io(over: { stderr?: Writable; stdout?: Writable } = {}): CliIo {
  return {
    stdin: null,
    stdout: over.stdout ?? new Capture(),
    stderr: over.stderr ?? new Capture(),
    env: {},
    cwd: dir,
  };
}
