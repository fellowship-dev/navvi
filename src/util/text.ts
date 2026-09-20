/** Small text and value helpers shared across modules; no imports, so any module may use them. */

/** Replace lone UTF-16 surrogates without changing valid emoji or other surrogate pairs. */
export function wellFormed(text: string): string {
  // Unicode mode consumes valid pairs as one code point, so only lone surrogates match.
  return text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

/** At most `max` UTF-16 code units, including the ellipsis; never splits a surrogate pair. */
export function clip(s: string, max: number): string {
  if (max <= 0) return "";
  const text = wellFormed(s);
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
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
