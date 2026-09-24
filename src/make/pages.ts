import type { BrowserContext, Page } from "playwright";
import { captureJson } from "../browser/network-capture.js";
import { refuseRevalidation } from "../browser/guards.js";
import { launch, type LaunchedBrowser } from "../browser/launch.js";
import { visibleText } from "../heuristics/index.js";
import { dismissConsent } from "../prestep/consent.js";
import { extractPage, fieldTypesOf, type PageExtraction } from "../scraper/extract.js";
import type { CompiledScraper } from "../scraper/schema.js";
import { readingOf, type PageReading } from "../replay/determinism.js";
import type { BrowserName } from "../input/schema.js";
import type { Capture, Obstacle, PageResponse } from "../investigate/index.js";

/**
 * U11: the only part of the driver that opens anything.
 *
 * Everything else in `src/make/` is pure or file IO, which is deliberate:
 * `tests/make.test.ts` drives the whole pipeline with a synthetic `Pages`
 * implementation and never launches a browser. This file is the seam that
 * makes that possible, and it is also the file that cannot be unit-tested,
 * which is why it contains decisions and no logic.
 *
 * ## It is a transcription of the live smoke script, on purpose
 *
 * That script was the only thing that had ever driven the
 * cascade against real pages, and every line of its capture sequence was
 * bought by a failure:
 *
 *  - **`captureJson` rather than a hand-rolled `page.on("response")`.** The
 *    first version of the script pushed from inside an async handler and closed
 *    the page without draining it, so `products/detail` — the endpoint Store
 *    B's entire answer lives in — was still being parsed when the run moved
 *    on. The manuscript reported ten endpoints and none of them was the right
 *    one. `captureJson` has the drain (`settled()`); a second capture written
 *    here would be the same race a third time.
 *  - **`match: /./`.** `captureJson` was built for replay, where the endpoint
 *    is known. Discovery does not know it, and keeping everything is the whole
 *    point of tier 2.
 *  - **The consent click before the second settle.** On Store B it is the
 *    click that releases the product calls at all. (Re-measured 2026-09-23:
 *    the page now reaches its full 12,069 characters and calls
 *    `products/detail` on both engines with nothing clicked. The click stays
 *    anyway — the banner sits over the page, and an obstacle nobody recorded
 *    is an obstacle `reconcile.md` cannot cost.)
 *  - **Waiting for the render to stop growing rather than for a fixed three
 *    seconds.** Across nine runs of the fixed wait the verdict tracked exactly
 *    one thing: whether the page had finished rendering. 11,107 characters
 *    bound three fields, ~3,200 bound none — same tree, same endpoints — because
 *    tier 2 anchors candidate values against the rendered text and there was no
 *    text to anchor against. A gate that reports failure when the harness was
 *    impatient teaches you to ignore the gate.
 *  - **Consent is tried twice: once after the navigation, and once after the
 *    render settles.** `networkidle` is not the same moment on the two
 *    engines. On `store-b.example/.../884669.html`, `goto` resolved at 7,288 ms
 *    under Chromium — by which time the page was fully rendered and the
 *    "Aceptar" button had been on screen for a while — and at 2,253 ms under
 *    Camoufox, against a 2,470-byte shell with an empty `<title>` and no
 *    consent button anywhere in the DOM; that button first appeared at
 *    7,047 ms. So the single dismissal ran five seconds early on the default
 *    browser, clicked nothing, recorded no obstacle, and left the banner over
 *    the page for the whole visit, while `--browser chromium` clicked it and
 *    looked fine. The fix is a second look once there is something to look
 *    at, not a sleep before the first one.
 *  - **The render has stopped when the text has stopped growing *and* the page
 *    has stopped fetching for itself *and* both have held still for
 *    `SETTLE_STABLE_POLLS` rounds.** Two equal samples 750 ms apart are not
 *    evidence that a render finished; they are evidence that it paused. The
 *    same Camoufox run sat at 3,174 characters from 7.0 s to 9.4 s while it
 *    waited on `products/detail` and then jumped to 12,069, and the old rule
 *    returned in the middle of that pause: the capture carried 1,410
 *    characters of body text instead of 4,046, and tier 2 — which anchors
 *    every candidate against that text — dropped all five fields with "no
 *    captured leaf survived the filter". The payload counter is the part of
 *    this that is a signal rather than a clock: through that pause the page
 *    was still taking delivery (62 responses at 7.0 s, 104 at 9.4 s), which is
 *    a page mid-render saying so.
 *  - **A settle that runs out of budget hands back an unfinished measurement,
 *    not a short page.** The cap is the same 25 s either way, and what it costs
 *    depends entirely on what else the machine is doing: the same `navvi make`
 *    on the same URL rendered 11,190 characters and bound 3 of 5 alone, and
 *    3,219 characters with the consent banner still up and 0 of 5 while
 *    `npm test` ran beside it. The second transcript is indistinguishable from
 *    the site having changed unless the settle says which of the two it was, so
 *    it does: see `Settle`.
 *  - **A navigation that failed is not a page that was slow.** `goto` was
 *    called with `.catch(() => undefined)`, which is right about one thing —
 *    `networkidle` is a *condition*, and a site that never goes quiet fails it
 *    with a finished page on screen, which is a visit worth carrying on with —
 *    and wrong about the rest. A page that never loaded went on to be dismissed
 *    at, polled at and capped at, for the full budget, and came back as an
 *    empty capture: a third run indistinguishable from the first two. The
 *    navigation's own account is kept now, and the address bar says which of
 *    the two kinds of failure it was — a `goto` that rejects with `about:blank`
 *    still in it brought back nothing.
 *
 *  - **Every request goes out with its conditional headers removed.** The
 *    reused context has a reused HTTP cache, and a second visit to a URL
 *    revalidates rather than re-downloads: Store B answered `304` to the
 *    4th, 7th and 10th visits of one session, the page rendered from the
 *    browser's copy, and the capture — which can only see bodies that cross
 *    the network — had nothing to bind. `refuseRevalidation` says what that
 *    cost and why it cannot be paid in `captureJson` instead.
 *
 * The one thing it does *not* copy is the consent selector. The script clicks
 * `Aceptar|Acepto|Entendido` by hand; this uses `prestep`'s `dismissConsent`,
 * which owns the consent rule table for the whole repository and hands back
 * every control it clicked — which is what turns a dismissed banner into an
 * `Obstacle` the manuscript and then `reconcile.md` can cost.
 */

