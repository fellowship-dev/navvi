import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BOT_CHALLENGE_SELECTORS,
  DECISIVE_CHALLENGE_SELECTORS,
  WIDGET_CHALLENGE_SELECTORS,
  readChallenge,
} from "../src/blocked/challenge.js";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { bank } from "../src/heuristics/index.js";
import { challengeSignal } from "../src/investigate/blocked.js";
import { classifyBlocked, type BlockedStatus } from "../src/prestep/blocked.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * **The same bytes, to both detectors.**
 *
 * `src/prestep/blocked.ts` and `src/investigate/blocked.ts` are two spellings of
 * "is this site refusing us", asked of two different things: one live `Page`
 * mid-navigation, and a finished run of stored responses. Neither can be
 * deleted — a `--har` compile has no browser and a pre-step has no corpus — and
 * on 2026-09-22 they answered the same bytes differently. Prestep fired on
 * `status ∈ {403, 429, 503} && any captcha container`, with no text check and
 * no product check, while investigate had already ruled that a captcha
 * container is furniture until the page is also an interstitial. A Chilean
 * store with reCAPTCHA in its login modal and one rate-limited 403 was
 * `blocked_bot_detection` to the first and healthy to the second.
 *
 * Nothing in the 721-test suite fed one page to both. This file is that seam:
 * one corpus, both verdicts per row, and the divergences **declared** rather
 * than discovered in the field.
 *
 * The invariant is computed, not copied. `investigateRefuses` below is built by
 * calling `challengeSignal` and `shell-skips-tier-1` for real — no threshold,
 * no marker list and no ordering is restated here.
 */

const FIXTURES = join(import.meta.dirname, "fixtures");
const bodyOf = (path: string): string => readFileSync(join(FIXTURES, path), "utf8");

type ChallengeStrength = "decisive" | "corroborated" | null;

interface Row {
  /** What the page is, in one phrase. */
  name: string;
  /** Path under `tests/fixtures`, served to the browser and read from disk for the offline side. */
  path: string;
  /** The navigation status the caller has, which is what prestep used to decide on. */
  status: number;
  /** What prestep must say about the live page. */
  prestep: BlockedStatus | null;
  /** What investigate reads off the stored bytes, and how strongly. */
  challenge: ChallengeStrength;
  /** A divergence that is real, with the reason it cannot be closed. */
  declared?: string;
}

const CORPUS: readonly Row[] = [
  {
    name: "a 403 with reCAPTCHA in the login modal, on a page that declares its product",
    path: "investigate/product-recaptcha-login.html",
    status: 403,
    prestep: null,
    challenge: null,
    declared:
      "investigate still reports a `status` signal for the 403 — a refusal of this request, weighed over a run by `blockedShare`. " +
      "Prestep has no word for that and must not borrow the captcha's.",
  },
  {
    name: "an Incapsula interstitial",
    path: "investigate/challenge-incapsula.html",
    status: 200,
    prestep: "blocked_bot_detection",
    challenge: "decisive",
  },
  {
    name: "a Cloudflare interstitial titled 'Just a moment...'",
    path: "challenge.html",
    status: 503,
    prestep: "blocked_bot_detection",
    challenge: "decisive",
  },
  {
    name: "a captcha that is the page, with no bundle that would ever fill it",
    path: "investigate/captcha-interstitial.html",
    status: 200,
    prestep: "blocked_bot_detection",
    challenge: "corroborated",
  },
  {
    name: "an apology page: the store's error document, served for every address",
    path: "investigate/apology.html",
    status: 200,
    prestep: null,
    challenge: null,
    declared:
      "the apology rule is about a *corpus* — the same document on different URLs — so one page can never trigger it. " +
      "Prestep sees exactly one page and is structurally unable to ask the question, which is why `apologySignals` lives only on the run side.",
  },
  {
    name: "a healthy server-rendered product page",
    path: "investigate/product.html",
    status: 200,
    prestep: null,
    challenge: null,
  },
  {
    name: "a JS shell",
    path: "investigate/storeb-shell.html",
    status: 200,
    prestep: null,
    challenge: null,
  },
  {
    name: "a JS shell behind a WAF: the same bytes as an interstitial to a plain fetch",
    path: "investigate/storeb-shell-waf.html",
    status: 200,
    prestep: null,
    challenge: "corroborated",
    declared:
      "both sides read the widget and both hold it back on a shell. Investigate keeps the signal so `classifyRun` can answer `deferred`; " +
      "prestep keeps navigating, because the browser it runs in is the render that settles it.",
  },
  {
    name: "a bare nginx 403",
    path: "investigate/forbidden.html",
    status: 403,
    prestep: null,
    challenge: null,
    declared: "the status is the whole signal, and the status is investigate's `BLOCKING_STATUSES` authority, not a challenge reading.",
  },
  {
    name: "a login wall",
    path: "login-wall.html",
    status: 200,
    prestep: "blocked_login_required",
    challenge: null,
    declared: "a login wall is prestep's other answer and has no counterpart on the run side; what matters is that neither calls it a bot challenge.",
  },
  {
    name: "a login wall with reCAPTCHA in the form",
    path: "investigate/login-wall-recaptcha.html",
    status: 200,
    prestep: "blocked_login_required",
    challenge: "corroborated",
    declared:
      "the captcha in a login form is furniture for the same reason it is on a product page, and prestep has the better word for the page. " +
      "Both call it blocked; only prestep can say which kind, which is why the login check is asked before the corroborated half.",
  },
];

