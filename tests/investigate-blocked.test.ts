import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bank } from "../src/heuristics/index.js";
import {
  apologySignals,
  challengeSignal,
  checkCanary,
  classifyRun,
  detectBlocking,
  mayHeal,
  recordCanary,
  settleDeferred,
  statusSignal,
  type PageResponse,
} from "../src/investigate/blocked.js";

/**
 * U3a and U3b. The run that produced these: StoreC, 2026-09-22, read from
 * Apify's datacenter IPs — `sku 0/111, stock 0/111, prices 3/111` and
 * "¡Lo sentimos!" as the product name on every row. The same URLs read
 * perfectly from a laptop, and the legacy scraper has been failing the same way
 * for months while looking like drift.
 *
 * The fixtures are synthetic. The *shapes* are real — a store error page that
 * keeps the store's nav and footer, an Incapsula interstitial that renders
 * nothing until its JavaScript runs, a product page that declares itself in
 * JSON-LD — but the store, the products and the prices are invented. navvi is a
 * public repository and a client's catalogue is not test data.
 */

const DIR = join(import.meta.dirname, "fixtures", "investigate");
const html = (name: string): string => readFileSync(join(DIR, `${name}.html`), "utf8");

const APOLOGY = html("apology");
const CHALLENGE = html("challenge-incapsula");
const FORBIDDEN = html("forbidden");
const PRODUCT = html("product");
const PRODUCT_REDESIGN = html("product-redesign");
const RENDERED = html("rendered-product");
const RENDERED_2 = html("rendered-product-2");
/** The shape the first live run met: `storeb-shell.html` plus Imperva's always-on resource. */
const SHELL_WAF = html("storeb-shell-waf");

/** The StoreC run's fill counts, exactly as the harness printed them. */
const STORE_C_FIELDS = {
  sku: { filled: 0, total: 111 },
  stock: { filled: 0, total: 111 },
  list_price: { filled: 3, total: 111 },
  product_name: { filled: 111, total: 111 },
};

function pages(body: string, ...urls: string[]): PageResponse[] {
  return urls.map((url) => ({ url, status: 200, body }));
}

describe("statusSignal — a refusal, not an absence", () => {
  it("reads 403 and 429 as the site answering no", () => {
    expect(statusSignal({ url: "https://example.cl/p/1", status: 403 })?.kind).toBe("status");
    expect(statusSignal({ url: "https://example.cl/p/1", status: 429 })?.kind).toBe("status");
  });

  it("leaves 404 and 500 alone: one is a dead product, the other is a retry", () => {
    // `retry-transport-not-an-answer` already owns both of these.
    expect(statusSignal({ url: "https://example.cl/p/1", status: 404 })).toBeNull();
    expect(statusSignal({ url: "https://example.cl/p/1", status: 500 })).toBeNull();
    expect(statusSignal({ url: "https://example.cl/p/1" })).toBeNull();
  });
});

describe("challengeSignal", () => {
  it("sees the challenge in the source of a page that renders nothing", () => {
    const signal = challengeSignal({ url: "https://example.cl/p/1", status: 200, body: CHALLENGE });
    expect(signal?.kind).toBe("challenge");
    // The incident id is what makes it decisive: the resource itself is
    // injected into every page of a site Imperva fronts.
    expect(signal?.evidence).toMatch(/^_Incapsula_Resource.*incident_id$/);
  });

  it("sees a challenge announced only in the headers, with no body at all", () => {
    const cloudflare = challengeSignal({ url: "https://example.cl/p/1", status: 200, headers: { "CF-Mitigated": "challenge" } });
    expect(cloudflare?.evidence).toBe("cf-mitigated: challenge");
  });

  it("does not read being behind a WAF as being refused by one", () => {
    // Imperva stamps x-iinfo and visid_incap on every response of every site it
    // fronts, blocked or not, and plenty of stores are fronted by one.
    const proxied = {
      url: "https://example.cl/p/1",
      status: 200,
      headers: { "x-iinfo": "9-12345-0 NNNN CT(0 0 0)", "set-cookie": "visid_incap_123=abc; path=/" },
      body: PRODUCT,
    };
    expect(challengeSignal(proxied)).toBeNull();
  });

  it("does not read a login modal's reCAPTCHA as a challenge page", () => {
    // A store that puts reCAPTCHA on its login form ships the loader in the
    // header of every product page. The page still declares its product.
    const withWidget = PRODUCT.replace("</head>", '<script src="https://www.google.com/recaptcha/api.js"></script></head>');
    expect(challengeSignal({ url: "https://example.cl/p/1", status: 200, body: withWidget })).toBeNull();
    // The same loader on a page that shows nothing and declares nothing is the
    // captcha *being* the page.
    const interstitial = '<body><div class="g-recaptcha"></div><script src="https://www.google.com/recaptcha/api.js"></script></body>';
    expect(challengeSignal({ url: "https://example.cl/p/1", status: 200, body: interstitial })?.kind).toBe("challenge");
  });

  it("reuses prestep's lexicon rather than keeping a second copy of it", () => {
    const signal = challengeSignal({ url: "https://example.cl/p/1", status: 403, body: "<body><h1>Attention Required!</h1></body>" });
    expect(signal?.because).toContain("challenge interstitial");
  });

  it("says nothing about a page that is serving a product", () => {
    expect(challengeSignal({ url: "https://example.cl/p/1", status: 200, body: PRODUCT })).toBeNull();
  });
});

