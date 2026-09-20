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
| agent | AE1 | 7 | 1392 | 0 | 2600 | 0.000000 | 125/125 | 0 | ok |
| agent | AE7 | 4 | 5789 | 0 | 4117 | 0.000000 | 48/48 | 0 | ok |
| agent | AE8 | 9 | 7225 | 1 | 6422 | 0.000000 | 48/48 | 1 | ok |
| agent | AE15 | 1 | 105 | 0 | 11211 | 0.000000 | 10/10 | 1 | ok |
| agent | F1-search | 15 | 4083 | 1 | 4491 | 0.000000 | 18/18 | 0 | ok |
| agent | F2-login | 15 | 4437 | 1 | 4565 | 0.000000 | 10/10 | 0 | ok |
| agent | F3-category | 11 | 8105 | 1 | 2544 | 0.000000 | 100/100 | 0 | ok |
| agent | F4-paginate | 6 | 1099 | 0 | 3540 | 0.000000 | 56/56 | 0 | ok |
| agent | F5-detail | 6 | 1157 | 0 | 4668 | 0.000000 | 75/75 | 0 | ok |
| agent | live:python.org | 0 | 0 | 0 | 0 | 0.000000 | 0/0 | 0 | skipped: agent column is a recorded replay; pass --agent-live to measure a host agent on a live site |
| agent | live:hackernews | 0 | 0 | 0 | 0 | 0.000000 | 0/0 | 0 | skipped: agent column is a recorded replay; pass --agent-live to measure a host agent on a live site |
| agent | live:scrapethissite-search | 0 | 0 | 0 | 0 | 0.000000 | 0/0 | 0 | skipped: agent column is a recorded replay; pass --agent-live to measure a host agent on a live site |
| agent | live:quotes-login | 0 | 0 | 0 | 0 | 0.000000 | 0/0 | 0 | skipped: agent column is a recorded replay; pass --agent-live to measure a host agent on a live site |
| agent | live:books-category | 0 | 0 | 0 | 0 | 0.000000 | 0/0 | 0 | skipped: agent column is a recorded replay; pass --agent-live to measure a host agent on a live site |
| jev | AE1 | 7 | 4415 | 1402 | 3848 | 0.000185 | 125/125 | 0 | ok |
| jev | AE7 | 4 | 18017 | 621 | 4791 | 0.000757 | 48/48 | 0 | ok |
| jev | AE8 | 9 | 26702 | 1901 | 8372 | 0.001121 | 48/48 | 1 | ok |
| jev | AE15 | 1 | 583 | 1135 | 12291 | 0.000024 | 10/10 | 1 | ok |
| jev | F1-search | 14 | 8065 | 2330 | 11325 | 0.000339 | 18/18 | 0 | ok |
| jev | F2-login | 15 | 8349 | 2698 | 6894 | 0.000351 | 10/10 | 0 | ok |
| jev | F3-category | 11 | 15737 | 1755 | 4077 | 0.000661 | 100/100 | 0 | ok |
| jev | F4-paginate | 6 | 3642 | 696 | 4281 | 0.000153 | 56/56 | 0 | ok |
| jev | F5-detail | 6 | 3901 | 963 | 5647 | 0.000164 | 75/75 | 0 | ok |
| jev | live:python.org | 6 | 8863 | 1100 | 6613 | 0.000372 | 100/100 | 0 | ok |
| jev | live:hackernews | 5 | 6963 | 1172 | 7908 | 0.000292 | 89/90 | 0 | ok |
| jev | live:scrapethissite-search | 15 | 19761 | 4235 | 14582 | 0.000830 | 63/63 | 0 | ok |
| jev | live:quotes-login | 12 | 7293 | 4041 | 6296 | 0.000306 | 0/20 | 0 | failed |
| jev | live:books-category | 9 | 42259 | 2546 | 8718 | 0.001775 | 22/22 | 0 | ok |
| claude | AE1 | 7 | 20 | 12674 | 15122 | 0.000000 | 125/125 | 0 | ok |
| claude | AE7 | 4 | 10 | 10507 | 14638 | 0.000000 | 48/48 | 0 | ok |
| claude | AE8 | 9 | 30 | 75065 | 81582 | 0.000000 | 46/48 | 2 | ok |
| claude | AE15 | 1 | 10 | 4836 | 16001 | 0.000000 | 10/10 | 1 | ok |
| claude | F1-search | 15 | 70 | 49497 | 53610 | 0.000000 | 18/18 | 0 | ok |
| claude | F2-login | 15 | 70 | 68748 | 72923 | 0.000000 | 10/10 | 0 | ok |
| claude | F3-category | 11 | 50 | 34901 | 37169 | 0.000000 | 100/100 | 0 | ok |
| claude | F4-paginate | 6 | 20 | 14726 | 18223 | 0.000000 | 56/56 | 0 | ok |
| claude | F5-detail | 6 | 30 | 19678 | 24293 | 0.000000 | 75/75 | 0 | ok |
| claude | live:python.org | 6 | 20 | 16047 | 25963 | 0.000000 | 100/100 | 0 | ok |
| claude | live:hackernews | 5 | 20 | 18957 | 30343 | 0.000000 | 89/90 | 0 | ok |
| claude | live:scrapethissite-search | 16 | 70 | 61180 | 67292 | 0.000000 | 63/63 | 0 | ok |
| claude | live:quotes-login | 12 | 40 | 82647 | 85352 | 0.000000 | 0/20 | 0 | failed |
| claude | live:books-category | 9 | 50 | 40805 | 48168 | 0.000000 | 22/22 | 0 | ok |
<!-- measurements:end -->
