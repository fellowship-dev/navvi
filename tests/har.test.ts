import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importHar, safeUrl, type CapturedResponse } from "../src/investigate/har.js";
import { flatten } from "../src/investigate/leaves.js";

/**
 * U2e: a capture stands in for the browser.
 *
 * The fixture is hand-written and synthetic — navvi is a public repository and
 * a client's catalogue is not test data — but every shape in it is one a real
 * export has: a reloaded HTML document, a detail endpoint answering 401 before
 * 200, a base64 body, JSON mislabelled `text/plain`, a preflight, a truncated
 * body, and `SECRET-` strings sitting in the headers and cookies where a real
 * capture keeps its session.
 *
 * What is actually being tested is interchangeability: what comes out of a HAR
 * has to be indistinguishable from what `browser/network-capture.ts` collects,
 * because everything downstream — `flatten`, `narrow`, `resolveDeclared` — is
 * written against that one shape.
 */

const DIR = join(import.meta.dirname, "fixtures", "investigate");
const HAR = readFileSync(join(DIR, "laptop-capture.har"), "utf8");

const DETAIL = "https://api.tienda.ejemplo.cl/catalog-svc/products/detail/1234?token=SECRET-QUERY-TOKEN";
const PRODUCT_PAGE = "https://tienda.ejemplo.cl/producto/jarabe-ejemplo-120ml";

/** `resolveDeclared`'s walk, copied verbatim, because that is the consumer. */
function newestThatWorks(captured: readonly CapturedResponse[], match: string): CapturedResponse | null {
  for (let i = captured.length - 1; i >= 0; i -= 1) {
    const response = captured[i]!;
    if (response.status >= 400 || !response.url.includes(match)) continue;
    return response;
  }
  return null;
}

describe("importHar", () => {
  it("returns the shape network capture returns, and nothing else", () => {
    const { responses } = importHar(HAR);
    expect(responses.length).toBeGreaterThan(0);
    for (const response of responses) {
      expect(Object.keys(response).sort()).toEqual(["body", "status", "url"]);
      expect(typeof response.url).toBe("string");
      expect(typeof response.status).toBe("number");
    }
  });

  it("keeps the 401 in front of the 200 for the same endpoint", () => {
    const { responses } = importHar(HAR);
    const detail = responses.filter((response) => response.url === DETAIL);
    // Both calls survive the import. Dropping the failure would be tidier and
    // would also delete the evidence that the endpoint needs a session.
    expect(detail.map((response) => response.status)).toEqual([401, 200]);

    // And the consumer's newest-first walk therefore lands on the product.
    const picked = newestThatWorks(responses, "/catalog-svc/products/detail/");
    expect(picked?.status).toBe(200);
    expect(flatten(picked?.body).map((leaf) => leaf.path)).toContain("productData.prices[price-list-std]");
  });

  it("repairs an order the exporter got wrong, and only then", () => {
    // Some tools group entries by connection rather than by time. A capture
    // whose 200 sits above its 401 would hand the newest-first walk the
    // failure, so a provably out-of-order log is stable-sorted by its own
    // timestamps.
    const jumbled = {
      log: {
        entries: [
          entry("2026-09-22T18:04:09.900Z", 200, '{"ok":true}'),
          entry("2026-09-22T18:04:09.600Z", 401, '{"fault":"no session"}'),
        ],
      },
    };
    expect(importHar(jumbled).responses.map((response) => response.status)).toEqual([401, 200]);
  });

  it("decodes a base64 body", () => {
    const { responses } = importHar(HAR);
    const stock = responses.find((response) => response.url.includes("/stock-svc/"));
    expect(stock?.body).toEqual({ stock: { available: 7, storeId: "cl-101", updatedAt: "2026-09-22T18:04:11Z" } });
  });

  it("reads JSON an API mislabelled as text/plain", () => {
    const { responses } = importHar(HAR);
    const pum = responses.find((response) => response.url.includes("/pum-service/"));
    expect(pum?.body).toEqual({ pum: { value: 108, unit: "ml" } });
  });

  it("keeps HTML documents apart from the payloads, newest per URL", () => {
    const { responses, documents } = importHar(HAR);
    // Tier 1 reads page HTML and a HAR carries it, so this is a JSON-LD answer
    // with no request made.
    expect(documents.get(PRODUCT_PAGE)).toContain("application/ld+json");
    // The reload is the second capture of that URL; the later one wins.
    expect(documents.get(PRODUCT_PAGE)).toContain("7 disponibles");
    expect(documents.size).toBe(1);
    // An HTML document must never be flattened as a payload.
    expect(responses.some((response) => typeof response.body === "string")).toBe(false);
    expect(responses.some((response) => response.url === PRODUCT_PAGE)).toBe(false);
  });

  it("drops the preflight and the assets", () => {
    const urls = importHar(HAR).responses.map((response) => response.url);
    expect(urls.filter((url) => url === DETAIL)).toHaveLength(2); // the OPTIONS is not a third
    expect(urls.some((url) => url.endsWith(".css") || url.endsWith(".jpg"))).toBe(false);
  });

  it("skips what it cannot read, counts it, and never throws", () => {
    const imported = importHar(HAR);
    // Truncated JSON and a JSON entry saved without its body: the two shapes
    // that mean "your export is incomplete", which is a different report from
    // "this site returns no JSON".
    expect(imported.unreadable).toBe(2);
    expect(imported.entries).toBe(12);
    expect(imported.responses).toHaveLength(4);
  });

  it("survives every way a hand-exported file can be broken", () => {
    for (const broken of [
      HAR.slice(0, 900), // truncated mid-write: does not parse at all
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ log: {} }),
      JSON.stringify({ log: { entries: "nope" } }),
      JSON.stringify({ log: { entries: [null, 7, {}, { request: {} }, { request: { url: "u" } }] } }),
      undefined,
      { log: { entries: [{ request: { url: "u" }, response: { content: { mimeType: "application/json" } } }] } },
    ]) {
      expect(() => importHar(broken)).not.toThrow();
      expect(importHar(broken).responses).toEqual([]);
    }
  });

  it("accepts an already-parsed HAR and agrees with the text", () => {
    expect(importHar(JSON.parse(HAR))).toEqual(importHar(HAR));
  });
});