/**
 * Chrome on macOS. The pharmacies serve a different page to an unrecognised agent.
 *
 * These two belong to `plainFetch` and are deliberately not handed to the
 * browser context. A launched browser already has a coherent identity, and
 * Camoufox's whole job is that its identity hangs together — announcing Chrome
 * on macOS from a Firefox engine is the contradiction fingerprinting looks
 * for. Measured 2026-09-23 on `store-b.example`: Camoufox introduced itself as
 * Firefox 152 on Windows with `navigator.language` of `en-US` and was served
 * the same page as Chromium, down to the character — 12,069 of rendered text,
 * the same title, the same `products/detail` payload. The pharmacy cares what
 * a bare HTTP client looks like, not what a real browser claims.
 */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const LOCALE = "es-CL";

/** How long one visit's settling may take in total, across both passes, before the run reads the page anyway. */
export const SETTLE_CAP_MS = 25_000;
/** Gap between two readings of the render. */
export const SETTLE_POLL_MS = 750;
/**
 * Consecutive unchanged readings that count as "finished" rather than "paused".
 * Three of them is 2.25 s of quiet, against the 2.4 s Store B spends waiting
 * on `products/detail` with a half-drawn page on screen. See the header.
 */
export const SETTLE_STABLE_POLLS = 3;
/**
 * The least any one settle may be given, whatever the visit has left of its cap.
 *
 * Enough polls to observe stability once: a settle that cannot do that is not a
 * settle, it is a read. It matters after the late consent click, because the
 * click is a change the run made itself and a page that has just lost its
 * overlay re-lays-out around the hole. One Camoufox capture under load came
 * back with 4,039 characters and its neighbour with zero — same click, same
 * captured `products/detail`, the difference being that the first settle had
 * eaten the whole 25 s and the second pass was allowed no polls at all.
 */
