import type { Locator, Page } from "playwright";
import { freshnessToken, isStale, waitForSettle, type SettleOptions } from "../browser/guards.js";
import { allowedControl, isOnAllowedDomain, isPersonalDataField } from "../browser/policy.js";
import { getControls, serializeControls, type AriaRole, type SnapshotControl } from "../browser/snapshot.js";
import type { Answer, Chooser, Question } from "../chooser/chooser.js";
import { premises } from "../chooser/questions.js";
import { LIMITS, type Profile } from "../input/schema.js";
import type { StepExpect, TraceStep } from "../scraper/schema.js";
import { maskSecrets } from "../secrets/resolve.js";
import { clip } from "../util/text.js";
import { generateText, policyControl, type RecentAction } from "./textHelper.js";
import { captureExpectation, isHttpHref, readLandmarks, secretNameFor, TraceRecorder, type Landmark } from "./trace.js";

/**
 * Navigate phase (U7): the jev-ultrafast loop with the chooser in Jev's seat.
 * Each step is one chooser batch: the operation choice plus one speculative
 * target choice per operation that has targets. Only the head of the chosen
 * operation is consumed; every index is validated against what was offered.
 * Executed steps are recorded as role plus accessible name with expectations
 * (R12, R42), so replay never needs a model.
 *
 * Decisions where the plan was open:
 * - Question ids are `nav.<n>.op|click|type|select|done` and `text.<n>` (retry
 *   `text.<n>.1`), where n counts decision batches, not executed steps, so a
 *   rejected DONE or a stale re-decision gets fresh ids.
 * - DONE is accepted at P(true) >= 0.7 (`DONE_THRESHOLD`). A rejected DONE, a
 *   `none` operation and a stale-out (3 stale decisions in a row) count as
 *   no-progress attempts without executing anything.
 * - Only steps that made progress (page changed, or the typed value landed)
 *   and stayed on the allowed domain enter the trace; a click whose final URL
 *   leaves the domain is undone with `goBack` and counts as no progress.
 * - Secret-capable and personal-data fields are offered as type targets only
 *   under profile `local` when `secrets` holds a value for `secretNameFor`;
 *   the model then picks the field and code picks the placeholder name.
 */

export const OPERATIONS = ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_UP", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"] as const;
export type Operation = (typeof OPERATIONS)[number];

/** R13: DONE is accepted only when the verification question gives P(true) at or above this. */
export const DONE_THRESHOLD = 0.7;
/** R13: consecutive attempts without progress before BLOCKED. */
export const NO_PROGRESS_LIMIT = 3;
/** Stale re-decisions allowed per step before the step counts as no progress. */
export const MAX_REDECISIONS = 2;
/** Visible text offered in the decision state, in characters. */
export const VISIBLE_TEXT_CHARS = 6_000;
export const SCROLL_PX = 600;
export const WAIT_MS = 100;
const ACTION_TIMEOUT_MS = 5_000;
const NAVIGATION_POLL_MS = 400;

const OPERATION_LABELS: Record<Operation, string> = {
  CLICK: "CLICK: click a link, button, checkbox, radio, tab, menu item, option or other control.",
  TYPE_TEXT: "TYPE_TEXT: enter or replace text in an editable field; the value is written afterwards from the goal.",
  SELECT: "SELECT: choose an offered value of a dropdown.",
  SCROLL_UP: "SCROLL_UP: scroll the page up.",
  SCROLL_DOWN: "SCROLL_DOWN: scroll the page down to reveal more content.",
  WAIT: "WAIT: wait briefly for loading content.",
  DONE: "DONE: every requirement of the goal is visibly satisfied on this page.",
  BLOCKED: "BLOCKED: no supported operation can make progress.",
};

