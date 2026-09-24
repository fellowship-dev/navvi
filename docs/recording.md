# Recording Navvi demos

Reuse the TypeScript scripts and shared `scripts/recorder.ts` compositor. There is no VHS prerequisite. Run commands from the repository root. The race recorder creates a unique run directory and preserves its frames and receipts. The older demo/live scripts regenerate their named assets and frame directories; preserve a wanted previous cut before running those.

## Prerequisites

```sh
npm ci
npx playwright install chromium
ffmpeg -version
ffprobe -version
```

Use a full ffmpeg installation supporting palette GIFs and H.264 MP4. Playwright's bundled ffmpeg is insufficient for this encoder. `FFMPEG=/absolute/path/to/ffmpeg` overrides detection; keep ffprobe beside it. Encoding produces a palette GIF and H.264/yuv420p MP4 with faststart.

## Existing cuts

| Command | Output | What it proves |
| --- | --- | --- |
| `npx tsx scripts/record-demo.ts` | `docs/demo.gif`, `docs/demo.mp4` | Controlled two-version fixture and healing, using recorded chooser answers. |
| `npx tsx scripts/record-live.ts python-jobs` | `docs/live-python-jobs.gif`, `.mp4` | Live public-site extraction with recorded chooser answers and illustrative screenshots. |
| `npx tsx scripts/record-live.ts hackernews` | `docs/live-hackernews.gif`, `.mp4` | Same recording mechanism for Hacker News. |
| `npx tsx scripts/record-race.ts` | `$DEMO_OUT/navvi-race-*/race.gif`, `race.mp4` (system temporary directory by default) | Live Navvi + Jev versus Navvi + Haiku, including prompt parsing, actual crawler pages and cached replay. Uses a controlled fixture unless `DEMO_URL` is set. Requires TypeSafe credentials plus an available text-model provider or supported local harness. |

The shared demo layout is 960×600 at 6 fps. The race uses 1280×800, GIF at 4 fps and MP4 at 8 fps. Preserve actual event timestamps for timers; the scripted holds in the illustrative clips are not end-to-end performance measurements.

## Launch order: compile first, replay second

The opening clip is Haiku on the left and Jev on the right, both compiling the same real task with empty caches. Use `DEMO_PHASES=compile` to export only that comparison. The second clip demonstrates saved replay with zero model calls. Keep these as separate assets. A faster run does not establish better accuracy; both datasets need review.

## Next cut: Remote OK

First prove this exact prompt through the CLI from the public homepage:

```sh
npx tsx bin/cli.ts \
  'Search Remote OK for Python jobs and extract up to 10 results with job title, company, location and job link. Exclude ads.' \
  https://remoteok.com/ --chooser jev --browser chromium \
  --max-pages 1 --max-items 10 --storage /tmp/navvi-remoteok-demo \
  --out /tmp/navvi-remoteok-first.json
```

Repeat the same command with the same storage and a new output path. Check the dataset against visible job cards, not just non-null values: title, company, location and working job link, with ads excluded. Verify zero model calls in the healthy replay summary. Salary is outside scope because many values are hidden behind membership.

For the side-by-side cut, use Navvi + Jev and Navvi + Haiku with separate empty storage folders and identical inputs and output requirements. Capture the browser page actually used by each run. Start the timer before prompt parsing and finish after data persistence. Show both durations, correctness and model calls. Then open a new browser and rerun the identical prompt with the saved cache. Call this Navvi's chooser comparison, not a direct race against jev-ultrafast.

The real-site race uses the same recording pipeline:

```sh
DEMO_URL=https://remoteok.com/ \
DEMO_EXPECT_SOURCE=https://remoteok.com/remote-python-jobs \
DEMO_PROMPT='Search Remote OK for Python jobs and extract up to 10 results with job title, company, location and job link. Exclude ads.' \
DEMO_PHASES=compile \
DEMO_OUT=/tmp/navvi-recordings \
npx tsx scripts/record-race.ts
```

Provide TypeSafe credentials and an authenticated Claude Code harness through the environment; the Haiku lane explicitly pins `haiku`. Jev's text helper follows the configured provider fallback, so document that provider in the publication caption if comparing costs. `DEMO_OUT` is a parent directory: each invocation prints and creates a new `navvi-race-*` child, preserving earlier runs. Omit URL and prompt to use the controlled search fixture. `DEMO_EXPECT_SOURCE` optionally requires every output row’s `_source` to exactly equal the supplied URL, in both lanes and phases. It is a recording acceptance oracle only: it never reaches the run input or chooser and cannot guide navigation. For Remote OK, this rejects an unapplied search that extracted homepage jobs.

