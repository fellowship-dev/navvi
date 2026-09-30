import { createHash, createHmac } from "node:crypto";
import { NavviError } from "../billing/budget.js";
import { Secret } from "./resolve.js";

/**
 * U16 (R20, KTD8): TOTP in-process, RFC 6238 over RFC 4226's HOTP. A seed is
 * resolved like any other secret under the name `totp:<name>` (the
 * `{{totp:name}}` placeholder) and turned into a code only when the replay or
 * the navigator is about to type it, never at run start: a code lives 30 s and
 * a run may spend longer than that before its login step.
 *
 * A seed is an `otpauth://totp/...?secret=BASE32[&digits=&period=&algorithm=]`
 * URI (what an authenticator app scans and gopass stores on its `totp:` line)
 * or a bare base32 secret (30 s, 6 digits, SHA1). Nothing in this file puts a
 * seed or a code in an error message.
 */

export const TOTP_PREFIX = "totp:";
/** A code requested with less than this left in its window waits for the next window. */
export const MIN_REMAINING_MS = 5_000;

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpParams {
  key: Buffer;
  digits: number;
  /** Seconds. */
  period: number;
  algorithm: TotpAlgorithm;
}

export class TotpSeedError extends NavviError {
  declare readonly status: "configuration_error";
  constructor(reason: string) {
    super("configuration_error", `not a TOTP seed: ${reason}`);
  }
}

/** True for a secret name that holds a TOTP seed (`totp:<name>`). */
export function isTotpName(name: string): boolean {
  return name.startsWith(TOTP_PREFIX);
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, case-insensitive, padding and spaces ignored. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  if (clean.length === 0) throw new TotpSeedError("the secret is empty");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new TotpSeedError("the secret is not base32");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

const ALGORITHMS: Record<string, TotpAlgorithm> = { SHA1: "SHA1", SHA256: "SHA256", SHA512: "SHA512" };

/** Parses an `otpauth://totp/...` URI or a bare base32 secret into generation parameters. */
export function parseTotpSeed(seed: string): TotpParams {
  const text = seed.trim();
  if (!/^otpauth:/i.test(text)) return { key: base32Decode(text), digits: 6, period: 30, algorithm: "SHA1" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TotpSeedError("the otpauth URI does not parse");
  }
  if (url.host.toLowerCase() !== "totp") throw new TotpSeedError(`an otpauth URI of type "${url.host}" is not TOTP`);
  const secret = url.searchParams.get("secret");
  if (!secret) throw new TotpSeedError("the otpauth URI has no secret parameter");
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const period = Number(url.searchParams.get("period") ?? 30);
  const algorithm = ALGORITHMS[(url.searchParams.get("algorithm") ?? "SHA1").toUpperCase()];
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new TotpSeedError("digits must be 6 to 10");
  if (!Number.isInteger(period) || period < 1 || period > 300) throw new TotpSeedError("period must be 1 to 300 seconds");
  if (!algorithm) throw new TotpSeedError("algorithm must be SHA1, SHA256 or SHA512");
  return { key: base32Decode(secret), digits, period, algorithm };
}

/** RFC 4226 HOTP for one counter value. */
export function hotp(key: Buffer, counter: number, digits: number, algorithm: TotpAlgorithm = "SHA1"): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The RFC 6238 code at `timeMs` (Unix epoch, milliseconds). */
export function totpAt(params: TotpParams, timeMs: number): string {
  return hotp(params.key, Math.floor(timeMs / 1000 / params.period), params.digits, params.algorithm);
}

export interface TotpClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: TotpClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/**
 * Per clock (in production the one system clock, so per process): the last
 * window each seed's code was generated for, keyed by a hash of the seed.
 * Sites commonly refuse a code a second time (RFC 6238 section 5.2), and a
 * run can log in twice within one window: the navigator records the login,
 * then the replay logs in again.
 */
const usedWindowsByClock = new WeakMap<TotpClock, Map<string, number>>();

/**
 * The code to type now. With less than `MIN_REMAINING_MS` left in the current
 * window, or when this process already generated this seed's code for the
 * current window, it waits for the next one, so the site never receives a code
 * that expires in transit or was already spent. Seed and code stay wrapped in
 * `Secret`.
 */
export async function generateTotp(seed: Secret | string, clock: TotpClock = systemClock): Promise<Secret> {
  const text = typeof seed === "string" ? seed : seed.reveal();
  const params = parseTotpSeed(text);
  const key = createHash("sha256").update(text).digest("hex");
  let usedWindows = usedWindowsByClock.get(clock);
  if (!usedWindows) usedWindowsByClock.set(clock, (usedWindows = new Map()));
  const periodMs = params.period * 1000;
  let now = clock.now();
  const remaining = periodMs - (now % periodMs);
  if (remaining < MIN_REMAINING_MS || usedWindows.get(key) === Math.floor(now / periodMs)) {
    await clock.sleep(remaining);
    now = clock.now();
  }
  usedWindows.set(key, Math.floor(now / periodMs));
  return new Secret(totpAt(params, now));
}

/** The strings of a seed worth masking: the seed as given and, for a URI, its base32 secret. */
export function seedMaskValues(seed: string): string[] {
  const out = [seed];
  if (/^otpauth:/i.test(seed.trim())) {
    try {
      const secret = new URL(seed.trim()).searchParams.get("secret");
      if (secret) out.push(secret);
    } catch {
      // unparseable: the whole string is all there is to mask
    }
  }
  return out;
}

const OTP_HINTS = [/\botp\b/i, /totp/i, /one[\s_-]?time/i, /\b2fa\b/i, /\bmfa\b/i, /two[\s_-]?factor/i, /verification[\s_-]?code/i, /authenticat(?:or|ion)[\s_-]?code/i, /c[oó]digo[\s_-]?de[\s_-]?verificaci[oó]n/i];
const OTP_INPUT_TYPES: ReadonlySet<string> = new Set(["text", "tel", "number"]);

/** The facts about a field that say whether it takes a one-time code. */
export interface OtpFieldFacts {
  tag?: string | undefined;
  inputType?: string | undefined;
  autocomplete?: string | undefined;
  nameAttr?: string | undefined;
  idAttr?: string | undefined;
  /** Accessible name. */
  name?: string | undefined;
  inputMode?: string | undefined;
  maxLength?: number | undefined;
}

/**
 * R20 / R24: a field a TOTP code may be typed into. It is an `<input>` of
 * type text, tel or number (or none), never a password or a textarea, and it
 * says so: `autocomplete="one-time-code"`, an OTP-like name, id or label, or
 * a short numeric field (inputmode numeric, maxlength 4 to 10).
 */
export function isOneTimeCodeField(field: OtpFieldFacts): boolean {
  if ((field.tag ?? "input").toLowerCase() !== "input") return false;
  const type = field.inputType?.toLowerCase();
  if (type !== undefined && !OTP_INPUT_TYPES.has(type)) return false;
  if (field.autocomplete?.toLowerCase().split(/\s+/).includes("one-time-code")) return true;
  const hints = [field.nameAttr, field.idAttr, field.name].filter((h): h is string => typeof h === "string" && h.length > 0);
  if (hints.some((h) => OTP_HINTS.some((p) => p.test(h.replace(/_/g, " "))))) return true;
  return field.inputMode?.toLowerCase() === "numeric" && field.maxLength !== undefined && field.maxLength >= 4 && field.maxLength <= 10;
}
