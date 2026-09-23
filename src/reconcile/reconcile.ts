import type { FieldType } from "../input/schema.js";
import { typeMatches } from "../investigate/leaves.js";
import type { FieldRecord, InventoryRecord, Manuscript, Obstacle, RejectionRecord } from "../investigate/manuscript.js";
import type { TypedValue } from "../scraper/extract.js";
import type { Spec } from "../spec/schema.js";
import { normalize } from "../util/text.js";
import type {
  Ambiguity,
  AvailableLeaf,
  LeafEvidence,
  NotObtainableField,
  ObstacleCost,
  ObtainableField,
  QuotedRubric,
  Reading,
  Reconciliation,
} from "./schema.js";

/**
 * U4: `navvi reconcile`. The manuscript, argued.
 *
 * Deterministic and offline. Nothing here opens a page, asks a model or reads
 * a clock it was not handed: it takes the investigation's own record and the
 * spec the client approved, and produces the five lists the client has to see
 * before a scraper is worth compiling - what they get, what they cannot have,
 * **what the site was offering that nobody asked for**, which calls were close
 * and what settled them, and what standing in the way costs.
 *
 * The one that has teeth is the third. Everything else restates a decision
 * already made; "available but not requested" is the only line that can change
 * the brief, and it is the line a compiler written to satisfy the brief can
 * never produce.
 */

export interface ReconcileOptions {
  /** The clock, so a reconciliation is reproducible. */
  now?: Date | undefined;
}

// --------------------------------------------------------------- small parts

/** The form a field name, a path segment and a rubric id are compared in. */
function key(text: string): string {
  return normalize(text).replace(/[^a-z0-9]+/g, "");
}

/** `productData.prices[price-list-std]` becomes `["productData", "prices", "price-list-std"]`. */
function segments(path: string): string[] {
  return path.split(/[.[\]]+/).filter((segment) => segment !== "");
}

/** A tier-2 rejection is spelled `endpoint:path`; a tier-1 one is a declared path or `role:x`. */
function splitRejection(rejection: RejectionRecord): { match: string; path: string } | undefined {
  if (rejection.tier !== 2) return undefined;
  const cut = rejection.path.indexOf(":");
  if (cut === -1) return { match: "", path: rejection.path };
  return { match: rejection.path.slice(0, cut), path: rejection.path.slice(cut + 1) };
}

