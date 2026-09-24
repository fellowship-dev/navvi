import type { Status } from "./schema.js";

/**
 * U7c: the state machine a field moves through, and the transitions it may take.
 *
 * ## Why this is not the `Status` enum
 *
 * `STATUSES` in `schema.ts` is what a *run* ends as. It is ten words long and
 * every one of them is a way for a run to stop. It says nothing about the thing
 * that actually goes wrong here, which is a **field**: offered as a candidate,
 * narrowed against its siblings, bound to one of them, gated, compiled,
 * replayed, drifted, healed. Nine of those ten words can be true of a run whose
 * every field is wrong, and the tenth — `succeeded` — was true of all three
 * defects of 2026-09-22.
 *
 * That is the whole reason for this file. On 2026-09-22 three compiled scrapers
 * were confidently wrong in three different ways — a seasonal CSS class, a list
 * price bound to a sale price, two distinct facts collapsed onto one node — and
 * `src/investigate/manuscript.ts`'s header is the canonical statement of them.
 * **Each one extracted a value, each one typechecked, and each one came back
 * `succeeded`.** A vocabulary in which those three runs are indistinguishable
 * from a correct one is a vocabulary that cannot name the defect, and
 * "a selector stopped matching" is what it says instead.
 *
 * So the states below are the lifecycle, and the run statuses are folded into
 * it as the places a run stops: a transition's `status` is what the run reports
 * when that transition is the last one it took. Every member of
 * `STATUSES` is carried by exactly one transition, checked at compile time by
 * `_everyStatusIsModelled` below and walked exhaustively by
 * `tests/machine.test.ts`, so a status added to `schema.ts` fails the build
 * until this machine learns where it happens.
 *
 * ## The three defects, as states and failed transitions
 *
 * | defect | state | transition taken that should not have been | requirement it did not meet |
 * | --- | --- | --- | --- |
 * | a seasonal CSS class | `bound` | `accept-binding` (`bound -> compiled`) | the selector survives a redesign |
 * | a list price bound to a sale price | `narrowed` | `settle` (`narrowed -> bound`) | the field's sense is told from its opposite |
 * | two facts collapsed onto one node | `offered` | `narrow` (`offered -> narrowed`) | the candidate answers for the requested entity, and its value varies |
 *
 * Three different states, three different transitions, three different
 * requirements — which is the point: before this file all three were
 * `succeeded`, and after it a failure names where it happened.
 *
 * ## The other three defects of 2026-09-22, and why they are here too
 *
 * The date carries two incidents. The one above is the three committed client
 * scrapers. The second is the first live run of the discovery cascade, whose
 * three defects `src/agree/agree.ts`, `tests/probe.test.ts` and
 * `src/investigate/blocked.ts` all call "defect 1/2/3 of that run". They are
 * modelled here as well, for a reason that is not completeness: they are the
 * incidents that bought the `deferred` state and most of `narrow`'s
 * requirements, and a machine that named the compile-time three and not the
 * run-time three would assert a tidiness the repository does not have.
 *
 * | defect | state | what went wrong |
 * | --- | --- | --- |
 * | a shell classified dead | `sampled` | `nothing-on-the-page` taken over a page that was still loading |
 * | a shell classified blocked | `sampled` | `bot-challenge` taken where there was no state to say "not yet decidable" |
 * | tier 2 deleted the one endpoint that mattered | `offered` | `narrow` refused because a sample that *could not* answer was read as one that *disagreed* |
 *
 * ## What this file deliberately does not know
 *
 * `scraper` is vocabulary and `investigate` is a stage, so the mapping from a
 * live run to a state cannot live here: an import of `classifyRun` would point
 * up a layer and `scripts/check-architecture.mjs` would refuse it, correctly.
 * What lives here is the vocabulary; what decides which word applies to a given
 * run stays in the stage that knows what a run is. `RUN_VERDICTS` below is the
 * one place that costs something, and it says so.
 *
 * Three further gaps, stated rather than smoothed over:
 *
 *  - **A status is carried by the transition where it is *decided*, not by
 *    every edge that could end in it.** `charge_limit` can bite at any point
 *    where a page is claimed; it is drawn from `sampled` because that is where
 *    the run's per-page charge is claimed. `needs_human` can be raised by
 *    healing as well as by a compile question, and is drawn at the compile
 *    question. A machine that drew every edge for every status would be a
 *    complete graph and would name nothing.
 *  - **Nothing writes `machine.mmd` yet.** `renderMachine()` produces the body;
 *    the compile stage emits it beside `scraper.json` and `rationale.md` once
 *    U11's `navvi make` driver exists to call it.
 *  - **`may-heal` is a requirement here and is not enforced at the call site.**
 *    `replay/crawler.ts` calls `createHealer()` unconditionally, so healing is
 *    reachable from a refused run in the code even though `heal: true` exists
 *    only on the drift verdict. That is Phase F's U9c, and until it lands this
 *    table describes an intent the run does not keep.
 */

