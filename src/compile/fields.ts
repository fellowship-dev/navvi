import { UNASKED, agree, answered } from "../agree/agree.js";
import type { LeafCandidate } from "../browser/snapshot.js";
import type { FieldType } from "../input/schema.js";
import { OPTION_VALUE_SEPARATOR, type Answer, type JsonValue, type Question, type QuestionContext } from "../chooser/chooser.js";
import { premises } from "../chooser/questions.js";
import { URL_ATTRS, commonShape, resolveUrl } from "../scraper/extract.js";
import type { FieldAlternative, Shape } from "../scraper/schema.js";
import { clip } from "../util/text.js";

/**
 * Field fan-out (R7, R30, KTD5, KTD6). Candidates are the leaves that resolve
 * on every sample; each field gets one `choice` question over all of them,
 * labeled with the path and the value on each sample. Questions sharing one
 * state form one batch; when the batch would exceed the chunk budget the
 * fields are split across batches, each carrying the state once.
 */

/** Largest serialized batch (state once plus every question) in characters. */
export const CHUNK_BUDGET_CHARS = 24_000;

/** Longest sample value shown per candidate in a label. */
export const LABEL_VALUE_CHARS = 60;

export const FIELD_QUESTION_PREFIX = "field.";

export interface CompileField {
  name: string;
  description?: string | undefined;
  /** R5: recorded in the compiled scraper so replay coerces the same way. */
  type?: FieldType | undefined;
}

export type LeafAttr = LeafCandidate["attr"];

export interface FieldCandidate {
  /** `selector` plus attribute; unique among the candidates offered. */
  key: string;
  path: string;
  selector: string;
  attr?: LeafAttr | undefined;
  /** The resolved value on each sample, in sample order. Never empty. For a list candidate, each sample's first value. */
  values: string[];
  shape: Shape;
  /**
   * A list candidate: `selector` is a positional leaf's selector with its last
   * `:nth-of-type(N)` taken off, so it matches every sibling the snapshot had
   * to tell apart by position, and the field it binds is multi-valued.
   */
  multiple?: true | undefined;
  /** List candidates only: every value on each sample, in sample order. */
  lists?: string[][] | undefined;
}

export interface LeafSpec {
  selector: string;
  attr?: string | undefined;
}

/** Resolves leaf specs on one sample the way replay does; null when a spec does not resolve. */
export interface SampleResolver {
  readonly count: number;
  resolve(sample: number, specs: readonly LeafSpec[]): Promise<Array<string | null>>;
  /** Every value each spec matches on one sample, as replay reads a multi-valued field; null when a spec does not parse. Without it no list candidate is offered. */
  resolveAll?(sample: number, specs: readonly LeafSpec[]): Promise<Array<string[] | null>>;
  /** Base URL of the sample, for absolute link and media values. */
  baseUrl(sample: number): string;
}

export function candidateKey(selector: string, attr: string | undefined): string {
  return attr ? `${selector}@${attr}` : selector;
}

/** Label suffix and key prefix of a list candidate; the suffix is part of the option's identity. */
export const LIST_MARK = " (every match, as a list)";
const LIST_KEY_PREFIX = "list:";

/**
 * The selector of every sibling a positional selector picked one of: the last
 * `:nth-of-type(N)` removed. Null for a selector with no position in it.
 *
 * The last one, wherever it sits, because the snapshot adds a position only
 * where siblings are ambiguous and the innermost ambiguity is the repetition:
 * `div.tags > a.tag:nth-of-type(2)` is one of the tags, and
 * `ol > li:nth-of-type(2) > a` is one of the breadcrumb links.
 */
export function listSelectorOf(selector: string): string | null {
  const re = /:nth-of-type\(\d+\)/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(selector); m !== null; m = re.exec(selector)) last = m;
  if (last === null) return null;
  return selector.slice(0, last.index) + selector.slice(last.index + last[0].length);
}

/**
 * Positional leaves grouped into families: one list selector, one attribute,
 * one path. The path is what makes it a family rather than a coincidence --
 * `span:nth-of-type(2)` beside a `span.text` strips to a selector matching
 * both, and the two are a quote and its byline, not a list -- so a family
 * counts only when two or more of its leaves share a path on one sample.
 */
