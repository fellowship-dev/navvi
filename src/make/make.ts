import { bulletWidth, chooserLines, makeArtifact, makeBullet, makeNote, makeRow, makeStage } from "../cli/render.js";
import { chooseSample, probeFrom, render as renderManuscript, type Manuscript, type RequestedField, type SampleChoice, type Stratum } from "../investigate/index.js";
import { outputSchema, reconcile, render as renderReconcile, summarize as summarizeReconcile, type Reconciliation } from "../reconcile/index.js";
import { NothingCompilableError, chooserOf, compileFromReconciliation, investigateTemplate, renderRationale, type ProvenCompile } from "../compile/index.js";
import { DEFAULT_REPLAYS, DEFAULT_SAMPLE_URLS, loadListSources, measureDeterminism, summarizeDeterminism, unstableFields, type Determinism, type PageReading } from "../replay/index.js";
import { canaryOrigin, fieldTypesOf, readValues, renderMachine, type CompiledScraper } from "../scraper/index.js";
import { groupByTemplate } from "../template/index.js";
import { SpecSchema, blockingQuestions, requestedFields, type Rubric, type Spec } from "../spec/schema.js";
import { briefToSpec } from "../spec/spec.js";
import { summarizeUsage, type Chooser } from "../chooser/chooser.js";
import type { FieldType } from "../input/schema.js";
import { AnswerError, applyAnswers, parseAnswer, type FieldTypes, type MatchedAnswer } from "./answers.js";
import { ARTIFACTS, PRIMARY, STAGES, Work, type StageName } from "./work.js";
import { fillLine, measurements, renderScorecard, scorecard } from "./verify.js";
import type { Pages } from "./pages.js";

/**
 * U11: `navvi make`, the driver.
 *
 * ## Why this is the unit that matters
 *
 * Every stage of the pipeline existed and was tested before this file, and
 * nothing ran them as one command: a live smoke script wired
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
 * canary is right and refusing silently is not. So `StageOutcome` has six
 * values and each one prints differently:
 *
 *  - `ran` — it did its work this run, and the block is the stage's own.
 *  - `reused` — its artifact is current, so it was not re-run. Named, because a
 *    client who answered a question and saw the old investigation reported as
 *    if it were new has been lied to by a green run.
 *  - `skipped` — it could have run and deliberately did not, with the reason.
 *  - `stopped` — it ran and refuses to hand anything downstream.
 *  - `threw` — it raised, which is a defect in navvi rather than a statement
 *    about this run. Named for the same reason as the other four: the stack it
 *    used to arrive as said which line, and never which stage.
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

/**
 * Which reading the determinism stage was handed, as a ledger argument.
 *
 * `determinism.json` keeps its shape and its `version: 1` across this change —
 * every key is still there and still typed the same — so an artifact written
 * before it is **indistinguishable to a reader** from one written after, and
 * it says something different. `keys` counted the columns the scraper compiled;
 * `resolved` counts the columns the page answered. Under `keys` every field's
 * `readOn` was the sampled URL count and no field was ever `absent`; a reader
 * comparing a new run against an old one would see coverage collapse and read
 * it as the site changing.
 *
 * Nothing in navvi's code is affected — downstream reads `verdict` and
 * `rejected`, and both mean exactly what they did. So this is a **documented
 * break for the human reader**, and the handling is that no work directory
 * mixes the two: the reading is an argument of the stage, so a
 * `determinism.json` recorded under `keys` is stale and is re-measured rather
 * than reused under the new sentence.
 *
 * The right fix is `Determinism.version: 2`, which belongs to
 * `src/replay/determinism.ts` and to whoever owns that artifact's type.
 */
const DETERMINISM_READING = "resolved";

// ------------------------------------------------------------ open decisions

/** One thing a reconciliation left for a person, as the stop block names it. */
export interface OpenItem {
  /** The ambiguity id, `<field>/disagreement`, or `obstacle/<kind>`. */
  id: string;
  because: string;
}

export type OpenDecision =
  | { action: "proceed" }
  | { action: "stop"; status: MakeStatus; because: string; items: OpenItem[] };

