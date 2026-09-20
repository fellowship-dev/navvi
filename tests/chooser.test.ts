import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Experimental_EvaluationMockModelV4, MockLanguageModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import type { Experimental_EvaluationModelV4CallOptions } from "@ai-sdk/provider";
import { LIMITS } from "../src/input/schema.js";
import {
  BaseChooser,
  ConfigurationError,
  InvalidAnswerError,
  StateTooLargeError,
  TEXT_INPUT_CAP,
  estimateTokens,
  sanitizeError,
  validateAnswers,
  type Answer,
  type BackendResult,
  type Chooser,
  type ChooserName,
  type Question,
} from "../src/chooser/chooser.js";
import { AgentChooser, QUESTIONS_START, QUESTIONS_END, loadAnswersFile } from "../src/chooser/agent.js";
import { JevChooser, JEV_MAX_STATE_TOKENS, JEV_PRICE_PER_MILLION_INPUT_USD, TypeSafeEvaluationModel } from "../src/chooser/jev.js";
import { ModelChooser, DEFAULT_MODEL_ID, DEFAULT_MODEL_STATE_CHARS, MODEL_PRICES } from "../src/chooser/model.js";
import { RecordedChooser, RecordingChooser } from "../src/chooser/recorded.js";
import type { CliRunner } from "../src/chooser/cli.js";
import { createChooser } from "../src/chooser/index.js";
import { Budget, BudgetExhaustedError, ModelUnavailableError, NavviError, NeedsHumanError } from "../src/billing/budget.js";

const SCRATCH = process.env.CLAUDE_SCRATCHPAD ?? tmpdir();
const RECORDED_DIR = join(process.cwd(), "tests", "recorded");
const STATE = "<ul><li class=p>Paracetamol 500mg $1.990</li><li class=p>Ibuprofeno 400mg $2.490</li></ul>";

/** Sample premises for the fixture questions; the run's real wording lives in src/chooser/questions.ts. */
const SAMPLE_PREMISE = {
  groupChoice: (field: string): string => `Which candidate group contains one record per row with the ${field} value? Pick none when no candidate does.`,
  consentBoolean: (): string => "Is the visible prompt a consent or cookie banner that can be dismissed without signing in or paying?",
  fieldQuality: (field: string): string => `How well do the sampled values match the ${field} field?`,
  textHelper: (what: string): string => `Write the ${what} to type into the control. Answer with the text only.`,
};

function fixture(id: string): Answer & { inputTokens: number; outputTokens: number } {
  return JSON.parse(readFileSync(join(RECORDED_DIR, "pharmacy", `${id}.json`), "utf8")) as Answer & {
    inputTokens: number;
    outputTokens: number;
  };
}

function batch(): Question[] {
  return [
    { id: "group", kind: "choice", premise: SAMPLE_PREMISE.groupChoice("price"), options: ["li.x", "li.p", "div.q"], state: STATE },
    { id: "visible", kind: "boolean", premise: SAMPLE_PREMISE.consentBoolean(), state: STATE },
    { id: "quality", kind: "score", premise: SAMPLE_PREMISE.fieldQuality("price"), options: ["wrong", "partial", "right"], state: STATE },
  ];
}

/** A scripted backend for testing the shared validation, retry, budget and usage layer. */
class ScriptedChooser extends BaseChooser {
  readonly name: ChooserName = "model";
  calls: Question[][] = [];
  constructor(
    private readonly script: Array<(batch: Question[]) => BackendResult | Promise<BackendResult>>,
    opts: { budget?: Budget; backoffMs?: number[]; maxStateChars?: number } = {},
  ) {
    super({ budget: opts.budget, backoffMs: opts.backoffMs ?? [0, 0], maxStateChars: opts.maxStateChars });
  }
  protected readonly failureStatus = "model_unavailable" as const;
  protected readonly price = { inputPerMillion: 1, outputPerMillion: 5 };
  protected async callBackend(batch: Question[]): Promise<BackendResult> {
    this.calls.push(batch);
    const step = this.script.shift();
    if (!step) throw new Error("script exhausted");
    return step(batch);
  }
}

function fixtureResult(batch: Question[]): BackendResult {
  return {
    answers: batch.map((q) => {
      const f = fixture(q.id);
      return { id: q.id, index: f.index, probability: f.probability, probabilities: f.probabilities, text: f.text };
    }),
    inputTokens: 120,
    outputTokens: 0,
  };
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://ai-gateway.vercel.sh/v4/ai/evaluate",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { authorization: "Bearer vck_secret_value" },
    isRetryable: statusCode === 429 || statusCode === 503 || statusCode === 529,
  });
}

/** Jev mock answering from the pharmacy fixtures in the AI SDK evaluation shape. */
function jevMock(behaviour: Array<"ok" | 429 | 503> = ["ok"]) {
  const calls: Experimental_EvaluationModelV4CallOptions[] = [];
  const model = new Experimental_EvaluationMockModelV4({
    provider: "gateway",
    modelId: "typesafe-ai/jev",
    supportedQuestionTypes: ["choice", "boolean", "score"],
    doEvaluate: async (options) => {
      calls.push(options);
      const step = behaviour.shift() ?? "ok";
      if (step !== "ok") throw apiError(step);
      const answers: Record<string, { type: "choice"; choice: string; probabilities?: Record<string, number> } | { type: "boolean"; probability: number } | { type: "score"; score: number; probabilities?: Record<string, number> }> = {};
      for (const [id, q] of Object.entries(options.questions)) {
        const f = fixture(id);
        if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const probs: Record<string, number> = {};
          keys.forEach((k, i) => (probs[k] = f.probabilities?.[i] ?? 0));
          answers[id] = { type: "choice", choice: keys[f.index ?? keys.length - 1] ?? "none", probabilities: probs };
        } else if (q.type === "boolean") {
          answers[id] = { type: "boolean", probability: f.probability ?? 0 };
        } else {
          const probs: Record<string, number> = {};
          q.criteria.forEach((_c, i) => (probs[String(i)] = f.probabilities?.[i] ?? 0));
          const mean = Object.entries(probs).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
          answers[id] = { type: "score", score: mean, probabilities: probs };
        }
      }
      return { answers, usage: { inputTokens: 120, outputTokens: 0 }, warnings: [], providerMetadata: { gateway: { zeroDataRetention: true } } };
    },
  });
  return { model, calls };
}

