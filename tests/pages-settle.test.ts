import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { openPages, type Pages } from "../src/make/index.js";
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
  });
});
