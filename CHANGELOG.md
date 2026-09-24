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
- **Docs and demos.** New README; `docs/decisions-race.gif` (the same 19 real
  navigation decisions: Jev 3.6× faster than Haiku over the API, 8–11× faster than
  Haiku through Claude Code); `docs/product.gif` (compile, zero-model re-run,
  self-heal); Apify detail in `docs/apify.md`.

## 3.0.0

The scraper compiler: prompt to reusable scraper, zero-model replay, healing.
