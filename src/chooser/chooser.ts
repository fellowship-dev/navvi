import { APICallError } from "@ai-sdk/provider";
import { type Chooser as ChooserId } from "../input/schema.js";
import { Budget, ModelUnavailableError, NavviError, NeedsHumanError } from "../billing/budget.js";
import { maskSecrets } from "../secrets/resolve.js";
import { isRecord, sleep } from "../util/text.js";

/**
 * R37 / KTD2: one chooser interface. Every choice is a question over
 * code-enumerated options plus `none`; the answer is an index validated against
 * the offered options whatever the backend. Free text leaves the interface only
 * for `text` questions (KTD11).
 */

export type ChooserName = ChooserId | "recorded";
export type QuestionKind = "choice" | "boolean" | "score" | "text";

export interface Question {
  id: string;
  kind: QuestionKind;
  /** What is being decided, written by questions.ts. Never contains a secret. */
  premise: string;
  /** choice: the offered options (none is implicit). score: ordered levels, lowest first. */
  options?: string[];
  /** The shared state the question is asked over (page excerpt, candidate table). */
  state: string;
  /** text only: maximum answer length in characters. */
  maxLength?: number;
  /** text only: JSON schema the answer must parse into. Presence means the answer is JSON. */
  schema?: unknown;
  /**
   * Structured facts behind the premise and state (the field being decided, the
   * samples, the page), for backends that read JSON better than prose (Jev).
   * Never contains a secret. Text backends keep reading `premise` and `state`.
   */
  context?: QuestionContext | undefined;
  /** choice only: structured facts per option, in option order, same length as `options`. */
  optionContext?: readonly JsonValue[] | undefined;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type QuestionContext = { [key: string]: JsonValue };

export interface Answer {
  id: string;
  /** choice: option index or null for none. boolean: 1 true, 0 false. score: level index. text: null. */
  index: number | null;
  /** boolean: P(true). */
  probability?: number;
  /** choice and score: distribution over the offered options or levels. */
  probabilities?: number[];
  /** text questions only. */
  text?: string;
}

export type ZeroDataRetentionState = "confirmed" | "unknown" | "not_applicable";

export interface ChooserUsage {
  chooser: ChooserName;
  questions: number;
  textQuestions: number;
  batches: number;
  inputTokens: number;
  outputTokens: number;
  /** Wall time spent waiting on the chooser, retries included. */
  waitMs: number;
  /** Cost at list price in USD; 0 on a subscription. */
  costUsd: number;
  zeroDataRetention: ZeroDataRetentionState;
  /** Who pays: metered API calls (the default) or an installed CLI on the user's subscription. */
  billing?: "api" | "subscription";
  /** What the CLI itself reported (Claude Code's `total_cost_usd`); informational on a subscription. */
  reportedCostUsd?: number;
  /**
   * U14: the writer's share of the totals above, when a second source answered
   * the free-text questions. Absent when one source answered everything, so
   * the run's cost is attributable per role: these numbers minus this object
   * is what the decider itself spent.
   */
  writer?: WriterUsage;
  /**
   * U7 / KTD6: the decider's transport failed and the run moved to another for
   * the rest of the run (Jev: AI Gateway to the TypeSafe API). Absent when the
   * run stayed on the transport it started on.
   */
  transportFallback?: TransportFallback;
}

/** U7: which route the decider left, which it took, and the failure that made it switch (sanitized). */
export interface TransportFallback {
  from: string;
  to: string;
  reason: string;
}

/** U14: the part of a `ChooserUsage` a delegated writer is responsible for. */
export interface WriterUsage {
  chooser: ChooserName;
  questions: number;
  textQuestions: number;
  batches: number;
  inputTokens: number;
  outputTokens: number;
  waitMs: number;
  costUsd: number;
}

export interface Chooser {
  readonly name: ChooserName;
  ask(batch: Question[]): Promise<Answer[]>;
  usage(): ChooserUsage;
}

/** KTD11: text-question input cap in characters (premise plus state). */
export const TEXT_INPUT_CAP = 2_000;
export const DEFAULT_TEXT_MAX_LENGTH = 2_000;
/** Default state cap for language-model backends in characters. */
export const DEFAULT_STATE_CHARS = 150_000;
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * What separates a code-enumerated option's *identity* from the page content it
 * quotes: `main/h1.name = Paracetamol 500 mg | Ibuprofeno 400 mg`.
 *
 * The identity is the candidate the chooser is picking; the tail is whatever
 * the sampled pages happened to show on the run that built the question. A
 * recorded answer is therefore compared on the identity (see
 * `src/chooser/recorded.ts`): the same recorded fixture is replayed by callers
 * that sample different pages of the same site, and the index answers the
 * candidate, not the sample.
 */
export const OPTION_VALUE_SEPARATOR = " = ";

/** The part of an option that names the candidate rather than the values it sampled. */
export function optionIdentity(option: string): string {
  const at = option.indexOf(OPTION_VALUE_SEPARATOR);
  return at < 0 ? option : option.slice(0, at);
}

export function questionChars(q: Question): number {
  return q.state.length + q.premise.length + (q.options ?? []).reduce((n, o) => n + o.length, 0);
}

/** Programmer or configuration errors: missing keys, malformed questions. */
export class ConfigurationError extends NavviError {
  constructor(message: string) {
    super("configuration_error", message);
  }
}

/**
 * A state larger than the backend accepts; refused before any network call.
 *
 * A `configuration_error` like its siblings, and for the same reason: navvi
 * built a question the backend will not take. No retry of any kind changes it,
 * and nothing about it is a fact about the site. It extended plain `Error`
 * until 2026-09-23, which meant every `instanceof NavviError` test in the
 * codebase silently missed it -- including the one in the crawler's healer,
 * where it was swallowed to a null field and reported as a successful run.
 */
export class StateTooLargeError extends NavviError {
  readonly chars: number;
  readonly maxChars: number;
  constructor(questionId: string, chars: number, maxChars: number) {
    super("configuration_error", `question "${questionId}" state is ${chars} characters, over the ${maxChars} character cap`);
    this.name = "StateTooLargeError";
    this.chars = chars;
    this.maxChars = maxChars;
  }
}

/** An answer outside the offered indices, after the one retry. */
export class InvalidAnswerError extends Error {
  readonly problems: InvalidAnswer[];
  constructor(problems: InvalidAnswer[]) {
    super(`invalid chooser answers: ${problems.map((p) => `${p.id}: ${p.reason}`).join("; ")}`);
    this.name = "InvalidAnswerError";
    this.problems = problems;
  }
}

export interface InvalidAnswer {
  id: string;
  reason: string;
}

export interface ValidationResult {
  /** Valid answers in batch order. */
  valid: Answer[];
  invalid: InvalidAnswer[];
}

function isIndex(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < max;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readProbabilities(raw: Record<string, unknown>, length: number): number[] | undefined {
  const p = raw.probabilities;
  if (!Array.isArray(p) || p.length !== length || !p.every(isProbability)) return undefined;
  return p;
}

/** Validate one raw answer batch against the questions that were asked. */
export function validateAnswers(batch: Question[], raw: unknown): ValidationResult {
  const invalid: InvalidAnswer[] = [];
  const byId = new Map<string, Answer>();
  const questions = new Map(batch.map((q) => [q.id, q]));
  if (!Array.isArray(raw)) {
    return { valid: [], invalid: batch.map((q) => ({ id: q.id, reason: "answers is not an array" })) };
  }
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string") {
      invalid.push({ id: "?", reason: "answer without a string id" });
      continue;
    }
    const q = questions.get(item.id);
    if (!q) {
      invalid.push({ id: item.id, reason: "not an asked question" });
      continue;
    }
    if (byId.has(q.id)) {
      invalid.push({ id: q.id, reason: "answered twice" });
      continue;
    }
    const problem = validateOne(q, item);
    if (typeof problem === "string") invalid.push({ id: q.id, reason: problem });
    else byId.set(q.id, problem);
  }
  const invalidIds = new Set(invalid.map((i) => i.id));
  return { valid: batch.filter((q) => byId.has(q.id) && !invalidIds.has(q.id)).map((q) => byId.get(q.id)!), invalid };
}

