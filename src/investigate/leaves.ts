import { coerceValue, type TypedValue } from "../scraper/extract.js";
import type { FieldType } from "../input/schema.js";
import { normalize } from "../util/text.js";

/**
 * U2b: the payload a page fetches for itself, flattened into candidates.
 *
 * The hard part of discovery is not collecting values, it is deciding which one
 * is `listPrice`. This file is the deterministic filter that runs before any
 * model is asked: flatten, anchor against what the page shows, type-check, and
 * require variation across samples. What survives is a handful of leaves per
 * field, and the `key-names-carry-the-signal` heuristic ranks those.
 *
 * Paths are emitted in the form `readJsonPath` in `scraper/extract.ts` accepts:
 * dotted, with brackets for a key carrying a dot or a dash. That is not
 * cosmetic — Store B's answer lives at
 * `productData.prices[price-list-std]`, and a path this module cannot express is
 * a binding the compiler cannot emit.
 */

export interface Leaf {
  path: string;
  value: TypedValue;
}

export interface FlattenOptions {
  /** Stop descending past this depth; a payload is allowed to be recursive. */
  maxDepth?: number;
  /** Stop collecting past this many leaves; Contentful answers with thousands. */
  maxLeaves?: number;
}

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_LEAVES = 5_000;

/** A key that needs brackets rather than a dot, because a dot would re-split it. */
function needsBrackets(key: string): boolean {
  return !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function join(parent: string, key: string): string {
  if (parent === "") return needsBrackets(key) ? `[${key}]` : key;
  return needsBrackets(key) ? `${parent}[${key}]` : `${parent}.${key}`;
}

/** Every scalar in a payload, as a path the compiled scraper can read back. */
export function flatten(json: unknown, options: FlattenOptions = {}): Leaf[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxLeaves = options.maxLeaves ?? DEFAULT_MAX_LEAVES;
  const out: Leaf[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string, depth: number): void => {
    if (out.length >= maxLeaves) return;
    if (node === null || typeof node !== "object") {
      // undefined never survives JSON, so anything else here is a scalar.
      if (typeof node === "string" || typeof node === "number" || typeof node === "boolean" || node === null) {
        if (path !== "") out.push({ path, value: node });
      }
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    if (depth >= maxDepth) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, join(path, key), depth + 1);
    }
  };

  walk(json, "", 0);
  return out;
}

// ---------------------------------------------------------------- narrowing

/**
 * Does this value appear in what the page shows a reader? A leaf whose value is
 * on the page is describing the page; one that is not is telemetry, a
 * configuration constant, or someone else's product.
 *
 * Numbers are compared through the page's own formatting as well as bare, so
 * `3690` anchors against `$ 3.690` — which is the whole reason the check is
 * worth doing on a Chilean pharmacy.
 */
export function anchors(value: TypedValue, pageText: string): boolean {
  if (value === null || value === "") return false;
  const haystack = normalize(pageText);
  const raw = normalize(String(value));
  if (raw.length === 0) return false;
  if (haystack.includes(raw)) return true;
  if (typeof value === "boolean") return false;
  const digits = String(value).replace(/[^\d]/g, "");
  if (digits.length < 3) return false;
  // The same digits under any thousands separator the page might use.
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, "[.,  ]?");
  return new RegExp(grouped).test(haystack.replace(/\s+/g, " "));
}

/**
 * Can this value be read as the field's declared type without becoming null?
 *
 * Stricter than replay's coercion on purpose. `parseNumber` is built to pull a
 * price out of whatever a page renders around it, which is right when you
 * already know the node holds a price and wrong here: it reads
 * "Ejemplo Comprimidos 100 mg" as 100 and lets a product name compete for
 * `listPrice`. A candidate for a numeric field has to *be* a number, give or
 * take a currency mark.
 */
export function typeMatches(value: TypedValue, type: FieldType | undefined): boolean {
  if (value === null) return false;
  if (type === undefined || type === "text") return String(value).trim().length > 0;
  if (type === "money" || type === "number" || type === "integer") {
    if (typeof value === "boolean") return false;
    if (typeof value !== "number") {
      const bare = String(value)
        .replace(/[$€£]|\b(?:CLP|USD|EUR)\b/gi, "")
        .trim();
      if (bare.length === 0 || /[A-Za-zÀ-ÿ]/.test(bare)) return false;
    }
  }
  return coerceValue(String(value), type) !== null;
}

export interface NarrowOptions {
  /** The declared output type the field must coerce to. */
  type?: FieldType | undefined;
  /** Visible text per sample, in the same order as `samples`. Omit to skip anchoring. */
  pageText?: readonly string[] | undefined;
  /** Reject a leaf whose value is the same on every sample (U8b: not a field). */
  requireVariation?: boolean;
}

export interface Candidate {
  path: string;
  /** The value on each sample, in sample order. */
  values: TypedValue[];
  /**
   * Other paths carrying exactly these values on every sample. A payload often
   * states one fact twice — Store B's sale price is both
   * `prices[price-sale-std]` and `appliedPromotions[price-sale-std].promotionalPrice`
   * — and two spellings of one fact are not an ambiguity to send to a model.
   * They are free alternatives for the compiled scraper.
   */
  aliases: string[];
}

/**
 * The deterministic filter, over one flattened payload per sample.
 *
 * A leaf survives when it is present on every sample, coerces to the field's
 * type, appears in what each page showed, and does not hold the same value
 * everywhere. Each of those four is free, and together they take a 170-leaf
 * payload down to the two or three a model should be shown.
 */
export function narrow(samples: readonly Leaf[][], options: NarrowOptions = {}): Candidate[] {
  if (samples.length === 0) return [];
  const byPath = new Map<string, TypedValue[]>();
  for (const [index, leaves] of samples.entries()) {
    for (const leaf of leaves) {
      let values = byPath.get(leaf.path);
      if (!values) byPath.set(leaf.path, (values = Array(samples.length).fill(undefined) as TypedValue[]));
      values[index] = leaf.value;
    }
  }

  const candidates: Candidate[] = [];
  for (const [path, values] of byPath) {
    // Present on every sample: a path that appears on one page is not a binding.
    if (values.some((value) => value === undefined)) continue;
    if (!values.every((value) => typeMatches(value, options.type))) continue;
    if (options.pageText) {
      const texts = options.pageText;
      if (!values.every((value, index) => anchors(value, texts[index] ?? ""))) continue;
    }
    if (options.requireVariation !== false && samples.length > 1) {
      const distinct = new Set(values.map((value) => normalize(String(value ?? ""))));
      if (distinct.size === 1) continue;
    }
    candidates.push({ path, values, aliases: [] });
  }
  return collapseAliases(candidates);
}

/** Depth first, then length: the shallowest spelling of a fact is the stablest one. */
function shallower(a: string, b: string): number {
  const depth = (path: string): number => (path.match(/[.[]/g) ?? []).length;
  return depth(a) - depth(b) || a.length - b.length || a.localeCompare(b);
}

/**
 * Candidates agreeing on every sample are one fact. The shallowest path leads
 * and the rest become its aliases, so the table a model sees holds distinct
 * values rather than distinct spellings.
 */
function collapseAliases(candidates: readonly Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate.values.map((value) => normalize(String(value ?? ""))));
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  const out: Candidate[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => shallower(a.path, b.path));
    const [primary, ...rest] = sorted;
    out.push({ ...primary!, aliases: rest.map((candidate) => candidate.path) });
  }
  return out;
}
