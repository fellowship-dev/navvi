import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { ModelUnavailableError } from "../billing/budget.js";
import { isRecord } from "../util/text.js";
import { ANSWER_WITH } from "./agent.js";
import { BaseChooser, ConfigurationError, DEFAULT_STATE_CHARS, estimateTokens, type BackendResult, type BaseChooserOptions, type ChooserName, type ChooserUsage, type Price, type Question } from "./chooser.js";
import { SYSTEM_PROMPT, renderQuestions } from "./model.js";

/**
 * KTD2 through an installed coding CLI: Claude Code (`claude -p`) or Codex
 * (`codex exec`) answers the batch on the user's subscription, no API key.
 * The batch is rendered like the model chooser's prompt, the reply is the
 * agent chooser's `answers` JSON, validated by the base class like any other
 * backend. Cost is 0 (subscription); Claude's reported figure is kept in
 * `reportedCostUsd` for the record.
 */

export type CliHarness = "claude" | "codex";

export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawns `cmd args`, optionally writing `input` to stdin; resolves on exit whatever the code. */
export type CliRunner = (cmd: string, args: string[], input?: string) => Promise<CliRunResult>;

export interface CliChooserOptions extends BaseChooserOptions {
  /** Model flag for the harness; `NAVVI_CLAUDE_MODEL` (default haiku) or `NAVVI_CODEX_MODEL` (default unset) when absent. */
  model?: string;
  /** Executable name or path; defaults to the harness name resolved on PATH. */
  command?: string;
  runner?: CliRunner;
  /** Per choice batch; a slower harness ends the run `model_unavailable`. */
  timeoutMs?: number;
  /** Per batch that asks for text: a spec draft is one long answer, not a pick. */
  textTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export const CLI_TIMEOUT_MS = 60_000;
/**
 * A text batch writes; a choice batch picks. Found live, 2026-09-23: make's spec
 * draft took Claude Code ~30 s on a quiet machine and ran past 60 s on a busy one,
 * so the run stopped at its first stage over a reply that was on its way.
 */
export const CLI_TEXT_TIMEOUT_MS = 180_000;
export const PROBE_TIMEOUT_MS = 20_000;
export const DEFAULT_CLAUDE_MODEL = "haiku";
/** Above this the prompt goes on stdin: Linux caps one argv string at 128 KiB. */
export const MAX_ARGV_PROMPT_CHARS = 64_000;
const PROBE_PROMPT = "reply with the word ok";

export const HARNESS_LABEL: Record<CliHarness, string> = { claude: "Claude Code", codex: "Codex" };
export const SIGN_IN_COMMAND: Record<CliHarness, string> = { claude: "claude", codex: "codex login" };

// ---------------------------------------------------------------- process runner

class CliTimeoutError extends Error {
  constructor(ms: number) {
    super(`no reply within ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * The environment the harness runs in.
 *
 * Claude Code without extended thinking. Measured 2026-09-24 on 19 captured
 * navigation questions: thinking off answered 19/19 exactly like thinking on,
 * in 32 s instead of 99.5 s, and the prompt-parse text question fell from ~22 s
 * to ~4.5 s — Haiku was spending two to three thousand output tokens thinking
 * about which of five options to pick. A user who set MAX_THINKING_TOKENS, or
 * NAVVI_CLAUDE_THINKING=1, gets what they asked for.
 */
export function harnessEnv(harness: CliHarness, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (harness !== "claude" || env.MAX_THINKING_TOKENS !== undefined || env.NAVVI_CLAUDE_THINKING) return env;
  return { ...env, MAX_THINKING_TOKENS: "0" };
}

/** The default runner: a child process with a kill-on-timeout, stdin closed unless `input` is given (codex reads a piped stdin). */
/**
 * Where the harness runs: a neutral directory, never the user's project.
 *
 * Found by the Hacker News recording, 2026-09-24: started inside a repository,
 * Claude Code loads that project's CLAUDE.md and hooks with the question, and
 * answered 2 of 6 prompt questions with "I need clarification…" instead of the
 * JSON asked for; the same questions from a neutral directory, 6 of 6. navvi
 * sends the harness everything it needs; the project around the user's shell
 * is not part of the question.
 */
export function harnessCwd(): string {
  return tmpdir();
}

export function processRunner(timeoutMs: number, env: NodeJS.ProcessEnv = process.env, cwd?: string): CliRunner {
  return (cmd, args, input) =>
    new Promise<CliRunResult>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env, ...(cwd !== undefined ? { cwd } : {}) });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new CliTimeoutError(timeoutMs));
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      if (input !== undefined && child.stdin) {
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
      }
    });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CliTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** `which` without a shell: the first executable named `command` on PATH, or the path itself when absolute. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = isAbsolute(command) || command.includes("/") ? [command] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const file of candidates) {
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- rendering and parsing

/**
 * Small models sometimes answer a choice with words ("not shown") instead of
 * an index. That is `none`; the strict validator would otherwise fail the batch.
 */
export function coerceAnswers(batch: Question[], raw: unknown[]): unknown[] {
  const kinds = new Map(batch.map((q) => [q.id, q.kind]));
  return raw.map((a) => {
    if (!isRecord(a) || typeof a.id !== "string") return a;
    const kind = kinds.get(a.id);
    if (kind !== "choice" && kind !== "boolean" && kind !== "score") return a;
    const { text, ...rest } = a;
    const index = rest.index;
    if (typeof index === "number" && Number.isInteger(index)) return rest;
    if (typeof index === "string" && /^-?\d+$/.test(index)) return { ...rest, index: Number(index) };
    if (index === null || index === undefined || typeof text === "string") return { ...rest, index: null };
    return rest;
  });
}

/** One prompt per batch: the answer shape first, then the model chooser's state and questions. */
export function renderPrompt(batch: Question[]): string {
  return [
    `Reply with JSON only, no prose, no code fence: ${ANSWER_WITH}`,
    "For choice questions answer with an option index (an integer) or null for none; never write words in place of an index. Use \"text\" only for text questions.",
    SYSTEM_PROMPT,
    `STATE:\n${batch[0]?.state ?? ""}`,
    `QUESTIONS:\n${renderQuestions(batch)}`,
  ].join("\n\n");
}

/** The first balanced `{...}` in `text` that parses as JSON, or undefined. Handles code fences and prose around it. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed: unknown = JSON.parse(text.slice(start, i + 1));
            if (isRecord(parsed)) return parsed;
          } catch {
            // an unbalanced fragment; keep scanning from the next brace
          }
          break;
        }
      }
    }
  }
  return undefined;
}

const AUTH_PATTERN = /not logged in|log ?in|sign ?in|authenticat|access token|refresh token|unauthorized|invalid api key|401/i;

export function looksLikeAuthFailure(text: string): boolean {
  return AUTH_PATTERN.test(text);
}

function parseJsonl(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed.type === "string") events.push(parsed);
    } catch {
      // a non-JSON line on stdout
    }
  }
  return events;
}

interface CodexOutcome {
  text: string | undefined;
  completed: boolean;
  error: string | undefined;
}

/** `codex exec --json`: the last `agent_message` item, `turn.completed`, and any `error` / `turn.failed` message. A plain stdout line is the fallback text. */
export function readCodexEvents(stdout: string): CodexOutcome {
  const events = parseJsonl(stdout);
  let text: string | undefined;
  let completed = false;
  let error: string | undefined;
  for (const event of events) {
    const type = event.type;
    if (type === "item.completed" && isRecord(event.item) && event.item.type === "agent_message" && typeof event.item.text === "string") text = event.item.text;
    else if (type === "turn.completed") completed = true;
    else if (type === "error" && typeof event.message === "string") error = event.message;
    else if (type === "turn.failed") {
      const nested = isRecord(event.error) && typeof event.error.message === "string" ? event.error.message : undefined;
      error = nested ?? error ?? "turn failed";
    }
  }
  if (text === undefined && events.length === 0) {
    const plain = stdout.trim();
    if (plain) text = plain;
  }
  return { text, completed, error };
}

interface ClaudeOutcome {
  text: string | undefined;
  isError: boolean;
  costUsd: number | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

/**
 * `claude -p --output-format json`: `{ result, total_cost_usd, usage }`. A plain stdout is the fallback text.
 *
 * U7: `usage.input_tokens` is only the uncached remainder. Claude Code caches
 * its own system prompt, so a real batch reported 10 input tokens next to
 * 18,429 in `cache_creation_input_tokens` and `cache_read_input_tokens`; the
 * input the model read is the sum of the three.
 */
export function readClaudeEnvelope(stdout: string): ClaudeOutcome {
  const envelope = extractJsonObject(stdout);
  if (envelope && typeof envelope.result === "string") {
    const usage = isRecord(envelope.usage) ? envelope.usage : {};
    const inputs = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].filter((n): n is number => typeof n === "number");
    return {
      text: envelope.result,
      isError: envelope.is_error === true,
      costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined,
      inputTokens: inputs.length > 0 ? inputs.reduce((a, b) => a + b, 0) : undefined,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    };
  }
  const plain = stdout.trim();
  return { text: plain || undefined, isError: false, costUsd: undefined, inputTokens: undefined, outputTokens: undefined };
}

// ---------------------------------------------------------------- chooser

export function defaultCliModel(harness: CliHarness, env: NodeJS.ProcessEnv): string | undefined {
  return harness === "claude" ? env.NAVVI_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL : env.NAVVI_CODEX_MODEL || undefined;
}

/**
 * The harness itself cannot answer: not on PATH, or installed but not signed
 * in. Still a `ConfigurationError` (an explicit `--chooser claude` must end
 * the run with the sign-in hint), but distinguishable so a caller holding a
 * list of backends can move to the next one instead of failing the run.
 */
export class CliUnavailableError extends ConfigurationError {}

export function signInError(harness: CliHarness, detail?: string): CliUnavailableError {
  const hint = harness === "claude" ? "run `claude` and sign in" : "run `codex login`";
  return new CliUnavailableError(`${HARNESS_LABEL[harness]} is installed but not signed in: ${hint}, or set an API key.${detail ? ` (${detail.trim().slice(0, 200)})` : ""}`);
}

export class CliChooser extends BaseChooser {
  readonly name: ChooserName;
  readonly harness: CliHarness;
  readonly model: string | undefined;
  protected readonly failureStatus = "model_unavailable" as const;
  protected readonly price: Price = { inputPerMillion: 0, outputPerMillion: 0 };
  private readonly command: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;
  private readonly textTimeoutMs: number;
  private reportedCostUsd = 0;

  constructor(harness: CliHarness, options: CliChooserOptions = {}) {
    super({ ...options, maxStateChars: options.maxStateChars ?? DEFAULT_STATE_CHARS });
    const env = options.env ?? process.env;
    this.harness = harness;
    this.name = harness;
    this.model = options.model ?? defaultCliModel(harness, env);
    this.command = options.command ?? harness;
    // NAVVI_CLI_TIMEOUT_MS is for a machine neither default fits; it sets both ceilings.
    const fromEnv = Number(env.NAVVI_CLI_TIMEOUT_MS);
    const override = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : undefined;
    this.timeoutMs = options.timeoutMs ?? override ?? CLI_TIMEOUT_MS;
    this.textTimeoutMs = options.textTimeoutMs ?? override ?? Math.max(this.timeoutMs, CLI_TEXT_TIMEOUT_MS);
    this.runner = options.runner ?? processRunner(Math.max(this.timeoutMs, this.textTimeoutMs), harnessEnv(harness, env), harnessCwd());
  }

  usage(): ChooserUsage {
    // The harness runs on the user's subscription, so its own tokens cost nothing; a writer it delegated to still bills (U14).
    return { ...super.usage(), costUsd: this.delegatedCostUsd, billing: "subscription", reportedCostUsd: this.reportedCostUsd };
  }

  protected async callBackend(batch: Question[]): Promise<BackendResult> {
    const prompt = renderPrompt(batch);
    const estimate = estimateTokens(prompt);
    let run: CliRunResult;
    try {
      const ceiling = batch.some((q) => q.kind === "text") ? this.textTimeoutMs : this.timeoutMs;
      run = await withTimeout(this.harness === "claude" ? this.runClaude(prompt) : this.runCodex(prompt), ceiling);
    } catch (err) {
      if (err instanceof CliTimeoutError) throw new ModelUnavailableError(`${HARNESS_LABEL[this.harness]} gave ${err.message}`, { cause: err });
      if (isRecord(err) && err.code === "ENOENT") throw new CliUnavailableError(`${HARNESS_LABEL[this.harness]} is not installed (\`${this.command}\` not found on PATH)`);
      throw err;
    }
    const outcome: { text: string | undefined; inputTokens?: number; outputTokens?: number } = this.harness === "claude" ? this.claudeOutcome(run) : this.codexOutcome(run);
    const parsed = outcome.text === undefined ? undefined : extractJsonObject(outcome.text);
    // No JSON, or JSON without answers: the base class re-asks once and then fails typed.
    const answers = coerceAnswers(batch, parsed && Array.isArray(parsed.answers) ? parsed.answers : []);
    // The budget caps what navvi sends; the harness's own cached prompt is on the subscription (U7).
    return { answers, inputTokens: outcome.inputTokens ?? estimate, budgetInputTokens: estimate, outputTokens: outcome.outputTokens ?? estimateTokens(outcome.text ?? ""), zeroDataRetention: "not_applicable" };
  }

