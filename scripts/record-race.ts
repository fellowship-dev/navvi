import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Actor } from "apify";
import { LogLevel, MemoryStorage, log as crawleeLog } from "crawlee";
import { chromium, type Browser, type Page } from "playwright";
import { createChooser, type Answer, type Chooser, type ChooserUsage, type Question } from "../src/chooser/index.js";
import { run, type RunSummary } from "../src/main.js";
import type { CrawlDeps } from "../src/replay/crawler.js";
import { startFixtureServer } from "../tests/server.js";
import { FFMPEG } from "./recorder.js";

/** Actual crawler pages, live prompt parsing, independent lane caches and measured replay.
 * DEMO_URL/DEMO_PROMPT select a public flow; otherwise use the controlled fixture.
 * DEMO_OUT is a parent directory: each invocation creates a fresh run directory.
 * See docs/recording.md. No existing recording or frame directory is overwritten.
 */

const WIDTH = 1280;
const HEIGHT = 800;
const PAGE_W = 600;
const PAGE_H = 350;
const SHOT_SCALE = 0.5; // Preserve desktop layout: 1200×700 captured, rendered at 600×350.
const SHOT_W = Math.round(PAGE_W / SHOT_SCALE);
const SHOT_H = Math.round(PAGE_H / SHOT_SCALE);
const TICK_MS = 250;
const LOG_LINES = 3;

// Acceptance oracle only: never passed to Navvi or its chooser.
const EXPECT_SOURCE = process.env.DEMO_EXPECT_SOURCE;
const PROMPT = process.env.DEMO_PROMPT ?? "search for python jobs, then list every result with title, company and link";

