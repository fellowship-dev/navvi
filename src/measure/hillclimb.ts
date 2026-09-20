import { writeFileSync } from "node:fs";
import { JevChooser } from "../chooser/jev.js";
import type { Answer, Chooser, Question } from "../chooser/chooser.js";
import { familyOf, loadBank, type BankBatch } from "./bank.js";

/**
 * The fast loop of the Jev hillclimb: re-ask every choice and boolean
 * question in the bank with the current Jev mapping (`toEvaluationQuestion`
 * in src/chooser/jev.ts), batch by batch as the run asked them, and score
 * against the gold answers. Seconds per pass, a fraction of a cent, no
 * browser. The measure harness remains the end-to-end check.
 *
 *   npm run hillclimb -- [--repeats 3] [--scenarios AE1,AE8] [--families group,heal.field] [--json out.json]
 */

export interface HillclimbOptions {
  repeats: number;
  scenarios?: string[];
  families?: string[];
  json?: string;
  env: NodeJS.ProcessEnv;
  /** Injected chooser for tests; defaults to a direct JevChooser. */
  chooser?: Chooser;
  log?: (line: string) => void;
}

export interface QuestionResult {
  scenario: string;
  batch: number;
  id: string;
  family: string;
  gold: number | null;
  /** Options counted right besides the gold one. */
  accept: number[];
  /** One answer per repeat. */
  picks: Array<number | null>;
  /** P(gold) per repeat when the backend reports probabilities. */
  goldProbability: Array<number | undefined>;
  optionCount: number;
}

export interface FamilyRow {
  family: string;
  questions: number;
  /** Correct picks over all repeats. */
  correct: number;
  asked: number;
  /** Gold was an option, Jev said none. */
  missedAsNone: number;
  /** Gold was none, Jev picked an option. */
  falsePick: number;
  /** Gold was an option, Jev picked a different option. */
  wrongOption: number;
  /** Questions whose repeats disagree. */
  unstable: number;
}

export interface HillclimbReport {
  repeats: number;
  questions: QuestionResult[];
  families: FamilyRow[];
  accuracy: number;
  batches: number;
  inputTokens: number;
  costUsd: number;
  /** Mean wall per batch call, ms. */
  meanBatchMs: number;
}

const USAGE = "usage: npm run hillclimb -- [--repeats N] [--scenarios A,B] [--families f1,f2] [--json out.json]";

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): HillclimbOptions {
  const options: HillclimbOptions = { repeats: 3, env };
  const args = [...argv];
  const value = (flag: string): string => {
    const next = args.shift();
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
    return next;
  };
  while (args.length > 0) {
    const arg = args.shift()!;
    switch (arg) {
      case "--repeats":
        options.repeats = Math.max(1, Number(value(arg)));
        break;
      case "--scenarios":
        options.scenarios = value(arg).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--families":
        options.families = value(arg).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--json":
        options.json = value(arg);
        break;
      default:
        throw new Error(`unknown flag "${arg}"\n${USAGE}`);
    }
  }
  return options;
}

function askable(q: Question, families: readonly string[] | undefined): boolean {
  if (q.kind === "text" || q.kind === "score") return false;
  return !families || families.includes(familyOf(q.id));
}

export async function runHillclimb(options: HillclimbOptions): Promise<HillclimbReport> {
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const chooser = options.chooser ?? new JevChooser({ env: options.env, provider: options.env.TYPESAFE_API_KEY ? "typesafe" : "gateway" });
  const bank = loadBank(undefined, options.scenarios);
  const results = new Map<string, QuestionResult>();
  let batches = 0;
  let batchMs = 0;
  for (let repeat = 0; repeat < options.repeats; repeat++) {
    for (const file of bank) {
      const questions = file.entries.filter((e) => askable(e.question, options.families)).map((e) => e.question);
      if (questions.length === 0) continue;
      const started = performance.now();
      let answers: Answer[];
      try {
        answers = await chooser.ask(questions);
      } catch (error) {
        log(`${file.scenario}/${file.batch}: failed: ${error instanceof Error ? error.message : String(error)}`);
        answers = questions.map((q) => ({ id: q.id, index: null }));
      }
      batchMs += performance.now() - started;
      batches += 1;
      record(file, answers, results, repeat);
    }
  }
  const questions = [...results.values()];
  const families = summarize(questions);
  const asked = families.reduce((n, f) => n + f.asked, 0);
  const correct = families.reduce((n, f) => n + f.correct, 0);
  const usage = chooser.usage();
  const report: HillclimbReport = {
    repeats: options.repeats,
    questions,
    families,
    accuracy: asked === 0 ? 0 : correct / asked,
    batches,
    inputTokens: usage.inputTokens,
    costUsd: usage.costUsd,
    meanBatchMs: batches === 0 ? 0 : batchMs / batches,
  };
  if (options.json) writeFileSync(options.json, JSON.stringify(report, null, 2) + "\n");
  return report;
}

