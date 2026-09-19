import type { Actor } from "apify";
import type { Answer, Chooser, ChooserUsage, Question } from "../chooser/chooser.js";
import { RecordedChooser } from "../chooser/recorded.js";
import { run, type RunSummary } from "../main.js";
import type { CrawlDeps } from "../replay/crawler.js";
import { SCRAPER_VERSION, cacheKey, type CompiledScraper, type TraceStep } from "../scraper/schema.js";
import { ScraperStore } from "../scraper/store.js";
import { groupByTemplate } from "../template/index.js";
import type { FixtureServer } from "../../tests/server.js";

/**
 * U18: the scenarios every chooser is measured on. They are the acceptance
 * examples the offline tests already prove (AE1 list, AE7 record, AE8 field
 * healing, AE15 step healing), run through `run()` against the fixture server
 * with a temporary store, plus one live list page per `--live` site. Each
 * scenario grades its rows cell by cell: a cell is correct when it holds the
 * value the fixture promises (non-null, a matching link, or null where the
 * page has nothing), so `fieldsCorrect` is correct cells over expected cells.
 */

export type Row = Record<string, unknown>;

export interface ScenarioContext {
  server: FixtureServer;
  chooser: Chooser;
  actor: Actor;
  storageDir: string;
  env: NodeJS.ProcessEnv;
}

export interface ScenarioOutcome {
  summaries: RunSummary[];
  /** The rows the scenario grades (the last run's, for a multi-run scenario). */
  rows: Row[];
}

export interface Scenario {
  id: string;
  title: string;
  fields: readonly string[];
  /** Rows the page promises; a live page promises at least this many. */
  expectedRows: number;
  /** Below this fraction of correct cells the scenario fails. */
  minFieldsCorrect: number;
  /** The scenario is a healing proof: at least one healing event is required. */
  expectHealing: boolean;
  /** Needs the network; skipped offline. */
  live: boolean;
  /** Which recorded fixture answers a batch when the agent column replays (KTD12). */
  recordedFixture: ((batch: Question[]) => string) | null;
  run(ctx: ScenarioContext): Promise<ScenarioOutcome>;
  /** True when the cell holds what the page promises; defaults to non-null. */
  cellOk?: (row: Row, field: string, ctx: { baseUrl: string }) => boolean;
}

export interface Grade {
  cells: { correct: number; expected: number };
  fieldsCorrect: number;
  healingEvents: number;
  pass: boolean;
  /** Why `pass` is false. */
  reason?: string;
}

const PRODUCTS = [
  "amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema", "diclofenaco-gel", "ibuprofeno-400-mg", "loratadina-10-mg",
  "losartan-50-mg", "metformina-850-mg", "omeprazol-20-mg", "paracetamol-500-mg", "salbutamol-inhalador", "vitamina-c-1-g",
];
const OUT_OF_STOCK = ["ibuprofeno-400-mg", "losartan-50-mg"];
const PHARMACY_FIELDS = ["name", "laboratory", "price", "stock"] as const;
const JOB_FIELDS = ["title", "company", "location", "date", "link"] as const;
const F = (names: readonly string[]) => names.map((name) => ({ name }));

/** The password the seeded login trace types; the fixture accepts any non-empty one. */
export const MEASURE_LOGIN_PASSWORD = "measure-secret";

const isHealBatch = (batch: Question[]): boolean => batch.some((q) => q.id.startsWith("heal."));

function deps(ctx: ScenarioContext, env: NodeJS.ProcessEnv = ctx.env): CrawlDeps {
  return { actor: ctx.actor, chooser: ctx.chooser, env, storageDir: ctx.storageDir, attended: false, maxConcurrency: 1 };
}

function baseInput(over: Record<string, unknown>): Record<string, unknown> {
  return { browser: "chromium", allowPrivateHosts: ["127.0.0.1"], ...over };
}

async function datasetRows(actor: Actor): Promise<Row[]> {
  const dataset = await actor.openDataset();
  return (await dataset.getData()).items as Row[];
}

function seeded(over: Partial<CompiledScraper> & { templateKey: string; cacheKey: string }): CompiledScraper {
  return {
    version: SCRAPER_VERSION,
    profile: "store",
    chooser: "agent",
    mode: "record",
    entry: { mode: "direct", url: "" },
    trace: [],
    pagination: { mode: "none" },
    detail: null,
    createdAt: new Date().toISOString(),
    fields: {},
    ...over,
  };
}

