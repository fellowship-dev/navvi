# Recording Navvi demos

Reuse the TypeScript scripts and shared `scripts/recorder.ts` compositor. There is no VHS prerequisite. Run commands from the repository root. These commands regenerate their named assets and frame directories; preserve a wanted previous cut before running them.

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
| `npx tsx scripts/record-race.ts` | `docs/race.gif`, `docs/race.mp4` | Live Jev versus Claude chooser on a controlled search-form fixture. Requires TypeSafe credentials plus an available text-model provider or supported local harness. |

The shared demo layout is 960×600 at 6 fps. The race uses 1280×560, GIF at 4 fps and MP4 at 8 fps. Preserve actual event timestamps for timers; the scripted holds in the illustrative clips are not end-to-end performance measurements.

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

Adapt `record-race.ts` rather than creating a second rendering pipeline. Before using it for this claim, remove its prestructured-input shortcut, replace the fixture with the verified public-site flow, and capture the real replay page instead of its separate `peek` page. Do not present the existing `record-live.ts` recorded-answer flow as live model decision-making.

Opening: “Jev made browser agents fast. I wanted the second run to stop needing an agent.” Closing: “Prompt → reusable scraper. AI returns when a selector breaks.” If healing is shown, label it as a separate controlled-site demonstration.

## Review before publishing

Inspect the first frame, form interaction, first real results, both timer stops, replay and last frame. Watch the complete MP4 at normal speed. Ensure labels match the actual chooser and cache state, text is legible at mobile width, and no credential or private data appears. Save the exact command, commit, run summaries, correctness check and timing receipt beside the recording work. Use MP4 for the social post and GIF for the README. Publishing follows review of the actual clip.
