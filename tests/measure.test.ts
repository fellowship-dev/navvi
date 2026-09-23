import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEASUREMENTS_END, MEASUREMENTS_START, fieldsCorrect, readMeasurements, renderReadmeSection, renderTable, replaceSection, type MeasurementRow } from "../src/measure/report.js";
import { parseArgs, runMeasurements, writeMeasurements } from "../src/measure/run.js";
import { SCENARIOS } from "../src/measure/scenarios.js";

/**
 * U18 measurement harness (R37, R44, KTD22): the same scenarios per chooser,
 * one table, docs/measurements.md rewritten between markers. Offline: the
 * agent column is the recorded replay; jev and model are skipped without keys.
 */

let dir: string;
let rows: MeasurementRow[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "navvi-measure-"));
  // `agentLive` is required, and false is what this offline run means: the
  // agent column is the recorded replay, never a real host agent over stdio.
  rows = await runMeasurements({ choosers: ["agent", "jev", "model"], offline: true, agentLive: false, env: {}, log: () => undefined });
}, 300_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const byScenario = (chooser: string, scenario: string): MeasurementRow => {
  const row = rows.find((r) => r.chooser === chooser && r.scenario === scenario);
  if (!row) throw new Error(`no row for ${chooser}/${scenario}`);
  return row;
};

// The per-scenario acceptance criteria are owned by the files that run them for
// real: AE7's twelve pharmacy rows by `crawler.test.ts :: AE12`, AE8's healing
// and AE15's renamed login step by `heal.test.ts`. What is unique here is that
// the harness writes a row per scenario per chooser, skips the keyless ones with
// a reason, and fills the complex-flow cells.
describe("offline harness run", () => {
  it("writes one row per scenario for the agent chooser and skips jev and model with a named reason when no key is set", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(ids).toEqual(["AE1", "AE7", "AE8", "AE15", "F1-search", "F2-login", "F3-category", "F4-paginate", "F5-detail"]);
    const agent = rows.filter((r) => r.chooser === "agent");
    expect(agent.map((r) => r.scenario)).toEqual(ids);
    for (const row of agent) {
      expect(row.status, row.scenario).toBe("ok");
      expect(row.skipped).toBeUndefined();
      expect(row.questions).toBeGreaterThan(0);
      expect(row.inputTokens).toBeGreaterThan(0);
      expect(row.totalMs).toBeGreaterThan(0);
      expect(row.costUsd).toBe(0);
    }
    for (const chooser of ["jev", "model"]) {
      const skipped = rows.filter((r) => r.chooser === chooser);
      expect(skipped.map((r) => r.scenario)).toEqual(ids);
      for (const row of skipped) {
        expect(row.status).toBe("skipped");
        expect(row.skipped).toMatch(/no key/);
      }
    }
    expect(rows).toHaveLength(27);
  });

  it("the complex flows fill every expected cell from the recorded answers: search 6x3, login 5x2, category 25x4, pagination 14x4, detail 25x3", () => {
    const expected: Record<string, number> = { "F1-search": 18, "F2-login": 10, "F3-category": 100, "F4-paginate": 56, "F5-detail": 75 };
    for (const [scenario, cells] of Object.entries(expected)) {
      const row = byScenario("agent", scenario);
      expect(row.cells, scenario).toEqual({ correct: cells, expected: cells });
      expect(row.status, scenario).toBe("ok");
    }
    // navigation flows ask the operation, its targets, the text value and the done check before the compile questions
    expect(byScenario("agent", "F1-search").questions).toBe(15);
    expect(byScenario("agent", "F2-login").questions).toBe(15);
  });
});

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
