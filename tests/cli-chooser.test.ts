import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actor } from "apify";
import { MemoryStorage } from "crawlee";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigurationError, InvalidAnswerError, type Question } from "../src/chooser/chooser.js";
import { CliChooser, extractJsonObject, probeCli, readCodexEvents, renderPrompt, resetProbeCache, type CliRunResult, type CliRunner } from "../src/chooser/cli.js";
import { createChooser, resolveDefaultChooser } from "../src/chooser/index.js";
import { Budget, ModelUnavailableError } from "../src/billing/budget.js";
import { defaultChooser } from "../src/input/schema.js";
import { run } from "../src/main.js";
import type { CrawlDeps } from "../src/replay/crawler.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * The claude and codex choosers: an installed, signed-in coding CLI answers
 * on the user's subscription. Fake runners stand in for the processes; the
 * one live smoke (NAVVI_LIVE_CLI=1) drives the pharmacy demo through the real
 * `claude -p`.
 */

const STATE = "<article><h1>Paracetamol 500 mg</h1><p class=lab>Laboratorio: Chile</p><span class=precio>$ 1.990</span></article>";

function batch(): Question[] {
  return [
    { id: "field.name", kind: "choice", premise: "Which candidate holds the product name?", options: ["h1", "p.lab", "span.precio"], state: STATE },
    { id: "consent", kind: "boolean", premise: "Is a consent banner visible?", state: STATE },
    { id: "label", kind: "text", premise: "Write a two-word label for the page.", state: STATE, maxLength: 40 },
  ];
}

const GOOD_ANSWERS = { answers: [{ id: "field.name", index: 0 }, { id: "consent", index: 0 }, { id: "label", index: null, text: "product page" }] };

type Call = { cmd: string; args: string[]; input: string | undefined };

const PRODUCTS = [
  "amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema", "diclofenaco-gel", "ibuprofeno-400-mg", "loratadina-10-mg",
  "losartan-50-mg", "metformina-850-mg", "omeprazol-20-mg", "paracetamol-500-mg", "salbutamol-inhalador", "vitamina-c-1-g",
];
const FIELDS = ["name", "laboratory", "price", "stock"];

