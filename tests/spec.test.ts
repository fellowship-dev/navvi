import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, type CliIo } from "../bin/cli.js";
import { QUESTIONS_END, QUESTIONS_START } from "../src/chooser/agent.js";
import { HEURISTICS } from "../src/heuristics/bank.js";
import type { Answer, Chooser, ChooserUsage, Question } from "../src/chooser/chooser.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { CredentialInPromptError } from "../src/input/prompt.js";
import { briefContains, isVague, resolveInputShape, vagueTermIn } from "../src/spec/brief.js";
import { applyAnswers, parseAnswer } from "../src/make/answers.js";
import { blockingQuestions, declaredFieldTypes, isReadyToInvestigate, requestedFields, underspecifiedFields, SpecSchema, type Spec } from "../src/spec/schema.js";
import { SpecParseError, briefToSpec, specFromDraft, specQuestionId, type SpecDraft } from "../src/spec/spec.js";

/**
 * U1: the brief compiles into a spec before anything touches the web.
 *
 * The acceptance case is the plan's: *"I need the product info of a dynamic set
 * of products in Store B"* must yield a spec whose open question is which
 * fields — not a spec with five confidently invented ones.
 */

const STORE_B = "I need the product info of a dynamic set of products in Store B.";
const GOLDEN = resolve(import.meta.dirname, "fixtures", "specs", "store-b.json");

/** The draft a model returns for the Store B brief; `tests/recorded/spec/` replays exactly this. */
const STORE_B_DRAFT: SpecDraft = {
  target: { site: "Store B", pageKind: "product", briefTerm: "Store B" },
  entity: { name: "product", briefTerm: "products" },
  inputs: { shape: "unknown", description: "a dynamic set of products", briefTerm: "a dynamic set of products" },
  fields: [
    { name: "product_name", description: "the product's name as shown on its page" },
    { name: "sku" },
    { name: "list_price" },
    { name: "promo_price" },
    { name: "stock" },
  ],
};

/** A chooser answering the one text question from a script. */
class ScriptedChooser implements Chooser {
  readonly name = "model" as const;
  readonly asked: Question[] = [];
  constructor(private readonly script: string[]) {}
  async ask(batch: Question[]): Promise<Answer[]> {
    this.asked.push(...batch);
    return batch.map((q) => {
      const text = this.script.shift();
      if (text === undefined) throw new Error("script exhausted");
      return { id: q.id, index: null, text };
    });
  }
  usage(): ChooserUsage {
    return { chooser: this.name, questions: 0, textQuestions: 0, batches: 0, inputTokens: 0, outputTokens: 0, waitMs: 0, costUsd: 0, zeroDataRetention: "not_applicable" };
  }
}

function draft(over: Partial<SpecDraft> = {}): SpecDraft {
  return { ...STORE_B_DRAFT, ...over };
}

describe("the brief verifier", () => {
  it("matches on word boundaries, with a simple plural, so a short marker is not a false positive", () => {
    expect(briefContains("the price of each item", "price")).toBe(true);
    expect(briefContains("the prices of each item", "price")).toBe(true);
    expect(briefContains("open the terminal", "term")).toBe(false);
    expect(briefContains("Precios de cada producto", "precio")).toBe(true);
  });

  it("knows a bundle word from a field name", () => {
    expect(isVague("product info")).toBe(true);
    expect(isVague("the product data")).toBe(true);
    expect(isVague("everything")).toBe(true);
    expect(isVague("list price")).toBe(false);
    expect(vagueTermIn(STORE_B)).toBe("product info");
    expect(vagueTermIn("give me the sku and the price")).toBeUndefined();
  });

  it("resolves an input shape only when the brief pins one", () => {
    expect(resolveInputShape("scrape these URLs", "url_list").shape).toBe("url_list");
    expect(resolveInputShape("scrape these SKUs", "url_list").shape).toBe("sku_list");
    expect(resolveInputShape(STORE_B, "url_list").shape).toBe("unknown");
    // Two shapes named at once is an ambiguity the draft may break, but only among what the brief said.
    expect(resolveInputShape("search for these skus", "sku_list").shape).toBe("sku_list");
    expect(resolveInputShape("search for these skus", "url_list").shape).toBe("unknown");
  });
});

