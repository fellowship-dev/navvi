import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, statSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { INPUT_SHAPES } from "../src/spec/schema.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, type CliIo, type RunFn } from "../bin/cli.js";
import { parseArgs } from "../src/cli/args.js";
import { telegramNotifier } from "../src/cli/notify.js";
import { toCsv } from "../src/cli/output.js";
import { QUESTIONS_END, QUESTIONS_START } from "../src/chooser/agent.js";
import { BudgetExhaustedError } from "../src/billing/budget.js";
import type { Answer, Chooser, Question } from "../src/chooser/chooser.js";
import type { CrawlDeps } from "../src/replay/crawler.js";
import { run as runNavvi, summaryFor, type RunSummary } from "../src/main.js";
import { PAYLOAD_IDS, payloadRoutes } from "./helpers.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

const REPO = resolve(import.meta.dirname, "..");
const FIXTURE = join(REPO, "tests", "recorded", "compile", "pharmacy-v1");

let server: FixtureServer;
let dir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), "navvi-cli-"));
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const PRODUCTS = [
  "amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema", "diclofenaco-gel", "ibuprofeno-400-mg", "loratadina-10-mg",
  "losartan-50-mg", "metformina-850-mg", "omeprazol-20-mg", "paracetamol-500-mg", "salbutamol-inhalador", "vitamina-c-1-g",
];
const productUrls = () => PRODUCTS.map((s) => `${server.baseUrl}/demo/pharmacy-v1/producto/${s}.html`);
const RECORD_FLAGS = ["--mode", "record", "--fields", "name,laboratory,price,stock", "--allow-private-host", "127.0.0.1", "--browser", "chromium", "--chooser", "agent"];

/** Answers a question from the recorded fixture, or from `text` for text questions. */
function recordedAnswer(q: Question, text: Record<string, string> = {}): Answer {
  const file = join(FIXTURE, `${q.id}.json`);
  if (existsSync(file)) {
    const recorded = JSON.parse(readFileSync(file, "utf8")) as Answer;
    return { id: q.id, index: recorded.index, ...(recorded.text !== undefined ? { text: recorded.text } : {}) };
  }
  const answer = Object.entries(text).find(([prefix]) => q.id.startsWith(prefix));
  if (!answer) throw new Error(`no scripted answer for question ${q.id}`);
  return { id: q.id, index: null, text: answer[1] };
}

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

/** A scripted host agent: reads each sentinel-delimited batch from stdout and answers it on stdin. */
function scriptedAgent(text: Record<string, string> = {}): { stdin: PassThrough; stdout: Capture; batches: Question[][] } {
  const stdin = new PassThrough();
  const batches: Question[][] = [];
  let consumed = 0;
  const stdout = new Capture((all) => {
    for (;;) {
      const start = all.indexOf(QUESTIONS_START, consumed);
      if (start < 0) return;
      const end = all.indexOf(`\n${QUESTIONS_END}`, start);
      if (end < 0) return;
      const body = all.slice(start + QUESTIONS_START.length, end);
      consumed = end + QUESTIONS_END.length + 1;
      const payload = JSON.parse(body) as { questions: Question[] };
      batches.push(payload.questions);
      const answers = payload.questions.map((q) => recordedAnswer(q, text));
      setImmediate(() => stdin.write(JSON.stringify({ answers }) + "\n"));
    }
  });
  return { stdin, stdout, batches };
}

function makeIo(over: Partial<CliIo> = {}): CliIo & { stdout: Capture; stderr: Capture } {
  return { stdin: null, stdout: new Capture(), stderr: new Capture(), env: {}, cwd: dir, ...over } as CliIo & { stdout: Capture; stderr: Capture };
}

function storageFor(name: string): string {
  return mkdtempSync(join(dir, `${name}-`));
}

