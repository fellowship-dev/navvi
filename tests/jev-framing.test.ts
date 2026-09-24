import { describe, expect, it } from "vitest";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import type { Experimental_EvaluationModelV4CallOptions } from "@ai-sdk/provider";
import { gateId, JevChooser, toEvaluationQuestion, toEvaluationState } from "../src/chooser/jev.js";
import { jevFraming, premises } from "../src/chooser/questions.js";
import type { Question } from "../src/chooser/chooser.js";
import { buildListQuestions, type FieldCandidate } from "../src/compile/index.js";
import { familyOf } from "../tools/measure/bank.js";

/**
 * The Jev framing of docs/jev-hillclimb.md: structured state from the batch's
 * shared context, structured instructions and criteria, the presence gate for
 * field healing. Each is a measured step; these tests pin the shape.
 */

/** The values earlier pages gave, shared by the premise and the question's own context. */
const EARLIER_VALUES = ["$ 6.990"];

const healQuestion = (): Question => ({
  id: "heal.price",
  kind: "choice",
  premise: premises.healField("price", EARLIER_VALUES),
  options: ["main/article/aside/span = $ 6.990", "main/section/ul/li/span = $ 8.490", "main/section/ul/li/span = $ 10.390"],
  state: "Healing on http://shop/p/1\nFields whose compiled selectors no longer resolve: price",
  context: { decision: "heal_field_value", field: { name: "price" }, earlier_values: EARLIER_VALUES, shape: "money", shared: { page: "http://shop/p/1", mode: "record", fields: ["name", "price"], broken_fields: ["price"] } },
  optionContext: [
    { path: "main/article/aside/span", shape: "money", values: ["$ 6.990"] },
    { path: "main/section/ul/li/span", shape: "money", values: ["$ 8.490"], candidates_on_same_path: 2 },
    { path: "main/section/ul/li/span", shape: "money", values: ["$ 10.390"], candidates_on_same_path: 2 },
  ],
});

const fieldQuestion = (): Question => ({
  id: "field.price",
  kind: "choice",
  premise: premises.fieldChoice("price"),
  options: ["aside/span = $ 6.990 | $ 12.990", "p/span = Laboratorio: | Laboratorio:"],
  state: "Records: pharmacy product",
  context: { decision: "field_value", field: { name: "price" }, shared: { records: "pharmacy product", mode: "record", fields: [{ name: "price" }], samples: ["http://shop/p/1", "http://shop/p/2"] } },
  optionContext: [
    { path: "aside/span", shape: "money", values: ["$ 6.990", "$ 12.990"] },
    { path: "p/span", shape: "text", values: ["Laboratorio:", "Laboratorio:"] },
  ],
});

function mock(answers: (options: Experimental_EvaluationModelV4CallOptions) => Record<string, unknown>) {
  const calls: Experimental_EvaluationModelV4CallOptions[] = [];
  const model = new Experimental_EvaluationMockModelV4({
    provider: "typesafe",
    modelId: "jev-latest",
    supportedQuestionTypes: ["choice", "boolean", "score"],
    doEvaluate: async (options) => {
      calls.push(options);
      return { answers: answers(options) as never, usage: { inputTokens: 100, outputTokens: 0 }, warnings: [] };
    },
  });
  return { model, calls };
}

