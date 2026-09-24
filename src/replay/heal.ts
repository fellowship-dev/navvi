import type { Page } from "playwright";
import { DEFAULT_CAPS, getCandidates, getControls, type LeafCandidate, type SnapshotControl } from "../browser/snapshot.js";
import type { JsonValue, Question } from "../chooser/chooser.js";
import { premises } from "../chooser/questions.js";
import { askChunked, candidateContexts, candidateKey, candidateLabel, toAlternative, type FieldCandidate } from "../compile/index.js";
import {
  checkCanary,
  classifyRun,
  mayHeal,
  type CanaryFingerprint,
  type CanaryReading,
  type FieldFill,
  type PageResponse,
  type RunVerdict,
} from "../investigate/blocked.js";
import { stateOf, transitionOf, transitionsForVerdict, transitionsFrom, type State, type StateId, type TransitionId } from "../scraper/machine.js";
import { appendFieldAlternative, appendStepAlternative, markHealed, type CompiledScraper, type LocatorAlternative, type Shape, type TraceStep } from "../scraper/schema.js";
import { clip, isRecord } from "../util/text.js";
import type { HealContext, HealFailure, HealOutcome, HealerHook } from "./crawler.js";
import { isUnstable, type Determinism } from "./determinism.js";
import { withCss } from "../navigate/trace.js";

/**
 * Healing (U13; R19, R31, R32, R33, R42). A page that fails its fingerprint
 * check or leaves a required field empty re-picks only the failing fields with
 * the chooser, over the leaves present on that page that are not already an
 * alternative, plus none. A failed trace step re-decides that one step over
 * the page's policy-filtered controls. Every repair is an appended
 * alternative: nothing is removed, reordered or renamed. Candidates the run
 * could not map to any field are reported, never stored.
 *
 * Phase F adds the two things that were missing from that sentence, and both
 * are about *when* a repair is allowed rather than how one is made.
 *
 *  - **U9c, `licenseToHeal`.** Until it landed, `crawler.ts` called
 *    `createHealer()` unconditionally and `classifyRun` had no importer in this
 *    module at all: the guarantee that "healing must never fire on a blocked
 *    page" was real in the type system — `heal: true` exists only on
 *    `DriftVerdict` — and unenforced in the run. A recompile against Store C's
 *    "¡Lo sentimos!" page was reachable in the code the whole time.
 *  - **U9b, `judgePromotions`.** An alternative that keeps working outranks one
 *    that keeps failing, so the cascade stops paying for a dead first
 *    alternative on every page of every later run.
 */

export const HEAL_QUESTION_PREFIX = "heal.";
export const HEAL_STEP_QUESTION_PREFIX = "heal.step.";

/** A leaf on a drifted page that no field resolves to and that looks like data (money, a badge). Reported in the summary only. */
export interface UnmappedCandidate {
  text: string;
  selector: string;
  path: string;
  shape: Shape;
}

export interface FieldHealingEvent {
  kind: "field";
  /** Fields that received a new alternative. */
  fields: string[];
  at: string;
  url?: string | undefined;
}

export interface StepHealingEvent {
  kind: "step";
  stepIndex: number;
  locator: LocatorAlternative;
  at: string;
  url?: string | undefined;
}

/**
 * U9b: one field's alternatives were reordered because a later one kept
 * answering and the ones ahead of it kept failing.
 *
 * It is a repair like the other two and belongs in the same list, but it is
 * not a *healing*: nothing was asked, nothing was appended, and no chooser was
 * paid. `isFieldHealingEvent` and `isStepHealingEvent` both say `false` about
 * it, which is what keeps a promotion out of the healing budget and out of the
 * "did this run drift?" question.
 */
export interface PromotionEvent {
  kind: "promotion";
  field: string;
  /** Where the winning alternative was before this run moved it to the front. */
  from: number;
  /** How many extracted items voted. See `MIN_PROMOTION_OBSERVATIONS`. */
  observations: number;
  at: string;
  because: string;
}

export type HealingEvent = FieldHealingEvent | StepHealingEvent | PromotionEvent;

export function isFieldHealingEvent(event: unknown): event is FieldHealingEvent {
  return isRecord(event) && event.kind === "field" && Array.isArray(event.fields) && typeof event.at === "string";
}