function keyFor(urls: string[], input: { goal?: string; description?: string; fields: string[]; profile: "store" | "local" }): { templateKey: string; cacheKey: string } {
  const templateKey = [...groupByTemplate(urls).keys()][0]!;
  return { templateKey, cacheKey: cacheKey(templateKey, input) };
}

const slugOf = (row: Row): string => String(row._source ?? "").split("/").pop()!.replace(".html", "");

export const AE1: Scenario = {
  id: "AE1",
  title: "python-jobs list page: compile five fields, extract 25 rows",
  fields: JOB_FIELDS,
  expectedRows: 25,
  minFieldsCorrect: 1,
  expectHealing: false,
  live: false,
  recordedFixture: () => "compile/python-jobs",
  async run(ctx) {
    const summary = await run(baseInput({ startUrls: [`${ctx.server.baseUrl}/fixtures/python-jobs.html`], mode: "list", fields: F(JOB_FIELDS), description: "python job listing" }), deps(ctx));
    return { summaries: [summary], rows: await datasetRows(ctx.actor) };
  },
  cellOk: (row, field, { baseUrl }) => (field === "link" ? new RegExp(`^${baseUrl}/fixtures/jobs/\\d+\\.html$`).test(String(row.link)) : row[field] != null),
};

export const AE7: Scenario = {
  id: "AE7",
  title: "pharmacy v1 record pages: compile four fields on three samples, record 12 products",
  fields: PHARMACY_FIELDS,
  expectedRows: 12,
  minFieldsCorrect: 1,
  expectHealing: false,
  live: false,
  recordedFixture: () => "compile/pharmacy-v1",
  async run(ctx) {
    const startUrls = PRODUCTS.map((s) => `${ctx.server.baseUrl}/demo/pharmacy-v1/producto/${s}.html`);
    const summary = await run(baseInput({ startUrls, mode: "record", fields: F(PHARMACY_FIELDS), description: "pharmacy product" }), deps(ctx));
    return { summaries: [summary], rows: await datasetRows(ctx.actor) };
  },
  cellOk: (row, field) => (field === "price" ? /^\$ [\d.]+$/.test(String(row.price)) : row[field] != null),
};

export const AE8: Scenario = {
  id: "AE8",
  title: "pharmacy v1 then v2 under the same URLs: the cached scraper heals every field",
  fields: PHARMACY_FIELDS,
  expectedRows: 12,
  minFieldsCorrect: 0.9,
  expectHealing: true,
  live: false,
  // the out-of-stock pages offer no price candidate: the recorded answer there is none
  recordedFixture: (batch) => (isHealBatch(batch) ? (batch.every((q) => q.id === "heal.price") ? "heal/pharmacy-nostock" : "heal/pharmacy") : "compile/pharmacy-v1"),
  async run(ctx) {
    const startUrls = PRODUCTS.map((s) => `${ctx.server.baseUrl}/demo/pharmacy/producto/${s}.html`);
    const raw = baseInput({ startUrls, mode: "record", fields: F(PHARMACY_FIELDS), description: "pharmacy product" });
    ctx.server.switchDemo("v1");
    const first = await run(raw, deps(ctx));
    ctx.server.switchDemo("v2");
    try {
      const second = await run(raw, deps(ctx));
      const rows = (await datasetRows(ctx.actor)).slice(first.items);
      return { summaries: [first, second], rows };
    } finally {
      ctx.server.switchDemo("v1");
    }
  },
  cellOk: (row, field) => {
    if (field !== "price") return row[field] != null;
    return OUT_OF_STOCK.includes(slugOf(row)) ? row.price === null : /^\$ [\d.]+$/.test(String(row.price));
  },
};

const LOGIN_FIELDS = ["order", "total"] as const;
const loginTrace: TraceStep[] = [
  { op: "type", text: "max@example.com", alternatives: [{ role: "textbox", name: "Email", exact: true }] },
  { op: "type", secret: "password", alternatives: [{ role: "textbox", name: "Password", exact: true }] },
  { op: "click", alternatives: [{ role: "button", name: "Log in", exact: true }], target: { form: { method: "post", action: "/login" } }, expect: { role: "heading", name: "Orders" } },
];

