/**
 * U18 / R44: the one measurements table. `renderTable` writes it,
 * `readMeasurements` parses it back (the README include and the tests),
 * `replaceSection` rewrites it between the markers of docs/measurements.md
 * and `renderReadmeSection` folds it into the per-chooser summary the README
 * shows. Every number the table carries survives a render/parse round trip:
 * milliseconds and counts are integers, cost has six decimals, fields correct
 * is the exact `correct/expected` fraction.
 */

export const MEASUREMENTS_START = "<!-- measurements:start -->";
export const MEASUREMENTS_END = "<!-- measurements:end -->";

export type MeasurementStatus = "ok" | "failed" | "skipped";

export interface MeasurementRow {
  /** The chooser column: agent, jev or model (R37). */
  chooser: string;
  /** Scenario id: AE1, AE7, AE8, AE15 or `live:<site>`. */
  scenario: string;
  questions: number;
  inputTokens: number;
  /** Wall time spent waiting on the chooser (ms). For a recorded replay this is the replay's own. */
  chooserWaitMs: number;
  /** Wall time of the whole scenario, browser included (ms). */
  totalMs: number;
  /** Cost at list price. */
  costUsd: number;
  cells: { correct: number; expected: number };
  healingEvents: number;
  status: MeasurementStatus;
  /** Why the row was skipped (no key, no network, recorded-only chooser). */
  skipped?: string;
}

/** R44: correct over expected cells, 0 when nothing was expected. */
export function fieldsCorrect(row: Pick<MeasurementRow, "cells">): number {
  return row.cells.expected === 0 ? 0 : row.cells.correct / row.cells.expected;
}

export const TABLE_COLUMNS = ["chooser", "scenario", "questions", "input tokens", "chooser wait (ms)", "total wall (ms)", "cost (USD)", "fields correct", "healing events", "status"] as const;

const COST_DECIMALS = 6;

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function statusCell(row: MeasurementRow): string {
  return row.status === "skipped" ? `skipped: ${row.skipped ?? "no reason given"}` : row.status;
}

