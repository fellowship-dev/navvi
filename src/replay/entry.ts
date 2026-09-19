import type { Locator, Page } from "playwright";
import { waitForSettle } from "../browser/guards.js";
import { allowedControl, isOnAllowedDomain, type Control } from "../browser/policy.js";
import type { Profile } from "../input/schema.js";
import type { CompiledScraper, LocatorAlternative, Status, StepExpect, TraceStep } from "../scraper/schema.js";
import type { Secret } from "../secrets/resolve.js";
import { urlPattern } from "../template/key.js";

/**
 * Entry modes and trace replay (R14, R24, R25, KTD14). A compiled list
 * scraper enters `direct` (every listing URL is a request) or `trace` (the
 * recorded steps replay once per crawler session, then pagination happens
 * in-page). Replay resolves each step by role and accessible name, trying the
 * recorded alternatives in order, and re-checks a click's recorded href or
 * form target against the domain and control policy before clicking. No model
 * is involved; a failed step is offered to the `onStepFailed` hook once.
 */

export type EntryMode = CompiledScraper["entry"]["mode"];

/** Record scrapers always enter directly; list scrapers follow their compiled entry. */
export function entryModeFor(scraper: CompiledScraper): EntryMode {
  return scraper.mode === "record" ? "direct" : scraper.entry.mode;
}

export interface ReplayPolicy {
  profile: Profile;
  startUrls: readonly string[];
  allowedDomains: readonly string[];
  allowMutations: readonly string[];
  /** The run's request guard (R26); a recorded href must also pass it. */
  isAllowedRequest?: ((url: string) => boolean) | undefined;
}

/**
 * What to do after a step failed: `retry` runs the same step once more,
 * `done` ends the replay as successful (navigation reached the target by
 * other means), `fail` ends it with `blocked_no_progress`.
 */
export type StepFailureAction = "retry" | "done" | "fail";

export interface ReplayTraceOptions {
  secrets: ReadonlyMap<string, Secret>;
  policy: ReplayPolicy;
  onStepFailed?: ((stepIndex: number, page: Page, reason: string) => Promise<StepFailureAction>) | undefined;
  /** Locator resolution and action timeout per step. Default 10 s. */
  stepTimeoutMs?: number | undefined;
  /** How long an `expect` waits. Default 10 s. */
  expectTimeoutMs?: number | undefined;
}

export type ReplayTraceResult =
  | { ok: true; steps: number }
  | { ok: false; status: Status; stepIndex: number; reason: string };

type Role = Parameters<Page["getByRole"]>[0];

class StepError extends Error {}
/** A policy refusal: never retried, never healed. */
class RefusedError extends Error {}
class HumanStepError extends Error {}

function describe(step: TraceStep): string {
  const alt = step.alternatives[0];
  return alt ? `${step.op} ${alt.role} "${alt.name}"` : step.op;
}

async function resolveLocator(page: Page, alternatives: readonly LocatorAlternative[], timeoutMs: number): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const alt of alternatives) {
      const locator = page.getByRole(alt.role as Role, { name: alt.name, exact: alt.exact }).first();
      if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) return locator;
    }
    await page.waitForTimeout(150);
  } while (Date.now() < deadline);
  throw new StepError(`no visible control matched ${alternatives.map((a) => `${a.role} "${a.name}"`).join(" / ")}`);
}

interface LiveControl {
  tag: string;
  type: string | undefined;
  href: string | undefined;
  autocomplete: string | undefined;
  nameAttr: string | undefined;
  form: { method: string; action: string } | null;
}

function readLiveControl(locator: Locator): Promise<LiveControl> {
  return locator.evaluate((el) => {
    const input = el as HTMLInputElement;
    const anchor = el as HTMLAnchorElement;
    const form = (el as HTMLButtonElement).form ?? el.closest("form");
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type")?.toLowerCase() ?? undefined,
      href: typeof anchor.href === "string" && anchor.href ? anchor.href : undefined,
      autocomplete: input.autocomplete || undefined,
      nameAttr: el.getAttribute("name") ?? undefined,
      form: form ? { method: (form.getAttribute("method") ?? "get").toLowerCase(), action: form.action || "" } : null,
    };
  });
}

