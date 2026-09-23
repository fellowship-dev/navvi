/**
 * The challenge lexicon, and the one place the decisive/corroboration split is
 * written down.
 *
 * Two modules ask "is this site refusing us" and neither can be deleted:
 * `src/prestep/blocked.ts` asks it about **one live `Page`**, mid-navigation,
 * with a DOM to query and a person possibly waiting; `src/investigate/blocked.ts`
 * asks it about **a finished run** — many stored responses, fill counts and a
 * canary — offline, with no browser anywhere. A `--har` compile needs the
 * second and cannot have the first.
 *
 * What they may not do is disagree about the same bytes, and on 2026-09-22 they
 * did. Prestep listed `.g-recaptcha`, `#recaptcha` and `iframe[src*=recaptcha]`
 * beside Cloudflare's own challenge containers and fired on
 * `status ∈ {403,429,503} && any selector hit`, with no text check and no
 * product check. Investigate had already ruled — with an encounter behind it —
 * that those same widgets are furniture: a store that puts reCAPTCHA on its
 * login modal ships the loader in the head of every product page, and Imperva
 * stamps `_Incapsula_Resource` into every page of every site it fronts. So a
 * Chilean store with a reCAPTCHA login modal and one rate-limited 403 was
 * `blocked_bot_detection` to prestep and perfectly healthy to investigate.
 *
 * The split below is the fix, and it is stated once:
 *
 * - **decisive** markers appear when, and only when, something was *mitigated*
 *   — Cloudflare's challenge platform and its `cf-chl` bundle, Imperva's
 *   resource carrying an `incident_id`, DataDome's and PerimeterX's block
 *   frames, `cf-mitigated` and friends in the headers, and the challenge
 *   wording in the document *title*. They say something about the response, so
 *   they stand on their own whatever else the page holds.
 * - **corroboration-required** markers are widgets any page may embed and WAF
 *   injections any page behind one carries. Being *behind* a WAF is not being
 *   *refused by* one. They fire only on a page that is also an interstitial:
 *   **it declares no product to a machine, and it renders almost no text.**
 *
 * And the corroboration is necessary, not sufficient — a JS shell satisfies it
 * by construction. Each caller carries that the way its own question allows:
 * `classifyRun` holds a corroborated signal back on a URL `shell-skips-tier-1`
 * claims and answers `deferred`; prestep asks the same rule and keeps
 * navigating, because a shell fills and a refusal does not.
 *
 * Note what is deliberately *not* here. Prestep used to carry
 * `CHALLENGE_STATUSES = {403, 429, 503}` and let any marker hit fire on one.
 * A status says the site refused *this request*; it says nothing about whether
 * the widget in the page is the point or the furniture, which is the only
 * question corroboration asks. Letting it upgrade a widget hit is precisely the
 * bug above, so the status decides nothing here. Investigate keeps its own
 * `BLOCKING_STATUSES` as a *separate* authority — a signal of kind `status`,
 * weighed over a run — which is the honest place for it.
 */

/** A reading's evidence and its sentence. Built by whichever side found the marker. */
export interface ChallengeMarker {
  /** The status, marker or fingerprint that fired it. */
  evidence: string;
  /** Why, in terms of the response. Goes into a report verbatim. */
  because: string;
}

/**
 * What either side can say about one page, in terms neither a DOM nor a stored
 * body owns. `decisive` and `widget` are what the caller's own scan found —
 * a `document.querySelector` on a live page, a regex over a stored body — and
 * the lists it scanned with are the ones below, so there is one lexicon.
 */
export interface ChallengeObservation {
  /** The document title, or "" when there is none. */
  title: string;
  /** The visible text: rendered for a live page, extracted from source for a stored one. */
  text: string;
  /** Length of that text *before* any cap the caller applied. Defaults to `text.length`. */
  textLength?: number | undefined;
  /** Does the page declare a Product to a machine (JSON-LD, microdata, `og:`/`product:`)? */
  declaresProduct: boolean;
  /** A marker that appears only when a request was mitigated. */
  decisive?: ChallengeMarker | null | undefined;
  /** A widget or WAF injection any page may carry. Only as strong as the page being empty. */
  widget?: string | null | undefined;
}

