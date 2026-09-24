import { typedNodes } from "../declared/json.js";
import { bank, type Bank, type Verdict } from "../heuristics/index.js";
import { visibleText } from "../heuristics/index.js";
import type { TypedValue } from "../scraper/extract.js";
import type { FieldSource } from "../scraper/schema.js";
import { flatten } from "./leaves.js";

/**
 * U2a: tier 1, what a page declares about itself. One plain HTTP fetch, no
 * browser, no model.
 *
 * On 2026-09-22 the committed Store A scraper was reading a *seasonal* CSS
 * class — `body.one-col.christmas-pattern` — fourteen levels down from `body`,
 * and covering 27-44% of the catalogue. The same page stated its name, sku,
 * brand, list price, promotional price and availability in its own `<meta>`
 * tags and JSON-LD, where no redesign and no December can move them. Reading
 * the declared values instead took three stores to ~100%.
 *
 * navvi could already *replay* a declared source; the compiler had no way to
 * *find* one. This file is the finding, and it is deliberately the cheapest
 * thing in the pipeline: HTML text in, candidates out, pure. Tier 2 (render and
 * capture) and tier 3 (compile a selector) only pay for what this does not
 * cover.
 *
 * Three declarations are read, in descending order of how much structure the
 * site committed to:
 *
 *   json-ld     `<script type="application/ld+json">`, including `@graph`
 *   microdata   `itemscope` / `itemtype` / `itemprop`
 *   meta        the OpenGraph and `product:` namespaces
 *
 * Paths are spelled the way `readDeclared` in `declared/json.ts` reads them
 * back — dotted, brackets for a key carrying a dot or a dash. That is the same
 * constraint `leaves.ts` works under and for the same reason: a path this
 * module can express but the extractor cannot read is a binding the compiler
 * cannot emit. `flatten` is reused rather than re-derived precisely so the two
 * tiers cannot drift into two spellings of one path.
 */

export type DeclaredKind = "json-ld" | "microdata" | "meta";

export interface DeclaredSource {
  /** Which declaration the value came out of. */
  kind: DeclaredKind;
  /**
   * For `json-ld` and `microdata`: the path *relative to the item node*, as
   * `readDeclared` reads it — `offers.price`, `prices[price-list-std]`.
   *
   * For `meta`: the property name, `product:sale_price:amount`. That one is not
   * read back through `readDeclared` (see `source` below); it is the key a
   * binder matches a field name against, and the property name is what the
   * whole OpenGraph namespace is named by.
   */
  path: string;
  /** Exactly as declared. Coercion is the field type's business, not tier 1's. */
  value: TypedValue;
  /**
   * The `FIELD_SOURCES` value an alternative for this finding has to carry.
   *
   * There is no `meta` source and this module does not add one. A `<meta>` tag
   * is an element of the document the plain fetch already returned, so
   * OpenGraph rides in as a **`dom`** alternative — `meta[property="og:title"]`
   * with `attr: "content"` — and that costs nothing, because the selector is an
   * exact attribute match on a `<head>` element: no positional `:nth-of-type`,
   * no state class, no styling utility, nothing the selector gate objects to
   * and nothing a redesign of the visible page can move. Microdata rides in the
   * same way for the same reason. Only JSON-LD gets `source: "json-ld"`,
   * because only JSON-LD needs a payload path and an `entity` to be read at all.
   */
  source: FieldSource;
  /** The alternative's selector: the script tag for `json-ld`, a real CSS selector otherwise. */
  selector: string;
  /** The attribute a `dom` alternative reads; absent means read the element's text. */
  attr?: string;
  /** `json-ld` and `microdata`: the schema.org `@type` the path is read from. */
  entity?: string;
}

export interface DeclaredOptions {
  /** The schema.org type a declared item has to be. Defaults to `Product`. */
  want?: string;
  /** A case's heuristic overrides; the default bank when omitted. */
  view?: Bank;
  /** Stop emitting past this many findings; a category page declares one item per tile. */
  maxSources?: number;
}