/** Language model mock answering the index JSON generateObject expects. */
function languageMock(text: string | ((prompt: unknown) => string), usage = { input: 300, output: 20 }) {
  const calls: unknown[] = [];
  const model = new MockLanguageModelV4({
    provider: "anthropic",
    modelId: DEFAULT_MODEL_ID,
    doGenerate: async (options) => {
      calls.push(options);
      const body = typeof text === "function" ? text(options.prompt) : text;
      return {
        content: [{ type: "text", text: body }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: usage.input, noCache: usage.input, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: usage.output, text: usage.output, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, calls };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(SCRATCH, "navvi-chooser-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("validation (R37)", () => {
  it("accepts in-range indices, none, booleans, scores and text", () => {
    const qs: Question[] = [...batch(), { id: "title", kind: "text", premise: SAMPLE_PREMISE.textHelper("store name"), state: STATE, maxLength: 50 }];
    const result = validateAnswers(qs, [
      { id: "group", index: 1 },
      { id: "visible", index: 1, probability: 0.9 },
      { id: "quality", index: 2 },
      { id: "title", index: null, text: "Store B" },
    ]);
    expect(result.invalid).toEqual([]);
    expect(result.valid.map((a) => a.index)).toEqual([1, 1, 2, null]);
    expect(validateAnswers([qs[0]!], [{ id: "group", index: null }]).invalid).toEqual([]);
  });

  it("rejects indices outside the offered options, bad booleans, long text and unknown ids", () => {
    const qs: Question[] = [...batch(), { id: "title", kind: "text", premise: "x", state: STATE, maxLength: 5 }];
    const result = validateAnswers(qs, [
      { id: "group", index: 3 },
      { id: "visible", index: 2 },
      { id: "quality", index: -1 },
      { id: "title", index: null, text: "too long text" },
      { id: "ghost", index: 0 },
    ]);
    expect(result.valid).toEqual([]);
    expect(result.invalid.map((i) => i.id).sort()).toEqual(["ghost", "group", "quality", "title", "visible"]);
    expect(validateAnswers([qs[0]!], [{ id: "group", index: 1, text: "free text leak" }]).invalid).toHaveLength(1);
  });
});

describe("BaseChooser retry, budget and usage", () => {
  it("returns typed answers and usage after a batch", async () => {
    const chooser = new ScriptedChooser([fixtureResult]);
    const answers = await chooser.ask(batch());
    expect(answers.map((a) => a.index)).toEqual([1, 1, 2]);
    expect(answers[1]?.probability).toBeCloseTo(0.93);
    const usage = chooser.usage();
    expect(usage.chooser).toBe("model");
    expect(usage.questions).toBe(3);
    expect(usage.inputTokens).toBe(120);
    expect(usage.waitMs).toBeGreaterThanOrEqual(0);
    expect(usage.costUsd).toBeCloseTo(120 / 1_000_000);
  });

  it("counts delegated text usage at the fallback price without prior shared usage or duplicate budget charges", async () => {
    const budget = new Budget({ chooserInputTokens: 400, textHelperCalls: 2 });
    const text: Question = { id: "parse", kind: "text", premise: "Parse", state: "prompt" };
    const textResult = (qs: Question[]): BackendResult => ({
      answers: qs.map((q) => ({ id: q.id, index: null, text: "parsed" })),
      inputTokens: 100, outputTokens: 20, zeroDataRetention: "not_applicable",
    });
    const fallback = new ScriptedChooser([textResult, textResult], { budget });
    await fallback.ask([text]); // Another caller already used this fallback.
    const before = fallback.usage();
    const mock = jevMock();
    const chooser = new JevChooser({ evaluationModel: mock.model, textFallback: fallback, budget });
    await chooser.ask([text, batch()[0]!]);
    const usage = chooser.usage();
    expect(usage).toMatchObject({ questions: 2, textQuestions: 1, batches: 2, inputTokens: 220, outputTokens: 20, zeroDataRetention: "unknown" });
    expect(usage.costUsd).toBeCloseTo((100 + 20 * 5 + 120 * JEV_PRICE_PER_MILLION_INPUT_USD) / 1_000_000);
    expect(usage.waitMs).toBeGreaterThanOrEqual(fallback.usage().waitMs - before.waitMs);
    expect(() => budget.chargeInputTokens(80)).not.toThrow();
    expect(() => budget.chargeInputTokens(1)).toThrow(BudgetExhaustedError);
    expect(chooser.usage()).toEqual(usage);
  });

  it("retains delegated failed-call usage and retention without claiming a zero-call run", async () => {
    const text: Question = { id: "parse", kind: "text", premise: "Parse", state: "prompt" };
    const bad = (): BackendResult => ({ answers: [], inputTokens: 50, outputTokens: 10, zeroDataRetention: "confirmed" });
    const fallback = new ScriptedChooser([bad, bad]);
    const chooser = new JevChooser({ evaluationModel: jevMock().model, textFallback: fallback });
    await expect(chooser.ask([text])).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(chooser.usage()).toMatchObject({ questions: 0, textQuestions: 0, batches: 2, inputTokens: 100, outputTokens: 20, zeroDataRetention: "confirmed" });
    expect(chooser.usage().costUsd).toBeCloseTo(0.0002);
    expect(chooser.usage().waitMs).toEqual(fallback.usage().waitMs);
  });

  it("snapshots only delegated usage when the fallback is reused later", async () => {
    const text: Question = { id: "parse", kind: "text", premise: "Parse", state: "prompt" };
    const ok = (): BackendResult => ({ answers: [{ id: "parse", index: null, text: "ok" }], inputTokens: 10, zeroDataRetention: "not_applicable" });
    const fallback = new ScriptedChooser([ok, ok]);
    const chooser = new JevChooser({ evaluationModel: jevMock().model, textFallback: fallback });
    await chooser.ask([text]);
    const usage = chooser.usage();
    expect(usage).toMatchObject({ questions: 1, textQuestions: 1, batches: 1, inputTokens: 10, zeroDataRetention: "not_applicable" });
    await fallback.ask([text]);
    expect(chooser.usage()).toEqual(usage);
  });

  it("attributes overlapping text calls once across callers sharing a fallback", async () => {
    const text: Question = { id: "parse", kind: "text", premise: "Parse", state: "prompt" };
    const ok = async (): Promise<BackendResult> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { answers: [{ id: "parse", index: null, text: "ok" }], inputTokens: 10, outputTokens: 2 };
    };
    const fallback = new ScriptedChooser([ok, ok, ok]);
    const first = new JevChooser({ evaluationModel: jevMock().model, textFallback: fallback });
    const second = new JevChooser({ evaluationModel: jevMock().model, textFallback: fallback });
    await Promise.all([first.ask([text]), first.ask([text]), second.ask([text])]);
    expect(first.usage()).toMatchObject({ questions: 2, textQuestions: 2, batches: 2, inputTokens: 20, outputTokens: 4 });
    expect(second.usage()).toMatchObject({ questions: 1, textQuestions: 1, batches: 1, inputTokens: 10, outputTokens: 2 });
    expect(first.usage().costUsd + second.usage().costUsd).toBeCloseTo(fallback.usage().costUsd);
    expect(first.usage().waitMs + second.usage().waitMs).toBeCloseTo(fallback.usage().waitMs);
  });

  it("releases the shared fallback queue after a failed call", async () => {
    const text: Question = { id: "parse", kind: "text", premise: "Parse", state: "prompt" };
    const fallback = new ScriptedChooser([
      () => { throw new Error("unavailable"); },
      () => ({ answers: [{ id: "parse", index: null, text: "ok" }], inputTokens: 10 }),
    ]);
    const chooser = new JevChooser({ evaluationModel: jevMock().model, textFallback: fallback });
    const results = await Promise.allSettled([chooser.ask([text]), chooser.ask([text])]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(chooser.usage()).toMatchObject({ questions: 1, textQuestions: 1, batches: 1, inputTokens: 10 });
    expect(chooser.usage().waitMs).toEqual(fallback.usage().waitMs);
  });

  it("retries an out-of-range answer once, then fails typed", async () => {
    const bad = (b: Question[]): BackendResult => ({ answers: b.map((q) => ({ id: q.id, index: 99 })) });
    const chooser = new ScriptedChooser([bad, (b) => fixtureResult(b)]);
    const answers = await chooser.ask(batch());
    expect(answers.map((a) => a.index)).toEqual([1, 1, 2]);
    expect(chooser.calls).toHaveLength(2);
    expect(chooser.calls[1]?.map((q) => q.id)).toEqual(["group", "visible", "quality"]);

    const stubborn = new ScriptedChooser([bad, bad]);
    const err = await stubborn.ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).status).toBe("model_unavailable");
    expect((err as ModelUnavailableError).cause).toBeInstanceOf(InvalidAnswerError);
    expect(stubborn.calls).toHaveLength(2);
  });

  it("recovers from a 429 then 200 and fails after three 503s", async () => {
    const ok = new ScriptedChooser([() => { throw apiError(429); }, fixtureResult]);
    await expect(ok.ask(batch())).resolves.toHaveLength(3);
    expect(ok.calls).toHaveLength(2);

    const down = new ScriptedChooser([() => { throw apiError(503); }, () => { throw apiError(503); }, () => { throw apiError(503); }]);
    const err = await down.ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as Error).message).toContain("503");
    expect((err as Error).message).not.toContain("vck_secret_value");
    expect(down.calls).toHaveLength(3);
  });

  it("charges the token budget and raises budget_exhausted", async () => {
    const budget = new Budget({ ...LIMITS, chooserInputTokens: 200 });
    const chooser = new ScriptedChooser([fixtureResult, fixtureResult], { budget });
    await chooser.ask(batch());
    const err = await chooser.ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).status).toBe("budget_exhausted");
    expect((err as BudgetExhaustedError).resource).toBe("chooserInputTokens");
  });

  it("caps text question input at 2,000 characters and counts text-helper calls", async () => {
    const budget = new Budget({ ...LIMITS, textHelperCalls: 1 });
    const chooser = new ScriptedChooser([
      (b) => ({ answers: b.map((q) => ({ id: q.id, index: null, text: "Store B" })) }),
      (b) => ({ answers: b.map((q) => ({ id: q.id, index: null, text: "Store B" })) }),
    ], { budget });
    const q: Question = { id: "title", kind: "text", premise: SAMPLE_PREMISE.textHelper("store name"), state: STATE, maxLength: 100 };
    const [a] = await chooser.ask([q]);
    expect(a?.text).toBe("Store B");
    expect(chooser.usage().textQuestions).toBe(1);
    await expect(chooser.ask([q])).rejects.toBeInstanceOf(BudgetExhaustedError);
    const long: Question = { ...q, state: "x".repeat(TEXT_INPUT_CAP + 1) };
    await expect(new ScriptedChooser([]).ask([long])).rejects.toBeInstanceOf(StateTooLargeError);
  });
});