function absolute(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function matchesExpect(page: Page, expect: StepExpect): Promise<void> | Promise<unknown> {
  if ("urlPattern" in expect) {
    const wanted = expect.urlPattern;
    return page.waitForURL(
      (url) => {
        try {
          return url.href.includes(wanted) || urlPattern([url.href]) === wanted;
        } catch {
          return false;
        }
      },
      { timeout: 0 },
    );
  }
  return page.getByRole(expect.role as Role, { name: expect.name }).first().waitFor({ state: "visible", timeout: 0 });
}

async function checkExpect(page: Page, expect: StepExpect, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepError(`expectation not met within ${timeoutMs}ms: ${JSON.stringify(expect)}`)), timeoutMs);
  });
  try {
    await Promise.race([matchesExpect(page, expect), timeout]);
  } catch (error) {
    if (error instanceof StepError) throw error;
    throw new StepError(`expectation failed: ${JSON.stringify(expect)}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

interface ReplayState {
  typedText: boolean;
  typedSecret: boolean;
}

/** R24 / R25 / KTD14 at replay: the recorded target and the live control both pass, else the click is refused. */
function checkClickPolicy(step: TraceStep, live: LiveControl, page: Page, policy: ReplayPolicy, state: ReplayState): void {
  const alt = step.alternatives[0];
  const targets: string[] = [];
  if (step.target?.href) targets.push(absolute(step.target.href, page.url()));
  if (step.target?.form) targets.push(absolute(step.target.form.action, page.url()));
  if (live.href) targets.push(live.href);
  if (live.form?.action) targets.push(live.form.action);
  for (const url of targets) {
    if (!isOnAllowedDomain(url, policy.startUrls, policy.allowedDomains)) {
      throw new RefusedError(`click target ${url} is off the allowed domains (R25)`);
    }
    if (policy.isAllowedRequest && !policy.isAllowedRequest(url)) {
      throw new RefusedError(`click target ${url} is refused by the request policy (R26)`);
    }
  }
  const form = step.target?.form ?? live.form;
  const control: Control = { role: alt?.role ?? "button", name: alt?.name ?? "", tag: live.tag };
  if (live.type) control.inputType = live.type;
  if (live.autocomplete) control.autocomplete = live.autocomplete;
  if (live.nameAttr) control.nameAttr = live.nameAttr;
  if (form) control.form = { method: form.method, hasTypedText: state.typedText, hasPasswordField: state.typedSecret, hasPaymentField: false };
  const decision = allowedControl(control, policy.profile, { allowMutations: policy.allowMutations });
  if (!decision.allowed) throw new RefusedError(`click on ${describe(step)} refused: ${decision.reason ?? "policy"}`);
}

async function runStep(page: Page, step: TraceStep, options: ReplayTraceOptions, state: ReplayState): Promise<void> {
  const stepTimeout = options.stepTimeoutMs ?? 10_000;
  switch (step.op) {
    case "human":
      throw new HumanStepError("the recorded trace needs a person at this step");
    case "wait":
      await waitForSettle(page, { maxMs: stepTimeout });
      return;
    case "scroll":
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await waitForSettle(page, { maxMs: stepTimeout });
      return;
    case "type": {
      const locator = await resolveLocator(page, step.alternatives, stepTimeout);
      if (step.secret !== undefined) {
        const secret = options.secrets.get(step.secret);
        if (!secret) throw new RefusedError(`secret {{secret:${step.secret}}} was not resolved`);
        const live = await readLiveControl(locator);
        if (live.type !== "password") throw new RefusedError(`secret {{secret:${step.secret}}} may only be typed into a password input (R24)`);
        await locator.fill(secret.reveal(), { timeout: stepTimeout });
        state.typedSecret = true;
      } else {
        await locator.fill(step.text ?? "", { timeout: stepTimeout });
        state.typedText = true;
      }
      return;
    }
    case "select": {
      const locator = await resolveLocator(page, step.alternatives, stepTimeout);
      await locator.selectOption(step.text ?? "", { timeout: stepTimeout });
      return;
    }
    case "click": {
      const locator = await resolveLocator(page, step.alternatives, stepTimeout);
      const live = await readLiveControl(locator);
      checkClickPolicy(step, live, page, options.policy, state);
      await locator.click({ timeout: stepTimeout });
      await waitForSettle(page, { idleMs: 300, maxMs: Math.min(stepTimeout, 5_000) }).catch(() => undefined);
      return;
    }
  }
}

/**
 * Replays a compiled trace on `page`, which is already at the entry URL.
 * Policy refusals and human steps end the replay at once; other failures go
 * to `onStepFailed` (default: fail) and at most one retry per step.
 */
export async function replayTrace(page: Page, scraper: CompiledScraper, options: ReplayTraceOptions): Promise<ReplayTraceResult> {
  const state: ReplayState = { typedText: false, typedSecret: false };
  const expectTimeout = options.expectTimeoutMs ?? 10_000;
  for (let index = 0; index < scraper.trace.length; index++) {
    const step = scraper.trace[index]!;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        await runStep(page, step, options, state);
        if (step.expect) await checkExpect(page, step.expect, expectTimeout);
        break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof HumanStepError) return { ok: false, status: "needs_human", stepIndex: index, reason };
        if (error instanceof RefusedError) return { ok: false, status: "blocked_no_progress", stepIndex: index, reason };
        if (attempts >= 2) return { ok: false, status: "blocked_no_progress", stepIndex: index, reason: `step ${index} (${describe(step)}) failed twice: ${reason}` };
        const action = options.onStepFailed ? await options.onStepFailed(index, page, reason) : "fail";
        if (action === "done") return { ok: true, steps: index + 1 };
        if (action === "fail") return { ok: false, status: "blocked_no_progress", stepIndex: index, reason: `step ${index} (${describe(step)}) failed: ${reason}` };
      }
    }
  }
  return { ok: true, steps: scraper.trace.length };
}
