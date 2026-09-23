import { z } from "zod";
import { declares, declaredTypes } from "../../declared/json.js";
import { normalize } from "../../util/text.js";
import { define, type AnyHeuristic } from "../types.js";

/**
 * Binding heuristics: collecting candidate values is easy, deciding which one
 * is `listPrice` is not. These narrow the table before Jev is shown it, and
 * three of them reject an answer outright — which is the more valuable half,
 * because a wrong binding passes every "did it extract?" check.
 */

/** Everything that is arguably the same value: "3.690", "$3.690", 3690. */
function sameValue(a: unknown, b: unknown): boolean {
  return normalize(String(a ?? "")) === normalize(String(b ?? ""));
}

const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]));

const jsonLdNeedsProductNode = define({
  id: "json-ld-needs-product-node",
  title: "A JSON-LD block with no Product node means no declared product — never search the graph for a node that answers.",
  stage: "bind",
  decides: "Whether declared data may be read at all on this page.",
  encounter:
    "StoreA, 2026-09-22: the graph walk kept walking until something had a name, found the Organization node, and bound productName to \"StoreA\" on all 33 redirect URLs — " +
    "with a SKU from the URL and a price from a surviving meta tag, so the row looked extracted and would have entered a price index.",
  input: z.object({
    jsonLd: z.array(JsonValue),
    /** The schema.org type the field needs. Defaults to Product. */
    want: z.string().min(1).default("Product"),
  }),
  evaluate: ({ jsonLd, want }) => {
    // The gate asks `src/declared/json.ts` — the same walk the compile
    // (`typedNodes`) and the replay (`readDeclared`) ask. It used to keep its
    // own copy, which accepted only an array-shaped `@graph` and compared
    // `@type` accent-folded, so a block shaped `"@graph": {"@type":"Product"}`
    // was refused here and read by replay. The gate and the read are one
    // answer now; see `docs/adr/0001-one-declared-json-reader.md`.
    if (declares(jsonLd, want)) {
      return { fires: false, because: `the block declares a ${want} node; read it` };
    }
    // Nothing of the wanted type: say what the block *did* declare, because
    // "no Product" and "no @type at all" are different pages to a reader.
    const found = declaredTypes(jsonLd);
    return {
      fires: true,
      because: found.length > 0 ? `the block declares ${found.join(", ")} but no ${want} node` : `the block declares no @type at all, so no ${want} node`,
      action: `treat this page as having no declared ${want}: fall through to the next tier rather than walking the graph for any node that answers`,
    };
  },
});

const noVariationNoField = define({
  id: "no-variation-no-field",
  title: "A value identical across every sample is not a field.",
  stage: "bind",
  decides: "Whether a candidate that extracted cleanly is allowed to become a binding.",
  encounter:
    "StoreA, 2026-09-22: productName came back as \"StoreA\" on all 33 samples. The generic rule catches it without knowing anything about schema.org, " +
    "and it is the same invariant the client admission loop applies after a compile, moved to where it prevents the defect instead of detecting it.",
  input: z.object({
    field: z.string().min(1),
    /** One sample's value per entry; at least two samples, or there is nothing to compare. */
    values: z.array(z.union([z.string(), z.number(), z.null()])).min(2),
  }),
  evaluate: ({ field, values }) => {
    const distinct = new Set(values.map((value) => normalize(String(value ?? ""))));
    if (distinct.size > 1) return { fires: false, because: `${field} takes ${distinct.size} distinct values across ${values.length} samples` };
    const [only] = [...distinct];
    return {
      fires: true,
      because: `${field} is ${JSON.stringify(String(values[0] ?? ""))} on all ${values.length} samples${only === "" ? " (and empty)" : ""}`,
      action: "reject this candidate: it is describing the site, not the record",
    };
  },
});

