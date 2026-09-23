import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bank } from "../src/heuristics/index.js";
import { chooseSample, classify, probeFrom, type PageResponse, type UrlProbe } from "../src/investigate/index.js";

/**
 * U2d's producer. **Defect 1's home.**
 *
 * `chooseSample` and `classify` are covered by 21 tests and every input any of
 * them had ever seen was a hand-written literal. The only code that turned a
 * real page into a `UrlProbe` was `probeOf` in `scripts/live-investigate.ts` —
 * outside `src/`, untested, and carrying its own copy of the shell rule:
 *
 *     isShell: visibleText(body).length < 400 && /<script[^>]+src=/i.test(body) && !declared
 *
 * while `shell-skips-tier-1` owns `SHELL_TEXT_CHARS = 400` in
 * `src/heuristics/rules/investigate.ts`. Defect 1 *was* the absence of
 * `isShell`: without it, `classify` read every one of Store B's 25 shells as
 * `dead:no-product` and a healthy store came back 100% dead. Pinning the
 * consumer while the producer re-spells the rule leaves the same hole open one
 * layer down.
 *
 * So these tests drive `probeFrom` over real page shapes and then feed what it
 * produced to `chooseSample` and `classify` — the derivation that was missing,
 * end to end.
 */

const DIR = join(import.meta.dirname, "fixtures", "investigate");
const html = (name: string): string => readFileSync(join(DIR, `${name}.html`), "utf8");

const PRODUCT = html("product");
const SHELL = html("storeb-shell");
const SHELL_WAF = html("storeb-shell-waf");
const REDIRECT = html("storea-redirect");
const FORBIDDEN = html("forbidden");

/** One plain fetch, in the shape `plainFetch` in `scripts/live-investigate.ts` returns. */
function fetched(url: string, status: number, body: string, landedOn = url): PageResponse {
  return { url: landedOn, status, body };
}

const URLS = {
  product: "https://example.cl/paracetamol-500-mg-20-comprimidos/100001.html",
  shell: "https://example.cl/acido-acetilsalicilico-100-mg/884669.html",
  redirect: "https://example.cl/ejemplo-complejo-b-30-comprimidos/8820237.html",
  gone: "https://example.cl/producto-descontinuado/999999.html",
  refused: "https://example.cl/aspirina-infantil/880330.html",
};

describe("probeFrom — one response, read into a probe", () => {
  it("reads a server-rendered product page as a live page that declares itself", () => {
    const probe = probeFrom(URLS.product, fetched(URLS.product, 200, PRODUCT));
    expect(probe).toEqual({
      url: URLS.product,
      status: 200,
      hasDeclaredProduct: true,
      isShell: false,
      // A struck-through list price and a sale price: two distinct amounts, so
      // the discount is visible, which is the only thing `classify` asks.
      priceCount: 2,
    });
  });

  it("reads a JS shell as a shell rather than as a page that declares nothing", () => {
    const probe = probeFrom(URLS.shell, fetched(URLS.shell, 200, SHELL));
    expect(probe.isShell).toBe(true);
    expect(probe.hasDeclaredProduct).toBe(false);
    expect(probe.priceCount).toBe(0);
    // And the same store's page behind a WAF is still a shell: what the WAF
    // stamps on it is a question for `blocked.ts`, not for the sample.
    expect(probeFrom(URLS.shell, fetched(URLS.shell, 200, SHELL_WAF)).isShell).toBe(true);
  });

  it("carries where the response landed when it moved, and nothing when it did not", () => {
    const moved = probeFrom(URLS.redirect, fetched(URLS.redirect, 200, REDIRECT, "https://example.cl/categoria/vitaminas"));
    expect(moved.redirectedTo).toBe("https://example.cl/categoria/vitaminas");
    expect(probeFrom(URLS.product, fetched(URLS.product, 200, PRODUCT))).not.toHaveProperty("redirectedTo");
  });

  it("keeps a 404 and a 403 apart, and reports a fetch that never answered as 0", () => {
    expect(probeFrom(URLS.gone, fetched(URLS.gone, 404, "")).status).toBe(404);
    expect(probeFrom(URLS.refused, fetched(URLS.refused, 403, FORBIDDEN)).status).toBe(403);
    // `plainFetch` returns `{ status: 0, body: "" }` when the request threw.
    expect(probeFrom(URLS.gone, { url: URLS.gone, status: 0, body: "" }).status).toBe(0);
    expect(probeFrom(URLS.gone, { url: URLS.gone }).status).toBe(0);
  });

  it("asks `shell-skips-tier-1` for `isShell` rather than carrying a copy of its threshold", () => {
    /**
     * The point of the whole module, and the only way to prove it from outside:
     * silence the rule through the bank's own override mechanism and the probe
     * has to change. A local `visibleText(body).length < 400` would not notice.
     */
    const silenced = new Bank({ "shell-skips-tier-1": { enabled: false, note: "proving the probe asks the rule rather than re-spelling it" } });
    const probe = probeFrom(URLS.shell, fetched(URLS.shell, 200, SHELL), { view: silenced });
    expect(probe.isShell).toBe(false);

    // And this is what that costs downstream — 2026-09-22, exactly: a healthy
    // store's every URL read as a dead one.
    expect(classify(probe).signature).toBe("dead:no-product");
    expect(classify(probeFrom(URLS.shell, fetched(URLS.shell, 200, SHELL))).strata).not.toContain("dead");
  });
});

