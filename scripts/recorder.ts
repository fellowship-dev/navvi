import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

/** Shared frame compositor and encoder for the demo and live-site recordings. */

export const FPS = 6;
export const WIDTH = 960;
export const HEIGHT = 600;
export const PAGE_WIDTH = 432;
export const PAGE_HEIGHT = 528;
const PAGE_SCALE = 0.72;
export const SHOT_WIDTH = Math.round(PAGE_WIDTH / PAGE_SCALE);
export const SHOT_HEIGHT = Math.round(PAGE_HEIGHT / PAGE_SCALE);
export const FFMPEG = process.env.FFMPEG ?? (existsSync("/usr/local/bin/ffmpeg") ? "/usr/local/bin/ffmpeg" : "ffmpeg");
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

export interface ComposeTheme { bar: string; badge: string; badgeColor: string; pageAlt: string }

export function compose(pageShot: string, theme: ComposeTheme, url: string, lines: readonly string[], partial: string | null, working: string | null): string {
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
  .badge { padding: 2px 7px; border-radius: 10px; font-weight: 700; font-size: 10px; color: #fff; background: ${theme.badgeColor}; }
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
    <div class="chrome"><span class="dots"><span style="background:#ff5f56"></span><span style="background:#ffbd2e"></span><span style="background:#27c93f"></span></span><span class="url">${escapeHtml(url)}</span><span class="badge">${escapeHtml(theme.badge)}</span></div>
    <img src="${pageShot}" alt="${escapeHtml(theme.pageAlt)}">
  </div>
  <div class="term"><div class="bar">${escapeHtml(theme.bar)}</div>${rendered.join("")}</div>
</div></body></html>`;
}

export class Recorder {
  private frame = 0;
  private pageShot = "";
  private theme: ComposeTheme = { bar: "navvi", badge: "", badgeColor: "#0b6e4f", pageAlt: "page" };
  private url = "";
  /** Lines already typed into the terminal. */
  private shown: string[] = [];

  constructor(
    private readonly shotPage: Page,
    private readonly composePage: Page,
    private readonly frames: string,
  ) {}

  setTheme(theme: Partial<ComposeTheme>): void {
    this.theme = { ...this.theme, ...theme };
  }

  get frameCount(): number {
    return this.frame;
  }

  async snapshotSite(url: string, badge?: string): Promise<void> {
    if (badge !== undefined) this.theme = { ...this.theme, badge, badgeColor: badge.includes("v2") ? "#c0392b" : "#0b6e4f" };
    this.url = url;
    await this.shotPage.goto(this.url, { waitUntil: "load" });
    const png = await this.shotPage.screenshot({ type: "png", clip: { x: 0, y: 0, width: SHOT_WIDTH, height: SHOT_HEIGHT } });
    this.pageShot = `data:image/png;base64,${png.toString("base64")}`;
  }

  private async emit(partial: string | null, working: string | null): Promise<void> {
    await this.composePage.setContent(compose(this.pageShot, this.theme, this.url, this.shown, partial, working));
    const file = join(this.frames, `${String(this.frame).padStart(4, "0")}.png`);
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


/** Encodes the PNG frames under `frames` into a GIF and an MP4 and reports their sizes. */
export function encode(frames: string, gif: string, mp4: string, maxGifBytes = 4 * 1024 * 1024): void {
  const input = join(frames, "%04d.png");
  execFileSync(
    FFMPEG,
    ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-vf", `scale=${WIDTH}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", gif],
    { stdio: "inherit" },
  );
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", mp4], { stdio: "inherit" });
  for (const file of [gif, mp4]) {
    const size = statSync(file).size;
    let duration = "?";
    try {
      duration = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], { encoding: "utf8" }).trim();
    } catch {
      // ffprobe is optional for the report
    }
    console.log(`${file}: ${(size / 1024 / 1024).toFixed(2)} MB, ${Number(duration).toFixed(1)} s`);
    if (file === gif && size > maxGifBytes) throw new Error(`${gif} is ${(size / 1024 / 1024).toFixed(2)} MB, over the ${(maxGifBytes / 1024 / 1024).toFixed(0)} MB budget`);
  }
}