export interface DeclaredReading {
  sources: DeclaredSource[];
  /** Every heuristic that had something to say, for the compile rationale. */
  verdicts: Array<{ id: string; verdict: Verdict }>;
}

/** A page that declares more items than this is a listing, and tier 1 is being asked the wrong question. */
const DEFAULT_MAX_SOURCES = 500;

const LD_JSON_SELECTOR = 'script[type="application/ld+json"]';

// ---------------------------------------------------------------- the reading

/**
 * Read every declaration on the page, with the rationale that produced it.
 *
 * `declaredFrom` is the same thing without the rationale; take this one when
 * you have to explain the answer, which for tier 1 is most of the time — "the
 * page declares nothing" and "the page declares an Organization and I refused
 * to read it as a product" are the same empty list and very different facts.
 */
export function readDeclared(html: string, options: DeclaredOptions = {}): DeclaredReading {
  const want = options.want ?? "Product";
  const view = options.view ?? bank();
  const limit = options.maxSources ?? DEFAULT_MAX_SOURCES;
  const tokens = tokenize(html);
  const verdicts: Array<{ id: string; verdict: Verdict }> = [];

  const sources: DeclaredSource[] = [];
  sources.push(...fromJsonLd(tokens, want, view, verdicts));
  sources.push(...fromMicrodata(html, tokens, want));
  sources.push(...fromMeta(tokens));

  return { sources: dedupe(sources).slice(0, limit), verdicts };
}

/** Tier 1 in one call: what this page states about itself, as bindable candidates. */
export function declaredFrom(html: string, options: DeclaredOptions = {}): DeclaredSource[] {
  return readDeclared(html, options).sources;
}

/**
 * Does what the page declared cover the whole spec — i.e. may the run stop here
 * and never open a browser?
 *
 * Takes the *bound* record rather than the raw findings, because "which
 * declared value is `listPrice`" is the binding question `bind.ts` answers and
 * this is only the stopping question. Store A is the case: all six requested
 * fields were stated by the page, so tiers 2 and 3 were pure waste, and the
 * run spent them anyway for want of anyone asking.
 */
export function coversSpec(declared: Record<string, TypedValue>, requested: readonly string[], view: Bank = bank()): Verdict {
  // The heuristic's shape is string | number | null; a declared boolean is
  // still a declaration, so spell it rather than dropping it.
  const flat: Record<string, string | number | null> = {};
  for (const [field, value] of Object.entries(declared)) flat[field] = typeof value === "boolean" ? String(value) : value;
  return view.run("declared-covers-spec", { requested, declared: flat });
}

// ---------------------------------------------------------------- json-ld

/**
 * The declared blocks, parsed. A block that is not JSON is not a declaration;
 * sites ship broken ones and a parse failure must not cost the other blocks.
 */
export function jsonLdBlocks(html: string): unknown[] {
  return parseLdBlocks(tokenize(html));
}

function parseLdBlocks(tokens: readonly Token[]): unknown[] {
  const blocks: unknown[] = [];
  for (const token of tokens) {
    if (token.kind !== "open" || token.name !== "script") continue;
    const type = (token.attrs["type"] ?? "").toLowerCase().trim();
    if (type !== "application/ld+json") continue;
    const text = (token.raw ?? "").trim();
    if (text === "") continue;
    try {
      blocks.push(JSON.parse(text));
    } catch {
      // A block the site itself cannot serialise is not evidence of anything.
    }
  }
  return blocks;
}

