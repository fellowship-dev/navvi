/**
 * The one reader of a declared JSON block.
 *
 * "Read a path out of a declared JSON block, optionally only off a node the
 * site typed `Product`" was written four times — `readJsonPath`/`isType` in
 * `scraper/extract.ts`, `typedNodes` in `investigate/declared.ts`, the
 * `json-ld-needs-product-node` gate in `heuristics/rules/bind.ts`, and
 * `readPath` in `browser/network-capture.ts` — and two of those carried
 * comments asserting they agreed. They did not: one accepted an object-shaped
 * `@graph` and three required an array, one compared `@type` accent-folded and
 * two compared it lower-cased, one had a cycle guard and two had none. A block
 * shaped `"@graph": { "@type": "Product", ... }` was bound by replay and
 * refused by the gate that exists to keep replay honest. See
 * `docs/adr/0001-one-declared-json-reader.md`.
 *
 * This module is the single spelling. It sits below `heuristics/` in the import
 * graph — it may import `util/` and nothing else in `src/` — so the gate, the
 * compile and the replay can all reach it without `heuristics/` gaining an
 * upward edge.
 */

/**
 * A dotted path, with brackets for a key that contains a dot or a dash --
 * `productData.prices[price-list-std]`, which Store B's payload needs.
 *
 * Segments are literal keys. Brackets are rewritten to dots before the split,
 * so `a[b-c].d` and `a.b-c.d` address the same value; the bracket form exists
 * because a key carrying a dot would otherwise re-split.
 */
function segmentsOf(path: string): string[] {
  return path
    .replace(/\[([^\]]+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

/** The value at `path`, read straight off `node` with no searching at all. */
function readAt(node: unknown, segments: readonly string[]): unknown {
  let current = node;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** schema.org `@type`, which may be a string or a list of them. */
function typesOf(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.filter((name): name is string => typeof name === "string");
}

/**
 * Is this node typed `entity`?
 *
 * `toLowerCase`, not `normalize`: schema.org type names are ASCII, and
 * accent-folding them is a third way for two readers to disagree about the same
 * block. Accent-folding belongs to *values* — `sameValue` in
 * `heuristics/rules/bind.ts` — where a page really does write a product name
 * two ways.
 */
function isType(node: Record<string, unknown>, entity: string): boolean {
  const wanted = entity.toLowerCase();
  return typesOf(node).some((name) => name.toLowerCase() === wanted);
}

/** A payload is allowed to be recursive, and a block is allowed to be junk. */
const MAX_DEPTH = 8;
const MAX_NODES = 500;
/** Two Products is an ambiguity; fifty is a page that hid a catalogue in a block. */
const MAX_TYPED = 50;

/**
 * Every node of a declared block, in document order — through arrays and
 * `@graph`, and **nowhere else**. `visit` returns `true` to stop the walk.
 *
 * The refusal is the load-bearing half. A page is free to bury its Product
 * beside its Organization (StoreA does), so the walk descends through
 * arrays — a page ships several blocks and a block may itself be a list — and
 * into `@graph`, one block holding several nodes.
 *
 * It deliberately descends nowhere else. A Product hanging off `isSimilarTo`,
 * `isRelatedTo`, `isAccessoryOrSparePartFor` or a `BreadcrumbList` item is a
 * *different* product, and binding to it produces a row with a real name at a
 * price that is not this page's -- the same failure as StoreA,
 * 2026-09-22, where a walk that kept going until something answered bound
 * `productName` to the `Organization` node and returned "StoreA" on all 33
 * URLs that redirect away from their product page. Those rows carried a name, a
 * SKU off the URL and a price from a surviving meta tag, so they passed every
 * "did it extract?" check and would have entered a price index at invented
 * prices. A plausible wrong row is worse than a blank one.
 *
 * `@graph` is accepted as a node object as well as an array of them, because
 * JSON-LD 1.1 §4.9 says its value is either. Three of the four old readings
 * required an array; replay's did not, and replay was the one that matched the
 * spec.
 *
 * Every public function here rides this one walk, so the gate and the read
 * cannot disagree about what is in the block — which is the whole point of the
 * module.
 */
function walkNodes(block: unknown, visit: (node: Record<string, unknown>) => boolean): void {
  const seen = new WeakSet<object>();
  let budget = MAX_NODES;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH || budget <= 0) return false;
    budget -= 1;
    if (Array.isArray(node)) {
      for (const item of node) if (walk(item, depth + 1)) return true;
      return false;
    }
    if (typeof node !== "object" || node === null) return false;
    if (seen.has(node)) return false;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (visit(record)) return true;
    const graph = record["@graph"];
    return graph === undefined ? false : walk(graph, depth + 1);
  };
  walk(block, 0);
}

/** `walkNodes`, stopping only at nodes the site typed `entity`. */
function walkTyped(block: unknown, entity: string, visit: (node: Record<string, unknown>) => boolean): void {
  walkNodes(block, (node) => isType(node, entity) && visit(node));
}

/**
 * Every `@type` the block declares anywhere the walk reaches, de-duplicated and
 * in document order.
 *
 * This is what makes `json-ld-needs-product-node` able to say *"the block
 * declares Organization, WebSite but no Product"* rather than only "no". It
 * rides the same walk, so the gate cannot describe a block the read would see
 * differently.
 */
export function declaredTypes(block: unknown): string[] {
  const found = new Set<string>();
  walkNodes(block, (node) => {
    for (const name of typesOf(node)) found.add(name);
    return false;
  });
  return [...found];
}

/**
 * Every node of `@type` `entity` in the block.
 *
 * All of them, not the first: a page is free to declare two Products, and two
 * nodes disagreeing about `name` is an ambiguity the caller should see rather
 * than one this function resolves by arriving first. Multiplicity is surfaced
 * at compile, where a person or a heuristic can look at it — never resolved at
 * replay, which has to stay deterministic and model-free.
 */
export function typedNodes(block: unknown, entity: string): unknown[] {
  const found: unknown[] = [];
  walkTyped(block, entity, (node) => {
    found.push(node);
    return found.length >= MAX_TYPED;
  });
  return found;
}

/**
 * Does this block declare an `entity` node at all? The gate and the read, one
 * answer.
 *
 * This is `typedNodes(...).length > 0` with the walk stopped at the first hit.
 * It is the question `json-ld-needs-product-node` asks: no Product node means
 * no declared product, and the graph is not then searched for a node that
 * happens to answer.
 */
export function declares(block: unknown, entity: string): boolean {
  let any = false;
  walkTyped(block, entity, () => (any = true));
  return any;
}

/**
 * The value at `path`, read only off a node typed `entity` when one is given.
 *
 * Without an `entity` the top-level object is the whole contract: a bare
 * `{"@type":"Product", ...}` block — and every captured network payload, which
 * has no schema.org typing at all — reads directly and nothing is searched.
 * Guessing is what caused the StoreA defect, so the graph walk is opt-in.
 *
 * With one, the first typed node that carries the path wins. `typedNodes`
 * returns all of them and a second Product disagreeing about `name` is a real
 * ambiguity — but replay is not where it gets resolved. Replay takes the first
 * answer, deterministically, and never refuses or throws on disagreement;
 * `declares` having said yes while this returns `undefined` is not a
 * disagreement about the block, only about the path.
 */
export function readDeclared(block: unknown, path: string, entity?: string): unknown {
  const segments = segmentsOf(path);
  if (!entity) return readAt(block, segments);

  let value: unknown;
  walkTyped(block, entity, (node) => {
    const hit = readAt(node, segments);
    if (hit === undefined) return false;
    value = hit;
    return true;
  });
  return value;
}
