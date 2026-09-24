import { describe, expect, it } from "vitest";
import * as schema from "../src/scraper/schema.js";
import { appendFieldAlternative, appendStepAlternative, markHealed, promoteFieldAlternative, validateScraper } from "../src/scraper/schema.js";
import { loginFixture } from "./helpers.js";

describe("merge rules (R31, R32)", () => {
  it("appends a field alternative at the end, keeping existing order and the input untouched", () => {
    const doc = loginFixture();
    const before = JSON.parse(JSON.stringify(doc));
    const alt = { selector: "h3 a", fingerprint: { samples: ["Python dev"], shape: "text" as const } };
    const next = appendFieldAlternative(doc, "title", alt);
    expect(next.fields.title?.alternatives).toEqual([...before.fields.title.alternatives, alt]);
    expect(doc).toEqual(before);
    expect(next).not.toBe(doc);
    expect(() => validateScraper(next)).not.toThrow();
  });

  it("refuses to append to an unknown field (no implicit add)", () => {
    expect(() =>
      appendFieldAlternative(loginFixture(), "price", {
        selector: ".price",
        fingerprint: { samples: ["$1"], shape: "money" },
      }),
    ).toThrow(/unknown field "price"/);
  });

  it("has no API that renames, retypes or removes a field", () => {
    const names = Object.keys(schema);
    expect(names.filter((n) => /rename|retype|remove|delete|drop|replace/i.test(n))).toEqual([]);
    expect(schema.MERGE_API).toEqual(["appendFieldAlternative", "appendStepAlternative", "markHealed", "promoteFieldAlternative"]);
    for (const name of schema.MERGE_API) expect(typeof schema[name]).toBe("function");
  });

  it("appends a step alternative keeping order and refuses an unknown step", () => {
    const doc = loginFixture();
    const before = JSON.parse(JSON.stringify(doc));
    const alt = { role: "button", name: "Continue", exact: true };
    const next = appendStepAlternative(doc, 2, alt);
    expect(next.trace[2]?.alternatives).toEqual([...before.trace[2].alternatives, alt]);
    expect(next.trace[0]).toEqual(before.trace[0]);
    expect(doc).toEqual(before);
    expect(() => appendStepAlternative(doc, 7, alt)).toThrow(/step 7/);
  });

  /**
   * The fourth merge rule, and the only one that is not an append. It came
   * here from `replay/heal.ts`, where it was written to be moved and said so:
   * the decision to reorder is a replay measurement, what a document may
   * become is this file's.
   */
  describe("promoteFieldAlternative (U9b)", () => {
    /** The Store C shape: the compiled selector first, the repair behind it. */
    const withThree = () => {
      const alt = (selector: string) => ({ selector, fingerprint: { samples: ["Python dev"], shape: "text" as const } });
      return appendFieldAlternative(appendFieldAlternative(loginFixture(), "title", alt("h1.title")), "title", alt("h3 a"));
    };

    it("moves one alternative to the front, keeps the rest in order, and leaves the input untouched", () => {
      const doc = withThree();
      const before = JSON.parse(JSON.stringify(doc));
      const next = promoteFieldAlternative(doc, "title", 2);
      expect(next.fields.title?.alternatives.map((a) => a.selector)).toEqual(["h3 a", "h2 a", "h1.title"]);
      // A reorder loses no reading, so the next run can overturn it.
      expect(next.fields.title?.alternatives).toHaveLength(before.fields.title.alternatives.length);
      expect(next.fields.url).toEqual(before.fields.url);
      expect(doc).toEqual(before);
      expect(next).not.toBe(doc);
      expect(() => validateScraper(next)).not.toThrow();
    });

    it("refuses an unknown field, the same way appendFieldAlternative does", () => {
      expect(() => promoteFieldAlternative(loginFixture(), "price", 0)).toThrow(/unknown field "price"/);
      expect(() => promoteFieldAlternative(loginFixture(), "price", 0)).toThrow(/cannot add or rename/);
    });

    it("refuses an index the field does not have, rather than dropping the field", () => {
      expect(() => promoteFieldAlternative(withThree(), "title", 7)).toThrow(/unknown alternative 7/);
      expect(() => promoteFieldAlternative(withThree(), "title", -1)).toThrow(/unknown alternative/);
      expect(() => promoteFieldAlternative(withThree(), "title", 1.5)).toThrow(/unknown alternative/);
    });

    it("promoting the alternative that is already first is a no-op, not a rewrite", () => {
      const doc = withThree();
      expect(promoteFieldAlternative(doc, "title", 0)).toBe(doc);
    });

    it("cannot retype a field or touch the type it declares", () => {
      const typed = { ...withThree() };
      typed.fields = { ...typed.fields, title: { ...typed.fields.title!, type: "text" as const } };
      const next = promoteFieldAlternative(typed, "title", 1);
      expect(next.fields.title?.type).toBe("text");
      expect(Object.keys(next.fields)).toEqual(Object.keys(typed.fields));
    });
  });

  it("markHealed sets healedAt and touches nothing else", () => {
    const doc = loginFixture();
    const before = JSON.parse(JSON.stringify(doc));
    const next = markHealed(doc, "2026-09-20T00:00:00.000Z");
    expect(next.healedAt).toBe("2026-09-20T00:00:00.000Z");
    const { healedAt: _ignored, ...rest } = next;
    expect(rest).toEqual(before);
    expect(doc.healedAt).toBeUndefined();
  });
});