  private runClaude(prompt: string): Promise<CliRunResult> {
    const modelArgs = this.model ? ["--model", this.model] : [];
    return prompt.length > MAX_ARGV_PROMPT_CHARS
      ? this.runner(this.command, ["-p", "--output-format", "json", ...modelArgs], prompt)
      : this.runner(this.command, ["-p", prompt, "--output-format", "json", ...modelArgs]);
  }

  private runCodex(prompt: string): Promise<CliRunResult> {
    const modelArgs = this.model ? ["-m", this.model] : [];
    const base = ["exec", "--skip-git-repo-check", "-s", "read-only", "--json", ...modelArgs];
    // `-` reads the prompt from stdin.
    return prompt.length > MAX_ARGV_PROMPT_CHARS ? this.runner(this.command, [...base, "-"], prompt) : this.runner(this.command, [...base, prompt]);
  }

  private claudeOutcome(run: CliRunResult): { text: string | undefined; inputTokens?: number; outputTokens?: number } {
    const envelope = readClaudeEnvelope(run.stdout);
    if (run.code !== 0 || envelope.isError) {
      const detail = `${envelope.isError ? envelope.text ?? "" : ""}\n${run.stderr}`.trim();
      if (looksLikeAuthFailure(detail)) throw signInError("claude", detail);
      throw new Error(`claude exited ${run.code}: ${detail.slice(0, 500) || "no output"}`);
    }
    if (envelope.costUsd !== undefined) this.reportedCostUsd += envelope.costUsd;
    return { text: envelope.text, inputTokens: envelope.inputTokens, outputTokens: envelope.outputTokens };
  }

