import type { UsageSummary } from "../chooser/chooser.js";
import type { BankEntry } from "../heuristics/index.js";
import { blockingQuestions, requestedFields, underspecifiedFields, type Spec } from "../spec/schema.js";

/**
 * The human halves of `navvi spec` and `navvi heuristics`. Data goes to stdout
 * as JSON, as everywhere else in this CLI; these render the stderr summary,
 * which is what a person actually reads.
 */

export function specBlock(spec: Spec, dataLine: string): string {
  const requested = requestedFields(spec);
  const inferred = underspecifiedFields(spec);
  const blocking = blockingQuestions(spec);
  const lines = [`navvi: spec for ${spec.target.site} (${spec.target.pageKind} pages), one row per ${spec.entity.name}`];
  lines.push(`  inputs: ${spec.inputs.shape}${spec.inputs.shape === "unknown" ? ` — "${spec.inputs.description}"` : ""}`);
  lines.push(`  fields requested: ${requested.length > 0 ? requested.map((field) => field.name).join(", ") : "none — neither the brief nor an answer names a field"}`);
  if (inferred.length > 0) lines.push(`  fields inferred (the brief did not ask for these): ${inferred.map((field) => field.name).join(", ")}`);
  const stated = (["freshness", "volume", "cadence", "budget"] as const).filter((name) => spec.constraints[name].stated);
  lines.push(`  constraints stated: ${stated.length > 0 ? stated.map((name) => `${name} ${JSON.stringify(spec.constraints[name].value)}`).join(", ") : "none"}`);
  if (spec.rubrics.length > 0) lines.push(`  case rubrics: ${spec.rubrics.map((rubric) => rubric.id).join(", ")}`);
  if (spec.openQuestions.length === 0) {
    lines.push("  open questions: none");
  } else {
    lines.push(`  open questions (${blocking.length} blocking of ${spec.openQuestions.length}):`);
    for (const question of spec.openQuestions) {
      lines.push(`    ${question.blocking ? "!" : "-"} [${question.id}] ${question.question}`);
      lines.push(`        because ${question.because}; ${question.answeredBy} answers`);
    }
  }
  lines.push(blocking.length === 0 ? "  ready to investigate." : "  not ready to investigate: answer the blocking questions and recompile the spec.");
  if (dataLine) lines.push(`  ${dataLine}`);
  return lines.join("\n") + "\n";
}

export function heuristicsBlock(entries: readonly BankEntry[]): string {
  const lines = [`navvi: ${entries.length} heuristic${entries.length === 1 ? "" : "s"} — what decides which question is even asked`];
  for (const { heuristic, override } of entries) {
    lines.push("");
    lines.push(`  ${heuristic.id}  (${heuristic.stage})${override?.enabled === false ? "  [disabled for this case]" : ""}`);
    lines.push(`    ${heuristic.title}`);
    lines.push(`    decides: ${heuristic.decides}`);
    lines.push(`    from:    ${heuristic.encounter}`);
    if (override) lines.push(`    override: ${override.enabled ? "enabled" : "disabled"} — ${override.note}`);
  }
  return lines.join("\n") + "\n";
}

/** One heuristic in full, for `navvi heuristics <id>`: adds the observation shape it accepts. */
export function heuristicBlock(entry: BankEntry): string {
  return heuristicsBlock([entry]) + `\n    observation shape:\n${JSON.stringify(entry.heuristic.jsonSchema, null, 2).replace(/^/gm, "      ")}\n`;
}

// ------------------------------------------------------------ U11: the driver

/**
 * The stage block of `navvi make`: the decision on the left, the artifact path
 * on the right, and nothing that restates the file.
 *
 * Three column positions, and they are the same three
 * `investigate/manuscript.ts`, `reconcile/render.ts` and
 * `replay/determinism.ts` already spell privately — those three stages print
 * their own blocks and the driver prints the other five, so all eight have to
 * line up in one terminal. This is a layout constant rather than a rule, which
 * is why a fourth private copy is tolerable where a fourth copy of a *rule*
 * would not be; the moment one of those three exports its numbers, these three
 * lines should become an import. See `tests/second-spelling.test.ts` for the
 * house rule this is deliberately just outside of.
 */
const STAGE_HEAD = 14;
const STAGE_DATA = 54;
const STAGE_BULLET = 16;

/**
 * One stage's head line. `summary` is what the stage decided; `dataLine` is
 * where it wrote it, and an empty one means the stage wrote nothing — which is
 * a fact about the stage and never a tidier version of the same line.
 */
