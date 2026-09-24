# `navvi make` fixtures

Synthetic, for the same reason every other fixture directory here is: navvi is
a public repository and a client's catalogue is not test data. The *shape* is
the one `../investigate/store-a-product.html` records — a JSON-LD `@graph`
with Organization, WebSite and Product, plus the OpenGraph and `product:` meta
namespaces — and every value below is invented.

Four product pages and no dead page. The catalogue's dead URL is a `404`
answered by the test's own fetch table rather than a file, because a status is
not a document and giving it one would invite the next person to edit the body
of a page nothing ever reads.

| page | list | sale | stratum it stands for |
| --- | --- | --- | --- |
| `analgesico.html` | 3.990 | 3.591 | discounted |
| `antiacido.html` | 7.990 | 6.392 | discounted |
| `antialergico.html` | 5.490 | 5.490 | undiscounted |
| `vitamina-c.html` | 2.490 | 2.490 | undiscounted, and the only one out of stock in its own copy |

Names, skus and both prices vary across the four, which they have to:
`no-variation-no-field` rejects a value that is the same on every sample as
describing the site rather than the record, and a fixture where every page says
the same price would bind nothing and look like a bug in the driver.

`vitamina-c.html` says *"Sin stock"* in its body and `out of stock` in its meta,
but the **probe** does not read either — `probeFrom` sets no `inStock`, so
`classify` cannot place any of these in the `out-of-stock` stratum and the
sample reports it unfilled. That is the honest outcome and the driver's test
asserts it: an unfillable stratum is a statement about what the compile was
never tested against, not a failure.

Tier 1 covers all five requested fields here, so `declared-covers-spec` fires
and the cascade never asks for a capture. That is what lets `tests/make.test.ts`
run the whole pipeline with a `Pages` implementation whose `capture` throws.
