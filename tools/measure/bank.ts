import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Answer, Chooser, ChooserUsage, Question } from "../../src/chooser/chooser.js";

/**
 * The question bank behind the Jev hillclimb (docs/jev-hillclimb.md): every
 * question a measured scenario asks on its gold path, with the whole question
 * (premise, options, state, structured context) and the gold answer. Captured
 * from the `agent` replay, whose answers the scenario's field grading proves
 * right, so a framing change can be re-asked in seconds without a browser.
 *
 * Layout: `tests/recorded/bank/<scenario>/<batch>.json`, one file per batch so
 * the re-ask groups questions exactly as the run did.
 */

export const BANK_DIR = join("tests", "recorded", "bank");

export interface BankEntry {
  question: Question;
  /** The gold answer: an option index, null for none, 0/1 for boolean. */
  gold: number | null;
  /** Gold text for text questions (not re-asked; Jev cannot write). */
  goldText?: string;
  /** Options as right as the gold one, from accept.json. */
  accept?: number[];
}

export interface BankBatch {
  scenario: string;
  batch: number;
  entries: BankEntry[];
}

/** Wraps a chooser and writes each batch it answers into the bank. */
export class BankingChooser implements Chooser {
  readonly name: Chooser["name"];
  private batches = 0;
  private readonly target: string;

  constructor(
    private readonly inner: Chooser,
    scenario: string,
    dir = BANK_DIR,
  ) {
    this.name = inner.name;
    this.target = join(resolve(dir), scenario.replace(/[^A-Za-z0-9._-]+/g, "-"));
    this.scenario = scenario;
  }
  private readonly scenario: string;

  async ask(batch: Question[]): Promise<Answer[]> {
    const answers = await this.inner.ask(batch);
    const byId = new Map(answers.map((a) => [a.id, a]));
    const entries: BankEntry[] = batch.map((q) => {
      const a = byId.get(q.id);
      const entry: BankEntry = { question: q, gold: a?.index ?? null };
      if (a?.text !== undefined) entry.goldText = a.text;
      return entry;
    });
    mkdirSync(this.target, { recursive: true });
    const file: BankBatch = { scenario: this.scenario, batch: this.batches, entries };
    writeFileSync(join(this.target, `${String(this.batches).padStart(3, "0")}.json`), JSON.stringify(file, null, 2) + "\n");
    this.batches += 1;
    return answers;
  }

  usage(): ChooserUsage {
    return this.inner.usage();
  }
}

/** `accept.json` at the bank root: per scenario and question id, the options that are as right as the gold one (the grading accepts them too). */
export type AcceptOverrides = Record<string, Record<string, number[]>>;

/** Every batch in the bank, scenario order then batch order, with `accept` filled from the overrides. */
export function loadBank(dir = BANK_DIR, scenarios?: readonly string[]): BankBatch[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  const acceptFile = join(root, "accept.json");
  const overrides = existsSync(acceptFile) ? (JSON.parse(readFileSync(acceptFile, "utf8")) as AcceptOverrides) : {};
  const out: BankBatch[] = [];
  for (const scenario of readdirSync(root).sort()) {
    const folder = join(root, scenario);
    if (!statSync(folder).isDirectory()) continue;
    if (scenarios && !scenarios.includes(scenario)) continue;
    for (const file of readdirSync(folder).filter((f) => f.endsWith(".json")).sort()) {
      const batch = JSON.parse(readFileSync(join(folder, file), "utf8")) as BankBatch;
      for (const entry of batch.entries) {
        const accept = overrides[scenario]?.[entry.question.id];
        if (accept) entry.accept = accept;
      }
      out.push(batch);
    }
  }
  return out;
}

/** The question family a bank entry belongs to, for the per-family table. */
export function familyOf(id: string): string {
  if (id.startsWith("group")) return "group";
  if (id.startsWith("field.")) return "field";
  if (id.startsWith("heal.step")) return "heal.step";
  if (id.startsWith("heal.")) return "heal.field";
  if (id.startsWith("link.")) return "link";
  if (/^nav\.\d+\.op$/.test(id)) return "nav.op";
  if (/^nav\.\d+\.done$/.test(id)) return "nav.done";
  if (id.startsWith("nav.")) return "nav.target";
  if (id.startsWith("text.")) return "text";
  return "other";
}
