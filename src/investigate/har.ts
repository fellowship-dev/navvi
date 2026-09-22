import type { CapturedResponse } from "../browser/network-capture.js";

/**
 * U2e: a capture stands in for the browser.
 *
 * `browser/network-capture.ts` watches a page call its own API and keeps every
 * JSON answer. This does the same thing from a file. A HAR — what Chrome
 * DevTools writes under "Save all as HAR (with content)" — is the same traffic,
 * recorded by somebody else's browser, and once it is parsed into the same
 * `CapturedResponse[]` every stage downstream (`flatten`, `narrow`, `bindField`,
 * and `resolveDeclared` at replay) cannot tell the two apart. That is the whole
 * point of this module: one shape, two ways of filling it.
 *
 * Why it exists: StoreC serves an apology page to a datacenter IP — a run from
 * Apify came back with `sku 0/111`, `stock 0/111` and `¡Lo sentimos!` sitting
 * where a product name belongs — while the same URLs read perfectly from a
 * laptop in Valdivia. Importing a capture separates *can we build this* from
 * *can we run it daily*: the scraper compiles today from a capture a human took
 * on a machine the store answers, and the proxy question goes back where it
 * belongs, with the production run. The ergonomic is borrowed from
 * `mvanhorn/cli-printing-press`, whose browser-sniff gate takes `--har` for
 * exactly this reason.
 *
 * Pure, offline, no network, no browser. Takes HAR text or an already-parsed
 * object, and never throws: a HAR is something a person exported under time
 * pressure on a machine you do not control, so half of one is still worth
 * reading. A bad entry is skipped and counted, never fatal.
 *
 * ## Secrets
 *
 * A HAR records *everything* — `Authorization`, `Cookie`, `Set-Cookie`, every
 * bearer token the page held while it was captured. This repository's rule is
 * that a secret value never enters a chooser question, a log, a trace or the
 * scraper JSON, so the cheapest way to keep that rule is to never carry the
 * secrets out of the file: headers and cookies are not read, not returned, and
 * have no field to live in. What does come out is the URL (`resolveDeclared`
 * matches on a substring of it, so it has to) and the response body (that *is*
 * the payload under investigation). A URL's query string is where the other
 * half of the tokens live — `?token=...`, `?sig=...` — so anything that prints
 * a URL prints `safeUrl(url)`, never the URL.
 */

export type { CapturedResponse };

export interface HarImport {
  /**
   * The JSON answers, in the order the capture made the calls.
   *
   * Order is load-bearing and nothing here is deduplicated or filtered on
   * status: `resolveDeclared` walks this list newest-first because a page that
   * retries leaves the failure behind too, and Store B's detail endpoint
   * answers 401 before its anonymous session exists and 200 after. Drop the
   * 401 and the list still works; drop the *order* and "newest that works"
   * silently becomes "some call that worked", which is how you bind a field to
   * a stale first attempt.
   */
  responses: CapturedResponse[];
  /**
   * The HTML documents the capture holds, by URL — tier 1 (JSON-LD, microdata,
   * `og:`) reads page HTML, and a HAR carries it, so importing one can answer
   * tier 1 with no request at all. Deliberately a separate field: an HTML
   * document is not a JSON payload and must never be flattened as one.
   *
   * A `Map`, not an object, because the keys are URLs off a file a stranger
   * produced and `__proto__` is a legal path segment. A reload leaves the same
   * URL twice; the later capture wins, on the same "newest wins" reading as
   * `responses`.
   */
  documents: Map<string, string>;
  /** Entries in the log, usable or not. */
  entries: number;
  /**
   * Entries that announced JSON or HTML and then could not be read — no
   * `content.text`, text cut off mid-object, base64 that decodes to noise.
   * This is the number that tells a human their export is truncated or was
   * taken without "with content", which is a different problem from a site
   * that simply never returned JSON.
   */
  unreadable: number;
}

/** HAR text, or the same thing already `JSON.parse`d. */
export function importHar(source: unknown): HarImport {
  const out: HarImport = { responses: [], documents: new Map(), entries: 0, unreadable: 0 };
  const entries = readEntries(source);
  if (!entries) return out;
  out.entries = entries.length;
  for (const entry of chronological(entries)) readEntry(entry, out);
  return out;
}

/**
 * A URL with its query string amputated, for anything that prints one.
 *
 * `?token=`, `?sig=`, `?access_token=` — a captured URL carries credentials as
 * often as a header does, and a log line is forever. The path is what a human
 * needs to recognise an endpoint anyway.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // `origin` already drops any user:password@ the capture recorded.
    return `${parsed.origin}${parsed.pathname}${parsed.search === "" ? "" : "?…"}`;
  } catch {
    const cut = url.indexOf("?");
    return cut === -1 ? url : `${url.slice(0, cut)}?…`;
  }
}

// ------------------------------------------------------------------ reading

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `log.entries`, from text or an object, or null when this is not a HAR. */
function readEntries(source: unknown): readonly unknown[] | null {
  let root: unknown = source;
  if (typeof source === "string") {
    // A truncated export does not parse at all. That is a file that tells you
    // nothing, not a crash: the caller reports "0 entries" and the human
    // re-exports.
    try { root = JSON.parse(source); } catch { return null; }
  }
  if (!isRecord(root)) return null;
  const log = root["log"];
  if (!isRecord(log)) return null;
  const entries = log["entries"];
  return Array.isArray(entries) ? entries : null;
}

