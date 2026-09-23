import type { FieldAlias, FieldRecord, Manuscript, VerdictLog } from "../investigate/manuscript.js";
import type { Chooser as ChooserId, FieldType, Mode, Profile } from "../input/schema.js";
import { rubricsFor, show, type Ambiguity, type ObtainableField, type QuotedRubric, type Reconciliation } from "../reconcile/index.js";
import { commonShape, type TypedValue } from "../scraper/extract.js";
import {
  SCRAPER_VERSION,
  cacheKey as cacheKeyFor,
  validateScraper,
  type CompiledScraper,
  type Field,
  type FieldAlternative,
  type FieldSource,
  type Fingerprint,
  type Pagination,
} from "../scraper/schema.js";
import type { Spec } from "../spec/schema.js";
import { gateAlternative, type RiskFamily } from "./gate.js";

/**
 * U7a: the seam. A reconciliation becomes a scraper the replay half runs.
 *
 * ## Why this file exists
 *
 * The architecture pass of 2026-09-23 found navvi was **two programs**.
 * `src/investigate/` proves where a value is stated — a JSON-LD path off a
 * typed node, a leaf in a payload the page fetches for itself — and writes it
 * down. `src/scraper/extract.ts` has a cascade that resolves exactly those two
 * things at replay, and `src/browser/` captures the traffic it needs. Neither
 * half had ever met: `src/compile/compile.ts` has never once set `source`,
 * `path`, `match` or `entity`, because it only ever emits DOM selectors chosen
 * by a model from live page candidates. So the declared half of the cascade
 * was live code whose only producer was a literal in a test file. Each half
 * green on its own fixture, which is the exact shape of all four defects of
 * 2026-09-22 — except these two had never been introduced.
 *
 * This is the introduction. Everything here is a **reading of a record**: it
 * opens no page, launches no browser and asks no chooser. The investigation
 * already did the expensive part and argued about it in `reconcile.md`;
 * anything that needs a live page in front of it belongs to `compile()`.
 *
 * ## Why it is short
 *
 * `ObtainableField` already carries `source`, `path`, `match`, `selector`,
 * `attr`, `entity`, `values` and `aliases`, which is very nearly a
 * `FieldAlternative` already. What is left is four decisions, and each one is
 * a place where a compile can be quietly wrong:
 *
 *  - **the order of the alternatives**, which *is* the cascade (see below);
 *  - **the fingerprint**, which is how replay tells drift from a changed page;
 *  - **which aliases are worth keeping**, given that an alias is agreement on
 *    three samples and three samples is weak evidence;
 *  - **which selectors may be committed at all**, which is `./gate.ts`.
 *
 * The file is named `proven` rather than `declared` on purpose. It compiles
 * what the investigation *proved obtainable*, `dom` bindings included, and
 * `declared` is already the name of `src/declared/` (the one JSON reader) and
 * of `src/investigate/declared.ts` (tier 1). A third meaning of one word in one
 * repository is the naming problem `docs/architecture.md` keeps a list of.
 */

// ------------------------------------------------------------- the cascade

/**
 * Tier order, which is the order `extract.ts` walks a field's alternatives in.
 *
 * `extractPage` resolves every non-`dom` alternative **in array order** and
 * stops at the first that answers, then falls to the DOM pass for what is
 * left. So the array is not a set of equal options that replay chooses
 * between: **the array is the cascade**, and the position of an alternative in
 * it is the whole of its priority. A declared reading sorts first because it
 * is a statement by the site about itself; a captured payload second because
 * it is the site's own API answering its own page; a DOM selector last because
 * it is an inference about styling, which is the hardest way to read a value
 * and the one all three failures of 2026-09-22 used.
 *
 * This sort was a no-op for as long as `FieldRecord` carried one `source` for
 * a binding and its aliases alike. Since `FieldAlias`, a field really can carry
 * a `json-ld` binding and a `dom` alias off the same page, and the sort decides
 * which one replay tries first. It is stable, so the bound reading still leads
 * among its equals.
 */
const TIER_RANK: Record<FieldSource, number> = { "json-ld": 0, network: 1, dom: 2 };

