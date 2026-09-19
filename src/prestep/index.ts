import type { Page } from "playwright";
import { waitForSettle } from "../browser/guards.js";
import type { Profile } from "../input/schema.js";
import { credentialMessage, findCredential } from "../input/credentials.js";
import type { Status, TraceStep } from "../scraper/schema.js";
import { classifyBlocked, type BlockedStatus } from "./blocked.js";
import { dismissConsent } from "./consent.js";
import { consoleNotifier, handoffToHuman, type Notifier } from "./human.js";
import { clickTurnstile } from "./turnstile.js";

/**
 * Pre-steps (U6): what runs after the first navigation and before any chooser
 * question or compile charge. In order: R27 credential refusal, consent
 * dismissal, one Turnstile click, blocked classification, and locally an
 * attended human handoff (R41). Every click is returned as a trace step so
 * replay repeats it without a model.
 *
 * Decisions where the plan was open:
 * - A credential in the goal, description or prompt returns the outcome
 *   (`blocked_login_required`) rather than throwing; `InputSchema` already
 *   refuses it at validation, so this is a second line for callers that
 *   build the options by hand. The reason is the shared R27 message.
 * - A first run whose human handoff times out ends `blocked_bot_detection`
 *   with reason "human timeout ...". `needs_human` is reserved for a replay
 *   that reaches a recorded human step and for chooser question batches.
 * - Attended is the caller's flag; `APIFY_IS_AT_HOME` in `env` always wins
 *   and makes the run unattended.
 */

export { BOT_CHALLENGE_SELECTORS, BOT_CHALLENGE_TEXT, LOGIN_HINTS, classifyBlocked } from "./blocked.js";
export { CONSENT_NAME_PATTERN, CONSENT_RULES, dismissConsent } from "./consent.js";
export { consoleNotifier, handoffToHuman, humanStep, type Notifier } from "./human.js";
export { TURNSTILE_SELECTORS, clickTurnstile } from "./turnstile.js";

export type PreStepOutcome = { status: null; steps: TraceStep[] } | { status: Status; steps: TraceStep[]; reason: string };

export interface PreStepOptions {
  goal?: string | undefined;
  description?: string | undefined;
  prompt?: string | undefined;
  profile: Profile;
  /** Locally with a person present: a bot challenge is handed to them (R41). */
  attended: boolean;
  /** Under `local`, secrets let navigation log in, so a login wall is not blocking. */
  hasSecrets?: boolean | undefined;
  notify?: Notifier | undefined;
  /** How long the human handoff waits. Default 5 minutes. */
  humanTimeoutMs?: number | undefined;
  humanPollMs?: number | undefined;
  /** Status of the navigation response that produced the current document, when the caller has it. */
  response?: { status?: number | undefined } | undefined;
  /** How long the Turnstile step waits for a token after its click. */
  turnstileWaitMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export const DEFAULT_HUMAN_TIMEOUT_MS = 5 * 60_000;

const click = (role: string, name: string): TraceStep => ({ op: "click", alternatives: [{ role, name, exact: true }] });

/** R27: the first credential literal among the run's texts, as an outcome, or null. */
function credentialOutcome(opts: PreStepOptions): PreStepOutcome | null {
  const found = findCredential(opts);
  return found ? { status: "blocked_login_required", steps: [], reason: credentialMessage(found.kind, found.where) } : null;
}

function blockedReason(status: BlockedStatus, detail?: string): string {
  const base = status === "blocked_bot_detection" ? "the page is a bot challenge" : "the page is a login wall";
  return detail ? `${base} (${detail})` : base;
}

export async function runPreSteps(page: Page, opts: PreStepOptions): Promise<PreStepOutcome> {
  const refused = credentialOutcome(opts);
  if (refused) return refused;

  const env = opts.env ?? process.env;
  const attended = opts.attended && !env.APIFY_IS_AT_HOME;
  const notify = opts.notify ?? consoleNotifier;
  const steps: TraceStep[] = [];

  const consent = await dismissConsent(page);
  for (const c of consent.clicked) steps.push(click(c.role, c.name));

  const turnstile = await clickTurnstile(page, { waitMs: opts.turnstileWaitMs });
  if (turnstile.clicked && turnstile.control) steps.push(click(turnstile.control.role, turnstile.control.name));

  let blocked = await classifyBlocked(page, opts.response);
  if (blocked === null) return { status: null, steps };

  if (blocked === "blocked_login_required") {
    if (opts.profile === "local" && opts.hasSecrets) return { status: null, steps };
    const detail = opts.profile === "local" ? "no secrets configured" : "store profile never logs in";
    return { status: blocked, steps, reason: blockedReason(blocked, detail) };
  }

  // blocked_bot_detection
  if (!attended) {
    const detail = env.APIFY_IS_AT_HOME ? "unattended on Apify" : "unattended run";
    return { status: blocked, steps, reason: blockedReason(blocked, detail) };
  }

  const handoff = await handoffToHuman(page, {
    attended,
    notify,
    timeoutMs: opts.humanTimeoutMs ?? DEFAULT_HUMAN_TIMEOUT_MS,
    pollMs: opts.humanPollMs,
    isStillBlocked: async () => (await classifyBlocked(page)) === "blocked_bot_detection",
    env,
  });
  if (!handoff.resolved) {
    const detail = handoff.reason === "human timeout" ? `human timeout after ${handoff.waitedMs}ms` : handoff.reason;
    return { status: blocked, steps, reason: blockedReason(blocked, detail) };
  }

  // The person changed the page: record it, settle, dismiss any consent that appeared, classify once more.
  steps.push(handoff.step);
  await waitForSettle(page, { idleMs: 300, maxMs: 3_000 }).catch(() => undefined);
  const again = await dismissConsent(page);
  for (const c of again.clicked) steps.push(click(c.role, c.name));

  blocked = await classifyBlocked(page);
  if (blocked === null) return { status: null, steps };
  if (blocked === "blocked_login_required" && opts.profile === "local" && opts.hasSecrets) return { status: null, steps };
  return { status: blocked, steps, reason: blockedReason(blocked, "still blocked after the human step") };
}
