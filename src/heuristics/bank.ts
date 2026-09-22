import { BIND_HEURISTICS } from "./rules/bind.js";
import { INVESTIGATE_HEURISTICS } from "./rules/investigate.js";
import { REPLAY_HEURISTICS } from "./rules/replay.js";
import type { AnyHeuristic, Overrides, Stage, Verdict } from "./types.js";

/**
 * U8b: the bank. Eleven rules, each from one encounter on 2026-09-22, each with
 * a fixture in `tests/fixtures/heuristics/`.
 *
 * The measurable output of dogfooding is this list growing: not "navvi handled
 * client", but *this engagement added eleven heuristics and eleven evals, and the
 * next site starts from them.*
 */

export const HEURISTICS: readonly AnyHeuristic[] = [...INVESTIGATE_HEURISTICS, ...BIND_HEURISTICS, ...REPLAY_HEURISTICS];

/** Every id, for tests and for the CLI's error message on an unknown one. */
export const HEURISTIC_IDS: readonly string[] = HEURISTICS.map((heuristic) => heuristic.id);

export class UnknownHeuristicError extends Error {
  constructor(readonly id: string) {
    super(`no heuristic "${id}"; the bank holds ${HEURISTIC_IDS.join(", ")}`);
    this.name = "UnknownHeuristicError";
  }
}

export interface BankEntry {
  heuristic: AnyHeuristic;
  /** The case override in force, when there is one. */
  override?: { enabled: boolean; note: string };
}

/**
 * A view of the bank under one case's overrides. A disabled heuristic still
 * answers — with `fires: false` and the note that silenced it — because a
 * compile that went a strange way has to be able to say which rule was not
 * allowed to speak.
 */
export class Bank {
  private readonly byId = new Map<string, AnyHeuristic>();

  constructor(private readonly overrides: Overrides = {}) {
    for (const heuristic of HEURISTICS) this.byId.set(heuristic.id, heuristic);
    for (const id of Object.keys(overrides)) {
      if (!this.byId.has(id)) throw new UnknownHeuristicError(id);
    }
  }

  list(stage?: Stage): BankEntry[] {
    return HEURISTICS.filter((heuristic) => stage === undefined || heuristic.stage === stage).map((heuristic) => this.entry(heuristic));
  }

  get(id: string): BankEntry {
    const heuristic = this.byId.get(id);
    if (!heuristic) throw new UnknownHeuristicError(id);
    return this.entry(heuristic);
  }

  enabled(id: string): boolean {
    return this.overrides[id]?.enabled !== false;
  }

  /** Judge one observation. Throws `ZodError` when the observation does not match the heuristic's shape. */
  run(id: string, observation: unknown): Verdict {
    const entry = this.get(id);
    const override = this.overrides[id];
    if (override?.enabled === false) {
      return { fires: false, because: `disabled for this case: ${override.note}` };
    }
    return entry.heuristic.run(observation);
  }

  /** Every enabled heuristic of a stage, judged against one observation shape it accepts. */
  runStage(stage: Stage, observation: unknown): Array<{ id: string; verdict: Verdict }> {
    const verdicts: Array<{ id: string; verdict: Verdict }> = [];
    for (const { heuristic } of this.list(stage)) {
      if (!this.enabled(heuristic.id)) continue;
      try {
        verdicts.push({ id: heuristic.id, verdict: heuristic.run(observation) });
      } catch {
        // An observation this rule does not describe is not this rule's business.
      }
    }
    return verdicts;
  }

  private entry(heuristic: AnyHeuristic): BankEntry {
    const override = this.overrides[heuristic.id];
    return override === undefined ? { heuristic } : { heuristic, override };
  }
}

export function bank(overrides: Overrides = {}): Bank {
  return new Bank(overrides);
}
