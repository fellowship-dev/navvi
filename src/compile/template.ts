import type { Page } from "playwright";
import type { SettleOptions } from "../browser/guards.js";
import type { Chooser } from "../chooser/chooser.js";
import { isChooserId, type Chooser as ChooserId, type Profile } from "../input/schema.js";
import {
  investigate,
  safeUrl,
  type Capture,
  type DomAnswer,
  type DomBinding,
  type DomRefusal,
  type DomRequest,
  type Manuscript,
  type PageResponse,
  type RequestedField,
  type SampleChoice,
  type SourceRecord,
  type TierDecision,
} from "../investigate/index.js";
import { reconcile, rubricsFor, type Reconciliation } from "../reconcile/index.js";
import type { Spec } from "../spec/schema.js";
import { chooseRecordFields, RECORD_SAMPLE_PAGES } from "./compile.js";
import { candidateLabel, fieldQuestionId, toAlternative, type CompileField } from "./fields.js";
import { gateAlternative } from "./gate.js";
import { NothingCompilableError, compileFromReconciliation, type ProvenCompile } from "./proven.js";

/**
 * U4: the compile core. One function per page template, cheapest tier first.
 *
 * ## Why this file exists
 *
 * On 2026-09-23 navvi had two compilers and a fresh-eyes run met both. The
 * plain command (`navvi "<prompt>" <url>`) put every field to a chooser as a
 * question about DOM candidates -- `compile()` in `./compile.ts` -- and never
 * looked at what the page declared. `navvi make` ran the declared and payload
 * tiers, compiled them in `./proven.ts`, and its "tier 3" was one line in the
 * manuscript saying a DOM compiler had been requested; nothing called one. So
 * `navvi make` on a books demo with its title, price and stock in plain markup
 * classified every URL dead, bound nothing, and exited 1, while the plain
 * command compiled the same page in a few seconds -- the two halves shared the
 * scraper format and replay and nothing else.
 *
 * This is the one place the tiers run in order for a template:
 *
 * ```
 * tier 1 declared  ->  tier 2 payload  ->  tier 3 DOM (uncovered fields only, a chooser)
 *   -> reconcile  ->  selector gate  ->  CompiledScraper
 * ```
 *
 * Tier 3 is `chooseRecordFields` -- the record flow `compile()` has always
 * run, candidates to questions to answers -- handed only the fields the cheap
 * tiers left uncovered (KTD2). There is no second DOM compiler here, and there
 * must not be one: the plain command's list mode, pagination and healing all
 * sit on that flow, and a tier 3 that drifted from it would be the two
 * programs again one directory down.
 *
 * ## What each front end takes from it
 *
 *  - `navvi make` is the staged view. Its investigate stage is
 *    `investigateTemplate` (tiers 1 to 3, one manuscript) and its compile stage
 *    is `compileFromReconciliation`, with the ledger, determinism and verify
 *    between them. The stages stay separately reusable; the tiers are this
 *    file's.
 *  - The plain command's record mode (U5) calls `compileTemplate` with the
 *    pages it already has open and the chooser it already built, and gets the
 *    same cascade in one call.
 *
 * ## What it does not do
 *
 * It opens nothing. The bytes come through `TemplateSources` -- a plain fetch,
 * a capture, and `render`, which hands tier 3 live pages and takes them back
 * -- so the caller owns the browser and the tests own the fixtures, the same
 * split `src/investigate/` makes for the same reason.
 */

// ------------------------------------------------------------------- inputs

/**
 * Hands `use` one live, rendered page per URL, in order, and closes them after.
 *
 * A callback rather than a list of pages because the caller owns their
 * lifetime: `navvi make`'s driver opens a fresh page per URL and closes it
 * when tier 3 is done, and the plain command's crawler already has its pages
 * open and must not have them closed under it.
 */
export type RenderPages = <T>(urls: readonly string[], use: (pages: Page[]) => Promise<T>) => Promise<T>;

/** Where one template's bytes come from. Only `fetch` is required: a run that stops at tier 1 never needs the rest. */
export interface TemplateSources {
  /** One plain HTTP request: tier 1, and the sample probes before it. */
  fetch(url: string): Promise<PageResponse>;
  /** A render with the payloads it fetched for itself: tier 2. */
  capture?: ((url: string) => Promise<Capture>) | undefined;
  /** Live pages for the DOM compiler: tier 3. */
  render?: RenderPages | undefined;
}

/** A chooser, or a way to open one only if tier 3 is reached. */
export type ChooserSource = Chooser | (() => Promise<Chooser>);

export interface DomTierOptions {
  render: RenderPages;
  chooser: ChooserSource;
  /** What a field means, for the question's premise. Defaults to nothing beyond its name. */
  describe?: ((field: RequestedField) => string | undefined) | undefined;
  /** What one record is, e.g. "book". */
  records?: string | undefined;
  settle?: SettleOptions | undefined;
}

// ------------------------------------------------------------------- tier 3

