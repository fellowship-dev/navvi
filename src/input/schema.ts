import { z } from "zod";
import { credentialMessage, findCredential } from "./credentials.js";

/** Structured run input. `prompt` alone is accepted and parsed later (U16). */

export const CHOOSERS = ["agent", "jev", "model", "claude", "codex"] as const;
export const PROFILES = ["store", "local"] as const;
export const BROWSERS = ["camoufox", "chromium"] as const;
export const MODES = ["list", "record"] as const;
/** R5: output types a field may declare; replay coerces the extracted text to them. */
export const FIELD_TYPES = ["text", "money", "integer", "number", "boolean", "url"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const LIMITS = {
  maxPages: 1000,
  maxItems: 50_000,
  chooserInputTokens: 1_500_000,
  textHelperCalls: 40,
  healingEvents: 5,
  navigationSteps: 30,
  navigationRequests: 60,
} as const;

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?fc/i,
  /^\[?fd/i,
];

/** R26: only http(s) to a public host, unless the host is explicitly allowlisted. */
export function isAllowedUrl(raw: string, allowPrivateHosts: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  if (!host) return false;
  if (allowPrivateHosts.includes(host)) return true;
  return !PRIVATE_HOST_PATTERNS.some((p) => p.test(host));
}

const urlField = z.string().url();

export const FieldSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "field names are identifiers"),
  description: z.string().optional(),
  type: z.enum(FIELD_TYPES).optional(),
});

/** `--fields name:type`: a bare name, or a name with one of FIELD_TYPES after a colon. */
export function parseFieldSpecs(specs: readonly string[]): Array<{ name: string; type?: FieldType }> {
  return specs.map((spec) => {
    const colon = spec.indexOf(":");
    if (colon < 0) return { name: spec };
    const name = spec.slice(0, colon);
    const type = spec.slice(colon + 1);
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      throw new Error(`unknown field type "${type}" in "${spec}"; one of ${FIELD_TYPES.join(", ")}`);
    }
    return { name, type: type as FieldType };
  });
}

/**
 * R34: a start entry is a URL, `{ url }` (Apify's request list editor) or
 * `{ requestsFromUrl }`, a URL answering URLs as newline text or JSON. The
 * lists are split out into `urlLists` before validation.
 */
function splitStartUrls(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as { startUrls?: unknown }).startUrls)) return raw;
  const input = raw as { startUrls: unknown[]; urlLists?: unknown };
  const startUrls: unknown[] = [];
  const urlLists: unknown[] = Array.isArray(input.urlLists) ? [...input.urlLists] : [];
  for (const entry of input.startUrls) {
    if (entry !== null && typeof entry === "object") {
      const o = entry as { url?: unknown; requestsFromUrl?: unknown };
      if (typeof o.requestsFromUrl === "string") urlLists.push(o.requestsFromUrl);
      else if ("url" in o) startUrls.push(o.url);
      else startUrls.push(entry);
    } else startUrls.push(entry);
  }
  return { ...input, startUrls, urlLists };
}

