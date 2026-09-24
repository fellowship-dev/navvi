import type { BrowserContext, Page } from "playwright";
import { waitForSettle, type SettleOptions } from "../browser/guards.js";
import { DEFAULT_CAPS, ensureSnapshotScript, getCandidates, type Candidates } from "../browser/snapshot.js";
import type { Answer, Chooser, Question } from "../chooser/chooser.js";
import { isChooserId, type Chooser as ChooserId, type Mode, type Profile } from "../input/schema.js";
import { scrollToBottom } from "../replay/entry.js";
import { SCRAPER_VERSION, validateScraper, type CompiledScraper, type ENTRY_MODES, type Field, type FieldAlternative, type Pagination } from "../scraper/schema.js";
import { pickSampleRows } from "../template/index.js";
import {
  applyFieldAnswers,
  applyListAnswers,
  buildFieldQuestions,
  buildListQuestions,
  singleCandidates,
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
  /** Requested fields mapped to `none`; replay emits null for them (R8). */
  fieldsNotFound: string[];
  /** List mode with `followDetailPages`: the chosen per-item detail link, for the detail compile (R18). */
  detailLink: FieldAlternative | null;
}

export interface CompileNoItems {
  ok: false;
  status: "no_items_found";
  fieldsNotFound: string[];
}

export type CompileResult = CompileSuccess | CompileNoItems;

/** Asks a fan-out in batches that fit the chunk budget; the chooser's own `usage()` counts them. */
export async function askChunked(chooser: Chooser, questions: readonly Question[]): Promise<Answer[]> {
  const out: Answer[] = [];
  for (const chunk of chunkQuestions(questions)) out.push(...(await chooser.ask(chunk)));
  return out;
}

async function resolveSpecs(page: Page, specs: readonly LeafSpec[], scope: { within?: string; itemIndex?: number; span?: number; unique?: boolean }): Promise<Array<string | null>> {
  await ensureSnapshotScript(page);
  const list = specs.map((s) => ({ selector: s.selector, attr: s.attr }));
  return page.evaluate(
    ({ list, scope }) => list.map((s) => window.__navvi!.resolveLeaf({ ...scope, selector: s.selector, attr: s.attr })),
    { list, scope },
  );
}

/** Every match of each spec, as replay reads a multi-valued field. */
async function resolveAllSpecs(page: Page, specs: readonly LeafSpec[], scope: { within?: string; itemIndex?: number; span?: number }): Promise<Array<string[] | null>> {
  await ensureSnapshotScript(page);
  const list = specs.map((s) => ({ selector: s.selector, attr: s.attr }));
  return page.evaluate(
    ({ list, scope }) => list.map((s) => window.__navvi!.resolveAll({ ...scope, selector: s.selector, attr: s.attr })),
    { list, scope },
  );
}

function listResolver(page: Page, item: ItemSpec, indices: readonly number[]): SampleResolver {
  const scope = (i: number) => ({ within: item.anchorSelector, itemIndex: indices[i] ?? 0, span: item.span });
  return {
    count: indices.length,
    baseUrl: () => page.url(),
    resolve: (i, specs) => resolveSpecs(page, specs, scope(i)),
    resolveAll: (i, specs) => resolveAllSpecs(page, specs, scope(i)),
  };
}

/**
 * Record mode: a single-value selector must match exactly one element on every
 * sample. The snapshot minimizes each selector against the page it came from;
 * on another sample the same short selector can also match a related
 * product's price ahead of the record's own, and first-match would offer that
 * value as this record's.
 */
