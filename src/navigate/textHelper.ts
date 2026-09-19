import { isModelTextAllowed, type Control } from "../browser/policy.js";
import type { SnapshotControl } from "../browser/snapshot.js";
import { TEXT_INPUT_CAP, type Chooser, type Question } from "../chooser/chooser.js";
import { premises } from "../chooser/questions.js";

/**
 * Text helper (KTD11, R24): the one place model-written text enters a run.
 * One `text` question carries the goal, the selected field, visible page
 * context and recent actions; the answer must be a JSON object with exactly
 * one string `text`. Invalid output is retried once, then the caller ends
 * BLOCKED. Model text never lands in personal-data fields and never looks
 * like an email, phone or card number (`isModelTextAllowed`). The value is
 * cached while the entire helper input is identical (a stale re-decision
 * reuses it) and discarded after a successful mutation.
 */

/** Visible page context offered to the helper, before the batch cap trims it. */
export const TEXT_CONTEXT_CHARS = 2_000;
export const TEXT_VALUE_MAX_CHARS = 2_000;

export interface RecentAction {
  action: string;
  text?: string | undefined;
}

export interface TextHelperInput {
  goal: string;
  field: SnapshotControl;
  /** Page title and visible text; capped here, never longer than TEXT_CONTEXT_CHARS. */
  context: { title: string; text: string };
  recentActions: readonly RecentAction[];
}

export type TextHelperResult =
  | { ok: true; text: string; requests: number }
  /** The model said the value is missing (`{"text": null}`); nothing to type, no retry. */
  | { ok: false; kind: "missing"; requests: number }
  /** Two invalid or disallowed answers in a row. */
  | { ok: false; kind: "invalid"; reason: string; requests: number };

/** The policy view of a snapshot control (`form: null` becomes absent). */
export function policyControl(c: SnapshotControl): Control {
  const control: Control = { role: c.role, name: c.name, tag: c.tag };
  if (c.inputType !== undefined) control.inputType = c.inputType;
  if (c.autocomplete !== undefined) control.autocomplete = c.autocomplete;
  if (c.nameAttr !== undefined) control.nameAttr = c.nameAttr;
  if (c.form) control.form = { method: c.form.method, hasTypedText: c.form.hasTypedText, hasPasswordField: c.form.hasPasswordField, hasPaymentField: c.form.hasPaymentField };
  return control;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** KTD11: the JSON must contain exactly one key, `text`, a non-empty string (or null for "missing"). */
export function parseTextAnswer(raw: string): { text: string } | { text: null } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "not valid JSON" };
  }
  if (!isRecord(parsed)) return { error: "not a JSON object" };
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "text") return { error: `keys ${JSON.stringify(keys)} instead of exactly "text"` };
  const text = parsed.text;
  if (text === null) return { text: null };
  if (typeof text !== "string") return { error: "text is not a string" };
  if (!text.trim()) return { error: "text is empty" };
  if (text.length > TEXT_VALUE_MAX_CHARS) return { error: `text is ${text.length} characters, over ${TEXT_VALUE_MAX_CHARS}` };
  return { text };
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** The state string for the helper: JSON of the input with the page text trimmed to fit the batch cap. */
export function textHelperState(input: TextHelperInput, premise: string): string {
  const field = { name: input.field.name, role: input.field.role, value: input.field.value, scope: input.field.scope };
  const actions = input.recentActions.slice(-6);
  const build = (text: string): string => JSON.stringify({ goal: input.goal, field, page: { title: input.context.title, text }, recentActions: actions });
  let context = cap(input.context.text, TEXT_CONTEXT_CHARS);
  let state = build(context);
  // The chooser refuses premise + state over TEXT_INPUT_CAP; the page text is the part that gives.
  while (state.length + premise.length > TEXT_INPUT_CAP && context.length > 0) {
    const over = state.length + premise.length - TEXT_INPUT_CAP;
    context = cap(context, Math.max(0, context.length - over - 1));
    state = build(context);
  }
  return state;
}

/** Cache key: the entire helper input. */
export function textHelperKey(input: TextHelperInput): string {
  return JSON.stringify({
    goal: input.goal,
    field: { id: input.field.id, name: input.field.name, role: input.field.role, value: input.field.value },
    context: input.context,
    recentActions: input.recentActions.slice(-6),
  });
}

export interface GenerateTextOptions {
  /** Question id for the first attempt; the retry appends `.1`. */
  questionId: string;
}

export class TextHelper {
  private pending: { key: string; text: string } | null = null;

  constructor(private readonly chooser: Chooser) {}

  /** Reuses the cached value while the whole input is identical (reference behaviour). */
  cached(input: TextHelperInput): string | null {
    const key = textHelperKey(input);
    return this.pending && this.pending.key === key ? this.pending.text : null;
  }

  /** Called after the typed value reached the page. */
  consume(): void {
    this.pending = null;
  }

  async generate(input: TextHelperInput, options: GenerateTextOptions): Promise<TextHelperResult> {
    const cached = this.cached(input);
    if (cached !== null) return { ok: true, text: cached, requests: 0 };
    const result = await generateText(this.chooser, input, options);
    if (result.ok) this.pending = { key: textHelperKey(input), text: result.text };
    return result;
  }
}

/**
 * One text question, one retry on invalid or disallowed output. The result
 * carries how many chooser requests were spent so the caller can count them.
 */
export async function generateText(chooser: Chooser, input: TextHelperInput, options: GenerateTextOptions): Promise<TextHelperResult> {
  const premise = premises.typeText();
  const state = textHelperState(input, premise);
  let lastError = "no answer";
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = attempt === 0 ? options.questionId : `${options.questionId}.${attempt}`;
    const question: Question = { id, kind: "text", premise, state, maxLength: TEXT_VALUE_MAX_CHARS + 32 };
    const [answer] = await chooser.ask([question]);
    const raw = answer?.text;
    if (typeof raw !== "string") {
      lastError = "no text answer";
      continue;
    }
    const parsed = parseTextAnswer(raw);
    if ("error" in parsed) {
      lastError = parsed.error;
      continue;
    }
    if (parsed.text === null) return { ok: false, kind: "missing", requests: attempt + 1 };
    if (!isModelTextAllowed(policyControl(input.field), parsed.text)) {
      lastError = "text looks like personal data (email, phone or card number) or targets a personal-data field";
      continue;
    }
    return { ok: true, text: parsed.text, requests: attempt + 1 };
  }
  return { ok: false, kind: "invalid", reason: `text helper returned no valid field value twice (${lastError})`, requests: 2 };
}
