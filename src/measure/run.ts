import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Actor } from "apify";
import { MemoryStorage } from "crawlee";
import { CHOOSERS, isChooserId, type Chooser as ChooserId } from "../input/schema.js";
import { createChooser, estimateTokens, findOnPath, RecordingChooser, type Answer, type Chooser, type ChooserUsage, type Question } from "../chooser/index.js";
import { BankingChooser } from "./bank.js";
import { renderTable, replaceSection, type MeasurementRow } from "./report.js";
import { grade, isLiveSite, liveScenario, LIVE_SITES, RoutedRecordedChooser, SCENARIOS, type LiveSite, type Scenario } from "./scenarios.js";
import { startFixtureServer } from "../../tests/server.js";

/**
 * U18 / KTD22: `npm run measure -- --choosers agent,jev,model [--live <site>]`
 * runs the fixture set (and one live site) per chooser and rewrites the table
 * between the markers of docs/measurements.md. One row per chooser and
 * scenario (R37, R44): questions, input tokens, chooser wall time, total wall
 * time, cost at list price, fields correct, healing events, status.
 *
 * Honesty: without `--agent-live` the `agent` column replays the recorded
 * answers (the scripted host agent's), so its wait is the replay's own and
 * its input tokens are an estimate of what the host agent was shown. `jev`
 * and `model` run only with their keys; a live run also refreshes the
 * recordings under tests/recorded/measure/<scenario>/<chooser>.
 */

export const DEFAULT_OUT = join("docs", "measurements.md");
export const MEASURE_RECORD_DIR = join("tests", "recorded");
const MEASURE_FIXTURE_PREFIX = "measure";
const NETWORK_PROBE_TIMEOUT_MS = 10_000;

export interface MeasureOptions {
  choosers: ChooserId[];
  /** Live sites to add, in order (`--live a,b` or repeated). */
  live?: LiveSite[];
  offline: boolean;
  /** Measure a real host agent over stdio instead of the recorded replay (attended). */
  agentLive: boolean;
  env: NodeJS.ProcessEnv;
  /** When set, the table is written there between the markers. */
  out?: string;
  log?: (line: string) => void;
  /** Root of the recorded answers; live runs record under `<root>/measure/`. */
  recordDir?: string;
  /**
   * Write every question batch the `agent` replay answers, with its answer as
   * gold, into the question bank (docs/jev-hillclimb.md). `--bank-chooser`
   * names another chooser whose answers seed the bank for review instead.
   */
  bank?: boolean;
  bankChooser?: ChooserId;
  /** Only these scenario ids (default: all). */
  scenarios?: string[];
}

const USAGE = `usage: npm run measure -- [--choosers agent,jev,model] [--scenarios AE1,F1-search] [--live <site>] [--offline] [--agent-live] [--bank] [--out docs/measurements.md]`;

/** Parses the CLI flags; unknown choosers and sites fail with the accepted names. */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): MeasureOptions {
  const options: MeasureOptions = { choosers: ["agent"], offline: false, agentLive: false, env };
  const args = [...argv];
  const value = (flag: string): string => {
    const next = args.shift();
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
    return next;
  };
  while (args.length > 0) {
    const arg = args.shift()!;
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (eq > 0) args.unshift(arg.slice(eq + 1));
    switch (flag) {
      case "--choosers": {
        const names = value(flag).split(",").map((n) => n.trim()).filter(Boolean);
        for (const name of names) {
          if (!isChooserId(name)) throw new Error(`unknown chooser "${name}"; choose from ${CHOOSERS.join(", ")}`);
        }
        options.choosers = [...new Set(names.filter(isChooserId))];
        break;
      }
      case "--live": {
        for (const site of value(flag).split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!isLiveSite(site)) throw new Error(`unknown live site "${site}"; choose from ${Object.keys(LIVE_SITES).join(", ")}`);
          options.live = [...new Set([...(options.live ?? []), site])];
        }
        break;
      }
      case "--offline":
        options.offline = true;
        break;
      case "--agent-live":
        options.agentLive = true;
        break;
      case "--bank":
        options.bank = true;
        break;
      case "--bank-chooser": {
        const name = value(flag);
        if (!isChooserId(name)) throw new Error(`unknown chooser "${name}"; choose from ${CHOOSERS.join(", ")}`);
        options.bank = true;
        options.bankChooser = name;
        break;
      }
      case "--scenarios":
        options.scenarios = value(flag).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--out":
        options.out = value(flag);
        break;
      case "--help":
      case "-h":
        throw new Error(USAGE);
      default:
        throw new Error(`unknown flag "${arg}"\n${USAGE}`);
    }
  }
  return options;
}