describe("specFromDraft (the deterministic half)", () => {
  it("the acceptance case: the Store B one-liner's open question is which fields", () => {
    const spec = specFromDraft(STORE_B, STORE_B_DRAFT);
    const blocking = blockingQuestions(spec);
    expect(blocking.map((question) => question.id)).toEqual(["fields-unnamed", "inputs-shape"]);
    const fields = blocking[0]!;
    expect(fields.question).toBe("Which fields should the scraper return?");
    expect(fields.because).toBe('the brief says "product info", which names no field');
    expect(fields.candidates).toEqual(["product_name", "sku", "list_price", "promo_price", "stock"]);
    expect(isReadyToInvestigate(spec)).toBe(false);
  });

  it("records the five fields as inferred rather than requested, so nobody reads them as the ask", () => {
    const spec = specFromDraft(STORE_B, STORE_B_DRAFT);
    expect(requestedFields(spec)).toEqual([]);
    expect(underspecifiedFields(spec).map((field) => field.name)).toEqual(["product_name", "sku", "list_price", "promo_price", "stock"]);
  });

  it('does not guess the input shape: "a dynamic set of products" is all three', () => {
    const spec = specFromDraft(STORE_B, STORE_B_DRAFT);
    expect(spec.inputs.shape).toBe("unknown");
    expect(spec.inputs.provenance).toBe("inferred");
    const question = spec.openQuestions.find((q) => q.id === "inputs-shape")!;
    expect(question.because).toContain('"a dynamic set of products"');
    expect(question.candidates).toEqual(["a URL list", "a SKU or code list", "search terms"]);
  });

  it("a brief that names its fields has no blocking field question", () => {
    const brief = "Get the name, list price and stock of these product URLs from Store A";
    const spec = specFromDraft(brief, {
      target: { site: "Store A", pageKind: "product", briefTerm: "Store A" },
      entity: { name: "product", briefTerm: "product" },
      inputs: { shape: "url_list", description: "the product URLs given per run", briefTerm: "product URLs" },
      fields: [
        { name: "name", briefTerm: "name" },
        { name: "list_price", briefTerm: "list price" },
        { name: "stock", briefTerm: "stock" },
      ],
    });
    expect(requestedFields(spec).map((field) => field.name)).toEqual(["name", "list_price", "stock"]);
    expect(spec.inputs.shape).toBe("url_list");
    expect(blockingQuestions(spec)).toEqual([]);
    expect(isReadyToInvestigate(spec)).toBe(true);
  });

  it("drops a quote the brief does not contain, and demotes the field that leaned on it", () => {
    const brief = "Get the name of these product URLs from Store A";
    const spec = specFromDraft(brief, {
      target: { site: "Store A", pageKind: "product", briefTerm: "Store A" },
      entity: { name: "product", briefTerm: "product" },
      inputs: { shape: "url_list", description: "product URLs", briefTerm: "product URLs" },
      fields: [
        { name: "name", briefTerm: "name" },
        { name: "bioequivalence", briefTerm: "bioequivalence, as requested" },
      ],
    });
    const invented = spec.fields.find((field) => field.name === "bioequivalence")!;
    expect(invented.provenance).toBe("inferred");
    expect(invented.briefTerm).toBeUndefined();
    expect(spec.openQuestions.find((q) => q.id === "fields-inferred")?.question).toContain("bioequivalence");
    // One inferred field among named ones is worth asking about, not worth stopping for.
    expect(blockingQuestions(spec)).toEqual([]);
  });

  it("a vague quote does not make a field requested, however confidently it is offered", () => {
    const spec = specFromDraft(STORE_B, draft({ fields: [{ name: "product_info", briefTerm: "product info" }] }));
    expect(spec.fields[0]!.provenance).toBe("inferred");
    expect(blockingQuestions(spec).map((question) => question.id)).toContain("fields-unnamed");
  });

  it("keeps a constraint only when the brief grounds it", () => {
    const brief = "Scrape these product URLs from Store A every Monday and Thursday";
    const spec = specFromDraft(brief, {
      target: { site: "Store A", pageKind: "product", briefTerm: "Store A" },
      entity: { name: "product", briefTerm: "product" },
      inputs: { shape: "url_list", description: "product URLs", briefTerm: "product URLs" },
      fields: [{ name: "price", briefTerm: "price" }],
      constraints: { cadence: "every Monday and Thursday", budget: "under $50 a month" },
    });
    expect(spec.constraints.cadence).toEqual({ value: "every Monday and Thursday", stated: true });
    expect(spec.constraints.budget).toEqual({ stated: false });
    expect(spec.openQuestions.find((q) => q.id === "constraints-unstated")?.candidates).toEqual(["freshness", "volume", "budget"]);
  });

  it("asks who the target is when the brief names no site the draft can quote", () => {
    const spec = specFromDraft("Get the list price of these product URLs", {
      target: { site: "Store B", pageKind: "product" },
      entity: { name: "product", briefTerm: "product" },
      inputs: { shape: "url_list", description: "product URLs", briefTerm: "product URLs" },
      fields: [{ name: "list_price", briefTerm: "list price" }],
    });
    expect(spec.target.provenance).toBe("inferred");
    expect(blockingQuestions(spec).map((question) => question.id)).toEqual(["target-site"]);
  });

  it("leaves an unknown page kind to the investigation rather than the client", () => {
    const spec = specFromDraft("Get the list price of these product URLs from Store A", {
      target: { site: "Store A", pageKind: "unknown", briefTerm: "Store A" },
      entity: { name: "product", briefTerm: "product" },
      inputs: { shape: "url_list", description: "product URLs", briefTerm: "product URLs" },
      fields: [{ name: "list_price", briefTerm: "list price" }],
    });
    const question = spec.openQuestions.find((q) => q.id === "target-page-kind")!;
    expect(question.answeredBy).toBe("investigation");
    expect(question.blocking).toBe(false);
  });

  it("carries case rubrics verbatim: the client's domain knowledge enters the compile", () => {
    const rubrics = [
      { id: "list-price", rule: "the list price is the crossed-out one and never Precio Club", source: "client" },
      { id: "promotion-days", rule: "Store B's promotion counts only Monday and Thursday", source: "client" },
    ];
    const spec = specFromDraft(STORE_B, STORE_B_DRAFT, rubrics);
    expect(spec.rubrics).toEqual(rubrics);
  });

  it("normalizes and de-duplicates field names", () => {
    const spec = specFromDraft(STORE_B, draft({ fields: [{ name: "Precio Oferta" }, { name: "precio_oferta" }, { name: "Stock" }] }));
    expect(spec.fields.map((field) => field.name)).toEqual(["precio_oferta", "stock"]);
    expect(spec.fields[0]!.description).toBe("Precio Oferta");
  });

  it("produces a spec that validates against its own schema", () => {
    expect(() => SpecSchema.parse(specFromDraft(STORE_B, STORE_B_DRAFT))).not.toThrow();
  });

  it("proposes no column type: a guessed type is the invisible guess this artifact refuses", () => {
    const spec = specFromDraft(STORE_B, STORE_B_DRAFT);
    expect(spec.fields.every((field) => field.type === undefined)).toBe(true);
    expect(declaredFieldTypes(spec)).toEqual({});
  });
});

