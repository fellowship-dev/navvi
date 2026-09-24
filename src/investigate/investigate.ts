import { isUsableResponse, newestUsableResponse } from "../browser/network-capture.js";
import { bank, type Bank } from "../heuristics/index.js";
import { declaresProduct } from "../heuristics/index.js";
import type { TypedValue } from "../scraper/extract.js";
import { MACHINERY_RULE, bindField } from "./bind.js";
import { classifyRun, recordCanary, settleDeferred, type ApologyOptions, type CanaryFingerprint, type PageResponse, type RunVerdict } from "./blocked.js";
import { coversSpec, readDeclared, type DeclaredSource } from "./declared.js";
import { UNASKED, agree, answered, unservable, type Agreement, type Observation } from "../agree/agree.js";
import { safeUrl, type CapturedResponse } from "./har.js";
import { headlineOf, identityAnchor, pageIdentities, type IdentityAnchor, type PageIdentity } from "./identity.js";
import { anchors, flatten, type Leaf } from "./leaves.js";
import type { FieldAlias, FieldRecord, InventoryRecord, Manuscript, Obstacle, RejectionRecord, RequestedField, SamplePickRecord, SourceRecord, TierDecision, TierRecord, VerdictLog } from "./manuscript.js";
import { KIND_PRECEDENCE, acceptedRoles, resolutionOrder, roleOfDeclared, type DeclaredRole } from "./roles.js";
import { NO_SHELLS_YET, bindable, type SampleChoice } from "./sample.js";

/**
 * U2c: the cascade. The five modules beside this one, in the order that makes
 * each of them cheap.
 *
 * ```
 * 1. plain fetch          no browser         JSON-LD, OpenGraph, microdata
 * 2. render + capture     browser            the JSON the page fetches for itself
 * 3. compile selectors    browser + model    whatever is still uncovered
 * ```
 *
 * The ordering is the product. On 2026-09-22 navvi's compiler asked one
 * question — *which DOM node holds this field?* — of a rendered page, for every
 * field of every site, and produced `body.one-col.christmas-pattern` on a store
 * that was stating all six requested fields in its own `<meta>` tags. Tier 3 is
 * still here and still necessary; it is now **the exception**, reached only by a
 * field the first two tiers left uncovered.
 *
 * Two things this file deliberately does not do:
 *
 *  - **It does not fetch, render or drive a browser.** All three are callbacks
 *    (`Sources`), so the whole cascade is offline-testable and a HAR stands in
 *    for the browser without this module knowing. That is not only ergonomics:
 *    the value of the cascade is the call that is *not* made, and a test can
 *    only assert `capture` was never called if `capture` is something it owns.
 *  - **It does not generate DOM candidates.** That is `src/compile/`, it needs a
 *    live page, and it costs a model. What happens here is the *decision* that
 *    it runs at all -- only for the fields tiers 1 and 2 left uncovered -- and
 *    the record of what it answered. `Sources.dom` is the callback, and
 *    `src/compile/template.ts` is what supplies it.
 *
 * Tier 3 used to stop at that record. Until 2026-09-23 this file pushed
 * `{ tier: 3, outcome: "requested" }` and nothing ever called the DOM compiler
 * on its behalf: `navvi make` on a page with no declared product bound nothing,
 * said so in a tier line nobody acted on, and exited 1, while the plain command
 * compiled the same page from its markup through a second compiler. The record
 * is still what a run without a DOM compiler writes (`requested`, with the
 * reason); a run with one gets `ran`, the bindings, and for each one the
 * question the chooser was asked and the backend that answered it.
 *
 * What comes out is a `Manuscript` (U2f): every source, sample, obstacle and
 * rejection, JSON-serialisable and stable.
 */

// -------------------------------------------------------------------- inputs

/**
 * What one rendered page handed back. The shape `browser/network-capture.ts`
 * produces and the shape `importHar` produces, which is the point of both: a
 * capture taken on a laptop the store answers compiles the same scraper as a
 * live render, and this module cannot tell them apart.
 */
export interface Capture {
  /** The JSON the page fetched for itself, in call order — oldest first, as `HarImport.responses` is. */
  responses: readonly CapturedResponse[];
  /**
   * The rendered page's visible text.
   *
   * Omit it and tier 2 does not anchor, which costs the single best filter it
   * has: a leaf whose value is on the page is describing the page, and one that
   * is not is telemetry or someone else's product.
   */
  text?: string | undefined;
  /** The rendered HTML, when the caller kept it. Used only to record a canary off a page that rendered. */
  html?: string | undefined;
  /** What the render had to get past: a consent dialog dismissed, a WAF that let it through. */
  obstacles?: readonly Obstacle[] | undefined;
  /**
   * Whether the render the capture was taken from ever finished.
   *
   * Optional, and absent is the honest answer for a capture imported from a
   * HAR: nobody watched that page settle, so nobody may claim it did. The
   * driver that renders live supplies it (`DrivenCapture` in
   * `src/make/pages.ts`), and only `quiesced` means the capture holds the page
   * rather than a frame of it.
   *
   * Declared structurally rather than imported. `Settle` is the page driver's
   * type and the driver is an entry-layer module; a stage importing it would
   * be an arrow pointing up. This is the part of it this module is allowed to
   * act on — the discriminant and the excuse — and `DrivenCapture` widens it
   * with the trend numbers for callers that can see them.
   */
  settle?: { outcome: "quiesced" | "capped" | "unreachable"; because?: string | undefined } | undefined;
}

/**
 * Where the bytes come from. All callbacks, and `capture` and `dom` are
 * optional, because a run that stops at tier 1 must be able to say it never
 * had either.
 */
export interface Sources {
  /** One plain HTTP request. No browser, no JavaScript. */
  fetch(url: string): Promise<PageResponse>;
  /** Render the URL and hand back what it fetched for itself. Called only for a field tier 1 left uncovered. */
  capture?: ((url: string) => Promise<Capture>) | undefined;
  /**
   * Tier 3: the DOM compiler, over rendered pages, with a chooser. Called at
   * most once, with only the fields tiers 1 and 2 left uncovered (KTD2), and
   * never on a blocked run. `src/compile/template.ts` supplies it; this module
   * cannot import `src/compile/` without closing a knot, and would not want
   * to: the page and the model are the caller's.
   */
  dom?: ((request: DomRequest) => Promise<DomAnswer>) | undefined;
}

// ------------------------------------------------------------------- tier 3

/** What tier 3 is handed: the uncovered fields, and the pages that were bound from. */
export interface DomRequest {
  /** The fields tiers 1 and 2 left uncovered, in requested order. Only these are asked about. */
  fields: readonly RequestedField[];
  /** The binding URLs, in sample order. The DOM compiler renders them, or the first few of them. */
  urls: readonly string[];
}

/** One field tier 3 bound: a selector the chooser picked and the selector gate let through. */
export interface DomBinding {
  field: string;
  selector: string;
  attr?: string | undefined;
  /** The candidate's path, as the snapshot labels it. */
  path: string;
  /** The value on each rendered sample, in sample order. */
  values: TypedValue[];
  decision: TierDecision;
  because: string;
}

/** A candidate the chooser picked and the selector gate refused, with the gate's own sentence. */
export interface DomRefusal {
  field: string;
  path: string;
  values: TypedValue[];
  because: string;
  decision: TierDecision;
}

export interface DomAnswer {
  /**
   * Did the DOM compiler run? `false` when it could not -- no chooser could be
   * opened, nothing rendered -- which is a different fact from running and
   * finding nothing, and `because` says which.
   */
  ran: boolean;
  bindings: DomBinding[];
  refused: DomRefusal[];
  /** Fields the chooser answered `none` for, or that had no candidate at all. */
  unanswered: Array<{ field: string; because: string }>;
  sources: SourceRecord[];
  because: string;
}

