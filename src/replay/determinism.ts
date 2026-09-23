import { coerceValues, type PageExtraction, type TypedValue } from "../scraper/extract.js";
import { clip, normalize } from "../util/text.js";
import type { FieldType } from "../input/schema.js";

/**
 * U6a: the same page, read N times.
 *
 * *Same input, same output.* An extraction that varies between runs on an
 * unchanged page is not a scraper, and on 2026-09-22 that variation was read as
 * news: a replay reported **33 repairs and 3 failures** against pages that had
 * not moved and a scraper that had not broken. The measurement moved. Every one
 * of those 36 findings was false, and the expensive half is the repairs — a
 * healer that believes a phantom failure recompiles a working field against
 * whatever the page happened to show that second, which is how a good scraper
 * is destroyed by its own repair. The same sentence is already in
 * `investigate/manuscript.ts` about binding against an error page; this is the
 * same defect one stage later.
 *
 * So before a compile is worth committing, the same extraction is run N times
 * against a page nobody changed, and **a field whose value moves is rejected as
 * unstable** rather than reported. A rejection here is a real statement and the
 * artifact makes it in full: which field moved, what it moved between, on how
 * many of the sampled URLs, and therefore that this binding cannot be trusted.
 *
 * ## This is not the across-samples question
 *
 * Two different questions wear the same word, and collapsing them is the one
 * mistake this file exists to make impossible:
 *
 *  - **Across samples** — one reading of each of many *different* pages. A
 *    value identical on all of them describes the site, not the record, and is
 *    rejected: `no-variation-no-field` in `heuristics/rules/bind.ts`, and
 *    `varies()` in `reconcile/reconcile.ts`. There, *sameness* is the defect.
 *  - **Across runs** — N readings of *one* page, which nobody touched between
 *    them. There, *difference* is the defect, and it is this file.
 *
 * A field can fail both ways at once and they mean opposite things, so nothing
 * here is named `varies`, `sameValue` or `distinct`. It moved, or it held.
 *
 * ## What "moved" means, and which way this errs
 *
 * `formOf` is the grouping key N readings are bucketed by. Deliberately a
 * grouping key and not a pair comparator: there is no shared `TypedValue`
 * comparator in this repository, and the two private ones that exist answer a
 * different question — `sameValue` in `bind.ts` stringifies both sides, so
 * `3321` and `"3321"` are one value to it and `null` and `""` are too, which is
 * right for "are these arguably the same reading of one page" and wrong here,
 * where a field that flips between a number and its own text has moved.
 *
 * What is folded, and why:
 *
 *  - **Whitespace and case**, via `normalize` from `util/text.ts` — the form
 *    this repository already compares names and terms in. The extractor squashes
 *    runs of whitespace before this ever sees a value, so a whitespace
 *    difference here is markup reflow rather than data, and rejecting a working
 *    field for it would reject most of them.
 *  - **Row order.** A page's values are compared as a sorted multiset across
 *    its items, so a listing that shuffles its rows between two loads is not
 *    movement, and a listing whose *values* changed is. Without a stable row
 *    key navvi cannot tell a shuffle from two rows swapping values, and a
 *    server-side shuffle is common enough that treating it as instability would
 *    reject every listing page in the sample.
 *
 * What is **not** folded, which is the direction this errs in:
 *
 *  - **Thousands separators, currency marks and any other re-writing of the
 *    same quantity.** `"$ 6.990"` and `"$6,990"` are two values here. This file
 *    does not re-parse anything: it compares what the extraction produced, in
 *    the type the declared field asked for. A field declared `money` was
 *    already coerced to `6990` on both readings and nothing moves; a field left
 *    as text ships the string to the client's column, and if the string moves
 *    the column moves. The declared type decides, not this file.
 *  - **`null` versus absent versus `false`.** Three different things, three
 *    different forms.
 *
 * Erring strict is the deliberate choice. A tolerant rule hides a real
 * instability and the cost of that is the 2026-09-22 incident arriving again
 * with a repair attached; a strict rule costs a field named in an artifact that
 * a person can read in one line and overrule. The failure modes are not
 * symmetric, so the rule is not either.
 *
 * ## N, the sample, and what it costs
 *
 * `DEFAULT_REPLAYS` is 3 and `DEFAULT_SAMPLE_URLS` is 6, both overridable. Two
 * readings that disagree are 50/50 and the artifact cannot say which one was
 * the outlier; three give a majority form and a sentence worth reading. Five
 * would cost two more passes over every URL to catch a one-in-five flake, which
 * is not what 2026-09-22 was — that field moved on every second read.
 *
 * The cost is honest and it is the reason this stage sits before the compile
 * rather than inside the crawl: N x U page loads, 18 at the defaults, with zero
 * model calls, spent once per compile and not per run. What it does not buy is
 * a proof — three reads a minute apart say nothing about a field that moves at
 * midnight, and a URL that could not be read twice is reported `insufficient`
 * rather than stable. This is a floor under the compile, not a guarantee.
 */

