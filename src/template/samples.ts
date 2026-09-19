/**
 * R30: compile learns from up to three sample pages (record mode) or three
 * rows (list mode). Selection is deterministic: first seen, stable order.
 */

export const DEFAULT_SAMPLE_COUNT = 3;

/** First `max` distinct URLs in input order. */
export function pickSampleUrls(urls: readonly string[], max = DEFAULT_SAMPLE_COUNT): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (picked.length >= max) break;
    if (seen.has(url)) continue;
    seen.add(url);
    picked.push(url);
  }
  return picked;
}

/** First `max` row indices of a list with `itemCount` rows. */
export function pickSampleRows(itemCount: number, max = DEFAULT_SAMPLE_COUNT): number[] {
  const count = Math.max(0, Math.min(Math.floor(itemCount), max));
  return Array.from({ length: count }, (_, i) => i);
}