export function isStepHealingEvent(event: unknown): event is StepHealingEvent {
  return isRecord(event) && event.kind === "step" && typeof event.stepIndex === "number" && typeof event.at === "string";
}

export function isPromotionEvent(event: unknown): event is PromotionEvent {
  return isRecord(event) && event.kind === "promotion" && typeof event.field === "string" && typeof event.from === "number";
}

export function isUnmappedCandidate(value: unknown): value is UnmappedCandidate {
  return isRecord(value) && typeof value.text === "string" && typeof value.selector === "string";
}

export function fieldHealQuestionId(field: string): string {
  return `${HEAL_QUESTION_PREFIX}${field}`;
}

export function stepHealQuestionId(stepIndex: number): string {
  return `${HEAL_STEP_QUESTION_PREFIX}${stepIndex}`;
}

// ---------------------------------------------------------------- unmapped candidates

/** Short badge-like texts worth reporting: stock and offer markers in English and Spanish. A label ending in a colon is not a badge. */
const BADGE_PATTERN = /\b(stock|agotado|disponible|oferta|descuento|promoci[oó]n|promo|sale|sold out|out of stock|discount|% ?off|nuevo|new|env[ií]o gratis|free shipping)\b/i;
const BADGE_MAX_CHARS = 40;

export function looksLikeBadge(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= BADGE_MAX_CHARS && !t.endsWith(":") && BADGE_PATTERN.test(t);
}

function knownKeys(scraper: CompiledScraper): Set<string> {
  const keys = new Set<string>();
  for (const field of Object.values(scraper.fields)) for (const alt of field.alternatives) keys.add(candidateKey(alt.selector, alt.attr));
  if (scraper.detail) for (const field of Object.values(scraper.detail.fields)) for (const alt of field.alternatives) keys.add(candidateKey(alt.selector, alt.attr));
  return keys;
}

/**
 * Leaves no field resolves to that carry a money value or a badge-like text,
 * outside repeated groups (a path shared by `minGroupItems` or more leaves is
 * a listing, not the record). Pure: the caller supplies the page's leaves.
 */
export function unmappedFrom(leaves: readonly LeafCandidate[], scraper: CompiledScraper, minGroupItems = DEFAULT_CAPS.minGroupItems): UnmappedCandidate[] {
  const known = knownKeys(scraper);
  const pathCounts = new Map<string, number>();
  for (const leaf of leaves) pathCounts.set(leaf.path, (pathCounts.get(leaf.path) ?? 0) + 1);
  const out: UnmappedCandidate[] = [];
  for (const leaf of leaves) {
    if (leaf.attr) continue;
    if (known.has(candidateKey(leaf.selector, leaf.attr))) continue;
    if ((pathCounts.get(leaf.path) ?? 0) >= minGroupItems) continue;
    if (leaf.shape !== "money" && !looksLikeBadge(leaf.text)) continue;
    out.push({ text: leaf.text, selector: leaf.selector, path: leaf.path, shape: leaf.shape });
  }
  return out;
}

function candidateScope(scraper: CompiledScraper): { within?: string; itemIndex?: number; span?: number } {
  return scraper.mode === "list" && scraper.item ? { within: scraper.item.anchorSelector, itemIndex: 0, span: scraper.item.span } : {};
}

/** Scans one page for unmapped candidates (code only, no chooser). */
export async function findUnmappedCandidates(page: Page, scraper: CompiledScraper): Promise<UnmappedCandidate[]> {
  const { leaves } = await getCandidates(page, candidateScope(scraper));
  return unmappedFrom(leaves, scraper);
}

// ---------------------------------------------------------------- field healing

function leafToCandidate(leaf: LeafCandidate): FieldCandidate {
  const candidate: FieldCandidate = { key: candidateKey(leaf.selector, leaf.attr), path: leaf.path, selector: leaf.selector, values: [leaf.text], shape: leaf.shape };
  if (leaf.attr) candidate.attr = leaf.attr;
  return candidate;
}

/** At most this many candidates are offered per healed field; small sets are what a chooser answers well (KTD5). */
export const HEAL_CANDIDATE_CAP = 12;

