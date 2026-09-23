import { describe, expect, it } from "vitest";
import { recordCanary, type CanaryFingerprint } from "../src/investigate/blocked.js";
import { CanarySchema, cacheKey, canaryOrigin, validateScraper, type Canary, type CompiledScraper } from "../src/scraper/schema.js";
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

/**
 * U9c: the canary travels on the document.
 *
 * It was filed beside the scraper in the cache store for one day (da8ba47,
 * which said so and called it a stopgap). A side-car falls out of step: a
 * `--force-recompile` that fails leaves yesterday's canary next to today's
 * scraper, and one key-value store is then two documents disagreeing about
 * one site.
 */
describe("the canary on a compiled scraper", () => {
  const page = "<html><head><title>Paracetamol</title></head><body><nav>Inicio Productos Farmacia Cuenta Ayuda</nav>"
    + "<h1>Paracetamol 500 mg</h1><p>Laboratorio Chile</p><footer>Farmacia Farmacia contacto ayuda despacho retiro</footer></body></html>";
  const fingerprint = (): CanaryFingerprint => recordCanary({ url: "https://example.com/p/1", status: 200, body: page }, { now: new Date("2026-09-23") });

  it("round-trips a recorded fingerprint through the document unchanged", () => {
    const canary = fingerprint();
    const doc = validateScraper({ ...loginFixture(), canary });
    expect(doc.canary).toEqual(canary);
    // Through JSON, the way it actually reaches a run months later.
    expect(validateScraper(JSON.parse(JSON.stringify(doc))).canary).toEqual(canary);
  });

  it("is the same shape `investigate/blocked.ts` records, checked both ways", () => {
    // A compile-time pin on the duplication the layer rule forces: the two
    // spellings must stay mutually assignable, and a real recording must parse.
    const fromBlocked: Canary = fingerprint();
    const toBlocked: CanaryFingerprint = fromBlocked;
    expect(CanarySchema.safeParse(toBlocked).success).toBe(true);
  });

  it("refuses a fingerprint that is not one, rather than storing a shape nothing can check", () => {
    expect(() => validateScraper({ ...loginFixture(), canary: { ...fingerprint(), words: [1, 2] } })).toThrow(/canary/);
    expect(() => validateScraper({ ...loginFixture(), canary: { ...fingerprint(), declaredProduct: "yes" } })).toThrow(/canary/);
    expect(() => validateScraper({ ...loginFixture(), canary: "none" })).toThrow(/canary/);
  });

  /**
   * The migration, and the reason the field is `nullish` rather than
   * `optional`. A scraper compiled before 2026-09-23 has no `canary` key at
   * all; one whose compile page carried nothing worth fingerprinting has
   * `canary: null`. Both leave the gate unable to check anything, and they are
   * not the same fact — only the first is a gap a later run should fill.
   */
  describe("canaryOrigin: the two absences are different facts", () => {
    it("loads a scraper written before the field existed, and calls it unrecorded", () => {
      const old = loginFixture() as Record<string, unknown>;
      expect("canary" in old).toBe(false);
      const doc = validateScraper(JSON.parse(JSON.stringify(old)));
      expect(doc.canary).toBeUndefined();
      expect(canaryOrigin(doc)).toBe("unrecorded");
    });

    it("keeps an explicit null as a decision, not as an absence", () => {
      const doc = validateScraper({ ...loginFixture(), canary: null });
      expect(doc.canary).toBeNull();
      // Through JSON too: `undefined` would not survive the round trip, `null` does.
      expect(validateScraper(JSON.parse(JSON.stringify(doc))).canary).toBeNull();
      expect(canaryOrigin(doc)).toBe("refused");
    });

    it("calls a recorded fingerprint recorded", () => {
      expect(canaryOrigin(validateScraper({ ...loginFixture(), canary: fingerprint() }))).toBe("recorded");
    });

    it("distinguishes all three from one another", () => {
      const origins = [loginFixture(), { ...loginFixture(), canary: null }, { ...loginFixture(), canary: fingerprint() }]
        .map((raw) => canaryOrigin(validateScraper(raw) as CompiledScraper));
      expect(origins).toEqual(["unrecorded", "refused", "recorded"]);
    });
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
