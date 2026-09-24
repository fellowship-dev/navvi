import { z } from "zod";
import { declares, declaredTypes } from "../../declared/json.js";
import { normalize } from "../../util/text.js";
import { define, type AnyHeuristic } from "../types.js";

/**
 * Binding heuristics: collecting candidate values is easy, deciding which one
 * is `listPrice` is not. These narrow the table before Jev is shown it, and
 * four of them reject an answer outright — which is the more valuable half,
 * because a wrong binding passes every "did it extract?" check.
 *
 * Two of those four are a pair, and they are a pair because neither can see
 * what the other can. `no-variation-no-field` catches the value that never
 * changes: the site's own name, arriving as a product name. `machine-value-is-
 * not-a-fact` catches the value at the other end — one that changes on every
 * request, that no reader was ever shown, and that is shaped like a clock
 * reading or a token. Between them, neither has to know what schema.org is.
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
    "Store A, 2026-09-22: the graph walk kept walking until something had a name, found the Organization node, and bound productName to \"Store A\" on all 33 redirect URLs — " +
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
    "Store A, 2026-09-22: productName came back as \"Store A\" on all 33 samples. The generic rule catches it without knowing anything about schema.org, " +
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

/**
 * Shannon entropy per character, in bits.
 *
 * Words repeat letters and are drawn from a small alphabet; a token is drawn
 * from a large one and repeats nothing. This is the only *statistical* signal
 * in the bank, and it is here because the alternative — a list of key names
 * that mean "noise" — is the thing `src/reconcile/schema.ts` refuses to write.
 */
function entropyPerChar(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / text.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

/** A date with a time of day on it. A bare calendar date is left alone: that can be a release date, which is a fact about the record. */
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** The longest run of consecutive letters, case-folded. `gel-frio` is 4; a uuid never reaches 5. */
function longestLetterRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (const character of text) {
    if (/\p{L}/u.test(character)) {
      run += 1;
      if (run > longest) longest = run;
    } else run = 0;
  }
  return longest;
}

/**
 * Is this value shaped like something a machine wrote for itself?
 *
 * Returns the sentence the verdict says out loud, or `null` to abstain. Every
 * test here is on the **value**, never on the key that carried it, and every
 * one of them is conservative on purpose: abstaining leaves a leaf in the
 * catalogue for a reader to dismiss, and firing wrongly deletes a fact.
 */
function readsAsMachinery(value: string | number | boolean | null): string | null {
  if (value === null || typeof value === "boolean") return null;
  const text = String(value).trim();
  if (text === "") return null;

  // 1. An instant. `2026-09-22` is a date and might be a release date;
  //    `2026-09-22T18:04:09Z` is a clock reading, and the only clock running
  //    while a page is being scraped is the one that served it.
  if (INSTANT.test(text)) return `${JSON.stringify(text)} is an instant to the minute or finer — when the response was made, not when anything about the record was`;
  if (/^\d+$/.test(text)) {
    const epoch = text.length === 13 ? Number(text) : text.length === 10 ? Number(text) * 1000 : NaN;
    if (Number.isFinite(epoch) && epoch >= Date.UTC(2001, 0, 1) && epoch <= Date.UTC(2100, 0, 1)) {
      return `${text} reads as epoch ${text.length === 13 ? "milliseconds" : "seconds"} — the instant the response was made`;
    }
    // Any other run of digits is left alone: a sku is a long digit run and so
    // is an internal id, and nothing about the digits tells them apart.
    return null;
  }

  // 2. An opaque token. Four conditions, all structural, all reported.
  if (/\s/.test(text)) return null; // whitespace means it was typed for a person
  if (text.length < 12) return null; // short enough to be a code someone quotes over the phone
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const digits = (text.match(/\d/gu) ?? []).length;
  if (letters === 0 || digits === 0) return null; // one alphabet only is a word or a number, not a token
  if (digits / (letters + digits) < 0.3) return null; // mostly letters: a slug, and a slug names the record
  const run = longestLetterRun(text);
  if (run > 4) return null; // something in here can be read aloud
  const bits = entropyPerChar(text);
  if (bits < 3) return null;
  return `${JSON.stringify(text)} is ${text.length} characters with no word longer than ${run} letter(s) in it, ${Math.round((100 * digits) / (letters + digits))}% digits and ${bits.toFixed(1)} bits of entropy per character — the shape of a token, a hash or a session`;
}

/**
 * Key names that *suggest* machinery. This list decides nothing.
 *
 * `src/reconcile/schema.ts` declines to blacklist key names, and it is right:
 * "guessing which key names are noise is a word list nobody can check". So the
 * list below can never make this rule fire and can never make it abstain. It
 * is only ever appended to a `because` that two pieces of evidence have already
 * earned, so a reader of the manuscript can see that the path agreed — or, more
 * usefully, see a rejection where the path said nothing at all.
 */
const MACHINERY_WORDS = ["session", "token", "csrf", "nonce", "trace", "span", "correlation", "request", "build", "revision", "etag", "hash", "checksum", "telemetry", "analytics", "timestamp", "epoch", "uuid", "guid"];

function namesMachinery(path: string): string | undefined {
  return keyTokens(path).find((token) => MACHINERY_WORDS.includes(token));
}