// ------------------------------------------------------------------ readings

/** One item's values, coerced to the declared field types, as one replay produced them. */
export type ItemValues = Record<string, TypedValue>;

/**
 * One reading: what a single replay of a single URL produced, one entry per
 * item. Record mode has exactly one item; a listing has one per row, and may
 * have none — a page that yielded twelve rows once and zero the next time is
 * precisely the phantom failure, so an empty reading is a reading and not an
 * error.
 */
export type PageReading = readonly ItemValues[];

/** N readings of one URL, in the order they were taken. */
export interface UrlReadings {
  url: string;
  readings: readonly PageReading[];
}

// ----------------------------------------------------------------- the policy

/** How many times each sampled URL is read. See the header for why three. */
export const DEFAULT_REPLAYS = 3;

/**
 * How many of the investigation's sample URLs this stage replays. The caller
 * slices its own sample to this; the sample was already chosen to span the
 * strata, and re-choosing it here would make the determinism stage disagree
 * with the manuscript about which pages the compile was argued from.
 */
export const DEFAULT_SAMPLE_URLS = 6;

// ---------------------------------------------------------------- the artifact

/**
 * One distinct thing a field was seen to be, across the N readings of one URL.
 *
 * `values` is one entry per item, in the order the first reading that took this
 * form produced them — not the sorted order the comparison used, because a
 * reader wants the page's own order. An item that had no entry for the field at
 * all is coalesced to `null` here; the distinction is kept where it matters, in
 * the comparison, so absent and null are never one form.
 */
export interface DeterminismForm {
  values: TypedValue[];
  /** How many of the N readings produced this form. */
  readings: number;
}

/** One URL on which a field did not hold still. */
export interface Movement {
  url: string;
  /** Every distinct form, in first-seen order. Two entries at least, or it would not be here. */
  forms: DeterminismForm[];
}

/**
 * `held` — every reading of every URL agreed. The binding may be committed.
 * `moved` — at least one URL disagreed with itself. **Rejected**: this is the
 * measurement, and nothing downstream may heal, repair or drift-report it.
 * `absent` — no sampled URL offered this field at all. A coverage question,
 * owned by the reconciliation, and deliberately not an instability one.
 */
export type Stability = "held" | "moved" | "absent";

export interface FieldStability {
  field: string;
  outcome: Stability;
  /** On how many sampled URLs it moved. */
  movedOn: number;
  /** On how many sampled URLs it was read at all. */
  readOn: number;
  /** One entry per URL where it moved, in sample order. */
  movements: Movement[];
  /** `true` only for `moved`: this binding may not be committed or repaired. */
  rejected: boolean;
  because: string;
}

/** One sampled URL and how many times it was actually read. */
export interface UrlRecord {
  url: string;
  /** Fewer than two means this URL proved nothing; the verdict says so rather than counting it as agreement. */
  readings: number;
}

/**
 * **U6b's slot, and U6a never fills it.**
 *
 * A field can also fail because two *alternatives of the same field* disagree
 * on one page — Store B's `promoPrice`, network 3321 against dom 2952 on all
 * six URLs. That is not instability across runs: both alternatives are perfectly
 * repeatable and each is right about a different thing, which is why the answer
 * is two fields rather than a ranking. It is a different unit, and the shape is
 * declared here only so the finding lands in this artifact and this stage block
 * instead of a second one.
 *
 * Absent means nobody asked. It does not mean nothing disagreed.
 */
export interface AlternativeDisagreement {
  field: string;
  /** What each alternative that answered returned, in compiled alternative order. */
  readings: Array<{ source: string; value: TypedValue }>;
  /** On how many sampled URLs they disagreed, of how many they were both read on. */
  disagreedOn: number;
  readOn: number;
  because: string;
  /** Free-form, for whatever U6b traces the values back to. */
  traced?: string[];
}

