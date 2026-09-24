/**
 * "Keep only what the samples agree on", written once.
 *
 * Four places in this repository intersect a set of samples and keep what
 * survives, and on 2026-09-22 a live run showed that only one of them knew the
 * rule. The four:
 *
 *  - `investigate/leaves.ts` `narrow` — a path present on every sample.
 *  - `investigate/investigate.ts` `bindRole` — a declared role every sample declares.
 *  - `investigate/investigate.ts` tier 2 — an endpoint the samples asked for.
 *  - `compile/fields.ts` `intersectCandidates` — a selector that resolves everywhere.
 *
 * A fifth was found on 2026-09-23 and had never been counted: `catalogueOf` in
 * `investigate/investigate.ts`, which builds the leaf inventory over the
 * contributing samples. It reads the way `narrow` does — a payload a sample
 * answered has no such fact, rather than a question it could not put — and is
 * strict for that reason.
 *
 * Each was correct in its own encounter and contradicted the others at a seam,
 * and every unit passed its own tests. Defect 3 of that run was tier 2 deleting
 * `catalog-svc/products/detail` — the one endpoint Store B's entire
 * answer lives in — because the third sample was a product the store itself
 * could not serve: 401, then 500, then 500. The fix taught tier 2 that **a
 * sample which could not answer must be dropped from the comparison rather than
 * allowed to veto it**. The other three copies never learned it, because there
 * was nowhere for the lesson to live.
 *
 * This is that place. It does not decide the policy — the four call sites still
 * want what they wanted, and two of them may always want different things. What
 * it does is make the difference *named* instead of being four accidental
 * spellings of `.some(x => x === undefined)`.
 *
 * ## The distinction the module exists for
 *
 * A sample that did not contribute did not necessarily disagree. There are two
 * reasons it can be missing and they are not the same fact:
 *
 *  - **unasked** — this sample never put the question. Store B's
 *    `products/recommendations` is called on two of three pages; the third page
 *    has no opinion about it because it never asked. Whether an intersection
 *    keeps that veto is the call site's to make, and they no longer all make it
 *    the same way: tier 2 gave it up on 2026-09-23, because a render that
 *    missed a call and a widget only two pages carry are the same observation
 *    here. The argument is at that call site.
 *  - **unservable** — this sample asked and could not be answered. That is a
 *    fact about *that sample*, not about the endpoint, and it must not delete
 *    the endpoint for the samples that did get an answer.
 *
 * Three of the four call sites do not distinguish these today. They are honest
 * about it: they pass `answered` and `UNASKED` only, and never reach the
 * `unservable` branch. Making that visible is most of the point — the day one
 * of them acquires an "asked but could not answer" case, the shape is already
 * here to say so.
 *
 * ## The `because` string
 *
 * This repository returns rationale as data (`heuristics/types.ts` `Verdict
 * .because`) and the manuscript prints it. An `Agreement` therefore carries the
 * sentence that explains who was left out and why, rather than leaving each
 * caller to spell it. Tier 2's wording is the wording, because it is the one
 * that had to argue a live compile.
 */

/** What one sample had to say. */
export type Observation<T> =
  /** It was asked, and this is the answer. */
  | { state: "answered"; value: T }
  /** It was asked and could not answer. Not a disagreement — an absence. */
  | { state: "unservable"; because: string }
  /** It never put the question, so it has no opinion to contribute or withhold. */
  | { state: "unasked" };

/** A sample that answered. */
export function answered<T>(value: T): Observation<T> {
  return { state: "answered", value };
}

/** A sample that asked and could not be answered, and why. */
export function unservable<T>(because: string): Observation<T> {
  return { state: "unservable", because };
}

/** A sample that never put the question. One value, because it carries no data. */
export const UNASKED: Observation<never> = { state: "unasked" };

export interface AgreeOptions {
  /**
   * Fewest answering samples an agreement may rest on. Default `0` — no floor,
   * which is what a call site that cannot produce an `unservable` needs: with
   * `requireAskedByAll` on, either every sample answered or there is no
   * agreement at all, and a floor would only be a second spelling of that.
   *
   * Tier 2 passes `Math.min(2, samples.length)`, because `narrow`'s variation
   * check needs two samples to mean anything and a lone capture makes one
   * answer the whole comparison.
   */
  floor?: number;
  /**
   * Must every sample have been asked? Default `true`.
   *
   * **This is the policy line.** `true` is today's behaviour at all four call
   * sites: one `unasked` sample and there is no agreement. Setting it `false`
   * at a call site moves `unasked` into `silent` alongside `unservable` — the
   * comparison then rests on whoever answered, subject to `floor`.
   *
   * **Tier 2 passes `false` since 2026-09-23**, and is the only call site that
   * does. A live render that nondeterministically misses one page's
   * `products/detail` call was deleting that endpoint for every sample, and
   * a live smoke run against Store B bound nothing about one run in three
   * because of it. The argument against tolerance — "a page's own furniture
   * must not become a source for pages that never load it" — is answered at
   * that call site by the floor and by the four filters below it, not here.
   * The whole argument is written there; this option only carries it out.
   *
   * The other call sites stay `true`, and each says why where it asks.
   */
  requireAskedByAll?: boolean;
  /**
   * What each sample was asked, as the noun phrase the manuscript prints:
   * "this endpoint", "this selector". Appears in `because`.
   */
  subject?: string;
}

