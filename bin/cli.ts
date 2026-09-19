#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Actor } from "apify";
import { LogLevel, MemoryStorage, log as crawleeLog } from "crawlee";
import { ZodError } from "zod";
import { parseArgs, usage, type CliArgs } from "../src/cli/args.js";
import { NotifyConfigurationError, createNotifier } from "../src/cli/notify.js";
import { formatRows, type OutputFormat, type Row } from "../src/cli/output.js";
import { createChooser, loadAnswersFile, missingCredentialsMessage, NavviError, NeedsHumanError, type Answer, type Chooser } from "../src/chooser/index.js";
import { promptToInput } from "../src/input/prompt.js";
import { defaultBrowser, defaultChooser, parseInput, type RunInput } from "../src/input/schema.js";
import { formatValidationError, run as runNavvi, type RunSummary } from "../src/main.js";
import type { Notifier } from "../src/prestep/human.js";
import type { CrawlActor, CrawlDeps } from "../src/replay/crawler.js";
import type { Status } from "../src/scraper/schema.js";

/**
 * U17 / R35: `npx navvi "<prompt>" <url...>`. Runnable by an agent without
 * reading code: data on stdout (or --out), a human summary on stderr, and
 * exit codes that say what to do next. With the agent chooser in stdio mode
 * the question batches share stdout with nothing else: the data is printed
 * only once the run has ended.
 */

export type RunFn = (raw: unknown, deps?: CrawlDeps) => Promise<RunSummary>;

export interface CliIo {
  /** `null` when the host has no stdin; the agent chooser then parks its questions. */
  stdin: NodeJS.ReadableStream | null;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Injectable for tests; defaults to `run` from src/main.ts. */
  run?: RunFn | undefined;
  fetch?: typeof fetch | undefined;
  /** How a missing `--secret` is asked for on a TTY; defaults to a hidden prompt on stdin. */
  promptSecret?: ((name: string) => Promise<string | null>) | undefined;
}

export const EXIT = { ok: 0, short: 1, configuration: 2, needsHuman: 3, budget: 4 } as const;

const SECRET_ENV_PREFIX = "NAVVI_SECRET_";

class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT.configuration,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function exitCodeFor(status: Status): number {
  switch (status) {
    case "succeeded":
      return EXIT.ok;
    case "needs_human":
      return EXIT.needsHuman;
    case "budget_exhausted":
    case "model_unavailable":
    case "charge_limit":
      return EXIT.budget;
    case "no_items_found":
    case "drift":
    case "blocked_bot_detection":
    case "blocked_login_required":
    case "blocked_no_progress":
      return EXIT.short;
  }
}

/** `NAVVI_SECRET_<NAME>`: upper case, anything but [A-Z0-9] becomes an underscore. */
export function secretEnvName(name: string): string {
  return `${SECRET_ENV_PREFIX}${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "navvi" && pkg.version) return pkg.version;
    }
    dir = dirname(dir);
  }
  return "0.0.0";
}

// ---------------------------------------------------------------- secrets

async function collectSecrets(args: CliArgs, io: CliIo): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  if (args.secretsFile) {
    const file = resolve(io.cwd, args.secretsFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new CliError(`--secrets-file ${args.secretsFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new CliError(`--secrets-file ${args.secretsFile} must be a JSON object of name -> value`);
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") throw new CliError(`--secrets-file ${args.secretsFile}: secret "${name}" is not a string`);
      secrets[name] = value;
    }
  }
  for (const name of args.secrets) {
    const envName = secretEnvName(name);
    const fromEnv = io.env[envName];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      secrets[name] = fromEnv;
      continue;
    }
    const asked = await (io.promptSecret ?? defaultSecretPrompt(io))(name);
    if (asked === null) throw new CliError(`--secret ${name}: set ${envName} in the environment (or run on a TTY to be prompted). Never pass the value on the command line.`);
    secrets[name] = asked;
  }
  return secrets;
}

