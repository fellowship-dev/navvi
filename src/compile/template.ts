import type { Page } from "playwright";
import type { SettleOptions } from "../browser/guards.js";
import { OPTION_VALUE_SEPARATOR, type Answer, type Chooser, type JsonValue, type Question, type QuestionContext } from "../chooser/chooser.js";
import { NONE_OPTION, premises } from "../chooser/questions.js";
import { isChooserId, type Chooser as ChooserId, type Profile } from "../input/schema.js";
import {
  investigate,
  safeUrl,
  type Capture,
  type DomAnswer,
  type DomBinding,
  type DomRefusal,
  type DomRequest,
  type FieldRecord,
  type Manuscript,
  type PageResponse,
  type RequestedField,
  type SampleChoice,
  type SourceRecord,
  type TierDecision,
} from "../investigate/index.js";
import { reconcile, rubricsFor, type Ambiguity, type Reading, type Reconciliation } from "../reconcile/index.js";
import type { TypedValue } from "../scraper/extract.js";
import type { Spec } from "../spec/schema.js";
import { clip } from "../util/text.js";
import { chooseRecordFields, RECORD_SAMPLE_PAGES } from "./compile.js";
import { LABEL_VALUE_CHARS, candidateLabel, fieldQuestionId, toAlternative, type CompileField } from "./fields.js";
import { gateAlternative } from "./gate.js";
import { NothingCompilableError, compileFromReconciliation, type ProvenCompile } from "./proven.js";

/**
 * U4: the compile core. One function per page template, cheapest tier first.
 *
 * ## Why this file exists
 *
 * On 2026-09-23 navvi had two compilers and a fresh-eyes run met both. The
 * plain command (`navvi "<prompt>" <url>`) put every field to a chooser as a
 * question about DOM candidates -- `compile()` in `./compile.ts` -- and never
 * looked at what the page declared. `navvi make` ran the declared and payload
 * tiers, compiled them in `./proven.ts`, and its "tier 3" was one line in the
 * manuscript saying a DOM compiler had been requested; nothing called one. So
 * `navvi make` on a books demo with its title, price and stock in plain markup
 * classified every URL dead, bound nothing, and exited 1, while the plain
 * command compiled the same page in a few seconds -- the two halves shared the
 * scraper format and replay and nothing else.
 *
 * This is the one place the tiers run in order for a template:
 *
 * ```
 * tier 1 declared  ->  tier 2 payload  ->  tier 3 DOM (uncovered fields only, a chooser)
 *   -> reconcile  ->  open ambiguity to the chooser  ->  selector gate  ->  CompiledScraper
 * ```
 *
 * Tier 3 is `chooseRecordFields` -- the record flow `compile()` has always
 * run, candidates to questions to answers -- handed only the fields the cheap
 * tiers left uncovered (KTD2). There is no second DOM compiler here, and there
 * must not be one: the plain command's list mode, pagination and healing all
 * sit on that flow, and a tier 3 that drifted from it would be the two
 * programs again one directory down.
 *
 * ## What each front end takes from it
 *
 *  - `navvi make` is the staged view. Its investigate stage is
 *    `investigateTemplate` (tiers 1 to 3, one manuscript) and its compile stage
 *    is `compileFromReconciliation`, with the ledger, determinism and verify
 *    between them. The stages stay separately reusable; the tiers are this
 *    file's.
 *  - The plain command's record mode (U5) calls `compileTemplate` with the
 *    pages it already has open and the chooser it already built, and gets the
 *    same cascade in one call.
 *
 * ## What it does not do
 *
 * It opens nothing. The bytes come through `TemplateSources` -- a plain fetch,
 * a capture, and `render`, which hands tier 3 live pages and takes them back
 * -- so the caller owns the browser and the tests own the fixtures, the same
 * split `src/investigate/` makes for the same reason.
 */

// ------------------------------------------------------------------- inputs

/**
 * Hands `use` one live, rendered page per URL, in order, and closes them after.
 *
 * A callback rather than a list of pages because the caller owns their
 * lifetime: `navvi make`'s driver opens a fresh page per URL and closes it
 * when tier 3 is done, and the plain command's crawler already has its pages
 * open and must not have them closed under it.
 */
export type RenderPages = <T>(urls: readonly string[], use: (pages: Page[]) => Promise<T>) => Promise<T>;

