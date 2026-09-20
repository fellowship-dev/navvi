import { createHash, randomBytes } from "node:crypto";
import { fstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NeedsHumanError } from "../billing/budget.js";
import { BaseChooser, validateAnswers, type Answer, type BackendResult, type BaseChooserOptions, type ChooserName, type Price, type Question } from "./chooser.js";

/**
 * R45 / KTD17: the host coding agent answers over stdio. The CLI prints one
 * JSON question batch between sentinels and waits for one JSON answer batch
 * on stdin. When no process can answer, the batch is written to
 * `storage/questions/<token>.json` and the run ends `needs_human` with the
 * token; `--answers <file> --resume <token>` continues from the file.
 */

export const PROTOCOL = "navvi-questions/1";
export const QUESTIONS_START = "---NAVVI-QUESTIONS---";
export const QUESTIONS_END = "---END---";
export const DEFAULT_QUESTIONS_DIR = join("storage", "questions");
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1_000;

export type AgentMode = "stdio" | "file" | "unattended";
/** The answer shape every reader is told, in the parked file and in a CLI prompt. */
export const ANSWER_WITH = 'JSON {"answers":[{"id":"<question id>","index":<option index or null for none; booleans 1/0>,"text":"<text questions only>"}]}';

export interface QuestionBatchFile {
  protocol: typeof PROTOCOL;
  token: string;
  createdAt: string;
  questions: Question[];
  answerWith: string;
  /** Every answer already known when this batch parked; carried into the next resume so a reader never re-answers. */
  answered?: StoredAnswer[];
}

/**
 * An answer with the question it was given to: `asked` is `questionKey()` of
 * the kind and options offered. Question ids repeat across pages, templates
 * and navigations with different option lists, so an answer without `asked`
 * (a hand-written `--answers` file) is spent on the first question carrying
 * its id and never re-served to a different question of the same id.
 */
export interface StoredAnswer extends Answer {
  asked?: string;
}

/** The wire form of a question: premise, options and state; the structured context is for JSON backends only. */
export function wireQuestion(q: Question): Question {
  const { context: _context, optionContext: _optionContext, ...wire } = q;
  return wire;
}

/** What an answer commits to: the question kind and its offered options, not the id alone. */
export function questionKey(q: Pick<Question, "kind" | "options">): string {
  return createHash("sha256").update(JSON.stringify([q.kind, q.options ?? []])).digest("hex").slice(0, 16);
}

function memoryKey(id: string, asked: string): string {
  return `${id}#${asked}`;
}

export interface AgentChooserOptions extends BaseChooserOptions {
  /** Injectable for tests. `null` means the host has no stdin at all. */
  stdin?: NodeJS.ReadableStream | null;
  stdout?: NodeJS.WritableStream;
  questionsDir?: string;
  timeoutMs?: number;
  /** Preloaded answers (`--answers <file>`), consumed before any I/O. */
  answers?: StoredAnswer[];
  mode?: "stdio" | "file";
  env?: NodeJS.ProcessEnv;
}

type Streamish = { isTTY?: boolean; fd?: number };

function detectMode(stdin: NodeJS.ReadableStream | null | undefined, env: NodeJS.ProcessEnv): AgentMode {
  if (env.NAVVI_AGENT_MODE === "file" || env.NAVVI_AGENT_MODE === "stdio") return env.NAVVI_AGENT_MODE;
  if (env.APIFY_IS_AT_HOME) return "unattended";
  if (!stdin) return "file";
  const s = stdin as Streamish;
  if (s.isTTY) return "stdio";
  if (typeof s.fd === "number") {
    try {
      const stat = fstatSync(s.fd);
      // A character device that is not a TTY is /dev/null: nobody will answer.
      if (stat.isCharacterDevice()) return "file";
    } catch {
      return "file";
    }
  }
  return "stdio";
}

function parseAnswerBatch(text: string): unknown[] | undefined {
  const body = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("---"))
    .join("\n")
    .trim();
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { answers?: unknown }).answers)) {
    return (parsed as { answers: unknown[] }).answers;
  }
  return [];
}

/** Read `--answers <file>`: `{ "answers": [...] }` or a bare array. */
export function loadAnswersFile(path: string): StoredAnswer[] {
  const parsed = parseAnswerBatch(readFileSync(path, "utf8"));
  if (!parsed) throw new Error(`answers file ${path} is not a JSON answer batch`);
  return parsed.filter((a): a is StoredAnswer => typeof a === "object" && a !== null && typeof (a as { id?: unknown }).id === "string");
}

/** Merge answer lists: an answer with `asked` is one per question, one without is one per id; later lists win. */
export function mergeAnswers(...lists: ReadonlyArray<readonly StoredAnswer[]>): StoredAnswer[] {
  const merged = new Map<string, StoredAnswer>();
  for (const list of lists) {
    for (const a of list) merged.set(typeof a.asked === "string" ? memoryKey(a.id, a.asked) : a.id, a);
  }
  return [...merged.values()];
}

export function readQuestionsFile(token: string, dir = DEFAULT_QUESTIONS_DIR): QuestionBatchFile {
  return JSON.parse(readFileSync(join(dir, `${token}.json`), "utf8")) as QuestionBatchFile;
}

export class AgentChooser extends BaseChooser {
  readonly name: ChooserName = "agent";
  protected readonly failureStatus = "needs_human" as const;
  protected readonly price: Price = { inputPerMillion: 0, outputPerMillion: 0 };
  readonly mode: AgentMode;

