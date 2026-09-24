import type { FieldType } from "../input/schema.js";
import type { TypedValue } from "../scraper/extract.js";
import type { FieldSource } from "../scraper/schema.js";
import type { FieldAlias, Obstacle, TierDecision } from "../investigate/manuscript.js";

/**
 * U4/U5: the argument, and the schema it proves.
 *
 * The manuscript (U2f) says what the investigation *did*. This says what the
 * client *gets*, and — the part that makes it worth writing — what they could
 * have had, what they cannot have, and which of their own rules settled the
 * calls that were close. A compile you cannot argue with is a compile you have
 * to rerun to disagree with; a compile whose schema is copied off the brief is
 * one nobody can check at all, because it asserts exactly what was asked.
 *
 * So `schema.json` is derived from this file's `obtainable` list, never from
 * `spec.fields`. A field that was not proved obtainable does not appear. That
 * is the whole of U5.
 *
 * The same two properties as the manuscript, for the same reasons:
 *
 *  - **JSON-serialisable.** No `Map`, no `Date`, no class instance.
 *  - **Stable.** Every list below is in a declared order, and `reconciledAt` —
 *    the one field a re-run moves — comes from an injected clock so a test and
 *    a diff can pin it.
 */

// ------------------------------------------------------------------ evidence

/**
 * How we know a leaf exists.
 *
 * `inventory` is the whole set of leaves the bound endpoints offered.
 * `rejected` is the fallback for a manuscript written before
 * `Manuscript.inventory` existed: it only sees leaves that competed for a
 * field the spec named, so it is **type-contingent and incomplete**, and every
 * record built from it says so rather than passing itself off as a catalogue.
 */
export type LeafEvidence = "inventory" | "rejected";

// ---------------------------------------------------------------- obtainable

/** A field the investigation bound, with where from. */
export interface ObtainableField {
  field: string;
  /** Declared by the spec, or read off the bound values when the spec left it open. */
  type: FieldType;
  /** `true` when the type was inferred from the values rather than declared. */
  typeInferred: boolean;
  /** 3: a DOM selector a chooser picked for a field the cheap tiers left uncovered. */
  tier: 1 | 2 | 3;
  source: FieldSource;
  /** For a `network` binding: the endpoint the path is read out of. */
  match?: string;
  path?: string;
  selector?: string;
  attr?: string;
  entity?: string;
  /** The bound value on each binding sample, in sample order. */
  values: TypedValue[];
  /**
   * Other readings carrying the same value — free alternatives for the compile.
   *
   * Each carries its own `source`, `selector`, `attr` and `entity`, the same
   * shape the binding above it carries, so `src/compile/` can emit one without
   * assuming it is read the way the binding is. It is not: a tier-1 binding may
   * be a JSON-LD path and its alias an OpenGraph property on a `<meta>` element.
   */
  aliases: FieldAlias[];
  /** One line naming where it came from, for a reader who will not open the JSON. */
  where: string;
  /**
   * U6b: the requested field this column was split off, when the client never
   * asked for it by name. Absent on a field the spec asked for.
   *
   * It is a column like any other below this line — same `values`, same
   * `where`, same leaf — because that is the whole claim: the second reading
   * was never a bad alternative, it was a field nobody had asked for yet.
   */
  splitFrom?: string;
  /** Tier 3 only: the question that bound it and the backend that answered, carried to `rationale.md`. */
  decision?: TierDecision;
  because: string;
}

// ------------------------------------------------------------ not obtainable

/**
 * `no-candidate` — nothing any tier that ran offered for this field.
 * `type-gap` — something *was* stated and the declared type refused it. Never
 * reported as a plain absence: the site answered, the column did not fit, and
 * that is a decision the client owns rather than a hole in the site.
 * `shared-path` — the manuscript bound this field and another to one reading.
 * One leaf is one fact, so neither is obtainable from it; `investigate` has
 * refused to write such a manuscript since 2026-09-23, and this is what an
 * older or edited one reads as.
 */
export type NotObtainableKind = "no-candidate" | "type-gap" | "shared-path";

export interface NotObtainableField {
  field: string;
  type?: FieldType;
  kind: NotObtainableKind;
  because: string;
  /**
   * Tier 3 has been handed this field and did not run; the DOM compiler may
   * still answer it. False once tier 3 ran, whatever it found: "may still
   * answer" about a compiler that already answered is a promise nobody keeps.
   */
  stillAsked: boolean;
  /** For `type-gap`: the ambiguity that carries both types and the decision. */
  ambiguity?: string;
}

// ------------------------------------------------- available but not requested

