import type { CompiledScraper } from "../scraper/schema.js";

/**
 * Template keys (R29, KTD15). A template is a host plus a URL pattern with the
 * variable path segments blanked. There is deliberately no DOM hash: two page
 * templates that land under one key are absorbed by merge healing, and
 * `templateGrowth` lets the summary say when a key's alternatives grew.
 *
 * Conventions:
 * - numeric segment            -> `{n}`
 * - uuid / long hex / opaque id -> `{id}`
 * - slug-like or varying        -> `{slug}`
 * - identical across all URLs   -> kept literally (even when numeric)
 * - a trailing page extension   -> kept as a literal suffix: `/producto/{slug}.html`
 * - query string dropped except pagination keys, kept as `?page={page}` so a
 *   paginated listing is its own template, apart from its bare first page.
 */

export const PAGINATION_KEYS = ["page", "p", "pagina", "offset", "start", "cursor"] as const;

const PAGE_EXTENSION = /\.(html?|php|aspx?|jsp|cfm|shtml)$/i;
const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const OPAQUE_ID = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{12,}$/i;
const SLUG = /^(?=.*[-_])(?=.*[a-z])(?=.*\d)[a-z0-9_-]+$/i;

type SegmentKind = "n" | "id" | "slug" | "literal";

function classify(segment: string): SegmentKind {
  if (NUMERIC.test(segment)) return "n";
  if (UUID.test(segment) || LONG_HEX.test(segment) || OPAQUE_ID.test(segment)) return "id";
  if (SLUG.test(segment)) return "slug";
  return "literal";
}

interface ParsedUrl {
  url: string;
  host: string;
  segments: string[];
  /** Literal suffix of the last segment, e.g. ".html"; empty when none. */
  extension: string;
  /** Sorted pagination keys present in the query string. */
  pagination: string[];
}

function parse(url: string): ParsedUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  let extension = "";
  const last = segments[segments.length - 1];
  if (last !== undefined) {
    const match = PAGE_EXTENSION.exec(last);
    if (match && match.index > 0) {
      extension = match[0].toLowerCase();
      segments[segments.length - 1] = last.slice(0, match.index);
    }
  }
  const pagination = PAGINATION_KEYS.filter((key) => parsed.searchParams.has(key)).sort();
  return { url, host: parsed.host.toLowerCase(), segments, extension, pagination };
}

function requireParsed(url: string): ParsedUrl {
  const parsed = parse(url);
  if (!parsed) throw new Error(`invalid URL: ${JSON.stringify(url)}`);
  return parsed;
}

/**
 * Bucket identity within a host: segment count, extension, pagination keys and
 * the first segment when it is a plain literal (a route prefix such as `/p` or
 * `/jobs`). Everything after the prefix is blanked when it varies.
 */
function bucketId(p: ParsedUrl): string {
  const first = p.segments[0];
  const prefix = first !== undefined && classify(first) === "literal" ? first : "*";
  return JSON.stringify([p.host, p.segments.length, p.extension, p.pagination, prefix]);
}

function patternOf(members: readonly ParsedUrl[]): string {
  const first = members[0];
  if (!first) throw new Error("a template needs at least one URL");
  const parts = first.segments.map((_, index) => {
    const values = new Set(members.map((m) => m.segments[index] ?? ""));
    const [only] = values;
    if (values.size === 1 && only !== undefined) {
      if (members.length > 1) return only;
      const kind = classify(only);
      return kind === "literal" ? only : `{${kind}}`;
    }
    const kinds = new Set([...values].map(classify));
    if (kinds.size === 1 && kinds.has("n")) return "{n}";
    if (kinds.size === 1 && kinds.has("id")) return "{id}";
    return "{slug}";
  });
  const path = `/${parts.join("/")}${first.extension}`;
  const query = first.pagination.map((key) => `${key}={${key}}`).join("&");
  return query.length > 0 ? `${path}?${query}` : path;
}

/** Pattern of the template that `urls[0]` belongs to, with the other URLs as context. Single host. */
export function urlPattern(urls: readonly string[]): string {
  if (urls.length === 0) throw new Error("urlPattern needs at least one URL");
  const parsed = urls.map(requireParsed);
  const lead = parsed[0];
  if (!lead) throw new Error("urlPattern needs at least one URL");
  const id = bucketId(lead);
  return patternOf(parsed.filter((p) => p.host === lead.host && bucketId(p) === id));
}

/** `${host}${pattern}`; the host is lowercased and the URL itself never appears. */
export function templateKey(host: string, pattern: string): string {
  return `${host.trim().toLowerCase()}${pattern}`;
}

/**
 * Groups URLs into templates: by host first, then by path shape and route
 * prefix, blanking the segments that vary. Duplicates collapse, invalid URLs
 * are dropped, and keys are sorted so the result is independent of input order.
 * URLs inside a group keep their first-seen order.
 */
export function groupByTemplate(urls: readonly string[]): Map<string, string[]> {
  const buckets = new Map<string, ParsedUrl[]>();
  const seen = new Set<string>();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const parsed = parse(url);
    if (!parsed) continue;
    const id = bucketId(parsed);
    const members = buckets.get(id);
    if (members) members.push(parsed);
    else buckets.set(id, [parsed]);
  }
  const grouped = new Map<string, string[]>();
  for (const members of buckets.values()) {
    const host = members[0]?.host ?? "";
    const key = templateKey(host, patternOf(members));
    const existing = grouped.get(key);
    const urlsOfBucket = members.map((m) => m.url);
    grouped.set(key, existing ? [...existing, ...urlsOfBucket] : urlsOfBucket);
  }
  return new Map([...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface TemplateGrowth {
  grew: boolean;
  /** Field names whose alternatives grew; detail fields are prefixed `detail.`. */
  fields: string[];
  /** Trace step indices whose locator alternatives grew. */
  steps: number[];
}

function grownFields(
  previous: CompiledScraper["fields"] | undefined,
  current: CompiledScraper["fields"] | undefined,
  prefix: string,
): string[] {
  if (!previous || !current) return [];
  return Object.keys(current)
    .filter((name) => {
      const before = previous[name]?.alternatives.length;
      const after = current[name]?.alternatives.length ?? 0;
      return before !== undefined && after > before;
    })
    .sort()
    .map((name) => `${prefix}${name}`);
}

/** R29: did a key's alternatives grow between two runs? The summary reports this. */
export function templateGrowth(previous: CompiledScraper | undefined, current: CompiledScraper): TemplateGrowth {
  if (!previous) return { grew: false, fields: [], steps: [] };
  const fields = [
    ...grownFields(previous.fields, current.fields, ""),
    ...grownFields(previous.detail?.fields, current.detail?.fields, "detail."),
  ];
  const steps = current.trace
    .map((step, index) => ({ index, after: step.alternatives.length, before: previous.trace[index]?.alternatives.length }))
    .filter(({ before, after }) => before !== undefined && after > before)
    .map(({ index }) => index);
  return { grew: fields.length > 0 || steps.length > 0, fields, steps };
}
