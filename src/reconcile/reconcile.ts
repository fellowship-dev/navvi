import { bank, type Bank, type Overrides, type Verdict } from "../heuristics/index.js";
import type { FieldType } from "../input/schema.js";
import { typeMatches } from "../investigate/leaves.js";
import type { FieldAlias, FieldRecord, InventoryRecord, Manuscript, Obstacle, RejectionRecord } from "../investigate/manuscript.js";
import type { TypedValue } from "../scraper/extract.js";
import type { Spec } from "../spec/schema.js";
import { normalize } from "../util/text.js";
import type {
  AlternativeDisagreement,
  Ambiguity,
  AvailableLeaf,
  DisagreementRecord,
  LeafEvidence,
  NotObtainableField,
  ObstacleCost,
  ObtainableField,
  QuotedRubric,
  Reading,
  Reconciliation,
  TracedReading,
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
 *
 * U6b added a sixth list with the same property. When a replay hands this
 * stage two readings of one field that disagreed on a page the compile never
 * saw, the answer is not a ranking between them: each is traced back to the
 * leaf that carried it and the second one becomes **its own column**. That is
 * the other line that can change the brief, and it is further out of a
 * prompt's reach than the third - a compiler asked to satisfy the brief would
 * have picked one of the two and been right about a value the client did not
 * mean. See "U6b: two fields, not one" below.
 */

export interface ReconcileOptions {
  /** The clock, so a reconciliation is reproducible. */
  now?: Date | undefined;
  /**
   * U6b: what a replay saw a compiled field's own alternatives return on one
   * page, from `judgeAlternatives` in `src/replay/determinism.ts`.
   *
   * It is an input rather than something computed here because the
   * disagreement does not exist yet at this stage and cannot be made to: a
   * field's alternatives are, by the manuscript's own definition of an alias,
   * paths that carried **the same value on every binding sample**. Store B's
   * two prices agreed on all three of them, because the club promotion was not
   * live that day. Only a replay against a page the compile never saw can put
   * the two readings side by side, and only this stage can say what they mean.
   *
   * Absent means nobody asked, and `Reconciliation.disagreements` is then
   * absent too rather than empty.
   */
  disagreements?: readonly AlternativeDisagreement[] | undefined;
  /**
   * The case's heuristic overrides, for the one rule this stage asks.
   *
   * A disabled rule still answers — `Bank.run` returns `fires: false` with the
   * note that silenced it — so a reconciliation that ranked a session id like
   * any other leaf can say a person switched the rule off rather than that the
   * rule looked and declined.
   */
  heuristics?: Overrides | undefined;
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

/**
 * U6c: the rule that says why a leaf is bookkeeping.
 *
 * `machine-value-is-not-a-fact` was the twelfth heuristic and, until this
 * called it, the only one in the bank nothing executed — written down from the
 * Store B encounter, fixtured, and then left to the arithmetic below. "A
 * rule nothing executes is navvi's signature defect" is the bank's own sentence
 * about it.
 *
 * It is asked here as well as at bind time, and the two answer different
 * readers. This stage has the whole leaf catalogue with `anchored` already
 * answered, and the artifact that needs the sentence is this one: the client
 * reads `available` and has to be able to dismiss a row *for a reason*. The
 * other wiring point — refusing a leaf as a **binding** candidate, which is
 * what its `decides` line is about — is `bindField` in
 * `src/investigate/bind.ts` since 2026-09-23, and a leaf it refused arrives
 * here as a rejection carrying the rule's id.
 */
const MACHINERY_RULE = "machine-value-is-not-a-fact";

/**
 * The rule's verdict on one leaf, or `undefined` when it did not fire.
 *
 * `anchored` is passed through exactly as the manuscript carries it, including
 * `undefined`: the rule treats "nobody looked" as its own answer and declines
 * rather than guessing from the key name, which is the whole reason it takes an
 * observation instead of a path. A leaf whose values the rule's schema refuses
 * is not this rule's business and is left alone.
 */
function machineryOf(rules: Bank, leaf: InventoryRecord): AvailableLeaf["machinery"] {
  let verdict: Verdict;
  try {
    verdict = rules.run(MACHINERY_RULE, {
      path: leaf.path,
      values: leaf.values,
      ...(leaf.anchored === undefined ? {} : { anchored: leaf.anchored }),
    });
  } catch {
    return undefined;
  }
  if (!verdict.fires) return undefined;
  return { heuristic: MACHINERY_RULE, because: verdict.because, action: verdict.action ?? "" };
}

/**
 * A field record's aliases, tolerant of a manuscript written before an alias
 * carried its own source.
 *
 * An older `investigation.json` spells them as bare strings. Nothing validates
 * a `Manuscript` with a schema, so such a file still parses, and the only
 * honest reading of a bare string is the assumption the old code made
 * silently: that the alias is read exactly the way the binding is. That is true
 * for the `network` case — the only one the old compile emitted — and it is the
 * false assumption for tier 1, which is why a tier-1 alias out of an old
 * manuscript still arrives carrying the binding's source and is still refused
 * downstream for exactly the same reason it always was. Nothing gets better for
 * an old file and nothing gets worse; a re-investigation is what closes it.
 */
export function aliasesOf(record: FieldRecord): FieldAlias[] {
  return (record.aliases as ReadonlyArray<FieldAlias | string>).map((alias) =>
    typeof alias !== "string"
      ? alias
      : {
          path: alias,
          source: record.source ?? "network",
          ...(record.match === undefined ? {} : { match: record.match }),
          ...(record.selector === undefined ? {} : { selector: record.selector }),
          ...(record.attr === undefined ? {} : { attr: record.attr }),
          ...(record.entity === undefined ? {} : { entity: record.entity }),
        },
  );
}

/** Aliases in a stable order: by path, so the same investigation reconciles the same twice. */
function sortedAliases(aliases: readonly FieldAlias[]): FieldAlias[] {
  return [...aliases].sort((a, b) => a.path.localeCompare(b.path));
}

/** Which `(match, path)` pairs a requested field already answers - bound or aliased. */
function claimedPaths(manuscript: Manuscript): Set<string> {
  const claimed = new Set<string>();
  for (const record of manuscript.fields) {
    const match = record.match ?? "";
    if (record.path !== undefined) claimed.add(`${match} ${record.path}`);
    for (const alias of aliasesOf(record)) claimed.add(`${alias.match ?? match} ${alias.path}`);
  }
  return claimed;
}

// ----------------------------------------------------- U6b: two fields, not one

/**
 * U6b: alternatives of one field that disagree are two fields.
 *
 * The 2026-09-22 compiles each had one shape of confidence in them, and this
 * is the last one: a list price bound to a sale price, which is what a
 * *ranking* between two readings produces when the ranking is right about
 * which one is prettier and wrong about which one the client meant. The plan's
 * own acceptance sentence for this unit is that **no prompt wording would have
 * surfaced the second half** — that Store B's two readings of `promoPrice`
 * disagree at all — because both are correct and the site's own payload names
 * them apart. A ranking picks one and throws away a fact the page states; a
 * rule that drops the "bad" alternative does the same thing without saying so.
 *
 * So the disagreement is not noise to be resolved. **It is a field that was
 * not asked for**, and the three cases are:
 *
 *  1. both readings trace to a leaf — two columns, each bound to its own leaf;
 *  2. the readings agree — nothing happens, and nothing is written down about
 *     a field whose alternatives were never in conflict;
 *  3. a reading traces to nothing — the page is showing a value this call did
 *     not return, which is the finding, and navvi invents no binding for it.
 *
 * ## The trace is a lookup, not an extraction
 *
 * `Manuscript.inventory` is every leaf the bound endpoints offered, unfiltered
 * by the requested fields' types — the catalogue U4 exists on. Tracing a value
 * is asking which leaf of **this field's own endpoint** carried it on any
 * sample. Nothing is re-flattened, nothing is re-read, and no page is opened:
 * if the catalogue does not have it, the honest answer is that it is not there.
 *
 * A manuscript with no catalogue at all can only be read through the rejection
 * set, which is filtered by the declared types of the fields the brief happened
 * to name. Tracing against it would silently answer "no leaf" for every value
 * of a type nobody asked about, which is the loudest possible finding produced
 * by an accident of the brief — so the split is refused there rather than run.
 */

/** One fact in the catalogue: the paths that carry it, shallowest first. */
interface Fact {
  path: string;
  values: TypedValue[];
  aliases: string[];
}

/** A path segment that is an array index. `key-names-carry-the-signal` is about key names; a position is not one. */
const POSITION = /^\d+$/;

/** `promotionalPrice` becomes `["promotional", "Price"]`; `price-sale-std` becomes `["price", "sale", "std"]`. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "");
}

function camel(parts: readonly string[]): string {
  return parts.map((word, index) => (index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1))).join("");
}

/** Two key words naming the same thing, give or take a plural: `promotions` and `Promotion`. */
function sameWord(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);
  return left === right || `${left}s` === right || left === `${right}s`;
}

/**
 * `isClubPromotion` becomes `["Club", "Promotion"]`.
 *
 * A boolean that reads as a flag is how a payload names one entry of an array
 * apart from its siblings, and it is the only name that entry has: `[1]` is a
 * position, and a position is exactly what `key-names-carry-the-signal` says
 * outranks nothing.
 */
function flagWords(name: string): string[] | undefined {
  const parts = words(name);
  const head = parts[0]?.toLowerCase();
  if (head !== "is" && head !== "has") return undefined;
  return parts.slice(1);
}

/** Every leaf of one endpoint that carried this value on any sample, grouped into facts. */
function factsCarrying(leaves: readonly InventoryRecord[], match: string, value: TypedValue): Fact[] {
  const carrying = leaves.filter((leaf) => leaf.match === match && leaf.values.some((seen) => Object.is(seen, value)));
  const facts: Fact[] = [];
  for (const leaf of carrying.sort((a, b) => segments(a.path).length - segments(b.path).length || a.path.localeCompare(b.path))) {
    // Two paths carrying the same value on *every* sample are one fact stated
    // twice - the manuscript's own definition of an alias - and the shallowest
    // is the payload's own statement of it. Two paths that agree here and
    // disagree elsewhere are two facts, and this refuses rather than picks.
    const fact = facts.find((entry) => sameValues(entry.values, leaf.values));
    if (fact === undefined) facts.push({ path: leaf.path, values: leaf.values, aliases: [] });
    else fact.aliases.push(leaf.path);
  }
  return facts;
}

/**
 * The name of the field a split emits, derived from the payload's own words.
 *
 * Two halves, and both come off something a person can check against the file:
 *
 *  - **the qualifier** — what the payload calls the thing that makes this leaf
 *    different from the one the requested field is bound to. A named path
 *    segment when there is one; the flag on the array entry when the segment is
 *    a position, with any word the container already said dropped, so
 *    `promotions[1]` + `isClubPromotion` is `club` and not `clubPromotion`.
 *  - **the noun** — the last word of the *requested* field's own name. The
 *    split field is the same quantity under a different qualifier and the
 *    client's column should be in the client's vocabulary, so `promoPrice`
 *    plus `club` is `clubPrice`.
 *
 * It will not always be the name a person would have chosen, and that is the
 * trade: a derived name is checkable against the payload in one line, and a
 * name a model invented is not checkable at all. What navvi must never do is
 * *quietly* choose it, which is why the derivation is spelled in the record.
 */
function nameForSplit(leaf: Fact, bound: string | undefined, field: string, leaves: readonly InventoryRecord[], match: string): string {
  const own = segments(leaf.path);
  const shared = new Set(bound === undefined ? [] : segments(bound));
  let qualifier: string[] | undefined;

  for (const [index, segment] of own.entries()) {
    if (!POSITION.test(segment)) continue;
    const container = own[index - 1];
    const flag = leaves.find((entry) => {
      if (entry.match !== match) return false;
      const parts = segments(entry.path);
      // An immediate scalar sibling of the entry the position names.
      if (parts.length !== index + 2) return false;
      if (!parts.slice(0, index + 1).every((part, at) => part === own[at])) return false;
      return entry.values.length > 0 && entry.values.every((value) => value === true) && flagWords(parts[index + 1]!) !== undefined;
    });
    if (flag === undefined) continue;
    const named = flagWords(segments(flag.path).at(-1)!)!.filter((word) => container === undefined || !sameWord(word, container));
    if (named.length > 0) qualifier = named;
  }

  if (qualifier === undefined) {
    const distinguishing = own.slice(0, -1).filter((segment) => !POSITION.test(segment) && !shared.has(segment));
    const nearest = distinguishing.at(-1);
    if (nearest !== undefined) qualifier = words(nearest);
  }

  const tail = words(own.at(-1) ?? leaf.path);
  if (qualifier === undefined) return camel(tail);
  const noun = words(field).at(-1);
  if (noun === undefined || sameWord(qualifier.at(-1)!, noun)) return camel(qualifier);
  return camel([...qualifier, noun]);
}

interface SplitResult {
  records: DisagreementRecord[];
  emitted: ObtainableField[];
}

/**
 * Trace every reading of every observed disagreement, and emit the fields.
 *
 * Nothing here decides *whether* two readings disagree — `judgeAlternatives`
 * already did, with `formOf`, which is the key U6a buckets N readings of one
 * page by. This stage never compares two readings to each other at all; it
 * compares a reading's value against the catalogue, with `Object.is` over a
 * leaf's sample values, which is the comparison `sameValues` and `varies` in
 * this file already make. So U6b adds no comparator: the two that exist each
 * answer the question of the stage that owns them.
 */
function splitDisagreements(
  observed: readonly AlternativeDisagreement[],
  obtainable: readonly ObtainableField[],
  leaves: readonly InventoryRecord[],
  evidence: LeafEvidence,
  requested: readonly { name: string; type?: FieldType | undefined }[],
  spec: Spec,
): SplitResult {
  const records: DisagreementRecord[] = [];
  const emitted: ObtainableField[] = [];
  const taken = new Set([...requested.map((field) => key(field.name)), ...obtainable.map((field) => key(field.field))]);

  for (const disagreement of observed) {
    const bound = obtainable.find((field) => field.field === disagreement.field);
    const match = bound?.match ?? "";
    const claimed = new Set([bound?.path, ...(bound?.aliases ?? []).map((alias) => alias.path)].filter((path): path is string => path !== undefined));
    const readings: TracedReading[] = [];
    const made: string[] = [];
    let unaccounted = false;
    let decision: string | undefined;

    for (const reading of disagreement.readings) {
      const refuse = (because: string): void => {
        readings.push({ source: reading.source, value: reading.value, outcome: "refused", because });
        decision ??= because;
      };

      if (bound === undefined) {
        refuse(
          `${disagreement.field} is not in this reconciliation's obtainable list, so there is no binding for ${show(reading.value)} to be a second reading *of*. ` +
            `A disagreement observed against a field this manuscript never bound is a question about which compile the replay was running, not about the page.`,
        );
        continue;
      }
      if (evidence !== "inventory") {
        refuse(
          `this manuscript carries no leaf catalogue, only the rejection set, which holds leaves that lost a competition for a field the brief *did* name and is filtered by those fields' declared types. ` +
            `Tracing ${show(reading.value)} against it would answer "no leaf" for every value of a type nobody asked about, which is the loudest finding navvi has produced by an accident of the brief. See \`Manuscript.inventory\`.`,
        );
        continue;
      }

      const facts = factsCarrying(leaves, match, reading.value);
      if (facts.length === 0) {
        unaccounted = true;
        readings.push({
          source: reading.source,
          value: reading.value,
          outcome: "unaccounted",
          because:
            `no leaf of ${match === "" ? "the bound endpoint" : match} carried ${show(reading.value)} on any sample. ` +
            `**The page is showing something this call did not return**, so either there is an endpoint the investigation never captured or the browser computes this number from ones it did. ` +
            `Nothing is bound to it: a binding invented for a value with no leaf behind it is a column that will be confidently wrong on the first page where the arithmetic changes.`,
        });
        continue;
      }
      if (facts.length > 1) {
        refuse(
          `${facts.length} different facts of ${match === "" ? "the bound endpoint" : match} carried ${show(reading.value)} - ${facts.map((fact) => fact.path).join(", ")} - and they disagree with each other on the other samples. ` +
            `One value matching two facts is not a trace, and navvi will not pick which one the page was showing.`,
        );
        continue;
      }

      const fact = facts[0]!;
      if (claimed.has(fact.path)) {
        readings.push({
          source: reading.source,
          value: reading.value,
          outcome: "requested",
          leaf: fact.path,
          because: `${show(reading.value)} is ${fact.path}, which is what ${disagreement.field} is already bound to. This reading is the column the client asked for.`,
        });
        continue;
      }

      const name = nameForSplit(fact, bound.path, disagreement.field, leaves, match);
      if (taken.has(key(name))) {
        refuse(
          `${show(reading.value)} traces to ${fact.path}, which is a second field and not a second reading - but the name the payload's own words derive for it, \`${name}\`, is already a column. ` +
            `navvi will not rename it and will not write into a column somebody else's values are in: a client decides what this one is called.`,
        );
        continue;
      }

      taken.add(key(name));
      const declared = requested.find((entry) => entry.name === disagreement.field)?.type;
      emitted.push({
        field: name,
        type: declared ?? inferType(fact.values),
        typeInferred: declared === undefined,
        tier: 2,
        source: "network",
        ...(match === "" ? {} : { match }),
        path: fact.path,
        values: fact.values,
        // Every one of these is another leaf of the same call, so they are
        // `network` readings of the endpoint the split came out of.
        aliases: sortedAliases(fact.aliases.map((path) => ({ path, source: "network" as const, ...(match === "" ? {} : { match }) }))),
        where: `network ${match === "" ? "" : `${match} `}${fact.path}`,
        splitFrom: disagreement.field,
        because:
          `a replay resolved ${disagreement.field}'s alternatives against one page and they returned different values; ${reading.source} returned ${show(reading.value)}, which traces to ${fact.path} - ` +
          `a different leaf of the same call than the one ${disagreement.field} is bound to. The page states both, so both are columns: this one was never a bad alternative, it was a field nobody had asked for.`,
      });
      made.push(name);
      readings.push({
        source: reading.source,
        value: reading.value,
        outcome: "split",
        leaf: fact.path,
        ...(fact.aliases.length > 0 ? { aliases: sortedAliases(fact.aliases.map((path) => ({ path, source: "network" as const, ...(match === "" ? {} : { match }) }))) } : {}),
        emitted: name,
        because: `${show(reading.value)} is ${fact.path}, a different leaf of the same call, so it is emitted as \`${name}\` bound to that leaf rather than ranked against ${disagreement.field}.`,
      });
    }

    if (unaccounted) {
      decision =
        `one of ${disagreement.field}'s readings has no leaf behind it. Somebody has to say where the page gets it: a capture of the page's own traffic will either show an endpoint the investigation missed, ` +
        `in which case this is a re-investigation, or it will not, in which case the number is computed in the browser and the only honest column is the input it is computed from.`;
    }
    const settled = rubricsFor(spec, disagreement.field);
    records.push({
      field: disagreement.field,
      readings,
      emitted: made,
      unaccounted,
      ...(decision === undefined ? {} : { decision }),
      because: becauseOfSplit(disagreement, made, unaccounted, settled.length),
    });
  }

  return { records, emitted };
}

function becauseOfSplit(disagreement: AlternativeDisagreement, made: readonly string[], unaccounted: boolean, rubrics: number): string {
  const head =
    `${disagreement.field}'s alternatives disagreed on ${disagreement.disagreedOn} of the ${disagreement.readOn} URLs they were both read on: ` +
    `${disagreement.readings.map((reading) => `${reading.source} ${show(reading.value)}`).join(" against ")}.`;
  const tail =
    made.length > 0
      ? ` Traced to their own leaves and split into ${[disagreement.field, ...made].join(" and ")}, each bound to the leaf behind it. Neither reading was ranked and neither was dropped.`
      : unaccounted
        ? ` Nothing could be split: a reading has no leaf behind it, and that is the finding rather than a gap to fill.`
        : ` Nothing was split; the readings resolved to the binding this field already has.`;
  const rule =
    rubrics > 0
      ? ` The spec carries ${rubrics === 1 ? "a rule" : `${rubrics} rules`} for this field, and the split does not consult ${rubrics === 1 ? "it" : "them"}: a rule says which reading answers the column the client named, never that the other fact should be thrown away.`
      : "";
  return head + tail + rule;
}

/**
 * The trace, as the determinism stage block prints it.
 *
 * `Determinism.alternatives[].traced` is free-form on purpose and this is what
 * fills it: the replay stage observed the disagreement and cannot explain it,
 * this stage traced it and can. The lines are generated rather than stored so
 * the artifact keeps one copy of the facts, and a caller that never asks for
 * them gets a determinism record with `traced` absent, which is honest - the
 * trace did not happen.
 */
export function tracedAlternatives(reconciliation: Reconciliation, observed: readonly AlternativeDisagreement[]): AlternativeDisagreement[] {
  return observed.map((disagreement) => {
    const record = reconciliation.disagreements?.find((entry) => entry.field === disagreement.field);
    if (record === undefined) return { ...disagreement };
    const lines = [
      `traced: ${record.readings.map((reading) => `${reading.source} ${show(reading.value)} is ${reading.leaf ?? "nothing this call returned"}`).join(", ")}`,
    ];
    const names = [record.field, ...record.emitted];
    if (record.emitted.length > 0) lines.push(`-> split into ${names.join(" and ")}, ${names.length === 2 ? "both" : "each"} bound to their leaf`);
    if (record.unaccounted) lines.push(`-> the page is showing something this call did not return; nothing is bound to it`);
    return { ...disagreement, traced: lines };
  });
}

// ------------------------------------------------------------------- the API

export function reconcile(manuscript: Manuscript, spec: Spec, options: ReconcileOptions = {}): Reconciliation {
  const now = options.now ?? new Date();
  const { leaves, evidence } = catalogue(manuscript);
  const claimed = claimedPaths(manuscript);
  const requestedKeys = new Set(manuscript.requested.map((field) => key(field.name)));
  const tier3 = manuscript.tiers.find((tier) => tier.tier === 3);
  const stillAsked = new Set(tier3?.outcome === "requested" ? tier3.asked : []);

  // ------------------------------------------------------------- obtainable

  /**
   * R4 at the artifact the compile reads: one reading is one fact.
   *
   * `investigate` refuses to bind two fields to one path since 2026-09-23, and
   * this is the same rule asked again of whatever manuscript arrived — one
   * written before that, or one a person edited — because `make` reuses an
   * `investigation.json` that is current, and a stale one carrying the
   * `sku`/`stock` collision would otherwise compile it. Both fields are named
   * as not obtainable, with the path they shared; neither is picked.
   */
  const readingOf = (record: FieldRecord): string =>
    [record.source, record.match ?? "", record.selector ?? "", record.attr ?? "", record.entity ?? "", record.path].join("\u0000");
  const boundTo = new Map<string, string[]>();
  for (const record of manuscript.fields) {
    if (record.path === undefined || record.tier === undefined || record.source === undefined) continue;
    const reading = readingOf(record);
    boundTo.set(reading, [...(boundTo.get(reading) ?? []), record.field]);
  }
  const sharedWith = (record: FieldRecord): string[] => (boundTo.get(readingOf(record)) ?? []).filter((name) => name !== record.field);

  const obtainable: ObtainableField[] = [];
  for (const record of manuscript.fields) {
    if (record.path === undefined || record.tier === undefined || record.source === undefined) continue;
    if (sharedWith(record).length > 0) continue;
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
      aliases: sortedAliases(aliasesOf(record)),
      where: whereOf(record),
      ...(record.decision === undefined ? {} : { decision: { ...record.decision } }),
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
    if (record === undefined) continue;
    if (record.path !== undefined) {
      const others = record.source === undefined || record.tier === undefined ? [] : sharedWith(record);
      if (others.length > 0) {
        notObtainable.push({
          field: field.name,
          ...(field.type === undefined ? {} : { type: field.type }),
          kind: "shared-path",
          because: `shared path: ${record.match === undefined ? "" : `${record.match}:`}${record.path} is bound to ${field.name} and to ${others.join(" and ")}; one leaf cannot be ${others.length + 1} facts, so none of them is obtainable from it`,
          stillAsked: stillAsked.has(field.name),
        });
      }
      continue;
    }
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

  const rules = bank(options.heuristics ?? {});
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
    const machinery = machineryOf(rules, leaf);
    available.push({
      match: leaf.match,
      path: leaf.path,
      values: leaf.values,
      ...(leaf.anchored === undefined ? {} : { anchored: leaf.anchored }),
      varies: moves,
      evidence,
      ...(machinery === undefined ? {} : { machinery }),
      because:
        `nothing in the spec asked for this; ${signals.join(", and ")}` +
        (machinery === undefined ? "" : `. ${MACHINERY_RULE} says it is the machine's own bookkeeping: ${machinery.because}`) +
        (evidence === "rejected" ? ". Seen only because it competed for a field the brief did name, so this catalogue is type-contingent and incomplete" : ""),
    });
  }
  /**
   * The order, and the one judgement in it that is no longer arithmetic.
   *
   * The two signals still rank the rows - shown to a reader, and moves across
   * the samples - because both are evidence and the count of them is what a
   * reader is being offered. What the arithmetic could never say is *why*
   * `telemetry.renderedAt` belongs at the bottom. It sorted last because it was
   * not anchored, which is the same rank a perfectly ordinary declared field
   * gets on a tier the investigation did not anchor at all, and the row carried
   * no sentence a client could disagree with. A silent sort is a judgement with
   * no recorded ground.
   *
   * So a leaf the bank actually called machinery sorts below every leaf it did
   * not, by a term large enough that no combination of the two signals can lift
   * it back - and the row says which rule said so and on what evidence.
   */
  const rank = (leaf: AvailableLeaf): number =>
    (leaf.machinery === undefined ? 0 : 4) + (leaf.anchored === true ? 0 : 1) + (leaf.varies ? 0 : 1);
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
        // A leaf a bank rule refused lost to the rule, not to the binding:
        // offering it as a second reading would ask a person to choose a
        // request id as a price.
        .filter((rejection) => rejection.heuristic === undefined)
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

  // ----------------------------------------------- U6b: the fields nobody asked

  /**
   * The split runs last of the five lists and appends rather than interleaves.
   *
   * Appending keeps every field the spec asked for at the index it has always
   * had, so a diff between two reconciliations shows the new column arriving
   * rather than every row below it shifting - the same reason every other list
   * in this artifact is in a declared order.
   */
  let disagreements: DisagreementRecord[] | undefined;
  if (options.disagreements !== undefined) {
    const split = splitDisagreements(options.disagreements, obtainable, leaves, evidence, manuscript.requested, spec);
    disagreements = split.records;
    obtainable.push(...split.emitted);
    // A leaf that is now a column is not a leaf nobody asked for. Saying both
    // in one artifact would make the reader decide which sentence to believe.
    const columns = new Set(split.emitted.flatMap((field) => [`${field.match ?? ""} ${field.path}`, ...field.aliases.map((alias) => `${alias.match ?? field.match ?? ""} ${alias.path}`)]));
    for (let index = available.length - 1; index >= 0; index--) {
      if (columns.has(`${available[index]!.match} ${available[index]!.path}`)) available.splice(index, 1);
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
  // A disagreement navvi could not settle by splitting is open for the same
  // reason an unsettled ambiguity is: a person has to answer it before this
  // compiles. A split that succeeded settles itself and opens nothing.
  const undecided = (disagreements ?? []).filter((record) => record.decision !== undefined);
  const open = ambiguities.some((ambiguity) => ambiguity.settledBy.length === 0) || undecided.length > 0;
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
    ...(disagreements === undefined ? {} : { disagreements }),
    obstacles,
    availableEvidence: evidence,
    verdict,
    because: becauseOf(
      verdict,
      manuscript,
      obtainable.filter((field) => field.splitFrom === undefined).length,
      notObtainable.length,
      available.length,
      ambiguities,
      blocking,
      disagreements,
    ),
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
      case "unsettled":
        return "nothing here is evidence about the site: the render budget ran out mid-page or the navigation never arrived, so a field this run could not bind may be a field this run did not wait for - re-run it on a quiet machine before believing a gap";
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
  disagreements: readonly DisagreementRecord[] | undefined,
): string {
  const parts = [`${obtainable} of ${manuscript.requested.length} requested field(s) obtainable`];
  if (notObtainable > 0) parts.push(`${notObtainable} not`);
  if (available > 0) parts.push(`${available} leaf/leaves available that nothing asked for`);
  const unsettled = ambiguities.filter((ambiguity) => ambiguity.settledBy.length === 0).length;
  if (ambiguities.length > 0) parts.push(`${ambiguities.length} ambiguity/ambiguities, ${unsettled} with no rule in the spec`);
  const split = (disagreements ?? []).flatMap((record) => record.emitted);
  if (split.length > 0) parts.push(`${split.length} field(s) split out of a disagreement nobody asked about (${split.join(", ")})`);
  const unaccounted = (disagreements ?? []).filter((record) => record.unaccounted).length;
  if (unaccounted > 0) parts.push(`${unaccounted} reading(s) the page shows that this call did not return`);
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
