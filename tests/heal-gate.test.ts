import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actor } from "apify";
import { MemoryStorage } from "crawlee";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { parseInput, type RunInput } from "../src/input/schema.js";
import { recordCanary, type CanaryFingerprint } from "../src/investigate/blocked.js";
import { runCrawl, type CrawlDeps } from "../src/replay/crawler.js";
import type { Determinism } from "../src/replay/determinism.js";
import {
  MIN_PROMOTION_OBSERVATIONS,
  isPromotionEvent,
  judgePromotions,
  licenseToHeal,
  observeResolutions,
  promoteFieldAlternative,
  type HealEvidence,
  type ResolutionTally,
} from "../src/replay/heal.js";
import { stateOf, transitionOf } from "../src/scraper/machine.js";
import { SCRAPER_VERSION, cacheKey, validateScraper, type CompiledScraper } from "../src/scraper/schema.js";
import { ScraperStore } from "../src/scraper/store.js";
import { groupByTemplate } from "../src/template/index.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

/**
 * Phase F, U9a / U9b / U9c.
 *
 * U9c's verification is one sentence — *a run whose canary failed does not
 * heal* — and it is proved twice below: over `licenseToHeal` alone, where the
 * evidence can be stated exactly, and through `runCrawl` against the demo
 * pharmacy fixture, where the same run heals or refuses depending on nothing
 * but the canary it was given.
 *
 * Everything here is synthetic. The refusal pages are a few lines of HTML
 * written for this file, not a capture of anybody's site.
 */

// ------------------------------------------------------------------ fixtures

/**
 * A page a site serves: enough text to be a page, a product on it, and a
 * vocabulary of its own. Two calls with different products are two documents;
 * `apologySignals` is about the opposite of that.
 */
const servedPage = (product: string, price: string): string => `<!doctype html>
<html lang="es"><head><title>${product} - Tienda Sintetica</title></head>
<body>
  <header><a href="/">Tienda Sintetica</a><nav><a href="/catalogo">Catalogo</a><a href="/contacto">Contacto</a></nav></header>
  <main>
    <h1 class="titulo">${product}</h1>
    <p class="marca">Marca: Fabricante Sintetico</p>
    <p class="precio">${price}</p>
    <p class="stock">Disponible</p>
    <p class="descripcion">${product} es un producto de catalogo. Lea las instrucciones del envase antes de usarlo y consulte a un profesional si tiene dudas sobre su uso.</p>
  </main>
  <footer><p>Tienda Sintetica, direccion sintetica. Precios con impuesto incluido.</p></footer>
</body></html>`;

/**
 * The refusal, in the shape `apologySignals` is written for: substantial text,
 * no declared product, and **the same document whatever URL you ask for**. Its
 * wording is deliberately ordinary — the rule is a shape, not a phrase list,
 * and a fixture that only worked because it said "sorry" would be testing a
 * phrase list.
 */
const refusalPage = `<!doctype html>
<html lang="es"><head><title>Tienda Sintetica</title></head>
<body>
  <header><a href="/">Tienda Sintetica</a></header>
  <main>
    <h1>No podemos mostrar esta pagina</h1>
    <p>Tu solicitud no pudo ser procesada en este momento. Intenta nuevamente mas tarde o comunicate con nuestro equipo de atencion si el problema continua.</p>
    <p>Codigo de referencia: 0000000000</p>
  </main>
  <footer><p>Tienda Sintetica, direccion sintetica.</p></footer>
</body></html>`;

/** A page from somewhere else entirely, for a canary that cannot possibly still resolve. */
const foreignPage = `<!doctype html>
<html lang="en"><head><title>Quarterly weather notes</title></head>
<body><main><h1>Quarterly weather notes</h1>
<p>Rainfall totals across the southern stations remained within the seasonal band throughout the quarter, with the highest daily accumulation recorded midway through the second month.</p>
<p>Wind observations were unremarkable. Temperature ranges narrowed toward the end of the period.</p></main></body></html>`;

