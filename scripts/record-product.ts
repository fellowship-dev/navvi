import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { LogLevel, log as crawleeLog } from "crawlee";
import { chromium, type CDPSession, type Page } from "playwright";
import type { RunSummary } from "../src/main.js";
import type { CrawlDeps } from "../src/replay/crawler.js";
import { startFixtureServer, type FixtureServer } from "../tests/server.js";
import { FFMPEG } from "./recorder.js";

/**
 * The product GIF: three beats of the built CLI, one clip.
 *
 * 1. compile   — `navvi "<prompt>" <book url>` on books.toscrape.com, empty storage, live Jev.
 * 2. re-run    — the same command on another book of the same template: cache hit, zero decisions.
 * 3. self-heal — the controlled pharmacy fixture: compile on v1, the same URLs switch to v2
 *                markup, the next run heals with live Jev, the run after that replays at zero.
 *
 * Every run is `main()` from `dist/bin/cli.js` (run `npm run build` first), called
 * in-process with the real argv and a captured stderr/stdout, so the terminal pane
 * shows the CLI's own words at the moment it wrote them. The only injection is
 * `io.run`: it wraps the built `run()` to add `CrawlDeps.onPage` (the crawler's own
 * page, screenshotted while the run is live) and to keep the RunSummary (for the
 * healed field names, which the CLI summary does not print). Crawler log lines
 * (`deps.log`) are kept in provenance; the per-launch browser diagnostic line is
 * not shown on screen because it prints a local filesystem path.
 *
 * Capture first, render second: each run's stderr chunks and page screenshots
 * carry real timestamps. The renderer maps display time to real time with one
 * uniform factor per run, prints that factor on the frame ("sped up 4×"), and
 * every clock and number on screen is the real one.
 *
 * Env: PRODUCT_OUT (parent dir, default system temp), PRODUCT_SOURCE (re-render an
 * existing capture dir), PRODUCT_PUBLISH=1 (copy gif/mp4/provenance into docs/).
 * Keys: AI_GATEWAY_API_KEY or TYPESAFE_API_KEY (Jev); a signed-in Claude Code writes
 * the text question (prompt parsing).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 6;
const STEP = 1 / FPS;
const SHOT_W = 1000;
const SHOT_H = 900;
const PANE_W = 560;
const PANE_H = Math.round((PANE_W / SHOT_W) * SHOT_H);
const POLL_MS = 300;

const PROMPT_BOOKS = "Extract the book title, price and availability";
const BOOK_1 = "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html";
const BOOK_2 = "https://books.toscrape.com/catalogue/sharp-objects_997/index.html";
const PROMPT_PHARMACY = "Extract the product name, laboratory, price and stock";
const PHARMACY = ["amoxicilina-500-mg", "loratadina-10-mg", "omeprazol-20-mg", "paracetamol-500-mg"];

type Beat = 1 | 2 | 3;

interface Stamped { atMs: number; text: string }

interface RunCapture {
  id: string;
  beat: Beat;
  title: string;
  site: string;
  displayCommand: string;
  argv: string[];
  startedAt: string;
  wallMs: number;
  exitCode: number;
  stderr: Stamped[];
  crawlerLog: Stamped[];
  stdout: string;
  shots: Array<{ atMs: number; file: string; url: string }>;
  shotErrors: Stamped[];
  summary: RunSummary | null;
  healedFields: string[];
  rows: Array<Record<string, unknown>>;
}

interface Capture {
  commit: string;
  workingTree: string;
  recordedAt: string;
  runs: RunCapture[];
}

type CliMain = (argv: readonly string[], io: {
  stdin: NodeJS.ReadableStream | null; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv; cwd: string; run?: (raw: unknown, deps?: CrawlDeps) => Promise<RunSummary>;
}) => Promise<number>;
type RunFn = (raw: unknown, deps?: CrawlDeps) => Promise<RunSummary>;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const HIDDEN_LOG = /^browser launch #\d+: /;

// ---------------------------------------------------------------- capture

async function capture(dir: string): Promise<Capture> {
  const distCli = join(ROOT, "dist/bin/cli.js");
  const distMain = join(ROOT, "dist/src/main.js");
  const { main } = (await import(distCli)) as { main: CliMain };
  const { run } = (await import(distMain)) as { run: RunFn };
  if (!process.env.AI_GATEWAY_API_KEY && !process.env.TYPESAFE_API_KEY) throw new Error("set AI_GATEWAY_API_KEY or TYPESAFE_API_KEY so the default chooser is Jev");
  const shotsDir = join(dir, "shots");
  mkdirSync(shotsDir, { recursive: true });
  const runs: RunCapture[] = [];
  let server: FixtureServer | null = null;

  async function one(id: string, beat: Beat, title: string, site: string, displayCommand: string, argv: string[]): Promise<RunCapture> {
    const t0 = performance.now();
    const at = () => performance.now() - t0;
    const stderr: Stamped[] = [];
    const crawlerLog: Stamped[] = [];
    let stdout = "";
    const errStream = new Writable({ write(chunk, _enc, cb) { stderr.push({ atMs: at(), text: String(chunk) }); cb(); } });
    const outStream = new Writable({ write(chunk, _enc, cb) { stdout += String(chunk); cb(); } });
    const current: { page: Page | null } = { page: null };
    let summary: RunSummary | null = null;
    const shots: RunCapture["shots"] = [];
    let polling = true;
    let seq = 0;
    const shotErrors: Stamped[] = [];
    const cdpSessions = new WeakMap<Page, CDPSession>();
    // Polled while the run is live, and once more on each page's load event (a 1 s replay can finish between polls).
    const shoot = async (page: Page): Promise<void> => {
      if (page.isClosed()) return;
      try {
        const file = join(shotsDir, `${id}-${String(seq++).padStart(3, "0")}.png`);
        const url = page.url();
        // CDP capture: Playwright's page.screenshot waits on fonts and stability and times out on a page mid-load.
        let cdp = cdpSessions.get(page);
        if (!cdp) cdpSessions.set(page, (cdp = await page.context().newCDPSession(page)));
        const shot = (await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: SHOT_W, height: SHOT_H, scale: 1 } })) as { data: string };
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        if (url.startsWith("http")) shots.push({ atMs: at(), file: basename(file), url });
      } catch (error) {
        // mid-navigation or closed: keep the previous shot
        shotErrors.push({ atMs: at(), text: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
      }
    };
    const poller = (async () => {
      while (polling) {
        const t = performance.now();
        if (current.page) await shoot(current.page);
        const left = POLL_MS - (performance.now() - t);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
      }
    })();
    const wrapped: RunFn = async (raw, deps) => {
      const s = await run(raw, {
        ...deps!,
        log: (message: string) => crawlerLog.push({ atMs: at(), text: message }),
        onPage: async (p: Page) => {
          await p.setViewportSize({ width: SHOT_W, height: SHOT_H });
          current.page = p;
          p.once("load", () => void shoot(p));
        },
      });
      summary = s;
      return s;
    };
    const startedAt = new Date().toISOString();
    console.log(`[${id}] navvi ${argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
    const exitCode = await main(argv, { stdin: null, stdout: outStream, stderr: errStream, env: process.env, cwd: dir, run: wrapped });
    const wallMs = at();
    polling = false;
    await poller;
    let rows: Array<Record<string, unknown>> = [];
    try { rows = JSON.parse(stdout) as Array<Record<string, unknown>>; } catch { /* not JSON: kept raw in stdout */ }
    const s = summary as RunSummary | null;
    const healedFields = [...new Set((s?.healingEvents ?? []).flatMap((e) => (e as { kind?: string; fields?: string[] }).kind === "field" ? ((e as { fields: string[] }).fields) : []))].sort();
    const result: RunCapture = { id, beat, title, site, displayCommand, argv, startedAt, wallMs, exitCode, stderr, crawlerLog, stdout, shots, shotErrors, summary: s, healedFields, rows };
    console.log(`[${id}] exit ${exitCode} in ${secs(wallMs)}\n${stderr.map((e) => e.text).join("")}`);
    runs.push(result);
    if (exitCode !== 0) writeFileSync(join(dir, "capture-failed.json"), JSON.stringify(runs, null, 2) + "\n");
    if (exitCode !== 0) throw new Error(`${id}: exit ${exitCode}`);
    return result;
  }

  try {
    // Relative to io.cwd (the run directory), so the provenance carries no local path.
    const storeBooks = "storage-books";
    const storePharmacy = "storage-pharmacy";
    const books = (url: string) => [PROMPT_BOOKS, url, "--browser", "chromium", "--storage", storeBooks];
    const r1 = await one("compile", 1, "Compile", "books.toscrape.com (live public site)", `navvi "${PROMPT_BOOKS}" ${BOOK_1}`, books(BOOK_1));
    if (r1.summary?.cacheHit !== false || (r1.summary?.chooser?.questions ?? 0) === 0) throw new Error("compile: expected a cache miss with decisions");
    const r2 = await one("rerun", 2, "Re-run", "books.toscrape.com (live public site)", `navvi "${PROMPT_BOOKS}" ${BOOK_2}`, books(BOOK_2));
    if (r2.summary?.cacheHit !== true || (r2.summary?.chooser?.questions ?? -1) !== 0) throw new Error("rerun: expected a cache hit with zero questions");

    server = await startFixtureServer();
    const urls = PHARMACY.map((slug) => `${server!.baseUrl}/demo/pharmacy/producto/${slug}.html`);
    const pharmacy = [PROMPT_PHARMACY, ...urls, "--allow-private-host", "127.0.0.1", "--browser", "chromium", "--storage", storePharmacy];
    const shown = `navvi "${PROMPT_PHARMACY}" <${urls.length} product pages>`;
    server.switchDemo("v1");
    await one("fixture-compile", 3, "Compile · site v1", "controlled fixture · v1 markup", shown, pharmacy);
    server.switchDemo("v2");
    const heal = await one("fixture-heal", 3, "Heal · site v2", "controlled fixture · v2 markup", shown, pharmacy);
    if (heal.summary?.cacheHit !== true || (heal.summary?.healingEvents.length ?? 0) === 0) throw new Error("heal: expected a cache hit with healing events");
    const replay = await one("fixture-replay", 3, "Replay · site v2", "controlled fixture · v2 markup", shown, pharmacy);
    if ((replay.summary?.chooser?.questions ?? -1) !== 0) throw new Error("fixture replay: expected zero questions");
  } finally {
    await server?.close();
  }
  const cap: Capture = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    workingTree: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim(),
    recordedAt: new Date().toISOString(),
    runs,
  };
  writeFileSync(join(dir, "capture.json"), JSON.stringify(cap, null, 2) + "\n");
  return cap;
}