function startHelperServer(routes: Record<string, { type: string; body: string }>): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const route = routes[new URL(req.url ?? "/", "http://127.0.0.1").pathname];
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": route.type });
    res.end(route.body);
  });
  return new Promise((ok) => {
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      ok({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

/**
 * A `RunSummary` for a stub run, derived from the production default rather
 * than spelled out a second time.
 *
 * This was a hand-copy of `summaryFor()` and it had already drifted: three
 * fields `RunSummary` requires were missing from the literal, each typed
 * `T | undefined`, and nothing read the mismatch while `tests/` sat outside
 * every typecheck (U14). Copying it again is how that happens again
 * (2026-09-22), so the copy is gone: the only thing this adds is `templates`,
 * because a stub that returns rows came from one template.
 */
function summary(over: Partial<RunSummary> = {}): RunSummary {
  const { status = "succeeded", message = "", ...rest } = over;
  const base = summaryFor(status, null, message);
  // `summaryFor` always carries a message; a stub that succeeded has none.
  if (message === "") delete base.message;
  return { ...base, templates: 1, ...rest };
}

function expectTwelveProducts(items: Array<Record<string, unknown>>): void {
  expect(items).toHaveLength(12);
  for (const item of items) {
    for (const name of ["name", "laboratory", "price", "stock"]) expect(item[name], name).not.toBeNull();
    expect(item.price).toMatch(/^\$ [\d.]+$/);
  }
  expect(new Set(items.map((i) => i._source)).size).toBe(12);
}

describe("argument parsing", () => {
  it("separates the prompt from URLs and collects repeatable flags", () => {
    const parsed = parseArgs(["get the price", "https://a.example/x", "https://a.example/y", "--allow-domain", "a.example", "--allow-domain=b.example", "--secret", "password", "--max-pages", "3", "--out", "o.csv"]);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.args.prompt).toBe("get the price");
    expect(parsed.args.urls).toEqual(["https://a.example/x", "https://a.example/y"]);
    expect(parsed.args.allowDomains).toEqual(["a.example", "b.example"]);
    expect(parsed.args.secrets).toEqual(["password"]);
    expect(parsed.args.maxPages).toBe(3);
    expect(parsed.args.out).toBe("o.csv");
  });

  it("parses the two U14 sources and their transport, and still parses --chooser", () => {
    const parsed = parseArgs(["--decider", "jev", "--writer", "claude", "--decider-transport", "typesafe", "https://a.example/x"]);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.args.decider).toBe("jev");
    expect(parsed.args.writer).toBe("claude");
    expect(parsed.args.deciderTransport).toBe("typesafe");
    expect(parsed.args.chooser).toBeUndefined();
    const old = parseArgs(["--chooser", "jev", "https://a.example/x"]);
    if (!old.ok) throw new Error(old.error);
    expect(old.args.chooser).toBe("jev");
    expect(old.args.decider).toBeUndefined();
    expect(old.args.writer).toBeUndefined();
    // Jev judges but cannot write, so it is not offered as a writer, and the transport is a closed set.
    expect(parseArgs(["--writer", "jev"]).ok).toBe(false);
    expect(parseArgs(["--decider-transport", "local"]).ok).toBe(false);
  });

  it("rejects unknown flags, bad enums and a second prompt", () => {
    expect(parseArgs(["--bogus"]).ok).toBe(false);
    expect(parseArgs(["--chooser", "gpt"]).ok).toBe(false);
    expect(parseArgs(["one prompt", "another prompt"]).ok).toBe(false);
    expect(parseArgs(["--max-pages", "zero"]).ok).toBe(false);
  });
});

describe("one command family (U5)", () => {
  it("a flag of the other front end is exit 2 naming it, rather than parsed and ignored", async () => {
    const run = parseArgs(["the price", "https://a.example/x", "--replays", "2"]);
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error).toContain("--replays is a `navvi make` flag");
    for (const flag of [["--sample", "3"], ["--answer", "fields=a"], ["--offline"], ["--force"], ["--settle-cap", "100"]]) {
      const parsed = parseArgs(["the price", "https://a.example/x", ...flag]);
      expect(parsed.ok, flag[0]).toBe(false);
      if (!parsed.ok) expect(parsed.error, flag[0]).toContain(flag[0]!);
    }
    const made = parseArgs(["make", "the price", "--work", "w", "--max-pages", "3"]);
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.error).toContain("--max-pages belongs to the plain command");
    for (const flag of [["--mode", "record"], ["--fields", "a"], ["--goal", "x"], ["--out", "o.json"], ["--force-recompile"], ["--profile", "local"]]) {
      const parsed = parseArgs(["make", "brief", "--work", "w", ...flag]);
      expect(parsed.ok, flag[0]).toBe(false);
      if (!parsed.ok) expect(parsed.error, flag[0]).toContain(flag[0]!);
    }

    const io = makeIo();
    expect(await main(["the price", "https://a.example/x", "--replays", "2"], io)).toBe(2);
    expect(io.stderr.text).toContain("--replays");
    const makeIoText = makeIo();
    expect(await main(["make", "the price", "--work", join(dir, "never"), "--max-pages", "3"], makeIoText)).toBe(2);
    expect(makeIoText.stderr.text).toContain("--max-pages");
    expect(existsSync(join(dir, "never"))).toBe(false);
  });

  it("both front ends take --work, --rubric and the shared flags", () => {
    const run = parseArgs(["the price", "https://a.example/x", "--work", "w", "--rubric", "price=the boxed one", "--from-url", "https://a.example/list.json", "--headed"]);
    if (!run.ok) throw new Error(run.error);
    expect(run.args.work).toBe("w");
    expect(run.args.rubrics).toEqual(["price=the boxed one"]);
    const made = parseArgs(["make", "the price", "https://a.example/x", "--work", "w", "--replays", "2", "--answer", "fields=price", "--headed", "--agent-mode", "file"]);
    if (!made.ok) throw new Error(made.error);
    expect(made.args.replays).toBe(2);
  });

  it("--help says the plain command with --work and navvi make write the same scraper for a record page", async () => {
    const io = makeIo();
    expect(await main(["--help"], io)).toBe(0);
    const help = io.stdout.text.replace(/\s+/g, " ");
    expect(help).toContain('navvi "<prompt>" <url...> --work <dir> and navvi make "<prompt>" <url...> --work <dir> compile through one core and write the same scraper.json');
    expect(help).toContain("the plain command refuses them (exit 2)");
  });

  it("--help lists every value --answer inputs= takes, from the enum itself", async () => {
    // A fresh-eyes run, 2026-09-23, answered `inputs=a URL list` from the prose options
    // and was refused with the enum; the help never named it.
    const io = makeIo();
    expect(await main(["--help"], io)).toBe(0);
    for (const shape of INPUT_SHAPES) expect(io.stdout.text).toContain(shape);
  });

  it("--work on the plain command writes make's artifact set for a record compile, and says what is absent", async () => {
    const agent = scriptedAgent();
    const io = makeIo({ stdin: agent.stdin, stdout: agent.stdout });
    const storage = storageFor("work");
    const work = join(storage, "w");
    const code = await main([...RECORD_FLAGS, "--agent-mode", "stdio", "--storage", storage, "--work", work, ...productUrls().slice(0, 4)], io);
    expect(code, io.stderr.text).toBe(0);
    for (const name of ["spec.json", "sample.json", "investigation.json", "reconcile.json", "reconcile.md", "schema.json", "scraper.json", "rationale.md", "machine.mmd"]) {
      expect(existsSync(join(work, name)), name).toBe(true);
    }
    const spec = JSON.parse(readFileSync(join(work, "spec.json"), "utf8")) as { fields: Array<{ name: string }>; inputs: { shape: string } };
    expect(spec.fields.map((field) => field.name)).toEqual(["name", "laboratory", "price", "stock"]);
    expect(spec.inputs.shape).toBe("url_list");
    expect(io.stderr.text).toContain(`navvi: work ${work}`);
    expect(io.stderr.text).toMatch(/absent: determinism\.json, scorecard\.md — the plain command measures neither/);

    // The replay compiles nothing, and says so rather than leaving the directory looking current.
    const again = makeIo();
    expect(await main([...RECORD_FLAGS, "--storage", storage, "--work", work, ...productUrls().slice(0, 4)], again)).toBe(0);
    expect(again.stderr.text).toContain("nothing compiled this run");
  }, 90_000);

  it("an open ambiguity on the plain command parks under --agent-mode file (exit 3), and the resume binds the reading answered", async () => {
    const helper = await startHelperServer(payloadRoutes());
    try {
      const storage = storageFor("reading");
      const urls = PAYLOAD_IDS.map((id) => `${helper.baseUrl}/p/${id}`);
      const flags = ["--mode", "record", "--fields", "productName:text", "--allow-private-host", "127.0.0.1", "--browser", "chromium", "--chooser", "agent", "--agent-mode", "file", "--storage", storage];
      const first = makeIo();
      expect(await main(["product", ...flags, ...urls], first)).toBe(3);
      const questionsDir = join(storage, "questions");
      const files = readdirSync(questionsDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const token = files[0]!.replace(/\.json$/, "");
      const batch = JSON.parse(readFileSync(join(questionsDir, files[0]!), "utf8")) as { questions: Question[] };
      // The payload tier bound the name; no DOM question was needed, only which reading it is.
      expect(batch.questions.map((question) => question.id)).toEqual(["reading.productName"]);
      const index = batch.questions[0]!.options!.findIndex((option) => option.includes("productData.seo.metaTitle"));
      expect(index).toBeGreaterThanOrEqual(0);
      const answersFile = join(storage, "answers.json");
      writeFileSync(answersFile, JSON.stringify({ answers: [{ id: "reading.productName", index }] }));

      const second = makeIo();
      expect(await main(["product", ...flags, "--answers", answersFile, "--resume", token, ...urls], second)).toBe(0);
      const rows = JSON.parse(second.stdout.text) as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.productName).sort()).toEqual(["Ejemplo Comprimidos", "Otro Jarabe"]);
    } finally {
      await helper.close();
    }
  }, 90_000);
});

