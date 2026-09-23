import { bank, type Bank } from "../heuristics/index.js";
import { declaresProduct } from "../heuristics/rules/investigate.js";
import type { TypedValue } from "../scraper/extract.js";
import { bindField } from "./bind.js";
import { classifyRun, recordCanary, settleDeferred, type ApologyOptions, type CanaryFingerprint, type PageResponse, type RunVerdict } from "./blocked.js";
import { coversSpec, readDeclared, type DeclaredSource } from "./declared.js";
import { safeUrl, type CapturedResponse } from "./har.js";
import { flatten, type Leaf } from "./leaves.js";
import type { FieldRecord, Manuscript, Obstacle, RejectionRecord, RequestedField, SamplePickRecord, SourceRecord, TierRecord, VerdictLog } from "./manuscript.js";
import { KIND_PRECEDENCE, acceptedRoles, resolutionOrder, roleOfDeclared, type DeclaredRole } from "./roles.js";
import { classify, type SampleChoice } from "./sample.js";

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
 *  - **It does not fetch, render or drive a browser.** Both are callbacks
 *    (`Sources`), so the whole cascade is offline-testable and a HAR stands in
 *    for the browser without this module knowing. That is not only ergonomics:
 *    the value of the cascade is the call that is *not* made, and a test can
 *    only assert `capture` was never called if `capture` is something it owns.
 *  - **It does not generate DOM candidates.** That is `src/compile/`, it needs a
 *    live page, and it costs a model. What happens here is the *decision* that
 *    it runs at all, and the record of what it was asked for.
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
}

/**
 * Where the bytes come from. Both are callbacks and `capture` is optional,
 * because a run that stops at tier 1 must be able to say it never had one.
 */
export interface Sources {
  /** One plain HTTP request. No browser, no JavaScript. */
  fetch(url: string): Promise<PageResponse>;
  /** Render the URL and hand back what it fetched for itself. Called only for a field tier 1 left uncovered. */
  capture?: ((url: string) => Promise<Capture>) | undefined;
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
      // answer, and it is not evidence that it did either: `newestUsable` skips
      // it below and so does this.
      if (response.status >= 400) continue;
      total += flatten(response.body).length;
    }
  }
  return total;
}

/** The newest answer this endpoint gave that was an answer. */
function newestUsable(responses: readonly CapturedResponse[]): CapturedResponse | undefined {
  // Newest-first, skipping refusals: Store B's detail endpoint answers 401
  // before its anonymous session exists and 200 after, and the 401 is the older
  // call, not the wrong one to have kept.
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index]!;
    if (response.status < 400) return response;
  }
  return undefined;
}

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
  aliases: string[];
}

/**
 * The one path of this role that every binding sample declares, with the rest
 * of the role's paths as aliases.
 *
 * "Every sample" is `narrow`'s rule restated for tier 1 and it earns its keep
 * the same way: a property one page declares and the next does not is not a
 * binding, it is a page that happened to have it.
 */
