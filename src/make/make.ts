import { bulletWidth, makeArtifact, makeBullet, makeNote, makeRow, makeStage } from "../cli/render.js";
import { chooseSample, investigate, probeFrom, render as renderManuscript, type Manuscript, type RequestedField, type SampleChoice, type Stratum } from "../investigate/index.js";
import { outputSchema, reconcile, render as renderReconcile, summarize as summarizeReconcile, type Reconciliation } from "../reconcile/index.js";
import { NothingCompilableError, compileFromReconciliation, renderRationale, type ProvenCompile } from "../compile/index.js";
import { DEFAULT_REPLAYS, DEFAULT_SAMPLE_URLS, loadListSources, measureDeterminism, summarizeDeterminism, unstableFields, type Determinism } from "../replay/index.js";
import { renderMachine, type CompiledScraper } from "../scraper/index.js";
import { groupByTemplate } from "../template/index.js";
import { SpecSchema, blockingQuestions, requestedFields, type Rubric, type Spec } from "../spec/schema.js";
import { briefToSpec } from "../spec/spec.js";
import type { Chooser } from "../chooser/chooser.js";
import type { FieldType } from "../input/schema.js";
import { AnswerError, applyAnswers, parseAnswer, type FieldTypes, type MatchedAnswer } from "./answers.js";
import { ARTIFACTS, PRIMARY, STAGES, Work, type StageName } from "./work.js";
import { measurements, renderScorecard, scorecard } from "./verify.js";
import type { Pages } from "./pages.js";

/**
 * U11: `navvi make`, the driver.
 *
 * ## Why this is the unit that matters
 *
 * Every stage of the pipeline existed and was tested before this file, and
 * nothing ran them as one command: `scripts/live-investigate.ts` wired
 * investigate to reconcile by hand for a smoke test and wrote no files, and
 * `bin/cli.ts` had `run`, `spec` and `heuristics`. `docs/architecture.md` said
 * in as many words that what was missing was the driver and not an edge.
 *
 * That matters here more than it usually would, because this repository's
 * recurring defect is a half that is green on its own fixture and has never met
 * the other half — four of them reached a live run past ~720 green tests on
 * 2026-09-22, each at a seam between two units that were both correct alone.
 * The driver is what makes the halves meet for real, so it is written to make
 * the seams visible rather than smooth: every stage says what it read, what it
 * wrote, and whether it ran at all.
 *
 * ## A stage that did not run and a stage that found nothing say different things
 *
 * This is the single most repeated lesson in the codebase. `TierRecord.outcome`
 * carries `skipped` for exactly this reason — *"tier 2 covered nothing" and
 * "tier 2 was never spent" are the same empty `covered` list and very different
 * facts* — and `Manuscript.canaryBecause` exists because refusing to record a
 * canary is right and refusing silently is not. So `StageOutcome` has five
 * values and each one prints differently:
 *
 *  - `ran` — it did its work this run, and the block is the stage's own.
 *  - `reused` — its artifact is current, so it was not re-run. Named, because a
 *    client who answered a question and saw the old investigation reported as
 *    if it were new has been lied to by a green run.
 *  - `skipped` — it could have run and deliberately did not, with the reason.
 *  - `stopped` — it ran and refuses to hand anything downstream.
 *  - `not reached` — an earlier stage stopped.
 *
 * ## The order, and why determinism sits where it does
 *
 * `spec, sample, investigate, reconcile, schema, determinism, compile, verify`,
 * which is the plan's transcript. Determinism before compile is the one that
 * needs explaining, because U6a reads pages *through a compiled scraper* and
 * the compile has not happened yet. It compiles a **provisional** scraper from
 * the current reconciliation — `compileFromReconciliation` is pure, offline and
 * free, so this costs nothing but the page loads it was always going to cost —
 * reads N x U pages with it, and hands `compile` the list of fields that would
 * not hold still. The compile then drops those, which is what U6a means by
 * *"rejected rather than repaired"*: a field that moves on an unchanged page
 * never reaches `scraper.json` at all.
 */

// ----------------------------------------------------------------- the report

export type StageOutcome = "ran" | "reused" | "skipped" | "stopped" | "not reached";

export interface StageReport {
  stage: StageName;
  outcome: StageOutcome;
  because: string;
  /** Artifacts this run wrote or reused, relative to the work directory. */
  artifacts: string[];
}

/**
 * What the run ended as. Mapped to a process exit code by `bin/cli.ts`, which
 * owns `EXIT` — a second table of exit numbers here would be exactly the second
 * spelling `tests/second-spelling.test.ts` is about.
 */
