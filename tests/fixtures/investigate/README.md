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

`storea-product-2.html` is the second sample of that same template, and it
exists for the reason `storeb-detail-2.json` exists: a binding is compiled
from a *sample*, and `no-variation-no-field` cannot say anything about one
page. Name, sku, both prices and availability vary; brand, both currencies and
condition are deliberately constant, so a run that asks for `brand` is told it
is describing the site rather than the record.

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

`storeb-detail-3.json` is the third sample, and it exists for the live run
of 2026-09-22 rather than for variation: three samples are the smallest set in
which one page can fail while the other two answer, which is the shape that
broke tier 2's grouping. It is the *healthy* third — the tests pair it with a
third sample whose detail call answers 401 and then 500, to prove the endpoint
survives either way.

`storeb-shell.html` is what one plain fetch against that store actually
returns: almost no visible text, no declaration of a product, and four script
bundles that will fetch the content later. It is what makes
`shell-skips-tier-1` fire, and the cascade skip tier 1 for the whole site
rather than pay for it 25 times. It carries no WAF marker — not even inside its
own comment, because the marker scan reads the raw source and a page with no
product, no text and a challenge marker is a *different* diagnosis.

`laptop-capture.har` is a hand-written HAR 1.2 export (U2e): the traffic one
product page makes, as DevTools would have saved it on a laptop the store
answers. It carries the shapes the importer has to survive rather than any real
capture — an HTML document and a reload of it, a detail endpoint answering 401
before it answers 200, a base64-encoded body, a JSON payload mislabelled
`text/plain`, a CORS preflight, a truncated body, an entry with no `content.text`
and an entry with no response at all. The `SECRET-` strings in its headers,
cookies and query string are there to be tested for: they must not come out the
other side.

## Blocked, drift or healthy (`blocked.ts`)

Five pages off one invented store, because the U3a apology rule is about a
*corpus*: what makes an error page an error page is that it is the same document
at every address.

`apology.html` is the StoreC shape — a page that renders real text, keeps the
store's nav and footer, declares no product, and is served for every URL asked
for. `¡Lo sentimos!` is in it as the example, and nothing in the code looks for
it.

`product.html` and `product-redesign.html` are one product before and after a
redesign: same JSON-LD Product, different markup, different class names, an
extra nav item. The canary has to keep resolving across that gap — a canary
sensitive to drift would report `blocked` on every redesign and stop healing
exactly when healing is what is needed.

`rendered-product.html` and `rendered-product-2.html` are two *different*
products off one template with nothing declared: the case the apology rule must
not call one document. Measured on these fixtures they overlap 0.38 against a
0.92 threshold, while two reads of `apology.html` overlap 1.00.

`challenge-incapsula.html` renders almost nothing — a challenge page has not run
its JavaScript yet — so it is caught by `_Incapsula_Resource` in the source
rather than by anything a reader would see. `forbidden.html` is a bare nginx 403,
where the status is the whole signal.