/** One markdown row per measurement, in the given order. */
export function renderTable(rows: readonly MeasurementRow[]): string {
  const header = `| ${TABLE_COLUMNS.join(" | ")} |`;
  const rule = `|${TABLE_COLUMNS.map(() => "---").join("|")}|`;
  const lines = rows.map((r) =>
    `| ${[
      r.chooser,
      r.scenario,
      String(r.questions),
      String(r.inputTokens),
      String(Math.round(r.chooserWaitMs)),
      String(Math.round(r.totalMs)),
      r.costUsd.toFixed(COST_DECIMALS),
      `${r.cells.correct}/${r.cells.expected}`,
      String(r.healingEvents),
      statusCell(r),
    ]
      .map(cell)
      .join(" | ")} |`,
  );
  return [header, rule, ...lines].join("\n");
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function parseFraction(text: string): { correct: number; expected: number } {
  const m = /^(\d+)\/(\d+)$/.exec(text);
  if (!m) throw new Error(`fields correct cell "${text}" is not correct/expected`);
  return { correct: Number(m[1]), expected: Number(m[2]) };
}

function parseStatus(text: string): { status: MeasurementStatus; skipped?: string } {
  if (text.startsWith("skipped")) return { status: "skipped", skipped: text.replace(/^skipped:?\s*/, "") };
  if (text === "ok" || text === "failed") return { status: text };
  throw new Error(`unknown status cell "${text}"`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The marker block: each marker on a line of its own, so prose that mentions a marker never counts. */
function findSection(md: string): { start: number; end: number } | null {
  const start = new RegExp(`^[ \\t]*${escapeRegExp(MEASUREMENTS_START)}[ \\t]*$`, "m").exec(md);
  if (!start) return null;
  const from = start.index + start[0].length;
  const end = new RegExp(`^[ \\t]*${escapeRegExp(MEASUREMENTS_END)}[ \\t]*$`, "m").exec(md.slice(from));
  if (!end) return null;
  const startAt = start.index + start[0].indexOf(MEASUREMENTS_START);
  const endAt = from + end.index + end[0].indexOf(MEASUREMENTS_END);
  return { start: startAt, end: endAt };
}

/**
 * Parses the measurements table out of a markdown document: the one between
 * the markers when present, else the first table whose header starts with
 * `chooser | scenario`.
 */
export function readMeasurements(md: string): MeasurementRow[] {
  const section = findSection(md);
  const body = section ? md.slice(section.start + MEASUREMENTS_START.length, section.end) : md;
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  const headerAt = lines.findIndex((l) => /^\|\s*chooser\s*\|\s*scenario\s*\|/.test(l));
  if (headerAt < 0) return [];
  const header = splitRow(lines[headerAt]!);
  const index = (name: (typeof TABLE_COLUMNS)[number]): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`measurements table has no "${name}" column`);
    return i;
  };
  const at = Object.fromEntries(TABLE_COLUMNS.map((c) => [c, index(c)])) as Record<(typeof TABLE_COLUMNS)[number], number>;
  const rows: MeasurementRow[] = [];
  for (const line of lines.slice(headerAt + 2)) {
    const cells = splitRow(line);
    if (cells.length < TABLE_COLUMNS.length) continue;
    const pick = (c: (typeof TABLE_COLUMNS)[number]): string => cells[at[c]] ?? "";
    const fraction = parseFraction(pick("fields correct"));
    const { status, skipped } = parseStatus(pick("status"));
    const row: MeasurementRow = {
      chooser: pick("chooser"),
      scenario: pick("scenario"),
      questions: Number(pick("questions")),
      inputTokens: Number(pick("input tokens")),
      chooserWaitMs: Number(pick("chooser wait (ms)")),
      totalMs: Number(pick("total wall (ms)")),
      costUsd: Number(pick("cost (USD)")),
      cells: fraction,
      healingEvents: Number(pick("healing events")),
      status,
    };
    if (skipped !== undefined) row.skipped = skipped;
    rows.push(row);
  }
  return rows;
}

/** Replaces the block between the markers with `table`; appends the block when the document has no markers. */
export function replaceSection(md: string, table: string): string {
  const block = `${MEASUREMENTS_START}\n${table}\n${MEASUREMENTS_END}`;
  const section = findSection(md);
  if (section) return md.slice(0, section.start) + block + md.slice(section.end + MEASUREMENTS_END.length);
  const sep = md.length === 0 || md.endsWith("\n\n") ? "" : md.endsWith("\n") ? "\n" : "\n\n";
  return `${md}${sep}${block}\n`;
}

interface ChooserSummary {
  chooser: string;
  ran: number;
  skipped: number;
  questions: number;
  inputTokens: number;
  chooserWaitMs: number;
  costUsd: number;
  correct: number;
  expected: number;
  healingEvents: number;
  reasons: Set<string>;
}

function summarise(rows: readonly MeasurementRow[]): ChooserSummary[] {
  const byChooser = new Map<string, ChooserSummary>();
  for (const r of rows) {
    let s = byChooser.get(r.chooser);
    if (!s) byChooser.set(r.chooser, (s = { chooser: r.chooser, ran: 0, skipped: 0, questions: 0, inputTokens: 0, chooserWaitMs: 0, costUsd: 0, correct: 0, expected: 0, healingEvents: 0, reasons: new Set() }));
    if (r.status === "skipped") {
      s.skipped += 1;
      if (r.skipped) s.reasons.add(r.skipped);
      continue;
    }
    s.ran += 1;
    s.questions += r.questions;
    s.inputTokens += r.inputTokens;
    s.chooserWaitMs += r.chooserWaitMs;
    s.costUsd += r.costUsd;
    s.correct += r.cells.correct;
    s.expected += r.cells.expected;
    s.healingEvents += r.healingEvents;
  }
  return [...byChooser.values()];
}

const CHOOSER_NOTES: Record<string, string> = {
  agent: "recorded replay of a host agent's answers unless measured with `--agent-live`; the wait is the replay's own, not a person's or a host model's think time",
  jev: "TypeSafe Jev at $0.042 per million input tokens, output free",
  model: "language-model chooser at the `MODEL_PRICES` list price",
};

/**
 * The compact per-chooser summary the README shows: scenarios run, questions,
 * input tokens, chooser wait, cost and fields correct, summed over every
 * scenario that ran; skipped scenarios carry their reason.
 */
export function renderReadmeSection(rows: readonly MeasurementRow[]): string {
  const header = "| chooser | scenarios | questions | input tokens | chooser wait | cost (USD) | fields correct | healing events | note |";
  const rule = "|---|---|---|---|---|---|---|---|---|";
  const lines = summarise(rows).map((s) => {
    const scenarios = s.skipped > 0 ? `${s.ran} run, ${s.skipped} skipped` : `${s.ran} run`;
    const wait = `${(s.chooserWaitMs / 1000).toFixed(1)} s`;
    const fields = s.expected === 0 ? "n/a" : `${s.correct}/${s.expected} (${((100 * s.correct) / s.expected).toFixed(1)}%)`;
    const note = s.ran === 0 ? `skipped: ${[...s.reasons].join("; ") || "no reason given"}` : (CHOOSER_NOTES[s.chooser] ?? "");
    return `| ${[s.chooser, scenarios, String(s.questions), String(s.inputTokens), wait, s.costUsd.toFixed(COST_DECIMALS), fields, String(s.healingEvents), note].map(cell).join(" | ")} |`;
  });
  return [header, rule, ...lines].join("\n");
}
