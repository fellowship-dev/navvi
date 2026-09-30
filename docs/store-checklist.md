# Apify Store publication checklist

What has to happen, in order, before navvi is public on the Apify Store. The
repository already carries the Store README (`.actor/README.md`, wired as
`readme` in `.actor/actor.json`), the input schema and the dataset schema;
everything below is Console work, a credential, or a decision. Tick each item
with the date and the evidence.

## Gates (decide before anything goes public)

- [ ] **Prompt-injection pre-filter shortfall.** `evals/injection/REPORT.md`
  reports R17 as *not demonstrated*: the shipped rules detect 89.1% of indirect
  attacks on the test split (41.6% on held-out WAInjectBench) at 0% benign false
  positives on our pages, while Llama Prompt Guard 2 86M's published bar is
  97.5% recall at 1% FPR, on a different benchmark, and was not run here. One
  of:
  - run `evals/injection/promptguard.py` on the same corpus (accept Meta's
    Llama 4 Community License on Hugging Face, set `HF_TOKEN`) and publish only
    if the rules hold up at equal detection; or
  - accept the shortfall explicitly, in writing, with the date.
- [ ] **Key surface on the Store.** R16 says the Store surface takes a Gateway
  key only. Today `.actor/input_schema.json` still publishes
  `typesafeApiKey`, `gatewayApiKey` and `anthropicApiKey`, and the client tasks
  on the private actor use `typesafeApiKey`. Choose:
  - **(a) Store = Gateway-only.** Drop `typesafeApiKey` and `anthropicApiKey`
    from the published schema (CLI and env keep them). The client tasks move to
    `gatewayApiKey`, or to the operator key and pay `decision` events. Update
    `PLATFORM_INPUT_KEYS`/`ACTOR_ONLY_KEYS`, `tests/input-schema.test.ts` and
    the README's "Bring your own key" paragraph in the same change.
  - **(b) Keep all three keys.** Amend R16: bring-your-own-key through any of
    the three providers. Nothing changes in code; the README is already
    accurate.
  - **(c) Two actors.** The Store actor publishes the Gateway key only; a
    private actor (or build tag) with the full key surface serves the client
    tasks. Costs a second schema and a second push target.

## Credentials

- [ ] **Operator Gateway key.** Create a dedicated Vercel AI Gateway key for the
  Store actor, separate from the personal `vercel-ai-gateway-key` the beta runs
  on today, and set a **spend cap** on it in the Vercel dashboard. Put it in the
  actor's environment variables as a secret `AI_GATEWAY_API_KEY`. The Gateway
  answers both Jev (`typesafe-ai/jev`) and the Claude writer (`anthropic/...`),
  so one key covers every question. Check that the account can reach the
  Haiku route: the free tier refused it on 2026-09-20.
- [ ] **Catalog it.** Record the key by name (never the value) in
  `fellowship-dev/claude-buddy` `runbooks/catalog.json`: a credential entry
  (id, owner, `AI_GATEWAY_API_KEY`, location, recovery policy, spend cap in
  the validation note) and its id in the `navvi-apify-actor` record's
  `credential_ids`, with catalog validation passing in the same commit.
- [ ] **`APIFY_TOKEN` as a GitHub secret.** Add it as a repository secret on
  `fellowship-dev/navvi` so CI's `push-actor` job pushes every green `main` to
  the `beta` tag. Without it the job is skipped, not failed. Record the secret
  (by name) against the actor's catalog record.

## Console: pricing

- [ ] Set the pricing model to **pay per event** and price the five events.
  Code never states a price; `docs/apify.md` has the exact semantics:
  - `actor-start`: once per run, first thing.
  - `scraper-compiled`: once per template compiled this run; a cache hit is
    free.
  - `page-scraped`: per page read (listing, paginated page, detail page).
  - `result-item`: per dataset item.
  - `decision`: per chooser question answered **on the operator key** (compile,
    navigation, healing, prompt parse; a batch of N is N). A run with its own
    key is charged none; a replay that asks nothing is charged none. Price it at
    least at the operator's per-question Gateway cost plus margin: it is the
    only event that pays the Gateway bill.
- [ ] Remember the caller pays events and the operator pays platform usage
  (compute, residential proxy, storage), so event prices need a compute margin.
- [ ] Test one run with a low maximum charge per run and read `SUMMARY.charges`
  against the Console's charged events.

## Console: listing

- [ ] **Logo.** Upload `docs/navvi-logo.png` (or a square crop of it).
- [ ] **Categories.** Suggested: Developer tools, AI, Automation (pick from the
  Console's list).
- [ ] **SEO title and description.** Set them in the Console: `actor.json` has
  no SEO fields in Apify's spec. Suggested title: "Navvi: AI scraper compiler,
  zero-model replay". Suggested description: "Describe the data in plain words;
  Navvi compiles a scraper, replays it with no model call and heals it when the
  site changes. Typed prices, stock, dates and links."
- [ ] **Sample output.** Promote the build, then run the prefilled input
  unchanged (Hacker News front page, list mode, one page, typed `title`,
  `link`, `points`, `comments`) on the `latest` build and use that run's dataset
  as the example. Never use a client run: its rows and URLs are not public.
  The dataset's "Example run (Hacker News)" view shows those columns.
- [ ] **README preview.** Open the actor's Information tab after the push and
  check that `.actor/README.md` renders, images load and every link is absolute.

## Release

- [ ] **Promote to `latest`.** CI and `scripts/push-beta.mjs` only push `beta`
  (and `beta-camoufox`). Once a `beta` build has passed the prefill run and the
  gates above, set its build as `latest` in the Console (Builds, the build, then
  the tag). The Store runs `latest`.
- [ ] **Daily Store test.** Apify runs the prefill every day; three failures in
  a row mark the actor under maintenance. Check the first few days.
- [ ] Publish from the Console, then update the `navvi-apify-actor` catalog
  record's lifecycle and validation note.
