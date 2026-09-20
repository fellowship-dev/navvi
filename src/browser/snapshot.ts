import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import type { Profile } from "../input/schema.js";
import type { Shape } from "../scraper/schema.js";

/**
 * Typed wrappers over the in-page script `snapshot.inject.js` (U4). The script is
 * injected once per page and exposes `controls()` for navigation steps and
 * `candidates()` for sample pages. Everything the chooser sees comes from
 * these two tables; ids are stable across calls within a page.
 */

/**
 * The `__name` shim keeps functions serialized by esbuild-based runners (tsx
 * sets `keepNames`) working inside the page.
 */
export const EVALUATE_SHIM = "globalThis.__name = globalThis.__name || ((fn) => fn);";

/**
 * Shim plus the in-page script, ready for `context.addInitScript` or
 * `page.evaluate`. The script sits next to this module both in `src/` and in
 * `dist/` (`scripts/copy-assets.mjs` copies it verbatim; tsc never compiles it).
 */
export const SNAPSHOT_INIT_SCRIPT = EVALUATE_SHIM + "\n" + readFileSync(new URL("./snapshot.inject.js", import.meta.url), "utf8");
const SNAPSHOT_SOURCE = SNAPSHOT_INIT_SCRIPT;

/** Defines the `__name` shim in the current document; safe to call repeatedly. */
export async function ensureEvaluateShim(page: Page): Promise<void> {
  await page.evaluate(EVALUATE_SHIM);
}

/**
 * Installs the shim and the snapshot script in every document the context
 * opens, so `ensureSnapshotScript` finds it present and skips the injection.
 * `launch()` calls this; TODO: the crawler should call installSnapshot(context) in its guardContext hook (src/replay/crawler.ts, owned elsewhere).
 */
export async function installSnapshot(context: BrowserContext): Promise<void> {
  await context.addInitScript(SNAPSHOT_INIT_SCRIPT);
}

/** Chooser state budget (KTD5): the largest fixture must serialize under this. */
export const SNAPSHOT_BUDGET_CHARS = 28_000;

/** Default caps, mirrored from `DEFAULT_CAPS` in snapshot.inject.js (the test asserts they match). */
export const DEFAULT_CAPS = {
  minGroupItems: 4,
  maxGroups: 20,
  maxLeaves: 80,
  maxLinks: 60,
  maxControls: 150,
} as const;

/** The deny list literal inside snapshot.inject.js; tests assert it equals policy.ts DENY_LIST. */
export const SNAPSHOT_DENY_LIST: readonly string[] = (() => {
  const match = /NAVVI_DENY_LIST\s*=\s*(\[[\s\S]*?\]);/.exec(SNAPSHOT_SOURCE);
  if (!match?.[1]) throw new Error("snapshot.inject.js: NAVVI_DENY_LIST literal not found");
  return JSON.parse(match[1]) as string[];
})();

/** The role argument of `page.getByRole`, for locators built from recorded or snapshotted controls. */
export type AriaRole = Parameters<Page["getByRole"]>[0];

export interface SnapshotFormInfo {
  method: string;
  action: string;
  hasTypedText: boolean;
  hasPasswordField: boolean;
  hasPaymentField: boolean;
}

/** One row of the control table. Already filtered by the R24/R38 structural rules. */
export interface SnapshotControl {
  id: string;
  role: string;
  name: string;
  tag: string;
  inputType?: string | undefined;
  value: string;
  checked?: boolean | undefined;
  disabled: boolean;
  visible: boolean;
  /** Center hit test resolves to the element or a descendant (not occluded, in or scrolled into the viewport). */
  clickable: boolean;
  /** Nearest form/dialog/row context text, at most 120 chars. */
  scope: string;
  form: SnapshotFormInfo | null;
  autocomplete?: string | undefined;
  nameAttr?: string | undefined;
  idAttr?: string | undefined;
  /** R24: true only for password inputs, which are only reachable through a secret step. */
  secretCapable: boolean;
  href?: string | undefined;
}

export interface ControlOptions {
  profile: Profile;
  allowMutations?: readonly string[] | undefined;
  maxControls?: number | undefined;
}

export interface GroupCandidate {
  id: string;
  /** Selector of the parent container, resolvable from the document. */
  selector: string;
  /** Child tag + stable classes, relative to the parent (`parent > itemSelector`). */
  itemSelector: string;
  itemCount: number;
  sampleTexts: string[];
  /** Multi-row items (Hacker News): the anchor row plus the following `span - 1` siblings. */
  anchorPlusRows?: { anchorSelector: string; span: number } | undefined;
}

export interface LeafCandidate {
  id: string;
  /** Tag/class path relative to the item (or to body); `+N/` prefixes a following row; `/@attr` an attribute. */
  path: string;
  /** Resolves with `row.matches(selector) ? row : row.querySelector(selector)`; rows tried in order. */
  selector: string;
  attr?: "href" | "src" | "datetime" | undefined;
  text: string;
  label: string;
  shape: Shape;
}

export interface LinkCandidate {
  id: string;
  selector: string;
  text: string;
  href: string;
  /** Anchors inside the top group that share this one's path (one entry per item link shape). */
  count: number;
}

export interface Candidates {
  groups: GroupCandidate[];
  leaves: LeafCandidate[];
  links: LinkCandidate[];
}

