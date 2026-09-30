import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actor } from "apify";
import { MemoryStorage } from "crawlee";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChooser, RecordingChooser } from "../src/chooser/index.js";
import { run } from "../src/main.js";
import type { CrawlDeps } from "../src/replay/crawler.js";
import { BUNDLE_ENV, openBundle, PASSPHRASE_ENV } from "../src/secrets/bundle.js";

/**
 * Live gate (`npm run test:live`): NAVVI_LIVE=1 and a key. One AE1-like list
 * run against python.org/jobs per chooser whose key is present: at least 20
 * rows with title and link filled, in at most three compile batches. Excluded
 * from the default run by vitest.config.ts. The agent chooser is not measured
 * here: it needs a person or a host agent on stdio.
 */

const LIVE = process.env.NAVVI_LIVE === "1";
const env = process.env;
const available: Array<"jev" | "model"> = [];
if (env.AI_GATEWAY_API_KEY || env.TYPESAFE_API_KEY) available.push("jev");
if (env.ANTHROPIC_API_KEY) available.push("model");

const JOBS_URL = "https://www.python.org/jobs/";
const FIELDS = ["title", "company", "location", "link"].map((name) => ({ name }));

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "navvi-live-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!LIVE || available.length === 0)("live: python.org/jobs (AE1)", () => {
  for (const name of available) {
    it(`${name}: compiles the jobs list in at most three batches and extracts at least 20 rows with title and link`, async () => {
      const actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false }) });
      const chooser = new RecordingChooser(createChooser({ chooser: name, env }), { fixture: `measure/live-python.org/${name}`, env });
      const deps: CrawlDeps = { actor, chooser, env, storageDir: mkdtempSync(join(dir, "profiles-")), attended: false, maxConcurrency: 1 };
      const summary = await run({ browser: "chromium", startUrls: [JOBS_URL], mode: "list", fields: FIELDS, description: "python job listing", maxPages: 1 }, deps);
      expect(summary.status).toBe("succeeded");
      expect(summary.items).toBeGreaterThanOrEqual(20);
      expect(chooser.usage().batches).toBeLessThanOrEqual(3);
      const rows = (await (await actor.openDataset()).getData()).items as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThanOrEqual(20);
      for (const row of rows) {
        expect(row.title).not.toBeNull();
        expect(row.link).toMatch(/^https:\/\/www\.python\.org\/jobs\//);
      }
    }, 300_000);
  }
});

describe.skipIf(LIVE && available.length > 0)("live: skipped", () => {
  it.skip(`needs NAVVI_LIVE=1 and AI_GATEWAY_API_KEY, TYPESAFE_API_KEY or ANTHROPIC_API_KEY (live=${LIVE}, keys=${available.length})`, () => undefined);
});

/**
 * U16 (R21): an unattended login with a TOTP second step, from a sealed
 * bundle, against a real site (ISC2 in the plan). Nothing site-specific lives
 * here: the site, the goal and the credentials all come from the environment,
 * and the case is skipped unless they are present.
 *
 * - NAVVI_LIVE_TOTP_URL    the login page
 * - NAVVI_LIVE_TOTP_GOAL   the goal, naming the seed as {{totp:<name>}}
 * - NAVVI_LIVE_TOTP_FIELDS fields to read once logged in (comma separated; default "name")
 * - NAVVI_SECRETS / NAVVI_SECRETS_PASSPHRASE  a bundle holding `username`, `password` and `totp:<name>`
 *
 * Two runs in one process: the first navigates and records the login, the
 * second replays the stored trace, which needs a fresh code (the spent-window
 * guard waits for the next window). No run output may contain a bundle value.
 */
const TOTP_URL = env.NAVVI_LIVE_TOTP_URL;
const TOTP_GOAL = env.NAVVI_LIVE_TOTP_GOAL;
const TOTP_READY = LIVE && available.includes("jev") && !!TOTP_URL && !!TOTP_GOAL && !!env[BUNDLE_ENV] && !!env[PASSPHRASE_ENV];

describe.skipIf(!TOTP_READY)("live: TOTP login from a sealed bundle (R21)", () => {
  it("logs in with a generated code, then replays the login unattended; no secret value reaches the output", async () => {
    const values = [...(await openBundle(env[BUNDLE_ENV]!, env[PASSPHRASE_ENV]!)).values()];
    const actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false }) });
    const fields = (env.NAVVI_LIVE_TOTP_FIELDS ?? "name").split(",").map((name) => ({ name: name.trim() })).filter((f) => f.name);
    const input = { browser: "chromium" as const, startUrls: [TOTP_URL!], mode: "record" as const, profile: "local" as const, goal: TOTP_GOAL!, fields };
    const deps = (): CrawlDeps => ({ actor, chooser: createChooser({ chooser: "jev", env }), env, storageDir: mkdtempSync(join(dir, "profiles-")), attended: false, maxConcurrency: 1 });
    const first = await run(input, deps());
    expect(first.status).toBe("succeeded");
    const second = await run(input, deps());
    expect(second.status).toBe("succeeded");
    expect(second.cacheHit).toBe(true);
    const rows = (await (await actor.openDataset()).getData()).items;
    const output = JSON.stringify({ first, second, rows });
    for (const value of values) if (value.length >= 3) expect(output.includes(value)).toBe(false);
  }, 600_000);
});
