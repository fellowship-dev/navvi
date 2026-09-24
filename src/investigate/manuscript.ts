import type { Verdict } from "../heuristics/index.js";
import type { FieldType } from "../input/schema.js";
import type { TypedValue } from "../scraper/extract.js";
import type { FieldSource } from "../scraper/schema.js";
import type { CanaryFingerprint } from "./blocked.js";
import type { ExcludedProbe, PickReason, UnfilledStratum } from "./sample.js";

/**
 * U2f: the investigation manuscript.
 *
 * One committed artifact naming every source, every sample, every obstacle and
 * every rejection. The ergonomic is borrowed from `mvanhorn/cli-printing-press`,
 * whose browser-sniff gate archives the pages it visited, the endpoints it
 * found, the response samples it kept and the protection signals it met as a
 * committed file with full provenance — so a generated client can be argued
 * with rather than only rerun.
 *
 * navvi needs it for a sharper reason. On 2026-09-22 three compiled scrapers
 * were confidently wrong in three different ways — a seasonal CSS class, a list
 * price bound to a sale price, two fields collapsed onto one node — and each
 * one looked fine from the outside: every value extracted, every type checked.
 * Understanding any of them meant opening `scraper.json` and squinting at a
 * selector. The manuscript is the other half of that file: **what was tried,
 * what it covered, and what was refused.** A compile you cannot argue with is a
 * compile you have to rerun to disagree with.
 *
 * Two properties it has to keep, because they are what make it worth
 * committing:
 *
 *  - **JSON-serialisable.** No `Map`, no `Date`, no class instance. It is
 *    written next to the scraper and read back months later by a run, a person
 *    and a diff.
 *  - **Stable.** The same investigation produces the same manuscript, so a diff
 *    between two runs is a real change and not a reordering. Every list here is
 *    in a deterministic order, and `recordedAt` — the one field a re-run moves —
 *    comes from an injected clock so a test pins it.
 */

/** Heuristic verdicts in the shape `bindField` and `classifyRun` already emit. */
export type VerdictLog = Array<{ id: string; verdict: Verdict }>;

/** A field the spec asked for, with the type it has to coerce to. */
export interface RequestedField {
  name: string;
  type?: FieldType | undefined;
}

// ------------------------------------------------------------------- sources

/**
 * One thing the investigation read. URLs are `safeUrl`-amputated before they
 * get here: a captured endpoint's query string carries `?token=`, `?sig=` as
 * often as a header does, and this file is committed.
 */
export interface SourceRecord {
  url: string;
  kind: "plain-fetch" | "payload" | "render";
  status?: number;
  /** The `match` a compiled `network` alternative would carry for this endpoint. */
  match?: string;
  /** How many candidates it offered: declared findings for a fetch, flattened leaves for a payload. */
  found: number;
  because: string;
}

// --------------------------------------------------------------------- tiers

export type TierName = "declared" | "payload" | "dom";

/**
 * What one tier was asked for and what it answered.
 *
 * `outcome` is the cascade's whole point written down. `skipped` is the
 * valuable one — a tier that did not run because an earlier one covered
 * everything, or because a heuristic said it would not pay — and it has to say
 * which, because "tier 2 covered nothing" and "tier 2 was never spent" are the
 * same empty `covered` list and very different facts.
 */
export interface TierRecord {
  tier: 1 | 2 | 3;
  name: TierName;
  outcome: "ran" | "skipped" | "requested";
  because: string;
  /** The fields this tier was handed: what the tiers above it left uncovered. */
  asked: string[];
  /** The fields it settled. */
  covered: string[];
  sources: SourceRecord[];
  verdicts: VerdictLog;
}

// -------------------------------------------------------------------- fields

