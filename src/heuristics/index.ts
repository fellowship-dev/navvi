export { Bank, HEURISTICS, HEURISTIC_IDS, UnknownHeuristicError, bank, type BankEntry } from "./bank.js";
/**
 * The two document tests the investigation rules are written in terms of, on
 * the module's face because four other modules ask them the same questions —
 * "is there anything on this page a reader could see" and "does it declare a
 * product to anyone who asks". They live beside the rules that made them so
 * that a rule and its test cannot drift; they are exported here so that
 * needing one is not a reason to reach past the module into a rules file.
 */
export { declaresProduct, visibleText } from "./rules/investigate.js";
export { STAGES, define, type AnyHeuristic, type Heuristic, type Override, type Overrides, type Stage, type Verdict } from "./types.js";
