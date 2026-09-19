import { randomBytes } from "node:crypto";
import { fstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NeedsHumanError } from "../billing/budget.js";
import { BaseChooser, type Answer, type BackendResult, type BaseChooserOptions, type ChooserName, type Price, type Question } from "./chooser.js";

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

export interface QuestionBatchFile {
  protocol: typeof PROTOCOL;
  token: string;
  createdAt: string;
  questions: Question[];
  answerWith: string;
  /** Every answer already known when this batch parked; carried into the next resume so a reader never re-answers. */
  answered?: Answer[];
}

export interface AgentChooserOptions extends BaseChooserOptions {
  /** Injectable for tests. `null` means the host has no stdin at all. */
  stdin?: NodeJS.ReadableStream | null;
  stdout?: NodeJS.WritableStream;
  questionsDir?: string;
  timeoutMs?: number;
  /** Preloaded answers (`--answers <file>`), consumed before any I/O. */
  answers?: Answer[];
  resumeToken?: string;
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
export function loadAnswersFile(path: string): Answer[] {
  const parsed = parseAnswerBatch(readFileSync(path, "utf8"));
  if (!parsed) throw new Error(`answers file ${path} is not a JSON answer batch`);
  return parsed.filter((a): a is Answer => typeof a === "object" && a !== null && typeof (a as { id?: unknown }).id === "string");
}

export function readQuestionsFile(token: string, dir = DEFAULT_QUESTIONS_DIR): QuestionBatchFile {
  return JSON.parse(readFileSync(join(dir, `${token}.json`), "utf8")) as QuestionBatchFile;
}

export class AgentChooser extends BaseChooser {
  readonly name: ChooserName = "agent";
  protected readonly failureStatus = "needs_human" as const;
  protected readonly price: Price = { inputPerMillion: 0, outputPerMillion: 0 };
  readonly mode: AgentMode;
  readonly resumeToken: string | undefined;

  private readonly stdin: NodeJS.ReadableStream | null;
  private readonly stdout: NodeJS.WritableStream;
  private readonly questionsDir: string;
  private readonly timeoutMs: number;
  private readonly preloaded: Map<string, Answer>;

  constructor(options: AgentChooserOptions = {}) {
    super({ ...options, maxAttempts: 1 });
    const env = options.env ?? process.env;
    this.stdin = options.stdin === undefined ? process.stdin : options.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.questionsDir = options.questionsDir ?? env.NAVVI_QUESTIONS_DIR ?? DEFAULT_QUESTIONS_DIR;
    this.timeoutMs = options.timeoutMs ?? Number(env.NAVVI_AGENT_TIMEOUT_MS ?? DEFAULT_AGENT_TIMEOUT_MS);
    this.mode = options.mode ?? detectMode(this.stdin, env);
    this.resumeToken = options.resumeToken;
    this.preloaded = new Map((options.answers ?? []).map((a) => [a.id, a]));
  }

  protected async callBackend(batch: Question[]): Promise<BackendResult> {
    const answers: unknown[] = [];
    const pending: Question[] = [];
    for (const q of batch) {
      const known = this.preloaded.get(q.id);
      if (known) {
        answers.push(known);
      } else {
        pending.push(q);
      }
    }
    if (pending.length === 0) return { answers };
    if (this.mode !== "stdio" || !this.stdin) {
      throw this.park(pending, this.mode === "unattended" ? "unattended run: no process can answer" : "stdin cannot deliver answers");
    }
    const replies = await this.roundTrip(pending, this.stdin);
    return { answers: [...answers, ...replies] };
  }

  /** Write the batch to storage/questions and build the needs_human error carrying the token. */
  private park(batch: Question[], reason: string): NeedsHumanError {
    const token = randomBytes(6).toString("hex");
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
      questions,
      answerWith: 'JSON {"answers":[{"id":"<question id>","index":<option index or null for none; booleans 1/0>,"text":"<text questions only>"}]}',
      answered: [...this.preloaded.values()],
    };
    writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
    return file;
  }

  private roundTrip(batch: Question[], stdin: NodeJS.ReadableStream): Promise<unknown[]> {
    const token = randomBytes(6).toString("hex");
    const payload = { protocol: PROTOCOL, token, questions: batch };
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
        reject(this.park(batch, reason));
      };
      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        if (!buffer.includes("\n")) return;
        const parsed = parseAnswerBatch(buffer);
        if (parsed) {
          cleanup();
          resolvePromise(parsed);
        }
      };
      const onEnd = () => fail("no answering process on stdin");
      const timer = setTimeout(() => fail(`no answer within ${this.timeoutMs} ms`), this.timeoutMs);
      stdin.on("data", onData);
      stdin.once("end", onEnd);
      stdin.once("close", onEnd);
      stdin.once("error", onEnd);
      if (typeof (stdin as { resume?: () => void }).resume === "function") (stdin as { resume: () => void }).resume();
    });
  }
}