export interface InvestigateOptions {
  /** The site as the spec named it; for the manuscript's first line. */
  site?: string | undefined;
  /** What the spec asked for, in the order it asked. */
  fields: readonly RequestedField[];
  /** U2d's answer, carried verbatim: which URLs, and why each is in the sample. */
  sample: SampleChoice;
  sources: Sources;
  /** A case's heuristic overrides; the default bank when omitted. */
  view?: Bank | undefined;
  /** The clock, so a manuscript is reproducible. */
  now?: Date | undefined;
  apology?: ApologyOptions | undefined;
  /** Passed to `classifyRun`: the share of URLs that must be refused before the transport settles it. */
  blockedShare?: number | undefined;
}

// ------------------------------------------------------------------ endpoints

/**
 * The endpoint a captured URL belongs to, with its identifiers blanked.
 *
 * `…/products/detail/100001` and `…/products/detail/100002` are one endpoint
 * asked twice, and a binding has to name the endpoint rather than the product —
 * otherwise "present on every sample" is false by construction and tier 2
 * binds nothing. A segment carrying a digit, or long enough to be an opaque id,
 * becomes `*`.
 */
function endpointKey(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
  }
  const segments = path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => (/\d/.test(segment) || segment.length > 24 ? "*" : segment));
  return `/${segments.join("/")}`;
}

/**
 * The `match` a compiled `network` alternative carries: the constant head of
 * the key, which is what `resolveDeclared` tests the live URL against. Stops at
 * the first blanked segment, because everything after it is a different
 * product on the next run.
 */
function endpointMatch(key: string): string {
  const segments = key.split("/").filter((segment) => segment !== "");
  const head: string[] = [];
  for (const segment of segments) {
    if (segment === "*") break;
    head.push(segment);
  }
  return head.join("/");
}

/**
 * How much a render produced, counted in leaves — the same unit tier 2 binds
 * from, so "the render produced nothing" means the same thing here and there.
 *
 * This is the evidence that settles a `deferred` run. A refused page has no
 * payload to hand over; a JS shell's entire answer is one. On 2026-09-22 the
 * three Store B URLs the cascade called blocked returned 86 payloads between
 * them, `catalog-svc/products/detail` among them, with every requested
 * field in it — one browser call away from the plain fetch that looked refused.
 */
function payloadLeaves(captures: readonly Capture[]): number {
  let total = 0;
  for (const capture of captures) {
    for (const response of capture.responses) {
      // A 401 before the anonymous session exists is not the page failing to
      // answer, and it is not evidence that it did either. `isUsableResponse`
      // is the one place that test is written; `newestUsable` below uses it too.
      if (!isUsableResponse(response)) continue;
      total += flatten(response.body).length;
    }
  }
  return total;
}

/**
 * The newest answer this endpoint gave that was an answer — the shared walk,
 * with no URL or payload constraint, because the caller has already grouped
 * the captures by endpoint key.
 */
const newestUsable = (responses: readonly CapturedResponse[]): CapturedResponse | null => newestUsableResponse(responses);

// ------------------------------------------------------------------- tier 1

interface DeclaredSample {
  url: string;
  sources: DeclaredSource[];
}

/** Declared findings of one role, best declaration first. */
function byRole(sources: readonly DeclaredSource[], role: DeclaredRole): DeclaredSource[] {
  return sources
    .filter((source) => roleOfDeclared(source) === role)
    .sort((a, b) => KIND_PRECEDENCE[a.kind] - KIND_PRECEDENCE[b.kind] || a.path.length - b.path.length || a.path.localeCompare(b.path));
}

interface DeclaredBinding {
  source: DeclaredSource;
  values: TypedValue[];
  aliases: FieldAlias[];
}

/**
 * A declared finding, as an alias of whatever was bound.
 *
 * Every field `DeclaredSource` already carries — the kind it rides in as, the
 * selector that resolves it, the attribute, the entity — is exactly what an
 * alternative for it needs, and tier 1 was throwing all of it away and keeping
 * the path. An OpenGraph property and a JSON-LD path are read in completely
 * different ways, and the record said only that they said the same thing.
 */
function aliasOfDeclared(source: DeclaredSource): FieldAlias {
  return {
    path: source.path,
    source: source.source,
    selector: source.selector,
    ...(source.attr === undefined ? {} : { attr: source.attr }),
    ...(source.entity === undefined ? {} : { entity: source.entity }),
  };
}

/**
 * The one path of this role that every binding sample declares, with the rest
 * of the role's paths as aliases.
 *
 * "Every sample" is not `narrow`'s rule *restated* any more — since 2026-09-23
 * it is the same rule, asked through `agree` in `agree/agree.ts`, which is
 * where the four copies of it now live as one. It earns its keep the way it
 * always did: a property one page declares and the next does not is not a
 * binding, it is a page that happened to have it.
 *
 * A sample declaring nothing of this role is `unasked`. That is the honest
 * reading and it is deliberately not `unservable`: the page was served and
 * read, and `bindable` has already kept the pages that could not be read —
 * dead picks and shells — out of `samples` entirely. So by the time a sample
 * reaches here, "no declaration of this role" is that page's answer, not its
 * failure to give one.
 */
function bindRole(samples: readonly DeclaredSample[], role: DeclaredRole): DeclaredBinding | undefined {
  const declaring = agree(
    samples.map((sample) => {
      const found = byRole(sample.sources, role);
      return found.length === 0 ? UNASKED : answered(found);
    }),
    { requireAskedByAll: true, subject: `role ${role}` },
  );
  if (declaring === null) return undefined;
  const perSample = declaring.values;
  const shared = perSample[0]!.filter((candidate) => perSample.every((found) => found.some((source) => source.path === candidate.path && source.kind === candidate.kind)));
  const chosen = shared[0];
  if (chosen === undefined) return undefined;
  const values = perSample.map((found) => found.find((source) => source.path === chosen.path && source.kind === chosen.kind)!.value);
  return { source: chosen, values, aliases: shared.slice(1).map(aliasOfDeclared) };
}

// ----------------------------------------------------------- the inventory

/**
 * How many leaves the committed catalogue may hold.
 *
 * The catalogue is taken from the **bound** endpoints only — the ones a field
 * actually came out of — which is what keeps it the size of a product payload
 * rather than the size of the capture. A live Store B render answers a dozen
 * endpoints, and `settings-svc/coverage` and `catalog-svc/categories/
 * category-tree` alone flatten to thousands of leaves; none of them is where a
 * field came from, so none of them is in here.
 *
 * The cap is the second guard, for the day the endpoint a field binds from *is*
 * the enormous one. It is a cap and not a silent truncation: the list is sorted
 * by `(match, path)` before it is cut, so the same investigation keeps the same
 * leaves, and tier 2's `because` says the catalogue was capped and out of how
 * many. A manuscript is committed and read months later; a file that quietly
 * dropped half a catalogue is worse than one that says it did.
 *
 * The cut is alphabetical rather than by how interesting a leaf looks, and that
 * is deliberate. "Anchored, or varying across the samples" is the test
 * `src/reconcile/` applies to decide what is worth showing a client; spending
 * it here as a ranking would make this file a second spelling of that rule, and
 * a catalogue that pre-judged itself is the accident the inventory exists to
 * undo. Arbitrary and stated beats clever and coupled.
 */
export const INVENTORY_MAX_LEAVES = 2_000;

/**
 * Every leaf one endpoint offered, requested or not, with **no type filter**.
 *
 * This is deliberately not `narrow`. `narrow` answers "which leaves could be
 * *this field*" — it takes a declared type, drops anything that will not coerce
 * to it, and collapses two spellings of one fact into a lead and its aliases.
 * Each of those is right for binding and wrong for a catalogue: the type filter
 * is what hides `productData.stock` from the `stock` question in the first
 * place, and a collapsed alias is a leaf the site offers that the artifact
 * would not name. What the two share is the one rule that matters here —
 * present on every sample that answered this endpoint — and they share it
 * through `agree` rather than by spelling it twice.
 *
 * `anchored` is answered here because this is where the rendered text is. The
 * text itself never enters the manuscript (`manuscript.ts` is explicit about
 * that: it is a committed file, and a page's text is not provenance), so the
 * question has to be asked while it is still in hand. No text, no answer —
 * `undefined`, which is not `false`.
 */
