# Changelog

## 3.1.0 — unreleased

One compiler, Jev first.

- **One compile core.** `navvi "<prompt>" <url>` and `navvi make` now compile a
  page template through the same code (`src/compile/template.ts`): declared data
  first (JSON-LD, meta), then the page's own JSON payloads, then DOM candidates
  the chooser picks from. A page with no structured data compiles (it used to be
  classified dead by `make`), and a page that declares its data needs no DOM
  questions at all.
- **`--work <dir>` on the plain command** writes every compile step as a file
  (spec, sample, investigation, reconciliation, `rationale.md`, scraper); `make`
  remains the resumable driver over the same pipeline.
- **Close calls are questions.** Competing readings of a field are asked of the
  chooser once, in one batch, with your `--rubric`s in the question; the answer is
  recorded with who gave it. Nothing binds an ambiguous reading silently.
- **Binding correctness.** A JSON payload binds only when it is provably about
  the page it came from, two fields never share one path, and machine values
  (ids, timestamps, counts) are refused at bind time.
- **Jev is visible.** Auto-selected Jev is announced; a keyless terminal run gets
  one tip with where to get a key; with both keys, an unavailable AI Gateway falls
  back to the TypeSafe API; the summary attributes every question to the decider
  or the writer.
- **Sturdier choosers.** Long text answers get a text-sized wait
  (`NAVVI_CLI_TIMEOUT_MS` overrides); a CLI writer that times out hands over to
  another subscription CLI, never to a metered API; a pick that arrives with an
  explanation is accepted; Claude Code's cached input tokens are counted.
- **`make` ergonomics.** Start URLs answer the input shape and the site; a model
  that does not answer ends `model_unavailable` (exit 4), not as a defect; a flag
  that belongs to the other command is refused by name.
- **Claude Code runs without extended thinking**: the same 19/19 answers on the
  captured navigation questions in 38 s instead of 92 s; the prompt-parse question
  in ~4.5 s instead of ~22 s. `MAX_THINKING_TOKENS` or `NAVVI_CLAUDE_THINKING=1`
  restores it.
- **A signed-out CLI is not a side door to a metered model.** Once a signed-in
  Claude Code or Codex has failed a question, the writer chain may still try the
  other CLI, but it ends there; it never reaches `ANTHROPIC_API_KEY` or the
  Gateway by way of a CLI that turns out to be signed out.
- **Claude Code and Codex run from a neutral directory.** Started inside a
  repository, Claude Code loaded that project's `CLAUDE.md` and hooks and
  answered some prompt questions with a clarification request; the batch and the
  sign-in probe now run from a temp directory.
- **Lists and partial fields.** A repeated element within an item is offered as
  one list selector and extracts as an array (typed per element, joined in CSV),
  and Jev can choose it. A requested field still unbound after compile ends the
  run `partial` (exit 1) with the field named; the scraper records it, so its
  replays end `partial` with the same line and a `--force-recompile` remedy. Old
  scrapers replay unchanged.
- **Limits the prompt states are kept.** "Up to 10" and "the first 3 pages" set
  `maxItems` and `maxPages`; an explicit flag wins.
- **Selectors.** A DOM candidate is the shortest selector unique on every sample:
  the fewest distinctive ancestors first, position only after that, and in record
  mode it must match exactly one element on every sample.
- **Redirects and renamed slugs.** A redirect to the same product under a renamed
  slug (same template, declares a product, keeps the requested slug's name word
  and every number) is that product, not a dead URL; a redirect to a category,
  search or home page, or to another product, stays dead. Tier 1 compares a
  redirected page by the URL that was asked for, so a list of renamed slugs binds
  its declared data instead of falling through to the DOM. A declared closed
  value (availability, condition, currency) that reads the same on every sample
  still binds.