/**
 * `determinism.json`.
 *
 * The same two properties the manuscript and the reconciliation keep, for the
 * same reasons:
 *
 *  - **JSON-serialisable.** No `Map`, no `Date`, no class instance. It is
 *    written next to the scraper and read back months later by a run, a person
 *    and a diff.
 *  - **Stable.** Every list is in a declared order — fields in the order the
 *    spec asked for them, never re-sorted by outcome, so a diff between two
 *    determinism runs is a real change and not a field changing rank. The one
 *    field a re-run moves, `recordedAt`, comes from an injected clock.
 */
export interface Determinism {
  version: 1;
  site: string;
  /** The only field a re-run moves; injected, so a test and a diff can pin it. */
  recordedAt: string;
  /** N: how many readings each URL was asked for. `urls` says how many it gave. */
  replays: number;
  urls: UrlRecord[];
  /** Every field, in the order the spec asked for it. */
  fields: FieldStability[];
  alternatives?: AlternativeDisagreement[];
  /**
   * `stable` — nothing moved, on a sample that could tell.
   * `unstable` — something moved. The named fields are rejected.
   * `insufficient` — no URL was read twice, so nothing here is evidence of
   * anything. Deliberately a third value: reporting `stable` for a sample that
   * could not disagree with itself is how this stage would become the thing it
   * was built to catch.
   */
  verdict: "stable" | "unstable" | "insufficient";
  because: string;
}

export interface DeterminismOptions {
  /** The site, as the manuscript names it. */
  site?: string | undefined;
  /** The spec's field order, so the artifact is in the order the client asked. Fields read but not declared are appended, sorted. */
  fields?: readonly string[] | undefined;
  /** N as requested, which may be more than any URL managed. Defaults to the largest count in the sample. */
  replays?: number | undefined;
  /** The clock, so a determinism record is reproducible. */
  now?: Date | undefined;
}

// ----------------------------------------------------------- the comparison

/**
 * The form two readings of one value are compared in.
 *
 * The prefixes are load-bearing: without them the string `"null"` and the value
 * `null` are one form, and so are `3321` and `"3321"`. A field that flips
 * between a number and its own text has moved — the coercion moved, which is
 * the same class of defect as the value moving and is harder to see.
 */
function formOf(value: TypedValue | undefined): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "string") return `text:${normalize(value)}`;
  return `${typeof value}:${String(value)}`;
}

/**
 * One reading of one field on one page, as one comparable string.
 *
 * Sorted, so re-ordered rows are one form. The separator is a NUL escape and
 * not a space or a comma: a normalized value keeps its internal spaces and may
 * contain a comma, so on either of those `["ab", "c"]` and `["a", "bc"]` would
 * join to one string and two different pages would agree. It is written as an
 * escape rather than typed, because a literal NUL byte makes this file binary
 * to `grep` and to a diff.
 */
function pageForm(values: readonly (TypedValue | undefined)[]): string {
  return values.map(formOf).sort().join("\u0000");
}

// ------------------------------------------------------------- the judgement

/** The declared order first, then anything read that the spec did not name, sorted. */
function fieldOrder(sample: readonly UrlReadings[], declared: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const { readings } of sample) for (const reading of readings) for (const item of reading) for (const name of Object.keys(item)) seen.add(name);
  const order = [...(declared ?? [])];
  const named = new Set(order);
  for (const name of [...seen].sort()) if (!named.has(name)) order.push(name);
  return order;
}

function summaryOfForms(forms: readonly DeterminismForm[]): string {
  return forms.map((form) => `${showForm(form)} on ${form.readings} of them`).join(", then ");
}

/**
 * The decision, and it is pure: no page, no browser, no clock but the injected
 * one. Everything this stage claims has to be arguable from a fixture, because
 * a determinism check that can only be run against the live site is the same
 * half-a-program that let the 2026-09-22 findings out.
 */
