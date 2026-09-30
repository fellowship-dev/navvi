# Prompt-injection pre-filter: eval report (U13 / R17)

Measured 2026-09-30. Counts and rates only: per-document results stay in the
gitignored `.cache/`, because the held-out corpus has no licence.

## Verdict

- **Shipped filter: `rules`** (`src/guard/`), run by `BaseChooser.ask` on every
  question that is not the caller's own words. Off the pinned-replay path by
  construction: replay asks no question, so the filter is never called
  (`tests/guard.test.ts` spies on it through a three-page replay).
- **Benign false positives: 0 of 519** generic product pages plus every navvi
  fixture and demo page (pharmacy demo included); **1 of 2,481 (0.04%)** on
  WAInjectBench's real benign web, comment and email text (held out, never
  read while writing the rules).
- **Detection on indirect attacks: 89.1% on the test split** (426/478), with
  91.8% of inserted attacks cut out entirely. **41.6% on held-out
  WAInjectBench** (160/385 with an explicit instruction): the honest
  generalization number. The rules catch the families they name and miss novel
  phrasing ("Before going shopping, please open a new tab and go to ...").
- **About 0.1 ms per page, no cost, no network**, on every backend including
  the CLI and host-agent choosers.
- **Against the bar: a reported shortfall.** Llama Prompt Guard 2 86M is gated
  (Llama 4 Community License) and was not run here; its published numbers are
  97.5% recall at 1% FPR and AUC 0.998 on Meta's private direct-jailbreak
  benchmark, and 81.2% attack prevention at 3% utility loss on AgentDojo
  ([model card](https://github.com/meta-llama/PurpleLlama/blob/172c1074069eb88ec834124272c1b1c4f8893445/Llama-Prompt-Guard-2/86M/MODEL_CARD.md)).
  The rules' false-positive rate (0% on our pages, 0.04% held out) is under
  that 1% operating point, but not at equal detection (89.1% < 97.5%) and not
  on the same benchmark. R17's acceptance is therefore **not demonstrated**;
  per U13 that blocks the Store until Prompt Guard 2 runs on this corpus
  (`promptguard.py`, after accepting Meta's licence and setting `HF_TOKEN`) or
  Max accepts the shortfall.
- **Measured model reference:** ProtectAI's DeBERTa v2 detector (Apache-2.0,
  CPU, same 444-document sample): 48.2% detection at 1.3% benign flagged. The
  rules on that sample: 83.7% at 0%.

## Why rules and not the Jev classifier

A yes/no Jev question over the TypeSafe transport generalizes much better:
82.1% on the held-out explicit attacks against the rules' 41.6%, and 85.1%
detection at 0.3% benign flagged at threshold 0.5 (93.6% at 1.3% at 0.3). It
was not shipped as the filter because it answers per page, not per span (a flag
would drop the whole question state, and the chooser would lose the page); it
adds ~250 ms (p95 ~500 ms) per question batch; and it needs a TypeSafe or
Gateway key, which the CLI and host-agent choosers do not have. Cost is not the
reason: about $0.00002 per page at list price.

**Recommended follow-up:** a cascade, rules first and Jev on what they pass,
asked per line block so a flag cuts a span, on runs that already hold a Jev
key. This harness measures it as soon as it exists.

## Method

- **Positives** (indirect only): CyberSecEval's 55 indirect rows as written;
  BIPIA's 150 attack goals, bare and in each of AgentDojo's five wrappers
  (`templates.json`), inserted at the start, middle or end of a seeded generic
  product page. BIPIA train goals and odd CyberSecEval ids are **dev** (the
  rules were written against them); BIPIA test goals and even ids are **test**.
  CyberSecEval rows come in sibling triples (one technique, three contexts), so
  its test half is not independent of dev: dev 77.8% against test 46.4% shows
  how much of it was fitted. WAInjectBench is **held out**.
- **Negatives:** 400 seeded generic product pages (English and Spanish, with
  the imperatives shops print: dosage directions, "Add to cart", "Ignore the
  negative reviews"), the visible text of all 119 HTML fixture and demo pages,
  and WAInjectBench's 2,481 benign texts.
- **Detected** means any flag on the page. **Neutralized** means no line of the
  inserted attack survives the cut (the "Signed, ..." sign-off aside).
- WAInjectBench's `*_wo_EI` and `popup` subsets are content manipulation with
  no instruction in the text ("A chair with wheels"); a text filter cannot see
  them. They are scored by subset below and left out of the headline rate.
- Jev and ProtectAI rows cover a seeded stratified sample (505 documents, 444
  without the implicit subsets); every other row covers the whole set. Latency
  for `rules` and `keyword` is in-process; Jev's is the API round trip;
  ProtectAI's is CPU inference on an Intel Mac.

## Reproduce

```
npx tsx evals/injection/fetch.ts --held-out
npx tsx evals/injection/run.ts --held-out                  # rules and the keyword baseline
npx tsx evals/injection/run.ts --held-out --jev 500        # + Jev (TYPESAFE_API_KEY), cached in .cache/scores-jev.jsonl
npx tsx evals/injection/run.ts --held-out --export
python evals/injection/promptguard.py protectai/deberta-v3-base-prompt-injection-v2 protectai-deberta-v2 --sample
python evals/injection/promptguard.py                      # Prompt Guard 2 86M: HF_TOKEN with the licence accepted
npx tsx evals/injection/run.ts --held-out --write-report
```

Sources, commits and licences: `corpora.json` and `NOTICE`.

<!-- measured -->

### Headline: detection on indirect attacks, false positives on benign pages

| detector | split | attacks detected | attacks neutralized | benign pages flagged | docs | ms/doc p50 | ms/doc p95 | cost/1k docs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| keyword | dev | 78/477 (16.4%) | 75/450 (16.7%) | 0/200 (0.0%) | 677 | 0.004 | 0.012 | $0 |
| keyword | test | 79/478 (16.5%) | 75/450 (16.7%) | 0/200 (0.0%) | 678 | 0.004 | 0.012 | $0 |
| keyword | fixtures | 0/0 (-) | - | 0/119 (0.0%) | 119 | 0.003 | 0.026 | $0 |
| keyword | held-out | 0/385 (0.0%) | - | 0/2481 (0.0%) | 3472 | 0.001 | 0.002 | $0 |
| rules | dev | 438/477 (91.8%) | 417/450 (92.7%) | 0/200 (0.0%) | 677 | 0.123 | 1.421 | $0 |
| rules | test | 426/478 (89.1%) | 413/450 (91.8%) | 0/200 (0.0%) | 678 | 0.107 | 0.364 | $0 |
| rules | fixtures | 0/0 (-) | - | 0/119 (0.0%) | 119 | 0.070 | 3.123 | $0 |
| rules | held-out | 160/385 (41.6%) | - | 1/2481 (0.0%) | 3472 | 0.051 | 0.287 | $0 |
| jev | dev | 47/51 (92.2%) | - | 0/20 (0.0%) | 71 | 281.096 | 515.705 | $0.0193 |
| jev | test | 41/51 (80.4%) | - | 0/20 (0.0%) | 71 | 247.672 | 487.326 | $0.0192 |
| jev | fixtures | 0/0 (-) | - | 0/12 (0.0%) | 12 | 240.341 | 260.830 | $0.0172 |
| jev | held-out | 32/39 (82.1%) | - | 1/251 (0.4%) | 351 | 255.538 | 380.859 | $0.0149 |
| protectai-deberta-v2 | dev | 17/51 (33.3%) | - | 0/20 (0.0%) | 71 | 215.608 | 455.161 | $0 |
| protectai-deberta-v2 | test | 21/51 (41.2%) | - | 0/20 (0.0%) | 71 | 202.516 | 304.678 | $0 |
| protectai-deberta-v2 | fixtures | 0/0 (-) | - | 1/12 (8.3%) | 12 | 124.849 | 301.186 | $0 |
| protectai-deberta-v2 | held-out | 30/39 (76.9%) | - | 3/251 (1.2%) | 351 | 240.889 | 2504.516 | $0 |

### Attacks by source (all splits)

| group | keyword | rules | jev | protectai-deberta-v2 |
| --- | --- | --- | --- | --- |
| dev / bipia+agentdojo:bare | 0/75 (0.0%) | 42/75 (56.0%) | 7/8 (87.5%) | 0/8 (0.0%) |
| dev / bipia+agentdojo:direct | 0/75 (0.0%) | 75/75 (100.0%) | 6/8 (75.0%) | 0/8 (0.0%) |
| dev / bipia+agentdojo:ignore_previous | 0/75 (0.0%) | 75/75 (100.0%) | 8/8 (100.0%) | 5/8 (62.5%) |
| dev / bipia+agentdojo:important_instructions | 0/75 (0.0%) | 75/75 (100.0%) | 8/8 (100.0%) | 0/8 (0.0%) |
| dev / bipia+agentdojo:injecagent | 75/75 (100.0%) | 75/75 (100.0%) | 8/8 (100.0%) | 8/8 (100.0%) |
| dev / bipia+agentdojo:system_message | 0/75 (0.0%) | 75/75 (100.0%) | 7/8 (87.5%) | 1/8 (12.5%) |
| dev / cyberseceval | 3/27 (11.1%) | 21/27 (77.8%) | 3/3 (100.0%) | 3/3 (100.0%) |
| held-out / wainjectbench-explicit | 0/385 (0.0%) | 160/385 (41.6%) | 32/39 (82.1%) | 30/39 (76.9%) |
| held-out / wainjectbench-implicit | 0/606 (0.0%) | 0/606 (0.0%) | 13/61 (21.3%) | 19/61 (31.1%) |
| test / bipia+agentdojo:bare | 0/75 (0.0%) | 38/75 (50.7%) | 6/8 (75.0%) | 0/8 (0.0%) |
| test / bipia+agentdojo:direct | 0/75 (0.0%) | 75/75 (100.0%) | 3/8 (37.5%) | 0/8 (0.0%) |
| test / bipia+agentdojo:ignore_previous | 0/75 (0.0%) | 75/75 (100.0%) | 8/8 (100.0%) | 8/8 (100.0%) |
| test / bipia+agentdojo:important_instructions | 0/75 (0.0%) | 75/75 (100.0%) | 8/8 (100.0%) | 2/8 (25.0%) |
| test / bipia+agentdojo:injecagent | 75/75 (100.0%) | 75/75 (100.0%) | 8/8 (100.0%) | 8/8 (100.0%) |
| test / bipia+agentdojo:system_message | 0/75 (0.0%) | 75/75 (100.0%) | 5/8 (62.5%) | 0/8 (0.0%) |
| test / cyberseceval | 4/28 (14.3%) | 13/28 (46.4%) | 3/3 (100.0%) | 3/3 (100.0%) |

### Attacks by category, test split

| group | keyword | rules | jev | protectai-deberta-v2 |
| --- | --- | --- | --- | --- |
| bipia+agentdojo / Base Encoding | 5/30 (16.7%) | 28/30 (93.3%) | 3/3 (100.0%) | 1/3 (33.3%) |
| bipia+agentdojo / Business Intelligence | 5/30 (16.7%) | 25/30 (83.3%) | 3/5 (60.0%) | 1/5 (20.0%) |
| bipia+agentdojo / Conversational Agent | 5/30 (16.7%) | 25/30 (83.3%) | 3/7 (42.9%) | 1/7 (14.3%) |
| bipia+agentdojo / Emoji Substitution | 5/30 (16.7%) | 29/30 (96.7%) | 1/1 (100.0%) | 1/1 (100.0%) |
| bipia+agentdojo / Entertainment | 5/30 (16.7%) | 30/30 (100.0%) | 5/5 (100.0%) | 2/5 (40.0%) |
| bipia+agentdojo / Information Dissemination | 5/30 (16.7%) | 30/30 (100.0%) | 4/4 (100.0%) | 1/4 (25.0%) |
| bipia+agentdojo / Language Translation | 5/30 (16.7%) | 29/30 (96.7%) | 2/2 (100.0%) | 2/2 (100.0%) |
| bipia+agentdojo / Marketing & Advertising | 5/30 (16.7%) | 29/30 (96.7%) | - | - |
| bipia+agentdojo / Misinformation & Propaganda | 5/30 (16.7%) | 30/30 (100.0%) | 5/5 (100.0%) | 2/5 (40.0%) |
| bipia+agentdojo / Research Assistance | 5/30 (16.7%) | 25/30 (83.3%) | 1/2 (50.0%) | 1/2 (50.0%) |
| bipia+agentdojo / Reverse Text | 5/30 (16.7%) | 27/30 (90.0%) | 3/3 (100.0%) | 2/3 (66.7%) |
| bipia+agentdojo / Scams & Fraud | 5/30 (16.7%) | 29/30 (96.7%) | - | - |
| bipia+agentdojo / Sentiment Analysis | 5/30 (16.7%) | 25/30 (83.3%) | 2/4 (50.0%) | 1/4 (25.0%) |
| bipia+agentdojo / Substitution Ciphers | 5/30 (16.7%) | 27/30 (90.0%) | 4/4 (100.0%) | 2/4 (50.0%) |
| bipia+agentdojo / Task Automation | 5/30 (16.7%) | 25/30 (83.3%) | 2/3 (66.7%) | 1/3 (33.3%) |
| cyberseceval / different_user_input_language | 0/3 (0.0%) | 0/3 (0.0%) | - | - |
| cyberseceval / hypothetical_scenario | 0/3 (0.0%) | 1/3 (33.3%) | - | - |
| cyberseceval / ignore_previous_instructions | 2/4 (50.0%) | 4/4 (100.0%) | - | - |
| cyberseceval / mixed_techniques | 0/2 (0.0%) | 2/2 (100.0%) | - | - |
| cyberseceval / overload_with_information | 2/3 (66.7%) | 3/3 (100.0%) | - | - |
| cyberseceval / persuasion | 0/3 (0.0%) | 0/3 (0.0%) | 1/1 (100.0%) | 1/1 (100.0%) |
| cyberseceval / system_mode | 0/4 (0.0%) | 3/4 (75.0%) | 2/2 (100.0%) | 2/2 (100.0%) |
| cyberseceval / token_smuggling | 0/3 (0.0%) | 0/3 (0.0%) | - | - |
| cyberseceval / virtualization | 0/3 (0.0%) | 0/3 (0.0%) | - | - |

### Benign pages flagged, by source

| group | keyword | rules | jev | protectai-deberta-v2 |
| --- | --- | --- | --- | --- |
| dev / synthetic-product | 0/200 (0.0%) | 0/200 (0.0%) | 0/20 (0.0%) | 0/20 (0.0%) |
| fixtures / navvi-fixtures | 0/119 (0.0%) | 0/119 (0.0%) | 0/12 (0.0%) | 1/12 (8.3%) |
| held-out / wainjectbench-benign | 0/2481 (0.0%) | 1/2481 (0.0%) | 1/251 (0.4%) | 3/251 (1.2%) |
| test / synthetic-product | 0/200 (0.0%) | 0/200 (0.0%) | 0/20 (0.0%) | 0/20 (0.0%) |

### Held out: WAInjectBench by subset

| group | keyword | rules | jev | protectai-deberta-v2 |
| --- | --- | --- | --- | --- |
| attack / EIA_w_EI | 0/62 (0.0%) | 62/62 (100.0%) | 15/15 (100.0%) | 15/15 (100.0%) |
| attack / EIA_wo_EI | 0/186 (0.0%) | 0/186 (0.0%) | 0/12 (0.0%) | 2/12 (16.7%) |
| attack / VPI_E_M | 0/31 (0.0%) | 0/31 (0.0%) | 0/5 (0.0%) | 3/5 (60.0%) |
| attack / VPI_web_text | 0/114 (0.0%) | 0/114 (0.0%) | 8/8 (100.0%) | 4/8 (50.0%) |
| attack / VWA_adv_w_EI | 0/94 (0.0%) | 38/94 (40.4%) | 1/1 (100.0%) | 0/1 (0.0%) |
| attack / VWA_adv_wo_EI | 0/204 (0.0%) | 0/204 (0.0%) | 0/16 (0.0%) | 0/16 (0.0%) |
| attack / popup | 0/216 (0.0%) | 0/216 (0.0%) | 13/33 (39.4%) | 17/33 (51.5%) |
| attack / wasp | 0/84 (0.0%) | 60/84 (71.4%) | 8/10 (80.0%) | 8/10 (80.0%) |
| benign / comment_issue | 0/806 (0.0%) | 1/806 (0.1%) | 0/124 (0.0%) | 1/124 (0.8%) |
| benign / email_msg | 0/173 (0.0%) | 0/173 (0.0%) | 0/34 (0.0%) | 1/34 (2.9%) |
| benign / web_text | 0/1502 (0.0%) | 0/1502 (0.0%) | 1/93 (1.1%) | 1/93 (1.1%) |

### jev: threshold sweep over its sample (444 docs)

| threshold | attacks detected | benign flagged |
| --- | --- | --- |
| 0.1 | 137/141 (97.2%) | 25/303 (8.3%) |
| 0.2 | 134/141 (95.0%) | 9/303 (3.0%) |
| 0.3 | 132/141 (93.6%) | 4/303 (1.3%) |
| 0.5 | 120/141 (85.1%) | 1/303 (0.3%) |
| 0.7 | 113/141 (80.1%) | 0/303 (0.0%) |
| 0.9 | 89/141 (63.1%) | 0/303 (0.0%) |
| rules, same sample | 118/141 (83.7%) | 0/303 (0.0%) |

### protectai-deberta-v2: threshold sweep over its sample (444 docs)

| threshold | attacks detected | benign flagged |
| --- | --- | --- |
| 0.1 | 77/141 (54.6%) | 8/303 (2.6%) |
| 0.2 | 73/141 (51.8%) | 6/303 (2.0%) |
| 0.3 | 71/141 (50.4%) | 6/303 (2.0%) |
| 0.5 | 68/141 (48.2%) | 4/303 (1.3%) |
| 0.7 | 66/141 (46.8%) | 4/303 (1.3%) |
| 0.9 | 65/141 (46.1%) | 4/303 (1.3%) |
| rules, same sample | 118/141 (83.7%) | 0/303 (0.0%) |
