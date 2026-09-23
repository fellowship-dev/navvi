import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { openPages, type Pages } from "../src/make/index.js";
import type { DrivenCapture } from "../src/make/pages.js";
import { dismissConsent } from "../src/prestep/consent.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U11: the driver's settle sequence, which is the one part of `src/make/` that
 * needs a browser and therefore the one part `tests/make.test.ts` cannot reach.
 *
 * The defect these cover, measured on `store-b.example` on 2026-09-23: on the
 * default browser (Camoufox) `navvi make` bound none of five fields and on
 * `--browser chromium` it bound three, with the same tree and the same
 * endpoints. The cause was two moments, both of which the driver got wrong
 * because Camoufox is slower to first paint than Chromium:
 *
 *  1. `goto(waitUntil: "networkidle")` resolved at 2,253 ms under Camoufox
 *     against a 2,470-byte shell, five seconds before the "Aceptar" button
 *     existed, so the one consent dismissal clicked nothing and recorded no
 *     obstacle. Under Chromium the same navigation resolved at 7,288 ms, by
 *     which time the banner had been up for a while.
 *  2. The render then plateaued at 3,174 characters from 7.0 s to 9.4 s while
 *     the page waited on `products/detail`, and a settle that returned on one
 *     unchanged reading returned there — handing tier 2 a page that had not
 *     finished rendering to anchor its candidates against.
 *
 * **What these tests cannot do.** They cannot reproduce the engine difference:
 * one Camoufox download is not a thing a unit test may depend on, and the
 * difference is a property of two real network stacks against one real site,
 * not of anything navvi owns. They run on Chromium, like the rest of the
 * suite. What they can do is hold the driver to the behaviour that difference
 * demanded — a banner that arrives after the navigation is still dismissed and
 * still recorded, and a render that pauses mid-flight is still waited for —
 * against fixtures built to put those two moments where Camoufox put them.
 * Both fail against the code as it stood this morning.
 */

/** A loopback port with nothing behind it: bound on 0, read back, released. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") return reject(new Error("the probe server reported no port"));
      probe.close(() => resolve(address.port));
    });
  });
}

let server: FixtureServer;
let browser: LaunchedBrowser;
let pages: Pages;
let storageDir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launch({ browser: "chromium", headed: false });
  storageDir = mkdtempSync(join(tmpdir(), "navvi-pages-"));
  pages = await openPages({ browser: "chromium", headed: false, storageDir });
});

afterAll(async () => {
  await pages?.close();
  await browser?.close();
  await server?.close();
});

describe("the driver's consent pass (U11, R9)", () => {
  it("the late-consent fixture has no banner when the navigation resolves: a single early dismissal clicks nothing", async () => {
    // The premise, stated as a fact about the fixture rather than assumed:
    // this is the shape of page the first dismissal cannot help with.
    const page = await browser.context.newPage();
    try {
      await page.goto(`${server.baseUrl}/fixtures/late-consent.html`, { waitUntil: "networkidle" });
      expect(await page.locator("#shield").count()).toBe(0);
      expect(await dismissConsent(page)).toEqual({ dismissed: false, clicked: [] });
    } finally {
      await page.close();
    }
  });

  it("a banner that arrives after the navigation is still clicked, and still recorded as an obstacle", async () => {
    const capture = await pages.capture(`${server.baseUrl}/fixtures/late-consent.html`);

    expect(capture.obstacles).toEqual([
      {
        kind: "consent",
        url: `${server.baseUrl}/fixtures/late-consent.html`,
        because: 'a consent dialog stood between the navigation and the page; navvi clicked button "Aceptar"',
        evidence: "Aceptar",
        blocking: false,
      },
    ]);

    // The click is what the page was gating its content on, so the text is the
    // proof the click landed rather than a second reading of the same thing.
    expect(capture.text).toContain("Ejemplo Analgesico 500 mg 16 Comprimidos");
    expect(capture.text).toContain("3.591");
    expect(capture.html).toContain('class="promo"');
    // And the banner is gone rather than merely clicked.
    expect(capture.text).not.toContain("Usamos cookies");
  });
});

describe("the driver's settle (U11)", () => {
  it("a render that pauses mid-flight is waited out, not read in the pause", async () => {
    const capture = await pages.capture(`${server.baseUrl}/fixtures/paused-render.html`);

    // The shell is what a settle that stops at the first unchanged reading gets.
    expect(capture.text).toContain("Farmacia de ejemplo");
    // Everything after the pause is what it misses.
    expect(capture.text).toContain("Ejemplo Antiacido 20 mg 14 Capsulas");
    expect(capture.text).toContain("6.392");
    expect(capture.obstacles).toEqual([]);
    // And it says so: this one is a measurement, not as far as it got.
    expect(capture.settle.outcome).toBe("quiesced");
  });
});

/**
 * A1: the cap that failed silently as a site regression.
 *
 * Measured on 2026-09-23 against one live product URL, twice: alone, `navvi
 * make` rendered 11,190 characters and bound 3 of 5; with a full `npm test`
 * running beside it, the same command on the same URL rendered 3,219
 * characters, still had the consent banner up, and bound 0 of 5 with "no
 * captured leaf survived the filter". Nothing in the second transcript says
 * which of those two runs it was — a reader with only that transcript reads a
 * site that has changed, files it, and is wrong.
 *
 * The budget is the thing under test, so the budget is what is starved: these
 * open a second driver whose `settleCapMs` is seconds rather than 25 of them
 * and point it at a page that never stops painting. No test in this repository
 * may wait 25 real seconds to find out what the driver does at the end of one,
 * and a page that outlasts a short budget is the same fact about the driver as
 * a busy machine outlasting a long one.
 */
