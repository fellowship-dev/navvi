import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Actor } from "apify";
import { LogLevel, MemoryStorage, log as crawleeLog } from "crawlee";
import { chromium, type Browser } from "playwright";
import { RecordedChooser } from "../src/chooser/index.js";
import { run } from "../src/main.js";
import { FPS, HEIGHT, Recorder, SHOT_HEIGHT, SHOT_WIDTH, WIDTH, encode } from "./recorder.js";

/**
 * Records a GIF of navvi scraping a real public site twice: the first run
 * compiles with answers a person or agent gave live (recorded under
 * tests/recorded/live/<site>), the second run replays with zero questions.
 *
 *   npx tsx scripts/record-live.ts python-jobs
 *   npx tsx scripts/record-live.ts hackernews
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");

interface Site {
  name: string;
  url: string;
  prompt: string;
  fields: string[];
  bar: string;
}

const SITES: Record<string, Site> = {
  "python-jobs": {
    name: "python.org jobs",
    url: "https://www.python.org/jobs/",
    prompt: "every job with title, company, location and link",
    fields: ["title", "company", "location", "link"],
    bar: 'npx navvi "every job with title, company, location and link" https://www.python.org/jobs/',
  },
  hackernews: {
    name: "Hacker News",
    url: "https://news.ycombinator.com/",
    prompt: "front page stories with title, link, points and comments",
    fields: ["title", "link", "points", "comments"],
    bar: 'npx navvi "front page stories with title, link, points and comments" https://news.ycombinator.com/',
  },
};

function cell(value: unknown, max: number): string {
  const text = value === null || value === undefined ? "null" : String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function record(key: string): Promise<void> {
  const site = SITES[key];
  if (!site) throw new Error(`unknown site ${key}; known: ${Object.keys(SITES).join(", ")}`);
  const frames = join(DOCS, `live-${key}-frames`);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });

  const dir = mkdtempSync(join(tmpdir(), "navvi-live-"));
  const storage = new MemoryStorage({ localDataDirectory: join(dir, "storage"), persistStorage: false });
  const actor = new Actor({ storageClient: storage });
  await actor.init({ storage, gracefulShutdown: false });

  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    const shotPage = await context.newPage();
    await shotPage.setViewportSize({ width: SHOT_WIDTH, height: SHOT_HEIGHT });
    const composePage = await context.newPage();
    const recorder = new Recorder(shotPage, composePage, frames);
    recorder.setTheme({ bar: "navvi — compile it once so you never drive it again", badge: site.name, badgeColor: "#1f6feb", pageAlt: site.name });
    await recorder.snapshotSite(site.url, site.name);

    await recorder.type(`$ ${site.bar}`, 6);
    await recorder.hold(2);
    await recorder.working("run 1  compiling: the agent answers the compile questions", 6);

    const input = { prompt: site.prompt, startUrls: [site.url], mode: "list", fields: site.fields.map((name) => ({ name })), maxPages: 1, browser: "chromium", chooser: "agent" };
    const t1 = Date.now();
    const first = await run(input, { actor, chooser: new RecordedChooser({ fixture: `live/${key}` }), env: {}, storageDir: join(dir, "st"), attended: false });
    const ms1 = Date.now() - t1;
    const rows = (await (await actor.openDataset()).getData()).items as Array<Record<string, unknown>>;
    await recorder.typeAll([
      `run 1  compiled 1 template, ${first.chooser?.questions ?? 0} questions, ${first.items} records, ${ms1} ms`,
      `       status ${first.status}, chooser ${first.chooser?.name === "recorded" ? "agent" : first.chooser?.name}, $${(first.chooser?.costUsd ?? 0).toFixed(4)}`,
    ]);
    for (const row of rows.slice(0, 4)) {
      await recorder.type(`  ${site.fields.map((f) => `${f}: ${cell(row[f], f === "link" ? 44 : 34)}`).join("  ")}`, 4);
    }
    await recorder.hold(6);

    await recorder.type(`$ ${site.bar}`, 4);
    await recorder.working("run 2  replaying the cached scraper", 4);
    const t2 = Date.now();
    const second = await run(input, { actor, chooser: new RecordedChooser({ fixture: `live/${key}` }), env: {}, storageDir: join(dir, "st"), attended: false });
    const ms2 = Date.now() - t2;
    await recorder.typeAll([
      `run 2  cache hit, ${second.chooser?.questions ?? 0} questions, ${second.items} records, ${ms2} ms`,
      `       the compiled scraper is a JSON file you can commit: storage/key_value_stores/scraper-cache/`,
    ]);
    await recorder.hold(16);
    await context.close();
    console.log(`frames: ${recorder.frameCount} (${(recorder.frameCount / FPS).toFixed(1)} s at ${FPS} fps); run1 ${first.status} ${first.items} items ${ms1} ms; run2 ${second.status} ${second.items} items ${ms2} ms`);
  } finally {
    await browser.close();
    await actor.exit({ exit: false });
  }
  encode(frames, join(DOCS, `live-${key}.gif`), join(DOCS, `live-${key}.mp4`));
  rmSync(frames, { recursive: true, force: true });
}

crawleeLog.setLevel(LogLevel.WARNING);
try {
  await record(process.argv[2] ?? "python-jobs");
} catch (error) {
  console.error(`record-live: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
