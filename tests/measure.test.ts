import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zeroCharges } from "../src/billing/charge.js";
import type { Question } from "../src/chooser/chooser.js";
import type { RunSummary } from "../src/main.js";
import { MEASUREMENTS_END, MEASUREMENTS_START, fieldsCorrect, readMeasurements, renderReadmeSection, renderTable, replaceSection, type MeasurementRow } from "../tools/measure/report.js";
import { parseArgs, runMeasurements, writeMeasurements } from "../tools/measure/run.js";
import { SCENARIOS, type Row, type Scenario } from "../tools/measure/scenarios.js";

/**
 * U18 measurement harness (R37, R44, KTD22): the same scenarios per chooser,
 * one table, docs/measurements.md rewritten between markers. Offline: the
 * agent column is the recorded replay; jev and model are skipped without keys.
 *
 * ## Why this file no longer runs all nine scenarios
 *
 * It used to drive the whole fixture set through a real browser in one
 * `beforeAll` with a 300-second budget -- nine scenarios, twelve of which
 * `vitest.config.ts` caps the workers for. Alone the file passed in 59 s, and
 * inside a full run it failed roughly one run in three, which was read as
 * contention. It was not: `F3-category` fails alone on an idle machine too,
 * in the same 2.9 s as a passing run, because the controls the navigator is
 * offered on a long page depend on the viewport height Crawlee's fingerprint
 * injection picked for that launch. `deps()` in `tools/measure/scenarios.ts`
 * pins the viewport and carries the measurement; the hit test behind it is
 * still wrong and still in `src/browser/snapshot.inject.js`.
 *
 * Most of that time bought a second spelling of assertions another file
 * already makes for real (`second-spelling.test.ts`): AE1 by
 * `compile.test.ts :: AE1` and `crawler.test.ts :: compiles python-jobs
 * once`, AE7 by `crawler.test.ts :: AE12`, AE8 and AE15 by `heal.test.ts ::
 * AE8` and `:: AE15` (both strictly stronger than the grading here), and
 * F4-paginate by `replay.test.ts` (fourteen items over three pages, then the
 * two-empty-pages stop).
 *
 * What is left is what nothing else runs:
 *
 * - The **harness itself** -- a row per scenario per chooser, a skip with a
 *   named reason, the graded cells, a failed scenario that still produces a
 *   row, the meter behind the replay's token estimate -- checked against stub
 *   scenarios through `scenarioSet`, with no browser at all.
 * - **Three flows** whose join no other test performs: a goal-driven first
 *   crawl, where the navigator runs on an empty store and the compile happens
 *   on the page the navigation reached. Every other navigation test either
 *   seeds the store (so the navigation is skipped) or calls `navigate()`
 *   directly on a page and never compiles. Those keep their real browser run.
 *
 * The nine-scenario run is still `npm run measure`, which is what produces the
 * table in docs/measurements.md.
 */

const dir = mkdtempSync(join(tmpdir(), "navvi-measure-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the harness, without a browser

/**
 * One recorded answer under the temporary record directory, so the agent
 * column replays something real (and the options check passes) without any
 * scenario running. The recording reports no tokens, like every fixture
 * recorded from the scripted host agent, which is what makes the meter's
 * estimate the value that reaches the row.
 */
const STUB_FIXTURE = "stub/replay";
const STUB_OPTIONS = ["ul.jobs > li.job (25 items): Senior Python Engineer", "div.card (25 items): Senior Python Engineer"];

const stubQuestion = (): Question => ({
  id: "stub.group",
  kind: "choice",
  premise: "Which element repeats once per job on this page?",
  state: "<ul class=\"jobs\"><li class=\"job\">Senior Python Engineer</li></ul>",
  options: STUB_OPTIONS,
});

mkdirSync(join(dir, STUB_FIXTURE), { recursive: true });
writeFileSync(join(dir, STUB_FIXTURE, "stub.group.json"), `${JSON.stringify({ id: "stub.group", kind: "choice", index: 1, options: STUB_OPTIONS }, null, 2)}\n`);

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  status: "succeeded",
  items: 0,
  pages: 1,
  templates: 1,
  cacheHit: false,
  healingEvents: [],
  unmappedCandidates: [],
  fieldsNotFound: [],
  chooser: null,
  input: null,
  requests: { compile: 0, list: 1, record: 0 },
  traceReplays: 0,
  blockedRequests: 0,
  unhealed: 0,
  scriptId: null,
  charges: zeroCharges(),
  zeroDataRetention: null,
  ...over,
});