export interface NavigateOptions {
  goal: string;
  chooser: Chooser;
  profile: Profile;
  allowMutations?: readonly string[] | undefined;
  allowedDomains?: readonly string[] | undefined;
  startUrls: readonly string[];
  /** R28: executed actions per navigation. */
  maxSteps?: number | undefined;
  /** R28: chooser requests per navigation (decision batches, DONE checks and text helper calls). */
  maxRequests?: number | undefined;
  settle?: SettleOptions | undefined;
  /** Resolved secret values by placeholder name; used only to fill, never logged (R39). */
  secrets?: Readonly<Record<string, string>> | undefined;
}

export type NavigateStatus = "DONE" | "BLOCKED";

/** Why a navigation ended BLOCKED: a login wall (a password field with no secret), a budget (R28), or no progress. */
export type BlockedBy = "login" | "budget" | "no_progress";

export interface NavigateResult {
  status: NavigateStatus;
  reason?: string;
  blockedBy?: BlockedBy;
  trace: TraceStep[];
  /** Executed actions. */
  steps: number;
  /** Chooser requests spent. */
  requests: number;
}

interface SelectTarget {
  control: SnapshotControl;
  value: string;
  label: string;
}

interface Targets {
  click: SnapshotControl[];
  type: SnapshotControl[];
  select: SelectTarget[];
}

interface Observation {
  token: string;
  url: string;
  title: string;
  text: string;
  controls: SnapshotControl[];
  targets: Targets;
  offered: Operation[];
  state: string;
  landmarks: Landmark[];
}

interface HistoryEntry extends RecentAction {
  pageChanged: boolean;
}

type ExecutionOutcome =
  | { executed: true; control: SnapshotControl | null; text?: string; secret?: string; typedOk: boolean; navigation: boolean; op: TraceStep["op"] }
  | { executed: false; skipped: string };

interface Decision {
  op: Operation | null;
  click: SnapshotControl | null;
  type: SnapshotControl | null;
  select: SelectTarget | null;
}

const ARIA_ROLES: ReadonlySet<string> = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio", "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton"]);
const TYPE_ROLES: ReadonlySet<string> = new Set(["textbox", "searchbox", "spinbutton"]);

function isTypeable(c: SnapshotControl): boolean {
  if (c.disabled || c.tag === "select") return false;
  return c.tag === "textarea" || TYPE_ROLES.has(c.role) || (c.role === "combobox" && c.tag === "input");
}

function describeControl(c: SnapshotControl): string {
  const bits = [`${c.role} ${JSON.stringify(clip(c.name, 60))}`];
  if (c.value) bits.push(`value=${JSON.stringify(clip(c.value, 40))}`);
  if (c.checked !== undefined) bits.push(`checked=${c.checked}`);
  if (c.href) bits.push(`-> ${clip(c.href, 80)}`);
  if (c.scope) bits.push(`in ${JSON.stringify(clip(c.scope, 60))}`);
  return bits.join(" ");
}

const firstLine = (err: unknown): string => (err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err));

function renderHistory(history: readonly HistoryEntry[]): string {
  const recent = history.slice(-10);
  if (recent.length === 0) return "RECENT ACTIONS: none";
  return `RECENT ACTIONS (oldest first)\n${recent.map((h) => `- ${h.action}${h.text !== undefined ? ` = ${JSON.stringify(h.text)}` : ""} (${h.pageChanged ? "page changed" : "no visible change"})`).join("\n")}`;
}

async function locate(page: Page, controls: readonly SnapshotControl[], control: SnapshotControl): Promise<Locator | null> {
  if (!ARIA_ROLES.has(control.role)) return null;
  const role = control.role as AriaRole;
  let locator = page.getByRole(role, { name: control.name, exact: true });
  let count = await locator.count();
  if (count === 0) {
    locator = page.getByRole(role, { name: control.name, exact: false });
    count = await locator.count();
  }
  if (count === 0) return null;
  if (count > 1) {
    const twins = controls.filter((c) => c.role === control.role && c.name === control.name);
    const k = twins.findIndex((c) => c.id === control.id);
    locator = locator.nth(Math.max(0, Math.min(k, count - 1)));
  }
  return locator;
}

