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
DEMO_OUT=/tmp/navvi-recordings \
npx tsx scripts/record-race.ts
```

Provide TypeSafe credentials and an authenticated Claude Code harness through the environment; the Haiku lane explicitly pins `haiku`. Jev's text helper follows the configured provider fallback, so document that provider in the publication caption if comparing costs. `DEMO_OUT` is a parent directory: each invocation prints and creates a new `navvi-race-*` child, preserving earlier runs. Omit URL and prompt to use the controlled search fixture. `DEMO_EXPECT_SOURCE` optionally requires every output row’s `_source` to exactly equal the supplied URL, in both lanes and phases. It is a recording acceptance oracle only: it never reaches the run input or chooser and cannot guide navigation. For Remote OK, this rejects an unapplied search that extracted homepage jobs.

Both lanes pass only the natural-language prompt plus the URL and common browser/page/item limits. Their first-run caches are isolated. Replay reuses each lane's own storage with a new chooser and a new crawler browser. Each crawler uses a 1200×700 desktop viewport, scaled to a 600×350 panel to preserve the site layout. The `CrawlDeps.onPage` hook captures the actual page for compile and replay; there is no separately navigated preview. Timers include prompt parsing, data retrieval and capture overhead. This is a recorded workflow measurement, not an isolated provider benchmark.

Each run directory retains `receipt.json` (commit, dirty-file list, input, phase timings, usage and summaries), four `*-rows.json` outputs, per-phase `*-questions.jsonl` diagnostics (question state, options, answers, errors and timestamps), storage and PNG frames. These diagnostic files are intended for public-site demo inputs only. If either lane returns no rows, missing fields or empty requested values in any row, an unexpected `_source` when configured, a blocked/error status or mismatched saved-row count, the script saves the evidence and exits without encoding a success clip. A successful replay only says “zero model calls” when its fresh chooser reports zero questions. Nonzero replay questions stay visible. Successful status does **not** establish semantic correctness: compare the saved rows against the displayed jobs before publishing.

Do not present the existing `record-live.ts` recorded-answer flow as live model decision-making.

Opening: “Jev made browser agents fast. I wanted the second run to stop needing an agent.” Closing: “Prompt → reusable scraper. AI returns when a selector breaks.” If healing is shown, label it as a separate controlled-site demonstration.

## Review before publishing

Inspect the first frame, form interaction, first real results, both timer stops, replay and last frame. Watch the complete MP4 at normal speed. Ensure labels match the actual chooser and cache state, text is legible at mobile width, and no credential or private data appears. Save the exact command, commit, run summaries, correctness check and timing receipt beside the recording work. Use MP4 for the social post and GIF for the README. Publishing follows review of the actual clip.