/**
 * How many alternatives one field may carry out of this compile.
 *
 * Three: the binding and at most two aliases. An alias is "another path that
 * carried the same value on every binding sample", and a binding sample is one
 * of three URLs — so an alias is agreement on three observations, which is
 * real evidence that two keys *can* say the same thing and no evidence at all
 * that they always will. The value of a fallback decays steeply (the second
 * and third have to fail before the fourth is ever consulted) while its cost
 * does not: every extra alternative is one more chance to answer with a
 * plausible wrong value on the day the ones above it stop answering, and a
 * plausible wrong row is worse than a blank one. Two is where those cross.
 *
 * Healing is the other half of this argument. `appendFieldAlternative` adds a
 * fallback at run time, with the page in front of it, against the field that
 * actually moved. That is a much better-evidenced alternative than a fourth
 * alias guessed from three samples months earlier, so the compile leaves room
 * for it rather than filling the array up front.
 */
export const MAX_ALTERNATIVES = 3;

// ------------------------------------------------------------ the readings

interface Reading {
  source: FieldSource;
  selector: string;
  attr?: string | undefined;
  path?: string | undefined;
  match?: string | undefined;
  entity?: string | undefined;
  /** The investigation's binding, or one of its free alternatives. */
  role: "binding" | "alias";
  /** Where it reads from, in one line, for the rationale. */
  where: string;
}

/**
 * One line naming where a reading reads from.
 *
 * A `dom` alternative is resolved by its selector and a declared one by its
 * path, with the selector along as a label. This prints the half that does the
 * work, because a rationale line nobody can check against the page is a line
 * nobody reads twice.
 */
function whereOf(reading: Reading): string {
  const parts: string[] = [reading.source];
  if (reading.match !== undefined) parts.push(reading.match);
  if (reading.entity !== undefined) parts.push(reading.entity);
  parts.push(reading.source === "dom" ? reading.selector : (reading.path ?? reading.selector));
  if (reading.attr !== undefined) parts.push(`@${reading.attr}`);
  return parts.join(" ");
}

/**
 * The label a declared alternative carries in `selector`.
 *
 * `FieldAlternativeSchema` keeps `selector` required on all three sources so
 * every alternative says where it looked. For `json-ld` the label is the
 * script tag, which the manuscript already recorded when it read it. For
 * `network` the label is the endpoint being matched, and the manuscript does
 * **not** record one — tier 2 sets `match` and leaves `selector` undefined —
 * so the match is the label, which is what `FieldAlternative.selector`'s own
 * documentation says it is.
 */
function labelFor(field: ObtainableField): string | undefined {
  if (field.source === "network") return field.match;
  return field.selector;
}

/**
 * The label an alias carries in `selector`.
 *
 * The same rule as `labelFor`, applied to a reading that now states its own
 * source: a `network` alias is labelled by the endpoint it matches, everything
 * else by the selector the declaration was read through. An alias with neither
 * cannot be compiled, and says so rather than borrowing the binding's — the
 * borrowing is the whole defect this closed.
 */
function labelForAlias(alias: FieldAlias, field: ObtainableField): string | undefined {
  if (alias.source === "network") return alias.match ?? field.match;
  return alias.selector;
}

/**
 * The readings of one obtainable field: the binding first, then its aliases.
 *
 * **Aliases used to compile only for a `network` binding, and it was a
 * limitation of the manuscript rather than a policy.** `FieldRecord.aliases`
 * was a list of bare paths with no source of their own. For tier 2 that is
 * enough and provably so: `narrow` builds a candidate's aliases out of other
 * leaves of *the same flattened payload*, so the binding's `match` plus the
 * alias path is a complete, resolvable alternative. For tier 1 it was not —
 * `bindRole` collects every declaration of one role, and those are different
 * kinds: a JSON-LD path rides in as `json-ld` with an `entity`, an OpenGraph
 * property as `dom` through `meta[property=...]` with `attr: "content"`.
 * Compiling `product:price:amount` as a `json-ld` path would have emitted an
 * alternative that can never resolve, so the compile refused all of them and
 * `rationale.md` said "stated elsewhere, not compiled" — a fact about the
 * record's shape reported as a fact about the site.
 *
 * `FieldAlias` closed it: an alias states how to read itself, in the same
 * words the binding uses, and this function no longer has to guess. Two
 * consequences worth naming, because both were dead code until now:
 *
 *  - the `TIER_RANK` sort above is no longer a no-op — a field really can
 *    carry a `json-ld` binding and a `dom` alias, and the array is the cascade;
 *  - the selector gate's `REFUSE_FALLBACK` bar is reachable from a real
 *    compile, because a `dom` alias sitting behind a declared binding is
 *    exactly the alternative that bar was written for.
 */