// ---------------------------------------------------------------- render

/** Display seconds for the live part of each run; the factor is chosen to fit, rounded up to a whole number. */
const ACTIVE_BUDGET_S: Record<string, number> = { compile: 4.0, rerun: 1.4, "fixture-compile": 1.2, "fixture-heal": 1.4, "fixture-replay": 1.1 };
const TYPE_S: Record<string, number> = { compile: 0.8, rerun: 0.5, "fixture-compile": 0.4, "fixture-heal": 0.3, "fixture-replay": 0.3 };
const HOLD_S: Record<string, number> = { compile: 2.4, rerun: 1.8, "fixture-compile": 0.8, "fixture-heal": 2.5, "fixture-replay": 2.0 };
/** Shown before the heal run: the fixture server has switched the same URLs to v2 markup. */
const SITE_CHANGE_S = 1.0;
const END_S = 3.5;

function speedFor(run: RunCapture): number {
  const factor = run.wallMs / 1000 / ACTIVE_BUDGET_S[run.id]!;
  return factor <= 1.1 ? 1 : Math.ceil(factor);
}

function shownStderr(text: string): string[] {
  return text.split("\n").filter((l, i, all) => !(l === "" && i === all.length - 1));
}

function highlight(line: string): string {
  let h = esc(line);
  if (h.startsWith("chooser: jev")) h = h.replace(/^chooser: jev/, '<b class="g">chooser: jev</b>');
  h = h.replace(/cache hit (yes)/, 'cache hit <b class="g">yes</b>');
  h = h.replace(/cache hit (no)/, 'cache hit <b class="y">no</b>');
  h = h.replace(/(decider jev: )(0 decisions)/, '$1<b class="zero">$2</b>');
  h = h.replace(/(decider jev: )(\d+ decisions?)/, '$1<b class="b">$2</b>');
  h = h.replace(/(healing events )([1-9]\d*)/, '$1<b class="y">$2</b>');
  h = h.replace(/(status succeeded)/, '<b class="g">$1</b>');
  return h;
}

