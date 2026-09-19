import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LogLevel, log as crawleeLog } from "crawlee";
import { chromium, type Browser, type Page } from "playwright";
import { runDemo, type DemoPhase, type DemoPhaseContext } from "./demo.js";

/**
 * U19: docs/demo.gif and docs/demo.mp4 without vhs or asciinema.
 *
 * The three-step proof runs for real; at every phase the recorder screenshots
 * the demo product page (v1, then v2, then v1 again) and composes one HTML
 * page: the page on the left, a terminal panel on the right with the demo's
 * output typed line by line. Each composed page is one PNG frame under
 * docs/demo-frames; ffmpeg encodes them and the frames are deleted.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const FRAMES = join(DOCS, "demo-frames");
const GIF = join(DOCS, "demo.gif");
const MP4 = join(DOCS, "demo.mp4");
const FPS = 6;
const WIDTH = 960;
const HEIGHT = 600;
const PAGE_WIDTH = 432;
const PAGE_HEIGHT = 528;
/** The product page renders at a desktop-ish width and is scaled into the panel. */
const PAGE_SCALE = 0.72;
const SHOT_WIDTH = Math.round(PAGE_WIDTH / PAGE_SCALE);
const SHOT_HEIGHT = Math.round(PAGE_HEIGHT / PAGE_SCALE);
const SAMPLE_PRODUCT = "ibuprofeno-400-mg";
const FFMPEG = process.env.FFMPEG ?? (existsSync("/usr/local/bin/ffmpeg") ? "/usr/local/bin/ffmpeg" : "ffmpeg");
const FFPROBE = FFMPEG.endsWith("ffmpeg") ? `${FFMPEG.slice(0, -"ffmpeg".length)}ffprobe` : "ffprobe";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Colors the CLI-style lines: run labels, cache hits, drift, the free third run and the verdict. */
function highlight(line: string): string {
  let html = escapeHtml(line);
  if (html.startsWith("$ ")) return `<span class="prompt">$</span> <span class="cmd">${html.slice(2)}</span>`;
  if (html.startsWith("navvi demo:")) return `<span class="title">${html}</span>`;
  if (html.startsWith("demo: PASS")) return `<span class="pass">${html}</span>`;
  if (html.startsWith("demo: FAIL")) return `<span class="fail">${html}</span>`;
  html = html.replace(/^(run \d)(\s+)(v[12])(\s+)/, '<span class="run">$1</span>$2<span class="ver">$3</span>$4');
  html = html.replace(/^(\s+site \w+:)/, '<span class="site">$1</span>');
  html = html.replace(/cache hit/g, '<span class="ok">cache hit</span>');
  html = html.replace(/drift detected on ([\w, ]+?)(?=, healed)/, 'drift detected on <span class="warn">$1</span>');
  html = html.replace(/healed with (\d+) questions/, '<span class="ok">healed</span> with <span class="num">$1</span> questions');
  html = html.replace(/\b0 questions\b/, '<span class="free">0 questions</span>');
  html = html.replace(/(\d+) records/g, '<span class="num">$1</span> records');
  html = html.replace(/(\d+) ms(?=$|,)/g, '<span class="ms">$1 ms</span>');
  html = html.replace(/(compiled 1 template)/, '<span class="ok">$1</span>');
  return html;
}

