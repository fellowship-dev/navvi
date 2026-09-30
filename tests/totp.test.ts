import { inspect } from "node:util";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, type LaunchedBrowser } from "../src/browser/launch.js";
import type { SnapshotControl } from "../src/browser/snapshot.js";
import type { Answer, Chooser, Question } from "../src/chooser/chooser.js";
import { navigate } from "../src/navigate/index.js";
import { recordStep, secretNameFor } from "../src/navigate/trace.js";
import { replayTrace, type ReplayPolicy } from "../src/replay/entry.js";
import { SCRAPER_VERSION, TraceStepSchema, type CompiledScraper, type TraceStep } from "../src/scraper/schema.js";
import { findPlaceholders, MissingSecretError, resolveSecrets, Secret } from "../src/secrets/resolve.js";
import { base32Decode, generateTotp, hotp, isOneTimeCodeField, parseTotpSeed, totpAt, type TotpClock } from "../src/secrets/totp.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U16 (R20, KTD8): `{{totp:name}}`. RFC 6238 in-process from a base32 seed or
 * an otpauth URI, generated at the step that types it, never before; a code
 * with under 5 s left waits for the next window; a TOTP secret goes only into
 * a one-time-code field; seed and code never reach a chooser, a trace or a
 * result.
 */

// RFC 6238 Appendix B: the seeds are these ASCII strings.
const SHA1_KEY = Buffer.from("12345678901234567890", "ascii");
const SHA256_KEY = Buffer.from("12345678901234567890123456789012", "ascii");
const SHA512_KEY = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii");
/** base32 of SHA1_KEY. */
const SHA1_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const VECTORS: Array<[time: number, sha1: string, sha256: string, sha512: string]> = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

/** A clock that only moves when the code under test sleeps. */
function fakeClock(startMs: number): TotpClock & { slept: number[] } {
  let now = startMs;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}

describe("RFC 6238 (KTD8)", () => {
  it("produces the Appendix B test vectors (8 digits, SHA1/SHA256/SHA512)", () => {
    for (const [time, sha1, sha256, sha512] of VECTORS) {
      expect(totpAt({ key: SHA1_KEY, digits: 8, period: 30, algorithm: "SHA1" }, time * 1000)).toBe(sha1);
      expect(totpAt({ key: SHA256_KEY, digits: 8, period: 30, algorithm: "SHA256" }, time * 1000)).toBe(sha256);
      expect(totpAt({ key: SHA512_KEY, digits: 8, period: 30, algorithm: "SHA512" }, time * 1000)).toBe(sha512);
    }
  });

  it("the 6-digit default is the same value truncated, from a bare base32 seed", () => {
    expect(base32Decode(SHA1_BASE32)).toEqual(SHA1_KEY);
    const params = parseTotpSeed(SHA1_BASE32);
    expect(params).toMatchObject({ digits: 6, period: 30, algorithm: "SHA1" });
    for (const [time, sha1] of VECTORS) expect(totpAt(params, time * 1000)).toBe(sha1.slice(-6));
    expect(hotp(SHA1_KEY, 0, 6)).toBe("755224"); // RFC 4226 Appendix D, count 0
  });

  it("parses an otpauth URI with digits, period and algorithm; lower case and spaces in the secret are accepted", () => {
    const uri = `otpauth://totp/Example:max@example.org?secret=${SHA1_BASE32.toLowerCase()}&issuer=Example&digits=8&period=60&algorithm=SHA1`;
    const params = parseTotpSeed(uri);
    expect(params).toMatchObject({ digits: 8, period: 60, algorithm: "SHA1" });
    expect(params.key).toEqual(SHA1_KEY);
    // period 60: time 59 is counter 0, like HOTP count 0 at 8 digits
    expect(totpAt(params, 59_000)).toBe(hotp(SHA1_KEY, 0, 8));
    expect(parseTotpSeed(`otpauth://totp/x?secret=${SHA1_BASE32}`)).toMatchObject({ digits: 6, period: 30, algorithm: "SHA1" });
    expect(parseTotpSeed("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ").key).toEqual(SHA1_KEY);
  });

  it("refuses what is not a TOTP seed without echoing it", () => {
    for (const bad of ["not base32 at all!", "otpauth://hotp/x?secret=GEZDGNBV&counter=1", "otpauth://totp/x?issuer=nosecret", `otpauth://totp/x?secret=${SHA1_BASE32}&digits=4`]) {
      let message = "";
      try {
        parseTotpSeed(bad);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/not a TOTP seed/);
      expect(message).not.toContain(SHA1_BASE32);
      expect(message).not.toContain("not base32 at all");
    }
  });
});