// ------------------------------------------------------------------- states

/**
 * What a state is for: `kind` is the half a failure report reads.
 *
 * The line that matters is `rest` against `terminal`. A run that stops in a
 * `rest` state can be repaired by the next run — that is drift, and healing is
 * the right answer. A run that stops in a `terminal` state cannot, and a heal
 * attempted from one recompiles against whatever the site served instead, which
 * on 2026-09-22 was Store C's "¡Lo sentimos!" page. One word is the difference
 * between "your scraper broke" and "you are being refused".
 */
export type StateKind = "start" | "progress" | "undecided" | "rest" | "terminal";

export interface State {
  id: string;
  kind: StateKind;
  /** What is true of a field while it is here. One sentence, present tense. */
  what: string;
  /** The incident that made this state necessary, when one did. */
  encounter?: string;
}

const STATE_TABLE = [
  {
    id: "requested",
    kind: "start",
    what: "the spec names this field and nothing has looked for it yet",
  },
  {
    id: "sampled",
    kind: "progress",
    what: "a set of pages has been chosen to look for it on, and every page in that set was served rather than refused",
    encounter:
      "Store B, 2026-09-22: `sample.ts` marked a 200 declaring no `Product` dead, which is right for the Store A redirect and wrong for a JavaScript shell. Store B declares no `Product` on any URL because the HTML is a bundle loader, so a healthy store came back 100% dead and the investigation read 0 of 5 fields over 0 plain fetches.",
  },
  {
    id: "offered",
    kind: "progress",
    what: "at least one candidate — a declared property, a payload leaf, a DOM node — holds something that could be this field on at least one sample",
  },
  {
    id: "narrowed",
    kind: "progress",
    what: "the candidates that survived anchoring, the type check, the variation check and the agreement across samples",
  },
  {
    id: "bound",
    kind: "progress",
    what: "one candidate has been chosen for the field, with the rule or the answer that chose it recorded",
  },
  {
    id: "compiled",
    kind: "progress",
    what: "the binding is an alternative in the `CompiledScraper`, past the selector gate, with a fingerprint to check it against later",
    encounter:
      "The three committed client scrapers of 2026-09-22 reached this state and stopped: `body.one-col.christmas-pattern`, `body.modal-open` and `p.font-semibold.leading-16.leading-22`, at 27-44% product coverage. Every one of them extracted a value and typechecked, which is why nothing downstream noticed.",
  },
  {
    id: "replayed",
    kind: "rest",
    what: "the alternative resolved on a later run and produced a value of the recorded shape",
  },
  {
    id: "drifted",
    kind: "rest",
    what: "the alternative stopped resolving while the canary still resolves, so the site is serving you and the template is what changed",
  },
  {
    id: "healed",
    kind: "rest",
    what: "a new alternative has been appended beside the old one and the scraper carries `healedAt`; nothing was removed, reordered or renamed",
  },
  {
    id: "deferred",
    kind: "undecided",
    what: "the evidence so far cannot tell a page that has not loaded from a page that is being refused, and says so instead of guessing",
    encounter:
      "Store B, 2026-09-22: three shells, three Incapsula resources, ~0 characters of visible text and no declared product — which is exactly the definition of an interstitial, and exactly the definition of a bundle loader. A plain fetch cannot separate them; only a render can, and the render was never reached because the run had already called itself blocked. This is the state the module had no way to say.",
  },
  {
    id: "refused",
    kind: "terminal",
    what: "the site is refusing you, and nothing may bind or heal against a page that was not served",
    encounter:
      "Store C, 2026-09-22: `sku 0/111, stock 0/111, prices 3/111` and \"¡Lo sentimos!\" as the product name, served to Apify's datacenter IPs and reading perfectly from a laptop. A store that has looked drifted for months may only ever have been blocking the datacenter it is scraped from.",
  },
  {
    id: "absent",
    kind: "terminal",
    what: "the site was served, was read, and has nothing to offer for this field",
  },
  {
    id: "exhausted",
    kind: "terminal",
    what: "the run ran out of money or chooser budget before this field was decided; nothing here says the field is unobtainable",
  },
  {
    id: "escalated",
    kind: "terminal",
    what: "the decision left the run: it needs an answer from an intelligence or a person that this run does not have",
  },
] as const satisfies readonly State[];

