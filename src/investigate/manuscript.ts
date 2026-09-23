import type { Verdict } from "../heuristics/index.js";
import type { FieldType } from "../input/schema.js";
import type { TypedValue } from "../scraper/extract.js";
import type { FieldSource } from "../scraper/schema.js";
import type { CanaryFingerprint } from "./blocked.js";
import type { ExcludedProbe, PickReason, UnfilledStratum } from "./sample.js";

/**
 * U2f: the investigation manuscript.
 *
 * One committed artifact naming every source, every sample, every obstacle and
 * every rejection. The ergonomic is borrowed from `mvanhorn/cli-printing-press`,
 * whose browser-sniff gate archives the pages it visited, the endpoints it
 * found, the response samples it kept and the protection signals it met as a
 * committed file with full provenance — so a generated client can be argued
 * with rather than only rerun.
 *
 * navvi needs it for a sharper reason. On 2026-09-22 three compiled scrapers
 * were confidently wrong in three different ways — a seasonal CSS class, a list
 * price bound to a sale price, two fields collapsed onto one node — and each
 * one looked fine from the outside: every value extracted, every type checked.
 * Understanding any of them meant opening `scraper.json` and squinting at a
 * selector. The manuscript is the other half of that file: **what was tried,
 * what it covered, and what was refused.** A compile you cannot argue with is a
 * compile you have to rerun to disagree with.
 *
 * Two properties it has to keep, because they are what make it worth
 * committing:
 *
 *  - **JSON-serialisable.** No `Map`, no `Date`, no class instance. It is
 *    written next to the scraper and read back months later by a run, a person
 *    and a diff.
 *  - **Stable.** The same investigation produces the same manuscript, so a diff
 *    between two runs is a real change and not a reordering. Every list here is
 *    in a deterministic order, and `recordedAt` — the one field a re-run moves —
 *    comes from an injected clock so a test pins it.
 */

/** Heuristic verdicts in the shape `bindField` and `classifyRun` already emit. */
export type VerdictLog = Array<{ id: string; verdict: Verdict }>;

/** A field the spec asked for, with the type it has to coerce to. */
export interface RequestedField {
  name: string;
  type?: FieldType | undefined;
}

// ------------------------------------------------------------------- sources

/**
 * One thing the investigation read. URLs are `safeUrl`-amputated before they
 * get here: a captured endpoint's query string carries `?token=`, `?sig=` as
 * often as a header does, and this file is committed.
 */
export interface SourceRecord {
  url: string;
  kind: "plain-fetch" | "payload" | "render";
  status?: number;
  /** The `match` a compiled `network` alternative would carry for this endpoint. */
  match?: string;
  /** How many candidates it offered: declared findings for a fetch, flattened leaves for a payload. */
  found: number;
  because: string;
}

// --------------------------------------------------------------------- tiers

export type TierName = "declared" | "payload" | "dom";

/**
 * What one tier was asked for and what it answered.
 *
 * `outcome` is the cascade's whole point written down. `skipped` is the
 * valuable one — a tier that did not run because an earlier one covered
 * everything, or because a heuristic said it would not pay — and it has to say
 * which, because "tier 2 covered nothing" and "tier 2 was never spent" are the
 * same empty `covered` list and very different facts.
 */
export interface TierRecord {
  tier: 1 | 2 | 3;
  name: TierName;
  outcome: "ran" | "skipped" | "requested";
  because: string;
  /** The fields this tier was handed: what the tiers above it left uncovered. */
  asked: string[];
  /** The fields it settled. */
  covered: string[];
  sources: SourceRecord[];
  verdicts: VerdictLog;
}

// -------------------------------------------------------------------- fields

/** A candidate a tier considered and did not bind, with the reason it lost. */
export interface RejectionRecord {
  tier: 1 | 2;
  path: string;
  /** The value on each binding sample, in sample order. */
  values: TypedValue[];
  because: string;
}

/**
 * One field's answer, with the path and every verdict behind it.
 *
 * `tier` absent means nothing cheap covered it and tier 3 was asked; `askModel`
 * means a tier narrowed the table but could not settle it, which is the only
 * state in which a model is worth paying for.
 */
export interface FieldRecord {
  field: string;
  type?: FieldType;
  tier?: 1 | 2;
  /** The `FIELD_SOURCES` value the compiled alternative carries. */
  source?: FieldSource;
  path?: string;
  /** For a `network` binding: which endpoint the path is read out of. */
  match?: string;
  /** For a `dom` binding: the selector, and the attribute it reads. */
  selector?: string;
  attr?: string;
  /** For a `json-ld` or microdata binding: the schema.org type the path is read from. */
  entity?: string;
  /** The bound value on each binding sample, in sample order. */
  values?: TypedValue[];
  /** Other paths carrying the same value; free alternatives for the compile. */
  aliases: string[];
  because: string;
  askModel: boolean;
  rejected: RejectionRecord[];
  verdicts: VerdictLog;
}

// ----------------------------------------------------------------- obstacles

/**
 * Something in the way, blocking or not.
 *
 * A consent dialog and an Incapsula script are both worth committing even when
 * neither stopped the run: the first is a step the compiled scraper has to keep
 * taking, and the second is the cost line in the answer to "can we run this
 * daily from a datacenter". `blocking` says which ones ended the investigation.
 */