describe("apologySignals — a shape, never a phrase list", () => {
  it("catches one document served for every address", () => {
    const signals = apologySignals(pages(APOLOGY, "https://example.cl/p/1", "https://example.cl/p/2", "https://example.cl/p/3"));
    expect(signals).toHaveLength(3);
    expect(signals[0]!.kind).toBe("apology");
    expect(signals[0]!.because).toContain("3 different URLs");
    // Nothing in the rule knows the page says "¡Lo sentimos!".
    expect(signals[0]!.because).not.toMatch(/sentimos/i);
  });

  it("does not call two sibling product pages one document, which is the rule's whole risk", () => {
    // Same template, same nav, same footer, no declared product anywhere: only
    // the product separates them, and that is exactly what an error page lacks.
    const signals = apologySignals([
      { url: "https://example.cl/p/1", status: 200, body: RENDERED },
      { url: "https://example.cl/p/2", status: 200, body: RENDERED_2 },
    ]);
    expect(signals).toEqual([]);
  });

  it("never calls a page that declares a product an apology, however often it repeats", () => {
    expect(apologySignals(pages(PRODUCT, "https://example.cl/p/1", "https://example.cl/p/2"))).toEqual([]);
  });

  it("needs different URLs: one page read twice is not a crowd", () => {
    expect(apologySignals(pages(APOLOGY, "https://example.cl/p/1", "https://example.cl/p/1"))).toEqual([]);
  });

  it("leaves a shell alone; an empty page is a different diagnosis", () => {
    // `shell-skips-tier-1` owns this one, and says to render rather than to stop.
    const shell = '<body><div id="root"></div><script src="/app.js"></script></body>';
    expect(apologySignals(pages(shell, "https://example.cl/p/1", "https://example.cl/p/2"))).toEqual([]);
  });
});

describe("detectBlocking", () => {
  it("collects every kind off one run", () => {
    const kinds = detectBlocking([
      { url: "https://example.cl/p/1", status: 403, body: FORBIDDEN },
      { url: "https://example.cl/p/2", status: 200, body: CHALLENGE },
      ...pages(APOLOGY, "https://example.cl/p/3", "https://example.cl/p/4"),
      { url: "https://example.cl/p/5", status: 200, body: PRODUCT },
    ]).map((signal) => signal.kind);
    expect(new Set(kinds)).toEqual(new Set(["status", "challenge", "apology"]));
    expect(kinds).toHaveLength(4);
  });
});

describe("recordCanary — small enough to commit", () => {
  const recorded = recordCanary({ url: "https://example.cl/p/1", status: 200, body: PRODUCT }, { now: new Date("2026-09-22T12:00:00Z") });

  it("is a few dozen words and two numbers, and survives a round trip through JSON", () => {
    expect(JSON.parse(JSON.stringify(recorded))).toEqual(recorded);
    expect(JSON.stringify(recorded).length).toBeLessThan(1_000);
    expect(recorded.words.length).toBeLessThanOrEqual(24);
    expect(recorded.declaredProduct).toBe(true);
    expect(recorded.recordedAt).toBe("2026-09-22");
    expect(recorded.textChars).toBeGreaterThan(100);
  });

  it("is deterministic, so two recordings of one page diff to nothing", () => {
    expect(recordCanary({ url: "https://example.cl/p/1", status: 200, body: PRODUCT }, { now: new Date("2026-09-22T12:00:00Z") })).toEqual(recorded);
  });
});