function validateOne(q: Question, raw: Record<string, unknown>): Answer | string {
  const options = q.options ?? [];
  switch (q.kind) {
    case "choice": {
      if (typeof raw.text === "string") return "free text on a choice question";
      if (raw.index !== null && !isIndex(raw.index, options.length)) {
        return `index ${String(raw.index)} outside 0..${options.length - 1} or null`;
      }
      const answer: Answer = { id: q.id, index: raw.index };
      const probabilities = readProbabilities(raw, options.length) ?? readProbabilities(raw, options.length + 1);
      if (probabilities) answer.probabilities = probabilities;
      return answer;
    }
    case "boolean": {
      if (!isIndex(raw.index, 2)) return `boolean index ${String(raw.index)} is not 0 or 1`;
      const answer: Answer = { id: q.id, index: raw.index };
      if (isProbability(raw.probability)) answer.probability = raw.probability;
      return answer;
    }
    case "score": {
      if (!isIndex(raw.index, options.length)) return `score index ${String(raw.index)} outside 0..${options.length - 1}`;
      const answer: Answer = { id: q.id, index: raw.index };
      const probabilities = readProbabilities(raw, options.length);
      if (probabilities) answer.probabilities = probabilities;
      return answer;
    }
    case "text": {
      // A JSON answer given as an object rather than a JSON string is the same answer.
      if (q.schema !== undefined && isRecord(raw.text)) raw = { ...raw, text: JSON.stringify(raw.text) };
      if (typeof raw.text !== "string") return "text answer is not a string";
      const max = q.maxLength ?? DEFAULT_TEXT_MAX_LENGTH;
      if (raw.text.length > max) return `text answer is ${raw.text.length} characters, over ${max}`;
      if (raw.index !== null && raw.index !== undefined) return "text answer carries an index";
      if (q.schema !== undefined) {
        try {
          if (!isRecord(JSON.parse(raw.text))) return "text answer is not a JSON object";
        } catch {
          return "text answer is not valid JSON";
        }
      }
      return { id: q.id, index: null, text: raw.text };
    }
  }
}