function leafFamilies(leaves: readonly LeafCandidate[]): Map<string, { path: string; selector: string; attr: LeafAttr; texts: string[] }> {
  const families = new Map<string, { path: string; selector: string; attr: LeafAttr; texts: string[] }>();
  for (const leaf of leaves) {
    const selector = listSelectorOf(leaf.selector);
    if (selector === null) continue;
    const key = `${LIST_KEY_PREFIX}${candidateKey(selector, leaf.attr)}\n${leaf.path}`;
    const family = families.get(key) ?? { path: leaf.path, selector, attr: leaf.attr, texts: [] };
    family.texts.push(leaf.text);
    families.set(key, family);
  }
  for (const [key, family] of families) if (family.texts.length < 2) families.delete(key);
  return families;
}

/** One list spec per leaf family that repeats on some sample, in first-seen order. */
function listSpecs(samples: ReadonlyArray<readonly LeafCandidate[]>): Array<{ key: string; path: string; selector: string; attr: LeafAttr }> {
  const out = new Map<string, { key: string; path: string; selector: string; attr: LeafAttr }>();
  for (const leaves of samples) {
    for (const family of leafFamilies(leaves).values()) {
      const key = LIST_KEY_PREFIX + candidateKey(family.selector, family.attr);
      if (!out.has(key)) out.set(key, { key, path: family.path, selector: family.selector, attr: family.attr });
    }
  }
  return [...out.values()];
}

/**
 * A list candidate is kept when it is a list somewhere -- two or more values
 * on at least one sample -- and has something on at least two samples (every
 * sample, when there are fewer). A list may be empty on one record (a quote
 * with no tags) without that being the selector failing, which is why this is
 * looser than R30's every-sample rule for one value; it is not looser than
 * two samples agreeing, which is `agree`'s own floor. A list identical on
 * every sample is dropped: see the comment inside.
 */
function keepList(lists: ReadonlyArray<readonly string[] | null>): boolean {
  if (lists.some((l) => l === null)) return false;
  const filled = lists.filter((l) => l!.length > 0).length;
  if (filled < Math.min(2, lists.length) || !lists.some((l) => l!.length >= 2)) return false;
  // The same list on every sample is the site's furniture -- its menu, its
  // footer links -- and not something the record says; the positional options
  // still offer any one of them. Measured on the pharmacy demo, where the
  // header, footer and nav lists alone pushed a four-field batch over the
  // chunk budget into a second chooser call.
  const first = JSON.stringify(lists[0]);
  return lists.length < 2 || lists.some((l) => JSON.stringify(l) !== first);
}

/** Values of a list candidate on one sample, as the heal and label code reads them: the first, or "" for an empty list. */
function firstValues(lists: readonly (readonly string[])[]): string[] {
  return lists.map((l) => l[0] ?? "");
}

/**
 * List candidates from one page's leaves alone, for healing a multi-valued
 * field: the positional leaves of one family are its values. Pure.
 */
export function listCandidatesFromLeaves(leaves: readonly LeafCandidate[]): FieldCandidate[] {
  const out: FieldCandidate[] = [];
  const seen = new Set<string>();
  for (const family of leafFamilies(leaves).values()) {
    const key = LIST_KEY_PREFIX + candidateKey(family.selector, family.attr);
    const values = family.texts.filter(Boolean);
    if (seen.has(key) || values.length < 2) continue;
    seen.add(key);
    out.push({ key, path: family.path, selector: family.selector, attr: family.attr, values: [values[0]!], shape: commonShape(values, family.attr), multiple: true, lists: [values] });
  }
  return out;
}

/**
 * Union of the samples' leaves by selector and attribute, kept only when the
 * selector resolves to a non-empty value on every sample (R30).
 *
 * With a resolver that can read every match, each family of positional leaves
 * (`a.tag:nth-of-type(1..4)`) is also returned once as a list candidate, after
 * every single one. The field questions offer only the single ones; the list
 * candidates are the follow-up's (`buildListQuestions`), where the chooser
 * decides between "the second tag" and "the tags".
 */
