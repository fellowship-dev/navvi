import type { BrowserContext, Page } from "playwright";
import type { Answer, Chooser, Question } from "../chooser/chooser.js";
import { compile, type CompileField } from "../compile/index.js";
import type { Chooser as ChooserId, Profile } from "../input/schema.js";
import { extractPage, type ItemExtraction } from "../scraper/extract.js";
import { validateScraper, type CompiledScraper, type FieldAlternative } from "../scraper/schema.js";

/**
 * Detail pages (R18). At compile time the chosen per-item link becomes the
 * scraper's `detail.linkField`; the detail template itself is compiled on the
 * first replay from three detail pages, in record mode, and stored under
 * `detail.fields`. Replay then opens each item's detail page, extracts the
 * detail fields and merges them into the list item. Every detail page opened
 * is a scraped page toward `maxPages`.
 */

/** Hidden field holding the detail link when no requested field carries it. Stripped from output rows. */
export const DETAIL_LINK_FIELD = "_detailLink";
export const DETAIL_SAMPLE_PAGES = 3;
/** Prefix on the detail compile's question ids, so recordings never collide with the list compile. */
export const DETAIL_QUESTION_PREFIX = "detail.";

/**
 * Attaches the compiled detail link to a freshly compiled list scraper: a
 * requested field with the same selector and attribute is reused, otherwise
 * the hidden link field is added. `detail.fields` stays empty until the
 * detail template is compiled.
 */
export function withDetailLink(scraper: CompiledScraper, detailLink: FieldAlternative): CompiledScraper {
  const existing = Object.entries(scraper.fields).find(([, field]) => field.alternatives.some((a) => a.selector === detailLink.selector && a.attr === detailLink.attr));
  const linkField = existing ? existing[0] : DETAIL_LINK_FIELD;
  const fields = existing ? scraper.fields : { ...scraper.fields, [DETAIL_LINK_FIELD]: { alternatives: [detailLink] } };
  return validateScraper({ ...scraper, fields, detail: { linkField, fields: {} } });
}

export function hasDetailTemplate(scraper: CompiledScraper): boolean {
  return scraper.detail !== null && Object.keys(scraper.detail.fields).length > 0;
}