function catalogueOf(match: string, samples: readonly Leaf[][], texts: readonly string[] | undefined): InventoryRecord[] {
  const byPath = new Map<string, Observation<TypedValue>[]>();
  for (const [index, leaves] of samples.entries()) {
    for (const leaf of leaves) {
      let observations = byPath.get(leaf.path);
      if (!observations) byPath.set(leaf.path, (observations = Array.from({ length: samples.length }, (): Observation<TypedValue> => UNASKED)));
      observations[index] = answered(leaf.value);
    }
  }

  const out: InventoryRecord[] = [];
  for (const [path, observations] of byPath) {
    // Same policy `narrow` states, asked of the same function: a path one
    // sample has and the next does not is that sample's furniture, not a fact
    // the endpoint offers about the record.
    const agreement = agree(observations, { requireAskedByAll: true, subject: "this path" });
    if (agreement === null) continue;
    out.push({
      match,
      path,
      values: agreement.values,
      // Indexed through `contributors` for the same reason `narrow` is: the
      // text of the sample that answered, never of one that did not.
      ...(texts === undefined ? {} : { anchored: agreement.values.every((value, position) => anchors(value, texts[agreement.contributors[position]!] ?? "")) }),
    });
  }
  return out;
}

// ---------------------------------------------------------------- the cascade