/** Where one template's bytes come from. Only `fetch` is required: a run that stops at tier 1 never needs the rest. */
export interface TemplateSources {
  /** One plain HTTP request: tier 1, and the sample probes before it. */
  fetch(url: string): Promise<PageResponse>;
  /** A render with the payloads it fetched for itself: tier 2. */
  capture?: ((url: string) => Promise<Capture>) | undefined;
  /** Live pages for the DOM compiler: tier 3. */
  render?: RenderPages | undefined;
}

/** A chooser, or a way to open one only if tier 3 is reached. */
export type ChooserSource = Chooser | (() => Promise<Chooser>);

export interface DomTierOptions {
  render: RenderPages;
  chooser: ChooserSource;
  /** What a field means, for the question's premise. Defaults to nothing beyond its name. */
  describe?: ((field: RequestedField) => string | undefined) | undefined;
  /** What one record is, e.g. "book". */
  records?: string | undefined;
  settle?: SettleOptions | undefined;
}

// ------------------------------------------------------------------- tier 3

/**
 * The tier-3 callback `investigate` takes as `Sources.dom`.
 *
 * Every chosen selector faces `gateAlternative` as the field's only reading
 * before it is written down as a binding, which is KTD2's "tier-3 alternatives
 * face the gate like proven ones" taken literally: it is the same call, at the
 * same bar, that `compileFromReconciliation` makes for a `dom` reading. Gating
 * here as well as there is not a second opinion -- the gate is a pure function
 * of the selector -- it is what lets the manuscript say "the chooser picked
 * this and the gate refused it" and leave the field unbound, rather than
 * reporting it obtainable and letting the compile drop it a stage later under
 * a sentence about something else.
 */
export function domTier(options: DomTierOptions): (request: DomRequest) => Promise<DomAnswer> {
  return async (request) => {
    let chooser: Chooser;
    try {
      chooser = typeof options.chooser === "function" ? await options.chooser() : options.chooser;
    } catch (error) {
      // A run with no credential for any chooser is a run that cannot ask, and
      // it is a fact about this run rather than a defect: tier 3 is recorded as
      // requested, the fields stay unbound, and the reconciliation says so.
      const said = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "no reason given";
      return { ran: false, bindings: [], refused: [], unanswered: [], sources: [], because: `no chooser could be opened to answer the DOM compiler's questions (${said}), so tier 3 did not run` };
    }

    const urls = request.urls.slice(0, RECORD_SAMPLE_PAGES);
    const fields: CompileField[] = request.fields.map((field) => {
      const description = options.describe?.(field);
      return { name: field.name, ...(description === undefined ? {} : { description }), ...(field.type === undefined ? {} : { type: field.type }) };
    });

    return options.render(urls, async (pages) => {
      const sources: SourceRecord[] = pages.map((page) => ({ url: safeUrl(page.url()), kind: "render" as const, found: 0, because: "rendered for the DOM compiler" }));
      const choice = await chooseRecordFields({
        pages,
        fields,
        chooser,
        offerLists: false,
        ...(options.records === undefined ? {} : { description: options.records }),
        ...(options.settle === undefined ? {} : { settle: options.settle }),
      });
      if (choice === null) {
        const because = `the DOM compiler rendered ${pages.length} page(s) and no leaf resolved on every one of them, so there was nothing to ask a chooser`;
        return { ran: true, bindings: [], refused: [], unanswered: fields.map((field) => ({ field: field.name, because })), sources, because };
      }
      for (const source of sources) {
        source.found = choice.candidates.length;
        source.because = `${choice.candidates.length} DOM candidate(s) resolved on every rendered sample`;
      }

      const bindings: DomBinding[] = [];
      const refused: DomRefusal[] = [];
      const unanswered: DomAnswer["unanswered"] = [];
      const answeredBy = chooser.name;
      const pageCount = `${pages.length} rendered page(s)`;
      for (const field of fields) {
        const id = fieldQuestionId(field.name, choice.suffix);
        const question = choice.questions.find((entry) => entry.id === id);
        const chosen = choice.mapped.get(field.name) ?? null;
        const offered = question?.options?.length ?? choice.candidates.length;
        if (chosen === null) {
          unanswered.push({ field: field.name, because: `tier 3: ${answeredBy} answered none to \`${id}\` over ${offered} candidate(s) on ${pageCount}; no DOM node holds ${field.name} on every sample` });
          continue;
        }
        if (chosen.multiple) {
          // Deferred, and said rather than smoothed over: a tier-3 binding
          // reaches the scraper through the reconciliation and
          // `compileFromReconciliation` (./proven.ts), and neither carries
          // `Field.multiple` yet. Binding the list selector anyway would
          // replay it as one value -- the first match -- which is the
          // silently-wrong list this option exists to prevent.
          unanswered.push({
            field: field.name,
            because: `tier 3: ${answeredBy} chose \`${chosen.path}\` as a list of every match, and the compile core cannot carry a multi-valued binding yet; ${field.name} is left unbound rather than compiled to its first element`,
          });
          continue;
        }
        const decision: TierDecision = { question: id, premise: question?.premise ?? "", options: offered, chose: candidateLabel(chosen), answeredBy };
        // The fingerprint `compile()` would have written: link and media
        // values made absolute, so the manuscript and the scraper agree.
        const alternative = toAlternative(chosen, choice.baseUrls);
        const values = alternative.fingerprint.samples.length === chosen.values.length ? [...alternative.fingerprint.samples] : [...chosen.values];
        const gate = gateAlternative(chosen.selector, "dom", { sole: true });
        if (!gate.ok) {
          refused.push({
            field: field.name,
            path: chosen.path,
            values,
            decision,
            because: `tier 3: ${answeredBy} chose \`${chosen.path}\` and the selector gate refused it, so ${field.name} is not obtainable from the markup either — ${gate.because}`,
          });
          continue;
        }
        bindings.push({
          field: field.name,
          selector: chosen.selector,
          ...(chosen.attr === undefined ? {} : { attr: chosen.attr }),
          path: chosen.path,
          values,
          decision,
          because:
            `${answeredBy} chose \`${chosen.path}\` out of ${offered} DOM candidate(s) that resolved on all ${pageCount}, asked \`${id}\`` +
            (gate.audit.risks.length > 0 ? `; the selector gate kept it: ${gate.because}` : ""),
        });
      }
      return {
        ran: true,
        bindings,
        refused,
        unanswered,
        sources,
        because:
          `the DOM compiler read ${pageCount}, offered ${choice.candidates.length} candidate(s), and ${answeredBy} answered ${choice.questions.length} question(s): ` +
          `${bindings.length} bound, ${refused.length} refused by the selector gate, ${unanswered.length} answered none`,
      };
    });
  };
}

