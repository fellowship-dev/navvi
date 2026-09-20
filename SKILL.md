---
name: navvi
description: Use when asked to scrape a site, automate a website flow, log in and click through pages, or when you are about to write a Playwright script to extract data. Compile it once so you never drive it again.
allowed-tools: Bash, Read
---

# navvi: Compile it once so you never drive it again.

One command turns a prompt and a few URLs into records plus a compiled scraper JSON; the second run replays it with zero model calls and heals drift when the site changes.

## When to Use

- Extract rows or fields from pages you can name by URL (listings, detail pages, a URL list file)
- Automate a flow before extracting: log in, search, filter, open detail pages
- You were about to write Playwright or a fetch-and-parse script for one site
- A scraper compiled earlier must run again, unattended, in a cron or a CI job

## When Not to Use

- Sites that need a solved captcha; navvi hands a challenge to a person on a headed run and never solves it
- Destructive actions (delete, pay, send) unless the user names them with `--allow-mutation`
- Private hosts or intranets, unless the user allowlists the host with `--allow-private-host`

## The One Command

```bash
npx navvi "<what to extract or do>" <url...> [--out data.json|data.csv]
```

Optional structure when the prompt is not enough: `--mode list|record --fields a,b,c --goal "<navigation>" --from-url <url> --max-pages N --follow-details`. A field may declare an output type, `--fields name,price:money,stock:boolean` (types: `text`, `money`, `integer`, `number`, `boolean`, `url`); the run coerces the value and a value that does not coerce is `null`. `npx navvi --help` lists every flag.

## Who Answers the Questions

Navvi never asks a model for a selector or code; it asks it to pick among options it enumerated from the page. Without `--chooser`, the first of these that applies is used and the choice is printed on stderr (`chooser: claude (Claude Code is installed and signed in; using your subscription)`):

1. **A key**: `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY` selects `--chooser jev` (fastest, cheapest, unattended healing in cron or CI); `ANTHROPIC_API_KEY` selects `--chooser model`. A key wins over an installed CLI.
2. **Claude Code or Codex installed and signed in** (`claude` or `codex` on PATH): navvi runs it for each batch on your subscription. Nothing to configure; `NAVVI_CLAUDE_MODEL` (default `haiku`) and `NAVVI_CODEX_MODEL` pick the model. An installed CLI that is not signed in is skipped, and the reason names the sign-in command (`claude`, `codex login`).
3. **Otherwise `--chooser agent`**: you are the model and answer the questions yourself, as below.

**Text questions under `jev` prefer your subscription.** Jev picks and judges but cannot write, so a text question (the search query to type into a box) is handed to another backend, and that hand-off runs the other way round: `claude`, then `codex` when on PATH, then a metered API key (`ANTHROPIC_API_KEY` before `AI_GATEWAY_API_KEY`). `AI_GATEWAY_API_KEY` therefore routes Jev over the Vercel AI Gateway, which is free for Jev, while text work still goes to a signed-in CLI subscription; the metered Gateway text model is reached only with no CLI installed. A CLI that turns out to be signed out is tried once and the run continues with the next backend. `--chooser model` asked for explicitly is always the API model.

## No Key, No CLI: You Answer the Questions

With `--chooser agent` run the command with stdin open and watch stdout for batches:

```
---NAVVI-QUESTIONS---
{"protocol":"navvi-questions/1","token":"…","questions":[{"id":"field.price","kind":"choice","premise":"…","options":["…"],"state":"…"}]}
---END---
```

Answer each batch on stdin with one JSON line, then keep reading; the records print after the last batch:

```json
{"answers":[{"id":"field.price","index":2},{"id":"prompt-ab12","index":null,"text":"{\"mode\":\"list\",…}"}]}
```

`index` is the option position, `null` for none, `1`/`0` for booleans; `text` is for text questions only and must satisfy the question's `schema`.

If you cannot keep stdin open (a tool that runs a command to completion), add `--agent-mode file`. Navvi writes the batch to `<storage>/questions/<token>.json` (`storage/questions/` by default, or under `--storage <dir>`), prints the path and the token on stderr, and exits **3** with nothing on stdout. Read the file, write an answers file in the shape it names, and rerun the **same command and flags** with `--answers answers.json --resume <token>`. A run can park more than once (a listing asks for the item group first, then the fields): each park prints a **new** token, so always resume with the latest one. Answers you already gave ride along in the parked file, so each answers file needs only the new batch. `--out` is written only when the run finishes. Answer a next-page question honestly; `--max-pages` still caps the crawl.

## Unattended

- `--chooser claude` or `--chooser codex`: the installed CLI answers on your subscription; needs no key, only a signed-in `claude` or `codex`
- `--chooser jev` (fastest, unattended healing): `AI_GATEWAY_API_KEY` (Vercel AI Gateway) or `TYPESAFE_API_KEY`; its text questions go to a signed-in `claude` or `codex` first and to a metered model only without one, so unattended runs want either a CLI or `ANTHROPIC_API_KEY`
- `--chooser model` (any AI SDK model): `ANTHROPIC_API_KEY`, or `AI_GATEWAY_API_KEY` when that is all there is (metered either way)
- `--chooser agent` still needs none; a run that cannot answer parks and exits 3

## Input Contract

- Prompt: plain words, one flow, one site. Never put a credential in the prompt, goal or URLs; navvi refuses them
- URLs come from the command line or `--from-url` (a URL answering the list as newline text or JSON), never from the prompt
- Logins: `--profile local --secret password` reads `NAVVI_SECRET_PASSWORD` from the environment (or prompts on a TTY); `--secrets-file secrets.json` takes a `{name: value}` object. Reference them in `--goal` as `{{secret:password}}`
- Domains: the run stays on the start URLs' domains; `--allow-domain <host>` widens it

## Output

- stdout (or `--out <file>`): a JSON array of records, one object per item, each with a `_source` URL; `.csv` or `--csv` writes CSV with a header from the union of keys
- stderr: a summary block (status, items, pages, chooser usage, healing events, unmapped candidates) unless `--quiet`
- `storage/key_value_stores/scraper-cache/<cacheKey>.json`: the compiled scraper. Copy or commit that file; the rest of `storage/` holds browser profiles with live sessions and must not be shared

## Statuses and Exit Codes

| Exit | Statuses | What to do |
| --- | --- | --- |
| 0 | `succeeded` | Use the data |
| 1 | `no_items_found`, `drift`, `blocked_bot_detection`, `blocked_login_required`, `blocked_no_progress` | Read the stderr message; a redesign needs a new prompt, a login needs `--profile local` and secrets |
| 2 | configuration or validation error | Fix the flags; the message names the env vars for keys |
| 3 | `needs_human` | Answer `<storage>/questions/<token>.json`, rerun the same command with `--answers <file> --resume <latest token>` |
| 4 | `budget_exhausted`, `model_unavailable`, `charge_limit` | Retry later, raise the cap, or switch chooser |

## Limits

- Heals drift (a moved field, a renamed button); reports a redesign as `drift` instead of guessing
- No captcha solving; a headed run (`--headed`) hands a challenge to a person and records that step
- Logins use the local profile; secrets come from the environment or a file, never the command line, and never enter a question, log or the scraper JSON
- Apify deployment is coming; today the CLI runs locally with Camoufox (default) or Chromium (`--browser chromium`)

## With and Without Jev

See `docs/measurements.md` for the measured questions, wait time and cost per chooser on the same pages.
