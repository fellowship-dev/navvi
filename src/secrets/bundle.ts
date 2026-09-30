import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, type ScryptOptions } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { NavviError } from "../billing/budget.js";

/**
 * U15 (R19, KTD7): the sealed secrets bundle. Local secrets (gopass, env, a
 * secrets file) are gathered on the machine that has them and sealed into one
 * armored string, `navvi1.<base64url>`, for an env var (`NAVVI_SECRETS`); the
 * passphrase is a second, separate secret (`NAVVI_SECRETS_PASSPHRASE`). The
 * run opens it in-process with node:crypto — scrypt then AES-256-GCM — so no
 * gpg binary, agent or pinentry is ever needed where the scraper runs.
 *
 * Nothing in this file puts a value, or the passphrase, in an error message.
 */

export const BUNDLE_ENV = "NAVVI_SECRETS";
export const PASSPHRASE_ENV = "NAVVI_SECRETS_PASSPHRASE";
export const BUNDLE_VERSION = 1;
export const BUNDLE_PREFIX = `navvi${BUNDLE_VERSION}.`;

/** scrypt cost: N = 2^15 (32 MiB with r = 8), the floor a bundle may declare. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 } as const;
const MIN_N = 2 ** 15;
const MAX_N = 2 ** 20;
const KEY_BYTES = 32;

/** A name a placeholder can reach: `{{secret:name}}`, or `totp:name` for a TOTP seed (U16). */
export const BUNDLE_NAME = /^(?:totp:)?[a-zA-Z_][a-zA-Z0-9_-]*$/;

export class SecretsBundleError extends NavviError {
  declare readonly status: "configuration_error";
  constructor(message: string) {
    super("configuration_error", message);
  }
}

interface Envelope {
  v: number;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r + 1024 * 1024 };
  return new Promise((done, fail) => {
    scryptCallback(passphrase.normalize("NFC"), salt, KEY_BYTES, options, (error, key) => (error ? fail(error) : done(key)));
  });
}

/** The header fields, bound to the ciphertext as associated data so none can be changed unnoticed. */
function aad(envelope: Pick<Envelope, "v" | "kdf" | "N" | "r" | "p" | "salt">): Buffer {
  return Buffer.from(JSON.stringify([envelope.v, envelope.kdf, envelope.N, envelope.r, envelope.p, envelope.salt]), "utf8");
}

/** Seals `secrets` under `passphrase`. The result names nothing and carries no value in the clear. */
export async function sealBundle(secrets: Readonly<Record<string, string>>, passphrase: string): Promise<string> {
  if (!passphrase) throw new SecretsBundleError("a sealed bundle needs a passphrase");
  for (const [name, value] of Object.entries(secrets)) {
    if (!BUNDLE_NAME.test(name)) throw new SecretsBundleError(`secret name "${name}" is not a placeholder name (letters, digits, _ and -, optionally prefixed totp:)`);
    if (typeof value !== "string" || value.length === 0) throw new SecretsBundleError(`secret "${name}" is empty`);
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const head = { v: BUNDLE_VERSION, kdf: "scrypt" as const, ...SCRYPT, salt: salt.toString("base64") };
  const key = await deriveKey(passphrase, salt, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(head));
  const ct = Buffer.concat([cipher.update(JSON.stringify({ secrets }), "utf8"), cipher.final()]);
  const envelope: Envelope = { ...head, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  return BUNDLE_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

/**
 * Opens an armored bundle into its name -> value map. A wrong passphrase and
 * an altered bundle are one error: GCM cannot tell them apart, and saying
 * which would help only someone guessing.
 */
export async function openBundle(armored: string, passphrase: string): Promise<Map<string, string>> {
  const text = armored.trim();
  const version = /^navvi(\d+)\./.exec(text);
  if (!version) throw new SecretsBundleError(`${BUNDLE_ENV} is not a sealed navvi bundle (expected text starting ${BUNDLE_PREFIX}); seal one with \`navvi secrets seal\``);
  if (Number(version[1]) !== BUNDLE_VERSION) {
    throw new SecretsBundleError(`${BUNDLE_ENV} is a version ${version[1]} bundle and this navvi reads version ${BUNDLE_VERSION}; reseal it with this navvi's \`navvi secrets seal\` or upgrade navvi`);
  }
  let envelope: Envelope;
  try {
    envelope = JSON.parse(Buffer.from(text.slice(version[0].length), "base64url").toString("utf8")) as Envelope;
  } catch {
    throw new SecretsBundleError(`${BUNDLE_ENV} is damaged: its body is not readable; copy it again whole`);
  }
  const shaped =
    envelope !== null &&
    typeof envelope === "object" &&
    envelope.v === BUNDLE_VERSION &&
    envelope.kdf === "scrypt" &&
    [envelope.N, envelope.r, envelope.p].every((n) => Number.isInteger(n) && n > 0) &&
    [envelope.salt, envelope.iv, envelope.tag, envelope.ct].every((s) => typeof s === "string");
  if (!shaped) throw new SecretsBundleError(`${BUNDLE_ENV} is damaged: its header is not a version ${BUNDLE_VERSION} bundle's; copy it again whole`);
  if (envelope.N < MIN_N || envelope.N > MAX_N || (envelope.N & (envelope.N - 1)) !== 0 || envelope.r > 32 || envelope.p > 16) {
    throw new SecretsBundleError(`${BUNDLE_ENV} declares scrypt parameters navvi does not accept; reseal it with \`navvi secrets seal\``);
  }
  if (!passphrase) throw new SecretsBundleError(`${BUNDLE_ENV} is set but ${PASSPHRASE_ENV} is not; set the passphrase it was sealed with`);
  let plain: string;
  try {
    const key = await deriveKey(passphrase, Buffer.from(envelope.salt, "base64"), envelope);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad(envelope));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretsBundleError(`${BUNDLE_ENV} could not be opened: ${PASSPHRASE_ENV} is not the passphrase it was sealed with, or the bundle was altered`);
  }
  let parsed: { secrets?: unknown };
  try {
    parsed = JSON.parse(plain) as { secrets?: unknown };
  } catch {
    throw new SecretsBundleError(`${BUNDLE_ENV} opened but holds no secrets map; reseal it`);
  }
  const map = new Map<string, string>();
  if (parsed.secrets === null || typeof parsed.secrets !== "object" || Array.isArray(parsed.secrets)) throw new SecretsBundleError(`${BUNDLE_ENV} opened but holds no secrets map; reseal it`);
  for (const [name, value] of Object.entries(parsed.secrets as Record<string, unknown>)) {
    if (typeof value === "string") map.set(name, value);
  }
  return map;
}

// ---------------------------------------------------------------- seal-time sources

/** Runs a command and resolves its stdout; rejects with the spawn error (`code: "ENOENT"` when the binary is missing). */
export type SealRunner = (command: string, args: readonly string[]) => Promise<string>;

export const execSealRunner: SealRunner = (command, args) =>
  new Promise((done, fail) => {
    execFile(command, [...args], { timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? fail(error) : done(String(stdout))));
  });

export interface SealSource {
  /** The name the value is sealed under; a secrets file without one contributes every key it holds. */
  name: string | undefined;
  /** `gopass:<entry>`, `env:<VAR>` or `file:<secrets.json>`. */
  from: string;
}

export interface GatherContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  run?: SealRunner | undefined;
}

export interface Gathered {
  secrets: Record<string, string>;
  /** One line per source that gave nothing, naming it and why — never a value. */
  problems: string[];
}

function spawnReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return "gopass is not installed (not found on PATH)";
  if (typeof code === "number") return `gopass show exited ${code} (is the entry there, and is gpg unlocked?)`;
  if ((error as { killed?: boolean } | null)?.killed) return "gopass show timed out (a pinentry waiting for a passphrase?)";
  return "gopass show failed";
}

