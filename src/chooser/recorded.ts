import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BaseChooser, type Answer, type BackendResult, type BaseChooserOptions, type Chooser, type ChooserName, type ChooserUsage, type Price, type Question } from "./chooser.js";

/**
 * KTD12: offline tests replay `tests/recorded/<fixture>/<questionId>.json`.
 * Recorder mode wraps a live chooser and writes those files; it is disabled
 * on the Apify platform (`APIFY_IS_AT_HOME`).
 */

export const DEFAULT_RECORDED_DIR = join("tests", "recorded");

export interface RecordedAnswerFile extends Answer {
  kind?: Question["kind"];
  inputTokens?: number;
  outputTokens?: number;
  /** The chooser that produced the recording. */
  chooser?: ChooserName;
}

export interface RecordedChooserOptions extends BaseChooserOptions {
  fixture: string;
  dir?: string;
}

export class RecordedChooser extends BaseChooser {
  readonly name: ChooserName = "recorded";
  protected readonly failureStatus = "model_unavailable" as const;
  protected readonly price: Price = { inputPerMillion: 0, outputPerMillion: 0 };
  private readonly dir: string;
  private readonly fixture: string;

  constructor(options: RecordedChooserOptions) {
    super(options);
    this.fixture = options.fixture;
    this.dir = resolve(options.dir ?? DEFAULT_RECORDED_DIR);
  }

  protected async callBackend(batch: Question[]): Promise<BackendResult> {
    let inputTokens = 0;
    let outputTokens = 0;
    const answers = batch.map((q) => {
      const file = join(this.dir, this.fixture, `${q.id}.json`);
      if (!existsSync(file)) {
        throw new Error(`no recorded answer for question "${q.id}" in fixture "${this.fixture}" (expected ${file}); run once with a live chooser wrapped in RecordingChooser`);
      }
      const recorded = JSON.parse(readFileSync(file, "utf8")) as RecordedAnswerFile;
      inputTokens += recorded.inputTokens ?? 0;
      outputTokens += recorded.outputTokens ?? 0;
      const { id: _id, kind: _kind, inputTokens: _i, outputTokens: _o, chooser: _c, ...answer } = recorded;
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