export function makeStage(label: string, summary: string, dataLine = ""): string {
  const head = label.padEnd(STAGE_HEAD, " ") + summary;
  if (dataLine === "") return head.trimEnd() + "\n";
  // A summary wider than the column pushes the path onto its own aligned line
  // rather than running into it. A path with no space in front of it is a path
  // nobody can copy, and truncating the summary instead would hide the half of
  // the line that says what the stage decided.
  if (head.length >= STAGE_DATA) return `${head.trimEnd()}\n${makeArtifact(dataLine)}`;
  return head.padEnd(STAGE_DATA, " ") + dataLine + "\n";
}

/**
 * A further artifact from a stage that already printed its head: the path on
 * the right and nothing on the left, which is how the plan's transcript shows
 * `rationale.md` and `machine.mmd` under `compile`.
 */
export function makeArtifact(dataLine: string): string {
  return " ".repeat(STAGE_DATA) + dataLine + "\n";
}

/**
 * A row under a stage: the stage's own sub-heading, with no mark. `compile`'s
 * `5 fields` line in the plan's transcript is one of these, and so is every row
 * `reconcile/render.ts` prints.
 */
export function makeRow(label: string, text: string): string {
  return `  ${label.padEnd(STAGE_BULLET - 2, " ")}${text}\n`;
}

/**
 * A bullet under a stage. `mark` is `!` for something a person has to act on
 * and `-` for something they only have to know, which is the same split
 * `reconcile/render.ts` and `investigate/manuscript.ts` print.
 *
 * `width` is the group's, not this line's. A caller printing several bullets
 * passes `bulletWidth(labels)` so the texts line up in one column; without it
 * each line sets its own and a list of ids of different lengths comes out as a
 * staircase, which is what the plan's transcript is not.
 */
export function makeBullet(label: string, text: string, mark: "!" | "-" = "-", width = bulletWidth([label])): string {
  return `  ${mark} ${label.padEnd(width, " ")}${text}\n`;
}

/** The column a group of bullets shares: the default, or wide enough for the longest label. */
export function bulletWidth(labels: readonly string[]): number {
  return Math.max(STAGE_BULLET - 4, ...labels.map((label) => label.length + 2));
}

/**
 * A continuation under a bullet, aligned with its text. `width` is the bullet
 * group's column when the group widened past the default.
 */
export function makeNote(text: string, width = STAGE_BULLET): string {
  return " ".repeat(width) + text + "\n";
}

/**
 * The last line of a run that stopped, with the exit code spelled out.
 *
 * The code is printed rather than left to the shell because the first
 * transcript in the plan prints it, and because the whole point of stopping at
 * a blocking question is that a person — or an agent reading stderr — knows the
 * difference between "navvi failed" and "navvi is waiting for you".
 */
export function makeStop(stage: string, because: string, exit: number): string {
  return `stopped at ${stage}: ${because} (exit ${exit})\n`;
}

// ------------------------------------------------------------ chooser usage

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * U7: one line per role, each with its own share, so every question is
 * attributed to whoever answered it. The run's totals are the decider's own
 * work plus the writer's; the decider line is the difference. A decider that
 * wrote its own text gets one line with both counts.
 *
 * Moved here from `bin/cli.ts` for U4, because `navvi make` prints the same
 * lines: it asks the chooser every tier-3 question, and a second spelling of
 * who answered what is exactly how the two front ends would come to disagree.
 */
export function chooserLines(c: UsageSummary): string[] {
  const w = c.writer;
  const decisions = c.questions - (c.textQuestions ?? 0);
  const ownText = (c.textQuestions ?? 0) - (w?.textQuestions ?? 0);
  const cost = (tokens: number, waitMs: number, usd: number): string => `${tokens} input tokens, ${fmtMs(waitMs)} waiting, $${usd.toFixed(4)}`;
  const own = cost(c.inputTokens - (w?.inputTokens ?? 0), c.waitMs - (w?.waitMs ?? 0), c.costUsd - (w?.costUsd ?? 0));
  const lines = ownText > 0
    ? [`  decider and writer ${c.name}: ${plural(decisions, "decision", "decisions")}, ${plural(ownText, "text question", "text questions")}, ${own}`]
    : [`  decider ${c.name}: ${plural(decisions, "decision", "decisions")}, ${own}`];
  if (w) lines.push(`  writer ${w.name}: ${plural(w.textQuestions, "text question", "text questions")}, ${cost(w.inputTokens, w.waitMs, w.costUsd)}`);
  const f = c.transportFallback;
  if (f) lines.push(`  decider transport: fell back from ${f.from} to ${f.to} (${f.reason})`);
  return lines;
}
