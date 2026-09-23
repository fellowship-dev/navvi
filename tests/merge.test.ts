import { describe, expect, it } from "vitest";
import * as schema from "../src/scraper/schema.js";
import { appendFieldAlternative, appendStepAlternative, markHealed, validateScraper } from "../src/scraper/schema.js";
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
    expect(schema.MERGE_API).toEqual(["appendFieldAlternative", "appendStepAlternative", "markHealed"]);
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