export type MakeStatus = "delivered" | "needs_answers" | "configuration" | "short";

export interface MakeResult {
  status: MakeStatus;
  /** The stage the run stopped at, when it stopped before the end. */
  stoppedAt?: StageName;
  /** The sentence the stop line prints. */
  because?: string;
  stages: StageReport[];
  /** The work directory, absolute, for the caller that wants to name it. */
  work: string;
}

// ----------------------------------------------------------------- the inputs

export interface MakeOptions {
  /** The work directory. Created if it is not there. */
  work: string;
  /** The brief, when one was given. Absent resumes from `spec.json`. */
  brief?: string | undefined;
  rubrics: readonly Rubric[];
  /** `--answer key=value`, raw and in the order they were given. */
  answers: readonly string[];
  /** Positional start URLs and `--from-url` list sources. */
  urls: readonly string[];
  fromUrls: readonly string[];
  allowPrivateHosts: readonly string[];
  sampleSize?: number | undefined;
  replays?: number | undefined;
  offline: boolean;
  force: boolean;
}

export interface MakeDeps {
  /** Where a stage block goes, the moment the stage finishes. Blocks stream; the data is in the files. */
  report(text: string): void;
  /**
   * Opens the page driver, once, and only if a stage actually needs it. A
   * driver that is never opened is a browser that never launched, which is what
   * makes the plan's first transcript true: *nothing has opened a browser*.
   */
  openPages?: (() => Promise<Pages>) | undefined;
  /**
   * Builds the chooser that answers the one question `briefToSpec` asks.
   *
   * A factory and not a `Chooser`, because building one resolves a credential,
   * announces the choice on stderr and may refuse the run outright — and a
   * resume (the plan's second transcript) never compiles a brief at all. A
   * command that demands an API key for a stage it was never going to run is
   * the same false failure as a stage that reports `stable` about pages it
   * never read.
   */
  openChooser?: (() => Promise<Chooser>) | undefined;
  /** Resolves `--from-url` into a URL list. Defaults to `replay`'s own, which is the one spelling of it. */
  loadUrls?: ((urls: readonly string[], fromUrls: readonly string[], allowPrivateHosts: readonly string[]) => Promise<string[]>) | undefined;
  /** The clock, so a whole run is reproducible. */
  now?: (() => Date) | undefined;
}

// ------------------------------------------------------------------ the driver

