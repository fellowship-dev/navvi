import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main, type CliIo } from "../bin/cli.js";
import type { Answer, Chooser, ChooserUsage, Question } from "../src/chooser/chooser.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { runCrawl } from "../src/replay/crawler.js";
import { SCRAPER_VERSION, cacheKey, type CompiledScraper, type TraceStep } from "../src/scraper/schema.js";
import { ScraperStore } from "../src/scraper/store.js";
import { BUNDLE_PREFIX, SecretsBundleError, gatherSecrets, openBundle, sealBundle, type SealRunner } from "../src/secrets/bundle.js";
import { MissingSecretError, resolveSecrets } from "../src/secrets/resolve.js";
import { groupByTemplate } from "../src/template/index.js";
import { F, datasetItems, fixtureInput, makeActor, makeDeps } from "./helpers.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U15 (R19, KTD7): one sealed bundle in `NAVVI_SECRETS`, opened with
 * `NAVVI_SECRETS_PASSPHRASE`, in-process with node:crypto on any OS.
 */

const PASSPHRASE = "correct horse battery staple";
const VALUES = { password: "hunter2-bundle", username: "maxine@example.com", "totp:isc2": "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" };

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "navvi-bundle-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sealBundle / openBundle", () => {
  it("round-trips every name, and the armored text carries no value", async () => {
    const armored = await sealBundle(VALUES, PASSPHRASE);
    expect(armored.startsWith(BUNDLE_PREFIX)).toBe(true);
    for (const value of Object.values(VALUES)) expect(armored).not.toContain(value);
    const opened = await openBundle(armored, PASSPHRASE);
    expect(Object.fromEntries(opened)).toEqual(VALUES);
  });

  it("two seals of the same secrets differ (fresh salt and iv)", async () => {
    expect(await sealBundle(VALUES, PASSPHRASE)).not.toBe(await sealBundle(VALUES, PASSPHRASE));
  });

  it("a wrong passphrase fails with a clear error naming no value", async () => {
    const armored = await sealBundle(VALUES, PASSPHRASE);
    const error = await openBundle(armored, "wrong-guess-99").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretsBundleError);
    expect((error as SecretsBundleError).status).toBe("configuration_error");
    expect(String((error as Error).message)).toMatch(/passphrase/i);
    for (const value of [...Object.values(VALUES), PASSPHRASE, "wrong-guess-99"]) expect(String((error as Error).message)).not.toContain(value);
  });

  it("tampered ciphertext fails authentication", async () => {
    const armored = await sealBundle(VALUES, PASSPHRASE);
    const body = JSON.parse(Buffer.from(armored.slice(BUNDLE_PREFIX.length), "base64url").toString("utf8")) as { ct: string; N: number };
    const ct = Buffer.from(body.ct, "base64");
    ct[0] = ct[0]! ^ 0x01;
    const tampered = BUNDLE_PREFIX + Buffer.from(JSON.stringify({ ...body, ct: ct.toString("base64") })).toString("base64url");
    await expect(openBundle(tampered, PASSPHRASE)).rejects.toThrow(/altered|passphrase/i);
    // The header is authenticated too: a changed cost parameter is refused, not obeyed.
    const header = BUNDLE_PREFIX + Buffer.from(JSON.stringify({ ...body, N: body.N * 2 })).toString("base64url");
    await expect(openBundle(header, PASSPHRASE)).rejects.toBeInstanceOf(SecretsBundleError);
  });

  it("refuses a bundle of another version and text that is no bundle", async () => {
    const armored = await sealBundle(VALUES, PASSPHRASE);
    await expect(openBundle(armored.replace(/^navvi1\./, "navvi2."), PASSPHRASE)).rejects.toThrow(/version 2/);
    await expect(openBundle("hunter2-bundle", PASSPHRASE)).rejects.toThrow(/not a sealed navvi bundle/);
    const error = await openBundle("hunter2-bundle", PASSPHRASE).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain("hunter2-bundle");
  });

  it("refuses names a placeholder could never reach", async () => {
    await expect(sealBundle({ "bad name": "x" }, PASSPHRASE)).rejects.toThrow(/bad name/);
  });
});