interface StubOptions {
  id: string;
  fields?: readonly string[];
  expectedRows?: number;
  expectHealing?: boolean;
  /** `null` is the scenario the agent column cannot replay (no recording). */
  recordedFixture?: Scenario["recordedFixture"];
  rows?: Row[];
  /** Ask the built chooser one recorded question, so usage and the meter are exercised. */
  ask?: boolean;
  throws?: boolean;
}

/** A scenario that returns rows instead of crawling for them. */
const stub = (options: StubOptions): Scenario => ({
  id: options.id,
  title: `${options.id} (stub)`,
  fields: options.fields ?? ["title", "company"],
  expectedRows: options.expectedRows ?? 2,
  minFieldsCorrect: 1,
  expectHealing: options.expectHealing ?? false,
  live: false,
  recordedFixture: options.recordedFixture === undefined ? () => STUB_FIXTURE : options.recordedFixture,
  async run(ctx) {
    if (options.ask) await ctx.chooser.ask([stubQuestion()]);
    if (options.throws) throw new Error("scenario blew up");
    return { summaries: [summary()], rows: options.rows ?? [{ title: "a", company: "b" }, { title: "c", company: "d" }] };
  },
});

const rowFor = (rows: readonly MeasurementRow[], chooser: string, scenario: string): MeasurementRow => {
  const row = rows.find((r) => r.chooser === chooser && r.scenario === scenario);
  if (!row) throw new Error(`no row for ${chooser}/${scenario}`);
  return row;
};

