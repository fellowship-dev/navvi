import { z } from "zod";

/** Structured run input. `prompt` alone is accepted and parsed later (U16). */

export const CHOOSERS = ["agent", "jev", "model"] as const;
export const PROFILES = ["store", "local"] as const;
export const BROWSERS = ["camoufox", "chromium"] as const;
export const MODES = ["list", "record"] as const;

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
});

export const InputSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    startUrls: z.array(urlField).min(1).optional(),
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
    if (!input.prompt && !input.startUrls) {
      ctx.addIssue({ code: "custom", path: ["startUrls"], message: "startUrls is required when prompt is not given" });
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
  });

export type RunInput = z.infer<typeof InputSchema>;
export type Chooser = (typeof CHOOSERS)[number];
export type Profile = (typeof PROFILES)[number];
export type BrowserName = (typeof BROWSERS)[number];
export type Mode = (typeof MODES)[number];

export function parseInput(raw: unknown): RunInput {
  return InputSchema.parse(raw);
}

/** R37 / KTD17: the agent chooser is the default when no key is present. */
export function defaultChooser(env: NodeJS.ProcessEnv = process.env): Chooser {
  if (env.AI_GATEWAY_API_KEY || env.TYPESAFE_API_KEY) return "jev";
  if (env.ANTHROPIC_API_KEY) return "model";
  return "agent";
}

/** R43: Camoufox locally, Chromium on Apify. */
export function defaultBrowser(env: NodeJS.ProcessEnv = process.env): BrowserName {
  if (env.NAVVI_BROWSER === "chromium" || env.NAVVI_BROWSER === "camoufox") return env.NAVVI_BROWSER;
  if (env.APIFY_IS_AT_HOME) return "chromium";
  return "camoufox";
}
