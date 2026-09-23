import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTOR_ONLY_KEYS, actorInput } from "../src/main.js";
import { BaseInputSchema, LIMITS, parseInput } from "../src/input/schema.js";

/**
 * U2 / R3, master plan R21, R22, R26, R28, KTD13, U14: the actor input schema
 * agrees with the Zod input, restricts the published surface (store profile,
 * jev or model deciders, a model writer since the image has no CLI), carries
 * the limits, and its prefill is a valid run.
 */

const ROOT = join(__dirname, "..");
type Property = { type: string; enum?: string[]; default?: unknown; prefill?: unknown; isSecret?: boolean; maximum?: number; minimum?: number; pattern?: string; resourceType?: string; editor?: string; sectionCaption?: string };
const schema = JSON.parse(readFileSync(join(ROOT, ".actor", "input_schema.json"), "utf8")) as { properties: Record<string, Property> };
const actorJson = JSON.parse(readFileSync(join(ROOT, ".actor", "actor.json"), "utf8")) as Record<string, unknown>;
const datasetSchema = JSON.parse(readFileSync(join(ROOT, ".actor", "dataset_schema.json"), "utf8")) as { fields: { properties: Record<string, unknown> }; views: Record<string, unknown> };

const pick = (key: "prefill" | "default"): Record<string, unknown> =>
  Object.fromEntries(Object.entries(schema.properties).filter(([, p]) => p[key] !== undefined).map(([name, p]) => [name, p[key]]));

describe(".actor/input_schema.json", () => {
  it("every property is a run input key or an actor-only key, and every section has a caption", () => {
    const known = new Set([...Object.keys(BaseInputSchema.shape), ...ACTOR_ONLY_KEYS]);
    for (const name of Object.keys(schema.properties)) expect(known.has(name), name).toBe(true);
    const captions = Object.values(schema.properties).map((p) => p.sectionCaption).filter(Boolean);
    expect(captions).toEqual(["Prompt", "Target", "What to extract", "Navigation", "Crawl limits", "Browser and proxy", "Your key", "Advanced", "Debug: browser retirement (U16)"]);
  });

  it("restricts the published surface: profile store only, chooser jev or model, the caller keys secret, scriptId patterned, the store resource-typed", () => {
    expect(schema.properties.profile?.enum).toEqual(["store"]);
    expect(schema.properties.profile?.enum).not.toContain("local");
    expect(schema.properties.chooser?.enum).toEqual(["jev", "model"]);
    expect(schema.properties.chooser?.enum).not.toContain("agent");
    // U14: the two sources are restricted the same way, and the platform has no CLI installed, so it cannot write on a subscription.
    expect(schema.properties.decider?.enum).toEqual(["jev", "model"]);
    expect(schema.properties.decider?.enum).not.toContain("agent");
    expect(schema.properties.writer?.enum).toEqual(["model"]);
    for (const name of ["jev", "agent", "claude", "codex"]) expect(schema.properties.writer?.enum).not.toContain(name);
    expect(schema.properties.deciderTransport?.enum).toEqual(["gateway", "typesafe"]);
    for (const key of ["typesafeApiKey", "gatewayApiKey", "anthropicApiKey"]) expect(schema.properties[key]?.isSecret, key).toBe(true);
    expect(schema.properties.scriptId?.pattern).toBeTruthy();
    expect(new RegExp(schema.properties.scriptId!.pattern!).test("scraper-cache/python.org-jobs-abc")).toBe(true);
    expect(new RegExp(schema.properties.scriptId!.pattern!).test("a/b/c")).toBe(false);
    expect(schema.properties.scraperStore?.resourceType).toBe("keyValueStore");
    expect(schema.properties.startUrls?.editor).toBe("requestListSources");
  });

  it("carries the R26 and R28 limits as maximum and pattern", () => {
    expect(schema.properties.maxPages?.maximum).toBe(LIMITS.maxPages);
    expect(schema.properties.maxItems?.maximum).toBe(LIMITS.maxItems);
    expect(schema.properties.maxPages?.minimum).toBe(1);
    expect(schema.properties.maxItems?.minimum).toBe(1);
    expect(schema.properties.fields?.type).toBe("array");
  });

  // The prefill is what Apify's daily Store test runs: it must produce dataset
  // rows in under five minutes, unattended, every day, or the actor is labelled
  // under maintenance after 3 failures and deprecated after 30. Hacker News's
  // front page is never empty and needs no navigation goal.
  it("the prefill is a valid run: the Hacker News front page, list mode, one page, typed fields (R22, KTD13)", () => {
    const { input } = actorInput(pick("prefill"), {});
    const parsed = parseInput(input);
    expect(parsed.startUrls).toEqual(["https://news.ycombinator.com/"]);
    expect(parsed.mode).toBe("list");
    expect(parsed.maxPages).toBe(1);
    expect(parsed.fields?.map((f) => f.name)).toEqual(["title", "link", "points", "comments"]);
    expect(parsed.fields?.find((f) => f.name === "link")?.type).toBe("url");
    expect(parsed.fields?.find((f) => f.name === "points")?.type).toBe("integer");
    expect(parsed.fields?.find((f) => f.name === "comments")?.type).toBe("integer");
    // no goal: the daily test must not spend navigation steps or model calls it does not need
    expect(parsed.goal).toBeUndefined();
    expect(parsed.profile).toBe("store");
    expect(parsed.proxy).toEqual({ useApifyProxy: false });
  });

  it("the schema defaults match the Zod defaults: feeding them changes nothing", () => {
    const minimal = { startUrls: ["https://example.org/"], mode: "record", fields: [{ name: "x" }] };
    const withDefaults = actorInput({ ...pick("default"), ...minimal }, {}).input;
    expect(parseInput(withDefaults)).toEqual(parseInput(minimal));
  });
});