async function selectOptions(page: Page, controls: readonly SnapshotControl[], control: SnapshotControl): Promise<SelectTarget[]> {
  const locator = await locate(page, controls, control);
  if (!locator) return [];
  const options = await locator
    .evaluate((el) => {
      if (!(el instanceof HTMLSelectElement)) return [];
      return [...el.options].filter((o) => !o.disabled && !o.closest("optgroup[disabled]")).map((o) => ({ value: o.value, label: (o.label || o.text).trim() }));
    })
    .catch(() => []);
  return options.map((o) => ({ control, value: o.value, label: o.label }));
}

/** Two animation frames or 50 ms; an editable combobox waits for visible options, capped at 200 ms (reference behaviour). */
function frameSettle(combobox: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    let frames = 0;
    let stopped = false;
    const finish = (): void => {
      stopped = true;
      resolve();
    };
    setTimeout(finish, combobox ? 200 : 50);
    const ready = (): void => {
      if (stopped) return;
      const options = [...document.querySelectorAll('[role="option"]')];
      const anyVisible = options.some((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      });
      if (++frames >= 2 && (!combobox || anyVisible)) finish();
      else requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  });
}

async function settleAfter(page: Page, control: SnapshotControl | null, expectNavigation: boolean, urlBefore: string, settle: SettleOptions): Promise<void> {
  if (expectNavigation) {
    const deadline = Date.now() + NAVIGATION_POLL_MS;
    while (Date.now() < deadline && page.url() === urlBefore) await page.waitForTimeout(20);
  }
  const combobox = control?.role === "combobox" && control.tag !== "select";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.evaluate(frameSettle, combobox);
      break;
    } catch {
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }
  }
  await waitForSettle(page, settle).catch(() => undefined);
}

function probabilityOfTrue(answer: Answer | undefined): number {
  if (!answer) return 0;
  if (typeof answer.probability === "number") return answer.probability;
  return answer.index === 1 ? 1 : 0;
}

function pick<T>(answer: Answer | undefined, offered: readonly T[]): T | null {
  if (!answer || answer.index === null || answer.index === undefined) return null;
  return offered[answer.index] ?? null;
}