/** A candidate a tier considered and did not bind, with the reason it lost. */
export interface RejectionRecord {
  /** 3: a DOM candidate the chooser picked and the selector gate refused. */
  tier: 1 | 2 | 3;
  path: string;
  /** The value on each binding sample, in sample order. */
  values: TypedValue[];
  because: string;
  /**
   * The bank rule that refused this leaf, when one did.
   *
   * A rejection with a rule behind it is not a competing reading: the leaf lost
   * because a rule said what it is, not because another leaf named the field
   * better. `src/reconcile/` reads the difference — it does not offer a leaf
   * the bank called machinery as a second reading of a bound field.
   */
  heuristic?: string;
  /**
   * U6: how to read this leaf, when it lost to another declaration of the
   * same page.
   *
   * A tier-1 rejection is a whole declaration -- a JSON-LD path, a microdata
   * property, an OpenGraph `<meta>` -- and the path alone does not say which,
   * so a chooser that picks it over the bound reading (KTD5) could not be
   * compiled from the path without borrowing the binding's selector, which is
   * the defect `FieldAlias` closed for aliases. Absent on tier 2, where the
   * endpoint in `path` is the whole of it, and on a manuscript written before.
   */
  read?: FieldAlias;
}

/**
 * Another reading of the same fact, carrying **its own** source.
 *
 * It used to be a bare path, and the bare path was a silent assumption: that
 * an alias is read exactly the way the binding is, so the binding's `source`,
 * `match`, `selector`, `attr` and `entity` apply to it. For tier 2 that is
 * provably true — `narrow` builds a candidate's aliases out of other leaves of
 * the same flattened payload, so the binding's endpoint plus the alias path is
 * a complete alternative — and for tier 1 it is false. `bindRole` collects
 * every declaration of one role, and those are different kinds: a JSON-LD path
 * rides in as `json-ld` with an `entity`, an OpenGraph property as `dom` with
 * `meta[property=...]` and `attr: "content"`. Compiling the second under the
 * first's source emits an alternative that can never resolve.
 *
 * So the compile refused to emit any of them, and `rationale.md` reported
 * every tier-1 alias as "stated elsewhere, not compiled" — a fact about this
 * record's shape being reported as a fact about the site. This type is what
 * closes it: an alias says how to read itself, in the same words the binding
 * uses, so `src/compile/proven.ts` can emit it without inventing anything.
 *
 * **Compatibility.** A manuscript written before this carries `aliases` as an
 * array of strings. Nothing validates `Manuscript` with a schema, so an old
 * file parses; `aliasesOf` in `src/reconcile/reconcile.ts` is the one reader
 * and it accepts both, reading a bare string as the old assumption — the
 * binding's own source — which is what the old compile did with it and is
 * still right for the `network` case that was the only one it compiled.
 */
export interface FieldAlias {
  /** Spelled as the binding's own `path` is spelled for this source. */
  path: string;
  /** The `FIELD_SOURCES` value an alternative for this alias has to carry. */
  source: FieldSource;
  /** For `network`: the endpoint the path is read out of. */
  match?: string;
  /** The script tag for `json-ld`, a real CSS selector for `dom`, the endpoint for `network`. */
  selector?: string;
  /** For `dom`: the attribute it reads; absent means the element's text. */
  attr?: string;
  /** For `json-ld` and microdata: the schema.org type the path is read from. */
  entity?: string;
}

/**
 * Who decided a tier-3 binding, and what they were asked.
 *
 * Tiers 1 and 2 bind by rule, and the rule is the argument. Tier 3 binds
 * because a chooser picked one code-enumerated candidate over the others, so
 * the argument is the question and the answer: which field, the premise the
 * chooser read, how many options it had, the one it chose, and which backend
 * answered. A rationale that says "tier 3, dom h1" without that is a binding
 * nobody can disagree with, which is the thing the manuscript exists to stop.
 */
