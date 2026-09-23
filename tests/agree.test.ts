import { describe, expect, it } from "vitest";
import { UNASKED, agree, answered, unservable, type Observation } from "../src/agree/agree.js";

/**
 * The rule four modules used to spell for themselves, now reachable directly.
 *
 * The point of this file is its length. Before `agree` existed, the only way to
 * exercise "a sample that could not answer must be dropped from the comparison
 * rather than allowed to veto it" was `tests/cascade.test.ts`'s Store B
 * shape: three URL probes, a `chooseSample` call, twelve noise endpoints with
 * hand-written bodies, a 401-then-500 detail sequence, three rendered texts and
 * a full `investigate()` run — roughly fifty lines of fixture and a whole
 * cascade to reach about seven lines of logic, and only ever at tier 2. The
 * other three copies of the rule had no such harness and no such test, which is
 * why they never learned it.
 *
 * Each case below is the same rule in one line of fixture. The cascade test
 * stays: it is the end-to-end evidence that tier 2 wires this up correctly, and
 * this file does not replace it. It replaces having to write it again for
 * `narrow`, `bindRole` and `intersectCandidates`.
 */

describe("agree — the asked/answered distinction", () => {
  it("keeps what every sample answered", () => {
    const result = agree([answered("a"), answered("b"), answered("c")]);
    expect(result?.values).toEqual(["a", "b", "c"]);
    expect(result?.contributors).toEqual([0, 1, 2]);
    expect(result?.silent).toEqual([]);
  });

  it("drops the sample that could not answer, and keeps the comparison", () => {
    // Defect 3 of the 2026-09-22 live run, in one line: Store B's third
    // product was one the store itself could not serve. It must not take
    // `products/detail` — the endpoint the whole answer lives in — with it.
    const result = agree([answered("a"), answered("b"), unservable<string>("401, then 500 twice")], { floor: 2 });
    expect(result?.values).toEqual(["a", "b"]);
    expect(result?.contributors).toEqual([0, 1]);
    expect(result?.silent).toEqual([2]);
  });

  it("lets a sample that was never asked veto the comparison", () => {
    // `products/recommendations`, called on two of three Store B pages.
    // Relaxing "answered by every sample" must not relax "asked by every
    // sample" with it, or a page's own furniture becomes a source.
    expect(agree([answered("a"), answered("b"), UNASKED], { floor: 2 })).toBeNull();
  });

  it("refuses a comparison thinner than the floor", () => {
    const perSample: Observation<string>[] = [answered("a"), unservable("no usable response"), unservable("no usable response")];
    expect(agree(perSample, { floor: 2 })).toBeNull();
    // The floor is the only thing that changed; one answer is a whole
    // comparison when the caller says one is enough.
    expect(agree(perSample, { floor: 1 })?.values).toEqual(["a"]);
  });

  it("asks 'asked by all' before 'answered by enough'", () => {
    // Both would reject, and the order still matters: an endpoint two of three
    // pages never called is not a thin comparison, it is not a comparison.
    expect(agree([answered("a"), UNASKED, unservable("no usable response")], { floor: 1 })).toBeNull();
  });
});

describe("agree — the policy each call site states", () => {
  /**
   * The strict policy, which is what `narrow`, `bindRole` and
   * `intersectCandidates` pass: they never produce an `unservable`, so
   * `requireAskedByAll` decides everything and the floor is inert.
   */
  it("with requireAskedByAll and only answered/unasked, one absence deletes the path", () => {
    expect(agree([answered(1), answered(2), UNASKED], { requireAskedByAll: true })).toBeNull();
    expect(agree([answered(1), answered(2), answered(3)], { requireAskedByAll: true })?.values).toEqual([1, 2, 3]);
  });

  /**
   * The tolerant policy: not used anywhere on 2026-09-23, and deliberately so
   * — whether tier 2's "asked by ALL samples" should become tolerant is an
   * open product question. This test pins what the one-line change would *do*,
   * so the decision is about the policy rather than about the mechanism.
   */
  it("without requireAskedByAll, an unasked sample is silent rather than fatal", () => {
    const result = agree([answered("a"), answered("b"), UNASKED], { requireAskedByAll: false, floor: 2 });
    expect(result?.values).toEqual(["a", "b"]);
    expect(result?.silent).toEqual([2]);
    expect(result?.because).toContain("never asked it");
  });

  it("an empty sample set is an empty agreement, not a null", () => {
    // Not a philosophical position: it is the default floor of 0 doing
    // nothing, and it is what keeps `bindRole` and `intersectCandidates`
    // behaving exactly as they did when handed zero samples.
    expect(agree<string>([])?.values).toEqual([]);
  });
});

describe("agree — the rationale is data", () => {
  it("keeps tier 2's sentence, the one that makes a compile arguable", () => {
    const result = agree([answered("a"), answered("b"), unservable<string>("asked 2 time(s), never usably answered")], {
      floor: 2,
      subject: "this endpoint",
    });
    // Verbatim from the 2026-09-22 fix. `tests/cascade.test.ts` asserts the
    // manuscript contains "got no answer"; this is where the sentence lives.
    expect(result?.because).toContain("1 of 3 sample(s) asked this endpoint and got no answer, and are left out of the comparison rather than deleting it");
  });

  it("names which sample was left out and why", () => {
    const result = agree([answered("a"), unservable<string>("401, then 500 twice"), answered("c")], { floor: 2, subject: "this endpoint" });
    expect(result?.because).toContain("sample 2 (401, then 500 twice)");
  });

  it("says so plainly when nobody was left out", () => {
    const result = agree([answered("a"), answered("b")], { subject: "this selector" });
    expect(result?.because).toBe("all 2 sample(s) answered this selector");
    expect(result?.because).not.toContain("got no answer");
  });
});