export async function intersectCandidates(samples: ReadonlyArray<readonly LeafCandidate[]>, resolver: SampleResolver): Promise<FieldCandidate[]> {
  const union = new Map<string, { path: string; selector: string; attr: LeafAttr }>();
  for (const leaves of samples) {
    for (const leaf of leaves) {
      const key = candidateKey(leaf.selector, leaf.attr);
      if (!union.has(key)) union.set(key, { path: leaf.path, selector: leaf.selector, attr: leaf.attr });
    }
  }
  const entries = [...union.entries()];
  const specs: LeafSpec[] = entries.map(([, e]) => ({ selector: e.selector, attr: e.attr }));
  const perSample: Array<Array<string | null>> = [];
  for (let i = 0; i < resolver.count; i++) perSample.push(await resolver.resolve(i, specs));

  const out: FieldCandidate[] = [];
  entries.forEach(([key, e], index) => {
    /**
     * R30, asked through the rule's one owner (`agree` in `agree/agree.ts`)
     * rather than spelled a fourth time. This call site's policy is the
     * strictest of the four and stays that way: a selector that does not
     * resolve on some sample is not a candidate, full stop.
     *
     * A selector that resolved to null or "" is `unasked` and not
     * `unservable`, which is the only honest reading available here: the
     * resolver ran against every sample and reported back, so it has told us
     * "nothing there", never "I could not look". The day it can distinguish a
     * sample it failed to reach from a sample with no such node, that sample
     * becomes `unservable` and this call site gets the tier 2 question rather
     * than inheriting the answer by accident.
     */
    const agreement = agree(
      perSample.map((sample) => {
        const value = sample[index];
        return value === null || value === undefined || value === "" ? UNASKED : answered(value);
      }),
      { requireAskedByAll: true, subject: "this selector" },
    );
    if (agreement === null) return;
    const values = agreement.values;
    if (values.length !== resolver.count) return;
    out.push({ key, path: e.path, selector: e.selector, attr: e.attr, values, shape: commonShape(values, e.attr) });
  });

  if (resolver.resolveAll) {
    const lists = listSpecs(samples);
    if (lists.length > 0) {
      const listSpecsOnly: LeafSpec[] = lists.map((l) => ({ selector: l.selector, attr: l.attr }));
      const perSampleLists: Array<Array<string[] | null>> = [];
      for (let i = 0; i < resolver.count; i++) perSampleLists.push(await resolver.resolveAll(i, listSpecsOnly));
      lists.forEach((l, index) => {
        const bySample = perSampleLists.map((sample) => sample[index] ?? null);
        if (!keepList(bySample)) return;
        const values = bySample as string[][];
        out.push({ key: l.key, path: l.path, selector: l.selector, attr: l.attr, values: firstValues(values), shape: commonShape(values.flat(), l.attr), multiple: true, lists: values });
      });
    }
  }
  return out;
}

/** How many values a list shows per sample in its label. */
const LIST_LABEL_VALUES = 1;
const LIST_VALUE_CHARS = 20;

function listSample(values: readonly string[]): string {
  const shown = values.slice(0, LIST_LABEL_VALUES).map((v) => JSON.stringify(clip(v, LIST_VALUE_CHARS)));
  if (values.length > LIST_LABEL_VALUES) shown.push("…");
  return `${values.length} value${values.length === 1 ? "" : "s"}${shown.length > 0 ? `: ${shown.join(", ")}` : ""}`;
}

/**
 * `<path> = <value on sample 1> | <value on sample 2> | ...`; a list candidate
 * is `<path> (every match, as a list) = 4 values: "a", "b", … | 1 value: "c"`.
 */
export function candidateLabel(candidate: FieldCandidate): string {
  if (candidate.multiple && candidate.lists) return `${candidate.path}${LIST_MARK}${OPTION_VALUE_SEPARATOR}${candidate.lists.map(listSample).join(" | ")}`;
  return `${candidate.path}${OPTION_VALUE_SEPARATOR}${candidate.values.map((v) => clip(v, LABEL_VALUE_CHARS)).join(" | ")}`;
}

export function fieldQuestionId(name: string, suffix = ""): string {
  return `${FIELD_QUESTION_PREFIX}${name}${suffix}`;
}

/** The facts behind a candidate option, for structured backends. */
export function candidateContext(candidate: FieldCandidate, samePath = 1): JsonValue {
  const out: { [key: string]: JsonValue } = { path: candidate.path, shape: candidate.shape, values: candidate.values.map((v) => clip(v, LABEL_VALUE_CHARS)) };
  if (candidate.attr) out.attribute = candidate.attr;
  if (candidate.multiple && candidate.lists) {
    out.multiple = true;
    out.values_per_sample = candidate.lists.map((l) => l.map((v) => clip(v, LABEL_VALUE_CHARS)));
  }
  // Several candidates on one path are the rows of a list (related products, a menu), not the page's own value.
  if (samePath > 1) out.candidates_on_same_path = samePath;
  return out;
}