/**
 * What the driver does with a reconciliation's open items.
 *
 * Today there is exactly one answer — stop — and it is written as a function
 * anyway because it is about to have a second. KTD5 turns an open ambiguity
 * into a choice question for the chooser, with the case's rubrics as premise;
 * when that lands, this is where it is asked, and a chooser answer becomes
 * `proceed` with the answer recorded. Until then an unanswered choice is a
 * stop, never a silent pick: the compile used to bind one reading of an open
 * field and write "the compile bound one reading anyway" in the rationale,
 * which is the defect saying out loud that it happened.
 *
 * Two kinds of open item, two statuses. A reading nothing settles is a
 * question a person answers — `needs_answers`, exit 3, like the spec's
 * blocking questions — and a rubric for that field settles it on the next run.
 * A blocking obstacle is not a question at all, and nothing typed at the
 * prompt removes it, so a run held only by one is `short`.
 */
export function openDecision(reconciliation: Reconciliation): OpenDecision {
  if (reconciliation.verdict !== "open") return { action: "proceed" };
  const questions: OpenItem[] = [
    ...reconciliation.ambiguities
      .filter((ambiguity) => ambiguity.settledBy.length === 0)
      .map((ambiguity) => ({ id: ambiguity.id, because: ambiguity.decision ?? ambiguity.because })),
    ...(reconciliation.disagreements ?? [])
      .filter((record) => record.decision !== undefined)
      .map((record) => ({ id: `${record.field}/disagreement`, because: record.decision! })),
  ];
  const obstacles: OpenItem[] = reconciliation.obstacles
    .filter((obstacle) => obstacle.blocking)
    .map((obstacle) => ({ id: `obstacle/${obstacle.kind}`, because: obstacle.cost }));
  const items = [...questions, ...obstacles];
  if (items.length === 0) {
    // `open` with nothing to name is a reconciliation this function cannot
    // read; stopping on it is the conservative reading, and the sentence is
    // the reconciliation's own.
    return { action: "stop", status: "needs_answers", because: `the reconciliation is open: ${reconciliation.because}`, items: [] };
  }
  const fields = [...new Set(questions.map((item) => item.id.split("/")[0]!))];
  const because =
    questions.length > 0
      ? `${questions.length} open decision${questions.length === 1 ? "" : "s"} (${fields.join(", ")}) — nothing in the spec settles ${questions.length === 1 ? "it" : "them"}; add a rubric for ${fields.length === 1 ? "that field" : "those fields"} and re-run`
      : `${obstacles.length} blocking obstacle${obstacles.length === 1 ? "" : "s"} (${obstacles.map((item) => item.id).join(", ")})`;
  return { action: "stop", status: questions.length > 0 ? "needs_answers" : "short", because, items };
}

// ----------------------------------------------------------------- the report

/**
 * `threw` is the sixth and it is the one that was missing.
 *
 * `stopped` is a statement about this run's inputs that a person can act on.
 * An exception is not: it is a defect in navvi, and every stage but `spec` and
 * `compile` let one out of `make()` entirely — no `MakeResult`, no stage
 * report, and a bare stack at `bin/cli.ts`. A driver whose whole purpose is
 * *"every stage says what it read, what it wrote, and whether it ran at all"*
 * was silent about the one failure most likely to happen, because the stages
 * that throw are the stages that open a browser.
 *
 * So a throw is an outcome like the other five. There is no sixth `MakeStatus`
 * to go with it: the run did not deliver, which is `short`, and `threw` on the
 * stage is what says why.
 */
