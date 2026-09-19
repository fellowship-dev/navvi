# Navvi v3

Self-healing scraper compiler. The plan lives in `fellowship-dev/claude-buddy`
under `specs/plans/2026-09-19-001-feat-jev-compiled-scraper-actor-plan.md`.

## Verify

- `npm run typecheck` and `npm test` on every change. Tests are offline:
  recorded chooser answers, fixtures served from disk.
- `npm run demo` runs the two-version pharmacy proof offline.
- `npm run test:live` needs a key and is required after changes under
  `src/chooser`, `src/compile`, `src/navigate`, `src/replay/heal.ts`,
  `src/secrets` or `src/browser/policy.ts`.

## Rules

- `playwright` stays pinned to 1.60.0: `camoufox-js` caps `playwright-core`
  below 1.61 and the Apify Camoufox image tops out at 1.60.0.
- Secrets are `{{secret:name}}` placeholders filled by code. A secret value
  never enters a chooser question, a log, a trace or the scraper JSON.
- The chooser only picks among code-enumerated options. Never let model
  output become a selector or a script.
- `storage/` holds browser profiles with live sessions. Never commit it,
  never copy it between machines.