Both lanes pass only the natural-language prompt plus the URL and common browser/page/item limits. Their first-run caches are isolated. Replay reuses each lane's own storage with a new chooser and a new crawler browser. Each crawler uses a 1200×700 desktop viewport, scaled to a 600×350 panel to preserve the site layout. The `CrawlDeps.onPage` hook captures the actual page for compile and replay; there is no separately navigated preview. Timers include prompt parsing, data retrieval and capture overhead. This is a recorded workflow measurement, not an isolated provider benchmark.

Each run directory retains `receipt.json` (commit, dirty-file list, input, phase timings, usage and summaries), per-lane, per-phase `*-rows.json` outputs, per-phase `*-questions.jsonl` diagnostics (question state, options, answers, errors and timestamps), storage and PNG frames. These diagnostic files are intended for public-site demo inputs only. If either lane returns no rows, missing fields or empty requested values in any row, an unexpected `_source` when configured, a blocked/error status or mismatched saved-row count, the script saves the evidence and exits without encoding a success clip. A successful replay only says “zero model calls” when its fresh chooser reports zero questions. Nonzero replay questions stay visible. Successful status does **not** establish semantic correctness: compare the saved rows against the displayed jobs before publishing.

Do not present the existing `record-live.ts` recorded-answer flow as live model decision-making.

Opening: “Jev made browser agents fast. I wanted the second run to stop needing an agent.” Closing: “Prompt → reusable scraper. AI returns when a selector breaks.” If healing is shown, label it as a separate controlled-site demonstration.

## Review before publishing

Inspect the first frame, form interaction, first real results, both timer stops, replay and last frame. Watch the complete MP4 at normal speed. Ensure labels match the actual chooser and cache state, text is legible at mobile width, and no credential or private data appears. Save the exact command, commit, run summaries, correctness check and timing receipt beside the recording work. Use MP4 for the social post and GIF for the README. Publishing follows review of the actual clip.

## First run versus saved replay from an existing recording

When the useful claim is reuse, compose the validated Jev lane's two sequential runs. To capture a new source without requiring the optional Haiku comparison, run the real-site command above with `DEMO_CHOOSERS=jev`. The recorder then requires only Jev's compile and replay to pass; it still enforces fields and expected source. It keeps the Jev pane in the same location for this compositor. The default `DEMO_CHOOSERS=claude,jev` puts Haiku left and Jev right. `DEMO_PHASES` defaults to `compile,replay`; use `compile` for the opening clip. This does not repeat model calls or show an invalid competitor lane. Preserve the original run directory. Verify the start/end frame indices and displayed elapsed clock values visually before supplying anchors:

```sh
DEMO_OUT=/tmp/navvi-publishable npx tsx scripts/compose-replay-comparison.ts \
  --source /tmp/navvi-recordings/navvi-race-j7CMFv \
  --expect-source https://remoteok.com/remote-python-jobs \
  --compile-start 6 --compile-end 169 --compile-anchor 0 \
  --replay-start 284 --replay-end 296 --replay-anchor 0.1
```

Those indices are specific to the cited recording, not defaults for future runs. Each `*-start` is the first active frame, each `*-end` the first frame showing the final timer, and each `*-anchor` its start frame's displayed elapsed seconds. The tool uses the existing `frames/frames.txt` durations to align the runs; it preserves original browser and timer pixels, freezes completed frames, and labels the comparison as two sequential real runs. Tenths-of-a-second source clocks imply ±0.05-second anchor rounding uncertainty, plus video sampling precision. No runtime value is invented.

The source must contain successful Jev compile/replay reports, complete requested fields, matching source URLs and zero replay questions. The resulting unique directory contains MP4, GIF, frames, selected rows and `provenance.json` with source hashes, source commit/dirty state, verified lane reports, alignment anchors and every output-to-input frame mapping. A dirty source capture is identified as such; a subsequent clean-commit validation must be reported separately. Review the original and derived keyframes before publishing. Do not claim a universal speedup from one example.

## Latest real-site attempt