export type StateId = (typeof STATE_TABLE)[number]["id"];

/**
 * The states, in lifecycle order.
 *
 * Widened to `State` on purpose. `STATE_TABLE` above keeps its literal types so
 * `StateId` is derived from the table rather than declared beside it — a second
 * spelling of a list is exactly what `tests/second-spelling.test.ts` is about —
 * and everything that *reads* the machine wants the interface, because a
 * `const` assertion drops the optional `encounter` from the states that have
 * none and makes the table unreadable generically.
 */
export const STATES: readonly State[] = STATE_TABLE;

// -------------------------------------------------------------- requirements

/**
 * One thing that has to be true before a transition may be taken.
 *
 * This is the field the machine exists for. A transition with no requirements
 * is a line on a diagram; a transition whose requirements are named is a thing
 * a failure can be attributed to, and every defect below is a requirement that
 * was not met rather than an arrow that was missing.
 *
 * `decidedBy` names the module, rule or gate that answers it, so the reader of
 * a failure has somewhere to go. `encounter` is the incident that bought it —
 * the house style everywhere in this repository, and the reason none of these
 * reads like a policy someone invented at a whiteboard.
 */
export interface Requirement {
  /** What has to be true. A full sentence, because a failure prints it. */
  must: string;
  /** The module, heuristic or gate that decides it. */
  decidedBy: string;
  /** The incident that bought this requirement, when one did. */
  encounter?: string;
}

// -------------------------------------------------------------- run verdicts

/**
 * The four answers `classifyRun` can give about a finished run.
 *
 * **This is a second spelling of `RunVerdict["state"]` in
 * `src/investigate/blocked.ts`, and it is a deliberate one.** `scraper` is
 * vocabulary and `investigate` is a stage: importing the union would point an
 * edge up a layer, which `scripts/check-architecture.mjs` refuses and is right
 * to. The house rule for an unavoidable second spelling
 * (`tests/second-spelling.test.ts`) is that a differential over the real thing
 * becomes mandatory rather than optional, so `tests/machine.test.ts` pins these
 * four words against the real union in both directions — a variant added to
 * `RunVerdict` and not added here fails the test lane's typecheck, and a word
 * here that `RunVerdict` does not have fails it too.
 *
 * What a tag means on a transition: **a run classified this way takes this
 * edge.** That is the half U9a needs — a failure that names a state and the
 * transition a verdict licensed, rather than "a selector stopped matching".
 */
export const RUN_VERDICTS = ["healthy", "drift", "blocked", "deferred"] as const;
export type RunVerdictTag = (typeof RUN_VERDICTS)[number];

// --------------------------------------------------------------- transitions

export interface Transition {
  id: string;
  from: StateId;
  to: StateId;
  /** The sentence a failure prints. Present tense, about the field. */
  because: string;
  /** Everything that has to be true to take it. */
  requires: readonly Requirement[];
  /** The run status reported when this transition is the last one a run takes. */
  status?: Status;
  /** The `classifyRun` verdict that licenses this transition, when one does. */
  onVerdict?: RunVerdictTag;
}

