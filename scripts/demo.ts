import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Actor } from "apify";
import { LogLevel, MemoryStorage, log as crawleeLog } from "crawlee";
import type { Answer, Chooser, ChooserUsage, Question } from "../src/chooser/chooser.js";
import { createChooser } from "../src/chooser/index.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { defaultChooser, parseInput } from "../src/input/schema.js";
import type { RunSummary } from "../src/main.js";
import { runCrawl, type CrawlDeps } from "../src/replay/crawler.js";
import { isFieldHealingEvent } from "../src/replay/heal.js";
import { cacheKey, type CompiledScraper } from "../src/scraper/schema.js";
import { ScraperStore } from "../src/scraper/store.js";
import { groupByTemplate } from "../src/template/index.js";
import { startFixtureServer, type DemoVersion, type FixtureServer } from "../tests/server.js";

/**
 * U19 / U15: the two-version proof (AE8) as a demo a human watches.
 *
 * `npm run demo` starts the fixture server, compiles the pharmacy scraper on
 * v1 with recorded answers, switches the same URLs to v2 and heals, switches
 * back to v1 and replays with zero questions. Exit 0 when every assertion
 * holds, 1 otherwise. `--live` swaps the recorded answers for a real chooser
 * (`createChooser`) when a key is set; `tests/acceptance.test.ts` drives the
 * same `runDemo()` and `scripts/record-demo.ts` renders it into docs/demo.gif.
 */

export type DemoPhase = "start" | "run" | "switch" | "end";

export interface DemoPhaseContext {
  server: FixtureServer;
  version: DemoVersion;
  /** Every line logged so far. */
  lines: readonly string[];
  /** The run just finished, on `run` phases. */
  run?: DemoRun;
}

export interface DemoOptions {
  live?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Human-readable progress lines; defaults to console.log. */
  log?: ((line: string) => void) | undefined;
  /** Called after the server starts, after each run, after each version switch and at the end. */
  onPhase?: ((phase: DemoPhase, context: DemoPhaseContext) => Promise<void> | void) | undefined;
  /** Reuse a running fixture server instead of starting one. */
  server?: FixtureServer | undefined;
}

export type DemoRow = Record<string, unknown>;

export interface DemoRun {
  index: 1 | 2 | 3;
  version: DemoVersion;
  summary: RunSummary;
  rows: DemoRow[];
  elapsedMs: number;
  /** The one-line result printed for this run. */
  line: string;
}

export interface DemoResult {
  ok: boolean;
  failures: string[];
  runs: DemoRun[];
  /** The scraper in the cache after the three runs. */
  stored: CompiledScraper | null;
  lines: string[];
  totalMs: number;
}

export const DEMO_PRODUCTS = [
  "amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema", "diclofenaco-gel", "ibuprofeno-400-mg", "loratadina-10-mg",
  "losartan-50-mg", "metformina-850-mg", "omeprazol-20-mg", "paracetamol-500-mg", "salbutamol-inhalador", "vitamina-c-1-g",
] as const;
export const DEMO_FIELDS = ["name", "laboratory", "price", "stock"] as const;
export const DEMO_DESCRIPTION = "pharmacy product";
export const DEMO_PROMPT = "name, laboratory, price and stock of each pharmacy product";
const OUT_OF_STOCK = ["ibuprofeno-400-mg", "losartan-50-mg"];
const EXPECTED_UNMAPPED = ["Sin stock", "Precio oferta"];

export const productUrls = (baseUrl: string): string[] => DEMO_PRODUCTS.map((slug) => `${baseUrl}/demo/pharmacy/producto/${slug}.html`);

const isHealBatch = (batch: Question[]): boolean => batch.some((q) => q.id.startsWith("heal."));

/** Routes every batch to the recorded fixture the AE8 test uses: out-of-stock pages have no price candidate. */
class RoutingRecordedChooser implements Chooser {
  readonly name = "recorded" as const;
  private readonly inner = new Map<string, RecordedChooser>();
  constructor(private readonly route: (batch: Question[]) => string) {}
  async ask(batch: Question[]): Promise<Answer[]> {
    const fixture = this.route(batch);
    let chooser = this.inner.get(fixture);
    if (!chooser) this.inner.set(fixture, (chooser = new RecordedChooser({ fixture })));
    return chooser.ask(batch);
  }
  usage(): ChooserUsage {
    const all = [...this.inner.values()].map((c) => c.usage());
    const sum = (k: "questions" | "textQuestions" | "batches" | "inputTokens" | "outputTokens" | "waitMs" | "costUsd") => all.reduce((n, u) => n + u[k], 0);
    return { chooser: "recorded", questions: sum("questions"), textQuestions: sum("textQuestions"), batches: sum("batches"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), waitMs: sum("waitMs"), costUsd: sum("costUsd"), zeroDataRetention: "not_applicable" };
  }
}