function stem(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Orders a page's candidates for one broken field so the chooser sees a short,
 * relevant list: a value equal to an earlier sample first, then a label or
 * path that shares a word stem with the field name, then a matching value
 * shape, then document order. Capped at HEAL_CANDIDATE_CAP.
 */
export function rankHealCandidates(candidates: readonly FieldCandidate[], ctx: { field: string; shape: Shape; samples: readonly string[] }): FieldCandidate[] {
  const fieldStem = stem(ctx.field).slice(0, 4);
  const sampleSet = new Set(ctx.samples.map((v) => stem(v)));
  const score = (c: FieldCandidate): number => {
    let n = 0;
    if (sampleSet.has(stem(c.values[0] ?? ""))) n += 8;
    const words = stem(c.path).split(" ");
    if (fieldStem.length >= 3 && words.some((w) => w.length >= 3 && (w.startsWith(fieldStem) || fieldStem.startsWith(w.slice(0, 4))))) n += 4;
    if (ctx.shape !== "text" && c.shape === ctx.shape) n += 2;
    if (ctx.shape === "text" && c.shape === "text") n += 1;
    return n;
  };
  return candidates
    .map((c, order) => ({ c, order, score: score(c) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, HEAL_CANDIDATE_CAP)
    .map(({ c }) => c);
}

function memoryKey(field: string, candidates: readonly FieldCandidate[]): string {
  return `${field}|${candidates.map((c) => c.key).sort().join("\n")}`;
}

function fieldState(scraper: CompiledScraper, fields: readonly string[], url: string): string {
  const lines = [`Healing on ${url}`, `Fields whose compiled selectors no longer resolve: ${fields.join(", ")}`];
  for (const name of fields) {
    const samples = scraper.fields[name]?.alternatives[0]?.fingerprint.samples.slice(0, 3) ?? [];
    if (samples.length > 0) lines.push(`Earlier ${name} values: ${samples.map((s) => JSON.stringify(s)).join(" | ")}`);
  }
  return lines.join("\n");
}

async function healFields(ctx: HealContext, fields: readonly string[], memory: Set<string>): Promise<HealOutcome> {
  const { page, scraper, chooser } = ctx;
  const url = page.url();
  const { leaves } = await getCandidates(page, candidateScope(scraper));
  const offered = new Map<string, FieldCandidate[]>();
  const freshByField = new Map<string, FieldCandidate[]>();
  const questions: Question[] = [];
  const state = fieldState(scraper, fields, url);
  for (const name of fields) {
    const field = scraper.fields[name];
    if (!field) continue;
    const known = new Set(field.alternatives.map((a) => candidateKey(a.selector, a.attr)));
    const samples = field.alternatives[0]?.fingerprint.samples.slice(0, 2) ?? [];
    const shape = field.alternatives[0]?.fingerprint.shape ?? "text";
    const fresh = leaves.filter((leaf) => !known.has(candidateKey(leaf.selector, leaf.attr))).map(leafToCandidate);
    const candidates = rankHealCandidates(fresh, { field: name, shape, samples });
    // The none-memory keys on every fresh leaf, so pages with the same structure share one answer whatever the cap keeps.
    if (candidates.length === 0 || memory.has(memoryKey(name, fresh))) continue;
    offered.set(name, candidates);
    freshByField.set(name, fresh);
    const allFields = Object.keys(scraper.fields);
    questions.push({
      id: fieldHealQuestionId(name),
      kind: "choice",
      premise: premises.healField(name, samples),
      options: candidates.map(candidateLabel),
      state,
      context: { decision: "heal_field_value", field: { name }, earlier_values: [...samples], shape, shared: { healing: "the compiled selectors no longer resolve on this page", page: url, mode: scraper.mode, fields: allFields, broken_fields: [...fields] } },
      optionContext: candidateContexts(candidates),
    });
  }
  if (questions.length === 0) {
    return { healed: false, reason: `no new candidate for ${fields.join(", ")} on ${url}`, unmapped: unmappedFrom(leaves, scraper) };
  }
  const answers = await askChunked(chooser, questions);
  const byId = new Map(answers.map((a) => [a.id, a]));
  let healed = scraper;
  const fixed: string[] = [];
  for (const [name, candidates] of offered) {
    const answer = byId.get(fieldHealQuestionId(name));
    const chosen = answer && answer.index !== null ? candidates[answer.index] : undefined;
    if (!chosen) {
      memory.add(memoryKey(name, freshByField.get(name) ?? candidates));
      continue;
    }
    healed = appendFieldAlternative(healed, name, toAlternative(chosen, [url]));
    fixed.push(name);
  }
  const unmapped = unmappedFrom(leaves, healed);
  if (fixed.length === 0) return { healed: false, reason: `the chooser picked none for ${[...offered.keys()].join(", ")} on ${url}`, unmapped };
  return { healed: true, scraper: markHealed(healed), event: { kind: "field", fields: fixed, at: new Date().toISOString(), url }, unmapped };
}

// ---------------------------------------------------------------- step healing

const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "textarea"]);
const SELECT_ROLES = new Set(["combobox", "listbox"]);

/** Controls a step's operation can act on (R42): typing needs a text control, a secret a password input, a click anything else. */
export function fitsStep(step: TraceStep, control: SnapshotControl): boolean {
  switch (step.op) {
    case "type":
      return step.secret !== undefined ? control.secretCapable : TEXT_ROLES.has(control.role) && !control.secretCapable;
    case "select":
      return SELECT_ROLES.has(control.role) || control.tag === "select";
    case "click":
      return !TEXT_ROLES.has(control.role) && !control.secretCapable;
    default:
      return false;
  }
}

const q = (s: string, max: number): string => JSON.stringify(clip(s, max));

/** The facts behind a control option, for structured backends. */
export function controlContext(control: SnapshotControl): JsonValue {
  const out: { [key: string]: JsonValue } = { role: control.role, name: clip(control.name, 60) };
  if (control.inputType) out.input_type = control.inputType;
  if (control.disabled) out.disabled = true;
  if (control.href) out.href = control.href.slice(0, 100);
  if (control.scope) out.scope = clip(control.scope, 60);
  if (control.value) out.current_value = clip(control.value, 60);
  if (control.checked !== undefined) out.checked = control.checked;
  if (control.form) out.form = { method: control.form.method, action: clip(control.form.action, 80) };
  return out;
}

export function controlLabel(control: SnapshotControl): string {
  const bits = [control.role, q(control.name, 60)];
  if (control.inputType && control.inputType !== "text" && control.inputType !== "submit") bits.push(`type=${control.inputType}`);
  if (control.disabled) bits.push("disabled");
  if (control.href) bits.push(`-> ${control.href.slice(0, 100)}`);
  if (control.scope) bits.push(`in ${q(control.scope, 60)}`);
  return bits.join(" ");
}

async function healStep(ctx: HealContext, stepIndex: number, reason: string): Promise<HealOutcome> {
  const { page, scraper, chooser } = ctx;
  const step = scraper.trace[stepIndex];
  if (!step) return { healed: false, reason: `no trace step ${stepIndex}` };
  if (step.op === "human" || step.op === "wait" || step.op === "scroll") return { healed: false, reason: `a ${step.op} step has no locator to heal` };
  const controls = await getControls(page, { profile: scraper.profile, allowMutations: ctx.allowMutations });
  const offered = controls.filter((c) => fitsStep(step, c) && !step.alternatives.some((a) => a.role === c.role && a.name === c.name));
  const url = page.url();
  if (offered.length === 0) return { healed: false, reason: `no control on ${url} fits the ${step.op} step` };
  const last = step.alternatives.at(-1);
  const state = [`Trace step ${stepIndex + 1} of ${scraper.trace.length}: ${step.op}${step.secret !== undefined ? " (secret)" : ""}`, `Page: ${url}`, `Failure: ${reason}`].join("\n");
  const question: Question = {
    id: stepHealQuestionId(stepIndex),
    kind: "choice",
    premise: premises.healStep(step.op, last?.name ?? ""),
    options: offered.map(controlLabel),
    state,
    context: { decision: "heal_trace_step", step: { index: stepIndex + 1, of: scraper.trace.length, operation: step.op, secret: step.secret !== undefined, recorded_control: last ? { role: last.role, name: last.name } : null }, shared: { page: url, failure: reason } },
    optionContext: offered.map(controlContext),
  };
  const [answer] = await chooser.ask([question]);
  const chosen = answer && answer.index !== null ? offered[answer.index] : undefined;
  if (!chosen) return { healed: false, reason: `the chooser picked no control for step ${stepIndex} on ${url}` };
  const locator: LocatorAlternative = withCss({ role: chosen.role, name: chosen.name, exact: true }, chosen);
  const healed = markHealed(appendStepAlternative(scraper, stepIndex, locator));
  return { healed: true, scraper: healed, event: { kind: "step", stepIndex, locator, at: new Date().toISOString(), url } };
}

// ---------------------------------------------------------------- the hook

/** A healer for one run: remembers `none` answers per offered question (field and candidate set), so the same drifted shape is asked once. */
export function createHealer(): HealerHook {
  const memory = new Set<string>();
  return async (ctx) => {
    const { failure } = ctx;
    if (failure.kind === "fields") return healFields(ctx, failure.fields, memory);
    return healStep(ctx, failure.stepIndex, failure.reason);
  };
}

// ---------------------------------------------------------------- U9c: the gate

/**
 * Everything the run knows at the moment it wants to repair something.
 *
 * `classifyRun` is offline and run-wide and the crawler is at one live page,
 * and that mismatch is the whole of U9c's seam. It is resolved by **carrying
 * the run-wide evidence and re-asking at every repair** rather than by
 * classifying once: the corpus grows as the run goes, so the verdict gets
 * sharper, and the page the healer is about to learn from is always the newest
 * member of it. A verdict computed once at the start would have been a verdict
 * about a run that had not happened; a verdict computed from this page alone
 * could not see the apology shape, which is a statement about a corpus and the
 * only thing that caught Store C without a canary.
 *
 * What is deliberately *not* in here: a threshold, a page count, a "once the
 * run has enough" clause. Healing is the operation where a gate that is
 * usually right destroys the artifact, so every field below is evidence and
 * `classifyRun` is the only thing that weighs it.
 */
export interface HealEvidence {
  /**
   * The pages this run read that failed their fingerprint check, in read
   * order, with the one in hand last.
   *
   * Failures only, and that is the right corpus rather than a saving: the
   * question is "may I learn from this page", so the population is the pages a
   * repair would be learned from. Store C's 111 failures are 111 copies of one
   * apology and `apologySignals` sees that; the pharmacy redesign's 12 failures
   * are 12 different product pages and it does not.
   */
  pages: readonly PageResponse[];
  /**
   * Fill counts per field **over those same pages**, read as the scraper stood
   * before any repair.
   *
   * The corpus and the counts have to be the same set of pages or the two
   * halves of the verdict are about different runs. The machine's requirement
   * is that the field stopped filling *while the rest of the run kept
   * answering*, which is a comparison between fields on the pages that are
   * failing — not between this page and a history of pages that are not.
   */
  fields: Readonly<Record<string, FieldFill>>;
  /**
   * The values each field actually produced on them, so `no-variation-no-field`
   * runs inside `classifyRun` rather than being trusted to the caller. This is
   * the half a fill rate cannot see: Store C's `product_name` was 111/111
   * filled with "¡Lo sentimos!", which is a collapse wearing a healthy number.
   */
  values: Readonly<Record<string, ReadonlyArray<string | number | null>>>;
  /** The canary recorded when this scraper was compiled, when the run carries one. */
  canary?: CanaryFingerprint | undefined;
  /** The page to check that canary against. See `canaryReadingFor`. */
  observed?: PageResponse | undefined;
  /** U6a's artifact, when the compile produced one. A field it rejected may not be repaired. */
  determinism?: Determinism | undefined;
}

export type HealLicence =
  | {
      licensed: true;
      /** The fields the repair may touch: the ones asked for, less anything U6a rejected. */
      fields: string[];
      verdict: RunVerdict;
      because: string;
    }
  | { licensed: false; verdict: RunVerdict; because: string };

/**
 * The canary reading for this run, and why it is taken against the page in
 * hand rather than by re-fetching the canary's own URL.
 *
 * `recordCanary` keeps a page's *most frequent* words, and the frequent words
 * of a product page are its furniture — the nav, the footer, the store's name.
 * That is chosen precisely so the fingerprint survives a redesign of the
 * product tile and disappears when the site stops serving you a page at all,
 * which makes it a fingerprint of the **site's answer**, not of one URL's
 * content. Measured on this repository's own demo fixtures, the canary taken
 * off one v1 product page keeps 17 to 22 of its 24 words on every one of the
 * twelve *redesigned* v2 pages, against a threshold of 0.4.
 *
 * So the page in hand answers the canary's question directly — is the site
 * still serving me the kind of page it served when this was recorded — and it
 * answers it about the page a repair would actually be learned from, which
 * re-fetching some other URL does not. It is also free: the healer has the
 * page open.
 */
export function canaryReadingFor(evidence: HealEvidence): CanaryReading | undefined {
  if (!evidence.canary) return undefined;
  const observed = evidence.observed ?? evidence.pages.at(-1);
  return checkCanary(evidence.canary, observed);
}

/**
 * **U9c: may this repair happen at all?**
 *
 * `mayHeal` is the only way to a field repair and `heal: true` exists on no
 * verdict but drift — that has been true in the type system since U3 and was
 * unenforced in the run, because nothing consumed `classifyRun`. This is the
 * consumption. A run whose canary failed comes back `blocked` and does not
 * heal.
 *
 * The two kinds of repair are licensed differently, and the machine is why:
 *
 *  - A **field** repair is `append-an-alternative`, which leaves from
 *    `drifted`, which is reached only by `stop-filling` — and `stop-filling`
 *    is tagged `onVerdict: "drift"`. So a field repair needs exactly
 *    `mayHeal`, and the type guard is asked rather than restated.
 *  - A **step** repair appends a *locator* to a trace step. It binds a control,
 *    not a value, so it cannot poison a column — but it can just as easily
 *    learn the button on a login wall or a challenge interstitial, so it is
 *    refused whenever the verdict licenses a transition into a state the run
 *    does not continue from. That is read off the machine's own `StateKind`
 *    (`terminal`, `undecided`) rather than from a list of verdict names here.
 *
 * `src/scraper/machine.ts` does not model step healing as a transition at all
 * — `append-an-alternative` is about a field re-picked over a drifted page's
 * leaves, and there is no edge for a locator re-decided over its controls. An
 * edge invented here would be the machine written a second time, so none is.
 * What the machine does model is where a run stops, and that is enough to say
 * what a step repair may not be attempted from.
 */
const ALL_KINDS: readonly State["kind"][] = ["start", "progress", "undecided", "rest", "terminal"];

export function licenseToHeal(failure: HealFailure, evidence: HealEvidence): HealLicence {
  const reading = canaryReadingFor(evidence);
  const verdict = classifyRun({
    pages: evidence.pages,
    fields: evidence.fields,
    values: evidence.values,
    ...(reading ? { canary: reading } : {}),
  });

  if (failure.kind === "step") {
    const dead = licensed(verdict, ["compiled", "sampled", "replayed", "deferred"], ["terminal", "undecided"]);
    if (dead) return { licensed: false, verdict, because: stepSentence(verdict, dead) };
    return { licensed: true, fields: [], verdict, because: stepSentence(verdict, undefined) };
  }

  if (!mayHeal(verdict)) {
    const instead = licensed(verdict, ["replayed", "compiled", "sampled", "deferred"], ALL_KINDS);
    return { licensed: false, verdict, because: refusal("replayed", "stop-filling", verdict, instead) };
  }

  // U6a's consumer. `isUnstable` and `unstableFields` landed with the
  // determinism stage and had no caller, so a field measured as moving on a
  // page nobody changed could still be healed — which is the 2026-09-22
  // replay's 33 phantom repairs with a gate in front of them and the gate
  // looking the other way. A rejected binding is rejected, not repaired.
  const rejected = evidence.determinism ? failure.fields.filter((name) => isUnstable(evidence.determinism!, name)) : [];
  const fields = failure.fields.filter((name) => !rejected.includes(name));
  const note = rejected.length === 0 ? "" : ` ${rejected.join(", ")} ${rejected.length === 1 ? "is" : "are"} left out: U6a rejected ${rejected.length === 1 ? "it" : "them"} as unstable, and a repair aimed at a value that will not hold still appends whichever form the page happened to show this second.`;
  if (fields.length === 0) {
    return { licensed: false, verdict, because: `${allowed("replayed", "stop-filling", verdict)}${note} Nothing is left to repair.` };
  }
  return { licensed: true, fields, verdict, because: `${allowed("replayed", "stop-filling", verdict)}${note}` };
}

/**
 * The transition this verdict licenses, preferring the state the repair claims
 * to be in.
 *
 * Both halves come out of the machine: `onVerdict` says which edges a verdict
 * licenses, and `StateKind` says whether the state at the far end is one a run
 * continues from. Nothing here lists verdict names against outcomes — the
 * moment this file did that it would be a second spelling of the table in
 * `src/scraper/machine.ts`, which is exactly what `tests/machine.test.ts`
 * exists to keep from happening twice.
 */
function licensed(verdict: RunVerdict, order: readonly StateId[], kinds: readonly State["kind"][]): { from: StateId; id: TransitionId; to: StateId } | undefined {
  const byVerdict = new Set(transitionsForVerdict(verdict.state).map((transition) => transition.id));
  for (const state of order) {
    for (const transition of transitionsFrom(state)) {
      if (!byVerdict.has(transition.id)) continue;
      const target = stateOf(transition.to);
      if (target && kinds.includes(target.kind)) return { from: state, id: transition.id as TransitionId, to: transition.to };
    }
  }
  return undefined;
}

/** A state as a report prints it: the name the machine gives it and the sentence it carries. */
function say(id: string): string {
  const state = stateOf(id);
  return state ? `"${state.id}" (${state.what})` : `"${id}"`;
}

/** What a transition asks of a run, quoted from the machine with the module that answers each one. */
function asks(id: TransitionId): string {
  const transition = transitionOf(id);
  if (!transition) return "";
  return transition.requires.map((requirement) => `${JSON.stringify(requirement.must)} (${requirement.decidedBy})`).join("; and ");
}

/**
 * U9a: a repair decision in the machine's words.
 *
 * The sentence names a state, the transition the repair needs, what that
 * transition requires and who decides it, the transition the run's verdict
 * licensed instead, and where the field comes to rest — in place of
 * "a selector stopped matching", which says none of those and is what this
 * module used to print.
 */
function refusal(from: StateId, needed: TransitionId, verdict: RunVerdict, instead: { from: StateId; id: TransitionId; to: StateId } | undefined): string {
  const wanted = transitionOf(needed);
  const rest = instead ? stateOf(instead.to) : undefined;
  const head = `the field is in ${say(from)}, and the repair needs "${needed}" (${wanted?.from} -> ${wanted?.to}), which requires ${asks(needed)}`;
  const licensed = instead
    ? `classifyRun answered "${verdict.state}", which licenses "${instead.id}" (${instead.from} -> ${instead.to}) instead`
    : `classifyRun answered "${verdict.state}", which licenses no transition this run may take next`;
  const lands = rest ? ` The field comes to rest in ${say(rest.id)}, a ${rest.kind} state.` : "";
  return `${head}. ${licensed}: ${verdict.because}.${lands}`;
}

/** The same sentence for a repair that was allowed, so a heal in the log says which transition licensed it. */
function allowed(from: StateId, taken: TransitionId, verdict: RunVerdict): string {
  const transition = transitionOf(taken);
  return `the field is in ${say(from)} and classifyRun answered "${verdict.state}", which licenses "${taken}" (${transition?.from} -> ${transition?.to}): ${verdict.because}.`;
}

/**
 * The step repair's sentence.
 *
 * A trace step is in `compiled` and its failure mode is
 * `trace-stops-progressing` (`compiled -> refused`). A step repair is an
 * attempt *not* to take that edge, so it is not licensed by a transition of
 * its own — the machine does not model step healing, and inventing an edge for
 * it here would be writing the machine a second time. What the machine does
 * say is where a run that is being refused comes to rest, and a locator
 * learned from a page the site refused is the login wall's button.
 */
function stepSentence(verdict: RunVerdict, dead: { from: StateId; id: TransitionId; to: StateId } | undefined): string {
  const stalled = transitionOf("trace-stops-progressing");
  const head = `the step is in ${say("compiled")}, and it stopped reaching the page — "${stalled?.id}" (${stalled?.from} -> ${stalled?.to}): ${stalled?.because}`;
  if (!dead) {
    return `${head}. classifyRun answered "${verdict.state}", which licenses no transition into a state this run cannot continue from, so the step may be re-decided against the page in front of it: ${verdict.because}.`;
  }
  const rest = stateOf(dead.to);
  return (
    `${head}. classifyRun answered "${verdict.state}", which licenses "${dead.id}" (${dead.from} -> ${dead.to}): ${verdict.because}. ` +
    `The run comes to rest in ${say(dead.to)}, a ${rest?.kind} state, and a locator re-decided against a page that was not served is the refusal's own control.`
  );
}

// ------------------------------------------------------------ U9b: promotion

/**
 * How many items each alternative of each field answered, by array index.
 *
 * `extractPage` resolves a field's alternatives in order and stops at the
 * first that answers, so `ItemExtraction.resolvedBy` is already a vote: the
 * index it names is the alternative that did the work, and every index before
 * it is one that was tried on this page and did not. Counting those votes is
 * the whole of the evidence promotion rests on — nothing is persisted, nothing
 * is added to `CompiledScraper`, and a run that reorders nothing pays for a
 * few integers.
 */
export type ResolutionTally = Record<string, number[]>;

/** Record one item's `resolvedBy` into the tally. */
export function observeResolutions(tally: ResolutionTally, resolvedBy: Readonly<Record<string, number | null>>): void {
  for (const [field, index] of Object.entries(resolvedBy)) {
    if (index === null || index === undefined || !Number.isInteger(index) || index < 0) continue;
    const counts = (tally[field] ??= []);
    while (counts.length <= index) counts.push(0);
    counts[index] = (counts[index] ?? 0) + 1;
  }
}

/**
 * How many items have to vote before a field's alternatives may be reordered.
 *
 * Three, for the reason `DEFAULT_REPLAYS` is three: two observations that
 * point the same way are still one coincidence away from being wrong, and a
 * listing whose first row happens to be malformed would otherwise reorder a
 * good binding on the strength of one page. Three is also cheap — every
 * ordinary run produces far more — so the cost of the floor is paid only by
 * runs too small to have measured anything.
 */
export const MIN_PROMOTION_OBSERVATIONS = 3;

export interface Promotion {
  field: string;
  /** The index that kept answering. Always greater than zero, or it would already be first. */
  from: number;
  observations: number;
  because: string;
}

export interface PromotionOptions {
  /**
   * Fields healed during this run, which may not be promoted from it.
   *
   * A healed alternative did not exist for the first part of the run, so its
   * count and the incumbent's were taken over different sets of pages, and
   * comparing them is comparing two different measurements. Store C's
   * promotion is described as happening *unattended* for exactly this reason:
   * the repair is one run's work and the promotion is the next run's evidence
   * that it was the right one.
   */
  healed?: ReadonlySet<string> | undefined;
  minObservations?: number | undefined;
}

/**
 * U9b: which fields have an alternative that keeps working ahead of which keep
 * failing.
 *
 * The rule is deliberately all-or-nothing rather than a score. One alternative
 * answered **every** observation and everything ahead of it answered **none**,
 * over at least `MIN_PROMOTION_OBSERVATIONS` items — anything less than that is
 * a field whose alternatives answer on different pages, which is U6b's finding
 * (two facts on one field) and not a ranking problem. Ranking a genuine
 * disagreement would commit one fact and hide the other, which is the one thing
 * `judgeAlternatives` exists to refuse.
 *
 * Pure: the tally in, the decisions out, no page and no clock.
 */
export function judgePromotions(scraper: CompiledScraper, tally: ResolutionTally, options: PromotionOptions = {}): Promotion[] {
  const floor = options.minObservations ?? MIN_PROMOTION_OBSERVATIONS;
  const out: Promotion[] = [];
  for (const [field, definition] of Object.entries(scraper.fields)) {
    if (options.healed?.has(field)) continue;
    if (definition.alternatives.length < 2) continue;
    const counts = tally[field] ?? [];
    const observations = counts.reduce((sum, n) => sum + n, 0);
    if (observations < floor) continue;
    const winner = counts.findIndex((n) => n > 0);
    if (winner <= 0) continue;
    if (counts[winner] !== observations) continue;
    const ahead = definition.alternatives.slice(0, winner).map((alternative, index) => `${index}: ${label(alternative)}`);
    out.push({
      field,
      from: winner,
      observations,
      because:
        `${field} resolved through alternative ${winner} (${label(definition.alternatives[winner]!)}) on all ${observations} items this run, ` +
        `and the ${ahead.length === 1 ? "alternative" : "alternatives"} ahead of it answered none of them (${ahead.join(", ")}). ` +
        `An alternative that keeps working outranks one that keeps failing, so it moves first; nothing is removed, so the ordering is a claim the next run can overturn.`,
    });
  }
  return out;
}

function label(alternative: CompiledScraper["fields"][string]["alternatives"][number]): string {
  const source = alternative.source ?? "dom";
  return alternative.path ? `${source} ${alternative.path}` : `${source} ${alternative.selector}${alternative.attr ? `@${alternative.attr}` : ""}`;
}
