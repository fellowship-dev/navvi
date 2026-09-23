import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * U11: the work directory, and the rule that decides whether a stage has to run
 * again.
 *
 * ## Why a ledger and not a file listing
 *
 * `navvi make` is eight stages and eleven files, and the plan's own sentence
 * for it is *"every stage independently runnable from the artifact above it —
 * re-running after editing an artifact recompiles downstream from that
 * artifact"*. That sentence rules out both of the cheap answers:
 *
 *  - **"the file exists"** cannot be it. `investigation.json` existing says
 *    nothing about *which* `spec.json` produced it, so a client who answers a
 *    question, re-runs, and gets the old investigation back has been told a
 *    lie by a green run. This is the repository's own recurring defect wearing
 *    a new hat: two halves that were never introduced, each correct alone.
 *  - **"the output is newer than the input"** cannot be it either. mtime is not
 *    a fact about content on this machine: a `git checkout`, a `cp -r`, a
 *    `stash pop` and an editor that writes through a temp file all move it
 *    without changing a byte, and two of those are how a work directory gets
 *    shared between the two Macs in the first place.
 *
 * So the ledger stores a **SHA-256 over the exact bytes each stage read**, plus
 * that stage's own parameters in a declared order, and a stage is current when
 * that digest has not moved and every artifact it wrote is still on disk.
 *
 * The consequence is the property the plan asked for, and it falls out rather
 * than being implemented twice: hand-editing `reconcile.json` does not make
 * `reconcile` stale — nothing it read changed — but it does move the input
 * digest of `schema`, `compile` and `verify`, all of which read those bytes.
 * The edit propagates exactly as far as the edit reaches, and nobody had to
 * pass a flag to say so.
 *
 * ## Overwriting an edit
 *
 * A stale stage whose own output was edited by hand is the one case where
 * re-running destroys work. It stops the run instead, names the file, and asks
 * for `--force`. Everywhere else in this repository a destructive step shows
 * what it would affect and asks first; a compiler that eats the artifact it
 * invited you to edit would be the exception.
 */

// ------------------------------------------------------------------- stages

/**
 * The pipeline, in order. This list is the driver's spine: `make.json` is keyed
 * by it, the staleness walk follows it, and a stage that is not here cannot be
 * reported at all.
 */
export const STAGES = ["spec", "sample", "investigate", "reconcile", "schema", "determinism", "compile", "verify"] as const;
export type StageName = (typeof STAGES)[number];

/**
 * What each stage writes, relative to the work directory.
 *
 * `reconcile` writes two: `reconcile.md` is the deliverable a client reads and
 * `reconcile.json` is the object `schema` and `compile` read. The plan's
 * transcript names only the Markdown on the stage line — that is what a person
 * is being pointed at — and the ledger carries both, because the staleness rule
 * above is about bytes a stage actually read and `compile` reads the JSON.
 */
export const ARTIFACTS: Record<StageName, readonly string[]> = {
  spec: ["spec.json"],
  sample: ["sample.json"],
  investigate: ["investigation.json"],
  reconcile: ["reconcile.json", "reconcile.md"],
  schema: ["schema.json"],
  determinism: ["determinism.json"],
  compile: ["scraper.json", "rationale.md", "machine.mmd"],
  verify: ["scorecard.md"],
};

/** The artifact each stage hands downstream, for the message that names what moved. */
export const PRIMARY: Record<StageName, string> = {
  spec: "spec.json",
  sample: "sample.json",
  investigate: "investigation.json",
  reconcile: "reconcile.json",
  schema: "schema.json",
  determinism: "determinism.json",
  compile: "scraper.json",
  verify: "scorecard.md",
};

// ------------------------------------------------------------------- ledger

export interface LedgerInput {
  /** The artifact's file name, or `params` for the stage's own arguments. */
  name: string;
  digest: string;
}

export interface LedgerOutput {
  path: string;
  digest: string;
}

export interface StageLedger {
  stage: StageName;
  /** One digest over every entry in `inputs`, which is what currency compares. */
  inputDigest: string;
  /** The parts, so a stale stage can say *which* input moved rather than that one did. */
  inputs: LedgerInput[];
  outputs: LedgerOutput[];
  /** The only field a re-run moves; injected, so a test and a diff can pin it. */
  recordedAt: string;
}

export interface Ledger {
  version: 1;
  stages: Partial<Record<StageName, StageLedger>>;
}

export const LEDGER_FILE = "make.json";

// -------------------------------------------------------------------- digest

/**
 * The digest of some bytes. SHA-256 and not a cheaper hash because this is what
 * decides whether a client's edit is honoured, and a collision here is a
 * silently ignored edit — the exact failure the whole file exists to prevent.
 */
