import type { FieldType, Mode } from "../input/schema.js";
import { briefContains } from "./brief.js";
import { SpecSchema, type FieldRequest, type Rubric, type Spec } from "./schema.js";

/**
 * U5: the spec a plain run already is.
 *
 * `navvi make` compiles a brief into a spec with a model and stops on every
 * question the brief left open. The plain command does not need either: by the
 * time `runCrawl` compiles a template, the run input has answered everything a
 * spec asks -- the fields (from `--fields`, or `promptToInput` has already
 * parsed them out of the prompt), what one record is (`description`), and what
 * varies per run (the start URLs, which are a URL list by construction). What
 * the compile core (`src/compile/template.ts`) needs is that answer in the
 * shape it reads, so this writes the input down as one, and asks nobody.
 *
 * ## Provenance
 *
 * Each element says where it came from, in the spec's own vocabulary:
 *
 *  - a field the brief's words name is `brief`, with the term;
 *  - a field the caller listed that the brief does not name is `answered` --
 *    somebody stated it, which is what `answered` means -- and never
 *    `inferred`, which would file the caller's own column under "the brief did
 *    not ask for these" and drop it from `requestedFields`;
 *  - the site and the input shape are read off the URLs, so `inferred`.
 *
 * ## What it does not do
 *
 * Invent. No field is added, no type guessed, no constraint stated, and the
 * open questions are empty because a run input with fields and URLs has none
 * left -- `parseInput` already refused the one that did.
 */

/** The parts of a run input a spec is written from; `RunInput` satisfies it. */
export interface SpecInput {
  prompt?: string | undefined;
  description?: string | undefined;
  mode?: Mode | undefined;
  fields?: ReadonlyArray<{ name: string; description?: string | undefined; type?: FieldType | undefined }> | undefined;
}

export interface SpecFromInputOptions {
  /** The template's start URLs; the site is the first one's host. */
  urls: readonly string[];
  /** The case's rubrics, verbatim (`--rubric`, `--rubrics-file`). */
  rubrics?: readonly Rubric[] | undefined;
}

/** What one record is called when the run did not say. `compile()` has always used the same word. */
export const DEFAULT_ENTITY = "record";

export function specFromInput(input: SpecInput, options: SpecFromInputOptions): Spec {
  const fields = input.fields ?? [];
  const description = input.description?.trim() ?? "";
  // The prompt, when there was one, is the brief. A structured run has none,
  // and the brief is then what it asked for, spelled out, so every provenance
  // claim below still has a text to be checked against.
  const brief = input.prompt?.trim() || (description === "" ? `Extract ${fields.map((field) => field.name).join(", ")}` : `Extract ${fields.map((field) => field.name).join(", ")} of each ${description}`);

  const requests: FieldRequest[] = fields.map((field) => {
    const named = briefContains(brief, field.name);
    return {
      name: field.name,
      ...(field.description === undefined ? {} : { description: field.description }),
      ...(named ? { briefTerm: field.name } : {}),
      ...(field.type === undefined ? {} : { type: field.type }),
      provenance: named ? ("brief" as const) : ("answered" as const),
    };
  });

  const spec: Spec = {
    version: 1,
    brief,
    target: { site: siteOf(options.urls), pageKind: input.mode === "list" ? "listing" : "unknown", provenance: "inferred" },
    entity: { name: description === "" ? DEFAULT_ENTITY : description, provenance: description === "" ? "inferred" : "brief" },
    inputs: { shape: "url_list", description: "the start URLs of the run", provenance: "inferred" },
    fields: requests,
    constraints: { freshness: { stated: false }, volume: { stated: false }, cadence: { stated: false }, budget: { stated: false } },
    rubrics: [...(options.rubrics ?? [])],
    openQuestions: [],
  };
  // Parsed rather than trusted: a spec the core reads is a spec `SpecSchema`
  // accepts, so a run input that cannot be one fails here, by field.
  return SpecSchema.parse(spec);
}

/** `example.com` from `https://www.example.com/p/1`; the first URL's host, which is what `answersFromUrls` answers `target` with. */
function siteOf(urls: readonly string[]): string {
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      if (host !== "") return host;
    } catch {
      // not a URL: the next one may be
    }
  }
  return "unknown";
}
