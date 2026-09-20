import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Actor } from "apify";
import { LogLevel, MemoryStorage, log as crawleeLog } from "crawlee";
import { chromium, type Browser, type Page } from "playwright";
import { createChooser, type Answer, type Chooser, type ChooserUsage, type Question } from "../src/chooser/index.js";
import { run } from "../src/main.js";
import { defaultNavigator } from "../src/replay/navigator.js";
import type { CrawlDeps } from "../src/replay/crawler.js";
import { startFixtureServer } from "../tests/server.js";
import { FFMPEG } from "./recorder.js";

/**
 * The side-by-side demo: the same prompt, a search form to its results, once
 * under Jev and once under Claude Haiku (Claude Code), both live, in real
 * time, with the wall clock on screen. Then both pages go blank and the
 * compiled scraper replays with zero questions. The site is the fixture
 * server (deterministic; the live sites are in docs/measurements.md), the
 * choosers are live.
 *
 *   TYPESAFE_API_KEY=... npx tsx scripts/record-race.ts
 *
 * Writes docs/race.gif and docs/race.mp4 and prints the numbers the frames show.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const WIDTH = 1280;
const HEIGHT = 560;
const PAGE_W = 300;
const PAGE_H = 400;
const SHOT_SCALE = 0.75;
const SHOT_W = Math.round(PAGE_W / SHOT_SCALE);
const SHOT_H = Math.round(PAGE_H / SHOT_SCALE);
const TICK_MS = 250;
const LOG_LINES = 11;

const PROMPT = "search for python jobs, then list every result with title, company and link";
const GOAL = "search for python jobs";
const FIELDS = ["title", "company", "link"];

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
  usage: ChooserUsage | null;
  phase: "compile" | "replay";
  compileMs: number;
  compileQuestions: number;
  replayMs: number;
  replayQuestions: number;
  /** What the text helper typed into the search box, for the replay's peek page. */
  typed: string;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Wraps a chooser so every batch it answers becomes a line in the lane's log, in the words of the decision. */
