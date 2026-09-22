# Discovery: compiling the cheapest way to read a page

Status: **design, not built.** Written 2026-09-22 after the client work exposed
that navvi can replay a declared source but cannot find one.

## The gap

navvi's compiler asks one question — *which DOM node holds this field?* — and
asks it of a rendered page. That is the hardest available question, and it was
being asked for every field of every site.

The client scrapers are what that produces. Three sites, three compiled scrapers,
27–44% product coverage:

```
StoreC    listPrice  :scope > body.modal-open > … > span.value:nth-of-type(1)
StoreA stock      :scope > body.one-col.christmas-pattern > … > div.desc:nth-of-type(2)
Store B listPrice  p.font-semibold.leading-16.leading-22
```

A modal-state class, a seasonal class, and a Tailwind line-height. Meanwhile
StoreA states both prices in its own `<meta>` tags, StoreC states name, SKU,
brand, price and availability in JSON-LD, and Store B's page fetches
`prices: {"price-list-std": 3690, "price-sale-std": 3321}` from its own API.

Reading those instead took the three stores to ~100%. But a person found them,
with curl and a browser script. navvi replayed what that person hand-wrote.

**A scraper maker has to find them itself.** That is this document.

## What "investigate" does

One phase before any compile, cheapest first, stopping as soon as the requested
fields are covered.

```
1. plain fetch          no browser         JSON-LD, OpenGraph, microdata
2. render + capture     browser            the JSON the page fetches for itself
3. compile selectors    browser + model    whatever is still uncovered
```

Tier 1 costs one HTTP request. Tier 2 costs a page load that a dynamic site
needed anyway. Tier 3 is today's compiler, now the exception rather than the
rule.

## Binding fields without guessing

The hard part is not collecting candidate values. It is deciding which one is
`listPrice`. Three prompts failed to make a model pick Store B's list price
out of a rendered page, so the answer cannot be "ask more precisely".

It does not have to be. Discovery has a **free verifier**: the rendered page.

1. **Flatten.** Every leaf of every captured payload and declared block becomes
   a `(path, value)` pair — `productData.prices[price-list-std] = 3690`.
2. **Anchor.** Collect the page's visible text. A leaf whose value appears
   on the page is describing the page. A leaf that does not is metadata,
   telemetry or someone else's product.
3. **Type-check.** A field declared `money` accepts a number or a currency
   string, never a sentence. This is free and removes most candidates.
4. **Require variation.** Compile over several sample URLs and keep only leaves
   whose value *differs between them*.

Step 4 is the one that matters most, and it is not theoretical. The first
cascade run bound StoreA's `productName` to a JSON-LD `name` that was
`"StoreA"` on every page — the Organization node, not the Product. A
variation check kills that automatically, without knowing anything about
schema.org. It is the same rule the client value invariants apply after a compile,
moved to where it prevents the defect instead of detecting it.

What survives is a handful of candidates per field, usually one or two. The
model is then asked to *label* a small table — "which of these is the list
price: `price-list-std` 3690, `price-sale-std` 3321?" — rather than to search a
DOM. Key names carry most of the signal, and the model is the tie-break, not the
search.

Fast, because steps 1–4 are deterministic. Cheap, because one small call
replaces a compile. Intelligent, because it finds the API rather than the pixels.

## What it emits

A scraper whose alternatives are ordered by tier, declared first, selectors
behind — which is what the schema already supports:

```json
{ "source": "network", "match": "products/detail",
  "path": "productData.prices[price-list-std]", "fingerprint": { … } }
{ "selector": "p.font-semibold.leading-16.leading-22", "fingerprint": { … } }
```

Plus a **rationale**: which tiers were tried, what each covered, what was
rejected and why. That is the debugging story. Today, understanding a bad
scraper means opening its JSON and squinting.

## The selector gate

When tier 3 does run, it must refuse what it produced for client. The audit already
exists (`diagnose.js`, to be moved here) and scores: absolute paths from `body`,
positional `:nth-of-type` chains, transient state classes (`modal-open`),
campaign classes (`christmas-pattern`), and selectors made only of styling
utilities. A rotten selector is a recompile, not a commit.

## Healing promotes

StoreC's compiled scraper carried the correct selector all along — healing had
found it and appended it as a secondary alternative while the rotten primary
stayed first. An alternative that keeps working should outrank one that keeps
failing. Purely mechanical, and it would have fixed that store unattended.

## The probe, which is the thing to sell

The same machinery, stopped after step 1, answers a question a prospect asks
before signing: *can you scrape this site, how reliably, and what will it cost?*

```
$ navvi probe https://store-a.example/products/…
tier 1  json-ld + og:  name, sku, brand, listPrice, promoPrice, stock
        no browser required   ~1.5 pages/s   no model calls
```

Seconds, no compile, no commitment. It is roughly half-built already.

## Order of work

1. Move the general code out of the client repo: the declared-data extractor, the
   struck-price rule, the selector audit, the value invariants, the admission
   loop. It is navvi's product sitting in a client's repository.
2. `navvi probe` — tier 1 only. Smallest shippable piece, and it sells.
3. Discovery steps 1–4 with the variation check.
4. The labelling call, and rationale in the compiled scraper.
5. The selector gate and healing promotion.

## What this does not solve

Bot protection is orthogonal and real: Store B sits behind Incapsula and that
cost does not move. A site with no declared data, no API and hostile markup
still needs tier 3 and still deserves a low confidence score — the probe should
say so rather than promise a scraper.