const TRANSITION_TABLE = [
  {
    id: "choose-a-sample",
    from: "requested",
    to: "sampled",
    because: "a compile sample was chosen and every page in it was served",
    requires: [
      {
        must: "the sample spans the strata R23 names — dead, out of stock, discounted, undiscounted — so a binding is not learned from one kind of page",
        decidedBy: "src/investigate/sample.ts `chooseSample`",
      },
      {
        must: "a URL that answered 403 is excluded from the sample rather than counted dead, because a refusal is a fact about the run and not about the product",
        decidedBy: "src/investigate/sample.ts `classify`",
        encounter: "Store C, 2026-09-22: 71 of 114 URLs refused from a datacenter and read perfectly from a laptop.",
      },
    ],
  },
  {
    id: "candidates-found",
    from: "sampled",
    to: "offered",
    because: "at least one tier offered a candidate for this field",
    onVerdict: "healthy",
    requires: [
      {
        must: "the run was classified before anything bound, and was not refused — nothing may bind against a page that was not served",
        decidedBy: "src/investigate/investigate.ts, ordering blocked before bound",
      },
    ],
  },
  {
    id: "nothing-on-the-page",
    from: "sampled",
    to: "absent",
    because: "the pages were served and read, and none of them offers anything for this field",
    status: "no_items_found",
    requires: [
      {
        must: "the page was rendered, so its emptiness is the site's answer and not a stage of loading it",
        decidedBy: "src/heuristics/rules/investigate.ts `shell-skips-tier-1`",
        encounter:
          "Store B, 2026-09-22 (defect 1 of the live run): a 200 declaring no `Product` was read as dead. That is right for the Store A redirect page and wrong for a JavaScript shell, and every Store B URL is a shell, so a healthy store left the binding set entirely. The rule needs `isShell === false`, and an unknown shell state cannot fire it either.",
      },
    ],
  },
  {
    id: "bot-challenge",
    from: "sampled",
    to: "refused",
    because: "the pages came back a bot challenge rather than the catalogue",
    status: "blocked_bot_detection",
    onVerdict: "blocked",
    requires: [
      {
        must: "the refusal marker is decisive on its own, rather than a corroboration read off a page whose emptiness the shell rule already explains",
        decidedBy: "src/blocked/challenge.ts, src/investigate/blocked.ts `classifyRun`",
        encounter:
          "2026-09-22 (defect 2 of the live run): ~0 characters of visible text, no declared product and Incapsula's script is the definition of an interstitial and also the definition of a bundle loader. The guard meant to stop a run *behind* a WAF read as a run *refused by* one. Prestep had the same shape from the other side — `status ∈ {403,429}` plus any captcha container meant a store with reCAPTCHA in its login modal was blocked there and healthy here, on the same bytes.",
      },
      {
        must: "enough of the run's URLs carry the signal that this is a policy and not a dead product; half by default",
        decidedBy: "src/investigate/blocked.ts `blockedShare`",
      },
    ],
  },
  {
    id: "login-wall",
    from: "sampled",
    to: "refused",
    because: "the pages are a login wall and the run has no credential for this site",
    status: "blocked_login_required",
    onVerdict: "blocked",
    requires: [
      {
        must: "the wording matches a login hint and the page carries no list content behind it, so a login modal over a readable catalogue is not mistaken for a wall",
        decidedBy: "src/prestep/blocked.ts `classifyBlocked`",
      },
    ],
  },
  {
    id: "hold-for-a-render",
    from: "sampled",
    to: "deferred",
    because: "the run looks refused, and every page that says so is one the shell rule already explains",
    onVerdict: "deferred",
    requires: [
      {
        must: "every blocking signal the run carries is a corroboration rather than a decisive marker, and each was read off a page the shell rule claims",
        decidedBy: "src/investigate/blocked.ts `classifyRun`",
        encounter:
          "2026-09-22: three Store B shells, three Incapsula resources, and a verdict of `blocked` on a store that was answering perfectly. There is no more evidence to be had from a plain fetch, so the run says what it is holding and what would settle it rather than guessing in either direction.",
      },
    ],
  },
  {
    id: "charge-limit",
    from: "sampled",
    to: "exhausted",
    because: "the run's pay-per-event limit was reached before this field was decided",
    status: "charge_limit",
    requires: [
      {
        must: "the charge is claimed before the page is read, so a page that cannot be paid for is never scraped",
        decidedBy: "src/billing/charge.ts `canAfford`",
      },
    ],
  },
  {
    id: "render-disproves-the-refusal",
    from: "deferred",
    to: "offered",
    because: "the render produced what a refused page has none of, so the held signals were the shell and not a wall",
    requires: [
      {
        must: "the render produced a payload the page fetched for itself, or a page a second classification does not call blocked",
        decidedBy: "src/investigate/blocked.ts `settleDeferred`",
      },
      {
        must: "the second pass runs with `shells: []`, so a page that is still a shell after a browser has had it is the refusal rather than the excuse for it",
        decidedBy: "src/investigate/blocked.ts `settleDeferred`",
        encounter: "Left to re-derive the shell rule, a WAF that blocks the page's own XHRs would defer forever.",
      },
    ],
  },
  {
    id: "render-confirms-the-refusal",
    from: "deferred",
    to: "refused",
    because: "the render produced neither a page nor a payload to disprove the signals being held",
    onVerdict: "blocked",
    requires: [
      {
        must: "a render was actually taken; a deferred run with no evidence at all is refused rather than settled either way",
        decidedBy: "src/investigate/blocked.ts `settleDeferred`",
      },
    ],
  },
  {
    id: "narrow",
    from: "offered",
    to: "narrowed",
    because: "the candidates that survived the deterministic filters and the agreement across samples",
    requires: [
      {
        must: "the candidate's value appears on the rendered page, so it is describing this page rather than being telemetry, configuration or someone else's product",
        decidedBy: "src/investigate/leaves.ts, anchoring against the page's visible text",
      },
      {
        must: "the value fits the declared type; a field declared `money` accepts a number or a currency string and never a sentence",
        decidedBy: "src/investigate/leaves.ts",
      },
      {
        must: "the value varies across the samples, because a value identical on every sample is describing the site and not the record",
        decidedBy: "src/heuristics/rules/bind.ts `no-variation-no-field`",
        encounter:
          "Store A, 2026-09-22: `productName` came back \"Store A\" on all 33 samples. The graph walk kept walking until something had a `name`, found the Organization node, and bound the store's own name as the product's — with a SKU from the URL and a price from a surviving meta tag, so the row looked extracted and would have entered a price index.",
      },
      {
        must: "the candidate answers for the entity the field is about, rather than for whichever node in the graph answered first",
        decidedBy: "src/heuristics/rules/bind.ts `json-ld-needs-product-node`, src/declared/json.ts",
        encounter:
          "Store A, 2026-09-22: one `@graph` carries Organization, WebSite and Product, and `name` resolves against all three. Walking the graph is opt-in now and says what it is walking toward; see `docs/adr/0001-one-declared-json-reader.md`.",
      },
      {
        must: "every sample was asked, at least two answered, and a sample that asked and could not be answered is left out of the comparison rather than allowed to delete it",
        decidedBy: "src/agree/agree.ts `agree`",
        encounter:
          "Store B, 2026-09-22 (defect 3 of the live run): tier 2 received 92, 88 and 50 captured payloads with `catalog-svc/products/detail` in all three and bound nothing. The third sample was a product the store itself could not serve — 401, 500, 500 — so the one endpoint the whole answer lives in was deleted for all three. What survived were the site-wide calls every page makes identically, which bind nothing because they are identical. `bindRole` at tier 1 has the same shape and is the fourth instance of one cause, known before it has bitten.",
      },
    ],
  },
  {
    id: "every-candidate-eliminated",
    from: "offered",
    to: "absent",
    because: "something was offered for this field and nothing survived narrowing",
    requires: [
      {
        must: "each elimination names the rule that made it, so an empty result is an argument rather than a shrug",
        decidedBy: "src/investigate/manuscript.ts `RejectionRecord`",
      },
    ],
  },
  {
    id: "settle",
    from: "narrowed",
    to: "bound",
    because: "one of the narrowed candidates was chosen for the field",
    requires: [
      {
        must: "the field's sense is told from its opposite: a list price is not settled by a candidate whose key, markup or vocabulary says sale",
        decidedBy: "src/heuristics/rules/bind.ts `key-names-carry-the-signal` and `struck-price-is-previous`, src/investigate/roles.ts",
        encounter:
          "Store B, 2026-09-22: three increasingly precise prompts could not make a model pick the list price out of the rendered DOM, where three prices are styled alike, and the compiled selector `p.font-semibold.leading-16.leading-22` caught the Club price. The page's own `products/detail` call names them apart — `prices: {\"price-list-std\": 3690, \"price-sale-std\": 3321}` — and no model needs to be asked. The same trap runs the other way in the declared vocabulary: schema.org's unqualified `offers.price` is what you pay *now*, which is how the committed Store C scraper spent the list-price role on the sale sense.",
      },
      {
        must: "a machine-readable attribute is preferred to rendered text when both hold the value, because the rendered form is formatted for a person",
        decidedBy: "src/heuristics/rules/bind.ts `machine-attribute-over-text`",
        encounter: "2026-09-22: rendered text \"$56.799\" parses to fifty-six under a decimal reading, while the meta tag's content attribute says 56799 and cannot be misread.",
      },
      {
        must: "when two candidates remain and no rule separates them, a model labels a small table rather than searching a DOM",
        decidedBy: "src/compile/fields.ts `buildFieldQuestions`",
      },
    ],
  },
  {
    id: "no-intelligence",
    from: "narrowed",
    to: "escalated",
    because: "a question was framed for this field and no intelligence was available to answer it",
    status: "model_unavailable",
    requires: [
      {
        must: "the transport was retried before the run gives up, because a timeout is not an answer",
        decidedBy: "src/chooser/chooser.ts, `retry-transport-not-an-answer`",
      },
    ],
  },
  {
    id: "ask-a-person",
    from: "narrowed",
    to: "escalated",
    because: "the question was parked for a person, and the run stops until it is answered",
    status: "needs_human",
    requires: [
      {
        must: "the parked batch is written with a token that resumes the run, so the hold is recoverable rather than a failure",
        decidedBy: "src/chooser/agent.ts",
      },
    ],
  },
  {
    id: "budget-exhausted",
    from: "narrowed",
    to: "exhausted",
    because: "the chooser's budget ran out before this field was settled",
    status: "budget_exhausted",
    requires: [
      {
        must: "the budget is checked before the call, not after, so the overspend never happens",
        decidedBy: "src/billing/budget.ts",
      },
    ],
  },
  {
    id: "accept-binding",
    from: "bound",
    to: "compiled",
    because: "the binding was written into the scraper as an alternative",
    requires: [
      {
        must: "the selector survives a redesign: it does not name a season, a modal state, a utility class or a line height",
        decidedBy: "the selector gate (U7b)",
        encounter:
          "The three committed client scrapers of 2026-09-22. Store A read `stock` through `body.one-col.christmas-pattern`, a class that is true until the decorations come down; Store C read `listPrice` fourteen levels deep from `body.modal-open`, a class that is true only while a dialog is open; Store B read `listPrice` from `p.font-semibold.leading-16.leading-22`, which is a line height. 27-44% product coverage, and all three extracted a value and typechecked, which is why this gate has to run before the commit rather than after the failure. A rotten selector is a recompile, not a commit.",
      },
      {
        must: "the alternative is appended and nothing is removed, reordered or renamed; the merge API cannot add or rename a field either",
        decidedBy: "src/scraper/schema.ts `appendFieldAlternative`",
      },
      {
        must: "the rationale names what was tried and what was rejected, so the binding can be argued with without opening the scraper JSON",
        decidedBy: "the compile rationale (U7a), src/investigate/manuscript.ts",
      },
    ],
  },
  {
    id: "gate-refuses-the-binding",
    from: "bound",
    to: "offered",
    because: "the gate refused the binding and the field goes back to its other candidates",
    requires: [
      {
        must: "the refusal names which part of the selector it refused, so the recompile is aimed rather than repeated",
        decidedBy: "the selector gate (U7b)",
      },
    ],
  },
  {
    id: "resolve",
    from: "compiled",
    to: "replayed",
    because: "the alternative resolved on the page and produced a value of the recorded shape",
    status: "succeeded",
    onVerdict: "healthy",
    requires: [
      {
        must: "the value matches the fingerprint recorded at compile time; a selector that resolves to the wrong shape has not resolved",
        decidedBy: "src/scraper/extract.ts",
      },
      {
        must: "alternatives for one field that return different values on the same page are two fields, not a bad alternative, and each is traced back to the payload leaf behind it",
        decidedBy: "the cross-alternative diff (U6b)",
        encounter:
          "Store B's committed `promoPrice` — 3321 from `prices[price-sale-std]` and 2952 from the DOM, on 6 of 6 samples. The DOM value is the club promotion in `promotions[]`, live only on Mondays and Thursdays and not a key under `prices`: two distinct facts collapsed onto one field, which ranking the alternatives would have hidden and dropping one would have lost.",
      },
    ],
  },
  {
    id: "trace-stops-progressing",
    from: "compiled",
    to: "refused",
    because: "a compiled trace step stopped reaching the page and the run made no progress",
    status: "blocked_no_progress",
    requires: [
      {
        must: "the step was retried and its locator alternatives were tried in order before the run calls it refused",
        decidedBy: "src/replay/entry.ts",
      },
    ],
  },
  {
    id: "stop-filling",
    from: "replayed",
    to: "drifted",
    because: "the field stopped filling while the rest of the run kept answering and the canary still resolves",
    status: "drift",
    onVerdict: "drift",
    requires: [
      {
        must: "the canary still resolves, which is the one boolean separating \"your scraper broke\" from \"the site started refusing you\"",
        decidedBy: "src/investigate/blocked.ts `checkCanary`",
        encounter:
          "The canary is deliberately insensitive to drift — an overlap threshold of 0.4, not 0.9 — because a canary that failed on every redesign would turn every drift into a false `blocked` and stop healing at exactly the moment healing is needed. Store C's apology page keeps 0.5 of the canary's words, so the load-bearing conjunct is the declared `Product`, not the word overlap.",
      },
      {
        must: "the field filled with values that vary; a field that fills 111 of 111 times with the same string has collapsed, not survived",
        decidedBy: "src/heuristics/rules/bind.ts `no-variation-no-field`, via `classifyRun`",
        encounter: "Store C, 2026-09-22: `product_name` was \"¡Lo sentimos!\" on all 111 URLs, filled every time, and only the variation check sees it.",
      },
    ],
  },
  {
    id: "site-starts-refusing",
    from: "replayed",
    to: "refused",
    because: "the field stopped filling and the canary failed with it, so the site stopped serving you",
    onVerdict: "blocked",
    requires: [
      {
        must: "the canary was actually read, body and all; a status alone does not say the page was served",
        decidedBy: "src/investigate/blocked.ts `checkCanary`",
        encounter: "Store C served its apology page with a 200 and a rendered body, so a status check alone would have called the canary resolved and the run drift.",
      },
      {
        must: "the verdict names a remedy, because a blocked verdict that only says blocked hands the problem back to whoever read it",
        decidedBy: "src/investigate/blocked.ts `Remedy`",
      },
    ],
  },
  {
    id: "append-an-alternative",
    from: "drifted",
    to: "healed",
    because: "the field was re-picked over the leaves on the drifted page and a new alternative was appended",
    requires: [
      {
        must: "the run's verdict is drift: `mayHeal` is the only way to a heal, and `heal: true` exists on no other variant",
        decidedBy: "src/investigate/blocked.ts `mayHeal`",
        encounter:
          "Store C, 2026-09-22: a recompile against a page that said \"¡Lo sentimos!\" would have learned the apology and committed it. Note that `replay/crawler.ts` still calls `createHealer()` unconditionally — the guarantee is real in the type system and unenforced in the run until Phase F's U9c lands.",
      },
      {
        must: "only the failing fields are re-picked, over the leaves on that page that are not already an alternative, plus none",
        decidedBy: "src/replay/heal.ts `createHealer`",
      },
    ],
  },
  {
    id: "repaired",
    from: "healed",
    to: "replayed",
    because: "the appended alternative resolved and the field fills again",
    requires: [
      {
        must: "the repaired scraper was stored before the re-extract, so the next page uses it too",
        decidedBy: "src/replay/crawler.ts",
      },
    ],
  },
  {
    id: "heal-needs-an-answer",
    from: "drifted",
    to: "escalated",
    because: "the repair needs a chooser answer the run cannot get",
    requires: [
      {
        must: "a chooser failure skips the healing and the page counts as unhealed rather than ending the crawl, unless it is a parked human question",
        decidedBy: "src/replay/crawler.ts `heal`",
      },
    ],
  },
] as const satisfies readonly Transition[];