function readingsOf(field: ObtainableField, max: number): { readings: Reading[]; uncompiled: Array<{ path: string; because: string }> } {
  const label = labelFor(field);
  const uncompiled: Array<{ path: string; because: string }> = [];
  if (label === undefined || label === "") {
    return {
      readings: [],
      uncompiled: field.aliases.map((alias) => ({ path: alias.path, because: "the binding itself carries no label, so nothing about this field could be compiled" })),
    };
  }

  const binding: Reading = {
    source: field.source,
    selector: label,
    attr: field.attr,
    path: field.path,
    match: field.match,
    entity: field.entity,
    role: "binding",
    where: "",
  };
  binding.where = whereOf(binding);
  const readings: Reading[] = [binding];

  /**
   * Shallowest path first, then alphabetically.
   *
   * A shallow path is the payload's own top-level statement of the fact; a deep
   * one is the same number repeated inside a block that exists only when the
   * record has that block — a promotion price nested under
   * `appliedPromotions[...]` is absent altogether on a product with no
   * discount, which is exactly the page a fallback is for. Alphabetical is the
   * tiebreak so the same investigation compiles the same scraper twice.
   */
  const sorted = [...field.aliases].sort((a, b) => segments(a.path) - segments(b.path) || a.path.localeCompare(b.path));
  const room = Math.max(0, max - readings.length);
  for (const [index, alias] of sorted.entries()) {
    if (index >= room) {
      uncompiled.push({
        path: alias.path,
        because: `the field already carries ${max} alternative(s), which is the cap: an alias is agreement on the binding samples and nothing more, and one this far down the array is only ever reached on a page where every alternative above it has already stopped answering`,
      });
      continue;
    }
    const aliasLabel = labelForAlias(alias, field);
    if (aliasLabel === undefined || aliasLabel === "") {
      uncompiled.push({
        path: alias.path,
        because: `this alias carries no ${alias.source === "network" ? "endpoint to match" : "selector"} of its own, so there is nothing to resolve it through; the binding's label belongs to the binding and reading it as this alias's is what made every tier-1 alias uncompilable`,
      });
      continue;
    }
    const reading: Reading = {
      source: alias.source,
      selector: aliasLabel,
      attr: alias.attr,
      path: alias.path,
      match: alias.source === "network" ? (alias.match ?? field.match) : alias.match,
      entity: alias.entity,
      role: "alias",
      where: "",
    };
    reading.where = whereOf(reading);
    readings.push(reading);
  }
  return { readings, uncompiled };
}

function segments(path: string): number {
  return path.split(/[.[\]]+/).filter((segment) => segment !== "").length;
}

// ---------------------------------------------------------- the fingerprint

/**
 * The fingerprint of a reading, from the values the investigation actually
 * read off the binding samples.
 *
 * `FieldAlternative.fingerprint` is what lets replay tell "this page changed"
 * from "this selector now reads something else", so it has to be built out of
 * observed values and classified by the module that owns shape —
 * `commonShape` in `scraper/extract.ts`, which is also what `toAlternative`
 * calls for the model-chosen half of the compile. Nothing here respells it.
 *
 * **A `null` value is dropped from the sample set rather than stringified.**
 * `null` is not a sample of what this value looks like; it is a sample that had
 * no value. Rendering it as `""` would put an empty string into `samples` and,
 * worse, give `commonShape` a second shape to reconcile — one null turns a
 * `money` fingerprint into `text`, and a `text` fingerprint accepts every
 * non-empty string there is. That is precisely the drift detector switching
 * itself off, quietly, on the field most likely to need it.
 *
 * A reading with no non-null value at all has no evidence behind it and gets
 * no alternative: `commonShape([])` answers `text`, which would ship exactly
 * the fingerprint that accepts anything.
 */
function fingerprintOf(values: readonly TypedValue[]): Fingerprint | null {
  const samples = values.filter((value) => value !== null).map((value) => String(value));
  if (samples.length === 0) return null;
  return { samples, shape: commonShape(samples) };
}

// ------------------------------------------------------------ what is refused

/** One alternative the gate would not let through, named with the family that refused it. */
export interface RefusedAlternative {
  field: string;
  where: string;
  /** The gate's families, in the order it scored them. Empty when the refusal was not the gate's. */
  families: RiskFamily[];
  score: number;
  threshold: number;
  because: string;
}

