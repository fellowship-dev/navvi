import type { Locator, Page } from "playwright";
import { enterText } from "../browser/typing.js";
import { waitForSettle } from "../browser/guards.js";
import { allowedControl, isOnAllowedDomain, type Control } from "../browser/policy.js";
import { ensureSnapshotScript, type AriaRole } from "../browser/snapshot.js";
import type { Profile } from "../input/schema.js";
import { isHttpHref, matchesUrlPattern } from "../navigate/trace.js";
import { resolveUrl } from "../scraper/extract.js";
import type { CompiledScraper, LocatorAlternative, Status, StepExpect, TraceStep } from "../scraper/schema.js";
import type { Secret } from "../secrets/resolve.js";

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
 * What to do after a step failed: `retry` runs the step once more (the given
 * `step`, a healed copy, replaces the captured one), `done` ends the replay as
 * successful (navigation reached the target by other means), `fail` ends it
 * with `blocked_no_progress`.
 */
export type StepFailureAction = { action: "retry"; step?: TraceStep | undefined } | { action: "done" } | { action: "fail" };

export interface ReplayTraceOptions {
  secrets: ReadonlyMap<string, Secret>;
  policy: ReplayPolicy;
  onStepFailed?: ((stepIndex: number, page: Page, reason: string) => Promise<StepFailureAction>) | undefined;
}

/** Locator resolution and action timeout per step. */
const STEP_TIMEOUT_MS = 10_000;
/** How long an `expect` waits. */
const EXPECT_TIMEOUT_MS = 10_000;

export type ReplayTraceResult =
  | { ok: true; steps: number }
  | { ok: false; status: Status; stepIndex: number; reason: string };

class StepError extends Error {}
/** A policy refusal: never retried, never healed. */
class RefusedError extends Error {}
class HumanStepError extends Error {}

function describe(step: TraceStep): string {
  const alt = step.alternatives[0];
  return alt ? `${step.op} ${alt.role} "${alt.name}"` : step.op;
}

/**
 * The first alternative that resolves to a visible control, polled until
 * `timeoutMs` runs out (0: one pass); null when none does.
 */
export async function resolveLocator(page: Page, alternatives: readonly LocatorAlternative[], timeoutMs: number): Promise<Locator | null> {
  await ensureSnapshotScript(page);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const alt of alternatives) {
      const candidates = [page.getByRole(alt.role as AriaRole, { name: alt.name, exact: alt.exact }).first()];
      if (alt.css) {
        const css = page.locator(alt.css).first();
        const name = (await css.count()) > 0 ? await css.evaluate((el) => window.__navvi!.controlName(el)).catch(() => null) : null;
        if (name === alt.name) candidates.unshift(css);
      }
      for (const locator of candidates) {
        if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) return locator;
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(150);
  }
}

async function requireLocator(page: Page, alternatives: readonly LocatorAlternative[]): Promise<Locator> {
  const locator = await resolveLocator(page, alternatives, STEP_TIMEOUT_MS);
  if (!locator) throw new StepError(`no visible control matched ${alternatives.map((a) => `${a.role} "${a.name}"`).join(" / ")}`);
  return locator;
}

/** Scrolls to the bottom and fires a scroll event too: a viewport taller than the page never scrolls, yet its loader still listens. */
export async function scrollToBottom(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      window.dispatchEvent(new Event("scroll"));
    })
    .catch(() => undefined);
}

interface LiveControl {
  name: string;
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
      name: window.__navvi!.controlName(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type")?.toLowerCase() ?? undefined,
      href: typeof anchor.href === "string" && anchor.href ? anchor.href : undefined,
      autocomplete: input.autocomplete || undefined,
      nameAttr: el.getAttribute("name") ?? undefined,
      form: form ? { method: (form.getAttribute("method") ?? "get").toLowerCase(), action: form.action || "" } : null,
    };
  });
}

/** A recorded target made absolute against the page; a value no URL parser accepts is checked as written. */
const absolute = (url: string, base: string): string => resolveUrl(url, base) ?? url;

function matchesExpect(page: Page, expect: StepExpect, timeout: number): Promise<unknown> {
  if ("urlPattern" in expect) {
    const wanted = expect.urlPattern;
    return page.waitForURL((url) => matchesUrlPattern(url.href, wanted), { timeout });
  }
  return page.getByRole(expect.role as AriaRole, { name: expect.name }).first().waitFor({ state: "visible", timeout });
}