function bindRole(samples: readonly DeclaredSample[], role: DeclaredRole): DeclaredBinding | undefined {
  const perSample = samples.map((sample) => byRole(sample.sources, role));
  if (perSample.some((found) => found.length === 0)) return undefined;
  const shared = perSample[0]!.filter((candidate) => perSample.every((found) => found.some((source) => source.path === candidate.path && source.kind === candidate.kind)));
  const chosen = shared[0];
  if (chosen === undefined) return undefined;
  const values = perSample.map((found) => found.find((source) => source.path === chosen.path && source.kind === chosen.kind)!.value);
  return { source: chosen, values, aliases: shared.slice(1).map((source) => source.path) };
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
   * StoreA 73% of the catalogue redirects — but it declares no product and
   * carries no payload, so including it in the binding set deletes every
   * candidate for every field ("present on every sample"). `classify` decides
   * which is which, so this module does not get a second opinion about what
   * dead means.
   */
  const picks: SamplePickRecord[] = options.sample.picks.map((pick) => ({
    url: pick.url,
    stratum: pick.stratum,
    because: pick.because,
    bound: !classify(pick.probe).strata.includes("dead"),
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
   * The render, taken once and shared.
   *
   * Tier 2 is still the only thing that *binds* from a capture, and the
   * StoreA run still never reaches for one. What changed is that a run the
   * transport could not settle may now ask for the same render early, to find
   * out whether the shell it fetched fills or refuses — and it must not then
   * pay for a second one.
   */
  const captures: Capture[] = [];
  let capturesTaken = false;
  const takeCaptures = async (): Promise<Capture[]> => {
    if (capturesTaken) return captures;
    capturesTaken = true;
    const capture = options.sources.capture;
    if (capture === undefined) return captures;
    for (const url of bindingUrls) {
      const taken = await capture(url);
      captures.push(taken);
      for (const obstacle of taken.obstacles ?? []) obstacles.push(obstacle);
      // A rendered page is the better canary when the plain fetch was a shell:
      // the fingerprint has to be of a page that was actually served.
      if (taken.html !== undefined && taken.html !== "") rendered.push({ url, status: 200, body: taken.html });
    }
    return captures;
  };

  /**
   * Blocked before bound, and this order is the whole of U3a.
   *
   * StoreC's run came back `sku 0/111`, `stock 0/111` and `¡Lo sentimos!`
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
  if (!allShells) {
    for (const [index, page] of fetched.entries()) {
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
   * opened. On StoreA all five requested fields were stated by the page, so
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
      : `${declaredSamples.reduce((total, sample) => total + sample.sources.length, 0)} declared finding(s) over ${declaredSamples.length} plain fetch(es)`,
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

    // Group every capture by endpoint, then keep only the endpoints every
    // sample asked: an endpoint one page called is not a source, it is a page.
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
     * *Asked* by every sample, *answered* by at least two — and the live run of
     * 2026-09-22 is the whole of why those are two questions rather than one.
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
     * dropped from that endpoint's comparison rather than allowed to veto it,
     * and the endpoint still has to have been asked everywhere, which is what
     * keeps `products/recommendations` and `products-bundled` — called on two
     * of the three pages — out.
     *
     * Two is the floor because `narrow`'s variation check needs two samples to
     * mean anything. With a single capture, one answer is the whole comparison
     * and the floor is one.
     */
    const floor = Math.min(2, perSample.length);
    const answering = new Map<string, number[]>();
    for (const key of perSample[0]?.keys() ?? []) {
      if (!perSample.every((grouped) => grouped.has(key))) continue;
      const indexes = perSample.flatMap((grouped, index) => (newestUsable(grouped.get(key)!) === undefined ? [] : [index]));
      if (indexes.length >= floor) answering.set(key, indexes);
    }
    const keys = [...answering.keys()].sort();

    const leavesByKey = new Map<string, Leaf[][]>();
    /** The rendered text of *this endpoint's* samples, in its own order — anchoring compares like with like. */
    const textByKey = new Map<string, string[] | undefined>();
    for (const key of keys) {
      const indexes = answering.get(key)!;
      const responses = indexes.map((index) => newestUsable(perSample[index]!.get(key)!)!);
      const leaves = responses.map((response) => flatten(response.body));
      leavesByKey.set(key, leaves);
      textByKey.set(key, pageText === undefined ? undefined : indexes.map((index) => pageText[index]!));
      const silent = perSample.length - indexes.length;
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
            `${silent === 0 ? "" : `; ${silent} of ${perSample.length} sample(s) asked this endpoint and got no answer, and are left out of the comparison rather than deleting it`}`,
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
    const named = (binding: ReturnType<typeof bindField> | undefined): boolean =>
      binding !== undefined && binding.path !== undefined && !binding.askModel && binding.verdicts.some((entry) => entry.verdict.fires && entry.verdict.pick === binding.path);
    const settled = (binding: ReturnType<typeof bindField> | undefined): boolean => binding !== undefined && binding.path !== undefined && !binding.askModel;

    /**
     * Which endpoint first. A site answers several calls and only one of them
     * is the product; the one that *names* the most uncovered fields is it.
     * Ties break on the key, so the choice is reproducible.
     */
    const namedCount = new Map<string, number>();
    for (const key of keys) namedCount.set(key, uncovered1.filter((field) => named(bindings.get(key)!.get(field.name))).length);
    const ordered = [...keys].sort((a, b) => (namedCount.get(b) ?? 0) - (namedCount.get(a) ?? 0) || a.localeCompare(b));

    for (const field of uncovered1) {
      const record = records.get(field.name)!;
      const chosen = ordered.find((key) => named(bindings.get(key)!.get(field.name))) ?? ordered.find((key) => settled(bindings.get(key)!.get(field.name)));

      for (const key of ordered) {
        const binding = bindings.get(key)!.get(field.name)!;
        record.verdicts.push(...binding.verdicts);
        for (const candidate of binding.candidates) {
          if (key === chosen && candidate.path === binding.path) continue;
          record.rejected.push({
            tier: 2,
            path: `${endpointMatch(key)}:${candidate.path}`,
            values: candidate.values,
            because: key === chosen ? `${binding.path ?? "another leaf"} was bound instead` : chosen === undefined ? binding.because : `${endpointMatch(chosen)} named ${field.name} and this endpoint did not`,
          });
        }
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
      record.aliases = binding.aliases;
      record.because = binding.because;
      record.askModel = false;
      covered2.push(field.name);
    }

    tier2 = {
      outcome: "ran",
      because: `${keys.length} endpoint(s) the page fetched for itself, over ${captures.length} rendered sample(s)${pageText === undefined ? "; unanchored, because no rendered text was supplied" : ""}`,
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

  const uncovered = fields.filter((field) => records.get(field.name)!.path === undefined).map((field) => field.name);
  tiers.push({
    tier: 3,
    name: "dom",
    outcome: uncovered.length === 0 ? "skipped" : "requested",
    because:
      uncovered.length === 0
        ? stop
          ? "declared-covers-spec fired: there is no DOM alternative to gate, because nothing was compiled"
          : "the declared data and the captured payloads covered every requested field; today's compiler is the exception, and this was not it"
        : `${uncovered.join(", ")} survived both cheap tiers; the DOM compiler in src/compile is asked for ${uncovered.length === 1 ? "it" : "them"} alone, over ${bindingUrls.length} sample URL(s), and its output faces the selector gate`,
    asked: uncovered,
    covered: [],
    sources: [],
    verdicts: [],
  });

  for (const field of fields) {
    const record = records.get(field.name)!;
    if (record.path === undefined && record.because === "nothing has looked yet") {
      record.because = "no tier that ran offered a candidate for this field";
    }
  }

  // ----------------------------------------------------------------- canary

  const canary = pickCanary([...rendered, ...fetched.filter((page) => !shellUrls.has(page.url))], now);

  return manuscriptOf({
    site,
    now,
    fields,
    sample: options.sample,
    picks,
    tiers,
    records,
    obstacles,
    ...(canary === undefined ? {} : { canary }),
    canaryBecause:
      canary === undefined
        ? `no canary was recorded: none of the ${fetched.length} page(s) read was a page a reader was served — a fingerprint taken off a shell resolves against anything, and a canary that always resolves turns every future refusal into drift`
        : `${safeUrl(canary.url)} fingerprinted: ${canary.words.length} words and ${canary.textChars} characters of text${canary.declaredProduct ? ", declaring a product" : ", declaring no product"}`,
    verdict: uncovered.length === 0 ? "covered" : "partial",
    because:
      uncovered.length === 0
        ? `every requested field is bound: ${fields.map((field) => `${field.name} at tier ${records.get(field.name)!.tier}`).join(", ")}`
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
 * at: StoreA's sku `8820237` is never rendered anywhere on the page, and its
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
       * A value identical across every sample is not a field. StoreA's
       * `productName` came back as "StoreA" on all 33 samples; the rule
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
    record.rejected.push({ tier: 1, path: candidate.path, values: candidate.values, because: binding.askModel ? binding.because : `${binding.path ?? "another declaration"} was bound instead` });
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
  record.aliases = binding.aliases;
  covered.push(field.name);
}

// ----------------------------------------------------------------- the canary

/**
 * A page that definitely worked, fingerprinted now so a run months later can
 * tell drift from refusal.
 *
 * Preference order matters: a page that declares a product is one the site
 * served properly, and the declared-`Product` conjunct is the load-bearing half
 * of `checkCanary` — word overlap alone would not have caught StoreC, whose
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
    obstacles,
    ...(parts.canary === undefined ? {} : { canary: parts.canary }),
    canaryBecause: parts.canaryBecause,
    verdict: parts.verdict,
    because: parts.because,
  };
}