export interface TierDecision {
  /**
   * The question id: `field.<name>` for a tier-3 DOM pick (with `.retry` after
   * the scroll-and-retry), `reading.<name>` for an open ambiguity (U6).
   */
  question: string;
  premise: string;
  /** How many candidates were offered, `none` not counted. */
  options: number;
  /** The option chosen, as the chooser saw it: `<path> = <value on each sample>`. */
  chose: string;
  /** The chooser that answered (`jev`, `claude`, `model`, `recorded`, ...). */
  answeredBy: string;
  /**
   * U6: the ambiguity this answer settled, e.g. `productName/competing-values`.
   *
   * Present on a decision taken over the readings the cheap tiers found rather
   * than over DOM candidates. `src/reconcile/` reads it to call that
   * ambiguity decided -- by this backend, on this question -- rather than
   * open, so a reconciliation of the decided manuscript compiles and a re-run
   * does not ask again.
   */
  settles?: string;
}

/**
 * One field's answer, with the path and every verdict behind it.
 *
 * `tier` absent means nothing cheap covered it and tier 3 was asked; `askModel`
 * means a tier narrowed the table but could not settle it, which is the only
 * state in which a model is worth paying for.
 */
export interface FieldRecord {
  field: string;
  type?: FieldType;
  /** 3 since U4: a DOM selector the chooser picked for a field tiers 1 and 2 left uncovered. */
  tier?: 1 | 2 | 3;
  /** The `FIELD_SOURCES` value the compiled alternative carries. */
  source?: FieldSource;
  path?: string;
  /** For a `network` binding: which endpoint the path is read out of. */
  match?: string;
  /** For a `dom` binding: the selector, and the attribute it reads. */
  selector?: string;
  attr?: string;
  /** For a `json-ld` or microdata binding: the schema.org type the path is read from. */
  entity?: string;
  /** The bound value on each binding sample, in sample order. */
  values?: TypedValue[];
  /**
   * Other readings carrying the same value; free alternatives for the compile.
   *
   * Each one says how to read itself. See `FieldAlias`, and its note on what an
   * older manuscript's bare strings mean.
   */
  aliases: FieldAlias[];
  because: string;
  askModel: boolean;
  rejected: RejectionRecord[];
  verdicts: VerdictLog;
  /**
   * The question that bound this field, and who answered it: a tier-3 DOM
   * pick, or (U6) a chooser's answer to an open ambiguity -- including `none`,
   * which leaves the field unbound and says who declined.
   */
  decision?: TierDecision;
}

// ----------------------------------------------------------------- inventory

/**
 * One leaf a payload offered, kept whether or not any requested field wanted it.
 *
 * **Added 2026-09-23 for U4, and it is not a convenience.** `RejectionRecord`
 * records where a leaf *lost a competition for a field the spec named*, which
 * is a different set and a type-contingent one: `narrow` filters candidates by
 * the requested field's declared type before `bindField` ever sees them, so a
 * boolean leaf is only ever recorded when the spec happens to ask for a boolean
 * field, and a money leaf only when it asks for money. Two things Phase D owes
 * the client cannot be read out of that set at all:
 *
 *  - **available but not requested** — Store B's `laboratory`,
 *    `activeIngredient`, `bioequivalence` and `pum`. Whether any of them
 *    survives into a rejection is an accident of which types the spec asked
 *    for, so an artifact built on rejections reports a different catalogue for
 *    the same site depending on the brief. That is the opposite of the point.
 *  - **the type gap.** `stock` is declared `boolean` and Store B states
 *    `productData.stock` as an integer, so `typeMatches` drops the leaf *before*
 *    it is a candidate and no rejection is written. Without this list the only
 *    honest thing reconcile can say is "no tier offered a candidate", which
 *    hides the one fact the client has to decide.
 *
 * Optional, so a manuscript written before it existed still parses and so
 * `investigate.ts` populates it on its own schedule. Absent, `src/reconcile/`
 * falls back to the rejection set and says in the artifact that it did.
 */
