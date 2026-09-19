import { createHash } from "node:crypto";
import { z } from "zod";
import { NavviError } from "../billing/budget.js";
import { TEXT_INPUT_CAP, type Chooser, type Question } from "../chooser/chooser.js";
import { premises } from "../chooser/questions.js";
import { isRecord } from "../util/text.js";
import { credentialMessage, findCredential } from "./credentials.js";
import { MODES, PROFILES, parseInput, type RunInput } from "./schema.js";

/**
 * U16 / R1 / KTD11: `prompt` is the only required input. It is parsed once per
 * run into the structured schema through a single `text` question, validated
 * before use, and merged under whatever the caller set explicitly.
 *
 * R27: a prompt, goal or description carrying a credential literal is refused
 * before any model call (the detector is ./credentials.ts; `InputSchema`
 * applies it too). URLs come from the input, never from the prompt.
 */

/** The structured output the text question must produce. */
export const StructuredFromPromptSchema = z.object({
  mode: z.enum(MODES),
  description: z.string().min(1),
  fields: z.array(z.object({ name: z.string().min(1), description: z.string().optional() })),
  goal: z.string().min(1).optional(),
  profile: z.enum(PROFILES).optional(),
  followDetailPages: z.boolean().optional(),
  /** false when the prompt asks for this page only; true or absent follows next-page links. */
  paginate: z.boolean().optional(),
  /** Secret names the goal will need, e.g. ["username", "password"]. Names, never values. */
  secretsExpected: z.array(z.string().min(1)).optional(),
});

export type StructuredFromPrompt = z.infer<typeof StructuredFromPromptSchema>;

/** JSON target handed to the chooser (ModelChooser quotes it in the request). */
export const STRUCTURED_JSON_SCHEMA: unknown = z.toJSONSchema(StructuredFromPromptSchema);

/** R27: refused before any model call; the run status is `blocked_login_required`. */
export class CredentialInPromptError extends NavviError {
  readonly kind: string;
  readonly where: string;
  constructor(kind: string, where: string) {
    super("blocked_login_required", credentialMessage(kind, where));
    this.kind = kind;
    this.where = where;
  }
}

/** The text question did not yield a valid structured input after the retry. */
export class PromptParseError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`could not infer the structured input from the prompt: ${problems.join("; ")}`);
    this.name = "PromptParseError";
    this.problems = problems;
  }
}

/** Deterministic question id: the same prompt always asks the same question (KTD12 replay, cache keys). */
export function promptQuestionId(prompt: string): string {
  const hash = createHash("sha256").update(fitPrompt(prompt, premises.promptToInput())).digest("hex");
  return `prompt-${hash.slice(0, 12)}`;
}

/** KTD11: premise plus state may not exceed the text input cap; the prompt yields. */
function fitPrompt(prompt: string, premise: string): string {
  return prompt.slice(0, Math.max(0, TEXT_INPUT_CAP - premise.length));
}

/** The one text question of the run; `errors` builds the single retry. */
export function buildPromptQuestion(prompt: string, errors: readonly string[] = []): Question {
  const id = promptQuestionId(prompt);
  const premise = premises.promptToInput(errors);
  return {
    id: errors.length > 0 ? `${id}-retry` : id,
    kind: "text",
    premise,
    state: fitPrompt(prompt, premise),
    maxLength: TEXT_INPUT_CAP,
    schema: STRUCTURED_JSON_SCHEMA,
  };
}

/** Field names must be identifiers: lowercase, underscores, no leading digit. */
export function normalizeFieldName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^\d/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Normalize model-provided field names before validation, keeping the original text as description. */
function normalizeFields(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.fields)) return raw;
  const fields = raw.fields.map((field: unknown) => {
    if (!isRecord(field) || typeof field.name !== "string") return field;
    const name = normalizeFieldName(field.name);
    const description = typeof field.description === "string" && field.description.length > 0 ? field.description : name !== field.name ? field.name : undefined;
    return description === undefined ? { ...field, name } : { ...field, name, description };
  });
  return { ...raw, fields };
}

type Parsed = { ok: true; structured: StructuredFromPrompt } | { ok: false; problems: string[] };

function parseStructured(text: string | undefined): Parsed {
  if (text === undefined) return { ok: false, problems: ["no text answer"] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, problems: [`answer is not valid JSON (${err instanceof Error ? err.message : String(err)})`] };
  }
  if (!isRecord(json)) return { ok: false, problems: ["answer is not a JSON object"] };
  const result = StructuredFromPromptSchema.safeParse(normalizeFields(json));
  if (!result.success) {
    return { ok: false, problems: result.error.issues.map((i) => `${i.path.length > 0 ? i.path.map(String).join(".") : "(root)"}: ${i.message}`) };
  }
  const structured = result.data;
  if (structured.fields.length === 0 && !structured.goal) {
    return { ok: false, problems: ["fields: could not infer any field to extract"] };
  }
  return { ok: true, structured };
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface PromptToInputResult {
  input: RunInput;
  structured: StructuredFromPrompt;
}

/**
 * Parse `prompt` into a `RunInput` through one text question. `base` carries
 * what the caller set explicitly and wins over anything the prompt implies
 * (startUrls, maxPages, mode, ...). Invalid output is retried once with the
 * validation errors appended to the premise, then fails with `PromptParseError`.
 */
export async function promptToInput(prompt: string, base: Partial<RunInput>, chooser: Chooser): Promise<PromptToInputResult> {
  const credential = findCredential({ prompt, goal: base.goal, description: base.description });
  if (credential) throw new CredentialInPromptError(credential.kind, credential.where);

  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const question = buildPromptQuestion(prompt, problems);
    const [answer] = await chooser.ask([question]);
    const parsed = parseStructured(answer?.text);
    if (parsed.ok) return { input: merge(prompt, parsed.structured, base), structured: parsed.structured };
    problems = parsed.problems;
  }
  throw new PromptParseError(problems);
}

function merge(prompt: string, structured: StructuredFromPrompt, base: Partial<RunInput>): RunInput {
  const needsSecrets = (structured.secretsExpected?.length ?? 0) > 0;
  const fromPrompt = defined({
    mode: structured.mode,
    description: structured.description,
    fields: structured.fields.length > 0 ? structured.fields : undefined,
    goal: structured.goal,
    profile: structured.profile ?? (needsSecrets ? "local" : undefined),
    followDetailPages: structured.followDetailPages,
    maxPages: structured.paginate === false ? 1 : undefined,
  });
  return parseInput({ ...fromPrompt, ...defined(base), prompt });
}