/**
 * The premise a tier-3 question carries for one field: the spec's own words
 * for it, and every rubric that names it, quoted.
 *
 * R5 says a structured decision is guided by the case's rubrics where it has
 * them. `rubricsFor` is `src/reconcile/`'s matcher, asked rather than
 * respelled, so the rule a chooser read when it picked a node is the rule
 * `rationale.md` quotes beside the binding.
 */
export function describeFrom(spec: Spec): (field: RequestedField) => string | undefined {
  return (field) => {
    const request = spec.fields.find((entry) => entry.name === field.name);
    const parts: string[] = [];
    if (request?.description !== undefined && request.description.trim() !== "") parts.push(request.description.trim());
    for (const rubric of rubricsFor(spec, field.name)) parts.push(`rule ${rubric.id}: "${rubric.rule}"`);
    return parts.length === 0 ? undefined : parts.join("; ");
  };
}

// ------------------------------------------------------- U6: open ambiguity

/**
 * U6 (R5, KTD5): an open ambiguity is a question, asked here.
 *
 * ## What was wrong
 *
 * A field the cheap tiers bound can still have competing readings: values the
 * site states on every sample, each from its own declaration or payload leaf,
 * that disagree with each other. On 2026-09-23 a payload endpoint offered
 * eight text leaves that could each have been `productName`, tier 2 bound the
 * first by key name, and the reconciliation said so -- "eight readings
 * compete, a person decides before this compiles". Two things then happened
 * to that sentence. Without a rubric, the compile bound one reading anyway and
 * wrote "the compile bound one reading anyway" into `rationale.md`; U3 turned
 * that into a hard stop. With a rubric, the rule was *quoted* beside a binding
 * nobody had checked against it: navvi does not read rules, so the binding
 * was still the one key-name ranking picked.
 *
 * ## What happens now
 *
 * Every competing-values ambiguity nobody has decided is one `choice`
 * question: the readings are the options (where each is read from, and what it
 * read on each sample), the premise is the field's spec description plus every
 * rubric that names it, quoted -- the same `describeFrom` tier 3 uses -- and
 * `none` is always on offer. All of them go in one batch. An answer is written
 * into the manuscript as the field's `decision`, the reading chosen becomes the
 * binding, and `reconcile` reads the decision back as `decidedBy` so the
 * ambiguity is no longer open. `none` unbinds the field with the chooser's
 * reason, and the compile goes on with the rest.
 *
 * Asked whether or not a rubric covers the field. A rubric is guidance for a
 * decision; with a chooser present, the decision is taken over it rather than
 * assumed from the order bind happened to rank the leaves in.
 *
 * ## What it does not do
 *
 * - **Decide without a chooser.** No chooser, or one that could not be
 *   opened, and the ambiguity stays exactly as reconcile left it: open when no
 *   rubric covers it (the caller stops, `needs_answers`), settled-by-rubric
 *   when one does.
 * - **Swallow a park.** The agent chooser in file mode throws
 *   `NeedsHumanError` with the batch written to disk; it leaves this function
 *   untouched, and the resume answers the same question ids over the same
 *   options, because both come from the same reconciliation.
 * - **Type gaps.** A type gap has one reading and a question about what the
 *   column means ("is there any?" or "how many?"), which is the spec's to
 *   answer with `--answer`, not a pick among readings.
 */