export async function investigate(options: InvestigateOptions): Promise<Manuscript> {
  const view = options.view ?? bank();
  const now = options.now ?? new Date();
  const fields = [...options.fields];
  const site = options.site ?? "the site";

  /**
   * The sample and the binding set are not the same list.
   *
   * A `dead` pick belongs in the sample — reproducing a blank is parity, and on
   * Store A 73% of the catalogue redirects — but it declares no product and
   * carries no payload, so including it in the binding set deletes every
   * candidate for every field ("present on every sample"). `bindable` decides
   * which is which, so this module does not get a second opinion — and it is
   * the same function asked again below, once the fetch has said which pages
   * came back a shell. `NO_SHELLS_YET` is what is known at this line: nothing
   * has been fetched, so no page can be a shell yet.
   */
  const picks: SamplePickRecord[] = options.sample.picks.map((pick) => ({
    url: pick.url,
    stratum: pick.stratum,
    because: pick.because,
    bound: bindable(pick, NO_SHELLS_YET).bind,
  }));
  const bindingUrls = picks.filter((pick) => pick.bound).map((pick) => pick.url);

  const obstacles: Obstacle[] = [];
  /** Pages as the browser rendered them, when a capture kept the HTML. Canary material only. */
  const rendered: PageResponse[] = [];
  for (const excluded of options.sample.excluded) {
    obstacles.push({ kind: "excluded", url: excluded.url, because: excluded.because, evidence: excluded.reason, blocking: false });
  }

  // ---------------------------------------------------------------- tier 1

  const fetched: PageResponse[] = [];
  for (const url of bindingUrls) {
    try {
      fetched.push(await options.sources.fetch(url));
    } catch (error) {
      // A fetch that threw is a URL that never answered, which `classify`
      // already has a reading for. It is not a reason to abandon the run.
      fetched.push({ url, status: 0, body: `${(error as Error).message}` });
    }
  }

  const fetchSources: SourceRecord[] = fetched.map((page) => ({
    url: safeUrl(page.url),
    kind: "plain-fetch" as const,
    ...(page.status === undefined ? {} : { status: page.status }),
    found: 0,
    because: `one plain HTTP request, no browser`,
  }));

  /**
   * Is tier 1 worth attempting on this site at all?
   *
   * `shell-skips-tier-1` reads one plain fetch and says whether the content
   * arrives later — Store B, 25 of 25 fetches returning a JS shell whose
   * answer was in its own `products/detail` call. It is asked of every binding
   * URL and tier 1 is skipped only when it fires on all of them: a site that
   * serves a real page sometimes is still worth the cheapest request.
   *
   * It is asked **before** the blocking question, which is new on 2026-09-22
   * and is half the fix from the first live run. The other half is that the
   * answer is handed to `classifyRun`, because a challenge marker in a page
   * this rule already explains is corroboration rather than a verdict.
   */
  const tier1Verdicts: VerdictLog = [];
  const shellUrls = new Set<string>();
  let shells = 0;
  for (const [index, page] of fetched.entries()) {
    const verdict = view.run("shell-skips-tier-1", { html: page.body ?? "" });
    tier1Verdicts.push({ id: "shell-skips-tier-1", verdict });
    if (!verdict.fires) continue;
    shells += 1;
    shellUrls.add(page.url);
    obstacles.push({ kind: "shell", url: safeUrl(page.url), because: verdict.because, evidence: "shell-skips-tier-1", blocking: false });
    const source = fetchSources[index];
    if (source) source.because = verdict.because;
  }
  const allShells = fetched.length > 0 && shells === fetched.length;

  /**
   * The same question as `bound` above, asked again now that the fetch has
   * answered the half of it the probe could not.
   *
   * Everything below that compares one sample against another — tier 1's
   * `bindRole`, the `takeByKeyNames` fallback, the canary — reads this and
   * nothing else. Three filters that disagreed is what made this the fourth
   * instance of one cause; one map, computed once, is the fix.
   */
  const comparability = new Map(options.sample.picks.map((pick) => [pick.url, bindable(pick, shellUrls)] as const));
  const comparable = (url: string): boolean => comparability.get(url)?.bind === true;
  /**
   * Tier 1's own comparison set, which KTD3 made narrower than `comparable`:
   * an `undeclared` page was served and is read by tiers 2 and 3, and it
   * declares nothing, so in `bindRole`'s "every sample declares this role" it
   * would delete every declared candidate on the pages that declare one.
   */
  const declaring = (url: string): boolean => comparability.get(url)?.tier1 === true;

  /**
   * The render, taken once and shared.
   *
   * Tier 2 is still the only thing that *binds* from a capture, and the
   * Store A run still never reaches for one. What changed is that a run the
   * transport could not settle may now ask for the same render early, to find
   * out whether the shell it fetched fills or refuses — and it must not then
   * pay for a second one.
   */
  const captures: Capture[] = [];
  let capturesTaken = false;
  /** The first render that did not finish, in its own words, for `canaryBecause`. */
  let unsettled: string | undefined;
  const takeCaptures = async (): Promise<Capture[]> => {
    if (capturesTaken) return captures;
    capturesTaken = true;
    const capture = options.sources.capture;
    if (capture === undefined) return captures;
    for (const url of bindingUrls) {
      const taken = await capture(url);
      captures.push(taken);
      for (const obstacle of taken.obstacles ?? []) obstacles.push(obstacle);
      /**
       * A rendered page is the better canary when the plain fetch was a shell:
       * the fingerprint has to be of a page that was actually served.
       *
       * **And it has to be of a whole one.** A canary taken off a half-drawn
       * page fingerprints the frame navvi happened to catch, and every replay
       * from then on compares a finished page against it and reports drift —
       * a false "the site changed" filed for the life of the scraper, from one
       * busy machine at compile time. Under Phase F's gate that false mismatch
       * is also what licenses healing, so the cheapest possible mistake here
       * buys a healer permission to recompile a working field.
       *
       * Refusing to record one is already this module's answer when the page
       * was a shell — `canaryBecause` exists for exactly that — so an
       * unfinished render takes the same road: no canary, and the sentence
       * says the render was starved rather than that the site was empty.
       */
      if (taken.settle !== undefined && taken.settle.outcome !== "quiesced") {
        unsettled ??= `${safeUrl(url)} ${taken.settle.because ?? `ended ${taken.settle.outcome}`}`;
        continue;
      }
      if (taken.html !== undefined && taken.html !== "") rendered.push({ url, status: 200, body: taken.html });
    }
    return captures;
  };

  /**
   * Blocked before bound, and this order is the whole of U3a.
   *
   * Store C's run came back `sku 0/111`, `stock 0/111` and `¡Lo sentimos!`
   * sitting where a product name belongs — 111/111 filled, every type checked.
   * Binding against that page learns the apology as the product name, which is
   * why nothing below this line runs when the transport says the site refused
   * us. `classifyRun` is the authority; this module does not re-derive it.
   *
   * What the first live run added, 2026-09-22: the authority is allowed to say
   * *not yet*. Three Store B URLs came back 2,863 characters of shell with
   * Imperva's always-on resource in the head — no declared product, ~0
   * characters of text, which is the corroboration rule's definition of an
   * interstitial word for word — and the cascade reported `blocked`, skipped
   * every tier, bound nothing and recorded no canary, on a store that renders
   * 86 payloads to a browser on the same machine. So a run whose only refusal
   * evidence is the emptiness of a page `shell-skips-tier-1` already explains
   * comes back `deferred`, and the render it was going to take anyway decides
   * it. The ordering is untouched: this still happens before anything binds,
   * and a confirmed refusal still returns without a single field bound.
   */
  const classifyOptions = {
    view,
    ...(options.apology === undefined ? {} : { apology: options.apology }),
    ...(options.blockedShare === undefined ? {} : { blockedShare: options.blockedShare }),
  };
  let run: RunVerdict = classifyRun({ pages: fetched, shells: [...shellUrls], ...classifyOptions });

  let deferred = false;
  if (run.state === "deferred") {
    deferred = true;
    const taken = await takeCaptures();
    run = settleDeferred(run, { pages: rendered, payloadLeaves: payloadLeaves(taken) }, classifyOptions);
    // The one line this artifact exists for: the plain fetch looked like a
    // refusal, and here is what the render said about it.
    obstacles.push({ kind: "deferred", because: run.because, evidence: "shell-skips-tier-1", blocking: run.state === "blocked" });
  }

  for (const signal of run.signals) {
    obstacles.push({ kind: signal.kind, url: signal.url, because: signal.because, evidence: signal.evidence, blocking: run.state === "blocked" });
  }

  const tiers: TierRecord[] = [];
  const records = new Map<string, FieldRecord>();
  for (const field of fields) {
    records.set(field.name, { field: field.name, ...(field.type === undefined ? {} : { type: field.type }), aliases: [], because: "nothing has looked yet", askModel: false, rejected: [], verdicts: [] });
  }

  if (run.state === "blocked") {
    tiers.push({
      tier: 1,
      name: "declared",
      outcome: "skipped",
      because: `the site is refusing this transport — ${run.because}`,
      asked: fields.map((field) => field.name),
      covered: [],
      sources: fetchSources,
      verdicts: [...tier1Verdicts, ...run.verdicts],
    });
    for (const tier of [2, 3] as const) {
      tiers.push({
        tier,
        name: tier === 2 ? "payload" : "dom",
        outcome: "skipped",
        because:
          tier === 2 && deferred
            ? "the render that would have answered this tier was already taken, to find out whether the plain fetch was a shell or a refusal, and it confirmed the refusal; a blocked run is not compiled from: binding against an error page is how a good scraper is destroyed by its own repair"
            : "a blocked run is not compiled from: binding against an error page is how a good scraper is destroyed by its own repair",
        asked: [],
        covered: [],
        sources: [],
        verdicts: [],
      });
    }
    for (const field of fields) {
      const record = records.get(field.name)!;
      record.because = "the site refused before anything could be read";
    }
    return manuscriptOf({
      site,
      now,
      fields,
      sample: options.sample,
      picks,
      tiers,
      records,
      obstacles,
      verdict: "blocked",
      because: `${run.because}; the remedy is ${run.remedy.action} — ${run.remedy.cost}`,
      canaryBecause: "no canary was recorded: a fingerprint of the page a blocked site serves is a fingerprint of the refusal",
    });
  }

  const declaredSamples: DeclaredSample[] = [];
  /** Fetched, recorded, but left out of the comparison — and the manuscript says which and why. */
  const uncomparable: PageResponse[] = [];
  if (!allShells) {
    for (const [index, page] of fetched.entries()) {
      if (!declaring(page.url)) {
        // A shell among real pages, or (KTD3) a page that declares nothing. It declares nothing, and "present on every
        // sample" would read that as "no field is present anywhere" — which is
        // exactly what it did before 2026-09-23. Its `SourceRecord` keeps the
        // shell verdict written above it, so the run still says it was read.
        uncomparable.push(page);
        continue;
      }
      const reading = readDeclared(page.body ?? "", { view });
      tier1Verdicts.push(...reading.verdicts);
      declaredSamples.push({ url: page.url, sources: reading.sources });
      const source = fetchSources[index];
      if (source) {
        source.found = reading.sources.length;
        source.because = `${reading.sources.length} declared finding(s) from one plain HTTP request, no browser`;
      }
    }
  }

  const covered1: string[] = [];
  if (!allShells && declaredSamples.length > 0) bindDeclared(declaredSamples, fields, records, covered1, view);

  /**
   * The stopping question, and it is not the binding question.
   *
   * `declared-covers-spec` is handed the *bound* record — what tier 1 settled,
   * per field — and answers whether the run may stop before a browser is
   * opened. On Store A all five requested fields were stated by the page, so
   * tiers 2 and 3 were pure waste, and the run spent them anyway for want of
   * anyone asking.
   */
  let stop = false;
  if (!allShells && fields.length > 0) {
    const declared: Record<string, TypedValue> = {};
    for (const field of fields) {
      const record = records.get(field.name)!;
      if (record.path !== undefined) declared[field.name] = record.values?.[0] ?? null;
    }
    const verdict = coversSpec(declared, fields.map((field) => field.name), view);
    tier1Verdicts.push({ id: "declared-covers-spec", verdict });
    stop = verdict.fires;
  }

  tiers.push({
    tier: 1,
    name: "declared",
    outcome: allShells ? "skipped" : "ran",
    because: allShells
      ? `shell-skips-tier-1 fired on ${shells} of ${fetched.length} plain fetches: the content arrives later, so the cheapest request cannot answer here`
      : `${declaredSamples.reduce((total, sample) => total + sample.sources.length, 0)} declared finding(s) over ${declaredSamples.length} plain fetch(es)` +
        (uncomparable.length === 0
          ? ""
          : `; ${uncomparable.length} of ${fetched.length} fetch(es) left out of the comparison — ${comparability.get(uncomparable[0]!.url)?.because ?? "nothing there to compare"}`),
    asked: fields.map((field) => field.name),
    covered: covered1,
    sources: fetchSources,
    verdicts: tier1Verdicts,
  });

  // ---------------------------------------------------------------- tier 2

  const uncovered1 = fields.filter((field) => records.get(field.name)!.path === undefined);
  const covered2: string[] = [];
  const tier2Sources: SourceRecord[] = [];
  let tier2: Pick<TierRecord, "outcome" | "because">;
  /**
   * The leaf catalogue, and the sentence tier 2 adds about it.
   *
   * Left `undefined` unless an endpoint was actually bound from. That is not
   * the same as an empty catalogue and `src/reconcile/` reads the difference:
   * absent means "no endpoint was the product endpoint, so there is nothing to
   * take a catalogue off", and it falls back to the rejection set and says in
   * the artifact that it did. An empty array would claim a catalogue was taken
   * and found nothing, which on a run that bound no payload is a lie.
   */
  let inventory: InventoryRecord[] | undefined;

  if (stop) {
    tier2 = { outcome: "skipped", because: "declared-covers-spec fired: every requested field is stated by the page itself, so no render, no capture, no compile" };
  } else if (uncovered1.length === 0) {
    tier2 = { outcome: "skipped", because: "tier 1 covered every requested field" };
  } else if (options.sources.capture === undefined) {
    tier2 = { outcome: "skipped", because: `no capture was supplied, so the payloads the page fetches for itself were never seen; ${uncovered1.map((field) => field.name).join(", ")} stay uncovered` };
  } else {
    // Taken here, or already taken above to settle a `deferred` verdict. Either
    // way it is one render per sample and the obstacles it met are recorded
    // once, by `takeCaptures`.
    const captures = await takeCaptures();

    /**
     * Anchoring is tier 2's sharpest filter and it needs the rendered text of
     * every sample. One sample without it and the comparison is uneven, so it
     * is all or nothing — and the manuscript says which, because a binding made
     * without the anchor survived three checks rather than four.
     */
    const texts = captures.map((capture) => capture.text);
    const pageText = texts.every((text) => text !== undefined && text !== "") ? (texts as string[]) : undefined;

    // Group every capture by endpoint. Which of those endpoints is a source is
    // the question the `agree` call below answers, and it is not "the ones
    // every sample asked" any more — see the argument there.
    const perSample = captures.map((capture) => {
      const grouped = new Map<string, CapturedResponse[]>();
      for (const response of capture.responses) {
        const key = endpointKey(response.url);
        const bucket = grouped.get(key);
        if (bucket) bucket.push(response);
        else grouped.set(key, [response]);
      }
      return grouped;
    });

    /**
     * *Answered* by at least two — and the live run of 2026-09-22 is the whole
     * of why "asked" and "answered" are two questions rather than one.
     *
     * The rule this replaces demanded a usable response from every sample, so a
     * sample the store could not serve deleted the endpoint for all of them.
     * Three Store B URLs rendered 70/86/51 payloads; the third,
     * `paracetamol-500-mg-16-comprimidos/881926.html`, got 401 then 500 then
     * 500 from `catalog-svc/products/detail/*` and rendered nothing but
     * site chrome. That one broken product took `products/detail` — the single
     * endpoint Store B's whole answer lives in — out of the run, and tier 2
     * reported ten endpoints, every one of them basket, zones and Contentful
     * noise, and bound 0 of 5 fields.
     *
     * This is the same defect `bindingUrls` already guards against one layer
     * up, restated: a sample with nothing in it does not merely fail to
     * contribute, it *deletes every candidate for every field*, because every
     * filter below here is an intersection. So a sample that did not answer is
     * dropped from that endpoint's comparison rather than allowed to veto it.
     * The rule as first written also required the endpoint to have been *asked*
     * everywhere, and that half is the subject of the second dated section
     * below; it no longer holds.
     *
     * Two is the floor because `narrow`'s variation check needs two samples to
     * mean anything. With a single capture, one answer is the whole comparison
     * and the floor is one.
     *
     * On 2026-09-23 the rule stopped living here. `agree` in `agree/agree.ts`
     * owns it for the four places that intersect samples, and this call is
     * where tier 2 states which policy it wants. The wording below is the
     * wording that had to argue this compile, and it moved with the rule.
     *
     * ## And on 2026-09-23, the other half of it
     *
     * The paragraph above was written about *answered* and left *asked*
     * strict, which is the 2026-09-22 lesson learned once and applied to one
     * of the two halves of one rule. A live render misses a call
     * nondeterministically — a fetch still in flight when the capture closed,
     * a lazy component that did not come into view — and an endpoint nobody
     * failed to serve is deleted for every sample because one of them never
     * got round to asking. a live smoke run against Store B returned
     * `0 of 5 bound` instead of `3 of 5` roughly one run in three — observed
     * three times on 2026-09-23 — and the missing call was `products/detail`
     * every time.
     *
     * So `requireAskedByAll` is `false` here, and the argument it overrules —
     * "an endpoint only two of three pages ever call may not be a per-product
     * endpoint at all" — is answered by what is measured to be doing that job
     * rather than by this veto:
     *
     *  - **The floor already refuses a one-sample endpoint.** A sample that
     *    answered necessarily asked, so `contributors >= floor` is a floor on
     *    *asked* too, and `floor` is `min(2, samples)`. An endpoint one page
     *    called is still not a source, on any run with more than one capture;
     *    writing the floor out again against `asked` would only be a second
     *    spelling of that.
     *  - **The veto was never what kept the furniture out.** On 2026-09-22 ten
     *    endpoints passed `asked by every sample` — the basket, the delivery
     *    zones, the coverage table, the CMS, the tracking beacon — and bound
     *    **zero** of five fields between them. What rejected them is
     *    everything below this line: the declared type, `no-variation-no-field`
     *    over payloads that answer every page identically, the anchor against
     *    what each page actually showed a reader, and `named` ordering, which
     *    takes a field from the endpoint whose *key names* it before one that
     *    merely had nothing else to offer.
     *
     * What is genuinely given up is the endpoint two of three pages call
     * *because they are different pages* — `products/recommendations`,
     * `products-bundled`. That is given up knowingly: a render that missed one
     * call and a widget that only two pages carry are the same observation
     * here, two of three asked, and no counting rule tells them apart. The
     * trade is a class of endpoint the four filters above already reject
     * against a whole run binding nothing one time in three, and the
     * manuscript says which endpoints rested on fewer than all the samples so
     * that a reader can see the trade being made rather than infer it.
     *
     * The key set is the **union** over the samples and not sample 1's call
     * list, which was harmless while `asked` was strict — a key sample 1 never
     * asked was rejected anyway — and is the whole fix once it is tolerant.
     * Iterating sample 1's keys would have made the outcome depend on *which*
     * sample dropped the call: an endpoint sample 1 never asked for is not
     * even a key to compare, so a third of the runs that flake would still
     * bind nothing and the flag would read as fixed. Sorted, because two runs
     * of one investigation must produce one manuscript.
     */
    const floor = Math.min(2, perSample.length);
    const answering = new Map<string, Agreement<CapturedResponse>>();
    /** Which samples never called an endpoint the others did — the tier's own record, for the manuscript. */
    const neverAsked = new Map<string, number[]>();
    for (const key of [...new Set(perSample.flatMap((grouped) => [...grouped.keys()]))].sort()) {
      const missing: number[] = [];
      const agreement = agree(
        perSample.map((grouped, index) => {
          const bucket = grouped.get(key);
          if (bucket === undefined) {
            missing.push(index);
            return UNASKED;
          }
          const newest = newestUsable(bucket);
          return newest === null ? unservable<CapturedResponse>(`asked ${bucket.length} time(s), never usably answered`) : answered(newest);
        }),
        { floor, requireAskedByAll: false, subject: "this endpoint" },
      );
      if (agreement === null) continue;
      answering.set(key, agreement);
      if (missing.length > 0) neverAsked.set(key, missing);
    }
    const keys = [...answering.keys()].sort();

    /**
     * What each sample page says it is, for KTD4's question below: the id or
     * slug in its URL, the sku and name it declared about itself (read by tier
     * 1 whether or not the spec asked for them), and its rendered headline.
     * Indexed like `captures`, which is `bindingUrls` order.
     */
    const identities: PageIdentity[] = pageIdentities(
      bindingUrls.map((url, index) => ({
        url,
        declared: (declaredSamples.find((entry) => entry.url === url)?.sources ?? [])
          .filter((source) => {
            const role = roleOfDeclared(source);
            return role === "sku" || role === "name";
          })
          .map((source) => source.value),
        headline: headlineOf(captures[index]?.html),
      })),
    );

    const leavesByKey = new Map<string, Leaf[][]>();
    /** The rendered text of *this endpoint's* samples, in its own order — anchoring compares like with like. */
    const textByKey = new Map<string, string[] | undefined>();
    /**
     * The leaf that shows each endpoint is about the page it was captured on,
     * or `undefined` when none does. An endpoint without one binds nothing.
     */
    const anchorByKey = new Map<string, IdentityAnchor | undefined>();
    for (const key of keys) {
      const agreement = answering.get(key)!;
      const responses = agreement.values;
      const leaves = responses.map((response) => flatten(response.body));
      leavesByKey.set(key, leaves);
      textByKey.set(key, pageText === undefined ? undefined : agreement.contributors.map((index) => pageText[index]!));
      anchorByKey.set(
        key,
        identityAnchor(
          leaves,
          agreement.contributors.map((index) => identities[index] ?? { exact: [], slugs: [] }),
        ),
      );
      for (const [position, response] of responses.entries()) {
        tier2Sources.push({
          url: safeUrl(response.url),
          kind: "payload",
          status: response.status,
          match: endpointMatch(key),
          found: leaves[position]!.length,
          because:
            `the page fetched this for itself; ${leaves[position]!.length} leaves flattened` +
            `${pageText === undefined ? ", unanchored (no rendered text was supplied)" : ", anchored against what the page showed"}` +
            `${agreement.silent.length === 0 ? "" : `; ${agreement.because}`}`,
        });
      }
    }

    /**
     * Every endpoint's answer for every uncovered field, computed once.
     *
     * A field is taken from an endpoint that **named** it — where
     * `key-names-carry-the-signal` fired — before one that merely had nothing
     * else to offer. `bindField` settles a lone survivor without asking
     * anybody, which is right within one payload and wrong across several: a
     * thin endpoint with one number in it (a stock service answering
     * `{available: 7}`) survives the filter for *any* money field and would
     * otherwise outrank the detail endpoint that names `price-list-std`. Named
     * first, lone survivors second.
     */
    const bindings = new Map<string, Map<string, ReturnType<typeof bindField>>>();
    for (const key of keys) {
      const perField = new Map<string, ReturnType<typeof bindField>>();
      for (const field of uncovered1) perField.set(field.name, bindField(field.name, leavesByKey.get(key)!, { type: field.type, pageText: textByKey.get(key), view }));
      bindings.set(key, perField);
    }
    /**
     * KTD4, the identity half: an endpoint that never says which product it is
     * about cannot be the source of a fact about this one. Its candidates are
     * still read and recorded — a reader deciding whether the refusal was right
     * needs to see what was refused — but nothing is chosen from it.
     */
    const anchored = (key: string): boolean => anchorByKey.get(key) !== undefined;
    const notThisPage = (key: string): string =>
      `${endpointMatch(key)} is not this page's: none of its leaves is the page's own identity (the id or slug in its URL, the sku or name it declares, its headline) on every sample, so nothing it offers can be a fact about this product — a recommendations or basket payload varies with the page and describes other products`;
    const named = (key: string, binding: ReturnType<typeof bindField> | undefined): boolean =>
      anchored(key) && binding !== undefined && binding.path !== undefined && !binding.askModel && binding.verdicts.some((entry) => entry.verdict.fires && entry.verdict.pick === binding.path);
    const settled = (key: string, binding: ReturnType<typeof bindField> | undefined): boolean => anchored(key) && binding !== undefined && binding.path !== undefined && !binding.askModel;

    /**
     * Which endpoint first. A site answers several calls and only one of them
     * is the product; the one that *names* the most uncovered fields is it.
     * Ties break on the key, so the choice is reproducible.
     *
     * This ordering is a preference and not an identity test, and for a while
     * it was the only one: an endpoint that named nothing still won any field
     * whose lone survivor it held. `anchored` above is the identity test now,
     * and an endpoint that fails it never names or settles anything.
     */
    const namedCount = new Map<string, number>();
    for (const key of keys) namedCount.set(key, uncovered1.filter((field) => named(key, bindings.get(key)!.get(field.name))).length);
    const ordered = [...keys].sort((a, b) => (namedCount.get(b) ?? 0) - (namedCount.get(a) ?? 0) || a.localeCompare(b));

    /** Each field's pick, before any of them is committed. */
    const picks = new Map<string, string | undefined>();
    for (const field of uncovered1) {
      picks.set(field.name, ordered.find((key) => named(key, bindings.get(key)!.get(field.name))) ?? ordered.find((key) => settled(key, bindings.get(key)!.get(field.name))));
    }

    /**
     * KTD4, the uniqueness half: one `(match, path)` is one fact.
     *
     * Each field above picked on its own, and nothing asked whether the leaf it
     * picked had already been spent — which is how `sku` and `stock` both came
     * out of one `total` on 2026-09-23. Two fields settling on one path is not
     * two answers that agree; it is one leaf that was the least-bad reading for
     * both, and at most one of them can be right. Picking which is a guess, so
     * neither is bound here: both go on to the next tier, and each says which
     * path it shared and with whom.
     */
    const pathOf = (name: string): string | undefined => {
      const key = picks.get(name);
      return key === undefined ? undefined : `${endpointMatch(key)}:${bindings.get(key)!.get(name)!.path!}`;
    };
    const sharers = new Map<string, string[]>();
    for (const field of uncovered1) {
      const path = pathOf(field.name);
      if (path === undefined) continue;
      const list = sharers.get(path);
      if (list) list.push(field.name);
      else sharers.set(path, [field.name]);
    }
    const sharedBy = (name: string): { path: string; others: string[] } | undefined => {
      const path = pathOf(name);
      const list = path === undefined ? undefined : sharers.get(path);
      return list === undefined || list.length < 2 ? undefined : { path: path!, others: list.filter((other) => other !== name) };
    };

    /** The endpoints a field actually came out of — the catalogue's whole scope. */
    const boundKeys = new Set<string>();

    for (const field of uncovered1) {
      const record = records.get(field.name)!;
      const shared = sharedBy(field.name);
      const sharedBecause =
        shared === undefined
          ? undefined
          : `shared path: ${shared.path} was the best reading for ${field.name} and for ${shared.others.join(" and ")}; one leaf cannot be ${shared.others.length + 1} facts and choosing between them would be a guess, so none of them is bound at tier 2 and each goes on to the next tier`;
      const chosen = shared === undefined ? picks.get(field.name) : undefined;

      for (const key of ordered) {
        const binding = bindings.get(key)!.get(field.name)!;
        const match = endpointMatch(key);
        record.verdicts.push(...binding.verdicts);
        for (const candidate of binding.candidates) {
          if (key === chosen && candidate.path === binding.path) continue;
          const path = `${match}:${candidate.path}`;
          record.rejected.push({
            tier: 2,
            path,
            values: candidate.values,
            because:
              shared !== undefined && path === shared.path
                ? sharedBecause!
                : !anchored(key)
                  ? notThisPage(key)
                  : key === chosen
                    ? `${binding.path ?? "another leaf"} was bound instead`
                    : chosen === undefined
                      ? binding.because
                      : `${endpointMatch(chosen)} named ${field.name} and this endpoint did not`,
          });
        }
        // The leaves the bank called machinery, refused by rule id — the
        // reason `narrow`'s anchor filter used to give silently.
        for (const refused of binding.machinery) {
          record.rejected.push({ tier: 2, path: `${match}:${refused.path}`, values: refused.values, because: `${MACHINERY_RULE}: ${refused.because}`, heuristic: MACHINERY_RULE });
        }
      }

      if (sharedBecause !== undefined) {
        record.because = sharedBecause;
        record.askModel = false;
        continue;
      }

      if (chosen === undefined) {
        // Nothing settled it anywhere. Report the best endpoint's reading
        // rather than the last one looked at: `askModel` means a table was
        // narrowed and not settled, and that table is the one worth paying a
        // model for.
        const best = ordered[0] === undefined ? undefined : bindings.get(ordered[0])!.get(field.name);
        if (best) {
          record.askModel = best.askModel;
          record.because = best.because;
        }
        continue;
      }
      const binding = bindings.get(chosen)!.get(field.name)!;
      record.tier = 2;
      record.source = "network";
      record.match = endpointMatch(chosen);
      record.path = binding.path!;
      record.values = binding.values ?? [];
      // A tier-2 alias is another leaf of the same flattened payload, so the
      // endpoint it is read out of is the binding's. `bindField` deals in paths
      // because that is all a payload has; the source is attached here, where
      // the tier is known.
      record.aliases = binding.aliases.map((path) => ({ path, source: "network" as const, match: endpointMatch(chosen) }));
      record.because = binding.because;
      record.askModel = false;
      boundKeys.add(chosen);
      covered2.push(field.name);
    }

    /**
     * The catalogue, off the endpoints a field was bound from.
     *
     * U4 asks the manuscript two questions the rejection set cannot answer —
     * *what does this site offer that nobody asked for*, and *what did the
     * declared type refuse before it was ever a candidate* — and both of them
     * are questions about the product endpoint, not about the brief. So the
     * scope is the bound endpoints and the filter is nothing at all: no type,
     * no anchor, no variation. `src/reconcile/` applies whatever test its
     * artifact needs; this list is the evidence it applies them to, and a
     * catalogue that pre-filtered itself would be the same accident of the
     * brief all over again, one layer down.
     */
    const catalogue = [...boundKeys].sort().flatMap((key) => catalogueOf(endpointMatch(key), leavesByKey.get(key)!, textByKey.get(key)));
    catalogue.sort((a, b) => a.match.localeCompare(b.match) || a.path.localeCompare(b.path));
    if (boundKeys.size > 0) inventory = catalogue.slice(0, INVENTORY_MAX_LEAVES);
    const inventoryBecause =
      inventory === undefined
        ? "; no leaf catalogue: no field was bound from a payload, so no endpoint is this site's product endpoint and there is nothing to take one off"
        : `; leaf catalogue: ${inventory.length} leaves` +
          (catalogue.length > inventory.length ? ` of the ${catalogue.length} offered, capped at ${INVENTORY_MAX_LEAVES} in (endpoint, path) order` : "") +
          ` from the ${boundKeys.size} bound endpoint(s), requested or not and unfiltered by type` +
          (pageText === undefined ? ", with the anchor question unasked" : "");

    /**
     * Which endpoints rested on fewer than all the samples, and who did not ask.
     *
     * Every one of these would have been deleted before 2026-09-23, so a
     * manuscript that did not say so would be silent about the change that
     * produced it — and about the one risk tolerating `asked` takes, which is
     * an endpoint some pages carry and others do not. Each endpoint's
     * `SourceRecord` carries `agree`'s own sentence about the same samples;
     * this is the tier-level index of them, because a reader asking "what did
     * this run rest on" should not have to read every source to find out.
     */
    const partial = keys.filter((key) => neverAsked.has(key));
    const askedBecause =
      partial.length === 0
        ? ""
        : `; ${partial.length} endpoint(s) were not called by every sample and were compared over the ones that did, rather than deleted for all of them: ` +
          partial.map((key) => `${endpointMatch(key)} (${neverAsked.get(key)!.map((index) => `sample ${index + 1}`).join(", ")} never asked it)`).join("; ");

    /**
     * The two KTD4 refusals, said at the tier. A run that bound fewer fields
     * than it used to should say which endpoints it stopped trusting and which
     * paths it stopped spending twice, not leave a reader to diff rejections.
     */
    const strangers = keys.filter((key) => !anchored(key));
    const identityBecause =
      strangers.length === 0 ? "" : `; ${strangers.length} endpoint(s) refused as not this page's, because no leaf is the page's own identity: ${[...new Set(strangers.map(endpointMatch))].join(", ")}`;
    const collisions = [...sharers.entries()].filter(([, names]) => names.length > 1);
    const sharedPathBecause =
      collisions.length === 0 ? "" : `; ${collisions.map(([path, names]) => `shared path ${path} left ${names.join(" and ")} unbound`).join("; ")}`;

    tier2 = {
      outcome: "ran",
      because: `${keys.length} endpoint(s) the page fetched for itself, over ${captures.length} rendered sample(s)${pageText === undefined ? "; unanchored, because no rendered text was supplied" : ""}${identityBecause}${sharedPathBecause}${askedBecause}${inventoryBecause}`,
    };
  }

  tiers.push({
    tier: 2,
    name: "payload",
    ...tier2,
    asked: uncovered1.map((field) => field.name),
    covered: covered2,
    sources: tier2Sources,
    verdicts: [],
  });

  // ---------------------------------------------------------------- tier 3

  const uncovered2 = fields.filter((field) => records.get(field.name)!.path === undefined);
  const asked3 = uncovered2.map((field) => field.name);
  const covered3: string[] = [];
  let tier3: Pick<TierRecord, "outcome" | "because" | "sources">;
  const handedOver = `${asked3.join(", ")} survived both cheap tiers`;
  if (asked3.length === 0) {
    tier3 = {
      outcome: "skipped",
      because: stop
        ? "declared-covers-spec fired: there is no DOM alternative to gate, because nothing was compiled"
        : "the declared data and the captured payloads covered every requested field; the DOM compiler is the exception, and this was not it",
      sources: [],
    };
  } else if (options.sources.dom === undefined) {
    tier3 = {
      outcome: "requested",
      because: `${handedOver}; no DOM compiler was supplied to this investigation, so tier 3 is recorded as asked for ${asked3.length === 1 ? "it" : "them"} and did not run`,
      sources: [],
    };
  } else if (bindingUrls.length === 0) {
    tier3 = {
      outcome: "skipped",
      because: `${handedOver}; no sampled URL is bindable, so there is no page to render and nothing for the DOM compiler to read`,
      sources: [],
    };
  } else {
    /**
     * Only the uncovered fields, and that is KTD2 rather than thrift. A field
     * tier 1 or 2 already bound has a reading the site stated about itself;
     * asking a chooser to pick a DOM node for it anyway is how the 2026-09-22
     * compiler produced `body.one-col.christmas-pattern` for a store that was
     * stating every field in its own `<meta>` tags.
     */
    const answer = await options.sources.dom({ fields: uncovered2, urls: bindingUrls });
    for (const binding of answer.bindings) {
      const record = records.get(binding.field);
      if (record === undefined || record.path !== undefined) continue;
      record.tier = 3;
      record.source = "dom";
      record.path = binding.path;
      record.selector = binding.selector;
      if (binding.attr !== undefined) record.attr = binding.attr;
      record.values = binding.values;
      record.aliases = [];
      record.because = binding.because;
      record.askModel = false;
      record.decision = binding.decision;
      covered3.push(binding.field);
    }
    for (const refusal of answer.refused) {
      const record = records.get(refusal.field);
      if (record === undefined || record.path !== undefined) continue;
      record.rejected.push({ tier: 3, path: refusal.path, values: refusal.values, because: refusal.because });
      record.because = refusal.because;
    }
    for (const entry of answer.unanswered) {
      const record = records.get(entry.field);
      if (record === undefined || record.path !== undefined) continue;
      record.because = entry.because;
    }
    tier3 = answer.ran
      ? { outcome: "ran", because: `${handedOver}; ${answer.because}`, sources: answer.sources }
      : { outcome: "requested", because: `${handedOver}; ${answer.because}`, sources: answer.sources };
  }
  tiers.push({ tier: 3, name: "dom", ...tier3, asked: asked3, covered: covered3, verdicts: [] });
  const uncovered = fields.filter((field) => records.get(field.name)!.path === undefined).map((field) => field.name);

  for (const field of fields) {
    const record = records.get(field.name)!;
    if (record.path === undefined && record.because === "nothing has looked yet") {
      record.because = "no tier that ran offered a candidate for this field";
    }
  }

  // ----------------------------------------------------------------- canary

  // A render is always a page that was served; a plain fetch is one only when
  // `bindable` says so — the same answer tier 1 compared against, not a second
  // filter that happens to agree today.
  const canary = pickCanary([...rendered, ...fetched.filter((page) => comparable(page.url))], now);

  return manuscriptOf({
    site,
    now,
    fields,
    sample: options.sample,
    picks,
    tiers,
    records,
    obstacles,
    ...(inventory === undefined ? {} : { inventory }),
    ...(canary === undefined ? {} : { canary }),
    canaryBecause:
      canary === undefined
        ? unsettled !== undefined
          ? `no canary was recorded: the render did not finish (${unsettled}), so the only page that could have been fingerprinted was a frame of one — and a canary taken off a half-drawn page is a false "the site changed" filed against every replay from here on`
          : `no canary was recorded: none of the ${fetched.length} page(s) read was a page a reader was served — a fingerprint taken off a shell resolves against anything, and a canary that always resolves turns every future refusal into drift`
        : `${safeUrl(canary.url)} fingerprinted: ${canary.words.length} words and ${canary.textChars} characters of text${canary.declaredProduct ? ", declaring a product" : ", declaring no product"}`,
    verdict: uncovered.length === 0 ? "covered" : "partial",
    because:
      uncovered.length === 0
        ? `every requested field is bound: ${fields.map((field) => `${field.name} at tier ${records.get(field.name)!.tier}`).join(", ")}`
        : tier3.outcome === "ran"
          ? `${fields.length - uncovered.length} of ${fields.length} fields bound across the three tiers; no tier bound ${uncovered.join(", ")}`
          : `${fields.length - uncovered.length} of ${fields.length} fields bound from declared data and captured payloads; ${uncovered.join(", ")} need the DOM compiler`,
  });
}

