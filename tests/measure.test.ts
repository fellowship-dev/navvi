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
  rows = await runMeasurements({ choosers: ["agent", "jev", "model"], offline: true, env: {}, log: () => undefined });
}, 180_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const byScenario = (chooser: string, scenario: string): MeasurementRow => {
  const row = rows.find((r) => r.chooser === chooser && r.scenario === scenario);
  if (!row) throw new Error(`no row for ${chooser}/${scenario}`);
  return row;
};

describe("offline harness run", () => {
  it("writes one row per scenario for the agent chooser and skips jev and model with a named reason when no key is set", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(ids).toEqual(["AE1", "AE7", "AE8", "AE15"]);
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
    expect(rows).toHaveLength(12);
  });

  it("AE8 (v1 then v2 under the same URLs) reports at least one healing event and fieldsCorrect >= 0.9", () => {
    const row = byScenario("agent", "AE8");
    expect(row.healingEvents).toBeGreaterThanOrEqual(1);
    expect(fieldsCorrect(row)).toBeGreaterThanOrEqual(0.9);
    expect(row.cells.expected).toBe(48);
  });

  it("AE7 (pharmacy v1 record) asks four questions and gets every cell right", () => {
    const row = byScenario("agent", "AE7");
    expect(row.questions).toBe(4);
    expect(fieldsCorrect(row)).toBe(1);
    expect(row.cells).toEqual({ correct: 48, expected: 48 });
    expect(row.healingEvents).toBe(0);
  });

  it("AE1 (python-jobs list) fills 25 rows of 5 fields with 7 questions; AE15 heals the renamed login step", () => {
    const ae1 = byScenario("agent", "AE1");
    expect(ae1.questions).toBe(7);
    expect(ae1.cells).toEqual({ correct: 125, expected: 125 });
    const ae15 = byScenario("agent", "AE15");
    expect(ae15.healingEvents).toBe(1);
    expect(ae15.cells).toEqual({ correct: 10, expected: 10 });
    expect(ae15.questions).toBe(1);
  });
});

describe("report", () => {
  const sample: MeasurementRow[] = [
    { chooser: "agent", scenario: "AE1", questions: 7, inputTokens: 1234, chooserWaitMs: 3, totalMs: 4567, costUsd: 0, cells: { correct: 125, expected: 125 }, healingEvents: 0, status: "ok" },
    { chooser: "jev", scenario: "AE8", questions: 10, inputTokens: 20000, chooserWaitMs: 1500, totalMs: 30000, costUsd: 0.00084, cells: { correct: 46, expected: 48 }, healingEvents: 1, status: "ok" },
    { chooser: "model", scenario: "AE7", questions: 0, inputTokens: 0, chooserWaitMs: 0, totalMs: 0, costUsd: 0, cells: { correct: 0, expected: 0 }, healingEvents: 0, status: "skipped", skipped: "no key (set ANTHROPIC_API_KEY)" },
    { chooser: "jev", scenario: "live:python.org", questions: 7, inputTokens: 9000, chooserWaitMs: 800, totalMs: 12000, costUsd: 0.000378, cells: { correct: 50, expected: 100 }, healingEvents: 0, status: "failed" },
  ];

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
  it("an unknown chooser fails with a clear error listing agent, jev, model", () => {
    expect(() => parseArgs(["--choosers", "agent,claude"])).toThrow(/unknown chooser "claude".*agent, jev, model/);
    expect(parseArgs([]).choosers).toEqual(["agent"]);
    expect(parseArgs(["--choosers", "jev,model", "--live", "hackernews", "--out", "x.md"])).toMatchObject({ choosers: ["jev", "model"], live: "hackernews", out: "x.md" });
    expect(() => parseArgs(["--live", "example.com"])).toThrow(/python\.org|hackernews/);
  });
});
