import { createHash } from "node:crypto";
import { z } from "zod";
import { CHOOSERS, FIELD_TYPES, MODES, PROFILES, type Profile } from "../input/schema.js";

/**
 * CompiledScraper v1 (KTD6): the versioned JSON contract every phase reads and
 * writes. Selectors are only ever passed to querySelector / Playwright
 * locators, never evaluated. Unknown versions are rejected.
 */

export const SCRAPER_VERSION = 1 as const;

// R6: the status union. main.ts imports this once the orchestrator rewires it.
export const STATUSES = [
  "succeeded",
  "no_items_found",
  "blocked_bot_detection",
  "blocked_login_required",
  "blocked_no_progress",
  "drift",
  "charge_limit",
  "budget_exhausted",
  "model_unavailable",
  "needs_human",
] as const;
export type Status = (typeof STATUSES)[number];

export const SHAPES = ["url", "date", "int", "money", "text"] as const;
export const STEP_OPS = ["click", "type", "select", "scroll", "wait", "human"] as const;
export const ENTRY_MODES = ["direct", "trace"] as const;
export const PAGINATION_MODES = ["next_link", "scroll", "none"] as const;

export const FingerprintSchema = z.object({
  samples: z.array(z.string()),
  shape: z.enum(SHAPES),
});

export const FieldAlternativeSchema = z.object({
  selector: z.string().min(1),
  attr: z.string().min(1).optional(),
  fingerprint: FingerprintSchema,
});

/** R31: at least one alternative; healing only ever appends. `type` (R5) is the declared output type replay coerces to. */
export const FieldSchema = z.object({
  alternatives: z.array(FieldAlternativeSchema).min(1, "a field needs at least one alternative"),
  type: z.enum(FIELD_TYPES).optional(),
});

const fieldName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "field names are identifiers");
export const FieldsSchema = z.record(fieldName, FieldSchema);

/** R42: ordered locator alternatives, matched by role and accessible name. */
export const LocatorAlternativeSchema = z.object({
  role: z.string().min(1),
  name: z.string(),
  exact: z.boolean(),
  /** For a control with no accessible name (a password field behind a broken label): its `name` attribute or id, as a CSS selector. */
  css: z.string().min(1).optional(),
});

export const StepTargetSchema = z.object({
  href: z.string().optional(),
  form: z.object({ method: z.string(), action: z.string() }).optional(),
});

export const ExpectSchema = z.union([
  z.object({ role: z.string().min(1), name: z.string() }),
  z.object({ urlPattern: z.string().min(1) }),
]);

export const TraceStepSchema = z
  .object({
    op: z.enum(STEP_OPS),
    text: z.string().optional(),
    /** Secret placeholder name; the value never enters the scraper. */
    secret: z.string().min(1).optional(),
    alternatives: z.array(LocatorAlternativeSchema),
    target: StepTargetSchema.optional(),
    expect: ExpectSchema.optional(),
    human: z.literal(true).optional(),
  })
  .superRefine((step, ctx) => {
    if (step.op === "type" && (step.text === undefined) === (step.secret === undefined)) {
      ctx.addIssue({ code: "custom", message: "a type step carries exactly one of text or secret" });
    }
    if (step.op !== "type" && step.secret !== undefined) {
      ctx.addIssue({ code: "custom", path: ["secret"], message: "only type steps carry a secret placeholder" });
    }
    if (step.op === "human" && step.human !== true) {
      ctx.addIssue({ code: "custom", path: ["human"], message: "a human step is marked human: true" });
    }
  });

export const EntrySchema = z.object({ mode: z.enum(ENTRY_MODES), url: z.string().min(1) });
export const ItemSchema = z.object({ anchorSelector: z.string().min(1), span: z.number().int().min(1) });
export const PaginationSchema = z.object({
  mode: z.enum(PAGINATION_MODES),
  locator: z.array(LocatorAlternativeSchema).optional(),
});
export const DetailSchema = z.object({ linkField: fieldName, fields: FieldsSchema });

export const CompiledScraperSchema = z
  .object({
    version: z.literal(SCRAPER_VERSION),
    templateKey: z.string().min(1),
    cacheKey: z.string().min(1),
    profile: z.enum(PROFILES),
    chooser: z.enum(CHOOSERS),
    mode: z.enum(MODES),
    entry: EntrySchema,
    trace: z.array(TraceStepSchema),
    item: ItemSchema.optional(),
    fields: FieldsSchema,
    pagination: PaginationSchema,
    detail: DetailSchema.nullable(),
    createdAt: z.string().min(1),
    healedAt: z.string().min(1).optional(),
  })
  .superRefine((doc, ctx) => {
    if (doc.mode === "list" && !doc.item) {
      ctx.addIssue({ code: "custom", path: ["item"], message: "list mode needs an item anchor" });
    }
    if (Object.keys(doc.fields).length === 0) {
      ctx.addIssue({ code: "custom", path: ["fields"], message: "a scraper needs at least one field" });
    }
    if (doc.detail && !(doc.detail.linkField in doc.fields)) {
      ctx.addIssue({ code: "custom", path: ["detail", "linkField"], message: `detail.linkField "${doc.detail.linkField}" is not a field` });
    }
  });

