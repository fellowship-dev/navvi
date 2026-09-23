# Tests and CI

The `test` job in `.github/workflows/ci.yml` is the current TypeScript compiler suite, not the archived v2 implementation. It installs dependencies, checks actor image pins, installs Chromium, typechecks, runs `npm test`, then builds the package and copies browser assets.

- `NAVVI_BROWSER=chromium` selects the browser installed on the Linux runner; the local product defaults to Camoufox. It is configuration, not an API key.
- GitHub Actions already sets `CI=true`. Postinstall uses that to skip downloading Camoufox. The redundant explicit `CI: "1"` was removed.
- Offline tests use local fixture pages and recorded chooser answers. They exercise compile, navigation, replay, healing, cache, CLI, secrets and billing behavior; they do not measure live Jev or Haiku quality/latency.
- `npm run test:live` sets `NAVVI_LIVE=1` and exercises Python.org with configured provider keys. It is an intentional opt-in network test and is not part of ordinary CI.
- `tsconfig.json` excludes `tests/` and vitest only strips test types, so neither `npm run typecheck` nor `npm test` reads a type error in a test file. `npm run typecheck:tests` (`tsconfig.test.json`, extending the base at the same strictness, over `tests/`, `src/`, `bin/`, `tools/` and `scripts/`) is what checks them. CI runs it as its own step; five type errors had accumulated in `tests/` before it existed.
- `npm run build` compiles `src/` and `bin/` only. `files` ships all of `dist`, so anything else compiled is published: the measurement harness and two dev scripts imported `tests/server.ts`, and `dist/tests/server.js` was on npm until the harness moved to `tools/` and `scripts/` left the build. Repo tooling is run with `tsx` and typechecked by the test lane, never compiled.
- `vitest.config.ts` bounds the workers because twelve test files drive a real browser. `tests/measure.test.ts` used to run all nine measurement scenarios in one 300-second `beforeAll`; it now checks the harness against stub scenarios and keeps a real browser run only for the three goal-driven first crawls no other test performs. `npm run measure` is still the nine.
- That file's `F3-category` failure was blamed on worker contention for weeks and was not contention. It fails alone, on an idle machine, in the same 2.9 s as a passing run: 2 of 25 solo runs on 2026-09-23, and cutting the file from nine scenarios to three (four times faster) did not change the rate. Isolating the file into its own Vitest group did not either — two of five full runs still failed with it isolated.
- The cause is a real defect in `controls()` (`src/browser/snapshot.inject.js`), not in the test. It decides `clickable` for a control below the fold by scrolling it into view and hit testing its centre, and that hit test is a function of viewport **height**: on `tests/fixtures/python-jobs.html` there is a ~13 px band every ~102 px — one per job row — in which exactly one job link fails it and is dropped from the controls entirely. Measured through `getControls` itself, 54 of the 326 heights between 600 and 1250 drop a link (17%); the band at 1112–1124 drops `jobs/109`, the link missing from every observed failure. Width makes no difference. **A link a person can click is not offered to the chooser at all, at one window height in six.** In a replay that is a loud failure; in a real run it is silent, and the model simply never sees the candidate.
- What randomises it in tests is Crawlee's fingerprint injection, which is on for Chromium and gives every browser launch a different viewport (1366×768 to 3440×1440 over twenty launches). A recorded answer is an index into the options a question offered and the recording states the options it answered (`src/chooser/recorded.ts`), so replaying it against a randomly sized window is not a reproducible test. `tests/navigate.test.ts` pins the same 33-option list from the same page in seven recordings and has never flaked, because it drives raw Playwright at its fixed 1280×720 default.
- So the measurement harness pins that same viewport: `deps()` in `tools/measure/scenarios.ts` sets 1280×720 through the `onPage` hook, which makes the replay reproducible and says out loud what `navigate.test.ts` gets by accident. `F3-category` then passed 40 of 40 solo runs. This does not fix the hit test, and the defect above is still open.
- A failed measurement row is `{ correct: 0, expected: <every cell> }` whether the scenario threw, ended blocked, or crawled a page and found nothing — three different causes behind one number, and `log: () => undefined` discarded the sentence that tells them apart. `tests/measure.test.ts` now keeps the harness's log line per scenario and passes it as the message of the expectation about that scenario, so a failure names its own cause.
- `tests/storage-guard.ts` compares repository storage against its starting state so test runs cannot silently leave local browser/profile data behind.
- The separate `push-actor` job depends on the test job and checks for `APIFY_TOKEN`; it pushes an Apify beta only when that secret exists. It is owned by the parallel Apify work. There is no npm publication job; npm releases are manual.

Local equivalent of the CI test lane:

```sh
NAVVI_SKIP_BROWSER_DOWNLOAD=1 npm ci
npx playwright install chromium
node scripts/check-image-pins.mjs
npm run typecheck
npm run typecheck:tests
NAVVI_BROWSER=chromium npm test
npm run build
```

A passing offline suite is not proof of a real-site result. Keep live compile/replay rows, model usage and correctness checks as separate release evidence.