describe("Budget (R28)", () => {
  it("raises on the call past the text helper limit with status budget_exhausted", () => {
    const budget = new Budget({ textHelperCalls: 2 });
    budget.chargeTextCall();
    budget.chargeTextCall();
    expect(() => budget.chargeTextCall()).toThrow(BudgetExhaustedError);
    try {
      budget.chargeTextCall();
    } catch (e) {
      expect(e).toBeInstanceOf(NavviError);
      expect((e as BudgetExhaustedError).status).toBe("budget_exhausted");
      expect((e as BudgetExhaustedError).resource).toBe("textHelperCalls");
      expect((e as BudgetExhaustedError).limit).toBe(2);
    }
  });
});

describe("error sanitizing", () => {
  it("strips Authorization headers, bearer tokens and the state from messages", () => {
    const raw = new Error(`request failed: Authorization: Bearer sk-ant-abc123 x-api-key: key789 state=${STATE}`);
    const clean = sanitizeError(raw, [STATE]);
    expect(clean.message).not.toContain("sk-ant-abc123");
    expect(clean.message).not.toContain("key789");
    expect(clean.message).not.toContain("Paracetamol");
    expect(clean.message).toContain("[redacted]");
    const withHeaders = sanitizeError(apiError(401));
    expect(JSON.stringify(withHeaders)).not.toContain("vck_secret_value");
    expect(withHeaders.message).toContain("401");
  });
});