const machineValueIsNotAFact = define({
  id: "machine-value-is-not-a-fact",
  title: "A value no reader was ever shown, shaped like a token or a clock reading, is the machine's bookkeeping and not a field.",
  stage: "bind",
  decides: "Whether a leaf that survived every other filter may be bound, or belongs in the catalogue as machinery.",
  encounter:
    "Store B, 2026-09-22: the products/detail payload carried `telemetry.renderedAt` = 1758560000000 among its 170 leaves — the millisecond the response was built, " +
    "on no page any reader saw. It changes every request, so `no-variation-no-field` has nothing to say about it, and it coerces to a number, so a spec asking for an integer field could bind it.",
  input: z.object({
    /** Where the value came from — the payload key path or the declared path. Spelled as `InventoryRecord.path` spells it. */
    path: z.string().min(1),
    /** One sample's value per entry. This rule never compares them to each other; that is `no-variation-no-field`'s question. */
    values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1),
    /**
     * Was every sample's value in what that page showed a reader?
     *
     * Handed in, never computed: `anchors()` lives in `investigate/leaves.ts`
     * and `heuristics` is vocabulary — it may not import a stage, and a second
     * copy of the anchor test here is exactly the defect
     * `tests/second-spelling.test.ts` exists to fail. `undefined` means nobody
     * looked, which is a different answer from `false` and is the answer tier 1
     * gives: it does not anchor, on purpose, because a declared sku is never
     * rendered anywhere.
     */
    anchored: z.boolean().optional(),
    /** The requested field this was a candidate for, when it was one. */
    field: z.string().min(1).optional(),
  }),
  evaluate: ({ path, values, anchored, field }) => {
    const subject = field === undefined ? path : `${field} at ${path}`;
    const hinted = namesMachinery(path);
    if (anchored === undefined) {
      return {
        fires: false,
        because: `nothing says whether a reader was shown ${subject}${hinted === undefined ? "" : `, and "${hinted}" in the path is a hint rather than evidence`}`,
      };
    }
    if (anchored) {
      return { fires: false, because: `${subject} is in what every page showed a reader, so whatever else it is, it is not the machine talking to itself` };
    }
    const shapes = values.map((value) => readsAsMachinery(value));
    const abstained = shapes.findIndex((shape) => shape === null);
    if (abstained !== -1) {
      return {
        fires: false,
        because:
          `no page showed ${subject} to a reader, but ${JSON.stringify(String(values[abstained] ?? ""))} is not shaped like machinery` +
          `${hinted === undefined ? "" : `; "${hinted}" in the path is a hint, and this rule does not reject on a key name`}`,
      };
    }
    return {
      fires: true,
      because: `no page showed ${subject} to a reader, and on all ${values.length} sample(s) ${shapes[0]}${hinted === undefined ? "" : `; the path names "${hinted}" too`}`,
      action: "reject this candidate: it is the machine's own bookkeeping — a session, a build, or the instant the request was served — not a fact about the record",
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
  encounter: "Store C, 2026-09-22: the list price was struck through, and the compiled path to it was fourteen levels deep from body.modal-open.",
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
  encounter: "Store A, 2026-09-22: the URL asked for variant 883052 while the page declared its master SKU 8820237; the caller asked for the variant.",
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
 * `productData.prices[price-list-std]` -> ["product", "data", "prices", "price", "list", "std"].
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
    /**
     * The margin, said out loud.
     *
     * The arithmetic above decides a real binding — `listPrice` against
     * `promoPrice` on a page that names both — and the numbers it decided on
     * reached nothing. `because` is carried verbatim into the manuscript and
     * the compile rationale, so a reader could see *that* one key won and
     * never *by how much*: `price-list-std` beating `price-sale-std` 3 to 0 and
     * beating it 3 to 2 printed the same sentence, and only one of those is a
     * binding anybody should be comfortable with.
     *
     * A close call being visible as a close call is the whole of it. What to
     * *do* about a close call — the review's suggestion is Jev as a tie-break
     * over this margin — is a decision that needs the margin recorded first,
     * and it is not made here: nothing in this file asks a model, and a bind
     * rule that did would be a model call inside the thing that exists to
     * decide what a model is even asked.
     */
    const table = scored.map((leaf) => `${leaf.path} ${leaf.score}`).join(", ");
    if (best.score <= 0) return { fires: false, because: `no captured key names ${field}; the leaves score ${table}` };
    if (runnerUp && runnerUp.score === best.score) {
      return { fires: false, because: `${best.path} and ${runnerUp.path} name ${field} equally well, both scoring ${best.score} — a margin of 0; this is the small table Jev should be shown: ${table}` };
    }
    return {
      fires: true,
      because:
        `${best.path} names ${field}, scoring ${best.score}` +
        (runnerUp === undefined
          ? " and the only candidate offered"
          : ` against ${runnerUp.path}'s ${runnerUp.score} — a margin of ${best.score - runnerUp.score} over ${scored.length} candidate(s): ${table}`),
      action: `bind ${field} to ${best.path} (${JSON.stringify(best.value)}) without asking a model to search a DOM for it`,
      pick: best.path,
    };
  },
});

export const BIND_HEURISTICS: readonly AnyHeuristic[] = [jsonLdNeedsProductNode, noVariationNoField, machineValueIsNotAFact, machineAttributeOverText, struckPriceIsPrevious, urlVariantBeatsMaster, keyNamesCarryTheSignal];
