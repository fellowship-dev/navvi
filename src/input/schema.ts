import { z } from "zod";
import { credentialMessage, findCredential } from "./credentials.js";

/** Structured run input. `prompt` alone is accepted and parsed later (U16). */

export const CHOOSERS = ["agent", "jev", "model", "claude", "codex"] as const;

/**
 * U14: a run has two configurable intelligence sources, chosen independently.
 *
 * - The **decider** answers the structured questions (choice, boolean, score).
 *   Every backend can do that: Jev is the measured default, an API model or a
 *   signed-in CLI does it too, and `agent` means the host coding agent (or the
 *   human) answers them.
 * - The **writer** answers the free-text questions (KTD11: "what search query
 *   would you type here"). Jev judges, it cannot write, so it is not a writer.
 *
 * `chooser` is the one field these two replace and stays the compatibility
 * surface: it sets the decider, and the writer keeps being derived exactly as
 * it is today. An explicit `decider` or `writer` wins over it.
 */
export const DECIDERS = CHOOSERS;
export const WRITERS = ["agent", "model", "claude", "codex"] as const;

/**
 * How the decider is reached. Today this is Jev's two APIs: `typesafe` is the
 * official TypeSafe API (`api.typesafe.ai`) and `gateway` is the Vercel AI
 * Gateway route. Unset keeps the inference from which key is set.
 *
 * SEAM (not implemented): a locally-run open-source model would be a third
 * transport, `local`, reached over an OpenAI-compatible base URL plus a model
 * id — the two values any of llama.cpp, Ollama, vLLM or LM Studio exposes —
 * carried as `NAVVI_LOCAL_BASE_URL` / `NAVVI_LOCAL_MODEL` or as a `local`
 * object on this input, and usable for either role. Nothing here accepts
 * `local` yet: the value is documented, not enumerated, so no configuration
 * can select a backend that would throw at run time.
 */
export const TRANSPORTS = ["gateway", "typesafe"] as const;

export const PROFILES = ["store", "local"] as const;

/**
 * The proxy object exactly as Apify's `editor: "proxy"` emits it: the
 * Console writes `useApifyProxy`, the selected Apify Proxy groups as
 * `apifyProxyGroups` (`RESIDENTIAL`, `BUYPROXIES94952`, …), the optional
 * two-letter country as `apifyProxyCountry`, and a caller's own proxies as
 * `proxyUrls`. Those UI names are the ones the Apify SDK documents as the
 * input-schema spellings of its own `groups` / `countryCode` options
 * (`node_modules/apify/dist/proxy_configuration.d.ts`,
 * `ProxyConfigurationOptions`), so modelling them here is what makes the
 * Console's residential selection survive validation instead of being
 * stripped. `crawler.ts` maps them onto `groups` / `countryCode`, the names
 * the SDK asks crawler code to use.
 *
 * Apify Proxy and a caller's own `proxyUrls` are one choice, not two layers:
 * Apify's `ProxyConfiguration` throws "Cannot combine custom proxies with
 * Apify Proxy" on the combination, so the run is refused here, at validation,
 * rather than letting one silently shadow the other.
 */
export const ProxySchema = z
  .object({
    useApifyProxy: z.boolean().optional(),
    /** `APIFY_PROXY_VALUE_REGEX` from `@apify/consts`; the SDK rejects anything else. */
    apifyProxyGroups: z.array(z.string().regex(/^[\w._~]+$/, "not an Apify Proxy group name")).optional(),
    /** ISO 3166-1 alpha-2, uppercase, as the SDK's `COUNTRY_CODE_REGEX` requires. */
    apifyProxyCountry: z
      .string()
      .regex(/^[A-Z]{2}$/, "not a two-letter upper-case ISO 3166-1 country code")
      .optional(),
    proxyUrls: z.array(z.string()).optional(),
  })
  .superRefine((proxy, ctx) => {
    const own = proxy.proxyUrls?.length ?? 0;
    if (proxy.useApifyProxy && own > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["proxyUrls"],
        message: "proxy.useApifyProxy cannot be combined with proxy.proxyUrls; pick Apify Proxy or your own proxy URLs, not both",
      });
    }
    if (!proxy.useApifyProxy && (proxy.apifyProxyGroups?.length || proxy.apifyProxyCountry)) {
      ctx.addIssue({
        code: "custom",
        path: ["useApifyProxy"],
        message: "proxy.apifyProxyGroups and proxy.apifyProxyCountry need proxy.useApifyProxy: true",
      });
    }
  });

