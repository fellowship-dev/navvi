import { challengeHeader, decisiveSourceMarker, readChallenge, titleOf, widgetSourceMarker } from "../blocked/challenge.js";
import { bank, type Bank, type Verdict } from "../heuristics/index.js";
import { declaresProduct, visibleText } from "../heuristics/index.js";
import { normalize } from "../util/text.js";
import type { Canary } from "../scraper/schema.js";

/**
 * U3a and U3b: is the run broken, or is the site refusing you?
 *
 * On 2026-09-22 those two were indistinguishable and it cost a full day.
 * Store C came back `sku 0/111, stock 0/111, prices 3/111` and **"¡Lo
 * sentimos!" as the product name** — its error page, served to Apify's
 * datacenter IPs. The same URLs read perfectly from a laptop. The *legacy*
 * scraper carries the same no-proxy config and fails on 71 of 114 URLs, so a
 * store that has looked "drifted" for months may only ever have been blocking
 * the datacenter it is scraped from.
 *
 * Why this file exists next to `src/prestep/blocked.ts` rather than inside it:
 * prestep answers a question about **one live `Page`** (`page.evaluate`, a
 * browser, a DOM) and splits a bot challenge from a login wall before
 * navigation continues. This module answers a question about **a finished run**
 * — many responses, fill counts, and a canary — offline, from text and numbers,
 * with no browser anywhere. A `--har` compile and a post-mortem over a stored
 * run both need the second and cannot have the first. What the two *do* share
 * is the challenge lexicon **and the decisive/corroboration split**, and both
 * now live in `src/blocked/challenge.ts` and are imported rather than restated
 * on either side. That module's note carries the encounter: prestep used to
 * fire on `status ∈ {403,429,503} && any captcha container`, so a store with
 * reCAPTCHA in its login modal and one rate-limited 403 was blocked there and
 * healthy here, on the same bytes. What is left below is only what a stored
 * response can say and a live page cannot — the apology shape over a corpus,
 * the canary, and the run's verdict.
 *
 * The one rule the whole module exists to protect: **healing must never fire on
 * a blocked page.** Recompiling against an error page is how a good scraper is
 * destroyed by its own repair mechanism, and it would have happened here — the
 * apology was 111/111 filled and would have been learned as the product name.
 * `RunVerdict` makes that structurally impossible: only the drift branch
 * carries `heal`, so there is no way to read a "heal" answer off a blocked one.
 *
 * The first live run of the cascade, later the same day, found the other edge
 * of that rule. Protecting healing this hard makes a false `blocked` the cheap
 * mistake to make, and it was made: three Store B shells read as three
 * Imperva interstitials, every tier skipped, nothing bound, on a store that was
 * answering. So there is now a fourth state — `DeferredVerdict` — for the one
 * thing this module could not previously say, which is *not from here*. A plain
 * fetch cannot tell a shell from a refusal; a render can, and `settleDeferred`
 * is where the second look is taken. Nothing binds against a deferred run
 * either, so the guarantee above is untouched.
 */

// ---------------------------------------------------------------- observations

/** One response as the transport saw it. No `Page`, no DOM: this has to work off a stored run. */
export interface PageResponse {
  url: string;
  /** Navigation status, when the caller kept it. */
  status?: number | undefined;
  /** Response headers, lower-cased keys. A block often announces itself here and nowhere else. */
  headers?: Readonly<Record<string, string>> | undefined;
  /** The response body as text. HTML for a page, anything for an endpoint. */
  body?: string | undefined;
}

export type BlockingSignalKind = "status" | "challenge" | "apology";

export interface BlockingSignal {
  kind: BlockingSignalKind;
  /** The URL it was read off, so a report can name the page rather than the run. */
  url: string;
  /** Why, in terms of the response. Goes into the report verbatim. */
  because: string;
  /** The status, marker or fingerprint that fired it. */
  evidence: string;
  /**
   * **This signal assumed the page was not a shell.**
   *
   * Set by every rule whose reading depends on the page being empty of its own
   * accord — the widget markers and the text lexicon below, which fire only on
   * "no declared product and almost no text", and the apology shape, whose
   * first conjunct is literally *it renders substantial text, it is not a
   * shell*. A shell satisfies those readings by construction, so on a URL
   * `shell-skips-tier-1` claims, the two rules contradict each other and this
   * one is the weaker: see `classifyRun`, which holds such a signal back as
   * corroboration and lets the render break the tie.
   *
   * Never set on a status, a challenge header, a challenge title or a decisive
   * `CHALLENGE_MARKERS` hit: those say something about the response rather than
   * about how little of it there is, and they stay decisive on their own.
   */
  corroborated?: true;
}

