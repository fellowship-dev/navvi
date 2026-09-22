# Investigation fixtures

Synthetic, and deliberately so. The *shapes* here were read off live pages on
2026-09-22 — key names, nesting, which tier answers which field — but the
values are invented. navvi is a public repository and a client's catalogue is
not test data; the shape is what the code has to handle, and the shape is
public knowledge the moment you open the page.

## Tier 1, what a page declares about itself (`declared.ts`)

`storea-product.html` is the encounter. The page states name, sku, brand,
list price, sale price and availability in its own `<head>` — a JSON-LD
`@graph` holding Organization, WebSite **and** Product, plus the OpenGraph and
`product:` meta namespaces — while the committed scraper was reading
`body.one-col.christmas-pattern`, which is in the fixture too, fourteen levels
from the answer.

`storea-redirect.html` is the negative case and the reason the JSON-LD gate
exists: an `@graph` with Organization and WebSite and no Product, plus a
`product:price:amount` meta that survived the redirect. A graph walk that keeps
walking until something has a name binds `productName` to `"StoreA"` here,
on all 33 such URLs. Tier 1 must return no declared Product.

`storec-product.html` is a bare JSON-LD Product with the offer nested one
level down, alongside a BreadcrumbList block and one block the site broke.

`microdata-product.html` is the third dialect: `itemscope` / `itemtype` /
`itemprop`, with a nested Offer and a footer Organization whose
`itemprop="name"` a regex would happily read as the product name.

## Tier 2, the payload a page fetches for itself (`leaves.ts`)

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