/** Counts what the chooser was shown, so a replay (which reports no tokens) still has an input-token estimate. */
class MeteredChooser implements Chooser {
  readonly name;
  estimatedInputTokens = 0;
  constructor(private readonly inner: Chooser) {
    this.name = inner.name;
  }
  async ask(batch: Question[]): Promise<Answer[]> {
    for (const q of batch) this.estimatedInputTokens += estimateTokens(q.premise + q.state + (q.options ?? []).join(""));
    return this.inner.ask(batch);
  }
  usage(): ChooserUsage {
    return this.inner.usage();
  }
}

type ChooserBuild = { chooser: MeteredChooser } | { skipped: string };

function fixtureFor(scenario: Scenario, chooser: ChooserId): string {
  return `${MEASURE_FIXTURE_PREFIX}/${scenario.id.replace(/[^A-Za-z0-9._-]+/g, "-")}/${chooser}`;
}

function buildChooser(name: ChooserId, scenario: Scenario, options: MeasureOptions): ChooserBuild {
  const { env } = options;
  const dir = options.recordDir ?? MEASURE_RECORD_DIR;
  const bank = (inner: Chooser): Chooser => (options.bank && name === (options.bankChooser ?? "agent") ? new BankingChooser(inner, scenario.id) : inner);
  const record = (inner: Chooser): MeteredChooser => new MeteredChooser(bank(new RecordingChooser(inner, { fixture: fixtureFor(scenario, name), dir, env })));
  switch (name) {
    case "agent":
      if (options.agentLive) return { chooser: record(createChooser({ chooser: "agent", env })) };
      if (!scenario.recordedFixture) return { skipped: "agent column is a recorded replay; pass --agent-live to measure a host agent on a live site" };
      return { chooser: new MeteredChooser(bank(new RoutedRecordedChooser(scenario.recordedFixture))) };
    case "jev":
      if (!env.AI_GATEWAY_API_KEY && !env.TYPESAFE_API_KEY) return { skipped: "no key (set AI_GATEWAY_API_KEY or TYPESAFE_API_KEY)" };
      return { chooser: record(createChooser({ chooser: "jev", env })) };
    case "model":
      if (!env.ANTHROPIC_API_KEY) return { skipped: "no key (set ANTHROPIC_API_KEY)" };
      return { chooser: record(createChooser({ chooser: "model", env })) };
    case "claude":
    case "codex":
      if (!findOnPath(name, env)) return { skipped: `\`${name}\` is not installed` };
      return { chooser: record(createChooser({ chooser: name, env })) };
  }
}

type RowOutcome = { status: "ok" | "failed"; cells: MeasurementRow["cells"]; healingEvents: number } | { status: "skipped"; skipped: string };

/** One table row: what the chooser cost (from its usage and the meter) plus how the scenario went. */
function rowFor(chooser: ChooserId, scenario: Scenario, metered: MeteredChooser | null, totalMs: number, outcome: RowOutcome): MeasurementRow {
  const usage = metered?.usage();
  const row: MeasurementRow = {
    chooser,
    scenario: scenario.id,
    questions: usage?.questions ?? 0,
    inputTokens: usage ? (usage.inputTokens > 0 ? usage.inputTokens : metered!.estimatedInputTokens) : 0,
    chooserWaitMs: Math.round(usage?.waitMs ?? 0),
    totalMs: Math.round(totalMs),
    costUsd: usage?.costUsd ?? 0,
    cells: outcome.status === "skipped" ? { correct: 0, expected: 0 } : outcome.cells,
    healingEvents: outcome.status === "skipped" ? 0 : outcome.healingEvents,
    status: outcome.status,
  };
  if (outcome.status === "skipped") row.skipped = outcome.skipped;
  return row;
}