export async function navigate(page: Page, options: NavigateOptions): Promise<NavigateResult> {
  const { goal, chooser, profile } = options;
  const allowMutations = options.allowMutations ?? [];
  const allowedDomains = options.allowedDomains ?? [];
  const maxSteps = options.maxSteps ?? LIMITS.navigationSteps;
  const maxRequests = options.maxRequests ?? LIMITS.navigationRequests;
  const settle: SettleOptions = options.settle ?? { idleMs: 150, maxMs: 2_000 };
  const secrets = options.secrets ?? {};
  const secretEntries = Object.entries(secrets);
  /** R39: every string that reaches the chooser or the result carries `[secret:name]` in place of a value. */
  const redact = (text: string): string => maskSecrets(text, secretEntries);
  const policy = { allowMutations };

  const recorder = new TraceRecorder();
  const history: HistoryEntry[] = [];
  let steps = 0;
  let requests = 0;
  let decisions = 0;
  let noProgress = 0;
  let lastControls: SnapshotControl[] = [];
  let lastNoProgress = "";

  const secretFor = (c: SnapshotControl): string | null => {
    if (profile !== "local") return null;
    const name = secretNameFor(c);
    return typeof secrets[name] === "string" ? name : null;
  };

  const onDomain = (url: string): boolean => isOnAllowedDomain(url, options.startUrls, allowedDomains);

  const blocked = (by: BlockedBy, reason: string): NavigateResult => {
    const password = lastControls.find((c) => c.secretCapable);
    const hint = password && !secretFor(password) ? `login required: a password field ("${password.name}") is visible and no secret is available; ` : "";
    return { status: "BLOCKED", blockedBy: hint ? "login" : by, reason: `${hint}${reason}`, trace: recorder.steps, steps, requests };
  };

  const ask = async (batch: Question[]): Promise<Answer[] | null> => {
    if (requests >= maxRequests) return null;
    requests += 1;
    return chooser.ask(batch);
  };

  const noProgressAttempt = (action: string, kind: string): void => {
    noProgress += 1;
    lastNoProgress = kind;
    history.push({ action, pageChanged: false });
  };

  async function observe(): Promise<Observation> {
    const token = await freshnessToken(page);
    const controls = await getControls(page, { profile, allowMutations });
    lastControls = controls;
    const url = page.url();
    const title = await page.title().catch(() => "");
    const text = clip(await page.evaluate(() => document.body?.innerText ?? "").catch(() => ""), VISIBLE_TEXT_CHARS);
    const landmarks = await readLandmarks(page).catch((): Landmark[] => []);

    const type = controls.filter((c) => {
      if (!isTypeable(c)) return false;
      if (c.secretCapable) return secretFor(c) !== null;
      if (isPersonalDataField(policyControl(c))) return secretFor(c) !== null;
      return allowedControl(policyControl(c), profile, policy).allowed;
    });
    const click = controls.filter((c) => {
      if (c.disabled || !c.clickable || c.secretCapable || c.tag === "select" || isTypeable(c)) return false;
      if (c.href && /^https?:/i.test(c.href) && !onDomain(c.href)) return false;
      return allowedControl(policyControl(c), profile, policy).allowed;
    });
    const select: SelectTarget[] = [];
    for (const c of controls.filter((c) => c.tag === "select" && !c.disabled)) select.push(...(await selectOptions(page, controls, c)));

    const offered = OPERATIONS.filter((op) => (op === "CLICK" ? click.length > 0 : op === "TYPE_TEXT" ? type.length > 0 : op === "SELECT" ? select.length > 0 : true));
    const state = redact([`GOAL: ${goal}`, `URL: ${url}`, `TITLE: ${title}`, "VISIBLE TEXT:", text, serializeControls(controls), renderHistory(history)].join("\n"));
    return { token, url, title, text, controls, targets: { click, type, select }, offered, state, landmarks };
  }

  function batchFor(n: number, o: Observation): Question[] {
    const batch: Question[] = [
      { id: `nav.${n}.op`, kind: "choice", premise: premises.operationChoice(goal), options: o.offered.map((op) => OPERATION_LABELS[op]), state: o.state },
    ];
    if (o.targets.click.length > 0) {
      batch.push({ id: `nav.${n}.click`, kind: "choice", premise: premises.operationTarget("CLICK", goal), options: o.targets.click.map((c) => redact(describeControl(c))), state: o.state });
    }
    if (o.targets.type.length > 0) {
      batch.push({ id: `nav.${n}.type`, kind: "choice", premise: premises.operationTarget("TYPE_TEXT", goal), options: o.targets.type.map((c) => redact(describeControl(c))), state: o.state });
    }
    if (o.targets.select.length > 0) {
      batch.push({
        id: `nav.${n}.select`,
        kind: "choice",
        premise: premises.operationTarget("SELECT", goal),
        options: o.targets.select.map((s) => redact(`${describeControl(s.control)} = ${JSON.stringify(clip(s.label, 60))}`)),
        state: o.state,
      });
    }
    return batch;
  }

  function interpret(n: number, o: Observation, answers: readonly Answer[]): Decision {
    const byId = new Map(answers.map((a) => [a.id, a]));
    // R11: the executor consumes only the head of the chosen operation; other heads are ignored.
    return {
      op: pick(byId.get(`nav.${n}.op`), o.offered),
      click: pick(byId.get(`nav.${n}.click`), o.targets.click),
      type: pick(byId.get(`nav.${n}.type`), o.targets.type),
      select: pick(byId.get(`nav.${n}.select`), o.targets.select),
    };
  }

  async function execute(n: number, o: Observation, d: Decision): Promise<ExecutionOutcome> {
    /** KTD14: getControls already filtered; re-check the one control that is about to act. The skip reason, or null. */
    const refused = (control: SnapshotControl): string | null => {
      const decision = allowedControl(policyControl(control), profile, policy);
      return decision.allowed ? null : (decision.reason ?? "policy");
    };
    /** Locates `control` among the observed ones and runs `fn` on it; a missing control or a failed action is a skip reason. */
    const act = async (control: SnapshotControl, label: string, verb: string, fn: (locator: Locator) => Promise<unknown>): Promise<string | null> => {
      const locator = await locate(page, o.controls, control);
      if (!locator) return `${label} not found`;
      try {
        await fn(locator);
        return null;
      } catch (err) {
        return `${verb} failed: ${firstLine(err)}`;
      }
    };
    switch (d.op) {
      case "WAIT":
        await page.waitForTimeout(WAIT_MS);
        return { executed: true, control: null, typedOk: false, navigation: false, op: "wait" };
      case "SCROLL_UP":
      case "SCROLL_DOWN":
        await page.mouse.wheel(0, d.op === "SCROLL_DOWN" ? SCROLL_PX : -SCROLL_PX);
        return { executed: true, control: null, text: d.op === "SCROLL_DOWN" ? "down" : "up", typedOk: false, navigation: false, op: "scroll" };
      case "CLICK": {
        const control = d.click;
        if (!control) return { executed: false, skipped: "no click target" };
        const skipped = refused(control) ?? (await act(control, `control ${control.role} "${control.name}"`, "click", (locator) => locator.click({ timeout: ACTION_TIMEOUT_MS })));
        if (skipped !== null) return { executed: false, skipped };
        const submit = control.form !== null && (control.inputType === "submit" || control.inputType === "image" || (control.tag === "button" && (control.inputType === undefined || control.inputType === "submit")));
        // a javascript: or mailto: href acts on the page and is not waited for as a navigation (its target is never recorded either)
        return { executed: true, control, typedOk: false, navigation: isHttpHref(control.href) || submit, op: "click" };
      }
      case "SELECT": {
        const target = d.select;
        if (!target) return { executed: false, skipped: "no select target" };
        const skipped =
          refused(target.control) ?? (await act(target.control, `select ${target.control.name}`, "select", (locator) => locator.selectOption({ value: target.value }, { timeout: ACTION_TIMEOUT_MS })));
        if (skipped !== null) return { executed: false, skipped };
        return { executed: true, control: target.control, text: target.label, typedOk: true, navigation: false, op: "select" };
      }
      case "TYPE_TEXT": {
        const control = d.type;
        if (!control) return { executed: false, skipped: "no type target" };
        const secret = secretFor(control);
        let value: string;
        if (secret !== null) {
          value = secrets[secret] ?? "";
        } else {
          if (control.secretCapable || isPersonalDataField(policyControl(control))) return { executed: false, skipped: "personal-data field without a secret" };
          const refusal = refused(control);
          if (refusal !== null) return { executed: false, skipped: refusal };
          const result = await generateText(
            chooser,
            { goal, field: control, context: { title: o.title, text: redact(o.text) }, recentActions: history.map(({ action, text }) => ({ action, text })) },
            { questionId: `text.${n}` },
          );
          requests += result.requests;
          if (!result.ok) {
            if (result.kind === "missing") return { executed: false, skipped: "text helper found no value for the field" };
            throw new TextHelperFailure(result.reason);
          }
          value = result.text;
          // The helper was another request: the page must still be the one the decision saw.
          if (await isStale(page, o.token)) return { executed: false, skipped: "page changed during text generation" };
        }
        let landed = "";
        const skipped = await act(control, `field ${control.role} "${control.name}"`, "fill", async (locator) => {
          await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
          landed = await locator.evaluate((el) => ("value" in el ? String((el as HTMLInputElement).value) : (el.textContent ?? ""))).catch(() => "");
        });
        if (skipped !== null) return { executed: false, skipped };
        const typedOk = landed === value;
        if (secret !== null) return { executed: true, control, secret, typedOk, navigation: false, op: "type" };
        return { executed: true, control, text: value, typedOk, navigation: false, op: "type" };
      }
      case "DONE":
      case "BLOCKED":
      case null:
        return { executed: false, skipped: "not an action" };
    }
  }

  for (;;) {
    if (steps >= maxSteps) return blocked("budget", `step budget of ${maxSteps} reached`);
    if (noProgress >= NO_PROGRESS_LIMIT) return blocked("no_progress", `no progress after ${NO_PROGRESS_LIMIT} attempts (last: ${lastNoProgress})`);

    // Decide over a fresh observation; a page that changed in between is decided again (bounded).
    let observation: Observation | null = null;
    let decision: Decision | null = null;
    for (let attempt = 0; ; attempt++) {
      if (requests >= maxRequests) return blocked("budget", `request budget of ${maxRequests} reached`);
      observation = await observe();
      const n = decisions++;
      const answers = await ask(batchFor(n, observation));
      if (!answers) return blocked("budget", `request budget of ${maxRequests} reached`);
      decision = interpret(n, observation, answers);
      if (!(await isStale(page, observation.token))) break;
      if (attempt >= MAX_REDECISIONS) {
        decision = null;
        break;
      }
    }
    if (!decision) {
      noProgressAttempt("re-decided: page kept changing", "stale");
      continue;
    }
    const n = decisions - 1;

    if (decision.op === null) {
      noProgressAttempt("no operation chosen", "none");
      continue;
    }
    if (decision.op === "BLOCKED") return blocked("no_progress", "the chooser found no supported operation that makes progress");
    if (decision.op === "DONE") {
      const answers = await ask([{ id: `nav.${n}.done`, kind: "boolean", premise: premises.goalAchieved(goal), state: observation.state }]);
      if (!answers) return blocked("budget", `request budget of ${maxRequests} reached`);
      const p = probabilityOfTrue(answers[0]);
      if (p >= DONE_THRESHOLD) return { status: "DONE", trace: recorder.steps, steps, requests };
      noProgressAttempt(`DONE rejected (P(goal achieved) ${p.toFixed(2)} < ${DONE_THRESHOLD})`, "done rejected");
      continue;
    }

    let outcome: ExecutionOutcome;
    try {
      outcome = await execute(n, observation, decision);
    } catch (err) {
      if (err instanceof TextHelperFailure) return blocked("no_progress", err.message);
      throw err;
    }
    if (!outcome.executed) {
      noProgressAttempt(`${decision.op} skipped: ${outcome.skipped}`, "skipped");
      continue;
    }
    steps += 1;

    const urlBefore = observation.url;
    await settleAfter(page, outcome.control, outcome.navigation, urlBefore, settle);
    const label = outcome.control ? `${outcome.op} ${outcome.control.role} ${JSON.stringify(clip(outcome.control.name, 60))}` : outcome.op;
    const shownText = outcome.secret !== undefined ? `{{secret:${outcome.secret}}}` : outcome.text;

    const url = page.url();
    if (!onDomain(url)) {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
      await waitForSettle(page, settle).catch(() => undefined);
      noProgress += 1;
      lastNoProgress = "left the allowed domain";
      history.push({ action: `${label} (undone: left the allowed domain)`, text: shownText, pageChanged: false });
      continue;
    }

    const pageChanged = (await freshnessToken(page).catch(() => observation.token)) !== observation.token;
    const progressed = pageChanged || outcome.typedOk;
    history.push({ action: label, text: shownText, pageChanged });
    if (!progressed) {
      noProgress += 1;
      lastNoProgress = outcome.op;
      continue;
    }
    noProgress = 0;
    const expectation: StepExpect | undefined = captureExpectation(observation.landmarks, await readLandmarks(page).catch((): Landmark[] => []), urlBefore, url);
    recorder.record({ op: outcome.op, control: outcome.control ?? undefined, controls: observation.controls, text: outcome.text, secret: outcome.secret, expect: expectation });
  }
}

class TextHelperFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextHelperFailure";
  }
}