The September 20 compile-only trial is **not accepted for publication**: Haiku returned `blocked_no_progress` with zero rows after 110.4 seconds; Jev returned ten rows after 61.8 seconds. Both reached the Python-filter URL, but the visible page includes unrelated-looking jobs. That is not evidence of a clean semantic match or a fair speed win. Review site filtering and extracted membership before accepting either dataset. The recorder correctly withheld the success GIF. Next work: inspect Haiku’s repeated rejected completion judgments and validate result membership beyond URL equality.


## September 20 proposed Hacker News replacement

Remote OK's Python-filter page served unrelated roles directly; only one of the
first ten retained job descriptions mentioned Python. Treat the failed comparison
and older replay as historical diagnostics, not an accepted semantic demo.
The owner is reviewing Hacker News as an alternative; it is not approved yet.

Clean source capture `80cfd8f` at `/tmp/navvi-hn-proposal/navvi-race-VJjU4P`:
Haiku 49.3 s, Jev 25.6 s, ten correct stories per lane; Jev replay 2.2 s with
zero model questions. Both deciders use the explicit Claude Code Haiku writer.
Jev structured decisions use TypeSafe direct. These are end-to-end recorded
workflows, including browser/capture overhead, not isolated inference latency.

```sh
DEMO_URL=https://hn.algolia.com/ \
DEMO_EXPECT_SOURCE='https://hn.algolia.com/?dateRange=all&page=0&prefix=true&query=Python&sort=byPopularity&type=story' \
DEMO_PROMPT='Search Hacker News for Python stories and extract up to 10 results with title, author, points and story link.' \
DEMO_PHASES=compile,replay DEMO_OUT=/tmp/navvi-hn-proposal \
npx tsx scripts/record-race.ts
```

`frame-times.jsonl` records per-frame phase, lane state and actual elapsed time.
The recorder freezes completed lane screenshots. For this capture, Jev compile
anchors are frames 6–102 (0.0 s) and replay 217–222 (0.1 s). The replay compositor
selects the Jev pane from receipt lane order and presents readable result cards;
it no longer assumes Jev is left or hardcodes the site name.

Reviewed-source receipts and candidate media live in Buddy at
`artifacts/navvi/2026-09-20-launch-evidence/`. The primary postprocessor preserves
all original compile frames/timings and overlays two persisted rows after each
lane completes. It omits the later replay phase. No clocks are rewritten and no
footage is sped up. Full ten-row datasets and the independent page comparison
remain alongside both clips.

Use a source checkout for this recording. npm 3.0.0 predates separate
writer/decider flags and the highlighted-word extraction correction. No npm
patch release is implied by a main-branch capture.

## Decision race: the same questions to Haiku and Jev

`scripts/record-decisions.ts` isolates the step where Navvi asks a model to
pick among code-enumerated candidates. It does not time browsing, prompt
parsing or extraction. Output: `docs/decisions-race.gif`, `.mp4` and
`docs/decisions-race-provenance.json`.

```sh
set -a; . /path/to/.env; set +a   # AI_GATEWAY_API_KEY, TYPESAFE_API_KEY
DECISIONS_OUT=/tmp/navvi-decisions npx tsx scripts/record-decisions.ts                 # capture + race + render
DECISIONS_MODE=race DECISIONS_CAPTURE=/tmp/navvi-decisions/navvi-decisions-XXXX \
  DECISIONS_OUT=/tmp/navvi-decisions npx tsx scripts/record-decisions.ts               # re-race an existing capture
DECISIONS_MODE=render DECISIONS_SOURCE=/tmp/navvi-decisions/navvi-decisions-YYYY \
  DECISIONS_PUBLISH=1 npx tsx scripts/record-decisions.ts                              # re-render, copy to docs/
```

Other variables: `DECISIONS_URL` / `DECISIONS_PROMPT` (default: Hacker News
search on `https://hn.algolia.com/`), `DECISIONS_REFERENCE_MODEL` (default
`claude-sonnet-4-6`), `DECISIONS_HAIKU_MODEL` (default `claude-haiku-4-5`) and
`DECISIONS_RUNS` (default 3). Every mode creates a new `navvi-decisions-*`
directory that holds `capture/`, `race.json`, `provenance.json`, the frames and
the media.

