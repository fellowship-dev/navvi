/**
 * Every premise the run asks lives here, so wording is reviewed in one place
 * and no caller improvises text. Premises describe the decision; the state
 * carries the evidence. A premise never carries a secret value (KTD18).
 */

export const NONE_OPTION = "none";

export const premises = {
  /** Compile: which repeated group holds the records, for `field`. */
  groupChoice: (field: string): string =>
    `Which candidate group contains one record per row with the ${field} value? Pick none when no candidate does.`,

  /** Compile: which candidate selector yields the field's value across the samples. */
  fieldChoice: (field: string, description?: string): string =>
    `Which candidate holds the ${field}${description ? ` (${description})` : ""} value on every sample? Pick none when no candidate is right on all samples.`,

  /** Compile: quality of a candidate's values across the samples, lowest level first. */
  fieldQuality: (field: string): string => `How well do the sampled values match the ${field} field?`,

  /** List mode: which link or control leads to the next listing page. */
  nextLinkChoice: (): string =>
    "Which control leads to the next page of the same listing? Pick none when this is the last page or no control does.",

  /** Navigation: which operation moves toward the goal from this page. */
  navigationOperation: (goal: string): string =>
    `Given the goal "${goal}", which operation is the next step from this page? Pick none when the goal is reached or no operation helps.`,

  /** Navigation: which control the chosen operation applies to. */
  navigationTarget: (operation: string, goal: string): string =>
    `Which control should the ${operation} step use to move toward "${goal}"? Pick none when no control fits.`,

  /** Pre-step: whether a visible prompt is a consent or cookie banner that may be dismissed. */
  consentBoolean: (): string => "Is the visible prompt a consent or cookie banner that can be dismissed without signing in or paying?",

  /** Healing: whether the page still shows the record the selector used to match. */
  driftBoolean: (field: string): string => `Does this page still show a ${field} value that the compiled scraper should extract?`,

  /** Text helper: typed text for a form control during navigation (KTD11). */
  textHelper: (what: string): string => `Write the ${what} to type into the control. Answer with the text only.`,

  /** Text helper: parse a free prompt into the structured input (KTD11, U16). */
  promptParse: (): string => "Parse the prompt into the structured run input as JSON matching the schema. Use only what the prompt states.",

  /** Compile, list mode: which repeated group holds one record per item for the described records and fields. */
  listGroupChoice: (description: string, fields: readonly string[]): string =>
    `Which candidate group holds one ${description} per item, with the ${fields.join(", ")} values? Pick none when no candidate does.`,

  /** Compile, list mode: which per-item link leads to the record's own detail page. */
  detailLinkChoice: (description: string): string =>
    `Which per-item link leads from a ${description} to its own detail page? Pick none when the records have no detail page.`,
} as const;

export type PremiseName = keyof typeof premises;