describe("generateTotp: at step time, never an expiring code", () => {
  it("with 29 s left generates at once, wrapped in a Secret", async () => {
    const clock = fakeClock(1111111111_000);
    const code = await generateTotp(new Secret(SHA1_BASE32), clock);
    expect(code).toBeInstanceOf(Secret);
    expect(code.reveal()).toBe("050471");
    expect(String(code)).toBe("[secret]");
    expect(inspect(code)).toBe("[secret]");
    expect(clock.slept).toEqual([]);
  });

  it("with 3 s left waits for the next window and returns that window's code", async () => {
    const clock = fakeClock(1111111107_000); // 1111111107 % 30 = 27: 3 s left
    const code = await generateTotp(SHA1_BASE32, clock);
    expect(clock.slept).toEqual([3_000]);
    expect(code.reveal()).toBe("050471"); // counter 37037037, not the expiring 081804
  });

  it("a second code for the same seed in the same window waits for the next window: a site refuses a spent code", async () => {
    const clock = fakeClock(1111111111_000);
    expect((await generateTotp(SHA1_BASE32, clock)).reveal()).toBe("050471");
    const again = await generateTotp(SHA1_BASE32, clock);
    expect(clock.slept).toEqual([29_000]);
    expect(again.reveal()).toBe(totpAt(parseTotpSeed(SHA1_BASE32), 1111111140_000));
    expect(again.reveal()).not.toBe("050471");
  });
});

describe("{{totp:name}} resolution (R20)", () => {
  it("finds totp placeholders in text as totp:<name>", () => {
    expect(findPlaceholders("log in with {{secret:password}} and {{totp:acme}}")).toEqual(["password", "totp:acme"]);
  });

  it("resolves a seed from NAVVI_TOTP_<NAME>, the bundle, or Apify's SECRET_TOTP_<NAME> source", async () => {
    const fromEnv = await resolveSecrets(["totp:acme"], { env: { NAVVI_TOTP_ACME: SHA1_BASE32 }, platform: "linux" });
    expect(fromEnv.get("totp:acme")?.reveal()).toBe(SHA1_BASE32);
    const fromBundle = await resolveSecrets(["totp:acme"], {
      env: { NAVVI_SECRETS: "navvi1.x", NAVVI_SECRETS_PASSPHRASE: "p" },
      platform: "linux",
      openBundle: async () => new Map([["totp:acme", `otpauth://totp/Acme?secret=${SHA1_BASE32}`]]),
    });
    expect(fromBundle.get("totp:acme")?.reveal()).toContain("otpauth://");
    const asked: string[] = [];
    const fromApify = await resolveSecrets(["totp:acme"], { env: {}, platform: "linux", apify: async (name) => (asked.push(name), SHA1_BASE32) });
    expect(fromApify.get("totp:acme")?.reveal()).toBe(SHA1_BASE32);
    expect(asked).toEqual(["totp:acme"]);
  });

  it("a missing seed fails before the browser with blocked_login_required naming {{totp:name}}", async () => {
    const promise = resolveSecrets(["totp:acme"], { env: {}, platform: "linux" });
    await expect(promise).rejects.toBeInstanceOf(MissingSecretError);
    await expect(promise).rejects.toMatchObject({ status: "blocked_login_required", placeholder: "totp:acme" });
    await expect(promise).rejects.toThrow(/\{\{totp:acme\}\}.*NAVVI_TOTP_ACME/);
  });

  it("a seed that is not TOTP fails up front the same way, without the value", async () => {
    const promise = resolveSecrets(["totp:acme"], { env: { NAVVI_TOTP_ACME: "hunter2-not-a-seed!" }, platform: "linux" });
    await expect(promise).rejects.toMatchObject({ status: "blocked_login_required", placeholder: "totp:acme" });
    await expect(promise).rejects.toThrow(/\{\{totp:acme\}\}.*not a TOTP seed/);
    await expect(promise).rejects.not.toThrow(/hunter2/);
  });
});

const control = (over: Partial<SnapshotControl>): SnapshotControl => ({
  id: "c1",
  role: "textbox",
  name: "Field",
  tag: "input",
  value: "",
  disabled: false,
  visible: true,
  clickable: true,
  scope: "",
  form: null,
  secretCapable: false,
  ...over,
});