function recordResolver(pages: readonly Page[]): SampleResolver {
  return {
    count: pages.length,
    baseUrl: (i) => pages[i]?.url() ?? "",
    resolve: (i, specs) => resolveSpecs(pages[i]!, specs, { unique: true }),
    resolveAll: (i, specs) => resolveAllSpecs(pages[i]!, specs, {}),
  };
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

function finish(options: CompileOptions, mapped: Map<string, FieldCandidate | null>, parts: Parts): CompileSuccess {
  const fields: Record<string, Field> = {};
  const fieldsNotFound: string[] = [];
  for (const field of options.fields) {
    const candidate = mapped.get(field.name);
    if (candidate) {
      fields[field.name] = {
        alternatives: [toAlternative(candidate, parts.baseUrls)],
        ...(field.type ? { type: field.type } : {}),
        ...(candidate.multiple ? { multiple: true } : {}),
      };
    }
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
  return { ok: true, scraper: validateScraper(doc), fieldsNotFound, detailLink: parts.detailLink };
}

function noItems(options: CompileOptions): CompileNoItems {
  return { ok: false, status: "no_items_found", fieldsNotFound: options.fields.map((f) => f.name) };
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

async function compileList(options: CompileOptions): Promise<CompileResult> {
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
      await scrollToBottom(page);
      await waitForSettle(page, options.settle);
      minItems = Math.min(minItems, RETRY_MIN_GROUP_ITEMS);
    }
    const cands = await getCandidates(page, { minGroupItems: minItems });
    const groups = cands.groups.filter((g) => !isDegenerateGroup(g));
    if (groups.length === 0) continue;

    const groupState = `Records: ${description}\nFields: ${names.join(", ")}\nPage: ${page.url()}`;
    const [groupAnswer] = await options.chooser.ask([buildGroupQuestion(groups, description, names, groupState, suffix, page.url())]);
    const group = groupAnswer && groupAnswer.index !== null ? groups[groupAnswer.index] : undefined;
    if (!group) continue;

    const item = itemFromGroup(group);
    const indices = pickSampleRows(group.itemCount);
    const samples: Candidates[] = [];
    for (const i of indices) samples.push(await getCandidates(page, { within: item.anchorSelector, itemIndex: i, span: item.span }));
    const candidates = await intersectCandidates(samples.map((s) => s.leaves), listResolver(page, item, indices));

    const state = fanOutState(description, options.fields, group.sampleTexts, `list mode, ${indices.length} sample rows of ${item.anchorSelector}`);
    const shared = { records: description, fields: options.fields, samples: group.sampleTexts, mode: "list" as const };
    const questions = buildFieldQuestions(options.fields, candidates, state, suffix, shared);
    const nextLinks = nextLinkCandidates(cands.links, options.startUrls, allowed);
    if (nextLinks.length > 0) questions.push(buildNextLinkQuestion(nextLinks, state, suffix, shared));
    const detailCands = options.followDetailPages ? detailLinkCandidates(singleCandidates(candidates), page.url(), options.startUrls, allowed) : [];
    if (detailCands.length > 0) questions.push(buildDetailLinkQuestion(detailCands, description, state, suffix, shared));

    const answers = await askChunked(options.chooser, questions);
    const mapped = applyFieldAnswers(options.fields, candidates, answers, suffix);
    // Asked only when some field bound one member of a repeated family, or nothing.
    const followUps = buildListQuestions(options.fields, mapped, candidates, state, suffix, shared);
    if (followUps.length > 0) applyListAnswers(mapped, followUps, await askChunked(options.chooser, followUps.map((f) => f.question)));
    if (allNone(mapped)) continue;

    const nextIndex = chosenIndex(answers, `${NEXT_LINK_QUESTION_ID}${suffix}`);
    const next = nextIndex === null ? null : (nextLinks[nextIndex] ?? null);
    const detailIndex = chosenIndex(answers, `${DETAIL_LINK_QUESTION_ID}${suffix}`);
    const detail = detailIndex === null ? null : (detailCands[detailIndex] ?? null);
    const entryMode = options.entryMode ?? (options.context ? await probeEntry(options.context, page.url(), item, minItems, options.settle) : "direct");
    return finish(options, mapped, {
      mode: "list",
      entry: { mode: entryMode, url: page.url() },
      item,
      pagination: paginationFrom(next),
      baseUrls: [page.url()],
      detailLink: detail ? toAlternative(detail, [page.url()]) : null,
    });
  }
  return noItems(options);
}

/** At most this many sample pages are read in record mode; the rest of a sample is not rendered for it. */
export const RECORD_SAMPLE_PAGES = 3;

export interface RecordChoiceOptions {
  /** One to three rendered sample pages of one template; more are ignored. */
  pages: readonly Page[];
  /** The fields to ask about -- and only these. See `chooseRecordFields`. */
  fields: readonly CompileField[];
  chooser: Chooser;
  description?: string | undefined;
  settle?: SettleOptions | undefined;
  /**
   * Ask the list follow-up (`buildListQuestions`). Default true. Tier 3 of the
   * compile core turns it off: its bindings reach the scraper through
   * `compileFromReconciliation` (./proven.ts), which cannot carry
   * `Field.multiple` yet, so a list there would replay as its first element.
   */
  offerLists?: boolean | undefined;
}

/** What the record-mode fan-out asked and what came back, per field. */
export interface RecordChoice {
  /** The leaves that resolved on every sample page: the options every question offered. */
  candidates: FieldCandidate[];
  questions: Question[];
  answers: Answer[];
  /** The chosen candidate per field, null for `none`. */
  mapped: Map<string, FieldCandidate | null>;
  /** `""`, or `RETRY_SUFFIX` when the answer came from the scroll-and-retry. */
  suffix: string;
  /** The sample URLs, in page order, for making link values absolute. */
  baseUrls: string[];
}

/**
 * The record-mode flow -- candidates, one choice question per field, answers
 * -- over exactly the fields it is handed.
 *
 * Split out of `compileRecord` for U4, so tier 3 of the one compile core
 * (`./template.ts`) is this function and not a second DOM compiler (KTD2). The
 * restriction is the caller's: tier 3 hands in only what tiers 1 and 2 left
 * uncovered, so a field the page already declared is never put to a chooser
 * as a question about DOM nodes.
 *
 * Null when no candidate resolved on every page, on either attempt: there was
 * nothing to ask. A choice whose every answer is `none` is returned rather
 * than swallowed, because "the chooser said none" and "nothing was offered"
 * are different sentences in a manuscript.
 */
export async function chooseRecordFields(options: RecordChoiceOptions): Promise<RecordChoice | null> {
  const pages = options.pages.slice(0, RECORD_SAMPLE_PAGES);
  if (pages.length === 0) throw new Error("record mode compile needs at least one sample page");
  if (options.fields.length === 0) throw new Error("record mode compile needs at least one field");
  const description = options.description ?? "record";
  for (const page of pages) await waitForSettle(page, options.settle);

  let last: RecordChoice | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix = attempt === 0 ? "" : RETRY_SUFFIX;
    if (attempt > 0) {
      for (const page of pages) {
        await scrollToBottom(page);
        await waitForSettle(page, options.settle);
      }
    }
    const leaves = [];
    for (const page of pages) leaves.push((await getCandidates(page)).leaves);
    const found = await intersectCandidates(leaves, recordResolver(pages));
    const candidates = options.offerLists === false ? singleCandidates(found) : found;
    if (candidates.length === 0) continue;

    const state = fanOutState(description, options.fields, pages.map((p) => p.url()), `record mode, ${pages.length} sample pages`);
    const shared = { records: description, fields: options.fields, samples: pages.map((p) => p.url()), mode: "record" as const };
    const questions = buildFieldQuestions(options.fields, candidates, state, suffix, shared);
    const answers = await askChunked(options.chooser, questions);
    const mapped = applyFieldAnswers(options.fields, candidates, answers, suffix);
    const followUps = options.offerLists === false ? [] : buildListQuestions(options.fields, mapped, candidates, state, suffix, shared);
    if (followUps.length > 0) {
      const listAnswers = await askChunked(options.chooser, followUps.map((f) => f.question));
      applyListAnswers(mapped, followUps, listAnswers);
      questions.push(...followUps.map((f) => f.question));
      answers.push(...listAnswers);
    }
    last = { candidates, questions, answers, mapped, suffix, baseUrls: pages.map((p) => p.url()) };
    if (!allNone(mapped)) return last;
  }
  return last;
}

async function compileRecord(options: CompileOptions): Promise<CompileResult> {
  const choice = await chooseRecordFields(options);
  if (choice === null || allNone(choice.mapped)) return noItems(options);
  return finish(options, choice.mapped, {
    mode: "record",
    entry: { mode: "direct", url: options.pages[0]!.url() },
    pagination: { mode: "none" },
    baseUrls: choice.baseUrls,
    detailLink: null,
  });
}

/** Compiles the template from the given sample pages with any chooser. */
export async function compile(options: CompileOptions): Promise<CompileResult> {
  if (options.fields.length === 0) throw new Error("compile needs at least one field");
  return options.mode === "list" ? compileList(options) : compileRecord(options);
}
