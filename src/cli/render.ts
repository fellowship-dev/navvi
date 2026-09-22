import type { BankEntry } from "../heuristics/index.js";
import { blockingQuestions, underspecifiedFields, type Spec } from "../spec/schema.js";

/**
 * The human halves of `navvi spec` and `navvi heuristics`. Data goes to stdout
 * as JSON, as everywhere else in this CLI; these render the stderr summary,
 * which is what a person actually reads.
 */

export function specBlock(spec: Spec, dataLine: string): string {
  const requested = spec.fields.filter((field) => field.provenance === "brief");
  const inferred = underspecifiedFields(spec);
  const blocking = blockingQuestions(spec);
  const lines = [`navvi: spec for ${spec.target.site} (${spec.target.pageKind} pages), one row per ${spec.entity.name}`];
  lines.push(`  inputs: ${spec.inputs.shape}${spec.inputs.shape === "unknown" ? ` — "${spec.inputs.description}"` : ""}`);
  lines.push(`  fields requested: ${requested.length > 0 ? requested.map((field) => field.name).join(", ") : "none — the brief names no field"}`);
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
