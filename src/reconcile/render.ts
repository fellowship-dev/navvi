import type { TypedValue } from "../scraper/extract.js";
import { show } from "./reconcile.js";
import type { Ambiguity, DisagreementRecord, Reading, Reconciliation } from "./schema.js";

/**
 * The two spellings of a reconciliation, and they are not the same document.
 *
 * `render` is **the deliverable**: `reconcile.md`, the artifact the client
 * reads and argues with, next to `reconcile.json`. It is long on purpose -
 * every claim carries the evidence behind it, because a document that asserts
 * without showing is one you have to rerun the investigation to disagree with.
 *
 * `summarize` is the stage block the driver prints on stderr while the run is
 * happening, in the same shape `investigate/manuscript.ts` prints: the file
 * path on the right, the decision on the left, and nothing that restates the
 * file. Same discipline as `cli/render.ts`.
 */

const LABEL = 20;

function pad(label: string): string {
  return label.padEnd(LABEL, " ");
}

function parts(path: string): string[] {
  return path.split(/[.[\]]+/).filter((segment) => segment !== "");
}

/** The last segment of a path: `productData.prices[price-list-std]` becomes `price-list-std`. */
function tail(path: string): string {
  return parts(path).at(-1) ?? path;
}

/**
 * A leaf path without its root object: `productData.pum.value` becomes
 * `pum.value`.
 *
 * The tail alone is what the readings table wants, where the endpoint and the
 * field are already on the line. It is the wrong thing for a list of leaves
 * nobody asked for: `value`, `unit`, `metaTitle` and `sessionId` in one row
 * name nothing a reader can act on, and `pum.value` and `seo.metaTitle` do.
 */
function short(path: string): string {
  const segments = parts(path);
  return segments.length > 1 ? segments.slice(1).join(".") : path;
}

/**
 * How many fields the client asked for, which is not how many rows the
 * obtainable table has.
 *
 * U6b appends a column the spec never named - a second reading of a requested
 * field, traced to its own leaf - so counting the table would report "4 of 6"
 * for five requested fields and make the split look like a coverage gain.
 * A split field carries `splitFrom`, so it is subtracted here rather than
 * hidden from the table it belongs in.
 */
function asked(reconciliation: Reconciliation): number {
  return reconciliation.obtainable.filter((field) => field.splitFrom === undefined).length + reconciliation.notObtainable.length;
}

function first(values: readonly TypedValue[]): string {
  return values.length === 0 ? "-" : show(values[0]!);
}

/** `price-list-std 4990 | price-sale-std 4491`: how an ambiguity reads in one line. */
function readingsLine(readings: readonly Reading[]): string {
  return readings.map((reading) => `${tail(reading.path)} ${first(reading.values)}`).join(" | ");
}

// ------------------------------------------------------------ the stage block

/**
 * One block on stderr while the run is happening.
 *
 * Deliberately the transcript from the plan and not a summary of the markdown:
 * what a person watching a run needs is the count, the line that might change
 * the brief, and any call that is still open.
 */