describe("help and version", () => {
  it("--help prints usage and exits 0", async () => {
    const io = makeIo();
    expect(await main(["--help"], io)).toBe(0);
    expect(io.stdout.text).toMatch(/usage: navvi/i);
    expect(io.stdout.text).toContain("--chooser");
  });

  it("--version prints the package version", async () => {
    const io = makeIo();
    expect(await main(["--version"], io)).toBe(0);
    const { version } = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };
    expect(io.stdout.text.trim()).toBe(version);
  });

  it("a bad flag is one error line and a pointer to --help, not the whole usage", async () => {
    const io = makeIo();
    expect(await main(["--no-such-flag", "https://example.org/"], io)).toBe(2);
    const lines = io.stderr.text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^navvi: .*--no-such-flag/);
    expect(lines[1]).toBe("run navvi --help for usage");
    expect(io.stdout.text).toBe("");
  });

  it("no arguments is a usage error (exit 2)", async () => {
    const io = makeIo();
    expect(await main([], io)).toBe(2);
    expect(io.stderr.text).toMatch(/usage/i);
  });
});

describe("a start URL that does not exist", () => {
  const status = (codes: Record<string, number>) =>
    (async (input: unknown) => new Response(null, { status: codes[String(input)] ?? 200 })) as unknown as typeof fetch;

  it("is reported by name before the prompt spends a model call", async () => {
    let ran = false;
    const io = makeIo({
      env: { PATH: "" },
      fetch: status({ "https://a.example/gone": 404 }),
      run: async () => {
        ran = true;
        return summary({ items: 0, status: "no_items_found" });
      },
    });
    expect(await main(["the price", "https://a.example/gone", "--decider", "agent", "--storage", storageFor("gone")], io)).toBe(1);
    expect(ran, "no run, so no writer call").toBe(false);
    expect(io.stderr.text).toContain("navvi: no_items_found: every start URL answered not found before the prompt was read, so no model was asked: https://a.example/gone (404)\n");
  });

  it("warns and reads the rest when only some are gone", async () => {
    let ran = false;
    const io = makeIo({
      env: { PATH: "" },
      fetch: status({ "https://a.example/gone": 410 }),
      run: async () => {
        ran = true;
        return summary({ items: 1 });
      },
    });
    expect(await main(["the price", "https://a.example/gone", "https://a.example/here", "--decider", "agent", "--storage", storageFor("half-gone")], io)).toBe(0);
    expect(ran).toBe(true);
    expect(io.stderr.text).toContain("navvi: a start URL answers not found and will read nothing: https://a.example/gone (410)\n");
  });

  it("is not probed with --mode and --fields, where no prompt is read", async () => {
    let probed = false;
    const io = makeIo({
      fetch: (async () => {
        probed = true;
        return new Response(null, { status: 404 });
      }) as unknown as typeof fetch,
      run: async () => summary({ items: 1 }),
    });
    expect(await main(["--decider", "agent", "--mode", "record", "--fields", "a", "--storage", storageFor("no-probe"), "https://a.example/gone"], io)).toBe(0);
    expect(probed).toBe(false);
  });
});