/**
 * A refusal, as opposed to an absence.
 *
 * 403 is the site saying no; `retry-transport-not-an-answer` already rules that
 * it is an answer and hands it here rather than retrying it. 429 is the awkward
 * one — that same rule retries a *single* 429 with backoff, and it is right to,
 * because one URL asking for a slower pace is not a block. So 429 earns a signal
 * here but the run-level threshold (`blockedShare`) is what turns a scattering
 * of them into a verdict. 503 is deliberately absent: prestep counts it because
 * it is looking at an interstitial that is on the screen, while over a run a 503
 * is a bad afternoon.
 */
export const BLOCKING_STATUSES: ReadonlySet<number> = new Set([403, 429]);

/**
 * Re-exported so `investigate`'s own callers keep their one import. The list
 * and the decisive/corroboration split it belongs to live in
 * `src/blocked/challenge.ts`, which prestep reads too.
 */
export { CHALLENGE_MARKERS } from "../blocked/challenge.js";


/** HTTP 403/429 — the site answering "no" rather than failing to answer. */
export function statusSignal(page: PageResponse): BlockingSignal | null {
  if (page.status === undefined || !BLOCKING_STATUSES.has(page.status)) return null;
  return {
    kind: "status",
    url: page.url,
    because: `HTTP ${page.status} is an answer: the site is refusing this request rather than failing to serve it`,
    evidence: `HTTP ${page.status}`,
  };
}

/**
 * A challenge interstitial: a marker in the source, a header, or challenge
 * wording in what little text there is.
 *
 * The order and the corroboration gate are not decided here — `readChallenge`
 * owns both, and prestep asks it the same question about a live page, so the
 * same bytes cannot be a challenge to one and furniture to the other. This
 * function's whole job is to say what a *stored response* can see: the headers
 * and the raw source, which is where a challenge page that never ran its
 * JavaScript keeps everything it has.
 */
export function challengeSignal(page: PageResponse): BlockingSignal | null {
  const body = page.body ?? "";
  const header = challengeHeader(page.headers);
  if (header === null && body === "") return null;

  const reading = readChallenge({
    title: titleOf(body),
    text: visibleText(body),
    declaresProduct: declaresProduct(body),
    decisive: header ?? decisiveSourceMarker(body),
    widget: widgetSourceMarker(body),
  });
  if (reading === null) return null;
  return { kind: "challenge", url: page.url, ...reading };
}

// ------------------------------------------------------------- apology shape

export interface ApologyOptions {
  /**
   * Below this many characters of visible text the page is a shell or an empty
   * error, which is a different diagnosis — `shell-skips-tier-1` owns it.
   */
  minTextChars?: number;
  /** How alike two pages' vocabularies have to be before they are one document. */
  similarity?: number;
  /** How many distinct URLs have to carry that document. One page repeating itself proves nothing. */
  minPages?: number;
}

const DEFAULT_MIN_TEXT_CHARS = 120;
const DEFAULT_SIMILARITY = 0.92;
const DEFAULT_MIN_PAGES = 2;

/**
 * Words of a page, as a set. Three characters and up, so articles and the
 * currency mark do not carry the comparison.
 */
function vocabulary(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3),
  );
}