export const SETTLE_FLOOR_MS = SETTLE_POLL_MS * (SETTLE_STABLE_POLLS + 1);
/** How many payloads one page may contribute. Tier 2 narrows them; it does not need all of them. */
export const CAPTURE_LIMIT = 200;

/**
 * What the driver needs a page for. Three verbs, one per stage that reads the
 * web: `fetch` for the sample probes and tier 1, `capture` for tier 2, and
 * `read` for the determinism replays and the verify replay.
 *
 * An interface rather than a class so the tests can answer all three from
 * fixtures, and so `--offline` can refuse to build one at all rather than
 * building one that quietly answers nothing.
 */
export interface Pages {
  fetch(url: string): Promise<PageResponse>;
  capture(url: string): Promise<DrivenCapture>;
  /** One reading of one URL through a compiled scraper, exactly as a replay would take it. */
  read(scraper: CompiledScraper, url: string): Promise<PageReading>;
  /** The full extraction, for the verify stage's fill rate. */
  extract(scraper: CompiledScraper, url: string): Promise<PageExtraction>;
  close(): Promise<void>;
}

/**
 * A capture, and whether the render it was taken from ever finished.
 *
 * `Capture` is `investigate`'s vocabulary and says what was on the page;
 * `settle` says whether navvi stayed long enough to be reading the page rather
 * than a frame of it. It is a widening rather than a change to `Capture`
 * because the driver is the only thing that can know it — a capture imported
 * from a HAR has no settle to report — and because every existing consumer of
 * a `Capture` keeps compiling and keeps behaving identically.
 *
 * Two callers want it. Tier 2 anchors its candidates against `text`, so a
 * capped `text` is what turns a busy machine into "no captured leaf survived
 * the filter"; and the canary is fingerprinted off `html`, so a capped `html`
 * is a false "the site changed" filed against every replay from here on.
 * Neither reads it yet: both live in `src/investigate/`, and the line that
 * carries an unfinished measurement into the manuscript is an `Obstacle` kind
 * that does not exist there yet.
 */
export interface DrivenCapture extends Capture {
  settle: Settle;
}

export interface PagesOptions {
  browser: BrowserName;
  headed: boolean;
  storageDir: string;
  /** Injectable so a test can answer a plain fetch without a network. */
  fetchImpl?: typeof fetch | undefined;
  settleCapMs?: number | undefined;
}

/**
 * One plain HTTP request, read into the shape `probeFrom` and tier 1 consume.
 *
 * A probe that never answered comes back `status: 0` rather than throwing.
 * `classify` reads 0 as transient and excludes the URL from the sample, which
 * is the right answer: one silent fetch is not evidence the catalogue lost the
 * URL, and letting the exception out would end an investigation because one of
 * 108 URLs timed out.
 */
export async function plainFetch(url: string, fetchImpl: typeof fetch = fetch): Promise<PageResponse> {
  try {
    const res = await fetchImpl(url, { headers: { "user-agent": UA, "accept-language": `${LOCALE},es;q=0.9` }, redirect: "follow" });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
    return { url: res.url, status: res.status, headers, body: await res.text() };
  } catch {
    return { url, status: 0, body: "" };
  }
}

/**
 * What one settle watched: the two readings, where each of them started and
 * where each of them was when the watching stopped.
 *
 * Both trends are here because both are what "the page is still going" looks
 * like, and they do not always move together: the Camoufox plateau in the
 * header held the text at 3,174 characters while the payload count went 62 to
 * 104, and a capture taken during a consent re-layout is the mirror image.
 */