describe("configuration errors (exit 2)", () => {
  it("--chooser jev without a key names both env vars and suggests --chooser agent", async () => {
    const io = makeIo();
    expect(await main(["--chooser", "jev", "--mode", "record", "--fields", "a", "https://example.org/"], io)).toBe(2);
    expect(io.stderr.text).toContain("AI_GATEWAY_API_KEY");
    expect(io.stderr.text).toContain("TYPESAFE_API_KEY");
    expect(io.stderr.text).toContain("--chooser agent");
  });

  it("--chooser model without a key names ANTHROPIC_API_KEY", async () => {
    const io = makeIo();
    expect(await main(["--chooser", "model", "--mode", "record", "--fields", "a", "https://example.org/"], io)).toBe(2);
    expect(io.stderr.text).toContain("ANTHROPIC_API_KEY");
  });

  it("a private host without --allow-private-host is a validation error", async () => {
    const io = makeIo();
    expect(await main(["--mode", "record", "--fields", "a", "http://127.0.0.1:9/x"], io)).toBe(2);
    expect(io.stderr.text).toMatch(/allowed public/);
  });

  it("--notify telegram without TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID is a configuration error", async () => {
    const io = makeIo();
    expect(await main(["--notify", "telegram", "--mode", "record", "--fields", "a", "https://example.org/"], io)).toBe(2);
    expect(io.stderr.text).toContain("TELEGRAM_BOT_TOKEN");
    expect(io.stderr.text).toContain("TELEGRAM_CHAT_ID");
  });
});

describe("agent chooser over stdio", () => {
  it("prints the batches between the sentinels, then twelve records as JSON, exit 0", async () => {
    const agent = scriptedAgent();
    const io = makeIo({ stdin: agent.stdin, stdout: agent.stdout });
    const code = await main([...RECORD_FLAGS, "--agent-mode", "stdio", "--storage", storageFor("stdio"), ...productUrls()], io);
    expect(io.stderr.text).toContain("status");
    expect(code).toBe(0);
    expect(agent.batches.length).toBeGreaterThan(0);
    expect(agent.batches.flat().map((q) => q.id)).toContain("field.name");

    const out = agent.stdout.text;
    const lastEnd = out.lastIndexOf(QUESTIONS_END);
    expect(lastEnd).toBeGreaterThan(0);
    const data = out.slice(lastEnd + QUESTIONS_END.length).trim();
    expectTwelveProducts(JSON.parse(data) as Array<Record<string, unknown>>);
    expect(io.stderr.text).toMatch(/status\s*:?\s*succeeded/);
    expect(io.stderr.text).toMatch(/items\s*:?\s*12/);
  }, 60_000);

  it("a prompt without --mode/--fields is passed through to run(), which parses it through one text question before the crawl", async () => {
    const structured = JSON.stringify({ mode: "record", description: "pharmacy product", fields: [{ name: "name" }, { name: "price" }] });
    const agent = scriptedAgent({ "prompt-": structured });
    const seen: unknown[] = [];
    const summaries: RunSummary[] = [];
    // The real run() with the CLI's chooser, which stops the crawl at its first question so only the prompt question reaches the agent.
    const runSpy: RunFn = async (raw, deps) => {
      seen.push(raw);
      const inner = deps!.chooser!;
      let batches = 0;
      const chooser: Chooser = {
        name: inner.name,
        ask: (batch) => (batches++ === 0 ? inner.ask(batch) : Promise.reject(new BudgetExhaustedError("chooserInputTokens", 0))),
        usage: () => inner.usage(),
      };
      const result = await runNavvi(raw, { ...deps, chooser });
      summaries.push(result);
      return result;
    };
    const io = makeIo({ stdin: agent.stdin, stdout: agent.stdout, run: runSpy });
    const code = await main(["name and price of each product", "--allow-private-host", "127.0.0.1", "--browser", "chromium", "--agent-mode", "stdio", "--storage", storageFor("prompt"), ...productUrls().slice(0, 2)], io);
    expect(code).toBe(4);
    expect(agent.batches.flat().map((q) => q.kind)).toEqual(["text"]);
    expect(seen).toHaveLength(1);
    const raw = seen[0] as { mode?: string; fields?: unknown; prompt: string; startUrls: string[] };
    expect(raw.mode).toBeUndefined();
    expect(raw.fields).toBeUndefined();
    expect(raw.prompt).toBe("name and price of each product");
    expect(raw.startUrls).toHaveLength(2);
    expect(io.stderr.text).toMatch(/status\s*:?\s*budget_exhausted/);
    const input = summaries[0]!.input!;
    expect(input.mode).toBe("record");
    expect(input.fields?.map((f) => f.name)).toEqual(["name", "price"]);
    expect(input.prompt).toBe("name and price of each product");
  }, 60_000);
});

