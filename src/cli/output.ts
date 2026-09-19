/**
 * U17: the data writers. JSON is an array of records; CSV takes its header from
 * the union of keys in first-seen order and quotes per RFC 4180 (CRLF rows,
 * quotes doubled, fields quoted when they carry a comma, quote or line break).
 */

export type Row = Record<string, unknown>;

export function toJson(rows: readonly Row[], compact = false): string {
  return (compact ? JSON.stringify(rows) : JSON.stringify(rows, null, 2)) + "\n";
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvHeader(rows: readonly Row[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

export function toCsv(rows: readonly Row[]): string {
  const header = csvHeader(rows);
  const lines = [header.map(cell).join(",")];
  for (const row of rows) lines.push(header.map((key) => cell(row[key])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export type OutputFormat = "json" | "json-compact" | "csv";

export function formatRows(rows: readonly Row[], format: OutputFormat): string {
  switch (format) {
    case "csv":
      return toCsv(rows);
    case "json-compact":
      return toJson(rows, true);
    case "json":
      return toJson(rows);
  }
}