/** Hidden prompt on a TTY stdin; `null` when there is no TTY to ask on. */
function defaultSecretPrompt(io: CliIo): (name: string) => Promise<string | null> {
  return (name) => {
    const stdin = io.stdin as (NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => void }) | null;
    if (!stdin?.isTTY || typeof stdin.setRawMode !== "function") return Promise.resolve(null);
    return new Promise((done) => {
      let value = "";
      io.stderr.write(`Secret ${name} (hidden): `);
      stdin.setRawMode!(true);
      stdin.resume();
      const onData = (chunk: Buffer | string) => {
        for (const ch of chunk.toString()) {
          if (ch === "\r" || ch === "\n") {
            stdin.removeListener("data", onData);
            stdin.setRawMode!(false);
            stdin.pause();
            io.stderr.write("\n");
            done(value);
            return;
          }
          if (ch === "\u0003") {
            stdin.removeListener("data", onData);
            stdin.setRawMode!(false);
            io.stderr.write("\n");
            done(null);
            return;
          }
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on("data", onData);
    });
  };
}

// ---------------------------------------------------------------- input

function baseInput(args: CliArgs, secrets: Record<string, string>): Record<string, unknown> {
  const hasSecrets = Object.keys(secrets).length > 0;
  const base: Record<string, unknown> = {
    startUrls: [...args.fromUrls, ...args.urls],
    allowedDomains: args.allowDomains,
    allowPrivateHosts: args.allowPrivateHosts,
    allowMutations: args.allowMutations,
    freshProfile: args.freshProfile,
    headed: args.headed,
    forceRecompile: args.forceRecompile,
    secrets,
  };
  if (args.mode) base.mode = args.mode;
  if (args.fields) base.fields = args.fields.map((name) => ({ name }));
  if (args.goal) base.goal = args.goal;
  if (args.maxPages !== undefined) base.maxPages = args.maxPages;
  if (args.maxItems !== undefined) base.maxItems = args.maxItems;
  if (args.followDetails) base.followDetailPages = true;
  if (args.detailFields) base.detailFields = args.detailFields.map((name) => ({ name }));
  if (args.browser) base.browser = args.browser;
  const profile = args.profile ?? (hasSecrets ? "local" : undefined);
  if (profile) base.profile = profile;
  if (args.scriptId) base.scriptId = args.scriptId;
  if (args.chooser) base.chooser = args.chooser;
  return base;
}

function validationError(error: unknown): CliError | null {
  if (error instanceof ZodError) return new CliError(`invalid input\n${formatValidationError(error)}`);
  if (error instanceof Error && error.message.startsWith("invalid input")) return new CliError(error.message);
  return null;
}

// ---------------------------------------------------------------- storage

interface RunStorage {
  actor: CrawlActor;
  items(): Promise<Row[]>;
  dispose(): Promise<void>;
}

/** Local storage under `--storage`: scrapers and profiles persist, the run's dataset is read back and dropped. */
async function openStorage(storageDir: string): Promise<RunStorage> {
  mkdirSync(storageDir, { recursive: true });
  const storage = new MemoryStorage({ localDataDirectory: storageDir, persistStorage: true, writeMetadata: false });
  const actor = new Actor({ storageClient: storage });
  // Local init only: no platform env, no graceful-shutdown handlers; exit({ exit: false }) tears the client down.
  await actor.init({ storage, gracefulShutdown: false });
  const datasetName = `run-${randomBytes(4).toString("hex")}`;
  const wrapped: CrawlActor = {
    openKeyValueStore: (name) => actor.openKeyValueStore(name),
    openDataset: () => actor.openDataset(datasetName),
    isAtHome: () => false,
    config: actor.config,
  };
  return {
    actor: wrapped,
    async items() {
      const dataset = await actor.openDataset(datasetName);
      const rows: Row[] = [];
      const limit = 1000;
      for (let offset = 0; ; offset += limit) {
        const page = await dataset.getData({ offset, limit });
        rows.push(...(page.items as Row[]));
        if (page.items.length < limit) break;
      }
      return rows;
    },
    async dispose() {
      const dataset = await actor.openDataset(datasetName);
      await dataset.drop().catch(() => undefined);
      await actor.exit({ exit: false }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------- reporting

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function summaryBlock(summary: RunSummary, dataLine: string): string {
  const lines = [`navvi: status ${summary.status}${summary.message ? ` — ${summary.message}` : ""}`];
  lines.push(`  items ${summary.items}  pages ${summary.pages}  templates ${summary.templates}  cache hit ${summary.cacheHit ? "yes" : "no"}`);
  const c = summary.chooser;
  lines.push(c ? `  chooser ${c.name}: ${c.questions} questions, ${c.inputTokens} input tokens, ${fmtMs(c.waitMs)} waiting, $${c.costUsd.toFixed(4)}` : "  chooser: none (no model call)");
  lines.push(`  healing events ${summary.healingEvents.length}  unmapped candidates ${summary.unmappedCandidates.length}  unhealed ${summary.unhealed}`);
  if (summary.fieldsNotFound.length > 0) lines.push(`  fields not found: ${summary.fieldsNotFound.join(", ")}`);
  if (dataLine) lines.push(`  ${dataLine}`);
  return lines.join("\n") + "\n";
}

function needsHumanBlock(token: string | undefined, questionsFile: string | undefined, message: string | undefined): string {
  const lines = ["navvi: needs_human — the agent chooser needs answers before the run can continue."];
  if (message) lines.push(`  ${message}`);
  if (questionsFile) lines.push(`  questions: ${questionsFile}`);
  if (token) {
    lines.push(`  token: ${token}`);
    lines.push(`  Read the questions file, write {"answers":[{"id":"<question id>","index":<option index, null for none, 1/0 for booleans>,"text":"<text questions only>"}]}`);
    lines.push(`  to a file, then rerun the same command with: --answers <answers.json> --resume ${token}`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- main

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.stderr.write(`navvi: ${parsed.error}\n\n${usage()}`);
    return EXIT.configuration;
  }
  const args = parsed.args;
  if (args.help) {
    io.stdout.write(usage());
    return EXIT.ok;
  }
  if (args.version) {
    io.stdout.write(`${packageVersion()}\n`);
    return EXIT.ok;
  }
  if (args.urls.length === 0 && args.fromUrls.length === 0) {
    io.stderr.write(`navvi: give at least one start URL (or --from-url).\n\n${usage()}`);
    return EXIT.configuration;
  }
  try {
    return await execute(args, io);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr.write(`navvi: ${error.message}\n`);
      return error.code;
    }
    if (error instanceof NeedsHumanError) {
      io.stderr.write(needsHumanBlock(error.token, error.questionsFile, error.message));
      return EXIT.needsHuman;
    }
    if (error instanceof NavviError) {
      io.stderr.write(`navvi: ${error.status}: ${error.message}\n`);
      return error.status === "configuration_error" ? EXIT.configuration : exitCodeFor(error.status as Status);
    }
    const asValidation = validationError(error);
    if (asValidation) {
      io.stderr.write(`navvi: ${asValidation.message}\n`);
      return asValidation.code;
    }
    const withStatus = error as { status?: unknown };
    if (typeof withStatus.status === "string" && withStatus.status !== "succeeded") {
      io.stderr.write(`navvi: ${withStatus.status}: ${error instanceof Error ? error.message : String(error)}\n`);
      return exitCodeFor(withStatus.status as Status);
    }
    io.stderr.write(`navvi: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT.short;
  }
}

function chooserFor(args: CliArgs, io: CliIo, storageDir: string): Chooser {
  const name = args.chooser ?? defaultChooser(io.env);
  if (name === "jev" && !io.env.AI_GATEWAY_API_KEY && !io.env.TYPESAFE_API_KEY) {
    throw new CliError(`${missingCredentialsMessage("jev")} On the command line that is \`--chooser agent\`.`);
  }
  if (name === "model" && !io.env.ANTHROPIC_API_KEY) {
    throw new CliError(`${missingCredentialsMessage("model")} On the command line that is \`--chooser agent\`.`);
  }
  const questionsDir = join(storageDir, "questions");
  let answers: Answer[] | undefined;
  if (args.answers) {
    const file = resolve(io.cwd, args.answers);
    try {
      answers = loadAnswersFile(file);
    } catch (error) {
      throw new CliError(`--answers ${args.answers}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (args.resume) {
    const file = join(questionsDir, `${args.resume}.json`);
    if (!existsSync(file)) throw new CliError(`--resume ${args.resume}: no parked questions at ${file}`);
    if (!answers) throw new CliError(`--resume ${args.resume} needs --answers <file>`);
  }
  return createChooser({
    chooser: name,
    env: io.env,
    agent: {
      stdin: io.stdin,
      stdout: io.stdout,
      questionsDir,
      ...(args.agentMode ? { mode: args.agentMode } : {}),
      ...(answers ? { answers } : {}),
      ...(args.resume ? { resumeToken: args.resume } : {}),
    },
  });
}

async function execute(args: CliArgs, io: CliIo): Promise<number> {
  const storageDir = resolve(io.cwd, args.storage);
  let notify: Notifier;
  try {
    notify = createNotifier(args.notify, io.env, { stderr: io.stderr, fetch: io.fetch });
  } catch (error) {
    if (error instanceof NotifyConfigurationError) throw new CliError(error.message);
    throw error;
  }
  const secrets = await collectSecrets(args, io);
  const chooser = chooserFor(args, io, storageDir);
  const base = baseInput(args, secrets);

  let input: RunInput;
  if (args.mode && args.fields && args.fields.length > 0) {
    try {
      input = parseInput({ ...base, ...(args.prompt ? { prompt: args.prompt, description: args.prompt } : {}) });
    } catch (error) {
      throw validationError(error) ?? error;
    }
  } else {
    if (!args.prompt) throw new CliError("give a prompt, or both --mode and --fields.");
    // KTD11: run() takes structured input only; prompt-only input is parsed here through one text question.
    let parsedBase: Partial<RunInput>;
    try {
      parsedBase = base as Partial<RunInput>;
      input = (await promptToInput(args.prompt, parsedBase, chooser)).input;
    } catch (error) {
      throw validationError(error) ?? error;
    }
  }
  input.chooser ??= args.chooser ?? defaultChooser(io.env);
  input.browser ??= defaultBrowser(io.env);

  const storage = await openStorage(storageDir);
  const deps: CrawlDeps = { chooser, actor: storage.actor, notify, attended: args.headed, storageDir, env: io.env };
  const runFn = io.run ?? runNavvi;
  let summary: RunSummary;
  let rows: Row[];
  try {
    summary = await runFn(input, deps);
    rows = await storage.items();
  } finally {
    await storage.dispose();
  }

  const format: OutputFormat = args.csv || args.out?.toLowerCase().endsWith(".csv") ? "csv" : args.json ? "json-compact" : "json";
  const text = formatRows(rows, format);
  let dataLine = "";
  if (summary.status === "needs_human") {
    // A parked run has no data yet; stdout stays clean for the agent reading the instructions.
  } else if (args.out) {
    const file = resolve(io.cwd, args.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    dataLine = `data: ${rows.length} records -> ${file}`;
  } else {
    io.stdout.write(text);
    dataLine = `data: ${rows.length} records on stdout`;
  }

  if (summary.status === "needs_human") {
    io.stderr.write(needsHumanBlock(summary.needsHuman?.token, summary.needsHuman?.questionsFile, summary.message));
    await notify(`navvi needs answers: ${summary.needsHuman?.questionsFile ?? "questions parked"} (token ${summary.needsHuman?.token ?? "?"})`).catch(() => undefined);
  } else if (!args.quiet) {
    io.stderr.write(summaryBlock(summary, dataLine));
  }
  return exitCodeFor(summary.status);
}

// ---------------------------------------------------------------- process entry

function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // stdout carries data (and agent question batches) only: Crawlee's INFO lines and any console.log go to stderr.
  crawleeLog.setLevel(process.env.NAVVI_LOG === "debug" ? LogLevel.DEBUG : LogLevel.WARNING);
  console.log = (...parts: unknown[]) => console.error(...parts);
  const code = await main(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() });
  process.stdout.write("", () => process.exit(code));
}
