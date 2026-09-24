import { normalize } from "../util/text.js";
import type { DeclaredKind, DeclaredSource } from "./declared.js";

/**
 * U2c, the half nobody plans for: what a *declared property* is, and which
 * spec field it answers.
 *
 * Tier 2 binds by key names and that works, because a payload's keys are the
 * site's own vocabulary and `key-names-carry-the-signal` reads them
 * (`productData.name` scores two tokens against `productName` while every other
 * leaf under `productData` scores one). Tier 1 is not that, and pretending it is
 * fails in two specific ways that cost an afternoon to find:
 *
 *  1. **`stock` never matches `availability`.** They share no token. A rule
 *     that ranks on key names gives every declared property a score of zero and
 *     sends the cheapest, most reliable field on the page to a model.
 *  2. **`product:` is a namespace, not a word.** Against the field
 *     `productName`, `product:price:amount`, `product:availability` and
 *     `product:retailer_item_id` all score exactly what `name` scores, because
 *     they all carry the token `product`. Five candidates tie and nothing fires.
 *
 * The difference is that a declared vocabulary is **published and finite**.
 * OpenGraph's product namespace and schema.org's `Product`/`Offer` are a fixed
 * list — `product:sale_price:amount` *is* the sale price on every site that
 * emits it — so matching a property to what it means is a lookup, not a search.
 * What varies is what the client calls their column: `stock`, `inStock`,
 * `disponibilidad`. So there are two tables here and they are different kinds
 * of thing: one maps a declared property to a **role** (public vocabulary), the
 * other maps a spec field name to the same roles (client vocabulary).
 *
 * Anything neither table knows falls through to `bindField` over the declared
 * leaves, so an unusual field name is ranked rather than dropped.
 */

/**
 * The facts a product page declares about itself.
 *
 * `price` is deliberately separate from `listPrice` and `salePrice`: schema.org
 * `offers.price` is *what you pay now* and says nothing about whether it is
 * discounted. On the Store A fixture it is 10493, the same number as
 * `product:sale_price:amount` and not the 14990 in the `<del>` — which is
 * exactly why reading it as the list price is the defect this file exists to
 * avoid.
 */
export type DeclaredRole =
  | "name"
  | "sku"
  | "brand"
  | "listPrice"
  | "salePrice"
  | "price"
  | "currency"
  | "availability"
  | "description"
  | "image"
  | "url"
  | "condition";

/**
 * Which declaration wins when two of them state the same role.
 *
 * JSON-LD first, and not for tidiness: it is the only declaration a heuristic
 * vouched for. `json-ld-needs-product-node` refuses a block with no `Product`
 * node, so a JSON-LD finding is known to be about a product. A `<meta>` tag is
 * gated by nothing — Store A's 33 redirect pages carry a surviving
 * `product:price:amount` with no Product anywhere, which is the trap that put
 * 33 fabricated rows into a price index. (The sample chooser keeps those URLs
 * out of the binding set as `dead`; this ordering is the second lock on the
 * same door.)
 */
export const KIND_PRECEDENCE: Readonly<Record<DeclaredKind, number>> = { "json-ld": 0, microdata: 1, meta: 2 };

// --------------------------------------------------- the published vocabulary

/**
 * The OpenGraph and `product:` namespaces, verbatim.
 *
 * `product:price:amount` is the list price **because `product:sale_price:amount`
 * exists beside it**: a namespace that spells the sale price separately means
 * the unqualified one is the undiscounted figure. `og:price:amount` has no such
 * sibling and is only ever "the price", so it gets the unqualified role.
 */
