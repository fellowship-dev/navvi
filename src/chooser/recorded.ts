import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BaseChooser, ConfigurationError, optionIdentity, type Answer, type BackendResult, type BaseChooserOptions, type Chooser, type ChooserName, type ChooserUsage, type Price, type Question } from "./chooser.js";

/**
 * KTD12: offline tests replay `tests/recorded/<fixture>/<questionId>.json`.
 * Recorder mode wraps a live chooser and writes those files; it is disabled
 * on the Apify platform (`APIFY_IS_AT_HOME`).
 *
 * ## Why a recording carries its options
 *
 * A recorded answer is an *index*. Replaying it by question id alone assumes
 * the option at that index is still the option the live chooser was looking at,
 * and nothing checked that: a candidate-ordering change in `compile/fields.ts`
 * or `compile/groups.ts` would have roughly forty tests across this repository
 * silently answer a **different candidate** and stay green (2026-09-22 audit,
 * §5.6 — the highest-leverage gap it found).
 *
 * So a recording states the options it was answering. On replay, the candidates
 * those options name must equal the candidates offered today, in order, or the
 * run fails loudly: the recording is stale and the test that depends on it is
 * meaningless until someone looks. What is deliberately *not* compared is the
 * page content an option quotes — the sampled values, and the fixture server's
 * ephemeral port — because neither is the candidate. See `comparableOption`.
 *
 * A recording written before this existed has no `options` and cannot be
 * checked. That is not a failure — the fixtures predate the field — but it is
 * not a pass either: it is reported once per question on stderr as
 * unverifiable, and `NAVVI_RECORD_OPTIONS=1` re-records the options of every
 * question a run replays, which is how a fixture set is brought up to date (and
 * how a deliberate ordering change is accepted after it has been reviewed).
 */

export const DEFAULT_RECORDED_DIR = join("tests", "recorded");

/** Set to `1` to write today's offered options into every recording a run replays. */
export const RECORD_OPTIONS_ENV = "NAVVI_RECORD_OPTIONS";

export interface RecordedAnswerFile extends Answer {
  kind?: Question["kind"];
  /**
   * The options offered when this answer was recorded, in offer order.
   *
   * Absent on a recording written before the check existed, which makes that
   * recording unverifiable rather than wrong. Present and naming different
   * candidates from today's options means the index no longer points where it
   * pointed. Stored through `normalizeOption`, so the file is the same bytes on
   * every machine.
   */
  options?: string[];
  /** A human annotation of what the index picked ("TYPE_TEXT"); free text, never checked. */
  note?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** The chooser that produced the recording. */
  chooser?: ChooserName;
}

/**
 * A recording's options no longer match what the code offers: the index means
 * something else now.
 *
 * A `ConfigurationError`, not a model failure — the fixture is stale, retrying
 * cannot help, and `BaseChooser` lets a `NavviError` through its retry loop
 * unwrapped so the message reaches whoever has to re-record.
 */
export class RecordedOptionsMismatchError extends ConfigurationError {
  readonly questionId: string;
  readonly fixture: string;
  readonly file: string;
  readonly recorded: readonly string[];
  readonly offered: readonly string[];
  constructor(fixture: string, questionId: string, file: string, recordedRaw: readonly string[], offeredRaw: readonly string[]) {
    // Reported in the compared form, so the difference the message points at is
    // the difference the check actually objected to.
    const recorded = recordedRaw.map(comparableOption);
    const offered = offeredRaw.map(comparableOption);
    const first = firstDifference(recorded, offered);
    super(
      `recorded answer for question "${questionId}" in fixture "${fixture}" answered different options than the code offers today, ` +
        `so its index no longer means what it meant when it was recorded.\n` +
        `  recorded ${recorded.length} option(s), offered ${offered.length}\n` +
        `  first difference at index ${first}:\n` +
        `    recorded: ${JSON.stringify(recorded[first] ?? null)}\n` +
        `    offered:  ${JSON.stringify(offered[first] ?? null)}\n` +
        `  ${file}\n` +
        `  If the new ordering is intended, re-record with ${RECORD_OPTIONS_ENV}=1 and check that every recorded index still picks the candidate it named.`,
    );
    this.name = "RecordedOptionsMismatchError";
    this.questionId = questionId;
    this.fixture = fixture;
    this.file = file;
    this.recorded = recorded;
    this.offered = offered;
  }
}

function firstDifference(a: readonly string[], b: readonly string[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) if (a[i] !== b[i]) return i;
  return 0;
}

/**
 * A loopback origin with the port blanked.
 *
 * Link and control options quote absolute URLs, and in tests those URLs carry
 * whatever ephemeral port the fixture server bound this run. That is not a
 * change in what the chooser was offered, so it is normalised away on both
 * sides — and written normalised, so a recording is the same bytes on every
 * machine. Nothing else about the option is touched: a different host, path,
 * query or label is a real difference and still fails.
 */
