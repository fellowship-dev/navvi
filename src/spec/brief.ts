import { normalize } from "../util/text.js";
import { INPUT_SHAPES, type InputShape } from "./schema.js";

/**
 * The deterministic half of S0. A draft of the spec is written by a model; this
 * file decides how much of it the brief actually supports.
 *
 * The rule throughout: **a claim about the brief is checked against the brief.**
 * The draft must quote the words it read a field or an input shape out of, and
 * a quote that is not in the brief does not count. That verifier is free, it
 * runs before any judgment, and it is what keeps "product info" from quietly
 * becoming six named fields nobody asked for.
 */

/** Words that name a bundle of unknown fields rather than a field. */
const VAGUE_TERMS = [
  "info",
  "information",
  "informacion",
  "data",
  "datos",
  "details",
  "detalles",
  "detail",
  "everything",
  "todo",
  "all",
  "stuff",
  "attributes",
  "atributos",
  "properties",
  "propiedades",
  "product info",
  "product information",
  "product data",
  "product details",
];

/**
 * Words that pin an input shape. A shape claim with no marker in the brief is
 * not a shape the brief stated — "a dynamic set of products" is every shape at
 * once, and choosing one silently is how a link finder gets built for a client
 * who was going to hand over URLs.
 */
const SHAPE_MARKERS: Record<Exclude<InputShape, "unknown">, string[]> = {
  url_list: ["url", "urls", "link", "links", "enlace", "enlaces", "direccion", "direcciones", "http", "address", "page list", "list of pages"],
  sku_list: ["sku", "skus", "code", "codes", "codigo", "codigos", "ean", "upc", "gtin", "barcode", "part number", "reference", "referencia", "id list", "ids"],
  search_terms: ["search", "searching", "query", "queries", "term", "terms", "keyword", "keywords", "buscar", "busqueda", "busquedas", "consulta", "by name", "name of"],
};

/** The brief in the form every comparison here uses. */
export function normalizedBrief(brief: string): string {
  return normalize(brief);
}

/**
 * Does the brief contain these words? Accent- and case-insensitive,
 * whitespace-collapsed, and on word boundaries with a simple plural allowed —
 * "price" is in "prices" but "term" is not in "terminal". A bare substring test
 * makes every short marker a false positive, which matters most for exactly the
 * shape markers a wrong answer here would silently pick.
 */
export function briefContains(brief: string, term: string): boolean {
  const needle = normalize(term);
  if (needle.length === 0) return false;
  const pattern = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:e?s)?\\b`, "u");
  return pattern.test(normalizedBrief(brief));
}

/** A term that names no field even when it is in the brief. */
export function isVague(term: string): boolean {
  const value = normalize(term).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (value.length === 0) return true;
  if (VAGUE_TERMS.includes(value)) return true;
  // "the product info", "all the product data": a vague head with filler around it.
  const words = value.split(" ").filter((word) => !["the", "a", "an", "my", "some", "any", "el", "la", "los", "las", "un", "una", "de", "del"].includes(word));
  return words.length > 0 && VAGUE_TERMS.includes(words.join(" "));
}

/**
 * Did the brief name this field? It must quote the brief, and the quote must be
 * a real field name rather than a bundle word.
 */
export function briefNamesField(brief: string, name: string, briefTerm?: string): boolean {
  const term = briefTerm ?? name;
  if (isVague(term) || isVague(name)) return false;
  if (briefContains(brief, term)) return true;
  // A draft may omit the quote for a field it read straight out of the brief.
  return briefTerm === undefined && briefContains(brief, name.replace(/_/g, " "));
}

/**
 * The brief's own bundle word, when it has one. Quoting it back is what turns
 * "the brief names no field" into "the brief says \"product info\", which names
 * no field" — the same open question, now traceable to the sentence.
 */
export function vagueTermIn(brief: string): string | undefined {
  const byLength = [...VAGUE_TERMS].sort((a, b) => b.length - a.length);
  return byLength.find((term) => briefContains(brief, term));
}

export interface ShapeEvidence {
  shape: InputShape;
  /** The marker found in the brief, when one was. */
  marker?: string;
}

/** Which shapes the brief itself pins, with the word that pins each. */
export function shapesStatedIn(brief: string): ShapeEvidence[] {
  const found: ShapeEvidence[] = [];
  for (const shape of INPUT_SHAPES) {
    if (shape === "unknown") continue;
    const marker = SHAPE_MARKERS[shape].find((word) => briefContains(brief, word));
    if (marker !== undefined) found.push({ shape, marker });
  }
  return found;
}

/**
 * The input shape the brief supports, given what the draft claimed. Unknown
 * when the brief pins nothing, and unknown when it pins more than one: an
 * ambiguity is an open question, not a tie to be broken here.
 */
export function resolveInputShape(brief: string, claimed: InputShape): ShapeEvidence {
  const stated = shapesStatedIn(brief);
  if (stated.length === 1) return stated[0]!;
  if (stated.length > 1) {
    const agreed = stated.find((evidence) => evidence.shape === claimed);
    return agreed ?? { shape: "unknown" };
  }
  return { shape: "unknown" };
}