const META_ROLES: Readonly<Record<string, DeclaredRole>> = {
  "og:title": "name",
  "og:description": "description",
  "og:image": "image",
  "og:url": "url",
  "og:price:amount": "price",
  "og:price:currency": "currency",
  "og:availability": "availability",
  "product:brand": "brand",
  "product:price:amount": "listPrice",
  "product:price:currency": "currency",
  "product:sale_price:amount": "salePrice",
  "product:sale_price:currency": "currency",
  "product:original_price:amount": "listPrice",
  "product:availability": "availability",
  "product:condition": "condition",
  "product:retailer_item_id": "sku",
  "product:catalog_item_id": "sku",
  "product:mfr_part_no": "sku",
  "product:gtin": "sku",
  "product:ean": "sku",
  "product:upc": "sku",
  "product:isbn": "sku",
};

/**
 * schema.org, read as a whole path rather than a last segment.
 *
 * `brand.name` and the product's own `name` are both `name`, and the segment
 * alone cannot tell them apart — the same defect `microdataSelector` in
 * `declared.ts` avoids by nesting the `itemprop` match. Array indices are
 * dropped, so `offers[0].price` and `offers.price` are one key.
 */
const NODE_ROLES: Readonly<Record<string, DeclaredRole>> = {
  name: "name",
  description: "description",
  image: "image",
  "image.url": "image",
  url: "url",
  sku: "sku",
  productid: "sku",
  mpn: "sku",
  gtin: "sku",
  gtin8: "sku",
  gtin12: "sku",
  gtin13: "sku",
  gtin14: "sku",
  brand: "brand",
  "brand.name": "brand",
  manufacturer: "brand",
  "manufacturer.name": "brand",
  price: "price",
  pricecurrency: "currency",
  availability: "availability",
  "offers.price": "price",
  "offers.pricecurrency": "currency",
  "offers.availability": "availability",
  "offers.pricespecification.price": "price",
  "offers.pricespecification.pricecurrency": "currency",
  "offers.sku": "sku",
};

/** `offers[0].price` -> `offers.price`, lower-cased: the key both tables are read with. */
function propertyKey(path: string): string {
  return normalize(path.replace(/\[\d+\]/g, "")).replace(/\s+/g, "");
}

/**
 * What this declared finding is *about*, or undefined when neither published
 * vocabulary names it.
 *
 * Undefined is a real answer and the caller must keep it as one: a property
 * this file has never heard of is handed to `bindField` and ranked, never
 * guessed at from a substring.
 */
export function roleOfDeclared(source: Pick<DeclaredSource, "kind" | "path">): DeclaredRole | undefined {
  if (source.kind === "meta") return META_ROLES[normalize(source.path).replace(/\s+/g, "")];
  return NODE_ROLES[propertyKey(source.path)];
}

// ----------------------------------------------------- the client vocabulary

/**
 * A spec field name, in the words a client uses for it.
 *
 * Each term is a token sequence, matched as a contiguous run inside the field's
 * own tokens, and the **longest** matching term wins: `promoPrice` matches
 * `price` (one token, list) and `promo price` (two, sale), and the two-token
 * reading is the one that is actually about this field. A tie goes to the row
 * that appears first here, which is why `brand name` sits under `brand` — a
 * field called `brandName` matches `name` and `brand` equally on one token, and
 * without that row the brand becomes the product name.
 *
 * Bare `price` is `listPrice` rather than `salePrice` on purpose: a client who
 * asks for one price is asking for the one on the shelf edge, and a field that
 * wanted the discounted figure says so.
 */