export type TransitionId = (typeof TRANSITION_TABLE)[number]["id"];

/** The transitions, in declaration order; widened for the same reason `STATES` is. */
export const TRANSITIONS: readonly Transition[] = TRANSITION_TABLE;

// ------------------------------------------------------------- the totality

/**
 * Compile-time totality over `STATUSES`.
 *
 * `CoveredStatus` is the union of statuses the table above actually carries. If
 * `schema.ts` gains a status this machine has not placed, the assignment below
 * stops compiling and the error names the missing member — which is the
 * property that makes this file worth committing rather than a picture that
 * rots. `tests/machine.test.ts` walks the same union at run time so the failure
 * is also a red test and not only a red build.
 */
type CoveredStatus = Extract<(typeof TRANSITION_TABLE)[number], { status: Status }>["status"];
type EveryStatusIsModelled = Status extends CoveredStatus ? true : ["unmodelled status", Exclude<Status, CoveredStatus>];
const _everyStatusIsModelled: EveryStatusIsModelled = true;
void _everyStatusIsModelled;

// --------------------------------------------------------------- the lookups

const STATE_BY_ID = new Map<string, State>(STATES.map((state) => [state.id, state]));
const TRANSITION_BY_ID = new Map<string, Transition>(TRANSITIONS.map((transition) => [transition.id, transition]));
const TRANSITION_BY_STATUS = new Map<Status, Transition>(
  TRANSITIONS.flatMap((transition) => (transition.status === undefined ? [] : [[transition.status, transition] as const])),
);