function startedAt(entry: unknown): number | null {
  if (!isRecord(entry)) return null;
  const raw = entry["startedDateTime"];
  if (typeof raw !== "string") return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

/**
 * File order, repaired only when it is provably wrong.
 *
 * HAR 1.2 says entries are sorted by `startedDateTime`, and every exporter
 * worth the name writes them that way — so the default is to touch nothing,
 * because re-sorting on a timestamp a proxy wrote is guessing about an order
 * the file already states. But some tools group entries by connection, and a
 * capture whose 200 sits above its 401 would hand `resolveDeclared` the failure
 * as the newest answer. So: if every entry carries a readable timestamp and
 * they are out of order, stable-sort by it — stable, so entries sharing a
 * millisecond keep the order the file gave them.
 */
function chronological(entries: readonly unknown[]): readonly unknown[] {
  const stamped: { entry: unknown; index: number; at: number }[] = [];
  for (const [index, entry] of entries.entries()) {
    const at = startedAt(entry);
    // One unstamped entry and the whole comparison is guesswork: leave the
    // file's own order alone.
    if (at === null) return entries;
    stamped.push({ entry, index, at });
  }
  const ordered = stamped.every((item, index) => index === 0 || item.at >= stamped[index - 1]!.at);
  if (ordered) return entries;
  return [...stamped].sort((a, b) => a.at - b.at || a.index - b.index).map((item) => item.entry);
}

type ContentKind = "json" | "html" | "maybe" | "other";

/**
 * What a `mimeType` promises. `maybe` is the honest answer for an API that
 * answers `text/plain` or forgets the header entirely — common enough that
 * refusing those loses real payloads — and it is settled by looking at the
 * first character rather than by trusting the label.
 */
function classify(mime: string): ContentKind {
  if (/html/i.test(mime)) return "html";
  if (/json/i.test(mime)) return "json";
  if (mime === "" || /^text\/plain|octet-stream/i.test(mime)) return "maybe";
  return "other";
}

/** `content.text`, base64 decoded when the export says it is. */
function decode(content: Record<string, unknown>): string | null {
  const text = content["text"];
  // Missing text is the "Save all as HAR" taken without content, or an export
  // that stopped mid-write. Either way the body is not here.
  if (typeof text !== "string" || text === "") return null;
  if (content["encoding"] !== "base64") return text;
  // Chrome base64s anything it considers binary, and sometimes text it does
  // not — a JSON payload served with a charset it distrusts arrives this way.
  try {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    return decoded === "" ? null : decoded;
  } catch {
    return null;
  }
}

function readEntry(entry: unknown, out: HarImport): void {
  if (!isRecord(entry)) return;

  const request = isRecord(entry["request"]) ? (entry["request"] as Record<string, unknown>) : null;
  const url = typeof request?.["url"] === "string" ? (request["url"] as string) : "";
  if (url === "") return;

  // A CORS preflight never carries a payload and always doubles the entry
  // count for a cross-origin API — which every one of these pharmacies has.
  const method = typeof request?.["method"] === "string" ? (request["method"] as string).toUpperCase() : "GET";
  if (method === "OPTIONS") return;

  // An entry with no response is a request the export caught in flight. Not an
  // error, just nothing to read.
  const response = isRecord(entry["response"]) ? (entry["response"] as Record<string, unknown>) : null;
  if (!response) return;
  const content = isRecord(response["content"]) ? (response["content"] as Record<string, unknown>) : null;
  if (!content) return;

  const mime = typeof content["mimeType"] === "string" ? (content["mimeType"] as string) : "";
  const kind = classify(mime);
  if (kind === "other") return;

  const text = decode(content);
  if (text === null) {
    // Only count what should have been readable. An image with no text is not
    // a truncated export.
    if (kind !== "maybe") out.unreadable += 1;
    return;
  }

  if (kind === "html") {
    out.documents.set(url, text);
    return;
  }

  const trimmed = text.trimStart();
  if (kind === "maybe" && !(trimmed.startsWith("{") || trimmed.startsWith("["))) return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Announced JSON, delivered half of it: the export was cut off. Worth
    // counting, never worth throwing over.
    if (kind === "json") out.unreadable += 1;
    return;
  }

  // Status is kept exactly as recorded, including the 401. The consumer skips
  // `>= 400` itself, and a failed call is evidence about the endpoint's shape.
  const status = typeof response["status"] === "number" ? (response["status"] as number) : 0;
  out.responses.push({ url, status, body });
}