/**
 * A leaf the site states about this record that nothing asked for.
 *
 * The membership test is evidence, not vocabulary. A leaf is here when it is
 * present on every answering sample and at least one of:
 *
 *  - it **anchored** — its value was in what the page showed a reader, so a
 *    person looking at the page can see it; or
 *  - it **varies** across the samples, so it describes the record rather than
 *    the site, the session or the build.
 *
 * Neither signal is a claim that the client wants it, and the artifact does not
 * pretend otherwise: both flags are on every row and the rows are ordered by
 * how many fired, so `laboratory` (shown and varying) sorts above
 * `telemetry.sessionId` (varying, never shown). Naming a session id as
 * available and letting the reader dismiss it is honest; guessing which key
 * names are noise is a word list nobody can check.
 *
 * `telemetry.sessionId` sorting last used to be the *whole* of that judgement:
 * a bare arithmetic rank put it at the bottom and nothing anywhere said why a
 * reader should dismiss it. A judgement with no recorded ground is the class of
 * defect this repository keeps hitting, so the reason is now asked of the bank
 * and carried on the row. See `machinery`.
 */
export interface AvailableLeaf {
  match: string;
  path: string;
  values: TypedValue[];
  /** Its value was in what each page showed a reader. `undefined` — not asked. */
  anchored?: boolean;
  /** It is not the same value on every sample. */
  varies: boolean;
  evidence: LeafEvidence;
  /**
   * The bank's answer to "is this the machine talking to itself", when it had
   * one.
   *
   * Present only when `machine-value-is-not-a-fact` **fired**: no page showed
   * the value to a reader and every sample of it reads as a token, a clock or
   * a build stamp. Absent means the rule abstained or was overridden, which is
   * not the same claim as "this is a fact about the record" — the rule says so
   * itself in `because` when it declines, and the row is ordered as if it had
   * never been asked.
   *
   * It orders the list and it is the sentence a reader dismisses the row on.
   * Nothing downstream drops a leaf for carrying it: the catalogue's whole
   * point is that the client sees what the site offered, including the parts
   * navvi thinks are bookkeeping.
   */
  machinery?: { heuristic: string; because: string; action: string };
  because: string;
}

// --------------------------------------------------------------- ambiguities

/**
 * `competing-values` — two or more readings of one field that disagree on the
 * same page. Not a bad alternative to be dropped and not a ranking problem:
 * the page carries two facts and the spec asked for one.
 * `type-gap` — the spec's column type and the site's own vocabulary disagree.
 */
export type AmbiguityKind = "competing-values" | "type-gap";

/** One reading of a field, as the ambiguity table shows it. */
export interface Reading {
  tier: 1 | 2 | 3;
  source?: FieldSource;
  match?: string;
  path: string;
  values: TypedValue[];
  /** `true` when this is the reading the investigation bound. */
  bound: boolean;
}

/**
 * A rubric, quoted. **The rationale is what makes the binding checkable**, so
 * the rule is carried verbatim out of the spec and never paraphrased.
 */
export interface QuotedRubric {
  id: string;
  rule: string;
  source: string;
  /** Why this rubric was matched to this field. */
  because: string;
}

export interface Ambiguity {
  /** Stable, derived from the field and kind, so a diff can follow one across runs. */
  id: string;
  field: string;
  kind: AmbiguityKind;
  /** For `competing-values`: the readings, bound one first, then by path. */
  readings: Reading[];
  /** For `type-gap`: what the spec asked for and what the site states. */
  declaredType?: FieldType;
  statedType?: string;
  /** The rubrics that settle it, quoted. Empty when nothing in the spec does. */
  settledBy: QuotedRubric[];
  /** The reading a rubric settled on, when one did. */
  resolved?: string;
  /** What a client has to decide, when nothing settles it. */
  decision?: string;
  because: string;
}

// --------------------------------------------------- U6b: the two-field case

/**
 * U6b: what two alternatives of one field returned on one page.
 *
 * **Produced by `src/replay/determinism.ts` and declared here**, which is the
 * one thing about this type worth explaining. The *observation* belongs to the
 * replay stage: a compiled field's alternatives are only ever resolved
 * together against a live page, and the Store B disagreement is invisible
 * at compile time because on the binding samples the two readings **agreed** —
 * the club promotion was not live that day, which is exactly why the DOM
 * selector passed as a fallback. The *decision* belongs here, because the
 * decision is "these are two fields" and a field is a column of the
 * reconciliation. So the record crosses one seam, and it is declared on the
 * side that has to keep it stable, next to the ambiguity it is the answer to.
 *
 * `disagreedOn` and `readOn` are counts of URLs, never of findings. Nothing in
 * this record says an alternative is wrong: both are repeatable and each is
 * right about a different thing.
 */
export interface AlternativeDisagreement {
  field: string;
  /** What each alternative that answered returned, in compiled alternative order. */
  readings: Array<{ source: string; value: TypedValue }>;
  /** On how many sampled URLs they disagreed, of how many they were both read on. */
  disagreedOn: number;
  readOn: number;
  because: string;
  /** Free-form, for the trace `src/reconcile/` puts back into the stage block. */
  traced?: string[];
}

