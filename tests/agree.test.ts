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
   * The tolerant policy, which tier 2 has passed since 2026-09-23: a live
   * render that nondeterministically misses one page's `products/detail` call
   * must not delete the endpoint for the two pages that have it. The argument
   * and what replaces the veto live at the call site in
   * `src/investigate/investigate.ts`; what this pins is the mechanism it asks
   * for, and `tests/investigate.test.ts` pins tier 2 asking for it.
   */
  it("without requireAskedByAll, an unasked sample is silent rather than fatal", () => {
    const result = agree([answered("a"), answered("b"), UNASKED], { requireAskedByAll: false, floor: 2 });
    expect(result?.values).toEqual(["a", "b"]);
    expect(result?.silent).toEqual([2]);
    expect(result?.because).toContain("never asked it");
  });

  /**
   * The half of the tolerant policy that does the refusing.
   *
   * Tier 2 stopped letting an unasked sample veto an endpoint and did **not**
   * stop refusing an endpoint one page called: a sample that answered
   * necessarily asked, so the floor on answers is a floor on askers too. That
   * is the whole of what keeps a page's own furniture from becoming a source
   * once the veto is gone, so it is worth one line here saying which option
   * carries it.
   */
  it("without requireAskedByAll, the floor still refuses a comparison of one", () => {
    const floor = 2;
    expect(agree([answered("a"), UNASKED, UNASKED], { requireAskedByAll: false, floor })).toBeNull();
    // Asked by one and answered by one is the same refusal as asked by three
    // and answered by one: the floor never counts anything but answers.
    expect(agree([answered("a"), unservable<string>("no usable response"), UNASKED], { requireAskedByAll: false, floor })).toBeNull();
    expect(agree([answered("a"), answered("b"), UNASKED], { requireAskedByAll: false, floor })?.contributors).toEqual([0, 1]);
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

  it("does not say a sample got no answer when it never asked the question", () => {
    /**
     * The lead-in and the tail used to contradict each other. One sentence
     * covered both reasons a sample can be silent, so the moment tier 2 went
     * tolerant on 2026-09-23 an endpoint one page never called came out as
     * "1 of 3 sample(s) asked this endpoint and got no answer … — sample 3
     * (never asked it)": an assertion in the lead-in that its own tail denies.
     * This string is committed beside a scraper and read months later by
     * somebody deciding whether to trust a binding, so it may not lie about
     * which of the two things happened.
     */
    const result = agree([answered("a"), answered("b"), UNASKED], { floor: 2, requireAskedByAll: false, subject: "this endpoint" });
    expect(result?.because).toBe(
      "1 of 3 sample(s) never asked this endpoint, and it rests on the ones that did rather than being deleted for all of them — sample 3 (never asked it)",
    );
    expect(result?.because).not.toContain("got no answer");
  });

  it("gives a sample that could not answer and a sample that never asked their own clause", () => {
    // Both reasons at once is the case that proves they are two sentences and
    // not one with a substitution in it.
    const result = agree([answered("a"), unservable<string>("401, then 500 twice"), UNASKED], {
      floor: 1,
      requireAskedByAll: false,
      subject: "this endpoint",
    });
    expect(result?.because).toContain("1 of 3 sample(s) asked this endpoint and got no answer");
    expect(result?.because).toContain("1 of 3 sample(s) never asked this endpoint");
    expect(result?.because).toContain("sample 2 (401, then 500 twice)");
    expect(result?.because).toContain("sample 3 (never asked it)");
  });

  it("says so plainly when nobody was left out", () => {
    const result = agree([answered("a"), answered("b")], { subject: "this selector" });
    expect(result?.because).toBe("all 2 sample(s) answered this selector");
    expect(result?.because).not.toContain("got no answer");
  });
});
