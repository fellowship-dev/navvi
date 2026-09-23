import type { Spec } from "../spec/schema.js";
import type { OutputSchema, Reconciliation, SchemaField } from "./schema.js";

/**
 * U5: the output schema, derived from what was **proved obtainable**.
 *
 * The brief said "product info". A schema written from the brief would either
 * be empty or be a guess dressed as a contract; a schema written from
 * `spec.fields` would assert five columns whether or not any of them can be
 * read. This is written from the reconciliation instead, so every column is
 * backed by a value taken off a real page and names the source that proved it,
 * and a field that was not proved obtainable **is not in it**.
 *
 * That last clause is the unit. An omission is the client's to see - `omitted`
 * carries it with the reason - and not the compiler's to paper over.
 */

export interface OutputSchemaOptions {
  /** The clock, so a schema is reproducible. */
  now?: Date | undefined;
}

export function outputSchema(reconciliation: Reconciliation, spec: Spec, options: OutputSchemaOptions = {}): OutputSchema {
  const now = options.now ?? new Date();

  const fields: SchemaField[] = reconciliation.obtainable.map((field) => {
    const sample = field.values.find((value) => value !== null);
    return {
      name: field.field,
      type: field.type,
      typeInferred: field.typeInferred,
      source: field.source,
      ...(field.match === undefined ? {} : { match: field.match }),
      ...(field.path === undefined ? {} : { path: field.path }),
      ...(field.selector === undefined ? {} : { selector: field.selector }),
      ...(field.attr === undefined ? {} : { attr: field.attr }),
      ...(field.entity === undefined ? {} : { entity: field.entity }),
      tier: field.tier,
      ...(sample === undefined ? {} : { example: sample }),
      because:
        `proved at tier ${field.tier}: ${field.where}, read on ${field.values.length} binding sample(s)` +
        (field.typeInferred ? `. The spec declared no type for this column, so it is read off the values - never \`money\`, because nothing in a bare number says a price from a count` : ""),
    };
  });

  const omitted = reconciliation.notObtainable.map((field) => ({
    name: field.field,
    because: field.because,
  }));

  return {
    version: 1,
    site: reconciliation.site,
    entity: spec.entity.name,
    derivedAt: now.toISOString(),
    fields,
    omitted,
    because: `${fields.length} column(s), derived from the reconciliation and not from the brief; ${omitted.length} requested field(s) were not proved obtainable and are absent rather than asserted`,
  };
}

/** The artifact: `schema.json`, stable key order, two-space indent. */
export function renderOutputSchema(schema: OutputSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