describe("a settle that runs out of its budget (A1)", () => {
  /**
   * One budget, two pages, and it has to be long enough that the *static* page
   * still settles inside it however busy the machine is: four polls is 3 s, and
   * the rest is slack for a navigation that may be competing with a browser
   * suite for a core. A test about a harness that lied under load is the last
   * test in the repository that may itself flake under load, and it can only
   * flake in that direction — nothing lets the page that repaints every 120 ms
   * hold still for three consecutive 750 ms polls.
   */
  const STARVED_CAP_MS = 9_000;

  /**
   * A loopback port that was ours a moment ago and is nobody's now: bound on
   * 0, read back, closed. A hard-coded low port would have been simpler and
   * would have tested the wrong thing — Chromium refuses to dial port 1 at all
   * (`net::ERR_UNSAFE_PORT`), which is the browser declining rather than the
   * navigation failing. This gets `net::ERR_CONNECTION_REFUSED`, in
   * milliseconds, with no name to resolve and nothing outside this machine.
   */
  let nowhereUrl: string;

  let starved: Pages;
  let starvedDir: string;
  let unfinished: DrivenCapture;
  let blank: DrivenCapture;
  let missing: DrivenCapture;

  beforeAll(async () => {
    starvedDir = mkdtempSync(join(tmpdir(), "navvi-starved-"));
    starved = await openPages({ browser: "chromium", headed: false, storageDir: starvedDir, settleCapMs: STARVED_CAP_MS });
    unfinished = await starved.capture(`${server.baseUrl}/fixtures/never-settles.html`);
    blank = await starved.capture(`${server.baseUrl}/fixtures/settled-blank.html`);
    nowhereUrl = `http://127.0.0.1:${await closedPort()}/`;
    missing = await starved.capture(nowhereUrl);
  }, 60_000);

  afterAll(async () => {
    await starved?.close();
  });

  it("a render the budget could not outlast is reported as unfinished, with what was still moving", () => {
    expect(unfinished.settle.outcome).toBe("capped");
    if (unfinished.settle.outcome !== "capped") return;

    // What was still moving, in the two trends the settle watches: the text
    // grew all the way to the last poll, and nothing was being fetched — which
    // is the half of the evidence that says the page was drawing, not waiting.
    expect(unfinished.settle.text).toBeGreaterThan(unfinished.settle.textFrom);
    expect(unfinished.settle.payloads).toBe(unfinished.settle.payloadsFrom);
    expect(unfinished.settle.changed).toBeGreaterThan(0);
    expect(unfinished.settle.polls).toBeGreaterThan(1);

    // And the sentence the transcript can print, carrying the same numbers.
    expect(unfinished.settle.because).toContain("never held still");
    expect(unfinished.settle.because).toContain(`text ${unfinished.settle.textFrom} -> ${unfinished.settle.text} characters`);
  });

  it("a page that finished with nothing worth binding on it is the other answer", () => {
    expect(blank.settle.outcome).toBe("quiesced");
    expect(blank.text).toContain("No pudimos mostrar este producto");
  });

  it("a navigation that never arrived says so, and does not spend the budget finding out", () => {
    expect(missing.settle.outcome).toBe("unreachable");
    if (missing.settle.outcome !== "unreachable") return;

    // What it said, rather than the silence `goto(...).catch(() => undefined)`
    // left behind.
    expect(missing.settle.because).toContain("ERR_CONNECTION_REFUSED");
    expect(missing.settle.because).toContain(nowhereUrl);
    expect(missing.settle.arrival).toBe(missing.settle.because);

    // And not one poll: watching a page that was never fetched arrive is how a
    // failed navigation used to cost a full settle and come back as an empty
    // capture — the same transcript as a page that emptied out.
    expect(missing.settle.polls).toBe(0);
    expect(missing.settle.ms).toBeLessThan(STARVED_CAP_MS);
  });

  it("the settle is the only thing that tells the three apart", () => {
    // Everything the binder reads of these three captures agrees: a few hundred
    // characters of text that anchor no candidate, and no payload to bind from.
    // That is precisely the live transcript — 0 of 5, "no captured leaf
    // survived the filter" — and it is the same on the page that changed, on
    // the machine that was busy, and on the URL that never answered. Before the
    // settle said which, nothing in the capture did: `settleRender` answered
    // with a text length that both of its call sites threw away, and `goto`'s
    // rejection was thrown away too.
    expect(unfinished.responses).toEqual([]);
    expect(blank.responses).toEqual([]);
    expect(missing.responses).toEqual([]);
    expect(unfinished.text?.length ?? 0).toBeGreaterThan(0);
    expect(blank.text?.length ?? 0).toBeGreaterThan(0);

    // What tells them apart, and the reason this is not just a field on a
    // struct: an unfinished measurement is now an `Obstacle`, so it rides the
    // road every other one rides — the manuscript records it and `reconcile.md`
    // costs it. A reader of a thin run learns the harness was starved without
    // having been in the room. The page that genuinely had nothing on it
    // records nothing, because nothing stood in the way.
    expect(blank.obstacles ?? []).toEqual([]);
    expect((unfinished.obstacles ?? []).map((obstacle) => obstacle.kind)).toEqual(["unsettled"]);
    expect((missing.obstacles ?? []).map((obstacle) => obstacle.kind)).toEqual(["unsettled"]);
    expect(unfinished.obstacles?.[0]?.blocking).toBe(false);
    expect(unfinished.obstacles?.[0]?.because).toContain("never held still");
    expect(missing.obstacles?.[0]?.because).toContain("ERR_CONNECTION_REFUSED");

    expect([unfinished.settle.outcome, blank.settle.outcome, missing.settle.outcome]).toEqual(["capped", "quiesced", "unreachable"]);
  });
});