/**
 * An entry in the old navvi's format: the password on line one, then
 * `username:`, `url:` and `totp: otpauth://...` lines. The password comes from
 * `gopass show -o`, the rest from the whole entry.
 */
async function fromGopass(name: string, entry: string, run: SealRunner): Promise<Record<string, string>> {
  const password = (await run("gopass", ["show", "-o", entry])).replace(/\r?\n$/, "");
  if (!password) throw new Error("the entry has no password line");
  const out: Record<string, string> = { [name]: password };
  const whole = await run("gopass", ["show", entry]);
  for (const line of whole.split(/\r?\n/).slice(1)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    if (["username", "user", "login"].includes(key) && out[`${name}_username`] === undefined) out[`${name}_username`] = match[2]!;
    if (key === "totp" && out[`totp:${name}`] === undefined) out[`totp:${name}`] = match[2]!;
  }
  return out;
}

function fromFile(path: string, name: string | undefined, cwd: string): Record<string, string> {
  let parsed: unknown;
  let text: string;
  try {
    text = readFileSync(resolvePath(cwd, path), "utf8");
  } catch (error) {
    throw new Error(`cannot read it (${(error as { code?: string }).code ?? "error"})`);
  }
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message quotes the file around the error: never echo secret material.
    throw new Error("it is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("it must be a JSON object of name -> value");
  const all = parsed as Record<string, unknown>;
  const pick = name === undefined ? Object.keys(all) : [name];
  const out: Record<string, string> = {};
  for (const key of pick) {
    const value = all[key];
    if (value === undefined && name !== undefined) throw new Error(`it has no "${name}"`);
    if (typeof value !== "string") throw new Error(`"${key}" is not a string`);
    out[key] = value;
  }
  return out;
}

/**
 * Reads every source. Sources for the same name are tried in order and the
 * first that answers wins, so a missing gopass can fall back to env; each one
 * that gives nothing is reported by name and reason.
 */
export async function gatherSecrets(sources: readonly SealSource[], context: GatherContext): Promise<Gathered> {
  const secrets: Record<string, string> = {};
  const answered = new Set<string>();
  const problems: string[] = [];
  const run = context.run ?? execSealRunner;
  for (const source of sources) {
    if (source.name !== undefined && answered.has(source.name)) continue;
    const colon = source.from.indexOf(":");
    const kind = colon < 0 ? "" : source.from.slice(0, colon);
    const ref = colon < 0 ? "" : source.from.slice(colon + 1);
    try {
      if (!["gopass", "env", "file"].includes(kind)) throw new Error("is not gopass:<entry>, env:<VAR> or file:<secrets.json>");
      if (!ref) throw new Error("names nothing after the colon");
      let got: Record<string, string>;
      if (kind === "gopass") {
        if (source.name === undefined) throw new Error("needs --name before it");
        try {
          got = await fromGopass(source.name, ref, run);
        } catch (error) {
          throw new Error(error instanceof Error && !("code" in error) && !("killed" in error) ? error.message : spawnReason(error));
        }
      } else if (kind === "env") {
        if (source.name === undefined) throw new Error("needs --name before it");
        const value = context.env[ref];
        if (value === undefined || value === "") throw new Error(`${ref} is not set`);
        got = { [source.name]: value };
      } else {
        got = fromFile(ref, source.name, context.cwd);
      }
      for (const [name, value] of Object.entries(got)) {
        if (answered.has(name)) continue;
        secrets[name] = value;
        answered.add(name);
      }
    } catch (error) {
      problems.push(`${source.name === undefined ? "" : `${source.name} <- `}${source.from}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  return { secrets, problems };
}
