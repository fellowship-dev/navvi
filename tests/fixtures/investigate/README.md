# Investigation fixtures

Synthetic, and deliberately so. The *shapes* here were read off live pages on
2026-09-22 — key names, nesting, which tier answers which field — but the
values are invented. navvi is a public repository and a client's catalogue is
not test data; the shape is what the code has to handle, and the shape is
public knowledge the moment you open the page.

`storeb-detail.json` mirrors `api.store-b.example/catalog-svc/products/detail/<id>`:
170 leaves on the live page, of which four are prices and three name a club
promotion. The nesting that matters is `prices` keyed by dashed currency codes
(`price-list-std`), `appliedPromotions` keyed the same way, and a `promotions`
array whose entries carry `isClubPromotion`.

`laptop-capture.har` is a hand-written HAR 1.2 export (U2e): the traffic one
product page makes, as DevTools would have saved it on a laptop the store
answers. It carries the shapes the importer has to survive rather than any real
capture — an HTML document and a reload of it, a detail endpoint answering 401
before it answers 200, a base64-encoded body, a JSON payload mislabelled
`text/plain`, a CORS preflight, a truncated body, an entry with no `content.text`
and an entry with no response at all. The `SECRET-` strings in its headers,
cookies and query string are there to be tested for: they must not come out the
other side.