interface Lane {
  key: "jev" | "claude";
  label: string;
  color: string;
  chooser: Chooser;
  page: Page | null;
  shot: string;
  blank: boolean;
  log: string[];
  status: string;
  rows: Array<Record<string, unknown>>;
  startedAt: number;
  finishedAt: number | null;
  phase: "compile" | "replay";
  compileMs: number;
  compileQuestions: number;
  replayMs: number;
  replayQuestions: number;
  reports: Array<{ phase: "compile" | "replay"; wallMs: number; questions: number; usage: ChooserUsage; summary?: RunSummary; error?: string; rows: Array<Record<string, unknown>> }>;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Wraps a chooser so every batch it answers becomes a line in the lane's log, in the words of the decision. */
function narrate(lane: Lane, inner: Chooser, diagnostics: string): Chooser {
  let batchId = 0;
  const record = (event: Record<string, unknown>) => appendFileSync(diagnostics, JSON.stringify({ at: new Date().toISOString(), elapsedMs: performance.now() - lane.startedAt, ...event }) + "\n");
  return {
    name: inner.name,
    usage: () => inner.usage(),
    async ask(batch: Question[]): Promise<Answer[]> {
      const t = performance.now();
      const id = ++batchId;
      record({ event: "questions", batchId: id, questions: batch });
      let answers: Answer[];
      try {
        answers = await inner.ask(batch);
        record({ event: "answers", batchId: id, waitMs: performance.now() - t, answers });
      } catch (error) {
        record({ event: "error", batchId: id, waitMs: performance.now() - t, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      const ms = Math.round(performance.now() - t);
      const byId = new Map(answers.map((a) => [a.id, a]));
      const lines: string[] = [];
      for (const q of batch) {
        const a = byId.get(q.id);
        if (!a) continue;
        const pick = a.index === null ? null : (q.options?.[a.index] ?? null);
        if (/^nav\.\d+\.op$/.test(q.id)) {
          const op = pick?.split(":")[0] ?? "none";
          const head = batch.find((x) => x.id === `${q.id.slice(0, -3)}.${op === "CLICK" ? "click" : op === "TYPE_TEXT" ? "type" : "select"}`);
          const target = head ? byId.get(head.id) : undefined;
          const targetText = target && target.index !== null ? head?.options?.[target.index]?.replace(/ in ".*$/, "") : undefined;
          lines.push(`${op}${targetText ? ` ${targetText}` : ""}`);
        } else if (/^nav\.\d+\.done$/.test(q.id)) {
          lines.push(a.index === 1 ? "goal reached, trace recorded" : "not done yet");
        } else if (q.id.startsWith("text.")) {
          lines.push(`typed ${a.text ?? ""}`);
        } else if (q.id === "group") {
          lines.push(`list: ${pick?.split(" (")[0] ?? "none"}`);
        } else if (q.id.startsWith("field.")) {
          lines.push(`${q.id.slice(6)} = ${pick?.split(" = ")[0] ?? "none"}`);
        } else if (q.id.startsWith("link.")) {
          lines.push(`${q.id === "link.next" ? "next page" : "detail link"}: ${pick ? pick.split(" -> ")[0] : "none"}`);
        }
      }
      const shown = lines.length > 0 ? lines : [`${batch.length} question${batch.length === 1 ? "" : "s"}`];
      lane.log.push(`${secs(performance.now() - lane.startedAt)}  ${shown.join(" · ")}  [${ms} ms]`);
      return answers;
    },
  };
}

function panel(lane: Lane, now: number): string {
  const elapsed = lane.startedAt ? (lane.finishedAt ?? now) - lane.startedAt : 0;
  const log = lane.log.slice(-LOG_LINES).map((l) => `<div class="l">${esc(l)}</div>`).join("");
  const rows =
    lane.rows.length > 0
      ? `<table>${lane.rows
          .slice(0, 4)
          .map((r) => `<tr>${Object.keys(r).slice(0, 4).map((f) => `<td>${esc(String(r[f] ?? "null")).slice(0, f === "link" ? 48 : 38)}</td>`).join("")}</tr>`)
          .join("")}</table><div class="more">${lane.rows.length} records</div>`
      : "";
  const shot = lane.blank || !lane.shot ? "" : `<img src="${lane.shot}">`;
  return `<div class="lane">
    <div class="clock" style="color:${lane.finishedAt ? "#7ee787" : "#e6edf3"}">${secs(elapsed)}</div>
    <div class="status">${esc(lane.status)}</div>
    <div class="browser"><div class="chrome"><span class="dots"><span></span><span></span><span></span></span><span class="badge" style="background:${lane.color}">${esc(lane.label)}</span></div><div class="view">${shot}</div></div>
    <div class="side">
      <div class="log">${log}</div>
      ${rows}
    </div>
  </div>`;
}

let startUrlShown = "";

function frame(lanes: Lane[], now: number, phase: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box } body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: #0b0e14; color: #c9d1d9; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; overflow: hidden }
  .head { height: 80px; padding: 8px 14px; font: 18px/1.4 Menlo, Consolas, monospace; border-bottom: 1px solid #21262d; display: flex; justify-content: space-between; align-items: center; gap: 16px; white-space: normal }
  .head .p { color: #7ee787; font-weight: 700 } .head .c { color: #e6edf3 } .head .phase { color: #8b949e; font-size: 18px; flex: none }
  .head > div:first-child { overflow: hidden; text-overflow: ellipsis }
  .lanes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 10px }
  .lane { display: flex; flex-direction: column; gap: 12px }
  .browser { background: #fff; border-radius: 8px; overflow: hidden; border: 1px solid #30363d; width: ${PAGE_W}px; height: ${PAGE_H + 26}px }
  .chrome { display: flex; align-items: center; gap: 8px; padding: 5px 8px; background: #2d333b; height: 26px }
  .dots span { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; background: #57606a }
  .badge { margin-left: auto; padding: 2px 8px; border-radius: 10px; font-weight: 700; font-size: 18px; color: #fff }
  .view { width: ${PAGE_W}px; height: ${PAGE_H}px; background: #fff } .view img { display: block; width: ${PAGE_W}px; height: ${PAGE_H}px }
  .side { display: flex; flex-direction: column; gap: 4px; padding: 2px 4px; min-width: 0 }
  .clock { font: 700 42px/1 Menlo, Consolas, monospace; letter-spacing: -1px }
  .status { font-size: 20px; color: #8b949e; min-height: 16px }
  .log { font: 16px/1.4 Menlo, Consolas, monospace; color: #adbac7; flex: 1 } .l { white-space: pre-wrap; word-break: break-word; margin-bottom: 2px }
  table { border-collapse: collapse; table-layout: fixed; width: 100%; font: 18px/1.3 Menlo, Consolas, monospace; color: #e6edf3 } td { padding: 1px 6px 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-top: 1px solid #21262d }
  .more { font-size: 18px; color: #7ee787; font-weight: 700; margin-top: 2px }
</style></head><body>
  <div class="head"><div><span class="p">$</span> <span class="c">npx navvi ${esc(JSON.stringify(PROMPT))} ${esc(startUrlShown)}</span></div><div class="phase">${esc(phase)}</div></div>
  <div class="lanes">${lanes.map((l) => panel(l, now)).join("")}</div>
</body></html>`;
}

async function main(): Promise<void> {
  const outParent = resolve(process.env.DEMO_OUT ?? tmpdir());
  mkdirSync(outParent, { recursive: true });
  const output = mkdtempSync(join(outParent, "navvi-race-"));
  const framesDir = join(output, "frames");
  mkdirSync(framesDir);
  console.log(`Recording evidence: ${output}`);
  // Fail before paid requests if the encoder is unavailable.
  execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
  const server = process.env.DEMO_URL ? null : await startFixtureServer();
  const startUrl = process.env.DEMO_URL ?? `${server!.baseUrl}/fixtures/search-form.html`;
  startUrlShown = startUrl;
  const env: NodeJS.ProcessEnv = { ...process.env, NAVVI_BROWSER: "chromium", NAVVI_CLAUDE_MODEL: "haiku" };
  delete env.DEMO_EXPECT_SOURCE;
  const freshChooser = (key: "jev" | "claude") => createChooser({ chooser: key, env, cli: { timeoutMs: 180_000, model: "haiku" } });
  const selected = process.env.DEMO_CHOOSERS ?? "jev,claude";
  if (selected !== "jev" && selected !== "jev,claude") throw new Error("DEMO_CHOOSERS must be jev or jev,claude");
  const keys: Array<"jev" | "claude"> = selected === "jev" ? ["jev"] : ["jev", "claude"];
  const lanes: Lane[] = keys.map((key) => ({
    key, label: key === "jev" ? "Navvi + Jev" : "Navvi + Haiku",
    color: key === "jev" ? "#1f6feb" : "#a371f7", chooser: freshChooser(key),
    page: null, shot: "", blank: true, log: [], status: "waiting", rows: [], startedAt: 0,
    finishedAt: null, phase: "compile", compileMs: 0, compileQuestions: 0,
    replayMs: 0, replayQuestions: 0, reports: [],
  }));
  const composer: Browser = await chromium.launch({ headless: true });
  const composePage = await (await composer.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })).newPage();
  const receipt = () => writeFileSync(join(output, "receipt.json"), JSON.stringify({
    recordedAt: new Date().toISOString(), startUrl, prompt: PROMPT,
    acceptance: { expectedSource: EXPECT_SOURCE ?? null },
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTree: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
    capture: "actual crawler page; includes prompt parsing and recording overhead",
    viewport: { width: SHOT_W, height: SHOT_H },
    correctness: "requires human comparison of saved rows with visible results",
    lanes: lanes.map(({ key, label, reports }) => ({ key, label, reports })),
  }, null, 2) + "\n");

  const durations: number[] = [];
  let frameIndex = 0;
  let lastFrameAt = performance.now();
  let phase = "";
  async function tick(): Promise<void> {
    const now = performance.now();
    for (const lane of lanes) {
      if (lane.page && !lane.blank) {
        try {
          const png = await lane.page.screenshot({ type: "png", clip: { x: 0, y: 0, width: SHOT_W, height: SHOT_H }, timeout: 400, animations: "disabled" });
          lane.shot = `data:image/png;base64,${png.toString("base64")}`;
        } catch {
          // mid-navigation or closed: keep the last shot
        }
      }
    }
    await composePage.setContent(frame(lanes, now, phase));
    await composePage.screenshot({ path: join(framesDir, `${String(frameIndex).padStart(4, "0")}.png`), type: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    durations.push((now - lastFrameAt) / 1000);
    lastFrameAt = now;
    frameIndex += 1;
  }
  let ticking = true;
  const ticker = (async () => {
    while (ticking) {
      const t = performance.now();
      await tick();
      const left = TICK_MS - (performance.now() - t);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    }
  })();

  const seen = new Map<Lane, number>();
  async function runLane(lane: Lane, actor: Actor, store: string, replay: boolean): Promise<void> {
    lane.chooser = freshChooser(lane.key);
    lane.phase = replay ? "replay" : "compile";
    lane.startedAt = performance.now();
    lane.finishedAt = null;
    lane.page = null;
    lane.blank = true;
    lane.shot = "";
    lane.rows = [];
    lane.status = replay ? "replaying saved scraper" : "parsing prompt, then compiling";
    const diagnostics = join(output, `${lane.key}-${lane.phase}-questions.jsonl`);
    writeFileSync(diagnostics, "", { flag: "wx" });
    const chooser = narrate(lane, lane.chooser, diagnostics);
    const deps: CrawlDeps = {
      actor, chooser, env, storageDir: store, attended: false, maxConcurrency: 1,
      onPage: async (page) => {
        await page.setViewportSize({ width: SHOT_W, height: SHOT_H });
        lane.page = page;
        lane.blank = false;
      },
    };
    let summary: RunSummary | undefined;
    let failure: string | undefined;
    try {
      summary = await run({ startUrls: [startUrl], prompt: PROMPT, browser: "chromium",
        ...(server ? { allowPrivateHosts: ["127.0.0.1"] } : {}), maxPages: 1, maxItems: 10 }, deps);
      const all = (await (await actor.openDataset()).getData()).items as Array<Record<string, unknown>>;
      lane.rows = all.slice(seen.get(lane) ?? 0);
      seen.set(lane, all.length);
      if (EXPECT_SOURCE) {
        const wrongSources = lane.rows.flatMap((row, index) => row._source === EXPECT_SOURCE ? [] : [`row ${index + 1}: ${JSON.stringify(row._source) ?? "missing"}`]);
        if (wrongSources.length) throw new Error(`Expected _source ${EXPECT_SOURCE}; mismatches: ${wrongSources.join("; ")}`);
      }
      const requiredFields = summary.input?.fields?.map((field) => field.name) ?? [];
      const emptyFields = lane.rows.flatMap((row, index) => requiredFields
        .filter((field) => row[field] == null || (typeof row[field] === "string" && row[field].trim() === "") || (Array.isArray(row[field]) && row[field].length === 0))
        .map((field) => `row ${index + 1}: ${field}`));
      if (emptyFields.length) throw new Error(`Empty requested values: ${emptyFields.join("; ")}`);
      if (!requiredFields.length) throw new Error("Parsed prompt has no requested fields to validate");
      if (summary.status !== "succeeded" || summary.items === 0 || lane.rows.length !== summary.items || summary.fieldsNotFound.length) {
        throw new Error(`${summary.status}: ${summary.message ?? ""}; ${summary.items} items, missing fields: ${summary.fieldsNotFound.join(", ")}`);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    lane.finishedAt = performance.now();
    const ms = lane.finishedAt - lane.startedAt;
    const usage = chooser.usage();
    const questions = usage.questions;
    lane.reports.push({ phase: lane.phase, wallMs: ms, questions, usage, summary, error: failure, rows: lane.rows });
    writeFileSync(join(output, `${lane.key}-${lane.phase}-rows.json`), JSON.stringify(lane.rows, null, 2) + "\n");
    receipt();
    lane.status = failure ? `FAILED: ${failure}` : `${lane.rows.length} records · ${questions} questions${replay && questions === 0 ? " · zero model calls" : ""}`;
    lane.log.push(`${secs(ms)}  ${failure ? "failed" : "done"}`);
    if (replay) {
      lane.replayMs = ms;
      lane.replayQuestions = questions;
    } else {
      lane.compileMs = ms;
      lane.compileQuestions = questions;
    }
    if (failure) throw new Error(`${lane.label} ${lane.phase}: ${failure}`);
  }

  const hold = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const stores = lanes.map((lane) => { const path = join(output, `${lane.key}-profiles`); mkdirSync(path); return path; });
    const actors = lanes.map((lane) => new Actor({ storageClient: new MemoryStorage({ localDataDirectory: join(output, `${lane.key}-storage`), persistStorage: true }) }));
    for (const replay of [false, true]) {
      phase = replay ? "run 2 · saved scraper, fresh browser" : "run 1 · prompt → scraper";
      for (const lane of lanes) {
        lane.blank = true;
        lane.log = [];
        lane.startedAt = 0;
        lane.finishedAt = null;
        lane.status = "waiting";
      }
      await hold(1500);
      // Let both runs finish and save their evidence even if one lane fails.
      const results = await Promise.allSettled(lanes.map((lane, i) => runLane(lane, actors[i]!, stores[i]!, replay)));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await hold(replay ? 5000 : 4000);
    }
  } finally {
    ticking = false;
    await ticker;
    await composer.close();
    await server?.close();
    receipt();
  }

  const list = join(framesDir, "frames.txt");
  const lines: string[] = [];
  for (let i = 0; i < frameIndex; i++) {
    lines.push(`file '${String(i).padStart(4, "0")}.png'`);
    lines.push(`duration ${Math.max(0.05, durations[i + 1] ?? 0.25).toFixed(3)}`);
  }
  lines.push(`file '${String(frameIndex - 1).padStart(4, "0")}.png'`);
  writeFileSync(list, lines.join("\n") + "\n");
  const gif = join(output, "race.gif");
  const mp4 = join(output, "race.mp4");
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=4,scale=${WIDTH}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", gif], { stdio: "inherit" });
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { stdio: "inherit" });
  for (const file of [gif, mp4]) console.log(`${file}: ${(statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
  for (const lane of lanes) {
    const u = lane.chooser.usage();
    console.log(`${lane.key}: compile ${Math.round(lane.compileMs)} ms, ${lane.compileQuestions} questions; replay ${Math.round(lane.replayMs)} ms, ${lane.replayQuestions} questions; replay chooser wait ${Math.round(u.waitMs)} ms, ${u.inputTokens} tokens, $${u.costUsd.toFixed(4)}`);
  }
  console.log(`frames: ${frameIndex}, ${durations.reduce((a, b) => a + b, 0).toFixed(1)} s`);
  console.log(`Frames, rows and receipt preserved: ${output}`);
}

crawleeLog.setLevel(LogLevel.WARNING);
try {
  await main();
} catch (error) {
  console.error(`record-race: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
process.exit();