export async function make(options: MakeOptions, deps: MakeDeps): Promise<MakeResult> {
  const now = deps.now ?? (() => new Date());
  const work = Work.open(options.work, { now });
  const stages: StageReport[] = [];

  /**
   * The page driver, opened at most once and only when a stage asks for it.
   *
   * Held in a box rather than a `let`, so the `finally` below closes whatever
   * was opened inside the callback: a bare local assigned only from inside a
   * closure narrows to `null` at the end of the function and the browser would
   * be left running.
   */
  const open: { pages: Pages | null } = { pages: null };
  const needPages = async (): Promise<Pages> => {
    if (open.pages === null) {
      if (!deps.openPages) throw new MakeStop("no page driver was supplied to the driver, so nothing can read a URL");
      open.pages = await deps.openPages();
    }
    return open.pages;
  };

  const say = (text: string): void => deps.report(text);
  const record = (stage: StageName, outcome: StageOutcome, because: string, artifacts: readonly string[] = []): void => {
    stages.push({ stage, outcome, because, artifacts: [...artifacts] });
  };

  /**
   * A stage refuses to continue. Distinct from a thrown `Error`, which is a
   * defect in navvi: a `MakeStop` is a statement about this run's inputs that a
   * person can act on, and it carries the sentence the stop line prints.
   */
  const stop = (stage: StageName, because: string, status: MakeStatus): MakeResult => {
    record(stage, "stopped", because);
    for (const later of STAGES.slice(STAGES.indexOf(stage) + 1)) record(later, "not reached", `the run stopped at ${stage}`);
    return { status, stoppedAt: stage, because, stages, work: work.dir };
  };

  try {
    // ------------------------------------------------------------------ spec

    const answers = options.answers.map(parseAnswer);
    let spec: Spec;
    let matched: MatchedAnswer[];
    let types: FieldTypes;
    try {
      ({ spec, matched, types } = await runSpec(work, options, deps, answers));
    } catch (error) {
      if (error instanceof AnswerError || error instanceof MakeStop) return stop("spec", error.message, "configuration");
      throw error;
    }

    const before = work.read(PRIMARY.spec);
    const text = JSON.stringify(spec, null, 2) + "\n";
    const rewritten = before !== text;
    work.write(PRIMARY.spec, text);
    work.record("spec", [], { brief: options.brief ?? null, rubrics: options.rubrics, answers: options.answers });

    /**
     * A field the *brief* named and a field the draft guessed are not the same
     * thing, and the head line says which. On the first run all five of Cruz
     * Verde's are guesses — "product info" names none — so reporting "5 fields"
     * there would say the brief asked for exactly what the stage is about to
     * stop and ask about.
     */
    const named = requestedFields(spec);
    const summary =
      named.length === spec.fields.length
        ? `${named.length} field${named.length === 1 ? "" : "s"}, inputs ${spec.inputs.shape}`
        : `${named.length} of ${spec.fields.length} fields named, inputs ${spec.inputs.shape}`;
    say(makeStage("spec", rewritten ? summary : `${summary} — reused`, work.path(PRIMARY.spec)));

    const answerLabel = (answer: MatchedAnswer): string =>
      // The question id when one is still open, the subject when the answer is
      // being re-applied to a spec that already carries it. Both are worth
      // printing: an answer that settled nothing is not an answer that was
      // ignored, and the two would otherwise look alike.
      answer.question === undefined ? `${answer.subject} (already settled)` : answer.question.id;
    const answerWidth = bulletWidth(matched.map(answerLabel));
    for (const answer of matched) {
      say(makeBullet(answerLabel(answer), `answered by ${answer.by} — ${answer.key}=${answer.value}`, "-", answerWidth));
    }
    const declared = Object.entries(types);
    if (declared.length > 0) {
      say(makeBullet("types", `${declared.map(([name, type]) => `${name}:${type}`).join(", ")}`, "-", answerWidth));
      say(makeNote("declared on the command line: a spec field has no column type, so these ride in make.json", answerWidth + 4));
    }

    const blocking = blockingQuestions(spec);
    if (blocking.length > 0) {
      const width = bulletWidth(blocking.map((question) => question.id));
      for (const question of blocking) say(makeBullet(question.id, question.because, "!", width));
      record("spec", "ran", `${blocking.length} blocking question${blocking.length === 1 ? "" : "s"}`, [PRIMARY.spec]);
      const because = `${blocking.length} blocking question${blocking.length === 1 ? "" : "s"}`;
      for (const later of STAGES.slice(1)) record(later, "not reached", "the spec is not ready to investigate");
      return { status: "needs_answers", stoppedAt: "spec", because, stages, work: work.dir };
    }
    record("spec", rewritten ? "ran" : "reused", rewritten ? "written from the brief and the answers" : "unchanged since the last run", [PRIMARY.spec]);

    if (spec.inputs.shape !== "url_list") {
      return stop(
        "sample",
        `the spec's input shape is ${spec.inputs.shape}; make can only sample a url_list today, so a ${spec.inputs.shape} needs the link finder (Phase B) first`,
        "configuration",
      );
    }

    // ---------------------------------------------------------------- sample

    const sampleParams = { urls: [...options.urls], fromUrls: [...options.fromUrls], size: options.sampleSize ?? null };
    const sampleState = work.currency("sample", ["spec.json"], sampleParams);
    let sample: SampleChoice;
    if (sampleState.current && !options.force) {
      sample = requireJson<SampleChoice>(work, PRIMARY.sample);
      say(makeStage("sample", `reused — ${sampleState.because}`, work.path(PRIMARY.sample)));
      for (const name of sampleState.edited) say(makeBullet("edited", `${name} is not the bytes navvi wrote; downstream reads yours`, "-"));
      record("sample", "reused", sampleState.because, [PRIMARY.sample]);
    } else {
      if (options.offline) return stop("sample", `${sampleState.because}, and --offline forbids the URL probes that would settle it`, "configuration");
      const guard = overwriteGuard(work, "sample", sampleState.edited, options.force);
      if (guard) return stop("sample", guard, "configuration");

      const urls = await (deps.loadUrls ?? defaultLoadUrls)(options.urls, options.fromUrls, options.allowPrivateHosts);
      if (urls.length === 0) return stop("sample", "no URL to sample; give start URLs, or --from-url pointing at a list", "configuration");

      const driver = await needPages();
      const probes = await probeAll(urls, driver);
      sample = chooseSample(probes, options.sampleSize === undefined ? {} : { size: options.sampleSize });
      work.writeJson(PRIMARY.sample, sample);
      work.record("sample", ["spec.json"], sampleParams);

      say(makeStage("sample", `${sample.picks.length} of ${sample.considered} URLs, spanning ${filledStrata(sample)} of 4 strata`, work.path(PRIMARY.sample)));
      say(makeNote(strataTally(sample)));
      const unfilledWidth = bulletWidth(sample.unfilled.map((entry) => entry.stratum));
      for (const unfilled of sample.unfilled) say(makeBullet(unfilled.stratum, unfilled.because, "!", unfilledWidth));
      if (sample.excluded.length > 0) say(makeBullet("excluded", `${sample.excluded.length} URL(s) are not compile input: ${[...new Set(sample.excluded.map((e) => e.reason))].join(", ")}`, "-"));
      record("sample", "ran", `${sample.picks.length} of ${sample.considered} URLs`, [PRIMARY.sample]);
    }

    // ----------------------------------------------------------- investigate

    const fields: RequestedField[] = spec.fields.map((field) => (types[field.name] ? { name: field.name, type: types[field.name] as FieldType } : { name: field.name }));
    const investigateParams = { site: spec.target.site, fields };
    const investigateState = work.currency("investigate", ["spec.json", "sample.json"], investigateParams);
    let manuscript: Manuscript;
    if (investigateState.current && !options.force) {
      manuscript = requireJson<Manuscript>(work, PRIMARY.investigate);
      say(makeStage("investigate", `reused — ${investigateState.because}`, work.path(PRIMARY.investigate)));
      for (const name of investigateState.edited) say(makeBullet("edited", `${name} is not the bytes navvi wrote; downstream reads yours`, "-"));
      record("investigate", "reused", investigateState.because, [PRIMARY.investigate]);
    } else {
      if (options.offline) return stop("investigate", `${investigateState.because}, and --offline forbids reading a page`, "configuration");
      const guard = overwriteGuard(work, "investigate", investigateState.edited, options.force);
      if (guard) return stop("investigate", guard, "configuration");

      const driver = await needPages();
      manuscript = await investigate({
        site: spec.target.site,
        fields,
        sample,
        sources: { fetch: (url) => driver.fetch(url), capture: (url) => driver.capture(url) },
        now: now(),
      });
      work.writeJson(PRIMARY.investigate, manuscript);
      work.record("investigate", ["spec.json", "sample.json"], investigateParams);
      say(renderManuscript(manuscript, work.path(PRIMARY.investigate)));
      record("investigate", "ran", manuscript.because, [PRIMARY.investigate]);
    }

    if (manuscript.verdict === "blocked") {
      return stop("investigate", `the site refused: ${manuscript.because}`, "short");
    }

    // ------------------------------------------------------------- reconcile

    const reconcileState = work.currency("reconcile", ["spec.json", "investigation.json"], {});
    let reconciliation: Reconciliation;
    if (reconcileState.current && !options.force) {
      reconciliation = requireJson<Reconciliation>(work, PRIMARY.reconcile);
      say(makeStage("reconcile", `reused — ${reconcileState.because}`, work.path("reconcile.md")));
      for (const name of reconcileState.edited) say(makeBullet("edited", `${name} is not the bytes navvi wrote; downstream reads yours`, "-"));
      record("reconcile", "reused", reconcileState.because, [...ARTIFACTS.reconcile]);
    } else {
      const guard = overwriteGuard(work, "reconcile", reconcileState.edited, options.force);
      if (guard) return stop("reconcile", guard, "configuration");
      reconciliation = reconcile(manuscript, spec, { now: now() });
      work.writeJson(PRIMARY.reconcile, reconciliation);
      work.write("reconcile.md", renderReconcile(reconciliation));
      work.record("reconcile", ["spec.json", "investigation.json"], {});
      say(summarizeReconcile(reconciliation, work.path("reconcile.md")));
      record("reconcile", "ran", reconciliation.because, [...ARTIFACTS.reconcile]);
    }

    // ---------------------------------------------------------------- schema

    const schemaState = work.currency("schema", ["spec.json", "reconcile.json"], {});
    if (schemaState.current && !options.force) {
      say(makeStage("schema", `reused — ${schemaState.because}`, work.path(PRIMARY.schema)));
      record("schema", "reused", schemaState.because, [PRIMARY.schema]);
    } else {
      const guard = overwriteGuard(work, "schema", schemaState.edited, options.force);
      if (guard) return stop("schema", guard, "configuration");
      const schema = outputSchema(reconciliation, spec, { now: now() });
      work.writeJson(PRIMARY.schema, schema);
      work.record("schema", ["spec.json", "reconcile.json"], {});
      const inferred = schema.fields.filter((field) => field.typeInferred).length;
      say(makeStage("schema", `${schema.fields.length} typed column${schema.fields.length === 1 ? "" : "s"}${inferred > 0 ? `, ${inferred} type${inferred === 1 ? "" : "s"} inferred` : ""}`, work.path(PRIMARY.schema)));
      if (inferred > 0) say(makeBullet("inferred", "the spec declared no type for these, so it was read off the values — never `money`, because nothing in a bare number says a price from a count", "-"));
      record("schema", "ran", schema.because, [PRIMARY.schema]);
    }

    if (reconciliation.obtainable.length === 0) {
      return stop("compile", `nothing was proved obtainable: ${reconciliation.because}`, "short");
    }

    // ----------------------------------------------------------- determinism

    const entryUrl = bindingUrls(manuscript)[0] ?? sample.picks[0]?.url;
    if (entryUrl === undefined) return stop("compile", "the sample has no URL a replay could start from", "short");
    const templateKey = templateKeyOf(bindingUrls(manuscript).length > 0 ? bindingUrls(manuscript) : sample.picks.map((pick) => pick.url));
    const compileOptions = { templateKey, entry: { mode: "direct" as const, url: entryUrl } };

    const replayUrls = bindingUrls(manuscript).slice(0, DEFAULT_SAMPLE_URLS);
    const replays = options.replays ?? DEFAULT_REPLAYS;
    const determinismParams = { replays, urls: replayUrls, compile: compileOptions };
    const determinismState = work.currency("determinism", ["spec.json", "investigation.json", "reconcile.json"], determinismParams);

    let determinism: Determinism | null = null;
    let determinismBecause = "";
    if (determinismState.current && !options.force) {
      determinism = requireJson<Determinism>(work, PRIMARY.determinism);
      say(makeStage("determinism", `reused — ${determinismState.because}`, work.path(PRIMARY.determinism)));
      record("determinism", "reused", determinismState.because, [PRIMARY.determinism]);
    } else if (options.offline || !deps.openPages) {
      determinismBecause = options.offline
        ? "--offline: reading the same page three times is the one thing this stage does"
        : "no page driver, so no page could be read three times";
      // Deliberately not reading a determinism.json left over from an earlier
      // run. It would be evidence about a different reconciliation, and
      // `verdict: "stable"` carried forward onto a compile it was not measured
      // against is precisely the phantom finding U6a exists to stop.
      work.forget("determinism");
      say(makeStage("determinism", `skipped — ${determinismBecause}`));
      say(makeBullet("not measured", "nothing below has been shown to hold still on an unchanged page", "!"));
      record("determinism", "skipped", determinismBecause, []);
    } else if (replayUrls.length === 0) {
      determinismBecause = "no sampled URL was bound from, so there is no page to read twice";
      work.forget("determinism");
      say(makeStage("determinism", `skipped — ${determinismBecause}`));
      record("determinism", "skipped", determinismBecause, []);
    } else {
      const guard = overwriteGuard(work, "determinism", determinismState.edited, options.force);
      if (guard) return stop("determinism", guard, "configuration");
      let provisional: ProvenCompile;
      try {
        provisional = compileFromReconciliation(reconciliation, manuscript, spec, { ...compileOptions, now: now() });
      } catch (error) {
        if (error instanceof NothingCompilableError) return stop("compile", error.message, "short");
        throw error;
      }
      const driver = await needPages();
      determinism = await measureDeterminism(replayUrls, { read: (url) => driver.read(provisional.scraper, url) }, {
        site: spec.target.site,
        fields: Object.keys(provisional.scraper.fields),
        replays,
        now: now(),
      });
      work.writeJson(PRIMARY.determinism, determinism);
      work.record("determinism", ["spec.json", "investigation.json", "reconcile.json"], determinismParams);
      say(summarizeDeterminism(determinism, work.path(PRIMARY.determinism)));
      say(makeNote("read through a scraper compiled from this reconciliation, not from scraper.json, which does not exist yet"));
      record("determinism", "ran", determinism.because, [PRIMARY.determinism]);
    }

    // U6b's finding lands in this artifact and this stage block by design; U6a
    // never fills it. Absent means nobody asked, and saying so is the whole
    // reason `AlternativeDisagreement` is declared in a file that does not
    // produce one.
    if (determinism !== null && determinism.alternatives === undefined) {
      say(makeBullet("alternatives", "not compared (U6b) — a field whose own alternatives disagree on one page would not be found here", "-"));
    }

    // --------------------------------------------------------------- compile

    const rejected = determinism === null ? [] : unstableFields(determinism);
    const compiling: Reconciliation = rejected.length === 0 ? reconciliation : { ...reconciliation, obtainable: reconciliation.obtainable.filter((field) => !rejected.includes(field.field)) };
    const compileParams = {
      ...compileOptions,
      determinism: determinism === null ? { ran: false, because: determinismBecause } : { ran: true, verdict: determinism.verdict, rejected },
    };
    const compileState = work.currency("compile", ["spec.json", "investigation.json", "reconcile.json"], compileParams);

    let compiled: ProvenCompile | null = null;
    let scraper: CompiledScraper;
    if (compileState.current && !options.force) {
      scraper = requireJson<CompiledScraper>(work, PRIMARY.compile);
      say(makeStage("compile", `reused — ${compileState.because}`, work.path(PRIMARY.compile)));
      for (const name of compileState.edited) say(makeBullet("edited", `${name} is not the bytes navvi wrote; verify reads yours`, "-"));
      record("compile", "reused", compileState.because, [...ARTIFACTS.compile]);
    } else {
      const guard = overwriteGuard(work, "compile", compileState.edited, options.force);
      if (guard) return stop("compile", guard, "configuration");
      if (compiling.obtainable.length === 0) {
        return stop("compile", `every obtainable field was rejected as unstable: ${rejected.join(", ")}`, "short");
      }
      try {
        compiled = compileFromReconciliation(compiling, manuscript, spec, { ...compileOptions, now: now() });
      } catch (error) {
        if (error instanceof NothingCompilableError) return stop("compile", error.message, "short");
        throw error;
      }
      scraper = compiled.scraper;
      work.writeJson(PRIMARY.compile, compiled.scraper);
      work.write("rationale.md", renderRationale(compiled.rationale));
      work.write("machine.mmd", renderMachine());
      work.record("compile", ["spec.json", "investigation.json", "reconcile.json"], compileParams);

      say(makeStage("compile", "", work.path(PRIMARY.compile)));
      say(makeRow(`${Object.keys(compiled.scraper.fields).length} fields`, alternativesLine(compiled)));
      const compileWidth = bulletWidth([...rejected, ...compiled.unbound.map((field) => field.field), "unproved"]);
      for (const field of rejected) say(makeBullet(field, "dropped: it did not hold still across the determinism replays, and a rejection is not a repair", "!", compileWidth));
      for (const field of compiled.unbound) say(makeBullet(field.field, `not bound: ${field.because}`, "!", compileWidth));
      if (determinism === null) say(makeBullet("unproved", `nothing was measured for stability — ${determinismBecause}`, "!", compileWidth));
      say(makeArtifact(work.path("rationale.md")));
      say(makeArtifact(work.path("machine.mmd")));
      record("compile", "ran", compiled.rationale.because, [...ARTIFACTS.compile]);
    }

    // ---------------------------------------------------------------- verify

    const unbound = compiled?.unbound.map((field) => field.field) ?? reconciliation.obtainable.filter((field) => !(field.field in scraper.fields)).map((field) => field.field);
    let extractions = null as Awaited<ReturnType<Pages["extract"]>>[] | null;
    let fillBecause = "";
    if (options.offline || !deps.openPages) {
      fillBecause = options.offline
        ? "--offline: the fill rate is the one measurement here that has to open a page"
        : "no page driver, so the compiled scraper has not been asked to read anything";
    } else if (replayUrls.length === 0) {
      fillBecause = "no sampled URL was bound from, so there is no page to replay against";
    } else {
      const driver = await needPages();
      extractions = [];
      for (const url of replayUrls) extractions.push(await driver.extract(scraper, url));
    }

    const card = scorecard(scraper, reconciliation, unbound, {
      site: spec.target.site,
      now: now(),
      extractions,
      ...(fillBecause === "" ? {} : { fillBecause }),
      determinism,
      ...(determinismBecause === "" ? {} : { determinismBecause }),
    });
    work.write(PRIMARY.verify, renderScorecard(card));
    work.record("verify", ["reconcile.json", "scraper.json"], { fill: extractions === null ? null : extractions.length });

    const filled = card.fill === null ? "fill not measured" : `fill ${card.fill.fields.filter((field) => field.read === field.of).length} of ${card.fill.fields.length}`;
    say(makeStage("verify", `${card.compiled} of ${card.requested} compiled, ${filled}`, work.path(PRIMARY.verify)));
    say(makeNote(measurements(card)));
    say(makeBullet("no grade", "the 100-point scorecard and its letter are U12, and its weights are undecided — these are the measurements it would be computed from", "!"));
    if (card.fill !== null) {
      const thin = card.fill.fields.filter((field) => field.read < field.of);
      const width = bulletWidth(thin.map((field) => field.field));
      for (const field of thin) say(makeBullet(field.field, `read on ${field.read} of ${field.of} replayed URLs`, "!", width));
    }
    record("verify", "ran", card.gradeBecause, [PRIMARY.verify]);

    return { status: "delivered", stages, work: work.dir };
  } finally {
    await open.pages?.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------------- the spec

class MakeStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MakeStop";
  }
}

