import type { BrowserContext, Page } from "playwright";
import { waitForSettle, type SettleOptions } from "../browser/guards.js";
import { DEFAULT_CAPS, ensureSnapshotScript, getCandidates, type Candidates } from "../browser/snapshot.js";
import type { Answer, Chooser, Question } from "../chooser/chooser.js";
import { CHOOSERS, type Chooser as ChooserId, type Mode, type Profile } from "../input/schema.js";
import { SCRAPER_VERSION, validateScraper, type CompiledScraper, type ENTRY_MODES, type Field, type FieldAlternative, type Pagination } from "../scraper/schema.js";
import { pickSampleRows } from "../template/index.js";
import {
  applyFieldAnswers,
  buildFieldQuestions,
  chunkQuestions,
  intersectCandidates,
  toAlternative,
  type CompileField,
  type FieldCandidate,
  type LeafSpec,
  type SampleResolver,
} from "./fields.js";
import { RETRY_SUFFIX, buildGroupQuestion, isDegenerateGroup, itemFromGroup } from "./groups.js";
import {
  DETAIL_LINK_QUESTION_ID,
  NEXT_LINK_QUESTION_ID,
  buildDetailLinkQuestion,
  buildNextLinkQuestion,
  chosenIndex,
  detailLinkCandidates,
  nextLinkCandidates,
  paginationFrom,
} from "./links.js";

/**
 * Compile phase (U5). From one to three sample pages already navigated by the
 * caller, produce a validated CompiledScraper for the template, or a typed
 * `no_items_found` outcome. Never launches a browser; the chooser only picks
 * among code-enumerated candidates (R7), and every choice has `none`.
 */

export type EntryMode = (typeof ENTRY_MODES)[number];
export type ItemSpec = { anchorSelector: string; span: number };

/** Group threshold for the one retry after scrolling to the bottom (R8). */
export const RETRY_MIN_GROUP_ITEMS = 2;

export interface CompileOptions {
  mode: Mode;
  /** Record mode: one to three sample pages. List mode: the listing page. */
  pages: readonly Page[];
  fields: readonly CompileField[];
  /** What one record is, e.g. "python job listing". */
  description?: string | undefined;
  templateKey: string;
  cacheKey: string;
  profile: Profile;
  chooser: Chooser;
  /** Recorded in the scraper; defaults to the chooser's name, `agent` for the recorded chooser. */
  chooserId?: ChooserId | undefined;
  startUrls: readonly string[];
  allowedDomains?: readonly string[] | undefined;
  /** List mode: also ask which per-item link leads to the detail page. */
  followDetailPages?: boolean | undefined;
  /** List mode: when given, the entry probe (R14) opens the listing URL in a fresh page of this context. */
  context?: BrowserContext | undefined;
  /** Skips the entry probe. */
  entryMode?: EntryMode | undefined;
  minGroupItems?: number | undefined;
  settle?: SettleOptions | undefined;
}

export interface CompileSuccess {
  ok: true;
  scraper: CompiledScraper;
  questions: number;
  batches: number;
  /** Requested fields mapped to `none`; replay emits null for them (R8). */
  fieldsNotFound: string[];
  /** List mode with `followDetailPages`: the chosen per-item detail link, for the detail compile (R18). */
  detailLink: FieldAlternative | null;
}

export interface CompileNoItems {
  ok: false;
  status: "no_items_found";
  questions: number;
  batches: number;
  fieldsNotFound: string[];
}

export type CompileResult = CompileSuccess | CompileNoItems;

/** Counts what the chooser was asked, chunking fan-outs to the budget. */
class Asker {
  questions = 0;
  batches = 0;
  constructor(private readonly chooser: Chooser) {}

  async ask(batch: Question[]): Promise<Answer[]> {
    if (batch.length === 0) return [];
    this.batches += 1;
    this.questions += batch.length;
    return this.chooser.ask(batch);
  }

  async askChunked(questions: Question[]): Promise<Answer[]> {
    const out: Answer[] = [];
    for (const chunk of chunkQuestions(questions)) out.push(...(await this.ask(chunk)));
    return out;
  }
}

function isChooserId(name: string): name is ChooserId {
  return (CHOOSERS as readonly string[]).includes(name);
}