export function summarize(reconciliation: Reconciliation, dataLine = ""): string {
  const requested = asked(reconciliation);
  const head = dataLine === "" ? "reconcile" : `reconcile${" ".repeat(Math.max(1, 54 - "reconcile".length))}${dataLine}`;
  const lines = [head];
  const bullet = (text: string): void => {
    lines.push(`  ${" ".repeat(LABEL)}${text}`);
  };

  const endpoints = [...new Set(reconciliation.obtainable.map((field) => field.match).filter((match) => match !== undefined))];
  const from = endpoints.length === 1 ? `, all from ${endpoints[0]}` : endpoints.length === 0 ? "" : `, from ${endpoints.length} sources`;
  const split = reconciliation.obtainable.filter((field) => field.splitFrom !== undefined);
  const extra = split.length === 0 ? "" : ` + ${split.length} split`;
  lines.push(`  ${pad("obtainable")}${reconciliation.obtainable.length - split.length} of ${requested}${extra}${from}`);

  for (const field of reconciliation.notObtainable) {
    lines.push(`  ${pad(field.kind === "type-gap" ? "type gap" : field.kind === "shared-path" ? "shared path" : "not obtainable")}${field.field}: ${field.because}`);
  }

  if (reconciliation.available.length > 0) {
    // The block is a glance, not the table: the leaves with both signals lead,
    // and the rest are counted rather than listed. reconcile.md has them all.
    const SHOWN = 6;
    const named = reconciliation.available.slice(0, SHOWN).map((leaf) => short(leaf.path));
    const rest = reconciliation.available.length - named.length;
    lines.push(`  ${pad("not requested")}${named.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`);
    if (reconciliation.availableEvidence === "rejected") {
      bullet("! read off the rejection set, not a leaf catalogue - incomplete, see reconcile.md");
    }
  }

  for (const ambiguity of reconciliation.ambiguities) {
    const decided = ambiguity.decidedBy;
    const settled = ambiguity.settledBy.length > 0 || decided !== undefined;
    lines.push(`  ${pad(decided !== undefined ? "ambiguity decided" : settled ? "ambiguity resolved" : "ambiguity open")}${ambiguity.field}: ${readingsLine(ambiguity.readings)}`);
    if (ambiguity.kind === "type-gap") bullet(`the spec asks for ${ambiguity.declaredType ?? "no type"}, the site states ${ambiguity.statedType}`);
    for (const rubric of ambiguity.settledBy) bullet(`rubric ${rubric.id}: "${rubric.rule}"`);
    if (decided !== undefined) bullet(`decided by ${decided.answeredBy}, asked ${decided.question}: ${decided.chose}`);
    else if (settled && ambiguity.resolved !== undefined) bullet(`-> ${tail(ambiguity.resolved)}   (without the rubric this stops)`);
    if (!settled && ambiguity.decision !== undefined) bullet(`? ${ambiguity.decision}`);
  }

  // U6b. A split is a column the client did not ask for arriving, which is the
  // one line in this block that can change the schema, so it names both fields.
  for (const record of reconciliation.disagreements ?? []) {
    const readings = record.readings.map((reading) => `${reading.source} ${show(reading.value)}`).join(" vs ");
    lines.push(`  ${pad(record.emitted.length > 0 ? "split" : "disagreement")}${record.field}: ${readings}`);
    for (const reading of record.readings) {
      if (reading.outcome === "split") bullet(`-> ${reading.emitted} from ${tail(reading.leaf ?? "")}, bound to its own leaf`);
      if (reading.outcome === "unaccounted") bullet(`! ${show(reading.value)} has no leaf behind it: the page is showing something this call did not return`);
      if (reading.outcome === "refused") bullet(`? ${reading.because}`);
    }
  }

  for (const obstacle of reconciliation.obstacles) {
    lines.push(`  ${pad("obstacle")}${obstacle.blocking ? "! " : "- "}${obstacle.kind}: ${obstacle.cost}`);
  }

  lines.push(`  ${pad(reconciliation.verdict)}${reconciliation.because}`);
  return lines.join("\n") + "\n";
}

// --------------------------------------------------------------- the artifact