export interface CandidateOptions {
  minGroupItems?: number | undefined;
  maxGroups?: number | undefined;
  maxLeaves?: number | undefined;
  maxLinks?: number | undefined;
  /** Item mode: selector of the item anchors (e.g. `ul.jobs > li.job` or a group's anchorSelector). */
  within?: string | undefined;
  itemIndex?: number | undefined;
  /** Rows per item in anchor-plus-rows layouts. */
  span?: number | undefined;
}

export interface ResolveLeafOptions {
  selector: string;
  attr?: string | undefined;
  within?: string | undefined;
  itemIndex?: number | undefined;
  span?: number | undefined;
}

declare global {
  interface Window {
    __navvi?: {
      controls(opts: unknown): SnapshotControl[];
      candidates(opts: unknown): Candidates;
      resolveLeaf(opts: unknown): string | null;
      freshness(): { url: string; text: string; values: Array<[number, string, boolean]> };
    };
  }
}

/** One round trip: defines the shim and reports whether the snapshot script is already in this document. */
const PROBE = "(" + EVALUATE_SHIM.replace(/;$/, ",") + " typeof window.__navvi === 'object' && window.__navvi !== null)";

/**
 * Fallback for contexts without `installSnapshot`: injects snapshot.inject.js
 * once per document (navigation clears it, so every call probes). Costs one
 * round trip when present, two when not.
 */
export async function ensureSnapshotScript(page: Page): Promise<void> {
  const present = await page.evaluate(PROBE);
  if (!present) await page.evaluate(SNAPSHOT_SOURCE);
}

export async function getControls(page: Page, opts: ControlOptions): Promise<SnapshotControl[]> {
  await ensureSnapshotScript(page);
  const args = { profile: opts.profile, allowMutations: [...(opts.allowMutations ?? [])], maxControls: opts.maxControls };
  return page.evaluate((a) => window.__navvi!.controls(a), args);
}

export async function getCandidates(page: Page, opts: CandidateOptions = {}): Promise<Candidates> {
  await ensureSnapshotScript(page);
  return page.evaluate((a) => window.__navvi!.candidates(a), { ...opts });
}

/** Resolves a proposed leaf selector the way replay does; null when nothing matches. */
export async function resolveLeaf(page: Page, opts: ResolveLeafOptions): Promise<string | null> {
  await ensureSnapshotScript(page);
  return page.evaluate((a) => window.__navvi!.resolveLeaf(a), { ...opts });
}

const q = (s: string, max: number): string => JSON.stringify(s.length > max ? `${s.slice(0, max - 1)}…` : s);

function assertBudget(text: string, what: string): string {
  if (text.length > SNAPSHOT_BUDGET_CHARS) {
    throw new Error(`${what} state is ${text.length} chars, over the ${SNAPSHOT_BUDGET_CHARS} char budget`);
  }
  return text;
}

/** Compact text state for the chooser: one line per candidate, ids first. Throws over budget. */
export function serializeForChooser(candidates: Candidates): string {
  const lines: string[] = [];
  lines.push(`GROUPS (${candidates.groups.length})`);
  for (const g of candidates.groups) {
    const shape = g.anchorPlusRows ? ` rows=${g.anchorPlusRows.span} anchor=${g.anchorPlusRows.anchorSelector}` : "";
    lines.push(`${g.id} ${g.itemCount} items <${g.selector} > ${g.itemSelector}>${shape}: ${g.sampleTexts.map((t) => q(t, 140)).join(" || ")}`);
  }
  lines.push(`LEAVES (${candidates.leaves.length})`);
  for (const l of candidates.leaves) {
    const label = l.label ? ` label=${q(l.label, 40)}` : "";
    lines.push(`${l.id} ${l.path} ${l.shape}${label}: ${q(l.text, 100)}`);
  }
  lines.push(`LINKS (${candidates.links.length})`);
  for (const k of candidates.links) lines.push(`${k.id} ${q(k.text, 60)} -> ${k.href.slice(0, 120)}${k.count > 1 ? ` (x${k.count} items)` : ""}`);
  return assertBudget(lines.join("\n"), "candidate");
}

/** Compact control table for navigation steps. Values of secret-capable controls are always empty. */
export function serializeControls(controls: SnapshotControl[]): string {
  const lines = [`CONTROLS (${controls.length})`];
  for (const c of controls) {
    const bits = [c.id, c.role, q(c.name, 60)];
    if (c.inputType && c.inputType !== "text" && c.inputType !== "submit") bits.push(`type=${c.inputType}`);
    if (c.secretCapable) bits.push("secret");
    if (c.value) bits.push(`value=${q(c.value, 40)}`);
    if (c.checked !== undefined) bits.push(`checked=${c.checked}`);
    if (c.disabled) bits.push("disabled");
    if (!c.clickable) bits.push("occluded");
    if (c.form) bits.push(`form=${c.form.method}${c.form.hasPasswordField ? "+password" : ""}${c.form.hasTypedText ? "+typed" : ""}`);
    if (c.href) bits.push(`-> ${c.href.slice(0, 100)}`);
    if (c.scope) bits.push(`in ${q(c.scope, 60)}`);
    lines.push(bits.join(" "));
  }
  return assertBudget(lines.join("\n"), "control");
}