function jsonLines(rows: Array<Record<string, unknown>>, max: number): string[] {
  const shown = rows.slice(0, max).map((r) => {
    const { _source, ...rest } = r;
    void _source;
    return rest;
  });
  const lines = JSON.stringify(shown, null, 1).split("\n").map((l) => l.replace(/^ +/, (s) => "  ".repeat(s.length)));
  if (rows.length > max) lines.splice(lines.length - 1, 0, `  … ${rows.length - max} more records`);
  return lines;
}

interface FrameState {
  run: RunCapture;
  typed: string;
  typing: boolean;
  realMs: number;
  finished: boolean;
  speed: number;
  shot: string | null;
  shotUrl: string;
  showRecords: boolean;
  steps: string[];
  banner?: string;
  borrowed?: boolean;
}

function beatHeader(beat: Beat, run: RunCapture, speed: number): { title: string; tag: string } {
  const titles: Record<Beat, string> = { 1: "1 · Compile a scraper from one sentence", 2: "2 · Re-run: zero LLM calls", 3: "3 · Self-heal when the markup changes" };
  const tags: string[] = [];
  tags.push(beat === 3 ? "controlled fixture: the markup changed between runs" : "live · books.toscrape.com");
  if (speed > 1) tags.push(`sped up ${speed}×`);
  void run;
  return { title: titles[beat], tag: tags.join(" · ") };
}

