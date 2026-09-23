/**
 * The investigation phase: one public surface over eight modules.
 *
 * Read in cascade order, which is also cost order:
 *
 * - `sample.ts`    — which URLs a compile is built from, and why each one.
 * - `declared.ts`  — tier 1: what a page states about itself, one HTTP request.
 * - `leaves.ts`    — tier 2's deterministic filter: flatten, anchor, type, vary.
 * - `bind.ts`      — tier 2's answer: a narrowed table to one binding.
 * - `roles.ts`     — tier 1's answer: a declared property is a lookup, not a search.
 * - `har.ts`       — a capture stands in for the browser.
 * - `blocked.ts`   — is the run broken, or is the site refusing you?
 * - `investigate.ts` / `manuscript.ts` — the cascade, and what it writes down.
 */

export { bindField, type BindOptions, type Binding } from "./bind.js";
export {
  BLOCKING_STATUSES,
  CHALLENGE_MARKERS,
  DEFAULT_REMEDY,
  apologySignals,
  challengeSignal,
  checkCanary,
  classifyRun,
  detectBlocking,
  mayHeal,
  recordCanary,
  settleDeferred,
  statusSignal,
  type ApologyOptions,
  type BlockedVerdict,
  type BlockingSignal,
  type BlockingSignalKind,
  type CanaryFingerprint,
  type CanaryReading,
  type CanaryState,
  type DeferredVerdict,
  type DriftVerdict,
  type FieldFill,
  type HealthyVerdict,
  type PageResponse,
  type RecordCanaryOptions,
  type Remedy,
  type RenderEvidence,
  type RunInput,
  type RunVerdict,
} from "./blocked.js";
export { coversSpec, declaredFrom, jsonLdBlocks, readDeclared, type DeclaredKind, type DeclaredOptions, type DeclaredReading, type DeclaredSource } from "./declared.js";
export { importHar, safeUrl, type CapturedResponse, type HarImport } from "./har.js";
export { investigate, type Capture, type InvestigateOptions, type Sources } from "./investigate.js";
export { anchors, flatten, narrow, typeMatches, type Candidate, type FlattenOptions, type Leaf, type NarrowOptions } from "./leaves.js";
export {
  render,
  type FieldRecord,
  type Manuscript,
  type Obstacle,
  type RejectionRecord,
  type RequestedField,
  type SamplePickRecord,
  type SampleRecord,
  type SourceRecord,
  type TierName,
  type TierRecord,
  type VerdictLog,
} from "./manuscript.js";
export { KIND_PRECEDENCE, acceptedRoles, fieldTokens, resolutionOrder, roleOfDeclared, roleOfField, type DeclaredRole } from "./roles.js";
export {
  STRATA,
  STRATUM_RATIONALE,
  chooseSample,
  classify,
  type ChooseOptions,
  type Classification,
  type ExcludedProbe,
  type ExcludedReason,
  type PickReason,
  type SampleChoice,
  type SamplePick,
  type Stratum,
  type UnfilledStratum,
  type UrlProbe,
} from "./sample.js";
