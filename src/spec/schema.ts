import { z } from "zod";
import { FIELD_TYPES, type FieldType } from "../input/schema.js";

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

/**
 * Where a spec element came from: the brief's own words, the compiler's
 * inference, or a person who was asked and answered.
 *
 * The first two are the only two a *drafted* spec can produce, which is why
 * they were the whole list. `--answer fields=…` produces neither: the brief
 * does not contain the words, and navvi did not infer them — somebody stated
 * them. That was recorded as `brief`, which made the spec claim the brief said
 * a word it does not contain, in the one artifact whose whole point is that
 * every claim in it is checkable against the brief printed above it. `inferred`
 * would have been worse still: it files the client's own choice under *"the
 * brief did not ask for these"*.
 *
 * `answered` is not a weaker `brief`. It is a stronger one — a person was
 * shown the open question and settled it — and the reason to spell it is that
 * the evidence behind it is a different kind of thing, so `briefTerm` is
 * absent and no amount of reading the brief will find it.
 */
export const PROVENANCES = ["brief", "inferred", "answered"] as const;
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
  /**
   * What kind of column this asks for, when somebody said.
   *
   * The one place navvi can tell *"is it in stock"* from *"how many are in
   * stock"*. Both are spelled `stock`, both are a perfectly ordinary thing to
   * ask a pharmacy catalogue for, and without a type on the request they are
   * the same request — so the compile binds whichever reading the page happened
   * to offer and the consumer gets the other one. Typed, the two asks are two
   * different asks, and `reconcile` can report a `type-gap` instead of a
   * confident wrong column.
   *
   * The vocabulary is `FIELD_TYPES`, deliberately not a new one. Those six are
   * already what `replay` coerces an extracted string to, what `--fields
   * name:type` accepts on the actor input, and what `--answer
   * fields=name:type` parses; a second list of column kinds living up here
   * would be a second thing to keep true of the same six values. They are also
   * the honest size of the problem: a scraped column is a number with a
   * currency on it, a whole count, a real number, a yes/no, a link, or the
   * words themselves. Nothing here is a type *system* — there is no nullability,
   * no unit, no enum — because none of those has ever decided a binding.
   *
   * Optional, and only a person sets it. The drafting model is not asked for a
   * type: a guessed column type is exactly the invisible guess this artifact
   * exists to refuse, and an untyped request is the truthful record of a brief
   * that said "product info" and nothing about columns.
   */
  type: z.enum(FIELD_TYPES).optional(),
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

/**
 * Every field the spec can act on: the ones somebody actually asked for,
 * whether the brief named them or a person answered the question about them.
 *
 * Written as "not inferred" rather than as a list of the two that count, so
 * that the split this function is about stays one line: an inference is the
 * only thing here nobody has stood behind.
 */
export function requestedFields(spec: Spec): FieldRequest[] {
  return spec.fields.filter((field) => field.provenance !== "inferred");
}

/**
 * The column types the spec declares, as `replay` and `investigate` want them:
 * a map from field name to type, holding only the fields somebody typed.
 *
 * The spec is the one ground for these. They used to travel beside it as a
 * parameter of the make run, which meant a resume that did not repeat
 * `--answer` silently lost them.
 */
export function declaredFieldTypes(spec: Spec): Record<string, FieldType> {
  const types: Record<string, FieldType> = {};
  for (const field of spec.fields) {
    if (field.type !== undefined) types[field.name] = field.type;
  }
  return types;
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
