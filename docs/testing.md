# Tests and CI

The `test` job in `.github/workflows/ci.yml` is the current TypeScript compiler suite, not the archived v2 implementation. It installs dependencies, checks actor image pins, installs Chromium, typechecks, runs `npm test`, then builds the package and copies browser assets.

- `NAVVI_BROWSER=chromium` selects the browser installed on the Linux runner; the local product defaults to Camoufox. It is configuration, not an API key.
- GitHub Actions already sets `CI=true`. Postinstall uses that to skip downloading Camoufox. The redundant explicit `CI: "1"` was removed.
- Offline tests use local fixture pages and recorded chooser answers. They exercise compile, navigation, replay, healing, cache, CLI, secrets and billing behavior; they do not measure live Jev or Haiku quality/latency.
- `npm run test:live` sets `NAVVI_LIVE=1` and exercises Python.org with configured provider keys. It is an intentional opt-in network test and is not part of ordinary CI.
- `tsconfig.json` excludes `tests/` and vitest only strips test types, so neither `npm run typecheck` nor `npm test` reads a type error in a test file. `npm run typecheck:tests` (`tsconfig.test.json`, extending the base at the same strictness, over `tests/`, `src/`, `bin/`, `tools/` and `scripts/`) is what checks them. CI runs it as its own step; five type errors had accumulated in `tests/` before it existed.
- `npm run build` compiles `src/` and `bin/` only. `files` ships all of `dist`, so anything else compiled is published: the measurement harness and two dev scripts imported `tests/server.ts`, and `dist/tests/server.js` was on npm until the harness moved to `tools/` and `scripts/` left the build. Repo tooling is run with `tsx` and typechecked by the test lane, never compiled.
- `vitest.config.ts` bounds the workers because twelve test files drive a real browser. A test file that starts many browser runs inside one hook defeats that bound: `tests/measure.test.ts` used to run all nine measurement scenarios in a 300-second `beforeAll` and failed roughly one full run in three on contention, while passing alone. It now checks the harness against stub scenarios and keeps a real browser run only for the three goal-driven first crawls no other test performs; `npm run measure` is still the nine.
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
