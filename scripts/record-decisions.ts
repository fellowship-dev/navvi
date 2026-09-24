import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Actor } from "apify";
import { LogLevel, MemoryStorage, log as crawleeLog } from "crawlee";
import { chromium } from "playwright";
import { JevChooser, ModelChooser, RecordingChooser, type Answer, type BackendResult, type Chooser, type Question } from "../src/chooser/index.js";
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
 *    per lane, wall clock per batch. Haiku: `ModelChooser` over the AI Gateway.
 *    Jev: `JevChooser` over the TypeSafe API. One untimed warm-up call per lane.
 *    `DECISIONS_RUNS` runs (default 3); lane order alternates per run.
 * 3. render — the median run (by speedup ratio) as GIF and MP4, answers ticking
 *    in at their measured times, plus `provenance.json`.
 *
 * Env:
 *   DECISIONS_MODE     capture (capture + race + render, default) | race (from DECISIONS_CAPTURE) | render (from DECISIONS_SOURCE)
 *   DECISIONS_CAPTURE  an existing run directory whose capture/ is reused (race mode)
 *   DECISIONS_SOURCE   an existing run directory whose race.json is re-rendered (render mode)
 *   DECISIONS_OUT      parent directory for the new run directory (default: system temp)
 *   DECISIONS_URL / DECISIONS_PROMPT   the public task (default: Hacker News search on hn.algolia.com)
 *   DECISIONS_REFERENCE_MODEL  capture decider (default claude-sonnet-4-6, via AI Gateway)
 *   DECISIONS_HAIKU_MODEL      default claude-haiku-4-5
 *   DECISIONS_RUNS     default 3
 *   DECISIONS_PUBLISH=1  copy gif/mp4/provenance to docs/decisions-race.*
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

interface LaneRun {
  lane: "haiku" | "jev";
  modelId: string;
  transport: string;
  warmupMs: number;
  warmupError?: string;
  /** Haiku lane: choice/boolean answers that arrived with an explanation in `text`, dropped before validation (includes the warm-up). */
  strippedExplanationTexts?: number;
  totalMs: number;
  batches: LaneBatch[];
  apiBatches: number;
  error?: string;
}

interface RaceRun {
  run: number;
  order: Array<"haiku" | "jev">;
  lanes: Record<"haiku" | "jev", LaneRun>;
  ratio: number;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sh = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: "utf8" }).trim();

function laneEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  if (!env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY is required (Haiku lane over the AI Gateway)");
  if (!env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required (Jev lane over the TypeSafe API)");
  return env;
}

// ---------------------------------------------------------------- capture

async function capture(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
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
  const logged: Chooser = {
    name: recording.name,
    usage: () => recording.usage(),
    async ask(batch: Question[]): Promise<Answer[]> {
      const id = ++n;
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
 * The Haiku lane. Measured on the captured navigation batches, Haiku returns
 * the right-shaped index but also fills the schema's optional `text` with an
 * explanation on choice questions ("TYPE_TEXT: enter ... to search for Python
 * stories"), and navvi's validator rejects any text on a choice twice, so the
 * stock ModelChooser fails the batch. This lane drops `text` on non-text
 * questions before validation and counts how often it had to. It changes no
 * index and adds no request; the count goes into the provenance.
 */
class HaikuLaneChooser extends ModelChooser {
  strippedText = 0;
  protected override async callBackend(batch: Question[]): Promise<BackendResult> {
    const result = await super.callBackend(batch);
    const kinds = new Map(batch.map((q) => [q.id, q.kind]));
    if (Array.isArray(result.answers)) {
      result.answers = result.answers.map((a: unknown) => {
        if (a && typeof a === "object" && "text" in a && kinds.get(String((a as { id?: unknown }).id)) !== "text") {
          this.strippedText += 1;
          const { text: _t, ...rest } = a as Record<string, unknown>;
          return rest;
        }
        return a;
      });
    }
    return result;
  }
}

const WARMUP: Question[] = [{ id: "w1", kind: "choice", premise: "Which of these is a fruit?", options: ["carrot", "apple", "stone"], state: "A grocery list." }];

async function raceLane(lane: "haiku" | "jev", batches: CapturedBatch[], env: NodeJS.ProcessEnv, haikuModel: string): Promise<LaneRun> {
  const chooser = lane === "haiku" ? new HaikuLaneChooser({ env, modelId: haikuModel }) : new JevChooser({ env, provider: "typesafe" });
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
    lane, modelId: lane === "haiku" ? `anthropic/${haikuModel}` : "jev-latest",
    transport: lane === "haiku" ? "Vercel AI Gateway (ModelChooser, AI SDK generateObject)" : "TypeSafe API https://api.typesafe.ai/v1/systemone (JevChooser, provider typesafe)",
    warmupMs, ...(warmupError ? { warmupError } : {}), totalMs, batches: out,
    ...(chooser instanceof HaikuLaneChooser ? { strippedExplanationTexts: chooser.strippedText } : {}), apiBatches: chooser.usage().batches - before, ...(error ? { error } : {}),
  };
}

async function race(batches: CapturedBatch[], env: NodeJS.ProcessEnv, runs: number): Promise<RaceRun[]> {
  const haikuModel = process.env.DECISIONS_HAIKU_MODEL ?? "claude-haiku-4-5";
  const out: RaceRun[] = [];
  for (let r = 1; r <= runs; r++) {
    const order: Array<"haiku" | "jev"> = r % 2 === 1 ? ["haiku", "jev"] : ["jev", "haiku"];
    const lanes = {} as Record<"haiku" | "jev", LaneRun>;
    for (const lane of order) {
      lanes[lane] = await raceLane(lane, batches, env, haikuModel);
      console.log(`run ${r} ${lane}: ${(lanes[lane].totalMs / 1000).toFixed(2)} s over ${lanes[lane].batches.length} batches${lanes[lane].error ? ` ERROR ${lanes[lane].error}` : ""}`);
    }
    out.push({ run: r, order, lanes, ratio: lanes.haiku.totalMs / lanes.jev.totalMs });
  }
  return out;
}

// ---------------------------------------------------------------- scoring

interface Scored {
  id: string;
  batch: number;
  kind: string;
  label: string;
  reference: string;
  haiku: string;
  jev: string;
  haikuMatch: boolean;
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

function score(batches: CapturedBatch[], run: RaceRun): Scored[] {
  const out: Scored[] = [];
  const find = (lane: LaneRun, batch: number, id: string) => lane.batches.find((b) => b.batch === batch)?.answers.find((a) => a.id === id);
  for (const b of batches) {
    for (const q of b.questions) {
      const ref = b.answers.find((a) => a.id === q.id);
      const h = find(run.lanes.haiku, b.batch, q.id);
      const j = find(run.lanes.jev, b.batch, q.id);
      out.push({
        id: q.id, batch: b.batch, kind: q.kind, label: premiseLabel(q),
        reference: pickText(q, ref), haiku: pickText(q, h), jev: pickText(q, j),
        haikuMatch: !!h && h.index === ref?.index, jevMatch: !!j && j.index === ref?.index, agree: !!h && !!j && h.index === j.index,
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
}

function column(inp: RenderInput, lane: "haiku" | "jev", tMs: number): string {
  const lr = inp.run.lanes[lane];
  const done = lr.batches.filter((b) => b.endMs <= tMs);
  const finished = done.length === lr.batches.length;
  const clock = finished ? lr.totalMs : Math.min(tMs, lr.totalMs);
  const answeredBatches = new Set(done.map((b) => b.batch));
  const rows = inp.scored.filter((s) => answeredBatches.has(s.batch));
  const visible = rows.slice(-VISIBLE_ROWS);
  const color = lane === "jev" ? "#7ee787" : "#d2a8ff";
  const name = lane === "jev" ? "Jev" : "Haiku";
  const sub = lane === "jev" ? "Jev · TypeSafe API" : `${inp.haikuModel} · AI Gateway`;
  const items = visible
    .map((s) => {
      const pick = lane === "jev" ? s.jev : s.haiku;
      const match = lane === "jev" ? s.jevMatch : s.haikuMatch;
      return `<div class="row"><span class="tick" style="color:${match ? "#7ee787" : "#ffa657"}">${match ? "✓" : "≠"}</span><span class="q">${esc(s.label)}</span><span class="a">${esc(clip(pick, 22))}</span></div>`;
    })
    .join("");
  const status = finished
    ? `<span style="color:${color}">done · ${rows.length} decisions</span>`
    : `${rows.length} / ${inp.scored.length} decisions`;
  return `<div class="col${finished ? " fin" : ""}">
    <div class="ch"><div><div class="name" style="color:${color}">${name}</div><div class="sub">${esc(sub)}</div></div><div class="clock" style="color:${finished ? color : "#e6edf3"}">${(clock / 1000).toFixed(1)}s</div></div>
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
.name { font-size: 40px; font-weight: 800; line-height: 1 } .sub { font-size: 16px; color: #8b949e; margin-top: 4px }
.clock { font: 800 64px/1 Menlo, Consolas, monospace; letter-spacing: -2px }
.status { font-size: 19px; color: #8b949e; margin: 8px 0 8px }
.row { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 8px; align-items: baseline; font-size: 19px; padding: 6px 0; border-top: 1px solid #1d232d }
.tick { font-weight: 800 } .q { color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis } .a { color: #e6edf3; font: 600 18px Menlo, Consolas, monospace; max-width: 215px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right }
.foot { position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 28px 10px; font-size: 16px; color: #8b949e; border-top: 1px solid #1d232d; background: #0b0e14 }`;

function footer(inp: RenderInput): string {
  const batches = inp.batches.length;
  return `Both lanes · same ${inp.scored.length} questions in ${batches} batches · over HTTP APIs · measured ${inp.date} · navvi ${inp.commit.slice(0, 7)} · median of ${inp.runs} runs`;
}

function raceFrame(inp: RenderInput, tMs: number): string {
  const speed = inp.speed > 1 ? `<div class="speed">shown at ${inp.speed}× speed</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
  <div class="title"><h1>Same decisions. Same questions.</h1>${speed}</div>
  <div class="task">${esc(`Real questions navvi asked while compiling: "${process.env.DECISIONS_PROMPT_SHOWN ?? inp.site}"`)}</div>
  <div class="cols">${column(inp, "haiku", tMs)}${column(inp, "jev", tMs)}</div>
  <div class="foot">${esc(footer(inp))}</div></body></html>`;
}

function endCard(inp: RenderInput): string {
  const h = inp.run.lanes.haiku.totalMs / 1000;
  const j = inp.run.lanes.jev.totalMs / 1000;
  const ratio = h / j;
  const n = inp.scored.length;
  const hm = inp.scored.filter((s) => s.haikuMatch).length;
  const jm = inp.scored.filter((s) => s.jevMatch).length;
  const ag = inp.scored.filter((s) => s.agree).length;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}
  .card { display: flex; flex-direction: column; align-items: center; justify-content: center; height: ${HEIGHT - 44}px; text-align: center; gap: 18px }
  .big { font-size: 54px; font-weight: 800; color: #e6edf3; letter-spacing: -1px } .big .j { color: #7ee787 } .big .h { color: #d2a8ff }
  .x { font-size: 76px; font-weight: 900; color: #7ee787; letter-spacing: -2px }
  .n { font-size: 26px; color: #c9d1d9 } .acc { font-size: 22px; color: #8b949e } .tag { margin-top: 18px; font-size: 26px; color: #79c0ff; font-weight: 700 }
  </style></head><body><div class="card">
    <div class="n">${n} decisions, ${inp.batches.length} batches</div>
    <div class="big"><span class="j">Jev: ${j.toFixed(1)}s</span> · <span class="h">Haiku: ${h.toFixed(1)}s</span></div>
    <div class="x">${ratio.toFixed(1)}× faster at deciding</div>
    <div class="acc">Matched the reference answer: Jev ${jm}/${n} · Haiku ${hm}/${n} · lanes agreed ${ag}/${n}</div>
    <div class="tag">navvi — prompt → reusable scraper. Zero LLM calls on re-runs.</div>
  </div><div class="foot">${esc(footer(inp))}</div></body></html>`;
}

async function render(dir: string, inp: RenderInput): Promise<{ gif: string; mp4: string }> {
  const frames = join(dir, "frames");
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })).newPage();
  const total = Math.max(inp.run.lanes.haiku.totalMs, inp.run.lanes.jev.totalMs);
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
  await shot(raceFrame(inp, 0), Math.round(INTRO_S * FPS));
  const activeFrames = Math.ceil((total / inp.speed / 1000) * FPS);
  let last = "";
  let run = 0;
  for (let f = 0; f <= activeFrames; f++) {
    const tMs = Math.min(total, (f / FPS) * 1000 * inp.speed);
    const html = raceFrame(inp, tMs);
    if (html === last) {
      copyFileSync(join(frames, `${String(i - 1).padStart(5, "0")}.png`), join(frames, `${String(i).padStart(5, "0")}.png`));
      i += 1;
      run++;
      continue;
    }
    last = html;
    await shot(html, 1);
  }
  await shot(raceFrame(inp, total), Math.round(1.2 * FPS));
  await shot(endCard(inp), Math.round(END_HOLD_S * FPS));
  await browser.close();
  const input = join(frames, "%05d.png");
  const gif = join(dir, "decisions-race.gif");
  const mp4 = join(dir, "decisions-race.mp4");
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-vf", `fps=${GIF_FPS},split[s0][s1];[s0]palettegen=max_colors=64:stats_mode=diff[p];[s1][p]paletteuse=dither=none:diff_mode=rectangle`, "-loop", "0", gif], { stdio: "inherit" });
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-r", "30", "-movflags", "+faststart", mp4], { stdio: "inherit" });
  for (const f of [gif, mp4]) console.log(`${f}: ${(statSync(f).size / 1024 / 1024).toFixed(2)} MB`);
  return { gif, mp4 };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const mode = process.env.DECISIONS_MODE ?? "capture";
  if (!["capture", "race", "render"].includes(mode)) throw new Error("DECISIONS_MODE must be capture, race or render");
  const parent = resolve(process.env.DECISIONS_OUT ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "navvi-decisions-"));
  console.log(`run directory: ${dir}`);
  execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
  const commit = sh("git", ["rev-parse", "HEAD"]);
  const workingTree = sh("git", ["status", "--porcelain"]);

  let captureDir = join(dir, "capture");
  let runs: RaceRun[];
  let raceMeta: { measuredAt: string; commit: string; workingTree: string };
  if (mode === "render") {
    const source = process.env.DECISIONS_SOURCE;
    if (!source) throw new Error("DECISIONS_SOURCE is required in render mode");
    captureDir = join(resolve(source), "capture");
    const saved = JSON.parse(readFileSync(join(resolve(source), "race.json"), "utf8")) as { runs: RaceRun[]; measuredAt: string; commit: string; workingTree: string };
    runs = saved.runs;
    raceMeta = saved;
    // The re-render directory carries the race and capture it was drawn from.
    copyFileSync(join(resolve(source), "race.json"), join(dir, "race.json"));
    cpSync(captureDir, join(dir, "capture"), { recursive: true });
  } else {
    const env = laneEnv();
    if (mode === "capture") await capture(captureDir, env);
    else {
      const src = process.env.DECISIONS_CAPTURE;
      if (!src) throw new Error("DECISIONS_CAPTURE is required in race mode");
      // Keep the run directory self-contained: the capture it raced travels with it.
      cpSync(join(resolve(src), "capture"), captureDir, { recursive: true });
    }
    const batches = loadBatches(captureDir);
    runs = await race(batches, env, Number(process.env.DECISIONS_RUNS ?? 3));
    raceMeta = { measuredAt: new Date().toISOString(), commit, workingTree };
    writeFileSync(join(dir, "race.json"), JSON.stringify({ ...raceMeta, captureDir, runs }, null, 2) + "\n");
  }
  const failed = runs.flatMap((r) => [r.lanes.haiku, r.lanes.jev].filter((l) => l.error).map((l) => `run ${r.run} ${l.lane}: ${l.error}`));
  if (failed.length) throw new Error(`race failed, nothing rendered: ${failed.join("; ")}`);

  const batches = loadBatches(captureDir);
  const cap = JSON.parse(readFileSync(join(captureDir, "capture.json"), "utf8")) as Record<string, unknown> & { url: string; prompt: string; capturedAt: string; commit: string };
  const allCaptured = readFileSync(join(captureDir, "questions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as CapturedBatch);
  const sorted = [...runs].sort((a, b) => a.ratio - b.ratio);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const scored = score(batches, median);
  const total = Math.max(median.lanes.haiku.totalMs, median.lanes.jev.totalMs) / 1000;
  const speed = total <= MAX_ACTIVE_S ? 1 : Math.ceil(total / MAX_ACTIVE_S);
  const date = raceMeta.measuredAt.slice(0, 10);
  process.env.DECISIONS_PROMPT_SHOWN = cap.prompt;
  const haikuModel = median.lanes.haiku.modelId.replace(/^anthropic\//, "");
  const media = await render(dir, { batches, run: median, scored, date, commit: raceMeta.commit, site: cap.url, speed, runs: runs.length, haikuModel });

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const provenance = {
    claim: "Jev vs Haiku on the decision step only: the same captured choice/boolean questions, same batches, sequential per lane, wall clock per batch.",
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
      haiku: { chooser: "ModelChooser subclass (HaikuLaneChooser): drops the explanation Haiku puts in `text` on choice/boolean answers, which the stock validator rejects; indices untouched", modelId: median.lanes.haiku.modelId, transport: median.lanes.haiku.transport },
      jev: { chooser: "JevChooser", modelId: median.lanes.jev.modelId, transport: median.lanes.jev.transport },
    },
    method: {
      warmUp: "one untimed one-question boolean call per lane immediately before its timed pass (connection setup); warm-up latency recorded below",
      order: "lanes run one after the other, never concurrently; order alternates per run (run 1 Haiku first, run 2 Jev first, ...)",
      timing: "performance.now() around chooser.ask(batch) for each captured batch; lane total is wall clock over all batches; BaseChooser retries (if any) are inside the timing, apiBatches counts backend calls",
      medianRun: "the run with the median Haiku/Jev ratio is the one rendered",
      reference: "the answer the reference decider gave during the capture run, whose navigation and extraction succeeded; matching it is agreement with that run, not ground truth",
      display: speed > 1 ? `time-compressed uniformly by ${speed}× for both lanes, stated on screen` : "real time",
    },
    runs: runs.map((r) => ({
      run: r.run, order: r.order, ratio: Number(r.ratio.toFixed(2)),
      lanes: Object.fromEntries((["haiku", "jev"] as const).map((k) => [k, {
        totalMs: Math.round(r.lanes[k].totalMs), warmupMs: Math.round(r.lanes[k].warmupMs), ...(r.lanes[k].warmupError ? { warmupError: r.lanes[k].warmupError } : {}), apiBatches: r.lanes[k].apiBatches, ...(r.lanes[k].strippedExplanationTexts !== undefined ? { strippedExplanationTexts: r.lanes[k].strippedExplanationTexts } : {}),
        batches: r.lanes[k].batches.map((b) => ({ batch: b.batch, ms: Math.round(b.ms), answers: b.answers })),
      }])),
      agreement: (() => { const s = score(batches, r); return { questions: s.length, haikuMatchesReference: s.filter((x) => x.haikuMatch).length, jevMatchesReference: s.filter((x) => x.jevMatch).length, lanesAgree: s.filter((x) => x.agree).length }; })(),
    })),
    medianRun: median.run,
    rendered: { perQuestion: scored, speed, gif: "docs/decisions-race.gif", mp4: "docs/decisions-race.mp4" },
  };
  writeFileSync(join(dir, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  if (process.env.DECISIONS_PUBLISH === "1") {
    copyFileSync(media.gif, "docs/decisions-race.gif");
    copyFileSync(media.mp4, "docs/decisions-race.mp4");
    copyFileSync(join(dir, "provenance.json"), "docs/decisions-race-provenance.json");
    console.log("published docs/decisions-race.{gif,mp4} and docs/decisions-race-provenance.json");
  }
  for (const r of runs) console.log(`run ${r.run}: Haiku ${(r.lanes.haiku.totalMs / 1000).toFixed(2)} s · Jev ${(r.lanes.jev.totalMs / 1000).toFixed(2)} s · ${r.ratio.toFixed(2)}×`);
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
