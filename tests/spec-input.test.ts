import { describe, expect, it } from "vitest";
import { requestedFields } from "../src/spec/schema.js";
import { DEFAULT_ENTITY, specFromInput } from "../src/spec/input.js";

/**
 * U5: the spec a plain run already is. The compile core reads a `Spec`; the
 * plain command has a run input, and this writes one down as the other
 * without asking anybody or inventing anything.
 */
describe("specFromInput", () => {
  it("writes the prompt as the brief, each field with its words, and the run's URLs as a url_list", () => {
    const spec = specFromInput(
      {
        prompt: "Extract the book title, price and availability",
        description: "book",
        mode: "record",
        fields: [{ name: "title", description: "the book's title" }, { name: "price", type: "money" }, { name: "availability" }, { name: "upc" }],
      },
      { urls: ["https://www.books.example/p/1", "https://www.books.example/p/2"], rubrics: [{ id: "price", rule: "the price is the one in the product box", source: "--rubric" }] },
    );
    expect(spec.brief).toBe("Extract the book title, price and availability");
    expect(spec.target).toEqual({ site: "books.example", pageKind: "unknown", provenance: "inferred" });
    expect(spec.entity).toEqual({ name: "book", provenance: "brief" });
    expect(spec.inputs.shape).toBe("url_list");
    expect(spec.fields).toEqual([
      { name: "title", description: "the book's title", briefTerm: "title", provenance: "brief" },
      { name: "price", briefTerm: "price", type: "money", provenance: "brief" },
      { name: "availability", briefTerm: "availability", provenance: "brief" },
      // Listed by the caller, not named by the brief: stated, so still requested.
      { name: "upc", provenance: "answered" },
    ]);
    expect(requestedFields(spec).map((field) => field.name)).toEqual(["title", "price", "availability", "upc"]);
    expect(spec.rubrics.map((rubric) => rubric.id)).toEqual(["price"]);
    expect(spec.openQuestions).toEqual([]);
    expect(Object.values(spec.constraints).every((constraint) => !constraint.stated)).toBe(true);
  });

  it("a structured run with no prompt gets a brief spelled from what it asked for, and the default record noun", () => {
    const spec = specFromInput({ mode: "list", fields: [{ name: "title" }, { name: "link" }] }, { urls: ["http://127.0.0.1:8080/jobs"] });
    expect(spec.brief).toBe("Extract title, link");
    expect(spec.entity).toEqual({ name: DEFAULT_ENTITY, provenance: "inferred" });
    expect(spec.target.pageKind).toBe("listing");
    expect(spec.target.site).toBe("127.0.0.1");
    expect(spec.fields.map((field) => field.provenance)).toEqual(["brief", "brief"]);
  });

  it("a description without a prompt names the records in the brief", () => {
    const spec = specFromInput({ description: "pharmacy product", fields: [{ name: "name" }] }, { urls: ["https://store.example/p"] });
    expect(spec.brief).toBe("Extract name of each pharmacy product");
    expect(spec.entity.name).toBe("pharmacy product");
  });
});
