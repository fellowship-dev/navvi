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

/** The first number in the text: sign, digits, one or two separators. */
const NUMBER_TOKEN = /[-+]?\d[\d.,]*/;

/**
 * Reads a number the way a price is written: `6.990` and `12,990` are
 * thousands (Chilean dot grouping and the English comma), `12.990,50` and
 * `12,990.00` carry a decimal part after the last separator, `6.99` and
 * `12,5` are decimals. Null when there is no number.
 */
export function parseNumber(text: string | null | undefined): number | null {
  const match = NUMBER_TOKEN.exec(squash(text));
  if (!match) return null;
  let token = match[0];
  const sign = token.startsWith("-") ? -1 : 1;
  token = token.replace(/^[-+]/, "").replace(/[.,]$/, "");
  const dots = token.split(".").length - 1;
  const commas = token.split(",").length - 1;
  let normalized: string;
  if (dots > 0 && commas > 0) {
    // the last separator is the decimal one, the other groups thousands
    const decimal = token.lastIndexOf(".") > token.lastIndexOf(",") ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    normalized = token.split(grouping).join("").replace(decimal, ".");
  } else if (dots + commas === 0) {
    normalized = token;
  } else {
    const sep = dots > 0 ? "." : ",";
    const parts = token.split(sep);
    // several separators, or one followed by exactly three digits: thousands grouping
    const grouping = parts.length > 2 || (parts.length === 2 && parts[1]!.length === 3);
    normalized = grouping ? parts.join("") : parts.join(".");
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? sign * value : null;
}

const NO_ACCENTS = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
/** Phrases match anywhere in the text; the negatives go first because "no disponible" contains "disponible". Words match the whole text only. */
const FALSE_PHRASES = ["agotado", "sin stock", "no disponible", "no hay stock", "out of stock", "sold out", "unavailable", "not available"];
const TRUE_PHRASES = ["en stock", "hay stock", "disponible", "in stock", "available"];
const FALSE_WORDS = new Set(["no", "false", "0"]);
const TRUE_WORDS = new Set(["si", "yes", "true", "1"]);

export function parseBoolean(text: string | null | undefined): boolean | null {
  const t = NO_ACCENTS(squash(text).toLowerCase());
  if (!t) return null;
  if (FALSE_WORDS.has(t) || FALSE_PHRASES.some((p) => t.includes(p))) return false;
  if (TRUE_WORDS.has(t) || TRUE_PHRASES.some((p) => t.includes(p))) return true;
  return null;
}

/** R5: the extracted text as the field's declared type; untyped and `text` fields are returned as they are. */
export function coerceValue(value: string | null, type: FieldType | undefined, base?: string): TypedValue {
  if (value === null || type === undefined || type === "text") return value;
  switch (type) {
    case "money":
    case "number":
      return parseNumber(value);
    case "integer": {
      const n = parseNumber(value);
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
export async function extractPage(page: Page, scraper: CompiledScraper, options: ExtractOptions = {}): Promise<PageExtraction> {
  const sourceUrl = options.sourceUrl ?? page.url();
  const compiled = Object.keys(scraper.fields);
  const requested = options.fields ? [...new Set([...options.fields, ...compiled])] : compiled;
  const specs: FieldSpec[] = compiled.map((name) => ({
    name,
    alternatives: scraper.fields[name]!.alternatives.map((a) => ({ selector: a.selector, attr: a.attr })),
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
      const picked = pickAlternative(row.candidates[i] ?? [], scraper.fields[spec.name]!.alternatives, result.baseUri);
      out.values[spec.name] = picked?.value ?? null;
      out.resolvedBy[spec.name] = picked && picked.value !== null ? picked.by : null;
    });
    return out;
  });
  const first = items[0] ?? nullFilled(requested, sourceUrl);
  return { values: first.values, resolvedBy: first.resolvedBy, sourceUrl, items };
}