function frameHtml(s: FrameState, shotsDir: string): string {
  const { run } = s;
  const { title, tag } = beatHeader(run.beat, run, s.speed);
  const lines: string[] = [];
  if (s.banner) lines.push(`<div class="banner">${esc(s.banner)}</div>`);
  else lines.push(`<div class="cmd"><span class="p">$</span> ${esc(s.typed)}${s.typing ? '<span class="cur">▍</span>' : ""}</div>`);
  if (!s.typing) {
    for (const e of run.stderr) if (e.atMs <= s.realMs) for (const l of shownStderr(e.text)) lines.push(`<div class="l">${highlight(l)}</div>`);
    if (s.finished && run.healedFields.length > 0) lines.push(`<div class="note">healed fields: <b class="y">${esc(run.healedFields.join(", "))}</b></div>`);
    const promotions = (run.summary?.healingEvents ?? []).filter((e) => (e as { kind?: string }).kind === "promotion").length;
    if (s.finished && promotions > 0 && run.healedFields.length === 0) lines.push(`<div class="note">those ${promotions} events are promotions, not heals: the v2 alternatives now go first, <b class="g">no model call</b></div>`);
    if (!s.finished) lines.push(`<div class="l dim">running<span class="cur">▍</span></div>`);
    if (s.showRecords && run.rows.length > 0) {
      lines.push(`<div class="rec">stdout · ${run.rows.length} record${run.rows.length === 1 ? "" : "s"}</div>`);
      for (const l of jsonLines(run.rows, run.beat === 3 ? 1 : 1)) lines.push(`<div class="j">${esc(l)}</div>`);
    }
  }
  const clock = s.typing ? "" : `<span class="clock ${s.finished ? "done" : ""}">${secs(s.realMs)}</span>`;
  const img = s.shot ? `<img src="file://${join(shotsDir, s.shot)}">` : `<div class="blank">${s.typing ? "" : "no page open yet: navvi parses the prompt first"}</div>`;
  const steps = s.steps.length ? `<div class="steps">${s.steps.map((x) => `<span>${esc(x)}</span>`).join('<i>→</i>')}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box } body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: #0b0e14; color: #c9d1d9; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; overflow: hidden }
  .head { height: 64px; padding: 0 22px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #21262d }
  .head h1 { margin: 0; font-size: 28px; color: #e6edf3; font-weight: 700 } .head .tag { font-size: 19px; color: #ffa657; font-weight: 600 }
  .body { display: grid; grid-template-columns: 1fr ${PANE_W + 2}px; gap: 14px; padding: 12px 16px; height: ${HEIGHT - 64}px }
  .term { background: #0f141b; border: 1px solid #30363d; border-radius: 10px; padding: 12px 16px; font: 17px/1.38 Menlo, "SFMono-Regular", Consolas, monospace; overflow: hidden; position: relative }
  .bar { display: flex; justify-content: space-between; align-items: center; color: #6e7681; font-size: 15px; border-bottom: 1px solid #21262d; padding-bottom: 6px; margin-bottom: 8px; min-height: 36px }
  .clock { font: 700 30px/1 Menlo, monospace; color: #e6edf3 } .clock.done { color: #7ee787 }
  .cmd { color: #e6edf3; white-space: pre-wrap; overflow-wrap: anywhere; margin-bottom: 6px } .p { color: #7ee787; font-weight: 700 }
  .l { white-space: pre-wrap; word-break: break-word; color: #adbac7 } .dim { color: #6e7681 }
  .banner { margin-top: 30px; font: 700 28px/1.35 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #ffa657; border-left: 5px solid #ffa657; padding-left: 14px }
  .note { color: #e6edf3; margin-top: 4px; border-left: 3px solid #ffa657; padding-left: 8px }
  .rec { margin-top: 10px; color: #7ee787; font-weight: 700 } .j { white-space: pre; color: #79c0ff }
  b.g { color: #7ee787 } b.y { color: #ffa657 } b.b { color: #79c0ff } b.zero { color: #0b0e14; background: #7ee787; padding: 0 5px; border-radius: 3px }
  .cur { color: #7ee787 }
  .browser { background: #1c2128; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; height: ${PANE_H + 34}px; align-self: start }
  .chrome { display: flex; align-items: center; gap: 8px; padding: 0 10px; height: 34px; background: #2d333b; color: #adbac7; font-size: 14px }
  .dots span { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; background: #57606a }
  .url { flex: 1; background: #1c2128; border-radius: 4px; padding: 3px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .browser img { display: block; width: ${PANE_W}px; height: ${PANE_H}px } .blank { width: ${PANE_W}px; height: ${PANE_H}px; display: flex; align-items: center; justify-content: center; color: #6e7681; font-size: 20px; background: #161b22 }
  .cap { margin-top: 8px; font-size: 15px; color: #8b949e; text-align: center }
  .right { display: flex; flex-direction: column }
  .steps { font-size: 16px; color: #8b949e; margin-bottom: 6px } .steps span:last-child { color: #e6edf3; font-weight: 700 } .steps i { font-style: normal; margin: 0 6px; color: #57606a }
</style></head><body>
  <div class="head"><h1>${esc(title)}</h1><div class="tag">${esc(tag)}</div></div>
  <div class="body">
    <div class="term">${steps}<div class="bar"><span>stderr · ${esc(run.title)}</span>${clock}</div>${lines.join("")}</div>
    <div class="right">
      <div class="browser"><div class="chrome"><span class="dots"><span></span><span></span><span></span></span><span class="url">${esc(s.shotUrl)}</span></div>${img}</div>
      <div class="cap">${s.banner ? "before the change: the last v1 page the compile read" : s.borrowed && s.shot ? "pages closed before capture: same v2 page, from the heal run" : `the page navvi's crawler is reading · ${esc(run.site)}`}</div>
    </div>
  </div>
</body></html>`;
}

function endHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: #0b0e14; color: #e6edf3; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px }
  .row { font-size: 34px; font-weight: 700; text-align: center; line-height: 1.35 } .row .a { color: #8b949e; font-weight: 400 }
  .g { color: #7ee787 } .y { color: #ffa657 } .b { color: #79c0ff }
  code { font: 700 46px Menlo, monospace; background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 10px 26px; color: #7ee787 }
  .url { font: 26px Menlo, monospace; color: #adbac7 }
</style></head><body>
  <div class="row">Give it to your agent <span class="a">→</span> <span class="b">fast, accurate scrapers with Jev</span></div>
  <div class="row"><span class="a">→</span> <span class="g">re-runs with zero LLM calls</span> <span class="a">→</span> <span class="y">self-heals when the site changes</span></div>
  <code>npx navvi</code>
  <div class="url">github.com/fellowship-dev/navvi</div>
</body></html>`;
}

