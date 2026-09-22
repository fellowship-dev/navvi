import { ensureEvaluateShim } from "../browser/snapshot.js";
import type { Page } from "playwright";
import type { FieldType } from "../input/schema.js";
import type { CompiledScraper, FieldAlternative, Fingerprint, Shape } from "./schema.js";

/**
 * Replay extraction (U5.6): one `page.evaluate` per page resolves every
 * field's alternatives against the item rows (list mode) or the document
 * (record mode); the first alternative whose value fits its fingerprint wins,
 * so a drifted early alternative that still yields text of the wrong shape
 * cannot shadow a healed one appended after it (R17). No model is involved;
 * selectors only ever reach `querySelector`. The shape classifier here mirrors
 * `shapeOf` in snapshot.inject.js so a compiled fingerprint accepts the values
 * the snapshot classified the same way.
 */

/** Longest extracted text value, in characters. */
export const MAX_VALUE_CHARS = 4_000;

/** Attributes whose values are URLs: made absolute, non-http(s) schemes become null (R4). */
export const URL_ATTRS: ReadonlySet<string> = new Set(["href", "src"]);

export interface ItemExtraction {
  values: Record<string, string | null>;
  /** Index of the alternative that resolved each field, or null when none did. */
  resolvedBy: Record<string, number | null>;
  sourceUrl: string;
}

export interface PageExtraction extends ItemExtraction {
  /** Record mode: exactly one item. List mode: one per item anchor, possibly none. */
  items: ItemExtraction[];
}

export interface ExtractOptions {
  /** Defaults to `page.url()`. */
  sourceUrl?: string | undefined;
  /** Requested field names; those absent from the scraper are emitted as null (R4, R8). */
  fields?: readonly string[] | undefined;
  /** JSON responses the page fetched, for `network` alternatives (U16 cascade). */
  captured?: readonly { url: string; status: number; body: unknown }[] | undefined;
}