/** The state, or `undefined` for a name this machine does not have. */
export function stateOf(id: string): State | undefined {
  return STATE_BY_ID.get(id);
}

/** The transition, or `undefined` for a name this machine does not have. */
export function transitionOf(id: string): Transition | undefined {
  return TRANSITION_BY_ID.get(id);
}

/** Everything a field in this state may do next, in declaration order. */
export function transitionsFrom(state: StateId): Transition[] {
  return TRANSITIONS.filter((transition) => transition.from === state);
}

/** Every transition a run classified this way licenses, in declaration order. */
export function transitionsForVerdict(verdict: RunVerdictTag): Transition[] {
  return TRANSITIONS.filter((transition) => transition.onVerdict === verdict);
}

/**
 * Where a run that ended with this status stopped.
 *
 * Total by construction — `_everyStatusIsModelled` above is what makes the
 * non-null safe — and the reason it is worth having: a status is a word, and
 * this turns it into a place in a lifecycle with an edge that led there.
 */
export function transitionForStatus(status: Status): Transition {
  const transition = TRANSITION_BY_STATUS.get(status);
  /* c8 ignore next */
  if (!transition) throw new Error(`no transition carries status "${status}"; the machine and STATUSES have drifted`);
  return transition;
}

/** The state a run that ended with this status left its fields in. */
export function stateForStatus(status: Status): State {
  const id = transitionForStatus(status).to;
  const state = STATE_BY_ID.get(id);
  /* c8 ignore next */
  if (!state) throw new Error(`transition for status "${status}" points at unknown state "${id}"`);
  return state;
}