const machineAttributeOverText = define({
  id: "machine-attribute-over-text",
  title: "Prefer a machine attribute (content, itemprop) over rendered text.",
  stage: "bind",
  decides: "Which of two candidates holding the same value becomes the binding.",
  encounter: "2026-09-22: rendered text \"$56.799\" parses to fifty-six under a decimal reading, while the meta tag's content attribute says 56799 and cannot be misread.",
  input: z.object({
    field: z.string().min(1),
    candidates: z
      .array(
        z.object({
          source: z.enum(["attribute", "text"]),
          /** The attribute the value came from, for an attribute candidate. */
          attribute: z.string().optional(),
          value: z.string(),
          selector: z.string().optional(),
        }),
      )
      .min(1),
  }),
  evaluate: ({ field, candidates }) => {
    const attribute = candidates.find((candidate) => candidate.source === "attribute");
    const text = candidates.find((candidate) => candidate.source === "text");
    if (!attribute) return { fires: false, because: `no machine attribute holds ${field} here; rendered text is the only source` };
    if (!text) return { fires: false, because: `only the ${attribute.attribute ?? "attribute"} candidate holds ${field}; there is nothing to prefer it over` };
    const ambiguous = !sameValue(attribute.value, text.value);
    return {
      fires: true,
      because: ambiguous
        ? `${field} reads ${JSON.stringify(attribute.value)} from ${attribute.attribute ?? "an attribute"} and ${JSON.stringify(text.value)} as rendered text; the rendered form is formatted for a person`
        : `${field} is available from ${attribute.attribute ?? "an attribute"} as well as rendered text`,
      action: `bind ${field} to the ${attribute.attribute ?? "attribute"} value: it survives locale, formatting and a redesign of the visible text`,
      pick: attribute.value,
    };
  },
});

/** Markup that says "this price is the previous one" whatever the class names are called this season. */
const STRUCK_TAG = /<\s*(del|s|strike)\b/i;
const STRUCK_CLASS = /\b(?:old|previous|before|was|list|regular|normal|strike|strikethrough|line-through|tachado|antes|anterior)[-_a-z]*\b/i;

const struckPriceIsPrevious = define({
  id: "struck-price-is-previous",
  title: "<del> and strike/old-price classes mean the previous price.",
  stage: "bind",
  decides: "Which of several prices on a page is the list price and which is what you pay today.",
  encounter: "StoreC, 2026-09-22: the list price was struck through, and the compiled path to it was fourteen levels deep from body.modal-open.",
  input: z.object({
    candidates: z.array(z.object({ value: z.string().min(1), markup: z.string(), selector: z.string().optional() })).min(1),
  }),
  evaluate: ({ candidates }) => {
    const struck = candidates.filter((candidate) => STRUCK_TAG.test(candidate.markup) || STRUCK_CLASS.test(candidate.markup));
    if (struck.length === 0) return { fires: false, because: "no candidate is struck through or marked as a previous price" };
    if (struck.length > 1) {
      return { fires: false, because: `${struck.length} candidates are struck through (${struck.map((candidate) => candidate.value).join(", ")}); the page shows more than one previous price and a rubric has to say which` };
    }
    const previous = struck[0]!;
    const current = candidates.find((candidate) => candidate !== previous);
    return {
      fires: true,
      because: `${previous.value} is struck through${current ? `, ${current.value} is not` : ""}`,
      action: `bind the list price to ${previous.value}${current ? ` and the promotional price to ${current.value}` : ""}`,
      pick: previous.value,
    };
  },
});

const urlVariantBeatsMaster = define({
  id: "url-variant-beats-master",
  title: "A variant named in the URL beats the page's master identity.",
  stage: "bind",
  decides: "Which identifier the row is keyed by when the page and the URL disagree.",
  encounter: "StoreA, 2026-09-22: the URL asked for variant 883052 while the page declared its master SKU 8820237; the caller asked for the variant.",
  input: z.object({
    url: z.string().min(1),
    declaredSku: z.union([z.string(), z.number(), z.null()]),
    /** How long a digit run has to be before it is an identifier rather than a page number. */
    minDigits: z.number().int().min(1).default(4),
  }),
  evaluate: ({ url, declaredSku, minDigits }) => {
    const declared = declaredSku === null ? "" : normalize(String(declaredSku));
    const tokens = (url.match(new RegExp(`\\d{${minDigits},}`, "g")) ?? []).filter((token) => token !== declared);
    if (tokens.length === 0) {
      return { fires: false, because: declared === "" ? "the URL names no identifier and the page declares none" : `the URL names no identifier other than the declared ${declared}` };
    }
    // The last long digit run is the addressed item; earlier ones are category or campaign ids.
    const variant = tokens[tokens.length - 1]!;
    return {
      fires: true,
      because: declared === "" ? `the URL names ${variant} and the page declares no sku` : `the URL asks for ${variant}, the page declares ${declared}`,
      action: `key the row by ${variant}: the caller asked for that variant, not for the page's master record`,
      pick: variant,
    };
  },
});

