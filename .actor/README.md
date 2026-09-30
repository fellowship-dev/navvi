# Navvi: self-healing scraper compiler

Describe what you want in plain words. Navvi compiles a scraper for the site,
returns the rows, and stores the scraper so the next run replays it with no
model call. When the site changes, it heals the field that moved and reports a
redesign instead of guessing.

![Compile a Hacker News scraper, re-run it with zero model calls, self-heal after a redesign](https://raw.githubusercontent.com/fellowship-dev/navvi/main/docs/product-hn.gif)

Source, CLI and full documentation: [github.com/fellowship-dev/navvi](https://github.com/fellowship-dev/navvi).

## How it works

1. **Compile.** Code enumerates the candidates on the page (elements, links,
   controls). A model only *picks* among them: which element is the price, which
   link is the next page. Model output never becomes a selector or a script, and
   an answer outside the offered options is rejected.
2. **Replay.** The compiled scraper is a JSON file of selectors and
   fingerprints, kept in a key-value store in your account. A later run on the
   same kind of page replays it with no model call.
3. **Heal.** When a page fails its fingerprint check, Navvi asks again for the
   field that moved and updates the scraper (at most 5 healing events a run). A
   page whose layout no longer matches is reported as `drift`.

## Input

A prompt and start URLs are enough. The structured inputs pin the details when
a program calls the actor.

| Input | What it does |
| --- | --- |
| `prompt` | What to extract, in plain words. Optional when `mode` and `fields` are given. Never put credentials in it. |
| `startUrls` | Pages to scrape, public http(s) hosts only. A `requestsFromUrl` entry (or a URL ending in `.txt`, `.json` or `.csv`) is fetched as the page list itself. |
| `mode` | `list` (many rows per page: a listing, search results) or `record` (one row per start URL: a product page). |
| `fields` | Field names, an optional description, and an optional type: `money`, `number`, `integer`, `boolean`, `url`. A value that does not coerce is `null`. |
| `fields[].optional` | A field that may be empty on a healthy page (a list price shown only during a discount). Replay never heals its nulls. |
| `scriptId` | Replay exactly this compiled scraper (the `SUMMARY` of an earlier run names it). Start URLs of another shape are reported as `offTemplate` and never compiled. |
| `scraperStore` | The key-value store the run reads and writes its scrapers in (default: `scraper-cache` in your account). **Pass it by ID**: under limited permissions a store given by name cannot be opened and the run ends `configuration_error`. |
| `maxPages` | The run's page budget (up to 20,000). Every start URL's first page is read regardless. |
| `maxPagesPerStart` | List mode: how many pages one listing may span, its first included (`1` reads only the first page of each search). |
| `maxConcurrency` / `minConcurrency` | Replay pages open at once (default 4, up to 20). A compile always runs one page at a time. |
| `proxy` | Apify Proxy or your own proxy URLs, never both. Choose the `RESIDENTIAL` group when a run ends `blocked_bot_detection`. |

The published actor runs the read-only `store` profile: no logins, no form
submits, no secrets. Keys that are not in the published input schema are
refused with `configuration_error` naming them, not silently dropped.

## Output

**Dataset.** One item per record: the fields you asked for (typed when you
declared a type), plus:

- `_source`: the URL of the page the record was read on (a listing's later
  page, or where a redirect landed);
- `_startUrl`: the start URL that produced it, so a list row joins back to its
  search.

**`SUMMARY` record** in the run's key-value store: `status`, `items`, `pages`,
`templates`, `cacheHit`, `healingEvents`, `fieldsNotFound`, `unhealed`,
`scriptId` (the scraper to pin next time), `chooser` (questions asked, tokens,
cost, and `injectionFlags` when page text was quarantined), `charges` (events
charged this run) and `zeroDataRetention`. Pages that gave no row and were not
healed are accounted for, each present only when non-zero, with a count and the
first 50 URLs:

| Key | Meaning |
| --- | --- |
| `blockedPages` | Bot-challenge pages (a count). |
| `deadPages` | 404/410, or a redirect off the template. |
| `transientPages` | Still 5xx after the retry. |
| `unsettledPages` | A weak challenge reading that did not settle within 5 s. |
| `noPayloadPages` | The page's own data never arrived. |
| `emptyListings` | A list start URL with no items (a search that found nothing). |
| `offTemplate` | Start URLs a pinned scraper does not match. |
| `optionalDrift` | Optional fields filled on some pages and empty on others. |

**Blocked-page evidence.** The first bot-challenge page of a run is kept as
`BLOCKED_PAGE` (HTML), `BLOCKED_PAGE_SCREENSHOT` (PNG) and `BLOCKED_PAGE_META`
(URL, landing URL, HTTP status, title, time), so a block can be checked instead
of trusted. A run where every page was a challenge ends `blocked_bot_detection`.

Run statuses: `succeeded`, `partial` (a requested field was never found; rows
carry it as `null`), `no_items_found`, `blocked_bot_detection`,
`blocked_login_required`, `blocked_no_progress`, `drift`, `charge_limit`,
`budget_exhausted`, `model_unavailable`, `needs_human`, plus
`configuration_error` for input that cannot run.

## Pricing

Pay per event. The prices are the ones shown on this actor's pricing tab.

| Event | Charged |
| --- | --- |
| `actor-start` | Once per run. |
| `scraper-compiled` | Once per template compiled this run. A cached scraper charges nothing. |
| `page-scraped` | Per page read: listing, paginated page or detail page. |
| `result-item` | Per dataset item. |
| `decision` | Per model question answered on the operator's key (compile, navigation, healing, prompt parsing). A run that brings its own key is charged none, and a replay that asks nothing charges none. |

When your charge limit is reached, the items pushed so far stay in the dataset
and the run ends `charge_limit`. A `decision` is checked before the model is
asked, so a spent budget buys no model call.

Bring your own key with `typesafeApiKey`, `gatewayApiKey` (Vercel AI Gateway)
or `anthropicApiKey`: that run pays your provider directly and is charged no
`decision` events. Your key is used for that run only and never written to the
`SUMMARY`.

## Limits

- Up to 20,000 pages and 50,000 items a run; 1,000 pages per listing.
- Navigation before extraction (`goal`): at most 30 steps.
- At most 5 healing events a run.
- Public hosts only: private, loopback and metadata addresses are refused.
- No logins on the published actor. Logged-in scraping is a feature of the
  local [CLI](https://github.com/fellowship-dev/navvi#readme).
- A site that challenges the browser may need residential proxies or the
  Camoufox build.

## Data disclosure

**What reaches a model, and when.** Navvi sends text to a model only when it
asks a question:

- when it **compiles** a scraper for a new kind of page;
- when it **navigates** toward a `goal` (search, open a category);
- when it **heals** a field on a page that drifted;
- when it **parses your prompt** (your own words, no page text).

A question carries an excerpt of the page (its visible text, the candidate
elements or controls, its URL and title) and your prompt, description and
field names. A replay whose pages pass their fingerprint check asks nothing
and sends nothing to any model; a pinned `scriptId` run sends page text only if
a page drifted and healing runs.

**Which providers.** Structured questions go to Jev, TypeSafe's System One
model, over the Vercel AI Gateway or the TypeSafe API
([typesafe.ai](https://typesafe.ai)), or to Claude (Haiku by default, Anthropic) directly
or over the Vercel AI Gateway, depending on the key in use and the `decider`
you pick. Free-text questions (such as the search query to type into a box) go
to Claude through Anthropic or the Gateway, because Jev does not write text.

**Prompt-injection filter first.** Page text passes a local, rule-based filter
before any question is asked. Spans that try to instruct the model are replaced
with a marker, and each cut is counted in `SUMMARY.chooser.injectionFlags`. It
reduces the risk and does not remove it: its measured detection and false
positives are in the
[eval report](https://github.com/fellowship-dev/navvi/blob/main/evals/injection/REPORT.md).

**No secrets.** The published actor accepts no secrets and runs no logins. Your
API keys are removed from the run input before it is recorded and redacted from
error messages. In the CLI, where logins exist, a secret's value is masked out
of the page text a navigation question carries.

**Zero data retention.** On the Gateway, Jev questions request zero data
retention. `SUMMARY.zeroDataRetention` reports what the run can show:
`confirmed` when the Gateway confirmed it for every answer, `unknown` when it
did not (including the direct TypeSafe API, or a run mixing sources),
`not_applicable` when Claude is the only source (zero data retention is not
requested there), and `null` when the run ended before it started crawling. A
Jev run that asked nothing reports `unknown`: there was no answer to confirm.

**Third-party pages stored in your account.**

- `BLOCKED_PAGE` and `BLOCKED_PAGE_SCREENSHOT` keep a copy of a third party's
  page (its HTML and a screenshot) in the run's default key-value store. They
  are kept for as long as your account retains that run's storage.
- A compiled scraper, kept in `scraperStore` (default `scraper-cache`),
  holds selectors, fingerprints and a few sample values read from the page.
  It is a named store and stays until you delete it.
- Dataset rows are the data you asked for, with the URL they came from.