  private codexOutcome(run: CliRunResult): { text: string | undefined } {
    const outcome = readCodexEvents(run.stdout);
    if (outcome.error !== undefined && looksLikeAuthFailure(outcome.error)) throw signInError("codex", outcome.error);
    if (outcome.error !== undefined || (run.code !== 0 && outcome.text === undefined)) {
      throw new Error(`codex exited ${run.code}: ${(outcome.error ?? run.stderr).slice(0, 500) || "no output"}`);
    }
    return { text: outcome.text };
  }
}

// ---------------------------------------------------------------- probe

export interface CliProbe {
  installed: boolean;
  /** `"unknown"` when the CLI is installed but the sign-in probe could not run (timeout, spawn error). */
  signedIn: boolean | "unknown";
  version?: string;
  detail?: string;
}

const probeCache = new Map<CliHarness, Promise<CliProbe>>();

/** Forget cached probe results (tests). */
export function resetProbeCache(): void {
  probeCache.clear();
}

export interface ProbeOptions {
  runner?: CliRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Bypass the per-process cache. */
  fresh?: boolean;
}

/**
 * Is the harness installed and signed in? Installed is `which`; signed in is a
 * one-word round trip that must succeed. Cached per process: the CLI is
 * probed at most once per run, before the browser starts.
 */
export function probeCli(harness: CliHarness, runnerOrOptions?: CliRunner | ProbeOptions): Promise<CliProbe> {
  const options: ProbeOptions = typeof runnerOrOptions === "function" ? { runner: runnerOrOptions } : (runnerOrOptions ?? {});
  const cached = probeCache.get(harness);
  if (cached && !options.fresh && !options.runner) return cached;
  const result = runProbe(harness, options);
  if (!options.runner) probeCache.set(harness, result);
  return result;
}

async function runProbe(harness: CliHarness, options: ProbeOptions): Promise<CliProbe> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const runner = options.runner ?? processRunner(timeoutMs, env, harnessCwd());
  const installed = options.runner ? await whichViaRunner(harness, runner) : findOnPath(harness, env) !== undefined;
  if (!installed) return { installed: false, signedIn: false, detail: `\`${harness}\` not found on PATH` };
  const probe: CliProbe = { installed: true, signedIn: "unknown" };
  try {
    const version = await withTimeout(runner(harness, ["--version"]), timeoutMs);
    if (version.code === 0 && version.stdout.trim()) probe.version = version.stdout.trim().split("\n")[0];
  } catch {
    // a version is a nicety
  }
  try {
    const args = harness === "claude" ? ["-p", PROBE_PROMPT, "--output-format", "json", "--model", DEFAULT_CLAUDE_MODEL] : ["exec", "--skip-git-repo-check", "-s", "read-only", "--json", PROBE_PROMPT];
    const run = await withTimeout(runner(harness, args), timeoutMs);
    if (harness === "claude") {
      const envelope = readClaudeEnvelope(run.stdout);
      probe.signedIn = run.code === 0 && !envelope.isError && typeof envelope.text === "string" && envelope.text.length > 0;
      if (!probe.signedIn) probe.detail = `${envelope.text ?? ""} ${run.stderr}`.trim().slice(0, 300) || `claude exited ${run.code}`;
    } else {
      const outcome = readCodexEvents(run.stdout);
      probe.signedIn = outcome.completed && outcome.error === undefined && run.code === 0;
      if (!probe.signedIn) probe.detail = (outcome.error ?? run.stderr.trim()).slice(0, 300) || `codex exited ${run.code}`;
    }
  } catch (err) {
    probe.signedIn = "unknown";
    probe.detail = err instanceof Error ? err.message : String(err);
  }
  return probe;
}

async function whichViaRunner(harness: CliHarness, runner: CliRunner): Promise<boolean> {
  try {
    const run = await runner("command", ["-v", harness]);
    return run.code === 0 && run.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