describe(".actor/actor.json and dataset schema", () => {
  it("declares the specification, both schemas, the Chromium default and memory for a browser", () => {
    expect(actorJson.actorSpecification).toBe(1);
    expect(actorJson.input).toBe("./input_schema.json");
    expect(actorJson.storages).toEqual({ dataset: "./dataset_schema.json" });
    expect(actorJson.dockerfile).toBe("./Dockerfile");
    expect(actorJson.buildTag).toBe("beta");
    expect((actorJson.environmentVariables as Record<string, string>).NAVVI_BROWSER).toBe("chromium");
    expect(actorJson.minMemoryMbytes as number).toBeGreaterThanOrEqual(1024);
    expect(datasetSchema.fields.properties._source).toBeTruthy();
    expect(Object.keys(datasetSchema.views)).toEqual(["overview"]);
  });
});

describe("actorInput (R23)", () => {
  it("moves the caller keys into the run env, strips them from the input and qualifies a bare scriptId with the store", () => {
    const raw = { startUrls: ["https://example.org/"], typesafeApiKey: " ts-key ", gatewayApiKey: "", anthropicApiKey: "ant", scraperStore: "my-store", scriptId: "python-jobs-abc" };
    const { input, env } = actorInput(raw, { TYPESAFE_API_KEY: "operator", PATH: "/bin" });
    expect(env).toEqual({ TYPESAFE_API_KEY: "ts-key", ANTHROPIC_API_KEY: "ant", PATH: "/bin" });
    expect(input).toEqual({ startUrls: ["https://example.org/"], scriptId: "my-store/python-jobs-abc" });
    for (const key of ACTOR_ONLY_KEYS) expect(key in input, key).toBe(false);
    // the raw object is untouched
    expect(raw.typesafeApiKey).toBe(" ts-key ");
  });

  it("keeps a qualified scriptId and the operator env when the input carries neither key nor store", () => {
    const { input, env } = actorInput({ scriptId: "other/key" }, { AI_GATEWAY_API_KEY: "op" });
    expect(input).toEqual({ scriptId: "other/key" });
    expect(env).toEqual({ AI_GATEWAY_API_KEY: "op" });
    expect(actorInput(null, {})).toEqual({ input: {}, env: {} });
    expect(actorInput("nope", {}).input).toEqual({});
  });
});

/**
 * U16: the browser-retirement knobs are actor-only input keys, so a task can
 * force a relaunch on one run without changing the actor's shared environment
 * -- and so a diagnostics build leaves every other run exactly as it was.
 */
describe("actorInput: the U16 retirement knobs", () => {
  it("moves them into the run env and strips them from the input", () => {
    const raw = { startUrls: ["https://example.org/"], retireBrowserAfterPages: 7, sessionMaxUsageCount: 5, sessionMaxErrorScore: 1 };
    const { input, env } = actorInput(raw, { PATH: "/bin" });
    expect(env).toEqual({
      PATH: "/bin",
      NAVVI_RETIRE_BROWSER_AFTER_PAGES: "7",
      NAVVI_SESSION_MAX_USAGE_COUNT: "5",
      NAVVI_SESSION_MAX_ERROR_SCORE: "1",
    });
    expect(input).toEqual({ startUrls: ["https://example.org/"] });
    // They must never reach the Zod input, which would reject them.
    expect(() => parseInput({ ...input, mode: "record", fields: [{ name: "title", type: "text" }] })).not.toThrow();
  });

  it("ignores a nonsensical threshold instead of crawling with it", () => {
    const { input, env } = actorInput({ startUrls: ["https://example.org/"], sessionMaxUsageCount: 0, retireBrowserAfterPages: "many" }, {});
    expect(env).toEqual({});
    expect(input).toEqual({ startUrls: ["https://example.org/"] });
  });

  // Base-env passthrough is asserted by "moves them into the run env and strips
  // them from the input" (PATH survives); "ignores a nonsensical threshold"
  // asserts that no NAVVI_* var is invented when none is set.
});
