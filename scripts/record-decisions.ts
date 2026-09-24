import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Actor } from "apify";
import { LogLevel, MemoryStorage, log as crawleeLog } from "crawlee";
import { chromium, type Page } from "playwright";
import { CliChooser, JevChooser, ModelChooser, RecordingChooser, type Answer, type BackendResult, type Chooser, type Question } from "../src/chooser/index.js";
import { run, type RunSummary } from "../src/main.js";
import { FFMPEG } from "./recorder.js";

/**
 * The decision race: the same real chooser questions, asked to Haiku and to Jev.
 *
 * Navvi never asks a model for a selector or code; it enumerates candidates and
 * asks the chooser to pick. This script isolates that decision step.
 *
 * 1. capture — one real run on a public site (`run()`, the same entry point as
 *    the CLI) with a reference decider, a third model that is in neither lane.
 *    Every batch navvi asked is logged in full to `capture/questions.jsonl`
 *    and the answers go through `RecordingChooser` into `capture/recorded/`.
 * 2. race — the captured choice/boolean batches, replayed as captured (same
 *    grouping, text questions removed because Jev cannot write), sequentially
 *    per lane, wall clock per batch. Haiku: the stock `ModelChooser` over the
 *    AI Gateway. Jev: `JevChooser` over the TypeSafe API. One untimed warm-up
 *    call per lane. `DECISIONS_RUNS` runs (default 3); lane order alternates per run.
 * 3. render — the median run (by speedup ratio) as GIF and MP4, answers ticking
 *    in at their measured times, plus `provenance.json`.
 *
 * Env:
 *   DECISIONS_MODE     capture (capture + race + render, default) | race (from DECISIONS_CAPTURE) | render (from DECISIONS_SOURCE)
 *                      | bench (race only from DECISIONS_CAPTURE: no capture, no render; writes bench.json)
 *   DECISIONS_LANES    bench mode lanes, comma-separated (default jev,haiku): jev | haiku | claude-code
 *                      claude-code is navvi's CliChooser("claude"): `claude -p` on the signed-in subscription,
 *                      model NAVVI_CLAUDE_MODEL (default haiku), a fresh CLI process per batch
 *   DECISIONS_BENCH_OUT  bench mode: also write the summary JSON to this path
 *   DECISIONS_CAPTURE  an existing run directory whose capture/ is reused (race mode)
 *   DECISIONS_SOURCE   an existing run directory whose race.json is re-rendered (render mode)
 *   DECISIONS_OUT      parent directory for the new run directory (default: system temp)
 *   DECISIONS_URL / DECISIONS_PROMPT   the public task (default: Hacker News search on hn.algolia.com)
 *   DECISIONS_REFERENCE_MODEL  capture decider (default claude-sonnet-4-6, via AI Gateway)
 *   DECISIONS_HAIKU_MODEL      default claude-haiku-4-5
 *   DECISIONS_RUNS     default 3
 *   DECISIONS_VS       capture/race/render: the lane racing Jev (default haiku; also claude-code). A race.json
 *                      without `vs` renders as haiku. claude-code publishes to docs/decisions-race-claude-code.{gif,mp4}
 *                      and docs/decisions-race-claude-code-provenance.json
 *   DECISIONS_PUBLISH=1  copy gif/mp4/provenance to docs/decisions-race.* (or the DECISIONS_VS names above)
 *   DECISIONS_VISUAL=1   the visual cut. capture: also screenshot navvi's own crawler page (CrawlDeps.onPage) just
 *                        before each batch is asked and measure the element box of every option on it
 *                        (capture/visual.json + capture/visual/batch-N.png). race/render: needs such a capture and
 *                        renders the page pane with each lane's picks outlined; publishes to
 *                        docs/decisions-race-visual.* or docs/decisions-race-claude-code-visual.*
 * Keys: AI_GATEWAY_API_KEY (Haiku lane, reference decider), TYPESAFE_API_KEY (Jev lane).
 * ANTHROPIC_API_KEY is removed from the environment so ModelChooser uses the Gateway.
 */

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 10;
const GIF_FPS = 10;
const MAX_ACTIVE_S = 15;
const END_HOLD_S = 3.5;
const INTRO_S = 1.2;
const VISIBLE_ROWS = 9;

const DEFAULT_URL = "https://hn.algolia.com/";
const DEFAULT_PROMPT = "Search Hacker News for Python stories and extract up to 10 results with title, author, points and story link.";

interface CapturedBatch {
  batch: number;
  elapsedMs: number;
  waitMs: number;
  questions: Question[];
  answers: Answer[];
}

interface LaneBatch {
  batch: number;
  startMs: number;
  endMs: number;
  ms: number;
  answers: Answer[];
}

type Lane = "haiku" | "jev" | "claude-code";
const LANES: readonly Lane[] = ["jev", "haiku", "claude-code"];

interface LaneRun {
  lane: Lane;
  modelId: string;
  transport: string;
  warmupMs: number;
  warmupError?: string;
  /** Haiku API lane: choice/boolean answers that arrived with an explanation in `text` beside the pick (observed, not altered; the stock validator accepts them since 8d868fb). Includes the warm-up. */
  explanationTexts?: number;
  totalMs: number;
  batches: LaneBatch[];
  apiBatches: number;
  error?: string;
}

interface RaceRun {
  run: number;
  order: Lane[];
  lanes: Partial<Record<Lane, LaneRun>>;
  /** other lane total / Jev total */
  ratio: number;
}

type Vs = Exclude<Lane, "jev">;

function vsLane(value: string | undefined): Vs {
  const v = (value ?? "haiku").trim();
  if (v !== "haiku" && v !== "claude-code") throw new Error(`DECISIONS_VS: unknown lane ${v} (haiku, claude-code)`);
  return v;
}

const laneOf = (run: RaceRun, lane: Lane): LaneRun => {
  const l = run.lanes[lane];
  if (!l) throw new Error(`run ${run.run} has no ${lane} lane`);
  return l;
};

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sh = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: "utf8" }).trim();

function laneEnv(needGateway = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  if (needGateway && !env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY is required (Haiku lane over the AI Gateway)");
  if (!env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required (Jev lane over the TypeSafe API)");
  return env;
}

// ---------------------------------------------------------------- visual capture

/** An element box in the page's CSS pixels, relative to the viewport the screenshot shows. */
interface VisualBox { x: number; y: number; w: number; h: number; how: string }

interface VisualBatch {
  batch: number;
  url: string;
  shot: string;
  viewport: { width: number; height: number };
  /** per question id: one box (or null: not located) per option, in option order */
  boxes: Record<string, Array<VisualBox | null>>;
  takenAtMs: number;
}

const round = (b: { x: number; y: number; width: number; height: number }, how: string): VisualBox =>
  ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), how });

/**
 * Resolves one option to the element it names on the live page, from the
 * structured facts navvi attached to it (`optionContext`): a control's ARIA
 * role and name (navigate/agent.ts), a group's container and item selectors
 * (compile/groups.ts), a field candidate's path and sample values
 * (compile/fields.ts), a link's text and href (compile/links.ts). Read-only.
 */
async function optionBox(page: Page, ctx: Record<string, unknown>): Promise<VisualBox | null> {
  const str = (k: string) => (typeof ctx[k] === "string" ? (ctx[k] as string) : undefined);
  try {
    if (str("container") && str("item")) {
      const sel = `${str("container")} > ${str("item")}`;
      const r = await page.evaluate((s) => {
        const els = [...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
        if (!els.length) return null;
        const x = Math.min(...els.map((b) => b.left)); const y = Math.min(...els.map((b) => b.top));
        return { x, y, width: Math.max(...els.map((b) => b.right)) - x, height: Math.max(...els.map((b) => b.bottom)) - y };
      }, sel);
      return r ? round(r, `union of ${sel}`) : null;
    }
    if (str("path") && Array.isArray(ctx.values_per_sample)) {
      // A list candidate: every element on the path, on sample 1 — the union of the elements whose values it lists.
      const css = str("path")!.split("/").filter((seg) => !seg.startsWith("@")).join(" > ");
      const want = ((ctx.values_per_sample as unknown[][])[0] ?? []).map((x) => String(x).replace(/\s+/g, " ").trim());
      const r = await page.evaluate(({ css, want }) => {
        const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
        const left = [...want];
        const rects: DOMRect[] = [];
        for (const el of document.querySelectorAll(css)) {
          const i = left.indexOf(norm((el as HTMLElement).innerText ?? el.textContent));
          if (i < 0) continue;
          left.splice(i, 1);
          rects.push(el.getBoundingClientRect());
          if (!left.length) break;
        }
        if (!rects.length) return null;
        const x = Math.min(...rects.map((b) => b.left)); const y = Math.min(...rects.map((b) => b.top));
        return { x, y, width: Math.max(...rects.map((b) => b.right)) - x, height: Math.max(...rects.map((b) => b.bottom)) - y };
      }, { css, want });
      return r ? round(r, `union of the ${css} elements holding sample 1's values`) : null;
    }
    if (str("path") && Array.isArray(ctx.values)) {
      const path = str("path")!;
      const attr = str("attribute");
      const css = path.split("/").filter((seg) => !seg.startsWith("@")).join(" > ");
      const want = String((ctx.values as unknown[])[0] ?? "").replace(/…$/, "").replace(/\s+/g, " ").trim();
      const r = await page.evaluate(({ css, attr, want }) => {
        const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
        for (const el of document.querySelectorAll(css)) {
          const v = attr ? norm((el as unknown as Record<string, string>)[attr] ?? el.getAttribute(attr)) : norm((el as HTMLElement).innerText ?? el.textContent);
          const raw = attr ? norm(el.getAttribute(attr)) : v;
          if (!want || v.startsWith(want) || raw.startsWith(want)) {
            const b = el.getBoundingClientRect();
            if (b.width > 0 && b.height > 0) return { x: b.left, y: b.top, width: b.width, height: b.height };
          }
        }
        return null;
      }, { css, attr: attr ?? null, want });
      return r ? round(r, `first ${css} whose ${attr ? `@${attr}` : "text"} is sample 1's value`) : null;
    }
    const role = str("role");
    const name = str("name");
    if (role && name) {
      const loc = page.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact: true });
      if ((await loc.count()) > 0) {
        const b = await loc.first().boundingBox({ timeout: 1500 });
        if (b) return round(b, `getByRole(${role}, "${name}")`);
      }
    }
    const href = str("href");
    if (href) {
      const text = str("text") ?? name ?? "";
      const r = await page.evaluate(({ href, text }) => {
        const as = [...document.querySelectorAll("a")].filter((a) => a.href === href);
        const a = as.find((x) => (x.innerText || x.getAttribute("aria-label") || "").trim() === text) ?? as[0];
        if (!a) return null;
        const b = a.getBoundingClientRect();
        return b.width > 0 && b.height > 0 ? { x: b.left, y: b.top, width: b.width, height: b.height } : null;
      }, { href, text });
      return r ? round(r, `a[href="${href}"]`) : null;
    }
  } catch {
    // an option that cannot be located stays null; the render says so
  }
  return null;
}