function heading(text: string): string {
  return `\n## ${text}\n`;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/**
 * `reconcile.md`: the artifact.
 *
 * Five sections, in the order the plan names them, and each row carries what
 * it is claimed on. The client reads this and the spec; nobody has to open
 * `investigation.json` to check a binding.
 */
export function render(reconciliation: Reconciliation): string {
  const out: string[] = [];
  const requested = asked(reconciliation);

  out.push(`# Reconciliation: ${reconciliation.site}`);
  out.push("");
  out.push(`> ${reconciliation.brief}`);
  out.push("");
  out.push(`**${reconciliation.verdict}** - ${reconciliation.because}`);
  out.push("");
  out.push(`Reconciled ${reconciliation.reconciledAt} from the investigation manuscript. Nothing here opened a page or asked a model.`);

  // ------------------------------------------------------------- obtainable

  const split = reconciliation.obtainable.filter((field) => field.splitFrom !== undefined);
  out.push(heading(`Obtainable (${reconciliation.obtainable.length - split.length} of ${requested}${split.length === 0 ? "" : `, plus ${split.length} split out of a disagreement`})`));
  if (reconciliation.obtainable.length === 0) {
    out.push("Nothing was bound.");
  } else {
    out.push("| field | type | where from | sample values | why |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const field of reconciliation.obtainable) {
      const type = field.typeInferred ? `${field.type} *(inferred)*` : field.type;
      out.push(`| \`${field.field}\` | ${type} | tier ${field.tier}, \`${cell(field.where)}\` | ${cell(field.values.map(show).join(", "))} | ${cell(field.because)} |`);
    }
    const aliased = reconciliation.obtainable.filter((field) => field.aliases.length > 0);
    if (aliased.length > 0) {
      out.push("");
      // Each alias names the source it is read through, because that is what
      // decides whether it can be compiled at all - a JSON-LD path and an
      // OpenGraph property say the same thing and are resolved in completely
      // different ways.
      out.push("Free alternatives - other readings carrying the same value on every sample, which the compile may use without asking anybody:");
      out.push("");
      for (const field of aliased) out.push(`- \`${field.field}\`: ${field.aliases.map((alias) => `${alias.source} \`${alias.path}\``).join(", ")}`);
    }
  }

  // --------------------------------------------------------- not obtainable

  out.push(heading(`Not obtainable (${reconciliation.notObtainable.length})`));
  if (reconciliation.notObtainable.length === 0) {
    out.push("Every requested field was bound.");
  } else {
    for (const field of reconciliation.notObtainable) {
      out.push(`- **\`${field.field}\`**${field.type === undefined ? "" : ` (${field.type})`} - ${field.because}`);
      if (field.stillAsked) out.push(`  - tier 3 has been handed this field; the DOM compiler may still answer it.`);
      if (field.ambiguity !== undefined) out.push(`  - this is a decision, not an absence: see ambiguity \`${field.ambiguity}\`.`);
    }
  }

  // ----------------------------------------------- available, not requested

  out.push(heading(`Available but not requested (${reconciliation.available.length})`));
  out.push("What the site states about this record that nothing in the brief asked for. A leaf is here when it is present on every answering sample and either its value was in what the page showed a reader, or it moves across the samples - the two signals that it describes the record rather than the site, the session or the build. Neither is a claim that the client wants it; the rows are ordered by how many fired.");
  out.push("");
  if (reconciliation.availableEvidence === "rejected") {
    out.push(
      "> **Incomplete.** This manuscript carries no leaf catalogue, so the table below is read off the rejection set - leaves that lost a competition for a field the brief *did* name. `narrow` filters candidates by the requested field's declared type before anything is written down, so this list changes with the brief rather than with the site, and every leaf of a type nobody asked for is missing from it. See `Manuscript.inventory`.",
    );
    out.push("");
  }
  if (reconciliation.available.length === 0) {
    out.push("Nothing.");
  } else {
    out.push("| leaf | sample values | shown to a reader | varies | machinery |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const leaf of reconciliation.available) {
      const where = leaf.match === "" ? `\`${leaf.path}\`` : `${leaf.match} \`${leaf.path}\``;
      const anchored = leaf.anchored === undefined ? "not asked" : leaf.anchored ? "yes" : "no";
      const machinery = leaf.machinery === undefined ? "-" : `\`${leaf.machinery.heuristic}\``;
      out.push(`| ${cell(where)} | ${cell(leaf.values.map(show).join(", "))} | ${anchored} | ${leaf.varies ? "yes" : "no"} | ${machinery} |`);
    }
    const machinery = reconciliation.available.filter((leaf) => leaf.machinery !== undefined);
    if (machinery.length > 0) {
      out.push("");
      // The rows at the bottom of that table used to get there by arithmetic
      // and carry no sentence a client could disagree with. These are the ones
      // a rule put there, with what it saw - and navvi still lists them, because
      // the catalogue's point is that the client sees what the site offered.
      out.push("The last rows are there because a rule said so, not because the count came out low:");
      out.push("");
      for (const leaf of machinery) {
        out.push(`- \`${leaf.path}\` - ${leaf.machinery!.because}. ${leaf.machinery!.action}`);
      }
    }
  }

  // ------------------------------------------------------------ ambiguities

  out.push(heading(`Ambiguities (${reconciliation.ambiguities.length})`));
  if (reconciliation.ambiguities.length === 0) {
    out.push("No field had two readings and no declared type disagreed with the site.");
  } else {
    for (const ambiguity of reconciliation.ambiguities) out.push(...renderAmbiguity(ambiguity));
  }

  // ------------------------------------------------------- U6b: disagreements

  if (reconciliation.disagreements !== undefined) {
    const split = reconciliation.disagreements.flatMap((record) => record.emitted);
    out.push(heading(`Alternatives that disagreed (${reconciliation.disagreements.length})`));
    out.push(
      "A replay resolved one field through **every** alternative the compile gave it, on a page the compile never saw, and they came back with different values. That is not instability - each alternative is repeatable - and it is not a bad alternative to drop: the page states two facts and the spec asked for one. Each value is traced back to the leaf of this call that carried it, and a value that traces to its own leaf becomes its own column. A value that traces to nothing is the finding.",
    );
    out.push("");
    if (reconciliation.disagreements.length === 0) {
      out.push("Every field's alternatives returned the same value on every page they were both read on.");
    } else {
      if (split.length > 0) out.push(`**${split.length} new column(s):** ${split.map((name) => `\`${name}\``).join(", ")}. They are in the Obtainable table above, bound to their own leaves.`);
      for (const record of reconciliation.disagreements) out.push(...renderDisagreement(record));
    }
  }

  // -------------------------------------------------------------- obstacles

  out.push(heading(`Obstacles (${reconciliation.obstacles.length})`));
  if (reconciliation.obstacles.length === 0) {
    out.push("Nothing stood in the way.");
  } else {
    out.push("| | obstacle | what was met | what it costs |");
    out.push("| --- | --- | --- | --- |");
    for (const obstacle of reconciliation.obstacles) {
      const what = `${obstacle.because}${obstacle.url === undefined ? "" : ` (${obstacle.url})`}`;
      out.push(`| ${obstacle.blocking ? "**blocking**" : ""} | \`${obstacle.kind}\` | ${cell(what)} | ${cell(obstacle.cost)} |`);
    }
  }

  out.push("");
  return out.join("\n");
}