async function resolveSpecs(page: Page, specs: readonly LeafSpec[], scope: { within?: string; itemIndex?: number; span?: number }): Promise<Array<string | null>> {
  await ensureSnapshotScript(page);
  const list = specs.map((s) => ({ selector: s.selector, attr: s.attr }));
  return page.evaluate(
    ({ list, scope }) => list.map((s) => window.__navvi!.resolveLeaf({ ...scope, selector: s.selector, attr: s.attr })),
    { list, scope },
  );
}

function listResolver(page: Page, item: ItemSpec, indices: readonly number[]): SampleResolver {
  return {
    count: indices.length,
    baseUrl: () => page.url(),
    resolve: (i, specs) => resolveSpecs(page, specs, { within: item.anchorSelector, itemIndex: indices[i] ?? 0, span: item.span }),
  };
}

function recordResolver(pages: readonly Page[]): SampleResolver {
  return {
    count: pages.length,
    baseUrl: (i) => pages[i]?.url() ?? "",
    resolve: (i, specs) => resolveSpecs(pages[i]!, specs, {}),
  };
}

async function scrollToBottom(page: Page, settle: SettleOptions | undefined): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await waitForSettle(page, settle);
}

function fanOutState(description: string, fields: readonly CompileField[], samples: readonly string[], how: string): string {
  const lines = [
    `Records: ${description}`,
    `Fields: ${fields.map((f) => (f.description ? `${f.name} (${f.description})` : f.name)).join(", ")}`,
    `Samples: ${how}`,
    ...samples.map((s, i) => `Sample ${i + 1}: ${s}`),
  ];
  return lines.join("\n");
}

const allNone = (mapped: Map<string, FieldCandidate | null>): boolean => [...mapped.values()].every((c) => c === null);

interface Parts {
  mode: Mode;
  entry: { mode: EntryMode; url: string };
  item?: ItemSpec | undefined;
  pagination: Pagination;
  baseUrls: readonly string[];
  detailLink: FieldAlternative | null;
}

function finish(options: CompileOptions, asker: Asker, mapped: Map<string, FieldCandidate | null>, parts: Parts): CompileSuccess {
  const fields: Record<string, Field> = {};
  const fieldsNotFound: string[] = [];
  for (const field of options.fields) {
    const candidate = mapped.get(field.name);
    if (candidate) fields[field.name] = { alternatives: [toAlternative(candidate, parts.baseUrls)] };
    else fieldsNotFound.push(field.name);
  }
  const doc: CompiledScraper = {
    version: SCRAPER_VERSION,
    templateKey: options.templateKey,
    cacheKey: options.cacheKey,
    profile: options.profile,
    chooser: options.chooserId ?? (isChooserId(options.chooser.name) ? options.chooser.name : "agent"),
    mode: parts.mode,
    entry: parts.entry,
    trace: [],
    fields,
    pagination: parts.pagination,
    detail: null,
    createdAt: new Date().toISOString(),
  };
  if (parts.item) doc.item = parts.item;
  return { ok: true, scraper: validateScraper(doc), questions: asker.questions, batches: asker.batches, fieldsNotFound, detailLink: parts.detailLink };
}

function noItems(options: CompileOptions, asker: Asker): CompileNoItems {
  return { ok: false, status: "no_items_found", questions: asker.questions, batches: asker.batches, fieldsNotFound: options.fields.map((f) => f.name) };
}

/**
 * R14 entry probe: the listing URL opened in a fresh page of the same context
 * is `direct` when the item anchor resolves with at least `minItems` items,
 * else `trace`.
 */
export async function probeEntry(context: BrowserContext, url: string, item: ItemSpec, minItems: number, settle?: SettleOptions): Promise<EntryMode> {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
    if (!response || !response.ok()) return "trace";
    await waitForSettle(page, settle);
    const count = await page.evaluate((selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    }, item.anchorSelector);
    return count >= minItems ? "direct" : "trace";
  } finally {
    await page.close();
  }
}

