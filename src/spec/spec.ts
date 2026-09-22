import { createHash } from "node:crypto";
import { z } from "zod";
import { TEXT_INPUT_CAP, type Chooser, type Question } from "../chooser/chooser.js";
import { premises } from "../chooser/questions.js";
import { findCredential } from "../input/credentials.js";
import { CredentialInPromptError, normalizeFieldName } from "../input/prompt.js";
import { isRecord, normalize } from "../util/text.js";
import { briefContains, briefNamesField, isVague, resolveInputShape, vagueTermIn } from "./brief.js";
import { INPUT_SHAPES, PAGE_KINDS, SpecSchema, type FieldRequest, type OpenQuestion, type Rubric, type Spec } from "./schema.js";

/**
 * U1: `navvi spec`. One text question turns the brief into a **draft**; the
 * rest of this file is deterministic and decides how much of that draft the
 * brief supports. The model proposes, the brief disposes.
 */

/** What the text question must produce. Provenance is not in it: the draft does not get to claim it. */
export const SpecDraftSchema = z.object({
  target: z.object({
    site: z.string().min(1),
    pageKind: z.enum(PAGE_KINDS),
    briefTerm: z.string().optional(),
  }),
  entity: z.object({
    name: z.string().min(1),
    briefTerm: z.string().optional(),
  }),
  inputs: z.object({
    shape: z.enum(INPUT_SHAPES),
    description: z.string().min(1),
    briefTerm: z.string().optional(),
  }),
  fields: z.array(z.object({ name: z.string().min(1), description: z.string().optional(), briefTerm: z.string().optional() })),
  constraints: z
    .object({
      freshness: z.string().optional(),
      volume: z.string().optional(),
      cadence: z.string().optional(),
      budget: z.string().optional(),
    })
    .optional(),
});

export type SpecDraft = z.infer<typeof SpecDraftSchema>;

export const SPEC_DRAFT_JSON_SCHEMA: unknown = z.toJSONSchema(SpecDraftSchema);

/** The draft did not parse after the retry. */
export class SpecParseError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`could not draft a spec from the brief: ${problems.join("; ")}`);
    this.name = "SpecParseError";
    this.problems = problems;
  }
}

/** Deterministic question id: the same brief always asks the same question (offline replay, cache keys). */
export function specQuestionId(brief: string): string {
  const hash = createHash("sha256").update(fitBrief(brief, premises.briefToSpec())).digest("hex");
  return `spec-${hash.slice(0, 12)}`;
}

function fitBrief(brief: string, premise: string): string {
  return brief.slice(0, Math.max(0, TEXT_INPUT_CAP - premise.length));
}

export function buildSpecQuestion(brief: string, errors: readonly string[] = []): Question {
  const id = specQuestionId(brief);
  const premise = premises.briefToSpec(errors);
  return {
    id: errors.length > 0 ? `${id}-retry` : id,
    kind: "text",
    premise,
    state: fitBrief(brief, premise),
    maxLength: TEXT_INPUT_CAP,
    schema: SPEC_DRAFT_JSON_SCHEMA,
  };
}

// ------------------------------------------------------------ reconciliation

/** A constraint value counts as stated only when some content word of it is in the brief. */
function groundedIn(brief: string, value: string): boolean {
  const words = normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
  if (words.length === 0) return briefContains(brief, value);
  return words.some((word) => briefContains(brief, word));
}

function constraint(brief: string, value: string | undefined) {
  if (value === undefined || value.trim().length === 0) return { stated: false };
  return groundedIn(brief, value) ? { value, stated: true } : { stated: false };
}

function fieldsFrom(brief: string, draft: SpecDraft): FieldRequest[] {
  const seen = new Set<string>();
  const fields: FieldRequest[] = [];
  for (const raw of draft.fields) {
    const name = normalizeFieldName(raw.name);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    const named = briefNamesField(brief, name, raw.briefTerm);
    const description = raw.description ?? (normalizeFieldName(raw.name) !== raw.name ? raw.name : undefined);
    fields.push({
      name,
      ...(description === undefined ? {} : { description }),
      // A quote the brief does not contain is dropped rather than carried as if it were evidence.
      ...(raw.briefTerm !== undefined && briefContains(brief, raw.briefTerm) ? { briefTerm: raw.briefTerm } : {}),
      provenance: named ? "brief" : "inferred",
    });
  }
  return fields;
}

/** The brief's own words for "we never said which fields", quoted back in the open question. */
function vaguePhrase(brief: string, draft: SpecDraft): string {
  const quoted = draft.fields.map((field) => field.briefTerm).find((term) => term !== undefined && briefContains(brief, term) && isVague(term));
  // Failing a quote from the draft, the brief is scanned for its own bundle word.
  const phrase = quoted ?? vagueTermIn(brief);
  if (phrase !== undefined) return `the brief says "${phrase}", which names no field`;
  return "the brief names no field to extract";
}

const SHAPE_LABELS: Record<string, string> = {
  url_list: "a URL list",
  sku_list: "a SKU or code list",
  search_terms: "search terms",
};