describe("agent chooser (R45, KTD17)", () => {
  function scripted(reply: (batch: { questions: Question[]; token: string }) => unknown) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let buf = "";
    stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const start = buf.indexOf(QUESTIONS_START);
      const end = buf.indexOf(QUESTIONS_END);
      if (start >= 0 && end > start) {
        const json = buf.slice(start + QUESTIONS_START.length, end).trim();
        buf = "";
        const parsed = JSON.parse(json) as { questions: Question[]; token: string };
        setTimeout(() => stdin.write(JSON.stringify(reply(parsed), null, 2) + "\n"), 5);
      }
    });
    return { stdin, stdout };
  }

  it("round-trips a batch through scripted streams and never prints secrets", async () => {
    const { stdin, stdout } = scripted((b) => ({
      answers: b.questions.map((q) => (q.kind === "text" ? { id: q.id, index: null, text: "Store B" } : { id: q.id, index: q.kind === "score" ? 2 : 1 })),
    }));
    const chooser = new AgentChooser({ stdin, stdout, questionsDir: join(tmp, "questions"), timeoutMs: 5_000, env: {} });
    const qs: Question[] = [...batch(), { id: "title", kind: "text", premise: SAMPLE_PREMISE.textHelper("store name"), state: STATE, maxLength: 40 }];
    const answers = await chooser.ask(qs);
    expect(answers.map((a) => a.index)).toEqual([1, 1, 2, null]);
    expect(answers[3]?.text).toBe("Store B");
    const usage = chooser.usage();
    expect(usage.chooser).toBe("agent");
    expect(usage.questions).toBe(4);
    expect(usage.costUsd).toBe(0);
    expect(usage.inputTokens).toBe(qs.reduce((n, q) => n + estimateTokens(q.state + q.premise + (q.options ?? []).join("")), 0));
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("retries an out-of-range answer once through the protocol, then ends needs_human", async () => {
    let n = 0;
    const { stdin, stdout } = scripted((b) => ({ answers: b.questions.map((q) => ({ id: q.id, index: n++ === 0 ? 7 : 1 })) }));
    const chooser = new AgentChooser({ stdin, stdout, questionsDir: join(tmp, "questions"), timeoutMs: 5_000, env: {} });
    const [a] = await chooser.ask([batch()[0]!]);
    expect(a?.index).toBe(1);
    const stubborn = scripted((b) => ({ answers: b.questions.map((q) => ({ id: q.id, index: 7 })) }));
    const chooser2 = new AgentChooser({ ...stubborn, questionsDir: join(tmp, "questions"), timeoutMs: 5_000, env: {} });
    const err = await chooser2.ask([batch()[0]!]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsHumanError);
    expect((err as NeedsHumanError).status).toBe("needs_human");
  });

  it("answers that arrived over stdio ride along in a later park's answered list", async () => {
    let batches = 0;
    const { stdin, stdout } = scripted((b) => {
      // The first batch is answered; on the second the answering process goes away.
      if (batches++ > 0) return stdin.end();
      return { answers: b.questions.map((q) => ({ id: q.id, index: q.kind === "score" ? 2 : 1 })) };
    });
    const dir = join(tmp, "questions-carry");
    const chooser = new AgentChooser({ stdin, stdout, questionsDir: dir, timeoutMs: 5_000, env: {} });
    expect((await chooser.ask(batch())).map((a) => a.index)).toEqual([1, 1, 2]);
    const err = await chooser.ask([{ id: "next", kind: "choice", premise: SAMPLE_PREMISE.groupChoice("stock"), options: ["a", "b"], state: STATE }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsHumanError);
    const parked = JSON.parse(readFileSync(join(dir, `${(err as NeedsHumanError).token}.json`), "utf8")) as { questions: Question[]; answered: Answer[] };
    expect(parked.questions.map((q) => q.id)).toEqual(["next"]);
    expect(parked.answered.map((a) => [a.id, a.index])).toEqual([["group", 1], ["visible", 1], ["quality", 2]]);
  });

  it("with a closed non-pipe stdin writes storage/questions/<token>.json and throws needs_human with the token", async () => {
    const dir = join(tmp, "storage", "questions");
    const chooser = new AgentChooser({ stdin: null, stdout: new PassThrough(), questionsDir: dir, env: {} });
    const err = await chooser.ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsHumanError);
    const token = (err as NeedsHumanError).token;
    expect(token).toMatch(/^[a-f0-9]{12}$/);
    expect((err as NeedsHumanError).message).toContain(token);
    const file = join(dir, `${token}.json`);
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8")) as { token: string; questions: Question[] };
    expect(written.token).toBe(token);
    expect(written.questions.map((q) => q.id)).toEqual(["group", "visible", "quality"]);

    // resume: --answers <file> --resume <token>
    const answersPath = join(tmp, "answers.json");
    writeFileSync(answersPath, JSON.stringify({ answers: [{ id: "group", index: 1 }, { id: "visible", index: 0 }, { id: "quality", index: 2 }] }));
    const resumed = new AgentChooser({ stdin: null, stdout: new PassThrough(), questionsDir: dir, answers: loadAnswersFile(answersPath), env: {} });
    const answers = await resumed.ask(batch());
    expect(answers.map((a) => a.index)).toEqual([1, 0, 2]);
  });

  it("unattended with no answering process ends needs_human at the first question and leaves nothing behind", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdin.end(); // the pipe closes without an answer
    const chooser = new AgentChooser({ stdin, stdout, questionsDir: join(tmp, "q"), timeoutMs: 200, env: {} });
    const err = await chooser.ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsHumanError);
    expect((err as NeedsHumanError).status).toBe("needs_human");
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("end")).toBe(0);

    const apify = new AgentChooser({ stdin: new PassThrough(), stdout: new PassThrough(), questionsDir: join(tmp, "q2"), env: { APIFY_IS_AT_HOME: "1" } });
    const t0 = Date.now();
    await expect(apify.ask(batch())).rejects.toBeInstanceOf(NeedsHumanError);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(chooser.usage().questions).toBe(0);
  });

  it("asks the same question id again over stdio when the offered options differ (memory is keyed by id and options)", async () => {
    const seen: string[][] = [];
    const { stdin, stdout } = scripted((b) => {
      seen.push(b.questions.map((q) => q.options ?? []).flat());
      return { answers: b.questions.map((q) => ({ id: q.id, index: (q.options?.length ?? 1) - 1 })) };
    });
    const chooser = new AgentChooser({ stdin, stdout, questionsDir: join(tmp, "questions-rekey"), timeoutMs: 5_000, env: {} });
    const first = await chooser.ask([{ id: "group", kind: "choice", premise: SAMPLE_PREMISE.groupChoice("price"), options: ["li.x", "li.p", "div.q"], state: STATE }]);
    expect(first[0]?.index).toBe(2);
    const second = await chooser.ask([{ id: "group", kind: "choice", premise: SAMPLE_PREMISE.groupChoice("price"), options: ["tr.row", "div.card"], state: STATE + "<p>page 2</p>" }]);
    expect(second[0]?.index).toBe(1);
    expect(seen).toHaveLength(2);
    // The identical question is still served from memory without a third round trip.
    const again = await chooser.ask([{ id: "group", kind: "choice", premise: SAMPLE_PREMISE.groupChoice("price"), options: ["li.x", "li.p", "div.q"], state: STATE }]);
    expect(again[0]?.index).toBe(2);
    expect(seen).toHaveLength(2);
  });

  it("drops a preloaded answer that fails validation and parks normally with a token", async () => {
    const dir = join(tmp, "questions-stale");
    const chooser = new AgentChooser({ stdin: null, stdout: new PassThrough(), questionsDir: dir, answers: [{ id: "group", index: 7 }], env: {} });
    const err = await chooser.ask([batch()[0]!]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsHumanError);
    const token = (err as NeedsHumanError).token;
    expect(token).toMatch(/^[a-f0-9]{12}$/);
    const parked = JSON.parse(readFileSync(join(dir, `${token}.json`), "utf8")) as { questions: Question[]; answered: Answer[] };
    expect(parked.questions.map((q) => q.id)).toEqual(["group"]);
    expect(parked.answered).toEqual([]);
  });

  it("prints the same token in the stdio batch that the parked file gets when the batch parks", async () => {
    let printed: string | undefined;
    const { stdin, stdout } = scripted((b) => {
      printed = b.token;
      stdin.end();
      return { answers: [] };
    });
    const dir = join(tmp, "questions-token");
    const chooser = new AgentChooser({ stdin, stdout, questionsDir: dir, timeoutMs: 5_000, env: {} });
    const err = await chooser.ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsHumanError);
    expect(printed).toMatch(/^[a-f0-9]{12}$/);
    expect((err as NeedsHumanError).token).toBe(printed);
    expect(existsSync(join(dir, `${printed}.json`))).toBe(true);
  });

  it("accepts an answer batch written without a trailing newline before stdin ends", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(QUESTIONS_END)) {
        stdin.write(JSON.stringify({ answers: [{ id: "group", index: 1 }, { id: "visible", index: 0 }, { id: "quality", index: 2 }] }));
        stdin.end();
      }
    });
    const chooser = new AgentChooser({ stdin, stdout, questionsDir: join(tmp, "questions-eof"), timeoutMs: 5_000, env: {} });
    const answers = await chooser.ask(batch());
    expect(answers.map((a) => a.index)).toEqual([1, 0, 2]);
  });

  it("is the default and the no-key path", () => {
    expect(createChooser({ env: {} }).name).toBe("agent");
  });
});

