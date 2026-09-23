# "Not a field" fixtures

Synthetic, like everything under `tests/fixtures/`. The *shape* is the one
StoreA's redirect URLs had on 2026-09-22 — a store landing page served for a
product address, with the `product:` meta namespace of the page you asked for
still attached to it — and every value in them is invented. navvi is a public
repository and a client's catalogue is not test data.

`store-landing-883052.html` and `store-landing-883099.html` are **two different
addresses answering with the same page**. On 33 of StoreA's URLs that is
what a scrape got: the product had gone, the store answered with itself, and
what came back still looked like a product row —

- a **name**, `og:title`, which is the store's own name on every one of them;
- a **price**, `product:price:amount`, a meta tag that survived the redirect and
  is the same number on every one of them;
- a **sku**, `product:retailer_item_id`, which is taken from the address and is
  therefore *different on every one of them*.

That last line is why there are two files instead of one page read twice. A row
where everything is constant is rejected by anything; the question this pair
asks is whether the sku is allowed through while the name and the price are
refused, on the same two pages, in one pass.

Both pages also carry a JSON-LD `@graph` holding Organization and WebSite and no
Product, because that is what the real pages carried. Nothing in
`tests/not-a-field.test.ts` reads it or mentions it: it is there so that the
rejection can be seen happening on the lane the schema.org gate does not cover —
the meta tags — rather than only on the lane it does.