export interface InventoryRecord {
  /** The endpoint the leaf came out of, spelled as `FieldRecord.match` spells it. */
  match: string;
  /** The leaf path, in the form `declared/json.ts` reads back. */
  path: string;
  /** The value on each *answering* sample of that endpoint, in its own order. */
  values: TypedValue[];
  /**
   * Was every value in what the page showed a reader?
   *
   * Computed where the rendered text is — at investigation — because the text
   * is not in the manuscript and never should be. `undefined` means no
   * rendered text was supplied and the question was not asked, which is not
   * the same answer as `false`.
   */
  anchored?: boolean;
}

// ----------------------------------------------------------------- obstacles

/**
 * Something in the way, blocking or not.
 *
 * A consent dialog and an Incapsula script are both worth committing even when
 * neither stopped the run: the first is a step the compiled scraper has to keep
 * taking, and the second is the cost line in the answer to "can we run this
 * daily from a datacenter". `blocking` says which ones ended the investigation.
 */
export interface Obstacle {
  /**
   * `deferred` is the record of a question the plain fetch could not answer:
   * the page looked refused, and a render was taken to find out. It carries the
   * answer in its `because` either way, because "the plain fetch looked like a
   * refusal and the render disproved it" is a fact about this site that the
   * next person to read the manuscript needs and that no other line states.
   * (2026-09-22, the first live run: three Store B shells read as three
   * Imperva interstitials and the whole investigation stopped.)
   *
   * `unsettled` is the run saying it did not finish measuring: the render
   * budget ran out with the page still moving, or the navigation never
   * arrived at all. What was captured is as far as navvi got and not a fact
   * about the site. Not blocking — the run goes on with what it has — and it
   * is the line that tells the reader of a thin manuscript that the harness
   * was starved rather than that the site changed.
   */
  kind: "consent" | "challenge" | "status" | "apology" | "shell" | "excluded" | "deferred" | "unsettled";
  url?: string;
  because: string;
  evidence?: string;
  blocking: boolean;
}

// -------------------------------------------------------------------- sample

/** One URL in the compile sample, and why it is in it. */
export interface SamplePickRecord {
  url: string;
  stratum: PickReason;
  because: string;
  /**
   * Was it bound from?
   *
   * A `dead` pick is in the sample on purpose — reproducing a blank is parity —
   * but it has no product to bind, and `narrow` keeps only leaves present on
   * *every* sample. Including one in the binding set deletes every candidate
   * for every field. So the sample and the binding set are not the same list,
   * and the manuscript says which URLs were which.
   */
  bound: boolean;
}

export interface SampleRecord {
  because: string;
  considered: number;
  picks: SamplePickRecord[];
  unfilled: UnfilledStratum[];
  excluded: ExcludedProbe[];
}

// ---------------------------------------------------------------- manuscript

export interface Manuscript {
  version: 1;
  site: string;
  /** The only field a re-run moves; injected, so a test and a diff can pin it. */
  recordedAt: string;
  /** What the spec asked for, in the order it asked. */
  requested: RequestedField[];
  sample: SampleRecord;
  tiers: TierRecord[];
  fields: FieldRecord[];
  /** Fields nothing covered, in requested order. Tier 3's shopping list. */
  uncovered: string[];
  /**
   * Every leaf the bound endpoints offered, requested or not. See
   * `InventoryRecord`: this is what U4's "available but not requested" and the
   * `stock` type gap are read out of, and neither is readable from `rejected`.
   */
  inventory?: InventoryRecord[];
  obstacles: Obstacle[];
  /** Recorded at investigation so a run months later can tell drift from refusal. */
  canary?: CanaryFingerprint;
  /**
   * Why there is a canary, or why there is not.
   *
   * A fingerprint taken off a shell — ten characters of text and two words —
   * resolves against anything and would turn every future block into "drift",
   * which is the one mistake `blocked.ts` exists to prevent. Refusing to record
   * one is the right answer; refusing silently is not.
   */
  canaryBecause: string;
  /**
   * `covered` — every requested field is bound.
   * `partial` — the cheap tiers left work for the compiler.
   * `blocked` — the site refused, and nothing was bound because binding against
   * an error page is how a good scraper is destroyed by its own repair.
   */
  verdict: "covered" | "partial" | "blocked";
  because: string;
}