export type StageOutcome = "ran" | "reused" | "skipped" | "stopped" | "threw" | "not reached";

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
   * Builds the chooser that answers `briefToSpec`'s question and, since U4,
   * tier 3's: one choice question per field the cheap tiers left uncovered.
   *
   * A factory and not a `Chooser`, because building one resolves a credential,
   * announces the choice on stderr and may refuse the run outright — and a
   * resume (the plan's second transcript) never compiles a brief at all, and a
   * page that declares every field never reaches tier 3. A command that
   * demands an API key for a stage it was never going to run is the same false
   * failure as a stage that reports `stable` about pages it never read. The
   * driver opens it at most once and both stages share it, so the usage it
   * prints is the whole run's.
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

  /**
   * The chooser, opened at most once and only when a stage asks for it — the
   * spec's one text question or tier 3's choice questions, whichever comes
   * first. Boxed for the same reason as the pages: the `finally` below reads
   * what was opened to print its usage.
   */
  const asked: { chooser: Chooser | null } = { chooser: null };
  const openChooser = deps.openChooser;
  const needChooser =
    openChooser === undefined
      ? undefined
      : async (): Promise<Chooser> => {
          asked.chooser ??= await openChooser();
          return asked.chooser;
        };
  const stageDeps: MakeDeps = { ...deps, openChooser: needChooser };

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

  /**
   * F7: which stage the driver is inside, so an exception can be attributed to
   * one instead of arriving as a stack with no address.
   *
   * A marker and not an `at(stage, fn)` wrapper because the stages are inline
   * blocks of this function and not callables: wrapping each in a closure would
   * restructure the whole driver to carry one string. `at` is called on the
   * line the section comment already marks, so the two cannot drift apart
   * without somebody deleting the comment.
   */
  let running: StageName = "spec";
  const at = (stage: StageName): void => {
    running = stage;
  };

  try {
    // ------------------------------------------------------------------ spec

    const answers = options.answers.map(parseAnswer);
    let spec: Spec;
    let matched: MatchedAnswer[];
    let types: FieldTypes;
    try {
      ({ spec, matched, types } = await runSpec(work, options, stageDeps, answers));
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
     * thing, and the head line says which. On the first run all five of Store
     * B's are guesses — "product info" names none — so reporting "5 fields"
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
      say(makeNote("declared on the spec's field list, so a resume keeps them without repeating --answer", answerWidth + 4));
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

    at("sample");

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

    at("investigate");

    const fields: RequestedField[] = spec.fields.map((field) => (field.type === undefined ? { name: field.name } : { name: field.name, type: field.type }));
    /**
     * `tiers: 3` marks a manuscript taken by the cascade with a real tier 3.
     * One written before U4 recorded tier 3 as requested and never ran it, so
     * reusing it would carry "0 sample URLs, nothing bound" forward about a
     * page the DOM compiler can now read; the argument makes it stale instead.
     */
    const investigateParams = { site: spec.target.site, fields, tiers: 3 };
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
      /**
       * The compile core's tiers, not a second copy of them: `investigateTemplate`
       * is the same tier 1 → 2 → 3 the plain command runs, and `make` holds the
       * rest of the core apart as stages so each can be reused and edited.
       * Tier 3 gets the pages through `render` and the chooser through the same
       * lazy box the spec stage uses, so a page that declares every field opens
       * neither.
       */
      manuscript = await investigateTemplate({
        spec,
        fields,
        sample,
        sources: {
          fetch: (url) => driver.fetch(url),
          capture: (url) => driver.capture(url),
          render: (urls, use) => driver.render(urls, use),
        },
        ...(needChooser === undefined ? {} : { chooser: needChooser }),
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

    at("reconcile");

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

    /**
     * R4, the third half: an open reconciliation does not compile.
     *
     * `reconcile` says `open` — "a person decides before this compiles" — and
     * until 2026-09-23 nothing read it: the driver checked the manuscript for
     * `blocked` and the reconciliation for an empty `obtainable`, and a field
     * with eight competing readings and no rule compiled one of them anyway.
     * `openDecision` is the one place that says what happens to open items, so
     * the chooser that answers them (KTD5) has one function to change.
     */
    const decision = openDecision(reconciliation);
    if (decision.action === "stop") {
      const width = bulletWidth(decision.items.map((item) => item.id));
      for (const item of decision.items) say(makeBullet(item.id, item.because, "!", width));
      for (const later of STAGES.slice(STAGES.indexOf("reconcile") + 1)) record(later, "not reached", "the reconciliation is open: a person decides before this compiles");
      return { status: decision.status, stoppedAt: "reconcile", because: decision.because, stages, work: work.dir };
    }

    // ---------------------------------------------------------------- schema

    at("schema");

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

    at("determinism");

    const entryUrl = bindingUrls(manuscript)[0] ?? sample.picks[0]?.url;
    if (entryUrl === undefined) return stop("compile", "the sample has no URL a replay could start from", "short");
    const templateKey = templateKeyOf(bindingUrls(manuscript).length > 0 ? bindingUrls(manuscript) : sample.picks.map((pick) => pick.url));
    // Who picked the tier-3 selectors, when anyone did. `scraper.chooser` means
    // "who the compile paid", and before U4 a make-built scraper said `agent`
    // whatever happened, because nobody was paid.
    const decidedBy = chooserOf(manuscript);
    const compileOptions = { templateKey, entry: { mode: "direct" as const, url: entryUrl }, ...(decidedBy === undefined ? {} : { chooser: decidedBy }) };

    const replayUrls = bindingUrls(manuscript).slice(0, DEFAULT_SAMPLE_URLS);
    const replays = options.replays ?? DEFAULT_REPLAYS;
    const determinismParams = { replays, urls: replayUrls, compile: compileOptions, reading: DETERMINISM_READING };
    const determinismState = work.currency("determinism", ["spec.json", "investigation.json", "reconcile.json"], determinismParams);

    let determinism: Determinism | null = null;
    let determinismBecause = "";
    /**
     * What the determinism replays actually read, counted at the seam that
     * takes them.
     *
     * `determinism.json` can now be asked — see `readFor` — but only per field
     * and per URL. This is the denominator underneath it: every field of every
     * item of every reading, so `read 3 of 60` and `read 45 of 60` are two
     * different sentences and neither can be mistaken for `stable`.
     *
     * Measured on store-b.example, 2026-09-23: three payload-bound fields printed
     * `determinism 3 replays x 3 URLs, 0 fields moved` and then, four lines
     * later, `verify fill 0 of 3`. That reads as the two stages contradicting
     * each other about the same pages through the same driver. They did not.
     * They agreed that nothing came back, and only one of them was able to say
     * so — which is the more expensive half, because `stable` was the sentence
     * a person was going to believe.
     */
    let replayRead: { read: number; of: number } | null = null;
    /**
     * One reading for the determinism stage, taken through `extract` rather
     * than `read`.
     *
     * The two are one page visit — `Pages.read` is `readingOf(extract(...))` —
     * and the difference is the whole of the 2026-09-23 defect. `readingOf`
     * coerces `ItemExtraction.values`, which is null-filled so that a row has
     * every requested column whatever the page answered (R4, R8); `readValues`
     * drops the fields nothing resolved, which is what the page actually said.
     * `judgeDeterminism` counts `field in item`, so with the null-filled
     * reading `readOn` was the full URL count on every field, `Stability.absent`
     * was unreachable and a replay that read nothing was `held` everywhere.
     *
     * Nothing about the judgement changed. It was asked the wrong reading.
     */
    const readFor = async (scraper: CompiledScraper, url: string, driver: Pages): Promise<PageReading> => {
      const extraction = await driver.extract(scraper, url);
      const into = (replayRead ??= { read: 0, of: 0 });
      for (const item of extraction.items) {
        for (const name of Object.keys(scraper.fields)) {
          into.of += 1;
          if (item.resolvedBy[name] !== null && item.resolvedBy[name] !== undefined) into.read += 1;
        }
      }
      return readValues(extraction, fieldTypesOf(scraper));
    };
    if (determinismState.current && !options.force) {
      determinism = requireJson<Determinism>(work, PRIMARY.determinism);
      say(makeStage("determinism", `reused — ${determinismState.because}`, work.path(PRIMARY.determinism)));
      // The guard is not a closure round this session's readings any more. A
      // reused record is read back and recounted, so the second run of `navvi
      // make` says exactly what the first one did about a blank replay.
      const reusedCoverage = coverageOf(determinism);
      if (reusedCoverage.read < reusedCoverage.of) {
        say(makeBullet(reusedCoverage.read === 0 ? "read nothing" : "read partly", thinReplay(reusedCoverage, null, determinism.verdict), "!"));
      }
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
      determinism = await measureDeterminism(replayUrls, { read: (url) => readFor(provisional.scraper, url, driver) }, {
        site: spec.target.site,
        fields: Object.keys(provisional.scraper.fields),
        replays,
        now: now(),
      });
      work.writeJson(PRIMARY.determinism, determinism);
      work.record("determinism", ["spec.json", "investigation.json", "reconcile.json"], determinismParams);
      say(summarizeDeterminism(determinism, work.path(PRIMARY.determinism)));
      say(makeNote("read through a scraper compiled from this reconciliation, not from scraper.json, which does not exist yet"));
      // `measureDeterminism` always takes at least one reading, so this is a
      // real count and not an unset one; a driver that read nothing at all
      // leaves `{ read: 0, of: 0 }`, which `thinReplay` says differently.
      //
      // The bullet fires on every reading short of complete, not only on the
      // blank one. A replay that read 1 of 27 still prints `0 fields moved`
      // and `stable`, and the one field it read is as good a witness to
      // stability as all 27 would have been — which is the same believed
      // sentence with a smaller number behind it.
      replayRead ??= { read: 0, of: 0 };
      if (replayRead.read < replayRead.of || replayRead.of === 0) {
        say(makeBullet(replayRead.read === 0 ? "read nothing" : "read partly", thinReplay(coverageOf(determinism), replayRead, determinism.verdict), "!"));
      }
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

    at("compile");

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
      work.writeJson(PRIMARY.compile, scraper);
      work.write("rationale.md", renderRationale(compiled.rationale));
      work.write("machine.mmd", renderMachine());
      work.record("compile", ["spec.json", "investigation.json", "reconcile.json"], compileParams);

      say(makeStage("compile", "", work.path(PRIMARY.compile)));
      say(makeRow(`${Object.keys(compiled.scraper.fields).length} fields`, alternativesLine(compiled)));
      const compileWidth = bulletWidth([...rejected, ...compiled.unbound.map((field) => field.field), "unproved", "canary"]);
      // Which of the three states this scraper ships with, and the
      // investigation's own sentence for it. A scraper that cannot tell a
      // redesign from a refusal is one a healer may not repair, so it is not a
      // detail of the artifact — it is a bound on what every later run may do.
      say(
        makeBullet(
          "canary",
          canaryOrigin(scraper) === "recorded"
            ? `recorded onto the scraper — ${manuscript.canaryBecause}`
            : `refused, so a later replay may not backfill one — ${manuscript.canaryBecause}`,
          canaryOrigin(scraper) === "recorded" ? "-" : "!",
          compileWidth,
        ),
      );
      for (const field of rejected) say(makeBullet(field, "dropped: it did not hold still across the determinism replays, and a rejection is not a repair", "!", compileWidth));
      for (const field of compiled.unbound) say(makeBullet(field.field, `not bound: ${field.because}`, "!", compileWidth));
      if (determinism === null) say(makeBullet("unproved", `nothing was measured for stability — ${determinismBecause}`, "!", compileWidth));
      say(makeArtifact(work.path("rationale.md")));
      say(makeArtifact(work.path("machine.mmd")));
      record("compile", "ran", compiled.rationale.because, [...ARTIFACTS.compile]);
    }

    // ---------------------------------------------------------------- verify

    at("verify");

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
      // Null unless this session took the readings. A reused determinism.json
      // carries no values to count — a held field stores no forms — and a zero
      // invented here would be a claim about replays that never happened.
      determinismValues: replayRead,
      ...(determinismBecause === "" ? {} : { determinismBecause }),
    });
    work.write(PRIMARY.verify, renderScorecard(card));
    work.record("verify", ["reconcile.json", "scraper.json"], { fill: extractions === null ? null : extractions.length });

    say(makeStage("verify", `${card.compiled} of ${card.requested} compiled, ${fillLine(card)}`, work.path(PRIMARY.verify)));
    say(makeNote(measurements(card)));
    say(makeBullet("no grade", "the 100-point scorecard and its letter are U12, and its weights are undecided — these are the measurements it would be computed from", "!"));
    if (card.fill !== null) {
      const thin = card.fill.fields.filter((field) => field.read < field.of);
      const width = bulletWidth(thin.map((field) => field.field));
      for (const field of thin) say(makeBullet(field.field, `read on ${field.read} of ${field.of} replayed URLs`, "!", width));
    }
    record("verify", "ran", card.gradeBecause, [PRIMARY.verify]);

    return { status: "delivered", stages, work: work.dir };
  } catch (error) {
    /**
     * F7: an exception is a stage outcome, not an escape from the transcript.
     *
     * Before this, a throw out of `sample`, `investigate`, `reconcile`,
     * `schema`, `determinism` or `verify` left `make()` entirely: the caller
     * got no `MakeResult`, the report had no line for it, and `bin/cli.ts`
     * printed a stack. That is exactly the failure this driver exists to
     * prevent one layer up — the transcript could not say which stage, or why
     * — and it is the likeliest failure there is, because the stages that
     * throw are the ones that open a browser.
     *
     * The error is not swallowed into a tidy sentence: the stack goes in the
     * `because`, because a defect in navvi is read by whoever is going to fix
     * navvi. What this adds is the address.
     */
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const because = `${running} threw, which is a defect in navvi and not a statement about this run's inputs: ${detail}`;
    // A stage that recorded and then threw on its way out keeps its own line;
    // overwriting `ran` with `threw` would lose what it did manage to write.
    if (!stages.some((entry) => entry.stage === running)) record(running, "threw", because);
    for (const later of STAGES.slice(STAGES.indexOf(running) + 1)) {
      if (!stages.some((entry) => entry.stage === later)) record(later, "not reached", `${running} threw`);
    }
    say(makeStage(running, "threw"));
    say(makeBullet("threw", detail.split("\n")[0] ?? "no message", "!"));
    return { status: "short", stoppedAt: running, because, stages, work: work.dir };
  } finally {
    await open.pages?.close().catch(() => undefined);
    /**
     * Who answered, whatever the run ended as. Printed only when a chooser was
     * opened: a resume that asked nobody has nothing to attribute, and a line
     * saying "0 decisions" there would read as a chooser that was consulted
     * and had nothing to say.
     */
    if (asked.chooser !== null) {
      const usage = asked.chooser.usage();
      say(makeStage("chooser", `${usage.questions} question${usage.questions === 1 ? "" : "s"}`));
      say(chooserLines(summarizeUsage(usage)).join("\n") + "\n");
    }
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
 *  1. `briefToSpec` asks a model. It is the only *free-text* model call in
 *     `make` (tier 3's are choices over enumerated candidates, and recorded in
 *     the manuscript), it is not deterministic, and re-deriving would mean the
 *     second run's spec can differ from the one the client just read and
 *     answered — so the answers would be attached to question ids that no
 *     longer exist.
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
    // spec, or U8's acceptance case — *"the client's list-price rubric settles Store
    // B's ambiguity in reconcile.md, with the rule quoted"* — would depend
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

/**
 * How much a determinism record read, **recounted from the record itself**.
 *
 * This is the half that makes the guard survive. Counting at the driver seam
 * (`replayRead`) works for exactly one run: the closure is gone on the next
 * invocation, `determinism.json` stores no value for a field that held — a held
 * field records no forms — and the second `navvi make` over the same work
 * directory reused the artifact and printed nothing at all, which is the whole
 * defect back again one run later.
 *
 * So the number a reader gets is derived from what the artifact says about
 * itself: `readOn` per field against the URLs the record covers. A person with
 * `determinism.json` and nothing else can do this arithmetic and catch a
 * `stable` verdict over a blank replay — which is what "falsifiable from its
 * own artifact" has to mean.
 *
 * **It costs nothing in artifact size.** `readOn` was always written; it was
 * counting the wrong thing. The fix is a field that means something, not a
 * field that was added.
 *
 * The pair is (field, URL), never (field, reading): `readOn` is a count of
 * URLs by construction, and inventing a per-reading denominator here would be
 * arithmetic the artifact cannot back.
 */
function coverageOf(determinism: Determinism): { read: number; of: number } {
  return {
    read: determinism.fields.reduce((total, field) => total + field.readOn, 0),
    of: determinism.fields.length * determinism.urls.length,
  };
}

/**
 * What to say about a determinism verdict measured over readings that carried
 * fewer values than fields.
 *
 * Deliberately not a downgrade of the verdict. `judgeDeterminism` was asked
 * whether the extraction moved and it answered correctly: it did not. The
 * defect is that the answer is printed in words — `stable`, `held`, "says the
 * same thing twice about a page nobody changed" — that a reader hears as "and
 * it read something", so the run says how much of it there was.
 *
 * `live` is this session's per-reading count, or `null` on a reuse. The two
 * denominators are different on purpose and are never averaged: the live one
 * counts every reading of every item, the recount counts (field, URL) pairs,
 * and only the recount can be checked against a file.
 */
function thinReplay(coverage: { read: number; of: number }, live: { read: number; of: number } | null, verdict: Determinism["verdict"]): string {
  const measured = verdict === "insufficient" ? "the verdict" : `\`${verdict}\``;
  if (live === null) {
    if (coverage.of === 0) return `this record names no field on any URL, so ${measured} is about nothing — recounted from the artifact, which this run reused rather than measured`;
    const recounted = "recounted from the record's own `readOn`, because this run reused it rather than taking the readings";
    return coverage.read === 0
      ? `none of the ${coverage.of} (field, URL) pairs this record covers carried a value — ${recounted} — so ${measured} is the stability of a blank extraction`
      : `${coverage.read} of the ${coverage.of} (field, URL) pairs this record covers carried a value — ${recounted} — so ${measured} says nothing about the other ${coverage.of - coverage.read}`;
  }
  if (live.of === 0) return `no replay of any URL produced a single item, so ${measured} is about pages that yielded no row to compare`;
  if (live.read === 0) {
    return `every one of the ${live.of} field readings came back null, so ${measured} is the stability of a blank extraction and not evidence that anything was read`;
  }
  return (
    `${live.read} of the ${live.of} field readings carried a value, so ${measured} is about the ${live.read} that answered ` +
    `and says nothing about the other ${live.of - live.read}; \`determinism.json\` recounts it as ${coverage.read} of ${coverage.of} (field, URL) pairs, in \`readOn\``
  );
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