function record(file: BankBatch, answers: readonly Answer[], results: Map<string, QuestionResult>, repeat: number): void {
  const byId = new Map(answers.map((a) => [a.id, a]));
  for (const entry of file.entries) {
    const a = byId.get(entry.question.id);
    if (!a) continue;
    const key = `${file.scenario}/${file.batch}/${entry.question.id}`;
    let r = results.get(key);
    if (!r) {
      r = { scenario: file.scenario, batch: file.batch, id: entry.question.id, family: familyOf(entry.question.id), gold: entry.gold, accept: entry.accept ?? [], picks: [], goldProbability: [], optionCount: entry.question.options?.length ?? 2 };
      results.set(key, r);
    }
    r.picks[repeat] = a.index;
    r.goldProbability[repeat] = entry.gold !== null && a.probabilities ? a.probabilities[entry.gold] : entry.gold === null && a.probabilities ? 1 - a.probabilities.reduce((s, p) => s + p, 0) : undefined;
  }
}

function summarize(questions: readonly QuestionResult[]): FamilyRow[] {
  const rows = new Map<string, FamilyRow>();
  for (const q of questions) {
    let row = rows.get(q.family);
    if (!row) {
      row = { family: q.family, questions: 0, correct: 0, asked: 0, missedAsNone: 0, falsePick: 0, wrongOption: 0, unstable: 0 };
      rows.set(q.family, row);
    }
    row.questions += 1;
    if (new Set(q.picks).size > 1) row.unstable += 1;
    for (const pick of q.picks) {
      row.asked += 1;
      if (pick === q.gold || (pick !== null && q.accept.includes(pick))) row.correct += 1;
      else if (pick === null) row.missedAsNone += 1;
      else if (q.gold === null) row.falsePick += 1;
      else row.wrongOption += 1;
    }
  }
  return [...rows.values()].sort((a, b) => a.family.localeCompare(b.family));
}

export function renderReport(report: HillclimbReport): string {
  const lines = ["| family | questions | correct | missed as none | false pick | wrong option | unstable |", "|---|---|---|---|---|---|---|"];
  for (const f of report.families) {
    lines.push(`| ${f.family} | ${f.questions} | ${f.correct}/${f.asked} | ${f.missedAsNone} | ${f.falsePick} | ${f.wrongOption} | ${f.unstable} |`);
  }
  const asked = report.families.reduce((n, f) => n + f.asked, 0);
  const correct = report.families.reduce((n, f) => n + f.correct, 0);
  lines.push(`| **all** | ${report.questions.length} | **${correct}/${asked} (${(report.accuracy * 100).toFixed(1)}%)** | ${report.families.reduce((n, f) => n + f.missedAsNone, 0)} | ${report.families.reduce((n, f) => n + f.falsePick, 0)} | ${report.families.reduce((n, f) => n + f.wrongOption, 0)} | ${report.families.reduce((n, f) => n + f.unstable, 0)} |`);
  lines.push("");
  lines.push(`${report.repeats} repeats, ${report.batches} batch calls, ${report.inputTokens} input tokens, $${report.costUsd.toFixed(4)}, mean ${Math.round(report.meanBatchMs)} ms per batch.`);
  const misses = report.questions.filter((q) => q.picks.some((p) => p !== q.gold && !(p !== null && q.accept.includes(p))));
  if (misses.length > 0) {
    lines.push("", "Misses:");
    for (const q of misses) {
      lines.push(`- ${q.scenario} ${q.id}: gold ${q.gold === null ? "none" : q.gold}, picks ${q.picks.map((p) => (p === null ? "none" : p)).join("/")}, P(gold) ${q.goldProbability.map((p) => (p === undefined ? "?" : p.toFixed(2))).join("/")}, ${q.optionCount} options`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  let options: HillclimbOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const report = await runHillclimb(options);
  process.stdout.write(`${renderReport(report)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
