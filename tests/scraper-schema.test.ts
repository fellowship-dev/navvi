import { describe, expect, it } from "vitest";
import {
  STATUSES,
  cacheKey,
  validateScraper,
  type CompiledScraper,
} from "../src/scraper/schema.js";

export function loginFixture(): CompiledScraper {
  return {
    version: 1,
    templateKey: "example.com/jobs/*",
    cacheKey: "example.com_jobs-abc",
    profile: "local",
    chooser: "agent",
    mode: "list",
    entry: { mode: "trace", url: "https://example.com/login" },
    trace: [
      {
        op: "type",
        text: "max@example.com",
        alternatives: [{ role: "textbox", name: "Email", exact: true }],
      },
      {
        op: "type",
        secret: "password",
        alternatives: [{ role: "textbox", name: "Password", exact: true }],
      },
      {
        op: "click",
        alternatives: [
          { role: "button", name: "Sign in", exact: true },
          { role: "button", name: "Log in", exact: false },
        ],
        target: { form: { method: "post", action: "/session" } },
        expect: { role: "heading", name: "Jobs" },
      },
    ],
    item: { anchorSelector: "li.job", span: 1 },
    fields: {
      title: {
        alternatives: [
          { selector: "h2 a", fingerprint: { samples: ["Python dev"], shape: "text" } },
        ],
      },
      url: {
        alternatives: [
          { selector: "h2 a", attr: "href", fingerprint: { samples: ["https://example.com/j/1"], shape: "url" } },
        ],
      },
    },
    pagination: { mode: "next_link", locator: [{ role: "link", name: "Next", exact: true }] },
    detail: null,
    createdAt: "2026-09-19T12:00:00.000Z",
  };
}

describe("compiled scraper schema (KTD6)", () => {
  it("round-trips a valid v1 document with a login trace unchanged", () => {
    const doc = loginFixture();
    const parsed = validateScraper(JSON.parse(JSON.stringify(doc)));
    expect(parsed).toEqual(doc);
  });

  it("rejects version 2 with a clear message", () => {
    const doc = { ...loginFixture(), version: 2 };
    expect(() => validateScraper(doc)).toThrow(/version 2/);
    expect(() => validateScraper(doc)).toThrow(/expected 1/);
  });

  it("rejects a field with zero alternatives", () => {
    const doc = loginFixture();
    doc.fields.title = { alternatives: [] };
    expect(() => validateScraper(doc)).toThrow(/alternatives/);
  });

  it("rejects non-objects and unknown profiles", () => {
    expect(() => validateScraper(null)).toThrow();
    expect(() => validateScraper({ ...loginFixture(), profile: "admin" })).toThrow();
  });

  it("exports the ten status codes (R6)", () => {
    expect([...STATUSES].sort()).toEqual(
      [
        "succeeded",
        "no_items_found",
        "blocked_bot_detection",
        "blocked_login_required",
        "blocked_no_progress",
        "drift",
        "charge_limit",
        "budget_exhausted",
        "model_unavailable",
        "needs_human",
      ].sort(),
    );
  });
});

describe("cache key (KTD7)", () => {
  const base = { goal: "list jobs", description: "python jobs", fields: ["title", "url"], profile: "store" as const };

  it("changes when goal or profile changes", () => {
    const a = cacheKey("example.com/jobs/*", base);
    expect(cacheKey("example.com/jobs/*", { ...base, goal: "list gigs" })).not.toBe(a);
    expect(cacheKey("example.com/jobs/*", { ...base, profile: "local" })).not.toBe(a);
    expect(cacheKey("other.com/jobs/*", base)).not.toBe(a);
  });

  it("is insensitive to field order and starts with the template key", () => {
    const a = cacheKey("example.com/jobs/*", base);
    expect(cacheKey("example.com/jobs/*", { ...base, fields: ["url", "title"] })).toBe(a);
    expect(a.startsWith("example.com")).toBe(true);
    expect(a).toMatch(/^[a-zA-Z0-9!\-_.'()]+$/);
  });
});