// ------------------------------------------- A9b: a request states its column

/**
 * A9b. `FieldRequest` carries the type of the column it asks for.
 *
 * The case is `stock`: *"is it in stock"* and *"how many are in stock"* are the
 * same word and two different asks, and an untyped request cannot hold the
 * difference — so navvi binds one and the consumer reads the other. The type
 * is the client's to declare, and `--answer <field>:<type>` is how they say
 * it.
 */
describe("a field request's column type", () => {
  const untyped = (): Spec => specFromDraft(STORE_B, STORE_B_DRAFT);
  const answerFields = (value: string, base: Spec = untyped()): Spec => applyAnswers(base, [parseAnswer(`fields=${value}`)]).spec;

  it("expresses the stock ambiguity: stock:boolean and stock:integer are two different asks", () => {
    const asBoolean = answerFields("productName,stock:boolean");
    const asInteger = answerFields("productName,stock:integer");

    expect(asBoolean.fields.find((field) => field.name === "stock")!.type).toBe("boolean");
    expect(asInteger.fields.find((field) => field.name === "stock")!.type).toBe("integer");
    // The point of the fix: the two requests are now different artifacts. Both
    // readings were previously the identical `{ name: "stock" }`.
    expect(asBoolean.fields).not.toEqual(asInteger.fields);
    // And the column nobody typed is still untyped, rather than defaulted.
    expect(asBoolean.fields.find((field) => field.name === "productName")!.type).toBeUndefined();
  });

  it("the declared type is part of the spec, so it survives being written and read back", () => {
    const spec = answerFields("productName,listPrice:money,stock:boolean");
    const round = SpecSchema.parse(JSON.parse(JSON.stringify(spec)));
    expect(declaredFieldTypes(round)).toEqual({ listPrice: "money", stock: "boolean" });
  });

  it("the type stops being a side channel: a resume that does not repeat --answer keeps it", () => {
    const first = applyAnswers(untyped(), [parseAnswer("fields=productName,listPrice:money")]);
    expect(first.types).toEqual({ listPrice: "money" });

    // The second run of `navvi make` reads `spec.json` and applies no answer.
    // The types used to be re-derived from argv, so this returned `{}` and the
    // investigation was handed five untyped columns.
    const resumed = applyAnswers(SpecSchema.parse(JSON.parse(JSON.stringify(first.spec))), []);
    expect(resumed.types).toEqual({ listPrice: "money" });
  });

  it("refuses a type the vocabulary does not have, naming the ones it does", () => {
    expect(() => answerFields("stock:yesno")).toThrow(/unknown field type "yesno"/);
    expect(() => answerFields("stock:yesno")).toThrow(/text, money, integer, number, boolean, url/);
  });

  /**
   * Compatibility, not a failing-first case: the committed golden is a
   * `spec.json` the previous version wrote. `type` is optional, so it still
   * parses and every column is simply untyped — which is the truthful record
   * of a brief that said "product info" and nothing about columns.
   */
  it("a spec written before this change still parses, with no column typed", () => {
    const golden = SpecSchema.parse(JSON.parse(readFileSync(GOLDEN, "utf8")));
    expect(golden.fields.map((field) => field.name)).toHaveLength(5);
    expect(golden.fields.every((field) => field.type === undefined)).toBe(true);
    expect(declaredFieldTypes(golden)).toEqual({});
  });
});

