import type { CompiledScraper } from "../scraper/schema.js";
import type { Reconciliation } from "../reconcile/index.js";
import type { Determinism } from "../replay/determinism.js";
import type { PageExtraction } from "../scraper/extract.js";

/**
 * U11's last stage, and the honest half of U12.
 *
 * The plan's transcript ends:
 *
 * ```
 * verify        scorecard 82/100 (B+)                 work/storeb/scorecard.md
 *               declared 0% · payload 100% · dom 0% · 1 obstacle · 0 model calls at replay
 * ```
 *
 * Everything on the second line is a measurement this stage can make from
 * artifacts that already exist. **The number on the first line is not.**
 * `82/100 (B+)` is a scoring policy — which tier is worth how much, what an
 * obstacle costs, where B+ starts — and the plan files it as U12, a separate
 * unit whose whole content is that policy, copied in shape from the printing
 * press's two-tier scorecard and not yet decided for navvi. Weights invented
 * here would be indistinguishable from weights somebody chose, and the first
 * person to read `78/100` would take it as a fact about the site rather than
 * about a constant in this file.
 *
 * So this stage reports every input the grade would be computed from and
 * refuses to compute it, in the artifact and in the stage block both. **U12 is
 * not done.** The plumbing is: the stage runs, writes `scorecard.md`, and is
 * part of the ledger, so U12 is a function added to this file rather than a
 * stage added to the driver.
 *
 * ## What it does measure, and which of them are claims
 *
 * The tier mix, the obstacle count, the field counts and the determinism
 * verdict are read straight out of the artifacts. The fill rate is the one
 * thing here that opens a page, and it is the only check in the whole pipeline
 * that runs the **final** compiled scraper against a real page — everything
 * before it argues about a scraper that has never been asked to do anything.
 * When no page driver is available it is absent rather than zero, because a
 * fill rate of "not measured" and a fill rate of "nothing came back" are the
 * two readings this repository keeps confusing.
 *
 * `modelCallsAtReplay` is the exception: it is a claim about the code and not a
 * count of anything. `compileFromReconciliation` asks nobody, and
 * `scraper/extract.ts` has no chooser to ask, so there is no path from a
 * compiled scraper to a model call. The field says so rather than pretending a
 * counter was read.
 */

export interface SourceMix {
  /** Fields whose first alternative is `json-ld` — what the page states about itself. */
  declared: number;
  /** Fields whose first alternative is `network` — the payload the page fetched for itself. */
  payload: number;
  /** Fields whose first alternative is a selector. */
  dom: number;
}

export interface FieldFill {
  field: string;
  /** URLs on which it came back non-null. */
  read: number;
  of: number;
}

export interface Scorecard {
  version: 1;
  site: string;
  /** The only field a re-run moves; injected, so a test and a diff can pin it. */
  recordedAt: string;
  requested: number;
  obtainable: number;
  compiled: number;
  /** Proved obtainable and not in the scraper. Never a silent difference: see `UnboundField`. */
  unbound: string[];
  mix: SourceMix;
  obstacles: { total: number; blocking: number };
  /** Zero by construction, not by counting. See the header. */
  modelCallsAtReplay: 0;
  modelCallsBecause: string;
  determinism: { verdict: Determinism["verdict"]; rejected: string[] } | null;
  /**
   * How much of what the determinism replays read was a value rather than
   * nothing, counted at the driver seam that took them. `null` when the stage
   * did not run this session, because a reused `determinism.json` carries no
   * values: a held field stores no forms, so the artifact names nothing that
   * could be counted. `FieldStability.readOn` now answers the per-field half of
   * this; the total here is what says `1 of 27` and `27 of 27` apart under a
   * verdict that reads the same either way. See `thinReplay` in `make.ts`.
   */
  determinismValues: { read: number; of: number } | null;
  /**
   * The same question, recounted from `determinism.json` itself: how many
   * (field, URL) pairs of the ones the record covers carried a value, summed
   * off each field's `readOn`.
   *
   * Present whenever there is a determinism record at all, including one this
   * session reused — which is the point of it. `determinismValues` is a closure
   * round the readings this run took and is gone on the next invocation; this
   * is arithmetic a person can redo with the file in front of them, so the
   * sentence under "Does it hold still" survives a re-run.
   */
  determinismCoverage: { read: number; of: number } | null;
  determinismBecause: string;
  /** Absent when no page was read. Absent is not zero. */
  fill: { urls: number; fields: FieldFill[] } | null;
  fillBecause: string;
  /** Always `null`. The 100-point grade is U12 and its weights are undecided. */
  grade: null;
  gradeBecause: string;
}