describe("harness", () => {
  it("the fixture set is the nine scenarios the table reports", () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(["AE1", "AE7", "AE8", "AE15", "F1-search", "F2-login", "F3-category", "F4-paginate", "F5-detail"]);
  });

  it("writes one row per scenario per chooser, in chooser order, and names why each unavailable chooser was skipped", async () => {
    // `env: {}` is what makes the skips deterministic: no key and no PATH,
    // whatever the machine running the suite happens to have exported.
    const rows = await runMeasurements({
      choosers: ["agent", "jev", "model", "claude"],
      offline: true,
      agentLive: false,
      env: {},
      log: () => undefined,
      recordDir: dir,
      scenarioSet: [stub({ id: "S1", ask: true }), stub({ id: "S2", ask: true })],
    });

    expect(rows.map((r) => `${r.chooser}/${r.scenario}`)).toEqual([
      "agent/S1", "agent/S2", "jev/S1", "jev/S2", "model/S1", "model/S2", "claude/S1", "claude/S2",
    ]);
    for (const row of rows.filter((r) => r.chooser === "agent")) {
      expect(row.status, row.scenario).toBe("ok");
      expect(row.skipped).toBeUndefined();
      expect(row.questions).toBe(1);
      // The recording reports no tokens, so the row carries the meter's
      // estimate of what the replayed chooser was shown.
      expect(row.inputTokens).toBeGreaterThan(0);
      expect(row.costUsd).toBe(0);
    }
    for (const [chooser, reason] of [["jev", /no key.*AI_GATEWAY_API_KEY/], ["model", /no key.*ANTHROPIC_API_KEY/], ["claude", /`claude` is not installed/]] as const) {
      const skipped = rows.filter((r) => r.chooser === chooser);
      expect(skipped.map((r) => r.scenario)).toEqual(["S1", "S2"]);
      for (const row of skipped) {
        expect(row.status, chooser).toBe("skipped");
        expect(row.skipped, chooser).toMatch(reason);
        expect(row.cells).toEqual({ correct: 0, expected: 0 });
        expect(row.healingEvents).toBe(0);
      }
    }
  });

  it("skips the agent column with its own reason when the scenario has no recording to replay", async () => {
    const rows = await runMeasurements({
      choosers: ["agent"],
      offline: true,
      agentLive: false,
      env: {},
      log: () => undefined,
      recordDir: dir,
      scenarioSet: [stub({ id: "unrecorded", recordedFixture: null })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("skipped");
    expect(rows[0]!.skipped).toMatch(/recorded replay.*--agent-live/);
  });

  it("fills the cells it graded, fails the row that falls short, and still writes a row for a scenario that throws", async () => {
    const out = join(dir, "harness-out.md");
    const rows = await runMeasurements({
      choosers: ["agent"],
      offline: true,
      agentLive: false,
      env: {},
      log: () => undefined,
      recordDir: dir,
      out,
      scenarioSet: [
        stub({ id: "full", fields: ["a", "b", "c"], expectedRows: 2, rows: [{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }] }),
        stub({ id: "short", fields: ["a", "b"], expectedRows: 3, rows: [{ a: 1, b: null }] }),
        stub({ id: "unhealed", expectHealing: true }),
        stub({ id: "boom", fields: ["a", "b"], expectedRows: 4, throws: true }),
      ],
    });

    // every cell the rows promised: three fields over two rows
    expect(rowFor(rows, "agent", "full").cells).toEqual({ correct: 6, expected: 6 });
    expect(rowFor(rows, "agent", "full").status).toBe("ok");
    // one row of the three promised, and a null cell in it: graded against what was expected, not what arrived
    expect(rowFor(rows, "agent", "short").cells).toEqual({ correct: 1, expected: 6 });
    expect(rowFor(rows, "agent", "short").status).toBe("failed");
    // a healing proof with no healing event is a failure however right the cells are
    expect(rowFor(rows, "agent", "unhealed").cells).toEqual({ correct: 4, expected: 4 });
    expect(rowFor(rows, "agent", "unhealed").status).toBe("failed");
    // the throw is caught: the run continues and the row says every cell was missed
    expect(rowFor(rows, "agent", "boom").cells).toEqual({ correct: 0, expected: 8 });
    expect(rowFor(rows, "agent", "boom").status).toBe("failed");

    // `out` is written as part of the run, not by a second call
    expect(readMeasurements(readFileSync(out, "utf8"))).toEqual(rows);
  });
});

// ------------------------------------------------------------------ the report

describe("report", () => {
  const sample: MeasurementRow[] = [
    { chooser: "agent", scenario: "AE1", questions: 7, inputTokens: 1234, chooserWaitMs: 3, totalMs: 4567, costUsd: 0, cells: { correct: 125, expected: 125 }, healingEvents: 0, status: "ok" },
    { chooser: "jev", scenario: "AE8", questions: 10, inputTokens: 20000, chooserWaitMs: 1500, totalMs: 30000, costUsd: 0.00084, cells: { correct: 46, expected: 48 }, healingEvents: 1, status: "ok" },
    { chooser: "model", scenario: "AE7", questions: 0, inputTokens: 0, chooserWaitMs: 0, totalMs: 0, costUsd: 0, cells: { correct: 0, expected: 0 }, healingEvents: 0, status: "skipped", skipped: "no key (set ANTHROPIC_API_KEY)" },
    { chooser: "jev", scenario: "live:python.org", questions: 7, inputTokens: 9000, chooserWaitMs: 800, totalMs: 12000, costUsd: 0.000378, cells: { correct: 50, expected: 100 }, healingEvents: 0, status: "failed" },
  ];

  // `renderTable` prints `correct/expected` itself, so R44's ratio -- and its
  // divide-by-zero guard for a skipped row -- has no other caller under test.
  it("fieldsCorrect is correct over expected, and zero when nothing was expected", () => {
    expect(fieldsCorrect(sample[0]!)).toBe(1);
    expect(fieldsCorrect(sample[1]!)).toBeCloseTo(46 / 48);
    expect(fieldsCorrect(sample[2]!)).toBe(0);
  });

  it("readMeasurements(renderTable(rows)) round-trips", () => {
    const md = renderTable(sample);
    expect(md.split("\n")[0]).toMatch(/^\| chooser \| scenario \| questions \|/);
    expect(readMeasurements(md)).toEqual(sample);
    expect(readMeasurements(`${MEASUREMENTS_START}\n${md}\n${MEASUREMENTS_END}\n`)).toEqual(sample);
  });

  it("the README section summarises per chooser and labels the agent column as a replay", () => {
    const section = renderReadmeSection(sample);
    expect(section).toContain("| agent |");
    expect(section).toContain("| jev |");
    expect(section).toMatch(/replay/i);
    expect(section).toMatch(/skipped/);
  });

  it("rewriting docs/measurements.md keeps the prose outside the markers and replaces only the table", () => {
    const file = join(dir, "measurements.md");
    const before = `# Measurements\n\nProse above.\n\n${MEASUREMENTS_START}\n| stale | table |\n|---|---|\n| x | y |\n${MEASUREMENTS_END}\n\nProse below.\n`;
    writeFileSync(file, before);
    writeMeasurements(file, sample);
    const after = readFileSync(file, "utf8");
    expect(after.startsWith("# Measurements\n\nProse above.\n\n")).toBe(true);
    expect(after.endsWith("\n\nProse below.\n")).toBe(true);
    expect(after).not.toContain("stale");
    expect(readMeasurements(after)).toEqual(sample);
    // idempotent: a second rewrite changes nothing but the table
    writeMeasurements(file, sample.slice(0, 1));
    expect(readMeasurements(readFileSync(file, "utf8"))).toEqual(sample.slice(0, 1));
    expect(readFileSync(file, "utf8")).toContain("Prose below.");
    // no markers yet: the section is appended
    expect(replaceSection("# Fresh\n", renderTable(sample))).toContain(MEASUREMENTS_START);
    // prose that mentions a marker inline is not the block: only markers on their own line count
    const mentioned = `Rewrites between \`${MEASUREMENTS_START}\` and \`${MEASUREMENTS_END}\`.\n\n${MEASUREMENTS_START}\n| old |\n${MEASUREMENTS_END}\n`;
    const rewritten = replaceSection(mentioned, renderTable(sample));
    expect(rewritten.startsWith(`Rewrites between \`${MEASUREMENTS_START}\` and \`${MEASUREMENTS_END}\`.\n\n`)).toBe(true);
    expect(rewritten).not.toContain("| old |");
    expect(readMeasurements(rewritten)).toEqual(sample);
  });
});

describe("cli", () => {
  it("an unknown chooser fails with a clear error listing every chooser", () => {
    expect(() => parseArgs(["--choosers", "agent,gpt"])).toThrow(/unknown chooser "gpt".*agent, jev, model, claude, codex/);
    expect(parseArgs([]).choosers).toEqual(["agent"]);
    expect(parseArgs(["--choosers", "jev,model", "--live", "hackernews", "--out", "x.md"])).toMatchObject({ choosers: ["jev", "model"], live: ["hackernews"], out: "x.md" });
    expect(() => parseArgs(["--live", "example.com"])).toThrow(/python\.org|hackernews/);
  });
});

// ------------------------------------------------------------------ the flows nothing else runs end to end

/**
 * A goal-driven first crawl: an empty store, so the navigator actually runs,
 * and the compile happens on the page the navigation reached. `navigate.test
 * .ts` covers the navigation half on a bare page (AE6 search, AE14 login) and
 * `crawler.test.ts` covers the extraction half from a seeded store; neither
 * joins them, and `tests/fixtures/categories.html` has no other reader at all.
 * These three are the cheapest scenarios of the nine, and the only ones whose
 * removal would lose a behaviour rather than a second spelling of one.
 */
describe("goal-driven first crawls", () => {
  let rows: MeasurementRow[];
  /**
   * The harness's own line per scenario, kept so a failure says why.
   *
   * A failed row is `{ correct: 0, expected: <every cell> }` whether the
   * scenario threw, ended blocked, or crawled a page and found nothing --
   * three different causes behind one number -- and `log: () => undefined`
   * discarded the one sentence that tells them apart. It cost a night
   * (2026-09-23) to get that sentence back, so it is part of the assertion now.
   */
  const log: string[] = [];

  beforeAll(async () => {
    // `agentLive: false` is what this offline run means: the agent column is
    // the recorded replay, never a real host agent over stdio.
    rows = await runMeasurements({
      choosers: ["agent"],
      scenarios: ["F1-search", "F2-login", "F3-category"],
      offline: true,
      agentLive: false,
      env: {},
      log: (line) => void log.push(line),
    });
  }, 120_000);

  /** What the harness said about `scenario`, as the message of the expectation about it. */
  const why = (scenario: string): string => log.find((line) => line.includes(`/${scenario}:`)) ?? `${scenario}: the harness logged nothing`;

  it("navigates, then compiles on the page it reached: search 6x3, login 5x2, category 25x4", () => {
    const expected: Record<string, number> = { "F1-search": 18, "F2-login": 10, "F3-category": 100 };
    expect(rows.map((r) => r.scenario)).toEqual(Object.keys(expected));
    for (const [scenario, cells] of Object.entries(expected)) {
      const row = rowFor(rows, "agent", scenario);
      expect(row.cells, why(scenario)).toEqual({ correct: cells, expected: cells });
      expect(row.status, why(scenario)).toBe("ok");
    }
  });

  it("the navigation flows ask the operation, its targets, the text value and the done check before the compile questions", () => {
    expect(rowFor(rows, "agent", "F1-search").questions).toBe(15);
    expect(rowFor(rows, "agent", "F2-login").questions).toBe(15);
  });
});
