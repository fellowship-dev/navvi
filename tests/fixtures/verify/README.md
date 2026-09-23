# `verify` fixtures

Synthetic, for the same reason every other fixture directory here is: navvi is
a public repository and a client's catalogue is not test data. The *shape* is
the one `src/browser/network-capture.ts` records — a product page that ships a
shell and then fetches a JSON document about itself, with the list price and
the sale price as separate leaves under one `prices` object — and every value
below is invented.

One page and three payloads, because what these exist to test is the seam
between a compiled `network` alternative and the visit that has to capture the
response it resolves against.

| URL | what it does |
| --- | --- |
| `payload-product.html?sku=900201` | fetches `payload-900201.json` and renders only the name |
| `payload-product.html?sku=900202` | fetches `payload-900202.json` |
| `payload-product.html?sku=900203` | fetches `payload-900203.json` |
| `payload-product.html` | the same markup, and never fetches anything |

**Nothing renders a price.** That is the point rather than an oversight: a
field bound to `productData.prices[price-list-std]` can only be read from the
captured response, so a replay that took the payload and a replay that did not
differ by the whole value and not by a fallback. A fixture with the prices in
the DOM would pass the verify stage's fill check through a `dom` alternative
and prove nothing about the payload path.

The no-query page is the negative direction, and it has to be the *same* page
to be worth anything: same title, same markup, same settled render, a name in
the heading — everything a harness might mistake for a healthy visit — with no
`payload-` response anywhere in the capture. A scraper replayed against it must
report the zero it measured.