// ------------------------------------------------------------ tier 1 binding

/**
 * Bind the requested fields to what the pages declared.
 *
 * Roles first (`roles.ts`: the published vocabularies are a lookup, not a
 * search), then `bindField` over the declared leaves for a field name neither
 * vocabulary knows.
 *
 * **Tier 1 does not anchor**, and that is a decision rather than an omission.
 * Anchoring asks whether a value appears in what the page showed a reader, which
 * is exactly right for a captured payload full of telemetry and someone else's
 * products. Applied to a declaration it deletes the two fields tier 1 is best
 * at: Store A's sku `8820237` is never rendered anywhere on the page, and its
 * availability renders as "Disponible" while the machine reading is "in stock".
 * A declared `Product` node has already been vouched for by
 * `json-ld-needs-product-node`; it does not also have to be visible.
 */
function bindDeclared(samples: readonly DeclaredSample[], fields: readonly RequestedField[], records: Map<string, FieldRecord>, covered: string[], view: Bank): void {
  const claimed = new Set<DeclaredRole>();

  for (const field of resolutionOrder(fields, (entry) => entry.name)) {
    const record = records.get(field.name)!;
    const roles = acceptedRoles(field.name, claimed);

    let bound: { role: DeclaredRole; binding: DeclaredBinding } | undefined;
    for (const role of roles) {
      const binding = bindRole(samples, role);
      if (binding === undefined) {
        record.rejected.push({ tier: 1, path: `role:${role}`, values: [], because: `no declaration of role ${role} is present on all ${samples.length} binding sample(s)` });
        continue;
      }
      /**
       * A value identical across every sample is not a field. Store A's
       * `productName` came back as "Store A" on all 33 samples; the rule
       * catches it without knowing anything about schema.org, and it is the
       * same invariant the client admission loop applies *after* a compile, moved
       * to where it prevents the defect instead of detecting it.
       */
      if (binding.values.length >= 2) {
        const verdict = view.run("no-variation-no-field", { field: field.name, values: binding.values.map((value) => (typeof value === "boolean" ? String(value) : value)) });
        record.verdicts.push({ id: "no-variation-no-field", verdict });
        if (verdict.fires) {
          record.rejected.push({ tier: 1, path: binding.source.path, values: binding.values, because: verdict.because });
          continue;
        }
      }
      bound = { role, binding };
      break;
    }

    if (bound === undefined) {
      // Neither vocabulary placed this field, or every role it accepts was
      // refused. Rank the declared leaves on their key names rather than
      // dropping the field — an unusual name is a ranking problem, not a
      // missing declaration.
      if (roles.length === 0) takeByKeyNames(samples, field, record, covered, view);
      continue;
    }

    claimed.add(bound.role);
    const { source, values, aliases } = bound.binding;
    record.tier = 1;
    record.source = source.source;
    record.path = source.path;
    record.selector = source.selector;
    if (source.attr !== undefined) record.attr = source.attr;
    if (source.entity !== undefined) record.entity = source.entity;
    record.values = values;
    record.aliases = aliases;
    record.askModel = false;
    record.because = `the page declares ${field.name} as ${source.kind} ${source.path} (role ${bound.role}), stated about itself in one plain HTTP request`;
    covered.push(field.name);
  }
}