async function render(dir: string, cap: Capture): Promise<{ gif: string; mp4: string; beats: Array<Record<string, unknown>>; frames: number }> {
  const framesDir = join(dir, "frames");
  mkdirSync(framesDir, { recursive: true });
  const shotsDir = join(dir, "shots");
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })).newPage();
  let n = 0;
  const emit = async (html: string) => {
    const htmlFile = join(framesDir, "frame.html");
    writeFileSync(htmlFile, html);
    await page.goto(`file://${htmlFile}`);
    await page.screenshot({ path: join(framesDir, `${String(n).padStart(4, "0")}.png`), type: "png" });
    n += 1;
  };
  const beats: Array<Record<string, unknown>> = [];
  const steps3: string[] = [];
  for (const run of cap.runs) {
    const speed = speedFor(run);
    const startFrame = n;
    const shotAt = (realMs: number) => {
      let best: RunCapture["shots"][number] | undefined;
      for (const s of run.shots) if (s.atMs <= realMs) best = s;
      return best ?? null;
    };
    // A 1 s replay can close its pages before any screenshot lands; then the pane shows the previous
    // run's last page of the same site version, and the caption says so.
    const prevRun = cap.runs[cap.runs.indexOf(run) - 1];
    const prevShot = prevRun?.shots.at(-1);
    const borrowed = run.shots.length === 0 && prevShot && run.argv.includes(prevShot.url) ? prevShot : null;
    const lastShot = run.shots.at(-1) ?? borrowed;
    const base = { run, speed, borrowed: borrowed !== null, steps: run.beat === 3 ? [...steps3, run.title.split(" · ")[0]!] : [], shotUrl: "" };
    // 1. type the command (untimed; the clock starts when the command runs)
    if (run.id === "fixture-heal") {
      const prev = cap.runs.find((r) => r.id === "fixture-compile");
      const prevShot = prev?.shots.at(-1) ?? null;
      for (let i = 0; i < Math.round(SITE_CHANGE_S * FPS); i++) {
        await emit(frameHtml({ ...base, typed: "", typing: true, realMs: 0, finished: false, shot: prevShot?.file ?? null, shotUrl: prevShot?.url ?? "", showRecords: false, banner: "The site changed: same URLs, new markup (v1 → v2). The cached scraper is now stale." }, shotsDir));
      }
    }
    const typeFrames = Math.max(2, Math.round(TYPE_S[run.id]! * FPS));
    for (let i = 1; i <= typeFrames; i++) {
      const cut = Math.ceil((run.displayCommand.length * i) / typeFrames);
      await emit(frameHtml({ ...base, typed: run.displayCommand.slice(0, cut), typing: true, realMs: 0, finished: false, shot: null, showRecords: false }, shotsDir));
    }
    // 2. the live run, real time / speed
    const activeFrames = Math.ceil(run.wallMs / 1000 / speed / STEP);
    for (let i = 0; i < activeFrames; i++) {
      const realMs = Math.min(run.wallMs, i * STEP * speed * 1000);
      const shot = shotAt(realMs) ?? borrowed;
      await emit(frameHtml({ ...base, typed: run.displayCommand, typing: false, realMs, finished: false, shot: shot?.file ?? null, shotUrl: shot?.url ?? "", showRecords: false }, shotsDir));
    }
    // 3. done: summary, then the records
    const holdFrames = Math.round(HOLD_S[run.id]! * FPS);
    for (let i = 0; i < holdFrames; i++) {
      await emit(frameHtml({ ...base, typed: run.displayCommand, typing: false, realMs: run.wallMs, finished: true, shot: lastShot?.file ?? null, shotUrl: lastShot?.url ?? "", showRecords: i >= Math.min(3, holdFrames - 1) || run.beat === 3 }, shotsDir));
    }
    if (run.beat === 3) steps3.push(run.title.split(" · ")[0]!);
    const s = run.summary;
    beats.push({
      run: run.id, beat: run.beat, command: run.argv, displayCommand: run.displayCommand, startedAt: run.startedAt, wallMs: Math.round(run.wallMs), exitCode: run.exitCode,
      displaySpeedup: speed, frames: [startFrame, n - 1],
      stderr: run.stderr.map((e) => ({ atMs: Math.round(e.atMs), text: e.text })),
      crawlerLog: run.crawlerLog.map((e) => ({ atMs: Math.round(e.atMs), text: e.text.split(homedir()).join("~"), shownOnScreen: false })),
      summary: s ? { status: s.status, items: s.items, pages: s.pages, templates: s.templates, cacheHit: s.cacheHit, chooser: s.chooser, healingEvents: s.healingEvents, unhealed: s.unhealed, unmappedCandidates: s.unmappedCandidates.length, fieldsNotFound: s.fieldsNotFound } : null,
      healedFields: run.healedFields, records: run.rows, pageScreenshots: run.shots.length, screenshotErrors: (run.shotErrors ?? []).length, screenshotBorrowedFromPreviousRun: borrowed?.file ?? null,
    });
  }
  for (let i = 0; i < Math.round(END_S * FPS); i++) await emit(endHtml());
  await browser.close();

  const gif = join(dir, "product.gif");
  const mp4 = join(dir, "product.mp4");
  const input = join(framesDir, "%04d.png");
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-vf", `split[s0][s1];[s0]palettegen=stats_mode=diff:max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", gif], { stdio: "inherit" });
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", mp4], { stdio: "inherit" });
  return { gif, mp4, beats, frames: n };
}

