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
