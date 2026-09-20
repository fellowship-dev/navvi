# The Jev hillclimb

Jev (TypeSafe) answers Navvi's compile and healing questions in under half a
second for a fraction of a cent. The first live measurement (2026-09-19,
`docs/measurements.md`) showed it picking `none` too readily on two question
types: confirming the only item group on a listing, and picking a replacement
candidate while healing a field. Max's read: Jev was given a bare premise and
raw option strings. It is a classifier that lives on criteria descriptions,
rubrics and structured state. This document is the measured climb out of that.

## The loop

1. **The bank.** `npm run measure -- --choosers agent --offline --bank` runs
   every scenario with the recorded agent answers (the gold path, proven by
   the scenario's field grading) and writes each question batch, whole
   (premise, options, text state, structured context) with its gold answer,
   to `tests/recorded/bank/<scenario>/<batch>.json`. `accept.json` at the bank
   root lists options that are as right as the gold one (AE1's date: the
   visible text and the `datetime` attribute both are).
2. **The re-ask.** `npm run hillclimb -- --repeats 5` sends every bank batch
   to Jev through the current mapping in `src/chooser/jev.ts` and scores the
   answers: per question family, correct picks, misses as `none`, false picks
   when gold was `none`, wrong options, and questions whose repeats disagree.
   Seconds per pass, about one cent for five repeats, no browser.
3. **A step** is one change to the mapping or the facts a question carries,
   measured on the bank. Kept when the number moves, reverted when it does
   not. The measure harness stays the end-to-end check.

Question families: `group` (which repeated group is the list), `field` (which
candidate is the field on every sample), `link` (next page, detail page),
`heal.field`, `heal.step`, `nav.op` and `nav.target` (navigation), `nav.done`.

## Steps

Bank of 2026-09-19 (AE1, AE7, AE8, AE15: 21 questions), 5 repeats each.

| step | change | all | heal.field | field | group | link | heal.step |
|---|---|---|---|---|---|---|---|
| 0 | as shipped: premise string, option strings, text state, `none` as "None of the options is right." Two batches failed transport (the SDK rejected 12-option answers: the API rounds probabilities to two decimals, the provider declared three) | 75/105 (71.4%) | 5/25 | 56/65 | 5/5 | 4/5 | 5/5 |
| 0b | declare two-decimal rounding (a defect, not framing) | 85/105 (81.0%) | 5/25 | 65/65 | 5/5 | 5/5 | 5/5 |
| 1 | structured state (the batch's shared facts as JSON), structured instructions (the question's own facts plus one rule per decision), structured criteria (each option's path, shape, values), `none` described per decision with what it is not for | 97/105 (92.4%) | 17/25 | 65/65 | 5/5 | 5/5 | 5/5 |
| 2 | `candidates_on_same_path` on each option (several candidates on one path are the rows of a list, not the page's own value) and the rule that earlier values come from other pages | 101/105 (96.2%) | 21/25 | 65/65 | 5/5 | 5/5 | 5/5 |
| 3 | presence gate for field healing: the choice loses `none`, a yes/no question in the same call decides whether the page shows the value at all; a gate without the candidates in its instructions answered no to everything (85/105), so the candidates travel in the gate | 104/105 (99.0%) | 24/25 | 65/65 | 5/5 | 5/5 | 5/5 |

What the misses were, and why each step worked:

- Step 0 to 1. Every healing question had two or three candidates that show
  the value (the `h1`, a breadcrumb span, a related product's name) plus a
  `none` framed as an easy exit. Jev split the mass between the right
  candidates and `none` took the plurality. Naming what `none` is not for,
  and giving each option its path and shape, put the mass on the `h1`.
- Step 1 to 2. The price heal offered the page's own price and three related
  products' prices, all on `main/section/ul/li/span`. Marking the shared path
  told Jev which ones are a list.
- Step 2 to 3. On the out-of-stock page (gold `none`) the three related
  prices split the mass three ways and each still beat `none`. A separate
  presence question does not compete with candidates, so it can say no.
  The jev-ultrafast agent (browser-use) uses the same shape: DONE and
  BLOCKED live in the operation question, never among the targets.

Per-batch wall time went from 374 ms to 495 ms across the steps (larger
state, the gate question); input tokens per five repeats from 133k to 248k
(about one cent).

## Where the bank stands

See the table in `docs/measurements.md` for the end-to-end numbers per
chooser after the climb.