export function digestOf(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

/**
 * A stage's parameters as one digest.
 *
 * `JSON.stringify` over a value the caller assembled in a fixed key order, not
 * a sorted walk: every caller in `make.ts` writes an object literal, so the
 * order is the source order and is stable by construction. A sorted walk would
 * be a second, subtler spelling of "these are the arguments" that could
 * disagree with the literal about what is in it.
 */
export function digestOfParams(params: unknown): string {
  return digestOf(JSON.stringify(params ?? null));
}

// ----------------------------------------------------------- the directory

export interface WorkOptions {
  /** The clock, so a ledger is reproducible. */
  now?: (() => Date) | undefined;
}

/**
 * Whether a stage may be skipped, and what a reader needs told either way.
 *
 * `edited` is on the *current* answer as well as the stale one, because an
 * artifact a person changed by hand is a fact about this run whichever way the
 * decision went: downstream is reading their bytes, not navvi's.
 */
export interface Currency {
  current: boolean;
  because: string;
  /** Artifacts whose bytes are not the bytes navvi wrote. */
  edited: string[];
}

export class Work {
  private ledger: Ledger;

  private constructor(
    readonly dir: string,
    ledger: Ledger,
    private readonly now: () => Date,
  ) {
    this.ledger = ledger;
  }

  /** Opens (and creates) a work directory, reading back the ledger if there is one. */
  static open(dir: string, options: WorkOptions = {}): Work {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, LEDGER_FILE);
    let ledger: Ledger = { version: 1, stages: {} };
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Ledger;
        // A ledger navvi cannot read is not a reason to silently re-run
        // everything against artifacts it then overwrites; it is a reason to
        // treat the directory as fresh and say nothing is known about it.
        if (parsed && parsed.version === 1 && typeof parsed.stages === "object") ledger = { version: 1, stages: parsed.stages ?? {} };
      } catch {
        ledger = { version: 1, stages: {} };
      }
    }
    return new Work(dir, ledger, options.now ?? (() => new Date()));
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  has(name: string): boolean {
    return existsSync(this.path(name));
  }

  /** The bytes of an artifact as they are on disk right now, or `null` when it is not there. */
  read(name: string): string | null {
    const file = this.path(name);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  }

  readJson<T>(name: string): T | null {
    const text = this.read(name);
    if (text === null) return null;
    return JSON.parse(text) as T;
  }

  /** The digest of an artifact as it is on disk, or the digest of nothing when it is absent. */
  digest(name: string): string {
    const text = this.read(name);
    return text === null ? "absent" : digestOf(text);
  }

  write(name: string, text: string): void {
    const file = this.path(name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  writeJson(name: string, value: unknown): void {
    this.write(name, JSON.stringify(value, null, 2) + "\n");
  }

  entry(stage: StageName): StageLedger | undefined {
    return this.ledger.stages[stage];
  }

  /**
   * Is this stage's result still the result of these inputs?
   *
   * `inputs` is the artifacts it reads, in the order it reads them, and
   * `params` is everything else it was given. Both go into the digest, because
   * a stage re-run with a different `--sample` read the same files and is not
   * current.
   */
  currency(stage: StageName, inputs: readonly string[], params: unknown): Currency {
    const entry = this.entry(stage);
    const edited = (entry?.outputs ?? []).filter((output) => this.digest(output.path) !== output.digest).map((output) => output.path);
    if (entry === undefined) return { current: false, because: `no record of it in ${LEDGER_FILE}`, edited };

    const missing = ARTIFACTS[stage].filter((name) => !this.has(name));
    if (missing.length > 0) return { current: false, because: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not there`, edited };

    const parts = this.inputParts(inputs, params);
    const moved = parts.filter((part) => (entry.inputs.find((was) => was.name === part.name)?.digest ?? "absent") !== part.digest);
    if (moved.length > 0 || parts.length !== entry.inputs.length) {
      const names = moved.map((part) => (part.name === "params" ? "its arguments" : part.name));
      return {
        current: false,
        because: names.length > 0 ? `${names.join(" and ")} changed since it last ran` : `it was run with a different set of inputs`,
        edited,
      };
    }
    // Short on purpose: it is printed as the head of a stage block whose right
    // column is the artifact path, and a sentence that names the file again
    // pushes the path onto a second line for no new information.
    return { current: true, because: "nothing it read has changed", edited };
  }

  /** Records a stage that ran, with what it read and what it wrote. */
  record(stage: StageName, inputs: readonly string[], params: unknown): void {
    this.ledger.stages[stage] = {
      stage,
      inputs: this.inputParts(inputs, params),
      inputDigest: digestOf(this.inputParts(inputs, params).map((part) => `${part.name}:${part.digest}`).join("\n")),
      outputs: ARTIFACTS[stage].filter((name) => this.has(name)).map((name) => ({ path: name, digest: this.digest(name) })),
      recordedAt: this.now().toISOString(),
    };
    this.flush();
  }

  /**
   * Forgets a stage.
   *
   * Used when a stage did not run — skipped, or never reached. Leaving a stale
   * record behind would let the *next* invocation call an artifact current
   * against inputs that were never read to produce it, which is the same lie as
   * "the file exists" arriving one run later.
   */
  forget(stage: StageName): void {
    if (this.ledger.stages[stage] === undefined) return;
    delete this.ledger.stages[stage];
    this.flush();
  }

  private inputParts(inputs: readonly string[], params: unknown): LedgerInput[] {
    const parts: LedgerInput[] = inputs.map((name) => ({ name, digest: this.digest(name) }));
    parts.push({ name: "params", digest: digestOfParams(params) });
    return parts;
  }

  private flush(): void {
    this.write(LEDGER_FILE, JSON.stringify(this.ledger, null, 2) + "\n");
  }
}