// ------------------------------------------ A9c: "the client answered" exists

/**
 * A9c. `PROVENANCES` has a word for a binding whose ground is a person.
 *
 * An answered field is neither `brief` — the brief does not contain the word,
 * and every provenance claim in a spec is supposed to be checkable against the
 * brief printed above it — nor `inferred`, which is the line navvi prints
 * under *"the brief did not ask for these"*.
 */
describe("the provenance of an answer", () => {
  const storeB = (): Spec => specFromDraft(STORE_B, STORE_B_DRAFT);

  it("a field the client named is `answered`, and the brief is not made to claim it", () => {
    const spec = applyAnswers(storeB(), [parseAnswer("fields=productName,stock:boolean")]).spec;
    const stock = spec.fields.find((field) => field.name === "stock")!;

    expect(stock.provenance).toBe("answered");
    // Why it cannot be `brief`: the assertion that would have made is false.
    expect(briefContains(spec.brief, "stock")).toBe(false);
    expect(stock.briefTerm).toBeUndefined();
  });

  it("an answered field is a request, and is never reported as something the brief did not ask for", () => {
    const spec = applyAnswers(storeB(), [parseAnswer("fields=productName,stock:boolean")]).spec;
    expect(requestedFields(spec).map((field) => field.name)).toEqual(["productName", "stock"]);
    expect(underspecifiedFields(spec)).toEqual([]);
  });

  it("the site, the entity and the input shape a client answers are `answered` too", () => {
    const spec = applyAnswers(storeB(), [parseAnswer("inputs=url_list"), parseAnswer("entity=presentation")]).spec;
    expect(spec.inputs.provenance).toBe("answered");
    expect(spec.entity.provenance).toBe("answered");
    expect(spec.inputs.description).toContain("answered by the client");
  });

  it("a field whose word really is in the brief keeps `brief`, with the quote that proves it", () => {
    const brief = "Get the name, list price and stock of these product URLs from Store A";
    const base = specFromDraft(brief, {
      target: { site: "Store A", pageKind: "product", briefTerm: "Store A" },
      entity: { name: "product", briefTerm: "product" },
      inputs: { shape: "url_list", description: "the product URLs given per run", briefTerm: "product URLs" },
      fields: [{ name: "name", briefTerm: "name" }],
    });
    const spec = applyAnswers(base, [parseAnswer("fields=name,stock:boolean,bioequivalent:boolean")]).spec;

    const stock = spec.fields.find((field) => field.name === "stock")!;
    expect(stock.provenance).toBe("brief");
    expect(stock.briefTerm).toBe("stock");
    expect(stock.type).toBe("boolean");
    // The one word the brief does not contain is the one that is `answered`.
    expect(spec.fields.find((field) => field.name === "bioequivalent")!.provenance).toBe("answered");
  });

  /**
   * Compatibility, not a failing-first case. A `spec.json` an older navvi
   * wrote records an answered input shape as `brief`; re-running the same
   * command must not rewrite those bytes just to relabel them, because the
   * staleness rule is over bytes and a rewrite re-runs every stage below.
   */
  it("a spec an older navvi answered is not rewritten just to relabel its provenance", () => {
    const older: Spec = {
      ...storeB(),
      inputs: { shape: "url_list", description: "url_list — answered by the client, settling inputs-shape", provenance: "brief" },
      openQuestions: [],
    };
    expect(applyAnswers(older, [parseAnswer("inputs=url_list")]).spec).toEqual(older);
  });
});