/**
 * A field the reconciliation proved obtainable that this compile could not
 * bind. Never dropped silently: the whole point of the gate is that a rotten
 * selector is a recompile, and a recompile needs somebody to know.
 */
export interface UnboundField {
  field: string;
  because: string;
  refused: RefusedAlternative[];
}

// -------------------------------------------------------------- the rationale

export interface AlternativeRationale {
  /** Its index in the compiled array, which is its position in the cascade. */
  index: number;
  source: FieldSource;
  where: string;
  role: "binding" | "alias";
  fingerprint: Fingerprint;
  because: string;
}

export interface FieldRationale {
  field: string;
  type: FieldType;
  typeInferred: boolean;
  tier: 1 | 2;
  alternatives: AlternativeRationale[];
  refused: RefusedAlternative[];
  /** Aliases the manuscript recorded that this compile did not turn into alternatives. */
  uncompiled: Array<{ path: string; because: string }>;
  /** What else the investigation tried for this field, and why it lost. */
  rejected: Array<{ where: string; values: TypedValue[]; because: string }>;
  /** Heuristics that fired on this field during the investigation. */
  verdicts: VerdictLog;
  /** U8: ambiguities that touched this binding, carrying their rubrics verbatim. */
  ambiguities: Ambiguity[];
  /** Rubrics naming this field that no ambiguity carried. */
  rubrics: QuotedRubric[];
  because: string;
}

export interface CompileRationale {
  version: 1;
  site: string;
  /** The brief, verbatim, so the argument is traceable to what was asked. */
  brief: string;
  entity: string;
  /** The only field a re-run moves; injected, so a test and a diff can pin it. */
  compiledAt: string;
  fields: FieldRationale[];
  unbound: UnboundField[];
  /** Requested, not proved obtainable, and therefore not a column. */
  notCompiled: Array<{ field: string; because: string; ambiguity?: string }>;
  because: string;
}

export interface ProvenCompile {
  scraper: CompiledScraper;
  /** Proved obtainable, and still not compiled. */
  unbound: UnboundField[];
  rationale: CompileRationale;
}

/** Every obtainable field was refused, so there is no scraper to return. */
export class NothingCompilableError extends Error {
  constructor(readonly unbound: UnboundField[]) {
    super(
      `nothing the reconciliation proved obtainable survived the compile; a scraper needs at least one field\n` +
        unbound.map((entry) => `  ${entry.field}: ${entry.because}`).join("\n"),
    );
    this.name = "NothingCompilableError";
  }
}

// ----------------------------------------------------------------- the API

export interface ProvenCompileOptions {
  /** The page template these fields were proved on. */
  templateKey: string;
  /** The URL a replay starts from. */
  entry: { mode: "direct" | "trace"; url: string };
  /** Defaults to `cacheKey(templateKey, ...)` over the compiled field names. */
  cacheKey?: string | undefined;
  profile?: Profile | undefined;
  /**
   * Recorded in the scraper. This compile asks nobody — the chooser named here
   * is the one the *investigation* paid for, which is what the field has always
   * meant, and `CHOOSERS` has no value for "none".
   */
  chooser?: ChooserId | undefined;
  mode?: Mode | undefined;
  item?: { anchorSelector: string; span: number } | undefined;
  pagination?: Pagination | undefined;
  /** The clock, so a compile is reproducible. */
  now?: Date | undefined;
  /** How many alternatives one field may carry. See `MAX_ALTERNATIVES`. */
  maxAlternatives?: number | undefined;
}

/**
 * Compile the reconciliation into a scraper `extract.ts` can replay.
 *
 * Deterministic, offline and pure: it reads `reconcile.json`, the manuscript
 * behind it and the spec the client approved, and returns the scraper, the
 * fields it could not bind, and the rationale for both.
 *
 * The manuscript is here for the argument rather than for the binding — the
 * reconciliation already carries everything the scraper needs. What only the
 * manuscript has is `FieldRecord.rejected`: the candidates each tier
 * considered and did not bind, with the reason each one lost. A rationale that
 * says what was bound without saying what it beat is a rationale nobody can
 * disagree with.
 */