const REDACTION_PATTERNS: RegExp[] = [
  /authorization\s*[:=]\s*(bearer\s+)?[^\s,;"']+/gi,
  /bearer\s+[^\s,;"']+/gi,
  /x-api-key\s*[:=]\s*[^\s,;"']+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bvck_[A-Za-z0-9_-]{4,}/g,
];

const REDACTED = "[redacted]";

/** Secret values first (API keys, the state), then anything shaped like a credential. */
function redact(text: string, secrets: readonly string[]): string {
  let out = maskSecrets(text, secrets.map((value, i) => [String(i), value] as const), () => REDACTED);
  for (const pattern of REDACTION_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * R27 / U2.7: a copy of `err` safe to log. No headers, no request body, no
 * state, no secret; the status code and message survive.
 */
export function sanitizeError(err: unknown, secrets: readonly string[] = []): Error & { statusCode?: number } {
  const source = err instanceof Error ? err : new Error(String(err));
  const clean: Error & { statusCode?: number } = new Error(redact(source.message, secrets));
  clean.name = source.name;
  if (source.stack) clean.stack = redact(source.stack, secrets);
  const status = (source as { statusCode?: unknown }).statusCode;
  if (typeof status === "number") clean.statusCode = status;
  return clean;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function isRetryableError(err: unknown): boolean {
  if (APICallError.isInstance(err)) return err.isRetryable;
  if (!isRecord(err)) return false;
  if (typeof err.isRetryable === "boolean") return err.isRetryable;
  if (typeof err.statusCode === "number") return RETRYABLE_STATUS.has(err.statusCode);
  return err.name === "AbortError" || err.name === "TimeoutError";
}

export interface BackendResult {
  /** One raw answer per question; validated by the base class. */
  answers: unknown;
  inputTokens?: number;
  /**
   * U7: the input charged to the run's token budget, when it differs from the
   * input the backend reports. A coding CLI reports its own cached system
   * prompt too; that rides on the subscription, and the budget caps what navvi
   * sends. Unset charges `inputTokens`.
   */
  budgetInputTokens?: number;
  outputTokens?: number;
  zeroDataRetention?: ZeroDataRetentionState;
}

export interface Price {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface BaseChooserOptions {
  budget?: Budget;
  /** Delays between transport retries; the last value repeats. */
  backoffMs?: number[];
  /** Transport attempts before `model_unavailable`. */
  maxAttempts?: number;
  /** State cap in characters for non-text questions. */
  maxStateChars?: number;
  /** Answers `text` questions when the backend cannot (Jev). */
  textFallback?: Chooser;
  /** Strings redacted from every error message (API keys). */
  secrets?: string[];
}

const DEFAULT_BACKOFF_MS = [500, 2_000];
// Usage snapshots must not overlap for callers delegating to the same chooser.
const FALLBACK_QUEUES = new WeakMap<Chooser, Promise<void>>();
const USAGE_COUNTERS = ["questions", "textQuestions", "batches", "inputTokens", "outputTokens", "waitMs"] as const;

function combineRetention(a: ZeroDataRetentionState | undefined, b: ZeroDataRetentionState): ZeroDataRetentionState {
  return a === undefined || a === b ? b : "unknown";
}

/**
 * Shared behaviour of every backend: question checks, budget, one validation
 * retry, transport retries with backoff, usage accounting, error sanitizing.
 */
export abstract class BaseChooser implements Chooser {
  abstract readonly name: ChooserName;
  protected abstract readonly failureStatus: "model_unavailable" | "needs_human";
  protected abstract readonly price: Price;
  protected abstract callBackend(batch: Question[]): Promise<BackendResult>;
  protected zeroDataRetentionDefault: ZeroDataRetentionState = "not_applicable";

  protected readonly budget: Budget;
  protected readonly backoffMs: number[];
  protected readonly maxAttempts: number;
  protected readonly maxStateChars: number;
  protected readonly textFallback: Chooser | undefined;
  protected secrets: string[];

  private counters = { questions: 0, textQuestions: 0, batches: 0, inputTokens: 0, outputTokens: 0, waitMs: 0 };
  private observedZeroDataRetention: ZeroDataRetentionState | undefined;
  private delegated = { questions: 0, textQuestions: 0, batches: 0, inputTokens: 0, outputTokens: 0, waitMs: 0, costUsd: 0 };
  private delegatedZeroDataRetention: ZeroDataRetentionState | undefined;
  /** U14: the writer that actually answered, set the first time text work is delegated. */
  private writerName: ChooserName | undefined;

  /** U14: what a delegated writer cost, for backends whose own tokens are free. */
  protected get delegatedCostUsd(): number {
    return this.delegated.costUsd;
  }

  constructor(options: BaseChooserOptions = {}) {
    this.budget = options.budget ?? new Budget();
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.maxStateChars = options.maxStateChars ?? DEFAULT_STATE_CHARS;
    this.textFallback = options.textFallback;
    this.secrets = options.secrets ?? [];
  }

  usage(): ChooserUsage {
    const { inputTokens, outputTokens } = this.counters;
    const totals = { ...this.counters };
    for (const key of USAGE_COUNTERS) totals[key] += this.delegated[key];
    const ownRetention = this.observedZeroDataRetention ?? this.zeroDataRetentionDefault;
    const hasOwnUsage = USAGE_COUNTERS.some((key) => this.counters[key] > 0);
    const zeroDataRetention = this.delegatedZeroDataRetention === undefined ? ownRetention
      : combineRetention(hasOwnUsage ? ownRetention : undefined, this.delegatedZeroDataRetention);
    const usage: ChooserUsage = {
      chooser: this.name,
      ...totals,
      costUsd: (inputTokens * this.price.inputPerMillion + outputTokens * this.price.outputPerMillion) / 1_000_000 + this.delegated.costUsd,
      zeroDataRetention,
    };
    // U14: name the second source only once it has answered something.
    if (this.writerName !== undefined) usage.writer = { chooser: this.writerName, ...this.delegated };
    return usage;
  }

  private async askTextFallback(text: Question[]): Promise<Answer[]> {
    const fallback = this.textFallback!;
    const previous = FALLBACK_QUEUES.get(fallback);
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    FALLBACK_QUEUES.set(fallback, turn);
    await previous;
    try {
      return await this.accountTextFallback(fallback, text);
    } finally {
      release();
      if (FALLBACK_QUEUES.get(fallback) === turn) FALLBACK_QUEUES.delete(fallback);
    }
  }

  private async accountTextFallback(fallback: Chooser, text: Question[]): Promise<Answer[]> {
    const before = fallback.usage();
    try {
      return await fallback.ask(text);
    } finally {
      // The fallback already charges its budget and prices its own tokens. Only
      // include work delegated by this chooser, even if the call failed.
      const after = fallback.usage();
      let used = false;
      for (const key of USAGE_COUNTERS) {
        const delta = after[key] - before[key];
        this.delegated[key] += delta;
        used ||= delta > 0;
      }
      this.delegated.costUsd += after.costUsd - before.costUsd;
      if (used) {
        this.delegatedZeroDataRetention = combineRetention(this.delegatedZeroDataRetention, after.zeroDataRetention);
        // A chain reports the member currently answering, which is the one that just did.
        this.writerName = after.chooser;
      }
    }
  }

  async ask(batch: Question[]): Promise<Answer[]> {
    if (batch.length === 0) return [];
    this.checkQuestions(batch);
    const byId = new Map<string, Answer>();
    const text = batch.filter((q) => q.kind === "text");
    const own = this.textFallback && text.length > 0 ? batch.filter((q) => q.kind !== "text") : batch;
    if (own.length < batch.length) {
      for (const a of await this.askTextFallback(text)) byId.set(a.id, a);
    }
    for (const group of groupByState(own)) {
      for (const a of await this.askGroup(group)) byId.set(a.id, a);
    }
    return batch.map((q) => byId.get(q.id)!);
  }

  private checkQuestions(batch: Question[]): void {
    const seen = new Set<string>();
    for (const q of batch) {
      if (!q.id || seen.has(q.id)) throw new ConfigurationError(`duplicate or empty question id "${q.id}"`);
      seen.add(q.id);
      if (q.kind === "choice" && (q.options?.length ?? 0) < 1) throw new ConfigurationError(`choice question "${q.id}" offers no options`);
      if (q.kind === "score" && (q.options?.length ?? 0) < 2) throw new ConfigurationError(`score question "${q.id}" needs at least two levels`);
      if (q.kind === "text") {
        const chars = q.state.length + q.premise.length;
        if (chars > TEXT_INPUT_CAP) throw new StateTooLargeError(q.id, chars, TEXT_INPUT_CAP);
      } else if (q.state.length > this.maxStateChars) {
        throw new StateTooLargeError(q.id, q.state.length, this.maxStateChars);
      }
    }
  }

  private async askGroup(group: Question[]): Promise<Answer[]> {
    for (const q of group) if (q.kind === "text") this.budget.chargeTextCall();
    const estimate = group.reduce((n, q) => n + estimateTokens(q.premise + q.state + (q.options ?? []).join("")), 0);
    this.budget.assertInputTokens(estimate);

    const answered = new Map<string, Answer>();
    let pending = group;
    let problems: InvalidAnswer[] = [];
    for (let validationAttempt = 0; validationAttempt < 2; validationAttempt++) {
      const result = await this.callWithRetry(pending);
      this.account(result, estimate);
      const { valid, invalid } = validateAnswers(pending, result.answers);
      for (const a of valid) answered.set(a.id, a);
      pending = pending.filter((q) => !answered.has(q.id));
      problems = [...invalid, ...pending.filter((q) => !invalid.some((i) => i.id === q.id)).map((q) => ({ id: q.id, reason: "no answer" }))];
      if (pending.length === 0) {
        this.counters.questions += group.length;
        this.counters.textQuestions += group.filter((q) => q.kind === "text").length;
        return group.map((q) => answered.get(q.id)!);
      }
    }
    throw this.fail(`${this.name} chooser answered outside the offered indices twice`, new InvalidAnswerError(problems));
  }

  private account(result: BackendResult, estimate: number): void {
    const input = result.inputTokens ?? estimate;
    this.budget.chargeInputTokens(result.budgetInputTokens ?? input);
    this.counters.batches += 1;
    this.counters.inputTokens += input;
    this.counters.outputTokens += result.outputTokens ?? 0;
    if (result.zeroDataRetention) this.observedZeroDataRetention = combineRetention(this.observedZeroDataRetention, result.zeroDataRetention);
  }

  private async callWithRetry(batch: Question[]): Promise<BackendResult> {
    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      try {
        return await this.callBackend(batch);
      } catch (err) {
        if (err instanceof NavviError) throw err;
        const clean = sanitizeError(err, this.secrets);
        if (attempt >= this.maxAttempts || !isRetryableError(err)) {
          // U7 / KTD6: retries on one route are spent; a backend with a second route takes it once and starts counting again.
          if (isRetryableError(err) && this.fallBack(clean, attempt)) {
            attempt = 0;
            continue;
          }
          throw new ModelUnavailableError(`${this.name} chooser failed after ${attempt} attempt(s): ${clean.message}`, { cause: clean, attempts: attempt });
        }
        await sleep(this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)] ?? 0);
      } finally {
        this.counters.waitMs += performance.now() - started;
      }
    }
  }

  /**
   * U7 / KTD6: called once retries on the current transport are exhausted by a
   * retryable failure. A backend that can reach the same model another way
   * switches and returns true, and the batch is retried there from the first
   * attempt; the default has no other way and returns false.
   */
  protected fallBack(_error: Error, _attempts: number): boolean {
    return false;
  }

  protected fail(message: string, cause: Error): NavviError {
    return this.failureStatus === "needs_human"
      ? new NeedsHumanError(`${message}: ${cause.message}`, { cause })
      : new ModelUnavailableError(`${message}: ${cause.message}`, { cause, attempts: 2 });
  }
}

function groupByState(batch: Question[]): Question[][] {
  const groups = new Map<string, Question[]>();
  for (const q of batch) {
    const group = groups.get(q.state);
    if (group) group.push(q);
    else groups.set(q.state, [q]);
  }
  return [...groups.values()];
}