const squash = (s: string | null | undefined): string => String(s ?? "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- URLs

/** Absolute http(s) URL for a link or media attribute, or null for any other scheme or a malformed value. */
export function resolveUrl(raw: string | null | undefined, base: string): string | null {
  const value = squash(raw);
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}

/** True for an absolute http(s) URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- shapes

const MONTHS =
  "(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|" +
  "ene|enero|febrero|marzo|abr|abril|mayo|junio|julio|ago|agosto|septiembre|octubre|noviembre|dic|diciembre)\\.?";

const DATE_PATTERNS: readonly RegExp[] = [
  /^\d{4}-\d{2}-\d{2}/,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  new RegExp(`\\b${MONTHS}\\b \\d{1,2}(,? \\d{4})?\\b`, "i"),
  new RegExp(`\\b\\d{1,2} (de )?${MONTHS}\\b( (de )?\\d{4})?\\b`, "i"),
  /\b\d+ (seconds?|minutes?|hours?|days?|weeks?|months?|years?) ago\b/i,
  /^hace \d+ /i,
];

const MONEY_PATTERNS: readonly RegExp[] = [
  /(^|[\s(])(\$|€|£|US\$|R\$|CLP|USD|EUR|MXN|ARS|COP|PEN|BRL)\s?\d/i,
  /\d\s?(€|£|CLP|USD|EUR|MXN|ARS|pesos)\b/i,
];

/** Integer with optional sign and optional thousands separators, exactly as the snapshot classifies `int`. */
const INT = /^[-+]?(\d{1,3}([.,]\d{3})*|\d+)$/;
/** A bare amount with a decimal part, accepted by the money shape only. */
const DECIMAL = /^[-+]?(\d{1,3}([.,]\d{3})*|\d+)[.,]\d{1,2}$/;

const isDate = (t: string): boolean => DATE_PATTERNS.some((p) => p.test(t));
const isMoney = (t: string): boolean => MONEY_PATTERNS.some((p) => p.test(t));

/** Mirror of `shapeOf` in snapshot.inject.js: most specific shape first. */
export function shapeOf(text: string, attr?: string | undefined): Shape {
  if (attr === "href" || attr === "src") return "url";
  if (attr === "datetime") return "date";
  const t = squash(text);
  if (/^https?:\/\/\S+$/i.test(t)) return "url";
  if (isDate(t)) return "date";
  if (isMoney(t)) return "money";
  if (INT.test(t)) return "int";
  return "text";
}

/** The shape shared by every sample value; mixed money and int read as money; anything else is text. */
export function commonShape(values: readonly string[], attr?: string | undefined): Shape {
  const shapes = new Set(values.map((v) => shapeOf(v, attr)));
  if (shapes.size === 1) return [...shapes][0]!;
  if (shapes.size === 2 && shapes.has("money") && shapes.has("int")) return "money";
  return "text";
}

/**
 * Code fingerprint check (R17): does `value` have the compiled shape?
 * money accepts "$ 12.990", "12.990", "$12,990.00", "CLP 12.990"; int accepts
 * digits with thousands separators; date accepts ISO and common written forms;
 * url accepts absolute http(s) only; text accepts any non-empty value.
 */
export function fingerprintMatches(value: string | null | undefined, fingerprint: Fingerprint): boolean {
  const t = squash(value);
  if (!t) return false;
  switch (fingerprint.shape) {
    case "text":
      return true;
    case "url":
      return isHttpUrl(t);
    case "date":
      return isDate(t);
    case "int":
      return INT.test(t);
    case "money":
      return isMoney(t) || INT.test(t) || DECIMAL.test(t);
  }
}

// ---------------------------------------------------------------- typed values (R5)

export type TypedValue = string | number | boolean | null;

/**
 * What the declared field type implies about how many decimals a value may
 * have. `1.250` is 1250 on a Chilean price tag and 1.25 in a dosage table, and
 * nothing in the string settles it, so the reading depends on the declaration:
 *
 * - `money`: currency amounts carry at most two decimals (the three-decimal
 *   ISO codes are spelled out in the text and detected below), so a separator
 *   followed by three digits groups thousands \u2014 `$ 6.990` is 6990.
 * - `integer`: a decimal reading is inadmissible by declaration, so grouping is
 *   the only interpretation that can produce a value at all \u2014 `1.234` is 1234.
 * - `number`: weights, ratings and dosages make `1.250` an ordinary decimal and
 *   nothing rules the grouped reading out either. Unresolvable, so null: this
 *   feeds a price index, where a silently 1000x value is worse than no value.
 */
export type NumberHint = "money" | "integer" | "number";

/** The first number in the text: sign, digits, one or two separators. */
const NUMBER_TOKEN = /[-+]?\d[\d.,]*/;
/** The same number grouped with spaces (French, Nordic, Polish, some Chilean sites): every group is exactly three digits. */
const SPACE_GROUPED_TOKEN = /[-+]?\d{1,3}(?: \d{3}(?!\d))+(?:[.,]\d+)?/;

/** ISO 4217 codes whose minor unit is three digits: `12.500 KWD` is twelve and a half dinars. */
const THREE_DECIMAL_CURRENCY = /\b(KWD|BHD|TND|OMR|JOD|IQD|LYD)\b/i;
/** ISO 4217 codes with no minor unit at all: `CLP 12.990` can only be grouped. */
const ZERO_DECIMAL_CURRENCY = /\b(CLP|COP|PYG|JPY|KRW|ISK|VND|XOF|XAF)\b/i;

/** Thousands grouping: one to three digits, then groups of exactly three. */
const isGrouped = (parts: readonly string[]): boolean =>
  parts.length > 1 && /^\d{1,3}$/.test(parts[0]!) && parts.slice(1).every((p) => /^\d{3}$/.test(p));

/**
 * The digits of `token` as a plain JS number literal, or null when the writing
 * is not a number any convention produces (`1.2.3`, `1,23.5`) or is ambiguous
 * and the hint refuses to guess. `text` is the whole value, read for currency
 * evidence; `spaceGrouped` says the spaces already did the thousands grouping.
 */
function normalizeDigits(token: string, spaceGrouped: boolean, hint: NumberHint, text: string): string | null {
  const dots = token.split(".").length - 1;
  const commas = token.split(",").length - 1;
  if (dots + commas === 0) return /^\d+$/.test(token) ? token : null;
  if (dots > 0 && commas > 0) {
    // the last separator is the decimal one, the other groups thousands
    const decimal = token.lastIndexOf(".") > token.lastIndexOf(",") ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    const cut = token.lastIndexOf(decimal);
    const head = token.slice(0, cut);
    const fraction = token.slice(cut + 1);
    if (head.includes(decimal) || !/^\d+$/.test(fraction)) return null;
    const parts = head.split(grouping);
    return isGrouped(parts) ? `${parts.join("")}.${fraction}` : null;
  }
  const parts = token.split(dots > 0 ? "." : ",");
  if (parts.length > 2) return isGrouped(parts) ? parts.join("") : null;
  const head = parts[0]!;
  const tail = parts[1]!;
  if (!/^\d+$/.test(head) || !/^\d+$/.test(tail)) return null;
  // One separator. Only a three-digit tail can be a thousands group; anything
  // else (6.99, 12,5, 1.2345) is a decimal part, whatever the declared type.
  if (tail.length !== 3) return `${head}.${tail}`;
  // Evidence in the string first, the declared type only when it stays silent.
  if (spaceGrouped) return `${head}.${tail}`; // spaces grouped already; a dot or comma left over is the decimal
  if (head.startsWith("0")) return `${head}.${tail}`; // no convention writes a thousands group of 0
  if (head.length > 3) return `${head}.${tail}`; // grouping would have split the head too
  if (THREE_DECIMAL_CURRENCY.test(text)) return `${head}.${tail}`;
  if (ZERO_DECIMAL_CURRENCY.test(text)) return head + tail;
  if (isMoney(text)) return head + tail; // a currency marker caps the decimals at two
  return hint === "number" ? null : head + tail;
}

/**
 * Reads a number the way a price is written: `6.990` and `12,990` are
 * thousands (Chilean dot grouping and the English comma), `12 990` is the
 * space grouping French, Nordic and Polish sites use, `12.990,50` and
 * `12,990.00` carry a decimal part after the last separator, `6.99` and
 * `12,5` are decimals. Null when there is no number, when the writing belongs
 * to no convention, or when a three-digit tail stays ambiguous under `hint`
 * (see NumberHint). The hint defaults to the conservative `number`.
 */
export function parseNumber(text: string | null | undefined, hint: NumberHint = "number"): number | null {
  const t = squash(text);
  const plain = NUMBER_TOKEN.exec(t);
  if (!plain) return null;
  const spaced = SPACE_GROUPED_TOKEN.exec(t);
  // The first number in the text wins; a space-grouped match starting no later
  // than the plain one is the same number, read whole instead of truncated.
  const spaceGrouped = spaced !== null && spaced.index <= plain.index;
  let token = (spaceGrouped ? spaced![0] : plain[0]).replace(/ /g, "");
  const sign = token.startsWith("-") ? -1 : 1;
  token = token.replace(/^[-+]/, "").replace(/[.,]+$/, "");
  if (!token) return null;
  const normalized = normalizeDigits(token, spaceGrouped, hint, t);
  if (normalized === null) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? sign * value : null;
}

const NO_ACCENTS = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const wordsOf = (s: string): string[] => s.split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Phrases match whole words in sequence, never as substrings: "sin stock" must
 * not read as "in stock". Both lists hold only unnegated phrases \u2014 "no
 * disponible" and "not available" are the TRUE phrase under a negator, which
 * the negation scan below handles, so a real double negative ("no est\u00e1
 * agotado" = not sold out) comes out true instead of inverted.
 */
const FALSE_PHRASES: readonly string[][] = ["agotado", "agotada", "agotados", "agotadas", "sin stock", "sin existencias", "fuera de stock", "out of stock", "sold out", "unavailable"].map(wordsOf);
const TRUE_PHRASES: readonly string[][] = ["en stock", "hay stock", "disponible", "disponibles", "in stock", "available"].map(wordsOf);
/** Words that answer a label cell on their own; they must be the whole value, never a word inside a sentence. */
const FALSE_WORDS = new Set(["no", "false", "0"]);
const TRUE_WORDS = new Set(["si", "yes", "true", "1"]);
const NEGATORS = new Set(["no", "not", "nunca", "never"]);
/** Copulas and adverbs a negator may reach across: "no se encuentra disponible", "no longer available". */
const NEGATION_FILLERS = new Set(["es", "esta", "estan", "se", "encuentra", "ha", "han", "hemos", "sido", "actualmente", "aun", "todavia", "longer", "is", "are", "was", "were", "be", "been", "being", "currently", "yet", "any", "more"]);
/** How far back a negator may sit, in filler words. */
const NEGATION_REACH = 3;

/** True when a negator sits just before word `i`, reaching across fillers only. */
function negatedAt(words: readonly string[], i: number): boolean {
  for (let j = i - 1; j >= 0 && j >= i - NEGATION_REACH; j--) {
    if (NEGATORS.has(words[j]!)) return true;
    if (!NEGATION_FILLERS.has(words[j]!)) return false;
  }
  return false;
}

/** Every phrase reading of the words, with negation applied. */
function phraseVerdicts(words: readonly string[]): boolean[] {
  const verdicts: boolean[] = [];
  const scan = (phrases: readonly string[][], polarity: boolean): void => {
    for (const phrase of phrases) {
      for (let i = 0; i + phrase.length <= words.length; i++) {
        if (phrase.every((w, k) => words[i + k] === w)) verdicts.push(negatedAt(words, i) ? !polarity : polarity);
      }
    }
  };
  scan(TRUE_PHRASES, true);
  scan(FALSE_PHRASES, false);
  return verdicts;
}

/** A bare yes/no cell value, or null when the text is not one. */
function polarityWord(t: string): boolean | null {
  const words = wordsOf(t);
  if (words.length !== 1) return null;
  if (FALSE_WORDS.has(words[0]!)) return false;
  if (TRUE_WORDS.has(words[0]!)) return true;
  return null;
}

/** The value answers the label, so a negative label inverts it: "Agotado: No" is in stock. */
function answerTo(label: string, word: boolean): boolean {
  const verdicts = phraseVerdicts(wordsOf(label));
  const negative = verdicts.length > 0 && verdicts.every((v) => v === false);
  return negative ? !word : word;
}

function booleanOf(t: string, depth: number): boolean | null {
  if (!t) return null;
  // A label cell answers with its value, not with its label: "Disponible: No"
  // and "In stock: 0" are false, however positive the label reads.
  const colon = t.indexOf(":");
  if (depth < 2 && colon > 0) {
    const value = t.slice(colon + 1).trim();
    if (value) {
      const word = polarityWord(value);
      return word === null ? booleanOf(value, depth + 1) : answerTo(t.slice(0, colon), word);
    }
  }
  const bare = polarityWord(t);
  if (bare !== null) return bare;
  // The same cell written with a dash or a pipe: "Disponible - No".
  const trailing = /\s[-\u2013\u2014|/]\s*([a-z0-9]+)\.?$/.exec(t);
  if (trailing) {
    const word = polarityWord(trailing[1]!);
    if (word !== null) return answerTo(t.slice(0, trailing.index), word);
  }
  const verdicts = phraseVerdicts(wordsOf(t));
  if (verdicts.length === 0) return null;
  // Disagreeing phrases ("disponible en tienda, agotado online") say nothing a
  // published price row may rely on.
  return verdicts.every((v) => v === verdicts[0]) ? verdicts[0]! : null;
}

export function parseBoolean(text: string | null | undefined): boolean | null {
  return booleanOf(NO_ACCENTS(squash(text).toLowerCase()), 0);
}

/** R5: the extracted text as the field's declared type; untyped and `text` fields are returned as they are. */
export function coerceValue(value: string | null, type: FieldType | undefined, base?: string): TypedValue {
  if (value === null || type === undefined || type === "text") return value;
  switch (type) {
    case "money":
    case "number":
      return parseNumber(value, type);
    case "integer": {
      const n = parseNumber(value, "integer");
      return n !== null && Number.isInteger(n) ? n : null;
    }
    case "boolean":
      return parseBoolean(value);
    case "url":
      return resolveUrl(value, base ?? value);
  }
}

export function coerceValues(values: Record<string, string | null>, types: Record<string, FieldType | undefined>, base?: string): Record<string, TypedValue> {
  const out: Record<string, TypedValue> = {};
  for (const [name, value] of Object.entries(values)) out[name] = coerceValue(value, types[name], base);
  return out;
}

/** The declared type of every field, top-level and detail. */
export function fieldTypesOf(scraper: CompiledScraper): Record<string, FieldType | undefined> {
  const types: Record<string, FieldType | undefined> = {};
  for (const [name, field] of Object.entries(scraper.fields)) types[name] = field.type;
  for (const [name, field] of Object.entries(scraper.detail?.fields ?? {})) types[name] = field.type;
  return types;
}

// ---------------------------------------------------------------- extraction

interface FieldSpec {
  name: string;
  alternatives: Array<{ selector: string; attr?: string | undefined }>;
}

interface EvaluateArg {
  mode: "list" | "record";
  anchorSelector: string;
  span: number;
  fields: FieldSpec[];
  maxChars: number;
}

interface EvaluateResult {
  baseUri: string;
  /** Per item, per field: the raw value of every alternative, in alternative order. */
  items: Array<{ candidates: Array<Array<string | null>> }>;
}

/** Runs inside the page. Self-contained: Playwright serializes it, so nothing from module scope is referenced. */
function extractInPage(arg: EvaluateArg): EvaluateResult {
  const squashText = (s: string | null | undefined): string => String(s ?? "").replace(/\s+/g, " ").trim();
  const textFragments = (el: Element): string => {
    let s = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) s += n.textContent ?? "";
      else if (n instanceof Element && /^(em|mark|strong|b|i|u|sub|sup)$/.test(n.localName)
        && !n.closest('[aria-hidden="true"],[inert]')
        && n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) s += textFragments(n);
      else s += " ";
    });
    return s;
  };
  const ownText = (el: Element): string => {
    if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && squashText(n.textContent))) return "";
    return squashText(textFragments(el));
  };
  const fullText = (el: Element): string => {
    const html = el as HTMLElement;
    return squashText(typeof html.innerText === "string" ? html.innerText : el.textContent);
  };
  const rowsFor = (anchor: Element, span: number): Element[] => {
    const rows = [anchor];
    let s: Element | null = anchor;
    for (let i = 1; i < span; i++) {
      s = s.nextElementSibling;
      if (!s) break;
      rows.push(s);
    }
    return rows;
  };
  const resolve = (rows: Element[], selector: string, attr: string | undefined): string | null => {
    for (const row of rows) {
      let el: Element | null = null;
      try {
        el = row.matches(selector) ? row : row.querySelector(selector);
      } catch {
        return null;
      }
      if (!el) continue;
      if (attr) {
        const v = el.getAttribute(attr);
        return v === null ? null : squashText(v);
      }
      return (ownText(el) || fullText(el)).slice(0, arg.maxChars);
    }
    return null;
  };
  const itemRows: Element[][] =
    arg.mode === "list" ? Array.from(document.querySelectorAll(arg.anchorSelector)).map((a) => rowsFor(a, arg.span)) : [[document.documentElement]];
  const items = itemRows.map((rows) => ({
    candidates: arg.fields.map((field) => field.alternatives.map((alt) => resolve(rows, alt.selector, alt.attr))),
  }));
  return { baseUri: document.baseURI, items };
}

