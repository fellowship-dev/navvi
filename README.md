# Navvi

**Compile it once so you never drive it again.**

Navvi is a self-healing scraper compiler. Say what you want from a site,
give it the URLs, and it compiles a scraper you keep: the second run makes
zero model calls, and when the site drifts it heals the broken field or step
instead of failing. No API key needed: if Claude Code or Codex is installed
and signed in, navvi uses it on your subscription; otherwise the coding agent
running the command answers the compile questions itself.

![Navvi demo](docs/demo.gif)

The same site, three runs: compile, heal when the markup changes, replay the original with zero questions. Video: [docs/demo.mp4](docs/demo.mp4) — reproduce it with `npm run demo`.

## Install and run

```bash
npm install navvi            # or skip: npx fetches it on first use
npx navvi "name, lab and price of each product" https://shop.example/p/1 https://shop.example/p/2 --out products.json
npx navvi "every job with title, company and link, follow next page" https://jobs.example/python --out jobs.csv
npx navvi "log in and list my invoices with number, date and total" https://app.example/login --secret password --goal "sign in as max with {{secret:password}}"
```

Node 22+. The first run downloads Camoufox; set `NAVVI_BROWSER=chromium` to
use Playwright's Chromium instead. Agents: read [`SKILL.md`](SKILL.md) first;
[`llms.txt`](llms.txt) indexes everything.

## What you get

- **Records**: a JSON array on stdout or in `--out <file>` (`.csv` writes CSV),
  one object per item, each with its `_source` URL.
- **A scraper you can commit**: `storage/key_value_stores/scraper-cache/<cacheKey>.json`,
  selectors with fingerprints plus the recorded navigation trace. Only that
  file; the rest of `storage/` holds browser profiles with live sessions.
- **A second run that costs nothing**: same prompt, same fields, same site
  template, no model call. Run it from cron, CI or a script.
- **Healing**: a moved field or a renamed button is repaired on the spot from
  the recorded alternatives and fingerprints; a real redesign is reported as
  `drift` rather than guessed at.
- **A summary on stderr**: status, items, pages, chooser usage, healing
  events, unmapped candidates. `--quiet` turns it off.

## Choosers

Navvi never lets a model write a selector or a script. It enumerates the
candidates itself and asks a *chooser* to pick. Five choosers, one contract:

| `--chooser` | Who answers | Needs | Best for |
| --- | --- | --- | --- |
| `claude` | Claude Code (`claude -p`) on your subscription | `claude` installed and signed in | Out of the box, no key |
| `codex` | Codex (`codex exec`) on your subscription | `codex` installed and signed in | Out of the box, no key |
| `jev` | Jev by TypeSafe, through Vercel AI Gateway or direct | `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY` | Speed, cost and unattended healing in cron or CI |
| `model` | Any AI SDK model | `ANTHROPIC_API_KEY` | A key you already have |
| `agent` | The coding agent running the command, over stdio | Nothing | Any tool that can keep stdin open or rerun with `--answers --resume` |

Without `--chooser` the order is: a key (`jev`, then `model`); else Claude
Code, then Codex, when installed and signed in (an installed CLI that is not
signed in never wins; the run says so and names `claude` or `codex login`);
else `agent`. The choice and its reason print on stderr unless `--quiet`.
`NAVVI_CLAUDE_MODEL` (default `haiku`) and `NAVVI_CODEX_MODEL` pick the CLI
model. CLI usage reports `$0.0000` with billing `subscription`; Claude Code's
own cost figure is kept as `reportedCostUsd` in the usage.

With the agent chooser, the CLI prints each question batch on stdout between
`---NAVVI-QUESTIONS---` and `---END---` and reads one JSON answer line from
stdin. When stdin cannot stay open, `--agent-mode file` parks the batch in
`storage/questions/<token>.json`, exits 3, and
`--answers answers.json --resume <token>` continues. Full protocol in
[`SKILL.md`](SKILL.md).

## How it differs

Browserbase Director, Browser Use and similar agents drive the browser with
a model on every run: flexible, but every run pays and every run can wander.
Crawl4AI and exported Playwright scripts are the opposite: cheap to run, but
static, so the first layout change breaks them. Navvi compiles once into a
scraper with recorded alternatives and fingerprints, replays it with no
model, and when a check fails it heals by merging a small repair into the
same scraper instead of re-driving the whole flow. The model (or the agent)
is only ever asked to pick among options the code enumerated.

## Local and Apify

Today Navvi runs locally through the CLI: Camoufox by default, Chromium with
`--browser chromium`, profiles and compiled scrapers under `--storage`
(default `./storage`). An Apify actor with the same input contract is
coming; the compiled scraper format is the same in both.

## Exit codes

| Exit | Status | Meaning |
| --- | --- | --- |
| 0 | `succeeded` | Records written |
| 1 | `no_items_found`, `drift`, `blocked_bot_detection`, `blocked_login_required`, `blocked_no_progress` | The run stopped short; stderr says why |
| 2 | configuration or validation error | Bad flags, missing key (the message names `AI_GATEWAY_API_KEY` / `TYPESAFE_API_KEY` / `ANTHROPIC_API_KEY` and reminds you `--chooser agent` needs none), a CLI chooser that is not signed in (`claude`, `codex login`), a private host without `--allow-private-host` |
| 3 | `needs_human` | Questions parked in `storage/questions/<token>.json`; answer and `--resume` |
| 4 | `budget_exhausted`, `model_unavailable`, `charge_limit` | Retry later, raise the cap, or switch chooser |

## Limits

- Heals drift, reports redesigns. A page that no longer carries the fields is
  `drift`, not a silent empty result.
- No captcha solving. On a headed run (`--headed`) a challenge is handed to
  the person at the keyboard and their step is recorded; unattended runs
  report `blocked_bot_detection`.
- Logins use `--profile local`. Secrets come from `NAVVI_SECRET_<NAME>`
  (`--secret name`), a `--secrets-file`, or a hidden TTY prompt; never the
  command line, never a question, a log or the scraper JSON.
- The run stays on the start URLs' domains unless `--allow-domain` widens
  it; private hosts need `--allow-private-host`; destructive-looking actions
  need `--allow-mutation`.
- Pagination and item caps default to 10 pages and 1000 items
  (`--max-pages`, `--max-items`).

## Measurements

With and without Jev on the same pages: questions, wait time, cost and heal
rate live in [`docs/measurements.md`](docs/measurements.md).

## License

MIT.