describe("briefToSpec", () => {
  it("replays the recorded draft offline and matches the committed artifact", async () => {
    const spec = await briefToSpec(STORE_B, new RecordedChooser({ fixture: "spec" }));
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Spec;
    expect(spec).toEqual(golden);
    expect(blockingQuestions(spec).map((question) => question.id)).toEqual(["fields-unnamed", "inputs-shape"]);
  });

  it("asks one text question, whose id is a function of the brief alone", async () => {
    const chooser = new ScriptedChooser([JSON.stringify(STORE_B_DRAFT)]);
    await briefToSpec(STORE_B, chooser);
    expect(chooser.asked).toHaveLength(1);
    expect(chooser.asked[0]!.id).toBe(specQuestionId(STORE_B));
    expect(chooser.asked[0]!.kind).toBe("text");
    expect(specQuestionId(STORE_B)).toBe(specQuestionId(STORE_B));
    expect(specQuestionId("something else entirely")).not.toBe(specQuestionId(STORE_B));
  });

  it("retries once with the validation errors, then gives up", async () => {
    const good = new ScriptedChooser(["not json at all", JSON.stringify(STORE_B_DRAFT)]);
    await expect(briefToSpec(STORE_B, good)).resolves.toMatchObject({ version: 1 });
    expect(good.asked[1]!.premise).toContain("The previous answer was rejected");

    const bad = new ScriptedChooser(["not json", "{}"]);
    await expect(briefToSpec(STORE_B, bad)).rejects.toBeInstanceOf(SpecParseError);
  });

  it("refuses a brief carrying a credential before any model call (R27)", async () => {
    const chooser = new ScriptedChooser([JSON.stringify(STORE_B_DRAFT)]);
    await expect(briefToSpec("log in with password: hunter2 and get the prices", chooser)).rejects.toBeInstanceOf(CredentialInPromptError);
    expect(chooser.asked).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ the CLI

class Capture extends Writable {
  text = "";
  constructor(private readonly onChunk?: (all: string) => void) {
    super();
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    this.onChunk?.(this.text);
    cb();
  }
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "navvi-spec-cli-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A host agent answering the one spec question over stdio with a fixed draft. */
function scriptedAgent(answer: string): { stdin: PassThrough; stdout: Capture } {
  const stdin = new PassThrough();
  let consumed = 0;
  const stdout = new Capture((all) => {
    for (;;) {
      const start = all.indexOf(QUESTIONS_START, consumed);
      if (start < 0) return;
      const end = all.indexOf(`\n${QUESTIONS_END}`, start);
      if (end < 0) return;
      const payload = JSON.parse(all.slice(start + QUESTIONS_START.length, end)) as { questions: Question[] };
      consumed = end + QUESTIONS_END.length + 1;
      const answers = payload.questions.map((q) => ({ id: q.id, index: null, text: answer }));
      setImmediate(() => stdin.write(JSON.stringify({ answers }) + "\n"));
    }
  });
  return { stdin, stdout };
}

function makeIo(over: Partial<CliIo> = {}): CliIo & { stdout: Capture; stderr: Capture } {
  return { stdin: null, stdout: new Capture(), stderr: new Capture(), env: {}, cwd: dir, ...over } as CliIo & { stdout: Capture; stderr: Capture };
}

describe("navvi spec", () => {
  it("writes the spec to a file and names the blocking questions on stderr", async () => {
    const agent = scriptedAgent(JSON.stringify(STORE_B_DRAFT));
    const io = makeIo({ stdin: agent.stdin, stdout: agent.stdout });
    const out = join(dir, "store-b.json");
    const code = await main(["spec", STORE_B, "--chooser", "agent", "--agent-mode", "stdio", "--out", out, "--storage", join(dir, "storage")], io);
    expect(code).toBe(0);
    const spec = JSON.parse(readFileSync(out, "utf8")) as Spec;
    expect(spec).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
    expect(io.stderr.text).toContain("fields requested: none — neither the brief nor an answer names a field");
    expect(io.stderr.text).toContain("[fields-unnamed] Which fields should the scraper return?");
    expect(io.stderr.text).toContain("not ready to investigate");
  });

  it("carries --rubric into the spec", async () => {
    const agent = scriptedAgent(JSON.stringify(STORE_B_DRAFT));
    const io = makeIo({ stdin: agent.stdin, stdout: agent.stdout });
    const out = join(dir, "with-rubric.json");
    const code = await main(
      ["spec", STORE_B, "--chooser", "agent", "--agent-mode", "stdio", "--out", out, "--storage", join(dir, "storage"), "--rubric", "list-price=the list price is the crossed-out one, never Precio Club"],
      io,
    );
    expect(code).toBe(0);
    const spec = JSON.parse(readFileSync(out, "utf8")) as Spec;
    expect(spec.rubrics).toEqual([{ id: "list-price", rule: "the list price is the crossed-out one, never Precio Club", source: "--rubric" }]);
  });

  it("refuses a malformed --rubric, and a spec with no brief", async () => {
    const io = makeIo();
    expect(await main(["spec", STORE_B, "--rubric", "no-equals-sign", "--chooser", "agent"], io)).toBe(2);
    expect(io.stderr.text).toContain('--rubric must be "id=rule"');

    const empty = makeIo();
    expect(await main(["spec", "--chooser", "agent"], empty)).toBe(2);
    expect(empty.stderr.text).toContain("give a brief");
  });

  // "spec needs no start URL" is proved by "writes the spec to a file and names
  // the blocking questions on stderr", which runs `navvi spec` with a brief and
  // no start URL; a bare `main(["spec"])` never reaches the start-URL guard.
});

describe("navvi heuristics", () => {
  it("lists the bank with the encounter behind each rule", async () => {
    const io = makeIo();
    expect(await main(["heuristics"], io)).toBe(0);
    // Counted off the bank rather than written out, because a literal here is
    // a second spelling of `HEURISTICS.length` that goes stale the next time
    // somebody adds a rule — as it did on 2026-09-23, when U6c's twelfth rule
    // landed and this line still said eleven.
    expect(io.stdout.text).toContain(`${HEURISTICS.length} heuristics`);
    expect(io.stdout.text).toContain("key-names-carry-the-signal");
    expect(io.stdout.text).toContain("price-list-std");
  });

  it("shows one rule with the observation shape it accepts", async () => {
    const io = makeIo();
    expect(await main(["heuristics", "every-field-collapsed-is-blocking", "--json"], io)).toBe(0);
    const [entry] = JSON.parse(io.stdout.text) as Array<{ id: string; stage: string; observation: unknown }>;
    expect(entry!.id).toBe("every-field-collapsed-is-blocking");
    expect(entry!.stage).toBe("replay");
    expect(JSON.stringify(entry!.observation)).toContain("canary");
  });

  it("says what it holds when asked for a rule it does not have", async () => {
    const io = makeIo();
    expect(await main(["heuristics", "no-such-rule"], io)).toBe(2);
    expect(io.stderr.text).toContain("no heuristic \"no-such-rule\"");
  });
});