function fromJsonLd(tokens: readonly Token[], want: string, view: Bank, verdicts: Array<{ id: string; verdict: Verdict }>): DeclaredSource[] {
  const blocks = parseLdBlocks(tokens);
  if (blocks.length === 0) return [];

  /**
   * The gate, and it is not a formality.
   *
   * Store A, 2026-09-22: 33 URLs redirect away from their product page to a
   * shell whose `@graph` holds an Organization and a WebSite and no Product.
   * A graph walk that keeps walking until *something* answers found the
   * Organization, bound `productName` to `"Store A"`, and — with a sku
   * scraped off the URL and a price from a `product:` meta tag that survived
   * the redirect — produced 33 rows that looked extracted and would have
   * entered a price index.
   *
   * So: no Product node means no declared product. The graph is not searched
   * for a node that happens to answer. Every node this function reads was
   * typed `Product` by the site.
   */
  const verdict = view.run("json-ld-needs-product-node", { jsonLd: blocks, want });
  verdicts.push({ id: "json-ld-needs-product-node", verdict });
  if (verdict.fires) return [];

  const sources: DeclaredSource[] = [];
  for (const block of blocks) {
    for (const node of typedNodes(block, want)) {
      for (const leaf of flatten(node)) {
        // `@context`, `@type`, `@id`: schema.org bookkeeping, not product facts.
        if (leaf.path.split(/[.[]/).some((segment) => segment.startsWith("@"))) continue;
        if (isEmpty(leaf.value)) continue;
        sources.push({ kind: "json-ld", path: leaf.path, value: leaf.value, source: "json-ld", selector: LD_JSON_SELECTOR, entity: want });
      }
    }
  }
  return sources;
}

// ---------------------------------------------------------------- microdata

/**
 * The microdata item tree, built from the tag stream so that `itemprop`
 * scoping is real rather than guessed.
 *
 * A regex over `itemprop=` would happily read the footer's
 * `<span itemprop="name">Store C</span>` as the product name — the
 * same defect as the JSON-LD graph walk, one markup dialect over. An `itemprop`
 * belongs to its nearest enclosing `itemscope` and to nothing else, and that is
 * a stack, so this keeps a stack.
 */
interface MicroItem {
  types: string[];
  props: Array<{ name: string; value: unknown }>;
}

interface Frame {
  tag: string;
  /** The item this element opened, when it carried `itemscope`. */
  item?: MicroItem;
  /** Where that item attaches when it closes, and under which property names. */
  attachTo?: MicroItem;
  attachAs?: string[];
  /** A property whose value is this element's text, waiting for the close tag. */
  pending?: { names: string[]; owner: MicroItem; start: number };
}

/** The attribute microdata reads a property out of, by element. Anything else means text. */
function propertyAttribute(tag: string): string | undefined {
  if (tag === "meta") return "content";
  if (tag === "audio" || tag === "embed" || tag === "iframe" || tag === "img" || tag === "source" || tag === "track" || tag === "video") return "src";
  if (tag === "a" || tag === "area" || tag === "link") return "href";
  if (tag === "object") return "data";
  if (tag === "data" || tag === "meter") return "value";
  if (tag === "time") return "datetime";
  return undefined;
}

function fromMicrodata(html: string, tokens: readonly Token[], want: string): DeclaredSource[] {
  const wanted = want.toLowerCase();
  const roots: MicroItem[] = [];
  const stack: Frame[] = [];
  /**
   * Which attribute each property name was declared in, so the emitted `dom`
   * alternative reads the machine value rather than the rendered one —
   * `content="56799"` over the `"$56.799"` beside it, which a decimal reading
   * turns into fifty-six. Names that disagree across elements lose the
   * attribute and fall back to text, which is the honest answer.
   */
  const attrByName = new Map<string, string | undefined>();
  const noteAttribute = (name: string, attr: string | undefined): void => {
    if (attrByName.has(name) && attrByName.get(name) !== attr) attrByName.set(name, undefined);
    else attrByName.set(name, attr);
  };

  const ownerOf = (): MicroItem | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const item = stack[i]?.item;
      if (item) return item;
    }
    return undefined;
  };

  const closeFrame = (frame: Frame, at: number): void => {
    if (frame.pending) {
      const text = visibleText(html.slice(frame.pending.start, at));
      if (text !== "") {
        for (const name of frame.pending.names) {
          frame.pending.owner.props.push({ name, value: text });
          noteAttribute(name, undefined);
        }
      }
    }
    if (frame.item && frame.attachTo && frame.attachAs && frame.attachAs.length > 0) {
      for (const name of frame.attachAs) frame.attachTo.props.push({ name, value: frame.item });
    }
  };

  for (const token of tokens) {
    if (token.kind === "close") {
      const index = stack.map((frame) => frame.tag).lastIndexOf(token.name);
      // A close tag matching nothing open is a stray; an unclosed <li> closes
      // with its parent. Neither is worth refusing to read the page over.
      if (index === -1) continue;
      for (let i = stack.length - 1; i >= index; i -= 1) closeFrame(stack[i]!, token.start);
      stack.length = index;
      continue;
    }

    const names = (token.attrs["itemprop"] ?? "").split(/\s+/).filter((name) => name !== "");
    const standalone = token.selfClosing || VOID_ELEMENTS.has(token.name) || token.raw !== undefined;
    const frame: Frame = { tag: token.name };

    if ("itemscope" in token.attrs) {
      const item: MicroItem = { types: typeNames(token.attrs["itemtype"] ?? ""), props: [] };
      const owner = ownerOf();
      frame.item = item;
      frame.attachTo = owner;
      frame.attachAs = names;
      // A root item is one no other item contains. Only those are checked
      // against `want`: a nested Offer is read because its Product is.
      if (!owner && item.types.some((name) => name.toLowerCase() === wanted)) roots.push(item);
    } else if (names.length > 0) {
      const owner = ownerOf();
      if (owner) {
        const attr = propertyAttribute(token.name);
        const declared = attr === undefined ? undefined : token.attrs[attr];
        if (declared !== undefined) {
          if (declared.trim() !== "") {
            for (const name of names) {
              owner.props.push({ name, value: declared.trim() });
              noteAttribute(name, attr);
            }
          }
        } else if (!standalone) {
          frame.pending = { names, owner, start: token.end };
        }
      }
    }

    if (!standalone) stack.push(frame);
    else closeFrame(frame, token.end);
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) closeFrame(stack[i]!, html.length);

  const sources: DeclaredSource[] = [];
  for (const root of roots) {
    for (const leaf of flatten(toPlain(root))) {
      if (isEmpty(leaf.value)) continue;
      const segments = propertySegments(leaf.path);
      const last = segments[segments.length - 1] ?? leaf.path;
      const attr = attrByName.get(last);
      sources.push({
        kind: "microdata",
        path: leaf.path,
        value: leaf.value,
        // Like OpenGraph: an `itemprop` is an element of the fetched document,
        // so it rides in as a `dom` alternative on an exact attribute match.
        source: "dom",
        selector: microdataSelector(want, segments),
        ...(attr === undefined ? {} : { attr }),
        entity: want,
      });
    }
  }
  return sources;
}

