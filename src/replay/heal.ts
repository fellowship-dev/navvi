import type { Page } from "playwright";
import { DEFAULT_CAPS, getCandidates, getControls, type LeafCandidate, type SnapshotControl } from "../browser/snapshot.js";
import type { Question } from "../chooser/chooser.js";
import { premises } from "../chooser/questions.js";
import { askChunked, candidateKey, candidateLabel, toAlternative, type FieldCandidate } from "../compile/index.js";
import { appendFieldAlternative, appendStepAlternative, markHealed, type CompiledScraper, type LocatorAlternative, type Shape, type TraceStep } from "../scraper/schema.js";
import { clip, isRecord } from "../util/text.js";
import type { HealContext, HealOutcome, HealerHook } from "./crawler.js";

/**
 * Healing (U13; R19, R31, R32, R33, R42). A page that fails its fingerprint
 * check or leaves a required field empty re-picks only the failing fields with
 * the chooser, over the leaves present on that page that are not already an
 * alternative, plus none. A failed trace step re-decides that one step over
 * the page's policy-filtered controls. Every repair is an appended
 * alternative: nothing is removed, reordered or renamed. Candidates the run
 * could not map to any field are reported, never stored.
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

export type HealingEvent = FieldHealingEvent | StepHealingEvent;

export function isFieldHealingEvent(event: unknown): event is FieldHealingEvent {
  return isRecord(event) && event.kind === "field" && Array.isArray(event.fields) && typeof event.at === "string";
}

export function isStepHealingEvent(event: unknown): event is StepHealingEvent {
  return isRecord(event) && event.kind === "step" && typeof event.stepIndex === "number" && typeof event.at === "string";
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

function memoryKey(field: string, candidates: readonly FieldCandidate[]): string {
  return `${field}|${candidates.map((c) => c.key).join("\n")}`;
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
  const questions: Question[] = [];
  const state = fieldState(scraper, fields, url);
  for (const name of fields) {
    const field = scraper.fields[name];
    if (!field) continue;
    const known = new Set(field.alternatives.map((a) => candidateKey(a.selector, a.attr)));
    const candidates = leaves.filter((leaf) => !known.has(candidateKey(leaf.selector, leaf.attr))).map(leafToCandidate);
    if (candidates.length === 0 || memory.has(memoryKey(name, candidates))) continue;
    offered.set(name, candidates);
    const samples = field.alternatives[0]?.fingerprint.samples.slice(0, 2) ?? [];
    questions.push({ id: fieldHealQuestionId(name), kind: "choice", premise: premises.healField(name, samples), options: candidates.map(candidateLabel), state });
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
      memory.add(memoryKey(name, candidates));
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
  };
  const [answer] = await chooser.ask([question]);
  const chosen = answer && answer.index !== null ? offered[answer.index] : undefined;
  if (!chosen) return { healed: false, reason: `the chooser picked no control for step ${stepIndex} on ${url}` };
  const locator: LocatorAlternative = { role: chosen.role, name: chosen.name, exact: true };
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
