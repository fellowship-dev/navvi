import { experimental_evaluate, type Experimental_EvaluationModel, type Experimental_EvaluationQuestion } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import {
  APICallError,
  type Experimental_EvaluationModelV4,
  type Experimental_EvaluationModelV4CallOptions,
  type Experimental_EvaluationModelV4Result,
  type JSONValue,
} from "@ai-sdk/provider";
import {
  BaseChooser,
  CHARS_PER_TOKEN,
  ConfigurationError,
  type BackendResult,
  type BaseChooserOptions,
  type ChooserName,
  type Price,
  type Question,
  type ZeroDataRetentionState,
} from "./chooser.js";
import { NONE_OPTION } from "./questions.js";

/**
 * KTD2: TypeSafe Jev through AI SDK `experimental_evaluate`, either via Vercel
 * AI Gateway (model id `typesafe-ai/jev`) or the direct TypeSafe API behind
 * the same evaluation-model interface. Jev cannot write text: `text`
 * questions need a `textFallback` chooser.
 */

/** List price, USD per million input tokens; output is free. */
export const JEV_PRICE_PER_MILLION_INPUT_USD = 0.042;
/** Jev context: 32k tokens for state plus the longest question. */
export const JEV_MAX_STATE_TOKENS = 32_000;
export const JEV_GATEWAY_MODEL_ID = "typesafe-ai/jev";
export const JEV_DIRECT_MODEL_ID = "jev-latest";
export const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_TIMEOUT_MS = 15_000;

export type JevProvider = "gateway" | "typesafe";

export interface JevChooserOptions extends BaseChooserOptions {
  /** Caller key (R23). Wins over the environment. */
  apiKey?: string;
  /** Which API the key belongs to; defaults to gateway for an explicit key. */
  provider?: JevProvider;
  env?: NodeJS.ProcessEnv;
  /** Injected model for tests and custom providers. */
  evaluationModel?: Experimental_EvaluationModel;
  fetch?: typeof fetch;
  timeoutMs?: number;
  zeroDataRetention?: boolean;
}

export function missingCredentialsMessage(chooser: "jev" | "model"): string {
  return (
    `chooser "${chooser}" has no credentials. Set AI_GATEWAY_API_KEY (Vercel AI Gateway), ` +
    `TYPESAFE_API_KEY (direct Jev) or ANTHROPIC_API_KEY (model chooser), pass the key in the run input, ` +
    `or use \`chooser: agent\`, which needs no key.`
  );
}

type Selection = { provider: JevProvider; apiKey: string };

function selectProvider(options: JevChooserOptions, env: NodeJS.ProcessEnv): Selection {
  if (options.apiKey) return { provider: options.provider ?? "gateway", apiKey: options.apiKey };
  if (options.provider === "gateway" && env.AI_GATEWAY_API_KEY) return { provider: "gateway", apiKey: env.AI_GATEWAY_API_KEY };
  if (options.provider === "typesafe" && env.TYPESAFE_API_KEY) return { provider: "typesafe", apiKey: env.TYPESAFE_API_KEY };
  if (!options.provider && env.AI_GATEWAY_API_KEY) return { provider: "gateway", apiKey: env.AI_GATEWAY_API_KEY };
  if (!options.provider && env.TYPESAFE_API_KEY) return { provider: "typesafe", apiKey: env.TYPESAFE_API_KEY };
  throw new ConfigurationError(missingCredentialsMessage("jev"));
}

export interface EvaluationQuestionMapping {
  question: Experimental_EvaluationQuestion;
  /** Criteria keys in option order (choice only), `none` last. */
  keys: string[];
}

/** Map a Navvi question to the AI SDK evaluation question. Choice questions always end with `none`. */
export function toEvaluationQuestion(q: Question): EvaluationQuestionMapping {
  switch (q.kind) {
    case "choice": {
      const options = q.options ?? [];
      const keys = optionKeys(options);
      const criteria: Record<string, string | null> = {};
      keys.forEach((key, i) => (criteria[key] = options[i] ?? null));
      criteria[NONE_OPTION] = "None of the options is right.";
      return { question: { type: "choice", instructions: q.premise, criteria }, keys: [...keys, NONE_OPTION] };
    }
    case "boolean":
      return { question: { type: "boolean", instructions: q.premise }, keys: [] };
    case "score":
      return { question: { type: "score", instructions: q.premise, criteria: q.options ?? [] }, keys: [] };
    case "text":
      throw new ConfigurationError(`jev cannot answer text question "${q.id}"; configure a text model or use chooser: agent`);
  }
}

/** Criteria keys are the option texts when unique and not `none`; otherwise index-prefixed slugs. */
function optionKeys(options: string[]): string[] {
  const plain = options.every((o) => o.length > 0 && o !== NONE_OPTION) && new Set(options).size === options.length;
  if (plain) return options;
  return options.map((option, i) => `${i}_${option.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 40) || "option"}`);
}

export class JevChooser extends BaseChooser {
  readonly name: ChooserName = "jev";
  readonly provider: JevProvider | "injected";
  protected readonly failureStatus = "model_unavailable" as const;
  protected readonly price: Price = { inputPerMillion: JEV_PRICE_PER_MILLION_INPUT_USD, outputPerMillion: 0 };
  private readonly model: Experimental_EvaluationModel;
  private readonly timeoutMs: number;
  private readonly requestZeroDataRetention: boolean;