describe("checkCanary — the one boolean that separates drift from refusal", () => {
  const recorded = recordCanary({ url: "https://example.cl/p/1", status: 200, body: PRODUCT }, { now: new Date("2026-09-22T12:00:00Z") });

  it("still resolves through a redesign, because a canary sensitive to drift would stop healing", () => {
    const reading = checkCanary(recorded, { url: recorded.url, status: 200, body: PRODUCT_REDESIGN });
    expect(reading.state).toBe("resolved");
  });

  it("fails on the apology the same store serves from a datacenter", () => {
    const reading = checkCanary(recorded, { url: recorded.url, status: 200, body: APOLOGY });
    expect(reading.state).toBe("failed");
  });

  it("fails on a refusal and on a challenge", () => {
    expect(checkCanary(recorded, { url: recorded.url, status: 403, body: FORBIDDEN }).state).toBe("failed");
    expect(checkCanary(recorded, { url: recorded.url, status: 200, body: CHALLENGE }).state).toBe("failed");
  });

  it("is unchecked rather than resolved when there is no page to read", () => {
    expect(checkCanary(recorded, undefined).state).toBe("unchecked");
    // StoreC's apology came back with a normal status: a 200 alone proves nothing.
    expect(checkCanary(recorded, { url: recorded.url, status: 200 }).state).toBe("unchecked");
  });

  it("lets a case that deletes its JSON-LD keep its canary", () => {
    const reading = checkCanary(recorded, { url: recorded.url, status: 200, body: RENDERED }, { requireDeclared: false });
    expect(reading.state).toBe("resolved");
  });

  it("pins which conjunct catches the apology: the word overlap alone would not have", () => {
    // Measured on these fixtures: the apology keeps half of the canary's
    // recorded words, because it keeps the store's nav and footer — and the
    // threshold is 0.4 on purpose, so that a redesign does not fail it. The
    // declared `Product` is what actually separates the two, which is why the
    // conjunct is there and why this test exists rather than a tighter number.
    expect(checkCanary(recorded, { url: recorded.url, status: 200, body: APOLOGY }, { requireDeclared: false }).state).toBe("resolved");
    expect(checkCanary(recorded, { url: recorded.url, status: 200, body: APOLOGY }).state).toBe("failed");
  });

  it("does not record a price as a canary word", () => {
    // The scraper exists to watch prices move; a canary that drops on a
    // promotion is a canary that reports blocked every Monday.
    expect(recorded.words.some((word) => /^\d+$/.test(word))).toBe(false);
  });
});

