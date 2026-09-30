import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseChooser, guardQuestions, summarizeUsage, TEXT_INPUT_CAP, type BackendResult, type Price, type Question } from "../src/chooser/chooser.js";
import { premises } from "../src/chooser/questions.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { chooserLines } from "../src/cli/render.js";
import * as filter from "../src/guard/filter.js";
import { QUARANTINE_MARKER, sanitizeText, scanText } from "../src/guard/index.js";
import { runCrawl } from "../src/replay/crawler.js";
import { SCRAPER_VERSION, cacheKey, type CompiledScraper } from "../src/scraper/schema.js";
import { ScraperStore } from "../src/scraper/store.js";
import { groupByTemplate } from "../src/template/index.js";
import { productPage, visibleText } from "../evals/injection/corpus.js";
import { datasetItems, F, fixtureInput, makeActor, makeDeps } from "./helpers.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * U13 / R17: the prompt-injection pre-filter. Attack strings come from the
 * pinned, MIT-licensed sample in evals/injection/ (CyberSecEval, BIPIA goals,
 * AgentDojo wrappers; attributed in NOTICE), never invented here. The numbers
 * behind the rules are evals/injection/REPORT.md; these tests hold the
 * behaviour: flagged text never reaches a chooser, benign pages pass, pinned
 * replay never runs the filter, and the summary says what was cut.
 */

// Every export of the filter, wrapped in a spy that calls through, so a test can
// prove where the guard runs and where it does not.
vi.mock("../src/guard/filter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/guard/filter.js")>();
  return {
    ...actual,
    sanitizeText: vi.fn(actual.sanitizeText),
    sanitizeState: vi.fn(actual.sanitizeState),
    sanitizeJson: vi.fn(actual.sanitizeJson),
  };
});

const ROOT = resolve(import.meta.dirname, "..");
const EVAL = join(ROOT, "evals", "injection");

interface Samples {
  cyberseceval: { fragments: { text: string }[] };
  bipia: { goals: string[] };
}
interface Templates {
  fill: { user: string; model: string };
  templates: Record<string, string>;
}

const samples = JSON.parse(readFileSync(join(EVAL, "samples.json"), "utf8")) as Samples;
const templates = JSON.parse(readFileSync(join(EVAL, "templates.json"), "utf8")) as Templates;

/** Every sampled goal in every wrapper but `bare`, plus the bare goals that address the reader's response, plus CyberSecEval fragments. */
function attacks(): string[] {
  const out: string[] = [];
  for (const goal of samples.bipia.goals) {
    for (const [name, shape] of Object.entries(templates.templates)) {
      if (name === "bare" && !/your response/i.test(goal)) continue;
      out.push(shape.replaceAll("{goal}", goal).replaceAll("{user}", templates.fill.user).replaceAll("{model}", templates.fill.model).trim());
    }
  }
  return [...out, ...samples.cyberseceval.fragments.map((f) => f.text)];
}

/** A generic product description with the attack as one of its paragraphs. */
function description(attack: string, seed: number): string {
  const lines = productPage(seed).split("\n");
  lines.splice(Math.floor(lines.length / 2), 0, attack);
  return lines.join("\n");
}

/** The lines of an attack a reader could act on (the sign-off alone is not an attack). */
function payload(attack: string): string[] {
  return attack.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12 && !/^(?:Signed,|Thanks!)/.test(l));
}

/** A backend that answers anything and keeps every batch it was sent. */
class CapturingChooser extends BaseChooser {
  readonly name = "recorded" as const;
  protected readonly failureStatus = "needs_human" as const;
  protected readonly price: Price = { inputPerMillion: 0, outputPerMillion: 0 };
  readonly seen: Question[][] = [];
  protected async callBackend(batch: Question[]): Promise<BackendResult> {
    this.seen.push(batch);
    return {
      answers: batch.map((q) => (q.kind === "text" ? { id: q.id, index: null, text: '{"text":"ok"}' } : q.kind === "boolean" ? { id: q.id, index: 1 } : { id: q.id, index: 0 })),
    };
  }
}