describe("resolveSecrets with a bundle", () => {
  it("resolves after NAVVI_SECRET_* and before the keychain and Apify", async () => {
    const armored = await sealBundle({ password: "from-bundle", other: "bundle-other" }, PASSPHRASE);
    const runCommand = vi.fn(async () => "from-keychain");
    const apify = vi.fn(async () => "from-apify");
    const out = await resolveSecrets(["password", "other", "kc"], {
      env: { NAVVI_SECRETS: armored, NAVVI_SECRETS_PASSPHRASE: PASSPHRASE, NAVVI_SECRET_PASSWORD: "env-wins" },
      platform: "darwin",
      runCommand,
      apify,
    });
    expect(out.get("password")?.reveal()).toBe("env-wins");
    expect(out.get("other")?.reveal()).toBe("bundle-other");
    expect(out.get("kc")?.reveal()).toBe("from-keychain");
    // `other` never asked the keychain: the bundle answered first.
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(apify).not.toHaveBeenCalled();
    expect(String(out.get("other"))).toBe("[secret]");
  });

  it("opens the bundle once per resolution however many names it answers", async () => {
    const armored = await sealBundle({ a: "aaa-value", b: "bbb-value" }, PASSPHRASE);
    const open = vi.fn(openBundle);
    const out = await resolveSecrets(["a", "b"], { env: { NAVVI_SECRETS: armored, NAVVI_SECRETS_PASSPHRASE: PASSPHRASE }, platform: "linux", openBundle: open });
    expect(out.get("b")?.reveal()).toBe("bbb-value");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not open the bundle when env answers every name", async () => {
    const open = vi.fn(openBundle);
    await resolveSecrets(["a"], { env: { NAVVI_SECRETS: "garbage", NAVVI_SECRET_A: "x" }, platform: "linux", openBundle: open });
    expect(open).not.toHaveBeenCalled();
  });

  it("a bundle without its passphrase, or with the wrong one, is a configuration error naming no value", async () => {
    const armored = await sealBundle({ password: "hunter2-bundle" }, PASSPHRASE);
    await expect(resolveSecrets(["password"], { env: { NAVVI_SECRETS: armored }, platform: "linux" })).rejects.toThrow(/NAVVI_SECRETS_PASSPHRASE/);
    const error = await resolveSecrets(["password"], { env: { NAVVI_SECRETS: armored, NAVVI_SECRETS_PASSPHRASE: "wrong-passphrase" }, platform: "linux" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: "configuration_error" });
    expect(String(error)).not.toContain("hunter2-bundle");
    expect(String(error)).not.toContain("wrong-passphrase");
  });

  it("a name the bundle lacks falls through and the miss names the bundle", async () => {
    const armored = await sealBundle({ other: "x-value" }, PASSPHRASE);
    const promise = resolveSecrets(["password"], { env: { NAVVI_SECRETS: armored, NAVVI_SECRETS_PASSPHRASE: PASSPHRASE }, platform: "linux" });
    await expect(promise).rejects.toBeInstanceOf(MissingSecretError);
    await expect(promise).rejects.toThrow(/NAVVI_SECRETS/);
  });
});

describe("gatherSecrets (seal-time sources)", () => {
  const entry = "hunter2-pw\nusername: maxine@example.com\nurl: https://example.com/login\ntotp: otpauth://totp/x?secret=JBSWY3DPEHPK3PXP\n";
  const gopass: SealRunner = async (command, args) => {
    expect(command).toBe("gopass");
    return args.includes("-o") ? "hunter2-pw" : entry;
  };

  it("reads a gopass entry's password, username and totp lines", async () => {
    const { secrets, problems } = await gatherSecrets([{ name: "site", from: "gopass:web/site" }], { env: {}, cwd: dir, run: gopass });
    expect(problems).toEqual([]);
    expect(secrets).toEqual({ site: "hunter2-pw", site_username: "maxine@example.com", "totp:site": "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" });
  });

  it("reads env and a secrets file", async () => {
    const file = join(dir, "s.json");
    writeFileSync(file, JSON.stringify({ a: "file-a", "totp:b": "JBSWY3DPEHPK3PXP" }));
    const { secrets } = await gatherSecrets([{ name: "e", from: "env:MY_VAR" }, { name: undefined, from: `file:${file}` }], { env: { MY_VAR: "env-value" }, cwd: dir });
    expect(secrets).toEqual({ e: "env-value", a: "file-a", "totp:b": "JBSWY3DPEHPK3PXP" });
  });

  it("a missing gopass binary names the entry, and the next source for the name still answers", async () => {
    const missing: SealRunner = async () => {
      throw Object.assign(new Error("spawn gopass ENOENT"), { code: "ENOENT" });
    };
    const { secrets, problems } = await gatherSecrets(
      [
        { name: "pw", from: "gopass:web/site" },
        { name: "pw", from: "env:PW" },
      ],
      { env: { PW: "env-pw" }, cwd: dir, run: missing },
    );
    expect(secrets).toEqual({ pw: "env-pw" });
    expect(problems.join("\n")).toMatch(/gopass:web\/site/);
    expect(problems.join("\n")).toMatch(/not installed/);
  });
});