/** Contexts for a whole option list, each knowing how many options share its path. */
export function candidateContexts(candidates: readonly FieldCandidate[]): JsonValue[] {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
  return candidates.map((c) => candidateContext(c, counts.get(c.path) ?? 1));
}

/** What the fan-out shares: the records, every field, the samples. Builders add the field under decision. */
export interface FanOutContext {
  records: string;
  fields: readonly CompileField[];
  samples: readonly string[];
  mode: "list" | "record";
}

/** The batch-wide state as JSON: every question in a fan-out batch carries the same one. */
export function sharedContext(shared: FanOutContext): JsonValue {
  const fields: JsonValue[] = shared.fields.map((f): JsonValue => (f.description ? { name: f.name, description: f.description } : { name: f.name }));
  return { records: shared.records, mode: shared.mode, fields, samples: [...shared.samples] };
}

/** `shared` is the batch-wide state (every question in the batch carries the same one); the rest is this question's own. */
function fieldContext(field: CompileField, shared: FanOutContext | undefined): QuestionContext {
  const out: QuestionContext = { decision: "field_value", field: field.description ? { name: field.name, description: field.description } : { name: field.name } };
  if (shared) {
    out.shared = sharedContext(shared);
  }
  return out;
}

/** The one-value candidates: what the field questions offer, and what their answer indices point into. */
export function singleCandidates(candidates: readonly FieldCandidate[]): FieldCandidate[] {
  return candidates.filter((c) => !c.multiple);
}

/** Field questions over the one-value candidates; list candidates are the follow-up's (`buildListQuestions`). */
export function buildFieldQuestions(fields: readonly CompileField[], candidates: readonly FieldCandidate[], state: string, suffix = "", shared?: FanOutContext): Question[] {
  const singles = singleCandidates(candidates);
  const options = singles.map(candidateLabel);
  const optionContext = candidateContexts(singles);
  return fields.map((field) => ({
    id: fieldQuestionId(field.name, suffix),
    kind: "choice",
    premise: premises.fieldChoice(field.name, field.description),
    options,
    state,
    context: fieldContext(field, shared),
    optionContext,
  }));
}

export const LIST_QUESTION_PREFIX = "list.";

export function listQuestionId(name: string, suffix = ""): string {
  return `${LIST_QUESTION_PREFIX}${name}${suffix}`;
}

/** A list follow-up: its question, and the list candidates its option indices point into. */
export interface ListFollowUp {
  field: string;
  question: Question;
  offered: FieldCandidate[];
}

/**
 * The list follow-up (2026-09-24): after the field questions, a field whose
 * answer was one member of a repeated family -- `a.tag:nth-of-type(2)` -- is
 * asked whether it is that one element or every one of them, and a field
 * answered `none` is offered the lists on the samples. Nobody else is asked
 * anything, so a field that bound a one-value node costs no extra question.
 *
 * A follow-up and not more options in the field questions, because those
 * options travel once per field: on the pharmacy demo five lists took a
 * four-field batch past the chunk budget into a second chooser call for every
 * record compile, and a second park for an agent answering from a file.
 *
 * The field's name words the premise and nothing else: whether a field is a
 * list is the chooser's call, made over the values.
 */
export function buildListQuestions(
  fields: readonly CompileField[],
  mapped: ReadonlyMap<string, FieldCandidate | null>,
  candidates: readonly FieldCandidate[],
  state: string,
  suffix = "",
  shared?: FanOutContext,
): ListFollowUp[] {
  const lists = candidates.filter((c) => c.multiple);
  if (lists.length === 0) return [];
  const out: ListFollowUp[] = [];
  for (const field of fields) {
    const chosen = mapped.get(field.name) ?? null;
    if (chosen?.multiple) continue;
    const family = chosen === null ? null : listSelectorOf(chosen.selector);
    const offered = chosen === null ? lists : lists.filter((l) => l.selector === family && l.attr === chosen.attr);
    if (offered.length === 0) continue;
    const plural = looksPlural(field.name, field.description);
    const question: Question = {
      id: listQuestionId(field.name, suffix),
      kind: "choice",
      premise: chosen === null ? premises.listForUnbound(field.name, field.description, plural) : premises.listForPositional(field.name, chosen.path, plural),
      options: offered.map(candidateLabel),
      state,
      context: { ...fieldContext(field, shared), decision: "field_list", ...(chosen === null ? {} : { chosen: candidateContext(chosen) }) },
      optionContext: candidateContexts(offered),
    };
    out.push({ field: field.name, question, offered });
  }
  return out;
}

