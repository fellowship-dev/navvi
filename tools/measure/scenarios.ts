import type { Actor } from "apify";
import type { Answer, Chooser, ChooserUsage, Question } from "../../src/chooser/chooser.js";
import { RecordedChooser } from "../../src/chooser/recorded.js";
import { run, type RunSummary } from "../../src/main.js";
import type { CrawlDeps } from "../../src/replay/crawler.js";
import { SCRAPER_VERSION, cacheKey, type CompiledScraper, type TraceStep } from "../../src/scraper/schema.js";
import { ScraperStore } from "../../src/scraper/store.js";
import { groupByTemplate } from "../../src/template/index.js";
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

/**
 * The viewport every measured crawl runs at.
 *
 * A recorded answer is an index into the options a question offered, and the
 * recording states the options it answered (`src/chooser/recorded.ts`), so the
 * replay only means anything if the run offers the same list. On a page with
 * controls below the fold that list is viewport-dependent: `controls()` in
 * `src/browser/snapshot.inject.js` decides `clickable` for an offscreen
 * control by scrolling it into view and hit testing its centre, and on
 * `python-jobs.html` there is a ~13 px band of viewport heights every ~102 px
 * -- one per job row -- in which exactly one job link loses that hit test and
 * is not offered at all. Measured 2026-09-23 through `getControls` itself: 54
 * of the 326 heights between 600 and 1250 drop a link, 17% of them, and the
 * band at 1112-1124 drops `jobs/109` -- the link missing from every observed
 * failure. Width makes no difference.
 *
 * Crawlee's fingerprint injection gives every browser launch a different
 * viewport (1366x768 to 3440x1440 over twenty launches), so which list the
 * chooser was offered was a per-run coin flip, and F3-category failed about
 * one run in twelve with `{ correct: 0, expected: 100 }` -- alone on an idle
 * machine, in the same 2.9 s as a passing run. It was read as worker
 * contention for weeks; it never was.
 *
 * `navigate.test.ts` pins the same 33-option list in seven recordings and has
 * never flaked, because it drives raw Playwright, whose default viewport is
 * this one. Fixing it here says out loud what that file gets by accident.
 *
 * This makes the replay reproducible. It does not make the hit test right: a
 * link a person can click is a link the chooser should be offered, whatever
 * the window size, and that is a defect in `controls()` that a real run hits
 * too -- silently, by dropping a candidate the model then cannot choose.
 */
const MEASURE_VIEWPORT = { width: 1280, height: 720 };