export const AE15: Scenario = {
  id: "AE15",
  title: "login trace with a renamed button: the step is re-decided, the orders list still extracts",
  fields: LOGIN_FIELDS,
  expectedRows: 5,
  minFieldsCorrect: 1,
  expectHealing: true,
  live: false,
  recordedFixture: () => "heal/login",
  async run(ctx) {
    const startUrls = [`${ctx.server.baseUrl}/login/`];
    const key = keyFor(startUrls, { fields: [...LOGIN_FIELDS], profile: "local" });
    const store = await ScraperStore.open({ actor: ctx.actor });
    await store.put(
      seeded({
        ...key,
        profile: "local",
        mode: "list",
        entry: { mode: "trace", url: startUrls[0]! },
        trace: loginTrace,
        item: { anchorSelector: "ul.orders > li.order", span: 1 },
        fields: {
          order: { alternatives: [{ selector: "a", fingerprint: { samples: ["Order #1001"], shape: "text" } }] },
          total: { alternatives: [{ selector: "span.total", fingerprint: { samples: ["$ 45.990"], shape: "money" } }] },
        },
      }),
    );
    ctx.server.switchLogin("renamed");
    try {
      const summary = await run(
        baseInput({ startUrls, mode: "list", fields: F(LOGIN_FIELDS), profile: "local" }),
        deps(ctx, { ...ctx.env, NAVVI_SECRET_PASSWORD: MEASURE_LOGIN_PASSWORD }),
      );
      return { summaries: [summary], rows: await datasetRows(ctx.actor) };
    } finally {
      ctx.server.switchLogin("normal");
    }
  },
};

/** The fixture set, in run order. */
export const SCENARIOS: readonly Scenario[] = [AE1, AE7, AE8, AE15];

export const LIVE_SITES = {
  "python.org": { url: "https://www.python.org/jobs/", fields: ["title", "company", "location", "link"], description: "python job listing" },
  hackernews: { url: "https://news.ycombinator.com/", fields: ["title", "link", "points"], description: "hacker news front page" },
} as const;

export type LiveSite = keyof typeof LIVE_SITES;

export function isLiveSite(name: string): name is LiveSite {
  return Object.hasOwn(LIVE_SITES, name);
}

/** One AE1-like list run against a real site: at least 20 rows with every field filled. */
export function liveScenario(site: LiveSite): Scenario {
  const { url, fields, description } = LIVE_SITES[site];
  return {
    id: `live:${site}`,
    title: `${url} list page over the network`,
    fields,
    expectedRows: 20,
    minFieldsCorrect: 0.9,
    expectHealing: false,
    live: true,
    recordedFixture: null,
    async run(ctx) {
      const summary = await run({ browser: "chromium", startUrls: [url], mode: "list", fields: F(fields), description, maxPages: 1 }, deps(ctx));
      return { summaries: [summary], rows: await datasetRows(ctx.actor) };
    },
  };
}

/** Grades a scenario's rows (R44 fields correct) and its run statuses. */
export function grade(scenario: Scenario, outcome: ScenarioOutcome, baseUrl: string): Grade {
  const cellOk = scenario.cellOk ?? ((row, field) => row[field] != null);
  const expected = Math.max(outcome.rows.length, scenario.expectedRows) * scenario.fields.length;
  let correct = 0;
  for (const row of outcome.rows) for (const field of scenario.fields) if (cellOk(row, field, { baseUrl })) correct += 1;
  const fieldsCorrect = expected === 0 ? 0 : correct / expected;
  const healingEvents = outcome.summaries.reduce((n, s) => n + s.healingEvents.length, 0);
  const failed = outcome.summaries.find((s) => s.status !== "succeeded");
  let reason: string | undefined;
  if (failed) reason = `run ended ${failed.status}${failed.message ? `: ${failed.message}` : ""}`;
  else if (outcome.rows.length < scenario.expectedRows) reason = `${outcome.rows.length} rows, expected ${scenario.expectedRows}`;
  else if (fieldsCorrect < scenario.minFieldsCorrect) reason = `${correct}/${expected} cells correct, below ${scenario.minFieldsCorrect}`;
  else if (scenario.expectHealing && healingEvents === 0) reason = "no healing event";
  const result: Grade = { cells: { correct, expected }, fieldsCorrect, healingEvents, pass: reason === undefined };
  if (reason !== undefined) result.reason = reason;
  return result;
}

/**
 * The agent column offline: replays the recorded answers the scenario names
 * per batch (a scenario can span two fixtures), summing usage across them.
 */
export class RoutedRecordedChooser implements Chooser {
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