  constructor(options: JevChooserOptions = {}) {
    super({ ...options, maxStateChars: options.maxStateChars ?? JEV_MAX_STATE_TOKENS * CHARS_PER_TOKEN });
    this.timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
    this.requestZeroDataRetention = options.zeroDataRetention ?? true;
    this.zeroDataRetentionDefault = "unknown";
    if (options.evaluationModel) {
      this.provider = "injected";
      this.model = options.evaluationModel;
      return;
    }
    const selection = selectProvider(options, options.env ?? process.env);
    this.provider = selection.provider;
    this.secrets = [...this.secrets, selection.apiKey];
    this.model =
      selection.provider === "gateway"
        ? createGateway({ apiKey: selection.apiKey, fetch: options.fetch }).evaluationModel(JEV_GATEWAY_MODEL_ID)
        : new TypeSafeEvaluationModel({ apiKey: selection.apiKey, fetch: options.fetch });
  }

  protected async callBackend(batch: Question[]): Promise<BackendResult> {
    const questions: Record<string, Experimental_EvaluationQuestion> = {};
    const keysById = new Map<string, string[]>();
    for (const q of batch) {
      const mapped = toEvaluationQuestion(q);
      questions[q.id] = mapped.question;
      keysById.set(q.id, mapped.keys);
    }
    const state = batch[0]?.state ?? "";
    const result = await experimental_evaluate({
      model: this.model,
      state,
      questions,
      // The chooser owns retries and backoff (BaseChooser); the SDK must not multiply them.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(this.timeoutMs),
      providerOptions: { gateway: { zeroDataRetention: this.requestZeroDataRetention } },
    });
    const answers = batch.map((q) => {
      const answer = result.answers[q.id];
      const options = q.options ?? [];
      if (!answer) return { id: q.id };
      if (answer.type === "choice") {
        const keys = keysById.get(q.id) ?? [];
        const position = keys.indexOf(answer.choice);
        const probabilities = answer.probabilities ? keys.slice(0, options.length).map((k) => answer.probabilities?.[k] ?? 0) : undefined;
        return { id: q.id, index: position < 0 || position >= options.length ? null : position, probabilities };
      }
      if (answer.type === "boolean") {
        return { id: q.id, index: answer.probability >= 0.5 ? 1 : 0, probability: answer.probability };
      }
      const probabilities = answer.probabilities ? options.map((_o, i) => answer.probabilities?.[String(i)] ?? 0) : undefined;
      return { id: q.id, index: Math.min(options.length - 1, Math.max(0, Math.round(answer.score))), probabilities };
    });
    const gateway = result.providerMetadata?.gateway;
    const zdr: ZeroDataRetentionState =
      gateway && typeof gateway === "object" && (gateway as Record<string, JSONValue | undefined>).zeroDataRetention === true ? "confirmed" : "unknown";
    return { answers, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, zeroDataRetention: zdr };
  }
}

/**
 * One-file direct TypeSafe provider: POST /v1/systemone with the same state
 * and questions, `noul` standing in for `boolean`.
 */
export class TypeSafeEvaluationModel implements Experimental_EvaluationModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "typesafe";
  readonly modelId: string;
  readonly supportedQuestionTypes = ["choice", "boolean", "score"] as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(options: { apiKey: string; fetch?: typeof fetch; modelId?: string; url?: string }) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.modelId = options.modelId ?? JEV_DIRECT_MODEL_ID;
    this.url = options.url ?? TYPESAFE_API_URL;
  }

  async doEvaluate(options: Experimental_EvaluationModelV4CallOptions): Promise<Experimental_EvaluationModelV4Result> {
    const questions: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(options.questions)) {
      questions[id] = q.type === "boolean" ? { ...q, type: "noul" } : q;
    }
    const body = JSON.stringify({ state: options.state, model: this.modelId, questions });
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, ...options.headers },
      body,
      signal: options.abortSignal,
    });
    if (!response.ok) {
      throw new APICallError({
        message: `TypeSafe API responded ${response.status}`,
        url: this.url,
        requestBodyValues: {},
        statusCode: response.status,
        isRetryable: [408, 409, 429, 500, 502, 503, 504, 529].includes(response.status),
      });
    }
    const parsed = (await response.json()) as {
      model?: string;
      answers?: Record<string, Record<string, unknown>>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const answers: Experimental_EvaluationModelV4Result["answers"] = {};
    for (const [id, raw] of Object.entries(parsed.answers ?? {})) {
      const probabilities = isNumberRecord(raw.probabilities) ? raw.probabilities : undefined;
      if (raw.type === "noul" && typeof raw.noul === "number") {
        answers[id] = { type: "boolean", probability: raw.noul };
      } else if (raw.type === "choice" && typeof raw.choice === "string") {
        answers[id] = { type: "choice", choice: raw.choice, probabilities };
      } else if (raw.type === "score" && typeof raw.score === "number") {
        answers[id] = { type: "score", score: raw.score, probabilities };
      }
    }
    return {
      answers,
      usage: { inputTokens: parsed.usage?.input_tokens, outputTokens: parsed.usage?.output_tokens },
      rounding: { probabilityDecimals: 3, scoreDecimals: 3 },
      warnings: [],
      response: { modelId: parsed.model },
    };
  }
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "number");
}