export interface SettleTrend {
  /** Characters of rendered visible text at the first poll, and at the last. */
  textFrom: number;
  text: number;
  /** Payloads the page had taken delivery of at the first poll, and at the last. */
  payloadsFrom: number;
  payloads: number;
  /** Polls taken, how many of them read something other than the poll before, and the wall clock they cost. */
  polls: number;
  changed: number;
  /** For a settle, what the polls cost. For a navigation that never arrived, what the navigation cost. */
  ms: number;
  /**
   * What the navigation said, when it said anything.
   *
   * Present whenever `page.goto` rejected — which is not the same as the page
   * not being there. `waitUntil: "networkidle"` is a condition, and a site that
   * never goes quiet fails it with a fully rendered page on screen; that is a
   * run the settle below should and does carry on with. So this is evidence
   * attached to whatever outcome the render then reached, rather than an
   * outcome of its own — except when nothing arrived at all, which is
   * `unreachable`.
   */
  arrival?: string | undefined;
}

/**
 * How a settle ended.
 *
 * This is a union and not a number with a flag beside it because the two are
 * not the same kind of fact. `quiesced` is a measurement: the page stopped, and
 * what the capture holds is the page. `capped` is the *absence* of one: the
 * budget ran out with the render still in flight, and what the capture holds is
 * as far as navvi got. Returning the second dressed as the first is the defect
 * this type exists to make unrepresentable — on 2026-09-23 a `navvi make` taken
 * while the test suite was running captured 3,219 characters of an 11,190
 * character page, bound 0 of 5 with "no captured leaf survived the filter", and
 * read exactly like a site that had changed under us. The same run alone bound
 * 3 of 5. A harness that reports a site regression when it was merely busy is
 * the failure the live smoke script's own header warns about, one layer
 * out.
 *
 * `unreachable` is the third of them and it was swallowed for longer than the
 * other two: `goto(...).catch(() => undefined)` threw the navigation's own
 * account away, so a page that never loaded went on to be watched, polled and
 * capped exactly like a page that loaded slowly, and both arrived at the
 * transcript looking like the third thing again — a site that had changed. One
 * `catch` conflated all three.
 *
 * `because` hangs off the two failing arms, so no caller can print the excuse
 * without having first asked whether there is one.
 */
export type Settle =
  | (SettleTrend & { outcome: "quiesced" })
  | (SettleTrend & { outcome: "capped"; because: string })
  | (SettleTrend & { outcome: "unreachable"; because: string });

/**
 * The sentence a capped settle carries: what was still moving when the budget
 * ran out, in the numbers that were measured rather than in an adjective.
 *
 * A render that put nothing on the page gets its own sentence, because it is a
 * different thing to have happened and because the loop below cannot report it
 * any other way: an empty reading is never counted as stable — a page with no
 * text on it has not finished arriving, whatever the DOM is doing — so a page
 * that stays empty burns the whole budget and arrives here with two flat
 * trends and nothing that moved.
 */
function whyUnsettled(trend: SettleTrend): string {
  const clock = `${(trend.ms / 1000).toFixed(1)} s and ${trend.polls} poll${trend.polls === 1 ? "" : "s"}`;
  const navigation = trend.arrival === undefined ? "" : `; the navigation had already said "${trend.arrival}"`;
  if (trend.text === 0) return `the render never put a visible character on the page in ${clock}; there is nothing here that could have settled${navigation}`;
  return (
    `the render never held still for ${SETTLE_STABLE_POLLS} consecutive polls in ${clock}: ` +
    `${trend.changed} of them read something new, text ${trend.textFrom} -> ${trend.text} characters, payloads ${trend.payloadsFrom} -> ${trend.payloads}${navigation}`
  );
}

/**
 * Where a page starts before anything has been navigated to, and where it stays
 * when the navigation fails outright. A `goto` that rejects with this still in
 * the address bar brought back nothing at all; one that rejects with the target
 * there timed out on its wait condition over a page that exists.
 */
const NOWHERE = "about:blank";

/**
 * The navigation, kept rather than swallowed: the first line of what Playwright
 * said, which is the part that names the failure (`net::ERR_NAME_NOT_RESOLVED`,
 * `Timeout 60000ms exceeded`) before the call log that follows it.
 */
