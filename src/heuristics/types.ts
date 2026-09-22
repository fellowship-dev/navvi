import { z } from "zod";

/**
 * U8b: the heuristic bank.
 *
 * Jev decides; heuristics decide **what Jev is even asked**. Without them the
 * pipeline is six ceremonies charged to a site whose whole answer was in its
 * meta tags. With them the ceremony is reserved for sites that earn it.
 *
 * A heuristic here is not a tuning constant. It is one encounter with the real
 * web, written down so it executes: named, inspectable (`navvi heuristics`),
 * overridable per case, and — the part that matters — **pinned by a fixture**.
 * Every rule in this bank was found by hand on 2026-09-22 and had already been
 * written as prose in a plan document before that, in one case four sessions
 * earlier. Prose does not execute. A heuristic that stops firing, or starts
 * firing wrongly, is a failing test.
 */

/** Where in the pipeline a heuristic gets a say. */
export const STAGES = ["investigate", "bind", "compile", "replay"] as const;
export type Stage = (typeof STAGES)[number];

export interface Verdict {
  /** Did the rule apply to this observation? */
  fires: boolean;
  /** Why, in terms of the observation. Goes into the compile rationale verbatim. */
  because: string;
  /** What the pipeline should do about it. Present when it fires. */
  action?: string;
  /** The candidate the rule picked, for rules that choose among several. */
  pick?: string;
}

export interface Heuristic<In> {
  id: string;
  /** The rule as one line — the row it occupies in the plan's table. */
  title: string;
  stage: Stage;
  /** What changes in the pipeline when this fires. */
  decides: string;
  /** The encounter that produced it. A heuristic with no encounter is a guess. */
  encounter: string;
  /** What an observation must look like. Fixtures are validated against it, so a drifted fixture fails loudly. */
  input: z.ZodType<In>;
  evaluate(input: In): Verdict;
}

/** A heuristic with its input type erased, so one registry can hold all of them. */
export interface AnyHeuristic {
  readonly id: string;
  readonly title: string;
  readonly stage: Stage;
  readonly decides: string;
  readonly encounter: string;
  /** Validate an observation and judge it. Throws `ZodError` when the shape is wrong. */
  run(observation: unknown): Verdict;
  /** The observation shape, for inspection and for agents writing an observation by hand. */
  readonly jsonSchema: unknown;
}

export function define<In>(heuristic: Heuristic<In>): AnyHeuristic {
  return {
    id: heuristic.id,
    title: heuristic.title,
    stage: heuristic.stage,
    decides: heuristic.decides,
    encounter: heuristic.encounter,
    run: (observation: unknown): Verdict => heuristic.evaluate(heuristic.input.parse(observation)),
    jsonSchema: z.toJSONSchema(heuristic.input as z.ZodType<unknown>),
  };
}

/**
 * A case may switch a heuristic off — client's rubrics override several of these —
 * and the override is recorded rather than applied silently, so a compile that
 * went a strange way can say which rule was not allowed to speak.
 */
export interface Override {
  enabled: boolean;
  /** Why the case overrode it. Required: an unexplained override is indistinguishable from a bug. */
  note: string;
}

export type Overrides = Readonly<Record<string, Override>>;