- **Capture.** One real `run()` (the CLI entry point) on the public site, with
  a reference decider that is in neither lane: Sonnet over the AI Gateway. The
  chooser is wrapped in `RecordingChooser` (`capture/recorded/`) and a logger
  that saves every batch in full (`capture/questions.jsonl`). The capture must
  succeed with rows, or nothing is raced.
- **Race.** Every captured choice and boolean batch, grouped exactly as Navvi
  asked it. Text questions (prompt parsing and the typed query) are dropped
  because Jev cannot write text. Haiku uses `ModelChooser` over the AI Gateway
  (`ANTHROPIC_API_KEY` is removed from the environment). Jev uses `JevChooser`
  over the TypeSafe API. Each lane gets one untimed warm-up call, then runs its
  batches sequentially with wall-clock timing per batch. The lanes never run
  concurrently, and their order alternates between runs.
- **Haiku lane.** Haiku returns the right index on the navigation batches,
  but it also fills the optional `text` field with an explanation. Before
  8d868fb navvi's validator rejected that and the stock `ModelChooser` failed
  batch 3, so the published render (`docs/decisions-race-provenance.json`)
  used a lane subclass that dropped `text` before validation. Since 8d868fb
  the stock validator keeps the pick and ignores the words, and the recorder's
  Haiku lane is now the stock `ModelChooser`: a subclass only counts
  explanations (`explanationTexts`) and changes nothing it returns. Verified
  on September 24: 7 backend calls for 7 batches in every run, 5 to 8
  explained picks per run, 19/19 reference matches.
- **Render.** The run with the median Haiku/Jev ratio. Answers appear at their
  measured batch end times. If the slower lane exceeds 15 s, both lanes are
  compressed by the same factor and the frame says so. A ✓ means the lane
  matched the reference decider's capture answer; ≠ means it did not.

September 24 result: HN search, 19 decisions (18 choice, 1 boolean) in 7
batches. Haiku took 11.0 / 13.3 / 11.7 s and Jev 3.2 / 2.6 / 3.5 s: 3.4× in the
median run, with a range of 3.4 to 5.0×. Both lanes matched the reference
19/19 in every run. This is a decision-latency measurement from one network
location on one task. It does not measure end-to-end compile time and does not
support a general accuracy claim.

### Race only, and the Claude Code lane

`DECISIONS_MODE=bench` races an existing capture with no capture and no
render. `DECISIONS_LANES` picks the lanes (default `jev,haiku`; also
`claude-code`), and the order rotates per run so every lane takes every
position. It writes `bench.json` and `bench-summary.json` in the run
directory, and `DECISIONS_BENCH_OUT` copies the summary elsewhere.

```sh
set -a; . /path/to/.env; set +a
DECISIONS_MODE=bench DECISIONS_LANES=jev,haiku,claude-code \
  DECISIONS_CAPTURE=/tmp/navvi-decisions/navvi-decisions-XXXX DECISIONS_OUT=/tmp/navvi-decisions \
  DECISIONS_BENCH_OUT=docs/decisions-race-claude-code.json npx tsx scripts/record-decisions.ts
```

The `claude-code` lane is what a navvi user without an API key gets:
`CliChooser("claude")`, which runs `claude -p <prompt> --output-format json
--model haiku` (`NAVVI_CLAUDE_MODEL`, default `haiku`) once per batch on the
signed-in subscription. The lane removes `ANTHROPIC_API_KEY` and every
`CLAUDE*` variable so that the child process is not a nested session of the
shell running the script. Its time includes starting a Claude Code process
for every batch. That is the cost a user pays, but it is not model latency.
A separate timing check found that startup accounts for only about 2.5 s per
batch. The rest is API time: Claude Code adds about 19k tokens of its own
prompt, and Haiku in Claude Code thinks for 400 to 2,500 tokens before it
answers.

September 24 result (`docs/decisions-race-claude-code.json`): the same 19
questions in 7 batches from the published capture, 3 runs. Medians: Jev
3.5 s, Haiku over the Gateway (stock `ModelChooser`) 12.0 s, Haiku through
Claude Code 91.6 s. That is 3.4× for Haiku over the API and 26× for Claude
Code (per-run 22.8 to 33.5×). All three lanes matched the reference 19/19 in
every run. The Claude Code figure varies with the machine, the user's Claude
Code configuration and how long Haiku thinks: the same batch took 10 s once
and 29 s another time. Present it as the no-API-key path, not as the speed of
Haiku.

