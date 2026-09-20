import type { LeafCandidate } from "../browser/snapshot.js";
import type { Answer, JsonValue, Question, QuestionContext } from "../chooser/chooser.js";
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
}

export type LeafAttr = LeafCandidate["attr"];

export interface FieldCandidate {
  /** `selector` plus attribute; unique among the candidates offered. */
  key: string;
  path: string;
  selector: string;
  attr?: LeafAttr | undefined;
  /** The resolved value on each sample, in sample order. Never empty. */
  values: string[];
  shape: Shape;
}

export interface LeafSpec {
  selector: string;
  attr?: string | undefined;
}

/** Resolves leaf specs on one sample the way replay does; null when a spec does not resolve. */
export interface SampleResolver {
  readonly count: number;
  resolve(sample: number, specs: readonly LeafSpec[]): Promise<Array<string | null>>;
  /** Base URL of the sample, for absolute link and media values. */
  baseUrl(sample: number): string;
}

export function candidateKey(selector: string, attr: string | undefined): string {
  return attr ? `${selector}@${attr}` : selector;
}

/**
 * Union of the samples' leaves by selector and attribute, kept only when the
 * selector resolves to a non-empty value on every sample (R30).
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
    const values: string[] = [];
    for (const sample of perSample) {
      const value = sample[index];
      if (value === null || value === undefined || value === "") return;
      values.push(value);
    }
    if (values.length !== resolver.count) return;
    out.push({ key, path: e.path, selector: e.selector, attr: e.attr, values, shape: commonShape(values, e.attr) });
  });
  return out;
}

/** `<path> = <value on sample 1> | <value on sample 2> | ...` */
export function candidateLabel(candidate: FieldCandidate): string {
  return `${candidate.path} = ${candidate.values.map((v) => clip(v, LABEL_VALUE_CHARS)).join(" | ")}`;
}

export function fieldQuestionId(name: string, suffix = ""): string {
  return `${FIELD_QUESTION_PREFIX}${name}${suffix}`;
}

/** The facts behind a candidate option, for structured backends. */
export function candidateContext(candidate: FieldCandidate, samePath = 1): JsonValue {
  const out: { [key: string]: JsonValue } = { path: candidate.path, shape: candidate.shape, values: candidate.values.map((v) => clip(v, LABEL_VALUE_CHARS)) };
  if (candidate.attr) out.attribute = candidate.attr;
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

export function buildFieldQuestions(fields: readonly CompileField[], candidates: readonly FieldCandidate[], state: string, suffix = "", shared?: FanOutContext): Question[] {
  const options = candidates.map(candidateLabel);
  const optionContext = candidateContexts(candidates);
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

/** Chosen candidate per field, null for `none` or an unanswered field. */
export function applyFieldAnswers(fields: readonly CompileField[], candidates: readonly FieldCandidate[], answers: readonly Answer[], suffix = ""): Map<string, FieldCandidate | null> {
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
export function toAlternative(candidate: FieldCandidate, baseUrls: readonly string[]): FieldAlternative {
  const urlAttr = candidate.attr !== undefined && URL_ATTRS.has(candidate.attr);
  const samples = urlAttr
    ? candidate.values.map((v, i) => resolveUrl(v, baseUrls[i] ?? baseUrls[0] ?? "")).filter((v): v is string => v !== null)
    : [...candidate.values];
  const shape = samples.length > 0 ? commonShape(samples) : candidate.shape;
  const alt: FieldAlternative = { selector: candidate.selector, fingerprint: { samples, shape } };
  if (candidate.attr) alt.attr = candidate.attr;
  return alt;
}
