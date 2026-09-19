import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { getControls } from "../src/browser/snapshot.js";
import { BOT_CHALLENGE_SELECTORS, BOT_CHALLENGE_TEXT, LOGIN_HINTS, classifyBlocked } from "../src/prestep/blocked.js";
import { CONSENT_NAME_PATTERN, CONSENT_RULES, dismissConsent } from "../src/prestep/consent.js";
import { handoffToHuman } from "../src/prestep/human.js";
import { runPreSteps, type PreStepOutcome } from "../src/prestep/index.js";
import { clickTurnstile } from "../src/prestep/turnstile.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

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

async function withPage<T>(url: string | null, fn: (page: Page, status: number | undefined) => Promise<T>): Promise<T> {
  const page = await browser.context.newPage();
  try {
    let status: number | undefined;
    if (url) {
      const response = await page.goto(`${server.baseUrl}${url}`);
      status = response?.status();
    }
    return await fn(page, status);
  } finally {
    await page.close();
  }
}

const noNotify = vi.fn(async (_message: string) => undefined);

function base(over: Partial<Parameters<typeof runPreSteps>[1]> = {}): Parameters<typeof runPreSteps>[1] {
  return { profile: "store", attended: false, notify: noNotify, humanTimeoutMs: 200, humanPollMs: 20, turnstileWaitMs: 100, env: {}, ...over };
}

declare global {
  interface Window {
    __clicks?: number;
  }
}

describe("consent pre-step (R9, KTD8)", () => {
  it("AE4: the generic rule accepts the cookie banner and the list becomes clickable", async () => {
    await withPage("/fixtures/cookie-banner.html", async (page, status) => {
      const before = await getControls(page, { profile: "store" });
      expect(before.find((c) => c.name === "Load more")).toMatchObject({ clickable: false });

      const outcome = await runPreSteps(page, base({ response: { status } }));
      expect(outcome.status).toBeNull();
      expect(outcome.steps).toEqual([{ op: "click", alternatives: [{ role: "button", name: "Accept all", exact: true }] }]);

      const after = await getControls(page, { profile: "store" });
      expect(after.find((c) => c.name === "Load more")).toMatchObject({ clickable: true });
      expect(after.find((c) => c.name === "Accept all")).toBeUndefined();
      expect(await page.locator(".xk-privacy-shield").count()).toBe(0);
    });
  });

  it("a OneTrust-style id is dismissed by the vendor rule without a matching name", async () => {
    await withPage(null, async (page) => {
      await page.setContent(`<!doctype html><title>Site</title><h1>Hello</h1>
        <div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:1rem">
          <p>This site uses cookies.</p>
          <button id="onetrust-accept-btn-handler" type="button">Yes, that is fine by me</button>
        </div>
        <script>document.getElementById("onetrust-accept-btn-handler").addEventListener("click", () => document.getElementById("onetrust-banner-sdk").remove());</script>`);
      expect(CONSENT_NAME_PATTERN.test("Yes, that is fine by me")).toBe(false);
      expect(CONSENT_RULES.some((r) => r.selector === "#onetrust-accept-btn-handler")).toBe(true);

      const result = await dismissConsent(page);
      expect(result.dismissed).toBe(true);
      expect(result.clicked).toEqual([{ role: "button", name: "Yes, that is fine by me" }]);
      expect(await page.locator("#onetrust-banner-sdk").count()).toBe(0);
    });
  });

  it("a newsletter modal that is not consent is left alone", async () => {
    await withPage(null, async (page) => {
      await page.setContent(`<!doctype html><title>Blog</title><h1>Posts</h1>
        <ul><li>a</li><li>b</li><li>c</li><li>d</li><li>e</li></ul>
        <div role="dialog" aria-label="Subscribe to our newsletter" style="position:fixed;inset:0;background:rgba(0,0,0,.4)">
          <h2>Subscribe to our newsletter</h2>
          <input type="email" placeholder="you@example.com">
          <button id="subscribe" type="button">Subscribe</button>
        </div>
        <script>window.__clicks = 0; document.getElementById("subscribe").addEventListener("click", () => { window.__clicks++; });</script>`);
      const outcome = await runPreSteps(page, base());
      expect(outcome).toEqual({ status: null, steps: [] });
      expect(await page.evaluate(() => window.__clicks)).toBe(0);
      expect(await page.locator("[role=dialog]").count()).toBe(1);
    });
  });
});