// Route by the known fixture page, not batch size: concurrent healing can leave
// only price broken on an in-stock page, and no-stock pages contain related prices.
function recordedChooser(): Chooser {
  return new RoutingRecordedChooser((batch) => (isHealBatch(batch) && batch.every((q) => q.id === "heal.price" && /^Healing on \S+\/(?:ibuprofeno-400-mg|losartan-50-mg)\.html(?:\n|$)/.test(q.state)) ? "heal/pharmacy-nostock" : "heal/pharmacy"));
}

function liveChooser(env: NodeJS.ProcessEnv): Chooser {
  const name = defaultChooser(env);
  if (name === "agent") throw new Error("--live needs a key: set AI_GATEWAY_API_KEY, TYPESAFE_API_KEY or ANTHROPIC_API_KEY (the agent chooser has nobody to answer here).");
  return createChooser({ chooser: name, env });
}

function slugOf(row: DemoRow): string {
  return String(row._source).split("/").pop()!.replace(".html", "");
}

const ms = (n: number) => `${Math.round(n)} ms`;

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    log(line);
  };
  const failures: string[] = [];
  const check = (condition: boolean, what: string) => {
    if (!condition) failures.push(what);
  };
  const runs: DemoRun[] = [];
  const startedAt = performance.now();

  const ownServer = !options.server;
  const server = options.server ?? (await startFixtureServer());
  const dir = mkdtempSync(join(tmpdir(), "navvi-demo-"));
  const storage = new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false });
  const actor = new Actor({ storageClient: storage });
  // Local init only: no platform env, no graceful-shutdown handlers; exit({ exit: false }) tears the client down.
  await actor.init({ storage, gracefulShutdown: false });
  const urls = productUrls(server.baseUrl);
  const chooserName = options.live ? defaultChooser(env) : undefined;
  const input = parseInput({
    startUrls: urls,
    mode: "record",
    fields: DEMO_FIELDS.map((name) => ({ name })),
    description: DEMO_DESCRIPTION,
    browser: "chromium",
    allowPrivateHosts: ["127.0.0.1"],
    ...(chooserName ? { chooser: chooserName } : {}),
  });
  // time spent in the caller's phase hook (the GIF recorder) is not the demo's time
  let phaseMs = 0;
  const phase = async (name: DemoPhase, run?: DemoRun) => {
    const t0 = performance.now();
    await options.onPhase?.(name, { server, version: server.currentDemo(), lines, ...(run ? { run } : {}) });
    phaseMs += performance.now() - t0;
  };

  let seen = 0;
  const rowsSince = async (): Promise<DemoRow[]> => {
    const dataset = await actor.openDataset();
    const all = (await dataset.getData()).items as DemoRow[];
    const rows = all.slice(seen);
    seen = all.length;
    return rows;
  };

  const crawl = async (index: 1 | 2 | 3, chooser: Chooser): Promise<{ summary: RunSummary; rows: DemoRow[]; elapsedMs: number }> => {
    /**
     * The crawler's own sentences go into this run's lines, not to stderr.
     *
     * Without it the demo can print "name null on atorvastatina-20-mg" while
     * the sentence explaining *why* — a stale recording, a healing that found
     * nothing, a page that never loaded — goes somewhere `runDemo`'s caller
     * cannot read. `tests/acceptance.test.ts` asserts against `lines`, so a
     * cause outside them does not exist as far as the proof is concerned, and
     * on 2026-09-23 that cost a session of diagnosing five symptoms.
     */
    const deps: CrawlDeps = {
      actor,
      chooser,
      env,
      storageDir: mkdtempSync(join(dir, "st-")),
      attended: false,
      maxConcurrency: 2,
      log: (message) => say(`  navvi: ${message}`),
    };
    const t0 = performance.now();
    const summary = await runCrawl(input, deps);
    const elapsedMs = performance.now() - t0;
    if (summary.status !== "succeeded") failures.push(`run ${index}: status ${summary.status}${summary.message ? ` (${summary.message})` : ""}`);
    return { summary, rows: await rowsSince(), elapsedMs };
  };

  try {
    say(`navvi demo: one prompt, one site that changes, three runs (${options.live ? `live chooser: ${chooserName}` : "offline, recorded answers"})`);
    say(`server ${server.baseUrl}, 12 product pages under /demo/pharmacy/producto/*`);
    say(`$ navvi "${DEMO_PROMPT}" <12 urls>`);
    server.switchDemo("v1");
    await phase("start");

    // run 1: compile on v1
    const first = await crawl(1, options.live ? liveChooser(env) : recordedChooser());
    const q1 = first.summary.chooser?.questions ?? 0;
    const line1 = `compiled ${first.summary.templates} template, ${q1} questions, ${first.summary.items} records, ${ms(first.elapsedMs)}`;
    say(`run 1  v1  ${line1}`);
    check(first.summary.cacheHit === false, "run 1: expected no cache hit");
    check(first.summary.templates === 1, `run 1: expected 1 template, got ${first.summary.templates}`);
    check(first.summary.items === 12 && first.rows.length === 12, `run 1: expected 12 records, got ${first.summary.items}/${first.rows.length}`);
    check(first.summary.healingEvents.length === 0, "run 1: expected no healing");
    if (!options.live) check(q1 === 4, `run 1: expected 4 questions, got ${q1}`);
    runs.push({ index: 1, version: "v1", ...first, line: line1 });
    await phase("run", runs[0]);

    // the site changes under the same URLs
    server.switchDemo("v2");
    say(`       site redesign: the same URLs now serve v2 markup (hashed class names, "Precio oferta", "Sin stock")`);
    await phase("switch");

    // run 2: cache hit, drift, heal
    const second = await crawl(2, options.live ? liveChooser(env) : recordedChooser());
    const drifted = [...new Set(second.summary.healingEvents.filter(isFieldHealingEvent).flatMap((e) => e.fields))].sort();
    const q2 = second.summary.chooser?.questions ?? 0;
    const nullPrice = second.rows.filter((row) => row.price === null);
    const unmapped = [...new Set(second.summary.unmappedCandidates.map((c) => c.text))];
    const headline = EXPECTED_UNMAPPED.filter((t) => unmapped.includes(t));
    const more = unmapped.length - headline.length;
    const unmappedShown = headline.length === 0 ? unmapped.slice(0, 2) : headline;
    const line2 = `${second.summary.cacheHit ? "cache hit" : "cache miss"}, drift detected on ${drifted.join(", ") || "nothing"}, healed with ${q2} questions, ${second.summary.items} records, price null on ${nullPrice.length}, unmapped: ${unmappedShown.join(", ") || "none"}${more > 0 ? ` (+${more} more)` : ""}, ${ms(second.elapsedMs)}`;
    say(`run 2  v2  ${line2}`);
    check(second.summary.cacheHit === true, "run 2: expected a cache hit");
    check(second.summary.items === 12 && second.rows.length === 12, `run 2: expected 12 records, got ${second.summary.items}/${second.rows.length}`);
    check(second.summary.healingEvents.length >= 1, "run 2: expected at least one healing event");
    check(nullPrice.length === 2 && nullPrice.every((row) => OUT_OF_STOCK.includes(slugOf(row))), `run 2: expected price null on exactly ${OUT_OF_STOCK.join(", ")}, got ${nullPrice.map(slugOf).join(", ") || "none"}`);
    for (const text of EXPECTED_UNMAPPED) check(unmapped.includes(text), `run 2: expected unmapped candidate "${text}"`);
    /**
     * The only pages run 2 may leave unhealed are the two that have no price
     * to find. Run 3 has asserted `unhealed` since it was written and run 2
     * never did, and on 2026-09-23 that asymmetry cost a session.
     *
     * `tests/acceptance.test.ts` failed about one full-suite run in three with
     * four null fields on one page. Every string it could print was a symptom
     * — `name null on <slug>`, `price missing on <slug>` — identical whether
     * the recording was stale, the chooser genuinely picked none, or the page
     * rendered nothing. The one number that names the cause class was already
     * computed and already in the summary, and nothing looked at it.
     *
     * So this is not a tighter assertion for its own sake: it is the line that
     * turns five symptoms into "a page was left unhealed", and `ctxLog` now
     * reaches `lines` so the sentence saying which page and why arrives with
     * it.
     */
    check(
      second.summary.unhealed === OUT_OF_STOCK.length,
      `run 2: expected exactly ${OUT_OF_STOCK.length} unhealed page(s) — the ones with no price to find — got ${second.summary.unhealed}`,
    );
    for (const row of second.rows) {
      for (const name of ["name", "laboratory", "stock"]) check(row[name] !== null, `run 2: ${name} null on ${slugOf(row)}`);
      if (!OUT_OF_STOCK.includes(slugOf(row))) check(typeof row.price === "string" && /^\$ [\d.]+$/.test(row.price), `run 2: price missing on ${slugOf(row)}`);
    }
    runs.push({ index: 2, version: "v2", ...second, line: line2 });
    await phase("run", runs[1]);

    // the site rolls back
    server.switchDemo("v1");
    say(`       site rollback: v1 markup is back`);
    await phase("switch");

    // run 3: the original alternatives resolve first, nobody is asked
    const third = await crawl(3, new RecordedChooser({ fixture: "crawler/empty" }));
    const q3 = third.summary.chooser?.questions ?? 0;
    const line3 = `${third.summary.cacheHit ? "cache hit" : "cache miss"}, ${q3} questions, ${third.summary.items} records, ${ms(third.elapsedMs)}`;
    say(`run 3  v1  ${line3}`);
    check(third.summary.cacheHit === true, "run 3: expected a cache hit");
    check(q3 === 0, `run 3: expected 0 questions, got ${q3}`);
    check(third.summary.items === 12 && third.rows.length === 12, `run 3: expected 12 records, got ${third.summary.items}/${third.rows.length}`);
    check(third.summary.healingEvents.length === 0, "run 3: expected no healing");
    check(third.summary.unhealed === 0, `run 3: expected nothing unhealed, got ${third.summary.unhealed}`);
    for (const row of third.rows) check(typeof row.price === "string" && /^\$ [\d.]+$/.test(row.price), `run 3: price missing on ${slugOf(row)}`);
    runs.push({ index: 3, version: "v1", ...third, line: line3 });
    await phase("run", runs[2]);

    // the stored scraper: same four fields, one healed alternative each
    const store = await ScraperStore.open({ actor });
    const templateKey = [...groupByTemplate(urls).keys()][0]!;
    const stored = await store.get(cacheKey(templateKey, { description: DEMO_DESCRIPTION, fields: [...DEMO_FIELDS], profile: "store" }));
    check(stored !== null, "no scraper stored in the cache");
    if (stored) {
      const names = Object.keys(stored.fields);
      check(names.join(",") === DEMO_FIELDS.join(","), `stored fields changed: ${names.join(", ")}`);
      check(stored.healedAt !== undefined, "stored scraper is not marked healed");
      const alternatives = names.map((name) => `${name} ${stored.fields[name]!.alternatives.length}`);
      say(`scraper  ${names.length} fields (${names.join(", ")}), alternatives: ${alternatives.join(", ")}, healed ${stored.healedAt ?? "never"}`);
    }
    const totalMs = performance.now() - startedAt - phaseMs;
    say(failures.length === 0 ? `demo: PASS in ${ms(totalMs)}, 36 records, ${q1 + q2 + q3} questions total, run 3 free` : `demo: FAIL\n  - ${failures.join("\n  - ")}`);
    await phase("end");
    return { ok: failures.length === 0, failures, runs, stored, lines, totalMs };
  } finally {
    await actor.exit({ exit: false }).catch(() => undefined);
    if (ownServer) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  crawleeLog.setLevel(process.env.NAVVI_LOG === "debug" ? LogLevel.DEBUG : LogLevel.WARNING);
  const live = process.argv.includes("--live");
  let code = 1;
  try {
    const result = await runDemo({ live });
    code = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`demo: ${error instanceof Error ? error.message : String(error)}`);
    code = error instanceof Error && error.message.startsWith("--live") ? 2 : 1;
  }
  process.stdout.write("", () => process.exit(code));
}
