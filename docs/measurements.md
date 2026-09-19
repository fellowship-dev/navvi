# Measurements

The same scenarios, once per chooser, in one table. The README's "with and
without Jev" comparison is generated from this table by
`renderReadmeSection` in `src/measure/report.ts`; nothing in it is typed by
hand.

## Reproduce

```sh
npm run measure -- --choosers agent,jev,model            # fixture set, keys as available
npm run measure -- --choosers agent,jev,model --live python.org   # plus one live site per chooser
npm run measure -- --choosers agent --offline             # what CI can run: no key, no network
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
| live:`<site>` | `https://www.python.org/jobs/` or `https://news.ycombinator.com/` | one AE1-like list run over the network (`--live`) |

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
- Numbers below are from the last run on the machine that ran it; wall
  times vary with the machine.

<!-- measurements:start -->
| chooser | scenario | questions | input tokens | chooser wait (ms) | total wall (ms) | cost (USD) | fields correct | healing events | status |
|---|---|---|---|---|---|---|---|---|---|
| agent | AE1 | 7 | 1392 | 1 | 2624 | 0.000000 | 125/125 | 0 | ok |
| agent | AE7 | 4 | 5789 | 0 | 4229 | 0.000000 | 48/48 | 0 | ok |
| agent | AE8 | 9 | 7225 | 1 | 6546 | 0.000000 | 48/48 | 1 | ok |
| agent | AE15 | 1 | 105 | 0 | 11211 | 0.000000 | 10/10 | 1 | ok |
| jev | AE1 | 1 | 448 | 1208 | 2458 | 0.000019 | 0/125 | 0 | failed |
| jev | AE7 | 4 | 10325 | 568 | 4711 | 0.000434 | 48/48 | 0 | ok |
| jev | AE8 | 15 | 16258 | 2635 | 9234 | 0.000683 | 13/48 | 1 | failed |
| jev | AE15 | 1 | 441 | 869 | 12070 | 0.000019 | 10/10 | 1 | ok |
| claude | AE1 | 7 | 20 | 18392 | 20881 | 0.000000 | 125/125 | 0 | ok |
| claude | AE7 | 4 | 10 | 10246 | 14399 | 0.000000 | 48/48 | 0 | ok |
| claude | AE8 | 9 | 30 | 61985 | 68553 | 0.000000 | 46/48 | 2 | ok |
| claude | AE15 | 1 | 10 | 8182 | 19368 | 0.000000 | 10/10 | 1 | ok |
<!-- measurements:end -->
