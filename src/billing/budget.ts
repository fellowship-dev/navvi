import { LIMITS } from "../input/schema.js";
import type { Status } from "../scraper/schema.js";

/**
 * R28: per-run chooser budget and the typed errors that end a run.
 * Status codes match the R6 status union (src/scraper/schema.ts).
 */

export type BudgetLimits = {
  chooserInputTokens: number;
  textHelperCalls: number;
};

export type BudgetResource = keyof BudgetLimits;

/** Every status a run can end with, plus the one for a run that never starts. */
export type RunStatus = Status | "configuration_error";

/** Base class for every error that carries a run status. */
export class NavviError extends Error {
  readonly status: RunStatus;
  constructor(status: RunStatus, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.status = status;
  }
}

export class BudgetExhaustedError extends NavviError {
  readonly resource: BudgetResource;
  readonly limit: number;
  constructor(resource: BudgetResource, limit: number) {
    super("budget_exhausted", `chooser budget exhausted: ${resource} limit of ${limit} reached`);
    this.resource = resource;
    this.limit = limit;
  }
}

export class ModelUnavailableError extends NavviError {
  readonly attempts: number;
  constructor(message: string, options?: { cause?: unknown; attempts?: number }) {
    super("model_unavailable", message, { cause: options?.cause });
    this.attempts = options?.attempts ?? 1;
  }
}

export class NeedsHumanError extends NavviError {
  /** Resume token when a question batch was written to storage/questions. */
  readonly token: string | undefined;
  readonly questionsFile: string | undefined;
  constructor(message: string, options?: { cause?: unknown; token?: string; questionsFile?: string }) {
    super("needs_human", message, { cause: options?.cause });
    this.token = options?.token;
    this.questionsFile = options?.questionsFile;
  }
}

/** Counters for one run. Every charge over the limit throws `BudgetExhaustedError`. */
export class Budget {
  readonly limits: BudgetLimits;
  private inputTokens = 0;
  private textCalls = 0;

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = {
      chooserInputTokens: limits.chooserInputTokens ?? LIMITS.chooserInputTokens,
      textHelperCalls: limits.textHelperCalls ?? LIMITS.textHelperCalls,
    };
  }

  /** Check that `tokens` more input tokens fit without charging them. */
  assertInputTokens(tokens: number): void {
    if (this.inputTokens + tokens > this.limits.chooserInputTokens) {
      throw new BudgetExhaustedError("chooserInputTokens", this.limits.chooserInputTokens);
    }
  }

  chargeInputTokens(tokens: number): void {
    this.assertInputTokens(tokens);
    this.inputTokens += tokens;
  }

  chargeTextCall(): void {
    if (this.textCalls + 1 > this.limits.textHelperCalls) {
      throw new BudgetExhaustedError("textHelperCalls", this.limits.textHelperCalls);
    }
    this.textCalls += 1;
  }
}