/**
 * The tier-3 callback `investigate` takes as `Sources.dom`.
 *
 * Every chosen selector faces `gateAlternative` as the field's only reading
 * before it is written down as a binding, which is KTD2's "tier-3 alternatives
 * face the gate like proven ones" taken literally: it is the same call, at the
 * same bar, that `compileFromReconciliation` makes for a `dom` reading. Gating
 * here as well as there is not a second opinion -- the gate is a pure function
 * of the selector -- it is what lets the manuscript say "the chooser picked
 * this and the gate refused it" and leave the field unbound, rather than
 * reporting it obtainable and letting the compile drop it a stage later under
 * a sentence about something else.
 */
export function domTier(options: DomTierOptions): (request: DomRequest) => Promise<DomAnswer> {
  return async (request) => {
    let chooser: Chooser;
    try {
      chooser = typeof options.chooser === "function" ? await options.chooser() : options.chooser;
    } catch (error) {
      // A run with no credential for any chooser is a run that cannot ask, and
      // it is a fact about this run rather than a defect: tier 3 is recorded as
      // requested, the fields stay unbound, and the reconciliation says so.
      const said = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "no reason given";
      return { ran: false, bindings: [], refused: [], unanswered: [], sources: [], because: `no chooser could be opened to answer the DOM compiler's questions (${said}), so tier 3 did not run` };
    }

    const urls = request.urls.slice(0, RECORD_SAMPLE_PAGES);
    const fields: CompileField[] = request.fields.map((field) => {
      const description = options.describe?.(field);
      return { name: field.name, ...(description === undefined ? {} : { description }), ...(field.type === undefined ? {} : { type: field.type }) };
    });

    return options.render(urls, async (pages) => {
      const sources: SourceRecord[] = pages.map((page) => ({ url: safeUrl(page.url()), kind: "render" as const, found: 0, because: "rendered for the DOM compiler" }));
      const choice = await chooseRecordFields({
        pages,
        fields,
        chooser,
        ...(options.records === undefined ? {} : { description: options.records }),
        ...(options.settle === undefined ? {} : { settle: options.settle }),
      });
      if (choice === null) {
        const because = `the DOM compiler rendered ${pages.length} page(s) and no leaf resolved on every one of them, so there was nothing to ask a chooser`;
        return { ran: true, bindings: [], refused: [], unanswered: fields.map((field) => ({ field: field.name, because })), sources, because };
      }
      for (const source of sources) {
        source.found = choice.candidates.length;
        source.because = `${choice.candidates.length} DOM candidate(s) resolved on every rendered sample`;
      }

      const bindings: DomBinding[] = [];
      const refused: DomRefusal[] = [];
      const unanswered: DomAnswer["unanswered"] = [];
      const answeredBy = chooser.name;
      const pageCount = `${pages.length} rendered page(s)`;
      for (const field of fields) {
        const id = fieldQuestionId(field.name, choice.suffix);
        const question = choice.questions.find((entry) => entry.id === id);
        const chosen = choice.mapped.get(field.name) ?? null;
        const offered = question?.options?.length ?? choice.candidates.length;
        if (chosen === null) {
          unanswered.push({ field: field.name, because: `tier 3: ${answeredBy} answered none to \`${id}\` over ${offered} candidate(s) on ${pageCount}; no DOM node holds ${field.name} on every sample` });
          continue;
        }
        const decision: TierDecision = { question: id, premise: question?.premise ?? "", options: offered, chose: candidateLabel(chosen), answeredBy };
        // The fingerprint `compile()` would have written: link and media
        // values made absolute, so the manuscript and the scraper agree.
        const alternative = toAlternative(chosen, choice.baseUrls);
        const values = alternative.fingerprint.samples.length === chosen.values.length ? [...alternative.fingerprint.samples] : [...chosen.values];
        const gate = gateAlternative(chosen.selector, "dom", { sole: true });
        if (!gate.ok) {
          refused.push({
            field: field.name,
            path: chosen.path,
            values,
            decision,
            because: `tier 3: ${answeredBy} chose \`${chosen.path}\` and the selector gate refused it, so ${field.name} is not obtainable from the markup either — ${gate.because}`,
          });
          continue;
        }
        bindings.push({
          field: field.name,
          selector: chosen.selector,
          ...(chosen.attr === undefined ? {} : { attr: chosen.attr }),
          path: chosen.path,
          values,
          decision,
          because:
            `${answeredBy} chose \`${chosen.path}\` out of ${offered} DOM candidate(s) that resolved on all ${pageCount}, asked \`${id}\`` +
            (gate.audit.risks.length > 0 ? `; the selector gate kept it: ${gate.because}` : ""),
        });
      }
      return {
        ran: true,
        bindings,
        refused,
        unanswered,
        sources,
        because:
          `the DOM compiler read ${pageCount}, offered ${choice.candidates.length} candidate(s), and ${answeredBy} answered ${choice.questions.length} question(s): ` +
          `${bindings.length} bound, ${refused.length} refused by the selector gate, ${unanswered.length} answered none`,
      };
    });
  };
}

/**
 * The premise a tier-3 question carries for one field: the spec's own words
 * for it, and every rubric that names it, quoted.
 *
 * R5 says a structured decision is guided by the case's rubrics where it has
 * them. `rubricsFor` is `src/reconcile/`'s matcher, asked rather than
 * respelled, so the rule a chooser read when it picked a node is the rule
 * `rationale.md` quotes beside the binding.
 */