describe("turnstile pre-step (R9)", () => {
  it("clicks the checkbox once and never a second time", async () => {
    await withPage("/fixtures/challenge.html", async (page) => {
      await page.evaluate(() => {
        window.__clicks = 0;
        document.getElementById("turnstile-check")!.addEventListener("click", () => {
          window.__clicks = (window.__clicks ?? 0) + 1;
        });
      });
      const first = await clickTurnstile(page, { waitMs: 100 });
      expect(first.clicked).toBe(true);
      expect(first.control).toEqual({ role: "checkbox", name: "Verify you are human" });
      expect(await page.evaluate(() => window.__clicks)).toBe(1);

      const second = await clickTurnstile(page, { waitMs: 100 });
      expect(second.clicked).toBe(false);
      expect(await page.evaluate(() => window.__clicks)).toBe(1);
    });
  });

  it("reports clicked: false on a page without a turnstile", async () => {
    await withPage("/fixtures/python-jobs.html", async (page) => {
      expect(await clickTurnstile(page, { waitMs: 100 })).toEqual({ clicked: false });
    });
  });
});

describe("blocked classification (R9, R13)", () => {
  it("exports the marker lists", () => {
    expect(BOT_CHALLENGE_TEXT.length).toBeGreaterThan(5);
    expect(BOT_CHALLENGE_SELECTORS).toContain("#px-captcha");
    expect(LOGIN_HINTS.length).toBeGreaterThan(3);
  });

  it("the challenge fixture (503) is bot detection", async () => {
    await withPage("/fixtures/challenge.html", async (page, status) => {
      expect(status).toBe(503);
      expect(await classifyBlocked(page, { status })).toBe("blocked_bot_detection");
      // Also without the response: title and body markers are enough.
      expect(await classifyBlocked(page)).toBe("blocked_bot_detection");
    });
  });

  it("the login wall is login required; a list page is neither", async () => {
    await withPage("/fixtures/login-wall.html", async (page, status) => {
      expect(await classifyBlocked(page, { status })).toBe("blocked_login_required");
    });
    await withPage("/fixtures/python-jobs.html", async (page, status) => {
      expect(await classifyBlocked(page, { status })).toBeNull();
    });
  });

  it("a list page with a login form in the header is not a login wall", async () => {
    await withPage(null, async (page) => {
      const items = Array.from({ length: 8 }, (_, i) => `<li class="post"><a href="/p/${i}">Post ${i}: notes from the field</a><span class="by">by user${i}</span></li>`).join("");
      await page.setContent(`<!doctype html><title>Forum</title>
        <form method="post" action="/login"><input name="u"><input name="p" type="password"><button>Sign in</button></form>
        <ul class="posts">${items}</ul>`);
      expect(await classifyBlocked(page, { status: 200 })).toBeNull();
    });
  });
});

describe("human handoff (R41, KTD20)", () => {
  it("unattended: resolves false at once without notifying", async () => {
    await withPage("/fixtures/challenge.html", async (page) => {
      const notify = vi.fn(async (_m: string) => undefined);
      const result = await handoffToHuman(page, { attended: false, notify, timeoutMs: 1000, pollMs: 10, isStillBlocked: async () => true, env: {} });
      expect(result.resolved).toBe(false);
      expect(notify).not.toHaveBeenCalled();
    });
  });

  it("attended on Apify: treated as unattended", async () => {
    await withPage("/fixtures/challenge.html", async (page) => {
      const notify = vi.fn(async (_m: string) => undefined);
      const result = await handoffToHuman(page, {
        attended: true,
        notify,
        timeoutMs: 1000,
        pollMs: 10,
        isStillBlocked: async () => false,
        env: { APIFY_IS_AT_HOME: "1" },
      });
      expect(result.resolved).toBe(false);
      expect(notify).not.toHaveBeenCalled();
    });
  });
});