describe("jev chooser (KTD2)", () => {
  it("answers choice, boolean and score from the evaluation mock with usage, cost and zero data retention", async () => {
    const { model, calls } = jevMock();
    const chooser = new JevChooser({ evaluationModel: model, backoffMs: [0, 0] });
    const answers = await chooser.ask(batch());
    expect(answers.map((a) => a.index)).toEqual([1, 1, 2]);
    expect(answers[0]?.probabilities).toEqual([0.05, 0.9, 0.05]);
    expect(answers[1]?.probability).toBeCloseTo(0.93);
    expect(answers[2]?.probabilities).toEqual([0.05, 0.15, 0.8]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.state).toBe(STATE);
    expect(Object.keys(call.questions)).toEqual(["group", "visible", "quality"]);
    expect(call.questions.group?.type).toBe("choice");
    expect(call.providerOptions?.gateway?.zeroDataRetention).toBe(true);
    const usage = chooser.usage();
    expect(usage.chooser).toBe("jev");
    expect(usage.questions).toBe(3);
    expect(usage.inputTokens).toBe(120);
    expect(usage.costUsd).toBeCloseTo((120 / 1_000_000) * JEV_PRICE_PER_MILLION_INPUT_USD);
    expect(usage.zeroDataRetention).toBe("confirmed");
  });

  it("choice questions always offer none as the last option", async () => {
    const { model, calls } = jevMock();
    await new JevChooser({ evaluationModel: model }).ask([batch()[0]!]);
    const q = calls[0]!.questions.group!;
    expect(q.type === "choice" && Object.keys(q.criteria).at(-1)).toBe("none");
  });

  it("refuses a state over 32k tokens without a network call; the model backend accepts it", async () => {
    const { model, calls } = jevMock();
    const big = { ...batch()[0]!, state: "x".repeat((JEV_MAX_STATE_TOKENS + 1) * 4) };
    await expect(new JevChooser({ evaluationModel: model }).ask([big])).rejects.toBeInstanceOf(StateTooLargeError);
    expect(calls).toHaveLength(0);
    expect(big.state.length).toBeLessThanOrEqual(DEFAULT_MODEL_STATE_CHARS);
    const lm = languageMock(JSON.stringify({ answers: [{ id: "group", index: 1 }] }));
    const answers = await new ModelChooser({ model: lm.model }).ask([big]);
    expect(answers[0]?.index).toBe(1);
    expect(lm.calls).toHaveLength(1);
  });

  it("recovers from a 429 then 200 and raises model_unavailable after three 503s", async () => {
    const ok = jevMock([429, "ok"]);
    const chooser = new JevChooser({ evaluationModel: ok.model, backoffMs: [0, 0] });
    await expect(chooser.ask(batch())).resolves.toHaveLength(3);
    expect(ok.calls).toHaveLength(2);

    const down = jevMock([503, 503, 503]);
    const err = await new JevChooser({ evaluationModel: down.model, backoffMs: [0, 0] }).ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).status).toBe("model_unavailable");
    expect(down.calls).toHaveLength(3);
  });

  it("names the env vars and chooser: agent when no credentials are configured", () => {
    const err = (() => {
      try {
        new JevChooser({ env: {} });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err?.message).toContain("AI_GATEWAY_API_KEY");
    expect(err?.message).toContain("TYPESAFE_API_KEY");
    expect(err?.message).toContain("ANTHROPIC_API_KEY");
    expect(err?.message).toContain("chooser: agent");
  });

  it("prefers the caller key over the environment and picks gateway vs direct by key", () => {
    expect(new JevChooser({ apiKey: "caller", env: { AI_GATEWAY_API_KEY: "op" } }).provider).toBe("gateway");
    expect(new JevChooser({ env: { AI_GATEWAY_API_KEY: "op" } }).provider).toBe("gateway");
    expect(new JevChooser({ env: { TYPESAFE_API_KEY: "op" } }).provider).toBe("typesafe");
    expect(new JevChooser({ apiKey: "caller", provider: "typesafe", env: {} }).provider).toBe("typesafe");
  });

  it("direct TypeSafe provider posts the systemone request and maps noul/choice/score back", async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            group: { type: "choice", choice: "option_1", probabilities: { option_0: 0.05, option_1: 0.9, option_2: 0.05, none: 0 }, confidence: 0.9 },
            visible: { type: "noul", noul: 0.93 },
            quality: { type: "score", score: 1.75, probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 }, confidence: 0.8 },
          },
          usage: { input_tokens: 439, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const chooser = new JevChooser({ apiKey: "ts-secret", provider: "typesafe", fetch: fetchImpl, env: {} });
    const answers = await chooser.ask(batch());
    expect(answers.map((a) => a.index)).toEqual([1, 1, 2]);
    expect(answers[2]?.probabilities).toEqual([0.05, 0.15, 0.8]);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(req.headers.authorization).toBe("Bearer ts-secret");
    const body = req.body as { model: string; state: string; questions: Record<string, { type: string }> };
    expect(body.model).toBe("jev-latest");
    expect(body.state).toBe(STATE);
    expect(body.questions.visible?.type).toBe("noul");
    expect(chooser.usage().inputTokens).toBe(439);
    expect(chooser.usage().zeroDataRetention).toBe("unknown");
  });

  it("direct provider errors never carry the bearer token", async () => {
    const fetchImpl: typeof fetch = async () => new Response("rate limited", { status: 429 });
    const model = new TypeSafeEvaluationModel({ apiKey: "ts-secret", fetch: fetchImpl });
    const chooser = new JevChooser({ evaluationModel: model, backoffMs: [0, 0] });
    const err = await chooser.ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(JSON.stringify({ m: (err as Error).message, s: String((err as Error).stack), c: String((err as Error).cause) })).not.toContain("ts-secret");
  });
});