let server: FixtureServer;
let browser: LaunchedBrowser;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launch({ browser: "chromium", headed: false });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Prestep's answer about the live page, with the status the caller would have. */
async function askPrestep(row: Row): Promise<BlockedStatus | null> {
  const page = await browser.context.newPage();
  try {
    await page.goto(`${server.baseUrl}/fixtures/${row.path}`);
    return await classifyBlocked(page, { status: row.status });
  } finally {
    await page.close();
  }
}

/** Investigate's answer about the stored bytes, and how strongly it holds it. */
function askInvestigate(row: Row): ChallengeStrength {
  const signal = challengeSignal({ url: `https://example.cl/${row.path}`, status: row.status, body: bodyOf(row.path) });
  if (signal === null) return null;
  return signal.corroborated === true ? "corroborated" : "decisive";
}

describe("the two blocked detectors, over one corpus", () => {
  it.each(CORPUS.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
    const prestep = await askPrestep(row);
    const challenge = askInvestigate(row);

    // Both verdicts, per row. A change on either side has to come back here and
    // say which column moved.
    expect({ prestep, challenge }).toEqual({ prestep: row.prestep, challenge: row.challenge });

    /**
     * And the property the file exists for. `investigateRefuses` is derived by
     * calling both rules — never by restating either — and it is exactly what
     * `classifyRun` does with a corroborated signal: hold it back on a URL
     * `shell-skips-tier-1` claims, because a shell is empty by construction and
     * the emptiness is the only thing the reading had.
     */
    const body = bodyOf(row.path);
    const signal = challengeSignal({ url: `https://example.cl/${row.path}`, status: row.status, body });
    const shell = bank().run("shell-skips-tier-1", { html: body }).fires;
    const investigateRefuses = signal !== null && !(signal.corroborated === true && shell);

    // Neither may call a page fine that the other calls refused …
    if (investigateRefuses) expect(prestep).not.toBeNull();
    // … and prestep may not invent a bot challenge the bytes do not carry.
    if (prestep === "blocked_bot_detection") expect(investigateRefuses).toBe(true);
  });

  it("names every row where the two are allowed to differ, and why", () => {
    // Not decoration: this is the rule from the audit — divergence must be
    // declared rather than discovered. A row that grows a divergence without a
    // reason written next to it fails here.
    for (const row of CORPUS) {
      const differs = (row.prestep === "blocked_bot_detection") !== (row.challenge !== null);
      if (differs) expect(row.declared, `${row.name} diverges with no reason declared`).toBeTruthy();
    }
    expect(CORPUS.filter((row) => row.declared !== undefined).length).toBeGreaterThan(3);
  });
});