/**
 * The sense a price field is asking for. Key names carry most of the signal —
 * `price-list-std` versus `price-sale-std` is not a hard question — and this is
 * the lexicon that turns that observation into a filter.
 */
const SENSES: Record<string, { self: string[]; opposite: string[] }> = {
  list: {
    self: ["list", "regular", "normal", "was", "old", "previous", "before", "full", "base", "original", "antes", "anterior", "lista"],
    opposite: ["sale", "offer", "promo", "promotion", "oferta", "discount", "descuento", "special", "deal", "now", "final"],
  },
  sale: {
    self: ["sale", "offer", "promo", "promotion", "oferta", "discount", "descuento", "special", "deal", "now", "final"],
    opposite: ["list", "regular", "normal", "was", "old", "previous", "before", "full", "base", "original", "antes", "anterior", "lista"],
  },
};

/**
 * `productData.prices[price-list-std]` -> ["product", "data", "prices", "price", "list", "cl"].
 * camelCase is split before lower-casing, because a payload key is as likely to
 * be `listPrice` as `price-list-std` and a single run-together token matches nothing.
 */
function keyTokens(path: string): string[] {
  return normalize(path.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** `listPrice` -> sense "list"; a field with no sense scores on its own words only. */
function fieldSense(field: string): { sense?: { self: string[]; opposite: string[] }; tokens: string[] } {
  const tokens = keyTokens(field);
  for (const [name, sense] of Object.entries(SENSES)) {
    if (tokens.some((token) => sense.self.includes(token) || token === name)) return { sense, tokens };
  }
  return { tokens };
}

const keyNamesCarryTheSignal = define({
  id: "key-names-carry-the-signal",
  title: "Payload key names carry more signal than position or styling.",
  stage: "bind",
  decides: "Which captured payload leaf a field binds to, before any model is asked.",
  encounter:
    "Store B, 2026-09-22: three increasingly precise prompts could not make a model pick the list price out of the rendered DOM, " +
    "while the page's own products/detail call names them apart — prices: {\"price-list-std\": 3690, \"price-sale-std\": 3321}.",
  input: z.object({
    field: z.string().min(1),
    leaves: z.array(z.object({ path: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) })).min(1),
  }),
  evaluate: ({ field, leaves }) => {
    const { sense, tokens } = fieldSense(field);
    const scored = leaves
      .map((leaf) => {
        const keys = keyTokens(leaf.path);
        let score = 0;
        for (const token of tokens) if (keys.includes(token)) score += 1;
        if (sense) {
          if (keys.some((key) => sense.self.includes(key))) score += 2;
          if (keys.some((key) => sense.opposite.includes(key))) score -= 3;
        }
        return { ...leaf, score };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored[0]!;
    const runnerUp = scored[1];
    if (best.score <= 0) return { fires: false, because: `no captured key names ${field}; the leaves say ${leaves.map((leaf) => leaf.path).join(", ")}` };
    if (runnerUp && runnerUp.score === best.score) {
      return { fires: false, because: `${best.path} and ${runnerUp.path} name ${field} equally well; this is the small table Jev should be shown` };
    }
    return {
      fires: true,
      because: `${best.path} names ${field}${runnerUp ? `, ahead of ${runnerUp.path}` : ""}`,
      action: `bind ${field} to ${best.path} (${JSON.stringify(best.value)}) without asking a model to search a DOM for it`,
      pick: best.path,
    };
  },
});

export const BIND_HEURISTICS: readonly AnyHeuristic[] = [jsonLdNeedsProductNode, noVariationNoField, machineAttributeOverText, struckPriceIsPrevious, urlVariantBeatsMaster, keyNamesCarryTheSignal];