async function arriveAt(page: Page, url: string): Promise<string | undefined> {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    return undefined;
  } catch (error: unknown) {
    const said = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.trim();
    return said === undefined || said === "" ? "the navigation failed without saying why" : said;
  }
}

/**
 * Waits until the page stops changing, or until `deadline`, and says which of
 * those two happened.
 *
 * "Stops changing" is two readings, not one: the visible text, and how many
 * payloads the page has taken delivery of so far. A page that is between its
 * own API calls has a still DOM and is not finished, and telling that apart
 * from a page that is finished is the whole job here — see the header for the
 * run where getting it wrong cost every field on the page.
 *
 * It used to answer with the text length and nothing else, and both call sites
 * threw it away — the shape the `Settle` header argues against, in the file
 * that invented it.
 */
async function settleRender(page: Page, deadline: number, payloads: () => number, arrival?: string | undefined): Promise<Settle> {
  const startedAt = Date.now();
  let previousText = -1;
  let previousPayloads = -1;
  let firstText = -1;
  let firstPayloads = -1;
  let unchanged = 0;
  let polls = 0;
  let changed = 0;
  for (;;) {
    const current = visibleText(await page.content().catch(() => "")).length;
    const delivered = payloads();
    polls += 1;
    if (firstText < 0) {
      firstText = current;
      firstPayloads = delivered;
    } else if (current !== previousText || delivered !== previousPayloads) {
      changed += 1;
    }
    const trend: SettleTrend = {
      textFrom: firstText,
      text: current,
      payloadsFrom: firstPayloads,
      payloads: delivered,
      polls,
      changed,
      ms: Date.now() - startedAt,
      ...(arrival === undefined ? {} : { arrival }),
    };
    if (current > 0 && current === previousText && delivered === previousPayloads) {
      if (++unchanged >= SETTLE_STABLE_POLLS) return { outcome: "quiesced", ...trend };
    } else {
      unchanged = 0;
    }
    if (Date.now() > deadline) return { outcome: "capped", ...trend, because: whyUnsettled(trend) };
    previousText = current;
    previousPayloads = delivered;
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
}

/**
 * Opens a browser and returns the three verbs over it.
 *
 * The context is reused across every URL, which is what makes a consent click
 * on the first page save the click on the rest — and, for the determinism
 * stage, what makes round two of three a real re-navigation of a site that
 * already knows this session rather than a cold first visit.
 */
export async function openPages(options: PagesOptions): Promise<Pages> {
  const settleCap = options.settleCapMs ?? SETTLE_CAP_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let browser: LaunchedBrowser | null = null;

  const context = async (): Promise<BrowserContext> => {
    browser ??= await launch({ browser: options.browser, headed: options.headed, storageDir: options.storageDir });
    return browser.context;
  };

  /**
   * One pass of the consent rules, recording every control it clicked as an
   * `Obstacle`. Answers whether anything was clicked, because a banner that
   * has just been dismissed is a page that is about to change again.
   */
  const dismiss = async (page: Page, url: string, obstacles: Obstacle[]): Promise<boolean> => {
    const consent = await dismissConsent(page);
    for (const click of consent.clicked) {
      obstacles.push({
        kind: "consent",
        url,
        because: `a consent dialog stood between the navigation and the page; navvi clicked ${click.role} "${click.name}"`,
        evidence: click.name,
        blocking: false,
      });
    }
    return consent.clicked.length > 0;
  };

  /** Navigate, dismiss consent, let the render settle, hand back the page, what it fetched, and how the settling ended. */
  const visit = async <T>(url: string, use: (page: Page, captured: ReturnType<typeof captureJson>, obstacles: Obstacle[], settle: Settle) => Promise<T>): Promise<T> => {
    const page = await (await context()).newPage();
    const obstacles: Obstacle[] = [];
    try {
      await refuseRevalidation(page);
      const captured = captureJson(page, { match: /./, limit: CAPTURE_LIMIT });
      // One budget for the whole visit rather than one per settle, so a second
      // pass cannot double what a page is allowed to cost.
      const deadline = Date.now() + settleCap;
      const delivered = () => captured.responses.length;
      const startedAt = Date.now();
      const arrival = await arriveAt(page, url);
      let settle: Settle;
      if (arrival !== undefined && page.url() === NOWHERE) {
        // Nothing arrived, so there is nothing to watch arriving. Polling a
        // blank page for 25 s produces an empty capture, which is the reading
        // that gets filed as "the site stopped answering" — and spending the
        // budget to produce it makes every later URL in the run poorer as well.
        settle = { outcome: "unreachable", because: arrival, textFrom: 0, text: 0, payloadsFrom: 0, payloads: 0, polls: 0, changed: 0, ms: Date.now() - startedAt, arrival };
      } else {
        await dismiss(page, url, obstacles);
        await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
        settle = await settleRender(page, deadline, delivered, arrival);
        // The banner the first pass was too early for. Under Camoufox this is
        // the one that clicks; under Chromium it finds the page already clear
        // and costs one evaluate. See the header.
        if (await dismiss(page, url, obstacles)) {
          const second = await settleRender(page, Math.max(deadline, Date.now() + SETTLE_FLOOR_MS), delivered, arrival);
          // A visit is only as finished as its least finished pass, and the
          // first one is kept when it capped: the second pass is granted the
          // floor out of an exhausted budget, so its quiescence is a statement
          // about the 3 s after a click and not about the render the first
          // pass abandoned.
          if (settle.outcome === "quiesced") settle = second;
        }
      }
      // An unfinished measurement is a thing that stood between navvi and the
      // page, so it goes where every other one goes: the manuscript records it,
      // `reconcile.md` costs it, and a thin run stops reading as a site that
      // changed.
      if (settle.outcome !== "quiesced") {
        obstacles.push({ kind: "unsettled", url, because: settle.because, evidence: `${settle.text} characters, ${settle.payloads} payloads, ${settle.polls} polls`, blocking: false });
      }
      await captured.settled();
      return await use(page, captured, obstacles, settle);
    } finally {
      await page.close().catch(() => undefined);
    }
  };

  return {
    fetch: (url) => plainFetch(url, fetchImpl),

    capture: (url) =>
      visit(url, async (page, captured, obstacles, settle) => {
        const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        const html = await page.content().catch(() => "");
        return { responses: captured.responses, text, html, obstacles, settle };
      }),

    read: async (scraper, url) => readingOf(await readPage(scraper, url), fieldTypesOf(scraper)),

    extract: (scraper, url) => readPage(scraper, url),

    async close() {
      await browser?.close().catch(() => undefined);
      browser = null;
    },
  };

  /**
   * One reading, through the compiled scraper and with the payloads the page
   * fetched for itself.
   *
   * `captured` is not optional decoration: every `network` alternative
   * `compileFromReconciliation` emits resolves against it, so a read taken
   * without it reports every payload-bound field as null — a clean artifact
   * about a scraper nobody actually ran.
   *
   * That sentence used to end "and the determinism stage would call that
   * `absent` rather than `moved`", and the second half of it was wrong in a way
   * worth keeping the correction for. `extractPage` null-fills every compiled
   * field on every page, so `field in item` is true whatever came back and
   * `FieldStability.absent` is unreachable from here. A replay that reads
   * nothing is `held` on every field, `0 fields moved`, verdict `stable`. On
   * 2026-09-23 that printed four lines above `verify fill 0 of 3` and read as
   * two stages disagreeing about the same three pages through this same
   * function; they were agreeing, and only `verify` could say what about.
   * `make.ts` counts the readings at the seam it hands `measureDeterminism`
   * for that reason.
   *
   * A read that throws is not caught. `DeterminismDriver` says so in as many
   * words: a URL that could not be read N times has not been measured, and a
   * stage that swallows load failures reports `stable` about pages it never
   * saw.
   */
  async function readPage(scraper: CompiledScraper, url: string): Promise<PageExtraction> {
    return visit(url, (page, captured) => extractPage(page, scraper, { sourceUrl: url, captured: captured.responses }));
  }
}