/** The fallback: no published vocabulary names this field, so rank the declared leaves the way tier 2 ranks a payload. */
function takeByKeyNames(samples: readonly DeclaredSample[], field: RequestedField, record: FieldRecord, covered: string[], view: Bank): void {
  const leaves = samples.map((sample) => sample.sources.map((source) => ({ path: source.path, value: source.value })));
  const binding = bindField(field.name, leaves, { type: field.type, view });
  record.verdicts.push(...binding.verdicts);
  for (const candidate of binding.candidates) {
    if (candidate.path === binding.path) continue;
    // How to read the loser, so a chooser that later picks it over the binding
    // (U6) compiles it through its own declaration and not the winner's.
    const declared = samples[0]!.sources.find((entry) => entry.path === candidate.path);
    record.rejected.push({
      tier: 1,
      path: candidate.path,
      values: candidate.values,
      because: binding.askModel ? binding.because : `${binding.path ?? "another declaration"} was bound instead`,
      ...(declared === undefined ? {} : { read: aliasOfDeclared(declared) }),
    });
  }
  record.askModel = binding.askModel;
  record.because = binding.because;
  if (binding.path === undefined || binding.askModel) return;
  const source = samples[0]!.sources.find((entry) => entry.path === binding.path);
  if (source === undefined) return;
  record.tier = 1;
  record.source = source.source;
  record.path = source.path;
  record.selector = source.selector;
  if (source.attr !== undefined) record.attr = source.attr;
  if (source.entity !== undefined) record.entity = source.entity;
  record.values = binding.values ?? [];
  // Tier 1's aliases are whole declarations, not paths off one document: the
  // binding may be a JSON-LD path and its alias an OpenGraph property, read
  // through a different selector entirely. Each one is looked back up so it
  // carries how to read itself; a path with no declaration behind it on the
  // first sample is dropped rather than compiled under the binding's source.
  record.aliases = binding.aliases
    .map((path) => samples[0]!.sources.find((entry) => entry.path === path))
    .filter((entry): entry is DeclaredSource => entry !== undefined)
    .map(aliasOfDeclared);
  covered.push(field.name);
}