export interface Agreement<T> {
  /** One value per contributing sample, in sample order. */
  values: T[];
  /** Indices of the samples that answered — the index into `values` is the position here. */
  contributors: number[];
  /** Indices left out of the comparison, in sample order. */
  silent: number[];
  /** Who was left out and why, in the words the manuscript prints. */
  because: string;
}

/**
 * What the samples agree on, or `null` when there is nothing to agree about.
 *
 * `null` is "no comparison here", not "the comparison failed": the caller drops
 * the path, role, endpoint or selector exactly as it did before this module
 * existed.
 *
 * Note that an empty `perSample` yields an empty `Agreement` rather than
 * `null`. That is not a philosophical position, it is the default `floor` of
 * `0` doing nothing, and it is what keeps the three call sites that can be
 * reached with zero samples behaving exactly as they did.
 */
export function agree<T>(perSample: readonly Observation<T>[], options: AgreeOptions = {}): Agreement<T> | null {
  const requireAskedByAll = options.requireAskedByAll ?? true;
  const floor = options.floor ?? 0;
  const subject = options.subject ?? "this path";

  const values: T[] = [];
  const contributors: number[] = [];
  const silent: number[] = [];
  let unaskedAnywhere = false;
  for (const [index, observation] of perSample.entries()) {
    if (observation.state === "answered") {
      contributors.push(index);
      values.push(observation.value);
      continue;
    }
    if (observation.state === "unasked") unaskedAnywhere = true;
    silent.push(index);
  }

  // Asked before answered, and in that order: an endpoint two of three pages
  // never call is not a thin comparison, it is not a comparison.
  if (requireAskedByAll && unaskedAnywhere) return null;
  if (contributors.length < floor) return null;

  return { values, contributors, silent, because: rationale(perSample, silent, subject) };
}

/** Sample numbers are 1-based here because this sentence is read by a person. */
function name(perSample: readonly Observation<unknown>[], index: number): string {
  const observation = perSample[index];
  const why = observation?.state === "unservable" ? observation.because : "never asked it";
  return `sample ${index + 1} (${why})`;
}

/**
 * Who was left out, and why — in two clauses, because there are two reasons.
 *
 * The first version of this wrote one sentence for both, and tier 2 going
 * tolerant on 2026-09-23 made that sentence lie: an endpoint one sample never
 * called came out as *"1 of 3 sample(s) asked this endpoint and got no answer
 * … — sample 3 (never asked it)"*, which asserts in its lead-in the opposite
 * of what it names in its tail. That reads as a bug in the run rather than in
 * the prose, and this string is committed next to a scraper and read months
 * later by somebody deciding whether to trust a binding.
 *
 * So `unservable` keeps its wording, verbatim from tier 2's 2026-09-22 fix —
 * it is the wording that had to argue a live compile, and `tests/agree.test.ts`
 * pins it — and `unasked` gets its own, naming the trade it is making.
 */
function rationale(perSample: readonly Observation<unknown>[], silent: readonly number[], subject: string): string {
  if (silent.length === 0) return `all ${perSample.length} sample(s) answered ${subject}`;
  const asked = silent.filter((index) => perSample[index]?.state === "unservable");
  const never = silent.filter((index) => perSample[index]?.state === "unasked");
  const clauses: string[] = [];
  if (asked.length > 0) {
    clauses.push(
      `${asked.length} of ${perSample.length} sample(s) asked ${subject} and got no answer, ` +
        `and are left out of the comparison rather than deleting it` +
        ` — ${asked.map((index) => name(perSample, index)).join("; ")}`,
    );
  }
  if (never.length > 0) {
    clauses.push(
      `${never.length} of ${perSample.length} sample(s) never asked ${subject}, ` +
        `and it rests on the ones that did rather than being deleted for all of them` +
        ` — ${never.map((index) => name(perSample, index)).join("; ")}`,
    );
  }
  return clauses.join("; ");
}