function compose(pageShot: string, version: string, url: string, lines: readonly string[], partial: string | null, working: string | null): string {
  const rendered = lines.map((line) => `<div class="line">${highlight(line)}</div>`);
  if (partial !== null) rendered.push(`<div class="line">${highlight(partial)}<span class="cursor">▍</span></div>`);
  if (working !== null) rendered.push(`<div class="line dim">${escapeHtml(working)}</div>`);
  if (partial === null && working === null) rendered.push(`<div class="line"><span class="cursor">▍</span></div>`);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: #0b0e14; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; overflow: hidden; }
  .wrap { display: grid; grid-template-columns: ${PAGE_WIDTH + 16}px 1fr; gap: 8px; padding: 8px; height: ${HEIGHT}px; }
  .browser { background: #1c2128; border-radius: 8px; overflow: hidden; border: 1px solid #30363d; display: flex; flex-direction: column; }
  .chrome { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #2d333b; color: #adbac7; font-size: 11px; }
  .dots span { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; }
  .url { flex: 1; background: #1c2128; border-radius: 4px; padding: 3px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { padding: 2px 7px; border-radius: 10px; font-weight: 700; font-size: 10px; color: #fff; background: ${version === "v2" ? "#c0392b" : "#0b6e4f"}; }
  .browser img { display: block; width: ${PAGE_WIDTH}px; height: ${PAGE_HEIGHT}px; }
  .term { background: #0f141b; border-radius: 8px; border: 1px solid #30363d; padding: 10px 14px; color: #c9d1d9; font: 12.5px/1.55 "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace; overflow: hidden; display: flex; flex-direction: column; }
  .term .bar { color: #6e7681; font-size: 11px; margin-bottom: 8px; border-bottom: 1px solid #21262d; padding-bottom: 6px; }
  .line { white-space: pre-wrap; word-break: break-word; margin: 1px 0; }
  .dim { color: #6e7681; }
  .prompt { color: #7ee787; font-weight: 700; } .cmd { color: #e6edf3; } .title { color: #79c0ff; font-weight: 700; }
  .run { color: #d2a8ff; font-weight: 700; } .ver { color: #ffa657; font-weight: 700; } .site { color: #8b949e; font-style: italic; }
  .ok { color: #7ee787; } .warn { color: #ffa657; } .num { color: #79c0ff; font-weight: 700; } .ms { color: #8b949e; }
  .free { color: #7ee787; font-weight: 700; background: #12361f; padding: 0 4px; border-radius: 3px; }
  .pass { color: #0b0e14; background: #7ee787; font-weight: 700; padding: 0 6px; border-radius: 3px; }
  .fail { color: #fff; background: #f85149; font-weight: 700; padding: 0 6px; border-radius: 3px; }
  .cursor { color: #7ee787; }
</style></head><body><div class="wrap">
  <div class="browser">
    <div class="chrome"><span class="dots"><span style="background:#ff5f56"></span><span style="background:#ffbd2e"></span><span style="background:#27c93f"></span></span><span class="url">${escapeHtml(url)}</span><span class="badge">site ${version}</span></div>
    <img src="${pageShot}" alt="product page ${version}">
  </div>
  <div class="term"><div class="bar">npm run demo — navvi, the self-healing scraper compiler</div>${rendered.join("")}</div>
</div></body></html>`;
}

class Recorder {
  private frame = 0;
  private pageShot = "";
  private version = "v1";
  private url = "";
  /** Lines already typed into the terminal. */
  private shown: string[] = [];

  constructor(
    private readonly shotPage: Page,
    private readonly composePage: Page,
  ) {}

  get frames(): number {
    return this.frame;
  }

  async snapshotSite(baseUrl: string, version: string): Promise<void> {
    this.version = version;
    this.url = `${baseUrl}/demo/pharmacy/producto/${SAMPLE_PRODUCT}.html`;
    await this.shotPage.goto(this.url, { waitUntil: "load" });
    const png = await this.shotPage.screenshot({ type: "png", clip: { x: 0, y: 0, width: SHOT_WIDTH, height: SHOT_HEIGHT } });
    this.pageShot = `data:image/png;base64,${png.toString("base64")}`;
  }

  private async emit(partial: string | null, working: string | null): Promise<void> {
    await this.composePage.setContent(compose(this.pageShot, this.version, this.url, this.shown, partial, working));
    const file = join(FRAMES, `${String(this.frame).padStart(4, "0")}.png`);
    await this.composePage.screenshot({ path: file, type: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    this.frame += 1;
  }

  async hold(frames: number): Promise<void> {
    for (let i = 0; i < frames; i++) await this.emit(null, null);
  }

  /** Types one line in `steps` frames, then shows it complete. */
  async type(line: string, steps = 3): Promise<void> {
    for (let i = 1; i < steps; i++) await this.emit(line.slice(0, Math.ceil((line.length * i) / steps)), null);
    this.shown.push(line);
    await this.emit(null, null);
  }

  async typeAll(lines: readonly string[]): Promise<void> {
    for (const line of lines) await this.type(line, line.length > 90 ? 5 : 3);
  }

  async working(label: string, frames = 4): Promise<void> {
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴"];
    for (let i = 0; i < frames; i++) await this.emit(null, `${label} ${spinner[i % spinner.length]}`);
  }
}

async function record(): Promise<void> {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  mkdirSync(DOCS, { recursive: true });
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    const shotPage = await context.newPage();
    await shotPage.setViewportSize({ width: SHOT_WIDTH, height: SHOT_HEIGHT });
    const composePage = await context.newPage();
    const recorder = new Recorder(shotPage, composePage);

    let typed = 0;
    const flush = async (lines: readonly string[]) => {
      await recorder.typeAll(lines.slice(typed));
      typed = lines.length;
    };
    const nextRun = (phase: DemoPhase, context: DemoPhaseContext): number | null => {
      if (phase === "start") return 1;
      if (phase === "switch") return context.version === "v2" ? 2 : 3;
      return null;
    };

    const onPhase = async (phase: DemoPhase, context: DemoPhaseContext): Promise<void> => {
      await recorder.snapshotSite(context.server.baseUrl, context.version);
      await flush(context.lines);
      const run = nextRun(phase, context);
      if (run !== null) {
        await recorder.hold(phase === "start" ? 2 : 3);
        await recorder.working(`run ${run}  ${context.version}  ${run === 1 ? "compiling" : run === 2 ? "replaying the cached scraper" : "replaying"}`, run === 1 ? 5 : 4);
      } else if (phase === "run") {
        await recorder.hold(context.run?.index === 2 ? 8 : 6);
      } else {
        await recorder.hold(18);
      }
    };

    const result = await runDemo({ log: () => undefined, onPhase });
    if (!result.ok) throw new Error(`demo failed, nothing encoded:\n  - ${result.failures.join("\n  - ")}`);
    await context.close();
    console.log(`frames: ${recorder.frames} (${(recorder.frames / FPS).toFixed(1)} s at ${FPS} fps)`);
  } finally {
    await browser.close();
  }

  const input = join(FRAMES, "%04d.png");
  execFileSync(
    FFMPEG,
    ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-vf", `scale=${WIDTH}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", GIF],
    { stdio: "inherit" },
  );
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", MP4], { stdio: "inherit" });
  rmSync(FRAMES, { recursive: true, force: true });

  for (const file of [GIF, MP4]) {
    const size = statSync(file).size;
    let duration = "?";
    try {
      duration = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], { encoding: "utf8" }).trim();
    } catch {
      // ffprobe is optional for the report
    }
    console.log(`${file}: ${(size / 1024 / 1024).toFixed(2)} MB, ${Number(duration).toFixed(1)} s`);
    if (file === GIF && size > 4 * 1024 * 1024) throw new Error(`docs/demo.gif is ${(size / 1024 / 1024).toFixed(2)} MB, over the 4 MB budget`);
  }
}

crawleeLog.setLevel(LogLevel.WARNING);
try {
  await record();
} catch (error) {
  console.error(`record-demo: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