export type ProxyInput = z.infer<typeof ProxySchema>;
export const BROWSERS = ["camoufox", "chromium"] as const;
export const MODES = ["list", "record"] as const;
/** R5: output types a field may declare; replay coerces the extracted text to them. */
export const FIELD_TYPES = ["text", "money", "integer", "number", "boolean", "url"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const LIMITS = {
  /** Run-wide: pages beyond each start URL's first (pagination, detail pages); a list of search URLs times their depth. */
  maxPages: 20_000,
  /** One start URL's listing: its first page plus the pages pagination adds. */
  maxPagesPerStart: 1000,
  maxItems: 50_000,
  chooserInputTokens: 1_500_000,
  textHelperCalls: 40,
  healingEvents: 5,
  navigationSteps: 30,
  navigationRequests: 60,
} as const;

/**
 * R26 / U11 R15: which hosts a run may never reach. Classification works on
 * parsed addresses, not string prefixes: the old prefix table let
 * `[::ffff:a9fe:a9fe]` (169.254.169.254 as IPv4-mapped IPv6), `[::]`, CGNAT,
 * multicast and `localhost.` through, and refused any public *name* that
 * happened to start with "fc" or "fd". `fc00::/7` is an IPv6 rule and only
 * ever applies to an IPv6 literal.
 */
const PRIVATE_NAME_SUFFIXES = [".localhost", ".local", ".internal"];

/** Blocked IPv4 ranges as [first octets as a 32-bit network, prefix length]. */
const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network", includes the unspecified 0.0.0.0
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT (RFC 6598)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes broadcast 255.255.255.255
];
const PRIVATE_V4: Array<[number, number]> = PRIVATE_V4_RANGES.map(([net, bits]) => [v4ToInt(parseV4(net)!), bits]);

function parseV4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null;
}

function v4ToInt(octets: number[]): number {
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

function isPrivateV4(octets: number[]): boolean {
  const ip = v4ToInt(octets);
  return PRIVATE_V4.some(([net, bits]) => ip >>> (32 - bits) === net >>> (32 - bits));
}

/** Eight 16-bit groups, or null. Accepts `::` compression and a trailing dotted IPv4 (resolver answers use it). */
function parseV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && text.slice(lastColon + 1).includes(".")) {
    // A dotted IPv4 tail (`::ffff:10.0.0.5`) becomes its two hex groups.
    const v4 = parseV4(text.slice(lastColon + 1));
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    return groups.every((g) => Number.isInteger(g)) ? groups : null;
  };
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length;
  if (halves.length === 1 && known !== 8) return null;
  if (halves.length === 2 && known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest];
}