const asResponse = (url: string, body: string, status = 200) => ({ url, status, body });

const FIELDS = ["name", "laboratory", "price", "stock"];

function evidence(over: Partial<HealEvidence> = {}): HealEvidence {
  return { pages: [], fields: {}, values: {}, ...over };
}

// --------------------------------------------------- U9a / U9c: the gate

describe("U9c: mayHeal at the call site", () => {
  it("licenses a field repair when the canary still resolves and the rest of the run keeps answering", () => {
    const canary = recordCanary({ ...asResponse("https://example.test/p/1", servedPage("Producto Uno", "$ 1.000")), body: servedPage("Producto Uno", "$ 1.000"), status: 200 });
    const licence = licenseToHeal(
      { kind: "fields", fields: ["price"] },
      evidence({
        pages: [asResponse("https://example.test/p/9", servedPage("Producto Nueve", "$ 9.000"))],
        fields: { name: { filled: 9, total: 9 }, price: { filled: 0, total: 9 } },
        values: { name: ["Producto Uno", "Producto Dos", "Producto Tres"], price: [null, null, null] },
        canary,
      }),
    );
    expect(licence.licensed).toBe(true);
    expect(licence.verdict.state).toBe("drift");
    if (!licence.licensed) return;
    expect(licence.fields).toEqual(["price"]);
    // U9a: the sentence names a state and the transition, not "a selector stopped matching".
    expect(licence.because).toContain(stateOf("replayed")!.what);
    expect(licence.because).toContain(transitionOf("stop-filling")!.id);
    expect(licence.because).not.toMatch(/selector stopped matching/i);
  });

  it("a run whose canary failed does not heal, and the refusal names the state the run rests in", () => {
    const canary = recordCanary({ ...asResponse("https://example.test/p/1", servedPage("Producto Uno", "$ 1.000")), body: servedPage("Producto Uno", "$ 1.000"), status: 200 });
    const licence = licenseToHeal(
      { kind: "fields", fields: ["name", "price"] },
      evidence({
        // One page, so nothing but the canary can tell a redesign from a refusal.
        pages: [asResponse("https://example.test/p/9", foreignPage)],
        fields: { name: { filled: 0, total: 4 }, price: { filled: 0, total: 4 } },
        values: { name: [null, null], price: [null, null] },
        canary,
      }),
    );
    expect(licence.licensed).toBe(false);
    expect(licence.verdict.state).toBe("blocked");
    const refused = transitionOf("site-starts-refusing")!;
    expect(licence.because).toContain(refused.id);
    expect(licence.because).toContain(stateOf(refused.to)!.what);
    expect(stateOf(refused.to)!.kind).toBe("terminal");
    // And it says what the repair needed, quoted from the machine rather than paraphrased.
    for (const requirement of transitionOf("stop-filling")!.requires) expect(licence.because).toContain(requirement.decidedBy);
  });

  it("the same document on every URL is a refusal however many fields still fill, so nothing is repaired against it", () => {
    const licence = licenseToHeal(
      { kind: "fields", fields: ["price"] },
      evidence({
        pages: [asResponse("https://example.test/p/1", refusalPage), asResponse("https://example.test/p/2", refusalPage), asResponse("https://example.test/p/3", refusalPage)],
        fields: { name: { filled: 3, total: 3 }, price: { filled: 0, total: 3 } },
        // The StoreC shape: the one field that fills, fills identically every time.
        values: { name: ["No podemos mostrar esta pagina", "No podemos mostrar esta pagina", "No podemos mostrar esta pagina"], price: [null, null, null] },
      }),
    );
    expect(licence.licensed).toBe(false);
    expect(licence.verdict.state).toBe("blocked");
  });

  it("without a canary a total collapse cannot be told from a refusal, and the gate refuses rather than guessing", () => {
    const shared = {
      fields: { name: { filled: 0, total: 1 }, price: { filled: 0, total: 1 } },
      values: {},
    };
    // A genuine redesign and a genuine refusal, at the moment of the first
    // repair, are the same run. The only thing that separates them is the
    // canary, and neither of these has one.
    const redesign = licenseToHeal({ kind: "fields", fields: ["name", "price"] }, evidence({ ...shared, pages: [asResponse("https://example.test/p/1", servedPage("Producto Uno", "$ 1.000"))] }));
    const refusal = licenseToHeal({ kind: "fields", fields: ["name", "price"] }, evidence({ ...shared, pages: [asResponse("https://example.test/p/1", refusalPage)] }));
    expect(redesign.licensed).toBe(false);
    expect(refusal.licensed).toBe(false);
    expect(redesign.verdict.state).toBe(refusal.verdict.state);
  });

  it("a field U6a rejected as unstable is taken out of the repair, and a repair with nothing left is refused", () => {
    const canary = recordCanary({ ...asResponse("https://example.test/p/1", servedPage("Producto Uno", "$ 1.000")), body: servedPage("Producto Uno", "$ 1.000"), status: 200 });
    const determinism: Determinism = {
      version: 1,
      site: "example.test",
      recordedAt: "2026-09-23T00:00:00.000Z",
      replays: 3,
      urls: [{ url: "https://example.test/p/1", readings: 3 }],
      fields: [
        { field: "price", outcome: "moved", movedOn: 1, readOn: 1, movements: [], rejected: true, because: "price moved" },
        { field: "stock", outcome: "held", movedOn: 0, readOn: 1, movements: [], rejected: false, because: "stock held" },
      ],
      verdict: "unstable",
      because: "one field moved",
    };
    const base = evidence({
      pages: [asResponse("https://example.test/p/9", servedPage("Producto Nueve", "$ 9.000"))],
      fields: { name: { filled: 9, total: 9 }, price: { filled: 0, total: 9 }, stock: { filled: 0, total: 9 } },
      values: { name: ["Uno", "Dos", "Tres"] },
      canary,
      determinism,
    });
    const both = licenseToHeal({ kind: "fields", fields: ["price", "stock"] }, base);
    expect(both.licensed).toBe(true);
    if (both.licensed) expect(both.fields).toEqual(["stock"]);
    expect(both.because).toContain("price");

    const onlyRejected = licenseToHeal({ kind: "fields", fields: ["price"] }, base);
    expect(onlyRejected.licensed).toBe(false);
    expect(onlyRejected.verdict.state).toBe("drift");
  });

  it("a step repair is allowed against a page the site served and refused against one it did not", () => {
    const served = licenseToHeal({ kind: "step", stepIndex: 2, reason: "the button moved" }, evidence({ pages: [asResponse("https://example.test/login", servedPage("Producto Uno", "$ 1.000"))] }));
    expect(served.licensed).toBe(true);

    const refused = licenseToHeal(
      { kind: "step", stepIndex: 2, reason: "the button moved" },
      evidence({ pages: [asResponse("https://example.test/login", refusalPage, 403)] }),
    );
    expect(refused.licensed).toBe(false);
    expect(refused.because).toContain(transitionOf("trace-stops-progressing")!.id);
    expect(refused.because).toContain(stateOf("compiled")!.what);
  });
});