function nullFilled(names: readonly string[], sourceUrl: string): ItemExtraction {
  return {
    values: Object.fromEntries(names.map((n) => [n, null])),
    resolvedBy: Object.fromEntries(names.map((n) => [n, null])),
    sourceUrl,
  };
}

/**
 * The alternative that resolves a field: the first whose value (a link or
 * media attribute made absolute) fits its fingerprint, else the first with any
 * non-empty value, else none.
 */
function pickAlternative(raws: ReadonlyArray<string | null>, alternatives: readonly FieldAlternative[], baseUri: string): { by: number; value: string | null } | null {
  const resolved = raws.map((raw, i) => {
    if (raw === null || raw === "") return null;
    const attr = alternatives[i]?.attr;
    return attr !== undefined && URL_ATTRS.has(attr) ? resolveUrl(raw, baseUri) : raw;
  });
  let by = resolved.findIndex((value, i) => value !== null && fingerprintMatches(value, alternatives[i]!.fingerprint));
  if (by < 0) by = raws.findIndex((raw) => raw !== null && raw !== "");
  return by < 0 ? null : { by, value: resolved[by] ?? null };
}

/**
 * Extracts one page against a compiled scraper in a single `page.evaluate`.
 * Record mode yields one item; list mode one per item anchor. `values` and
 * `resolvedBy` mirror the first item (null-filled when there is none).
 */
