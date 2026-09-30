# navvi 3.1.0: release notes draft

Draft for the GitHub release of `v3.1.0`, for Max to edit and publish after
`npm publish`. Everything below the line is the release body.

Publishing notes (not part of the body):

- Tag `v3.1.0` on the commit that is published to npm; leave every existing tag
  as it is.
- GitHub's current "Latest" release is `v3.21.0`, from the retired Python line.
  Create this one with `gh release create v3.1.0 --latest --notes-file …` (or
  tick "Set as the latest release") so the TypeScript line is what the repository
  page shows.

---

## navvi 3.1.0

One compiler, Jev first, and replay you can run on a thousand URLs and believe.

```bash
npm install -g navvi
npx playwright install chromium
navvi "Extract the book title, price and availability" <url>
```

### Highlights

- **One compile core.** `navvi "<prompt>" <url>` and `navvi make` compile through
  the same code: what the page declares (JSON-LD, meta) first, then the JSON the
  page fetches for itself, then DOM candidates a model only picks among.
  `--work <dir>` writes every step as a file you can read and edit.
- **Jev first.** With `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` set, navvi picks
  Jev by itself: on the same 19 real navigation questions, 3.6x faster than Claude
  Haiku over the API and 8-11x faster than Haiku through Claude Code, all 19/19.
- **No surprise bills.** Free-text questions go to a signed-in Claude Code or
  Codex on your subscription first; a CLI that is busy or signed out never hands
  over to a metered API. The CLIs run from a neutral directory, so your project's
  own agent instructions do not reach them.
- **Lists and partial results.** A field with several values is a list; a field
  never found ends the run `partial` and says which one, on compile and on every
  replay.
- **Replay at scale.** Every start URL's first page is read, `maxPagesPerStart`
  caps each listing, every row carries `_startUrl`, and a pinned scraper replays
  the URLs of its template on a mixed list and reports the rest (`offTemplate`).
- **Honest run reports.** A page that is not a readable page of the template is
  counted, not healed: `blockedPages` (the first one kept with a screenshot),
  `deadPages`, `transientPages`, `unsettledPages`, `noPayloadPages`,
  `emptyListings`, plus `optionalDrift` for optional fields.
- **Sturdier compiles.** Renamed slugs that redirect to the same product are that
  product; redirected pages are compared by the URL that was asked for; a page
  that never goes network-idle no longer costs 90 s a visit; selectors are the
  shortest unique on every sample.
- **Apify actor.** `scraperStore` keeps a run's scrapers in its own store (pass
  it by ID), `maxConcurrency`/`minConcurrency` and optional fields are inputs, and
  replay pages load lighter.

The full list is in [CHANGELOG.md](https://github.com/fellowship-dev/navvi/blob/main/CHANGELOG.md).

### About the older 3.x tags

This repository also carries the tags `v3.9.0` through `v3.21.0` and
`v3.22.0-py`. They belong to the **retired Python navvi**, which was published on
PyPI and is frozen (its last release is `v3.22.0-py`, also tagged `v2-final`).
They are not versions of this package and are not on npm.

The TypeScript navvi on npm restarted its numbering at 3.x: `3.0.0`, then this
`3.1.0`. The old tags stay untouched so existing links and pins keep working, which
means they sort above `v3.1.0` in the tag list. For this package, the npm version
is the one to read: `npm view navvi version`.
