import type { TypedValue } from "../scraper/extract.js";
import { show } from "./reconcile.js";
import type { Ambiguity, Reading, Reconciliation } from "./schema.js";

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
  const requested = reconciliation.obtainable.length + reconciliation.notObtainable.length;
  const head = dataLine === "" ? "reconcile" : `reconcile${" ".repeat(Math.max(1, 54 - "reconcile".length))}${dataLine}`;
  const lines = [head];
  const bullet = (text: string): void => {
    lines.push(`  ${" ".repeat(LABEL)}${text}`);
  };

  const endpoints = [...new Set(reconciliation.obtainable.map((field) => field.match).filter((match) => match !== undefined))];
  const from = endpoints.length === 1 ? `, all from ${endpoints[0]}` : endpoints.length === 0 ? "" : `, from ${endpoints.length} sources`;
  lines.push(`  ${pad("obtainable")}${reconciliation.obtainable.length} of ${requested}${from}`);

  for (const field of reconciliation.notObtainable) {
    lines.push(`  ${pad(field.kind === "type-gap" ? "type gap" : "not obtainable")}${field.field}: ${field.because}`);
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
    const settled = ambiguity.settledBy.length > 0;
    lines.push(`  ${pad(settled ? "ambiguity resolved" : "ambiguity open")}${ambiguity.field}: ${readingsLine(ambiguity.readings)}`);
    if (ambiguity.kind === "type-gap") bullet(`the spec asks for ${ambiguity.declaredType ?? "no type"}, the site states ${ambiguity.statedType}`);
    for (const rubric of ambiguity.settledBy) bullet(`rubric ${rubric.id}: "${rubric.rule}"`);
    if (settled && ambiguity.resolved !== undefined) bullet(`-> ${tail(ambiguity.resolved)}   (without the rubric this stops)`);
    if (!settled && ambiguity.decision !== undefined) bullet(`? ${ambiguity.decision}`);
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
  const requested = reconciliation.obtainable.length + reconciliation.notObtainable.length;

  out.push(`# Reconciliation: ${reconciliation.site}`);
  out.push("");
  out.push(`> ${reconciliation.brief}`);
  out.push("");
  out.push(`**${reconciliation.verdict}** - ${reconciliation.because}`);
  out.push("");
  out.push(`Reconciled ${reconciliation.reconciledAt} from the investigation manuscript. Nothing here opened a page or asked a model.`);

  // ------------------------------------------------------------- obtainable

  out.push(heading(`Obtainable (${reconciliation.obtainable.length} of ${requested})`));
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
      out.push("Free alternatives - other paths carrying the same value on every sample, which the compile may use without asking anybody:");
      out.push("");
      for (const field of aliased) out.push(`- \`${field.field}\`: ${field.aliases.map((alias) => `\`${alias}\``).join(", ")}`);
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
    out.push("| leaf | sample values | shown to a reader | varies |");
    out.push("| --- | --- | --- | --- |");
    for (const leaf of reconciliation.available) {
      const where = leaf.match === "" ? `\`${leaf.path}\`` : `${leaf.match} \`${leaf.path}\``;
      const anchored = leaf.anchored === undefined ? "not asked" : leaf.anchored ? "yes" : "no";
      out.push(`| ${cell(where)} | ${cell(leaf.values.map(show).join(", "))} | ${anchored} | ${leaf.varies ? "yes" : "no"} |`);
    }
  }

  // ------------------------------------------------------------ ambiguities

  out.push(heading(`Ambiguities (${reconciliation.ambiguities.length})`));
  if (reconciliation.ambiguities.length === 0) {
    out.push("No field had two readings and no declared type disagreed with the site.");
  } else {
    for (const ambiguity of reconciliation.ambiguities) out.push(...renderAmbiguity(ambiguity));
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
    if (ambiguity.resolved !== undefined) {
      out.push("");
      out.push(`Bound to \`${ambiguity.resolved}\`. **Without the rule this stops.**`);
    }
  }
  if (ambiguity.decision !== undefined) {
    out.push("");
    out.push(`**A client decides:** ${ambiguity.decision}`);
  }
  out.push("");
  return out;
}