async function compileList(options: CompileOptions, asker: Asker): Promise<CompileResult> {
  const page = options.pages[0];
  if (!page) throw new Error("list mode compile needs the listing page");
  const description = options.description ?? "record";
  const names = options.fields.map((f) => f.name);
  const allowed = options.allowedDomains ?? [];
  let minItems = options.minGroupItems ?? DEFAULT_CAPS.minGroupItems;
  await waitForSettle(page, options.settle);

  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix = attempt === 0 ? "" : RETRY_SUFFIX;
    if (attempt > 0) {
      await scrollToBottom(page, options.settle);
      minItems = Math.min(minItems, RETRY_MIN_GROUP_ITEMS);
    }
    const cands = await getCandidates(page, { minGroupItems: minItems });
    const groups = cands.groups.filter((g) => !isDegenerateGroup(g));
    if (groups.length === 0) continue;

    const groupState = `Records: ${description}\nFields: ${names.join(", ")}\nPage: ${page.url()}`;
    const [groupAnswer] = await asker.ask([buildGroupQuestion(groups, description, names, groupState, suffix)]);
    const group = groupAnswer && groupAnswer.index !== null ? groups[groupAnswer.index] : undefined;
    if (!group) continue;

    const item = itemFromGroup(group);
    const indices = pickSampleRows(group.itemCount);
    const samples: Candidates[] = [];
    for (const i of indices) samples.push(await getCandidates(page, { within: item.anchorSelector, itemIndex: i, span: item.span }));
    const candidates = await intersectCandidates(samples.map((s) => s.leaves), listResolver(page, item, indices));

    const state = fanOutState(description, options.fields, group.sampleTexts, `list mode, ${indices.length} sample rows of ${item.anchorSelector}`);
    const questions = buildFieldQuestions(options.fields, candidates, state, suffix);
    const nextLinks = nextLinkCandidates(cands.links, options.startUrls, allowed);
    if (nextLinks.length > 0) questions.push(buildNextLinkQuestion(nextLinks, state, suffix));
    const detailCands = options.followDetailPages ? detailLinkCandidates(candidates, page.url(), options.startUrls, allowed) : [];
    if (detailCands.length > 0) questions.push(buildDetailLinkQuestion(detailCands, description, state, suffix));

    const answers = await asker.askChunked(questions);
    const mapped = applyFieldAnswers(options.fields, candidates, answers, suffix);
    if (allNone(mapped)) continue;

    const nextIndex = chosenIndex(answers, `${NEXT_LINK_QUESTION_ID}${suffix}`);
    const next = nextIndex === null ? null : (nextLinks[nextIndex] ?? null);
    const detailIndex = chosenIndex(answers, `${DETAIL_LINK_QUESTION_ID}${suffix}`);
    const detail = detailIndex === null ? null : (detailCands[detailIndex] ?? null);
    const entryMode = options.entryMode ?? (options.context ? await probeEntry(options.context, page.url(), item, minItems, options.settle) : "direct");
    return finish(options, asker, mapped, {
      mode: "list",
      entry: { mode: entryMode, url: page.url() },
      item,
      pagination: paginationFrom(next),
      baseUrls: [page.url()],
      detailLink: detail ? toAlternative(detail, [page.url()]) : null,
    });
  }
  return noItems(options, asker);
}

async function compileRecord(options: CompileOptions, asker: Asker): Promise<CompileResult> {
  const pages = options.pages.slice(0, 3);
  if (pages.length === 0) throw new Error("record mode compile needs at least one sample page");
  const description = options.description ?? "record";
  for (const page of pages) await waitForSettle(page, options.settle);

  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix = attempt === 0 ? "" : RETRY_SUFFIX;
    if (attempt > 0) for (const page of pages) await scrollToBottom(page, options.settle);
    const leaves = [];
    for (const page of pages) leaves.push((await getCandidates(page)).leaves);
    const candidates = await intersectCandidates(leaves, recordResolver(pages));
    if (candidates.length === 0) continue;

    const state = fanOutState(description, options.fields, pages.map((p) => p.url()), `record mode, ${pages.length} sample pages`);
    const answers = await asker.askChunked(buildFieldQuestions(options.fields, candidates, state, suffix));
    const mapped = applyFieldAnswers(options.fields, candidates, answers, suffix);
    if (allNone(mapped)) continue;

    return finish(options, asker, mapped, {
      mode: "record",
      entry: { mode: "direct", url: pages[0]!.url() },
      pagination: { mode: "none" },
      baseUrls: pages.map((p) => p.url()),
      detailLink: null,
    });
  }
  return noItems(options, asker);
}

/** Compiles the template from the given sample pages with any chooser. */
export async function compile(options: CompileOptions): Promise<CompileResult> {
  if (options.fields.length === 0) throw new Error("compile needs at least one field");
  const asker = new Asker(options.chooser);
  return options.mode === "list" ? compileList(options, asker) : compileRecord(options, asker);
}