/** The item's absolute http(s) detail URL, or null. */
export function detailLinkOf(scraper: CompiledScraper, item: ItemExtraction): string | null {
  if (!scraper.detail) return null;
  const value = item.values[scraper.detail.linkField];
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The record scraper replay runs on a detail page: the detail fields, nothing else. */
export function detailScraper(scraper: CompiledScraper): CompiledScraper | null {
  if (!hasDetailTemplate(scraper) || !scraper.detail) return null;
  const doc: CompiledScraper = {
    version: scraper.version,
    templateKey: `${scraper.templateKey}#detail`,
    cacheKey: `${scraper.cacheKey}#detail`,
    profile: scraper.profile,
    chooser: scraper.chooser,
    mode: "record",
    entry: { mode: "direct", url: scraper.entry.url },
    trace: [],
    fields: scraper.detail.fields,
    pagination: { mode: "none" },
    detail: null,
    createdAt: scraper.createdAt,
  };
  return validateScraper(doc);
}

/** Wraps a chooser so every question id carries `prefix` on the way out and loses it on the way back. */
export function prefixQuestions(chooser: Chooser, prefix: string): Chooser {
  return {
    name: chooser.name,
    usage: () => chooser.usage(),
    async ask(batch: Question[]): Promise<Answer[]> {
      const answers = await chooser.ask(batch.map((q) => ({ ...q, id: `${prefix}${q.id}` })));
      return answers.map((a) => ({ ...a, id: a.id.startsWith(prefix) ? a.id.slice(prefix.length) : a.id }));
    },
  };
}

export interface CompileDetailOptions {
  context: BrowserContext;
  scraper: CompiledScraper;
  /** Detail URLs of the first items; at most `DETAIL_SAMPLE_PAGES` are opened. */
  links: readonly string[];
  detailFields: readonly CompileField[];
  description?: string | undefined;
  chooser: Chooser;
  chooserId?: ChooserId | undefined;
  profile: Profile;
  startUrls: readonly string[];
  allowedDomains?: readonly string[] | undefined;
  /** Runs on each opened sample page before compiling (consent dismissal). */
  prepare?: ((page: Page) => Promise<void>) | undefined;
}

export interface CompileDetailResult {
  /** The list scraper with `detail.fields` filled when the compile succeeded; unchanged otherwise. */
  scraper: CompiledScraper;
  ok: boolean;
  /** Detail pages opened, each a scraped page. */
  pagesOpened: number;
  /** Extraction of the sample pages by URL, so they are not fetched twice. */
  samples: Map<string, ItemExtraction>;
  fieldsNotFound: string[];
  questions: number;
}

/** Compiles the detail template from up to three detail pages of the same context (R18). */
export async function compileDetail(options: CompileDetailOptions): Promise<CompileDetailResult> {
  const { scraper } = options;
  if (!scraper.detail) throw new Error("compileDetail needs a scraper with a detail link");
  const links = [...new Set(options.links)].slice(0, DETAIL_SAMPLE_PAGES);
  const pages: Page[] = [];
  const samples = new Map<string, ItemExtraction>();
  const names = options.detailFields.map((f) => f.name);
  try {
    for (const url of links) {
      const page = await options.context.newPage();
      pages.push(page);
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      if (options.prepare) await options.prepare(page).catch(() => undefined);
    }
    if (pages.length === 0) return { scraper, ok: false, pagesOpened: 0, samples, fieldsNotFound: names, questions: 0 };
    const result = await compile({
      mode: "record",
      pages,
      fields: options.detailFields,
      description: options.description,
      templateKey: `${scraper.templateKey}#detail`,
      cacheKey: `${scraper.cacheKey}#detail`,
      profile: options.profile,
      chooser: prefixQuestions(options.chooser, DETAIL_QUESTION_PREFIX),
      chooserId: options.chooserId,
      startUrls: options.startUrls,
      allowedDomains: options.allowedDomains,
    });
    if (!result.ok) return { scraper, ok: false, pagesOpened: pages.length, samples, fieldsNotFound: result.fieldsNotFound, questions: result.questions };
    const compiled = validateScraper({ ...scraper, detail: { linkField: scraper.detail.linkField, fields: result.scraper.fields } });
    const replay = detailScraper(compiled);
    if (replay) {
      for (const [i, url] of links.entries()) {
        const page = pages[i];
        if (page) samples.set(url, await extractPage(page, replay, { sourceUrl: url, fields: names }));
      }
    }
    return { scraper: compiled, ok: true, pagesOpened: pages.length, samples, fieldsNotFound: result.fieldsNotFound, questions: result.questions };
  } finally {
    for (const page of pages) await page.close().catch(() => undefined);
  }
}

/** Opens one detail page in `page` and extracts the detail fields. Null fields when the page cannot be read. */
export async function extractDetail(page: Page, scraper: CompiledScraper, url: string, fields: readonly string[]): Promise<ItemExtraction> {
  const replay = detailScraper(scraper);
  const empty: ItemExtraction = {
    values: Object.fromEntries(fields.map((n) => [n, null])),
    resolvedBy: Object.fromEntries(fields.map((n) => [n, null])),
    sourceUrl: url,
  };
  if (!replay) return empty;
  const response = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
  if (!response) return empty;
  return extractPage(page, replay, { sourceUrl: url, fields });
}

/** Detail values merged into the list item: detail fields fill in, list fields win on a name clash. */
export function mergeDetail(item: ItemExtraction, detail: ItemExtraction | null, fields: readonly string[]): ItemExtraction {
  const values = { ...item.values };
  const resolvedBy = { ...item.resolvedBy };
  for (const name of fields) {
    if (name in item.values && item.values[name] !== null) continue;
    values[name] = detail?.values[name] ?? null;
    resolvedBy[name] = detail?.resolvedBy[name] ?? null;
  }
  return { ...item, values, resolvedBy };
}
