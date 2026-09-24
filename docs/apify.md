# Running navvi on Apify

The CLI and the Apify actor are the same code. This page covers the actor: its build, its input, proxies and pay-per-event pricing. For the CLI, start at the [README](../README.md).

Locally Navvi runs through the CLI: Camoufox by default, Chromium with
`--browser chromium`, profiles and compiled scrapers under `--storage`
(default `./storage`).

On Apify the same code is the actor under `.actor/`: the manifest, the input
schema (the CLI flags as fields, with section captions and descriptions
written for a model reading them through Apify's MCP server), the dataset
schema and two Dockerfiles. `Dockerfile` is the default build on
`apify/actor-node-playwright-chrome`; `Dockerfile.camoufox` builds on
`apify/actor-node-playwright-camoufox` and is the switch for a site that
challenges Chromium. Both image tags carry the Playwright version and must
equal the `playwright` pin in `package.json`; `node scripts/check-image-pins.mjs`
fails CI when they disagree. CI pushes every green `main` to the `beta` build
tag through `apify/push-actor-action` when the `APIFY_TOKEN` repository
secret is present; `latest` is a manual promote. `node scripts/push-beta.mjs`
pushes the Chromium beta from a signed-in CLI and `--camoufox` pushes the
Camoufox build under the `beta-camoufox` tag of the same version.

The actor input differs from the CLI in three places: `startUrls` takes
`{ url }` and `{ requestsFromUrl }` entries (Apify's request-list editor);
`profile` is `store` only, `chooser` and `decider` are `jev` or `model` and
`writer` is `model` (the image has no CLI to run on a subscription); a caller key
comes as a secret input (`typesafeApiKey`, `gatewayApiKey`,
`anthropicApiKey`) and is used for that run only. `scriptId` pins a compiled
scraper by key, with `scraperStore` naming the key-value store when the key
is bare (default `scraper-cache` in your account). Locally,

```sh
npx apify run --input-file input.json   # runs dist/src/main.js with local storage
```

runs the actor entry with the same input.

## Proxies and residential IPs

Yes: everything Apify Proxy offers is selectable in the Console's proxy editor
and reaches Crawlee. The `proxy` input is Apify's own proxy object, so the
groups and the country you pick survive validation and are handed to
`Actor.createProxyConfiguration`, which Crawlee then rotates per session for
every browser it launches.

```json
{
  "proxy": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"],
    "apifyProxyCountry": "CL"
  }
}
```

In the Console: open **Proxy**, choose **Apify Proxy**, then select the
`RESIDENTIAL` group and, optionally, a country (two-letter code, e.g. `US`,
`CL`). Leaving the groups empty lets Apify pick datacenter proxies
automatically.

- **Residential costs money, by the gigabyte**, billed to your Apify account on
  top of the actor's events — datacenter proxies are the cheap default and are
  included in most plans. Turn residential on for the sites that need it, not
  for every run.
- **It is the fix for `blocked_bot_detection`.** A run that ends there is
  usually being blocked on the IP, not on the page: re-run it with
  `apifyProxyGroups: ["RESIDENTIAL"]`, and on a stubborn site with the Camoufox
  build as well.
- **Residential is not on every plan.** If your account has no access to the
  group you selected, the platform run stops before the browser opens with a
  configuration error that names the group and the country it asked for, so
  the fix is legible instead of a stream of 407s. Locally, where the Apify SDK
  only warns, the run says on stderr that no proxy was created and continues
  without one.
- **Your own proxies go in `proxyUrls`** instead, and are rotated the same way.
  Apify Proxy and your own proxies are one choice, not two layers: asking for
  both is refused at validation (Apify's own `ProxyConfiguration` also refuses
  to combine them) rather than one silently shadowing the other.

## Pay-per-event

On Apify the actor charges four events, priced in the Apify Console, never in
code. Every run ends with a `SUMMARY` record in the run's key-value store
carrying the status, counts, chooser usage, healing events, the `scriptId` to
pin next time, the charged event counts and the zero-data-retention state.

| Event | Charged |
| --- | --- |
| `actor-start` | Once, first thing; covers navigation model spend when the operator key is used |
| `scraper-compiled` | Once per template, the first time a page passes the fingerprint check with a scraper compiled this run; a cache hit charges nothing |
| `page-scraped` | Per scraped page (listing, paginated page, detail page); the limit is checked before every page |
| `result-item` | Per dataset item |

When the run's charge limit is reached the items pushed so far stay in the
dataset and the run ends `charge_limit`. Off the platform nothing is charged
and every count in the summary is zero; a local run with
`ACTOR_TEST_PAY_PER_EVENT=1 ACTOR_USE_CHARGING_LOG_DATASET=1` charges at $1
per event against `ACTOR_MAX_TOTAL_CHARGE_USD` and writes the charging log to
the `charging_log` dataset instead.

Who pays what under pay-per-event, per Apify's pricing docs: the caller pays
the events; the actor's platform usage (compute, residential proxy, storage)
is the operator's cost, which is why the event prices carry a compute margin.
The first platform run under this pricing confirms the split and this
paragraph is updated with the observed numbers.