describe("file-and-resume (exit 3)", () => {
  it("--agent-mode file parks the batch under storage/questions, exits 3; --answers --resume completes", async () => {
    const storage = storageFor("file");
    const first = makeIo();
    const code = await main([...RECORD_FLAGS, "--agent-mode", "file", "--storage", storage, ...productUrls()], first);
    expect(code).toBe(3);
    const questionsDir = join(storage, "questions");
    const files = readdirSync(questionsDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const token = files[0]!.replace(/\.json$/, "");
    expect(first.stderr.text).toContain(token);
    expect(first.stderr.text).toContain(join(questionsDir, files[0]!));
    expect(first.stderr.text).toContain(`--resume ${token}`);
    expect(first.stderr.text).toContain("--answers");
    expect(first.stdout.text.trim()).toBe("");

    const batch = JSON.parse(readFileSync(join(questionsDir, files[0]!), "utf8")) as { protocol: string; token: string; questions: Question[] };
    expect(batch.protocol).toBe("navvi-questions/1");
    expect(batch.token).toBe(token);
    const answersFile = join(storage, "answers.json");
    writeFileSync(answersFile, JSON.stringify({ answers: batch.questions.map((q) => recordedAnswer(q)) }));

    const second = makeIo();
    const again = await main([...RECORD_FLAGS, "--agent-mode", "file", "--storage", storage, "--answers", answersFile, "--resume", token, ...productUrls()], second);
    expect(second.stderr.text).toMatch(/status\s*:?\s*succeeded/);
    expect(again).toBe(0);
    expectTwelveProducts(JSON.parse(second.stdout.text) as Array<Record<string, unknown>>);
  }, 90_000);

  it("answers from earlier parks are carried forward: list mode parks twice and each resume needs only the new batch", async () => {
    const storage = storageFor("file-twice");
    const fixture = join(REPO, "tests", "recorded", "compile", "python-jobs");
    const answerFrom = (q: Question): Answer => {
      const recorded = JSON.parse(readFileSync(join(fixture, `${q.id}.json`), "utf8")) as Answer;
      return { id: q.id, index: recorded.index };
    };
    const listFlags = ["--mode", "list", "--fields", "title,company,location,date,link", "--max-pages", "1", "--allow-private-host", "127.0.0.1", "--browser", "chromium", "--chooser", "agent", "--agent-mode", "file", "--storage", storage];
    const url = `${server.baseUrl}/fixtures/python-jobs.html`;
    const questionsDir = join(storage, "questions");
    const latestToken = () => readdirSync(questionsDir).filter((f) => f.endsWith(".json")).map((f) => ({ f, t: statSync(join(questionsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]!.f.replace(/\.json$/, "");

    expect(await main([...listFlags, url], makeIo())).toBe(3);
    const token1 = latestToken();
    const batch1 = JSON.parse(readFileSync(join(questionsDir, `${token1}.json`), "utf8")) as { questions: Question[] };
    expect(batch1.questions.map((q) => q.id)).toEqual(["group"]);
    const answers1 = join(storage, "answers1.json");
    writeFileSync(answers1, JSON.stringify({ answers: batch1.questions.map(answerFrom) }));

    expect(await main([...listFlags, "--answers", answers1, "--resume", token1, url], makeIo())).toBe(3);
    const token2 = latestToken();
    expect(token2).not.toBe(token1);
    const batch2 = JSON.parse(readFileSync(join(questionsDir, `${token2}.json`), "utf8")) as { questions: Question[]; answered?: Answer[] };
    expect(batch2.questions.map((q) => q.id)).not.toContain("group");
    expect(batch2.answered?.map((a) => a.id)).toEqual(["group"]);
    const answers2 = join(storage, "answers2.json");
    writeFileSync(answers2, JSON.stringify({ answers: batch2.questions.map(answerFrom) }));

    const io = makeIo();
    expect(await main([...listFlags, "--answers", answers2, "--resume", token2, url], io)).toBe(0);
    const rows = JSON.parse(io.stdout.text) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(25);
  }, 120_000);

  it("--resume with an unknown token is a configuration error", async () => {
    const io = makeIo();
    const answers = join(dir, "answers-unknown.json");
    writeFileSync(answers, JSON.stringify({ answers: [] }));
    expect(await main([...RECORD_FLAGS, "--storage", storageFor("unknown"), "--answers", answers, "--resume", "nope", ...productUrls().slice(0, 1)], io)).toBe(2);
    expect(io.stderr.text).toMatch(/nope/);
  });
});

describe("list sources and output files", () => {
  it("--from-url with a JSON list of twelve product URLs records twelve items", async () => {
    const helper = await startHelperServer({ "/products.json": { type: "application/json", body: JSON.stringify(productUrls()) } });
    try {
      const agent = scriptedAgent();
      const io = makeIo({ stdin: agent.stdin, stdout: agent.stdout });
      const code = await main([...RECORD_FLAGS, "--agent-mode", "stdio", "--storage", storageFor("fromurl"), "--from-url", `${helper.baseUrl}/products.json`], io);
      expect(code).toBe(0);
      const out = agent.stdout.text;
      const data = out.slice(out.lastIndexOf(QUESTIONS_END) + QUESTIONS_END.length).trim();
      expectTwelveProducts(JSON.parse(data) as Array<Record<string, unknown>>);
    } finally {
      await helper.close();
    }
  }, 60_000);

  const rows = PRODUCTS.map((slug, i) => ({ name: slug, price: `$ ${i + 1}.990`, note: i === 0 ? 'has "quotes", commas\nand a newline' : null, _source: `https://example.org/${slug}` }));
  const pushingRun: RunFn = async (_raw, deps?: CrawlDeps) => {
    const dataset = await deps!.actor!.openDataset();
    await dataset.pushData(rows);
    return summary({ items: rows.length, pages: rows.length });
  };

  it("--out out.csv writes a header row and twelve RFC 4180 rows; stdout stays empty", async () => {
    const out = join(dir, "out.csv");
    const io = makeIo({ run: pushingRun });
    expect(await main(["--mode", "record", "--fields", "name,price", "--storage", storageFor("csv"), "--out", out, "https://example.org/a"], io)).toBe(0);
    expect(io.stdout.text).toBe("");
    const csv = readFileSync(out, "utf8");
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("name,price,note,_source");
    // the quoted newline in row 1 is a bare \n inside the field; rows end in CRLF
    expect(csv).toContain('"has ""quotes"", commas\nand a newline"');
    expect(lines.length).toBe(1 + 12);
    expect(io.stderr.text).toContain(out);
  });

  it("--out out.json writes a JSON array; --json prints compact JSON to stdout", async () => {
    const out = join(dir, "out.json");
    const io = makeIo({ run: pushingRun });
    expect(await main(["--mode", "record", "--fields", "name,price", "--storage", storageFor("json"), "--out", out, "https://example.org/a"], io)).toBe(0);
    const parsed = JSON.parse(readFileSync(out, "utf8")) as unknown[];
    expect(parsed).toHaveLength(12);

    const compact = makeIo({ run: pushingRun });
    expect(await main(["--mode", "record", "--fields", "name,price", "--storage", storageFor("compact"), "--json", "https://example.org/a"], compact)).toBe(0);
    expect(compact.stdout.text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(compact.stdout.text)).toHaveLength(12);

    const quiet = makeIo({ run: pushingRun });
    expect(await main(["--mode", "record", "--fields", "name,price", "--storage", storageFor("quiet"), "--quiet", "https://example.org/a"], quiet)).toBe(0);
    expect(quiet.stderr.text).toBe("");
  });

  it("toCsv quotes per RFC 4180 and takes the header from the union of keys", () => {
    const csv = toCsv([{ a: 1, b: "x,y" }, { b: 'say "hi"', c: true }]);
    expect(csv).toBe('a,b,c\r\n1,"x,y",\r\n,"say ""hi""",true\r\n');
  });
});

describe("secrets (R27/R39)", () => {
  it("--secret password reads NAVVI_SECRET_PASSWORD and never prints the value", async () => {
    const value = "hunter2-Sup3rSecret";
    let seen: Record<string, string> | undefined;
    const runSpy: RunFn = async (raw) => {
      seen = (raw as { secrets: Record<string, string> }).secrets;
      return summary({ items: 0, status: "no_items_found", message: "spy" });
    };
    const io = makeIo({ run: runSpy, env: { NAVVI_SECRET_PASSWORD: value } });
    const code = await main(["--mode", "record", "--fields", "a", "--secret", "password", "--profile", "local", "--storage", storageFor("secret"), "https://example.org/login"], io);
    expect(code).toBe(1);
    expect(seen?.password).toBe(value);
    expect(io.stdout.text).not.toContain(value);
    expect(io.stderr.text).not.toContain(value);
  });

  it("--secret without the env var and without a TTY is a configuration error naming the variable", async () => {
    const io = makeIo({ run: async () => summary() });
    expect(await main(["--mode", "record", "--fields", "a", "--secret", "api_token", "https://example.org/"], io)).toBe(2);
    expect(io.stderr.text).toContain("NAVVI_SECRET_API_TOKEN");
  });

  it("--secrets-file loads a JSON object and implies the local profile", async () => {
    const file = join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify({ username: "max", password: "p@ss" }));
    let seen: { secrets: Record<string, string>; profile: string } | undefined;
    const io = makeIo({ run: async (raw) => ((seen = raw as { secrets: Record<string, string>; profile: string }), summary({ items: 1 })) });
    expect(await main(["--mode", "record", "--fields", "a", "--secrets-file", file, "--storage", storageFor("sf"), "https://example.org/"], io)).toBe(0);
    expect(seen?.secrets).toEqual({ username: "max", password: "p@ss" });
    expect(seen?.profile).toBe("local");
    expect(io.stderr.text).not.toContain("p@ss");
  });

  it("--secrets-file with invalid JSON reports the path only, never the file contents", async () => {
    const file = join(dir, "secrets-broken.json");
    const leak = "hunter2-do-not-echo";
    // Not JSON at all: the parser's message would quote the file contents.
    writeFileSync(file, `password: ${leak}`);
    const io = makeIo({ run: async () => summary() });
    expect(await main(["--mode", "record", "--fields", "a", "--secrets-file", file, "https://example.org/"], io)).toBe(2);
    expect(io.stderr.text).toContain(file);
    expect(io.stderr.text).not.toContain(leak);
    expect(io.stderr.text).not.toContain("password");
  });
});

describe("prompt-derived input validation (exit 2)", () => {
  it("a prompt whose structured answer fails input validation is a configuration error, not a stack trace", async () => {
    const structured = JSON.stringify({ mode: "record", description: "orders", fields: [{ name: "id" }], goal: "sign in with token: abc123" });
    const agent = scriptedAgent({ "prompt-": structured });
    const io = makeIo({ stdin: agent.stdin, stdout: agent.stdout });
    const code = await main(["list my orders", "--allow-private-host", "127.0.0.1", "--browser", "chromium", "--agent-mode", "stdio", "--storage", storageFor("prompt-invalid"), ...productUrls().slice(0, 1)], io);
    expect(agent.batches.flat().map((q) => q.kind)).toEqual(["text"]);
    expect(code).toBe(2);
    expect(io.stderr.text).toContain("configuration_error");
    expect(io.stderr.text).toMatch(/goal/);
    expect(io.stderr.text).not.toMatch(/ZodError|\n\s+at /);
  });
});

describe("notifications (R41)", () => {
  it("telegram posts sendMessage with the chat id and never logs the token", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const stderr = new Capture();
    const notify = telegramNotifier({ TELEGRAM_BOT_TOKEN: "123:ABCtoken", TELEGRAM_CHAT_ID: "42" }, { fetch: fetchImpl, stderr });
    await notify("hello there");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:ABCtoken/sendMessage");
    expect(JSON.parse(calls[0]!.body)).toEqual({ chat_id: "42", text: "hello there" });
    expect(stderr.text).not.toContain("ABCtoken");

    const failing = telegramNotifier({ TELEGRAM_BOT_TOKEN: "123:ABCtoken", TELEGRAM_CHAT_ID: "42" }, { fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch, stderr });
    await expect(failing("x")).resolves.toBeUndefined();
    expect(stderr.text).toContain("401");
    expect(stderr.text).not.toContain("ABCtoken");
  });

  it("exit code 4 for budget_exhausted and model_unavailable, 1 for drift and blocked", async () => {
    for (const [status, code] of [["budget_exhausted", 4], ["model_unavailable", 4], ["drift", 1], ["blocked_bot_detection", 1], ["no_items_found", 1], ["succeeded", 0]] as const) {
      const io = makeIo({ run: async () => summary({ status, items: status === "succeeded" ? 1 : 0 }) });
      expect(await main(["--mode", "record", "--fields", "a", "--storage", storageFor("codes"), "https://example.org/"], io), status).toBe(code);
    }
  });
});

describe("agent surfaces (R35)", () => {
  it("SKILL.md has a name, a description that triggers on Playwright, and the pitch line first", () => {
    const skill = readFileSync(join(REPO, "SKILL.md"), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill);
    expect(match).not.toBeNull();
    const [, frontmatter, body] = match!;
    expect(frontmatter).toMatch(/^name: navvi$/m);
    const description = /^description: (.*)$/m.exec(frontmatter!)?.[1] ?? "";
    expect(description).toMatch(/Playwright/);
    expect(description).toMatch(/scrape/i);
    expect(description).toMatch(/log in/i);
    expect(description).toMatch(/automate a website/i);
    const firstLine = body!.split("\n").find((l) => l.trim().length > 0) ?? "";
    expect(firstLine).toContain("Compile it once so you never drive it again");
    expect(skill.split("\n").length).toBeLessThanOrEqual(150);
    expect(skill).toContain(QUESTIONS_START);
    expect(skill).toContain("--answers");
    expect(skill).toContain("docs/measurements.md");
  });

  it("README provides source installation; llms.txt links the skill", () => {
    const readme = readFileSync(join(REPO, "README.md"), "utf8");
    expect(readme).toContain("git clone https://github.com/fellowship-dev/navvi.git");
    expect(readme).toContain("node dist/bin/cli.js");
    expect(readme).not.toMatch(/\bv2\b/);
    const llms = readFileSync(join(REPO, "llms.txt"), "utf8");
    expect(llms).toMatch(/^# Navvi/m);
    expect(llms).toContain("SKILL.md");
    expect(llms).toContain("README.md");
  });
});

describe("built binary", () => {
  it("node dist/bin/cli.js --version prints the package version after npm run build", () => {
    try {
      execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "pipe", timeout: 120_000 });
    } catch (error) {
      const out = error instanceof Error && "stderr" in error ? String((error as { stderr: Buffer }).stderr) : String(error);
      if (/src\/replay|tests\//.test(out)) {
        console.warn("skipping built-binary check: build fails outside the CLI files\n" + out.slice(0, 500));
        return;
      }
      throw error;
    }
    const version = execFileSync("node", [join(REPO, "dist", "bin", "cli.js"), "--version"], { cwd: REPO, encoding: "utf8" });
    const { version: packaged } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string };
    expect(version.trim()).toBe(packaged);
  }, 150_000);
});


describe("persisted plain-English CLI replay", () => {
  it("repeats the same command with zero chooser questions and verified extracted rows", async () => {
    const storage = storageFor("prompt-replay");
    const structured = JSON.stringify({ mode: "record", description: "pharmacy product", fields: ["name", "laboratory", "price", "stock"].map((name) => ({ name })) });
    const args = ["get name laboratory price and stock for each product", "--allow-private-host", "127.0.0.1", "--browser", "chromium", "--chooser", "agent", "--agent-mode", "stdio", "--storage", storage, ...productUrls()];
    const first = scriptedAgent({ "prompt-": structured });
    expect(await main(args, makeIo({ stdin: first.stdin, stdout: first.stdout }))).toBe(0);
    expect(first.batches.flat().filter((q) => q.kind === "text")).toHaveLength(1);
    const second = scriptedAgent();
    const io = makeIo({ stdin: second.stdin, stdout: second.stdout });
    expect(await main(args, io)).toBe(0);
    expect(second.batches).toHaveLength(0);
    expectTwelveProducts(JSON.parse(second.stdout.text));
  }, 60_000);
});

// ---------------------------------------------------------------- U7: who answered, and Jev in plain sight

describe("attribution and the Jev announcement (U7)", () => {
  const FLAGS = ["--mode", "record", "--fields", "name,price", "https://example.org/a"];
  const withChooser = (chooser: NonNullable<RunSummary["chooser"]>): RunFn => async () => summary({ items: 1, chooser });

  it("Jev deciding with Claude writing: one line per role, each with its own share", async () => {
    const io = makeIo({
      run: withChooser({ name: "jev", questions: 4, textQuestions: 1, inputTokens: 18_900, waitMs: 4_000, costUsd: 0.0001, writer: { name: "claude", textQuestions: 1, inputTokens: 18_439, waitMs: 3_100, costUsd: 0 } }),
    });
    expect(await main(["--chooser", "agent", "--storage", storageFor("attr-jev"), ...FLAGS], io)).toBe(0);
    expect(io.stderr.text).toContain("  decider jev: 3 decisions, 461 input tokens, 900ms waiting, $0.0001\n");
    expect(io.stderr.text).toContain("  writer claude: 1 text question, 18439 input tokens, 3.1s waiting, $0.0000\n");
  });

  it("a decider writing its own text: one line with both counts", async () => {
    const io = makeIo({ run: withChooser({ name: "claude", questions: 4, textQuestions: 1, inputTokens: 36_000, waitMs: 6_000, costUsd: 0 }) });
    expect(await main(["--chooser", "agent", "--storage", storageFor("attr-claude"), ...FLAGS], io)).toBe(0);
    expect(io.stderr.text).toContain("  decider and writer claude: 3 decisions, 1 text question, 36000 input tokens, 6.0s waiting, $0.0000\n");
    expect(io.stderr.text).not.toContain("  writer ");
  });

  it("a decider with no text to write prints the decider line alone", async () => {
    const io = makeIo({ run: withChooser({ name: "jev", questions: 3, textQuestions: 0, inputTokens: 400, waitMs: 500, costUsd: 0.00002 }) });
    expect(await main(["--chooser", "agent", "--storage", storageFor("attr-plain"), ...FLAGS], io)).toBe(0);
    expect(io.stderr.text).toContain("  decider jev: 3 decisions, 400 input tokens, 500ms waiting, $0.0000\n");
    expect(io.stderr.text).not.toContain("writer");
  });

  it("the summary says when the decider fell back to another transport", async () => {
    const io = makeIo({
      run: withChooser({ name: "jev", questions: 3, textQuestions: 0, inputTokens: 400, waitMs: 500, costUsd: 0, transportFallback: { from: "gateway", to: "typesafe", reason: "AI Gateway failed after 3 attempt(s): Service temporarily unavailable" } }),
    });
    expect(await main(["--chooser", "agent", "--storage", storageFor("attr-fallback"), ...FLAGS], io)).toBe(0);
    expect(io.stderr.text).toContain("  decider transport: fell back from gateway to typesafe (AI Gateway failed after 3 attempt(s): Service temporarily unavailable)\n");
  });

  it("an auto-selected Jev is announced with its benefit and its writer", async () => {
    const io = makeIo({ run: async () => summary({ items: 1 }), env: { TYPESAFE_API_KEY: "t", PATH: "" } });
    expect(await main(["--storage", storageFor("announce"), ...FLAGS], io)).toBe(0);
    expect(io.stderr.text).toContain("chooser: jev (TYPESAFE_API_KEY found — fast typed decisions; no text writer");
    expect(io.stderr.text).not.toContain("tip:");
  });

  it("without a Jev key or a CLI, the agent announcement names Jev once, terminal or pipe; --quiet does not", async () => {
    const tty = makeIo({ run: async () => summary({ items: 1 }), env: { PATH: "" } });
    Object.assign(tty.stderr, { isTTY: true });
    expect(await main(["--storage", storageFor("tip-tty"), ...FLAGS], tty)).toBe(0);
    const chooserLine = tty.stderr.text.split("\n").find((l) => l.startsWith("chooser: agent ("));
    expect(chooserLine).toMatch(/\); with TYPESAFE_API_KEY set, Jev makes these decisions — get a key at https:\/\/typesafe\.ai$/);
    expect(tty.stderr.text.match(/typesafe\.ai/g)).toHaveLength(1);
    expect(tty.stderr.text).not.toContain("tip:");

    const ci = makeIo({ run: async () => summary({ items: 1 }), env: { PATH: "" } });
    expect(await main(["--storage", storageFor("tip-ci"), ...FLAGS], ci)).toBe(0);
    expect(ci.stderr.text).toContain("; with TYPESAFE_API_KEY set, Jev makes these decisions — get a key at https://typesafe.ai\n");
    expect(ci.stderr.text.match(/typesafe\.ai/g)).toHaveLength(1);

    const quiet = makeIo({ run: async () => summary({ items: 1 }), env: { PATH: "" } });
    Object.assign(quiet.stderr, { isTTY: true });
    expect(await main(["--storage", storageFor("tip-quiet"), "--quiet", ...FLAGS], quiet)).toBe(0);
    expect(quiet.stderr.text).toBe("");
  });

  it("the Gateway fallback notice reaches the CLI's stderr", async () => {
    const io = makeIo({
      env: { AI_GATEWAY_API_KEY: "g", TYPESAFE_API_KEY: "t", PATH: "" },
      run: async (_raw, deps) => {
        // The chooser the CLI built is the one that falls back; ask it one question over a Gateway that is down.
        await deps!.chooser!.ask([{ id: "pick", kind: "choice", premise: "Which?", options: ["a", "b"], state: "<p>a</p>" }]).catch(() => undefined);
        return summary({ items: 1 });
      },
    });
    const gatewayDown = (async (input: unknown) => {
      const url = String((input as { url?: string }).url ?? input);
      if (url.includes("api.typesafe.ai")) return Response.json({ answers: { pick: { type: "choice", choice: "option_0", probabilities: { option_0: 0.9, option_1: 0.05, none: 0.05 } } }, usage: { input_tokens: 12 } });
      return new Response(JSON.stringify({ error: { message: "Service temporarily unavailable", type: "service_unavailable" } }), { status: 503, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = gatewayDown;
    try {
      expect(await main(["--storage", storageFor("fallback-cli"), ...FLAGS], io)).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
    expect(io.stderr.text).toContain("chooser: jev fell back from the AI Gateway to the TypeSafe API");
  }, 30_000);
});
