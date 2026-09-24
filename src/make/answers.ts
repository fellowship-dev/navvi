import { parseFieldSpecs, type FieldType } from "../input/schema.js";
import { briefContains } from "../spec/brief.js";
import { INPUT_SHAPES, OPEN_QUESTION_SUBJECTS, blockingQuestions, declaredFieldTypes, type InputShape, type OpenQuestion, type OpenQuestionSubject, type Spec } from "../spec/schema.js";

/**
 * U11: `--answer <key>=<value>`, and what it is allowed to do to a spec.
 *
 * The plan's first run stops with two blocking questions and its second answers
 * them by subject — `--answer fields=…`, `--answer inputs=url_list` — not by
 * question id. Both spellings work here, id first, because the ids
 * (`fields-unnamed`, `inputs-shape`) are written by whoever drafted the spec
 * and a client who quotes one should be obeyed exactly.
 *
 * ## A key names a part of the spec, not only an open question
 *
 * The obvious rule — "the key must match a question that is open right now" —
 * is wrong, and wrong in a way that only shows up on the *third* run. The
 * plan's second run answers `fields` and `inputs`; the answered spec is then
 * written back with those questions settled and removed, so the same command,
 * re-run to pick up an edited artifact, would fail with *"no open question by
 * that id or subject"* for the answers it had just successfully given. A
 * driver whose second invocation works and whose third does not is worse than
 * one that never worked.
 *
 * So a key resolves against `OPEN_QUESTION_SUBJECTS` — the parts of a spec
 * there can be a question about — whether or not a question about that part is
 * still open. Answering settles any open question on that subject and is
 * otherwise simply a statement about the spec, which is what a person typing
 * `--answer fields=…` means.
 *
 * ## An answer to nothing at all is still an error
 *
 * The tempting behaviour is to ignore it. That is how a person types
 * `--answer field=…`, watches the run stop at the same blocking question, and
 * concludes navvi is broken — the answer *was* given and navvi *did* read it
 * and silently dropped it on the floor. Same shape as every other defect in
 * this repository: a half that is green on its own and never meets the other
 * half. So a key that is neither a question id nor a subject names both lists
 * and fails.
 *
 * ## What an answer is the provenance of
 *
 * `FieldRequest.provenance` now has a third value, `answered`, and it is what
 * this file writes. The two it had, `brief` and `inferred`, are the only two a
 * drafted spec can produce, and an answer is neither: the brief did not name
 * these fields, and navvi did not infer them — a person was shown the open
 * question and settled it. Recording that as `brief`, which is what this file
 * did, made the spec assert the brief contained words it does not.
 *
 * A field whose name the brief *does* contain keeps `brief`, checked with the
 * spec module's own `briefContains`, and carries the `briefTerm` that proves
 * it. So the two provenances stay exactly as falsifiable as they were: one is
 * checkable against the brief printed above it, the other against the answers
 * recorded verbatim in `make.json`.
 */

export interface Answer {
  /** As given on the command line: a question id, a subject, or `constraints.<name>`. */
  key: string;
  value: string;
}

/** One answer, resolved to the part of the spec it speaks about. */
export interface MatchedAnswer extends Answer {
  /** The part of the spec this answer sets. */
  subject: OpenQuestionSubject;
  /** The open question it settles, when there is one. Absent is normal on a re-run. */
  question?: OpenQuestion;
  /** How the key resolved, for the line that reports it. */
  by: "id" | "subject";
}

export class AnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerError";
  }
}

/** The declared column types of a spec's fields, by field name. See `declaredFieldTypes`. */
export type FieldTypes = Record<string, FieldType>;

export interface AppliedAnswers {
  spec: Spec;
  matched: MatchedAnswer[];
  /**
   * The answered spec's declared column types, read back off it — a view, not
   * a second place they live. `spec.fields[].type` is the ground.
   */
  types: FieldTypes;
}

export function parseAnswer(raw: string): Answer {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new AnswerError(`--answer must be "key=value", got ${JSON.stringify(raw)}`);
  return { key: raw.slice(0, eq).trim(), value: raw.slice(eq + 1).trim() };
}

/**
 * The answers the command line already gave without being asked.
 *
 * Found by a fresh-eyes run, 2026-09-23: `navvi make "<brief>" <url> <url>`
 * stopped at spec to ask what the input was, and on the next run which site,
 * about URLs on one host sitting right there in argv. Start URLs or a
 * `--from-url` list are a URL list; start URLs on a single host name the site.
 * Only a question the spec still has open is answered, and never one the
 * client answered explicitly: this fills silence, it does not overrule.
 */