export type CompiledScraper = z.infer<typeof CompiledScraperSchema>;
export type Fingerprint = z.infer<typeof FingerprintSchema>;
export type FieldAlternative = z.infer<typeof FieldAlternativeSchema>;
export type Field = z.infer<typeof FieldSchema>;
export type LocatorAlternative = z.infer<typeof LocatorAlternativeSchema>;
export type TraceStep = z.infer<typeof TraceStepSchema>;
export type StepTarget = z.infer<typeof StepTargetSchema>;
export type StepExpect = z.infer<typeof ExpectSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
export type Detail = z.infer<typeof DetailSchema>;
export type Shape = (typeof SHAPES)[number];

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "scraper"}: ${i.message}`).join("\n");
}

/** Validates an untrusted document. Throws with a clear message on version != 1. */
export function validateScraper(raw: unknown): CompiledScraper {
  if (raw === null || typeof raw !== "object") {
    throw new Error("compiled scraper must be a JSON object");
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== SCRAPER_VERSION) {
    throw new Error(`unsupported compiled scraper version ${JSON.stringify(version)} (expected ${SCRAPER_VERSION})`);
  }
  const result = CompiledScraperSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`invalid compiled scraper\n${formatIssues(result.error)}`);
  }
  return result.data;
}

export interface CacheKeyInput {
  goal?: string | undefined;
  description?: string | undefined;
  fields: readonly string[];
  profile: Profile;
}

/** Apify key-value store keys: `^[a-zA-Z0-9!\-_.'()]+$`, at most 256 chars. */
const KEY_SAFE = /[^a-zA-Z0-9!\-_.'()]+/g;

/** KTD7: templateKey + sha256 over goal, description, sorted field names and profile. */
export function cacheKey(templateKey: string, input: CacheKeyInput): string {
  const fields = [...new Set(input.fields)].sort();
  const digest = createHash("sha256")
    .update(JSON.stringify([input.goal ?? "", input.description ?? "", fields, input.profile]))
    .digest("hex");
  const prefix = templateKey.replace(KEY_SAFE, "_").slice(0, 180);
  return `${prefix}-${digest}`;
}

/**
 * Merge rules (R31, R32). Every function is pure and returns a new document.
 * Alternatives are only ever appended; nothing here can rename, retype or
 * remove a field, and appending to an unknown field throws.
 */
export const MERGE_API = ["appendFieldAlternative", "appendStepAlternative", "markHealed"] as const;

function sameFieldAlternative(a: FieldAlternative, b: FieldAlternative): boolean {
  return a.selector === b.selector && a.attr === b.attr;
}

function sameLocator(a: LocatorAlternative, b: LocatorAlternative): boolean {
  return a.role === b.role && a.name === b.name && a.exact === b.exact;
}

export interface AppendFieldOptions {
  /** Append to `detail.fields` instead of the top-level fields. */
  detail?: boolean;
}

export function appendFieldAlternative(
  scraper: CompiledScraper,
  field: string,
  alt: FieldAlternative,
  options: AppendFieldOptions = {},
): CompiledScraper {
  const scope = options.detail ? scraper.detail?.fields : scraper.fields;
  const existing = scope?.[field];
  if (!existing) {
    throw new Error(`unknown field "${field}"; the merge API cannot add or rename fields`);
  }
  if (existing.alternatives.some((a) => sameFieldAlternative(a, alt))) return scraper;
  const updated: Field = { ...existing, alternatives: [...existing.alternatives, alt] };
  if (options.detail && scraper.detail) {
    return { ...scraper, detail: { ...scraper.detail, fields: { ...scraper.detail.fields, [field]: updated } } };
  }
  return { ...scraper, fields: { ...scraper.fields, [field]: updated } };
}

export function appendStepAlternative(scraper: CompiledScraper, stepIndex: number, alt: LocatorAlternative): CompiledScraper {
  const step = scraper.trace[stepIndex];
  if (!Number.isInteger(stepIndex) || !step) {
    throw new Error(`unknown trace step ${stepIndex}; the trace has ${scraper.trace.length} steps`);
  }
  if (step.alternatives.some((a) => sameLocator(a, alt))) return scraper;
  const trace = scraper.trace.map((s, i) => (i === stepIndex ? { ...s, alternatives: [...s.alternatives, alt] } : s));
  return { ...scraper, trace };
}

export function markHealed(scraper: CompiledScraper, at: string | Date = new Date()): CompiledScraper {
  return { ...scraper, healedAt: at instanceof Date ? at.toISOString() : at };
}