function sameValues(a: readonly TypedValue[], b: readonly TypedValue[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

function varies(values: readonly TypedValue[]): boolean {
  return values.length >= 2 && values.some((value) => !Object.is(value, values[0]));
}

/** A value, as the artifact prints it: quoted when it is text, bare when it is not. */
export function show(value: TypedValue): string {
  if (value === null) return "null";
  return typeof value === "string" ? `"${value}"` : String(value);
}

function showValues(values: readonly TypedValue[]): string {
  return values.map(show).join(" | ");
}

/**
 * What the site *states*, as a type name - not what the spec declared.
 *
 * This is deliberately not a `FieldType`. `FieldType` is the client's column
 * vocabulary, where `integer` means "the client wants a whole number"; here it
 * means "the payload put a whole number in this key". Naming both in one
 * ambiguity is the entire point, so they do not share a spelling.
 */
export function statedType(values: readonly TypedValue[]): string {
  const kinds = new Set(
    values.map((value) => {
      if (value === null) return "null";
      if (typeof value === "boolean") return "boolean";
      if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
      return "text";
    }),
  );
  return [...kinds].sort().join(" or ");
}

/**
 * The type of a bound field the spec left open, read off its values.
 *
 * `money` is never inferred. A Chilean price and a pack count are both integers
 * in a payload and nothing in the number says which, so the honest answer is
 * `integer` plus a `because` that says it was inferred - a declared `money`
 * changes how `extract.ts` reads `1.250`, and guessing that is how a scraper
 * returns 1.25 for a 1,250-peso product.
 */
function inferType(values: readonly TypedValue[]): FieldType {
  const present = values.filter((value) => value !== null);
  if (present.length === 0) return "text";
  if (present.every((value) => typeof value === "boolean")) return "boolean";
  if (present.every((value) => typeof value === "number")) return present.every((value) => Number.isInteger(value)) ? "integer" : "number";
  return "text";
}

function whereOf(record: FieldRecord): string {
  const parts = [record.source ?? "unbound"];
  if (record.match !== undefined) parts.push(record.match);
  if (record.entity !== undefined) parts.push(record.entity);
  if (record.path !== undefined) parts.push(record.path);
  if (record.selector !== undefined && record.path === undefined) parts.push(record.selector);
  if (record.attr !== undefined) parts.push(`@${record.attr}`);
  return parts.join(" ");
}

// --------------------------------------------------------------- the rubrics

/**
 * The rubrics from the spec that bear on one field, quoted verbatim.
 *
 * **Quoted, not applied.** navvi does not read "the crossed-out one, never
 * Precio Club" and decide anything with it; it puts that sentence next to the
 * binding so a person can check the binding in one line instead of replaying
 * the site. A rubric that is paraphrased cannot do that, which is why `rule`
 * is carried through untouched and the match reason is a separate field.
 */
export function rubricsFor(spec: Spec, fieldName: string): QuotedRubric[] {
  const wanted = key(fieldName);
  const request = spec.fields.find((field) => field.name === fieldName);
  const term = request?.briefTerm ?? request?.description;
  const out: QuotedRubric[] = [];
  for (const rubric of spec.rubrics) {
    const tail = rubric.id.split("/").at(-1) ?? rubric.id;
    let because: string | undefined;
    if (key(tail) === wanted || key(rubric.id).includes(wanted)) because = `the rubric id \`${rubric.id}\` names ${fieldName}`;
    else if (key(rubric.rule).includes(wanted)) because = `the rule names ${fieldName}`;
    else if (term !== undefined && term.trim() !== "" && normalize(rubric.rule).includes(normalize(term))) because = `the rule quotes the brief's own words for ${fieldName} ("${term}")`;
    if (because === undefined) continue;
    out.push({ id: rubric.id, rule: rubric.rule, source: rubric.source, because });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ------------------------------------------------------------- the inventory

/**
 * Every leaf the payloads offered: from the manuscript's own catalogue when it
 * has one, and from the rejection set when it does not.
 *
 * The fallback is not equivalent and does not pretend to be. `narrow` filters
 * by the requested field's declared type *before* anything is recorded as a
 * candidate, so the rejection set holds only leaves that could have been one
 * of the fields the brief happened to name: ask for no boolean field and no
 * boolean leaf is ever written down. `evidence` carries which set this was,
 * and the rendered artifact says so above the table.
 */
function catalogue(manuscript: Manuscript): { leaves: InventoryRecord[]; evidence: LeafEvidence } {
  if (manuscript.inventory !== undefined) {
    return { leaves: [...manuscript.inventory], evidence: "inventory" };
  }
  const byKey = new Map<string, InventoryRecord>();
  for (const record of manuscript.fields) {
    for (const rejection of record.rejected) {
      const split = splitRejection(rejection);
      if (split === undefined || split.path.startsWith("role:")) continue;
      const id = `${split.match} ${split.path}`;
      if (!byKey.has(id)) byKey.set(id, { match: split.match, path: split.path, values: rejection.values });
    }
  }
  return { leaves: [...byKey.values()], evidence: "rejected" };
}

/** Which `(match, path)` pairs a requested field already answers - bound or aliased. */
function claimedPaths(manuscript: Manuscript): Set<string> {
  const claimed = new Set<string>();
  for (const record of manuscript.fields) {
    const match = record.match ?? "";
    if (record.path !== undefined) claimed.add(`${match} ${record.path}`);
    for (const alias of record.aliases) claimed.add(`${match} ${alias}`);
  }
  return claimed;
}

// ------------------------------------------------------------------- the API

export function reconcile(manuscript: Manuscript, spec: Spec, options: ReconcileOptions = {}): Reconciliation {
  const now = options.now ?? new Date();
  const { leaves, evidence } = catalogue(manuscript);
  const claimed = claimedPaths(manuscript);
  const requestedKeys = new Set(manuscript.requested.map((field) => key(field.name)));
  const tier3 = manuscript.tiers.find((tier) => tier.tier === 3);
  const stillAsked = new Set(tier3?.asked ?? []);

  // ------------------------------------------------------------- obtainable

  const obtainable: ObtainableField[] = [];
  for (const record of manuscript.fields) {
    if (record.path === undefined || record.tier === undefined || record.source === undefined) continue;
    const values = record.values ?? [];
    const declared = record.type;
    obtainable.push({
      field: record.field,
      type: declared ?? inferType(values),
      typeInferred: declared === undefined,
      tier: record.tier,
      source: record.source,
      ...(record.match === undefined ? {} : { match: record.match }),
      path: record.path,
      ...(record.selector === undefined ? {} : { selector: record.selector }),
      ...(record.attr === undefined ? {} : { attr: record.attr }),
      ...(record.entity === undefined ? {} : { entity: record.entity }),
      values,
      aliases: [...record.aliases].sort(),
      where: whereOf(record),
      because: record.because,
    });
  }

  // ------------------------------------------------------------ the type gap

  /**
   * A field nothing bound, where the site *did* state something under that
   * name and the declared type refused it.
   *
   * This is the whole of the `stock` case, and it is why the inventory exists.
   * `typeMatches` is the function that dropped the leaf in the first place, so
   * it is the function asked here: the artifact reports the filter that ran,
   * not a second opinion about it.
   */
  const typeGaps = new Map<string, InventoryRecord>();
  for (const field of manuscript.requested) {
    const record = manuscript.fields.find((entry) => entry.field === field.name);
    if (record?.path !== undefined) continue;
    const wanted = key(field.name);
    const candidates = leaves
      .filter((leaf) => segments(leaf.path).some((segment) => key(segment) === wanted))
      .filter((leaf) => leaf.values.length > 0 && !leaf.values.every((value) => typeMatches(value, field.type)))
      .sort((a, b) => a.match.localeCompare(b.match) || a.path.localeCompare(b.path));
    const found = candidates[0];
    if (found !== undefined) typeGaps.set(field.name, found);
  }

  // --------------------------------------------------------- not obtainable

  const notObtainable: NotObtainableField[] = [];
  for (const field of manuscript.requested) {
    const record = manuscript.fields.find((entry) => entry.field === field.name);
    if (record === undefined || record.path !== undefined) continue;
    const gap = typeGaps.get(field.name);
    notObtainable.push({
      field: field.name,
      ...(field.type === undefined ? {} : { type: field.type }),
      kind: gap === undefined ? "no-candidate" : "type-gap",
      because:
        gap === undefined
          ? record.because
          : `not obtainable *as declared*: ${gap.match === "" ? "" : `${gap.match} `}${gap.path} states ${showValues(gap.values)}, and the declared type refused it before it was ever a candidate`,
      stillAsked: stillAsked.has(field.name),
      ...(gap === undefined ? {} : { ambiguity: `${field.name}/type-gap` }),
    });
  }

  // -------------------------------------------- available but not requested

  const available: AvailableLeaf[] = [];
  for (const leaf of leaves) {
    if (claimed.has(`${leaf.match} ${leaf.path}`)) continue;
    // A leaf whose own key names a requested field is that field's business -
    // bound above, or a type gap - and never "nobody asked for this".
    if (segments(leaf.path).some((segment) => requestedKeys.has(key(segment)))) continue;
    const moves = varies(leaf.values);
    if (leaf.anchored !== true && !moves) continue;
    const signals: string[] = [];
    if (leaf.anchored === true) signals.push("its value was in what the page showed a reader");
    if (moves) signals.push(`it moves across the samples (${showValues(leaf.values)})`);
    available.push({
      match: leaf.match,
      path: leaf.path,
      values: leaf.values,
      ...(leaf.anchored === undefined ? {} : { anchored: leaf.anchored }),
      varies: moves,
      evidence,
      because:
        `nothing in the spec asked for this; ${signals.join(", and ")}` +
        (evidence === "rejected" ? ". Seen only because it competed for a field the brief did name, so this catalogue is type-contingent and incomplete" : ""),
    });
  }
  const rank = (leaf: AvailableLeaf): number => (leaf.anchored === true ? 0 : 1) + (leaf.varies ? 0 : 1);
  available.sort((a, b) => rank(a) - rank(b) || a.match.localeCompare(b.match) || a.path.localeCompare(b.path));

  // ------------------------------------------------------------ ambiguities

  const ambiguities: Ambiguity[] = [];
  for (const field of manuscript.requested) {
    const record = manuscript.fields.find((entry) => entry.field === field.name);
    if (record === undefined) continue;

    // Competing readings of a field that *was* bound.
    if (record.path !== undefined) {
      const bound = record.values ?? [];
      const seen = new Set([showValues(bound)]);
      const readings: Reading[] = [
        {
          tier: record.tier ?? 2,
          ...(record.source === undefined ? {} : { source: record.source }),
          ...(record.match === undefined ? {} : { match: record.match }),
          path: record.path,
          values: bound,
          bound: true,
        },
      ];
      const competing = record.rejected
        .filter((rejection) => {
          const split = splitRejection(rejection);
          // Same page, same endpoint: a reading from somewhere else is a
          // different source disagreeing, not this page carrying two facts.
          if (split === undefined) return rejection.tier === 1 && record.match === undefined;
          return split.match === (record.match ?? "");
        })
        .filter((rejection) => rejection.values.length > 0 && !sameValues(rejection.values, bound))
        .sort((a, b) => a.path.localeCompare(b.path));
      for (const rejection of competing) {
        const shown = showValues(rejection.values);
        if (seen.has(shown)) continue;
        seen.add(shown);
        const split = splitRejection(rejection);
        readings.push({
          tier: rejection.tier,
          ...(record.source === undefined ? {} : { source: record.source }),
          ...(split === undefined || split.match === "" ? {} : { match: split.match }),
          path: split?.path ?? rejection.path,
          values: rejection.values,
          bound: false,
        });
      }
      if (readings.length >= 2) {
        const settledBy = rubricsFor(spec, field.name);
        ambiguities.push({
          id: `${field.name}/competing-values`,
          field: field.name,
          kind: "competing-values",
          readings,
          settledBy,
          resolved: record.path,
          ...(settledBy.length > 0
            ? {}
            : {
                decision: `nothing in the spec settles which of these ${readings.length} readings is ${field.name}; without a rule the binding is a guess, and a client who cares about the difference has to say which one they mean`,
              }),
          because:
            settledBy.length > 0
              ? `${readings.length} readings disagree on the same page; the spec carries ${settledBy.length === 1 ? "a rule" : `${settledBy.length} rules`} for this field, quoted beside the binding so it can be checked in one line rather than replayed. Without the rule this stops.`
              : `${readings.length} readings disagree on the same page and the spec carries no rule for this field.`,
        });
      }
    }

    // The declared type and the site's own vocabulary disagreeing.
    const gap = typeGaps.get(field.name);
    if (gap !== undefined) {
      const stated = statedType(gap.values);
      ambiguities.push({
        id: `${field.name}/type-gap`,
        field: field.name,
        kind: "type-gap",
        readings: [{ tier: 2, source: "network", ...(gap.match === "" ? {} : { match: gap.match }), path: gap.path, values: gap.values, bound: false }],
        ...(field.type === undefined ? {} : { declaredType: field.type }),
        statedType: stated,
        settledBy: rubricsFor(spec, field.name),
        decision:
          `the spec asks for ${field.type ?? "an unstated type"} and the site states ${stated}. ` +
          `Either the column means "is there any?", and ${gap.path} becomes a ${field.type ?? "derived"} reading of a count the site never made, ` +
          `or it means "how many?", and the column's own type changes. navvi will not pick: a ${field.type ?? "value"} derived from ${showValues(gap.values)} is a claim the site did not make, and coercing it silently is how a column stops meaning anything.`,
        because: `${field.name} is declared ${field.type ?? "with no type"} and ${gap.match === "" ? "" : `${gap.match} `}${gap.path} states ${showValues(gap.values)} - ${stated}, not ${field.type ?? "the declared type"}. The type filter dropped it before it was a candidate, so nothing bound and nothing was rejected either.`,
      });
    }
  }

  // -------------------------------------------------------------- obstacles

  const obstacles: ObstacleCost[] = manuscript.obstacles.map((obstacle) => ({
    kind: obstacle.kind,
    ...(obstacle.url === undefined ? {} : { url: obstacle.url }),
    because: obstacle.because,
    ...(obstacle.evidence === undefined ? {} : { evidence: obstacle.evidence }),
    blocking: obstacle.blocking,
    cost: costOf(obstacle),
  }));
  obstacles.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.kind.localeCompare(b.kind) || (a.url ?? "").localeCompare(b.url ?? "") || a.because.localeCompare(b.because));

  // ---------------------------------------------------------------- verdict

  const blocking = obstacles.some((obstacle) => obstacle.blocking);
  const open = ambiguities.some((ambiguity) => ambiguity.settledBy.length === 0);
  const verdict: Reconciliation["verdict"] = obtainable.length === 0 ? "empty" : blocking || open ? "open" : notObtainable.length > 0 ? "partial" : "complete";

  return {
    version: 1,
    site: manuscript.site,
    brief: spec.brief,
    reconciledAt: now.toISOString(),
    obtainable,
    notObtainable,
    available,
    ambiguities,
    obstacles,
    availableEvidence: evidence,
    verdict,
    because: becauseOf(verdict, manuscript, obtainable.length, notObtainable.length, available.length, ambiguities, blocking),
  };
}

// ---------------------------------------------------------------- the costs

/**
 * What an obstacle costs the compiled scraper, per run.
 *
 * A fixed table rather than a sentence composed per site, because the cost of
 * a consent dialog is a property of consent dialogs. The obstacle's own
 * `because` says what was met; this says what it will keep charging.
 */
export function costOf(obstacle: Obstacle): string {
  const base = ((): string => {
    switch (obstacle.kind) {
      case "consent":
        return "a prestep on every page, for the life of the scraper: the click is part of the compiled entry, and a page that skips it reads as empty";
      case "challenge":
        return "a rendered browser rather than a plain fetch, and a residential path the day the datacenter is refused";
      case "status":
        return "the URL is not in the binding set; a run that meets this at replay reports it rather than healing against it";
      case "apology":
        return "nothing binds here - the page is the same document at every address, and binding against it is how a good scraper is destroyed by its own repair";
      case "shell":
        return "tier 1 is unusable on this site: every URL pays for a render, every run, because a plain fetch returns no product";
      case "excluded":
        return "one fewer sample in the comparison; the binding is made on a narrower set";
      case "deferred":
        return "one extra render at investigation to tell a shell from a refusal, and nothing at replay";
    }
  })();
  return obstacle.blocking ? `blocking - ${base}` : base;
}

function becauseOf(
  verdict: Reconciliation["verdict"],
  manuscript: Manuscript,
  obtainable: number,
  notObtainable: number,
  available: number,
  ambiguities: Ambiguity[],
  blocking: boolean,
): string {
  const parts = [`${obtainable} of ${manuscript.requested.length} requested field(s) obtainable`];
  if (notObtainable > 0) parts.push(`${notObtainable} not`);
  if (available > 0) parts.push(`${available} leaf/leaves available that nothing asked for`);
  const unsettled = ambiguities.filter((ambiguity) => ambiguity.settledBy.length === 0).length;
  if (ambiguities.length > 0) parts.push(`${ambiguities.length} ambiguity/ambiguities, ${unsettled} with no rule in the spec`);
  if (blocking) parts.push("a blocking obstacle stands in the way");
  const tail =
    verdict === "complete"
      ? "every requested field is bound and every close call has a rule behind it"
      : verdict === "open"
        ? "a person decides before this compiles"
        : verdict === "empty"
          ? "nothing was bound, so there is no schema to derive"
          : "the compile can proceed on what was proved, and the rest is named";
  return `${parts.join("; ")} - ${tail}`;
}