function narrate(lane: Lane, inner: Chooser): Chooser {
  return {
    name: inner.name,
    usage: () => inner.usage(),
    async ask(batch: Question[]): Promise<Answer[]> {
      const t = performance.now();
      const answers = await inner.ask(batch);
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
          lane.typed = a.text?.replace(/^\{"text":"(.*)"\}$/, "$1") ?? "";
          lines.push(`typed ${JSON.stringify(lane.typed)}`);
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
  const elapsed = (lane.finishedAt ?? now) - lane.startedAt;
  const log = lane.log.slice(-LOG_LINES).map((l) => `<div class="l">${esc(l)}</div>`).join("");
  const rows =
    lane.rows.length > 0
      ? `<table>${lane.rows
          .slice(0, 4)
          .map((r) => `<tr>${FIELDS.map((f) => `<td>${esc(String(r[f] ?? "null")).slice(0, f === "link" ? 30 : 22)}</td>`).join("")}</tr>`)
          .join("")}</table><div class="more">${lane.rows.length} records</div>`
      : "";
  const shot = lane.blank || !lane.shot ? "" : `<img src="${lane.shot}">`;
  return `<div class="lane">
    <div class="browser"><div class="chrome"><span class="dots"><span></span><span></span><span></span></span><span class="badge" style="background:${lane.color}">${esc(lane.label)}</span></div><div class="view">${shot}</div></div>
    <div class="side">
      <div class="clock" style="color:${lane.finishedAt ? "#7ee787" : "#e6edf3"}">${secs(elapsed)}</div>
      <div class="status">${esc(lane.status)}</div>
      <div class="log">${log}</div>
      ${rows}
    </div>
  </div>`;
}

let startUrlShown = "";

function frame(lanes: Lane[], now: number, phase: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box } body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: #0b0e14; color: #c9d1d9; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; overflow: hidden }
  .head { height: 52px; padding: 8px 14px; font: 13px/1.4 Menlo, Consolas, monospace; border-bottom: 1px solid #21262d; display: flex; justify-content: space-between; align-items: center; gap: 16px; white-space: nowrap }
  .head .p { color: #7ee787; font-weight: 700 } .head .c { color: #e6edf3 } .head .phase { color: #8b949e; font-size: 12px; flex: none }
  .head > div:first-child { overflow: hidden; text-overflow: ellipsis }
  .lanes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 10px }
  .lane { display: grid; grid-template-columns: ${PAGE_W}px 1fr; gap: 8px }
  .browser { background: #fff; border-radius: 8px; overflow: hidden; border: 1px solid #30363d; width: ${PAGE_W}px; height: ${PAGE_H + 26}px }
  .chrome { display: flex; align-items: center; gap: 8px; padding: 5px 8px; background: #2d333b; height: 26px }
  .dots span { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; background: #57606a }
  .badge { margin-left: auto; padding: 2px 8px; border-radius: 10px; font-weight: 700; font-size: 10px; color: #fff }
  .view { width: ${PAGE_W}px; height: ${PAGE_H}px; background: #fff } .view img { display: block; width: ${PAGE_W}px; height: ${PAGE_H}px }
  .side { display: flex; flex-direction: column; gap: 4px; padding: 2px 4px; min-width: 0 }
  .clock { font: 700 34px/1 Menlo, Consolas, monospace; letter-spacing: -1px }
  .status { font-size: 12px; color: #8b949e; min-height: 16px }
  .log { font: 11px/1.4 Menlo, Consolas, monospace; color: #adbac7; flex: 1 } .l { white-space: pre-wrap; word-break: break-word; margin-bottom: 2px }
  table { border-collapse: collapse; table-layout: fixed; width: 100%; font: 10px/1.3 Menlo, Consolas, monospace; color: #e6edf3 } td { padding: 1px 6px 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-top: 1px solid #21262d }
  .more { font-size: 10px; color: #7ee787; font-weight: 700; margin-top: 2px }
</style></head><body>
  <div class="head"><div><span class="p">$</span> <span class="c">npx navvi ${esc(JSON.stringify(PROMPT))} ${esc(startUrlShown)}</span></div><div class="phase">${esc(phase)}</div></div>
  <div class="lanes">${lanes.map((l) => panel(l, now)).join("")}</div>
</body></html>`;
}

async function main(): Promise<void> {
  const framesDir = join(DOCS, "race-frames");
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const server = await startFixtureServer();
  const startUrl = `${server.baseUrl}/fixtures/search-form.html`;
  startUrlShown = startUrl;
  const env = { ...process.env, NAVVI_BROWSER: "chromium" };
  const lanes: Lane[] = [
    { key: "jev", label: "Jev (TypeSafe)", color: "#1f6feb", chooser: createChooser({ chooser: "jev", env }), page: null, shot: "", blank: true, log: [], status: "", rows: [], startedAt: 0, finishedAt: null, usage: null, phase: "compile", compileMs: 0, compileQuestions: 0, replayMs: 0, replayQuestions: 0, typed: "" },
    { key: "claude", label: "Claude Haiku (Claude Code)", color: "#a371f7", chooser: createChooser({ chooser: "claude", env, cli: { timeoutMs: 180_000 } }), page: null, shot: "", blank: true, log: [], status: "", rows: [], startedAt: 0, finishedAt: null, usage: null, phase: "compile", compileMs: 0, compileQuestions: 0, replayMs: 0, replayQuestions: 0, typed: "" },
  ];
  const tmp = mkdtempSync(join(tmpdir(), "navvi-race-"));
  const composer: Browser = await chromium.launch({ headless: true });
  const composePage = await (await composer.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })).newPage();

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
    lane.startedAt = performance.now();
    lane.finishedAt = null;
    lane.blank = true;
    lane.shot = "";
    lane.rows = [];
    lane.status = replay ? "replaying the compiled scraper" : "compiling: the chooser answers";
    const chooser = narrate(lane, lane.chooser);
    const deps: CrawlDeps = {
      actor,
      chooser,
      env,
      storageDir: store,
      attended: false,
      maxConcurrency: 1,
      navigator: async (page, goal, ctx) => {
        lane.page = page;
        lane.blank = false;
        return defaultNavigator(page, goal, ctx);
      },
    };
    const before = chooser.usage().questions;
    const summary = await run({ startUrls: [startUrl], goal: GOAL, mode: "list", fields: FIELDS.map((name) => ({ name })), description: "job search result", browser: "chromium", allowPrivateHosts: ["127.0.0.1"], maxPages: 1 }, deps);
    const questions = chooser.usage().questions - before;
    lane.finishedAt = performance.now();
    const ms = lane.finishedAt - lane.startedAt;
    const all = (await (await actor.openDataset()).getData()).items as Array<Record<string, unknown>>;
    lane.rows = all.slice(seen.get(lane) ?? 0);
    seen.set(lane, all.length);
    lane.status = replay ? `${summary.status}: ${summary.items} records, ${questions} questions, no model call` : `${summary.status}: ${summary.items} records, ${questions} questions, chooser wait ${secs(summary.chooser?.waitMs ?? 0)}`;
    lane.log.push(`${secs(ms)}  done: ${summary.items} records, ${questions} questions`);
    if (replay) {
      lane.replayMs = ms;
      lane.replayQuestions = questions;
    } else {
      lane.compileMs = ms;
      lane.compileQuestions = questions;
    }
    // the replay page never goes through the navigator: show the results page it reached
    if (replay && lane.page) lane.blank = false;
  }

  const hold = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    phase = "run 1 · compile";
    await hold(1500);
    const stores = lanes.map(() => mkdtempSync(join(tmp, "st-")));
    const actors = lanes.map(() => new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(tmp, "storage-")), persistStorage: false }) }));
    await Promise.all(lanes.map((lane, i) => runLane(lane, actors[i]!, stores[i]!, false)));
    await hold(4000);
    phase = "run 2 · replay, zero questions";
    for (const lane of lanes) {
      lane.blank = true;
      lane.log = [];
      lane.status = "";
    }
    await hold(1500);
    // replay: the same actor holds the compiled scraper; the navigator is not called, so the page is shown through a peek page
    await Promise.all(
      lanes.map(async (lane, i) => {
        // the trace replays on the crawler's own page; show the reached page from the fixture server alongside
        const peek = await composePage.context().newPage();
        await peek.setViewportSize({ width: SHOT_W, height: SHOT_H });
        lane.page = peek;
        const p = runLane(lane, actors[i]!, stores[i]!, true);
        await hold(600);
        lane.blank = false;
        await peek.goto(`${server.baseUrl}/fixtures/results.html?q=${encodeURIComponent(lane.typed || "python")}`, { waitUntil: "load" });
        await p;
        await peek.close().catch(() => undefined);
      }),
    );
    await hold(5000);
  } finally {
    ticking = false;
    await ticker;
    await composer.close();
    await server.close();
  }

  const list = join(framesDir, "frames.txt");
  const lines: string[] = [];
  for (let i = 0; i < frameIndex; i++) {
    lines.push(`file '${String(i).padStart(4, "0")}.png'`);
    lines.push(`duration ${Math.max(0.05, durations[i + 1] ?? 0.25).toFixed(3)}`);
  }
  lines.push(`file '${String(frameIndex - 1).padStart(4, "0")}.png'`);
  writeFileSync(list, lines.join("\n") + "\n");
  const gif = join(DOCS, "race.gif");
  const mp4 = join(DOCS, "race.mp4");
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=4,scale=${WIDTH}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", gif], { stdio: "inherit" });
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { stdio: "inherit" });
  for (const file of [gif, mp4]) console.log(`${file}: ${(statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
  for (const lane of lanes) {
    const u = lane.chooser.usage();
    console.log(`${lane.key}: compile ${Math.round(lane.compileMs)} ms, ${lane.compileQuestions} questions; replay ${Math.round(lane.replayMs)} ms, ${lane.replayQuestions} questions; chooser wait ${Math.round(u.waitMs)} ms, ${u.inputTokens} tokens, $${u.costUsd.toFixed(4)}`);
  }
  console.log(`frames: ${frameIndex}, ${durations.reduce((a, b) => a + b, 0).toFixed(1)} s`);
  rmSync(framesDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
}

crawleeLog.setLevel(LogLevel.WARNING);
try {
  await main();
} catch (error) {
  console.error(`record-race: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
process.exit();
