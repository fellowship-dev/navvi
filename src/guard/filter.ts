import { RULES, type Rule } from "./rules.js";

/**
 * U13 / R17: the prompt-injection pre-filter. Page text that tries to instruct
 * the model reading it is cut out before it reaches a chooser question, and
 * every cut is counted with its reason so a run summary can say so.
 *
 * Deterministic and local on purpose: no model call, no network, microseconds
 * per kilobyte. It runs where page text meets the chooser (compile, navigate,
 * heal, free-text questions) and never on pinned replay, which asks no
 * question and therefore has nothing to filter. Chosen over a classifier call
 * by evals/injection/REPORT.md, which is where its numbers live.
 */

/** What replaces a quarantined span. Must match no rule, or a second pass would count it again. */
export const QUARANTINE_MARKER = "[removed: suspected prompt injection]";

export interface Finding {
  /** The rule that fired (`override`, `chat_markup`, ...). */
  rule: string;
  start: number;
  end: number;
}

export interface Sanitized {
  text: string;
  findings: Finding[];
}

/** The longest line quarantined whole; a longer one gives up only the sentences around the hit. */
const MAX_LINE = 400;
const SENTENCE_END = /[.!?](?=\s)|\n/g;

function lineBounds(text: string, at: number): [number, number] {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const nl = text.indexOf("\n", at);
  return [start, nl < 0 ? text.length : nl];
}

/** The sentence around `[from, to)`, inside `[lo, hi)`; with `next`, the following sentence too. */
function sentenceBounds(text: string, from: number, to: number, lo: number, hi: number, next: boolean): [number, number] {
  let start = lo;
  SENTENCE_END.lastIndex = lo;
  for (let m = SENTENCE_END.exec(text); m && m.index < from && m.index < hi; m = SENTENCE_END.exec(text)) start = m.index + 1;
  let end = hi;
  let ends = next ? 2 : 1;
  SENTENCE_END.lastIndex = Math.max(to, start);
  for (let m = SENTENCE_END.exec(text); m && m.index < hi; m = SENTENCE_END.exec(text)) {
    if (--ends === 0) {
      end = m.index + 1;
      break;
    }
  }
  return [start, end];
}

/** The next line with text on it after `from`, as `[start, end)`, or undefined. */
function nextLine(text: string, from: number): [number, number] | undefined {
  let at = from;
  while (at < text.length) {
    const [start, end] = lineBounds(text, at);
    if (text.slice(start, end).trim()) return [start, end];
    at = end + 1;
  }
  return undefined;
}

function reach(text: string, rule: Rule, from: number, to: number): [number, number] {
  const lo = lineBounds(text, from)[0];
  const hi = lineBounds(text, Math.max(from, to - 1))[1];
  if (rule.block) return [lo, hi];
  if (hi - lo <= MAX_LINE) {
    // An override that ends its line on a colon ("... do the following first:") hands its payload to the next line.
    if (rule.takesNext && /:\s*$/.test(text.slice(lo, hi))) {
      const next = nextLine(text, hi + 1);
      if (next && next[1] - next[0] <= MAX_LINE) return [lo, next[1]];
    }
    return [lo, hi];
  }
  return sentenceBounds(text, from, to, lo, hi, rule.takesNext === true);
}

const ENCODED = /(?:[01]{8}\s+){5,}[01]{8}|[A-Za-z0-9+/]{24,}={0,2}/g;
const ENCODED_RULE: Rule = { id: "encoded", pattern: ENCODED };

/** Base64 or space-separated binary as text, when it decodes to something printable. */
function decode(blob: string): string | undefined {
  let out: string;
  if (/^[01\s]+$/.test(blob)) {
    out = blob.trim().split(/\s+/).map((b) => String.fromCharCode(parseInt(b, 2))).join("");
  } else {
    if (!/[a-z]/.test(blob) || !/[A-Z]/.test(blob)) return undefined;
    out = Buffer.from(blob, "base64").toString("utf8");
  }
  const printable = [...out].filter((c) => /[\p{L}\p{N}\p{P}\p{Zs}]/u.test(c)).length;
  return out.length >= 12 && printable / out.length > 0.9 ? out : undefined;
}