// ---------------------------------------------------------------- main

/** The commit dist/ was built from: HEAD at the time of the build, plus any src/ or bin/ change since. */
function distBuild(): Record<string, unknown> {
  const builtAt = statSync(join(ROOT, "dist/bin/cli.js")).mtime.toISOString();
  const commit = execFileSync("git", ["log", "-1", `--before=${builtAt}`, "--format=%H"], { cwd: ROOT, encoding: "utf8" }).trim();
  const changedSince = execFileSync("git", ["diff", "--stat", commit, "--", "src", "bin"], { cwd: ROOT, encoding: "utf8" }).trim();
  return { builtAt, headAtBuild: commit, srcBinChangesSinceBuild: changedSince || "none" };
}

async function mainScript(): Promise<void> {
  execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
  let dir: string;
  let cap: Capture;
  if (process.env.PRODUCT_SOURCE) {
    dir = resolve(process.env.PRODUCT_SOURCE);
    cap = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8")) as Capture;
  } else {
    const parent = resolve(process.env.PRODUCT_OUT ?? tmpdir());
    mkdirSync(parent, { recursive: true });
    dir = mkdtempSync(join(parent, "navvi-product-"));
    console.log(`Recording evidence: ${dir}`);
    cap = await capture(dir);
  }
  const out = await render(dir, cap);
  const provenance = {
    asset: "docs/product.gif, docs/product.mp4",
    script: "scripts/record-product.ts",
    commit: cap.commit,
    workingTreeAtCapture: cap.workingTree || "clean",
    recordedAt: cap.recordedAt,
    how: "Each run is main() from the built dist/bin/cli.js, in-process, with the real argv; stderr is captured with timestamps. io.run wraps the built run() only to add CrawlDeps.onPage (actual crawler page screenshots) and to keep the RunSummary. Crawler log lines (deps.log) are kept here but not shown on screen.",
    chooser: "default chooser resolution (no --chooser flag): Jev decides, a signed-in Claude Code answers the text question (prompt parsing)",
    display: { width: WIDTH, height: HEIGHT, fps: FPS, note: "Clocks show real elapsed time. Each run's live section is sped up uniformly by displaySpeedup, which is printed on screen when > 1. Command typing and result holds are untimed." },
    beat3: "controlled two-version fixture (demo/pharmacy-v1 then demo/pharmacy-v2 behind the same URLs, served by tests/server.ts), with live Jev decisions for compile and heal",
    frames: out.frames,
    distBuild: distBuild(),
    runs: out.beats,
  };
  writeFileSync(join(dir, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  for (const file of [out.gif, out.mp4]) console.log(`${file}: ${(statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`frames: ${out.frames} (${(out.frames / FPS).toFixed(1)} s)`);
  for (const b of out.beats) console.log(`${b.run}: ${b.wallMs} ms, speedup ${b.displaySpeedup}×, frames ${JSON.stringify(b.frames)}`);
  if (process.env.PRODUCT_PUBLISH === "1") {
    copyFileSync(out.gif, join(ROOT, "docs/product.gif"));
    copyFileSync(out.mp4, join(ROOT, "docs/product.mp4"));
    copyFileSync(join(dir, "provenance.json"), join(ROOT, "docs/product-provenance.json"));
    console.log("published to docs/product.*");
  }
}

crawleeLog.setLevel(LogLevel.WARNING);
try {
  await mainScript();
} catch (error) {
  console.error(`record-product: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
}
process.exit();
