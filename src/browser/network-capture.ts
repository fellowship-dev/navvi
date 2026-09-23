import type { Page, Response } from "playwright";
import { readDeclared } from "../declared/json.js";

/**
 * Extraction from the responses a page fetches for itself.
 *
 * A single-page app ships a JavaScript shell: there is no JSON-LD in the HTML,
 * no OpenGraph product tags, and nothing to read until it renders. But while it
 * renders it calls its own API, and that call carries the data the page is
 * about -- named, typed, and free of any presentational guesswork.
 *
 * Reading that response is strictly better than reading the DOM it produces:
 *
 *   Store B's product API returns
 *     prices = { "price-list-std": 3690, "price-sale-std": 3321 }
 *   while the rendered page shows three prices styled alike, which is how a
 *   compiled selector caught the Club price instead of the list price. Three
 *   increasingly precise prompts could not separate them, because in the DOM
 *   they are not separable -- the distinction exists only in the payload.
 *
 * The session is not the problem people expect. Nothing here authenticates, and
 * nothing reverse-engineers a token: the page logs itself in as it always does,
 * and the capture watches. Store B's detail endpoint answers 401 to a bare
 * request and 200 to the page's own, and this sees the second one.
 *
 * This is a shape, not a site. Any app that fetches JSON about the thing it is
 * displaying can be read this way.
 */

/** A JSON response the page fetched, kept with the URL that produced it. */
export interface CapturedResponse {
  url: string;
  status: number;
  body: unknown;
}

export interface CaptureOptions {
  /** Which response URLs to keep. A string is a substring test. */
  match: string | RegExp;
  /** Keep at most this many, oldest first. Guards a page that polls. */
  limit?: number;
}

function matches(url: string, match: string | RegExp): boolean {
  return typeof match === "string" ? url.includes(match) : match.test(url);
}

/**
 * What a matching response was refused for.
 *
 * An empty capture has two readings -- the page never called anything that
 * matched, or it called thirty things and every one of them was thrown away --
 * and until these counters existed the two were the same observation. The
 * discard is not an edge case: `make/pages.ts` captures with `match: /./`, so
 * on every page the content-type filter silently drops every document,
 * stylesheet, image and font the page fetched, and the 304 that cost a day to
 * diagnose (a revalidated response carries no `content-type`, so there is no
 * payload to bind) went out through this same door leaving nothing behind.
 *
 * Counters and not a log, because this runs on every response of a live page:
 * two integers and a map of MIME types bounded at `SKIP_TYPES`, no bodies read
 * and no URLs kept.
 */
export interface CaptureSkips {
  /**
   * Matched responses refused for their content-type, counted by the type they
   * carried with its parameters stripped. A response that carried none counts
   * under `""` -- which is what a 304 is.
   */
  contentType: Record<string, number>;
  /** Matched responses that arrived once `limit` was already full. */
  overLimit: number;
  /** Matched JSON responses whose body could not be read: the page went away mid-parse. */
  unreadable: number;
}

/**
 * How many distinct content-types a capture names before the rest go to
 * `other`. Bounded because the key comes off a header a server controls.
 */
const SKIP_TYPES = 12;

