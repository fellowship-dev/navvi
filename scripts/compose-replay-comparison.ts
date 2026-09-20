/** Compose two sequential recordings without synthesizing their browser frames or timers.
 * Frame anchors are manually verified against the original rounded on-screen clocks.
 * See docs/recording.md. This never starts a crawler or calls a model.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { FFMPEG } from "./recorder.js";

const args = process.argv.slice(2);
const option = (name: string): string => {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing --${name}`);
  return args[index + 1]!;
};
const number = (name: string): number => {
  const value = Number(option(name));
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${name}`);
  return value;
};
const source = resolve(option("source"));
const expectedSource = option("expect-source");
const anchors = {
  compile: { first: number("compile-start"), last: number("compile-end"), displayedSeconds: number("compile-anchor") },
  replay: { first: number("replay-start"), last: number("replay-end"), displayedSeconds: number("replay-anchor") },
};
const parent = resolve(process.env.DEMO_OUT ?? tmpdir());
mkdirSync(parent, { recursive: true });
const output = mkdtempSync(join(parent, "navvi-replay-comparison-"));
const frames = join(output, "frames");
mkdirSync(frames);
const rawReceipt = readFileSync(join(source, "receipt.json"));
const receipt = JSON.parse(rawReceipt.toString());
const lane = receipt.lanes.find((lane: { key: string }) => lane.key === "jev");
if (!lane) throw new Error("Source has no Jev lane");
const laneIndex = receipt.lanes.findIndex((lane: { key: string }) => lane.key === "jev");
const laneOffset = laneIndex === 0 ? 0 : 635;
for (const phase of ["compile", "replay"]) {
  const report = lane.reports.find((report: { phase: string }) => report.phase === phase);
  if (!report || report.error || report.summary.status !== "succeeded" || report.rows.length === 0 || report.rows.length !== report.summary.items) throw new Error(`${phase}: unsuccessful source`);
  for (const row of report.rows) {
    if (row._source !== expectedSource) throw new Error(`${phase}: wrong source URL`);
    for (const field of report.summary.input.fields) {
      if (row[field.name] == null || String(row[field.name]).trim() === "") throw new Error(`${phase}: empty ${field.name}`);
    }
  }
  writeFileSync(join(output, `${phase}-rows.json`), JSON.stringify(report.rows, null, 2) + "\n");
}
const replayReport = lane.reports.find((report: { phase: string }) => report.phase === "replay");
if (replayReport.questions !== 0) throw new Error("Source replay is not model-free");
const compileReport = lane.reports.find((report: { phase: string }) => report.phase === "compile");
const manifest = readFileSync(join(source, "frames", "frames.txt"), "utf8");
const entries: Array<{ file: string; at: number; duration: number }> = [];
let at = 0;
for (const match of manifest.matchAll(/file '([^']+)'\nduration ([\d.]+)/g)) {
  const duration = Number(match[2]);
  entries.push({ file: match[1]!, at, duration });
  at += duration;
}
for (const anchor of Object.values(anchors)) {
  if (!Number.isInteger(anchor.first) || !Number.isInteger(anchor.last) || anchor.last <= anchor.first || !entries[anchor.last]) throw new Error("Frame anchors are outside manifest");
}
const FPS = 4;
const duration = compileReport.wallMs / 1000 + 2;
const sourceAt = (phase: keyof typeof anchors, elapsed: number): number => {
  const anchor = anchors[phase];
  const target = entries[anchor.first]!.at - anchor.displayedSeconds + elapsed;
  // Before the first active screenshot, preserve the actual preceding waiting frame.
  let index = Math.max(0, anchor.first - 1);
  while (index < anchor.last && entries[index + 1]!.at <= target) index++;
  return index;
};
const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const images = new Map<number, string>();
const image = (index: number) => {
  if (!images.has(index)) images.set(index, `data:image/png;base64,${readFileSync(join(source, "frames", entries[index]!.file)).toString("base64")}`);
  return images.get(index)!;
};
const results = (report: typeof compileReport, elapsed: number) => elapsed * 1000 < report.wallMs ? "" : `<div class="results"><b>${report.rows.length} records saved · first 2 shown</b>${report.rows.slice(0, 2).map((row: Record<string, unknown>) => {
  const fields = report.summary.input.fields as Array<{ name: string }>;
  const values = fields.map(({ name }) => String(row[name] ?? ""));
  return `<article><div>${esc(values[0] ?? "")}</div><small>${values.slice(1).map((value) => esc(/^https?:/.test(value) ? new URL(value).hostname : value)).join(" · ")}</small></article>`;
}).join("")}</div>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const mapping: Array<{ outputFrame: number; elapsedSeconds: number; compileFrame: string; replayFrame: string }> = [];
try {
  for (let i = 0; i < Math.ceil(duration * FPS); i++) {
    const elapsed = i / FPS;
    const compileIndex = sourceAt("compile", elapsed);
    const replayIndex = sourceAt("replay", elapsed);
    mapping.push({ outputFrame: i, elapsedSeconds: elapsed, compileFrame: entries[compileIndex]!.file, replayFrame: entries[replayIndex]!.file });
    await page.setContent(`<!doctype html><html><head><style>
      *{box-sizing:border-box}body{margin:0;width:1280px;height:800px;background:#0b0e14;color:#e6edf3;font-family:-apple-system,Arial,sans-serif;overflow:hidden}
      header{height:80px;padding:10px 16px;border-bottom:1px solid #30363d;font-size:20px;line-height:27px}header b{color:#7ee787}header span{color:#adbac7;font-size:18px}
      .panels{display:flex;gap:8px}.panel{width:632px}.label{height:32px;padding:4px 10px;font-size:20px;font-weight:700;color:#79c0ff}.repeat{color:#7ee787}
      .raw{position:relative;width:632px;height:474px;overflow:hidden}.raw img{position:absolute;left:-${laneOffset}px;top:-80px;width:1280px;height:800px;max-width:none}
      .results{padding:8px 12px;font:20px/1.2 -apple-system,Arial,sans-serif}.results article{margin-top:6px;border-top:1px solid #30363d;padding-top:6px}.results article div{font-weight:600;line-height:24px}.results small{display:block;font-size:17px;color:#adbac7;margin-top:3px}.results table{width:100%;table-layout:fixed;border-collapse:collapse}.results td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-top:1px solid #30363d;padding:2px 5px 2px 0}.results b{display:block;color:#7ee787;font-size:20px}
      footer{position:absolute;bottom:0;left:0;width:1280px;height:38px;padding:9px 16px;font-size:16px;color:#adbac7;border-top:1px solid #30363d;background:#0b0e14}
      </style></head><body><header><b>Navvi</b> · ${esc(receipt.prompt)}<br><span>Same prompt · ${esc(new URL(receipt.startUrl).hostname)} · fresh browser for each run</span></header>
      <div class="panels"><section class="panel"><div class="label">First run · Jev + text fallback</div><div class="raw"><img src="${image(compileIndex)}"></div>${results(compileReport, elapsed)}</section>
      <section class="panel"><div class="label repeat">Repeat · saved scraper</div><div class="raw"><img src="${image(replayIndex)}"></div>${results(replayReport, elapsed)}</section></div>
      <footer>Two sequential real runs, aligned for comparison · original rounded timers · faster run freezes when complete</footer></body></html>`);
    await page.screenshot({ path: join(frames, `${String(i).padStart(4, "0")}.png`) });
  }
} finally { await browser.close(); }
writeFileSync(join(output, "provenance.json"), JSON.stringify({
  sourceDirectory: source, sourceReceiptSha256: createHash("sha256").update(rawReceipt).digest("hex"),
  sourceManifestSha256: createHash("sha256").update(manifest).digest("hex"),
  sourceCommit: receipt.commit, sourceWorkingTree: receipt.workingTree, sourceRecordedAt: receipt.recordedAt,
  prompt: receipt.prompt, expectedSource, validatedLane: lane,
  editing: "Sequential actual Jev runs aligned using original rounded clock anchors; original timer and browser pixels preserved; final frames frozen; saved receipt rows shown after measured completion. Haiku excluded.",
  alignmentPrecisionSeconds: 0.05, samplingFramesPerSecond: FPS, anchors, mapping,
  limitations: "A measured example, not a universal speedup or an independent held-out benchmark. Alignment has original timer rounding and frame sampling precision.",
}, null, 2) + "\n");
const input = join(frames, "%04d.png");
execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(output, "replay-comparison.mp4")], { stdio: "inherit" });
execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-vf", "split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle", "-loop", "0", join(output, "replay-comparison.gif")], { stdio: "inherit" });
console.log(output);