/** Jaccard overlap of two vocabularies: 1 is the same document, 0 shares nothing. */
function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * The apology fingerprint — **a shape, never a phrase list.**
 *
 * `¡Lo sentimos!` is the example, not the rule. A list of apologetic Spanish
 * strings would have caught Store C on 2026-09-22 and nothing else: it fails on
 * the next store, the next locale, and the same store the week it rewords its
 * error page. So the rule is the invariant underneath, which is
 * language-independent and site-independent:
 *
 *   1. the page **renders substantial text** — it is not a shell and not an
 *      empty 500, both of which are already other diagnoses;
 *   2. it **declares no product** to a machine — no JSON-LD `Product`, no
 *      microdata, no `og:`/`product:` price. A page that declares a product is
 *      answering, whatever else it repeats;
 *   3. it is **the same document on different URLs**.
 *
 * (3) is the decisive one and the reason this function takes a corpus rather
 * than a page. A catalogue is per-product by construction: two product pages
 * differ because the products differ. An error page is one document served for
 * every URL you ask for. Store C's run is exactly that — 111 URLs, one page,
 * and its name field 111/111 filled with the apology, which is why a fill rate
 * alone called it healthy.
 *
 * The threshold is high (0.92) on purpose: two product pages off one template
 * share their whole furniture — nav, footer, "agregar al carro" — and what
 * separates them is the product. An error page has no product to differ by, so
 * it sits near 1.0 while siblings sit well below it. Conjunct (2) is the belt
 * to that braces: a template so thin that its products score above 0.92 is a
 * template whose products declare themselves.
 */
export function apologySignals(pages: readonly PageResponse[], options: ApologyOptions = {}): BlockingSignal[] {
  const minTextChars = options.minTextChars ?? DEFAULT_MIN_TEXT_CHARS;
  const threshold = options.similarity ?? DEFAULT_SIMILARITY;
  const minPages = options.minPages ?? DEFAULT_MIN_PAGES;

  const candidates = pages
    .filter((page) => page.body !== undefined && page.body !== "")
    .map((page) => ({ page, text: visibleText(page.body ?? "") }))
    .filter(({ page, text }) => text.length >= minTextChars && !declaresProduct(page.body ?? ""))
    .map((entry) => ({ ...entry, words: vocabulary(entry.text), key: normalize(entry.page.url) }));

  const out: BlockingSignal[] = [];
  for (const candidate of candidates) {
    // Same document, different address. Comparing a page against itself, or
    // against a second read of the same URL, would make one page a crowd.
    const twins = candidates.filter((other) => other.key !== candidate.key && similarity(candidate.words, other.words) >= threshold);
    const distinct = new Set(twins.map((twin) => twin.key)).size + 1;
    if (distinct < minPages) continue;
    out.push({
      kind: "apology",
      url: candidate.page.url,
      because: `${candidate.text.length} characters of text, no declared product, and the same document on ${distinct} different URLs: one page is being served for every address`,
      evidence: `${distinct} identical pages`,
      // Conjunct (1) is an assumption about the page, not an observation of the
      // site, and `minTextChars` is where it is asserted: 120 characters. A
      // shell with a cookie banner and an "enable JavaScript" line clears that
      // bar, and every shell in a catalogue is the same document on every URL
      // by construction — conjunct (3) for free. So an apology read off a page
      // `shell-skips-tier-1` claims is the same contradiction the challenge
      // markers produced on 2026-09-22, wearing a different coat, and it is
      // held back the same way rather than waiting to be found in the field.
      corroborated: true,
    });
  }
  return out;
}

/** Every blocking signal the run's responses carry, in page order. */
export function detectBlocking(pages: readonly PageResponse[], options: ApologyOptions = {}): BlockingSignal[] {
  const signals: BlockingSignal[] = [];
  for (const page of pages) {
    const status = statusSignal(page);
    if (status) signals.push(status);
    const challenge = challengeSignal(page);
    if (challenge) signals.push(challenge);
  }
  signals.push(...apologySignals(pages, options));
  return signals;
}

// -------------------------------------------------------------------- canary

/**
 * U3b. What was recorded at investigation about a page that definitely worked.
 *
 * Small and JSON-serialisable on purpose: this is committed next to the
 * scraper, read by a run months later, and diffed by a person. A few dozen
 * words and two numbers, not a stored page.
 *
 * The shape itself is `scraper/schema.ts`'s `Canary`, because that is where the
 * compiled scraper carries it and a scraper is vocabulary rather than a stage.
 * This name stays because it is the one this stage speaks in -- recording and
 * checking a fingerprint is what `blocked.ts` is for -- but there is one
 * definition, not two that a test has to keep equal.
 */
export type CanaryFingerprint = Canary;

const CANARY_WORDS = 24;

/** The fraction of recorded words that must still be present. Low on purpose — see `checkCanary`. */
const CANARY_OVERLAP = 0.4;