// ---------------------------------------------------------- U9b: promotion

function scraperWith(alternatives: number): CompiledScraper {
  return validateScraper({
    version: SCRAPER_VERSION,
    templateKey: "example.test/p/*",
    cacheKey: "example.test-1",
    profile: "store",
    chooser: "agent",
    mode: "record",
    entry: { mode: "direct", url: "https://example.test/p/1" },
    trace: [],
    pagination: { mode: "none" },
    detail: null,
    createdAt: "2026-09-23T00:00:00.000Z",
    fields: {
      productName: {
        alternatives: Array.from({ length: alternatives }, (_, index) => ({
          selector: index === 0 ? "body.modal-open h1" : `h1.titulo-${index}`,
          fingerprint: { samples: ["Producto Uno"], shape: "text" },
        })),
      },
      sku: { alternatives: [{ selector: "span.sku", fingerprint: { samples: ["FA-0001"], shape: "text" } }] },
    },
  });
}

describe("U9b: an alternative that keeps working outranks one that keeps failing", () => {
  it("the correct selector healing left second moves first, unattended, on the run after the repair", () => {
    const scraper = scraperWith(2);
    const tally: ResolutionTally = {};
    // StoreC's shape: the compiled selector answers nothing, the appended one
    // answers every row, and nobody is asked anything.
    for (let item = 0; item < 111; item++) observeResolutions(tally, { productName: 1, sku: 0 });

    const promotions = judgePromotions(scraper, tally);
    expect(promotions.map((promotion) => promotion.field)).toEqual(["productName"]);
    expect(promotions[0]!.from).toBe(1);
    expect(promotions[0]!.observations).toBe(111);

    const promoted = promoteFieldAlternative(scraper, "productName", 1);
    expect(promoted.fields.productName!.alternatives.map((alternative) => alternative.selector)).toEqual(["h1.titulo-1", "body.modal-open h1"]);
    // A promotion is a reorder and nothing else: every reading is retained, so
    // the next run can overturn it.
    expect(promoted.fields.productName!.alternatives).toHaveLength(scraper.fields.productName!.alternatives.length);
    expect(validateScraper(promoted)).toBeTruthy();
    expect(promoted.fields.sku).toEqual(scraper.fields.sku);
  });

  it("the run that healed a field does not also promote it: the two counts were taken over different pages", () => {
    const tally: ResolutionTally = {};
    for (let item = 0; item < 50; item++) observeResolutions(tally, { productName: 1 });
    expect(judgePromotions(scraperWith(2), tally, { healed: new Set(["productName"]) })).toEqual([]);
  });

  it("a single lucky page does not reorder a binding", () => {
    const tally: ResolutionTally = {};
    for (let item = 0; item < MIN_PROMOTION_OBSERVATIONS - 1; item++) observeResolutions(tally, { productName: 1 });
    expect(judgePromotions(scraperWith(2), tally)).toEqual([]);
    observeResolutions(tally, { productName: 1 });
    expect(judgePromotions(scraperWith(2), tally)).toHaveLength(1);
  });

  it("alternatives that each answer on different pages are not ranked: that is two facts on one field, not a loser", () => {
    const tally: ResolutionTally = {};
    for (let item = 0; item < 6; item++) observeResolutions(tally, { productName: item % 2 });
    expect(judgePromotions(scraperWith(2), tally)).toEqual([]);
  });

  it("promotion cannot add, rename or reach past a field's alternatives", () => {
    const scraper = scraperWith(2);
    expect(() => promoteFieldAlternative(scraper, "nope", 1)).toThrow(/unknown field/);
    expect(() => promoteFieldAlternative(scraper, "productName", 7)).toThrow(/unknown alternative/);
    expect(promoteFieldAlternative(scraper, "productName", 0)).toBe(scraper);
  });
});

