import { generateObject, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { z } from "zod";
import { BaseChooser, ConfigurationError, DEFAULT_STATE_CHARS, DEFAULT_TEXT_MAX_LENGTH, type BackendResult, type BaseChooserOptions, type ChooserName, type Price, type Question } from "./chooser.js";
import { missingCredentialsMessage } from "./jev.js";
import { NONE_OPTION } from "./questions.js";

/**
 * KTD2 / KTD11: any AI SDK language model answering a JSON schema of indices.
 * Haiku is the tested default. The same backend writes typed text for `text`
 * questions.
 */

export const DEFAULT_MODEL_ID = "claude-haiku-4-5";
export const DEFAULT_MODEL_STATE_CHARS = DEFAULT_STATE_CHARS;
export const MODEL_TIMEOUT_MS = 60_000;

/** List prices, USD per million tokens (Anthropic first-party rates, cached 2026-06). Unknown ids use the Haiku row. */
export const MODEL_PRICES: Record<string, Price> = {
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
  "claude-sonnet-5": { inputPerMillion: 2, outputPerMillion: 10 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
};

export function priceFor(modelId: string): Price {
  const bare = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  const known = Object.keys(MODEL_PRICES).find((id) => bare === id || bare.startsWith(`${id}-`));
  return MODEL_PRICES[known ?? DEFAULT_MODEL_ID]!;
}

export interface ModelChooserOptions extends BaseChooserOptions {
  /** Injected model instance (tests, custom providers). */
  model?: LanguageModel;
  modelId?: string;
  /** Caller key (R23). Wins over the environment. */
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const AnswerBatchSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      index: z.number().int().nullable(),
      text: z.string().optional(),
    }),
  ),
});

function resolveModel(options: ModelChooserOptions, env: NodeJS.ProcessEnv): { model: LanguageModel; modelId: string; secret?: string } {
  const modelId = options.modelId ?? env.NAVVI_MODEL ?? DEFAULT_MODEL_ID;
  if (options.model) return { model: options.model, modelId: typeof options.model === "string" ? options.model : options.model.modelId };
  const anthropicKey = options.apiKey ?? env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return { model: createAnthropic({ apiKey: anthropicKey, fetch: options.fetch })(modelId), modelId, secret: anthropicKey };
  }
  if (env.AI_GATEWAY_API_KEY) {
    const gatewayId = modelId.includes("/") ? modelId : `anthropic/${modelId}`;
    return { model: createGateway({ apiKey: env.AI_GATEWAY_API_KEY, fetch: options.fetch }).languageModel(gatewayId), modelId, secret: env.AI_GATEWAY_API_KEY };
  }
  throw new ConfigurationError(missingCredentialsMessage("model"));
}

export function renderQuestions(batch: Question[]): string {
  return batch
    .map((q) => {
      switch (q.kind) {
        case "choice":
          return `[${q.id}] choice: ${q.premise}\n${(q.options ?? []).map((o, i) => `  ${i}: ${o}`).join("\n")}\n  null: ${NONE_OPTION}`;
        case "boolean":
          return `[${q.id}] boolean: ${q.premise}\n  0: no\n  1: yes`;
        case "score":
          return `[${q.id}] score: ${q.premise}\n${(q.options ?? []).map((o, i) => `  ${i}: ${o}`).join("\n")}`;
        case "text": {
          const target = q.schema !== undefined ? `JSON matching ${JSON.stringify(q.schema)}` : `plain text, at most ${q.maxLength ?? DEFAULT_TEXT_MAX_LENGTH} characters`;
          return `[${q.id}] text: ${q.premise}\n  answer in "text" (${target}) with "index": null`;
        }
      }
    })
    .join("\n\n");
}

export const SYSTEM_PROMPT =
  "You answer questions about a web page state. For every question return exactly one entry in answers with its id. " +
  "Choice: the index of the best option, or null when none fits. Boolean: 1 for yes, 0 for no. Score: the index of the matching level. " +
  "Text: the requested text in the text field with index null. Never add other fields, never explain.";

export class ModelChooser extends BaseChooser {
  readonly name: ChooserName = "model";
  readonly modelId: string;
  protected readonly failureStatus = "model_unavailable" as const;
  protected readonly price: Price;
  private readonly model: LanguageModel;
  private readonly timeoutMs: number;

  constructor(options: ModelChooserOptions = {}) {
    super({ ...options, maxStateChars: options.maxStateChars ?? DEFAULT_MODEL_STATE_CHARS });
    const resolved = resolveModel(options, options.env ?? process.env);
    this.model = resolved.model;
    this.modelId = resolved.modelId;
    this.price = priceFor(this.modelId);
    this.timeoutMs = options.timeoutMs ?? MODEL_TIMEOUT_MS;
    if (resolved.secret) this.secrets = [...this.secrets, resolved.secret];
  }

  protected async callBackend(batch: Question[]): Promise<BackendResult> {
    const result = await generateObject({
      model: this.model,
      schema: AnswerBatchSchema,
      schemaName: "answers",
      system: SYSTEM_PROMPT,
      prompt: `STATE:\n${batch[0]?.state ?? ""}\n\nQUESTIONS:\n${renderQuestions(batch)}`,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(this.timeoutMs),
    });
    return { answers: result.object.answers, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, zeroDataRetention: "not_applicable" };
  }
}
