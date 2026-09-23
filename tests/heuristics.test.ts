import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bank, HEURISTICS, HEURISTIC_IDS, UnknownHeuristicError } from "../src/heuristics/index.js";
import { visibleText } from "../src/heuristics/rules/investigate.js";

/**
 * U8b's eval. Each heuristic ships with the encounter that produced it, as a
 * fixture, so the rule is pinned rather than remembered: a heuristic that stops
 * firing, or starts firing wrongly, is a failing test here.
 *
 * Every finding of 2026-09-22 was already written down as prose in a plan
 * document — the SKU defect at line 35, StoreC's JSON-LD at line 990 — and
 * four sessions went by without any of it executing. This file is the
 * difference.
 */

const FIXTURE_DIR = join("tests", "fixtures", "heuristics");

interface Expectation {
  fires: boolean;
  pick?: string;
  becauseIncludes?: string;
  actionIncludes?: string;
}

interface Case {
  name: string;
  observation: unknown;
  expect: Expectation;
}

interface Fixture {
  heuristic: string;
  encounter: string;
  cases: Case[];
}

function fixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as Fixture);
}

describe("the heuristic bank (U8b)", () => {
  it("holds the eleven heuristics of 2026-09-22, each with an encounter", () => {
    expect(HEURISTICS).toHaveLength(11);
    for (const heuristic of HEURISTICS) {
      expect(heuristic.encounter, `${heuristic.id} has no encounter`).toMatch(/2026-09-22/);
      expect(heuristic.title.length).toBeGreaterThan(10);
      expect(heuristic.decides.length).toBeGreaterThan(10);
    }
    expect(new Set(HEURISTIC_IDS).size).toBe(HEURISTICS.length);
  });

  it("has a fixture for every heuristic, and no fixture for a heuristic it does not have", () => {
    const covered = fixtures().map((fixture) => fixture.heuristic).sort();
    expect(covered).toEqual([...HEURISTIC_IDS].sort());
  });

  it("refuses an unknown id, and an override naming one", () => {
    expect(() => bank().get("no-such-rule")).toThrow(UnknownHeuristicError);
    expect(() => bank({ "no-such-rule": { enabled: false, note: "typo" } })).toThrow(UnknownHeuristicError);
  });

  it("lets a case silence a heuristic, and says so rather than going quiet", () => {
    const view = bank({ "no-variation-no-field": { enabled: false, note: "client: a single-product catalogue is expected to repeat" } });
    const verdict = view.run("no-variation-no-field", { field: "product_name", values: ["StoreA", "StoreA"] });
    expect(verdict.fires).toBe(false);
    expect(verdict.because).toContain("disabled for this case");
    expect(verdict.because).toContain("single-product catalogue");
    expect(view.enabled("no-variation-no-field")).toBe(false);
    // Silencing one rule does not silence the bank.
    expect(view.run("retry-transport-not-an-answer", { outcome: { kind: "timeout" } }).fires).toBe(true);
  });

  it("refuses an observation that does not match the heuristic's shape", () => {
    expect(() => bank().run("no-variation-no-field", { field: "price", values: ["only one"] })).toThrow();
  });

  it("runs a whole stage and skips the rules an observation does not describe", () => {
    const verdicts = bank().runStage("replay", { outcome: { kind: "timeout" } });
    expect(verdicts.map((verdict) => verdict.id)).toEqual(["retry-transport-not-an-answer"]);
  });
});

describe.each(fixtures())("$heuristic", (fixture: Fixture) => {
  const view = bank();

  // Bank membership and the 2026-09-22 encounter on every rule are proved once,
  // file-wide, by "holds the eleven heuristics of 2026-09-22" and "has a fixture
  // for every heuristic" above; asserting them again per fixture only re-read the
  // fixture this block had already loaded.

  it.each(fixture.cases)("$name", (testCase: Case) => {
    const verdict = view.run(fixture.heuristic, testCase.observation);
    expect(verdict.fires, `${verdict.because}`).toBe(testCase.expect.fires);
    if (testCase.expect.pick !== undefined) expect(verdict.pick).toBe(testCase.expect.pick);
    if (testCase.expect.becauseIncludes !== undefined) expect(verdict.because).toContain(testCase.expect.becauseIncludes);
    if (testCase.expect.actionIncludes !== undefined) expect(verdict.action ?? "").toContain(testCase.expect.actionIncludes);
    // A rule that fires always says what to do about it; the action is the half a compile rationale prints.
    if (verdict.fires) expect(verdict.action, `${fixture.heuristic} fired without an action`).toBeTruthy();
  });
});

describe("visibleText", () => {
  it("drops scripts, styles and comments rather than counting them as content", () => {
    const html = "<body><!-- hi --><script>var a = 'a very long string of javascript that is not content'</script><style>.a{color:red}</style><p>Paracetamol 500 mg</p></body>";
    expect(visibleText(html)).toBe("Paracetamol 500 mg");
  });
});