describe("Jev framing: structured state, instructions and criteria", () => {
  it("the batch's shared context is the state; the question's own facts and the rule are the instructions", () => {
    const q = fieldQuestion();
    expect(toEvaluationState([q])).toEqual(q.context!.shared);
    const { question, keys } = toEvaluationQuestion(q);
    expect(question.type).toBe("choice");
    const instructions = question.instructions as Record<string, unknown>;
    // The question is the premise `questions.ts` writes, minus its trailing
    // "Pick none…" clause. Asserting a hand-copy of the string here is how a
    // premise reword silently breaks that strip in production while this stays
    // green (2026-09-22), so both halves are derived.
    expect(typeof instructions.question).toBe("string");
    expect(instructions.question).not.toMatch(/Pick none/);
    expect(q.premise.startsWith(instructions.question as string)).toBe(true);
    expect((instructions.question as string).length).toBeGreaterThan(0);
    expect(instructions.decision).toBe("field_value");
    expect(instructions.field).toEqual({ name: "price" });
    expect(instructions.shared).toBeUndefined();
    expect(instructions.rule).toBe(jevFraming.rule("field_value"));
    expect(keys).toEqual(["option_0", "option_1", "none"]);
  });

  it("criteria are the option facts, none is described for the decision", () => {
    const { question } = toEvaluationQuestion(fieldQuestion());
    if (question.type !== "choice") throw new Error("choice expected");
    expect(question.criteria.option_0).toEqual({ path: "aside/span", shape: "money", values: ["$ 6.990", "$ 12.990"] });
    expect(question.criteria.none).toMatchObject({ what: expect.stringContaining("No candidate") });
  });

  it("without context the mapping is the premise and the option strings, none last", () => {
    const { context: _c, optionContext: _o, ...plain } = fieldQuestion();
    const { question, keys } = toEvaluationQuestion(plain);
    if (question.type !== "choice") throw new Error("choice expected");
    expect(question.instructions).toBe(plain.premise);
    expect(question.criteria.option_0).toBe(plain.options![0]);
    expect(keys.at(-1)).toBe("none");
    expect(toEvaluationState([plain])).toBe(plain.state);
  });

  it("field healing is gated: the choice has no none, a presence question carries the candidates", () => {
    const { question, keys, gate } = toEvaluationQuestion(healQuestion());
    expect(keys).toEqual(["option_0", "option_1", "option_2"]);
    if (question.type !== "choice") throw new Error("choice expected");
    expect(question.criteria.none).toBeUndefined();
    expect(gate?.type).toBe("boolean");
    const instructions = gate!.instructions as Record<string, unknown>;
    expect(instructions.candidates).toHaveLength(3);
    expect(instructions.earlier_values).toEqual(EARLIER_VALUES);
    expect(instructions.rule).toBe(jevFraming.presence(healQuestion().context!, [])!.rule);
  });

  it("the gate decides none: a no turns the chosen candidate into none, a yes keeps it", async () => {
    const pick = (present: number) =>
      mock((o) => {
        const out: Record<string, unknown> = {};
        for (const id of Object.keys(o.questions)) {
          out[id] = id === gateId("heal.price") ? { type: "boolean", probability: present } : { type: "choice", choice: "option_1", probabilities: { option_0: 0.2, option_1: 0.5, option_2: 0.3 } };
        }
        return out;
      });
    const absent = pick(0.2);
    const [a] = await new JevChooser({ evaluationModel: absent.model }).ask([healQuestion()]);
    expect(a!.index).toBeNull();
    expect(Object.keys(absent.calls[0]!.questions)).toEqual(["heal.price", "heal.price.present"]);
    const present = pick(0.9);
    const [b] = await new JevChooser({ evaluationModel: present.model }).ask([healQuestion()]);
    expect(b!.index).toBe(1);
    expect(b!.probabilities).toEqual([0.2, 0.5, 0.3]);
  });

  it("the bank groups question ids into families", () => {
    expect(["group", "field.title", "heal.step.2", "heal.price", "link.next", "nav.0.op", "nav.3.done", "nav.1.click", "text.0"].map(familyOf)).toEqual([
      "group", "field", "heal.step", "heal.field", "link", "nav.op", "nav.done", "nav.target", "text",
    ]);
  });
});

/**
 * The list follow-up as the quotes run of 2026-09-24 asked it: tags answered
 * none, and the follow-up offers every tag of each quote as one list.
 */