describe("runPreSteps (R9, R13, R27, R41)", () => {
  it("AE5: the challenge fixture unattended ends with blocked_bot_detection and no notification", async () => {
    await withPage("/fixtures/challenge.html", async (page, status) => {
      const notify = vi.fn(async (_m: string) => undefined);
      const outcome = await runPreSteps(page, base({ notify, response: { status } }));
      expect(outcome.status).toBe("blocked_bot_detection");
      expect(notify).not.toHaveBeenCalled();
      // The turnstile click was still attempted once and is on record.
      expect(outcome.steps).toEqual([{ op: "click", alternatives: [{ role: "checkbox", name: "Verify you are human", exact: true }] }]);
    });
  });

  it("AE16: attended, a person clears the challenge and a human step is recorded", async () => {
    await withPage("/fixtures/challenge.html", async (page, status) => {
      // The scripted person reacts to the notification: 300ms later the challenge is gone.
      let person: NodeJS.Timeout | undefined;
      const notify = vi.fn(async (_m: string) => {
        person = setTimeout(() => {
          void page.goto(`${server.baseUrl}/fixtures/python-jobs.html`);
        }, 300);
      });
      let outcome: PreStepOutcome;
      try {
        outcome = await runPreSteps(page, base({ attended: true, notify, humanTimeoutMs: 10_000, humanPollMs: 50, response: { status } }));
      } finally {
        clearTimeout(person);
      }
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![0]).toContain("/fixtures/challenge.html");
      expect(outcome.status).toBeNull();
      // Chronological: the one turnstile click, then what the person did.
      expect(outcome.steps).toEqual([
        { op: "click", alternatives: [{ role: "checkbox", name: "Verify you are human", exact: true }] },
        {
          op: "human",
          human: true,
          alternatives: [{ role: "document", name: "Python Jobs", exact: false }],
          expect: { urlPattern: "/fixtures/python-jobs.html" },
        },
      ]);
    });
  });

  it("AE16: attended, nobody comes: blocked_bot_detection with a human timeout reason", async () => {
    await withPage("/fixtures/challenge.html", async (page, status) => {
      const notify = vi.fn(async (_m: string) => undefined);
      const outcome = await runPreSteps(page, base({ attended: true, notify, humanTimeoutMs: 150, humanPollMs: 20, response: { status } }));
      expect(notify).toHaveBeenCalledTimes(1);
      expect(outcome.status).toBe("blocked_bot_detection");
      expect(outcome.status !== null && outcome.reason).toMatch(/human timeout/);
      expect(outcome.steps.some((s) => s.op === "human")).toBe(false);
    });
  });

  it("login wall: blocked under store, blocked under local without secrets, passes under local with secrets", async () => {
    await withPage("/fixtures/login-wall.html", async (page, status) => {
      const store = await runPreSteps(page, base({ profile: "store", response: { status } }));
      expect(store.status).toBe("blocked_login_required");

      const localNoSecrets = await runPreSteps(page, base({ profile: "local", hasSecrets: false, response: { status } }));
      expect(localNoSecrets.status).toBe("blocked_login_required");

      const localWithSecrets = await runPreSteps(page, base({ profile: "local", hasSecrets: true, response: { status } }));
      expect(localWithSecrets).toEqual({ status: null, steps: [] });
    });
  });

  it("R27: a credential-looking goal is refused before any page interaction", async () => {
    const page = {
      goto: vi.fn(),
      evaluate: vi.fn(),
      locator: vi.fn(),
      title: vi.fn(),
      url: vi.fn(),
      bringToFront: vi.fn(),
    };
    const notify = vi.fn(async (_m: string) => undefined);
    const outcome = await runPreSteps(page as unknown as Page, base({ goal: "log in with user max and password: hunter2, then list orders", notify }));
    expect(outcome.status).toBe("blocked_login_required");
    expect(outcome.status !== null && outcome.reason).toMatch(/goal carries a password/);
    expect(outcome.steps).toEqual([]);
    for (const fn of Object.values(page)) expect(fn).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("python-jobs: status null with zero steps", async () => {
    await withPage("/fixtures/python-jobs.html", async (page, status) => {
      expect(await runPreSteps(page, base({ response: { status } }))).toEqual({ status: null, steps: [] });
    });
  });
});