function deps(ctx: ScenarioContext, env: NodeJS.ProcessEnv = ctx.env): CrawlDeps {
  return {
    actor: ctx.actor,
    chooser: ctx.chooser,
    env,
    storageDir: ctx.storageDir,
    attended: false,
    maxConcurrency: 1,
    onPage: (page) => page.setViewportSize({ ...MEASURE_VIEWPORT }),
  };
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

// ---------------------------------------------------------------- complex flows (2026-09-19)

/**
 * Flows with navigation and forms, not only URL lists: a search form to its
 * results, a login to an account list, a category link, pagination, detail
 * pages. Each has an expected field map so correctness is a fraction. Their
 * recorded answers live under `tests/recorded/flows/<name>/` (one fixture per
 * scenario: navigation, text and compile batches together).
 */

const RESULT_FIELDS = ["title", "company", "link"] as const;
const FLOW_JOB_FIELDS = ["title", "company", "location", "link"] as const;
const DETAIL_LIST_FIELDS = ["title", "company"] as const;
const DETAIL_FIELDS = ["description"] as const;

const jobLink = (baseUrl: string, row: Row): boolean => new RegExp(`^${baseUrl}/fixtures/jobs/\\d+\\.html$`).test(String(row.link));

export const FLOW_SEARCH: Scenario = {
  id: "F1-search",
  title: "search form to results: type the query, submit, compile the results list",
  fields: RESULT_FIELDS,
  expectedRows: 6,
  minFieldsCorrect: 1,
  expectHealing: false,
  live: false,
  recordedFixture: () => "flows/search",
  async run(ctx) {
    const summary = await run(
      baseInput({ startUrls: [`${ctx.server.baseUrl}/fixtures/search-form.html`], goal: "search for python jobs", mode: "list", fields: F(RESULT_FIELDS), description: "job search result" }),
      deps(ctx),
    );
    return { summaries: [summary], rows: await datasetRows(ctx.actor) };
  },
  cellOk: (row, field, { baseUrl }) => (field === "link" ? jobLink(baseUrl, row) : row[field] != null),
};

export const FLOW_LOGIN: Scenario = {
  id: "F2-login",
  title: "login to an account page: secret username and password, submit, compile the orders list",
  fields: LOGIN_FIELDS,
  expectedRows: 5,
  minFieldsCorrect: 1,
  expectHealing: false,
  live: false,
  recordedFixture: () => "flows/login",
  async run(ctx) {
    const summary = await run(
      baseInput({
        startUrls: [`${ctx.server.baseUrl}/login/`],
        goal: "log in with {{secret:username}} and {{secret:password}}, then open the orders",
        mode: "list",
        fields: F(LOGIN_FIELDS),
        description: "order",
        profile: "local",
      }),
      deps(ctx, { ...ctx.env, NAVVI_SECRET_USERNAME: "max@example.com", NAVVI_SECRET_PASSWORD: MEASURE_LOGIN_PASSWORD }),
    );
    return { summaries: [summary], rows: await datasetRows(ctx.actor) };
  },
  cellOk: (row, field) => (field === "total" ? /^\$ [\d.]+$/.test(String(row.total)) : /^Order #\d+$/.test(String(row.order))),
};

export const FLOW_CATEGORY: Scenario = {
  id: "F3-category",
  title: "category page: open the Python category, compile the listing behind it",
  fields: FLOW_JOB_FIELDS,
  expectedRows: 25,
  minFieldsCorrect: 1,
  expectHealing: false,
  live: false,
  recordedFixture: () => "flows/category",
  async run(ctx) {
    const summary = await run(
      baseInput({ startUrls: [`${ctx.server.baseUrl}/fixtures/categories.html`], goal: "open the Python category", mode: "list", fields: F(FLOW_JOB_FIELDS), description: "python job listing" }),
      deps(ctx),
    );
    return { summaries: [summary], rows: await datasetRows(ctx.actor) };
  },
  cellOk: (row, field, { baseUrl }) => (field === "link" ? jobLink(baseUrl, row) : row[field] != null),
};

export const FLOW_PAGINATE: Scenario = {
  id: "F4-paginate",
  title: "pagination: compile the next link, follow three pages, stop on the empty ones",
  fields: FLOW_JOB_FIELDS,
  expectedRows: 14,
  minFieldsCorrect: 1,
  expectHealing: false,
  live: false,
  recordedFixture: () => "flows/paginate",
  async run(ctx) {
    const summary = await run(
      baseInput({ startUrls: [`${ctx.server.baseUrl}/fixtures/python-jobs-1.html`], mode: "list", fields: F(FLOW_JOB_FIELDS), description: "python job listing", paginate: true }),
      deps(ctx),
    );
    return { summaries: [summary], rows: await datasetRows(ctx.actor) };
  },
  cellOk: (row, field, { baseUrl }) => (field === "link" ? jobLink(baseUrl, row) : row[field] != null),
};

export const FLOW_DETAIL: Scenario = {
  id: "F5-detail",
  title: "detail pages: compile the per-item link, then the description on three detail pages, merge into 25 rows",
  fields: [...DETAIL_LIST_FIELDS, ...DETAIL_FIELDS],
  expectedRows: 25,
  minFieldsCorrect: 1,
  expectHealing: false,
  live: false,
  recordedFixture: () => "flows/detail",
  async run(ctx) {
    const summary = await run(
      baseInput({
        startUrls: [`${ctx.server.baseUrl}/fixtures/python-jobs.html`],
        mode: "list",
        fields: F(DETAIL_LIST_FIELDS),
        detailFields: F(DETAIL_FIELDS),
        followDetailPages: true,
        paginate: false,
        description: "python job listing",
        maxPages: 30,
      }),
      deps(ctx),
    );
    return { summaries: [summary], rows: await datasetRows(ctx.actor) };
  },
};

export const FLOWS: readonly Scenario[] = [FLOW_SEARCH, FLOW_LOGIN, FLOW_CATEGORY, FLOW_PAGINATE, FLOW_DETAIL];

/** The fixture set, in run order. */
export const SCENARIOS: readonly Scenario[] = [AE1, AE7, AE8, AE15, ...FLOWS];

interface LiveSiteSpec {
  url: string;
  fields: readonly string[];
  description: string;
  /** A navigation goal before the listing (a search, a login, a category). */
  goal?: string;
  profile?: "store" | "local";
  /** Secrets the goal names, as `NAVVI_SECRET_<NAME>` values the harness sets (test accounts only). */
  secrets?: Record<string, string>;
  expectedRows: number;
  maxPages?: number;
}

/**
 * Public sites made for scraping practice, one per flow type. scrapethissite
 * and toscrape.com are sandboxes published for exactly this; python.org and
 * Hacker News are the plain lists of the first measurement.
 */
export const LIVE_SITES: Record<string, LiveSiteSpec> = {
  "python.org": { url: "https://www.python.org/jobs/", fields: ["title", "company", "location", "link"], description: "python job listing", expectedRows: 20 },
  hackernews: { url: "https://news.ycombinator.com/", fields: ["title", "link", "points"], description: "hacker news front page", expectedRows: 20 },
  "scrapethissite-search": {
    url: "https://www.scrapethissite.com/pages/forms/",
    goal: "search for teams named Rangers",
    fields: ["team", "year", "wins"],
    description: "hockey team season",
    expectedRows: 15,
    maxPages: 1,
  },
  "quotes-login": {
    url: "https://quotes.toscrape.com/login",
    goal: "log in with the username {{secret:username}} and the password {{secret:password}}",
    profile: "local",
    secrets: { USERNAME: "navvi", PASSWORD: "navvi-measure" },
    fields: ["quote", "author"],
    description: "quote",
    expectedRows: 10,
    maxPages: 1,
  },
  "books-category": {
    url: "https://books.toscrape.com/",
    goal: "open the Travel category",
    fields: ["title", "price"],
    description: "book",
    expectedRows: 11,
    maxPages: 1,
  },
};

export type LiveSite = keyof typeof LIVE_SITES;

export function isLiveSite(name: string): name is LiveSite {
  return Object.hasOwn(LIVE_SITES, name);
}

/** One list run against a real site, with its navigation goal when the flow has one: the expected rows with every field filled. */
export function liveScenario(site: LiveSite): Scenario {
  const spec = LIVE_SITES[site]!;
  const { url, fields, description } = spec;
  return {
    id: `live:${site}`,
    title: `${url}${spec.goal ? ` then "${spec.goal}"` : ""} over the network`,
    fields,
    expectedRows: spec.expectedRows,
    minFieldsCorrect: 0.9,
    expectHealing: false,
    live: true,
    recordedFixture: null,
    async run(ctx) {
      const env = { ...ctx.env };
      for (const [name, value] of Object.entries(spec.secrets ?? {})) env[`NAVVI_SECRET_${name}`] = value;
      const input: Record<string, unknown> = { browser: "chromium", startUrls: [url], mode: "list", fields: F(fields), description, maxPages: spec.maxPages ?? 1 };
      if (spec.goal) input.goal = spec.goal;
      if (spec.profile) input.profile = spec.profile;
      const summary = await run(input, deps(ctx, env));
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
  /** `dir` is the recording root (`--record-dir`); the default is `tests/recorded`. */
  constructor(
    private readonly route: (batch: Question[]) => string,
    private readonly dir?: string,
  ) {}

  async ask(batch: Question[]): Promise<Answer[]> {
    const fixture = this.route(batch);
    let chooser = this.inner.get(fixture);
    if (!chooser) this.inner.set(fixture, (chooser = new RecordedChooser(this.dir === undefined ? { fixture } : { fixture, dir: this.dir })));
    return chooser.ask(batch);
  }

  usage(): ChooserUsage {
    const all = [...this.inner.values()].map((c) => c.usage());
    const sum = (k: "questions" | "textQuestions" | "batches" | "inputTokens" | "outputTokens" | "waitMs" | "costUsd") => all.reduce((n, u) => n + u[k], 0);
    return { chooser: "recorded", questions: sum("questions"), textQuestions: sum("textQuestions"), batches: sum("batches"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), waitMs: sum("waitMs"), costUsd: sum("costUsd"), zeroDataRetention: "not_applicable" };
  }
}
