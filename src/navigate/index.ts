import type { Page } from "playwright";
import type { NavigateOptions, NavigateResult } from "./agent.js";

/**
 * Navigate phase (U7) entry point. The crawler injects a `Navigator` so the
 * goal-driven loop stays swappable (recorded answers in tests, a live chooser
 * in runs) without the crawler knowing about choosers.
 */

export {
  navigate,
  DONE_THRESHOLD,
  NO_PROGRESS_LIMIT,
  MAX_REDECISIONS,
  OPERATIONS,
  type BlockedBy,
  type NavigateOptions,
  type NavigateResult,
  type NavigateStatus,
  type Operation,
} from "./agent.js";
export { generateText, parseTextAnswer, policyControl, type TextHelperInput, type TextHelperResult } from "./textHelper.js";
export { TraceRecorder, captureExpectation, readLandmarks, recordStep, secretNameFor, uniqueName, urlPatternFor, type Landmark, type RecordStepInput } from "./trace.js";

/** Everything `navigate` needs besides the page and the goal. */
export type NavigatorContext = Omit<NavigateOptions, "goal">;

/** The shape the crawler (U8) injects: drive `page` toward `goal`, return the trace and status. */
export type Navigator = (page: Page, goal: string, ctx: NavigatorContext) => Promise<NavigateResult>;