/**
 * The cascade's declared sources, resolved before any selector runs.
 *
 * A declared alternative wins over a DOM one because it is a statement by the
 * site rather than an inference about its styling. Order within the field is
 * still respected -- a scraper that lists a DOM alternative first gets it
 * first -- but a declared alternative that resolves ends the search, exactly as
 * a selector that resolves does.
 */
async function resolveDeclared(
  page: Page,
  alternative: FieldAlternative,
  captured: readonly { url: string; status: number; body: unknown }[],
): Promise<string | null> {
  const source = alternative.source ?? "dom";
  if (source === "dom" || !alternative.path) return null;

  if (source === "network") {
    const match = alternative.match ?? "";
    // Newest first: a page that retries leaves the failure behind too, and Cruz
    // Verde's detail endpoint answers 401 before its anonymous session exists.
    for (let i = captured.length - 1; i >= 0; i -= 1) {
      const response = captured[i]!;
      if (response.status >= 400 || !response.url.includes(match)) continue;
      const value = readJsonPath(response.body, alternative.path);
      if (value !== undefined && value !== null) return String(value);
    }
    return null;
  }

  // json-ld: every block on the page, first one carrying the path.
  const blocks = await page
    .$$eval('script[type="application/ld+json"]', (nodes) => nodes.map((n) => n.textContent ?? ""))
    .catch(() => [] as string[]);
  for (const block of blocks) {
    let parsed: unknown;
    try { parsed = JSON.parse(block.trim()); } catch { continue; }
    const value = readJsonPath(parsed, alternative.path, alternative.entity);
    if (value !== undefined && value !== null) return String(value);
  }
  return null;
}