export const READING_QUESTION_PREFIX = "reading.";

export function readingQuestionId(field: string): string {
  return `${READING_QUESTION_PREFIX}${field}`;
}

/** One thing a reconciliation left for a person, as a stop block names it. */
export interface OpenItem {
  /** The ambiguity id, `<field>/disagreement`, or `obstacle/<kind>`. */
  id: string;
  because: string;
}

/** What still holds a reconciliation open: decisions a person or a chooser owes, and obstacles nobody's answer removes. */
export interface OpenItems {
  questions: OpenItem[];
  obstacles: OpenItem[];
}

/**
 * The open items of a reconciliation, split the way a front end has to act on
 * them: a question is answered (exit 3), an obstacle is not a question at all.
 */
export function openItems(reconciliation: Reconciliation): OpenItems {
  return {
    questions: [
      ...reconciliation.ambiguities
        .filter((ambiguity) => ambiguity.settledBy.length === 0 && ambiguity.decidedBy === undefined)
        .map((ambiguity) => ({ id: ambiguity.id, because: ambiguity.decision ?? ambiguity.because })),
      ...(reconciliation.disagreements ?? [])
        .filter((record) => record.decision !== undefined)
        .map((record) => ({ id: `${record.field}/disagreement`, because: record.decision! })),
    ],
    obstacles: reconciliation.obstacles.filter((obstacle) => obstacle.blocking).map((obstacle) => ({ id: `obstacle/${obstacle.kind}`, because: obstacle.cost })),
  };
}

/** The ambiguities a chooser can answer: competing readings of a bound field that nobody has decided. */
export function askableAmbiguities(reconciliation: Reconciliation): Ambiguity[] {
  return reconciliation.ambiguities.filter((ambiguity) => ambiguity.kind === "competing-values" && ambiguity.decidedBy === undefined && ambiguity.readings.length >= 2);
}

/** Where a reading is read from, in one line: `tier 2 network <endpoint> <path>`, `tier 1 json-ld Product name`. */
function readingWhere(reading: Reading): string {
  const parts = [`tier ${reading.tier}`];
  if (reading.source !== undefined) parts.push(reading.source);
  if (reading.match !== undefined) parts.push(reading.match);
  if (reading.entity !== undefined) parts.push(reading.entity);
  parts.push(reading.path);
  return parts.join(" ");
}

function shown(value: TypedValue): string {
  return value === null ? "null" : clip(String(value), LABEL_VALUE_CHARS);
}

/**
 * `<where> = <value on sample 1> | <value on sample 2>`, the label a tier-3
 * candidate carries, so an option's identity (`optionIdentity`) is where the
 * reading comes from and not what the samples happened to say.
 */
export function readingLabel(reading: Reading): string {
  return `${readingWhere(reading)}${OPTION_VALUE_SEPARATOR}${reading.values.map(shown).join(" | ")}`;
}

/**
 * One choice question per askable ambiguity, all sharing one state: which
 * record, which site, which samples the values were read on.
 */