describe("secrets", () => {
  it("cannot carry a header or a cookie out of the capture", () => {
    const imported = importHar(HAR);
    const serialized = JSON.stringify({ ...imported, documents: [...imported.documents] });
    // A HAR records Authorization, Cookie and Set-Cookie for every request. The
    // return type has nowhere to put them, which is the point: a secret value
    // never enters a chooser question, a log, a trace or the scraper JSON.
    expect(serialized).not.toContain("SECRET-BEARER-TOKEN");
    expect(serialized).not.toContain("SECRET-SESSION-COOKIE");
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("set-cookie");
    for (const response of imported.responses) {
      expect(response).not.toHaveProperty("headers");
      expect(response).not.toHaveProperty("cookies");
    }
  });

  it("keeps the query string on the URL and off anything printable", () => {
    const { responses } = importHar(HAR);
    // The token stays in `url` because `resolveDeclared` matches on a substring
    // of it — deliberate, and exactly why printing a captured URL raw is not.
    expect(responses.some((response) => response.url.includes("SECRET-QUERY-TOKEN"))).toBe(true);
    expect(safeUrl(DETAIL)).toBe("https://api.tienda.ejemplo.cl/catalog-svc/products/detail/1234?…");
    expect(safeUrl(DETAIL)).not.toContain("SECRET-QUERY-TOKEN");
    expect(safeUrl("https://u:p@host.cl/a/b")).toBe("https://host.cl/a/b");
    expect(safeUrl("not a url?token=SECRET")).toBe("not a url?…");
    expect(safeUrl("https://host.cl/a")).toBe("https://host.cl/a");
  });
});

function entry(startedDateTime: string, status: number, text: string): unknown {
  return {
    startedDateTime,
    request: { method: "GET", url: "https://api.tienda.ejemplo.cl/catalog-svc/products/detail/9" },
    response: { status, content: { mimeType: "application/json", text } },
  };
}