export function compileFromReconciliation(
  reconciliation: Reconciliation,
  manuscript: Manuscript,
  spec: Spec,
  options: ProvenCompileOptions,
): ProvenCompile {
  const now = options.now ?? new Date();
  const max = options.maxAlternatives ?? MAX_ALTERNATIVES;
  const fields: Record<string, Field> = {};
  const rationale: FieldRationale[] = [];
  const unbound: UnboundField[] = [];

  for (const field of reconciliation.obtainable) {
    const record = manuscript.fields.find((entry) => entry.field === field.field);
    const { readings, uncompiled } = readingsOf(field, max);
    readings.sort((a, b) => TIER_RANK[a.source] - TIER_RANK[b.source]);

    const alternatives: FieldAlternative[] = [];
    const kept: AlternativeRationale[] = [];
    const refused: RefusedAlternative[] = [];

    // One fingerprint per field, not per reading: an alias is, by the
    // manuscript's definition of one, a path that carried the same values on
    // the same samples.
    const fingerprint = fingerprintOf(field.values);
    for (const reading of readings) {
      if (fingerprint === null) {
        refused.push({
          field: field.field,
          where: reading.where,
          families: [],
          score: 0,
          threshold: 0,
          because: `every binding sample read null, so there is no evidence of what this value looks like; a fingerprint built from nothing classifies as \`text\` and accepts every non-empty string, which is the drift check switched off`,
        });
        continue;
      }
      /**
       * `sole` is not "this field has one reading": it is "nothing has
       * survived ahead of this one yet", so a field whose first reading the
       * gate refused still holds its second to the permissive bar rather than
       * to the fallback bar. See the thresholds in `./gate.ts`.
       *
       * That bar used to be unreachable from here: a `FieldRecord` carried one
       * source for a field, so a `dom` field had exactly one reading and every
       * alternative was judged at the sole bar. `FieldAlias` is what made it
       * live — a `dom` alias behind a declared binding is the alternative the
       * lower bar was written for, reached only on the page whose markup has
       * already moved, which is precisely where a presentation-only or
       * root-anchored selector matches the wrong element rather than nothing.
       */
      const decision = gateAlternative(reading.selector, reading.source, { sole: alternatives.length === 0 });
      if (!decision.ok) {
        refused.push({
          field: field.field,
          where: reading.where,
          families: decision.refusedBy,
          score: decision.audit.score,
          threshold: decision.threshold,
          because: decision.because,
        });
        continue;
      }
      const alternative: FieldAlternative = { selector: reading.selector, fingerprint };
      if (reading.attr !== undefined) alternative.attr = reading.attr;
      if (reading.source !== "dom") alternative.source = reading.source;
      if (reading.path !== undefined) alternative.path = reading.path;
      if (reading.match !== undefined) alternative.match = reading.match;
      if (reading.entity !== undefined) alternative.entity = reading.entity;
      alternatives.push(alternative);
      // The gate's own sentence is printed only when the gate had something to
      // say: for a declared alternative it says "this is a label, I did not
      // look", which is true and belongs nowhere near an explanation of why a
      // reading is in the cascade.
      const audited = reading.source === "dom" && decision.audit.risks.length > 0 ? ` The selector was kept: ${decision.because}.` : "";
      kept.push({
        index: alternatives.length - 1,
        source: reading.source,
        where: reading.where,
        role: reading.role,
        fingerprint,
        because:
          (reading.role === "binding"
            ? field.because
            : `another path into the same payload, carrying the same value on every binding sample; replay reaches it only when every alternative above it has stopped answering`) + audited,
      });
    }

    if (alternatives.length === 0) {
      unbound.push({
        field: field.field,
        because:
          refused.length === 0
            ? "the reconciliation proved it obtainable but recorded no reading this compile could turn into an alternative"
            : `every reading of this field was refused; it is proved obtainable and not compiled, which is a recompile rather than a missing column`,
        refused,
      });
      continue;
    }

    fields[field.field] = { alternatives, type: field.type };
    rationale.push(rationaleFor(field, record, reconciliation, spec, kept, refused, uncompiled));
  }

  if (Object.keys(fields).length === 0) throw new NothingCompilableError(unbound);

  const names = Object.keys(fields);
  const profile = options.profile ?? "store";
  const doc: CompiledScraper = {
    version: SCRAPER_VERSION,
    templateKey: options.templateKey,
    cacheKey: options.cacheKey ?? cacheKeyFor(options.templateKey, { goal: reconciliation.brief, fields: names, profile }),
    profile,
    chooser: options.chooser ?? "agent",
    mode: options.mode ?? "record",
    entry: options.entry,
    trace: [],
    fields,
    pagination: options.pagination ?? { mode: "none" },
    detail: null,
    createdAt: now.toISOString(),
    /**
     * A4: the canary travels on the scraper, not beside it, and it is written
     * here rather than by the driver because this is the function that has the
     * manuscript and produces the document. A compile that made both from one
     * manuscript can put them in one file, and then there is no window in which
     * the two disagree -- which was the whole objection to the cache-store
     * side-car this replaced.
     *
     * Until 2026-09-23 `make` wrote a fingerprint into `Manuscript.canary` and
     * a `scraper.json` with no `canary` key at all, so every scraper it
     * produced arrived `unrecorded` -- *nobody looked* -- about a run that had
     * looked, and had to wait for a clean replay to backfill what was already
     * on disk one file away.
     *
     * `null` and not "leave the key off" when there is no fingerprint, because
     * the three states are not interchangeable: `unrecorded` is a scraper
     * compiled before the field existed and is filled in by the first clean
     * replay, while `refused` is a decision taken against a real page and is
     * left alone. This run looked, and `Manuscript.canaryBecause` says what it
     * saw -- including the case the investigation refuses for a render that
     * never finished, where a fingerprint would be of whatever frame navvi
     * happened to catch. That one is a false "the site changed" filed against
     * every replay from here on, and under Phase F's gate a false canary
     * mismatch is what licenses healing, so `refused` is both honest and the
     * safe direction.
     */
    canary: manuscript.canary ?? null,
  };
  if (options.item) doc.item = options.item;

  return {
    scraper: validateScraper(doc),
    unbound,
    rationale: {
      version: 1,
      site: reconciliation.site,
      brief: reconciliation.brief,
      entity: spec.entity.name,
      compiledAt: now.toISOString(),
      fields: rationale,
      unbound,
      notCompiled: reconciliation.notObtainable.map((entry) => ({
        field: entry.field,
        because: entry.because,
        ...(entry.ambiguity === undefined ? {} : { ambiguity: entry.ambiguity }),
      })),
      because:
        `${rationale.length} column(s) compiled from what the investigation proved, ` +
        `${unbound.length} proved obtainable and refused, ` +
        `${reconciliation.notObtainable.length} requested and never obtainable. No page was opened and no model was asked.`,
    },
  };
}