describe("model chooser (KTD2, KTD11)", () => {
  it("answers choice, boolean, score and text through generateObject with usage and cost", async () => {
    const lm = languageMock(JSON.stringify({ answers: [{ id: "group", index: 1 }, { id: "visible", index: 1 }, { id: "quality", index: 2 }, { id: "title", index: null, text: "Store B" }] }));
    const chooser = new ModelChooser({ model: lm.model });
    const qs: Question[] = [...batch(), { id: "title", kind: "text", premise: SAMPLE_PREMISE.textHelper("store name"), state: STATE, maxLength: 40 }];
    const answers = await chooser.ask(qs);
    expect(answers.map((a) => a.index)).toEqual([1, 1, 2, null]);
    expect(answers[3]?.text).toBe("Store B");
    const usage = chooser.usage();
    expect(usage.chooser).toBe("model");
    expect(usage.questions).toBe(4);
    expect(usage.textQuestions).toBe(1);
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(20);
    const price = MODEL_PRICES[DEFAULT_MODEL_ID]!;
    expect(usage.costUsd).toBeCloseTo((300 * price.inputPerMillion + 20 * price.outputPerMillion) / 1_000_000);
    expect(usage.zeroDataRetention).toBe("not_applicable");
  });

  it("retries an out-of-range index once and then fails typed", async () => {
    let n = 0;
    const lm = languageMock(() => JSON.stringify({ answers: [{ id: "group", index: n++ === 0 ? 5 : 1 }] }));
    const chooser = new ModelChooser({ model: lm.model, backoffMs: [0, 0] });
    expect((await chooser.ask([batch()[0]!]))[0]?.index).toBe(1);
    expect(lm.calls).toHaveLength(2);
    const bad = languageMock(JSON.stringify({ answers: [{ id: "group", index: 5 }] }));
    await expect(new ModelChooser({ model: bad.model }).ask([batch()[0]!])).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(bad.calls).toHaveLength(2);
  });

  it("names the env vars when no key is configured and reads NAVVI_MODEL", () => {
    expect(() => new ModelChooser({ env: {} })).toThrow(ConfigurationError);
    expect(() => new ModelChooser({ env: {} })).toThrow(/ANTHROPIC_API_KEY[\s\S]*chooser: agent/);
    expect(new ModelChooser({ env: { ANTHROPIC_API_KEY: "k", NAVVI_MODEL: "claude-sonnet-5" } }).modelId).toBe("claude-sonnet-5");
    expect(new ModelChooser({ env: { ANTHROPIC_API_KEY: "k" } }).modelId).toBe(DEFAULT_MODEL_ID);
  });
});