// ---------------------------------------------------------------- CLI

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, done: () => void): void {
    this.text += chunk.toString();
    done();
  }
}
function io(env: NodeJS.ProcessEnv): CliIo & { stdout: Capture; stderr: Capture } {
  return { stdin: null, stdout: new Capture(), stderr: new Capture(), env, cwd: dir } as CliIo & { stdout: Capture; stderr: Capture };
}

describe("navvi secrets seal|list", () => {
  it("seals from env, prints only the bundle, and list prints names only", async () => {
    const env = { NAVVI_SECRETS_PASSPHRASE: PASSPHRASE, SITE_PW: "hunter2-cli" };
    const sealIo = io(env);
    expect(await main(["secrets", "seal", "--name", "password", "--from", "env:SITE_PW"], sealIo)).toBe(0);
    const armored = sealIo.stdout.text.trim();
    expect(armored.startsWith(BUNDLE_PREFIX)).toBe(true);
    expect(sealIo.stdout.text + sealIo.stderr.text).not.toContain("hunter2-cli");
    expect(sealIo.stderr.text).toContain("password");

    const listIo = io({ NAVVI_SECRETS: armored, NAVVI_SECRETS_PASSPHRASE: PASSPHRASE });
    expect(await main(["secrets", "list"], listIo)).toBe(0);
    expect(listIo.stdout.text).toBe("password\n");

    const out = await resolveSecrets(["password"], { env: { NAVVI_SECRETS: armored, NAVVI_SECRETS_PASSPHRASE: PASSPHRASE }, platform: "linux" });
    expect(out.get("password")?.reveal()).toBe("hunter2-cli");
  });

  it("--out writes the bundle with mode 0600 and nothing on stdout", async () => {
    const file = join(dir, "bundle.txt");
    const sealIo = io({ NAVVI_SECRETS_PASSPHRASE: PASSPHRASE, SITE_PW: "hunter2-cli" });
    expect(await main(["secrets", "seal", "--name", "password", "--from", "env:SITE_PW", "--out", file], sealIo)).toBe(0);
    expect(sealIo.stdout.text).toBe("");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const listIo = io({ NAVVI_SECRETS_PASSPHRASE: PASSPHRASE });
    expect(await main(["secrets", "list", "--in", file], listIo)).toBe(0);
    expect(listIo.stdout.text).toBe("password\n");
    expect(readFileSync(file, "utf8")).not.toContain("hunter2-cli");
  });

  it("refuses to seal without a passphrase, and a wrong one on list exits 2 with no value", async () => {
    const sealIo = io({ SITE_PW: "hunter2-cli" });
    expect(await main(["secrets", "seal", "--name", "password", "--from", "env:SITE_PW"], sealIo)).toBe(2);
    expect(sealIo.stderr.text).toMatch(/NAVVI_SECRETS_PASSPHRASE/);
    const armored = await sealBundle({ password: "hunter2-cli" }, PASSPHRASE);
    const listIo = io({ NAVVI_SECRETS: armored, NAVVI_SECRETS_PASSPHRASE: "wrong passphrase!" });
    expect(await main(["secrets", "list"], listIo)).toBe(2);
    expect(listIo.stderr.text + listIo.stdout.text).not.toContain("hunter2-cli");
  });

  it("a name no source answers fails the seal naming the name and why", async () => {
    const sealIo = io({ NAVVI_SECRETS_PASSPHRASE: PASSPHRASE });
    expect(await main(["secrets", "seal", "--name", "password", "--from", "env:NOPE"], sealIo)).toBe(2);
    expect(sealIo.stderr.text).toMatch(/password/);
    expect(sealIo.stderr.text).toMatch(/env:NOPE/);
    expect(sealIo.stdout.text).toBe("");
  });
});