// ------------------------------------------------- U9c, end to end in a run

let server: FixtureServer;
let dir: string;

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), "navvi-heal-gate-"));
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => server.switchDemo("v1"));

const PRODUCTS = [
  "amoxicilina-500-mg", "atorvastatina-20-mg", "clotrimazol-crema", "diclofenaco-gel", "ibuprofeno-400-mg", "loratadina-10-mg",
  "losartan-50-mg", "metformina-850-mg", "omeprazol-20-mg", "paracetamol-500-mg", "salbutamol-inhalador", "vitamina-c-1-g",
];

describe("U9c through a real run: the canary is what makes a total collapse repairable", () => {
  const productUrls = () => PRODUCTS.map((slug) => `${server.baseUrl}/demo/pharmacy/producto/${slug}.html`);

  function input(over: Record<string, unknown>): RunInput {
    return parseInput({ browser: "chromium", allowPrivateHosts: ["127.0.0.1"], mode: "record", fields: FIELDS.map((name) => ({ name })), ...over });
  }

  /** The v1 selectors, which every v2 page breaks at once — a whole-template redesign. */
  async function seed(actor: Actor, urls: string[]): Promise<{ store: ScraperStore; key: string }> {
    const templateKey = [...groupByTemplate(urls).keys()][0]!;
    const key = cacheKey(templateKey, { fields: FIELDS, profile: "store" });
    const store = await ScraperStore.open({ actor });
    await store.put(
      validateScraper({
        version: SCRAPER_VERSION,
        templateKey,
        cacheKey: key,
        profile: "store",
        chooser: "agent",
        mode: "record",
        entry: { mode: "direct", url: urls[0]! },
        trace: [],
        pagination: { mode: "none" },
        detail: null,
        createdAt: new Date().toISOString(),
        fields: {
          name: { alternatives: [{ selector: "h1.producto-nombre", fingerprint: { samples: ["Paracetamol 500 mg x 16 comprimidos"], shape: "text" } }] },
          laboratory: { alternatives: [{ selector: "p.producto-laboratorio span.valor", fingerprint: { samples: ["Laboratorio Chile"], shape: "text" } }] },
          price: { alternatives: [{ selector: "div.producto-precio span.precio", fingerprint: { samples: ["$ 2.490"], shape: "money" } }] },
          stock: { alternatives: [{ selector: "p.producto-stock span.stock", fingerprint: { samples: ["Disponible"], shape: "text" } }] },
        },
      }),
    );
    return { store, key };
  }

  async function canaryOfV1(url: string): Promise<CanaryFingerprint> {
    server.switchDemo("v1");
    const body = await (await fetch(url)).text();
    return recordCanary({ url, status: 200, body });
  }

  /**
   * The healer is a spy that repairs nothing.
   *
   * What is under test is the gate, so the run must not depend on a recorded
   * answer: `rankHealCandidates` orders a page's candidates partly by whether
   * a value matches an earlier sample, which makes the option order — and so
   * the recorded index — a property of which page healed first. A spy makes
   * "was the healer reached" the only thing the test reads, which is exactly
   * the question U9c asks.
   */
  async function run(canary: CanaryFingerprint): Promise<{ summary: Awaited<ReturnType<typeof runCrawl>>; asked: string[][]; log: string[] }> {
    const actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false }) });
    const urls = productUrls();
    await seed(actor, urls);
    const asked: string[][] = [];
    const log: string[] = [];
    server.switchDemo("v2");
    const deps: CrawlDeps = {
      actor,
      chooser: new RecordedChooser({ fixture: "crawler/empty" }),
      env: {},
      storageDir: mkdtempSync(join(dir, "st-")),
      attended: false,
      maxConcurrency: 1,
      canary,
      healer: async ({ failure }) => {
        asked.push(failure.kind === "fields" ? [...failure.fields] : [`step ${failure.stepIndex}`]);
        return { healed: false, reason: "the spy healer repairs nothing" };
      },
      log: (message) => log.push(message),
    };
    const summary = await runCrawl(input({ startUrls: urls }), deps);
    return { summary, asked, log };
  }

  it("a run whose canary failed does not heal: the healer is never reached, and the refusal names the state the run rests in", async () => {
    const alien = recordCanary({ url: `${server.baseUrl}/demo/pharmacy/producto/${PRODUCTS[9]!}.html`, status: 200, body: foreignPage });
    const { summary, asked, log } = await run(alien);
    expect(asked).toEqual([]);
    expect(summary.healingEvents).toEqual([]);
    // Every page still counts as unhealed: a refused repair is a page that was
    // not repaired, not a page that was fine.
    expect(summary.unhealed).toBe(PRODUCTS.length);
    const refusal = log.find((line) => line.startsWith("healing refused"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain(stateOf("refused")!.what);
    expect(refusal).toContain(transitionOf("stop-filling")!.id);
    expect(refusal).not.toMatch(/selector stopped matching/i);
  }, 60_000);

  it("the same run with a canary that still resolves reaches the healer with every collapsed field, so the gate is the canary and not the fill counts", async () => {
    const good = await canaryOfV1(`${server.baseUrl}/demo/pharmacy/producto/${PRODUCTS[9]!}.html`);
    const { summary, asked, log } = await run(good);
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect([...asked[0]!].sort()).toEqual([...FIELDS].sort());
    expect(summary.healingEvents.filter((event) => !isPromotionEvent(event))).toEqual([]);
    expect(log.some((line) => line.startsWith("healing licensed"))).toBe(true);
  }, 60_000);
});