export interface Obstacle {
  /**
   * `deferred` is the record of a question the plain fetch could not answer:
   * the page looked refused, and a render was taken to find out. It carries the
   * answer in its `because` either way, because "the plain fetch looked like a
   * refusal and the render disproved it" is a fact about this site that the
   * next person to read the manuscript needs and that no other line states.
   * (2026-09-22, the first live run: three Store B shells read as three
   * Imperva interstitials and the whole investigation stopped.)
   */
  kind: "consent" | "challenge" | "status" | "apology" | "shell" | "excluded" | "deferred";
  url?: string;
  because: string;
  evidence?: string;
  blocking: boolean;
}

// -------------------------------------------------------------------- sample

/** One URL in the compile sample, and why it is in it. */
export interface SamplePickRecord {
  url: string;
  stratum: PickReason;
  because: string;
  /**
   * Was it bound from?
   *
   * A `dead` pick is in the sample on purpose — reproducing a blank is parity —
   * but it has no product to bind, and `narrow` keeps only leaves present on
   * *every* sample. Including one in the binding set deletes every candidate
   * for every field. So the sample and the binding set are not the same list,
   * and the manuscript says which URLs were which.
   */
  bound: boolean;
}

export interface SampleRecord {
  because: string;
  considered: number;
  picks: SamplePickRecord[];
  unfilled: UnfilledStratum[];
  excluded: ExcludedProbe[];
}

// ---------------------------------------------------------------- manuscript

export interface Manuscript {
  version: 1;
  site: string;
  /** The only field a re-run moves; injected, so a test and a diff can pin it. */
  recordedAt: string;
  /** What the spec asked for, in the order it asked. */
  requested: RequestedField[];
  sample: SampleRecord;
  tiers: TierRecord[];
  fields: FieldRecord[];
  /** Fields nothing covered, in requested order. Tier 3's shopping list. */
  uncovered: string[];
  obstacles: Obstacle[];
  /** Recorded at investigation so a run months later can tell drift from refusal. */
  canary?: CanaryFingerprint;
  /**
   * Why there is a canary, or why there is not.
   *
   * A fingerprint taken off a shell — ten characters of text and two words —
   * resolves against anything and would turn every future block into "drift",
   * which is the one mistake `blocked.ts` exists to prevent. Refusing to record
   * one is the right answer; refusing silently is not.
   */
  canaryBecause: string;
  /**
   * `covered` — every requested field is bound.
   * `partial` — the cheap tiers left work for the compiler.
   * `blocked` — the site refused, and nothing was bound because binding against
   * an error page is how a good scraper is destroyed by its own repair.
   */
  verdict: "covered" | "partial" | "blocked";
  because: string;
}

// ------------------------------------------------------------------ rendering

const TIER_LABEL: Record<1 | 2 | 3, string> = { 1: "tier 1", 2: "tier 2", 3: "tier 3" };

function pad(label: string): string {
  return label.padEnd(12, " ");
}

function bullet(lines: string[], text: string): void {
  lines.push(`              ${text}`);
}

/**
 * The manuscript as a person reads it — the stage block the plan's transcript
 * shows on stderr, while the JSON goes to a file.
 *
 * Same discipline as `cli/render.ts`: data is JSON, this is the summary, and
 * the summary names the decision rather than restating the file.
 */
export function render(manuscript: Manuscript, dataLine = ""): string {
  const lines = [`investigate   ${manuscript.site}${dataLine === "" ? "" : `${" ".repeat(Math.max(1, 38 - manuscript.site.length))}${dataLine}`}`];

  const bound = manuscript.sample.picks.filter((pick) => pick.bound).length;
  lines.push(`  ${pad("sample")}${bound} of ${manuscript.sample.considered} URLs bound, ${manuscript.sample.picks.length} sampled`);
  bullet(lines, manuscript.sample.because);
  for (const entry of manuscript.sample.unfilled) bullet(lines, `! ${entry.stratum}: ${entry.because}`);

  for (const tier of manuscript.tiers) {
    const head = tier.outcome === "ran" ? `${tier.covered.length} of ${tier.asked.length} fields covered` : tier.outcome === "skipped" ? "skipped" : `asked for ${tier.asked.join(", ") || "nothing"}`;
    lines.push(`  ${pad(TIER_LABEL[tier.tier])}${tier.name}: ${head}`);
    bullet(lines, tier.because);
    for (const source of tier.sources) bullet(lines, `${source.kind} ${source.url}${source.match === undefined ? "" : ` (${source.match})`} — ${source.found} candidate(s)`);
    for (const { id, verdict } of tier.verdicts) {
      if (verdict.fires) bullet(lines, `heuristic ${id} fired — ${verdict.because}`);
    }
  }

  lines.push(`  ${pad("fields")}${manuscript.fields.filter((field) => field.path !== undefined).length} of ${manuscript.fields.length} bound`);
  for (const field of manuscript.fields) {
    const where = field.path === undefined ? "unbound" : `${field.source} ${field.match === undefined ? "" : `${field.match} `}${field.path}`;
    bullet(lines, `${field.field.padEnd(14, " ")}${where}`);
    bullet(lines, `  ${field.because}`);
  }
  if (manuscript.uncovered.length > 0) lines.push(`  ${pad("uncovered")}${manuscript.uncovered.join(", ")}`);

  if (manuscript.obstacles.length > 0) {
    lines.push(`  ${pad("obstacles")}${manuscript.obstacles.length}`);
    for (const obstacle of manuscript.obstacles) bullet(lines, `${obstacle.blocking ? "!" : "-"} ${obstacle.kind}${obstacle.url === undefined ? "" : ` ${obstacle.url}`}: ${obstacle.because}`);
  }
  lines.push(`  ${pad("canary")}${manuscript.canaryBecause}`);
  lines.push(`  ${pad(manuscript.verdict)}${manuscript.because}`);
  return lines.join("\n") + "\n";
}