/** The input object before the start-URL split; the actor schema test reads its keys. */
export const BaseInputSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    startUrls: z.array(urlField).optional(),
    /** URLs answering a list of URLs (R34); merged into the start URLs at run time. */
    urlLists: z.array(urlField).default([]),
    mode: z.enum(MODES).optional(),
    description: z.string().optional(),
    fields: z.array(FieldSchema).optional(),
    goal: z.string().optional(),
    maxPages: z.number().int().min(1).max(LIMITS.maxPages).default(10),
    maxItems: z.number().int().min(1).max(LIMITS.maxItems).default(1000),
    followDetailPages: z.boolean().default(false),
    detailFields: z.array(FieldSchema).optional(),
    browser: z.enum(BROWSERS).optional(),
    allowedDomains: z.array(z.string().min(1)).default([]),
    allowPrivateHosts: z.array(z.string().min(1)).default([]),
    proxy: z.object({ useApifyProxy: z.boolean().optional(), proxyUrls: z.array(z.string()).optional() }).optional(),
    scriptId: z.string().optional(),
    forceRecompile: z.boolean().default(false),
    chooser: z.enum(CHOOSERS).optional(),
    profile: z.enum(PROFILES).default("store"),
    secrets: z.record(z.string(), z.string()).default({}),
    allowMutations: z.array(z.string()).default([]),
    freshProfile: z.boolean().default(false),
    headed: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (!input.prompt && !input.startUrls && input.urlLists.length === 0) {
      ctx.addIssue({ code: "custom", path: ["startUrls"], message: "startUrls is required when prompt is not given" });
    }
    if (input.startUrls && input.startUrls.length === 0 && input.urlLists.length === 0) {
      ctx.addIssue({ code: "custom", path: ["startUrls"], message: "startUrls needs at least one URL or list" });
    }
    for (const [i, url] of input.urlLists.entries()) {
      if (!isAllowedUrl(url, input.allowPrivateHosts)) {
        ctx.addIssue({ code: "custom", path: ["urlLists", i], message: `not an allowed public http(s) URL: ${url}` });
      }
    }
    if (!input.prompt && !input.mode) {
      ctx.addIssue({ code: "custom", path: ["mode"], message: "mode is required when prompt is not given" });
    }
    if (!input.prompt && (!input.fields || input.fields.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["fields"], message: "fields is required when prompt is not given" });
    }
    for (const [i, url] of (input.startUrls ?? []).entries()) {
      if (!isAllowedUrl(url, input.allowPrivateHosts)) {
        ctx.addIssue({ code: "custom", path: ["startUrls", i], message: `not an allowed public http(s) URL: ${url}` });
      }
    }
    if (input.profile === "store" && Object.keys(input.secrets).length > 0) {
      ctx.addIssue({ code: "custom", path: ["secrets"], message: "the store profile takes no secrets; use profile: local" });
    }
    // R27: a credential literal is refused at validation, before any model call.
    const credential = findCredential(input);
    if (credential) {
      ctx.addIssue({ code: "custom", path: [credential.where], message: credentialMessage(credential.kind, credential.where) });
    }
  });

export const InputSchema = z.preprocess(splitStartUrls, BaseInputSchema);

export type RunInput = z.infer<typeof BaseInputSchema>;
export type Chooser = (typeof CHOOSERS)[number];

export function isChooserId(name: string): name is Chooser {
  return (CHOOSERS as readonly string[]).includes(name);
}
export type Profile = (typeof PROFILES)[number];
export type BrowserName = (typeof BROWSERS)[number];
export type Mode = (typeof MODES)[number];

export function parseInput(raw: unknown): RunInput {
  return InputSchema.parse(raw);
}

/** Which installed coding CLIs are signed in, as probed by `resolveDefaultChooser`. */
export interface AvailableClis {
  claude?: boolean;
  codex?: boolean;
}

/**
 * R37 / KTD17: a key wins (jev, then model); without one, a signed-in
 * Claude Code, then Codex, answers on the subscription; else the agent
 * chooser. `available` comes from `probeCli`; unknown means not available.
 */
export function defaultChooser(env: NodeJS.ProcessEnv = process.env, available: AvailableClis = {}): Chooser {
  if (env.AI_GATEWAY_API_KEY || env.TYPESAFE_API_KEY) return "jev";
  if (env.ANTHROPIC_API_KEY) return "model";
  if (available.claude) return "claude";
  if (available.codex) return "codex";
  return "agent";
}

/** True when a key selects the chooser and no CLI probe is needed. */
export function hasChooserKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY || env.TYPESAFE_API_KEY || env.ANTHROPIC_API_KEY);
}

/** R43: Camoufox locally, Chromium on Apify. */
export function defaultBrowser(env: NodeJS.ProcessEnv = process.env): BrowserName {
  if (env.NAVVI_BROWSER === "chromium" || env.NAVVI_BROWSER === "camoufox") return env.NAVVI_BROWSER;
  if (env.APIFY_IS_AT_HOME) return "chromium";
  return "camoufox";
}