// ----------------------------------------------------------------- the canary

/**
 * A page that definitely worked, fingerprinted now so a run months later can
 * tell drift from refusal.
 *
 * Preference order matters: a page that declares a product is one the site
 * served properly, and the declared-`Product` conjunct is the load-bearing half
 * of `checkCanary` — word overlap alone would not have caught Store C, whose
 * apology keeps half the canary's vocabulary.
 *
 * Shells never reach here: the caller filters them out, and takes a rendered
 * page over a plain fetch when a capture kept one. A fingerprint of ten
 * characters and two words resolves against anything, and a canary that always
 * resolves reads every future refusal as drift — which is the one call
 * `blocked.ts` exists to get right.
 */
function pickCanary(pages: readonly PageResponse[], now: Date): CanaryFingerprint | undefined {
  const usable = pages.filter((page): page is PageResponse & { body: string; status: number } => typeof page.body === "string" && page.body !== "" && typeof page.status === "number");
  const chosen = usable.find((page) => declaresProduct(page.body)) ?? usable[0];
  return chosen === undefined ? undefined : recordCanary(chosen, { now });
}

// ------------------------------------------------------------- the manuscript

interface Assembly {
  site: string;
  now: Date;
  fields: readonly RequestedField[];
  sample: SampleChoice;
  picks: SamplePickRecord[];
  tiers: TierRecord[];
  records: Map<string, FieldRecord>;
  obstacles: Obstacle[];
  /** Absent unless tier 2 bound a field from a payload; see the tier-2 block. */
  inventory?: InventoryRecord[];
  canary?: CanaryFingerprint;
  canaryBecause: string;
  verdict: Manuscript["verdict"];
  because: string;
}

