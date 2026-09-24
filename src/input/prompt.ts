import { createHash } from "node:crypto";
import { z } from "zod";
import { NavviError } from "../billing/budget.js";
import { TEXT_INPUT_CAP, type Chooser, type Question } from "../chooser/chooser.js";
import { premises } from "../chooser/questions.js";
import { isRecord } from "../util/text.js";
import type { ActorLike } from "../scraper/store.js";
import { credentialMessage, findCredential, looksLikeCredential } from "./credentials.js";
import { LIMITS, MODES, PROFILES, parseInput, type RunInput } from "./schema.js";

/**
 * U16 / R1 / KTD11: `prompt` is the only required input. A cache miss asks a
 * single `text` question; the interpretation is validated before persistence
 * and reuse, and merged under whatever the caller set explicitly.
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
  /**
   * The most records the prompt asks for ("up to 10", "the first 5"). Without
   * it "up to 10" was read as nothing and a quotes run returned 100 rows
   * (2026-09-24). An explicit --max-items still wins.
   */
  maxItems: z.number().int().min(1).max(LIMITS.maxItems).optional(),
  /** The most listing pages the prompt allows ("the first 3 pages"). An explicit --max-pages still wins. */
  maxPages: z.number().int().min(1).max(LIMITS.maxPages).optional(),
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
  refuseCredentialValues(json);
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
export async function promptToInput(prompt: string, base: Partial<RunInput>, chooser: Chooser, actor?: ActorLike): Promise<PromptToInputResult> {
  const credential = findCredential({ prompt, goal: base.goal, description: base.description });
  if (credential) throw new CredentialInPromptError(credential.kind, credential.where);

  // Validate the caller before inspecting storage; never let cached values hide invalid input.
  parseInput({ ...base, prompt });
  refuseCredentialValues(prompt);
  const key = promptCacheKey(prompt, base.profile ?? "store");
  const cache = actor ? await actor.openKeyValueStore("prompt-cache") : undefined;
  if (cache && !base.forceRecompile) {
    let cached: StructuredFromPrompt | undefined;
    try {
      const raw = await cache.getValue<unknown>(key);
      if (isRecord(raw) && raw.version === PROMPT_CACHE_VERSION && raw.key === key) {
        const parsed = parseStructured(JSON.stringify(raw.structured));
        if (parsed.ok) {
          validateInterpretation(prompt, parsed.structured);
          cached = parsed.structured;
        }
      }
    } catch {
      // Malformed or obsolete records are cache misses, not run failures.
    }
    if (cached) return { input: merge(prompt, cached, base), structured: cached };
  }

  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const question = buildPromptQuestion(prompt, problems);
    const [answer] = await chooser.ask([question]);
    const parsed = parseStructured(answer?.text);
    if (parsed.ok) {
      validateInterpretation(prompt, parsed.structured);
      const input = merge(prompt, parsed.structured, base);
      // Store only the interpretation; caller URLs, credentials and runtime policy never enter this record.
      await cache?.setValue(key, { version: PROMPT_CACHE_VERSION, key, structured: parsed.structured });
      return { input, structured: parsed.structured };
    }
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
    maxItems: structured.maxItems,
    maxPages: structured.paginate === false ? 1 : structured.maxPages,
  });
  return parseInput({ ...fromPrompt, ...defined(base), prompt });
}

/**
 * Bump when normalization/merge semantics change. The schema and parsing
 * premise are hashed too. 2: the limits the prompt states (`maxItems`,
 * `maxPages`) are part of the interpretation, so a version-1 record, which
 * never read them, is a miss. They are keyed by the prompt like the rest of
 * it; the caller's own --max-items and --max-pages never enter the record and
 * win on merge, cache hit or not.
 */
const PROMPT_CACHE_VERSION = 2;
export function promptCacheKey(prompt: string, profile: string): string {
  return "prompt-" + createHash("sha256").update(JSON.stringify({
    version: PROMPT_CACHE_VERSION, prompt, profile,
    premise: premises.promptToInput(), schema: STRUCTURED_JSON_SCHEMA, textCap: TEXT_INPUT_CAP,
  })).digest("hex");
}

function validateInterpretation(prompt: string, structured: StructuredFromPrompt): void {
  // Validate before explicit overrides can conceal an unsafe model-derived goal or description.
  merge(prompt, structured, {});
}

/** Inspect original model strings before schema parsing can discard extra properties. */
function refuseCredentialValues(value: unknown, path: string[] = []): void {
  if (typeof value === "string") {
    const kind = looksLikeCredential(value);
    if (kind) throw new z.ZodError([{ code: "custom", path, message: credentialMessage(kind, path.join(".") || "prompt") }]);
    for (const match of value.matchAll(/https?:\/\/[^\s]+/giu)) {
      let url: URL;
      try { url = new URL(match[0]); } catch { continue; }
      if (url.username || url.password || [...url.searchParams.keys()].some((key) => /^(?:password|passwd|pwd|token|access_token|refresh_token|api[_-]?key|secret|authorization)$/i.test(key))) {
        throw new z.ZodError([{ code: "custom", path, message: credentialMessage("URL credential", path.join(".") || "prompt") }]);
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => refuseCredentialValues(item, [...path, String(index)]));
  } else if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) => {
      if (/^(?:password|passwd|pwd|token|access_token|refresh_token|api[_-]?key|secret|authorization)$/i.test(key) && typeof item === "string" && item && !item.startsWith("{{secret:")) {
        throw new z.ZodError([{ code: "custom", path: [...path, key], message: credentialMessage("credential value", [...path, key].join(".")) }]);
      }
      refuseCredentialValues(item, [...path, key]);
    });
  }
}