// ---------------------------------------------------------------- R39 through a run

class SpyChooser implements Chooser {
  readonly name = "recorded" as const;
  readonly batches: Question[][] = [];
  private readonly inner: RecordedChooser;
  constructor(fixture: string) {
    this.inner = new RecordedChooser({ fixture });
  }
  async ask(batch: Question[]): Promise<Answer[]> {
    this.batches.push(batch);
    return this.inner.ask(batch);
  }
  usage(): ChooserUsage {
    return this.inner.usage();
  }
}

describe("a bundle secret never leaves the run (R39)", () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(async () => {
    await server?.close();
  });
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    server.switchLogin("normal");
  });

  it("a login healed through the chooser from a bundle keeps the value out of questions, logs, the stored scraper and the summary", async () => {
    const SECRET = "hunter2-sealed-value";
    const armored = await sealBundle({ password: SECRET }, PASSPHRASE);
    const actor = makeActor(dir);
    const store = await ScraperStore.open({ actor });
    const loginUrls = [`${server.baseUrl}/login/`];
    const templateKey = [...groupByTemplate(loginUrls).keys()][0]!;
    const key = { templateKey, cacheKey: cacheKey(templateKey, { fields: ["order", "total"], profile: "local" }) };
    const trace: TraceStep[] = [
      { op: "type", text: "max@example.com", alternatives: [{ role: "textbox", name: "Email", exact: true }] },
      { op: "type", secret: "password", alternatives: [{ role: "textbox", name: "Password", exact: true }] },
      { op: "click", alternatives: [{ role: "button", name: "Log in", exact: true }], target: { form: { method: "post", action: "/login" } }, expect: { role: "heading", name: "Orders" } },
    ];
    const scraper: CompiledScraper = {
      version: SCRAPER_VERSION,
      ...key,
      profile: "local",
      chooser: "agent",
      mode: "list",
      entry: { mode: "trace", url: loginUrls[0]! },
      trace,
      item: { anchorSelector: "ul.orders > li.order", span: 1 },
      fields: {
        order: { alternatives: [{ selector: "a", fingerprint: { samples: ["Order #1001"], shape: "text" } }] },
        total: { alternatives: [{ selector: "span.total", fingerprint: { samples: ["$ 45.990"], shape: "money" } }] },
      },
      pagination: { mode: "none" },
      detail: null,
      createdAt: new Date().toISOString(),
    };
    await store.put(scraper);

    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))));
    }
    spies.push(
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        logs.push(String(chunk));
        return true;
      }),
    );

    server.switchLogin("renamed");
    const chooser = new SpyChooser("heal/login");
    const env = { NAVVI_SECRETS: armored, NAVVI_SECRETS_PASSPHRASE: PASSPHRASE };
    const summary = await runCrawl(fixtureInput({ startUrls: loginUrls, mode: "list", fields: F("order", "total"), profile: "local" }), makeDeps(dir, actor, chooser, { env, storageDir: mkdtempSync(join(dir, "st-")), maxConcurrency: 1 }));
    expect(summary.status).toBe("succeeded");
    expect(summary.items).toBe(5);
    expect(chooser.batches.length).toBeGreaterThan(0);

    const stored = await store.get(key.cacheKey);
    const rows = await datasetItems(actor);
    expect(logs.length).toBeGreaterThan(0);
    for (const [label, text] of [
      ["chooser questions", JSON.stringify(chooser.batches)],
      ["logs", logs.join("\n")],
      ["stored scraper", JSON.stringify(stored)],
      ["summary", JSON.stringify(summary)],
      ["rows", JSON.stringify(rows)],
    ] as const) {
      expect(text, label).not.toContain(SECRET);
      expect(text, label).not.toContain(PASSPHRASE);
    }
  }, 60_000);
});