/** Everything in a deterministic order, so a diff of two manuscripts is a real change. */
function manuscriptOf(parts: Assembly): Manuscript {
  const fields = parts.fields.map((field) => parts.records.get(field.name)!);
  const obstacles = [...parts.obstacles].sort(
    (a, b) => Number(b.blocking) - Number(a.blocking) || a.kind.localeCompare(b.kind) || (a.url ?? "").localeCompare(b.url ?? "") || a.because.localeCompare(b.because),
  );
  return {
    version: 1,
    site: parts.site,
    recordedAt: parts.now.toISOString(),
    requested: parts.fields.map((field) => ({ name: field.name, ...(field.type === undefined ? {} : { type: field.type }) })),
    sample: {
      because: parts.sample.because,
      considered: parts.sample.considered,
      picks: parts.picks,
      unfilled: [...parts.sample.unfilled],
      excluded: [...parts.sample.excluded],
    },
    tiers: parts.tiers,
    fields,
    uncovered: fields.filter((field) => field.path === undefined).map((field) => field.field),
    ...(parts.inventory === undefined ? {} : { inventory: parts.inventory }),
    obstacles,
    ...(parts.canary === undefined ? {} : { canary: parts.canary }),
    canaryBecause: parts.canaryBecause,
    verdict: parts.verdict,
    because: parts.because,
  };
}