function rationaleFor(
  field: ObtainableField,
  record: FieldRecord | undefined,
  reconciliation: Reconciliation,
  spec: Spec,
  alternatives: AlternativeRationale[],
  refused: RefusedAlternative[],
  uncompiled: Array<{ path: string; because: string }>,
): FieldRationale {
  const ambiguities = reconciliation.ambiguities.filter((ambiguity) => ambiguity.field === field.field);
  /**
   * U8: a rubric that names this field but that no ambiguity carried.
   *
   * `rubricsFor` is `src/reconcile/`'s own matcher, asked rather than
   * respelled, so the rationale cannot quote a different set of rules than
   * `reconcile.md` did. Its answers are subtracted from the ambiguities' own
   * so one rule is not printed twice under one field.
   */
  const carried = new Set(ambiguities.flatMap((ambiguity) => ambiguity.settledBy.map((rubric) => rubric.id)));
  const rubrics = rubricsFor(spec, field.field).filter((rubric) => !carried.has(rubric.id));

  return {
    field: field.field,
    type: field.type,
    typeInferred: field.typeInferred,
    tier: field.tier,
    alternatives,
    refused,
    uncompiled,
    rejected: (record?.rejected ?? []).map((rejection) => ({
      where: `tier ${rejection.tier} ${rejection.path}`,
      values: rejection.values,
      because: rejection.because,
    })),
    verdicts: (record?.verdicts ?? []).filter((entry) => entry.verdict.fires),
    ambiguities,
    rubrics,
    because: `${field.where}, read on ${field.values.length} binding sample(s) at tier ${field.tier}; ${alternatives.length} alternative(s) compiled, ${refused.length} refused`,
  };
}

// ------------------------------------------------------------- the artifact