interface SpecResult {
  spec: Spec;
  matched: MatchedAnswer[];
  types: FieldTypes;
}

/**
 * The spec stage, and the one real decision in it: **resume by reading
 * `spec.json`, never by deriving the brief again.**
 *
 * Three reasons, in the order they matter:
 *
 *  1. `briefToSpec` asks a model. It is the only model call in the whole of
 *     `make`, it is not deterministic, and re-deriving would mean the second
 *     run's spec can differ from the one the client just read and answered — so
 *     the answers would be attached to question ids that no longer exist.
 *  2. The spec is the artifact the client **approves** and the compile is later
 *     judged against. Re-deriving it silently replaces the approved thing.
 *  3. It is what makes "every stage independently runnable from the artifact
 *     above it" true of the first stage too. The artifact above `spec` is
 *     `spec.json` itself, so editing it by hand has to be the supported path,
 *     and it is: the file is parsed through `SpecSchema`, so a broken edit
 *     fails with the field that is wrong rather than four stages later.
 *
 * Nothing is lost by not re-deriving: `Spec.brief` is the brief verbatim, so
 * `reconcile` and the rationale still quote what was asked. A brief given on
 * the command line that differs from the stored one is a *new* brief and does
 * re-derive — that is a different job, not a resume.
 */
async function runSpec(work: Work, options: MakeOptions, deps: MakeDeps, answers: ReturnType<typeof parseAnswer>[]): Promise<SpecResult> {
  const stored = work.read(PRIMARY.spec);
  let spec: Spec | null = null;
  if (stored !== null) {
    const parsed = SpecSchema.safeParse(JSON.parse(stored));
    if (!parsed.success) throw new MakeStop(`${work.path(PRIMARY.spec)} is not a valid spec: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    spec = parsed.data;
  }

  /**
   * `--force` re-runs the stages; it does not throw the spec away.
   *
   * The first draft read `spec.json` only when `!force`, which meant
   * `--force` on a resume — the ordinary way to recompile after editing an
   * artifact — refused with *"no brief and no spec.json"* about a spec that was
   * sitting right there. Re-deriving is a model call and a *new* spec, so it
   * happens when a brief is actually given and never as a side effect of a
   * flag about staleness.
   */
  const briefChanged = options.brief !== undefined && spec !== null && (options.force || spec.brief.trim() !== options.brief.trim());
  if (spec === null || briefChanged) {
    if (options.brief === undefined) {
      throw new MakeStop(`no brief and no ${PRIMARY.spec} in ${work.dir}: give the brief as the first argument, or point --work at a directory that already has one`);
    }
    if (!deps.openChooser) throw new MakeStop("compiling a brief into a spec needs a chooser, and none was supplied");
    spec = await briefToSpec(options.brief, await deps.openChooser(), { rubrics: [...options.rubrics] });
  } else if (options.rubrics.length > 0) {
    // Rubrics are the client's domain knowledge and they reach `reconcile`
    // through the spec. Re-supplying them on a resume must update the stored
    // spec, or U8's acceptance case — *"client's list-price rubric settles Cruz
    // Verde's ambiguity in reconcile.md, with the rule quoted"* — would depend
    // on which run happened to carry the file.
    spec = { ...spec, rubrics: [...options.rubrics] };
  }

  const applied = applyAnswers(spec, answers);
  return { spec: applied.spec, matched: applied.matched, types: applied.types };
}

// ------------------------------------------------------------------- helpers

/**
 * Refuses to overwrite an artifact a person edited.
 *
 * A stale stage rewrites its own output, and when that output is not the bytes
 * navvi wrote, rewriting it destroys somebody's work. Everywhere else in this
 * repository a destructive step shows what it would affect and asks first; a
 * compiler that eats the artifact it invited you to edit would be the
 * exception. `--force` is the yes.
 */
function overwriteGuard(work: Work, stage: StageName, edited: readonly string[], force: boolean): string | null {
  if (force || edited.length === 0) return null;
  return (
    `${edited.join(" and ")} ${edited.length === 1 ? "was" : "were"} edited by hand since navvi wrote ${edited.length === 1 ? "it" : "them"}, ` +
    `and ${stage} has to run again, which would overwrite ${edited.length === 1 ? "it" : "them"}. Re-run with --force to discard the edit, ` +
    `or move ${edited.length === 1 ? "it" : "them"} aside first.`
  );
}

function requireJson<T>(work: Work, name: string): T {
  const value = work.readJson<T>(name);
  if (value === null) throw new MakeStop(`${work.path(name)} is gone between the currency check and the read`);
  return value;
}

/** `replay`'s own list loader, which is the one spelling of "a URL that answers URLs". */
async function defaultLoadUrls(urls: readonly string[], fromUrls: readonly string[], allowPrivateHosts: readonly string[]): Promise<string[]> {
  return loadListSources(urls, fromUrls, allowPrivateHosts);
}

/**
 * Probes every URL in the catalogue, six at a time.
 *
 * Every URL, not a slice: `chooseSample` picks one page per stratum and the
 * strata it cares most about — dead, out of stock — are the minority of any
 * catalogue. Probing the first twenty of 108 would report an unfilled stratum
 * that the list actually contains, and `STRATUM_RATIONALE` would then quote,
 * in the manuscript, a reason the compile was never tested against something it
 * could have been.
 */
async function probeAll(urls: readonly string[], pages: Pages): Promise<ReturnType<typeof probeFrom>[]> {
  const CONCURRENCY = 6;
  const out: ReturnType<typeof probeFrom>[] = new Array(urls.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= urls.length) return;
      const url = urls[index]!;
      out[index] = probeFrom(url, await pages.fetch(url));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return out;
}

function filledStrata(sample: SampleChoice): number {
  return new Set(sample.picks.map((pick) => pick.stratum).filter((stratum) => stratum !== "coverage")).size;
}

/** `discounted 2, undiscounted 2, out of stock 1, dead 1`, in the strata's own order. */
function strataTally(sample: SampleChoice): string {
  const counts = new Map<string, number>();
  for (const pick of sample.picks) counts.set(pick.stratum, (counts.get(pick.stratum) ?? 0) + 1);
  const order: readonly (Stratum | "coverage")[] = ["discounted", "undiscounted", "out-of-stock", "dead", "coverage"];
  return order.filter((stratum) => counts.has(stratum)).map((stratum) => `${String(stratum).replace(/-/g, " ")} ${counts.get(stratum)}`).join(", ");
}

/** The URLs a binding was actually argued from — the sample minus the picks that carry no product. */
function bindingUrls(manuscript: Manuscript): string[] {
  return manuscript.sample.picks.filter((pick) => pick.bound).map((pick) => pick.url);
}

/**
 * The template these fields were proved on.
 *
 * `groupByTemplate` is the repository's one answer to "are these the same kind
 * of page", and the largest group wins when a sample straddles two — a sample
 * that does is a fact worth having in the ledger, and `ProvenCompileOptions`
 * takes exactly one key.
 */
function templateKeyOf(urls: readonly string[]): string {
  const groups = [...groupByTemplate(urls).entries()].sort((a, b) => b[1].length - a[1].length);
  return groups[0]?.[0] ?? "unknown";
}

/** `5 network alternatives, 3 dom kept, 2 refused by the selector gate`. */
function alternativesLine(compiled: ProvenCompile): string {
  const counts = new Map<string, number>();
  let refused = 0;
  for (const field of compiled.rationale.fields) {
    for (const alternative of field.alternatives) counts.set(alternative.source, (counts.get(alternative.source) ?? 0) + 1);
    refused += field.refused.length;
  }
  const parts = [...counts.entries()].map(([source, count]) => `${count} ${source} alternative${count === 1 ? "" : "s"}`);
  if (refused > 0) parts.push(`${refused} refused by the selector gate`);
  return parts.length > 0 ? parts.join(", ") : "no alternative survived";
}