/** A runner scripted by command: `claude` and `codex` calls pop the next reply; `command -v` answers `which`. */
function fakeRunner(replies: Array<Partial<CliRunResult>>, installed: string[] = ["claude", "codex"]): CliRunner & { calls: Call[] } {
  const calls: Call[] = [];
  const runner = (async (cmd: string, args: string[], input?: string) => {
    calls.push({ cmd, args, input });
    if (cmd === "command") {
      const name = args[1]!;
      return installed.includes(name) ? { code: 0, stdout: `/usr/local/bin/${name}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "--version") return { code: 0, stdout: `${cmd} 9.9.9\n`, stderr: "" };
    const next = replies.shift();
    if (!next) throw new Error("fake runner: no reply scripted");
    return { code: 0, stdout: "", stderr: "", ...next };
  }) as CliRunner & { calls: Call[] };
  runner.calls = calls;
  return runner;
}

const claudeEnvelope = (result: string, costUsd = 0.0123): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: costUsd, duration_ms: 1800, usage: { input_tokens: 900, output_tokens: 60 } });

const codexJsonl = (text: string): string =>
  [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join("\n") + "\n";

const CODEX_AUTH_FAILURE =
  [
    JSON.stringify({ type: "thread.started", thread_id: "t2" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "error", message: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again." }),
    JSON.stringify({ type: "turn.failed", error: { message: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again." } }),
  ].join("\n") + "\n";

describe("prompt rendering and reply parsing", () => {
  it("renders the answer shape, the state and every question with indexed options and none last", () => {
    const prompt = renderPrompt(batch());
    expect(prompt.startsWith("Reply with JSON only")).toBe(true);
    expect(prompt).toContain('{"answers":[{"id":"<question id>"');
    expect(prompt).toContain(`STATE:\n${STATE}`);
    expect(prompt).toContain("[field.name] choice: Which candidate holds the product name?\n  0: h1\n  1: p.lab\n  2: span.precio\n  null: none");
    expect(prompt).toContain("[consent] boolean:");
    expect(prompt).toContain("[label] text:");
  });

  it("extracts the first JSON object from fences, prose and nested braces", () => {
    expect(extractJsonObject('Sure! ```json\n{"answers":[{"id":"a","index":1}]}\n```')).toEqual({ answers: [{ id: "a", index: 1 }] });
    expect(extractJsonObject('{"a":"br{ace}","b":{"c":[1,2]}} trailing {"x":1}')).toEqual({ a: "br{ace}", b: { c: [1, 2] } });
    expect(extractJsonObject("{ not json } {\"ok\":true}")).toEqual({ ok: true });
    expect(extractJsonObject("no object here")).toBeUndefined();
  });

  it("reads codex JSONL: the agent message, completion and errors; plain stdout is the fallback", () => {
    expect(readCodexEvents(codexJsonl("hello"))).toEqual({ text: "hello", completed: true, error: undefined });
    const failed = readCodexEvents(CODEX_AUTH_FAILURE);
    expect(failed.completed).toBe(false);
    expect(failed.error).toContain("sign in");
    expect(readCodexEvents('{"answers":[]}\n')).toEqual({ text: '{"answers":[]}', completed: false, error: undefined });
  });
});

describe("claude chooser", () => {
  it("answers a choice, boolean and text batch through claude -p --output-format json and reports subscription usage", async () => {
    const runner = fakeRunner([{ stdout: claudeEnvelope("```json\n" + JSON.stringify(GOOD_ANSWERS) + "\n```", 0.0123) }]);
    const chooser = new CliChooser("claude", { runner, env: {} });
    const answers = await chooser.ask(batch());
    expect(answers).toEqual([
      { id: "field.name", index: 0 },
      { id: "consent", index: 0 },
      { id: "label", index: null, text: "product page" },
    ]);
    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.cmd).toBe("claude");
    expect(call.args[0]).toBe("-p");
    expect(call.args[1]).toContain("Reply with JSON only");
    expect(call.args.slice(2)).toEqual(["--output-format", "json", "--model", "haiku"]);
    expect(call.input).toBeUndefined();
    const usage = chooser.usage();
    expect(usage.chooser).toBe("claude");
    expect(usage.questions).toBe(3);
    expect(usage.textQuestions).toBe(1);
    expect(usage.batches).toBe(1);
    expect(usage.inputTokens).toBe(900);
    expect(usage.costUsd).toBe(0);
    expect(usage.billing).toBe("subscription");
    expect(usage.reportedCostUsd).toBeCloseTo(0.0123, 6);
  });

  it("honours NAVVI_CLAUDE_MODEL and an explicit model option", async () => {
    const runner = fakeRunner([{ stdout: claudeEnvelope(JSON.stringify(GOOD_ANSWERS)) }, { stdout: claudeEnvelope(JSON.stringify(GOOD_ANSWERS)) }]);
    await new CliChooser("claude", { runner, env: { NAVVI_CLAUDE_MODEL: "sonnet" } }).ask(batch());
    await new CliChooser("claude", { runner, env: { NAVVI_CLAUDE_MODEL: "sonnet" }, model: "opus" }).ask(batch());
    expect(runner.calls[0]!.args.slice(-2)).toEqual(["--model", "sonnet"]);
    expect(runner.calls[1]!.args.slice(-2)).toEqual(["--model", "opus"]);
  });

  it("estimates input tokens from the prompt when the envelope has no usage", async () => {
    const runner = fakeRunner([{ stdout: JSON.stringify({ type: "result", result: JSON.stringify(GOOD_ANSWERS) }) }]);
    const chooser = new CliChooser("claude", { runner, env: {} });
    await chooser.ask(batch());
    const usage = chooser.usage();
    expect(usage.inputTokens).toBeGreaterThan(50);
    expect(usage.reportedCostUsd).toBe(0);
  });

  it("re-asks once on a reply without JSON, then fails model_unavailable with the invalid answers as cause", async () => {
    const runner = fakeRunner([{ stdout: claudeEnvelope("I cannot answer that.") }, { stdout: claudeEnvelope("Still no.") }]);
    const chooser = new CliChooser("claude", { runner, env: {} });
    const err = await chooser.ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).cause).toBeInstanceOf(InvalidAnswerError);
    expect(runner.calls).toHaveLength(2);
  });

  it("a wrong index on the first reply is asked again and accepted on the second", async () => {
    const first = { answers: [{ id: "field.name", index: 7 }, { id: "consent", index: 0 }, { id: "label", index: null, text: "product page" }] };
    const second = { answers: [{ id: "field.name", index: 0 }] };
    const runner = fakeRunner([{ stdout: claudeEnvelope(JSON.stringify(first)) }, { stdout: claudeEnvelope(JSON.stringify(second)) }]);
    const answers = await new CliChooser("claude", { runner, env: {} }).ask(batch());
    expect(answers[0]).toEqual({ id: "field.name", index: 0 });
    expect(runner.calls[1]!.args[1]).toContain("[field.name]");
    expect(runner.calls[1]!.args[1]).not.toContain("[consent]");
  });

  it("a non-zero exit mentioning sign-in is a configuration error naming `claude`", async () => {
    const runner = fakeRunner([{ code: 1, stdout: "", stderr: "Not logged in. Please run `claude` and authenticate." }]);
    const err = await new CliChooser("claude", { runner, env: {} }).ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as Error).message).toContain("run `claude`");
  });

  it("an is_error envelope without a sign-in hint is model_unavailable, not configuration", async () => {
    const runner = fakeRunner([{ code: 1, stdout: JSON.stringify({ type: "result", is_error: true, result: "rate limit reached" }), stderr: "" }]);
    const err = await new CliChooser("claude", { runner, env: {}, backoffMs: [0] }).ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as Error).message).toContain("rate limit");
  });

  it("a slow harness is model_unavailable after the batch timeout", async () => {
    const runner: CliRunner = () => new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: "", stderr: "" }), 200));
    const err = await new CliChooser("claude", { runner, env: {}, timeoutMs: 20 }).ask(batch().slice(0, 2)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as Error).message).toContain("no reply within 20 ms");
  });

  it("a batch that asks for text gets the longer text ceiling, a choice batch keeps the short one", async () => {
    // Found live, 2026-09-23: make's spec draft is one long text answer; Claude Code
    // took ~30 s on a quiet machine and past the 60 s choice ceiling on a busy one.
    const slow: CliRunner = () => new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: claudeEnvelope(JSON.stringify({ answers: [{ id: "label", index: null, text: "a label" }] })), stderr: "" }), 60));
    const text: Question[] = [{ id: "label", kind: "text", premise: "Write a label.", state: STATE, maxLength: 40 }];
    const answers = await new CliChooser("claude", { runner: slow, env: {}, timeoutMs: 20, textTimeoutMs: 500 }).ask(text);
    expect(answers[0]!.text).toBe("a label");
    const err = await new CliChooser("claude", { runner: slow, env: {}, timeoutMs: 20, textTimeoutMs: 500, backoffMs: [0] }).ask(batch().slice(0, 1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
  });

  it("NAVVI_CLI_TIMEOUT_MS sets both ceilings for a machine the defaults do not fit", async () => {
    const slow: CliRunner = () => new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: claudeEnvelope(JSON.stringify({ answers: [{ id: "label", index: null, text: "a label" }] })), stderr: "" }), 60));
    const text: Question[] = [{ id: "label", kind: "text", premise: "Write a label.", state: STATE, maxLength: 40 }];
    const err = await new CliChooser("claude", { runner: slow, env: { NAVVI_CLI_TIMEOUT_MS: "20" }, backoffMs: [0] }).ask(text).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as Error).message).toContain("no reply within 20 ms");
  });

  it("a very long prompt travels on stdin instead of argv", async () => {
    const runner = fakeRunner([{ stdout: claudeEnvelope(JSON.stringify({ answers: [{ id: "q", index: 0 }] })) }]);
    const state = "x".repeat(70_000);
    await new CliChooser("claude", { runner, env: {} }).ask([{ id: "q", kind: "choice", premise: "pick", options: ["a"], state }]);
    const call = runner.calls[0]!;
    expect(call.args).toEqual(["-p", "--output-format", "json", "--model", "haiku"]);
    expect(call.input).toContain("QUESTIONS:");
  });
});

describe("codex chooser", () => {
  it("answers through codex exec --json, reading the agent_message item", async () => {
    const runner = fakeRunner([{ stdout: codexJsonl(JSON.stringify(GOOD_ANSWERS)) }]);
    const chooser = new CliChooser("codex", { runner, env: {} });
    const answers = await chooser.ask(batch());
    expect(answers.map((a) => a.index)).toEqual([0, 0, null]);
    const call = runner.calls[0]!;
    expect(call.cmd).toBe("codex");
    expect(call.args.slice(0, 5)).toEqual(["exec", "--skip-git-repo-check", "-s", "read-only", "--json"]);
    expect(call.args[5]).toContain("Reply with JSON only");
    expect(call.args).toHaveLength(6);
    expect(chooser.usage().billing).toBe("subscription");
    expect(chooser.usage().costUsd).toBe(0);
  });

  it("NAVVI_CODEX_MODEL adds -m; unset adds nothing", async () => {
    const runner = fakeRunner([{ stdout: codexJsonl(JSON.stringify(GOOD_ANSWERS)) }]);
    await new CliChooser("codex", { runner, env: { NAVVI_CODEX_MODEL: "gpt-5-codex" } }).ask(batch());
    expect(runner.calls[0]!.args.slice(5, 7)).toEqual(["-m", "gpt-5-codex"]);
  });

  it("a plain non-JSON stdout line is read as the reply", async () => {
    const runner = fakeRunner([{ stdout: JSON.stringify(GOOD_ANSWERS) + "\n" }]);
    const answers = await new CliChooser("codex", { runner, env: {} }).ask(batch());
    expect(answers).toHaveLength(3);
  });

  it("an auth failure in the event stream is a configuration error naming `codex login`", async () => {
    const runner = fakeRunner([{ code: 1, stdout: CODEX_AUTH_FAILURE, stderr: "ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized" }]);
    const err = await new CliChooser("codex", { runner, env: {} }).ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as Error).message).toContain("codex login");
    expect((err as Error).message).toContain("Codex is installed but not signed in");
  });

  it("invalid JSON twice fails typed", async () => {
    const runner = fakeRunner([{ stdout: codexJsonl("nope") }, { stdout: codexJsonl("{\"answers\": \"x\"}") }]);
    const err = await new CliChooser("codex", { runner, env: {} }).ask(batch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(runner.calls).toHaveLength(2);
  });
});

describe("probeCli", () => {
  it("claude: installed and signed in when the one-word probe returns a result", async () => {
    const runner = fakeRunner([{ stdout: claudeEnvelope("ok") }]);
    const probe = await probeCli("claude", runner);
    expect(probe).toMatchObject({ installed: true, signedIn: true, version: "claude 9.9.9" });
    const probeCall = runner.calls.find((c) => c.cmd === "claude" && c.args[0] === "-p")!;
    expect(probeCall.args).toEqual(["-p", "reply with the word ok", "--output-format", "json", "--model", "haiku"]);
  });

  it("claude: installed but signed out when the probe exits non-zero", async () => {
    const runner = fakeRunner([{ code: 1, stdout: "", stderr: "Not logged in" }]);
    const probe = await probeCli("claude", runner);
    expect(probe.installed).toBe(true);
    expect(probe.signedIn).toBe(false);
    expect(probe.detail).toContain("Not logged in");
  });

  it("codex: signed in on turn.completed without an error event; signed out on the auth failure", async () => {
    const good = fakeRunner([{ stdout: codexJsonl("ok") }]);
    expect(await probeCli("codex", good)).toMatchObject({ installed: true, signedIn: true });
    const bad = fakeRunner([{ code: 1, stdout: CODEX_AUTH_FAILURE }]);
    const probe = await probeCli("codex", bad);
    expect(probe.signedIn).toBe(false);
    expect(probe.detail).toContain("sign in");
  });

  it("not installed when `command -v` fails, without running a probe", async () => {
    const runner = fakeRunner([], []);
    expect(await probeCli("codex", runner)).toMatchObject({ installed: false, signedIn: false });
    expect(runner.calls).toHaveLength(1);
  });

  it("unknown when the probe itself cannot run", async () => {
    const runner = fakeRunner([], ["claude"]);
    const probe = await probeCli("claude", runner);
    expect(probe.installed).toBe(true);
    expect(probe.signedIn).toBe("unknown");
  });

  it("without a runner the result is cached per process and `which` is a PATH lookup", async () => {
    resetProbeCache();
    const first = probeCli("claude", { env: { PATH: "/nonexistent" } });
    const second = probeCli("claude", { env: { PATH: "/nonexistent" } });
    expect(second).toBe(first);
    expect(await first).toMatchObject({ installed: false, signedIn: false });
    resetProbeCache();
  });
});

describe("default chooser chain", () => {
  it("keys win, then claude, then codex, then agent", () => {
    const both = { claude: true, codex: true };
    expect(defaultChooser({ AI_GATEWAY_API_KEY: "k" }, both)).toBe("jev");
    expect(defaultChooser({ TYPESAFE_API_KEY: "k" }, both)).toBe("jev");
    expect(defaultChooser({ ANTHROPIC_API_KEY: "k" }, both)).toBe("model");
    expect(defaultChooser({}, both)).toBe("claude");
    expect(defaultChooser({}, { claude: false, codex: true })).toBe("codex");
    expect(defaultChooser({}, { codex: true })).toBe("codex");
    expect(defaultChooser({}, {})).toBe("agent");
    expect(defaultChooser({})).toBe("agent");
  });

  it("resolveDefaultChooser does not probe when a key is set", async () => {
    let probed = 0;
    const resolved = await resolveDefaultChooser({ ANTHROPIC_API_KEY: "k" }, async () => {
      probed++;
      return { installed: true, signedIn: true };
    });
    expect(resolved).toMatchObject({ name: "model", reason: "ANTHROPIC_API_KEY is set" });
    expect(probed).toBe(0);
  });

  it("prefers a signed-in Claude Code and stops probing there", async () => {
    const probed: string[] = [];
    const resolved = await resolveDefaultChooser({}, async (h) => {
      probed.push(h);
      return { installed: true, signedIn: true };
    });
    expect(resolved.name).toBe("claude");
    expect(resolved.reason).toBe("Claude Code is installed and signed in; using your subscription");
    expect(probed).toEqual(["claude"]);
  });

  it("an installed but signed-out CLI never wins: codex next, else agent with the sign-in hint", async () => {
    const codexWins = await resolveDefaultChooser({}, async (h) => (h === "claude" ? { installed: true, signedIn: false } : { installed: true, signedIn: true }));
    expect(codexWins.name).toBe("codex");
    expect(codexWins.reason).toContain("Codex is installed and signed in");

    const agent = await resolveDefaultChooser({}, async (h) => (h === "codex" ? { installed: true, signedIn: false } : { installed: false, signedIn: false }));
    expect(agent.name).toBe("agent");
    expect(agent.reason).toContain("Codex is installed but not signed in (run `codex login`)");
    expect(agent.reason).toContain("you answer the questions");

    const nothing = await resolveDefaultChooser({}, async () => ({ installed: false, signedIn: false }));
    expect(nothing.name).toBe("agent");
    expect(nothing.reason).toContain("no API key and no signed-in Claude Code or Codex");
  });

  it("createChooser builds the CLI choosers by name", () => {
    const runner = fakeRunner([]);
    expect(createChooser({ chooser: "claude", env: {}, cli: { runner } }).name).toBe("claude");
    expect(createChooser({ chooser: "codex", env: {}, cli: { runner } }).name).toBe("codex");
  });
});

describe("a CLI chooser that is not signed in ends the run as a configuration error", () => {
  let server: FixtureServer;
  let dir: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    dir = mkdtempSync(join(tmpdir(), "navvi-cli-auth-"));
  });

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("codex signed out: run() rejects with the sign-in hint instead of ending no_items_found", async () => {
    const actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false }) });
    const runner = fakeRunner([{ code: 1, stdout: CODEX_AUTH_FAILURE }, { code: 1, stdout: CODEX_AUTH_FAILURE }]);
    const chooser = new CliChooser("codex", { runner, env: {} });
    const deps: CrawlDeps = { actor, chooser, env: {}, storageDir: mkdtempSync(join(dir, "st-")), attended: false, maxConcurrency: 1 };
    const raw = {
      browser: "chromium",
      allowPrivateHosts: ["127.0.0.1"],
      startUrls: [`${server.baseUrl}/demo/pharmacy/producto/${PRODUCTS[0]}.html`],
      mode: "record",
      fields: FIELDS.map((name) => ({ name })),
      description: "pharmacy product",
      chooser: "codex",
    };
    const err = await run(raw, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as Error).message).toContain("codex login");
  }, 60_000);
});

// ---------------------------------------------------------------- live smoke

const LIVE = process.env.NAVVI_LIVE_CLI === "1";

describe.skipIf(!LIVE)("live: pharmacy demo through the real Claude Code (NAVVI_LIVE_CLI=1)", () => {
  let server: FixtureServer;
  let dir: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    dir = mkdtempSync(join(tmpdir(), "navvi-live-cli-"));
  });

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("compiles the 12 product records with all four fields filled", async () => {
    const env = process.env;
    const actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false }) });
    const chooser = createChooser({ chooser: "claude", env });
    const deps: CrawlDeps = { actor, chooser, env, storageDir: mkdtempSync(join(dir, "st-")), attended: false, maxConcurrency: 1 };
    const started = performance.now();
    const summary = await run(
      {
        browser: "chromium",
        allowPrivateHosts: ["127.0.0.1"],
        startUrls: PRODUCTS.map((s) => `${server.baseUrl}/demo/pharmacy/producto/${s}.html`),
        mode: "record",
        fields: FIELDS.map((name) => ({ name })),
        description: "pharmacy product",
        chooser: "claude",
      },
      deps,
    );
    const wallMs = performance.now() - started;
    const usage = chooser.usage();
    console.error(`live claude: status ${summary.status}, items ${summary.items}, questions ${usage.questions} in ${usage.batches} batches, chooser wait ${Math.round(usage.waitMs)} ms, wall ${Math.round(wallMs)} ms, reported cost $${(usage.reportedCostUsd ?? 0).toFixed(4)}, billed $${usage.costUsd}`);
    expect(summary.status).toBe("succeeded");
    expect(summary.items).toBe(12);
    const rows = (await (await actor.openDataset()).getData()).items as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(12);
    for (const row of rows) for (const field of FIELDS) expect(row[field], `${String(row._source)} ${field}`).not.toBeNull();
    expect(usage.billing).toBe("subscription");
    expect(usage.costUsd).toBe(0);
  }, 300_000);
});

describe("Claude Code token accounting (U7)", () => {
  it("counts the cached input Claude Code reports separately, not only the uncached remainder", async () => {
    // The shape of a real `claude -p --output-format json` envelope (2026-09-23): the
    // harness caches its own system prompt, so `input_tokens` alone was 10 of 18,439.
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      result: JSON.stringify(GOOD_ANSWERS),
      total_cost_usd: 0.0091,
      usage: { input_tokens: 10, cache_creation_input_tokens: 3716, cache_read_input_tokens: 14713, output_tokens: 38 },
    });
    // A budget the harness's cached prompt alone would blow through.
    const budget = new Budget({ chooserInputTokens: 5_000 });
    const chooser = new CliChooser("claude", { runner: fakeRunner([{ stdout: envelope }]), env: {}, budget });
    await chooser.ask(batch());
    expect(chooser.usage().inputTokens).toBe(18_439);
    expect(chooser.usage().outputTokens).toBe(38);
    // The harness's own prompt rides on the subscription; the run's input budget is charged what navvi sent.
    expect(() => budget.assertInputTokens(4_000)).not.toThrow();
  });
});

describe("the Jev announcement (U7)", () => {
  it("names the key, the benefit and who writes the text", async () => {
    const noProbe = async () => {
      throw new Error("must not probe");
    };
    const bin = mkdtempSync(join(tmpdir(), "navvi-bin-"));
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      const withClaude = await resolveDefaultChooser({ TYPESAFE_API_KEY: "t", PATH: bin }, noProbe);
      expect(withClaude.name).toBe("jev");
      expect(withClaude.reason).toBe("TYPESAFE_API_KEY found — fast typed decisions; text questions go to claude");

      const both = await resolveDefaultChooser({ AI_GATEWAY_API_KEY: "g", TYPESAFE_API_KEY: "t", PATH: bin }, noProbe);
      expect(both.reason).toBe("AI_GATEWAY_API_KEY found — fast typed decisions, TypeSafe API as fallback; text questions go to claude");

      const explicit = await resolveDefaultChooser({ TYPESAFE_API_KEY: "t", PATH: bin }, noProbe, { writer: "codex" });
      expect(explicit.reason).toContain("text questions go to codex");

      const noWriter = await resolveDefaultChooser({ TYPESAFE_API_KEY: "t", PATH: "" }, noProbe);
      expect(noWriter.reason).toContain("no text writer");
      expect(noWriter.reason).toContain("ANTHROPIC_API_KEY");

      const gatewayOnly = await resolveDefaultChooser({ AI_GATEWAY_API_KEY: "g", PATH: "" }, noProbe);
      expect(gatewayOnly.reason).toContain("text questions go to model");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