/**
 * `rationale.md`.
 *
 * Same discipline as `reconcile.md` and the same reason: a document that
 * asserts without showing is one you have to rerun the pipeline to disagree
 * with. The bar this has to clear is one sentence from the plan — **reading
 * the rationale explains a binding without opening the scraper JSON** — so
 * every field prints where it reads from, what that beat, what is behind it,
 * what was refused and by which family, and any rule of the client's own that
 * bears on it, quoted verbatim.
 */
export function renderRationale(rationale: CompileRationale): string {
  const out: string[] = [];
  const cell = (text: string): string => text.replaceAll("|", "\\|");

  out.push(`# Compile rationale: ${rationale.site}`);
  out.push("");
  out.push(`> ${rationale.brief}`);
  out.push("");
  out.push(rationale.because);
  out.push("");
  out.push(
    `Compiled ${rationale.compiledAt} from the reconciliation and the investigation manuscript. One row is a ${rationale.entity}. Nothing here opened a page or asked a model: every alternative below is a reading the investigation had already proved on real pages, and this file is the argument for the order they are in.`,
  );

  // --------------------------------------------------------------- the fields

  out.push(`\n## Compiled (${rationale.fields.length})\n`);
  if (rationale.fields.length === 0) {
    out.push("Nothing was compiled.");
  } else {
    out.push("| field | type | bound to | alternatives | fingerprint |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const field of rationale.fields) {
      const lead = field.alternatives[0];
      const type = field.typeInferred ? `${field.type} *(inferred)*` : field.type;
      const print = lead === undefined ? "-" : `${lead.fingerprint.shape}: ${lead.fingerprint.samples.join(", ")}`;
      out.push(`| \`${field.field}\` | ${type} | tier ${field.tier}, \`${cell(lead?.where ?? "-")}\` | ${field.alternatives.length} | ${cell(print)} |`);
    }
    out.push("");
    out.push(
      "An alternative's position in that array is its priority and nothing else: replay resolves the declared sources in array order, takes the first that answers, and only then looks at the DOM. The array **is** the cascade.",
    );
    for (const field of rationale.fields) out.push(...renderField(field, cell));
  }

  // ------------------------------------------------------------- the refusals

  out.push(`\n## Refused (${rationale.unbound.length})\n`);
  if (rationale.unbound.length === 0) {
    out.push("Every field the reconciliation proved obtainable was compiled.");
  } else {
    out.push(
      "Proved obtainable by the investigation and **not** compiled. A selector the gate refuses is one that extracted on the sample and will not survive a page it was not compiled from, so it is a recompile rather than a commit — and it is named here rather than dropped, because a field that disappears silently is discovered in production.",
    );
    out.push("");
    for (const entry of rationale.unbound) {
      out.push(`- **\`${entry.field}\`** — ${entry.because}`);
      for (const refusal of entry.refused) {
        const families = refusal.families.length === 0 ? "no evidence" : refusal.families.join(", ");
        out.push(`  - \`${refusal.where}\` — refused by **${families}** (score ${refusal.score} against ${refusal.threshold}): ${refusal.because}`);
      }
    }
  }

  // --------------------------------------------------------- never obtainable

  out.push(`\n## Not obtainable (${rationale.notCompiled.length})\n`);
  if (rationale.notCompiled.length === 0) {
    out.push("Every requested field was proved obtainable.");
  } else {
    out.push("Requested, never proved obtainable, and therefore absent from the scraper rather than asserted in it. See `reconcile.md` for the argument.");
    out.push("");
    for (const entry of rationale.notCompiled) {
      out.push(`- **\`${entry.field}\`** — ${entry.because}`);
      if (entry.ambiguity !== undefined) out.push(`  - a decision, not an absence: see ambiguity \`${entry.ambiguity}\`.`);
    }
  }

  out.push("");
  return out.join("\n");
}