describe("recording: a one-time-code field is a totp placeholder", () => {
  it("names an autocomplete=one-time-code or clearly-OTP field totp:<the run's totp name>, and never a password field", () => {
    const names = ["username", "password", "totp:acme"];
    expect(secretNameFor(control({ inputType: "text", name: "Verification code", autocomplete: "one-time-code" }), names)).toBe("totp:acme");
    expect(secretNameFor(control({ inputType: "tel", name: "Code", nameAttr: "otp_code" }), names)).toBe("totp:acme");
    expect(secretNameFor(control({ inputType: "password", name: "One-time password", secretCapable: true, autocomplete: "one-time-code" }), names)).toBe("password");
    expect(secretNameFor(control({ inputType: "email", name: "Email", autocomplete: "username" }), names)).toBe("username");
    // no seed in the run: the field still names a totp placeholder, which then fails as missing
    expect(secretNameFor(control({ inputType: "text", name: "Code", autocomplete: "one-time-code" }))).toBe("totp:otp");
    const step = recordStep({ op: "type", control: control({ name: "Verification code", autocomplete: "one-time-code" }), secret: "totp:acme" });
    expect(TraceStepSchema.parse(step)).toMatchObject({ op: "type", secret: "totp:acme" });
    expect(findPlaceholders({ trace: [step] } as unknown as CompiledScraper)).toEqual(["totp:acme"]);
  });

  it("isOneTimeCodeField: an input that says it takes a code, never a password, textarea or plain text field", () => {
    expect(isOneTimeCodeField({ tag: "input", inputType: "text", autocomplete: "one-time-code" })).toBe(true);
    expect(isOneTimeCodeField({ tag: "input", inputType: "text", inputMode: "numeric", maxLength: 6 })).toBe(true);
    expect(isOneTimeCodeField({ tag: "input", name: "Authenticator code" })).toBe(true);
    expect(isOneTimeCodeField({ tag: "input", inputType: "password", autocomplete: "one-time-code" })).toBe(false);
    expect(isOneTimeCodeField({ tag: "textarea", name: "Verification code" })).toBe(false);
    expect(isOneTimeCodeField({ tag: "input", inputType: "text", name: "Note" })).toBe(false);
    expect(isOneTimeCodeField({ tag: "input", inputType: "email", autocomplete: "one-time-code" })).toBe(false);
  });
});