async function snapVisual(page: Page, dir: string, id: number, batch: Question[], started: number): Promise<VisualBatch | null> {
  if (page.isClosed()) return null;
  const takenAtMs = performance.now() - started;
  const shot = `batch-${id}.png`;
  mkdirSync(join(dir, "visual"), { recursive: true });
  await page.screenshot({ path: join(dir, "visual", shot), type: "png" });
  const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const boxes: Record<string, Array<VisualBox | null>> = {};
  const cache = new Map<string, VisualBox | null>();
  for (const q of batch) {
    if (q.kind !== "choice" || !q.optionContext) continue;
    const out: Array<VisualBox | null> = [];
    for (const ctx of q.optionContext) {
      if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) { out.push(null); continue; }
      const key = JSON.stringify(ctx);
      if (!cache.has(key)) cache.set(key, await optionBox(page, ctx as Record<string, unknown>));
      out.push(cache.get(key)!);
    }
    boxes[q.id] = out;
  }
  return { batch: id, url: page.url(), shot, viewport, boxes, takenAtMs };
}

// ---------------------------------------------------------------- capture

async function capture(dir: string, env: NodeJS.ProcessEnv, visual = false): Promise<void> {
  const url = process.env.DECISIONS_URL ?? DEFAULT_URL;
  const prompt = process.env.DECISIONS_PROMPT ?? DEFAULT_PROMPT;
  const referenceModel = process.env.DECISIONS_REFERENCE_MODEL ?? "claude-sonnet-4-6";
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "questions.jsonl");
  writeFileSync(log, "");
  const reference = new ModelChooser({ env, modelId: referenceModel });
  const recording = new RecordingChooser(reference, { fixture: "capture", dir: join(dir, "recorded"), env });
  const started = performance.now();
  let n = 0;
  // Visual cut: navvi's own crawler page, observed through CrawlDeps.onPage, is photographed read-only before each batch.
  let livePage: Page | undefined;
  const visuals: VisualBatch[] = [];
  const logged: Chooser = {
    name: recording.name,
    usage: () => recording.usage(),
    async ask(batch: Question[]): Promise<Answer[]> {
      const id = ++n;
      if (visual && livePage) {
        try {
          const v = await snapVisual(livePage, dir, id, batch, started);
          if (v) visuals.push(v);
        } catch (e) {
          console.log(`capture batch ${id}: no screenshot (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      const t = performance.now();
      const answers = await recording.ask(batch);
      const entry: CapturedBatch = { batch: id, elapsedMs: t - started, waitMs: performance.now() - t, questions: batch, answers };
      appendFileSync(log, JSON.stringify(entry) + "\n");
      console.log(`capture batch ${id}: ${batch.map((q) => q.id).join(", ")}`);
      return answers;
    },
  };
  const actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: join(dir, "storage"), persistStorage: true }) });
  mkdirSync(join(dir, "profiles"), { recursive: true });
  let summary: RunSummary | undefined;
  let error: string | undefined;
  try {
    summary = await run({ startUrls: [url], prompt, browser: "chromium", maxPages: 1, maxItems: 10 }, {
      actor, chooser: logged, env: { ...env, NAVVI_BROWSER: "chromium" }, storageDir: join(dir, "profiles"), attended: false, maxConcurrency: 1,
      ...(visual ? { onPage: async (p: Page) => { livePage = p; } } : {}),
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const rows = error ? [] : ((await (await actor.openDataset()).getData()).items as Array<Record<string, unknown>>);
  writeFileSync(join(dir, "rows.json"), JSON.stringify(rows, null, 2) + "\n");
  writeFileSync(join(dir, "capture.json"), JSON.stringify({
    capturedAt: new Date().toISOString(), url, prompt, referenceDecider: { chooser: "ModelChooser", modelId: referenceModel, transport: "Vercel AI Gateway" },
    commit: sh("git", ["rev-parse", "HEAD"]), workingTree: sh("git", ["status", "--porcelain"]),
    status: summary?.status ?? "error", message: summary?.message ?? error ?? null, items: summary?.items ?? 0, fieldsNotFound: summary?.fieldsNotFound ?? [],
    usage: reference.usage(),
  }, null, 2) + "\n");
  rmSync(join(dir, "profiles"), { recursive: true, force: true });
  if (visual) writeFileSync(join(dir, "visual.json"), JSON.stringify(visuals, null, 2) + "\n");
  if (error || !summary || summary.status !== "succeeded" || summary.items === 0) throw new Error(`capture did not succeed: ${summary?.status ?? "error"} ${summary?.message ?? error ?? ""}`);
  console.log(`capture: ${summary.items} rows, ${n} batches -> ${dir}`);
}

function loadBatches(captureDir: string): CapturedBatch[] {
  const all = readFileSync(join(captureDir, "questions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as CapturedBatch);
  // Decisions only: Jev cannot write text, so text questions (prompt parsing, the typed query) are not part of the race.
  return all
    .map((b) => {
      const keep = b.questions.filter((q) => q.kind !== "text");
      const ids = new Set(keep.map((q) => q.id));
      return { ...b, questions: keep, answers: b.answers.filter((a) => ids.has(a.id)) };
    })
    .filter((b) => b.questions.length > 0);
}

// ---------------------------------------------------------------- race

/**
 * The Haiku API lane: the stock ModelChooser. Until 8d868fb navvi's validator
 * rejected the explanation Haiku writes in `text` beside a valid index, and
 * this recorder stripped it in a subclass. Now the stock validator accepts
 * the pick and drops the words, so this subclass only counts how many answers
 * carried an explanation; it changes nothing it returns.
 */
class CountingModelChooser extends ModelChooser {
  explanationTexts = 0;
  protected override async callBackend(batch: Question[]): Promise<BackendResult> {
    const result = await super.callBackend(batch);
    const kinds = new Map(batch.map((q) => [q.id, q.kind]));
    if (Array.isArray(result.answers)) {
      for (const a of result.answers as unknown[]) {
        if (a && typeof a === "object" && typeof (a as { text?: unknown }).text === "string" && kinds.get(String((a as { id?: unknown }).id)) !== "text") this.explanationTexts += 1;
      }
    }
    return result;
  }
}

/**
 * The Claude Code lane runs `claude` as a navvi user without an API key would:
 * signed in on the subscription, no ANTHROPIC_API_KEY, and none of the parent
 * Claude Code session's variables (CLAUDECODE, CLAUDE_CODE_*), which would
 * otherwise make the child a nested session of whatever is running this script.
 */
function claudeCodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/^(CLAUDE|ANTHROPIC)/.test(k)) out[k] = v;
  return out;
}

const WARMUP: Question[] = [{ id: "w1", kind: "choice", premise: "Which of these is a fruit?", options: ["carrot", "apple", "stone"], state: "A grocery list." }];

async function raceLane(lane: Lane, batches: CapturedBatch[], env: NodeJS.ProcessEnv, haikuModel: string): Promise<LaneRun> {
  const chooser =
    lane === "haiku" ? new CountingModelChooser({ env, modelId: haikuModel })
    : lane === "jev" ? new JevChooser({ env, provider: "typesafe" })
    : new CliChooser("claude", { env: claudeCodeEnv(env) });
  // Untimed warm-up (connection setup). A failed warm-up is recorded, not fatal: the timed pass stands on its own.
  const w = performance.now();
  let warmupError: string | undefined;
  try {
    await chooser.ask(WARMUP);
  } catch (err) {
    warmupError = err instanceof Error ? err.message : String(err);
  }
  const warmupMs = performance.now() - w;
  const before = chooser.usage().batches;
  const out: LaneBatch[] = [];
  const t0 = performance.now();
  let error: string | undefined;
  for (const b of batches) {
    const s = performance.now();
    try {
      const answers = await chooser.ask(b.questions);
      const e = performance.now();
      out.push({ batch: b.batch, startMs: s - t0, endMs: e - t0, ms: e - s, answers });
    } catch (err) {
      error = `batch ${b.batch}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
  }
  const totalMs = performance.now() - t0;
  return {
    lane,
    modelId: lane === "haiku" ? `anthropic/${haikuModel}` : lane === "jev" ? "jev-latest" : `claude --model ${(chooser as CliChooser).model ?? "(CLI default)"}`,
    transport: lane === "haiku" ? "Vercel AI Gateway (stock ModelChooser, AI SDK generateObject)"
      : lane === "jev" ? "TypeSafe API https://api.typesafe.ai/v1/systemone (JevChooser, provider typesafe)"
      : "Claude Code CLI on the signed-in subscription (CliChooser claude: `claude -p <prompt> --output-format json --model <m>`, one process per batch)",
    warmupMs, ...(warmupError ? { warmupError } : {}), totalMs, batches: out,
    ...(chooser instanceof CountingModelChooser ? { explanationTexts: chooser.explanationTexts } : {}), apiBatches: chooser.usage().batches - before, ...(error ? { error } : {}),
  };
}

async function race(batches: CapturedBatch[], env: NodeJS.ProcessEnv, runs: number, vs: Vs): Promise<RaceRun[]> {
  const haikuModel = process.env.DECISIONS_HAIKU_MODEL ?? "claude-haiku-4-5";
  const out: RaceRun[] = [];
  for (let r = 1; r <= runs; r++) {
    const order: Lane[] = r % 2 === 1 ? [vs, "jev"] : ["jev", vs];
    const lanes: Partial<Record<Lane, LaneRun>> = {};
    for (const lane of order) {
      const lr = await raceLane(lane, batches, env, haikuModel);
      lanes[lane] = lr;
      console.log(`run ${r} ${lane}: ${(lr.totalMs / 1000).toFixed(2)} s over ${lr.batches.length} batches (warm-up ${(lr.warmupMs / 1000).toFixed(2)} s)${lr.error ? ` ERROR ${lr.error}` : ""}`);
    }
    out.push({ run: r, order, lanes, ratio: lanes[vs]!.totalMs / lanes.jev!.totalMs });
  }
  return out;
}

// ---------------------------------------------------------------- bench (race only)

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Race only: no capture, no render. Any set of lanes over an existing capture,
 * sequential, one untimed warm-up per lane, order rotated per run so every
 * lane takes every position (with two lanes this is plain alternation).
 */
async function bench(dir: string, captureDir: string, env: NodeJS.ProcessEnv, commit: string, workingTree: string): Promise<void> {
  const lanes = (process.env.DECISIONS_LANES ?? "jev,haiku").split(",").map((l) => l.trim()).filter(Boolean) as Lane[];
  for (const l of lanes) if (!LANES.includes(l)) throw new Error(`DECISIONS_LANES: unknown lane ${l} (jev, haiku, claude-code)`);
  const runsWanted = Number(process.env.DECISIONS_RUNS ?? 3);
  const haikuModel = process.env.DECISIONS_HAIKU_MODEL ?? "claude-haiku-4-5";
  const batches = loadBatches(captureDir);
  const measuredAt = new Date().toISOString();
  const runs: Array<{ run: number; order: Lane[]; lanes: Partial<Record<Lane, LaneRun>> }> = [];
  for (let r = 0; r < runsWanted; r++) {
    const order = lanes.map((_, i) => lanes[(i + r) % lanes.length]!);
    const out: Partial<Record<Lane, LaneRun>> = {};
    for (const lane of order) {
      out[lane] = await raceLane(lane, batches, env, haikuModel);
      const lr = out[lane]!;
      console.log(`run ${r + 1} ${lane}: ${(lr.totalMs / 1000).toFixed(2)} s over ${lr.batches.length} batches (warm-up ${(lr.warmupMs / 1000).toFixed(2)} s)${lr.error ? ` ERROR ${lr.error}` : ""}`);
    }
    runs.push({ run: r + 1, order, lanes: out });
    writeFileSync(join(dir, "bench.json"), JSON.stringify({ measuredAt, commit, workingTree, captureDir, lanes, runs }, null, 2) + "\n");
  }
  const cap = JSON.parse(readFileSync(join(captureDir, "capture.json"), "utf8")) as { url: string; prompt: string; capturedAt: string; commit: string; referenceDecider: unknown };
  const perLane = Object.fromEntries(lanes.map((lane) => {
    const lrs = runs.map((r) => r.lanes[lane]!);
    const totals = lrs.map((l) => l.totalMs);
    return [lane, {
      modelId: lrs[0]!.modelId,
      transport: lrs[0]!.transport,
      failedRuns: lrs.filter((l) => l.error).map((l, i) => ({ run: i + 1, error: l.error })),
      totalMsPerRun: totals.map(Math.round),
      medianTotalMs: Math.round(median(totals)),
      medianBatchMs: Math.round(median(lrs.flatMap((l) => l.batches.map((b) => b.ms)))),
      warmupMsPerRun: lrs.map((l) => Math.round(l.warmupMs)),
      agreementPerRun: lrs.map((l) => { const a = laneMatches(batches, l); return { matchesReference: a.matchesReference, of: a.questions, mismatches: a.mismatches }; }),
    }];
  }));
  const ratios: Record<string, unknown> = {};
  if (lanes.includes("jev")) {
    for (const other of lanes.filter((l) => l !== "jev")) {
      const perRun = runs.map((r) => r.lanes[other]!.totalMs / r.lanes.jev!.totalMs);
      ratios[`${other}/jev`] = {
        ofMedians: Number(((perLane[other] as { medianTotalMs: number }).medianTotalMs / (perLane.jev as { medianTotalMs: number }).medianTotalMs).toFixed(2)),
        perRun: perRun.map((x) => Number(x.toFixed(2))),
        medianOfPerRun: Number(median(perRun).toFixed(2)),
      };
    }
  }
  const summary = {
    claim: `Decision-step latency only, lanes ${lanes.join(", ")}: the same captured choice/boolean questions, same batches, sequential per lane, wall clock per batch.`,
    measuredAt,
    navviCommit: commit,
    workingTreeAtMeasurement: workingTree || "clean",
    capture: { dir: captureDir, site: cap.url, task: cap.prompt, capturedAt: cap.capturedAt, commit: cap.commit, referenceDecider: cap.referenceDecider },
    questions: { batches: batches.length, count: batches.reduce((n, b) => n + b.questions.length, 0), ids: batches.map((b) => ({ batch: b.batch, ids: b.questions.map((q) => q.id), kinds: b.questions.map((q) => q.kind) })) },
    method: {
      warmUp: "one untimed one-question choice call per lane immediately before its timed pass",
      order: "lanes one after the other, never concurrently; order rotated per run so each lane takes each position",
      timing: "performance.now() around chooser.ask(batch) per captured batch; lane total is wall clock over all batches; BaseChooser re-asks, if any, are inside the timing (apiBatches counts backend calls)",
      reference: "the answer the reference decider gave during the capture run; matching it is agreement with that run, not ground truth",
    },
    lanes: perLane,
    ratios,
    runs: runs.map((r) => ({
      run: r.run, order: r.order,
      lanes: Object.fromEntries(r.order.map((k) => { const l = r.lanes[k]!; return [k, {
        totalMs: Math.round(l.totalMs), warmupMs: Math.round(l.warmupMs), ...(l.warmupError ? { warmupError: l.warmupError } : {}), apiBatches: l.apiBatches,
        ...(l.explanationTexts !== undefined ? { explanationTexts: l.explanationTexts } : {}), ...(l.error ? { error: l.error } : {}),
        batches: l.batches.map((b) => ({ batch: b.batch, ms: Math.round(b.ms), answers: b.answers.map((a) => ({ id: a.id, index: a.index })) })),
      }]; })),
    })),
  };
  writeFileSync(join(dir, "bench-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  if (process.env.DECISIONS_BENCH_OUT) writeFileSync(resolve(process.env.DECISIONS_BENCH_OUT), JSON.stringify(summary, null, 2) + "\n");
  for (const lane of lanes) {
    const p = perLane[lane] as { medianTotalMs: number; totalMsPerRun: number[]; agreementPerRun: Array<{ matchesReference: number; of: number }> };
    console.log(`${lane}: median ${(p.medianTotalMs / 1000).toFixed(2)} s · runs ${p.totalMsPerRun.map((x) => (x / 1000).toFixed(2)).join(" / ")} s · reference ${p.agreementPerRun.map((a) => `${a.matchesReference}/${a.of}`).join(", ")}`);
  }
  for (const [k, v] of Object.entries(ratios)) console.log(`${k}: ${JSON.stringify(v)}`);
  const failed = runs.flatMap((r) => r.order.filter((k) => r.lanes[k]!.error).map((k) => `run ${r.run} ${k}: ${r.lanes[k]!.error}`));
  if (failed.length) throw new Error(`bench had failing lanes: ${failed.join("; ")}`);
  console.log(`evidence in ${dir}`);
}

// ---------------------------------------------------------------- scoring

interface Scored {
  id: string;
  batch: number;
  kind: string;
  label: string;
  reference: string;
  /** the lane racing Jev (DECISIONS_VS) */
  other: string;
  jev: string;
  otherMatch: boolean;
  jevMatch: boolean;
  agree: boolean;
}

function premiseLabel(q: Question): string {
  const id = q.id;
  if (/^nav\.\d+\.op$/.test(id)) return "Which action next?";
  if (/^nav\.\d+\.click$/.test(id)) return "Which control to click?";
  if (/^nav\.\d+\.type$/.test(id)) return "Which field to type in?";
  if (/^nav\.\d+\.select$/.test(id)) return "Which dropdown value?";
  if (/^nav\.\d+\.done$/.test(id)) return "Is the search done?";
  if (id.startsWith("group")) return "Which list holds the results?";
  if (id.startsWith("link.next")) return "Which link is the next page?";
  if (id.startsWith("link.detail")) return "Which link opens the detail?";
  if (id.startsWith("field.")) return `Which element is the ${id.slice(6).split(/[./]/)[0]!.replace(/_/g, " ")}?`;
  return q.kind === "boolean" ? "Yes or no?" : "Which option?";
}

function pickText(q: Question, a: Answer | undefined): string {
  if (!a) return "(no answer)";
  if (q.kind === "boolean") return a.index === 1 ? "yes" : "no";
  if (a.index === null) return "none";
  const raw = q.options?.[a.index] ?? "?";
  let s = raw;
  if (/^nav\.\d+\.op$/.test(q.id)) s = raw.split(":")[0]!;
  else if (/^nav\.\d+\.(click|type|select)$/.test(q.id)) s = raw.replace(/ in ".*$/, "").replace(/ -> .*$/, "");
  else if (q.id.startsWith("field.")) s = `“${(raw.split(" = ")[1] ?? raw).split(" | ")[0]!}”`;
  else if (q.id.startsWith("group")) s = raw.split(": ")[0]!.split(" > ").pop()!;
  else if (q.id.startsWith("link.")) s = raw.split(" -> ")[0]!;
  return s;
}

function laneMatches(batches: CapturedBatch[], lane: LaneRun): { questions: number; matchesReference: number; mismatches: Array<{ id: string; reference: number | null | undefined; lane: number | null | undefined }> } {
  let n = 0;
  let m = 0;
  const mismatches: Array<{ id: string; reference: number | null | undefined; lane: number | null | undefined }> = [];
  for (const b of batches) {
    for (const q of b.questions) {
      n += 1;
      const ref = b.answers.find((a) => a.id === q.id)?.index;
      const got = lane.batches.find((x) => x.batch === b.batch)?.answers.find((a) => a.id === q.id)?.index;
      if (got !== undefined && got === ref) m += 1;
      else mismatches.push({ id: q.id, reference: ref, lane: got });
    }
  }
  return { questions: n, matchesReference: m, mismatches };
}

function score(batches: CapturedBatch[], run: RaceRun, vs: Vs): Scored[] {
  const out: Scored[] = [];
  const find = (lane: LaneRun, batch: number, id: string) => lane.batches.find((b) => b.batch === batch)?.answers.find((a) => a.id === id);
  for (const b of batches) {
    for (const q of b.questions) {
      const ref = b.answers.find((a) => a.id === q.id);
      const h = find(laneOf(run, vs), b.batch, q.id);
      const j = find(laneOf(run, "jev"), b.batch, q.id);
      out.push({
        id: q.id, batch: b.batch, kind: q.kind, label: premiseLabel(q),
        reference: pickText(q, ref), other: pickText(q, h), jev: pickText(q, j),
        otherMatch: !!h && h.index === ref?.index, jevMatch: !!j && j.index === ref?.index, agree: !!h && !!j && h.index === j.index,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- render

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface RenderInput {
  batches: CapturedBatch[];
  run: RaceRun;
  scored: Scored[];
  date: string;
  commit: string;
  site: string;
  speed: number;
  runs: number;
  haikuModel: string;
  vs: Vs;
  /** visual cut: the capture's screenshot and option boxes per batch, the screenshot inlined as a data URI */
  visual?: Map<number, VisualBatch & { dataUri: string }> | undefined;
}

/** Name, subtitle and color per lane. The haiku pair keeps its published labels. */
function laneLabel(inp: RenderInput, lane: Lane): { name: string; sub: string; color: string } {
  if (lane === "jev") return { name: "Jev", sub: inp.vs === "haiku" ? "Jev · TypeSafe API" : "TypeSafe API", color: "#7ee787" };
  if (lane === "haiku") return { name: "Haiku", sub: `${inp.haikuModel} · AI Gateway`, color: "#d2a8ff" };
  return { name: "Haiku via Claude Code", sub: `navvi's default without a key · claude -p --model ${inp.haikuModel}`, color: "#d2a8ff" };
}

function column(inp: RenderInput, lane: Lane, tMs: number): string {
  const lr = laneOf(inp.run, lane);
  const done = lr.batches.filter((b) => b.endMs <= tMs);
  const finished = done.length === lr.batches.length;
  const clock = finished ? lr.totalMs : Math.min(tMs, lr.totalMs);
  const answeredBatches = new Set(done.map((b) => b.batch));
  const rows = inp.scored.filter((s) => answeredBatches.has(s.batch));
  const visible = rows.slice(-VISIBLE_ROWS);
  const { name, sub, color } = laneLabel(inp, lane);
  const items = visible
    .map((s) => {
      const pick = lane === "jev" ? s.jev : s.other;
      const match = lane === "jev" ? s.jevMatch : s.otherMatch;
      return `<div class="row"><span class="tick" style="color:${match ? "#7ee787" : "#ffa657"}">${match ? "✓" : "≠"}</span><span class="q">${esc(s.label)}</span><span class="a">${esc(clip(pick, 22))}</span></div>`;
    })
    .join("");
  const status = finished
    ? `<span style="color:${color}">done · ${rows.length} decisions</span>`
    : `${rows.length} / ${inp.scored.length} decisions`;
  return `<div class="col${finished ? " fin" : ""}">
    <div class="ch"><div><div class="name${name.length > 12 ? " long" : ""}" style="color:${color}">${esc(name)}</div><div class="sub">${esc(sub)}</div></div><div class="clock" style="color:${finished ? color : "#e6edf3"}">${(clock / 1000).toFixed(1)}s</div></div>
    <div class="status">${status}</div>
    <div class="list">${items}</div>
  </div>`;
}

const STYLE = `* { box-sizing: border-box } body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: #0b0e14; color: #c9d1d9; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; overflow: hidden; position: relative }
.title { padding: 18px 28px 6px; display: flex; justify-content: space-between; align-items: baseline }
.title h1 { margin: 0; font-size: 40px; color: #e6edf3; letter-spacing: -0.5px } .title .speed { font-size: 22px; color: #ffa657; font-weight: 700 }
.task { padding: 0 28px 10px; font-size: 19px; color: #8b949e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding: 0 28px }
.col { background: #11161f; border: 1px solid #262c36; border-radius: 12px; padding: 14px 18px; height: 520px; overflow: hidden }
.col.fin { border-color: #3a4454 }
.ch { display: flex; justify-content: space-between; align-items: center }
.name { font-size: 40px; font-weight: 800; line-height: 1 } .name.long { font-size: 30px } .sub { font-size: 16px; color: #8b949e; margin-top: 4px }
.clock { font: 800 64px/1 Menlo, Consolas, monospace; letter-spacing: -2px }
.status { font-size: 19px; color: #8b949e; margin: 8px 0 8px }
.row { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 8px; align-items: baseline; font-size: 19px; padding: 6px 0; border-top: 1px solid #1d232d }
.tick { font-weight: 800 } .q { color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis } .a { color: #e6edf3; font: 600 18px Menlo, Consolas, monospace; max-width: 215px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right }
.foot { position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 28px 10px; font-size: 16px; color: #8b949e; border-top: 1px solid #1d232d; background: #0b0e14 }`;

function footer(inp: RenderInput): string {
  const batches = inp.batches.length;
  if (inp.vs === "claude-code") return `Same ${inp.scored.length} questions in ${batches} batches · Claude Code: one claude -p per batch, signed-in subscription · measured ${inp.date} · navvi ${inp.commit.slice(0, 7)} · median of ${inp.runs} runs`;
  return `Both lanes · same ${inp.scored.length} questions in ${batches} batches · over HTTP APIs · measured ${inp.date} · navvi ${inp.commit.slice(0, 7)} · median of ${inp.runs} runs`;
}

function raceFrame(inp: RenderInput, tMs: number): string {
  const speed = inp.speed > 1 ? `<div class="speed">shown at ${inp.speed}× speed</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
  <div class="title"><h1>Same decisions. Same questions.</h1>${speed}</div>
  <div class="task">${esc(`Real questions navvi asked while compiling: "${process.env.DECISIONS_PROMPT_SHOWN ?? inp.site}"`)}</div>
  <div class="cols">${column(inp, inp.vs, tMs)}${column(inp, "jev", tMs)}</div>
  <div class="foot">${esc(footer(inp))}</div></body></html>`;
}

function endCard(inp: RenderInput): string {
  const h = laneOf(inp.run, inp.vs).totalMs / 1000;
  const j = laneOf(inp.run, "jev").totalMs / 1000;
  const other = laneLabel(inp, inp.vs).name;
  const ratio = h / j;
  const n = inp.scored.length;
  const hm = inp.scored.filter((s) => s.otherMatch).length;
  const jm = inp.scored.filter((s) => s.jevMatch).length;
  const ag = inp.scored.filter((s) => s.agree).length;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}
  .card { display: flex; flex-direction: column; align-items: center; justify-content: center; height: ${HEIGHT - 44}px; text-align: center; gap: 18px }
  .big { font-size: ${other.length > 12 ? 46 : 54}px; font-weight: 800; color: #e6edf3; letter-spacing: -1px } .big .j { color: #7ee787 } .big .h { color: #d2a8ff }
  .x { font-size: 76px; font-weight: 900; color: #7ee787; letter-spacing: -2px }
  .n { font-size: 26px; color: #c9d1d9 } .acc { font-size: 22px; color: #8b949e } .tag { margin-top: 18px; font-size: 26px; color: #79c0ff; font-weight: 700 }
  </style></head><body><div class="card">
    <div class="n">${n} decisions, ${inp.batches.length} batches</div>
    <div class="big"><span class="j">Jev: ${j.toFixed(1)}s</span> · <span class="h">${esc(other)}: ${h.toFixed(1)}s</span></div>
    <div class="x">${ratio.toFixed(1)}× faster at deciding</div>
    <div class="acc">Matched the reference answer: Jev ${jm}/${n} · ${esc(other)} ${hm}/${n} · lanes agreed ${ag}/${n}</div>
    <div class="tag">navvi — prompt → reusable scraper. Zero LLM calls on re-runs.</div>
  </div><div class="foot">${esc(footer(inp))}</div></body></html>`;
}

// ---------------------------------------------------------------- render: visual cut

const VISUAL_FINAL_HOLD_S = 1.6;
/** After both lanes have answered a batch, the page keeps showing it this long (display seconds) before moving on. */
const VISUAL_LANDED_HOLD_S = 0.9;
const PANE_W = 860;
const PANE_H = 486;
const BOX_COLOR: Record<"jev" | "other", { line: string; fill: string }> = {
  jev: { line: "#2da44e", fill: "rgba(46,164,78,0.13)" },
  other: { line: "#8250df", fill: "rgba(130,80,223,0.10)" },
};

type BatchKind = "nav" | "done" | "group" | "fields" | "list" | "other";

function batchKind(b: CapturedBatch): BatchKind {
  const ids = b.questions.map((q) => q.id);
  if (ids.some((id) => /^nav\.\d+\.op$/.test(id))) return "nav";
  if (ids.some((id) => /^nav\.\d+\.done$/.test(id))) return "done";
  if (ids.includes("group")) return "group";
  if (ids.some((id) => id.startsWith("field."))) return "fields";
  if (ids.some((id) => id.startsWith("list."))) return "list";
  return "other";
}

const BATCH_TITLE: Record<BatchKind, [string, string]> = {
  nav: ["Next step: which action, on which control?", "Next step"],
  done: ["Is the search done?", "Search done?"],
  group: ["Which list holds the results?", "Results list"],
  fields: ["Which element is each field? Which link is the next page?", "Fields + next"],
  list: ["One value per record, or every match as a list?", "One or a list?"],
  other: ["Which option?", "Decision"],
};

/** Where a picked option sits on the page, and what to call it there. */
function boxLabel(q: Question): string {
  if (/^nav\.\d+\.click$/.test(q.id)) return "click";
  if (/^nav\.\d+\.type$/.test(q.id)) return "type here";
  if (/^nav\.\d+\.select$/.test(q.id)) return "select";
  if (q.id === "group" || q.id.startsWith("group")) return "results list";
  if (q.id.startsWith("field.")) return q.id.slice(6).split(/[./]/)[0]!.replace(/_/g, " ");
  if (q.id.startsWith("link.next")) return "next page";
  if (q.id.startsWith("list.")) return `${q.id.slice(5).replace(/_/g, " ")} as a list`;
  return "pick";
}

const answerOf = (lane: LaneRun, batch: number, id: string): Answer | undefined => lane.batches.find((b) => b.batch === batch)?.answers.find((a) => a.id === id);

/** One line for what a lane decided in a batch: `full` for under the page, compact for the rail. */
function batchPick(b: CapturedBatch, answers: (id: string) => Answer | undefined, full: boolean): string {
  const q = (re: RegExp) => b.questions.find((x) => re.test(x.id));
  switch (batchKind(b)) {
    case "nav": {
      const op = q(/^nav\.\d+\.op$/)!;
      const name = pickText(op, answers(op.id));
      const target = (re: RegExp) => { const t = q(re); const txt = t ? pickText(t, answers(t.id)) : "none"; return full ? txt : txt.split(" ")[0]!; };
      if (name === "CLICK") return `CLICK → ${target(/^nav\.\d+\.click$/)}`;
      if (name === "TYPE_TEXT") return `TYPE → ${target(/^nav\.\d+\.type$/)}`;
      if (name === "SELECT") return `SELECT → ${target(/^nav\.\d+\.select$/)}`;
      return full && name === "DONE" ? "DONE: the goal is met on this page" : name;
    }
    case "done": { const d = q(/^nav\.\d+\.done$/)!; return pickText(d, answers(d.id)); }
    case "group": { const g = b.questions[0]!; const t = pickText(g, answers(g.id)); return full ? t : t.split(" (")[0]!; }
    case "fields": {
      const fields = b.questions.filter((x) => x.id.startsWith("field."));
      const found = fields.filter((f) => { const a = answers(f.id); return a && a.index !== null; });
      const next = q(/^link\.next/);
      const nextPick = next ? pickText(next, answers(next.id)) : "";
      if (!full) return `${found.length}/${fields.length} fields`;
      return `${found.length} of ${fields.length} fields located${next ? ` · next page: ${nextPick}` : ""}`;
    }
    case "list": return b.questions.map((x) => { const a = answers(x.id); const f = x.id.slice(5).replace(/_/g, " "); return !a ? "(no answer)" : a.index === null ? (full ? `${f}: none, keep the one element` : "one value") : (full ? `${f}: every match, as a list` : "list"); }).join(", ");
    default: return b.questions.map((x) => pickText(x, answers(x.id))).join(", ");
  }
}

function batchMatches(b: CapturedBatch, lane: LaneRun): { n: number; m: number } {
  let m = 0;
  for (const q of b.questions) {
    const ref = b.answers.find((a) => a.id === q.id);
    const got = answerOf(lane, b.batch, q.id);
    if (got && ref && got.index === ref.index) m += 1;
  }
  return { n: b.questions.length, m };
}

/** The part of the viewport screenshot the pane shows for a batch: every picked element (reference and both lanes) in view, fixed for the batch. */
function paneCrop(inp: RenderInput, b: CapturedBatch, v: VisualBatch): { x: number; y: number; w: number; h: number; scale: number } {
  const vw = v.viewport.width;
  const vh = v.viewport.height;
  const picked: VisualBox[] = [];
  for (const q of b.questions) {
    const boxes = v.boxes[q.id];
    if (!boxes) continue;
    for (const a of [b.answers.find((x) => x.id === q.id), answerOf(laneOf(inp.run, "jev"), b.batch, q.id), answerOf(laneOf(inp.run, inp.vs), b.batch, q.id)]) {
      const box = a && a.index !== null ? boxes[a.index] : null;
      // A results list spans the page; it does not decide the zoom.
      // A very wide element (a full-width search bar) counts by its left part, so the zoom stays readable.
      if (box && box.y < vh && box.y + box.h > 0 && q.id !== "group") picked.push({ ...box, w: Math.min(box.w, 700) });
    }
  }
  const aspect = PANE_H / PANE_W;
  let w = Math.min(vw, 860);
  let cx = 0;
  let cy = 0;
  if (picked.length) {
    const x0 = Math.min(...picked.map((p) => p.x)); const y0 = Math.min(...picked.map((p) => Math.max(0, p.y)));
    const x1 = Math.max(...picked.map((p) => p.x + p.w)); const y1 = Math.max(...picked.map((p) => Math.min(vh, p.y + p.h)));
    w = Math.min(vw, Math.max(w, x1 - x0 + 120, (y1 - y0 + 160) / aspect));
    const wide = picked.some((p) => p.w === 700);
    cx = Math.min(x0 - (wide ? 200 : 60), (x0 + x1) / 2 - w / 2);
    cy = y0 - 90;
  } else {
    // Nothing picked on this page: show its top left, from where its located elements start.
    const all = inp.visual ? [...inp.visual.values()].flatMap((x) => Object.values(x.boxes).flat()) : [];
    const lefts = all.filter((x): x is VisualBox => !!x && x.y < vh && x.w < vw / 2).map((x) => x.x);
    w = Math.min(vw, 980);
    cx = lefts.length ? Math.min(...lefts) - 30 : 0;
  }
  let h = w * aspect;
  if (h > vh) { h = vh; w = h / aspect; }
  const x = Math.max(0, Math.min(vw - w, cx));
  const y = Math.max(0, Math.min(vh - h, cy));
  return { x, y, w, h, scale: PANE_W / w };
}

const isElementQuestion = (q: Question): boolean => q.kind === "choice" && (/^nav\.\d+\.(click|type|select)$/.test(q.id) || q.id.startsWith("group") || q.id.startsWith("field.") || q.id.startsWith("link.") || q.id.startsWith("list."));

/**
 * The outlines and labels on the page for the lanes that have answered this
 * batch: the other lane's box outside, Jev's inside. When both lanes picked
 * the same element it gets one label with both lane colors; different picks
 * get one label each. Labels are placed where they do not cover each other.
 */
function paneOverlay(inp: RenderInput, b: CapturedBatch, v: VisualBatch, answered: readonly Lane[], crop: ReturnType<typeof paneCrop>): string {
  const toPane = (box: VisualBox, pad: number) => ({ left: (box.x - crop.x) * crop.scale - pad, top: (box.y - crop.y) * crop.scale - pad, width: box.w * crop.scale + 2 * pad, height: box.h * crop.scale + 2 * pad });
  const outlines: string[] = [];
  const edges: string[] = [];
  const chips: Array<{ label: string; whos: Array<"jev" | "other">; r: ReturnType<typeof toPane> }> = [];
  for (const q of b.questions) {
    if (!isElementQuestion(q)) continue;
    const ref = b.answers.find((x) => x.id === q.id);
    const picks = answered.map((lane) => ({ lane, who: (lane === "jev" ? "jev" : "other") as "jev" | "other", a: answerOf(laneOf(inp.run, lane), b.batch, q.id) }))
      .filter((p) => p.a && p.a.index !== null);
    const byIndex = new Map<number, typeof picks>();
    for (const p of picks) byIndex.set(p.a!.index!, [...(byIndex.get(p.a!.index!) ?? []), p]);
    for (const [index, ps] of byIndex) {
      const box = v.boxes[q.id]?.[index];
      const label = `${boxLabel(q)}${ref && ref.index === index ? "" : " ≠"}`;
      const whos = ps.map((p) => p.who).sort((x, y) => (x === "jev" ? -1 : y === "jev" ? 1 : 0));
      if (!box) { edges.push(`<div class="edge">${whos.map((w) => `<i style="background:${BOX_COLOR[w].line}"></i>`).join("")}${esc(label)}: not located on the page</div>`); continue; }
      const inner = toPane(box, 3);
      if (inner.top > PANE_H || inner.top + inner.height < 0) { edges.push(`<div class="edge">${whos.map((w) => `<i style="background:${BOX_COLOR[w].line}"></i>`).join("")}${inner.top > PANE_H ? "↓" : "↑"} ${esc(label)}: outside this view</div>`); continue; }
      for (const w of [...whos].reverse()) {
        const r = toPane(box, w === "jev" ? 3 : 8);
        outlines.push(`<div class="hl" style="left:${r.left.toFixed(1)}px;top:${r.top.toFixed(1)}px;width:${r.width.toFixed(1)}px;height:${r.height.toFixed(1)}px;border-color:${BOX_COLOR[w].line};background:${BOX_COLOR[w].fill}"></div>`);
      }
      chips.push({ label, whos, r: toPane(box, whos.includes("other") ? 8 : 3) });
    }
  }
  // Label placement: above or below the box, left or right aligned, the first spot inside the pane that overlaps no earlier label.
  type Rect = { x: number; y: number; w: number; h: number };
  const placed: Rect[] = [];
  const overlaps = (a: Rect, p: Rect) => a.x < p.x + p.w && p.x < a.x + a.w && a.y < p.y + p.h && p.y < a.y + a.h;
  // Labels avoid each other and every outlined element smaller than a quarter of the pane (a results list is not one).
  const obstacles: Rect[] = chips.map((c) => ({ x: c.r.left, y: c.r.top, w: c.r.width, h: c.r.height })).filter((r) => r.w * r.h < (PANE_W * PANE_H) / 4);
  const hit = (a: Rect) => placed.some((p) => overlaps(a, p)) || obstacles.some((o) => overlaps(a, o));
  const labels = chips.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left).map((c) => {
    const w = c.label.length * 8.6 + 16 + c.whos.length * 14;
    const h = 23;
    const { left, top, width, height } = c.r;
    const spots = [
      { x: left, y: top - h - 1 }, { x: left, y: top + height + 1 }, { x: left + width - w, y: top - h - 1 }, { x: left + width - w, y: top + height + 1 },
      { x: left + width + 4, y: top }, { x: left - w - 4, y: top }, { x: left + 4, y: top + 4 },
    ].map((sp) => ({ x: Math.max(4, Math.min(PANE_W - w - 4, sp.x)), y: Math.max(4, Math.min(PANE_H - h - 4, sp.y)), w, h }));
    const spot = spots.find((sp) => !hit(sp)) ?? spots.find((sp) => !placed.some((p) => overlaps(sp, p))) ?? spots[0]!;
    placed.push(spot);
    const bg = c.whos.length === 1 ? BOX_COLOR[c.whos[0]!].line : "#161b22";
    return `<div class="tag" style="left:${spot.x.toFixed(1)}px;top:${spot.y.toFixed(1)}px;background:${bg}">${c.whos.length > 1 ? c.whos.map((w) => `<i style="background:${BOX_COLOR[w].line}"></i>`).join("") : ""}${esc(c.label)}</div>`;
  });
  return `${outlines.join("")}${labels.join("")}${edges.length ? `<div class="edges">${edges.join("")}</div>` : ""}`;
}

/** The batch the page pane shows at measured time t, and whether each lane has answered it. */
function paneBatch(inp: RenderInput, tMs: number): CapturedBatch {
  const doneAt = (b: CapturedBatch) => Math.max(...([inp.vs, "jev"] as const).map((l) => laneOf(inp.run, l).batches.find((x) => x.batch === b.batch)?.endMs ?? Infinity));
  const landed = inp.batches.filter((b) => doneAt(b) <= tMs);
  const working = inp.batches.find((b) => doneAt(b) > tMs);
  if (!working) return inp.batches[inp.batches.length - 1]!;
  const last = landed[landed.length - 1];
  if (last && (tMs - doneAt(last)) / inp.speed < VISUAL_LANDED_HOLD_S * 1000) return last;
  return working;
}

function laneRail(inp: RenderInput, lane: Lane, tMs: number, shown: number): string {
  const lr = laneOf(inp.run, lane);
  const done = lr.batches.filter((b) => b.endMs <= tMs);
  const finished = done.length === lr.batches.length;
  const clock = finished ? lr.totalMs : Math.min(tMs, lr.totalMs);
  const { name, sub, color } = laneLabel(inp, lane);
  const decisions = inp.batches.filter((b) => done.some((d) => d.batch === b.batch)).reduce((n, b) => n + b.questions.length, 0);
  const rows = inp.batches.map((b) => {
    const answered = done.some((d) => d.batch === b.batch);
    const cur = b.batch === shown ? " cur" : "";
    if (!answered) return `<div class="rrow pending${cur}"><span class="tick">·</span><span class="q">${esc(BATCH_TITLE[batchKind(b)][1])}</span><span class="a"></span></div>`;
    const { n, m } = batchMatches(b, lr);
    const ok = n === m;
    return `<div class="rrow${cur}"><span class="tick" style="color:${ok ? "#7ee787" : "#ffa657"}">${ok ? "✓" : "≠"}</span><span class="q">${esc(BATCH_TITLE[batchKind(b)][1])}</span><span class="a">${esc(clip(batchPick(b, (id) => answerOf(lr, b.batch, id), false), 18))}</span></div>`;
  }).join("");
  const status = finished ? `<span style="color:${color}">done · ${decisions} decisions</span>` : `${decisions} / ${inp.scored.length} decisions`;
  return `<div class="rail${finished ? " fin" : ""}">
    <div class="rh"><div><div class="rname${name.length > 12 ? " long" : ""}" style="color:${color}">${esc(name)}</div><div class="rsub">${esc(sub)}</div></div><div class="rclock" style="color:${finished ? color : "#e6edf3"}">${(clock / 1000).toFixed(1)}s</div></div>
    <div class="rstatus">${status}</div>${rows}</div>`;
}

const VISUAL_STYLE = `
.vmain { position: absolute; top: 64px; left: 20px; right: 20px; display: grid; grid-template-columns: ${PANE_W}px 1fr; gap: 16px }
.pane { background: #11161f; border: 1px solid #262c36; border-radius: 12px; overflow: hidden }
.ph { display: flex; justify-content: space-between; align-items: baseline; padding: 8px 14px 6px; font-size: 21px; color: #e6edf3; font-weight: 700 }
.ph .bn { font-size: 16px; color: #8b949e; font-weight: 600 }
.bar { display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: #2d333b; color: #adbac7; font-size: 13px }
.bar .dots span { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px }
.bar .url { flex: 1; background: #1c2128; border-radius: 4px; padding: 2px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.shot { position: relative; width: ${PANE_W}px; height: ${PANE_H}px; overflow: hidden; background: #fff }
.shot img { position: absolute; display: block; max-width: none }
.hl { position: absolute; border: 4px solid; border-radius: 6px }
.tag { position: absolute; color: #fff; font: 700 15px/1 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; padding: 4px 7px; border-radius: 5px; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.35) }
.tag i, .edge i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px }
.edges { position: absolute; left: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 6px }
.edge { background: #161b22; color: #fff; font: 700 15px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; padding: 5px 9px; border-radius: 5px }
.strip { padding: 7px 14px 8px; border-top: 1px solid #262c36 }
.sl { display: grid; grid-template-columns: 14px 150px minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: 18px; padding: 2px 0 }
.sl .dot { width: 12px; height: 12px; border-radius: 3px } .sl .who { font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.sl .what { color: #e6edf3; font: 600 16px Menlo, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis } .sl .when { color: #8b949e; font: 600 16px Menlo, Consolas, monospace }
.rails { display: grid; grid-template-rows: 1fr 1fr; gap: 12px; height: 610px }
.rail { background: #11161f; border: 1px solid #262c36; border-radius: 12px; padding: 10px 14px; overflow: hidden }
.rail.fin { border-color: #3a4454 }
.rh { display: flex; justify-content: space-between; align-items: center }
.rname { font-size: 30px; font-weight: 800; line-height: 1 } .rname.long { font-size: 20px } .rsub { font-size: 12px; color: #8b949e; margin-top: 3px; max-width: 190px }
.rclock { font: 800 46px/1 Menlo, Consolas, monospace; letter-spacing: -2px }
.rstatus { font-size: 16px; color: #8b949e; margin: 5px 0 4px }
.rrow { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 6px; align-items: baseline; font-size: 16px; padding: 3px 4px; border-top: 1px solid #1d232d }
.rrow.pending { color: #545d68 } .rrow.cur { background: #1b2230; border-radius: 4px }
.rrow .a { font: 600 14px Menlo, Consolas, monospace; color: #e6edf3; white-space: nowrap }
.rrow .tick { font-weight: 800 }`;

function visualFrame(inp: RenderInput, tMs: number): string {
  const b = paneBatch(inp, tMs);
  const v = inp.visual!.get(b.batch);
  const pos = inp.batches.indexOf(b) + 1;
  let pane: string;
  if (v) {
    const crop = paneCrop(inp, b, v);
    const img = `<img src="${v.dataUri}" style="left:${(-crop.x * crop.scale).toFixed(1)}px;top:${(-crop.y * crop.scale).toFixed(1)}px;width:${(v.viewport.width * crop.scale).toFixed(1)}px;height:${(v.viewport.height * crop.scale).toFixed(1)}px">`;
    // The other lane's (outer) box first, Jev's (inner) on top, each only once that lane has answered.
    const lanes = ([inp.vs, "jev"] as const).filter((l) => (laneOf(inp.run, l).batches.find((x) => x.batch === b.batch)?.endMs ?? Infinity) <= tMs);
    pane = `<div class="bar"><span class="dots"><span style="background:#ff5f56"></span><span style="background:#ffbd2e"></span><span style="background:#27c93f"></span></span><span class="url">${esc(v.url)}</span></div>
      <div class="shot">${img}${paneOverlay(inp, b, v, lanes, crop)}</div>`;
  } else {
    pane = `<div class="bar"><span class="url">(no screenshot for this batch)</span></div><div class="shot"></div>`;
  }
  const strip = ([ "jev", inp.vs ] as const).map((l) => {
    const lr = laneOf(inp.run, l);
    const lb = lr.batches.find((x) => x.batch === b.batch);
    const { name, color } = laneLabel(inp, l);
    const short = l === "jev" ? "Jev" : name;
    if (lb && lb.endMs <= tMs) {
      const { n, m } = batchMatches(b, lr);
      return `<div class="sl"><span class="dot" style="background:${BOX_COLOR[l === "jev" ? "jev" : "other"].line}"></span><span class="who" style="color:${color}">${esc(short)}</span><span class="what">${n === m ? "✓" : `≠ ${m}/${n}`} ${esc(batchPick(b, (id) => answerOf(lr, b.batch, id), true))}</span><span class="when">${(lb.ms / 1000).toFixed(1)}s</span></div>`;
    }
    const thinking = lb && lb.startMs <= tMs ? `${((tMs - lb.startMs) / 1000).toFixed(1)}s` : "";
    return `<div class="sl"><span class="dot" style="background:${BOX_COLOR[l === "jev" ? "jev" : "other"].line}"></span><span class="who" style="color:${color}">${esc(short)}</span><span class="what" style="color:#8b949e">${thinking ? "thinking…" : "…"}</span><span class="when">${thinking}</span></div>`;
  }).join("");
  const speed = inp.speed > 1 ? `<div class="speed">shown at ${inp.speed}× speed</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}${VISUAL_STYLE}
  .title { padding: 12px 20px 0 } .title h1 { font-size: 34px }</style></head><body>
  <div class="title"><h1>Same questions, on the page navvi was reading.</h1>${speed}</div>
  <div class="vmain">
    <div class="pane"><div class="ph"><span>${esc(BATCH_TITLE[batchKind(b)][0])}</span><span class="bn">batch ${pos} of ${inp.batches.length}</span></div>${pane}<div class="strip">${strip}</div></div>
    <div class="rails">${laneRail(inp, "jev", tMs, b.batch)}${laneRail(inp, inp.vs, tMs, b.batch)}</div>
  </div>
  <div class="foot">${esc(footer(inp))}</div></body></html>`;
}

async function render(dir: string, inp: RenderInput): Promise<{ gif: string; mp4: string }> {
  const frames = join(dir, "frames");
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })).newPage();
  const total = Math.max(laneOf(inp.run, inp.vs).totalMs, laneOf(inp.run, "jev").totalMs);
  let i = 0;
  const shot = async (html: string, count: number) => {
    await page.setContent(html);
    const first = join(frames, `${String(i).padStart(5, "0")}.png`);
    await page.screenshot({ path: first, type: "png" });
    i += 1;
    for (let k = 1; k < count; k++) {
      copyFileSync(first, join(frames, `${String(i).padStart(5, "0")}.png`));
      i += 1;
    }
  };
  const frameAt = inp.visual ? visualFrame : raceFrame;
  await shot(frameAt(inp, 0), Math.round(INTRO_S * FPS));
  const activeFrames = Math.ceil((total / inp.speed / 1000) * FPS);
  let last = "";
  let run = 0;
  for (let f = 0; f <= activeFrames; f++) {
    const tMs = Math.min(total, (f / FPS) * 1000 * inp.speed);
    const html = frameAt(inp, tMs);
    if (html === last) {
      copyFileSync(join(frames, `${String(i - 1).padStart(5, "0")}.png`), join(frames, `${String(i).padStart(5, "0")}.png`));
      i += 1;
      run++;
      continue;
    }
    last = html;
    await shot(html, 1);
  }
  await shot(frameAt(inp, total), Math.round((inp.visual ? VISUAL_FINAL_HOLD_S : 1.2) * FPS));
  await shot(endCard(inp), Math.round(END_HOLD_S * FPS));
  await browser.close();
  const input = join(frames, "%05d.png");
  const gif = join(dir, "decisions-race.gif");
  const mp4 = join(dir, "decisions-race.mp4");
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-vf", `fps=${GIF_FPS},split[s0][s1];[s0]palettegen=max_colors=${inp.visual ? 128 : 64}:stats_mode=diff[p];[s1][p]paletteuse=dither=none:diff_mode=rectangle`, "-loop", "0", gif], { stdio: "inherit" });
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-r", "30", "-movflags", "+faststart", mp4], { stdio: "inherit" });
  for (const f of [gif, mp4]) console.log(`${f}: ${(statSync(f).size / 1024 / 1024).toFixed(2)} MB`);
  return { gif, mp4 };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const mode = process.env.DECISIONS_MODE ?? "capture";
  if (!["capture", "race", "render", "bench"].includes(mode)) throw new Error("DECISIONS_MODE must be capture, race, render or bench");
  const parent = resolve(process.env.DECISIONS_OUT ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "navvi-decisions-"));
  console.log(`run directory: ${dir}`);
  const commit = sh("git", ["rev-parse", "HEAD"]);
  const workingTree = sh("git", ["status", "--porcelain"]);
  if (mode === "bench") {
    const src = process.env.DECISIONS_CAPTURE;
    if (!src) throw new Error("DECISIONS_CAPTURE is required in bench mode");
    const captureDir = join(dir, "capture");
    cpSync(join(resolve(src), "capture"), captureDir, { recursive: true });
    const lanes = (process.env.DECISIONS_LANES ?? "jev,haiku").split(",").map((l) => l.trim());
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    if (lanes.includes("haiku") && !env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY is required (Haiku lane over the AI Gateway)");
    if (lanes.includes("jev") && !env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required (Jev lane over the TypeSafe API)");
    await bench(dir, captureDir, env, commit, workingTree);
    return;
  }
  execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });

  let captureDir = join(dir, "capture");
  let runs: RaceRun[];
  let raceMeta: { measuredAt: string; commit: string; workingTree: string };
  let vs = vsLane(process.env.DECISIONS_VS);
  const visual = process.env.DECISIONS_VISUAL === "1";
  if (mode === "render") {
    const source = process.env.DECISIONS_SOURCE;
    if (!source) throw new Error("DECISIONS_SOURCE is required in render mode");
    captureDir = join(resolve(source), "capture");
    const saved = JSON.parse(readFileSync(join(resolve(source), "race.json"), "utf8")) as { runs: RaceRun[]; measuredAt: string; commit: string; workingTree: string; vs?: Vs };
    runs = saved.runs;
    // The race decides the pair; a race.json from before DECISIONS_VS is Haiku vs Jev.
    vs = vsLane(saved.vs ?? "haiku");
    raceMeta = saved;
    // The re-render directory carries the race and capture it was drawn from.
    copyFileSync(join(resolve(source), "race.json"), join(dir, "race.json"));
    cpSync(captureDir, join(dir, "capture"), { recursive: true });
  } else {
    const env = laneEnv(mode === "capture" || vs === "haiku");
    if (mode === "capture") await capture(captureDir, env, visual);
    else {
      const src = process.env.DECISIONS_CAPTURE;
      if (!src) throw new Error("DECISIONS_CAPTURE is required in race mode");
      // Keep the run directory self-contained: the capture it raced travels with it.
      cpSync(join(resolve(src), "capture"), captureDir, { recursive: true });
    }
    if (visual && !existsSync(join(captureDir, "visual.json"))) throw new Error("DECISIONS_VISUAL=1 needs a capture made with DECISIONS_VISUAL=1 (capture/visual.json)");
    const batches = loadBatches(captureDir);
    runs = await race(batches, env, Number(process.env.DECISIONS_RUNS ?? 3), vs);
    raceMeta = { measuredAt: new Date().toISOString(), commit, workingTree };
    writeFileSync(join(dir, "race.json"), JSON.stringify({ ...raceMeta, vs, captureDir, runs }, null, 2) + "\n");
  }
  const failed = runs.flatMap((r) => [laneOf(r, vs), laneOf(r, "jev")].filter((l) => l.error).map((l) => `run ${r.run} ${l.lane}: ${l.error}`));
  if (failed.length) throw new Error(`race failed, nothing rendered: ${failed.join("; ")}`);

  const batches = loadBatches(captureDir);
  const cap = JSON.parse(readFileSync(join(captureDir, "capture.json"), "utf8")) as Record<string, unknown> & { url: string; prompt: string; capturedAt: string; commit: string };
  const allCaptured = readFileSync(join(captureDir, "questions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as CapturedBatch);
  const sorted = [...runs].sort((a, b) => a.ratio - b.ratio);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const scored = score(batches, median, vs);
  const total = Math.max(laneOf(median, vs).totalMs, laneOf(median, "jev").totalMs) / 1000;
  const speed = total <= MAX_ACTIVE_S ? 1 : Math.ceil(total / MAX_ACTIVE_S);
  const date = raceMeta.measuredAt.slice(0, 10);
  process.env.DECISIONS_PROMPT_SHOWN = cap.prompt;
  const haikuModel = vs === "haiku" ? laneOf(median, "haiku").modelId.replace(/^anthropic\//, "") : laneOf(median, vs).modelId.replace(/^claude --model /, "");
  let visuals: VisualBatch[] | undefined;
  if (visual) {
    if (!existsSync(join(captureDir, "visual.json"))) throw new Error("DECISIONS_VISUAL=1 needs a capture made with DECISIONS_VISUAL=1 (capture/visual.json)");
    visuals = JSON.parse(readFileSync(join(captureDir, "visual.json"), "utf8")) as VisualBatch[];
  }
  const visualMap = visuals && new Map(visuals.map((v) => [v.batch, { ...v, dataUri: `data:image/png;base64,${readFileSync(join(captureDir, "visual", v.shot)).toString("base64")}` }]));
  const media = await render(dir, { batches, run: median, scored, date, commit: raceMeta.commit, site: cap.url, speed, runs: runs.length, haikuModel, vs, visual: visualMap });
  const stem = `${vs === "haiku" ? "docs/decisions-race" : `docs/decisions-race-${vs}`}${visual ? "-visual" : ""}`;
  const otherName = vs === "haiku" ? "Haiku" : "Haiku via Claude Code";
  // Provenance keys the other lane by its lane name (haiku, claude-code).
  const named = (s: Scored) => { const { other, otherMatch, ...rest } = s; return { ...rest, [vs]: other, [`${vs === "haiku" ? "haiku" : "claudeCode"}Match`]: otherMatch }; };

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const provenance = {
    claim: vs === "claude-code"
      ? "Jev vs Haiku through Claude Code (navvi's CliChooser, the default without an API key) on the decision step only: the same captured choice/boolean questions, same batches, sequential per lane, wall clock per batch; the Claude Code lane includes starting one claude process per batch."
      : "Jev vs Haiku on the decision step only: the same captured choice/boolean questions, same batches, sequential per lane, wall clock per batch.",
    measuredAt: raceMeta.measuredAt,
    navviCommit: raceMeta.commit,
    workingTreeAtMeasurement: raceMeta.workingTree || "clean",
    capture: {
      site: cap.url, task: cap.prompt, capturedAt: cap.capturedAt, commit: cap.commit,
      referenceDecider: cap.referenceDecider, status: cap.status, items: cap.items, fieldsNotFound: cap.fieldsNotFound,
      entryPoint: "src/main.ts run() (the CLI's entry point); chooser wrapped in RecordingChooser plus a full-question logger",
      rows: JSON.parse(readFileSync(join(captureDir, "rows.json"), "utf8")),
      allBatchesAsked: allCaptured.map((b) => ({ batch: b.batch, questions: b.questions.map((q) => ({ id: q.id, kind: q.kind })) })),
      // capture/questions.jsonl, with each batch's shared state stored once instead of once per question.
      questionsJsonl: allCaptured.map((b) => ({ ...b, state: b.questions[0]?.state ?? "", questions: b.questions.map(({ state, ...q }) => (state === b.questions[0]?.state ? q : { ...q, state })) })),
    },
    excludedFromRace: "text questions (prompt parsing, the typed search query): Jev answers typed decisions and cannot write text, so they are not decisions in this comparison",
    raced: {
      batches: batches.length,
      questions: sum(batches.map((b) => b.questions.length)),
      kinds: batches.flatMap((b) => b.questions).reduce<Record<string, number>>((acc, q) => ({ ...acc, [q.kind]: (acc[q.kind] ?? 0) + 1 }), {}),
      questionList: batches.flatMap((b) => b.questions.map((q) => ({ batch: b.batch, id: q.id, kind: q.kind, label: premiseLabel(q), premise: q.premise, options: q.options?.length ?? 0, stateChars: q.state.length }))),
    },
    lanes: {
      [vs]: { label: otherName, chooser: vs === "haiku" ? "ModelChooser (stock validation since 8d868fb; a counting subclass records how many picks arrived with an explanation, changing nothing)" : "CliChooser(\"claude\") with ANTHROPIC_API_KEY and every CLAUDE* variable removed", modelId: laneOf(median, vs).modelId, transport: laneOf(median, vs).transport, ...(visual ? { measuredOnCommit: raceMeta.commit } : {}) },
      jev: { label: "Jev", chooser: "JevChooser", modelId: laneOf(median, "jev").modelId, transport: laneOf(median, "jev").transport, ...(visual ? { measuredOnCommit: raceMeta.commit } : {}) },
    },
    method: {
      warmUp: "one untimed one-question boolean call per lane immediately before its timed pass (connection setup); warm-up latency recorded below",
      order: `lanes run one after the other, never concurrently; order alternates per run (run 1 ${otherName} first, run 2 Jev first, ...)`,
      timing: "performance.now() around chooser.ask(batch) for each captured batch; lane total is wall clock over all batches; BaseChooser retries (if any) are inside the timing, apiBatches counts backend calls",
      medianRun: `the run with the median ${otherName}/Jev ratio is the one rendered`,
      reference: "the answer the reference decider gave during the capture run, whose navigation and extraction succeeded; matching it is agreement with that run, not ground truth",
      display: speed > 1 ? `time-compressed uniformly by ${speed}× for both lanes, stated on screen` : "real time",
    },
    runs: runs.map((r) => ({
      run: r.run, order: r.order, ratio: Number(r.ratio.toFixed(2)),
      lanes: Object.fromEntries(([vs, "jev"] as const).map((k) => { const l = laneOf(r, k); return [k, {
        totalMs: Math.round(l.totalMs), warmupMs: Math.round(l.warmupMs), ...(l.warmupError ? { warmupError: l.warmupError } : {}), apiBatches: l.apiBatches, ...(l.explanationTexts !== undefined ? { explanationTexts: l.explanationTexts } : {}),
        batches: l.batches.map((b) => ({ batch: b.batch, ms: Math.round(b.ms), answers: b.answers })),
      }]; })),
      agreement: (() => { const s = score(batches, r, vs); return { questions: s.length, [`${vs === "haiku" ? "haiku" : "claudeCode"}MatchesReference`]: s.filter((x) => x.otherMatch).length, jevMatchesReference: s.filter((x) => x.jevMatch).length, lanesAgree: s.filter((x) => x.agree).length }; })(),
    })),
    medianRun: median.run,
    rendered: { perQuestion: scored.map(named), speed, gif: `${stem}.gif`, mp4: `${stem}.mp4` },
    ...(visuals ? {
      visual: {
        screenshots: "one viewport screenshot of navvi's own crawler page per batch, taken through CrawlDeps.onPage inside the capture's chooser wrapper immediately before the batch was asked (read-only: screenshot and bounding-box reads only); not published, the render crops and scales them",
        boxesSource: "per option, the element navvi's optionContext names, located on that live page at capture time: controls by ARIA role and accessible name (Playwright getByRole(...).boundingBox, falling back to the anchor with the option's href); a result group as the union of `container > item`; a field candidate as the first element on its path whose text or attribute starts with the option's sample-1 value; a list candidate as the union of the path's elements holding sample 1's values; a link by href and text. Coordinates are CSS pixels in the viewport; null means not located",
        highlight: `${laneLabel({ vs } as RenderInput, "jev").name} outlined green (inner box, label above), ${otherName} purple (outer box, label below); a box appears when that lane's answer for the batch has landed at its measured time; ≠ marks a pick that differs from the reference; op and yes/no picks are written under the page`,
        batches: visuals.map((v) => ({ batch: v.batch, url: v.url, viewport: v.viewport, takenAtCaptureMs: Math.round(v.takenAtMs), boxes: v.boxes })),
      },
    } : {}),
  };
  writeFileSync(join(dir, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  if (process.env.DECISIONS_PUBLISH === "1") {
    copyFileSync(media.gif, `${stem}.gif`);
    copyFileSync(media.mp4, `${stem}.mp4`);
    copyFileSync(join(dir, "provenance.json"), `${stem}-provenance.json`);
    console.log(`published ${stem}.{gif,mp4} and ${stem}-provenance.json`);
  }
  for (const r of runs) console.log(`run ${r.run}: ${otherName} ${(laneOf(r, vs).totalMs / 1000).toFixed(2)} s · Jev ${(laneOf(r, "jev").totalMs / 1000).toFixed(2)} s · ${r.ratio.toFixed(2)}×`);
  console.log(`median run ${median.run}; evidence in ${dir}`);
  if (existsSync(join(dir, "frames"))) console.log(`frames: ${join(dir, "frames")}`);
}

crawleeLog.setLevel(LogLevel.WARNING);
try {
  await main();
} catch (error) {
  console.error(`record-decisions: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
process.exit();