function listFollowUp(): Question {
  const lists = [["change", "deep-thoughts", "thinking", "world"], ["abilities", "choices"], ["inspirational", "life", "live", "miracle", "miracles"]];
  const tags: FieldCandidate = { key: "list:div.tags a.tag", path: "div.tags/a.tag", selector: "div.tags > a.tag", values: lists.map((l) => l[0]!), shape: "text", multiple: true, lists };
  const hrefs: FieldCandidate = { ...tags, key: "list:div.tags a.tag@href", path: "div.tags/a.tag/@href", attr: "href", shape: "url", values: lists.map((l) => `/tag/${l[0]}/`), lists: lists.map((l) => l.map((t) => `/tag/${t}/`)) };
  const fields = [{ name: "quote" }, { name: "author" }, { name: "tags", description: "Tags associated with the quote" }];
  const mapped = new Map<string, FieldCandidate | null>([["quote", null], ["author", null], ["tags", null]]);
  const shared = { records: "quotes", fields, samples: ["q1", "q2", "q3"], mode: "list" as const };
  const followUps = buildListQuestions(fields, mapped, [tags, hrefs], "state", "", shared).filter((f) => f.field === "tags");
  return followUps[0]!.question;
}

describe("Jev framing: the list follow-up (field_list)", () => {
  it("carries its own rule and its own none, not the generic 'None of the options is right.'", () => {
    const { question, keys } = toEvaluationQuestion(listFollowUp());
    if (question.type !== "choice") throw new Error("choice expected");
    const instructions = question.instructions as Record<string, unknown>;
    expect(instructions.decision).toBe("field_list");
    expect(instructions.rule).toBe(jevFraming.rule("field_list"));
    // What the rule has to tell Jev: several values per record are one list,
    // counts differ, and link targets are not the tag text.
    expect(instructions.rule).toMatch(/several values per record/);
    expect(instructions.rule).toMatch(/count differs per record/);
    expect(instructions.rule).toMatch(/@href/);
    expect(question.criteria.none).toEqual(jevFraming.none("field_list"));
    expect(question.criteria.none).toMatchObject({ what: expect.stringContaining("No offered list"), not_for: expect.stringContaining("pick it") });
    expect(keys).toEqual(["option_0", "option_1", "none"]);
  });

  it("each option is its elements per record and their counts, not the first element of each", () => {
    const { question } = toEvaluationQuestion(listFollowUp());
    if (question.type !== "choice") throw new Error("choice expected");
    expect(question.criteria.option_0).toEqual({
      path: "div.tags/a.tag",
      shape: "text",
      multiple: true,
      values_per_sample: [["change", "deep-thoughts", "thinking", "world"], ["abilities", "choices"], ["inspirational", "life", "live", "miracle", "miracles"]],
      count_per_sample: [4, 2, 5],
    });
  });

  it("the option label shows several values per item", () => {
    expect(listFollowUp().options![0]).toBe('div.tags/a.tag (every match, as a list) = 4 values: "change", "deep-thoughts", "thinking", … | 2 values: "abilities", "choices" | 5 values: "inspirational", "life", "live", …');
  });
});

describe("text helper answers (R24): the value, whatever the envelope", () => {
  it("reads the JSON envelope, a bare value, and rejects commentary", async () => {
    const { parseTextAnswer } = await import("../src/navigate/textHelper.js");
    expect(parseTextAnswer('{"text":"python"}')).toEqual({ text: "python" });
    expect(parseTextAnswer('{"text":null}')).toEqual({ text: null });
    expect(parseTextAnswer("python jobs")).toEqual({ text: "python jobs" });
    expect(parseTextAnswer("New York")).toEqual({ text: "New York" });
    expect(parseTextAnswer("Sure! Here is the text you should type: python")).toEqual({ error: "not valid JSON" });
    expect(parseTextAnswer("python\nand more")).toEqual({ error: "not valid JSON" });
    expect(parseTextAnswer('{"value":"python"}')).toMatchObject({ error: expect.stringContaining("keys") });
  });
});