describe("what changed on the prestep side", () => {
  it("a captcha container and a refusing status are not a challenge on a page that is serving a product", async () => {
    // The rule this replaces, verbatim from `src/prestep/blocked.ts` before
    // today: `status ∈ {403, 429, 503} && (titleHit || textHit || selectorHit)`.
    // All three conjuncts of the old rule are satisfied below — the container is
    // in the DOM, the status is 403 — and the page is still answering, so it is
    // not a challenge. That is the verdict investigate has always given these
    // bytes.
    const page = await browser.context.newPage();
    try {
      await page.goto(`${server.baseUrl}/fixtures/investigate/product-recaptcha-login.html`);
      expect(await page.locator(".g-recaptcha").count()).toBe(1);
      expect(await classifyBlocked(page, { status: 403 })).toBeNull();
      expect(await classifyBlocked(page, { status: 429 })).toBeNull();
      expect(await classifyBlocked(page, { status: 503 })).toBeNull();
    } finally {
      await page.close();
    }
  });

  it("still reads the same container as a challenge once the page stops serving anything", async () => {
    // The corroboration is what the container needed all along, and it is
    // available: no declared product and almost no text.
    const page = await browser.context.newPage();
    try {
      await page.goto(`${server.baseUrl}/fixtures/investigate/captcha-interstitial.html`);
      expect(await page.locator(".g-recaptcha").count()).toBe(1);
      // No status at all: the reading never needed one.
      expect(await classifyBlocked(page)).toBe("blocked_bot_detection");
    } finally {
      await page.close();
    }
  });
});

describe("one lexicon, one split", () => {
  it("prestep's container list is the two halves and nothing else", () => {
    expect(BOT_CHALLENGE_SELECTORS).toEqual([...DECISIVE_CHALLENGE_SELECTORS, ...WIDGET_CHALLENGE_SELECTORS]);
    expect(new Set(DECISIVE_CHALLENGE_SELECTORS).size + new Set(WIDGET_CHALLENGE_SELECTORS).size).toBe(new Set(BOT_CHALLENGE_SELECTORS).size);
    // The captcha widgets are the corroborated half. This is the assignment the
    // whole disagreement turned on.
    expect(WIDGET_CHALLENGE_SELECTORS).toContain(".g-recaptcha");
    expect(DECISIVE_CHALLENGE_SELECTORS).toContain("#px-captcha");
  });

  it("marks every corroborated reading and no decisive one", () => {
    const interstitial = { title: "", text: "", declaresProduct: false };
    expect(readChallenge({ ...interstitial, decisive: { evidence: "cf-mitigated: challenge", because: "…" } })?.corroborated).toBeUndefined();
    expect(readChallenge({ ...interstitial, title: "Just a moment..." })?.corroborated).toBeUndefined();
    expect(readChallenge({ ...interstitial, widget: "g-recaptcha" })?.corroborated).toBe(true);
    expect(readChallenge({ ...interstitial, text: "Verifica que eres humano" })?.corroborated).toBe(true);
  });

  it("refuses the corroborated half on a page that is answering, whatever the status said", () => {
    // Two gates, and each one alone is enough to stop the reading.
    expect(readChallenge({ title: "", text: "", declaresProduct: true, widget: "g-recaptcha" })).toBeNull();
    expect(readChallenge({ title: "", text: "x".repeat(1_600), declaresProduct: false, widget: "g-recaptcha" })).toBeNull();
    // And neither gate touches a decisive marker: those say something about the
    // response rather than about how little of it there is.
    expect(readChallenge({ title: "", text: "x".repeat(1_600), declaresProduct: true, decisive: { evidence: "px-captcha", because: "…" } })).not.toBeNull();
  });
});
