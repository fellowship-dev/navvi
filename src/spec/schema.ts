import { z } from "zod";

/**
 * S0 of the prompt-to-scraper pipeline (plan 2026-09-22-007, U1): a brief
 * compiles into a **spec** before anything touches the web.
 *
 * The spec is the artifact the client approves and the compile is later judged
 * against. Its load-bearing part is not the list of fields it found; it is the
 * list of things the brief did **not** say. "Product info" names no field, and
 * "a dynamic set of products" names no input shape. Both are recorded as open
 * questions rather than guessed, because the guess is invisible afterwards and
 * the open question is not.
 */

export const PAGE_KINDS = ["product", "listing", "search", "unknown"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/**
 * What varies per run. Which one it is changes the whole design — a URL list
 * needs no link finder, a SKU list needs a URL template, search terms need
 * navigation — so an unresolved shape is a blocking open question, never a
 * default.
 */
export const INPUT_SHAPES = ["url_list", "sku_list", "search_terms", "unknown"] as const;
export type InputShape = (typeof INPUT_SHAPES)[number];

/** Where a spec element came from: the brief's own words, or the compiler's inference. */
export const PROVENANCES = ["brief", "inferred"] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Who can answer an open question: the client, or S1's investigation with evidence. */
export const ANSWERED_BY = ["client", "investigation"] as const;
export type AnsweredBy = (typeof ANSWERED_BY)[number];

export const OPEN_QUESTION_SUBJECTS = ["target", "entity", "inputs", "fields", "constraints"] as const;
export type OpenQuestionSubject = (typeof OPEN_QUESTION_SUBJECTS)[number];

export const FieldRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * The exact words of the brief this field came from, when it has any. Checked
   * against the brief text: a term that is not in the brief does not make the
   * field requested, whatever the draft claims.
   */
  briefTerm: z.string().optional(),
  provenance: z.enum(PROVENANCES),
});
export type FieldRequest = z.infer<typeof FieldRequestSchema>;

export const OpenQuestionSchema = z.object({
  id: z.string().min(1),
  about: z.enum(OPEN_QUESTION_SUBJECTS),
  question: z.string().min(1),
  /** What the brief left unsaid, in the brief's own words, so the question is traceable. */
  because: z.string().min(1),
  /** The options worth offering; for fields, what the draft inferred and the client may confirm. */
  candidates: z.array(z.string()).optional(),
  /** Blocking questions stop the compile from being meaningful; the rest only make it poorer. */
  blocking: z.boolean(),
  answeredBy: z.enum(ANSWERED_BY),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

/** A constraint slot is always present, so an unstated one is visible rather than absent. */
export const ConstraintSchema = z.object({
  value: z.string().optional(),
  stated: z.boolean(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const ConstraintsSchema = z.object({
  freshness: ConstraintSchema,
  volume: ConstraintSchema,
  cadence: ConstraintSchema,
  budget: ConstraintSchema,
});
export type Constraints = z.infer<typeof ConstraintsSchema>;

/**
 * A case rubric, passed in rather than rediscovered (U8): "the list price is the
 * crossed-out one and never Precio Club". Carried verbatim into the spec so the
 * client's domain knowledge is part of what they approve.
 */
export const RubricSchema = z.object({
  id: z.string().min(1),
  rule: z.string().min(1),
  source: z.string().min(1),
});
export type Rubric = z.infer<typeof RubricSchema>;

export const SpecSchema = z.object({
  version: z.literal(1),
  /** The brief, verbatim. Every provenance claim in the spec is checkable against it. */
  brief: z.string().min(1),
  target: z.object({
    site: z.string().min(1),
    pageKind: z.enum(PAGE_KINDS),
    provenance: z.enum(PROVENANCES),
  }),
  /** What one row is. */
  entity: z.object({
    name: z.string().min(1),
    provenance: z.enum(PROVENANCES),
  }),
  inputs: z.object({
    shape: z.enum(INPUT_SHAPES),
    description: z.string().min(1),
    provenance: z.enum(PROVENANCES),
  }),
  fields: z.array(FieldRequestSchema),
  constraints: ConstraintsSchema,
  rubrics: z.array(RubricSchema),
  openQuestions: z.array(OpenQuestionSchema),
});
export type Spec = z.infer<typeof SpecSchema>;

/** Every field the spec can act on: the ones the brief actually asked for. */
export function requestedFields(spec: Spec): FieldRequest[] {
  return spec.fields.filter((field) => field.provenance === "brief");
}

/** Fields the draft proposed that the brief never named; S3 answers these with evidence. */
export function underspecifiedFields(spec: Spec): FieldRequest[] {
  return spec.fields.filter((field) => field.provenance === "inferred");
}

export function blockingQuestions(spec: Spec): OpenQuestion[] {
  return spec.openQuestions.filter((question) => question.blocking);
}

/** A spec with no blocking question is ready for S1; the rest need the client first. */
export function isReadyToInvestigate(spec: Spec): boolean {
  return blockingQuestions(spec).length === 0;
}