function countType(counts: Record<string, number>, raw: string): void {
  // Parameters stripped (`application/json; charset=utf-8`), or a server that
  // varies its charset would fill the map with one type spelled six ways.
  const type = (raw.split(";")[0] ?? "").trim().toLowerCase();
  const key = type in counts || Object.keys(counts).length < SKIP_TYPES ? type : "other";
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * One sentence about what a capture threw away, or null when it threw nothing
 * away. Null rather than an empty string so a caller cannot log "dropped " and
 * think it said something.
 */
export function describeSkips(skips: CaptureSkips): string | null {
  const parts: string[] = [];
  const types = Object.entries(skips.contentType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const forType = types.reduce((sum, [, n]) => sum + n, 0);
  if (forType > 0) {
    parts.push(`${forType} for want of a JSON content-type (${types.map(([type, n]) => `${type === "" ? "none" : type} ${n}`).join(", ")})`);
  }
  if (skips.overLimit > 0) parts.push(`${skips.overLimit} after the capture was full`);
  if (skips.unreadable > 0) parts.push(`${skips.unreadable} whose body could not be read`);
  return parts.length === 0 ? null : `dropped ${parts.join("; ")}`;
}

/**
 * Starts capturing before navigation and returns the reader.
 *
 * A page commonly calls the same endpoint more than once -- Store B calls
 * its detail endpoint twice, the first answering 401 before the anonymous
 * session exists and the second carrying the product. So every match is kept
 * and the caller picks; taking the first would take the failure.
 */
export interface Capture {
  responses: CapturedResponse[];
  /** What matched and was refused anyway. See `CaptureSkips`. */
  skipped: CaptureSkips;
  /**
   * Resolves once every body read started so far has finished.
   *
   * Reading a response body is asynchronous, so a response that arrived is not
   * yet a response that can be read. Extracting without waiting loses whichever
   * payloads were still being parsed -- three Store B products came back
   * empty on a full catalogue run for exactly this reason, and looked like
   * pages the scraper had failed on rather than a race in the harness.
   */
  settled(): Promise<void>;
}

export function captureJson(page: Page, options: CaptureOptions): Capture {
  const responses: CapturedResponse[] = [];
  const pending = new Set<Promise<void>>();
  const limit = options.limit ?? 20;
  // Null-prototype: the key is a header value off a server, and `__proto__` is
  // a legal one.
  const skipped: CaptureSkips = { contentType: Object.create(null) as Record<string, number>, overLimit: 0, unreadable: 0 };

  const onResponse = (response: Response): void => {
    const url = response.url();
    // The match runs before the limit check so `overLimit` counts responses
    // this capture wanted, not every response a full page went on to make.
    if (!matches(url, options.match)) return;
    if (responses.length >= limit) { skipped.overLimit += 1; return; }
    const type = response.headers()["content-type"] ?? "";
    if (!/json/i.test(type)) { countType(skipped.contentType, type); return; }
    // The page may navigate away mid-read; a failed read is a response we did
    // not get, never a crash.
    const read = response
      .json()
      .then((body: unknown) => { responses.push({ url, status: response.status(), body }); })
      .catch(() => { skipped.unreadable += 1; })
      .finally(() => { pending.delete(read); });
    pending.add(read);
  };

  page.on("response", onResponse);
  return {
    responses,
    skipped,
    async settled() {
      // A read can start another read only in theory, but draining in a loop
      // costs nothing and removes the question.
      for (let guard = 0; pending.size > 0 && guard < 10; guard += 1) {
        await Promise.all([...pending]);
      }
    },
  };
}

/**
 * Reads a dotted path out of a captured body. Segments are literal keys, so a
 * key containing a dot is addressed by wrapping it in brackets --
 * `productData.prices[price-list-std]`, which Store B's payload needs.
 *
 * It used to spell that grammar out here, which made it the fourth copy of the
 * declared-block reader. A captured payload is the same reader with no entity:
 * there is no schema.org typing in an app's own API response, so nothing is
 * searched and the top-level object is the whole contract. The name stays
 * because `pickResponse` and `extractCaptured` are separate entry points that a
 * differential pins (`tests/second-spelling.test.ts`).
 */
export function readPath(body: unknown, path: string): unknown {
  return readDeclared(body, path);
}

/**
 * Did this response answer at all? A refusal is not an answer, and it is not
 * evidence that the endpoint has nothing either: Store B's detail endpoint
 * answers 401 before the page's anonymous session exists and 200 after.
 *
 * The single spelling of that test. Counting payloads, picking a field's
 * response and compiling a `network` alternative must agree about which
 * captures count, or one of them silently binds to a failure.
 */
export function isUsableResponse(response: CapturedResponse): boolean {
  return response.status < 400;
}

/** Narrows which captures `newestUsableResponse` will accept. */
export interface UsableResponseFilter {
  /** Substring the response URL must contain. Omitted or empty matches every URL. */
  match?: string | undefined;
  /** The body must satisfy this to count as an answer. Omitted means any usable response counts. */
  carries?: ((body: unknown) => boolean) | undefined;
}

/**
 * The newest captured response that is usable — the one spelling of
 * "newest usable captured response" (2026-09-22).
 *
 * "Newest that works" rather than "last" or "first", because a page that
 * retries leaves both the failure and the success behind, in that order. Every
 * consumer of a capture walks this list the same way and differs only in what
 * it additionally demands: a URL substring (`resolveDeclared` compiling a
 * `network` alternative, a HAR import's endpoint), a readable path
 * (`pickResponse`), or nothing at all (tier 2's endpoint intersection). Before
 * this existed the walk was written out four times, once in a test commented
 * "copied verbatim", and nothing compared any two.
 */
export function newestUsableResponse(
  responses: readonly CapturedResponse[],
  filter: UsableResponseFilter = {},
): CapturedResponse | null {
  const { match, carries } = filter;
  for (let i = responses.length - 1; i >= 0; i -= 1) {
    const response = responses[i]!;
    if (!isUsableResponse(response)) continue;
    if (match && !response.url.includes(match)) continue;
    if (carries && !carries(response.body)) continue;
    return response;
  }
  return null;
}

/**
 * The best response for a field: the newest usable capture that actually
 * contains the path.
 */
export function pickResponse(responses: readonly CapturedResponse[], path: string): CapturedResponse | null {
  return newestUsableResponse(responses, { carries: (body) => readPath(body, path) !== undefined });
}

/** Field name to dotted path, resolved against what the page fetched. */
export type NetworkFieldMap = Record<string, string>;

export function extractCaptured(responses: readonly CapturedResponse[], fields: NetworkFieldMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(fields)) {
    const response = pickResponse(responses, path);
    out[name] = response ? readPath(response.body, path) : undefined;
  }
  return out;
}