function skippedRow(chooser: ChooserId, scenario: Scenario, reason: string): MeasurementRow {
  return rowFor(chooser, scenario, null, 0, { status: "skipped", skipped: reason });
}

async function probeNetwork(site: LiveSite): Promise<string | null> {
  const url = LIVE_SITES[site]!.url;
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(NETWORK_PROBE_TIMEOUT_MS), redirect: "follow" });
    return res.ok || res.status < 500 ? null : `no network: ${url} answered ${res.status}`;
  } catch (error) {
    return `no network: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Runs every scenario for every chooser, sequentially, each with a fresh temporary store. */
export async function runMeasurements(options: MeasureOptions): Promise<MeasurementRow[]> {
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const rows: MeasurementRow[] = [];
  const scenarios: Scenario[] = SCENARIOS.filter((s) => !options.scenarios || options.scenarios.includes(s.id));
  const liveSkips = new Map<string, string | null>();
  for (const site of options.live ?? []) {
    const scenario = liveScenario(site);
    scenarios.push(scenario);
    liveSkips.set(scenario.id, options.offline ? "offline run (--offline)" : await probeNetwork(site));
  }

  const tmp = mkdtempSync(join(tmpdir(), "navvi-measure-"));
  const server = await startFixtureServer();
  try {
    for (const chooserName of options.choosers) {
      for (const scenario of scenarios) {
        const liveSkip = liveSkips.get(scenario.id);
        if (scenario.live && liveSkip) {
          rows.push(skippedRow(chooserName, scenario, liveSkip));
          log(`${chooserName}/${scenario.id}: skipped: ${liveSkip}`);
          continue;
        }
        const built = buildChooser(chooserName, scenario, options);
        if ("skipped" in built) {
          rows.push(skippedRow(chooserName, scenario, built.skipped));
          log(`${chooserName}/${scenario.id}: skipped: ${built.skipped}`);
          continue;
        }
        const actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(tmp, "storage-")), persistStorage: false }) });
        const storageDir = mkdtempSync(join(tmp, "profiles-"));
        const started = performance.now();
        let row: MeasurementRow;
        try {
          const outcome = await scenario.run({ server, chooser: built.chooser, actor, storageDir, env: options.env });
          const totalMs = performance.now() - started;
          const result = grade(scenario, outcome, server.baseUrl);
          row = rowFor(chooserName, scenario, built.chooser, totalMs, { status: result.pass ? "ok" : "failed", cells: result.cells, healingEvents: result.healingEvents });
          log(`${chooserName}/${scenario.id}: ${row.status}${result.reason ? ` (${result.reason})` : ""}: ${row.questions} questions, ${row.inputTokens} tokens, chooser ${row.chooserWaitMs} ms, total ${row.totalMs} ms, $${row.costUsd.toFixed(6)}, ${result.cells.correct}/${result.cells.expected} cells, ${row.healingEvents} healing`);
        } catch (error) {
          const totalMs = performance.now() - started;
          row = rowFor(chooserName, scenario, built.chooser, totalMs, { status: "failed", cells: { correct: 0, expected: scenario.expectedRows * scenario.fields.length }, healingEvents: 0 });
          log(`${chooserName}/${scenario.id}: failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        rows.push(row);
      }
    }
  } finally {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  if (options.out) writeMeasurements(options.out, rows);
  return rows;
}

/** Rewrites the table between the markers of `file`, keeping the prose around it; creates the file when missing. */
export function writeMeasurements(file: string, rows: readonly MeasurementRow[]): void {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, replaceSection(current, renderTable(rows)));
}

async function main(): Promise<void> {
  let options: MeasureOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  options.out ??= DEFAULT_OUT;
  const rows = await runMeasurements(options);
  process.stdout.write(`${renderTable(rows)}\n`);
  process.stderr.write(`wrote ${rows.length} rows to ${options.out}\n`);
  process.exit(rows.some((r) => r.status === "failed") ? 1 : 0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