export function readingQuestions(ambiguities: readonly Ambiguity[], manuscript: Manuscript, spec: Spec): Question[] {
  const describe = describeFrom(spec);
  const samples = manuscript.sample.picks.filter((pick) => pick.bound).map((pick) => safeUrl(pick.url));
  const state = [
    `records: ${spec.entity.name}`,
    `site: ${manuscript.site}`,
    `each reading lists its value on these samples, in this order:`,
    ...samples.map((url, index) => `  ${index + 1}. ${url}`),
  ].join("\n");
  const shared: JsonValue = { records: spec.entity.name, site: manuscript.site, samples };
  return ambiguities.map((ambiguity) => {
    const requested = manuscript.requested.find((field) => field.name === ambiguity.field) ?? { name: ambiguity.field };
    const description = describe(requested);
    const field: { [key: string]: JsonValue } = { name: ambiguity.field };
    if (description !== undefined) field.description = description;
    if (requested.type !== undefined) field.type = requested.type;
    const context: QuestionContext = {
      decision: "field_reading",
      field,
      rubrics: rubricsFor(spec, ambiguity.field).map((rubric) => ({ id: rubric.id, rule: rubric.rule })),
      shared,
    };
    return {
      id: readingQuestionId(ambiguity.field),
      kind: "choice" as const,
      premise: premises.readingChoice(ambiguity.field, description),
      options: ambiguity.readings.map(readingLabel),
      state,
      context,
      optionContext: ambiguity.readings.map((reading): JsonValue => ({
        tier: reading.tier,
        ...(reading.source === undefined ? {} : { source: reading.source }),
        ...(reading.match === undefined ? {} : { endpoint: reading.match }),
        path: reading.path,
        values: reading.values.map((value) => (typeof value === "string" ? clip(value, LABEL_VALUE_CHARS) : value)),
      })),
    };
  });
}

/**
 * What one answer did to its field.
 *
 * `kept` — the chooser chose the reading already bound. `rebound` — it chose
 * another, which is the binding now. `declined` — it answered none, and the
 * field is unbound. `unreadable` — it chose a tier-1 reading this manuscript
 * does not record how to read (written before `RejectionRecord.read`), so the
 * field is unbound rather than compiled through the loser's path and the
 * winner's selector.
 */
export type ReadingOutcome = "kept" | "rebound" | "declined" | "unreadable";

export interface ReadingDecision {
  ambiguity: string;
  field: string;
  question: string;
  answeredBy: string;
  /** The option chosen, as the chooser saw it, or `none`. */
  chose: string;
  outcome: ReadingOutcome;
  because: string;
}

/** A binding as a rejection is spelled: `endpoint:path` at tier 2, the path itself at tier 1. */
function rejectionPath(tier: 1 | 2 | 3, match: string | undefined, path: string): string {
  return tier === 2 ? `${match ?? ""}:${path}` : path;
}