function openQuestionsFor(brief: string, spec: Omit<Spec, "openQuestions">, draft: SpecDraft): OpenQuestion[] {
  const questions: OpenQuestion[] = [];
  const requested = spec.fields.filter((field) => field.provenance === "brief");
  const inferred = spec.fields.filter((field) => field.provenance === "inferred");

  if (requested.length === 0) {
    questions.push({
      id: "fields-unnamed",
      about: "fields",
      question: "Which fields should the scraper return?",
      because: vaguePhrase(brief, draft),
      candidates: inferred.map((field) => field.name),
      blocking: true,
      answeredBy: "client",
    });
  } else if (inferred.length > 0) {
    questions.push({
      id: "fields-inferred",
      about: "fields",
      question: `Should the scraper also return ${inferred.map((field) => field.name).join(", ")}?`,
      because: "the brief does not name these; they were inferred from what the request usually means",
      candidates: inferred.map((field) => field.name),
      blocking: false,
      answeredBy: "client",
    });
  }

  if (spec.inputs.shape === "unknown") {
    questions.push({
      id: "inputs-shape",
      about: "inputs",
      question: "In what shape do the inputs arrive: a URL list, a SKU or code list, or search terms?",
      because: `the brief describes the inputs as "${spec.inputs.description}", which fits all three`,
      candidates: Object.values(SHAPE_LABELS),
      blocking: true,
      answeredBy: "client",
    });
  }

  if (spec.target.provenance === "inferred") {
    questions.push({
      id: "target-site",
      about: "target",
      question: "Which site is this for?",
      because: "the brief does not name a site the draft could quote",
      blocking: true,
      answeredBy: "client",
    });
  }

  if (spec.target.pageKind === "unknown") {
    questions.push({
      id: "target-page-kind",
      about: "target",
      question: "What kind of page does one record live on: a product page, a listing, or a search result page?",
      because: "the brief does not say, and the investigation can settle it from a sample URL",
      candidates: ["product", "listing", "search"],
      blocking: false,
      answeredBy: "investigation",
    });
  }

  const unstated = (["freshness", "volume", "cadence", "budget"] as const).filter((name) => !spec.constraints[name].stated);
  if (unstated.length > 0) {
    questions.push({
      id: "constraints-unstated",
      about: "constraints",
      question: `Does the run have a ${unstated.join(", ")} constraint?`,
      because: "the brief states none of these",
      candidates: [...unstated],
      blocking: false,
      answeredBy: "client",
    });
  }

  return questions;
}

/** The deterministic half: what the brief supports, given a draft. Pure, and the unit the tests pin. */
export function specFromDraft(brief: string, draft: SpecDraft, rubrics: readonly Rubric[] = []): Spec {
  const shape = resolveInputShape(brief, draft.inputs.shape);
  const targetNamed = briefContains(brief, draft.target.briefTerm ?? draft.target.site);
  const entityNamed = briefContains(brief, draft.entity.briefTerm ?? draft.entity.name);
  const withoutQuestions: Omit<Spec, "openQuestions"> = {
    version: 1,
    brief,
    target: { site: draft.target.site, pageKind: draft.target.pageKind, provenance: targetNamed ? "brief" : "inferred" },
    entity: { name: draft.entity.name, provenance: entityNamed ? "brief" : "inferred" },
    inputs: { shape: shape.shape, description: draft.inputs.description, provenance: shape.shape === "unknown" ? "inferred" : "brief" },
    fields: fieldsFrom(brief, draft),
    constraints: {
      freshness: constraint(brief, draft.constraints?.freshness),
      volume: constraint(brief, draft.constraints?.volume),
      cadence: constraint(brief, draft.constraints?.cadence),
      budget: constraint(brief, draft.constraints?.budget),
    },
    rubrics: [...rubrics],
  };
  const spec: Spec = { ...withoutQuestions, openQuestions: openQuestionsFor(brief, withoutQuestions, draft) };
  return SpecSchema.parse(spec);
}

// ------------------------------------------------------------------- driver

type Parsed = { ok: true; draft: SpecDraft } | { ok: false; problems: string[] };

function parseDraft(text: string | undefined): Parsed {
  if (text === undefined) return { ok: false, problems: ["no text answer"] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, problems: [`answer is not valid JSON (${err instanceof Error ? err.message : String(err)})`] };
  }
  if (!isRecord(json)) return { ok: false, problems: ["answer is not a JSON object"] };
  const result = SpecDraftSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, problems: result.error.issues.map((i) => `${i.path.length > 0 ? i.path.map(String).join(".") : "(root)"}: ${i.message}`) };
  }
  return { ok: true, draft: result.data };
}

export interface SpecOptions {
  rubrics?: readonly Rubric[];
}

/**
 * Brief in, spec out. One text question, retried once with the validation
 * errors appended, then `SpecParseError`. R27: a brief carrying a credential
 * literal is refused before any model call.
 */
export async function briefToSpec(brief: string, chooser: Chooser, options: SpecOptions = {}): Promise<Spec> {
  const credential = findCredential({ prompt: brief });
  if (credential) throw new CredentialInPromptError(credential.kind, credential.where);

  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const question = buildSpecQuestion(brief, problems);
    const [answer] = await chooser.ask([question]);
    const parsed = parseDraft(answer?.text);
    if (parsed.ok) return specFromDraft(brief, parsed.draft, options.rubrics);
    problems = parsed.problems;
  }
  throw new SpecParseError(problems);
}
