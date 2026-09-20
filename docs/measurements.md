# Measurements

The same scenarios, once per chooser, in one table. The README's "with and
without Jev" comparison is generated from this table by
`renderReadmeSection` in `src/measure/report.ts`; nothing in it is typed by
hand.

## Reproduce

```sh
npm run measure -- --choosers agent,jev,claude                       # fixture set, keys and CLIs as available
npm run measure -- --choosers agent,jev,claude --live python.org,quotes-login   # plus live sites per chooser
npm run measure -- --choosers agent --offline                        # what CI can run: no key, no network
npm run measure -- --choosers agent --offline --bank                 # also write the question bank (docs/jev-hillclimb.md)
npm run measure -- --scenarios F1-search,F2-login --choosers jev     # a subset
```

The harness (`src/measure/run.ts`) runs each scenario sequentially with a
fresh temporary store and Chromium, then rewrites only the block between
the two `measurements:start` / `measurements:end` HTML-comment markers
at the end of this file (each on a line of its own). Prose
outside the markers is kept.

## Scenarios

| id | page | what is measured |
|---|---|---|
| AE1 | `tests/fixtures/python-jobs.html` (list) | compile five fields, extract 25 rows |
| AE7 | `demo/pharmacy-v1` product pages (record) | compile four fields on three samples, record 12 products |
| AE8 | `demo/pharmacy` v1 then v2 under the same URLs | the cached scraper heals every field; price is null on the two out-of-stock pages |
| AE15 | `demo/login` with the button renamed | a seeded login trace re-decides the renamed step and the orders list extracts |
| F1-search | `tests/fixtures/search-form.html` then `results.html` | goal "search for python jobs": type the query, submit, compile the six results |
| F2-login | `demo/login` from scratch, profile `local` | goal with `{{secret:username}}` and `{{secret:password}}`: fill both, submit, compile the five orders |
| F3-category | `tests/fixtures/categories.html` | goal "open the Python category": click the link, compile the 25-job listing behind it |
| F4-paginate | `tests/fixtures/python-jobs-1.html` to `-5` | compile the next link, follow three pages of five, stop on the two empty ones: 14 rows |
| F5-detail | `tests/fixtures/python-jobs.html` and `jobs/*.html` | compile the per-item link and the description on three detail pages, merge into 25 rows |
| live:`<site>` | see below | one run over the network per site (`--live a,b`) |