export interface ScorecardOptions {
  site: string;
  /** The clock, so a scorecard is reproducible. */
  now?: Date | undefined;
  /** One extraction per URL the verify replay read, or `null` when it did not run. */
  extractions?: readonly PageExtraction[] | null | undefined;
  /** Why there is no fill rate, when there is none. */
  fillBecause?: string | undefined;
  determinism?: Determinism | null | undefined;
  /** What the determinism replays read, when this session took them. See `Scorecard.determinismValues`. */
  determinismValues?: { read: number; of: number } | null | undefined;
  /** Why there is no determinism record, when there is none. */
  determinismBecause?: string | undefined;
}

const GRADE_BECAUSE =
  "No grade. The 100-point scorecard and its letter are U12, a separate unit whose entire content is the weighting — " +
  "how much a declared tier is worth against a payload tier, what an obstacle costs, where B+ starts. " +
  "Every input that grade would be computed from is above; inventing the weights here would produce a number " +
  "indistinguishable from one somebody chose.";

const MODEL_CALLS_BECAUSE =
  "Zero by construction rather than by counting: compileFromReconciliation asks nobody, and scraper/extract.ts has no chooser to ask, " +
  "so there is no path from a compiled scraper to a model call. This is a claim about the code and it is the code's job to keep it true.";

/** The tier a compiled field is actually read at: its first alternative, which is the one the cascade tries first. */
function mixOf(scraper: CompiledScraper): SourceMix {
  const mix: SourceMix = { declared: 0, payload: 0, dom: 0 };
  for (const field of Object.values(scraper.fields)) {
    const first = field.alternatives[0];
    const source = first?.source ?? "dom";
    if (source === "json-ld") mix.declared += 1;
    else if (source === "network") mix.payload += 1;
    else mix.dom += 1;
  }
  return mix;
}

/**
 * Per-field fill over the URLs the verify replay read.
 *
 * Counted over `items`, not over the page's top-level values: record mode puts
 * its one item in both places, so reading both would count a record page twice
 * — the same trap `readingOf` calls out in `determinism.ts`. A field that was
 * read on no item on a URL counts as not read there, which is what a client
 * means by a blank cell.
 */
function fillOf(scraper: CompiledScraper, extractions: readonly PageExtraction[]): FieldFill[] {
  return Object.keys(scraper.fields).map((field) => ({
    field,
    read: extractions.filter((page) => page.items.some((item) => item.values[field] !== null && item.values[field] !== undefined)).length,
    of: extractions.length,
  }));
}