## Product GIF: compile, zero-call re-run, self-heal

`scripts/record-product.ts` records the three-beat product clip for the README
and social posts. Output: `docs/product.gif`, `docs/product.mp4` and
`docs/product-provenance.json`, 1280×720 at 6 fps.

```sh
npm run build                     # the script drives dist/, not src/
set -a; . /path/to/.env; set +a   # AI_GATEWAY_API_KEY and/or TYPESAFE_API_KEY
PRODUCT_OUT=/tmp/navvi-product npx tsx scripts/record-product.ts                     # capture + render
PRODUCT_SOURCE=/tmp/navvi-product/navvi-product-XXXX PRODUCT_PUBLISH=1 \
  npx tsx scripts/record-product.ts                                                  # re-render, copy to docs/
```

A signed-in Claude Code must be on `PATH`: with a key present and no
`--chooser`, the CLI's default resolution picks Jev for decisions and Claude
Code for the one text question (prompt parsing). The announcement line is shown
on screen.

- **Beat 1, compile.** `navvi "Extract the book title, price and availability"
  <a-light-in-the-attic_1000>` on books.toscrape.com with empty storage.
- **Beat 2, re-run.** The same command on `sharp-objects_997`, the same
  template, and the same storage: `cache hit yes`, `decider jev: 0 decisions`.
- **Beat 3, self-heal.** A controlled fixture, labeled as such on every frame.
  Four pharmacy product pages served by `tests/server.ts`: a compile on v1, a
  `switchDemo("v2")` under the same URLs, a heal run, then a replay on v2.
  Jev answers live in both the compile and the heal; nothing is recorded. The
  healed field names come from the run's `RunSummary.healingEvents`, because
  the CLI summary prints only the count, and they are drawn as an annotation
  rather than as stderr. The replay after a heal reports `promotion` events
  (the working alternatives move to the front) with zero decisions. The frame
  says so, so the non-zero count is not read as another heal.

Each run is `main()` from `dist/bin/cli.js`, called in-process with the real
argv and captured stdout and stderr. The only injection is `io.run`: it wraps
the built `run()` to add `CrawlDeps.onPage`, which screenshots the crawler's
own page every 300 ms and on each load event (a CDP capture, because
Playwright's `page.screenshot` timed out on pages that were still loading), and
to keep the `RunSummary`. A 1-second replay can close its pages before any
frame lands. The pane then shows the previous run's last page for one of the
same URLs, and the caption says so. The provenance records the screenshot count,
the capture errors and any borrowed frame for each run.
Crawler log lines (`deps.log`) go to the provenance file. They are not drawn,
because the per-launch browser diagnostic prints a local filesystem path.
Stdout JSON is drawn without `_source`, and the provenance keeps full records.

Capture and render are separate passes. Stderr chunks and screenshots carry
real timestamps. The renderer plays each run's live section with one uniform
factor, chosen from a per-run display budget, and prints `sped up N×` on the
frame whenever N > 1. Clocks and every number are the real ones. Command
typing, the "site changed" card and result holds are untimed.

The script refuses to render if the compile is not a cache miss with decisions,
if the re-run is not a cache hit with zero questions, if the heal has no
healing events, or if the post-heal replay asks a question. Before publishing,
inspect one frame per beat plus the end card.

September 24 capture (`dist/` built from `1134707`; the provenance records the
build commit and every later `src/`/`bin/` change, which was one usage-text
edit). Compile: 21.8 s, cache miss, Jev made 3 decisions (2.1 s waiting,
$0.0003), and Claude Code answered 1 text question (15.4 s waiting). Re-run:
2.1 s, cache hit, 0 decisions. Fixture compile on v1: 23.2 s, 4 decisions.
Heal on v2: 1.7 s, 4 decisions, 1 field healing event covering `product_name`,
`laboratory`, `price` and `stock`, 0 unhealed. Replay on v2: 1.0 s,
0 decisions, 4 promotion events. On screen, the live sections run at 6×, 2×,
20×, 2× and 1× respectively. On two of five earlier takes, the fixture
compile's Jev calls fell back from the AI Gateway to the TypeSafe API after
three `Service temporarily unavailable` responses. On one take, the fixture
compile ended `no_items_found`, and the script refused to render it. Neither
problem affected this capture.