/**
 * One disagreement, with what every reading of it became.
 *
 * The `what it became` column is the whole point of the table: a reader who
 * remembers only one sentence about this section should remember that no
 * reading was ranked and none was dropped.
 */
function renderDisagreement(record: DisagreementRecord): string[] {
  const out: string[] = [];
  out.push("");
  out.push(`### \`${record.field}\``);
  out.push("");
  out.push(record.because);
  out.push("");
  out.push("| reading | value | the leaf behind it | what it became |");
  out.push("| --- | --- | --- | --- |");
  for (const reading of record.readings) {
    const became =
      reading.outcome === "split"
        ? `**\`${reading.emitted}\`**, a new column`
        : reading.outcome === "requested"
          ? `\`${record.field}\`, the column that was asked for`
          : reading.outcome === "unaccounted"
            ? "**nothing** - see below"
            : "nothing; a person decides";
    out.push(`| \`${reading.source}\` | ${cell(show(reading.value))} | ${reading.leaf === undefined ? "-" : `\`${cell(reading.leaf)}\``} | ${became} |`);
  }
  out.push("");
  for (const reading of record.readings) {
    if (reading.outcome === "requested") continue;
    out.push(`- \`${reading.source}\` ${show(reading.value)} - ${reading.because}`);
  }
  if (record.decision !== undefined) {
    out.push("");
    out.push(`**A person decides:** ${record.decision}`);
  }
  out.push("");
  return out;
}

function renderAmbiguity(ambiguity: Ambiguity): string[] {
  const out: string[] = [];
  out.push(`### \`${ambiguity.field}\` - ${ambiguity.kind}`);
  out.push("");
  out.push(ambiguity.because);
  out.push("");
  if (ambiguity.kind === "type-gap") {
    out.push(`| the spec asks for | the site states |`);
    out.push(`| --- | --- |`);
    out.push(`| \`${ambiguity.declaredType ?? "no type"}\` | \`${ambiguity.statedType ?? "unknown"}\` |`);
    out.push("");
  }
  out.push("| reading | values | |");
  out.push("| --- | --- | --- |");
  for (const reading of ambiguity.readings) {
    const where = `tier ${reading.tier}${reading.source === undefined ? "" : ` ${reading.source}`}${reading.match === undefined ? "" : ` ${reading.match}`} \`${reading.path}\``;
    out.push(`| ${cell(where)} | ${cell(reading.values.map(show).join(", "))} | ${reading.bound ? "**bound**" : ""} |`);
  }
  out.push("");
  if (ambiguity.settledBy.length > 0) {
    out.push("Settled by, quoted verbatim from the spec - navvi does not read the rule, it puts it beside the binding so the binding can be checked in one line:");
    out.push("");
    for (const rubric of ambiguity.settledBy) {
      out.push(`- **\`${rubric.id}\`** (${rubric.source}): "${rubric.rule}"`);
      out.push(`  - matched because ${rubric.because}`);
    }
    if (ambiguity.resolved !== undefined && ambiguity.decidedBy === undefined) {
      out.push("");
      out.push(`Bound to \`${ambiguity.resolved}\`. **Without the rule this stops.**`);
    }
  }
  if (ambiguity.decidedBy !== undefined) {
    const decided = ambiguity.decidedBy;
    out.push("");
    out.push(`Decided by **${decided.answeredBy}**, asked \`${decided.question}\` over ${decided.options} reading(s) (and \`none\`):`);
    out.push("");
    out.push(`> ${decided.premise}`);
    out.push("");
    out.push(`It chose \`${cell(decided.chose)}\`.`);
  }
  if (ambiguity.decision !== undefined) {
    out.push("");
    out.push(`**A client decides:** ${ambiguity.decision}`);
  }
  out.push("");
  return out;
}