export function judgeDeterminism(sample: readonly UrlReadings[], options: DeterminismOptions = {}): Determinism {
  const now = options.now ?? new Date();
  const urls: UrlRecord[] = sample.map(({ url, readings }) => ({ url, readings: readings.length }));
  const comparable = sample.filter(({ readings }) => readings.length >= 2);
  const replays = options.replays ?? Math.max(0, ...urls.map((record) => record.readings));

  const fields: FieldStability[] = [];
  for (const field of fieldOrder(sample, options.fields)) {
    const movements: Movement[] = [];
    let readOn = 0;

    for (const { url, readings } of sample) {
      if (!readings.some((reading) => reading.some((item) => field in item))) continue;
      readOn++;
      // One reading cannot disagree with itself, and counting it as agreement
      // would let a URL that failed to load twice vote for stability.
      if (readings.length < 2) continue;

      const forms = new Map<string, DeterminismForm>();
      for (const reading of readings) {
        const values = reading.map((item) => item[field]);
        const form = pageForm(values);
        const seen = forms.get(form);
        if (seen === undefined) forms.set(form, { values: values.map((value) => value ?? null), readings: 1 });
        else seen.readings++;
      }
      if (forms.size > 1) movements.push({ url, forms: [...forms.values()] });
    }

    const outcome: Stability = readOn === 0 ? "absent" : movements.length > 0 ? "moved" : "held";
    fields.push({
      field,
      outcome,
      movedOn: movements.length,
      readOn,
      movements,
      rejected: outcome === "moved",
      because: becauseOfField(field, outcome, movements, readOn, comparable.length),
    });
  }

  const moved = fields.filter((field) => field.outcome === "moved");
  const verdict: Determinism["verdict"] = comparable.length === 0 ? "insufficient" : moved.length > 0 ? "unstable" : "stable";

  return {
    version: 1,
    site: options.site ?? "",
    recordedAt: now.toISOString(),
    replays,
    urls,
    fields,
    verdict,
    because: becauseOfRun(verdict, moved, comparable.length, urls.length, replays),
  };
}

function becauseOfField(field: string, outcome: Stability, movements: readonly Movement[], readOn: number, comparable: number): string {
  if (outcome === "absent") {
    return `${field} was not read on any sampled URL, so there was nothing to read twice. That is a coverage question for the reconciliation and not an instability one.`;
  }
  if (outcome === "held") {
    if (comparable === 0) return `${field} was read on ${readOn} URLs, none of them twice, so it has not held still — it has not been asked.`;
    return `${field} took one form on every reading of each of the ${readOn} URLs it was read on.`;
  }
  const first = movements[0]!;
  return (
    `${field} moved on ${movements.length} of the ${readOn} URLs it was read on, starting with ${first.url}: ${summaryOfForms(first.forms)}. ` +
    `Nobody changed the page between those readings, so what moved is the measurement and not the site. ` +
    `The binding is rejected rather than repaired: a repair here appends an alternative chosen against whichever form the page happened to show that second.`
  );
}

function becauseOfRun(verdict: Determinism["verdict"], moved: readonly FieldStability[], comparable: number, sampled: number, replays: number): string {
  if (verdict === "insufficient") {
    return (
      `No sampled URL was read twice${sampled === 0 ? "" : ` (${sampled} sampled, ${comparable} read more than once)`}, so nothing here is evidence. ` +
      `This is not stability: a reading cannot disagree with itself, and calling that agreement is the defect this stage exists to catch.`
    );
  }
  if (verdict === "stable") {
    return `Every field took one form on all ${replays} readings of each of the ${comparable} URLs, so the extraction says the same thing twice about a page nobody changed.`;
  }
  const names = moved.map((field) => field.field).join(", ");
  return (
    `${moved.length === 1 ? "One field" : `${moved.length} fields`} moved on an unchanged page across ${replays} readings of ${comparable} URLs: ${names}. ` +
    `${moved.length === 1 ? "It is" : "They are"} rejected as measurement. Nothing downstream may repair, heal or drift-report ${moved.length === 1 ? "it" : "them"} — ` +
    `a finding raised against a value that will not hold still is a finding about navvi.`
  );
}

// --------------------------------------------------------------- the consumers

/** Did this field fail to hold still? The question a healer has to ask before it repairs anything. */
export function isUnstable(determinism: Determinism, field: string): boolean {
  return determinism.fields.some((record) => record.field === field && record.rejected);
}

/** Every rejected field, in artifact order. Nothing here may be committed, healed or drift-reported. */
export function unstableFields(determinism: Determinism): string[] {
  return determinism.fields.filter((record) => record.rejected).map((record) => record.field);
}

// ------------------------------------------------------------------ the driver

