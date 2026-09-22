# Why a browser relaunch fails on the Apify Chrome image

Status: **trigger found and fixed.** The relaunch itself is still unexplained.

## Correction, 2026-09-21

`d99ad0c` claimed the browser pool's `retireBrowserAfterPageCount: 100` was the
trigger and raised it. **That was wrong.** Build 3.0.9 carried the change and
failed identically — Store B at 536 s and 49 rows against 3.0.8's 551 s and
48 rows, same error. Memory peaked at 25% of the 4096 MB limit, so it was not
OOM either.

**The real trigger is the session pool.** Crawlee's `Session` defaults to
`maxUsageCount: 50` (`@crawlee/core` `session_pool/session.js`), and
`BrowserCrawler` retires the *browser* when a session retires (`@crawlee/browser`
`browser-crawler.js`: on `EVENT_SESSION_RETIRED` ->
`browserPool.retireBrowserController`). So an unconfigured run tore the browser
down and relaunched it **every 50 requests** — which is exactly where Store B
died twice, and why StoreC, at 10 requests, survived.

Fixed by setting `sessionOptions.maxUsageCount` in
`buildSessionPoolOptions` (`src/replay/crawler.ts`). A run replaying a pinned
scraper is not evading a block, so a fresh session buys nothing but a browser
restart. The browser-pool bound from `d99ad0c` is kept — one browser per run is
reasonable on its own terms — but it fixed nothing.

## What happened

Two Apify runs on 2026-09-21 (build 3.0.8, client price scrapes, `store` profile,
Chromium) ended like this:

```
INFO  PlaywrightCrawler: Finished! Total 50 requests: 50 succeeded, 0 failed. {"terminal":true}
ERROR [Status message]: Failed to launch browser. Please check the following:
      - Check whether the provided executable path "/pw-browsers/chrome" is correct.
      - Make sure your Dockerfile extends `apify/actor-node-playwright-*` ...
      The original error is available in the `cause` property. ...
```

The crawler finished **cleanly** and the run failed 86 ms later, exit code 1.
Store B died at 50 of 109 URLs (551 s), StoreA at 29 requests (445 s). A
third run that only reached 10 requests survived.

## What is established

- **The first launch works.** Both runs scraped dozens of pages before failing,
  so `/pw-browsers/chrome` resolves correctly at least once. A simply-wrong
  executable path would fail the first launch too.
- **The trigger is a pool relaunch.** The browser-pool bound was applied only to
  runs with a persistent profile, so a `store` run inherited Crawlee's
  `retireBrowserAfterPageCount: 100`. `record` mode opens an extra sample page
  per request, so ~50 requests is already ~100 pages — which is exactly where
  Store B stopped. Fixed in `d99ad0c` by applying the bound unconditionally.
- **It also truncated the crawl.** Those runs ended at 50 and 29 requests
  against lists of 109 and 138, so the crawl stopped when the pool died rather
  than when the queue emptied.

## What is not established

Why the *replacement* launch fails when the first succeeded. Candidates, none
confirmed:

1. The image's Chrome does not tolerate a second concurrent or rapid
   re-launch (single-instance wrapper, lock file, or a user-data dir still held
   by the retiring browser).
2. Crawlee resolves `executablePath` differently on the replacement launch than
   on the first.
3. Memory: 4096 MB with Chromium under `xvfb`; a retiring browser that has not
   fully exited leaves too little for a second.

The decisive evidence is the `cause` property, which the run log truncates.

## How to settle it

1. Log the `cause`. Wrap the crawler run so a launch failure prints
   `err.cause?.message` and the resolved `executablePath`, plus
   `APIFY_DEFAULT_BROWSER_PATH` and `PLAYWRIGHT_BROWSERS_PATH`. One build.
2. Reproduce deliberately: a build with `retireBrowserAfterPageCount: 5` against
   ~20 URLs forces several relaunches in about a minute, instead of waiting nine
   minutes for the natural trigger.
3. With the cause in hand, decide whether this belongs in navvi (launch options,
   teardown ordering) or in the Dockerfile.

Until then, a run that never retires a browser never hits it — which is what
ships today, and is also a defensible default on its own terms.

## Why it still matters

`retireBrowserAfterPageCount: 1_000_000` means one browser serves an entire run.
That is fine for a few hundred pages, and untested for a long one: a leaking
browser now has no recycling mechanism to rescue it. If a catalogue run ever
grows past a few thousand pages, this needs to be understood rather than
avoided.


## 2026-09-21, third attempt: stop plugging triggers, instrument the failure

Build 3.0.10 carried the session-pool fix and **still failed**, but much later:

| build | change | runtime | rows |
| --- | --- | --- | --- |
| 3.0.8 | — | 551 s | 48 |
| 3.0.9 | browser pool bound raised | 536 s | 49 |
| 3.0.10 | session `maxUsageCount` raised | **932 s** | **84** |

So `maxUsageCount: 50` was a genuine trigger — throughput nearly doubled — but
not the only one. The remaining path is the session's **error score**:
`session.js` `markBad()` calls `retire()` once `errorScore` reaches
`maxErrorScore` (default **3**), and a retired session retires the browser just
the same. Store B produces healing failures on some pages, so a run
accumulates errors and eventually retires its session that way instead.

**Three hypotheses, three builds, two partially right, the run still fails.**
That is the wrong method. Every one of these paths ends in the same place: a
browser relaunch that fails on this image. Enumerating the paths that retire a
browser is unbounded; making the relaunch work, or learning why it cannot, is
one question.

**Do this first, before any further fix:**

1. **Log the cause.** Wrap the crawler run so a launch failure prints
   `err.cause?.message`, the resolved `executablePath`, and the values of
   `APIFY_DEFAULT_BROWSER_PATH` and `PLAYWRIGHT_BROWSERS_PATH`. The run log
   truncates the `cause` today, and it is the only thing that actually names the
   problem.
2. **Force the repro cheaply.** A build with `maxErrorScore: 1` and
   `maxUsageCount: 5` over ~20 URLs provokes several relaunches in about a
   minute, instead of waiting fifteen for a natural one.
3. Only then decide whether the fix belongs in navvi's launch or teardown, or in
   the Dockerfile.

A plausible reading of the evidence, worth testing directly: the image's Chrome
may not tolerate a second launch while the retiring browser still holds
something (a lock, a user-data directory, a port), in which case the fix is
ordering — await the old browser's exit before launching the replacement —
rather than avoiding retirement at all.
