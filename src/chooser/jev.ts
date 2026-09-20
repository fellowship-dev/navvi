import { experimental_evaluate, type Experimental_EvaluationModel, type Experimental_EvaluationQuestion } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import {
  APICallError,
  type Experimental_EvaluationModelV4,
  type Experimental_EvaluationModelV4Input,
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
  type JsonValue,
  type Price,
  type Question,
  type ZeroDataRetentionState,
} from "./chooser.js";
import { jevFraming, NONE_OPTION } from "./questions.js";
import { wellFormed } from "../util/text.js";

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
  /** Criteria keys in option order (choice only), `none` last unless gated. */
  keys: string[];
  /** The presence gate asked alongside a gated choice: yes means an option, no means `none`. */
  gate?: Experimental_EvaluationQuestion;
}

/** Question id of the presence gate that accompanies a gated choice. */
export const gateId = (id: string): string => `${id}.present`;

/**
 * A gated choice stands when the value is on the page and the chosen candidate
 * is it: P(present) x P(choice) at or above this. Measured on the AE8 healing
 * batches (docs/jev-hillclimb.md, step 6): present fields score 0.37 to 0.49,
 * the out-of-stock price 0.07; a plain P(present) < 0.5 veto flipped the
 * stock field one run in five at 0.50 to 0.55.
 */
export const GATE_JOINT_THRESHOLD = 0.2;

/** The question's own structured facts: its context without the batch-wide `shared` part. */
function ownContext(q: Question): { [key: string]: JsonValue } | undefined {
  if (!q.context) return undefined;
  const { shared: _shared, ...own } = q.context;
  return own;
}

/**
 * The state a batch is asked over: the structured shared facts when the
 * questions carry them (every question in a batch shares one), else the text.
 */
export function toEvaluationState(batch: readonly Question[]): Experimental_EvaluationModelV4Input {
  const shared = batch[0]?.context?.shared;
  return shared !== undefined ? asInput(shared) : (batch[0]?.state ?? "");
}

/** A JSON value as an evaluation input: scalars other than strings are wrapped. */
function asInput(value: JsonValue): Experimental_EvaluationModelV4Input {
  if (typeof value === "string" || Array.isArray(value) || (typeof value === "object" && value !== null)) return value;
  return { value };
}

/**
 * Map a Navvi question to the AI SDK evaluation question. Choice questions
 * always end with `none`. With structured context the instructions and the
 * criteria are JSON (docs/jev-hillclimb.md); without it, the premise and the
 * option strings.
 */
export function toEvaluationQuestion(q: Question): EvaluationQuestionMapping {
  const own = ownContext(q);
  switch (q.kind) {
    case "choice": {
      const options = q.options ?? [];
      const keys = optionKeys(options);
      const criteria: Record<string, Experimental_EvaluationModelV4Input | null> = {};
      const structured = q.optionContext && q.optionContext.length === options.length ? q.optionContext : undefined;
      keys.forEach((key, i) => (criteria[key] = structured ? asInput(structured[i] ?? null) : (options[i] ?? null)));
      const decision = typeof own?.decision === "string" ? own.decision : undefined;
      const instructions = own ? jevFraming.instructions(q.premise, own) : q.premise;
      const gate = own && jevFraming.gated(decision) ? jevFraming.presence(own, structured ?? options) : undefined;
      if (gate && options.length > 0) {
        return { question: { type: "choice", instructions, criteria }, keys, gate: { type: "boolean", instructions: gate } };
      }
      criteria[NONE_OPTION] = own ? asInput(jevFraming.none(decision)) : "None of the options is right.";
      return { question: { type: "choice", instructions, criteria }, keys: [...keys, NONE_OPTION] };
    }
    case "boolean":
      return { question: { type: "boolean", instructions: own ? jevFraming.instructions(q.premise, own) : q.premise }, keys: [] };
    case "score":
      return { question: { type: "score", instructions: q.premise, criteria: q.options ?? [] }, keys: [] };
    case "text":
      throw new ConfigurationError(`jev cannot answer text question "${q.id}"; configure a text model or use chooser: agent`);
  }
}

/**
 * Criteria keys are short (`option_0`, `option_1`, ...); the option text is the
 * criterion's description. TypeSafe reads the description, and a long option
 * text as the key made the choice harder to answer in live runs.
 */
function optionKeys(options: string[]): string[] {
  return options.map((_o, i) => `option_${i}`);
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
    const gated = new Set<string>();
    for (const q of batch) {
      const mapped = toEvaluationQuestion(q);
      questions[q.id] = mapped.question;
      keysById.set(q.id, mapped.keys);
      if (mapped.gate) {
        questions[gateId(q.id)] = mapped.gate;
        gated.add(q.id);
      }
    }
    const state = toEvaluationState(batch);
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
        let index = position < 0 || position >= options.length ? null : position;
        if (gated.has(q.id) && index !== null) {
          const gate = result.answers[gateId(q.id)];
          const chosen = answer.probabilities?.[answer.choice] ?? 1;
          if (gate?.type === "boolean" && gate.probability * chosen < GATE_JOINT_THRESHOLD) index = null;
        }
        return { id: q.id, index, probabilities };
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
    // DOM strings can contain lone surrogates (including text clipped in the page).
    // JSON permits escaped surrogates, but TypeSafe rejects them as invalid Unicode.
    const body = JSON.stringify({ state: options.state, model: this.modelId, questions },
      (_key, value: unknown) => typeof value === "string" ? wellFormed(value) : value);
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
      // The API rounds probabilities to two decimals; declaring three made twelve-option answers fail the SDK's sum check.
      rounding: { probabilityDecimals: 2, scoreDecimals: 3 },
      warnings: [],
      response: { modelId: parsed.model },
    };
  }
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "number");
}