/** A canary page that collapses below this fraction of its recorded text is not the same page. */
const CANARY_TEXT_RATIO = 0.25;

export interface RecordCanaryOptions {
  /** How many words to keep. More is not better: this gets committed. */
  words?: number;
  /** For tests, and for recording against the run's own clock rather than the wall. */
  now?: Date;
}

/** Record a known-good page at investigation time. */
export function recordCanary(page: PageResponse & { body: string; status: number }, options: RecordCanaryOptions = {}): CanaryFingerprint {
  const text = visibleText(page.body);
  const counts = new Map<string, number>();
  for (const word of normalize(text).split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3) continue;
    // No bare numbers. A price is the least stable thing on a product page —
    // it is what the scraper is there to watch change — and a canary that
    // drops every time the store runs a promotion is a canary nobody trusts.
    // (`apologySignals` keeps digits, for the opposite reason: there, the
    // product's numbers are what separates two sibling pages.)
    if (/^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const words = [...counts.entries()]
    // Frequency first, then alphabetical, so the fingerprint is deterministic
    // and a diff of two recordings is readable.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, options.words ?? CANARY_WORDS)
    .map(([word]) => word)
    .sort();
  return {
    url: page.url,
    recordedAt: (options.now ?? new Date()).toISOString().slice(0, 10),
    status: page.status,
    declaredProduct: declaresProduct(page.body),
    textChars: text.length,
    words,
  };
}

/** The three readings the bank's `every-field-collapsed-is-blocking` accepts. */
export type CanaryState = "resolved" | "failed" | "unchecked";

export interface CanaryReading {
  state: CanaryState;
  because: string;
}

/**
 * Does the canary still resolve?
 *
 * This is the whole U3b distinction. If the template stops matching *and* the
 * canary fails too, the site is refusing you. If the canary still resolves, the
 * site is serving you and the template is what changed — that is drift, and
 * healing is the right answer. One boolean is the difference between "your
 * scraper broke" and "the site started refusing you".
 *
 * So the check is **deliberately insensitive to drift**. `CANARY_OVERLAP` is
 * 0.4, not 0.9: a canary that failed whenever the site was redesigned would
 * turn every drift into a false `blocked` and stop healing at exactly the
 * moment healing is what is needed. It is allowed to be wrong in the direction
 * of "resolved"; being wrong in the direction of "failed" costs a repair.
 *
 * Note what is *not* enough: a 200. Store C served its apology page with a
 * normal status and a rendered body, so a status check alone would have called
 * the canary resolved and the run drift. A canary with no body read is
 * `unchecked`, never `resolved`.
 */
export function checkCanary(
  recorded: CanaryFingerprint,
  observed: PageResponse | undefined,
  options: { overlap?: number; requireDeclared?: boolean } = {},
): CanaryReading {
  if (observed === undefined) return { state: "unchecked", because: "the canary page was not fetched on this run" };

  const status = statusSignal(observed);
  if (status) return { state: "failed", because: `the canary ${status.because}` };

  const challenge = challengeSignal(observed);
  if (challenge) return { state: "failed", because: `the canary is a challenge page: ${challenge.because}` };

  if (observed.body === undefined || observed.body === "") {
    return { state: "unchecked", because: "the canary answered but its body was not kept; a status alone does not say the page was served" };
  }

  /**
   * The sharpest evidence the canary has, and it is free.
   *
   * A store's error page keeps the store's furniture — Store C's did — so the
   * word overlap below cannot separate "apology with a nav bar" from "product
   * page" on its own. What an apology never has is a declared `Product`. If the
   * canary declared one when it was recorded and declares none now, whatever
   * came back is not the page that was recorded.
   *
   * The trade-off, stated rather than hidden: a site that genuinely deletes its
   * JSON-LD has drifted, and this reads it as refusal. That is the safe
   * direction — the verdict is `blocked` with a remedy a person will read,
   * rather than a heal that recompiles against an error page. A case that knows
   * better sets `requireDeclared: false`.
   */
  if ((options.requireDeclared ?? true) && recorded.declaredProduct && !declaresProduct(observed.body)) {
    return { state: "failed", because: `the canary declared a product when it was recorded on ${recorded.recordedAt} and declares none now; this is not the page that was recorded` };
  }

  const text = visibleText(observed.body);
  if (recorded.textChars > 0 && text.length < recorded.textChars * CANARY_TEXT_RATIO) {
    return { state: "failed", because: `the canary rendered ${recorded.textChars} characters when it was recorded and ${text.length} now; this is not the page that was recorded` };
  }

  const words = vocabulary(text);
  const present = recorded.words.filter((word) => words.has(word)).length;
  const overlap = recorded.words.length === 0 ? 1 : present / recorded.words.length;
  const threshold = options.overlap ?? CANARY_OVERLAP;
  if (overlap < threshold) {
    return { state: "failed", because: `the canary keeps ${present} of the ${recorded.words.length} words recorded on ${recorded.recordedAt}; the site is not serving the page it served then` };
  }
  return { state: "resolved", because: `the canary still resolves: ${present} of ${recorded.words.length} recorded words and ${text.length} characters of text` };
}

// ------------------------------------------------------------------- verdict

/**
 * What to do about a block. A blocked verdict that only says "blocked" hands
 * the problem back to whoever read it; this says which lever exists and that
 * pulling it costs money.
 *
 * `group` and `note` are free for the case to fill because the measurement does
 * not generalise. Apify Proxy's default pool and `BUYPROXIES94952` recovered
 * very different fractions of the same six Store C URLs on 2026-09-22, and
 * neither number is advice about any other store or any other week — it is a
 * measurement the case should carry, not a constant this module should hold.
 */
export interface Remedy {
  /** The lever. There is one today; a named union keeps it honest when there are two. */
  action: "enable-proxy";
  /** The proxy group to try, when the case knows one. */
  group?: string;
  /** That this is a paid decision, and on what terms. */
  cost: string;
  /** What the case measured, if anything: which group recovered how much, when. */
  note?: string;
}

export const DEFAULT_REMEDY: Remedy = {
  action: "enable-proxy",
  cost: "a paid decision: proxy traffic bills per GB, and no group is guaranteed to recover a given store — measure a group on this store's own URLs before committing to it",
};

interface VerdictBase {
  because: string;
  /** Every signal read off the run's responses, for the report. */
  signals: BlockingSignal[];
  /** How the canary read, including `unchecked`. */
  canary: CanaryState;
  /** Every heuristic that had something to say, in the shape `bindField` uses. */
  verdicts: Array<{ id: string; verdict: Verdict }>;
}

export interface BlockedVerdict extends VerdictBase {
  state: "blocked";
  /** What to do about it. A blocked verdict always names a remedy. */
  remedy: Remedy;
}

export interface DriftVerdict extends VerdictBase {
  state: "drift";
  /**
   * The only place this flag exists. Healing reads the verdict, not the fill
   * counts, so "recompile against whatever the page shows now" is unreachable
   * from a blocked run — which is the point, because the page a Store C
   * recompile would have learned from said "¡Lo sentimos!".
   */
  heal: true;
}

export interface HealthyVerdict extends VerdictBase {
  state: "healthy";
}

/**
 * **Not yet decidable**, and the reason the first live run of the cascade was
 * wrong on 2026-09-22.
 *
 * Every blocking signal this run carries is `corroborated` — it read the page's
 * emptiness — and every page it read it off is one `shell-skips-tier-1` already
 * explains. A JS shell and a challenge interstitial are the same bytes to a
 * plain fetch: no declared product, no text, a script tag. Store B's is the
 * first, and the cascade called it the second, skipped every tier and bound
 * nothing on a store that was answering perfectly.
 *
 * There is no more evidence to be had at this level, so this verdict does not
 * guess. It says what it is holding and what would settle it: a render. A shell
 * fills; a refusal does not. `settleDeferred` is the second pass.
 *
 * It is deliberately *not* a `blocked` with a softer word — nothing may bind
 * against a deferred run either, because it may yet turn out to be one — nor a
 * `healthy`, which would let a genuine refusal through. It is the one state the
 * module had no way to say.
 */
export interface DeferredVerdict extends VerdictBase {
  state: "deferred";
  /** The signals being held back, and the ones a render has to disprove. */
  deferred: BlockingSignal[];
}

export type RunVerdict = BlockedVerdict | DriftVerdict | HealthyVerdict | DeferredVerdict;

/**
 * The gate a healer asks. There is no other way to get a heal out of a verdict,
 * and `deferred` is not a way either: an undecided run has nothing to heal
 * against for the same reason a blocked one has nothing.
 */
export function mayHeal(verdict: RunVerdict): verdict is DriftVerdict {
  return verdict.state === "drift";
}

// ------------------------------------------------------------ the second pass

/** What the render produced, which is the only thing that tells a shell from a refusal. */
export interface RenderEvidence {
  /** The pages as the browser rendered them. Empty when the render kept no HTML. */
  pages: readonly PageResponse[];
  /**
   * How much the pages fetched for themselves, counted in leaves. A refusal has
   * no payload to hand over; a shell's whole answer is one. Zero here is a
   * render that produced nothing, which is not the same as a render never taken
   * — that case reaches this function with no evidence at all and is refused.
   */
  payloadLeaves: number;
}

/**
 * Re-decide a `deferred` verdict against what a render produced.
 *
 * The ordering `investigate.ts` protects — blocked before bound — is preserved
 * rather than relaxed: this still runs before anything binds, and it still has
 * only two answers that let the cascade continue. What changed is *what it gets
 * to look at*. On 2026-09-22 the plain fetch was the whole record, and the plain
 * fetch of a shell is indistinguishable from the plain fetch of a challenge
 * page. A render is one call, it was going to be made anyway on a shell site,
 * and it separates them completely.
 *
 * Nothing is deferred twice: the second pass declares `shells: []`, so the
 * corroboration rules run at full strength over the rendered pages. That is not
 * a technicality — a page that is *still* a shell after a browser has had it is
 * a page whose content never arrived, which is the refusal, not the excuse for
 * it. Leaving the shell rule to re-derive itself here would let a WAF that
 * blocks the XHRs defer forever.
 */
export function settleDeferred(deferred: DeferredVerdict, evidence: RenderEvidence, input: Omit<RunInput, "pages" | "shells"> = {}): RunVerdict {
  const canary = deferred.canary;
  if (evidence.payloadLeaves > 0) {
    return {
      state: "healthy",
      because: `${deferred.because} — and the render disproved it: the page fetched ${evidence.payloadLeaves} leaves of payload for itself, which a refused page has none of`,
      signals: deferred.signals,
      canary,
      verdicts: deferred.verdicts,
    };
  }

  if (evidence.pages.length > 0) {
    const second = classifyRun({ ...input, pages: evidence.pages, shells: [] });
    const signals = [...deferred.signals, ...second.signals];
    const verdicts = [...deferred.verdicts, ...second.verdicts];
    if (second.state !== "blocked") {
      return {
        state: "healthy",
        because: `${deferred.because} — and the render disproved it: ${second.because}`,
        signals,
        canary,
        verdicts,
      };
    }
    return {
      state: "blocked",
      because: `${deferred.because} — and the render confirmed it: ${second.because}`,
      signals,
      canary,
      verdicts,
      remedy: { ...DEFAULT_REMEDY, ...input.remedy },
    };
  }

  return {
    state: "blocked",
    because: `${deferred.because} — and the render produced neither a page nor a payload to disprove it`,
    signals: deferred.signals,
    canary,
    verdicts: deferred.verdicts,
    remedy: { ...DEFAULT_REMEDY, ...input.remedy },
  };
}

export interface FieldFill {
  filled: number;
  total: number;
}

export interface RunInput {
  /** One entry per URL the run touched. Omit for a run that kept only its counts. */
  pages?: readonly PageResponse[];
  /** Fill counts per field. The bank needs two or more to have a collapse to talk about. */
  fields?: Readonly<Record<string, FieldFill>>;
  /**
   * Per-field values across samples. When given, the constant fields are
   * derived here by running `no-variation-no-field` rather than being declared
   * by the caller — which is the Store C trap closed end to end: the apology was
   * 111/111 filled and identical, and only the variation check sees that.
   */
  values?: Readonly<Record<string, ReadonlyArray<string | number | null>>>;
  /** Fields a variation check already rejected. Merged with anything derived from `values`. */
  constant?: readonly string[];
  /** The canary reading for this run. */
  canary?: CanaryState | CanaryReading;
  /** What the case knows about the remedy: a named group, a cost note. */
  remedy?: Partial<Remedy>;
  /** A case's heuristic overrides; the default bank when omitted. */
  view?: Bank;
  /**
   * URLs whose plain fetch came back a JS shell — `shell-skips-tier-1`'s own
   * answer, carried rather than re-derived, the way `constant` carries a
   * variation check the caller already ran.
   *
   * Omit it and this module asks the rule itself, for the pages that need it.
   * That is not a convenience: "blocked" must be unreachable from a shell *for
   * every caller*, not only for the one that remembered to pass the set. The
   * cascade passes it because it has already paid for the verdicts and wants
   * them in the manuscript once.
   */
  shells?: readonly string[];
  apology?: ApologyOptions;
  /**
   * Fraction of the run's URLs that must carry a blocking signal before the
   * transport alone settles it. Half by default: one 403 in a hundred is a dead
   * product, a hundred in a hundred is a policy.
   */
  blockedShare?: number;
  /** A field at or below this fill rate counts as collapsed. Passed straight to the bank. */
  floor?: number;
}

const DEFAULT_BLOCKED_SHARE = 0.5;
const DEFAULT_FLOOR = 0.05;

function canaryOf(input: RunInput["canary"]): CanaryReading {
  if (input === undefined) return { state: "unchecked", because: "no canary was recorded for this scraper" };
  if (typeof input === "string") return { state: input, because: `the canary was reported as ${input}` };
  return input;
}

/**
 * The run's verdict: blocked, drift, healthy — or `deferred`, which is the run
 * saying it has read everything a plain fetch can hold and it is not enough.
 *
 * Two independent authorities, in this order:
 *
 *  1. **The transport.** Refusals and challenges on a large enough share of the
 *     run's URLs settle it on their own — there is nothing to heal against a
 *     403, and the canary is irrelevant when the catalogue itself is refused.
 *     With one exception, and it is the whole of the 2026-09-22 live-run fix: a
 *     signal that read the page's *emptiness* (`corroborated`) off a page the
 *     shell rule claims is not evidence of anything, because a shell is empty
 *     by construction. Those are held back and the run comes out `deferred`.
 *  2. **The bank.** `every-field-collapsed-is-blocking` owns the collapse call
 *     and the canary distinction. It is run, never re-derived: this function
 *     assembles the observation (fill counts, constants, canary state) and
 *     reports what the rule says, so a change to the rule changes the verdict
 *     and its fixture pins both.
 *
 * The healthy/drift split below the bank is a different question — *is anything
 * wrong at all* — and is decided here, from the same floor the bank was given.
 */
export function classifyRun(input: RunInput): RunVerdict {
  const view = input.view ?? bank();
  const pages = input.pages ?? [];
  const fields = input.fields ?? {};
  const floor = input.floor ?? DEFAULT_FLOOR;
  const reading = canaryOf(input.canary);
  const verdicts: Array<{ id: string; verdict: Verdict }> = [];
  const signals = detectBlocking(pages, input.apology ?? {});
  const remedy: Remedy = { ...DEFAULT_REMEDY, ...input.remedy };

  // A field that filled but never varied is collapsed too, and only the
  // variation rule can tell. Store C's product_name is the case: 111/111.
  const constant = new Set(input.constant ?? []);
  for (const [field, values] of Object.entries(input.values ?? {})) {
    if (values.length < 2) continue;
    const verdict = view.run("no-variation-no-field", { field, values: [...values] });
    verdicts.push({ id: "no-variation-no-field", verdict });
    if (verdict.fires) constant.add(field);
  }

  // 1. The transport.
  const blockedUrls = new Set(signals.map((signal) => normalize(signal.url)));
  const urls = new Set(pages.map((page) => normalize(page.url)));
  const share = urls.size === 0 ? 0 : blockedUrls.size / urls.size;
  const threshold = input.blockedShare ?? DEFAULT_BLOCKED_SHARE;

  /**
   * Which of these signals is only as strong as the page not being a shell, on
   * a page that is one. The caller's own answer wins when it gave one; when it
   * did not, the rule is asked here — and only about the pages a `corroborated`
   * signal named, so a healthy run pays nothing and gains no verdict noise.
   */
  const declaredShells = input.shells === undefined ? undefined : new Set(input.shells.map(normalize));
  const bodies = new Map(pages.map((page) => [normalize(page.url), page.body ?? ""]));
  const shellCache = new Map<string, boolean>();
  const isShell = (url: string): boolean => {
    const key = normalize(url);
    if (declaredShells !== undefined) return declaredShells.has(key);
    const known = shellCache.get(key);
    if (known !== undefined) return known;
    const verdict = view.run("shell-skips-tier-1", { html: bodies.get(key) ?? "" });
    verdicts.push({ id: "shell-skips-tier-1", verdict });
    shellCache.set(key, verdict.fires);
    return verdict.fires;
  };

  const held = new Set(signals.filter((signal) => signal.corroborated === true && isShell(signal.url)));
  const decisive = signals.filter((signal) => !held.has(signal));
  const decisiveUrls = new Set(decisive.map((signal) => normalize(signal.url)));

  if (urls.size > 0 && decisiveUrls.size / urls.size >= threshold) {
    const kinds = [...new Set(decisive.map((signal) => signal.kind))].join(", ");
    return {
      state: "blocked",
      because: `${decisiveUrls.size} of ${urls.size} URLs answered with a refusal (${kinds}): ${decisive[0]?.because ?? ""}`,
      signals,
      canary: reading.state,
      verdicts,
      remedy,
    };
  }

  // The transport would have settled it, and only the held signals get it over
  // the line. That is the 2026-09-22 shape exactly — three Store B shells,
  // three Incapsula resources, "blocked" — and it is not a verdict, it is a
  // question for a browser.
  if (urls.size > 0 && held.size > 0 && share >= threshold) {
    const first = [...held][0]!;
    return {
      state: "deferred",
      because: `${blockedUrls.size} of ${urls.size} URLs look refused (${first.because}), but every page that says so is one shell-skips-tier-1 already explains, and a shell and an interstitial are the same bytes to a plain fetch`,
      signals,
      deferred: [...held],
      canary: reading.state,
      verdicts,
    };
  }

  const gone = collapsed(fields, constant, floor);

  // 2. The bank. Its input needs two fields; one field cannot collapse "together
  // with" anything, and the rule says so by refusing the observation.
  const names = Object.keys(fields);
  if (names.length >= 2 && names.every((name) => (fields[name]?.total ?? 0) >= 1)) {
    const verdict = view.run("every-field-collapsed-is-blocking", {
      fields,
      canary: reading.state,
      constant: [...constant],
      floor,
    });
    verdicts.push({ id: "every-field-collapsed-is-blocking", verdict });
    if (verdict.fires) {
      return {
        state: "blocked",
        because: `${verdict.because}${reading.state === "unchecked" ? "" : ` — ${reading.because}`}`,
        signals,
        canary: reading.state,
        verdicts,
        remedy,
      };
    }
    if (reading.state === "resolved" && gone.length > 0) {
      // Name what stopped filling: the rule's own sentence is about what
      // survived, which is the wrong half for whoever has to repair this.
      return { state: "drift", heal: true, because: `${gone.join(", ")} stopped filling — ${verdict.because} — ${reading.because}`, signals, canary: reading.state, verdicts };
    }
  }

  if (gone.length > 0) {
    return {
      state: "drift",
      heal: true,
      because: `${gone.join(", ")} stopped filling while the rest of the run kept answering; the site is serving you and the template is what changed`,
      signals,
      canary: reading.state,
      verdicts,
    };
  }

  return {
    state: "healthy",
    because:
      names.length === 0 && urls.size === 0
        ? "nothing was observed: no responses and no fill counts, so nothing here says the run went wrong"
        : `every field still fills above ${floor} with values that vary, and ${urls.size === 0 ? "no response" : `${blockedUrls.size} of ${urls.size} URLs`} carried a refusal signal`,
    signals,
    canary: reading.state,
    verdicts,
  };
}

/** Fields at or below the floor, plus the ones that filled with one value forever. */
function collapsed(fields: Readonly<Record<string, FieldFill>>, constant: ReadonlySet<string>, floor: number): string[] {
  return Object.entries(fields)
    .filter(([name, count]) => count.total > 0 && (count.filled / count.total <= floor || constant.has(name)))
    .map(([name]) => name);
}
