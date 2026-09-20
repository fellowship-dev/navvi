import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import { DENY_LIST } from "../src/browser/policy.js";
import {
  DEFAULT_CAPS,
  SNAPSHOT_BUDGET_CHARS,
  SNAPSHOT_DENY_LIST,
  getCandidates,
  getControls,
  resolveLeaf,
  serializeControls,
  serializeForChooser,
  type Candidates,
  type LeafCandidate,
} from "../src/browser/snapshot.js";
import { recordStep } from "../src/navigate/trace.js";
import { freshnessToken, isStale, waitForSettle } from "../src/browser/guards.js";
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

async function withPage<T>(url: string, fn: (page: Page) => Promise<T>, context = browser.context): Promise<T> {
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}${url}`);
    return await fn(page);
  } finally {
    await page.close();
  }
}

const FIXTURES = [
  "/fixtures/python-jobs.html",
  "/fixtures/hackernews.html",
  "/fixtures/placeholder-board.html",
  "/fixtures/infinite-scroll.html",
  "/fixtures/cookie-banner.html",
  "/fixtures/challenge.html",
  "/fixtures/login-wall.html",
  "/fixtures/search-form.html",
  "/fixtures/results.html?q=python",
  "/fixtures/delete-account.html",
  "/fixtures/redirect-private.html",
  "/fixtures/many-links.html",
  "/demo/pharmacy-v1/index.html",
  "/demo/pharmacy-v1/producto/paracetamol-500-mg.html",
  "/demo/pharmacy-v2/index.html",
  "/demo/pharmacy-v2/producto/atorvastatina-20-mg.html",
  "/login/",
] as const;

const byText = (leaves: LeafCandidate[], text: string) => leaves.find((l) => l.text === text && !l.attr);

describe("group candidates (R7, R10, KTD5)", () => {
  it("python-jobs yields a group of 25 li items ranked first", async () => {
    await withPage("/fixtures/python-jobs.html", async (page) => {
      const { groups } = await getCandidates(page);
      expect(groups.length).toBeGreaterThan(0);
      const top = groups[0]!;
      expect(top.itemCount).toBe(25);
      expect(top.itemSelector).toBe("li.job");
      expect(top.selector).toBe("ul.jobs");
      expect(top.sampleTexts).toHaveLength(3);
      expect(top.sampleTexts[0]).toContain("Senior Python Engineer");
      const count = await page.evaluate((sel) => document.querySelectorAll(`${sel} > li.job`).length, top.selector);
      expect(count).toBe(25);
    });
  });

  it("finds content rows when more frequent spacer rows have no text", async () => {
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent(`<table><tbody id="listings">${Array.from({ length: 8 }, (_, i) => `
        <tr class="divider"><td></td></tr><tr class="divider"><td></td></tr>
        <tr class="listing${i > 2 ? " verified" : ""}"><td>Engineer ${i} at Company ${i}, remote worldwide</td></tr>
        <tr class="expanded" style="display:none"><td>Hidden description ${i}</td></tr>`).join("")}</tbody></table>`);
      const { groups } = await getCandidates(page);
      const listings = groups.find((g) => g.selector === "#listings" && g.itemSelector === "tr.listing");
      expect(listings).toBeDefined();
      expect(listings!.itemCount).toBe(8);
      expect(listings!.sampleTexts[0]).toContain("Engineer 0");
      expect(groups[0]!.id).toBe(listings!.id);
      expect(await page.locator(`${listings!.selector} > ${listings!.itemSelector}`).count()).toBe(listings!.itemCount);
      expect(groups.some((g) => g.itemSelector.includes("divider") || g.itemSelector.includes("expanded"))).toBe(false);
    });
  });

  it("hackernews yields an anchor-plus-rows candidate of 30 items whose sample text has title and points", async () => {
    await withPage("/fixtures/hackernews.html", async (page) => {
      const { groups } = await getCandidates(page);
      const rows = groups.find((g) => g.anchorPlusRows);
      expect(rows).toBeDefined();
      expect(rows!.itemCount).toBe(30);
      expect(rows!.anchorPlusRows!.span).toBe(3);
      expect(rows!.sampleTexts[0]).toContain("Show HN: A self-healing scraper compiler");
      expect(rows!.sampleTexts[0]).toContain("points");
      const anchors = await page.evaluate((sel) => document.querySelectorAll(sel).length, rows!.anchorPlusRows!.anchorSelector);
      expect(anchors).toBe(30);
      // the multi-row candidate outranks the single-row tr.athing group
      expect(groups[0]!.id).toBe(rows!.id);
    });
  });

  it("placeholder board: identical skeleton rows are not a group; the hydrated rows are after settle", async () => {
    await withPage("/fixtures/placeholder-board.html", async (page) => {
      const before = await getCandidates(page);
      expect(before.groups.filter((g) => g.selector.includes("root") || g.itemSelector.includes("row"))).toHaveLength(0);
      const token = await freshnessToken(page);
      // the board hydrates 800ms after load; a 1s quiet window spans it
      expect(await waitForSettle(page, { idleMs: 1_000, maxMs: 5_000 })).toBe(true);
      expect(await isStale(page, token)).toBe(true);
      const after = await getCandidates(page);
      const board = after.groups.find((g) => g.itemSelector === "div.row");
      expect(board).toBeDefined();
      expect(board!.itemCount).toBe(10);
      expect(board!.selector).toBe("#root");
      expect(await isStale(page, await freshnessToken(page))).toBe(false);
    });
  });

  it("exported caps equal the in-page defaults", async () => {
    await withPage("/fixtures/search-form.html", async (page) => {
      await getCandidates(page);
      const inPage = await page.evaluate(() => (window as unknown as { __navvi: { DEFAULT_CAPS: unknown } }).__navvi.DEFAULT_CAPS);
      expect(inPage).toEqual(DEFAULT_CAPS);
    });
  });

  it("ids are stable across calls within a page", async () => {
    await withPage("/fixtures/python-jobs.html", async (page) => {
      const first = await getCandidates(page);
      const second = await getCandidates(page);
      expect(second.groups.map((g) => g.id)).toEqual(first.groups.map((g) => g.id));
      expect(second.leaves.map((l) => l.id)).toEqual(first.leaves.map((l) => l.id));
      expect(second.links.map((l) => l.id)).toEqual(first.links.map((l) => l.id));
      const controls1 = await getControls(page, { profile: "store" });
      const controls2 = await getControls(page, { profile: "store" });
      expect(controls2.map((c) => c.id)).toEqual(controls1.map((c) => c.id));
    });
  });

  it("enumerates item-relative leaves inside one list item, with @href and @datetime attributes", async () => {
    await withPage("/fixtures/python-jobs.html", async (page) => {
      const { groups } = await getCandidates(page);
      const top = groups[0]!;
      const item = await getCandidates(page, { within: `${top.selector} > ${top.itemSelector}`, itemIndex: 1 });
      expect(item.groups).toHaveLength(0);
      const title = item.leaves.find((l) => l.text.startsWith("Backend Developer"));
      expect(title).toMatchObject({ path: "h2.job-title/a", shape: "text" });
      const href = item.leaves.find((l) => l.attr === "href");
      expect(href).toMatchObject({ path: "h2.job-title/a/@href", shape: "url", text: "/fixtures/jobs/101.html" });
      const date = item.leaves.find((l) => l.attr === "datetime");
      expect(date).toMatchObject({ path: "time.posted/@datetime", shape: "date", text: "2026-08-27" });
      for (const leaf of item.leaves) {
        const resolved = await resolveLeaf(page, { selector: leaf.selector, attr: leaf.attr, within: `${top.selector} > ${top.itemSelector}`, itemIndex: 1 });
        expect(resolved, `${leaf.path} via ${leaf.selector}`).toBe(leaf.text);
      }
    });
  });

  it("enumerates leaves across the rows of an anchor-plus-rows item", async () => {
    await withPage("/fixtures/hackernews.html", async (page) => {
      const { groups } = await getCandidates(page);
      const rows = groups.find((g) => g.anchorPlusRows)!;
      const within = rows.anchorPlusRows!.anchorSelector;
      const item = await getCandidates(page, { within, itemIndex: 0, span: rows.anchorPlusRows!.span });
      const points = item.leaves.find((l) => l.text === "12 points");
      expect(points).toBeDefined();
      expect(points!.path.startsWith("+1/")).toBe(true);
      const title = item.leaves.find((l) => l.text === "Show HN: A self-healing scraper compiler");
      expect(title).toBeDefined();
      expect(await resolveLeaf(page, { selector: points!.selector, within, itemIndex: 0, span: 3 })).toBe("12 points");
      expect(await resolveLeaf(page, { selector: points!.selector, within, itemIndex: 5, span: 3 })).toMatch(/^\d+ points$/);
    });
  });
});

describe("leaf candidates (KTD5, KTD6)", () => {
  it("v1 product page yields name, laboratory, price and stock leaves with shapes and labels", async () => {
    await withPage("/demo/pharmacy-v1/producto/paracetamol-500-mg.html", async (page) => {
      const { leaves } = await getCandidates(page);
      const name = byText(leaves, "Paracetamol 500 mg x 16 comprimidos");
      const lab = byText(leaves, "Laboratorio Chile");
      const price = byText(leaves, "$ 2.490");
      const stock = byText(leaves, "Disponible");
      expect(name).toMatchObject({ shape: "text", selector: "h1.producto-nombre" });
      expect(lab).toMatchObject({ shape: "text", label: "Laboratorio:" });
      expect(price).toMatchObject({ shape: "money", label: "Precio" });
      expect(stock).toMatchObject({ shape: "text", label: "Stock:" });
      expect(price!.path).toBe("main/article.producto/div.producto-precio/span.precio");
      // main content is enumerated before header/footer noise
      const footerIndex = leaves.findIndex((l) => l.text.startsWith("Despacho a todo Chile"));
      expect(footerIndex).toBeGreaterThan(leaves.indexOf(stock!));
    });
  });

  it("v2 product pages yield the same fields plus the Sin stock and Precio oferta leaves", async () => {
    await withPage("/demo/pharmacy-v2/producto/atorvastatina-20-mg.html", async (page) => {
      const { leaves } = await getCandidates(page);
      expect(byText(leaves, "Atorvastatina 20 mg x 30 comprimidos")).toMatchObject({ shape: "text", selector: "h1" });
      expect(byText(leaves, "Abbott")).toMatchObject({ shape: "text", label: "Laboratorio:" });
      expect(byText(leaves, "Disponible")).toMatchObject({ shape: "text", label: "Stock:" });
      expect(byText(leaves, "$ 10.390")).toMatchObject({ shape: "money", label: "Precio oferta" });
      expect(byText(leaves, "$ 12.990")).toMatchObject({ shape: "money", label: "Precio normal" });
      expect(byText(leaves, "Precio oferta")).toBeDefined();
      // a month abbreviation inside a word ("Dic..." in Diclofenaco) is not a date, and a price is never a label
      expect(byText(leaves, "Diclofenaco 1% gel 60 g")).toMatchObject({ shape: "text" });
      expect(byText(leaves, "Precio normal")).toMatchObject({ label: "" });
      for (const leaf of leaves) expect(leaf.selector, leaf.path).not.toMatch(/prc-|ttl-|lbl-|compra-4b2e91f/);
    });
    await withPage("/demo/pharmacy-v2/producto/ibuprofeno-400-mg.html", async (page) => {
      const { leaves } = await getCandidates(page);
      expect(byText(leaves, "Sin stock")).toMatchObject({ shape: "text" });
      expect(byText(leaves, "Agotado")).toMatchObject({ label: "Stock:" });
      // no price in the purchase block of a product without stock
      expect(leaves.filter((l) => l.shape === "money" && l.path.startsWith("main/article/aside"))).toEqual([]);
    });
  });

  it("proposed selectors resolve with querySelector to the same element", async () => {
    for (const url of ["/demo/pharmacy-v1/producto/omeprazol-20-mg.html", "/demo/pharmacy-v2/producto/omeprazol-20-mg.html", "/fixtures/hackernews.html"]) {
      await withPage(url, async (page) => {
        const { leaves } = await getCandidates(page);
        expect(leaves.length).toBeGreaterThan(5);
        const mismatches: string[] = [];
        for (const leaf of leaves) {
          const resolved = await resolveLeaf(page, { selector: leaf.selector, attr: leaf.attr });
          if (resolved !== leaf.text) mismatches.push(`${leaf.path} via ${leaf.selector}: ${JSON.stringify(resolved)} != ${JSON.stringify(leaf.text)}`);
        }
        expect(mismatches).toEqual([]);
      });
    }
  });

  it("drops hashed class names from proposals and falls back to :nth-of-type last", async () => {
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent(`<main>
        <div class="css-1x2y3z sc-abc123 _x9f8a card"><span class="sc-9d8e7f">alpha</span><span class="price-3f9a1c">beta</span></div>
        <div class="css-1x2y3z sc-abc123 _x9f8a card"><span class="sc-9d8e7f">gamma</span><span class="price-3f9a1c">delta</span></div>
      </main>`);
      const { leaves } = await getCandidates(page);
      const alpha = byText(leaves, "alpha")!;
      const delta = byText(leaves, "delta")!;
      expect(alpha.selector).not.toMatch(/css-|sc-|_x9f8a|price-3f9a1c/);
      expect(alpha.selector).toContain("div.card");
      expect(alpha.selector).toContain(":nth-of-type(1)");
      expect(delta.selector).toContain(":nth-of-type(2)");
      expect(await resolveLeaf(page, { selector: alpha.selector })).toBe("alpha");
      expect(await resolveLeaf(page, { selector: delta.selector })).toBe("delta");
    });
  });
});

describe("link candidates", () => {
  it("many-links returns at most the cap, nearest to the top group first", async () => {
    await withPage("/fixtures/many-links.html", async (page) => {
      const { groups, links } = await getCandidates(page);
      expect(groups[0]!.itemCount).toBe(10);
      expect(links.length).toBeLessThanOrEqual(DEFAULT_CAPS.maxLinks);
      expect(links.length).toBe(DEFAULT_CAPS.maxLinks);
      const firstTag = links.findIndex((l) => l.text.startsWith("tag"));
      const next = links.findIndex((l) => l.text === "Next");
      const item1 = links.findIndex((l) => l.text === "Item 1");
      expect(item1).toBeGreaterThanOrEqual(0);
      expect(next).toBeGreaterThan(item1);
      expect(next).toBeLessThan(firstTag);
      expect(links.every((l) => l.href.startsWith(server.baseUrl))).toBe(true);
    });
  });

  it("off-domain anchors are not link candidates but keep their href leaf", async () => {
    await withPage("/fixtures/hackernews.html", async (page) => {
      const { links, leaves } = await getCandidates(page);
      expect(links.some((l) => new URL(l.href).hostname === "example.org")).toBe(false);
      expect(links.some((l) => l.text === "More")).toBe(true);
      expect(leaves.some((l) => l.attr === "href" && l.text.includes("example.org"))).toBe(true);
      // links without a name are useless to a chooser; repeated per-item links collapse into one entry with a count
      expect(links.every((l) => l.text.length > 0)).toBe(true);
      const comments = links.filter((l) => /^\d+ comments$/.test(l.text));
      expect(comments).toHaveLength(1);
      expect(comments[0]!.count).toBe(30);
      expect(links.find((l) => l.text === "More")!.count).toBe(1);
    });
  });
});

describe("controls (R24, R38)", () => {
  it("enumerates custom pointer targets with policy filtering and a replayable code-generated locator", async () => {
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent(`<style>.options > div { cursor:pointer }</style><div class="options">
        <div data-tag="python" onclick="this.dataset.clicked='yes'">🐍 Python</div>
        <div style="cursor:cell">JavaScript</div><div>Delete account</div><div aria-disabled="true">Unavailable</div>
        </div><div style="cursor:pointer;display:none">Hidden</div><div>Ordinary text</div>
        <button style="cursor:pointer"><span>Native control</span></button>`);
      const controls = await getControls(page, { profile: "store" });
      const python = controls.find((c) => c.name === "🐍 Python");
      expect(python).toMatchObject({ role: "button", tag: "div", clickable: true });
      expect(controls.find((c) => c.name === "JavaScript")).toMatchObject({ role: "button", clickable: true });
      expect(controls.find((c) => c.name === "Delete account")).toBeUndefined();
      expect(controls.find((c) => c.name === "Ordinary text")).toBeUndefined();
      expect(controls.find((c) => c.name === "Hidden")).toBeUndefined();
      expect(controls.filter((c) => c.name === "Native control")).toHaveLength(1);
      expect(controls.find((c) => c.name === "Unavailable")).toMatchObject({ disabled: true, clickable: false });
      const step = recordStep({ op: "click", control: python!, controls });
      const css = step.alternatives[0]!.css;
      expect(css).toBeTruthy();
      expect(await page.locator(css!).count()).toBe(1);
      await page.locator(css!).click();
      expect(await page.locator(css!).getAttribute("data-clicked")).toBe("yes");
    });
  });

  it("keeps viewport controls beyond the DOM cap without scrolling through offscreen links", async () => {
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent(`<main>${Array.from({ length: 200 }, (_, i) => `<a style="display:block;height:40px" href="/job/${i}">Job ${i}</a>`).join("")}</main>
        <div style="position:fixed;inset:0;background:white"><button id="close-popup">Close popup</button><input aria-label="Search jobs"></div>`);
      await page.evaluate(() => {
        const state = window as unknown as { scrollCalls: number };
        state.scrollCalls = 0;
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (options) { state.scrollCalls++; original.call(this, options); };
      });
      const controls = await getControls(page, { profile: "store", maxControls: 5 });
      expect(controls).toHaveLength(5);
      expect(controls.find((c) => c.name === "Close popup")).toMatchObject({ clickable: true });
      expect(controls.find((c) => c.name === "Search jobs")).toMatchObject({ clickable: true });
      expect(await page.evaluate(() => (window as unknown as { scrollCalls: number }).scrollCalls)).toBe(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const again = await getControls(page, { profile: "store", maxControls: 5 });
      expect(again.map((c) => c.id)).toEqual(controls.map((c) => c.id));
    });
  });

  it("marks a button under the cookie overlay as not clickable and the accept button as clickable", async () => {
    await withPage("/fixtures/cookie-banner.html", async (page) => {
      const controls = await getControls(page, { profile: "store" });
      const loadMore = controls.find((c) => c.name === "Load more");
      const accept = controls.find((c) => c.name === "Accept all");
      expect(loadMore).toMatchObject({ role: "button", visible: true, clickable: false });
      expect(accept).toMatchObject({ role: "button", visible: true, clickable: true });
      expect(accept!.scope).toContain("We value your privacy");
      await page.click("#xk-accept");
      const after = await getControls(page, { profile: "store" });
      expect(after.find((c) => c.name === "Load more")).toMatchObject({ clickable: true });
      expect(after.find((c) => c.name === "Accept all")).toBeUndefined();
    });
  });

  it("delete-account: store drops the deny-listed button and the POST submit; local keeps only the submit", async () => {
    await withPage("/fixtures/delete-account.html", async (page) => {
      const store = await getControls(page, { profile: "store" });
      expect(store.find((c) => c.name === "Delete account")).toBeUndefined();
      expect(store.find((c) => c.name === "Show all jobs")).toBeUndefined();
      expect(store.find((c) => c.name === "Browse all jobs")).toMatchObject({ role: "link" });
      const local = await getControls(page, { profile: "local" });
      expect(local.find((c) => c.name === "Delete account")).toBeUndefined();
      expect(local.find((c) => c.name === "Show all jobs")).toMatchObject({
        role: "button",
        form: { method: "post", hasTypedText: false, hasPasswordField: false, hasPaymentField: false },
      });
      const allowed = await getControls(page, { profile: "local", allowMutations: ["delete"] });
      expect(allowed.find((c) => c.name === "Delete account")).toMatchObject({ role: "button" });
      const storeAllowed = await getControls(page, { profile: "store", allowMutations: ["delete"] });
      expect(storeAllowed.find((c) => c.name === "Delete account")).toBeUndefined();
    });
  });

  it("the password input appears only as a secret-capable target; file and hidden inputs never appear", async () => {
    await withPage("/login/", async (page) => {
      const controls = await getControls(page, { profile: "local" });
      const passwords = controls.filter((c) => c.inputType === "password");
      expect(passwords).toHaveLength(1);
      expect(passwords[0]).toMatchObject({ secretCapable: true, name: "Password", value: "" });
      expect(controls.filter((c) => c.secretCapable)).toHaveLength(1);
      expect(controls.some((c) => c.inputType === "hidden")).toBe(false);
      expect(controls.find((c) => c.name === "Email")).toMatchObject({ role: "textbox", secretCapable: false, autocomplete: "username" });
      const submit = controls.find((c) => c.name === "Log in");
      expect(submit).toMatchObject({ role: "button", form: { method: "post", hasPasswordField: true } });
      // store: a POST submit on a password form is never offered
      const store = await getControls(page, { profile: "store" });
      expect(store.find((c) => c.name === "Log in")).toBeUndefined();
      await page.fill("#password", "hunter2");
      const typed = await getControls(page, { profile: "local" });
      expect(typed.find((c) => c.inputType === "password")!.value).toBe("");
      expect(serializeControls(typed)).not.toContain("hunter2");
    });
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent(`<form method="post" action="/x"><input type="file" name="f"><input type="hidden" name="h" value="1"><input type="text" name="cc-number"><input name="cardnumber"><input type="text" name="q"><button>Send it</button><button>Go</button></form>`);
      const controls = await getControls(page, { profile: "local" });
      expect(controls.map((c) => c.nameAttr ?? c.name)).toEqual(["q"]);
    });
  });

  it("hasTypedText reflects text typed in this run and unlocks a store POST submit", async () => {
    await withPage("/fixtures/search-form.html", async (page) => {
      await page.setContent(`<form method="post" action="/search"><input type="text" name="q" aria-label="Query"><button type="submit">Search</button></form>`);
      expect((await getControls(page, { profile: "store" })).find((c) => c.name === "Search")).toBeUndefined();
      await page.fill("input[name=q]", "python");
      const after = await getControls(page, { profile: "store" });
      expect(after.find((c) => c.name === "Search")).toMatchObject({ form: { hasTypedText: true } });
      expect(after.find((c) => c.name === "Query")).toMatchObject({ value: "python" });
    });
  });

  it("the deny list in snapshot.inject.js equals DENY_LIST from policy.ts", () => {
    expect([...SNAPSHOT_DENY_LIST]).toEqual([...DENY_LIST]);
  });
});

describe("chooser budget", () => {
  it("serialized state for every fixture stays under SNAPSHOT_BUDGET_CHARS", async () => {
    const sizes: Array<[string, number, number]> = [];
    for (const url of FIXTURES) {
      await withPage(url, async (page) => {
        const candidates = await getCandidates(page);
        const controls = await getControls(page, { profile: "local" });
        expect(candidates.groups.length).toBeLessThanOrEqual(DEFAULT_CAPS.maxGroups);
        expect(candidates.leaves.length).toBeLessThanOrEqual(DEFAULT_CAPS.maxLeaves);
        expect(candidates.links.length).toBeLessThanOrEqual(DEFAULT_CAPS.maxLinks);
        expect(controls.length).toBeLessThanOrEqual(DEFAULT_CAPS.maxControls);
        // serializers throw over budget; the largest fixture must stay under it
        const candidateText = serializeForChooser(candidates);
        const controlText = serializeControls(controls);
        sizes.push([url, candidateText.length, controlText.length]);
        expect(candidateText.length, url).toBeLessThan(SNAPSHOT_BUDGET_CHARS);
        expect(controlText.length, url).toBeLessThan(SNAPSHOT_BUDGET_CHARS);
      });
    }
    sizes.sort((a, b) => Math.max(b[1], b[2]) - Math.max(a[1], a[2]));
    const [url, candidateChars, controlChars] = sizes[0]!;
    console.log(`largest serialized state: ${url} candidates=${candidateChars} controls=${controlChars} chars (budget ${SNAPSHOT_BUDGET_CHARS})`);
    expect(Math.max(candidateChars, controlChars)).toBeLessThan(SNAPSHOT_BUDGET_CHARS);
  });

  it("serializeForChooser throws when a snapshot exceeds the budget", () => {
    const huge: Candidates = {
      groups: [],
      leaves: Array.from({ length: 400 }, (_, i) => ({ id: `l${i}`, path: "p".repeat(60), selector: "x", text: "t".repeat(100), label: "", shape: "text" as const })),
      links: [],
    };
    expect(() => serializeForChooser(huge)).toThrow(/budget/);
  });
});

describe("fixture server", () => {
  it("switchDemo maps /demo/pharmacy to the selected version under the same URLs", async () => {
    const url = "/demo/pharmacy/producto/paracetamol-500-mg.html";
    server.switchDemo("v1");
    const v1 = await (await fetch(`${server.baseUrl}${url}`)).text();
    server.switchDemo("v2");
    const v2 = await (await fetch(`${server.baseUrl}${url}`)).text();
    server.switchDemo("v1");
    expect(v1).toContain("producto-precio");
    expect(v2).toContain("compra-4b2e91f");
    expect(v2).not.toContain("producto-precio");
    expect((await fetch(`${server.baseUrl}/fixtures/challenge.html`)).status).toBe(503);
    expect((await fetch(`${server.baseUrl}/fixtures/../package.json`)).status).toBe(404);
  });

  it("POST /login sets the session cookie and gates account.html", async () => {
    await withPage("/login/", async (page) => {
      await page.goto(`${server.baseUrl}/login/account.html`);
      expect(page.url()).toBe(`${server.baseUrl}/login/`);
      const empty = await fetch(`${server.baseUrl}/login`, { method: "POST", body: "email=a%40b.c&password=", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
      expect(empty.status).toBe(302);
      expect(empty.headers.get("location")).toBe("/login/?error=1");
      expect(empty.headers.get("set-cookie")).toBeNull();
      await page.fill("#email", "max@example.com");
      await page.fill("#password", "hunter2");
      await page.click("button[type=submit]");
      await page.waitForURL(/account\.html$/);
      expect(await page.textContent("h1")).toBe("Orders");
      const { groups } = await getCandidates(page);
      expect(groups[0]).toMatchObject({ itemSelector: "li.order", itemCount: 5 });
      const renamed = await (await fetch(`${server.baseUrl}/login/index-renamed.html`)).text();
      expect(renamed).toContain(">Sign in<");
    });
  });
});

describe("camoufox parity", () => {
  it("the demo product page yields the same candidate shape and ids under camoufox", async () => {
    let fox: LaunchedBrowser;
    try {
      fox = await launch({ browser: "camoufox", headed: false });
    } catch (error) {
      console.log(`camoufox parity skipped: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      return;
    }
    try {
      const url = "/demo/pharmacy-v1/producto/paracetamol-500-mg.html";
      const chromium = await withPage(url, (page) => getCandidates(page));
      const camoufox = await withPage(url, (page) => getCandidates(page), fox.context);
      const strip = (c: Candidates) => ({
        groups: c.groups.map(({ id, selector, itemSelector, itemCount }) => ({ id, selector, itemSelector, itemCount })),
        leaves: c.leaves.map(({ id, path, selector, attr, text, shape, label }) => ({ id, path, selector, attr, text, shape, label })),
        links: c.links.map(({ id, href, text }) => ({ id, href, text })),
      });
      expect(strip(camoufox)).toEqual(strip(chromium));
    } finally {
      await fox.close();
    }
  }, 120_000);
});