Live sites (`--live`): `python.org` and `hackernews` (plain lists),
`scrapethissite-search` (a search form: "search for teams named Rangers",
then the results table), `quotes-login` (a login form with any credentials,
then the quotes list, profile `local`), `books-category` ("open the Travel
category", then the eleven books). scrapethissite.com and toscrape.com are
sandboxes published for scraping practice.

## Columns

- **questions**: choices the chooser was asked (R37); every one is over
  code-enumerated options plus `none`.
- **input tokens**: what the chooser read. Live choosers report their own
  count; the recorded replay reports none, so the `agent` column carries an
  estimate at 4 characters per token of the questions shown.
- **chooser wait (ms)**: wall time spent waiting on the chooser, retries
  included.
- **total wall (ms)**: the whole scenario, browser launch and pages included.
- **cost (USD)**: at list price. Jev: $0.042 per million input tokens, output
  free. Model: the `MODEL_PRICES` table in `src/chooser/model.ts` (default
  model `claude-haiku-4-5` at $1 in, $5 out per million).
- **fields correct**: correct cells over expected cells (rows x fields). A
  cell is correct when it holds what the page promises: non-null, a link
  matching the fixture, or null where the page has nothing (AE8's
  out-of-stock prices).
- **healing events**: alternatives appended after drift (R17, R42).
- **status**: `ok`, `failed`, or `skipped: <reason>`.

## Honesty notes

- **`agent` is a recorded replay unless `--agent-live` is passed.** The rows
  replay the answers a scripted host agent gave once
  (`tests/recorded/**`), so the wait is the replay's own file reads, not a
  person's or a host model's think time, and the cost is zero because the
  host pays for its own tokens. `--agent-live` runs the real `AgentChooser`
  over stdio and needs someone (or a host agent) attending.
- **`jev` and `model` run only when their key is present**
  (`AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`; `ANTHROPIC_API_KEY`).
  Without one the row is `skipped: no key`. A live run also refreshes the
  recordings under `tests/recorded/measure/<scenario>/<chooser>/`.
- **Live rows need the network.** Without it, or with `--offline`, they are
  skipped with the reason. The `agent` column never runs a live site unless
  `--agent-live` is passed: there is no recording to replay.
- **The flow scenarios' agent answers (F1 to F5) were proposed by Claude
  Haiku and checked one by one by the host agent** against the questions in
  the bank before being promoted to `tests/recorded/flows/**`; the grading
  proves them (every cell right). The first four scenarios replay the
  answers a scripted host agent gave in the first session.
- **`jev` answers text questions through a fallback**: a model key when one
  is set, else an installed CLI (Claude Code here). F1's typed query is the
  one text question in the set; its wait and tokens count in the `jev` row.
- Numbers below are from the last run on the machine that ran it; wall
  times vary with the machine.

## Before the Jev hillclimb

The same harness on 2026-09-19 before `docs/jev-hillclimb.md`, four
scenarios, Jev with a bare premise and raw option strings. The list compile
(AE1) flipped between runs (0/125 in the first live measurement, 125/125 in
this one); field healing (AE8) lost 38 of 48 cells to `none`.

| chooser | scenario | questions | input tokens | chooser wait (ms) | total wall (ms) | cost (USD) | fields correct | healing events | status |
|---|---|---|---|---|---|---|---|---|---|
| agent | AE1 | 7 | 1392 | 1 | 2617 | 0.000000 | 125/125 | 0 | ok |
| agent | AE7 | 4 | 5789 | 0 | 4265 | 0.000000 | 48/48 | 0 | ok |
| agent | AE8 | 9 | 7225 | 1 | 6730 | 0.000000 | 48/48 | 1 | ok |
| agent | AE15 | 1 | 105 | 0 | 11217 | 0.000000 | 10/10 | 1 | ok |
| jev | AE1 | 7 | 2675 | 1118 | 3620 | 0.000112 | 125/125 | 0 | ok |
| jev | AE7 | 4 | 10325 | 596 | 4883 | 0.000434 | 48/48 | 0 | ok |
| jev | AE8 | 15 | 16277 | 2418 | 9084 | 0.000684 | 10/48 | 1 | failed |
| jev | AE15 | 1 | 441 | 887 | 12104 | 0.000019 | 10/10 | 1 | ok |
| claude | AE1 | 7 | 20 | 15261 | 17753 | 0.000000 | 125/125 | 0 | ok |
| claude | AE7 | 4 | 10 | 6562 | 10748 | 0.000000 | 48/48 | 0 | ok |
| claude | AE8 | 9 | 30 | 43234 | 49857 | 0.000000 | 46/48 | 2 | ok |
| claude | AE15 | 1 | 10 | 5128 | 16329 | 0.000000 | 10/10 | 1 | ok |

## After

Every row below is from one run of the harness after the hillclimb.


<!-- measurements:start -->
| chooser | scenario | questions | input tokens | chooser wait (ms) | total wall (ms) | cost (USD) | fields correct | healing events | status |
|---|---|---|---|---|---|---|---|---|---|
| agent | AE1 | 7 | 1392 | 1 | 2634 | 0.000000 | 125/125 | 0 | ok |
| agent | AE7 | 4 | 5789 | 0 | 4164 | 0.000000 | 48/48 | 0 | ok |
| agent | AE8 | 9 | 7225 | 1 | 6503 | 0.000000 | 48/48 | 1 | ok |
| agent | AE15 | 1 | 105 | 0 | 11194 | 0.000000 | 10/10 | 1 | ok |
| agent | F1-search | 15 | 4083 | 1 | 4515 | 0.000000 | 18/18 | 0 | ok |
| agent | F2-login | 15 | 4437 | 1 | 4446 | 0.000000 | 10/10 | 0 | ok |
| agent | F3-category | 11 | 8105 | 1 | 2561 | 0.000000 | 100/100 | 0 | ok |
| agent | F4-paginate | 6 | 1099 | 0 | 3518 | 0.000000 | 56/56 | 0 | ok |
| agent | F5-detail | 6 | 1157 | 0 | 4695 | 0.000000 | 75/75 | 0 | ok |
| agent | live:python.org | 0 | 0 | 0 | 0 | 0.000000 | 0/0 | 0 | skipped: agent column is a recorded replay; pass --agent-live to measure a host agent on a live site |
| agent | live:hackernews | 0 | 0 | 0 | 0 | 0.000000 | 0/0 | 0 | skipped: agent column is a recorded replay; pass --agent-live to measure a host agent on a live site |
| agent | live:scrapethissite-search | 0 | 0 | 0 | 0 | 0.000000 | 0/0 | 0 | skipped: agent column is a recorded replay; pass --agent-live to measure a host agent on a live site |
| agent | live:quotes-login | 0 | 0 | 0 | 0 | 0.000000 | 0/0 | 0 | skipped: agent column is a recorded replay; pass --agent-live to measure a host agent on a live site |
| agent | live:books-category | 0 | 0 | 0 | 0 | 0.000000 | 0/0 | 0 | skipped: agent column is a recorded replay; pass --agent-live to measure a host agent on a live site |
| jev | AE1 | 7 | 4415 | 1193 | 3643 | 0.000185 | 125/125 | 0 | ok |
| jev | AE7 | 4 | 18017 | 576 | 4729 | 0.000757 | 48/48 | 0 | ok |
| jev | AE8 | 9 | 26702 | 1997 | 8487 | 0.001121 | 48/48 | 1 | ok |
| jev | AE15 | 1 | 583 | 730 | 11908 | 0.000024 | 10/10 | 1 | ok |
| jev | F1-search | 14 | 8348 | 2380 | 12228 | 0.000351 | 18/18 | 0 | ok |
| jev | F2-login | 15 | 8701 | 2363 | 6693 | 0.000365 | 10/10 | 0 | ok |
| jev | F3-category | 11 | 15951 | 1906 | 4204 | 0.000670 | 100/100 | 0 | ok |
| jev | F4-paginate | 6 | 3642 | 633 | 4162 | 0.000153 | 56/56 | 0 | ok |
| jev | F5-detail | 6 | 3901 | 1221 | 5926 | 0.000164 | 75/75 | 0 | ok |
| jev | live:python.org | 6 | 8863 | 1487 | 8662 | 0.000372 | 100/100 | 0 | ok |
| jev | live:hackernews | 5 | 6863 | 1159 | 7706 | 0.000288 | 89/90 | 0 | ok |
| jev | live:scrapethissite-search | 15 | 20044 | 2470 | 11896 | 0.000842 | 63/63 | 0 | ok |
| jev | live:quotes-login | 16 | 22943 | 2932 | 7658 | 0.000964 | 20/20 | 0 | ok |
| jev | live:books-category | 9 | 42473 | 2962 | 10582 | 0.001784 | 22/22 | 0 | ok |
| claude | AE1 | 7 | 20 | 18697 | 21206 | 0.000000 | 125/125 | 0 | ok |
| claude | AE7 | 4 | 10 | 7915 | 12030 | 0.000000 | 48/48 | 0 | ok |
| claude | AE8 | 9 | 30 | 48998 | 55526 | 0.000000 | 46/48 | 2 | ok |
| claude | AE15 | 1 | 10 | 4928 | 16103 | 0.000000 | 10/10 | 1 | ok |
| claude | F1-search | 15 | 70 | 53899 | 58112 | 0.000000 | 18/18 | 0 | ok |
| claude | F2-login | 15 | 70 | 59182 | 63496 | 0.000000 | 10/10 | 0 | ok |
| claude | F3-category | 11 | 50 | 46166 | 48435 | 0.000000 | 100/100 | 0 | ok |
| claude | F4-paginate | 6 | 20 | 14714 | 18216 | 0.000000 | 56/56 | 0 | ok |
| claude | F5-detail | 6 | 30 | 20818 | 25431 | 0.000000 | 75/75 | 0 | ok |
| claude | live:python.org | 6 | 20 | 14978 | 21088 | 0.000000 | 100/100 | 0 | ok |
| claude | live:hackernews | 5 | 20 | 16686 | 23001 | 0.000000 | 89/90 | 0 | ok |
| claude | live:scrapethissite-search | 16 | 70 | 52243 | 58172 | 0.000000 | 63/63 | 0 | ok |
| claude | live:quotes-login | 16 | 70 | 51693 | 57025 | 0.000000 | 20/20 | 0 | ok |
| claude | live:books-category | 9 | 50 | 41881 | 49605 | 0.000000 | 22/22 | 0 | ok |
<!-- measurements:end -->

## On the Apify platform (2026-09-20)

The first platform runs of the actor, U4 of the client-on-Navvi plan. Actor
`kdeETLG1aDgq61ofI`, the prefill input (python.org/jobs, list mode, five
fields with `link` typed as `url`, `maxPages` 1), Jev over the Vercel AI
Gateway supplied as the caller's `gatewayApiKey`. Both runs executed under
`LIMITED_PERMISSIONS`.

| build | tag | browser | status | items | pages | questions | chooser wait (ms) | cost (USD) | charges |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3.0.5 | `beta` | Chromium | succeeded | 25 | 1 | 7 | 749 | 0.000433 | all zero |
| 3.0.7 | `beta-camoufox` | Camoufox | succeeded | 25 | 1 | 0 | 0 | 0.000000 | all zero |

Read these two rows together. The Chromium run compiled the scraper from
scratch and asked Jev seven questions for four hundredths of a cent. The
Camoufox run, on the same account minutes later, found that scraper in the
`scraper-cache` key-value store and replayed it with **zero** model
questions and zero cost: the compile-once promise holds across images on the
platform, not only locally.

Charges are all zero in both runs and that is correct, not a defect. The actor
has no pay-per-event pricing configured in the Console yet, and `Charger` is a
deliberate no-op without it, so a test run bills nobody. The charging counters
are exercised instead by `tests/billing.test.ts` against a fake with the SDK's
semantics, and locally by `ACTOR_TEST_PAY_PER_EVENT=1`.

Not yet measured on the platform: the live measurement set (this table's
scenarios run against the fixture server, which the platform has no access
to), and a Cloudflare-fronted site to record `blocked_bot_detection` under
Chromium against the Camoufox result. Both remain open items of U4.

### What the image build actually required

Five failed builds preceded 3.0.5, each a real defect that no local test could
catch, because this Mac has no container runtime and the platform build is the
first place the recipe runs:

1. `camoufox-js` depends on `better-sqlite3`, which found no prebuild for the
   image platform and fell back to `node-gyp`; the base images ship no Python.
   `camoufox-js` is optional now, and both images install a toolchain.
2. `npm ci` runs this package's `postinstall`, but the Dockerfiles copied only
   the manifests at that point, so the script was missing.
3. `tsc` compiled `src/measure` and `scripts/`, which import the test fixture
   server, and `tests/` is excluded from the build context.
   `tsconfig.actor.json` now compiles `src` and `bin` only.
4. The base images set `NODE_ENV=production`, so a bare `npm ci` omitted
   devDependencies and `tsc` was absent. `--include=dev` says it outright.
5. The Camoufox image pruned `--omit=optional` after the build and so deleted
   the very package it launches; it prunes only dev dependencies now.