async function checkExpect(page: Page, expect: StepExpect): Promise<void> {
  try {
    await matchesExpect(page, expect, EXPECT_TIMEOUT_MS);
  } catch (error) {
    throw new StepError(`expectation failed: ${JSON.stringify(expect)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface ReplayState {
  typedText: boolean;
  typedSecret: boolean;
}

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(["text", "email", "tel", "search", "url"]);
const TEXT_ROLES: ReadonlySet<string> = new Set(["textbox", "searchbox", "combobox"]);

/**
 * R24: the `password` secret (the name `secretNameFor` gives every password
 * input at compile) goes only into a password input; any other secret (a
 * username, an account code) into a text-like control: a text, email, tel,
 * search or url input, a textarea, or a textbox-role editor.
 */
function secretFitsControl(name: string, live: LiveControl, role: string | undefined): boolean {
  if (name === "password") return live.type === "password";
  if (live.tag === "input") return live.type === undefined || TEXT_INPUT_TYPES.has(live.type);
  if (live.tag === "textarea") return true;
  return role !== undefined && TEXT_ROLES.has(role);
}

/**
 * R24 / R25 / KTD14 at replay: the recorded target and the live control both
 * pass, else the click is refused. Only http(s) targets face the domain and
 * request policy: a `javascript:` or `mailto:` href acts on the page and
 * leaves the name-based control policy to judge the click.
 */
function checkClickPolicy(step: TraceStep, live: LiveControl, page: Page, policy: ReplayPolicy, state: ReplayState): void {
  const alt = step.alternatives[0];
  const targets: string[] = [];
  if (step.target?.href) targets.push(absolute(step.target.href, page.url()));
  if (step.target?.form) targets.push(absolute(step.target.form.action, page.url()));
  if (live.href) targets.push(live.href);
  if (live.form?.action) targets.push(live.form.action);
  for (const url of targets.filter(isHttpHref)) {
    if (!isOnAllowedDomain(url, policy.startUrls, policy.allowedDomains)) {
      throw new RefusedError(`click target ${url} is off the allowed domains (R25)`);
    }
    if (policy.isAllowedRequest && !policy.isAllowedRequest(url)) {
      throw new RefusedError(`click target ${url} is refused by the request policy (R26)`);
    }
  }
  const form = step.target?.form ?? live.form;
  const control: Control = { role: alt?.role ?? "button", name: live.name, tag: live.tag };
  if (live.type) control.inputType = live.type;
  if (live.autocomplete) control.autocomplete = live.autocomplete;
  if (live.nameAttr) control.nameAttr = live.nameAttr;
  if (form) control.form = { method: form.method, hasTypedText: state.typedText, hasPasswordField: state.typedSecret, hasPaymentField: false };
  const decision = allowedControl(control, policy.profile, { allowMutations: policy.allowMutations });
  if (!decision.allowed) throw new RefusedError(`click on ${describe(step)} refused: ${decision.reason ?? "policy"}`);
}

async function runStep(page: Page, step: TraceStep, options: ReplayTraceOptions, state: ReplayState): Promise<void> {
  switch (step.op) {
    case "human":
      throw new HumanStepError("the recorded trace needs a person at this step");
    case "wait":
      await waitForSettle(page, { maxMs: STEP_TIMEOUT_MS });
      return;
    case "scroll":
      await scrollToBottom(page);
      await waitForSettle(page, { maxMs: STEP_TIMEOUT_MS });
      return;
    case "type": {
      const locator = await requireLocator(page, step.alternatives);
      if (step.secret !== undefined) {
        const secret = options.secrets.get(step.secret);
        if (!secret) throw new RefusedError(`secret {{secret:${step.secret}}} was not resolved`);
        const live = await readLiveControl(locator);
        if (!secretFitsControl(step.secret, live, step.alternatives[0]?.role)) {
          const fit = step.secret === "password" ? "a password input" : "a text-like input";
          throw new RefusedError(`secret {{secret:${step.secret}}} may only be typed into ${fit} (R24)`);
        }
        await locator.fill(secret.reveal(), { timeout: STEP_TIMEOUT_MS });
        // the form policy asks whether a password was typed; a username secret is typed text to it
        if (step.secret === "password") state.typedSecret = true;
        else state.typedText = true;
      } else {
        await enterText(locator, step.text ?? "", STEP_TIMEOUT_MS);
        state.typedText = true;
      }
      return;
    }
    case "select": {
      const locator = await requireLocator(page, step.alternatives);
      await locator.selectOption(step.text ?? "", { timeout: STEP_TIMEOUT_MS });
      return;
    }
    case "click": {
      const locator = await requireLocator(page, step.alternatives);
      const live = await readLiveControl(locator);
      checkClickPolicy(step, live, page, options.policy, state);
      await locator.click({ timeout: STEP_TIMEOUT_MS });
      await waitForSettle(page, { idleMs: 300, maxMs: Math.min(STEP_TIMEOUT_MS, 5_000) }).catch(() => undefined);
      return;
    }
  }
}

/**
 * Replays a compiled trace on `page`, which is already at the entry URL.
 * Policy refusals and human steps end the replay at once; other failures go
 * to `onStepFailed` (default: fail) and at most one retry per step, on the
 * step the hook hands back (a healed one) or the captured one.
 */
export async function replayTrace(page: Page, scraper: CompiledScraper, options: ReplayTraceOptions): Promise<ReplayTraceResult> {
  const state: ReplayState = { typedText: false, typedSecret: false };
  for (let index = 0; index < scraper.trace.length; index++) {
    let step = scraper.trace[index]!;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        await runStep(page, step, options, state);
        if (step.expect) await checkExpect(page, step.expect);
        break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof HumanStepError) return { ok: false, status: "needs_human", stepIndex: index, reason };
        if (error instanceof RefusedError) return { ok: false, status: "blocked_no_progress", stepIndex: index, reason };
        if (attempts >= 2) return { ok: false, status: "blocked_no_progress", stepIndex: index, reason: `step ${index} (${describe(step)}) failed twice: ${reason}` };
        const next: StepFailureAction = options.onStepFailed ? await options.onStepFailed(index, page, reason) : { action: "fail" };
        if (next.action === "done") return { ok: true, steps: index + 1 };
        if (next.action === "fail") return { ok: false, status: "blocked_no_progress", stepIndex: index, reason: `step ${index} (${describe(step)}) failed: ${reason}` };
        if (next.step) step = next.step;
      }
    }
  }
  return { ok: true, steps: scraper.trace.length };
}
