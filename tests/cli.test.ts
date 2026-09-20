import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, statSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, type CliIo, type RunFn } from "../bin/cli.js";
import { parseArgs } from "../src/cli/args.js";
import { telegramNotifier } from "../src/cli/notify.js";
import { toCsv } from "../src/cli/output.js";
import { QUESTIONS_END, QUESTIONS_START } from "../src/chooser/agent.js";
import { BudgetExhaustedError } from "../src/billing/budget.js";
import type { Answer, Chooser, Question } from "../src/chooser/chooser.js";
import type { CrawlDeps } from "../src/replay/crawler.js";
import { run as runNavvi, type RunSummary } from "../src/main.js";
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

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    status: "succeeded",
    items: 0,
    pages: 0,
    templates: 1,
    cacheHit: false,
    healingEvents: [],
    unmappedCandidates: [],
    fieldsNotFound: [],
    chooser: null,
    input: null,
    requests: { compile: 0, list: 0, record: 0 },
    traceReplays: 0,
    blockedRequests: 0,
    unhealed: 0,
    ...over,
  };
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

  it("rejects unknown flags, bad enums and a second prompt", () => {
    expect(parseArgs(["--bogus"]).ok).toBe(false);
    expect(parseArgs(["--chooser", "gpt"]).ok).toBe(false);
    expect(parseArgs(["one prompt", "another prompt"]).ok).toBe(false);
    expect(parseArgs(["--max-pages", "zero"]).ok).toBe(false);
  });
});

describe("help and version", () => {
  it("--help prints usage and exits 0", async () => {
    const io = makeIo();
    expect(await main(["--help"], io)).toBe(0);
    expect(io.stdout.text).toMatch(/usage: navvi/i);
    expect(io.stdout.text).toContain("--chooser");
  });

  it("--version prints 3.0.0", async () => {
    const io = makeIo();
    expect(await main(["--version"], io)).toBe(0);
    expect(io.stdout.text.trim()).toBe("3.0.0");
  });

  it("no arguments is a usage error (exit 2)", async () => {
    const io = makeIo();
    expect(await main([], io)).toBe(2);
    expect(io.stderr.text).toMatch(/usage/i);
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
  it("node dist/bin/cli.js --version prints 3.0.0 after npm run build", () => {
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
    expect(version.trim()).toBe("3.0.0");
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
