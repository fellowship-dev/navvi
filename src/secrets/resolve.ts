import { execFile } from "node:child_process";
import { inspect } from "node:util";
import { NavviError } from "../billing/budget.js";
import type { CompiledScraper } from "../scraper/schema.js";
import type { RunInput } from "../input/schema.js";

/**
 * Secrets (R39). A scraper only ever carries the placeholder `{{secret:name}}`;
 * code resolves the value at replay from, in order, the input map, the
 * environment (`NAVVI_SECRET_<NAME>`), the macOS keychain
 * (`security find-generic-password -s navvi -a <name> -w`) and an Apify
 * source. Values live in a `Secret` whose every rendering path is "[secret]".
 * A missing secret ends the run before the browser opens.
 */

export const SECRET_PLACEHOLDER = /\{\{secret:([a-zA-Z_][a-zA-Z0-9_-]*)\}\}/g;
export const KEYCHAIN_SERVICE = "navvi";

/** How a secret value renders anywhere it might be printed. */
export const MASK = "[secret]";

/** Values shorter than this are not masked: splitting text on them would mangle it more than protect it. */
const MIN_MASKED_LENGTH = 3;

/**
 * `text` with every secret value replaced by `mask(name)`, `[secret:name]` by
 * default. Values under three characters are left alone.
 */
export function maskSecrets(text: string, secrets: Iterable<readonly [name: string, value: string]>, mask: (name: string) => string = (name) => `[secret:${name}]`): string {
  let out = text;
  for (const [name, value] of secrets) {
    if (value.length >= MIN_MASKED_LENGTH) out = out.split(value).join(mask(name));
  }
  return out;
}

/** `url` with any userinfo password (and username) replaced by the mask; a string that is not a URL is returned unchanged. */
export function maskUrlCredentials(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not parseable: strip anything that looks like `scheme://user:pass@` by hand.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, `$1${MASK}@`);
  }
  if (!parsed.username && !parsed.password) return url;
  // Rebuilt by hand: the URL setters would percent-encode the mask's brackets.
  return `${parsed.protocol}//${MASK}@${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * The run input as it may be echoed in a summary or log (R39): every secret
 * value masked and every proxy URL stripped of its userinfo credentials.
 */
export function redactRunInput<T extends Pick<RunInput, "secrets" | "proxy">>(input: T): T {
  const out: T = { ...input, secrets: Object.fromEntries(Object.keys(input.secrets).map((name) => [name, MASK])) };
  if (input.proxy?.proxyUrls) {
    out.proxy = { ...input.proxy, proxyUrls: input.proxy.proxyUrls.map(maskUrlCredentials) };
  }
  return out;
}

export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  /** The only way to the value; never log the result. */
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return MASK;
  }
  toJSON(): string {
    return MASK;
  }
  [inspect.custom](): string {
    return MASK;
  }
}

export class MissingSecretError extends NavviError {
  declare readonly status: "blocked_login_required";
  readonly placeholder: string;
  constructor(name: string, tried: readonly string[]) {
    super(
      "blocked_login_required",
      `secret {{secret:${name}}} is not available; tried ${tried.join(", ")}. Provide it as input.secrets.${name}, ${secretEnvName(name)} or a keychain item (service ${KEYCHAIN_SERVICE}, account ${name})`,
    );
    this.placeholder = name;
  }
}

export function secretEnvName(name: string): string {
  return `NAVVI_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export type PlaceholderSource = string | CompiledScraper | undefined | null;

function isScraper(source: PlaceholderSource): source is CompiledScraper {
  return typeof source === "object" && source !== null && Array.isArray((source as CompiledScraper).trace);
}

/** Placeholder names, de-duplicated in first-seen order, from texts and compiled scrapers. */
export function findPlaceholders(source: PlaceholderSource | readonly PlaceholderSource[]): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    if (!out.includes(name)) out.push(name);
  };
  const list = Array.isArray(source) ? source : [source as PlaceholderSource];
  for (const item of list) {
    if (typeof item === "string") {
      for (const match of item.matchAll(SECRET_PLACEHOLDER)) add(match[1]!);
    } else if (isScraper(item)) {
      for (const step of item.trace) if (step.secret) add(step.secret);
    }
  }
  return out;
}

/** Runs a command and resolves its trimmed stdout, or null when it exits non-zero. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string | null>;

export const execFileRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).replace(/\r?\n$/, ""));
    });
  });

export interface SecretSources {
  input?: Readonly<Record<string, string>> | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Defaults to `process.platform`; the keychain is only consulted on darwin. */
  platform?: NodeJS.Platform | undefined;
  runCommand?: CommandRunner | undefined;
  /** Apify source, e.g. a secret input field or a key-value record; null when absent. */
  apify?: ((name: string) => Promise<string | null>) | undefined;
}

async function fromKeychain(name: string, sources: SecretSources): Promise<string | null> {
  const platform = sources.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const run = sources.runCommand ?? execFileRunner;
  try {
    const value = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Resolves every placeholder or throws `MissingSecretError` for the first one no source has. */
export async function resolveSecrets(names: readonly string[], sources: SecretSources = {}): Promise<Map<string, Secret>> {
  const out = new Map<string, Secret>();
  const env = sources.env ?? process.env;
  for (const name of new Set(names)) {
    const tried: string[] = [];
    let value: string | null | undefined = sources.input?.[name];
    tried.push("input.secrets");
    if (!value) {
      value = env[secretEnvName(name)];
      tried.push(secretEnvName(name));
    }
    if (!value) {
      value = await fromKeychain(name, sources);
      tried.push("keychain");
    }
    if (!value && sources.apify) {
      value = await sources.apify(name).catch(() => null);
      tried.push("apify");
    }
    if (!value) throw new MissingSecretError(name, tried);
    out.set(name, new Secret(value));
  }
  return out;
}