describe("recorded chooser (KTD12)", () => {
  it("replays recorded answers per fixture and question id", async () => {
    const chooser = new RecordedChooser({ fixture: "pharmacy" });
    const qs: Question[] = [...batch(), { id: "title", kind: "text", premise: "name", state: STATE, maxLength: 40 }];
    const answers = await chooser.ask(qs);
    expect(answers.map((a) => a.index)).toEqual([1, 1, 2, null]);
    expect(answers[3]?.text).toBe("Farmacia Store B");
    expect(chooser.usage().chooser).toBe("recorded");
    expect(chooser.usage().inputTokens).toBe(400);
  });

  it("fails loudly on an unrecorded question id", async () => {
    const chooser = new RecordedChooser({ fixture: "pharmacy" });
    await expect(chooser.ask([{ ...batch()[0]!, id: "nonexistent" }])).rejects.toThrow(/no recorded answer .*nonexistent.*pharmacy/);
  });

  it("recorder mode writes fixtures from a wrapped chooser and does nothing on Apify", async () => {
    const dir = join(tmp, "recorded");
    const inner = () => new ScriptedChooser([fixtureResult]);
    const recorder = new RecordingChooser(inner(), { fixture: "rec", dir, env: {} });
    const answers = await recorder.ask(batch());
    expect(answers.map((a) => a.index)).toEqual([1, 1, 2]);
    expect(readdirSync(join(dir, "rec")).sort()).toEqual(["group.json", "quality.json", "visible.json"]);
    const replay = new RecordedChooser({ fixture: "rec", dir });
    expect((await replay.ask(batch())).map((a) => a.index)).toEqual([1, 1, 2]);

    const apify = new RecordingChooser(inner(), { fixture: "apify", dir, env: { APIFY_IS_AT_HOME: "1" } });
    await apify.ask(batch());
    expect(existsSync(join(dir, "apify"))).toBe(false);
  });
});

describe("createChooser", () => {
  it("builds each backend by name", () => {
    const names: ChooserName[] = ["agent", "jev", "model"];
    const built: Chooser[] = [
      createChooser({ chooser: "agent", env: {}, agent: { stdin: null, stdout: new PassThrough() } }),
      createChooser({ chooser: "jev", env: { AI_GATEWAY_API_KEY: "k" } }),
      createChooser({ chooser: "model", env: { ANTHROPIC_API_KEY: "k" } }),
    ];
    expect(built.map((c) => c.name)).toEqual(names);
    expect(() => createChooser({ chooser: "jev", env: {} })).toThrow(ConfigurationError);
  });
});

// ---------------------------------------------------------------- text fallback precedence

