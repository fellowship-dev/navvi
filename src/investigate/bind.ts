import { bank, type Bank, type Verdict } from "../heuristics/index.js";
import type { FieldType } from "../input/schema.js";
import type { TypedValue } from "../scraper/extract.js";
import { anchors, narrow, type Candidate, type Leaf } from "./leaves.js";

/**
 * U2b, second half: from a narrowed table to a binding.
 *
 * This is the bank's first consumer. The deterministic filter in `leaves.ts`
 * takes a 170-leaf payload down to a handful; `key-names-carry-the-signal` then
 * ranks what is left on the key names alone. The model is the tie-break, not
 * the search — which matters because three increasingly precise prompts could
 * not make one pick Store B's list price out of a rendered DOM, and nothing
 * about `price-list-std` versus `price-sale-std` is hard.
 */

export interface BindOptions {
  type?: FieldType | undefined;
  pageText?: readonly string[] | undefined;
  /** A case's heuristic overrides; the default bank when omitted. */
  view?: Bank;
}

export interface Binding {
  field: string;
  /** What survived the deterministic filter, in the order it was considered. */
  candidates: Candidate[];
  /** The path the heuristics settled on, when they did. */
  path?: string;
  values?: TypedValue[];
  /**
   * Other paths carrying the same value as the bound one; free alternatives
   * for the compile.
   *
   * Paths and not `FieldAlias`es, and deliberately: this function is handed a
   * flat table of `{path, value}` and has no idea what a path is read through.
   * The caller does — tier 2 knows the endpoint, tier 1 has the whole
   * `DeclaredSource` — so the caller attaches the source. What used to happen
   * instead was that nobody attached one and the compile assumed the binding's,
   * which is false for tier 1 and is A6.
   */
  aliases: string[];
  because: string;
  /**
   * True when the heuristics could not settle it and a model should be shown
   * the surviving table. False both when a binding was found and when nothing
   * survived — neither is a question worth paying for.
   */
  askModel: boolean;
  /** Every heuristic that had something to say, for the compile rationale. */
  verdicts: Array<{ id: string; verdict: Verdict }>;
  /**
   * Leaves `machine-value-is-not-a-fact` refused for this field, with the
   * rule's own sentence. Empty when no rendered text was supplied: the rule
   * treats "nobody looked" as its own answer and abstains, and so does this.
   */
  machinery: MachineryRejection[];
}

export interface MachineryRejection {
  path: string;
  /** Other spellings of the same values, refused with it. */
  aliases: string[];
  values: TypedValue[];
  because: string;
}

/** The rule this file executes at bind time, spelled once. */
export const MACHINERY_RULE = "machine-value-is-not-a-fact";

/**
 * `machine-value-is-not-a-fact`, asked where its `decides` line says it
 * belongs: of a leaf that could have been a candidate for this field.
 *
 * Until 2026-09-23 the rule ran only in `src/reconcile/`, as a label on a
 * catalogue row, and the binding path refused the same leaves silently — the
 * anchor filter in `narrow` drops anything no page showed, and a leaf dropped
 * without a reason is a leaf nobody can dispute. So this asks the question the
 * anchor filter answers *before* it answers it: the leaves present on every
 * sample that coerce to the field's type, each with `anchored` settled against
 * the rendered text. The ones the rule fires on are handed back with the rule's
 * sentence, and the manuscript records them as rejections carrying its id.
 *
 * What binds does not change, and that is deliberate: every leaf this rule can
 * fire on is unanchored, and `narrow` refuses those anyway. The rule is a
 * *reason*, not a second filter; a second filter here would be a second
 * spelling of the anchor test.
 */
function machineryIn(field: string, samples: readonly Leaf[][], options: BindOptions, view: Bank, verdicts: Array<{ id: string; verdict: Verdict }>): MachineryRejection[] {
  const texts = options.pageText;
  if (texts === undefined) return [];
  const out: MachineryRejection[] = [];
  // No anchoring and no variation: this is the table *before* those two
  // filters, because they are the filters the rule is explaining.
  for (const candidate of narrow(samples, { type: options.type, requireVariation: false })) {
    if (candidate.values.every((value, index) => anchors(value, texts[index] ?? ""))) continue;
    let verdict: Verdict;
    try {
      verdict = view.run(MACHINERY_RULE, { path: candidate.path, values: candidate.values, anchored: false, field });
    } catch {
      // A value the rule's schema refuses is not this rule's business.
      continue;
    }
    if (!verdict.fires) continue;
    verdicts.push({ id: MACHINERY_RULE, verdict });
    out.push({ path: candidate.path, aliases: candidate.aliases, values: candidate.values, because: verdict.because });
  }
  return out;
}

/**
 * Bind one field against the payloads captured for each sample page.
 *
 * `samples` is one flattened payload per sample URL, in the same order as
 * `pageText`.
 */
export function bindField(field: string, samples: readonly Leaf[][], options: BindOptions = {}): Binding {
  const view = options.view ?? bank();
  // The machinery verdicts go after the ranking's, so the first verdict a
  // reader meets is still the one that decided the binding.
  const refused: Array<{ id: string; verdict: Verdict }> = [];
  const machinery = machineryIn(field, samples, options, view, refused);
  const binding = settle(field, samples, options, view);
  return { ...binding, verdicts: [...binding.verdicts, ...refused], machinery };
}

function settle(field: string, samples: readonly Leaf[][], options: BindOptions, view: Bank): Omit<Binding, "machinery"> {
  const candidates = narrow(samples, { type: options.type, pageText: options.pageText });
  const verdicts: Array<{ id: string; verdict: Verdict }> = [];

  if (candidates.length === 0) {
    return { field, candidates, aliases: [], because: "no captured leaf survived the filter for this field", askModel: false, verdicts };
  }

  /**
   * Elect a spelling per group before ranking across groups. Two names for one
   * fact would otherwise tie with each other and read as an ambiguity —
   * `prices[price-sale-std]` against `appliedPromotions[…].promotionalPrice`,
   * which is one sale price written twice.
   */
  const elected = candidates.map((candidate) => {
    const spellings = [candidate.path, ...candidate.aliases];
    if (spellings.length === 1) return { candidate, path: candidate.path };
    const within = view.run("key-names-carry-the-signal", {
      field,
      leaves: spellings.map((path) => ({ path, value: candidate.values[0] ?? null })),
    });
    return { candidate, path: within.fires && within.pick ? within.pick : candidate.path };
  });

  const leaves = elected.map(({ candidate, path }) => ({ path, value: candidate.values[0] ?? null }));
  const groupOf = (path: string): (typeof candidates)[number] | undefined => elected.find((entry) => entry.path === path)?.candidate;

  const verdict = view.run("key-names-carry-the-signal", { field, leaves });
  verdicts.push({ id: "key-names-carry-the-signal", verdict });

  if (verdict.fires && verdict.pick) {
    // The best-named spelling leads; the rest of its group are alternatives.
    const group = groupOf(verdict.pick)!;
    const aliases = [group.path, ...group.aliases].filter((path) => path !== verdict.pick);
    return { field, candidates, path: verdict.pick, values: group.values, aliases, because: verdict.because, askModel: false, verdicts };
  }

  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      field,
      candidates,
      path: only.path,
      values: only.values,
      aliases: only.aliases,
      because: `${only.path} is the only value that survived the filter for ${field}`,
      askModel: false,
      verdicts,
    };
  }

  return { field, candidates, aliases: [], because: verdict.because, askModel: true, verdicts };
}