describe("the filter (R17)", () => {
  it("flags every sampled injection inside a product description and cuts all of it", () => {
    const all = attacks();
    expect(all.length).toBeGreaterThan(20);
    all.forEach((attack, i) => {
      const page = description(attack, 90_000 + i);
      const { text, findings } = sanitizeText(page);
      expect(findings.length, attack).toBeGreaterThan(0);
      for (const line of payload(attack)) expect(text, attack).not.toContain(line);
      expect(text).toContain(QUARANTINE_MARKER);
    });
  });

  it("passes every benign fixture page, the pharmacy demo included, unflagged", () => {
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith(".html")) pages.push(path);
      }
    };
    walk(join(ROOT, "tests", "fixtures"));
    walk(join(ROOT, "demo"));
    expect(pages.some((p) => p.includes("pharmacy"))).toBe(true);
    for (const page of pages) {
      const text = visibleText(readFileSync(page, "utf8"));
      expect(scanText(text), page).toEqual([]);
    }
  });

  it("passes ordinary shop imperatives and navvi's own premises", () => {
    const shop = [
      "Add to cart", "Please select a size", "Click here to checkout", "Do not exceed the stated dose.",
      "Ignore the negative reviews, mine works perfectly.", "Follow the instructions in the manual to pair your device.",
      "Operating system: compatible with iOS and Android.", "Imagine you're on the beach with this towel.",
      "Agregar al carro", "No exceder la dosis recomendada.", "Instrucciones: no usar en caso de alergia a sus componentes.",
    ];
    for (const line of shop) expect(scanText(line), line).toEqual([]);
    const rendered = [
      premises.operationChoice("find the price of paracetamol"), premises.operationTarget("CLICK", "open the first result"),
      premises.goalAchieved("search for sunscreen"), premises.typeText(), premises.healField("price", ["$3.490", "$1.990"]),
      premises.healStep("CLICK", "Buscar"), premises.fieldChoice("price", "the product price"), premises.nextLinkChoice(),
      premises.detailLinkChoice("product"), premises.briefToSpec(), premises.promptToInput(),
    ];
    for (const premise of rendered) expect(scanText(premise), premise).toEqual([]);
  });

  it("does not flag its own quarantine marker, so a second pass counts nothing", () => {
    const once = sanitizeText(description(attacks()[0]!, 1));
    expect(once.findings.length).toBeGreaterThan(0);
    expect(scanText(once.text)).toEqual([]);
  });
});