/** The id of the first rule that fires anywhere in `text`. */
function firstRule(text: string): string | undefined {
  return RULES.find((rule) => rule.pattern.test(text))?.id;
}

/** Every rule hit in `text`, each widened to the span it quarantines, overlaps merged. */
export function scanText(text: string): Finding[] {
  if (text.length === 0) return [];
  const raw: Finding[] = [];
  for (const rule of RULES) {
    const global = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
    for (const m of text.matchAll(global)) {
      // A pattern anchored on a line break starts at the break; the hit is the text after it.
      const lead = m[0].length - m[0].trimStart().length;
      const [start, end] = reach(text, rule, m.index + lead, m.index + m[0].length);
      raw.push({ rule: rule.id, start, end });
    }
  }
  // Token smuggling: an instruction hidden in Base64 or in 8-bit binary is decoded and held to the same rules.
  for (const m of text.matchAll(ENCODED)) {
    const decoded = decode(m[0]);
    const inner = decoded === undefined ? undefined : firstRule(decoded);
    if (inner === undefined) continue;
    const [start, end] = reach(text, ENCODED_RULE, m.index, m.index + m[0].length);
    raw.push({ rule: `encoded_${inner}`, start, end });
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Finding[] = [];
  for (const f of raw) {
    const last = merged[merged.length - 1];
    if (last && f.start <= last.end) last.end = Math.max(last.end, f.end);
    else merged.push({ ...f });
  }
  return merged;
}

/**
 * `text` with every finding replaced by `marker` (the quarantine marker by
 * default; "" when the caller cannot afford the text to grow). Unchanged, the
 * same string, when nothing fired.
 */
export function sanitizeText(text: string, marker: string = QUARANTINE_MARKER): Sanitized {
  const findings = scanText(text);
  if (findings.length === 0) return { text, findings };
  let out = "";
  let at = 0;
  for (const f of findings) {
    out += text.slice(at, f.start) + marker;
    at = f.end;
  }
  return { text: out + text.slice(at), findings };
}

export type GuardJson = string | number | boolean | null | GuardJson[] | { [key: string]: GuardJson };

/** Every string inside a JSON value sanitized; the same object back when nothing fired. */
export function sanitizeJson<T extends GuardJson>(value: T, marker: string = QUARANTINE_MARKER): { value: T; findings: Finding[] } {
  const findings: Finding[] = [];
  const walk = (v: GuardJson): GuardJson => {
    if (typeof v === "string") {
      const s = sanitizeText(v, marker);
      findings.push(...s.findings);
      return s.text;
    }
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x);
        changed ||= y !== x;
        return y;
      });
      return changed ? out : v;
    }
    if (v !== null && typeof v === "object") {
      let changed = false;
      const out: { [key: string]: GuardJson } = {};
      for (const [k, x] of Object.entries(v)) {
        const y = walk(x);
        changed ||= y !== x;
        out[k] = y;
      }
      return changed ? out : v;
    }
    return v;
  };
  return { value: walk(value) as T, findings };
}

/**
 * A string that may be serialized JSON (the text helper's state is): parsed and
 * sanitized per value so the result is still valid JSON, else sanitized as text.
 */
export function sanitizeState(state: string, marker: string = QUARANTINE_MARKER): Sanitized {
  const trimmed = state.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: GuardJson | undefined;
    try {
      parsed = JSON.parse(state) as GuardJson;
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const { value, findings } = sanitizeJson(parsed, marker);
      return findings.length === 0 ? { text: state, findings } : { text: JSON.stringify(value), findings };
    }
  }
  return sanitizeText(state, marker);
}
