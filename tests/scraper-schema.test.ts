import { describe, expect, it } from "vitest";
import { cacheKey, validateScraper } from "../src/scraper/schema.js";
import { loginFixture } from "./helpers.js";

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