function renderField(field: FieldRationale, cell: (text: string) => string): string[] {
  const out: string[] = [];
  out.push(`\n### \`${field.field}\`\n`);
  out.push(field.because);
  out.push("");

  out.push("| # | source | reads | why it is here |");
  out.push("| --- | --- | --- | --- |");
  for (const alternative of field.alternatives) {
    const role = alternative.role === "binding" ? "**bound**" : "fallback";
    out.push(`| ${alternative.index} | \`${alternative.source}\` | \`${cell(alternative.where)}\` | ${role} — ${cell(alternative.because)} |`);
  }

  if (field.rejected.length > 0) {
    out.push("");
    out.push("What else was tried, and why it lost:");
    out.push("");
    out.push("| candidate | values | why it lost |");
    out.push("| --- | --- | --- |");
    for (const rejection of field.rejected) {
      out.push(`| \`${cell(rejection.where)}\` | ${cell(rejection.values.map(show).join(", "))} | ${cell(rejection.because)} |`);
    }
  }

  if (field.verdicts.length > 0) {
    out.push("");
    out.push("Heuristics that fired while this field was being bound:");
    out.push("");
    for (const { id, verdict } of field.verdicts) {
      out.push(`- **\`${id}\`** — ${verdict.because}${verdict.action === undefined ? "" : ` → ${verdict.action}`}`);
    }
  }

  if (field.refused.length > 0) {
    out.push("");
    out.push("Refused by the selector gate — the field still compiles, but these are not in the scraper:");
    out.push("");
    for (const refusal of field.refused) {
      const families = refusal.families.length === 0 ? "no evidence" : refusal.families.join(", ");
      out.push(`- \`${cell(refusal.where)}\` — **${families}** (score ${refusal.score} against ${refusal.threshold}): ${refusal.because}`);
    }
  }

  if (field.uncompiled.length > 0) {
    out.push("");
    out.push("Stated elsewhere and not compiled:");
    out.push("");
    for (const entry of field.uncompiled) out.push(`- \`${entry.path}\` — ${entry.because}`);
  }

  for (const ambiguity of field.ambiguities) out.push(...renderAmbiguity(ambiguity, cell));

  if (field.rubrics.length > 0) {
    out.push("");
    out.push("Rules of the client's own that name this field, quoted verbatim from the spec:");
    out.push("");
    for (const rubric of field.rubrics) {
      out.push(`- **\`${rubric.id}\`** (${rubric.source}): "${rubric.rule}"`);
      out.push(`  - matched because ${rubric.because}`);
    }
  }

  out.push("");
  return out;
}

/**
 * U8: the rubric reaches the compile.
 *
 * `reconcile` already settles an ambiguity and already carries `QuotedRubric`
 * verbatim; what was missing is that nothing downstream read it, so a scraper
 * came out the far end with no trace of the rule that decided which of two
 * prices it binds. The rule is printed **verbatim and never paraphrased** —
 * that is what `src/reconcile/schema.ts` states in bold, and it is the only
 * reason the binding is checkable in one line instead of by replaying the site.
 *
 * An ambiguity that no rubric settled is printed too, with what a person would
 * have to decide. The compile bound one reading anyway, because an unbound
 * column helps nobody; saying so is what keeps that from being a guess nobody
 * can see.
 */
function renderAmbiguity(ambiguity: Ambiguity, cell: (text: string) => string): string[] {
  const out: string[] = [];
  const settled = ambiguity.settledBy.length > 0;
  out.push("");
  out.push(`**Ambiguity \`${ambiguity.id}\`** (${ambiguity.kind}) — ${ambiguity.because}`);
  out.push("");
  out.push("| reading | values | |");
  out.push("| --- | --- | --- |");
  for (const reading of ambiguity.readings) {
    const where = `tier ${reading.tier}${reading.source === undefined ? "" : ` ${reading.source}`}${reading.match === undefined ? "" : ` ${reading.match}`} \`${reading.path}\``;
    out.push(`| ${cell(where)} | ${cell(reading.values.map(show).join(", "))} | ${reading.bound ? "**bound**" : ""} |`);
  }
  out.push("");
  if (settled) {
    out.push("Settled by, quoted verbatim from the spec — navvi does not read the rule, it puts it beside the binding so the binding can be checked in one line:");
    out.push("");
    for (const rubric of ambiguity.settledBy) {
      out.push(`- **\`${rubric.id}\`** (${rubric.source}): "${rubric.rule}"`);
      out.push(`  - matched because ${rubric.because}`);
    }
    if (ambiguity.resolved !== undefined) {
      out.push("");
      out.push(`Compiled as \`${ambiguity.resolved}\`. **Without the rule this stops.**`);
    }
  } else {
    out.push(
      `**Nothing in the spec settles this, and the compile bound one reading anyway.** The scraper will return that reading on every page, and nothing in the scraper says it was a close call.`,
    );
    if (ambiguity.decision !== undefined) {
      out.push("");
      out.push(`**A client decides:** ${ambiguity.decision}`);
    }
  }
  return out;
}
