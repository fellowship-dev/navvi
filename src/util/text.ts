/** Small text and value helpers shared across modules; no imports, so any module may use them. */

/** `s` cut to `max` characters, the last one an ellipsis when it was longer. `max` under 1 yields "". */
export function clip(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Accent-free, lower-case, single-spaced, trimmed: the form names and terms are compared in. */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves after `ms`; immediately when `ms` is not positive. */
export function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
