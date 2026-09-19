import { describe, expect, it } from "vitest";
import { InputSchema, isAllowedUrl, defaultChooser, defaultBrowser } from "../src/input/schema.js";
import { InvalidInputError, run } from "../src/main.js";
import type { Chooser } from "../src/chooser/chooser.js";

describe("input schema", () => {
  it("rejects an empty input naming the missing fields", () => {
    const result = InputSchema.safeParse({});
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("startUrls");
    expect(paths).toContain("mode");
    expect(paths).toContain("fields");
  });

  it("accepts prompt-only input", () => {
    expect(InputSchema.safeParse({ prompt: "get prices" }).success).toBe(true);
  });

  it("rejects maxPages 5000 and a file: start URL", () => {
    const base = { mode: "record", fields: [{ name: "price" }] };
    expect(InputSchema.safeParse({ ...base, startUrls: ["https://example.com/a"], maxPages: 5000 }).success).toBe(false);
    expect(InputSchema.safeParse({ ...base, startUrls: ["file:///etc/passwd"] }).success).toBe(false);
  });

  it("rejects unknown chooser, profile and secrets under store", () => {
    const base = { mode: "record", fields: [{ name: "price" }], startUrls: ["https://example.com/a"] };
    expect(InputSchema.safeParse({ ...base, chooser: "gpt" }).success).toBe(false);
    expect(InputSchema.safeParse({ ...base, profile: "admin" }).success).toBe(false);
    expect(InputSchema.safeParse({ ...base, secrets: { password: "x" } }).success).toBe(false);
    expect(InputSchema.safeParse({ ...base, profile: "local", secrets: { password: "x" } }).success).toBe(true);
  });
});

describe("url guard (R26)", () => {
  it.each([
    "file:///etc/passwd",
    "http://169.254.169.254/",
    "http://localhost:9222/json",
    "javascript:alert(1)",
    "http://box.internal/",
    "http://10.0.0.5/",
    "http://[::1]/",
  ])("rejects %s", (url) => {
    expect(isAllowedUrl(url)).toBe(false);
  });
  it("passes a public https host and an explicitly allowlisted private host", () => {
    expect(isAllowedUrl("https://news.ycombinator.com/")).toBe(true);
    expect(isAllowedUrl("http://127.0.0.1:4321/fixture", ["127.0.0.1"])).toBe(true);
  });
});

describe("defaults", () => {
  it("chooses the agent chooser with no keys and camoufox off-platform", () => {
    expect(defaultChooser({})).toBe("agent");
    expect(defaultChooser({ AI_GATEWAY_API_KEY: "k" })).toBe("jev");
    expect(defaultChooser({ ANTHROPIC_API_KEY: "k" })).toBe("model");
    expect(defaultBrowser({})).toBe("camoufox");
    expect(defaultBrowser({ APIFY_IS_AT_HOME: "1" })).toBe("chromium");
    expect(defaultBrowser({ NAVVI_BROWSER: "chromium" })).toBe("chromium");
  });
});

describe("run", () => {
  it("throws a validation error naming the missing field", async () => {
    await expect(run({})).rejects.toThrow(/startUrls/);
  });

  it("maps a prompt-derived input that fails validation to InvalidInputError", async () => {
    const structured = JSON.stringify({ mode: "record", description: "orders", fields: [{ name: "id" }], goal: "sign in with token: abc123" });
    const chooser: Chooser = {
      name: "agent",
      ask: async (batch) => batch.map((q) => ({ id: q.id, index: null, text: structured })),
      usage: () => ({ chooser: "agent", questions: 0, textQuestions: 0, batches: 0, inputTokens: 0, outputTokens: 0, waitMs: 0, costUsd: 0, zeroDataRetention: "not_applicable" }),
    };
    const err = await run({ prompt: "list my orders", startUrls: ["https://example.org/orders"] }, { chooser }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect((err as InvalidInputError).status).toBe("configuration_error");
    expect((err as InvalidInputError).message).toMatch(/goal/);
  });
});