/**
 * A failure, in the words U9a asks for: a state and the transition that got
 * there, rather than "a selector stopped matching".
 */
export function describeStatus(status: Status): string {
  const transition = transitionForStatus(status);
  const state = stateForStatus(status);
  const repairable = state.kind === "rest" ? "the next run can repair it" : "no run continues from here without a person";
  return `${status}: ${transition.from} -> ${transition.to} via ${transition.id} — ${transition.because}; the field rests in "${state.id}" (${state.what}), and ${repairable}`;
}

// --------------------------------------------------------------- the diagram

/**
 * The machine as the body of `work/<case>/machine.mmd`, printed beside
 * `scraper.json` and `rationale.md`.
 *
 * `stateDiagram-v2` rather than `graph TD`, for two reasons. The first is that
 * `[*]` is part of the notation: a start marker and an end marker are drawn
 * rather than inferred by a reader counting arrowheads, and *where a run stops*
 * is the diagnostic payload of this whole file — a `rest` state heals and a
 * `terminal` state does not. The second is that `docs/architecture.md` already
 * spends `graph TD` on the import graph, and two different pictures of two
 * different things should not look like the same kind of picture.
 *
 * The output is a body, not a fenced block, the same way
 * `scripts/check-architecture.mjs --graph` prints one: a `.mmd` file is raw
 * mermaid, and a caller embedding it in Markdown adds its own fence.
 */
