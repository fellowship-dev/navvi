# 0001: one reader for a declared JSON block

Decided 2026-09-23. The first ADR in this repository; `docs/adr/` starts here.

## The encounter

StoreA, 2026-09-22: 33 URLs redirect away from their product page to a
shell whose `@graph` holds an Organization and a WebSite and no Product. A
graph walk that kept walking until *something* answered found the Organization
and bound `productName` to `"StoreA"` on all 33 rows — with a SKU off the
URL and a price from a surviving `product:` meta tag, so the rows looked
extracted and would have entered a price index at invented prices.

The fix at the time was the right one: read a path only off a node the site
typed `Product`, and descend only through arrays and `@graph`. It was written
four times.

| | `scraper/extract.ts:527-592`<br>`isType` + `readJsonPath` | `investigate/declared.ts:217-244`<br>`typedNodes` | `heuristics/rules/bind.ts:33-43`<br>the `json-ld-needs-product-node` gate | `browser/network-capture.ts:108-120`<br>`readPath` |
|---|---|---|---|---|
| `@graph` descent | `if (graph !== undefined)` — an **object** counts | `if (Array.isArray(graph))` | `Array.isArray(record["@graph"]) ? … : false` | n/a |
| `@type` compare | `toLowerCase()` | `toLowerCase()` | `normalize()` — NFD, strips combining marks | n/a |
| cycle guard | none; a 500-iteration cap | `WeakSet`, depth 8 | none | n/a |
| result | first match | all matches | boolean | value at path, no entity |

A block shaped `"@graph": { "@type": "Product", … }` was **bound by replay and
refused by the gate** — the gate that exists to keep replay honest saying "this
page declares no product" about a page replay was already binding.

Two of the four carried comments asserting they agreed. `declared.ts:235`: "the
same reading `json-ld-needs-product-node` takes, so the gate and the read
cannot disagree about what is in the block." `extract.ts:555-557`:
"`json-ld-needs-product-node` (bind) and `typedNodes` (investigate) read a block
the same way." They did not. A second spelling with a note saying it is not one
is the worst form of this defect, because the note is what a reviewer reads.

## The rulings

1. **`@graph` accepts a node object as well as an array.** JSON-LD 1.1 §4.9:
   the value of `@graph` is a node object *or* an array of node objects. Three
   readings required an array; replay's did not, and replay was accidentally
   the spec-correct one. **This LOOSENS the gate** — it now says "there is a
   Product here" about blocks it used to refuse. That is deliberate. It is not a
   hole to close: tightening it back re-opens the disagreement between the gate
   and the read, in the direction where the gate blocks a page whose product
   replay can read correctly.
2. **First typed node wins at replay; `typedNodes` still returns all of them.**
   Two Products disagreeing about `name` is a real ambiguity, and compile is
   where a person or a heuristic looks at it. Replay stays deterministic and
   model-free: it takes the first typed node that carries the path and never
   throws, refuses, or picks. (`declares` answering yes while `readDeclared`
   answers `undefined` is not a disagreement about the block — only about
   whether that path is in it.)
3. **`@type` compares with `toLowerCase()`, not `normalize()`.** schema.org type
   names are ASCII; accent-folding them is a third way for two readers to
   disagree about one block, bought for a case that does not exist.
   `normalize` keeps its job comparing *values* — `sameValue` in `bind.ts`,
   where a page really does write one price three ways.
4. **The module is `src/declared/json.ts`, below `src/heuristics/`.** Heuristics
   imported only `src/util/` and must not gain an upward edge, so the shared
   reader imports `src/util/` and nothing else in `src/`. That is what lets the
   gate, the compile and the replay all call it.
5. **`readPath` folds in.** A captured network payload is the same reader with
   no entity: an app's own API response carries no schema.org typing, so
   nothing is searched and the top-level object is the whole contract.
   `readPath`, `pickResponse` and `extractCaptured` stay as names — they are
   separate entry points, and `tests/second-spelling.test.ts` pins that they
   resolve the same capture.

## What survives unchanged

The walk descends through arrays and `@graph` and **nowhere else**. A Product
under `isSimilarTo`, `isRelatedTo`, `isAccessoryOrSparePartFor`, or as a
`BreadcrumbList` item, is a *different* product; binding to it yields a row with
a real name at a price that is not this page's. A plausible wrong row is worse
than a blank one. That refusal is the load-bearing half of the 2026-09-22 fix
and is not negotiable.

## Consequences

- `src/declared/json.ts` exports `typedNodes`, `declares`, `declaredTypes` and
  `readDeclared`. `declares` and `readDeclared` ride one walk, which is the
  whole point.
- No branded `JsonPath`. Every call site passes a `string` off a parsed scraper
  or a schema field, so the brand bought a cast at each of them and validated
  nothing — any string is a path.
- `readJsonPath` and `isType` are gone from `extract.ts`;
  `tests/cascade-extract.test.ts` imports `readDeclared` instead, which is still
  the exact function replay calls.
- `tests/second-spelling.test.ts` grows a source guard: reading `@graph` or
  `@type` off a record is spelled in `src/declared/json.ts` and nowhere under
  `src/`, `tests/`, `scripts/` or `bin/`. A fifth copy fails there rather than
  in a live run.
- `tests/fixtures/heuristics/json-ld-needs-product-node.json` gains the case
  ruling 1 changes: an object-valued `@graph` carrying a Product, which the gate
  now accepts.