/** A challenge reading, in the shape `BlockingSignal` carries it. */
export interface ChallengeReading {
  evidence: string;
  because: string;
  /**
   * **This reading assumed the page was not showing anyone anything.** Set on
   * every reading that fired only because the page declares no product and
   * renders almost nothing — which a JS shell does by construction. See the
   * module note: a corroborated reading on a shell is not a verdict.
   */
  corroborated?: true;
}

/** Challenge interstitial wording, matched against the title and the visible text. */
export const BOT_CHALLENGE_TEXT: readonly RegExp[] = [
  /checking your browser/i,
  /just a moment/i,
  /verify(ing)? (that )?you are (a )?human/i,
  /verify you are not a (ro)?bot/i,
  /access denied/i,
  /attention required/i,
  /un momento/i,
  /verifica que eres humano/i,
  /comprueba que eres humano/i,
  /confirma que eres humano/i,
  /acceso denegado/i,
  /enable javascript and cookies to continue/i,
  /please enable cookies/i,
  /request unsuccessful\. incapsula/i,
  /pardon our interruption/i,
  /performance & security by cloudflare/i,
  /datadome/i,
  /perimeterx/i,
  /press & hold/i,
];

/**
 * Containers that exist only on a page that was stopped. A store does not ship
 * `#challenge-running` or a `form[action*=captcha]` in the furniture of its
 * catalogue.
 */
export const DECISIVE_CHALLENGE_SELECTORS: readonly string[] = [
  "#challenge-running",
  "#challenge-form",
  "#challenge-error-text",
  "#cf-challenge-running",
  "#px-captcha",
  "[id^='px-captcha']",
  "#datadome",
  "iframe[src*='captcha-delivery.com']",
  "iframe[src*='geo.captcha-delivery.com']",
  "#captcha-form",
  "form[action*='captcha']",
];

/**
 * Captcha widgets. A login modal, a contact form and a newsletter box all carry
 * these on perfectly healthy pages, which is why they need the page to be empty
 * before they mean anything.
 */
export const WIDGET_CHALLENGE_SELECTORS: readonly string[] = [
  "#cf-turnstile",
  ".cf-turnstile",
  'iframe[src*="challenges.cloudflare.com"]',
  ".h-captcha",
  "iframe[src*='hcaptcha.com']",
  ".g-recaptcha",
  "#recaptcha",
  "iframe[src*='recaptcha']",
];

/** Every container either half names. Kept for callers that only want to query once. */
export const BOT_CHALLENGE_SELECTORS: readonly string[] = [...DECISIVE_CHALLENGE_SELECTORS, ...WIDGET_CHALLENGE_SELECTORS];

/**
 * Markers in the raw source, not the rendered text. A challenge page that has
 * not run its JavaScript — which is every challenge page in a stored response
 * body — renders almost nothing, so the visible-text lexicon cannot reach it.
 *
 * **Decisive**, in the sense above: Cloudflare's challenge platform and its
 * `cf-chl` token bundle, Incapsula's resource carrying an `incident_id`,
 * DataDome's and PerimeterX's block frames.
 */
