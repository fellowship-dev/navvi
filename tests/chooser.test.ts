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
import { createChooser } from "../src/chooser/index.js";
import { premises } from "../src/chooser/questions.js";
import { Budget, BudgetExhaustedError, ModelUnavailableError, NeedsHumanError } from "../src/billing/budget.js";

const SCRATCH = process.env.CLAUDE_SCRATCHPAD ?? tmpdir();
const RECORDED_DIR = join(process.cwd(), "tests", "recorded");
const STATE = "<ul><li class=p>Paracetamol 500mg $1.990</li><li class=p>Ibuprofeno 400mg $2.490</li></ul>";

function fixture(id: string): Answer & { inputTokens: number; outputTokens: number } {
  return JSON.parse(readFileSync(join(RECORDED_DIR, "pharmacy", `${id}.json`), "utf8")) as Answer & {
    inputTokens: number;
    outputTokens: number;
  };
}

function batch(): Question[] {
  return [
    { id: "group", kind: "choice", premise: premises.groupChoice("price"), options: ["li.x", "li.p", "div.q"], state: STATE },
    { id: "visible", kind: "boolean", premise: premises.consentBoolean(), state: STATE },
    { id: "quality", kind: "score", premise: premises.fieldQuality("price"), options: ["wrong", "partial", "right"], state: STATE },
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
    const qs: Question[] = [...batch(), { id: "title", kind: "text", premise: premises.textHelper("store name"), state: STATE, maxLength: 50 }];
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
    const q: Question = { id: "title", kind: "text", premise: premises.textHelper("store name"), state: STATE, maxLength: 100 };
    const [a] = await chooser.ask([q]);
    expect(a?.text).toBe("Store B");
    expect(chooser.usage().textQuestions).toBe(1);
    await expect(chooser.ask([q])).rejects.toBeInstanceOf(BudgetExhaustedError);
    const long: Question = { ...q, state: "x".repeat(TEXT_INPUT_CAP + 1) };
    await expect(new ScriptedChooser([]).ask([long])).rejects.toBeInstanceOf(StateTooLargeError);
  });
});

describe("Budget (R28)", () => {
  it("raises on the sixth healing event", () => {
    const budget = new Budget();
    for (let i = 0; i < LIMITS.healingEvents; i++) budget.chargeHealingEvent();
    expect(() => budget.chargeHealingEvent()).toThrow(BudgetExhaustedError);
    try {
      budget.chargeHealingEvent();
    } catch (e) {
      expect((e as BudgetExhaustedError).status).toBe("budget_exhausted");
      expect((e as BudgetExhaustedError).resource).toBe("healingEvents");
    }
    expect(budget.snapshot().healingEvents).toBe(LIMITS.healingEvents);
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
    const qs: Question[] = [...batch(), { id: "title", kind: "text", premise: premises.textHelper("store name"), state: STATE, maxLength: 40 }];
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
    const resumed = new AgentChooser({ stdin: null, stdout: new PassThrough(), questionsDir: dir, answers: loadAnswersFile(answersPath), resumeToken: token, env: {} });
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
            group: { type: "choice", choice: "li.p", probabilities: { "li.x": 0.05, "li.p": 0.9, "div.q": 0.05, none: 0 }, confidence: 0.9 },
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
    const qs: Question[] = [...batch(), { id: "title", kind: "text", premise: premises.textHelper("store name"), state: STATE, maxLength: 40 }];
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
