import { defaultChooser, hasChooserKey, type AvailableClis, type Chooser as ChooserId, type Decider, type Transport, type Writer } from "../input/schema.js";
import { Budget } from "../billing/budget.js";
import { AgentChooser, type AgentChooserOptions } from "./agent.js";
import { CliChooser, CliUnavailableError, HARNESS_LABEL, SIGN_IN_COMMAND, findOnPath, probeCli, type CliChooserOptions, type CliHarness, type CliProbe } from "./cli.js";
import { JevChooser, type JevChooserOptions } from "./jev.js";
import { ModelChooser, type ModelChooserOptions } from "./model.js";
import type { Answer, Chooser, ChooserUsage, Question, ZeroDataRetentionState } from "./chooser.js";

export * from "./chooser.js";
export * from "./questions.js";
export { AgentChooser, ANSWER_WITH, loadAnswersFile, mergeAnswers, questionKey, readQuestionsFile, QUESTIONS_START, QUESTIONS_END, PROTOCOL, type AgentChooserOptions, type AgentMode, type QuestionBatchFile, type StoredAnswer } from "./agent.js";
export { CliChooser, CliUnavailableError, CLI_TIMEOUT_MS, DEFAULT_CLAUDE_MODEL, HARNESS_LABEL, SIGN_IN_COMMAND, extractJsonObject, findOnPath, probeCli, processRunner, readClaudeEnvelope, readCodexEvents, renderPrompt, resetProbeCache, type CliChooserOptions, type CliHarness, type CliProbe, type CliRunner, type CliRunResult } from "./cli.js";
export { JevChooser, TypeSafeEvaluationModel, JEV_PRICE_PER_MILLION_INPUT_USD, JEV_MAX_STATE_TOKENS, JEV_GATEWAY_MODEL_ID, missingCredentialsMessage, noWriterMessage, type JevChooserOptions, type JevProvider } from "./jev.js";
export { ModelChooser, MODEL_PRICES, DEFAULT_MODEL_ID, DEFAULT_MODEL_STATE_CHARS, priceFor, type ModelChooserOptions } from "./model.js";
export { RecordedChooser, RecordingChooser, DEFAULT_RECORDED_DIR, type RecordedChooserOptions, type RecordingChooserOptions, type RecordedAnswerFile } from "./recorded.js";
export { Budget, BudgetExhaustedError, ModelUnavailableError, NeedsHumanError, NavviError } from "../billing/budget.js";

export interface CreateChooserOptions {
  /**
   * R37 / U14 compatibility: the single-source field. It names the decider and
   * nothing else; `decider` wins when both are given. Defaults to
   * `defaultChooser(env)` (KTD17: agent without a key or a signed-in CLI).
   */
  chooser?: ChooserId;
  /** U14: who answers the structured questions (choice, boolean, score). */
  decider?: Decider;
  /**
   * U14: who answers the free-text questions. Unset derives today's behaviour:
   * the decider writes its own text, unless it is Jev, which cannot, and then
   * the ordered chain below answers (subscription CLIs before a metered model).
   */
  writer?: Writer;
  /** U14: which API the decider is reached over; Jev's `gateway` or `typesafe` today. */
  deciderTransport?: Transport;
  env?: NodeJS.ProcessEnv;
  budget?: Budget;
  /** Caller key for jev or model (R23). */
  apiKey?: string;
  agent?: Omit<AgentChooserOptions, "budget" | "env">;
  jev?: Omit<JevChooserOptions, "budget" | "env" | "apiKey">;
  model?: Omit<ModelChooserOptions, "budget" | "env" | "apiKey">;
  /** Options shared by the claude and codex choosers (runner, timeout, model). */
  cli?: Omit<CliChooserOptions, "budget" | "env">;
}

/**
 * One factory for the run: the decider, the writer it hands text to, and one
 * shared budget. The returned chooser is still the run's single `Chooser`; a
 * configured writer rides inside it as the decider's `textFallback`, so every
 * caller (and every usage total) keeps working unchanged.
 */
export function createChooser(options: CreateChooserOptions = {}): Chooser {
  const env = options.env ?? process.env;
  const budget = options.budget ?? new Budget();
  const name = options.decider ?? options.chooser ?? defaultChooser(env);
  const writer = writerFor(options, env, budget, name);
  switch (name) {
    case "agent":
      return new AgentChooser({ ...options.agent, budget, env, ...(writer ? { textFallback: writer } : {}) });
    case "jev": {
      // Jev cannot write: text questions (a typed search query) go to the configured writer, else to an installed CLI on the user's subscription, and only then to a metered model key.
      const provider = options.deciderTransport ?? options.jev?.provider;
      return new JevChooser({ ...options.jev, ...(provider ? { provider } : {}), apiKey: options.apiKey, budget, env, textFallback: writer });
    }
    case "model":
      return new ModelChooser({ ...options.model, apiKey: options.apiKey, budget, env, ...(writer ? { textFallback: writer } : {}) });
    case "claude":
    case "codex":
      return new CliChooser(name, { ...options.cli, budget, env, ...(writer ? { textFallback: writer } : {}) });
  }
}

