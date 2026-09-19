import { describe, expect, it } from "vitest";
import { TEXT_INPUT_CAP, questionChars, type Answer, type Chooser, type ChooserUsage, type Question } from "../src/chooser/chooser.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { NavviError } from "../src/billing/budget.js";
import { looksLikeCredential } from "../src/input/credentials.js";
import { CredentialInPromptError, PromptParseError, buildPromptQuestion, promptQuestionId, promptToInput } from "../src/input/prompt.js";
import { InputSchema } from "../src/input/schema.js";

const URLS = ["https://www.example-pharmacy.cl/producto/paracetamol-500", "https://www.example-pharmacy.cl/producto/ibuprofeno-400"];

const PROMPTS = {
  products: "Get me price, name, laboratory and stock for these products",
  jobs: "All job posts on this page with title, company and link, follow next page",
  login: "Log in with my account and export my orders",
  spanishField: "Para cada producto dame el Precio Oferta",
} as const;

function recorded(): Chooser {
  return new RecordedChooser({ fixture: "prompt" });
}

/** A chooser answering text questions from a script, recording what was asked. */
class FakeChooser implements Chooser {
  readonly name = "model" as const;
  readonly asked: Question[][] = [];
  constructor(private readonly script: string[]) {}
  async ask(batch: Question[]): Promise<Answer[]> {
    this.asked.push(batch);
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

const VALID = JSON.stringify({ mode: "record", description: "Product price", fields: [{ name: "price" }] });

describe("looksLikeCredential (R27)", () => {
  it("flags password, contraseña, token, api key literals and user:pass pairs", () => {
    expect(looksLikeCredential("log in, password: hunter2")).toBe("password");
    expect(looksLikeCredential("contraseña: hunter2")).toBe("password");
    expect(looksLikeCredential("use token: abc123")).toBe("token");
    expect(looksLikeCredential("api key: abc123")).toBe("api key");
    expect(looksLikeCredential("apikey=abc123")).toBe("api key");
    expect(looksLikeCredential("connect as max:hunter2@example.com")).toBe("user:pass pair");
    expect(looksLikeCredential("use sk-ant-a1b2c3d4e5f6g7h8i9j0k1l2m3 for auth")).toBe("token-looking string");
    expect(looksLikeCredential("key aB3dE5fG7hI9jK1lM3nO5pQ7 please")).toBe("token-looking string");
  });

  it("does not flag talk about credentials, placeholders or URLs", () => {
    expect(looksLikeCredential("Log in with my account and export my orders")).toBeNull();
    expect(looksLikeCredential("type my password from the secret store")).toBeNull();
    expect(looksLikeCredential("password: {{secret:password}}")).toBeNull();
    expect(looksLikeCredential("use {{secret:api_key}} when asked")).toBeNull();
    expect(looksLikeCredential("open https://example.com/products/abcdefghij1234567890xyz first")).toBeNull();
    expect(looksLikeCredential("fill the password field, then the username field")).toBeNull();
  });

  it("the input schema refuses a credential in the prompt, goal or description with an issue naming {{secret:name}}", () => {
    const base = { startUrls: [URLS[0]!], mode: "record", fields: [{ name: "order" }] };
    for (const [where, text] of [
      ["prompt", "Log in with password: hunter2 and export my orders"],
      ["goal", "sign in with token: abc123"],
      ["description", "orders for max:hunter2@example.com"],
    ] as const) {
      const result = InputSchema.safeParse({ ...base, [where]: text });
      expect(result.success, where).toBe(false);
      const issue = result.success ? undefined : result.error.issues.find((i) => i.path.join(".") === where);
      expect(issue?.message, where).toMatch(new RegExp(`the ${where} carries a`));
      expect(issue?.message, where).toContain("{{secret:name}}");
    }
    expect(InputSchema.safeParse({ ...base, prompt: "Log in with my account and export my orders", goal: "type {{secret:password}} then open orders" }).success).toBe(true);
  });
});

describe("promptToInput (R1, KTD11)", () => {
  it("parses a record prompt into four fields, keeping the caller's startUrls", async () => {
    const { input, structured } = await promptToInput(PROMPTS.products, { startUrls: URLS }, recorded());
    expect(structured.mode).toBe("record");
    expect(structured.fields.map((f) => f.name)).toEqual(["price", "name", "laboratory", "stock"]);
    expect(input.mode).toBe("record");
    expect(input.fields?.map((f) => f.name)).toEqual(["price", "name", "laboratory", "stock"]);
    expect(input.startUrls).toEqual(URLS);
    expect(input.prompt).toBe(PROMPTS.products);
    expect(input.profile).toBe("store");
  });

  it("parses a list prompt with pagination on", async () => {
    const { input, structured } = await promptToInput(PROMPTS.jobs, { startUrls: [URLS[0]!] }, recorded());
    expect(structured.mode).toBe("list");
    expect(structured.fields.map((f) => f.name)).toEqual(["title", "company", "link"]);
    expect(input.mode).toBe("list");
    expect(input.maxPages).toBeGreaterThan(1);
  });

  it("parses a login goal into profile local with expected secrets", async () => {
    const { input, structured } = await promptToInput(PROMPTS.login, { startUrls: [URLS[0]!] }, recorded());
    expect(structured.goal).toBeTruthy();
    expect(structured.profile).toBe("local");
    expect(structured.secretsExpected).toEqual(expect.arrayContaining(["username", "password"]));
    expect(input.goal).toBe(structured.goal);
    expect(input.profile).toBe("local");
  });

  it("lets explicit base values win over the prompt", async () => {
    const { input } = await promptToInput(PROMPTS.jobs, { startUrls: [URLS[0]!], maxPages: 3, mode: "record" }, recorded());
    expect(input.maxPages).toBe(3);
    expect(input.mode).toBe("record");
  });

  it("refuses a prompt carrying a password before asking anything (R27)", async () => {
    const chooser = new FakeChooser([VALID]);
    const run = promptToInput("Log in with password: hunter2 and export my orders", { startUrls: [URLS[0]!] }, chooser);
    await expect(run).rejects.toBeInstanceOf(CredentialInPromptError);
    await expect(run).rejects.toBeInstanceOf(NavviError);
    await expect(run).rejects.toMatchObject({ status: "blocked_login_required" });
    await expect(run).rejects.toThrow(/\{\{secret:/);
    expect(chooser.asked).toHaveLength(0);
  });

  it("refuses a credential in the base goal or description too", async () => {
    const chooser = new FakeChooser([VALID]);
    await expect(promptToInput(PROMPTS.login, { startUrls: [URLS[0]!], goal: "sign in with token: abc123" }, chooser)).rejects.toMatchObject({ status: "blocked_login_required" });
    expect(chooser.asked).toHaveLength(0);
  });

  it("does not refuse a prompt that only talks about a password", async () => {
    const chooser = new FakeChooser([JSON.stringify({ mode: "record", description: "Orders", fields: [{ name: "order" }], goal: "log in and open orders", secretsExpected: ["password"] })]);
    const { input } = await promptToInput("Log in and type my password from the secret store, then list my orders", { startUrls: [URLS[0]!] }, chooser);
    expect(chooser.asked).toHaveLength(1);
    expect(input.profile).toBe("local");
  });

  it("retries once with the validation errors, then succeeds", async () => {
    const chooser = new FakeChooser(["not json at all", VALID]);
    const { input } = await promptToInput(PROMPTS.products, { startUrls: URLS }, chooser);
    expect(input.fields?.map((f) => f.name)).toEqual(["price"]);
    expect(chooser.asked).toHaveLength(2);
    const retry = chooser.asked[1]![0]!;
    expect(retry.premise).toMatch(/JSON/);
    expect(retry.premise).not.toBe(chooser.asked[0]![0]!.premise);
    expect(questionChars(retry)).toBeLessThanOrEqual(TEXT_INPUT_CAP);
  });

  it("fails with a clear message naming what could not be inferred after the retry", async () => {
    const chooser = new FakeChooser(["{}", JSON.stringify({ mode: "table", description: "x" })]);
    const run = promptToInput(PROMPTS.products, { startUrls: URLS }, chooser);
    await expect(run).rejects.toBeInstanceOf(PromptParseError);
    await expect(run).rejects.toThrow(/mode/);
    await expect(run).rejects.toThrow(/fields/);
    expect(chooser.asked).toHaveLength(2);
  });

  it("normalizes field names to identifiers and keeps the original text as the description", async () => {
    const { input, structured } = await promptToInput(PROMPTS.spanishField, { startUrls: [URLS[0]!] }, recorded());
    expect(structured.fields).toEqual([{ name: "precio_oferta", description: "Precio Oferta" }]);
    expect(input.fields).toEqual([{ name: "precio_oferta", description: "Precio Oferta" }]);
  });

  it("keeps a model-provided description when normalizing a name", async () => {
    const chooser = new FakeChooser([JSON.stringify({ mode: "record", description: "x", fields: [{ name: "Stock Total", description: "units in stock" }, { name: "9lives" }] })]);
    const { structured } = await promptToInput(PROMPTS.products, { startUrls: URLS }, chooser);
    expect(structured.fields).toEqual([
      { name: "stock_total", description: "units in stock" },
      { name: "_9lives", description: "9lives" },
    ]);
  });

  it("is deterministic: the same prompt yields the same question id and structured input", async () => {
    const first = await promptToInput(PROMPTS.products, { startUrls: URLS }, recorded());
    const second = await promptToInput(PROMPTS.products, { startUrls: URLS }, recorded());
    expect(first.structured).toEqual(second.structured);
    expect(first.input).toEqual(second.input);
    expect(promptQuestionId(PROMPTS.products)).toBe(promptQuestionId(PROMPTS.products));
    expect(promptQuestionId(PROMPTS.products)).not.toBe(promptQuestionId(PROMPTS.jobs));
    expect(buildPromptQuestion(PROMPTS.products)).toEqual(buildPromptQuestion(PROMPTS.products));
  });

  it("truncates a prompt over the cap so the question input stays at 2,000 characters", async () => {
    const long = `${PROMPTS.products} ${"and more detail ".repeat(200)}`;
    expect(long.length).toBeGreaterThan(TEXT_INPUT_CAP);
    const chooser = new FakeChooser([VALID]);
    await promptToInput(long, { startUrls: URLS }, chooser);
    const q = chooser.asked[0]![0]!;
    expect(q.kind).toBe("text");
    expect(q.schema).toBeDefined();
    expect(q.premise.length + q.state.length).toBe(TEXT_INPUT_CAP);
    expect(q.premise.length).toBeLessThan(TEXT_INPUT_CAP);
    expect(q.state.length).toBeLessThan(long.length);
    expect(long.startsWith(q.state)).toBe(true);
    expect(promptQuestionId(long)).toBe(promptQuestionId(long.slice(0, q.state.length)));
  });
});