function embeddedV4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isPrivateV6(g: number[]): boolean {
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped).
  if (g.slice(0, 5).every((x) => x === 0)) {
    if (g[5] === 0xffff) return isPrivateV4(embeddedV4(g[6]!, g[7]!));
    if (g[5] === 0) return true;
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(embeddedV4(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return isPrivateV4(embeddedV4(g[1]!, g[2]!)); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/**
 * True for a private, loopback, link-local, CGNAT, multicast, unspecified,
 * broadcast or reserved address, IPv4 or IPv6 (IPv4-mapped IPv6 is judged by
 * the IPv4 it carries). Anything that does not parse as an address is treated
 * as private: this classifies resolver answers, and an answer it cannot read
 * must not open the door.
 */
export function isPrivateAddress(ip: string): boolean {
  const text = ip.trim().replace(/^\[|\]$/g, "");
  const v4 = parseV4(text);
  if (v4) return isPrivateV4(v4);
  const v6 = text.includes(":") ? parseV6(text) : null;
  if (v6) return isPrivateV6(v6);
  return true;
}

/** An IP literal as the URL parser prints a hostname: dotted IPv4, or bracketed IPv6. */
export function isIpLiteral(host: string): boolean {
  return parseV4(host) !== null || (host.startsWith("[") && host.endsWith("]"));
}

/** The hostname rules: `localhost`, `*.localhost`, `.local`, `.internal`, each with or without the trailing dot. */
export function isPrivateHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost") return true;
  return PRIVATE_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** A URL hostname (as `new URL()` normalizes it) that a run may not reach without an allowlist entry. */
export function isPrivateHost(host: string): boolean {
  if (!host) return true;
  if (isIpLiteral(host)) return isPrivateAddress(host);
  return isPrivateHostname(host);
}

/**
 * R26: only http(s) to a public host, unless the host is explicitly
 * allowlisted. This is the static half; a name's resolved addresses are
 * checked by `makeHostCheck` in browser/policy.ts (KTD12).
 */
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
  return !isPrivateHost(host);
}

const urlField = z.string().url();

export const FieldSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "field names are identifiers"),
  description: z.string().optional(),
  type: z.enum(FIELD_TYPES).optional(),
  /**
   * The field may be empty on a healthy page: a struck-through list price
   * exists only while a product is discounted. Replay never heals a null in an
   * optional field (it asked the chooser on every undiscounted page, every
   * run); a run whose rows never fill it reports it as not found instead.
   */
  optional: z.boolean().optional(),
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
    /**
     * The run's page budget. Every start URL's first page is read whatever it
     * says (a list of 1000 search URLs is 1000 listings, not 10); pagination
     * and detail pages stop once the run has scraped this many pages.
     */
    maxPages: z.number().int().min(1).max(LIMITS.maxPages).default(10),
    /** List mode: pages one start URL's listing may span, its first included; unset, only `maxPages` bounds it. */
    maxPagesPerStart: z.number().int().min(1).max(LIMITS.maxPagesPerStart).optional(),
    maxItems: z.number().int().min(1).max(LIMITS.maxItems).default(1000),
    /** Pages a replay opens at once (default 4); a compile always runs one at a time. */
    maxConcurrency: z.number().int().min(1).max(20).optional(),
    /** Pages a replay keeps open even when the platform reads its CPU as busy. */
    minConcurrency: z.number().int().min(1).max(20).optional(),
    followDetailPages: z.boolean().default(false),
    detailFields: z.array(FieldSchema).optional(),
    browser: z.enum(BROWSERS).optional(),
    allowedDomains: z.array(z.string().min(1)).default([]),
    allowPrivateHosts: z.array(z.string().min(1)).default([]),
    proxy: ProxySchema.optional(),
    scriptId: z.string().optional(),
    forceRecompile: z.boolean().default(false),
    /** U14: the single field the two sources replace; still honoured, see `resolveSources`. */
    chooser: z.enum(CHOOSERS).optional(),
    /** U14: who answers the structured questions. Wins over `chooser`. */
    decider: z.enum(DECIDERS).optional(),
    /** U14: who answers the free-text questions. Jev cannot write, so it is not offered. */
    writer: z.enum(WRITERS).optional(),
    /** U14: which API the decider is reached over (Jev today); unset infers it from the keys. */
    deciderTransport: z.enum(TRANSPORTS).optional(),
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
/** U14: a backend that can answer structured questions; every chooser can. */
export type Decider = (typeof DECIDERS)[number];
/** U14: a backend that can answer free text; every chooser but Jev. */
export type Writer = (typeof WRITERS)[number];
/** U14: how the decider is reached. */
export type Transport = (typeof TRANSPORTS)[number];

export function isChooserId(name: string): name is Chooser {
  return (CHOOSERS as readonly string[]).includes(name);
}
export function isWriterId(name: string): name is Writer {
  return (WRITERS as readonly string[]).includes(name);
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

/** U14: the two sources a run actually uses, plus the decider's transport. */
export interface SourceSelection {
  decider: Decider;
  /**
   * Explicitly configured writer. `undefined` means "derive it": the decider
   * writes its own text, unless it is Jev, which cannot, and then the ordered
   * chain in `createChooser` (subscription CLIs, then a metered model) does.
   */
  writer?: Writer;
  deciderTransport?: Transport;
}

/** The fields of a run input `resolveSources` reads; `RunInput` satisfies it. */
export interface SourceInput {
  chooser?: Chooser | undefined;
  decider?: Decider | undefined;
  writer?: Writer | undefined;
  deciderTransport?: Transport | undefined;
}

/**
 * U14 compatibility: `chooser` names the decider, and only the decider. When
 * `decider` is also given the explicit field wins; `writer` has no old
 * equivalent, so leaving it unset reproduces today's derivation exactly. With
 * neither field the decider is `defaultChooser(env, available)`, unchanged.
 */
export function resolveSources(input: SourceInput = {}, env: NodeJS.ProcessEnv = process.env, available: AvailableClis = {}): SourceSelection {
  const selection: SourceSelection = { decider: input.decider ?? input.chooser ?? defaultChooser(env, available) };
  if (input.writer) selection.writer = input.writer;
  if (input.deciderTransport) selection.deciderTransport = input.deciderTransport;
  return selection;
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