function sameValues(a: readonly TypedValue[], b: readonly TypedValue[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

/** Forget where a field was read from; its rejections, verdicts and decision stay. */
function unbind(record: FieldRecord): void {
  delete record.tier;
  delete record.source;
  delete record.path;
  delete record.match;
  delete record.selector;
  delete record.attr;
  delete record.entity;
  delete record.values;
  record.aliases = [];
  record.askModel = false;
}

/**
 * The manuscript with each answer applied, and what each one did.
 *
 * Pure: the manuscript handed in is not touched. A question with no answer in
 * `answers` is left as it was, so its ambiguity stays open and says so.
 */
export function applyReadingAnswers(
  manuscript: Manuscript,
  ambiguities: readonly Ambiguity[],
  questions: readonly Question[],
  answers: readonly Answer[],
  answeredBy: string,
): { manuscript: Manuscript; decisions: ReadingDecision[] } {
  const next = structuredClone(manuscript);
  const decisions: ReadingDecision[] = [];
  for (const ambiguity of ambiguities) {
    const id = readingQuestionId(ambiguity.field);
    const question = questions.find((entry) => entry.id === id);
    const answer = answers.find((entry) => entry.id === id);
    const record = next.fields.find((entry) => entry.field === ambiguity.field);
    if (question === undefined || answer === undefined || record?.path === undefined || record.tier === undefined) continue;

    const options = question.options ?? [];
    const offered = ambiguity.readings.length;
    const chosen = answer.index === null ? undefined : ambiguity.readings[answer.index];
    const decision: TierDecision = {
      question: id,
      premise: question.premise,
      options: offered,
      chose: answer.index === null ? NONE_OPTION : (options[answer.index] ?? NONE_OPTION),
      answeredBy,
      settles: ambiguity.id,
    };
    const was = { tier: record.tier, match: record.match, path: record.path, values: record.values ?? [], where: readingWhere(ambiguity.readings.find((reading) => reading.bound) ?? ambiguity.readings[0]!) };
    const previous = record.because;
    record.decision = decision;
    record.askModel = false;

    // The binding it displaced joins the rejections, with the reason it lost,
    // so the rationale's "what else was tried" still lists every reading.
    const displace = (because: string): void => {
      record.rejected.push({
        tier: was.tier,
        path: rejectionPath(was.tier, was.match, was.path),
        values: was.values,
        because,
        ...(was.tier === 1 && record.source !== undefined && record.selector !== undefined
          ? {
              read: {
                path: was.path,
                source: record.source,
                selector: record.selector,
                ...(record.attr === undefined ? {} : { attr: record.attr }),
                ...(record.entity === undefined ? {} : { entity: record.entity }),
              },
            }
          : {}),
      });
    };

    let outcome: ReadingOutcome;
    if (chosen === undefined) {
      outcome = "declined";
      displace(`${answeredBy} answered none to \`${id}\`: not the ${ambiguity.field}, and neither was any other reading`);
      unbind(record);
      record.because = `the chooser declined every reading: ${answeredBy} answered none to \`${id}\` over the ${offered} reading(s) the site states for ${ambiguity.field}, so it is not bound -- nothing binds an ambiguous reading without a decision`;
    } else if (chosen.bound) {
      outcome = "kept";
      record.because = `${answeredBy} chose \`${readingWhere(chosen)}\` out of ${offered} competing reading(s), asked \`${id}\`, which is the reading tier ${was.tier} had bound: ${previous}`;
    } else if (chosen.tier !== 2 && (chosen.selector === undefined || chosen.source === undefined)) {
      outcome = "unreadable";
      displace(`${answeredBy} chose \`${readingWhere(chosen)}\` instead, asked \`${id}\``);
      unbind(record);
      record.because =
        `${answeredBy} chose \`${readingWhere(chosen)}\` out of ${offered} reading(s), asked \`${id}\`, and this manuscript does not record how to read that declaration -- ` +
        `it was written before a tier-1 rejection carried its own -- so ${ambiguity.field} is not bound rather than read through the path it chose and the selector it did not. Re-investigate to compile it.`;
    } else {
      outcome = "rebound";
      displace(`${answeredBy} chose \`${readingWhere(chosen)}\` instead, asked \`${id}\``);
      const spelled = rejectionPath(chosen.tier, chosen.match, chosen.path);
      const at = record.rejected.findIndex((rejection) => rejection.tier === chosen.tier && rejection.path === spelled && sameValues(rejection.values, chosen.values));
      if (at >= 0) record.rejected.splice(at, 1);
      unbind(record);
      record.tier = chosen.tier;
      record.source = chosen.tier === 2 ? "network" : chosen.source!;
      record.path = chosen.path;
      if (chosen.match !== undefined) record.match = chosen.match;
      if (chosen.tier !== 2) record.selector = chosen.selector!;
      if (chosen.attr !== undefined) record.attr = chosen.attr;
      if (chosen.entity !== undefined) record.entity = chosen.entity;
      record.values = [...chosen.values];
      // The aliases were other spellings of the value that lost; none of them
      // is known to spell this one, so none is carried over.
      record.because = `${answeredBy} chose \`${readingWhere(chosen)}\` out of ${offered} competing reading(s), asked \`${id}\`; tier ${was.tier} had bound \`${was.where}\`, which is now among the readings it beat`;
    }
    decisions.push({ ambiguity: ambiguity.id, field: ambiguity.field, question: id, answeredBy, chose: decision.chose, outcome, because: record.because });
  }
  return { manuscript: next, decisions };
}

export interface DecideOpenOptions {
  manuscript: Manuscript;
  reconciliation: Reconciliation;
  spec: Spec;
  /** Who answers. Absent: nothing is asked, and whatever is open stays open. */
  chooser?: ChooserSource | undefined;
  now?: Date | undefined;
}

export interface DecidedOpen {
  /** The manuscript with every answer applied; the one handed in when nothing was asked. */
  manuscript: Manuscript;
  /** Reconciled again from that manuscript when anything was answered. */
  reconciliation: Reconciliation;
  /** How many questions were put to the chooser: one per askable ambiguity, or none. */
  asked: number;
  decisions: ReadingDecision[];
  /** Why nothing was asked although something was askable: no chooser, or one that could not be opened. */
  unasked?: string;
}

/**
 * Put every undecided ambiguity to the chooser, in one batch, and reconcile
 * the answers.
 *
 * `NeedsHumanError` from the chooser (the agent protocol parking in file mode)
 * is not caught: it is the caller's exit 3, and its resume asks the same
 * questions again from the same reconciliation.
 */
export async function decideOpen(options: DecideOpenOptions): Promise<DecidedOpen> {
  const { manuscript, reconciliation, spec } = options;
  const ambiguities = askableAmbiguities(reconciliation);
  const unchanged = { manuscript, reconciliation, asked: 0, decisions: [] as ReadingDecision[] };
  if (ambiguities.length === 0) return unchanged;
  if (options.chooser === undefined) return { ...unchanged, unasked: "no chooser was supplied to answer it" };

  let chooser: Chooser;
  try {
    chooser = typeof options.chooser === "function" ? await options.chooser() : options.chooser;
  } catch (error) {
    const said = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "no reason given";
    return { ...unchanged, unasked: `no chooser could be opened to answer it (${said})` };
  }

  const questions = readingQuestions(ambiguities, manuscript, spec);
  const answers = await chooser.ask(questions);
  const applied = applyReadingAnswers(manuscript, ambiguities, questions, answers, chooser.name);
  return {
    manuscript: applied.manuscript,
    reconciliation: reconcile(applied.manuscript, spec, { now: options.now ?? new Date() }),
    asked: questions.length,
    decisions: applied.decisions,
  };
}

/** A chooser source that opens at most once however many stages ask for it. */
function openOnce(source: ChooserSource): ChooserSource {
  if (typeof source !== "function") return source;
  let opened: Promise<Chooser> | undefined;
  return () => (opened ??= source());
}

// ----------------------------------------------------------------- the core

export interface InvestigateTemplateOptions {
  spec: Spec;
  /** The fields to bind, in requested order. Usually the spec's, with the types the client declared. */
  fields: readonly RequestedField[];
  /** Which URLs, and why each is in the sample. */
  sample: SampleChoice;
  sources: TemplateSources;
  /** Who answers tier 3. Absent: tier 3 is recorded as requested and does not run. */
  chooser?: ChooserSource | undefined;
  now?: Date | undefined;
  settle?: SettleOptions | undefined;
}

/**
 * Tiers 1, 2 and 3 for one template, written down as one manuscript.
 *
 * This is `navvi make`'s investigate stage, and the first half of
 * `compileTemplate`. Tier 3 runs only when both a renderer and a chooser were
 * supplied; without either it is recorded as requested, which is what every
 * run did before U4 and still the honest record of one that could not ask.
 */
export function investigateTemplate(options: InvestigateTemplateOptions): Promise<Manuscript> {
  const { render } = options.sources;
  const dom =
    render !== undefined && options.chooser !== undefined
      ? domTier({ render, chooser: options.chooser, describe: describeFrom(options.spec), records: options.spec.entity.name, settle: options.settle })
      : undefined;
  return investigate({
    site: options.spec.target.site,
    fields: options.fields,
    sample: options.sample,
    sources: {
      fetch: (url) => options.sources.fetch(url),
      ...(options.sources.capture === undefined ? {} : { capture: options.sources.capture }),
      ...(dom === undefined ? {} : { dom }),
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/**
 * The chooser a scraper records, read off the manuscript that produced it.
 *
 * `CompiledScraper.chooser` has always meant "who the compile paid", and until
 * U4 a manuscript-built scraper had no honest answer and wrote `agent`. A
 * tier-3 binding carries its own answer; tiers 1 and 2 still have none.
 *
 * U6 added the reconciliation as a second place to look. A decision over an
 * open ambiguity is written into the manuscript *and* carried into the
 * reconciliation; `navvi make` keeps the decided reconciliation on disk and
 * may compile it next run beside the manuscript the investigation wrote, so
 * the answer has to be findable from either.
 */
export function chooserOf(manuscript: Manuscript, reconciliation?: Reconciliation): ChooserId | undefined {
  const decisions = [
    ...manuscript.fields.map((field) => field.decision),
    ...(reconciliation?.obtainable ?? []).map((field) => field.decision),
    ...(reconciliation?.ambiguities ?? []).map((ambiguity) => ambiguity.decidedBy),
    ...(reconciliation?.notObtainable ?? []).map((field) => field.decision),
  ];
  for (const decision of decisions) {
    const by = decision?.answeredBy;
    if (by !== undefined && isChooserId(by)) return by;
  }
  return undefined;
}

export interface TemplateCompileOptions extends InvestigateTemplateOptions {
  templateKey: string;
  /** The URL a replay starts from. */
  entry: { mode: "direct" | "trace"; url: string };
  cacheKey?: string | undefined;
  profile?: Profile | undefined;
}

export type TemplateCompile =
  | {
      ok: true;
      manuscript: Manuscript;
      reconciliation: Reconciliation;
      compiled: ProvenCompile;
      /** U6: what the chooser decided about each open ambiguity it was asked. Empty when nothing was open. */
      decisions: ReadingDecision[];
    }
  | {
      ok: false;
      /**
       * `blocked` — the site refused and nothing was bound. `open` — the
       * reconciliation has a decision nobody made: no chooser was there to
       * ask (U6 asks one first; `unasked` says why it could not), or what is
       * open is not a choice among readings (a type gap, a blocking
       * obstacle). U3: an open ambiguity does not silently compile.
       * `empty` — nothing was proved obtainable.
       * `refused` — everything obtainable was refused by the selector gate.
       */
      status: "blocked" | "open" | "empty" | "refused";
      manuscript: Manuscript;
      reconciliation?: Reconciliation;
      /** `open` only: what is still open, split into questions (exit 3) and blocking obstacles. */
      open?: OpenItems;
      /** `open` only: why the open questions were not put to a chooser, when they were not. */
      unasked?: string;
      /** What the chooser decided before the run stopped, when it was asked anything. */
      decisions?: ReadingDecision[];
      because: string;
    };

/**
 * One template, compiled: tier 1 → tier 2 → tier 3 → reconcile → gate → scraper.
 *
 * Deterministic below the chooser. Everything after the manuscript is pure
 * apart from `decideOpen`'s one batch of questions, which is why `navvi make`
 * can hold the stages apart with a ledger and still be running this cascade
 * rather than a copy of it. A chooser that parks (the agent protocol in file
 * mode) throws `NeedsHumanError` out of this function; that is the caller's
 * exit 3, not a status here.
 */
export async function compileTemplate(options: TemplateCompileOptions): Promise<TemplateCompile> {
  const now = options.now ?? new Date();
  // Tier 3 and the open-ambiguity questions share one chooser, opened at most
  // once and only by whichever of them needs it first.
  const chooserSource = options.chooser === undefined ? undefined : openOnce(options.chooser);
  const investigated = await investigateTemplate({ ...options, chooser: chooserSource, now });
  if (investigated.verdict === "blocked") return { ok: false, status: "blocked", manuscript: investigated, because: investigated.because };

  // U6: an ambiguity is a question before it is a stop.
  const decided = await decideOpen({ manuscript: investigated, reconciliation: reconcile(investigated, options.spec, { now }), spec: options.spec, chooser: chooserSource, now });
  const { manuscript, reconciliation, decisions } = decided;
  if (reconciliation.verdict === "open") {
    const open = openItems(reconciliation);
    const because =
      decided.unasked === undefined || open.questions.length === 0
        ? reconciliation.because
        : `${open.questions.length} open decision(s) (${open.questions.map((item) => item.id).join(", ")}) and ${decided.unasked}: ${reconciliation.because}`;
    return {
      ok: false,
      status: "open",
      manuscript,
      reconciliation,
      open,
      ...(decided.unasked === undefined ? {} : { unasked: decided.unasked }),
      ...(decisions.length === 0 ? {} : { decisions }),
      because,
    };
  }
  if (reconciliation.obtainable.length === 0) return { ok: false, status: "empty", manuscript, reconciliation, ...(decisions.length === 0 ? {} : { decisions }), because: reconciliation.because };

  const chooser = chooserOf(manuscript, reconciliation);
  try {
    const compiled = compileFromReconciliation(reconciliation, manuscript, options.spec, {
      templateKey: options.templateKey,
      entry: options.entry,
      now,
      ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(chooser === undefined ? {} : { chooser }),
    });
    return { ok: true, manuscript, reconciliation, compiled, decisions };
  } catch (error) {
    if (error instanceof NothingCompilableError) return { ok: false, status: "refused", manuscript, reconciliation, ...(decisions.length === 0 ? {} : { decisions }), because: error.message };
    throw error;
  }
}