export function renderMachine(): string {
  const lines: string[] = [];
  // The diagram type first, before any comment: mermaid sniffs it off the head
  // of the text, and a `%%` line above it is one more thing to be right about
  // in a file nothing here can parse to check.
  lines.push("stateDiagram-v2");
  lines.push("%% The lifecycle of one field, generated by renderMachine() in src/scraper/machine.ts.");
  lines.push("%% A run stops at a double circle. From a rest state the next run repairs it; from a terminal state it does not.");
  lines.push("  [*] --> requested");

  for (const state of STATES) {
    lines.push(`  ${state.id} : ${clean(state.what)}`);
  }

  for (const transition of TRANSITIONS) {
    const verdict = transition.onVerdict ? ` (${transition.onVerdict})` : "";
    const status = transition.status ? ` = ${transition.status}` : "";
    lines.push(`  ${transition.from} --> ${transition.to} : ${clean(transition.id)}${verdict}${status}`);
  }

  for (const state of STATES) {
    if (state.kind === "rest" || state.kind === "terminal") lines.push(`  ${state.id} --> [*]`);
  }

  for (const state of STATES) {
    if (!state.encounter) continue;
    lines.push(`  note right of ${state.id}`);
    lines.push(`    ${clean(state.encounter)}`);
    lines.push("  end note");
  }

  return lines.join("\n") + "\n";
}

/**
 * Mermaid reads `:` as the separator between an id and its label and `;` as an
 * end of statement, so neither may appear in a label. Newlines are collapsed
 * for the same reason: one statement is one line.
 */
function clean(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[:;]/g, " —").trim();
}