describe("U9b end to end: the selector healing left second moves first, unattended", () => {
  it("a run that asks nobody anything reorders the field and says so in its summary", async () => {
    const actor = new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "promo-")), persistStorage: false }) });
    const urls = PRODUCTS.map((slug) => `${server.baseUrl}/demo/pharmacy/producto/${slug}.html`);
    const templateKey = [...groupByTemplate(urls).keys()][0]!;
    const key = cacheKey(templateKey, { fields: ["name", "stock"], profile: "store" });
    const store = await ScraperStore.open({ actor });
    /**
     * The state StoreC was left in: the compiled selector is dead, healing
     * found the right one and appended it second, and the scraper carries
     * `healedAt`. Nothing in this run heals — the first alternative simply
     * never answers and the second always does.
     */
    await store.put(
      validateScraper({
        version: SCRAPER_VERSION,
        templateKey,
        cacheKey: key,
        profile: "store",
        chooser: "agent",
        mode: "record",
        entry: { mode: "direct", url: urls[0]! },
        trace: [],
        pagination: { mode: "none" },
        detail: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        healedAt: "2026-09-02T00:00:00.000Z",
        fields: {
          name: {
            alternatives: [
              { selector: "body.modal-open h1.producto-nombre-antiguo", fingerprint: { samples: ["Paracetamol 500 mg x 16 comprimidos"], shape: "text" } },
              { selector: "h1.producto-nombre", fingerprint: { samples: ["Paracetamol 500 mg x 16 comprimidos"], shape: "text" } },
            ],
          },
          stock: { alternatives: [{ selector: "p.producto-stock span.stock", fingerprint: { samples: ["Disponible"], shape: "text" } }] },
        },
      }),
    );

    server.switchDemo("v1");
    const chooser = new RecordedChooser({ fixture: "crawler/empty" });
    const summary = await runCrawl(
      parseInput({ browser: "chromium", allowPrivateHosts: ["127.0.0.1"], mode: "record", fields: [{ name: "name" }, { name: "stock" }], startUrls: urls }),
      { actor, chooser, env: {}, storageDir: mkdtempSync(join(dir, "promo-st-")), attended: false, maxConcurrency: 1, log: () => undefined },
    );

    expect(summary.status).toBe("succeeded");
    expect(summary.items).toBe(PRODUCTS.length);
    // Unattended: nobody was asked anything, and nothing was healed.
    expect(chooser.usage().questions).toBe(0);
    expect(summary.unhealed).toBe(0);

    const promotions = summary.healingEvents.filter(isPromotionEvent);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]!.field).toBe("name");
    expect(promotions[0]!.from).toBe(1);
    expect(promotions[0]!.observations).toBe(PRODUCTS.length);
    expect(promotions[0]!.because).toContain("h1.producto-nombre");

    const stored = await store.get(key);
    expect(stored!.fields.name!.alternatives.map((alternative) => alternative.selector)).toEqual([
      "h1.producto-nombre",
      "body.modal-open h1.producto-nombre-antiguo",
    ]);
    // Nothing removed, nothing renamed, no other field touched.
    expect(Object.keys(stored!.fields)).toEqual(["name", "stock"]);
    expect(stored!.fields.stock!.alternatives).toHaveLength(1);
  }, 60_000);
});