export interface DeterminismDriver {
  /**
   * Read one URL once, exactly as a replay would: navigate, extract, coerce.
   *
   * A read that throws is not caught here. A URL that cannot be read N times
   * has not been measured, and a determinism stage that swallows load failures
   * would report `stable` about pages it never saw — which is the shape of
   * every defect this file is here for.
   */
  read(url: string, round: number): Promise<PageReading>;
}

/**
 * The thin half: read each URL N times, then hand the readings to the pure
 * judgement above.
 *
 * Round-major rather than URL-major on purpose. Three back-to-back reads of one
 * URL are served by the same warm cache and prove nothing; going round by round
 * puts every other URL in the sample, and a real re-navigation, between two
 * readings of the same page — which is where the 2026-09-22 movement lived.
 */
export async function measureDeterminism(urls: readonly string[], driver: DeterminismDriver, options: DeterminismOptions = {}): Promise<Determinism> {
  const replays = options.replays ?? DEFAULT_REPLAYS;
  // A URL listed twice is one page, not two votes.
  const unique = [...new Set(urls)];
  const readings = new Map<string, PageReading[]>(unique.map((url) => [url, []]));
  for (let round = 0; round < replays; round++) {
    for (const url of unique) readings.get(url)!.push(await driver.read(url, round));
  }
  return judgeDeterminism(
    unique.map((url) => ({ url, readings: readings.get(url)! })),
    { ...options, replays },
  );
}

/**
 * A `PageExtraction` as one reading.
 *
 * `items` and never the top-level values: record mode puts its one item there
 * too, so reading both would count a record page's single item twice.
 */
export function readingOf(extraction: PageExtraction, types: Record<string, FieldType | undefined>): PageReading {
  return extraction.items.map((item) => coerceValues(item.values, types, item.sourceUrl));
}

// ------------------------------------------------------------ the stage block

/** Where the block's summary starts, where the artifact path starts, where a bullet's text starts. */
const HEAD = 14;
const DATA = 54;
const BULLET = 16;

/**
 * A value as the block prints it: quoted when it is text, bare when it is not.
 * `JSON.stringify` already spells exactly that, so nothing here re-decides it.
 */
function showValue(value: TypedValue): string {
  return JSON.stringify(value);
}

function showForm(form: DeterminismForm): string {
  if (form.values.length === 0) return "no items";
  if (form.values.length === 1) return showValue(form.values[0]!);
  return clip(`${form.values.length} items: ${form.values.map(showValue).join(", ")}`, 52);
}

/**
 * One block on stderr while the run is happening, in the shape
 * `reconcile/render.ts` and `investigate/manuscript.ts` print: the decision on
 * the left, the artifact path on the right, and nothing that restates the file.
 *
 * What a person watching a compile needs from this stage is the count, and then
 * every field that will not be committed. A stable run is one line.
 */
export function summarizeDeterminism(determinism: Determinism, dataLine = ""): string {
  const moved = determinism.fields.filter((field) => field.outcome === "moved");
  const count = `${moved.length === 1 ? "1 field" : `${moved.length} fields`} moved`;
  const head = "determinism".padEnd(HEAD, " ") + `${determinism.replays} replays x ${determinism.urls.length} URLs, ${count}`;
  const lines = [dataLine === "" ? head : head.padEnd(DATA, " ") + dataLine];

  const bullet = (label: string, text: string): void => {
    lines.push(`  ! ${label.padEnd(BULLET - 4, " ")}${text}`);
  };
  const continuation = (text: string): void => {
    lines.push(" ".repeat(BULLET) + text);
  };

  for (const field of moved) {
    const first = field.movements[0]!;
    bullet(field.field, `${first.forms.map(showForm).join(" then ")} on ${field.movedOn} of ${field.readOn} - rejected, not repaired`);
  }

  // U6b's finding, when U6b put one here. Same block, because a field that
  // cannot be committed is one decision however it failed.
  for (const disagreement of determinism.alternatives ?? []) {
    const readings = disagreement.readings.map((reading) => `${reading.source} ${showValue(reading.value)}`).join(" vs ");
    bullet(disagreement.field, `${readings} on ${disagreement.disagreedOn} of ${disagreement.readOn} - alternatives disagree`);
    for (const line of disagreement.traced ?? []) continuation(line);
  }

  // A run that could not tell says so. Silence would read as the one-line
  // stable case, which is the reading this stage may never allow.
  if (determinism.verdict === "insufficient") continuation(`! insufficient: ${determinism.because}`);

  return lines.join("\n") + "\n";
}