/** Applies list follow-up answers: a chosen list replaces the field's binding; `none` keeps it. */
export function applyListAnswers(mapped: Map<string, FieldCandidate | null>, followUps: readonly ListFollowUp[], answers: readonly Answer[]): void {
  const byId = new Map(answers.map((a) => [a.id, a]));
  for (const followUp of followUps) {
    const answer = byId.get(followUp.question.id);
    const chosen = answer && answer.index !== null ? followUp.offered[answer.index] : undefined;
    if (chosen) mapped.set(followUp.field, chosen);
  }
}

/**
 * Does the field's name or description read as several values per record?
 * Only ever words a premise; it never picks or ranks away an option.
 */
export function looksPlural(name: string, description?: string | undefined): boolean {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const last = words[words.length - 1] ?? "";
  if (/(?<!s|u|i)s$/.test(last) || /(ies|ches|shes|xes)$/.test(last)) return true;
  return description !== undefined && /\b(list|lists|all|every|each|several|multiple)\b/i.test(description);
}

/** Characters a batch costs: the shared state once plus every question's own text. */
export function batchChars(questions: readonly Question[]): number {
  if (questions.length === 0) return 0;
  const states = new Set(questions.map((q) => q.state));
  let total = 0;
  for (const state of states) total += state.length;
  for (const q of questions) total += q.id.length + q.premise.length + (q.options ?? []).reduce((n, o) => n + o.length + 4, 0);
  return total;
}

/**
 * Greedy split preserving order: questions accumulate while the batch stays
 * within `budget`. A single question over budget travels alone (the chooser's
 * own cap decides then).
 */
export function chunkQuestions(questions: readonly Question[], budget = CHUNK_BUDGET_CHARS): Question[][] {
  const batches: Question[][] = [];
  let current: Question[] = [];
  for (const q of questions) {
    if (current.length > 0 && batchChars([...current, q]) > budget) {
      batches.push(current);
      current = [];
    }
    current.push(q);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Chosen candidate per field, null for `none` or an unanswered field. Indices point into the one-value candidates, as the questions offered them. */
export function applyFieldAnswers(fields: readonly CompileField[], all: readonly FieldCandidate[], answers: readonly Answer[], suffix = ""): Map<string, FieldCandidate | null> {
  const candidates = singleCandidates(all);
  const byId = new Map(answers.map((a) => [a.id, a]));
  const map = new Map<string, FieldCandidate | null>();
  for (const field of fields) {
    const answer = byId.get(fieldQuestionId(field.name, suffix));
    const chosen = answer && answer.index !== null ? (candidates[answer.index] ?? null) : null;
    map.set(field.name, chosen);
  }
  return map;
}

/**
 * KTD6 alternative from a chosen candidate. Link and media samples are made
 * absolute; samples with a non-http(s) scheme are dropped from the fingerprint
 * (replay yields null for them, R4). The shape is what the sample values show,
 * not what the attribute name implies (a bare-year `datetime` is an int, and
 * must replay as one); the attribute's shape stands only with no sample left.
 */
/** Most values a list candidate's fingerprint keeps. */
export const LIST_FINGERPRINT_SAMPLES = 12;

export function toAlternative(candidate: FieldCandidate, baseUrls: readonly string[]): FieldAlternative {
  const urlAttr = candidate.attr !== undefined && URL_ATTRS.has(candidate.attr);
  // A list's fingerprint is its elements: each one must fit the shape on replay.
  const raw: Array<[string, number]> = candidate.multiple && candidate.lists
    ? candidate.lists.flatMap((l, i) => l.map((v): [string, number] => [v, i])).slice(0, LIST_FINGERPRINT_SAMPLES)
    : candidate.values.map((v, i): [string, number] => [v, i]);
  const samples = urlAttr
    ? raw.map(([v, i]) => resolveUrl(v, baseUrls[i] ?? baseUrls[0] ?? "")).filter((v): v is string => v !== null)
    : raw.map(([v]) => v);
  const shape = samples.length > 0 ? commonShape(samples) : candidate.shape;
  const alt: FieldAlternative = { selector: candidate.selector, fingerprint: { samples, shape } };
  if (candidate.attr) alt.attr = candidate.attr;
  return alt;
}