export function describeFrom(spec: Spec): (field: RequestedField) => string | undefined {
  return (field) => {
    const request = spec.fields.find((entry) => entry.name === field.name);
    const parts: string[] = [];
    if (request?.description !== undefined && request.description.trim() !== "") parts.push(request.description.trim());
    for (const rubric of rubricsFor(spec, field.name)) parts.push(`rule ${rubric.id}: "${rubric.rule}"`);
    return parts.length === 0 ? undefined : parts.join("; ");
  };
}

// ----------------------------------------------------------------- the core

export interface InvestigateTemplateOptions {
  spec: Spec;
  /** The fields to bind, in requested order. Usually the spec's, with the types the client declared. */
  fields: readonly RequestedField[];
  /** Which URLs, and why each is in the sample. */
  sample: SampleChoice;
  sources: TemplateSources;
  /** Who answers tier 3. Absent: tier 3 is recorded as requested and does not run. */
  chooser?: ChooserSource | undefined;
  now?: Date | undefined;
  settle?: SettleOptions | undefined;
}

/**
 * Tiers 1, 2 and 3 for one template, written down as one manuscript.
 *
 * This is `navvi make`'s investigate stage, and the first half of
 * `compileTemplate`. Tier 3 runs only when both a renderer and a chooser were
 * supplied; without either it is recorded as requested, which is what every
 * run did before U4 and still the honest record of one that could not ask.
 */
export function investigateTemplate(options: InvestigateTemplateOptions): Promise<Manuscript> {
  const { render } = options.sources;
  const dom =
    render !== undefined && options.chooser !== undefined
      ? domTier({ render, chooser: options.chooser, describe: describeFrom(options.spec), records: options.spec.entity.name, settle: options.settle })
      : undefined;
  return investigate({
    site: options.spec.target.site,
    fields: options.fields,
    sample: options.sample,
    sources: {
      fetch: (url) => options.sources.fetch(url),
      ...(options.sources.capture === undefined ? {} : { capture: options.sources.capture }),
      ...(dom === undefined ? {} : { dom }),
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/**
 * The chooser a scraper records, read off the manuscript that produced it.
 *
 * `CompiledScraper.chooser` has always meant "who the compile paid", and until
 * U4 a manuscript-built scraper had no honest answer and wrote `agent`. A
 * tier-3 binding carries its own answer; tiers 1 and 2 still have none.
 */
export function chooserOf(manuscript: Manuscript): ChooserId | undefined {
  for (const field of manuscript.fields) {
    const by = field.decision?.answeredBy;
    if (by !== undefined && isChooserId(by)) return by;
  }
  return undefined;
}

export interface TemplateCompileOptions extends InvestigateTemplateOptions {
  templateKey: string;
  /** The URL a replay starts from. */
  entry: { mode: "direct" | "trace"; url: string };
  cacheKey?: string | undefined;
  profile?: Profile | undefined;
}

export type TemplateCompile =
  | { ok: true; manuscript: Manuscript; reconciliation: Reconciliation; compiled: ProvenCompile }
  | {
      ok: false;
      /**
       * `blocked` — the site refused and nothing was bound. `open` — the
       * reconciliation has a decision nobody made (U3: an open ambiguity does
       * not silently compile). `empty` — nothing was proved obtainable.
       * `refused` — everything obtainable was refused by the selector gate.
       */
      status: "blocked" | "open" | "empty" | "refused";
      manuscript: Manuscript;
      reconciliation?: Reconciliation;
      because: string;
    };

/**
 * One template, compiled: tier 1 → tier 2 → tier 3 → reconcile → gate → scraper.
 *
 * Deterministic below the chooser. Everything after the manuscript is pure,
 * which is why `navvi make` can hold the stages apart with a ledger and still
 * be running this cascade rather than a copy of it.
 */
export async function compileTemplate(options: TemplateCompileOptions): Promise<TemplateCompile> {
  const now = options.now ?? new Date();
  const manuscript = await investigateTemplate({ ...options, now });
  if (manuscript.verdict === "blocked") return { ok: false, status: "blocked", manuscript, because: manuscript.because };

  const reconciliation = reconcile(manuscript, options.spec, { now });
  if (reconciliation.verdict === "open") return { ok: false, status: "open", manuscript, reconciliation, because: reconciliation.because };
  if (reconciliation.obtainable.length === 0) return { ok: false, status: "empty", manuscript, reconciliation, because: reconciliation.because };

  const chooser = chooserOf(manuscript);
  try {
    const compiled = compileFromReconciliation(reconciliation, manuscript, options.spec, {
      templateKey: options.templateKey,
      entry: options.entry,
      now,
      ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(chooser === undefined ? {} : { chooser }),
    });
    return { ok: true, manuscript, reconciliation, compiled };
  } catch (error) {
    if (error instanceof NothingCompilableError) return { ok: false, status: "refused", manuscript, reconciliation, because: error.message };
    throw error;
  }
}