describe("classifyRun — blocked, drift, healthy", () => {
  it("reports the StoreC datacenter run as blocked, not drift", () => {
    const verdict = classifyRun({
      fields: STORE_C_FIELDS,
      values: { product_name: ["¡Lo sentimos!", "¡Lo sentimos!", "¡Lo sentimos!"] },
      canary: "failed",
    });
    expect(verdict.state).toBe("blocked");
    expect(mayHeal(verdict)).toBe(false);
    // There is no way to read a heal off a blocked verdict.
    expect(verdict).not.toHaveProperty("heal");
    expect(verdict.because).toContain("every field collapsed at once");
    expect(verdict.canary).toBe("failed");
    expect(verdict.verdicts.map((entry) => entry.id)).toContain("every-field-collapsed-is-blocking");
  });

  it("derives the constant field from the bank rather than being told about it", () => {
    // The trap: product_name was 111/111 filled, so a fill rate alone calls the
    // run healthy. Only the variation check sees the apology behind the number.
    const derived = classifyRun({ fields: STORE_C_FIELDS, values: { product_name: ["¡Lo sentimos!", "¡Lo sentimos!"] }, canary: "failed" });
    expect(derived.verdicts.some((entry) => entry.id === "no-variation-no-field" && entry.verdict.fires)).toBe(true);
    expect(derived.state).toBe("blocked");

    // Without the constant, the same counts read as an ordinary drift.
    const naive = classifyRun({ fields: STORE_C_FIELDS, canary: "failed" });
    expect(naive.state).toBe("drift");
  });

  it("turns the same collapse into drift when the canary still resolves", () => {
    const verdict = classifyRun({
      fields: STORE_C_FIELDS,
      values: { product_name: ["¡Lo sentimos!", "¡Lo sentimos!"] },
      canary: { state: "resolved", because: "the canary still resolves: 21 of 24 recorded words" },
    });
    expect(verdict.state).toBe("drift");
    expect(mayHeal(verdict)).toBe(true);
    expect(verdict.because).toContain("the canary page still resolves");
  });

  it("names a remedy on every blocked verdict, and says it costs money", () => {
    const verdict = classifyRun({ fields: STORE_C_FIELDS, values: { product_name: ["a", "a"] }, canary: "failed" });
    expect(verdict.state).toBe("blocked");
    if (verdict.state !== "blocked") return;
    expect(verdict.remedy.action).toBe("enable-proxy");
    expect(verdict.remedy.cost).toContain("paid decision");
    expect(verdict.remedy.group).toBeUndefined();
  });

  it("carries the case's own measurement when the case has one", () => {
    const verdict = classifyRun({
      fields: STORE_C_FIELDS,
      canary: "failed",
      constant: ["product_name"],
      remedy: { group: "apify-default-pool", note: "measured 2026-09-22 on six URLs of this store; another group recovered none of them" },
    });
    expect(verdict.state).toBe("blocked");
    if (verdict.state !== "blocked") return;
    expect(verdict.remedy.group).toBe("apify-default-pool");
    expect(verdict.remedy.note).toContain("2026-09-22");
    expect(verdict.remedy.cost).toContain("paid decision");
  });

  it("is blocked on the transport alone when the run's URLs are refused", () => {
    const verdict = classifyRun({
      pages: [
        { url: "https://example.cl/p/1", status: 403, body: FORBIDDEN },
        { url: "https://example.cl/p/2", status: 403, body: FORBIDDEN },
        { url: "https://example.cl/p/3", status: 200, body: PRODUCT },
      ],
    });
    expect(verdict.state).toBe("blocked");
    expect(verdict.because).toContain("2 of 3 URLs");
    expect(mayHeal(verdict)).toBe(false);
  });

  it("is blocked on the apology alone, with no fill counts at all", () => {
    const verdict = classifyRun({ pages: pages(APOLOGY, "https://example.cl/p/1", "https://example.cl/p/2", "https://example.cl/p/3") });
    expect(verdict.state).toBe("blocked");
    expect(verdict.signals.every((signal) => signal.kind === "apology")).toBe(true);
  });

  it("does not let one refused URL in a healthy run block the run", () => {
    const run = [
      { url: "https://example.cl/p/1", status: 403, body: FORBIDDEN },
      ...pages(PRODUCT, "https://example.cl/p/2", "https://example.cl/p/3", "https://example.cl/p/4"),
    ];
    const verdict = classifyRun({ pages: run, fields: { sku: { filled: 108, total: 111 }, list_price: { filled: 110, total: 111 } } });
    expect(verdict.state).toBe("healthy");
    // The signal is still reported: it is a fact about a URL, just not a verdict about the run.
    expect(verdict.signals).toHaveLength(1);
  });

  it("calls a partial collapse drift, and lets the healer act on it", () => {
    const verdict = classifyRun({
      pages: pages(PRODUCT, "https://example.cl/p/1", "https://example.cl/p/2"),
      fields: { sku: { filled: 0, total: 111 }, list_price: { filled: 110, total: 111 } },
      canary: "resolved",
    });
    expect(verdict.state).toBe("drift");
    expect(mayHeal(verdict)).toBe(true);
    expect(verdict.because).toContain("sku");
  });

  it("says so rather than guessing when nothing was observed", () => {
    const verdict = classifyRun({});
    expect(verdict.state).toBe("healthy");
    expect(verdict.because).toContain("nothing was observed");
  });

  it("defers rather than blocks when every page that looks refused is a shell", () => {
    // The first live run of the cascade, 2026-09-22. Three Store B URLs,
    // three JS shells with Imperva's always-on resource in the head, and
    // `blocked` — on a store that renders 86 payloads to a browser on the same
    // machine. The corroboration rule's definition of an interstitial and
    // `shell-skips-tier-1`'s definition of a shell are the same sentence.
    const verdict = classifyRun({ pages: pages(SHELL_WAF, "https://example.cl/p/1", "https://example.cl/p/2", "https://example.cl/p/3") });
    expect(verdict.state).toBe("deferred");
    if (verdict.state !== "deferred") return;
    expect(mayHeal(verdict)).toBe(false);
    expect(verdict).not.toHaveProperty("heal");
    // Nothing may bind against a deferred run either: there is no remedy to
    // read off it and no heal, only the question and what would answer it.
    expect(verdict).not.toHaveProperty("remedy");
    expect(verdict.deferred.every((signal) => signal.corroborated)).toBe(true);
    expect(verdict.because).toContain("shell-skips-tier-1");
    // The rule is asked here rather than trusted from the caller, so "blocked"
    // is unreachable from a shell for every caller and not only for the cascade.
    expect(verdict.verdicts.some((entry) => entry.id === "shell-skips-tier-1" && entry.verdict.fires)).toBe(true);
  });

  it("keeps the transport decisive for everything a render would not change", () => {
    // A 403 on a shell is still a 403: the status says something about the
    // response, not about how little of it there is.
    const refused = classifyRun({
      pages: [
        { url: "https://example.cl/p/1", status: 403, body: SHELL_WAF },
        { url: "https://example.cl/p/2", status: 403, body: SHELL_WAF },
      ],
    });
    expect(refused.state).toBe("blocked");

    // A decisive marker — Imperva's resource carrying an incident_id — is not
    // corroboration and is not held back either.
    expect(classifyRun({ pages: pages(CHALLENGE, "https://example.cl/p/1", "https://example.cl/p/2") }).state).toBe("blocked");

    // And an interstitial that is not a shell: no declared product, almost no
    // text, a captcha widget, and no bundle that would ever fill it.
    const interstitial = '<html><body><h1>Verificando</h1><div class="g-recaptcha"></div></body></html>';
    expect(classifyRun({ pages: pages(interstitial, "https://example.cl/p/1", "https://example.cl/p/2") }).state).toBe("blocked");
  });

  it("settles a deferred run on what the render produced, either way", () => {
    const deferred = classifyRun({ pages: pages(SHELL_WAF, "https://example.cl/p/1", "https://example.cl/p/2") });
    expect(deferred.state).toBe("deferred");
    if (deferred.state !== "deferred") return;

    // A refused page has no payload to hand over; a shell's whole answer is one.
    const filled = settleDeferred(deferred, { pages: [], payloadLeaves: 41 });
    expect(filled.state).toBe("healthy");
    expect(filled.because).toContain("the render disproved it");

    // Nothing came back at all. The markers stand, and so does the remedy.
    const empty = settleDeferred(deferred, { pages: [], payloadLeaves: 0 });
    expect(empty.state).toBe("blocked");
    if (empty.state !== "blocked") return;
    expect(empty.remedy.action).toBe("enable-proxy");
    expect(mayHeal(empty)).toBe(false);

    // The shell filled — with the store's apology. The StoreC shape arriving
    // one tier later, and `apologySignals` has it.
    const apology = settleDeferred(deferred, { pages: pages(APOLOGY, "https://example.cl/p/1", "https://example.cl/p/2"), payloadLeaves: 0 });
    expect(apology.state).toBe("blocked");
    expect(apology.because).toContain("the render confirmed it");

    // The render produced a real page. Whatever else is wrong, it is not a refusal.
    const served = settleDeferred(deferred, { pages: [{ url: "https://example.cl/p/1", status: 200, body: PRODUCT }], payloadLeaves: 0 });
    expect(served.state).not.toBe("blocked");
  });

  it("does not defer forever when the render hands back the same shell", () => {
    // A WAF that blocks the page's own XHRs leaves a shell that never fills.
    // The second pass declares `shells: []` for exactly this: a page still empty
    // after a browser has had it is the refusal, not the excuse for it.
    const deferred = classifyRun({ pages: pages(SHELL_WAF, "https://example.cl/p/1", "https://example.cl/p/2") });
    if (deferred.state !== "deferred") throw new Error("expected deferred");
    const settled = settleDeferred(deferred, { pages: pages(SHELL_WAF, "https://example.cl/p/1", "https://example.cl/p/2"), payloadLeaves: 0 });
    expect(settled.state).toBe("blocked");
  });

  it("honours a case override, and records which rule was not allowed to speak", () => {
    const view = bank({ "every-field-collapsed-is-blocking": { enabled: false, note: "this store is scraped from a residential line" } });
    const verdict = classifyRun({ fields: STORE_C_FIELDS, constant: ["product_name"], canary: "failed", view });
    expect(verdict.state).toBe("drift");
    const entry = verdict.verdicts.find((v) => v.id === "every-field-collapsed-is-blocking");
    expect(entry?.verdict.because).toContain("disabled for this case");
    expect(entry?.verdict.because).toContain("residential line");
  });
});