  private readonly stdin: NodeJS.ReadableStream | null;
  private readonly stdout: NodeJS.WritableStream;
  private readonly questionsDir: string;
  private readonly timeoutMs: number;
  /** Every answer known so far, keyed by id and `questionKey`: preloaded from `--answers`, plus each one that arrived over stdio. A park carries them all. */
  private readonly answered: Map<string, StoredAnswer>;
  /** Preloaded answers without `asked`: each is spent on the first question carrying its id. */
  private readonly unkeyed: Map<string, StoredAnswer>;

  constructor(options: AgentChooserOptions = {}) {
    super({ ...options, maxAttempts: 1 });
    const env = options.env ?? process.env;
    this.stdin = options.stdin === undefined ? process.stdin : options.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.questionsDir = options.questionsDir ?? env.NAVVI_QUESTIONS_DIR ?? DEFAULT_QUESTIONS_DIR;
    this.timeoutMs = options.timeoutMs ?? Number(env.NAVVI_AGENT_TIMEOUT_MS ?? DEFAULT_AGENT_TIMEOUT_MS);
    this.mode = options.mode ?? detectMode(this.stdin, env);
    this.answered = new Map();
    this.unkeyed = new Map();
    for (const a of options.answers ?? []) {
      if (typeof a.asked === "string") this.answered.set(memoryKey(a.id, a.asked), a);
      else this.unkeyed.set(a.id, a);
    }
  }

  /** The remembered answer for exactly this question, or undefined. An invalid one is forgotten so the question reaches stdio or parks. */
  private recall(q: Question): Answer | undefined {
    const asked = questionKey(q);
    const key = memoryKey(q.id, asked);
    let known = this.answered.get(key);
    if (!known) {
      const spare = this.unkeyed.get(q.id);
      if (!spare) return undefined;
      this.unkeyed.delete(q.id);
      known = { ...spare, asked };
      this.answered.set(key, known);
    }
    if (validateAnswers([q], [known]).valid.length === 1) return known;
    this.answered.delete(key);
    return undefined;
  }

  private remember(q: Question, answer: Answer): void {
    const asked = questionKey(q);
    this.answered.set(memoryKey(q.id, asked), { ...answer, asked });
  }

  protected async callBackend(batch: Question[]): Promise<BackendResult> {
    const answers: unknown[] = [];
    const pending: Question[] = [];
    for (const q of batch) {
      const known = this.recall(q);
      if (known) {
        answers.push(known);
      } else {
        pending.push(q);
      }
    }
    if (pending.length === 0) return { answers };
    const token = randomBytes(6).toString("hex");
    if (this.mode !== "stdio" || !this.stdin) {
      throw this.park(pending, this.mode === "unattended" ? "unattended run: no process can answer" : "stdin cannot deliver answers", token);
    }
    const replies = await this.roundTrip(pending, this.stdin, token);
    // Only valid replies are kept: an invalid one must reach stdio again on the base class's retry.
    const byId = new Map(pending.map((q) => [q.id, q]));
    for (const reply of validateAnswers(pending, replies).valid) this.remember(byId.get(reply.id)!, reply);
    return { answers: [...answers, ...replies] };
  }

  /** Write the batch to storage/questions and build the needs_human error carrying the token, the one the stdio batch printed. */
  private park(batch: Question[], reason: string, token: string): NeedsHumanError {
    const file = this.writeBatch(token, batch);
    return new NeedsHumanError(
      `agent chooser needs answers (${reason}). Questions written to ${file}; answer them and rerun with --answers <file> --resume ${token}`,
      { token, questionsFile: file },
    );
  }

  private writeBatch(token: string, questions: Question[]): string {
    const dir = resolve(this.questionsDir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${token}.json`);
    const payload: QuestionBatchFile = {
      protocol: PROTOCOL,
      token,
      createdAt: new Date().toISOString(),
      questions: questions.map(wireQuestion),
      answerWith: ANSWER_WITH,
      answered: [...this.answered.values()],
    };
    writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
    return file;
  }

  private roundTrip(batch: Question[], stdin: NodeJS.ReadableStream, token: string): Promise<unknown[]> {
    const payload = { protocol: PROTOCOL, token, questions: batch.map(wireQuestion) };
    this.stdout.write(`${QUESTIONS_START}\n${JSON.stringify(payload, null, 2)}\n${QUESTIONS_END}\n`);

    return new Promise<unknown[]>((resolvePromise, reject) => {
      let buffer = "";
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("close", onEnd);
        stdin.removeListener("error", onEnd);
        if (typeof (stdin as { pause?: () => void }).pause === "function") (stdin as { pause: () => void }).pause();
      };
      const fail = (reason: string) => {
        if (settled) return;
        cleanup();
        reject(this.park(batch, reason, token));
      };
      const settle = (): boolean => {
        const parsed = parseAnswerBatch(buffer);
        if (!parsed) return false;
        cleanup();
        resolvePromise(parsed);
        return true;
      };
      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        if (buffer.includes("\n")) settle();
      };
      // A closing stdin may still hold an answer without its trailing newline.
      const onEnd = () => {
        if (settled || settle()) return;
        fail("no answering process on stdin");
      };
      const timer = setTimeout(() => fail(`no answer within ${this.timeoutMs} ms`), this.timeoutMs);
      stdin.on("data", onData);
      stdin.once("end", onEnd);
      stdin.once("close", onEnd);
      stdin.once("error", onEnd);
      if (typeof (stdin as { resume?: () => void }).resume === "function") (stdin as { resume: () => void }).resume();
    });
  }
}