export function scorecard(scraper: CompiledScraper, reconciliation: Reconciliation, unbound: readonly string[], options: ScorecardOptions): Scorecard {
  const now = options.now ?? new Date();
  const extractions = options.extractions ?? null;
  return {
    version: 1,
    site: options.site,
    recordedAt: now.toISOString(),
    requested: reconciliation.obtainable.length + reconciliation.notObtainable.length,
    obtainable: reconciliation.obtainable.length,
    compiled: Object.keys(scraper.fields).length,
    unbound: [...unbound],
    mix: mixOf(scraper),
    obstacles: { total: reconciliation.obstacles.length, blocking: reconciliation.obstacles.filter((obstacle) => obstacle.blocking).length },
    modelCallsAtReplay: 0,
    modelCallsBecause: MODEL_CALLS_BECAUSE,
    determinism: options.determinism ? { verdict: options.determinism.verdict, rejected: options.determinism.fields.filter((f) => f.rejected).map((f) => f.field) } : null,
    determinismValues: options.determinism ? (options.determinismValues ?? null) : null,
    determinismCoverage: options.determinism
      ? {
          read: options.determinism.fields.reduce((total, field) => total + field.readOn, 0),
          of: options.determinism.fields.length * options.determinism.urls.length,
        }
      : null,
    determinismBecause: options.determinism
      ? options.determinism.because
      : (options.determinismBecause ?? "the determinism stage did not run, so nothing here says the extraction holds still"),
    fill: extractions === null ? null : { urls: extractions.length, fields: fillOf(scraper, extractions) },
    fillBecause:
      extractions === null
        ? (options.fillBecause ?? "no page was read, so the compiled scraper has not been asked to do anything yet")
        : `the compiled scraper was replayed against ${extractions.length} of the sample's own URLs`,
    grade: null,
    gradeBecause: GRADE_BECAUSE,
  };
}

// --------------------------------------------------------------- the artifact

/** A count as a percentage of the compiled fields, or `n/a` when there are none to be a percentage of. */
function share(count: number, total: number): string {
  return total === 0 ? "n/a" : `${Math.round((count / total) * 100)}%`;
}

/**
 * The one line under the `verify` head in the plan's transcript, minus the
 * grade it cannot honestly print. Used by the stage block and by the artifact,
 * so the two cannot disagree about what was measured.
 */
export function measurements(card: Scorecard): string {
  const total = card.compiled;
  return (
    `declared ${share(card.mix.declared, total)} · payload ${share(card.mix.payload, total)} · dom ${share(card.mix.dom, total)}` +
    ` · ${card.obstacles.total} obstacle${card.obstacles.total === 1 ? "" : "s"} · ${card.modelCallsAtReplay} model calls at replay`
  );
}

/**
 * The fill as one line, for the stage block and the artifact both.
 *
 * Two fractions rather than one, and that is the whole point of this function.
 * The block used to print `fill 0 of 5` alone, which is the count of fields
 * read on *every* URL — so it says `fill 0 of 3` when nothing came back from
 * anywhere, and it also says `fill 0 of 3` when all three fields came back on
 * two of the three URLs. Those two Store B runs happened on the same day,
 * one on the default browser and one on `--browser chromium`, and printed the
 * same headline; the difference between "the scraper reads nothing" and "the
 * scraper reads, and one page did not answer" was recoverable only from the
 * bullets underneath. This repository already keeps the finding that a fill
 * rate with one number in it can be believed either way: on the Store C run
 * `product_name` was 111 of 111 filled against pages that were an apology.
 *
 * So the second fraction is every field on every URL: `0 of 9 reads` and
 * `6 of 9 reads` cannot be mistaken for each other.
 */
export function fillLine(card: Scorecard): string {
  if (card.fill === null) return "fill not measured";
  const everywhere = card.fill.fields.filter((field) => field.read === field.of).length;
  const read = card.fill.fields.reduce((total, field) => total + field.read, 0);
  const of = card.fill.fields.reduce((total, field) => total + field.of, 0);
  return `fill ${everywhere} of ${card.fill.fields.length} fields, ${read} of ${of} reads`;
}