export function answersFromUrls(spec: Spec, urls: readonly string[], fromUrls: readonly string[], explicit: readonly Answer[]): Answer[] {
  const said = new Set(explicit.map((answer) => key(answer.key).split(".")[0]!));
  for (const answer of explicit) {
    const question = spec.openQuestions.find((open) => key(open.id) === key(answer.key));
    if (question) said.add(key(question.about));
  }
  const open = (subject: OpenQuestionSubject): boolean => !said.has(subject) && spec.openQuestions.filter((question) => key(question.about) === subject).length === 1;
  const out: Answer[] = [];
  if (open("inputs") && urls.length + fromUrls.length > 0) out.push({ key: "inputs", value: "url_list" });
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).hostname.replace(/^www\./, ""));
    } catch {
      return out;
    }
  }
  if (open("target") && hosts.size === 1) out.push({ key: "target", value: [...hosts][0]! });
  return out;
}

/** The form a question id, a subject and an answer key are compared in. */
function key(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Resolves an answer to the part of the spec it sets.
 *
 * By question id first, so a client who quotes the id the spec printed is
 * obeyed exactly even when two questions share a subject. Then by subject, and
 * a subject with more than one open question about it is refused rather than
 * applied to both: two open questions about `fields` mean the drafter had two
 * different things to ask, and answering both with one string would put the
 * same answer in two places without anyone choosing to.
 */
export function matchAnswer(answer: Answer, spec: Spec): MatchedAnswer {
  const wanted = key(answer.key);
  const byId = spec.openQuestions.find((question) => key(question.id) === wanted);
  if (byId) return { ...answer, subject: byId.about, question: byId, by: "id" };

  const subject = wanted.split(".")[0]!;
  if ((OPEN_QUESTION_SUBJECTS as readonly string[]).includes(subject)) {
    const open = spec.openQuestions.filter((question) => key(question.about) === subject);
    if (open.length > 1) {
      throw new AnswerError(
        `--answer ${answer.key}: ${open.length} open questions are about ${subject} (${open.map((q) => q.id).join(", ")}); answer one by its id`,
      );
    }
    return { ...answer, subject: subject as OpenQuestionSubject, ...(open[0] ? { question: open[0] } : {}), by: "subject" };
  }

  const open = spec.openQuestions.map((question) => `${question.id} (${question.about})`);
  throw new AnswerError(
    `--answer ${answer.key}: no open question by that id, and ${subject} is not a part of a spec. ` +
      `Subjects: ${OPEN_QUESTION_SUBJECTS.join(", ")}. ` +
      (open.length === 0 ? `This spec has no open questions at all.` : `Open: ${open.join(", ")}.`),
  );
}

// ---------------------------------------------------------------- applying

/**
 * Applies the answers to the spec and removes the questions they settled.
 *
 * Returns a new spec; the one on disk is rewritten by the caller, because the
 * answered spec is the artifact everything downstream is built from and a spec
 * with a question still open in it would make the next run stop again.
 */
export function applyAnswers(spec: Spec, answers: readonly Answer[]): AppliedAnswers {
  let next: Spec = structuredClone(spec);
  const matched: MatchedAnswer[] = [];

  for (const answer of answers) {
    const match = matchAnswer(answer, next);
    next = applyOne(next, match);
    matched.push(match);
  }

  const settled = new Set(matched.map((match) => match.question?.id).filter((id): id is string => id !== undefined));
  next = { ...next, openQuestions: next.openQuestions.filter((question) => !settled.has(question.id)) };
  return { spec: next, matched, types: declaredFieldTypes(next) };
}

function applyOne(spec: Spec, match: MatchedAnswer): Spec {
  switch (match.subject) {
    case "fields":
      return applyFields(spec, match);
    case "inputs":
      return applyInputs(spec, match);
    case "target":
      return { ...spec, target: { ...spec.target, site: match.value, provenance: "answered" } };
    case "entity":
      return { ...spec, entity: { name: match.value, provenance: "answered" } };
    case "constraints":
      return applyConstraint(spec, match);
  }
}

/**
 * `--answer fields=productName,sku,listPrice:money,stock:boolean`.
 *
 * The names become the spec's field list, in the order the client wrote them,
 * which is the order every artifact downstream reports in. The optional `:type`
 * suffix is parsed by `parseFieldSpecs` — the repository's one spelling of
 * `name:type`, the same one `--fields` uses — and lands on the request itself,
 * as `FieldRequest.type`.
 *
 * It used to come back out separately and ride in `make.json` as a parameter
 * of the investigate stage, because `FieldRequest` had no type. Two things
 * were wrong with that beyond the tidiness: the declaration was not part of
 * the artifact the client approves, so nothing downstream could quote it back
 * at them; and it was re-derived from argv on every run, so a resume that did
 * not repeat `--answer` compiled the same spec with every column untyped.
 * `stock:boolean` and `stock:integer` are two different asks (see
 * `FieldRequest.type`) and which one was made is now stored, not passed.
 */
function applyFields(spec: Spec, match: MatchedAnswer): Spec {
  const names = match.value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (names.length === 0) throw new AnswerError(`--answer ${match.key}: name at least one field`);
  let parsed: Array<{ name: string; type?: FieldType }>;
  try {
    parsed = parseFieldSpecs(names);
  } catch (error) {
    throw new AnswerError(`--answer ${match.key}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const fields = parsed.map((field) => {
    // `briefTerm` is checked against the brief text by whoever reads it, so it
    // is set only when the word really is there — and checked with the spec
    // module's own `briefContains`, which matches on word boundaries. A naive
    // `includes` says the brief contains the field `a`, which would make every
    // short column name look like it came from the client's own words. A client
    // naming `promoPrice` for a brief that said "product info" has not made
    // that word appear in the brief, and claiming it did would make the spec
    // unfalsifiable.
    //
    // The same check decides the provenance, because it is the same question:
    // when the brief contains the word, the brief is the ground and the quote
    // proves it; when it does not, the ground is the person who answered, and
    // that is `answered` rather than a `brief` nobody could check.
    const named = briefContains(spec.brief, field.name);
    return {
      name: field.name,
      ...(named ? { briefTerm: field.name } : {}),
      ...(field.type === undefined ? {} : { type: field.type }),
      provenance: named ? ("brief" as const) : ("answered" as const),
    };
  });
  return { ...spec, fields };
}

function applyInputs(spec: Spec, match: MatchedAnswer): Spec {
  const shape = key(match.value).replace(/[\s-]+/g, "_");
  if (!(INPUT_SHAPES as readonly string[]).includes(shape)) {
    throw new AnswerError(`--answer ${match.key}: must be one of ${INPUT_SHAPES.join(", ")}, got "${match.value}"`);
  }
  /**
   * Re-applying an answer that changes nothing must change nothing.
   *
   * The first draft of this rewrote `description` unconditionally, and the
   * sentence it wrote named the open question it settled — so the *third* run
   * of the same command wrote a different sentence, because by then there was
   * no open question to name. `spec.json`'s bytes moved, and every stage below
   * it re-ran: a full re-investigation of a live catalogue caused by nothing
   * but running the same command twice. The staleness rule is over bytes, so
   * every writer above it has to be idempotent or the rule is a liability.
   *
   * The test is "not inferred" rather than "already `answered`" for the same
   * reason: a `spec.json` an older navvi wrote records an answered shape as
   * `brief`, and re-running the same command must not rewrite those bytes just
   * to relabel them. It settles at the shape the client asked for either way.
   */
  if (spec.inputs.shape === shape && spec.inputs.provenance !== "inferred") return spec;
  return {
    ...spec,
    inputs: {
      shape: shape as InputShape,
      description: `${match.value} — answered by the client${match.question ? `, settling ${match.question.id}` : ""}`,
      provenance: "answered",
    },
  };
}

const CONSTRAINT_NAMES = ["freshness", "volume", "cadence", "budget"] as const;

function applyConstraint(spec: Spec, match: MatchedAnswer): Spec {
  const parts = key(match.key).split(".");
  const name = parts[1];
  if (name === undefined || !(CONSTRAINT_NAMES as readonly string[]).includes(name)) {
    throw new AnswerError(`--answer ${match.key}: name the constraint, as constraints.${CONSTRAINT_NAMES.join(" / constraints.")}`);
  }
  return {
    ...spec,
    constraints: { ...spec.constraints, [name]: { value: match.value, stated: true } },
  };
}

// ----------------------------------------------------------------- reporting

/** What is still in the way, if anything. The one spelling of it is `blockingQuestions`. */
export function stillBlocking(spec: Spec): OpenQuestion[] {
  return blockingQuestions(spec);
}