describe("real pages through probeFrom, then chooseSample, then classify", () => {
  const responses: Array<{ url: string; response: PageResponse }> = [
    { url: URLS.product, response: fetched(URLS.product, 200, PRODUCT) },
    { url: URLS.shell, response: fetched(URLS.shell, 200, SHELL) },
    { url: URLS.redirect, response: fetched(URLS.redirect, 200, REDIRECT, "https://example.cl/categoria/vitaminas") },
    { url: URLS.gone, response: fetched(URLS.gone, 404, "") },
    { url: URLS.refused, response: fetched(URLS.refused, 403, FORBIDDEN) },
  ];
  const probes: UrlProbe[] = responses.map((entry) => probeFrom(entry.url, entry.response));

  it("gives each page shape the stratum it stands for", () => {
    const seen = Object.fromEntries(probes.map((probe) => [probe.url, classify(probe)]));

    expect(seen[URLS.product]).toMatchObject({ strata: ["discounted"], signature: "live:stock?:two-or-more-prices:declared" });
    // The shell is live. It stands for no stratum — a page with no prices on it
    // cannot say whether a discount is visible — but it is compile input, and
    // that is the distinction defect 1 was the absence of.
    expect(seen[URLS.shell]).toMatchObject({ strata: [], signature: "live:stock?:no-price:declared?" });
    expect(seen[URLS.redirect]).toMatchObject({ strata: ["dead"], signature: "dead:redirect" });
    expect(seen[URLS.gone]).toMatchObject({ strata: ["dead"], signature: "dead:status-404" });
    expect(seen[URLS.refused]).toMatchObject({ strata: [], signature: "excluded:blocked" });
  });

  it("builds a sample that spans the shapes, excludes only the refusal, and never calls the shell dead", () => {
    const choice = chooseSample(probes, { size: 5 });

    expect(choice.excluded).toEqual([
      { url: URLS.refused, reason: "blocked", because: expect.stringContaining("403 is a refusal, not a dead URL") },
    ]);

    const byUrl = new Map(choice.picks.map((pick) => [pick.url, pick.stratum]));
    expect(byUrl.get(URLS.redirect)).toBe("dead");
    expect(byUrl.get(URLS.product)).toBe("discounted");
    // The healthy store's page is in the sample. It is picked for coverage
    // rather than for a stratum, and it is picked.
    expect(byUrl.get(URLS.shell)).toBe("coverage");
    expect(byUrl.get(URLS.gone)).toBe("coverage");

    // Nothing that answered is missing, and nothing healthy is dead.
    expect(choice.considered).toBe(5);
    expect(choice.picks).toHaveLength(4);
    expect(choice.unfilled.map((entry) => entry.stratum)).toEqual(["out-of-stock", "undiscounted"]);
  });

  it("reads the whole Store B catalogue as compile input, which is the run that failed", () => {
    // Three URLs, three shells, one shape. Before `isShell` existed every one
    // of these classified `dead:no-product`, the binding set came out empty and
    // the manuscript bound nothing on a store answering perfectly.
    const catalogue = ["884669", "880330", "881926"].map((id) =>
      probeFrom(`https://example.cl/p/${id}.html`, fetched(`https://example.cl/p/${id}.html`, 200, SHELL_WAF)),
    );
    const choice = chooseSample(catalogue, { size: 3 });

    expect(choice.excluded).toEqual([]);
    expect(choice.picks).toHaveLength(3);
    expect(choice.picks.every((pick) => pick.stratum === "coverage")).toBe(true);
    expect(catalogue.every((probe) => !classify(probe).strata.includes("dead"))).toBe(true);
    // The catalogue genuinely has no dead page and no discount to show, and the
    // choice says so instead of inventing one.
    expect(choice.unfilled.map((entry) => entry.stratum)).toEqual(["dead", "out-of-stock", "discounted", "undiscounted"]);
  });
});