/**
 * What became of one reading of a disagreement, once it was traced.
 *
 * `requested` — it traced to the leaf the requested field is already bound to,
 * so this reading *is* the column the client asked for and there is nothing to
 * emit.
 * `split` — it traced to a **different** leaf. The page carries two facts; the
 * second one is emitted as its own obtainable field, bound to that leaf.
 * `unaccounted` — no leaf of this endpoint carried this value on any sample.
 * **This is itself the finding**, and it is the one case that cannot be
 * compiled: the page is showing something this call did not return, which
 * means either there is an endpoint the investigation never captured or the
 * page computes the number in the browser. navvi does not invent a binding for
 * it — getting this wrong in the confident direction is the whole of the
 * 2026-09-22 defects.
 * `refused` — it traced, and navvi still would not act on it: two leaves that
 * carry the value disagree with each other, or the derived name collides with
 * a column that already exists, or the manuscript carries no leaf catalogue to
 * trace against at all. A person decides; `because` says which of those it was.
 */
export type TraceOutcome = "requested" | "split" | "unaccounted" | "refused";

export interface TracedReading {
  /** The alternative, as the replay stage named it: `network`, `dom`, `json-ld`. */
  source: string;
  value: TypedValue;
  outcome: TraceOutcome;
  /** The leaf that carried this value, for every outcome but `unaccounted`. */
  leaf?: string;
  /** Other readings of the same endpoint carrying the same fact on every sample. */
  aliases?: FieldAlias[];
  /** The field this became, for `split`. */
  emitted?: string;
  because: string;
}

/**
 * One cross-alternative disagreement, traced.
 *
 * The reason this is a list of its own rather than a third `AmbiguityKind`:
 * an ambiguity is a question for the client, and this is an **answer**. Two
 * readings that each trace to their own leaf are two fields, and the client is
 * told what they now have rather than asked which one they meant.
 */
export interface DisagreementRecord {
  field: string;
  /** Every reading, in the order replay resolved the alternatives. */
  readings: TracedReading[];
  /** The fields this emitted, in the order they were appended to `obtainable`. */
  emitted: string[];
  /** A reading had no leaf behind it. Always a decision for a person. */
  unaccounted: boolean;
  /** What a person has to do. Absent when the split answered the whole of it. */
  decision?: string;
  because: string;
}

// ----------------------------------------------------------------- obstacles

/**
 * An obstacle, with what it costs.
 *
 * The manuscript records the obstacle; the cost is the sentence the client
 * reads. A consent dialog costs a prestep on every page for the life of the
 * scraper; a shell costs a render per URL where a plain fetch would have done.
 * Both are the answer to "can we run this daily", which is the question the
 * manuscript's `blocking` flag alone does not answer.
 */
export interface ObstacleCost {
  kind: Obstacle["kind"];
  url?: string;
  because: string;
  evidence?: string;
  blocking: boolean;
  /** What it costs the compiled scraper, per run. */
  cost: string;
}

// ------------------------------------------------------------ reconciliation

export interface Reconciliation {
  version: 1;
  site: string;
  /** What the brief asked for, verbatim, so the argument is traceable to it. */
  brief: string;
  /** The only field a re-run moves; injected, so a test and a diff can pin it. */
  reconciledAt: string;
  obtainable: ObtainableField[];
  notObtainable: NotObtainableField[];
  available: AvailableLeaf[];
  ambiguities: Ambiguity[];
  /**
   * U6b. **Optional on purpose, and the reason is U6a's.** Absent means nobody
   * handed this reconciliation a replay observation, so no alternative was
   * ever resolved twice on one page and nothing here could have been checked.
   * An empty array is the different claim that it was checked and every
   * field's alternatives agreed.
   */
  disagreements?: DisagreementRecord[];
  obstacles: ObstacleCost[];
  /** How the leaf catalogue was built, and what it cannot see when it is `rejected`. */
  availableEvidence: LeafEvidence;
  /**
   * `complete` — every requested field is obtainable and nothing is open.
   * `partial` — some fields are obtainable and some are not.
   * `open` — an ambiguity or a blocking obstacle needs a person.
   * `empty` — nothing was bound.
   */
  verdict: "complete" | "partial" | "open" | "empty";
  because: string;
}

// ---------------------------------------------------------- U5: the schema

/** One column of `schema.json`, naming the evidence that proved it. */
export interface SchemaField {
  name: string;
  type: FieldType;
  /** `true` when the type was read off the values rather than declared by the spec. */
  typeInferred: boolean;
  source: FieldSource;
  match?: string;
  path?: string;
  selector?: string;
  attr?: string;
  entity?: string;
  /** The tier that proved it. */
  tier: 1 | 2 | 3;
  /** One example value, from the first binding sample. */
  example?: TypedValue;
  because: string;
}

/**
 * The output schema, derived from what was **proved obtainable**.
 *
 * Not from the brief, and not from `spec.fields`. "Product info" names no
 * column; five typed columns each naming its source is what the client
 * approves, and every one of them is backed by a value read off a real page.
 */
export interface OutputSchema {
  version: 1;
  site: string;
  /** What one row is, from the spec. */
  entity: string;
  derivedAt: string;
  fields: SchemaField[];
  /** Requested and not in `fields`, so the omission is visible rather than silent. */
  omitted: Array<{ name: string; because: string }>;
  because: string;
}
