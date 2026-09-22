import type { Page, Response } from "playwright";

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
 * Starts capturing before navigation and returns the reader.
 *
 * A page commonly calls the same endpoint more than once -- Store B calls
 * its detail endpoint twice, the first answering 401 before the anonymous
 * session exists and the second carrying the product. So every match is kept
 * and the caller picks; taking the first would take the failure.
 */
export interface Capture {
  responses: CapturedResponse[];
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

  const onResponse = (response: Response): void => {
    if (responses.length >= limit) return;
    const url = response.url();
    if (!matches(url, options.match)) return;
    const type = response.headers()["content-type"] ?? "";
    if (!/json/i.test(type)) return;
    // The page may navigate away mid-read; a failed read is a response we did
    // not get, never a crash.
    const read = response
      .json()
      .then((body: unknown) => { responses.push({ url, status: response.status(), body }); })
      .catch(() => undefined)
      .finally(() => { pending.delete(read); });
    pending.add(read);
  };

  page.on("response", onResponse);
  return {
    responses,
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
 */
export function readPath(body: unknown, path: string): unknown {
  const segments = path
    .replace(/\[([^\]]+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let node: unknown = body;
  for (const segment of segments) {
    if (node === null || node === undefined || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * The best response for a field: the newest match that actually contains the
 * path. "Newest that works" rather than "last" or "first", because a page that
 * retries leaves both the failure and the success behind, in that order.
 */
export function pickResponse(responses: readonly CapturedResponse[], path: string): CapturedResponse | null {
  for (let i = responses.length - 1; i >= 0; i -= 1) {
    const response = responses[i]!;
    if (response.status >= 400) continue;
    if (readPath(response.body, path) !== undefined) return response;
  }
  return null;
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
