/**
 * `src/reconcile/`: the manuscript, argued, and the schema that argument proves.
 *
 * The whole module is four calls and two artifacts:
 *
 * ```ts
 * const reconciliation = reconcile(manuscript, spec, { now });  // reconcile.json
 * writeFileSync("reconcile.md", render(reconciliation));        // the deliverable
 * process.stderr.write(summarize(reconciliation, path));        // the stage block
 * const schema = outputSchema(reconciliation, spec, { now });   // schema.json
 * ```
 *
 * Deterministic, offline and pure: it reads the investigation's own record and
 * the spec the client approved, opens nothing and asks nobody. The only thing
 * a re-run moves is the timestamp, and that comes from an injected clock.
 */
export { reconcile, costOf, rubricsFor, show, statedType, tracedAlternatives, type ReconcileOptions } from "./reconcile.js";
export { render, summarize } from "./render.js";
export { outputSchema, renderOutputSchema, type OutputSchemaOptions } from "./output.js";
export type {
  AlternativeDisagreement,
  Ambiguity,
  AmbiguityKind,
  AvailableLeaf,
  DisagreementRecord,
  LeafEvidence,
  NotObtainableField,
  NotObtainableKind,
  ObstacleCost,
  ObtainableField,
  OutputSchema,
  QuotedRubric,
  Reading,
  Reconciliation,
  SchemaField,
  TraceOutcome,
  TracedReading,
} from "./schema.js";