/** schema.org `@type`, which may be a string or a list of them. */
function isType(node: unknown, entity: string): boolean {
  if (node === null || typeof node !== "object") return false;
  const type = (node as Record<string, unknown>)["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === "string" && t.toLowerCase() === entity.toLowerCase());
}

/**
 * A dotted path, with brackets for a key that contains a dot or a dash --
 * `productData.prices[price-list-std]`, which Store B's payload needs.
 *
 * With `search`, an array or an `@graph` is walked to find the first node the
 * path resolves against, because a site is free to bury its Product node in a
 * graph beside its Organization node, and StoreA does.
 */
function readJsonPath(body: unknown, path: string, entity?: string): unknown {
  const segments = path.replace(/\[([^\]]+)\]/g, ".$1").split(".").filter(Boolean);
  const direct = (node: unknown): unknown => {
    let current = node;
    for (const segment of segments) {
      if (current === null || current === undefined || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  };

  // Without an entity the top-level object is the whole contract: a bare
  // `{"@type":"Product", ...}` block reads directly and nothing is searched.
  if (!entity) return direct(body);
  if (isType(body, entity)) {
    const hit = direct(body);
    if (hit !== undefined) return hit;
  }

  // With one, walk the graph but resolve only against nodes of that type.
  const queue: unknown[] = [body];
  for (let guard = 0; queue.length > 0 && guard < 500; guard += 1) {
    const node = queue.shift();
    if (Array.isArray(node)) { queue.push(...node); continue; }
    if (node === null || typeof node !== "object") continue;
    if (isType(node, entity)) {
      const found = direct(node);
      if (found !== undefined) return found;
    }
    queue.push(...Object.values(node as Record<string, unknown>));
  }
  return undefined;
}

export async function extractPage(page: Page, scraper: CompiledScraper, options: ExtractOptions = {}): Promise<PageExtraction> {
  const sourceUrl = options.sourceUrl ?? page.url();
  const compiled = Object.keys(scraper.fields);
  const requested = options.fields ? [...new Set([...options.fields, ...compiled])] : compiled;
  const captured = options.captured ?? [];

  // Declared sources first: they need no DOM evaluation and cannot be confused
  // by a page that looks the same as another.
  //
  // `resolvedBy` stays an index into the field's own alternatives, whichever
  // source answered, because that is what healing and the summaries read.
  const declared = new Map<string, { value: string; by: number }>();
  for (const name of compiled) {
    const alternatives = scraper.fields[name]!.alternatives;
    for (const [index, alternative] of alternatives.entries()) {
      if ((alternative.source ?? "dom") === "dom") continue;
      const value = await resolveDeclared(page, alternative, captured);
      if (value !== null && value !== "") {
        declared.set(name, { value, by: index });
        break;
      }
    }
  }

  // The DOM pass only sees DOM alternatives, so an index it reports is an index
  // into that subset and has to be mapped back before anyone stores it.
  const domIndexes = new Map<string, number[]>();
  for (const name of compiled) {
    const keep: number[] = [];
    scraper.fields[name]!.alternatives.forEach((a, i) => { if ((a.source ?? "dom") === "dom") keep.push(i); });
    domIndexes.set(name, keep);
  }

  const specs: FieldSpec[] = compiled.map((name) => ({
    name,
    alternatives: domIndexes.get(name)!.map((i) => {
      const a = scraper.fields[name]!.alternatives[i]!;
      return { selector: a.selector, attr: a.attr };
    }),
  }));
  const item = scraper.mode === "list" ? scraper.item : undefined;
  const arg: EvaluateArg = {
    mode: scraper.mode,
    anchorSelector: item?.anchorSelector ?? "",
    span: item?.span ?? 1,
    fields: specs,
    maxChars: MAX_VALUE_CHARS,
  };
  await ensureEvaluateShim(page);
  const result = await page.evaluate(extractInPage, arg);

  const items: ItemExtraction[] = result.items.map((row) => {
    const out = nullFilled(requested, sourceUrl);
    specs.forEach((spec, i) => {
      const fromDeclared = declared.get(spec.name);
      if (fromDeclared) {
        out.values[spec.name] = fromDeclared.value;
        out.resolvedBy[spec.name] = fromDeclared.by;
        return;
      }
      const keep = domIndexes.get(spec.name)!;
      const domAlternatives = keep.map((k) => scraper.fields[spec.name]!.alternatives[k]!);
      const picked = pickAlternative(row.candidates[i] ?? [], domAlternatives, result.baseUri);
      out.values[spec.name] = picked?.value ?? null;
      out.resolvedBy[spec.name] = picked && picked.value !== null ? (keep[picked.by] ?? picked.by) : null;
    });
    return out;
  });
  const first = items[0] ?? nullFilled(requested, sourceUrl);
  return { values: first.values, resolvedBy: first.resolvedBy, sourceUrl, items };
}