// ------------------------------------------------------------------ rendering

const TIER_LABEL: Record<1 | 2 | 3, string> = { 1: "tier 1", 2: "tier 2", 3: "tier 3" };

function pad(label: string): string {
  return label.padEnd(12, " ");
}

function bullet(lines: string[], text: string): void {
  lines.push(`              ${text}`);
}

/**
 * The manuscript as a person reads it — the stage block the plan's transcript
 * shows on stderr, while the JSON goes to a file.
 *
 * Same discipline as `cli/render.ts`: data is JSON, this is the summary, and
 * the summary names the decision rather than restating the file.
 */
export function render(manuscript: Manuscript, dataLine = ""): string {
  const lines = [`investigate   ${manuscript.site}${dataLine === "" ? "" : `${" ".repeat(Math.max(1, 38 - manuscript.site.length))}${dataLine}`}`];

  const bound = manuscript.sample.picks.filter((pick) => pick.bound).length;
  lines.push(`  ${pad("sample")}${bound} of ${manuscript.sample.considered} URLs bound, ${manuscript.sample.picks.length} sampled`);
  bullet(lines, manuscript.sample.because);
  for (const entry of manuscript.sample.unfilled) bullet(lines, `! ${entry.stratum}: ${entry.because}`);

  for (const tier of manuscript.tiers) {
    const head = tier.outcome === "ran" ? `${tier.covered.length} of ${tier.asked.length} fields covered` : tier.outcome === "skipped" ? "skipped" : `asked for ${tier.asked.join(", ") || "nothing"}`;
    lines.push(`  ${pad(TIER_LABEL[tier.tier])}${tier.name}: ${head}`);
    bullet(lines, tier.because);
    for (const source of tier.sources) bullet(lines, `${source.kind} ${source.url}${source.match === undefined ? "" : ` (${source.match})`} — ${source.found} candidate(s)`);
    for (const { id, verdict } of tier.verdicts) {
      if (verdict.fires) bullet(lines, `heuristic ${id} fired — ${verdict.because}`);
    }
  }

  lines.push(`  ${pad("fields")}${manuscript.fields.filter((field) => field.path !== undefined).length} of ${manuscript.fields.length} bound`);
  for (const field of manuscript.fields) {
    // U5: a DOM binding is shown by the selector the scraper stores. Its path
    // (`div.container-fluid.page/.../h1`) is the manuscript's address for the
    // node the chooser picked, and printing it here made the transcript
    // disagree with `scraper.json` about a binding that was fine.
    const address = field.source === "dom" && field.selector !== undefined ? `${field.selector}${field.attr === undefined ? "" : ` @${field.attr}`}` : field.path;
    const where = field.path === undefined ? "unbound" : `${field.source} ${field.match === undefined ? "" : `${field.match} `}${address}`;
    bullet(lines, `${field.field.padEnd(14, " ")}${where}`);
    bullet(lines, `  ${field.because}`);
    if (field.decision !== undefined) bullet(lines, `  decided by ${field.decision.answeredBy}: ${field.decision.question}, 1 of ${field.decision.options} candidate(s)`);
  }
  if (manuscript.uncovered.length > 0) lines.push(`  ${pad("uncovered")}${manuscript.uncovered.join(", ")}`);

  if (manuscript.obstacles.length > 0) {
    lines.push(`  ${pad("obstacles")}${manuscript.obstacles.length}`);
    for (const obstacle of manuscript.obstacles) bullet(lines, `${obstacle.blocking ? "!" : "-"} ${obstacle.kind}${obstacle.url === undefined ? "" : ` ${obstacle.url}`}: ${obstacle.because}`);
  }
  lines.push(`  ${pad("canary")}${manuscript.canaryBecause}`);
  lines.push(`  ${pad(manuscript.verdict)}${manuscript.because}`);
  return lines.join("\n") + "\n";
}
