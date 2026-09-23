/**
 * `src/make/`: U11, the driver — one command that runs every stage and keeps
 * its artifacts in a work directory.
 *
 * Four files and one call:
 *
 * ```ts
 * const result = await make(
 *   { work: "work/storeb", brief, rubrics, answers, urls, fromUrls, ... },
 *   { report: (text) => process.stderr.write(text), openPages, chooser },
 * );
 * ```
 *
 * - `make.ts`    — the sequence: spec, sample, investigate, reconcile, schema,
 *                  determinism, compile, verify, and what each one is allowed
 *                  to skip.
 * - `work.ts`    — the work directory, the ledger, and the rule that decides
 *                  whether a stage has to run again.
 * - `answers.ts` — `--answer key=value` and what it may do to a spec.
 * - `pages.ts`   — the only part that opens a browser. Everything else is pure
 *                  or file IO, which is what lets the whole pipeline be driven
 *                  from fixtures in `tests/make.test.ts`.
 * - `verify.ts`  — the measurements a scorecard would be computed from, and the
 *                  grade it refuses to invent. **U12 is not done**; see its
 *                  header for exactly what is missing.
 */
export { make, type MakeDeps, type MakeOptions, type MakeResult, type MakeStatus, type StageOutcome, type StageReport } from "./make.js";
export { AnswerError, applyAnswers, matchAnswer, parseAnswer, stillBlocking, type Answer, type AppliedAnswers, type FieldTypes, type MatchedAnswer } from "./answers.js";
export { ARTIFACTS, LEDGER_FILE, PRIMARY, STAGES, Work, digestOf, digestOfParams, type Currency, type Ledger, type StageLedger, type StageName } from "./work.js";
export { CAPTURE_LIMIT, SETTLE_CAP_MS, openPages, plainFetch, type Pages, type PagesOptions } from "./pages.js";
export { fillLine, measurements, renderScorecard, scorecard, type FieldFill, type Scorecard, type ScorecardOptions, type SourceMix } from "./verify.js";