/**
 * U14: the writer, as a chooser the decider delegates `text` questions to.
 *
 * An explicit `writer` wins, and naming the decider itself means "no second
 * source" — the decider answers its own text, as it always has. Unset is the
 * old derivation: every backend but Jev writes for itself, and Jev gets the
 * ordered chain below. `options.jev.textFallback` stays an escape hatch for
 * callers that build the writer themselves (tests, `tools/measure`).
 */
function writerFor(options: CreateChooserOptions, env: NodeJS.ProcessEnv, budget: Budget, decider: Decider): Chooser | undefined {
  if (options.writer) return options.writer === decider ? undefined : buildWriter(options.writer, options, env, budget);
  if (options.jev?.textFallback && decider === "jev") return options.jev.textFallback;
  return decider === "jev" ? textFallbackFor(options, env, budget) : undefined;
}

function buildWriter(name: Writer, options: CreateChooserOptions, env: NodeJS.ProcessEnv, budget: Budget): Chooser {
  switch (name) {
    case "agent":
      return new AgentChooser({ ...options.agent, budget, env });
    case "model":
      return new ModelChooser({ ...options.model, budget, env });
    case "claude":
    case "codex":
      return new CliChooser(name, { ...options.cli, budget, env });
  }
}

interface TextFallbackCandidate {
  name: ChooserId;
  build: () => Chooser;
}

/**
 * SEAM — a locally-run open-source model, designed and not implemented.
 *
 * Both roles are already reduced to one interface: a `Chooser` with `name`,
 * `ask(batch)` and `usage()`. A local backend is therefore one more `case` in
 * `buildWriter` and in `createChooser`'s switch, plus one constructor. Its
 * configuration is two values, the pair every local runtime (llama.cpp,
 * Ollama, vLLM, LM Studio) exposes:
 *
 *   - an OpenAI-compatible **base URL** (`http://127.0.0.1:11434/v1`), and
 *   - a **model id** (`qwen3:8b`).
 *
 * As a writer it is an `@ai-sdk/openai-compatible` provider behind
 * `ModelChooser` (same JSON-schema-of-indices prompt, `costUsd` 0, billing
 * neither `api` nor `subscription`). As a decider it needs the local model to
 * answer the same structured shape: either an evaluation model like
 * `TypeSafeEvaluationModel` in `jev.ts` pointed at the local URL, or the
 * `ModelChooser` path, in which case `deciderTransport: "local"` is the third
 * transport and `LIMITS.chooserInputTokens` is the only budget that still
 * applies. Nothing accepts a `local` value yet — deliberately, so no input can
 * select a backend that would throw at run time.
 */

/**
 * U7: who `textFallbackFor` would ask first, without building anything — for
 * the announcement. Same order, same PATH check; undefined when nobody can write.
 */
export function derivedWriter(env: NodeJS.ProcessEnv = process.env): Writer | undefined {
  for (const harness of HARNESS_ORDER) if (findOnPath(harness, env)) return harness;
  if (env.ANTHROPIC_API_KEY || env.AI_GATEWAY_API_KEY) return "model";
  return undefined;
}

/**
 * Who writes the text Jev cannot (R23 / KTD11), when no `writer` was
 * configured — the derived writer. Subscription before metering:
 * an installed Claude Code or Codex answers on the user's plan at no cost,
 * while every API path bills per token — `AI_GATEWAY_API_KEY` is free for
 * Jev's structured questions but metered for a text model, so it must not
 * quietly capture text work a signed-in CLI would do. Among the metered
 * options a dedicated `ANTHROPIC_API_KEY` wins over the Gateway; that order
 * lives in `resolveModel`, so one `model` candidate covers both.
 *
 * `findOnPath` proves the binary exists, not that it is signed in (that is an
 * async probe, and `createChooser` is synchronous). A signed-out CLI raises
 * `CliUnavailableError` on its first batch and the chain moves on rather than
 * ending the run.
 */
function textFallbackFor(options: CreateChooserOptions, env: NodeJS.ProcessEnv, budget: Budget): Chooser | undefined {
  const candidates: TextFallbackCandidate[] = [];
  for (const harness of HARNESS_ORDER) {
    if (findOnPath(harness, env)) candidates.push({ name: harness, build: () => new CliChooser(harness, { ...options.cli, budget, env }) });
  }
  if (env.ANTHROPIC_API_KEY || env.AI_GATEWAY_API_KEY) candidates.push({ name: "model", build: () => new ModelChooser({ ...options.model, budget, env }) });
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0]!.build();
  return new TextFallbackChain(candidates);
}

/**
 * The text fallbacks in preference order, built one at a time. The first
 * candidate answers every batch until it reports itself unusable
 * (`CliUnavailableError`: not installed, or installed but not signed in), at
 * which point the next takes over for the rest of the run. Any other failure
 * is the answer: a signed-in CLI that times out or refuses is not a reason to
 * start spending on an API.
 */
export class TextFallbackChain implements Chooser {
  private readonly candidates: TextFallbackCandidate[];
  private readonly built: (Chooser | undefined)[];
  private index = 0;