const FIELD_TERMS: ReadonlyArray<{ role: DeclaredRole; terms: readonly string[] }> = [
  { role: "brand", terms: ["brand", "marca", "brand name", "nombre marca"] },
  { role: "name", terms: ["name", "title", "product name", "nombre", "producto", "titulo"] },
  { role: "sku", terms: ["sku", "id", "code", "codigo", "item id", "product id", "retailer item id", "ean", "upc", "gtin", "mpn", "barcode", "referencia"] },
  {
    role: "salePrice",
    terms: [
      "sale price",
      "promo price",
      "promotional price",
      "offer price",
      "discount price",
      "discounted price",
      "final price",
      "now price",
      "precio oferta",
      "precio promocion",
      "precio final",
      "promo",
      "sale",
      "oferta",
      "descuento",
      "discount",
    ],
  },
  {
    role: "listPrice",
    terms: [
      "list price",
      "regular price",
      "normal price",
      "full price",
      "original price",
      "old price",
      "was price",
      "base price",
      "precio lista",
      "precio normal",
      "precio",
      "price",
    ],
  },
  { role: "availability", terms: ["availability", "available", "stock", "in stock", "instock", "disponibilidad", "disponible", "existencias"] },
  { role: "currency", terms: ["currency", "moneda", "divisa"] },
  { role: "description", terms: ["description", "descripcion", "detalle"] },
  { role: "image", terms: ["image", "imagen", "photo", "foto", "picture"] },
  { role: "url", terms: ["url", "link", "enlace", "permalink", "href"] },
];

/**
 * `productData.prices[price-list-std]` -> ["product","data","prices","price","list","std"].
 * Same split `key-names-carry-the-signal` uses, and deliberately so: a field
 * whose tokens this file reads one way and the bank reads another is a field
 * whose two tiers disagree about what it is called.
 */
export function fieldTokens(name: string): string[] {
  return normalize(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Is `terms` a contiguous run inside `tokens`? */
function contains(tokens: readonly string[], terms: readonly string[]): boolean {
  if (terms.length === 0 || terms.length > tokens.length) return false;
  for (let start = 0; start + terms.length <= tokens.length; start += 1) {
    if (terms.every((term, offset) => tokens[start + offset] === term)) return true;
  }
  return false;
}

/** Which declared fact this spec field is asking for, or undefined when its name says nothing this file knows. */
export function roleOfField(field: string): DeclaredRole | undefined {
  const tokens = fieldTokens(field);
  let best: { role: DeclaredRole; length: number } | undefined;
  for (const { role, terms } of FIELD_TERMS) {
    for (const term of terms) {
      const parts = term.split(" ");
      if (!contains(tokens, parts)) continue;
      // Strictly longer, so an earlier row wins a tie: see `brand name`.
      if (best === undefined || parts.length > best.length) best = { role, length: parts.length };
    }
  }
  return best?.role;
}

/**
 * The roles a field will accept, best first.
 *
 * The fallback chain is where the unqualified `price` role is spent, and it is
 * spent **once**. Store C declares a bare JSON-LD `offers.price` and nothing
 * else: that number is what you pay today, so it answers `promoPrice`, and
 * `listPrice` is left for tier 3 to find under the `<del>` — which is exactly
 * the shape the plan asks Store C to produce. Handing the same leaf to both
 * fields would instead collapse them onto one value, which is the Store B
 * defect of 2026-09-22 arriving one tier earlier.
 *
 * `claimed` is the set of roles an earlier field already took, so the caller
 * resolves fields in a fixed order and this function stays pure.
 */
export function acceptedRoles(field: string, claimed: ReadonlySet<DeclaredRole>): DeclaredRole[] {
  const role = roleOfField(field);
  if (role === undefined) return [];
  if (role === "salePrice") return claimed.has("price") ? ["salePrice"] : ["salePrice", "price"];
  if (role === "listPrice") return claimed.has("price") ? ["listPrice"] : ["listPrice", "price"];
  return [role];
}

/**
 * The order fields are resolved in, so the `price` fallback lands on the
 * sale-sense field rather than on whichever field the spec happened to list
 * first. Stable otherwise: original order within a group.
 */
export function resolutionOrder<T>(fields: readonly T[], nameOf: (field: T) => string): T[] {
  const rank = (field: T): number => {
    const role = roleOfField(nameOf(field));
    if (role === undefined) return 3;
    // Explicitly-named roles first, then the sale sense, then the list sense.
    if (role === "salePrice") return 1;
    if (role === "listPrice") return 2;
    return 0;
  };
  return [...fields].map((field, index) => ({ field, index })).sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index).map((entry) => entry.field);
}
