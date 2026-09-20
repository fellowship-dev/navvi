import type { GroupCandidate } from "../browser/snapshot.js";
import type { JsonValue, Question } from "../chooser/chooser.js";
import { premises } from "../chooser/questions.js";
import { clip, normalize } from "../util/text.js";

/**
 * Group choice (R7, R8, R10): the chooser picks which code-enumerated repeated
 * group holds one record per item. Question ids are `group` and, after the
 * scroll retry, `group.retry`.
 */

export const GROUP_QUESTION_ID = "group";
export const RETRY_SUFFIX = ".retry";

const SAMPLE_CHARS = 140;

export function groupLabel(group: GroupCandidate): string {
  const shape = group.anchorPlusRows ? `, ${group.anchorPlusRows.span} rows each` : "";
  const samples = group.sampleTexts.map((t) => clip(t, SAMPLE_CHARS)).join(" || ");
  return `${group.selector} > ${group.itemSelector} (${group.itemCount} items${shape}): ${samples}`;
}

/** R10: a group whose sample items all read the same is never a record group. */
export function isDegenerateGroup(group: GroupCandidate): boolean {
  return group.itemCount < 1 || new Set(group.sampleTexts.map(normalize)).size <= 1;
}

/** The facts behind a group option, for structured backends. */
export function groupContext(group: GroupCandidate): JsonValue {
  const out: { [key: string]: JsonValue } = {
    container: group.selector,
    item: group.itemSelector,
    item_count: group.itemCount,
    sample_items: group.sampleTexts.map((t) => clip(t, SAMPLE_CHARS)),
  };
  if (group.anchorPlusRows) out.rows_per_item = group.anchorPlusRows.span;
  return out;
}

export function buildGroupQuestion(groups: readonly GroupCandidate[], description: string, fields: readonly string[], state: string, suffix = "", page?: string): Question {
  return {
    id: `${GROUP_QUESTION_ID}${suffix}`,
    kind: "choice",
    premise: premises.listGroupChoice(description, fields),
    options: groups.map(groupLabel),
    state,
    context: { decision: "list_group", shared: { records: description, fields: [...fields], ...(page ? { page } : {}) } },
    optionContext: groups.map(groupContext),
  };
}

/** The compiled item anchor for a chosen group: `parent > item`, or the anchor row plus span for multi-row items. */
export function itemFromGroup(group: GroupCandidate): { anchorSelector: string; span: number } {
  if (group.anchorPlusRows) return { anchorSelector: group.anchorPlusRows.anchorSelector, span: group.anchorPlusRows.span };
  return { anchorSelector: `${group.selector} > ${group.itemSelector}`, span: 1 };
}