- **Compile on a page that never goes network-idle.** Navigation waits for
  `networkidle` at most 20 s and the post-consent wait at most 5 s, and the
  settle budget starts once the page has arrived, instead of every visit waiting
  90 s on a page that was finished on screen.
- **Pinned replay on a mixed list.** A pinned `scriptId` replays every start URL
  matching its template; URLs of other shapes are reported (`offTemplate`) and
  never compiled, and a pin that matches nothing ends without compiling. A dot is
  a slug character, so dotted slugs no longer split one template into several.
- **Replay says what happened to every page.** A page that is not a readable page
  of the template yields no row, asks no model and is counted in the summary
  instead of being healed:
  - `blockedPages`: a bot challenge. The first one of a run, on compile or replay,
    is kept in the run's key-value store (`BLOCKED_PAGE`,
    `BLOCKED_PAGE_SCREENSHOT`, `BLOCKED_PAGE_META`) so a block can be checked,
    and a run where every page was a challenge ends `blocked_bot_detection`.
  - `deadPages`: answered 404/410, or redirected off the template (for a scraper
    that never logs in; under a login it is still drift).
  - `transientPages`: still 5xx after the crawler's retry; only a decisive
    challenge reading makes a 5xx page blocked.
  - `unsettledPages`: a weak challenge reading (a captcha widget on a page still
    rendering) that did not settle within 5 s of waiting for the scraper's anchor.
  - `noPayloadPages`: every failed field reads a page payload that never arrived;
    not `unhealed`.
  - `emptyListings`: a list start URL whose first page has no item under the
    anchor (a search that found nothing); not paginated.

  Each carries a count and the first 50 URLs.
- **Optional fields.** A field input may be `optional: true` (a struck-through
  list price exists only during a discount): its nulls never trigger healing, a
  run whose rows never fill it reports it not found, and one that fills on some
  pages and not others is reported as `optionalDrift` (informational).
- **List mode at scale.** Every start URL's first page is read, so a thousand
  search URLs are a thousand listings; `maxPages` is the run's budget for further
  pages (limit raised to 20,000) and the new `maxPagesPerStart` caps one
  listing's pagination. Every row carries `_startUrl`, the start URL that
  produced it (equal to `_source` on record rows).
- **Lighter replay.** Replay pages skip images, fonts and media, a record replay
  navigates to `domcontentloaded` and waits for `load` at most 10 s, and the
  payload capture keeps 200 responses. `maxConcurrency` and `minConcurrency` are
  inputs; a compile stays serial.
- **A heal survives a store it cannot write.** The actor's store picker asks for
  read and write access, and a repair that cannot be stored is used for the run
  and logged instead of losing the page's row.
- **`scraperStore` holds the run's scrapers.** It names the key-value store the
  run reads and writes compiled and healed scrapers in, so a trial run stays out
  of the shared `scraper-cache`. Under limited permissions pass it by ID: a store
  the actor may not open is a `configuration_error` naming the store and that
  fix, and the summary keeps a run error's own status.
- **Quieter CLI.** The browser-launch diagnostic moved behind `NAVVI_LOG=debug`
  and names the browser actually launched; a bad flag prints one line and a
  pointer to `--help`; `make` ends with its status and exit code; `rationale.md`
  says why a selector was kept; a prompt run whose every start URL is 404/410
  stops before any model call.
- **Release.** `npm publish` builds first, so `dist/` cannot ship stale.
- **Docs and demos.** New README; `docs/decisions-race.gif` (the same 19 real
  navigation decisions: Jev 3.6× faster than Haiku over the API, 8–11× faster than
  Haiku through Claude Code), with a Claude Code cut and a visual cut that outlines
  each question's candidates on the page; `docs/product-hn.gif`, the README's hero
  clip (compile a live Hacker News scraper, re-run with zero model calls, self-heal
  after a simulated redesign); Apify detail in `docs/apify.md`.

## 3.0.0

The scraper compiler: prompt to reusable scraper, zero-model replay, healing.