export const CHALLENGE_MARKERS: readonly RegExp[] = [
  /\/cdn-cgi\/challenge-platform\//i,
  /\bcf[-_]chl[-_a-z]*/i,
  /_Incapsula_Resource[^\s"'<>]*incident_id/i,
  /captcha-delivery\.com/i,
  /\bpx-captcha\b/i,
];

/**
 * **Corroboration required.** The source spelling of `WIDGET_CHALLENGE_SELECTORS`,
 * plus Imperva's always-on resource — the one with no `incident_id`, which is
 * served in the head of every page of every site it fronts, refused or not.
 */
export const WIDGET_MARKERS: readonly RegExp[] = [
  /_Incapsula_Resource/i,
  /\bcf[-_]turnstile\b/i,
  /challenges\.cloudflare\.com/i,
  /google\.com\/recaptcha\/api(?:\.js|2)/i,
  /\bg-recaptcha\b|\bgrecaptcha\b/i,
  /\bh-?captcha\b|hcaptcha\.com/i,
];

/**
 * Headers that announce a *block*, with the same discipline: `x-iinfo` and the
 * `visid_incap` cookie are stamped on every response Imperva proxies, and
 * `server: sucuri` on every response Sucuri serves, so none of them is here.
 * `cf-mitigated`, `x-sucuri-block` and the `__cf_chl` cookie are set only when
 * the request was actually stopped.
 */
export const CHALLENGE_HEADERS: ReadonlyArray<{ name: string; value?: RegExp }> = [
  { name: "cf-mitigated" },
  { name: "x-sucuri-block" },
  { name: "set-cookie", value: /__cf_chl/i },
];

/**
 * Above this much visible text a page is showing someone something, and a
 * captcha widget in it is furniture rather than the point.
 */
export const INTERSTITIAL_TEXT_CHARS = 1_500;

/** The document title of a stored body. The live side reads `document.title`. */
export function titleOf(html: string): string {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

/** The first pattern that matches, as the text it matched. */
export function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  if (text === "") return null;
  for (const pattern of patterns) {
    const hit = pattern.exec(text);
    if (hit) return hit[0];
  }
  return null;
}

/** A decisive header, as a marker. */
export function challengeHeader(headers: Readonly<Record<string, string>> | undefined): ChallengeMarker | null {
  if (!headers) return null;
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  for (const { name, value } of CHALLENGE_HEADERS) {
    const found = lower.get(name);
    if (found === undefined) continue;
    if (value === undefined || value.test(found)) {
      const evidence = `${name}: ${found}`;
      return { evidence, because: `the response carries a challenge header (${evidence})` };
    }
  }
  return null;
}

/** A decisive marker in the raw source of a stored response, or a serialized DOM. */
export function decisiveSourceMarker(source: string): ChallengeMarker | null {
  const hit = firstMatch(source, CHALLENGE_MARKERS);
  return hit === null ? null : { evidence: hit, because: `the response body loads a challenge (${hit})` };
}

/** A corroboration-required widget in the raw source of a stored response, or a serialized DOM. */
export function widgetSourceMarker(source: string): string | null {
  return firstMatch(source, WIDGET_MARKERS);
}

/**
 * Does this page read as a bot challenge, and how strongly?
 *
 * The whole order lives here so that neither caller can reorder it by accident:
 *
 *  1. a decisive marker — a header, a mitigation-only resource, a challenge
 *     container — says so on its own;
 *  2. so does challenge wording in the **title**: a store does not title its
 *     product page "Just a moment…";
 *  3. everything below needs the page to be an interstitial as well as to carry
 *     the marker, so a page that **declares a product** or **renders real text**
 *     stops here, whatever widget it embeds and whatever status it answered;
 *  4. a widget or WAF injection, and
 *  5. challenge wording in the body text — both `corroborated`, because both
 *     read the page's emptiness rather than the response.
 */
export function readChallenge(observation: ChallengeObservation): ChallengeReading | null {
  if (observation.decisive) return { evidence: observation.decisive.evidence, because: observation.decisive.because };

  const titleHit = firstMatch(observation.title, BOT_CHALLENGE_TEXT);
  if (titleHit !== null) return { evidence: titleHit, because: `the page is titled ${JSON.stringify(observation.title)}` };

  const length = observation.textLength ?? observation.text.length;
  if (observation.declaresProduct || length >= INTERSTITIAL_TEXT_CHARS) return null;

  if (observation.widget) {
    return {
      evidence: observation.widget,
      because: `a page with no declared product and ${length} characters of text loads ${observation.widget}`,
      corroborated: true,
    };
  }

  const textHit = firstMatch(observation.text, BOT_CHALLENGE_TEXT);
  if (textHit !== null) {
    return { evidence: textHit, because: `the page reads as a challenge interstitial (${JSON.stringify(textHit)})`, corroborated: true };
  }
  return null;
}