describe("a recorded two-step login replays with a TOTP code (fixture server)", () => {
  let server: FixtureServer;
  let browser: LaunchedBrowser;
  const PASSWORD = "hunter2-otp-fixture";
  const USERNAME = "maxine@example.com";

  beforeAll(async () => {
    server = await startFixtureServer();
    browser = await launch({ browser: "chromium", headed: false });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function withPage<T>(path: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await browser.context.newPage();
    try {
      await page.goto(`${server.baseUrl}${path}`);
      return await fn(page);
    } finally {
      await page.close();
    }
  }

  const policy = (): ReplayPolicy => ({ profile: "local", startUrls: [`${server.baseUrl}/`], allowedDomains: [], allowMutations: [] });
  const scraper = (trace: TraceStep[]): CompiledScraper => ({
    version: SCRAPER_VERSION,
    templateKey: "t",
    cacheKey: "c",
    profile: "local",
    chooser: "agent",
    mode: "list",
    entry: { mode: "trace", url: `${server.baseUrl}/login-otp/` },
    trace,
    pagination: { mode: "none" },
    detail: null,
    createdAt: new Date().toISOString(),
    fields: {},
  });
  const code = { role: "textbox", name: "Verification code", exact: true };
  const note = { role: "textbox", name: "Note", exact: true };
  const LOGIN_TRACE: TraceStep[] = [
    { op: "type", secret: "username", alternatives: [{ role: "textbox", name: "Email", exact: true }] },
    { op: "type", secret: "password", alternatives: [{ role: "textbox", name: "Password", exact: true }] },
    { op: "click", alternatives: [{ role: "button", name: "Log in", exact: true }], target: { form: { method: "post", action: "/login-otp" } }, expect: { role: "heading", name: "Two-step verification" } },
    { op: "type", secret: "totp:acme", alternatives: [code] },
    { op: "click", alternatives: [{ role: "button", name: "Verify", exact: true }], target: { form: { method: "post", action: "/login-otp/verify" } }, expect: { role: "heading", name: "Your account" } },
  ];
  const secrets = () =>
    new Map([
      ["username", new Secret(USERNAME)],
      ["password", new Secret(PASSWORD)],
      ["totp:acme", new Secret(`otpauth://totp/Acme:maxine?secret=${SHA1_BASE32}&issuer=Acme`)],
    ]);

  it("fills the code of the fixed clock's window at the OTP step and reaches the account", async () => {
    server.expectOtp("050471");
    const clock = fakeClock(1111111111_000);
    await withPage("/login-otp/", async (page) => {
      const result = await replayTrace(page, scraper(LOGIN_TRACE), { secrets: secrets(), policy: policy(), clock });
      expect(result).toEqual({ ok: true, steps: 5 });
      expect(server.lastOtp()).toBe("050471");
      expect(new URL(page.url()).pathname).toBe("/login-otp/account");
    });
  });

  it("refuses a totp secret for a password field and for a free-text field, typing nothing", async () => {
    server.expectOtp(null);
    await withPage("/login-otp/", async (page) => {
      const result = await replayTrace(page, scraper([{ op: "type", secret: "totp:acme", alternatives: [{ role: "textbox", name: "Password", exact: true }] }]), { secrets: secrets(), policy: policy(), clock: fakeClock(1111111111_000) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/\{\{totp:acme\}\}.*one-time-code/);
      expect(await page.locator("#password").inputValue()).toBe("");
    });
    await withPage("/login-otp/verify", async (page) => {
      const result = await replayTrace(page, scraper([{ op: "type", secret: "totp:acme", alternatives: [note] }]), { secrets: secrets(), policy: policy(), clock: fakeClock(1111111111_000) });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/one-time-code/);
        expect(result.reason).not.toContain("050471");
      }
      expect(await page.locator("#note").inputValue()).toBe("");
    });
  });

  it("records the OTP step as totp:<name> while navigating, and no code or seed reaches the chooser or the trace", async () => {
    server.expectOtp("050471");
    const batches: Question[][] = [];
    let typedCode = false;
    const chooser: Chooser = {
      name: "agent",
      usage: () => ({ chooser: "agent", questions: 0, textQuestions: 0, batches: batches.length, inputTokens: 0, outputTokens: 0, waitMs: 0, costUsd: 0, zeroDataRetention: "not_applicable" }),
      async ask(batch: Question[]): Promise<Answer[]> {
        batches.push(batch);
        const state = batch[0]?.state ?? "";
        const want = state.includes("Your account") ? "DONE" : typedCode ? "CLICK" : "TYPE_TEXT";
        return batch.map((q): Answer => {
          if (q.id.endsWith(".done")) return { id: q.id, index: 1, probability: 1 };
          const options = q.options ?? [];
          if (q.id.endsWith(".op")) return { id: q.id, index: options.findIndex((o) => o.startsWith(`${want}:`)) };
          if (q.id.endsWith(".type")) {
            const index = options.findIndex((o) => o.includes("Verification code"));
            if (want === "TYPE_TEXT") typedCode = true;
            return { id: q.id, index };
          }
          if (q.id.endsWith(".click")) return { id: q.id, index: options.findIndex((o) => o.includes("Verify")) };
          return { id: q.id, index: null };
        });
      },
    };
    const seed = `otpauth://totp/Acme:maxine?secret=${SHA1_BASE32}&issuer=Acme`;
    await withPage("/login-otp/verify", async (page) => {
      const result = await navigate(page, {
        goal: "enter the {{totp:acme}} code and open my account",
        chooser,
        profile: "local",
        startUrls: [`${server.baseUrl}/`],
        settle: { idleMs: 100, maxMs: 1_500 },
        secrets: { "totp:acme": seed },
        clock: fakeClock(1111111111_000),
      });
      expect(result.status).toBe("DONE");
      expect(server.lastOtp()).toBe("050471");
      const typed = result.trace.find((s) => s.op === "type");
      expect(typed).toMatchObject({ op: "type", secret: "totp:acme", alternatives: [code] });
      expect(typed).not.toHaveProperty("text");
      const everything = JSON.stringify({ batches, result });
      expect(everything).not.toContain("050471");
      expect(everything).not.toContain(SHA1_BASE32);
      expect(everything).not.toContain("otpauth://");
    });
  });
});