const LOOPBACK_PORT = /\b(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+/g;

/** The stored form of an offered option: what was offered, minus the ephemeral port. */
export function normalizeOption(option: string): string {
  return option.replace(LOOPBACK_PORT, "$1:*");
}

/**
 * The compared form: the candidate the option names, without the values it
 * quoted from this run's sample pages.
 *
 * `optionIdentity` is `src`'s own split, used by the label builder itself, so
 * this is not a second reading of the label format. The values are dropped
 * because one recorded fixture is replayed by callers that sample different
 * pages of the same site — `compile/pharmacy-v1` is compiled from three
 * products by `compile.test.ts` and three others by `acceptance.test.ts` — and
 * the index answers the candidate, not the sample. Everything that identifies
 * the candidate is still compared: its path, its attribute, its position in the
 * list, and how many candidates there are.
 *
 * What dropping the values does **not** make page-independent is the *order*.
 * `rankHealCandidates` ranks a heal question's options by value — a candidate
 * whose value matches an earlier sample goes first — so two pages of one
 * template can offer the same candidates in different positions, and a
 * recording made on one genuinely does not answer the other. That is a property
 * of the caller's question rather than of this check, and the caller answers it
 * by recording a fixture per page: see `HEAL_FIXTURE_BY_PAGE` in
 * `scripts/demo.ts`, and the one-in-three flake it was written for.
 */
export function comparableOption(option: string): string {
  return optionIdentity(normalizeOption(option));
}

const sameOptions = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((option, i) => comparableOption(option) === comparableOption(b[i]!));

/** One warning per unverifiable recording per process, so a suite does not print the same line forty times. */
const warnedUnverifiable = new Set<string>();

export interface RecordedChooserOptions extends BaseChooserOptions {
  fixture: string;
  dir?: string;
  /** Defaults to `process.env`; read for `NAVVI_RECORD_OPTIONS`. */
  env?: NodeJS.ProcessEnv;
  /** Where the unverifiable-recording warning goes. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

export class RecordedChooser extends BaseChooser {
  readonly name: ChooserName = "recorded";
  protected readonly failureStatus = "model_unavailable" as const;
  protected readonly price: Price = { inputPerMillion: 0, outputPerMillion: 0 };
  private readonly dir: string;
  private readonly fixture: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly warn: (message: string) => void;
  /** Questions replayed this run whose recording stated its options and matched. */
  verifiedOptions = 0;
  /** Question ids replayed this run whose recording predates the options check. */
  readonly unverifiedOptions: string[] = [];

  constructor(options: RecordedChooserOptions) {
    super(options);
    this.fixture = options.fixture;
    this.dir = resolve(options.dir ?? DEFAULT_RECORDED_DIR);
    this.env = options.env ?? process.env;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  protected async callBackend(batch: Question[]): Promise<BackendResult> {
    let inputTokens = 0;
    let outputTokens = 0;
    const rerecord = Boolean(this.env[RECORD_OPTIONS_ENV]);
    const answers = batch.map((q) => {
      const file = join(this.dir, this.fixture, `${q.id}.json`);
      if (!existsSync(file)) {
        throw new Error(`no recorded answer for question "${q.id}" in fixture "${this.fixture}" (expected ${file}); run once with a live chooser wrapped in RecordingChooser`);
      }
      const recorded = JSON.parse(readFileSync(file, "utf8")) as RecordedAnswerFile;
      const offered = q.options ?? [];
      if (rerecord) {
        writeFileSync(file, JSON.stringify({ ...recorded, options: offered.map(normalizeOption) }, null, 2) + "\n");
      } else if (recorded.options) {
        // The index is only an answer to the options it was recorded against.
        if (!sameOptions(recorded.options, offered)) {
          throw new RecordedOptionsMismatchError(this.fixture, q.id, file, recorded.options, offered);
        }
        this.verifiedOptions += 1;
      } else {
        this.unverifiedOptions.push(q.id);
        if (!warnedUnverifiable.has(file)) {
          warnedUnverifiable.add(file);
          this.warn(`navvi: recorded answer "${q.id}" in fixture "${this.fixture}" states no options, so the replayed index is unverified — re-record with ${RECORD_OPTIONS_ENV}=1 (${file})`);
        }
      }
      inputTokens += recorded.inputTokens ?? 0;
      outputTokens += recorded.outputTokens ?? 0;
      const { id: _id, kind: _kind, options: _opts, note: _n, inputTokens: _i, outputTokens: _o, chooser: _c, ...answer } = recorded;
      return { id: q.id, ...answer };
    });
    return { answers, inputTokens, outputTokens };
  }
}

export interface RecordingChooserOptions {
  fixture: string;
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

/** Wraps a live chooser and writes each answer as a fixture file, unless running on Apify. */
export class RecordingChooser implements Chooser {
  readonly name: ChooserName;
  readonly enabled: boolean;
  private readonly inner: Chooser;
  private readonly target: string;

  constructor(inner: Chooser, options: RecordingChooserOptions) {
    this.inner = inner;
    this.name = inner.name;
    this.enabled = !(options.env ?? process.env).APIFY_IS_AT_HOME;
    this.target = join(resolve(options.dir ?? DEFAULT_RECORDED_DIR), options.fixture);
  }

  async ask(batch: Question[]): Promise<Answer[]> {
    const before = this.inner.usage();
    const answers = await this.inner.ask(batch);
    if (!this.enabled) return answers;
    const after = this.inner.usage();
    const share = batch.length === 0 ? 0 : 1 / batch.length;
    mkdirSync(this.target, { recursive: true });
    for (const answer of answers) {
      const q = batch.find((x) => x.id === answer.id);
      const file: RecordedAnswerFile = {
        ...answer,
        kind: q?.kind,
        // The options the index answers. Without them the replay is a bare
        // index against whatever the code offers on the day it is replayed.
        ...(q?.options ? { options: q.options.map(normalizeOption) } : {}),
        inputTokens: Math.round((after.inputTokens - before.inputTokens) * share),
        outputTokens: Math.round((after.outputTokens - before.outputTokens) * share),
        chooser: this.inner.name,
      };
      writeFileSync(join(this.target, `${answer.id}.json`), JSON.stringify(file, null, 2) + "\n");
    }
    return answers;
  }

  usage(): ChooserUsage {
    return this.inner.usage();
  }
}