/** `offers.price` -> ["offers", "price"]; an array index is not a property name. */
function propertySegments(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, "")
    .split(/[.[]/)
    .map((segment) => segment.replace(/\]$/, ""))
    .filter((segment) => segment !== "");
}

/**
 * The whole path, not just its last name: `brand.name` and the product's own
 * `name` are both `itemprop="name"`, and a selector built from the last segment
 * alone binds the brand to the `<h1>`. Nesting the `itemprop` matches the way
 * the item nests keeps them apart —
 * `[itemtype*="/Product"] [itemprop="brand"] [itemprop="name"]`.
 *
 * Array indices are dropped rather than turned into `:nth-of-type`, which the
 * selector gate rejects on sight and rightly: a repeated property's selector
 * points at the first one, and a caller that needs the third should read the
 * path instead of the DOM.
 */
function microdataSelector(want: string, segments: readonly string[]): string {
  const scoped = segments.filter((segment) => !/["'\\]/.test(segment)).map((segment) => `[itemprop="${segment}"]`);
  return [`[itemtype*="/${want}"]`, ...scoped].join(" ");
}

/** `https://schema.org/Product` -> `Product`; an itemtype may list several. */
function typeNames(itemtype: string): string[] {
  return itemtype
    .split(/\s+/)
    .filter((url) => url !== "")
    .map((url) => url.replace(/\/+$/, "").split("/").pop() ?? url);
}

/**
 * The item as a payload `flatten` can walk: one value per property, an array
 * when the page declared the property more than once. That keeps microdata and
 * JSON-LD producing the same path for the same fact — `offers.price` either
 * way — which is the point of routing both through `flatten`.
 */
function toPlain(item: MicroItem): Record<string, unknown> {
  const grouped = new Map<string, unknown[]>();
  for (const { name, value } of item.props) {
    const plain = isMicroItem(value) ? toPlain(value) : value;
    const bucket = grouped.get(name);
    if (bucket) bucket.push(plain);
    else grouped.set(name, [plain]);
  }
  const out: Record<string, unknown> = {};
  for (const [name, values] of grouped) out[name] = values.length === 1 ? values[0] : values;
  return out;
}

function isMicroItem(value: unknown): value is MicroItem {
  return typeof value === "object" && value !== null && Array.isArray((value as MicroItem).props);
}

// ---------------------------------------------------------------- meta

/**
 * The OpenGraph and `product:` namespaces only.
 *
 * Not because the rest of the `<head>` is unreadable, but because it is the
 * same on every page of the site — a description template, a viewport, a
 * verification token — and a value identical across samples is not a field
 * (`no-variation-no-field`). Carrying it would cost the variation check work to
 * reach the answer it already knows.
 *
 * `product:price:amount` and `product:sale_price:amount` are the two Store A
 * was stating all along while the compiled scraper read a Christmas class, and
 * `product:retailer_item_id` is the sku. They are the whole reason this tier
 * pays for itself.
 */
const DECLARED_META = /^(?:og|product):/i;

function fromMeta(tokens: readonly Token[]): DeclaredSource[] {
  const sources: DeclaredSource[] = [];
  for (const token of tokens) {
    if (token.kind !== "open" || token.name !== "meta") continue;
    // `property` is the OpenGraph spelling; plenty of sites emit `name`, and
    // both are read back by the same attribute selector.
    const attribute = token.attrs["property"] !== undefined ? "property" : "name";
    const property = (token.attrs[attribute] ?? "").trim();
    if (property === "" || !DECLARED_META.test(property)) continue;
    const content = token.attrs["content"];
    if (content === undefined || content.trim() === "") continue;
    // A property that would break out of the selector's quoting is not worth
    // the escaping rules; nothing in these two namespaces looks like that.
    if (/["'\\]/.test(property)) continue;
    sources.push({
      kind: "meta",
      path: property,
      value: content.trim(),
      source: "dom",
      selector: `meta[${attribute}="${property}"]`,
      attr: "content",
    });
  }
  return sources;
}

// ---------------------------------------------------------------- plumbing

function isEmpty(value: TypedValue): boolean {
  return value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * The same fact stated twice is one finding. A page that repeats
 * `og:title` in two places is not declaring two names, and the caller should
 * not have to decide between identical rows.
 */
function dedupe(sources: readonly DeclaredSource[]): DeclaredSource[] {
  const seen = new Set<string>();
  const out: DeclaredSource[] = [];
  for (const source of sources) {
    const key = `${source.kind}\u0000${source.path}\u0000${String(source.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

// ---------------------------------------------------------------- tokenizer

/**
 * A tag scanner, not a parser.
 *
 * There is no HTML parser in this dependency tree and tier 1 must not add one:
 * the whole claim of this tier is that it costs one HTTP request and nothing
 * else. What the three readers above need is narrow — attribute values, element
 * nesting depth, and the raw text of a `<script>` — and that is a scan over
 * tags with quote-aware attribute reading. The rest of HTML's grammar is
 * somebody else's problem, and a page this scanner mis-nests degrades to fewer
 * declared findings, never to a wrong one: every reader above still requires
 * the site's own `@type` or `itemtype` before it reads anything.
 */
interface Token {
  kind: "open" | "close";
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  /** Offset of the `<`. */
  start: number;
  /** Offset just past the `>`. */
  end: number;
  /** Raw text of a raw-text element (`script`, `style`), already consumed. */
  raw?: string;
}

const VOID_ELEMENTS: ReadonlySet<string> = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

/** A page with more tags than this is not a product page, and tier 1 is a budget. */
const MAX_TOKENS = 200_000;

const TAG_START = /<(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)/y;
const WHITESPACE = /\s*/y;
const ATTR_NAME = /[^\s=/>]+/y;
const BARE_VALUE = /[^\s>]*/y;

function tokenize(html: string): Token[] {
  const lower = html.toLowerCase();
  const tokens: Token[] = [];
  let i = 0;

  while (i < html.length && tokens.length < MAX_TOKENS) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    TAG_START.lastIndex = lt;
    const head = TAG_START.exec(html);
    if (!head) {
      i = lt + 1;
      continue;
    }
    const closing = head[1] === "/";
    const name = head[2]!.toLowerCase();
    let p = TAG_START.lastIndex;
    const attrs: Record<string, string> = {};
    let selfClosing = false;

    while (p < html.length) {
      WHITESPACE.lastIndex = p;
      WHITESPACE.exec(html);
      p = WHITESPACE.lastIndex;
      const char = html[p];
      if (char === undefined) break;
      if (char === ">") {
        p += 1;
        break;
      }
      if (char === "/") {
        selfClosing = true;
        p += 1;
        continue;
      }
      ATTR_NAME.lastIndex = p;
      const key = ATTR_NAME.exec(html);
      if (!key) {
        p += 1;
        continue;
      }
      p = ATTR_NAME.lastIndex;
      WHITESPACE.lastIndex = p;
      WHITESPACE.exec(html);
      const afterName = WHITESPACE.lastIndex;
      let value = "";
      if (html[afterName] === "=") {
        WHITESPACE.lastIndex = afterName + 1;
        WHITESPACE.exec(html);
        p = WHITESPACE.lastIndex;
        const quote = html[p];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, p + 1);
          value = end === -1 ? html.slice(p + 1) : html.slice(p + 1, end);
          p = end === -1 ? html.length : end + 1;
        } else {
          BARE_VALUE.lastIndex = p;
          value = BARE_VALUE.exec(html)?.[0] ?? "";
          p = BARE_VALUE.lastIndex;
        }
      }
      // A repeated attribute keeps the first value, as a browser does.
      if (!(key[0].toLowerCase() in attrs)) attrs[key[0].toLowerCase()] = decodeEntities(value);
    }

    const token: Token = { kind: closing ? "close" : "open", name, attrs, selfClosing, start: lt, end: p };

    if (!closing && RAW_TEXT_ELEMENTS.has(name) && !selfClosing) {
      // Raw text: the content is not markup, so `<` inside a JSON-LD string
      // must not start a tag. Consume to the matching close tag.
      const close = lower.indexOf(`</${name}`, p);
      token.raw = close === -1 ? html.slice(p) : html.slice(p, close);
      const after = close === -1 ? html.length : html.indexOf(">", close);
      i = after === -1 ? html.length : after + 1;
    } else {
      i = Math.max(p, lt + 1);
    }
    tokens.push(token);
  }
  return tokens;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Enough of the entity table for attribute values: the five XML names, nbsp, and numeric references. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    if (key.startsWith("#")) {
      const code = key.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[key] ?? whole;
  });
}
