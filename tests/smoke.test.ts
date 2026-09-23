import { describe, expect, it } from "vitest";
import { InputSchema, defaultBrowser } from "../src/input/schema.js";
import { run } from "../src/main.js";

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

  // The proxy object Apify's `editor: "proxy"` emits survives validation
  // whole; before this the groups and the country were stripped and a run that
  // asked for RESIDENTIAL silently got datacenter proxies.
  it("keeps the Apify Proxy groups and country the Console emits", () => {
    const base = { mode: "record", fields: [{ name: "price" }], startUrls: ["https://example.com/a"] };
    const proxy = { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "CL" };
    const parsed = InputSchema.parse({ ...base, proxy });
    expect(parsed.proxy).toEqual(proxy);
    expect(InputSchema.parse({ ...base, proxy: { useApifyProxy: false } }).proxy).toEqual({ useApifyProxy: false });
    expect(InputSchema.parse({ ...base, proxy: { useApifyProxy: true, apifyProxyGroups: ["BUYPROXIES94952"] } }).proxy).toEqual({ useApifyProxy: true, apifyProxyGroups: ["BUYPROXIES94952"] });
  });

  it("refuses Apify Proxy combined with a caller's own proxy URLs, a bad country and groups without Apify Proxy", () => {
    const base = { mode: "record", fields: [{ name: "price" }], startUrls: ["https://example.com/a"] };
    const both = InputSchema.safeParse({ ...base, proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], proxyUrls: ["http://user:pass@127.0.0.1:8000"] } });
    expect(both.success).toBe(false);
    expect(both.success ? "" : both.error.issues.map((i) => i.message).join("\n")).toMatch(/cannot be combined/);
    expect(InputSchema.safeParse({ ...base, proxy: { useApifyProxy: true, apifyProxyCountry: "cl" } }).success).toBe(false);
    expect(InputSchema.safeParse({ ...base, proxy: { useApifyProxy: true, apifyProxyGroups: ["not a group"] } }).success).toBe(false);
    expect(InputSchema.safeParse({ ...base, proxy: { apifyProxyGroups: ["RESIDENTIAL"] } }).success).toBe(false);
    // a caller's own proxies alone stay valid
    expect(InputSchema.safeParse({ ...base, proxy: { useApifyProxy: false, proxyUrls: ["http://user:pass@127.0.0.1:8000"] } }).success).toBe(true);
  });
});

// The R26 url guard lives in `policy.test.ts :: url guard (R26)`, which runs the
// same seven URLs through `isAllowedUrl` *and* `isAllowedRequestUrl`, and proves
// the public-host / allowlisted-127.0.0.1 pass through both.

describe("defaults", () => {
  // Chooser precedence is exhaustively owned by `cli-chooser.test.ts :: keys win,
  // then claude, then codex, then agent`; only the browser default is unique here.
  it("defaults to camoufox off-platform, chromium on it and whatever NAVVI_BROWSER names", () => {
    expect(defaultBrowser({})).toBe("camoufox");
    expect(defaultBrowser({ APIFY_IS_AT_HOME: "1" })).toBe("chromium");
    expect(defaultBrowser({ NAVVI_BROWSER: "chromium" })).toBe("chromium");
  });
});

describe("run", () => {
  it("throws a validation error naming the missing field", async () => {
    await expect(run({})).rejects.toThrow(/startUrls/);
  });

  // The prompt-derived InvalidInputError path is owned by `cli.test.ts :: a prompt
  // whose structured answer fails input validation is a configuration error, not a
  // stack trace`, which runs the same fixture through the real binary and also
  // asserts the exit code and that no ZodError leaks.
});