  constructor(candidates: TextFallbackCandidate[]) {
    this.candidates = candidates;
    this.built = candidates.map(() => undefined);
  }

  /** The candidate currently answering. */
  get name(): ChooserId {
    return this.candidates[this.index]!.name;
  }

  async ask(batch: Question[]): Promise<Answer[]> {
    for (;;) {
      try {
        return await this.member().ask(batch);
      } catch (err) {
        if (!(err instanceof CliUnavailableError) || this.index + 1 >= this.candidates.length) throw err;
        this.index += 1;
      }
    }
  }

  /** Every candidate that has run, so the totals never go backwards when the chain moves on. */
  usage(): ChooserUsage {
    const used = this.built.filter((c): c is Chooser => c !== undefined).map((c) => c.usage());
    const total: ChooserUsage = { chooser: this.name, questions: 0, textQuestions: 0, batches: 0, inputTokens: 0, outputTokens: 0, waitMs: 0, costUsd: 0, zeroDataRetention: "not_applicable" };
    let retention: ZeroDataRetentionState | undefined;
    let reported: number | undefined;
    for (const one of used) {
      total.questions += one.questions;
      total.textQuestions += one.textQuestions;
      total.batches += one.batches;
      total.inputTokens += one.inputTokens;
      total.outputTokens += one.outputTokens;
      total.waitMs += one.waitMs;
      total.costUsd += one.costUsd;
      retention = retention === undefined || retention === one.zeroDataRetention ? one.zeroDataRetention : "unknown";
      if (one.reportedCostUsd !== undefined) reported = (reported ?? 0) + one.reportedCostUsd;
    }
    if (retention !== undefined) total.zeroDataRetention = retention;
    const billing = this.built[this.index]?.usage().billing;
    if (billing !== undefined) total.billing = billing;
    if (reported !== undefined) total.reportedCostUsd = reported;
    return total;
  }

  private member(): Chooser {
    const existing = this.built[this.index];
    if (existing) return existing;
    const made = this.candidates[this.index]!.build();
    this.built[this.index] = made;
    return made;
  }
}

export interface ResolvedChooser {
  name: ChooserId;
  /** One line for stderr: why this chooser. */
  reason: string;
  probes: Partial<Record<CliHarness, CliProbe>>;
}

const HARNESS_ORDER: CliHarness[] = ["claude", "codex"];

/**
 * U7: why Jev, what it is good for, and who takes the text it cannot write —
 * the whole arrangement in one line, so nothing about who answers is hidden.
 */
function jevReason(env: NodeJS.ProcessEnv, writer: Writer | undefined): string {
  const key = env.AI_GATEWAY_API_KEY ? "AI_GATEWAY_API_KEY" : "TYPESAFE_API_KEY";
  const fallback = env.AI_GATEWAY_API_KEY && env.TYPESAFE_API_KEY ? ", TypeSafe API as fallback" : "";
  const text = writer ?? derivedWriter(env);
  const writes = text
    ? `text questions go to ${text === "model" ? `model (${env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "AI_GATEWAY_API_KEY"}, metered)` : text}`
    : "no text writer: sign in to `claude` or `codex`, or set ANTHROPIC_API_KEY, if a text question comes up";
  return `${key} found — fast typed decisions${fallback}; ${writes}`;
}

/**
 * The default chooser with its reason. Keys decide without probing; without
 * a key each CLI is probed in order (Claude Code first) and the first one
 * signed in wins. An installed but signed-out CLI never wins; its sign-in
 * command is part of the reason when the run falls through to the agent.
 * `writer` is an explicit `--writer`, named in Jev's reason instead of the
 * derived one.
 */
export async function resolveDefaultChooser(
  env: NodeJS.ProcessEnv = process.env,
  probe: (harness: CliHarness) => Promise<CliProbe> = (h) => probeCli(h, { env }),
  options: { writer?: Writer } = {},
): Promise<ResolvedChooser> {
  if (hasChooserKey(env)) {
    const name = defaultChooser(env);
    if (name === "jev") return { name, reason: jevReason(env, options.writer), probes: {} };
    return { name, reason: "ANTHROPIC_API_KEY is set", probes: {} };
  }
  const probes: Partial<Record<CliHarness, CliProbe>> = {};
  const available: AvailableClis = {};
  const notes: string[] = [];
  for (const harness of HARNESS_ORDER) {
    const result = await probe(harness);
    probes[harness] = result;
    if (result.installed && result.signedIn === true) {
      available[harness] = true;
      break;
    }
    if (result.installed) notes.push(`${HARNESS_LABEL[harness]} is installed but not signed in (run \`${SIGN_IN_COMMAND[harness]}\`)`);
  }
  const name = defaultChooser(env, available);
  if (name === "claude" || name === "codex") {
    return { name, reason: `${HARNESS_LABEL[name]} is installed and signed in; using your subscription`, probes };
  }
  const why = notes.length > 0 ? notes.join("; ") : "no API key and no signed-in Claude Code or Codex";
  return { name, reason: `${why}; you answer the questions`, probes };
}
