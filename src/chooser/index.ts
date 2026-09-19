import { defaultChooser, type Chooser as ChooserId } from "../input/schema.js";
import { Budget } from "../billing/budget.js";
import { AgentChooser, type AgentChooserOptions } from "./agent.js";
import { JevChooser, type JevChooserOptions } from "./jev.js";
import { ModelChooser, type ModelChooserOptions } from "./model.js";
import type { Chooser } from "./chooser.js";

export * from "./chooser.js";
export * from "./questions.js";
export { AgentChooser, loadAnswersFile, mergeAnswers, questionKey, readQuestionsFile, QUESTIONS_START, QUESTIONS_END, PROTOCOL, type AgentChooserOptions, type AgentMode, type QuestionBatchFile, type StoredAnswer } from "./agent.js";
export { JevChooser, TypeSafeEvaluationModel, JEV_PRICE_PER_MILLION_INPUT_USD, JEV_MAX_STATE_TOKENS, JEV_GATEWAY_MODEL_ID, missingCredentialsMessage, type JevChooserOptions, type JevProvider } from "./jev.js";
export { ModelChooser, MODEL_PRICES, DEFAULT_MODEL_ID, DEFAULT_MODEL_STATE_CHARS, priceFor, type ModelChooserOptions } from "./model.js";
export { RecordedChooser, RecordingChooser, DEFAULT_RECORDED_DIR, type RecordedChooserOptions, type RecordingChooserOptions, type RecordedAnswerFile } from "./recorded.js";
export { Budget, BudgetExhaustedError, ModelUnavailableError, NeedsHumanError, NavviError } from "../billing/budget.js";

export interface CreateChooserOptions {
  /** R37: who answers. Defaults to `defaultChooser(env)` (KTD17: agent without a key). */
  chooser?: ChooserId;
  env?: NodeJS.ProcessEnv;
  budget?: Budget;
  /** Caller key for jev or model (R23). */
  apiKey?: string;
  agent?: Omit<AgentChooserOptions, "budget" | "env">;
  jev?: Omit<JevChooserOptions, "budget" | "env" | "apiKey">;
  model?: Omit<ModelChooserOptions, "budget" | "env" | "apiKey">;
}

/** One factory for the run: the selected backend, sharing one budget. */
export function createChooser(options: CreateChooserOptions = {}): Chooser {
  const env = options.env ?? process.env;
  const budget = options.budget ?? new Budget();
  const name = options.chooser ?? defaultChooser(env);
  switch (name) {
    case "agent":
      return new AgentChooser({ ...options.agent, budget, env });
    case "jev": {
      const text = options.jev?.textFallback ?? (env.ANTHROPIC_API_KEY || env.AI_GATEWAY_API_KEY ? new ModelChooser({ ...options.model, budget, env }) : undefined);
      return new JevChooser({ ...options.jev, apiKey: options.apiKey, budget, env, textFallback: text });
    }
    case "model":
      return new ModelChooser({ ...options.model, apiKey: options.apiKey, budget, env });
  }
}
