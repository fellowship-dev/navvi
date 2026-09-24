import { renderRationale } from "../compile/index.js";
import { outputSchema, render as renderReconcile } from "../reconcile/index.js";
import type { CompiledTemplate } from "../replay/crawler.js";
import { renderMachine } from "../scraper/index.js";
import { ARTIFACTS, PRIMARY, Work, type StageName } from "./work.js";

/**
 * U5: `navvi "<prompt>" <url> --work <dir>` -- the plain command's compile,
 * written down as `navvi make` writes its own.
 *
 * Both front ends compile a record template through `compileTemplate`, so
 * what the plain command kept in memory is the same record `navvi make` keeps
 * on disk: a spec, a sample, a manuscript, a reconciliation and a scraper with
 * its rationale. This writes that record under make's own names, through
 * make's own `Work` and the same renderers, so a person reads one set of
 * artifacts whichever command produced them and there is no second spelling
 * of any of them to drift.
 *
 * ## What it does not write
 *
 *  - **`make.json`.** The ledger records which bytes each stage read, and the
 *    plain command ran no stage by that definition. A `navvi make --work` on
 *    the same directory therefore finds no record, re-runs every stage from
 *    the `spec.json` written here, and does not mistake this run's artifacts
 *    for its own.
 *  - **`determinism.json` and `scorecard.md`.** The plain command does not
 *    read a page three times or score its fill; those are make's stages, and
 *    an absent file is the honest record of a measurement nobody took.
 *  - **In list mode, anything but the spec and the scraper.** `compileList`
 *    keeps no manuscript, reconciliation or rationale.
 *
 * One difference in what is written: `investigation.json` here is the
 * manuscript with the chooser's answers to any competing readings applied,
 * because the plain command asks them inside the one call. `navvi make` keeps
 * the investigation as the tiers wrote it and carries those answers in
 * `reconcile.json` alone. Both reconcile to the same `reconcile.json`.
 */

export interface AbsentArtifact {
  name: string;
  because: string;
}

export interface WrittenArtifacts {
  /** The directory, absolute as given. */
  dir: string;
  templateKey: string;
  /** In the order `navvi make`'s stages write them. */
  written: string[];
  absent: AbsentArtifact[];
}

const NOT_MEASURED = "the plain command measures neither determinism nor fill; `navvi make --work` on this directory runs those stages";

export function writeCompiledTemplate(dir: string, compiled: CompiledTemplate, options: { now?: (() => Date) | undefined } = {}): WrittenArtifacts {
  const work = Work.open(dir, options.now === undefined ? {} : { now: options.now });
  const written: string[] = [];
  const absent: AbsentArtifact[] = [];
  const write = (name: string, text: string): void => {
    work.write(name, text);
    written.push(name);
  };
  const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
  const missing = (stage: StageName, because: string): void => {
    for (const name of ARTIFACTS[stage]) absent.push({ name, because });
  };

  write(PRIMARY.spec, json(compiled.spec));

  const core = compiled.core;
  if (core === undefined) {
    const because = `${compiled.mode} mode compiles through compileList, which keeps no sample, manuscript or reconciliation`;
    for (const stage of ["sample", "investigate", "reconcile", "schema"] as const) missing(stage, because);
  } else {
    write(PRIMARY.sample, json(core.sample));
    write(PRIMARY.investigate, json(core.manuscript));
    if (core.reconciliation === undefined) {
      missing("reconcile", `the compile stopped before reconciling: ${compiled.because ?? core.manuscript.because}`);
    } else {
      write(PRIMARY.reconcile, json(core.reconciliation));
      write("reconcile.md", renderReconcile(core.reconciliation));
    }
  }

  missing("determinism", NOT_MEASURED);

  if (compiled.scraper === null) {
    const because = `nothing compiled: ${compiled.because ?? "the compile stopped short"}`;
    missing("schema", because);
    missing("compile", because);
  } else {
    if (core?.reconciliation !== undefined) write(PRIMARY.schema, json(outputSchema(core.reconciliation, compiled.spec, options.now === undefined ? {} : { now: options.now() })));
    write(PRIMARY.compile, json(compiled.scraper));
    if (core?.rationale !== undefined) write("rationale.md", renderRationale(core.rationale));
    else absent.push({ name: "rationale.md", because: `${compiled.mode} mode compiles through compileList, which argues no binding` });
    write("machine.mmd", renderMachine());
  }

  missing("verify", NOT_MEASURED);
  // One entry per file, in stage order, whatever path added it.
  const seen = new Set<string>();
  const unique = absent.filter((entry) => !written.includes(entry.name) && !seen.has(entry.name) && seen.add(entry.name));
  return { dir: work.dir, templateKey: compiled.templateKey, written, absent: unique };
}