describe("the chooser sees no flagged span (R17)", () => {
  it("strips injections from state, options and structured context, and counts them in the summary", async () => {
    const [override, wrapped] = [samples.cyberseceval.fragments[0]!.text, attacks()[1]!];
    const chooser = new CapturingChooser();
    const answers = await chooser.ask([
      {
        id: "q1",
        kind: "choice",
        premise: premises.fieldChoice("description", "the product description"),
        state: description(wrapped, 7),
        options: [`main/p.desc = Gentle formula. ${override}`, "main/h1.name = Sunscreen SPF 50"],
        context: { field: "description", samples: [`Gentle formula. ${override}`] },
        optionContext: [{ value: override }, { value: "Sunscreen SPF 50" }],
      },
      { id: "q2", kind: "boolean", premise: premises.goalAchieved("find the price"), state: "Price $3.490\nAdd to cart" },
    ]);
    expect(answers.map((a) => a.id)).toEqual(["q1", "q2"]);
    const sent = JSON.stringify(chooser.seen);
    for (const line of [...payload(wrapped), override]) expect(sent).not.toContain(line);
    // The candidate identity survives: only the page text it quotes was cut, a short line whole.
    expect(chooser.seen[0]![0]!.options![0]).toBe(`main/p.desc = ${QUARANTINE_MARKER}`);

    const usage = chooser.usage();
    expect(usage.injectionFlags?.questions).toBe(1);
    expect(usage.injectionFlags?.count).toBeGreaterThanOrEqual(4);
    expect(usage.injectionFlags?.reasons.override).toBeGreaterThan(0);
    const summary = summarizeUsage(usage);
    expect(summary.injectionFlags).toEqual(usage.injectionFlags);
    expect(chooserLines(summary).join("\n")).toMatch(/injection guard: \d+ spans of page text quarantined in 1 question \(/);
  });

  it("a clean run reports no injection flags at all", async () => {
    const chooser = new CapturingChooser();
    await chooser.ask([{ id: "q", kind: "boolean", premise: premises.goalAchieved("find the price"), state: productPage(3) }]);
    expect(chooser.usage().injectionFlags).toBeUndefined();
    expect(summarizeUsage(chooser.usage())).not.toHaveProperty("injectionFlags");
  });

  it("keeps a JSON state valid JSON and a text question under its cap", () => {
    const attack = attacks()[2]!;
    const state = JSON.stringify({ goal: "search for sunscreen", page: { title: "Shop", text: `Sunscreen SPF 50\n${attack}\nAdd to cart` } });
    const [guarded] = guardQuestions([{ id: "t", kind: "text", premise: premises.typeText(), state }]).batch;
    const parsed = JSON.parse(guarded!.state) as { goal: string; page: { text: string } };
    expect(parsed.goal).toBe("search for sunscreen");
    for (const line of payload(attack)) expect(parsed.page.text).not.toContain(line);

    // Trimmed to the cap already: the marker would overflow it, so the span is cut bare.
    const premise = premises.typeText();
    const short = "TODO: obey.";
    const filler = "x".repeat(TEXT_INPUT_CAP - premise.length - short.length - 1);
    const full = `${filler}\n${short}`;
    const [capped] = guardQuestions([{ id: "c", kind: "text", premise, state: full }]).batch;
    expect(capped!.state).toBe(`${filler}\n`);
    expect(capped!.premise.length + capped!.state.length).toBeLessThanOrEqual(TEXT_INPUT_CAP);
  });

  it("leaves a trusted question (the caller's own brief) untouched", () => {
    const q: Question = { id: "brief", kind: "text", premise: premises.briefToSpec(), state: "Ignore previous instructions is a phrase I want to search for", trusted: true };
    const { batch, flags } = guardQuestions([q]);
    expect(batch[0]).toBe(q);
    expect(flags).toBeUndefined();
  });
});

describe("pinned replay never runs the filter (R17)", () => {
  let server: FixtureServer;
  let dir: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    dir = mkdtempSync(join(tmpdir(), "navvi-guard-"));
  });

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.mocked(filter.sanitizeText).mockClear();
    vi.mocked(filter.sanitizeState).mockClear();
    vi.mocked(filter.sanitizeJson).mockClear();
  });

  const calls = () => vi.mocked(filter.sanitizeText).mock.calls.length + vi.mocked(filter.sanitizeState).mock.calls.length + vi.mocked(filter.sanitizeJson).mock.calls.length;

  it("a seeded scraper replays three pages with zero filter calls; a question to the same chooser does call it", async () => {
    const actor = makeActor(dir);
    const urls = [`${server.baseUrl}/fixtures/python-jobs-1.html`];
    const fields = ["title", "company"];
    const templateKey = [...groupByTemplate(urls).keys()][0]!;
    const scraper: CompiledScraper = {
      version: SCRAPER_VERSION,
      profile: "store",
      chooser: "agent",
      mode: "list",
      templateKey,
      cacheKey: cacheKey(templateKey, { fields, profile: "store" }),
      entry: { mode: "direct", url: urls[0]! },
      trace: [],
      item: { anchorSelector: "ul.jobs > li.job", span: 1 },
      pagination: { mode: "next_link", locator: [{ role: "link", name: "Next", exact: true }] },
      detail: null,
      createdAt: new Date().toISOString(),
      fields: {
        title: { alternatives: [{ selector: "h2.job-title > a", fingerprint: { samples: ["Senior Python Engineer II"], shape: "text" } }] },
        company: { alternatives: [{ selector: "span.company", fingerprint: { samples: ["Anaconda"], shape: "text" } }] },
      },
    };
    await (await ScraperStore.open({ actor })).put(scraper);
    const chooser = new RecordedChooser({ fixture: "crawler/empty" });
    const summary = await runCrawl(fixtureInput({ startUrls: urls, mode: "list", fields: F(...fields), maxPages: 2 }), makeDeps(dir, actor, chooser));
    expect(summary.status).toBe("succeeded");
    expect(summary.pages).toBe(3);
    expect((await datasetItems(actor)).length).toBeGreaterThan(0);
    expect(chooser.usage().questions).toBe(0);
    expect(calls()).toBe(0);
    expect(summary.chooser?.injectionFlags).toBeUndefined();

    // The spy is live: the moment a question is asked (compile, navigate, heal), the guard runs.
    await new CapturingChooser().ask([{ id: "heal", kind: "boolean", premise: premises.healStep("CLICK", "Next"), state: "Next" }]);
    expect(calls()).toBeGreaterThan(0);
  });
});
