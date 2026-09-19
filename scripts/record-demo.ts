import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LogLevel, log as crawleeLog } from "crawlee";
import { chromium, type Browser } from "playwright";
import { runDemo, type DemoPhase, type DemoPhaseContext } from "./demo.js";
import { FPS, HEIGHT, Recorder, SHOT_HEIGHT, SHOT_WIDTH, WIDTH, encode } from "./recorder.js";

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
const SAMPLE_PRODUCT = "ibuprofeno-400-mg";

async function record(): Promise<void> {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    const shotPage = await context.newPage();
    await shotPage.setViewportSize({ width: SHOT_WIDTH, height: SHOT_HEIGHT });
    const composePage = await context.newPage();
    const recorder = new Recorder(shotPage, composePage, FRAMES);
    recorder.setTheme({ bar: "npm run demo — navvi, the self-healing scraper compiler", pageAlt: "demo product page" });

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
      await recorder.snapshotSite(`${context.server.baseUrl}/demo/pharmacy/producto/${SAMPLE_PRODUCT}.html`, `site ${context.version}`);
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
    console.log(`frames: ${recorder.frameCount} (${(recorder.frameCount / FPS).toFixed(1)} s at ${FPS} fps)`);
  } finally {
    await browser.close();
  }
  encode(FRAMES, join(DOCS, "demo.gif"), join(DOCS, "demo.mp4"));
  rmSync(FRAMES, { recursive: true, force: true });
}

crawleeLog.setLevel(LogLevel.WARNING);
try {
  await record();
} catch (error) {
  console.error(`record-demo: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