/** `scorecard.md`. */
export function renderScorecard(card: Scorecard): string {
  const lines = [`# Scorecard — ${card.site}`, "", `Measured ${card.recordedAt}.`, "", measurements(card), ""];

  lines.push("## Grade", "", card.gradeBecause, "");

  lines.push("## Fields", "");
  lines.push("| | count |", "| --- | --- |");
  lines.push(`| requested by the spec | ${card.requested} |`);
  lines.push(`| proved obtainable | ${card.obtainable} |`);
  lines.push(`| compiled into the scraper | ${card.compiled} |`);
  lines.push(`| proved obtainable and not compiled | ${card.unbound.length} |`);
  if (card.unbound.length > 0) lines.push("", `Not compiled: ${card.unbound.join(", ")}. See \`rationale.md\` for what refused each one.`);
  lines.push("");

  lines.push("## Where the values come from", "");
  lines.push("| tier | fields | share |", "| --- | --- | --- |");
  lines.push(`| declared (json-ld) | ${card.mix.declared} | ${share(card.mix.declared, card.compiled)} |`);
  lines.push(`| payload (network) | ${card.mix.payload} | ${share(card.mix.payload, card.compiled)} |`);
  lines.push(`| dom (selector) | ${card.mix.dom} | ${share(card.mix.dom, card.compiled)} |`);
  lines.push("", "Counted on each field's **first** alternative, which is the one the cascade resolves first. A field with a dom fallback behind a payload binding counts as payload.", "");

  lines.push("## What it costs to run", "");
  lines.push(`- Obstacles: ${card.obstacles.total}, of which ${card.obstacles.blocking} blocking. See \`reconcile.md\` for what each one costs per run.`);
  lines.push(`- Model calls at replay: ${card.modelCallsAtReplay}. ${card.modelCallsBecause}`);
  lines.push("");

  lines.push("## Does it hold still", "");
  lines.push(card.determinism === null ? `Not measured. ${card.determinismBecause}` : `\`${card.determinism.verdict}\` — ${card.determinismBecause}`);
  if (card.determinism && card.determinism.rejected.length > 0) lines.push("", `Rejected as unstable: ${card.determinism.rejected.join(", ")}.`);
  // The sentence above is about movement and says nothing about how much there
  // was to move: a field that held stores no forms, so `determinism.json` names
  // the value of nothing it committed. Printed here because this artifact
  // outlives the transcript, and because "says the same thing twice about a
  // page nobody changed" sitting three lines above a table of zeroes is what
  // sent 2026-09-23 looking for a contradiction between two stages that were
  // agreeing. A partial read gets the same treatment as a blank one: `stable`
  // over 1 of 27 readings is the same believed sentence with a smaller number
  // behind it.
  const coverage = card.determinismCoverage;
  if (coverage !== null && coverage.of > 0 && coverage.read < coverage.of) {
    lines.push(
      "",
      coverage.read === 0
        ? `**No field was read on any of the ${coverage.of} (field, URL) pairs \`determinism.json\` covers.** What held still was a blank extraction; ` +
          "the verdict above is not evidence that this scraper read anything."
        : `**${coverage.read} of the ${coverage.of} (field, URL) pairs \`determinism.json\` covers carried a value.** ` +
          `The verdict above is about those and says nothing about the other ${coverage.of - coverage.read}.`,
      "",
      "Recounted from each field's own `readOn`, so a reader with the file can check it without having been here when it ran.",
    );
    // The finer count, when this session is the one that took the readings. A
    // reused record cannot produce it: a held field stores no forms.
    if (card.determinismValues !== null) {
      lines.push(
        "",
        card.determinismValues.of === 0
          ? "No replay produced an item at all."
          : `This run took ${card.determinismValues.of} field readings across every replay of every URL, and ${card.determinismValues.read} of them carried a value.`,
      );
    }
  } else if (card.determinismValues !== null && card.determinismValues.of === 0) {
    lines.push("", "**No replay produced an item**, so the verdict above is about pages that offered no row to compare.");
  }
  lines.push("");

  lines.push("## Does it actually read a page", "");
  if (card.fill === null) {
    lines.push(`Not measured. ${card.fillBecause}`);
    lines.push("", "This is the only check in the pipeline that runs the finished scraper against a real page. Without it every number above is an argument about an artifact nobody has asked to do anything.");
  } else {
    lines.push(card.fillBecause, "");
    lines.push("| field | read on |", "| --- | --- |");
    for (const field of card.fill.fields) lines.push(`| ${field.field} | ${field.read} of ${field.of} |`);
  }
  lines.push("");
  return lines.join("\n");
}