/** A PATH directory of executable stubs, so `findOnPath` sees exactly the harnesses a test installs. */
function fakeBin(harnesses: string[]): string {
  const dir = mkdtempSync(join(tmp, "bin-"));
  for (const name of harnesses) writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

/** Records the endpoint a provider reaches for, then fails: which API was chosen, without a network. */
function recordingFetch(urls: string[]): typeof fetch {
  return (async (input: unknown) => {
    urls.push(typeof input === "string" ? input : String((input as { url?: string }).url ?? input));
    throw new Error("no network in tests");
  }) as unknown as typeof fetch;
}

type CliBehaviour = "answers" | "signed-out" | "broken";

/** Stands in for `claude -p` / `codex exec`: an answer, the signed-out failure, or an unrelated crash. */
function cliRunner(behaviour: CliBehaviour, text = "from the subscription"): CliRunner & { calls: string[] } {
  const calls: string[] = [];
  const runner = (async (cmd: string) => {
    calls.push(cmd);
    if (behaviour === "broken") return { code: 1, stdout: "", stderr: "segmentation fault" };
    if (behaviour === "signed-out") {
      return cmd === "claude"
        ? { code: 1, stdout: "", stderr: "Invalid API key · Please run /login" }
        : { code: 1, stdout: `${JSON.stringify({ type: "error", message: "Please log out and sign in again." })}\n`, stderr: "" };
    }
    const body = JSON.stringify({ answers: [{ id: "query", index: null, text }] });
    const envelope = { type: "result", is_error: false, result: body, total_cost_usd: 0.002, usage: { input_tokens: 90, output_tokens: 8 } };
    return { code: 0, stdout: JSON.stringify(envelope), stderr: "" };
  }) as CliRunner & { calls: string[] };
  runner.calls = calls;
  return runner;
}

const textQuestion = (): Question => ({ id: "query", kind: "text", premise: SAMPLE_PREMISE.textHelper("search query"), state: STATE, maxLength: 40 });

const MODEL_ANSWER = JSON.stringify({ answers: [{ id: "query", index: null, text: "from the api" }] });

/**
 * Jev over the Gateway is free, a Gateway text model is not. Text questions
 * Jev cannot write must prefer a subscription CLI and only then a metered
 * API, ANTHROPIC_API_KEY before the Gateway.
 */
describe("text fallback precedence: subscription before metered", () => {
  it("gateway key with a CLI on PATH: Jev answers the choice, the CLI answers the text, nothing is metered", async () => {
    const jev = jevMock();
    const cli = cliRunner("answers");
    const urls: string[] = [];
    const chooser = createChooser({
      chooser: "jev",
      env: { AI_GATEWAY_API_KEY: "g", PATH: fakeBin(["claude"]) },
      jev: { evaluationModel: jev.model },
      cli: { runner: cli },
      model: { fetch: recordingFetch(urls), maxAttempts: 1 },
    });
    const answers = await chooser.ask([batch()[0]!, textQuestion()]);
    expect(chooser.name).toBe("jev");
    expect(answers[0]?.index).toBe(1);
    expect(answers[1]?.text).toBe("from the subscription");
    expect(jev.calls).toHaveLength(1);
    expect(cli.calls).toEqual(["claude"]);
    expect(urls).toEqual([]);
    expect(chooser.usage().costUsd).toBeCloseTo((120 * JEV_PRICE_PER_MILLION_INPUT_USD) / 1_000_000);
  });

  it("gateway key and no CLI on PATH: text falls through to the metered model over the Gateway", async () => {
    const urls: string[] = [];
    const chooser = createChooser({
      chooser: "jev",
      env: { AI_GATEWAY_API_KEY: "g", PATH: fakeBin([]) },
      jev: { evaluationModel: jevMock().model },
      model: { fetch: recordingFetch(urls), maxAttempts: 1 },
    });
    await expect(chooser.ask([textQuestion()])).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("ai-gateway.vercel.sh");
  });

  it("a dedicated ANTHROPIC_API_KEY is the metered option, ahead of the Gateway", async () => {
    const urls: string[] = [];
    const chooser = createChooser({
      chooser: "jev",
      env: { ANTHROPIC_API_KEY: "a", AI_GATEWAY_API_KEY: "g", PATH: fakeBin([]) },
      jev: { evaluationModel: jevMock().model },
      model: { fetch: recordingFetch(urls), maxAttempts: 1 },
    });
    await expect(chooser.ask([textQuestion()])).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("api.anthropic.com");
  });

  it("no key and no CLI: Jev has no text fallback at all", () => {
    const chooser = createChooser({ chooser: "jev", env: { TYPESAFE_API_KEY: "t", PATH: fakeBin([]) } });
    expect(chooser.name).toBe("jev");
    // Nothing to delegate to: the text question reaches Jev itself, which refuses it.
    return expect(chooser.ask([textQuestion()])).rejects.toThrow(/text/i);
  });

  it("an explicit `chooser: model` still resolves to the API model, even with a CLI on PATH", async () => {
    const urls: string[] = [];
    const chooser = createChooser({
      chooser: "model",
      env: { AI_GATEWAY_API_KEY: "g", PATH: fakeBin(["claude", "codex"]) },
      model: { fetch: recordingFetch(urls), maxAttempts: 1 },
    });
    expect(chooser.name).toBe("model");
    await expect(chooser.ask([textQuestion()])).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(urls[0]).toContain("ai-gateway.vercel.sh");

    const anthropic: string[] = [];
    const direct = createChooser({
      chooser: "model",
      env: { ANTHROPIC_API_KEY: "a", AI_GATEWAY_API_KEY: "g", PATH: fakeBin(["claude"]) },
      model: { fetch: recordingFetch(anthropic), maxAttempts: 1 },
    });
    await expect(direct.ask([textQuestion()])).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(anthropic[0]).toContain("api.anthropic.com");
  });

  it("an installed but signed-out CLI hands the text on instead of ending the run, once", async () => {
    const cli = cliRunner("signed-out");
    const lm = languageMock(MODEL_ANSWER);
    const chooser = createChooser({
      chooser: "jev",
      env: { AI_GATEWAY_API_KEY: "g", PATH: fakeBin(["claude", "codex"]) },
      jev: { evaluationModel: jevMock().model },
      cli: { runner: cli },
      model: { model: lm.model },
    });
    expect((await chooser.ask([textQuestion()]))[0]?.text).toBe("from the api");
    expect(cli.calls).toEqual(["claude", "codex"]);

    // The chain stays where it landed: no second round of doomed CLI calls.
    expect((await chooser.ask([textQuestion()]))[0]?.text).toBe("from the api");
    expect(cli.calls).toEqual(["claude", "codex"]);
    expect(lm.calls).toHaveLength(2);
    expect(chooser.usage().textQuestions).toBe(2);
  });

  it("a signed-in CLI that fails for another reason is the answer, not a reason to start spending", async () => {
    const cli = cliRunner("broken");
    const lm = languageMock(MODEL_ANSWER);
    const chooser = createChooser({
      chooser: "jev",
      env: { AI_GATEWAY_API_KEY: "g", PATH: fakeBin(["claude"]) },
      jev: { evaluationModel: jevMock().model },
      cli: { runner: cli, maxAttempts: 1 },
      model: { model: lm.model },
    });
    await expect(chooser.ask([textQuestion()])).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(cli.calls).toEqual(["claude"]);
    expect(lm.calls).toEqual([]);
  });
});
