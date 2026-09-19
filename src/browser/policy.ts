import { isAllowedUrl, type Profile } from "../input/schema.js";
import { normalize } from "../util/text.js";

/**
 * Browser policy (R24, R25, R26, R38, KTD14). One pure filter,
 * `allowedControl`, runs at compile and at replay; structure is checked
 * before names.
 */

export { isAllowedUrl };

/** Schemes that never leave the page; everything else must pass the URL guard. */
const IN_PAGE_SCHEMES = new Set(["about:", "data:", "blob:"]);

/** R26 as a `page.route`-style predicate. */
export function isAllowedRequestUrl(url: string, allowPrivateHosts: readonly string[] = []): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (IN_PAGE_SCHEMES.has(parsed.protocol)) return parsed.protocol !== "about:" || url === "about:blank";
  return isAllowedUrl(url, allowPrivateHosts);
}

/** Second-level public suffixes where the registrable domain is three labels. */
const SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "org.mx", "gob.mx", "edu.mx",
  "com.ar", "org.ar", "gob.ar", "edu.ar",
  "com.co", "org.co", "gov.co", "edu.co",
  "com.pe", "org.pe", "gob.pe", "edu.pe",
  "com.uy", "com.py", "com.bo", "com.ec", "com.ve",
  "gob.cl", "gov.cl",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.nz", "org.nz", "net.nz",
  "co.za", "org.za",
  "co.in", "org.in", "net.in",
  "co.kr", "com.cn", "com.hk", "com.sg", "com.tw", "com.tr", "com.my",
  "com.es", "org.es",
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** R25: last two labels, or three when the last two are a known second-level suffix. */
export function registrableDomain(host: string): string {
  const clean = host.trim().toLowerCase().replace(/\.$/, "");
  if (IPV4.test(clean) || clean.startsWith("[")) return clean;
  const labels = clean.split(".");
  if (labels.length <= 2) return clean;
  const lastTwo = labels.slice(-2).join(".");
  return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** Lower-case host of an http(s) URL; null for any other scheme or an unparsable URL. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostWithin(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** R25: a URL stays on a start URL's registrable domain or a listed allowed domain (subdomains included). */
export function isOnAllowedDomain(url: string, startUrls: readonly string[], allowedDomains: readonly string[] = []): boolean {
  const host = hostOf(url);
  if (!host) return false;
  for (const start of startUrls) {
    const startHost = hostOf(start);
    if (startHost && hostWithin(host, registrableDomain(startHost))) return true;
  }
  return allowedDomains.some((d) => hostWithin(host, d.trim().toLowerCase().replace(/^\*?\./, "")));
}

/** A control as enumerated by code from the accessibility tree. Never model output. */
export interface Control {
  role: string;
  name: string;
  tag?: string;
  inputType?: string;
  form?: { method: string; hasTypedText: boolean; hasPasswordField: boolean; hasPaymentField: boolean };
  autocomplete?: string;
  nameAttr?: string;
}

export interface PolicyContext {
  allowMutations: readonly string[];
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export const DENY_LIST_EN = [
  "delete", "remove", "buy", "purchase", "checkout", "check out", "pay", "confirm", "order", "send", "post",
  "publish", "subscribe", "unsubscribe", "sign out", "signout", "log out", "logout", "follow", "report",
] as const;

export const DENY_LIST_ES = [
  "eliminar", "borrar", "quitar", "comprar", "pagar", "confirmar", "pedir", "enviar", "publicar", "suscribir",
  "suscribirse", "desuscribir", "desuscribirse", "cerrar sesión", "seguir", "reportar", "denunciar",
] as const;

export const DENY_LIST = [...DENY_LIST_EN, ...DENY_LIST_ES] as const;

const PAYMENT_PATTERNS = [/^cc-/i, /card/i, /cvv/i, /cvc/i, /\bcc\b/i, /credit/i, /iban/i, /tarjeta/i];
const PERSONAL_PATTERNS = [
  ...PAYMENT_PATTERNS,
  /ssn/i, /passport/i, /\bdob\b/i, /birth/i, /bday/i, /phone/i, /\btel\b/i, /tel-/i, /telefono/i, /rut/i, /dni/i, /email/i,
];

const NORMALIZED_DENY = DENY_LIST.map((term) => ({ term, pattern: new RegExp(`(^|[^\\p{L}\\p{N}])${normalize(term)}([^\\p{L}\\p{N}]|$)`, "u") }));

/** The deny-list term matched by an accessible name, or null. */
export function deniedName(name: string): string | null {
  const text = normalize(name);
  if (!text) return null;
  return NORMALIZED_DENY.find(({ pattern }) => pattern.test(text))?.term ?? null;
}

function matchesAny(value: string | undefined, patterns: readonly RegExp[]): boolean {
  return value !== undefined && patterns.some((p) => p.test(value));
}

export function isPaymentField(control: Control): boolean {
  return matchesAny(control.autocomplete, PAYMENT_PATTERNS) || matchesAny(control.nameAttr, PAYMENT_PATTERNS);
}

export function isPersonalDataField(control: Control): boolean {
  return matchesAny(control.autocomplete, PERSONAL_PATTERNS) || matchesAny(control.nameAttr, PERSONAL_PATTERNS);
}

/** R24: only password inputs may be typed into, and only through a secret placeholder step. */
export function isSecretCapable(control: Control): boolean {
  return control.inputType?.toLowerCase() === "password";
}

function isSubmitControl(control: Control): boolean {
  if (!control.form) return false;
  const type = control.inputType?.toLowerCase();
  if (type === "submit" || type === "image") return true;
  return control.tag?.toLowerCase() === "button" && (type === undefined || type === "submit");
}

function mutationAllowed(control: Control, term: string, ctx: PolicyContext): boolean {
  const name = normalize(control.name);
  return ctx.allowMutations.some((entry) => {
    const wanted = normalize(entry);
    return wanted === normalize(term) || wanted === name;
  });
}

/**
 * KTD14: the one filter both the compiler and the replayer run. Structure
 * first (input types, payment, forms), names last.
 */
export function allowedControl(control: Control, profile: Profile, ctx: PolicyContext): PolicyDecision {
  const inputType = control.inputType?.toLowerCase();
  if (inputType === "password") return { allowed: false, reason: "password inputs are only reachable through a secret step" };
  if (inputType === "file") return { allowed: false, reason: "file inputs are never targets" };
  if (inputType === "hidden") return { allowed: false, reason: "hidden inputs are never targets" };
  if (isPaymentField(control)) return { allowed: false, reason: "payment fields are never targets" };

  if (control.form?.hasPaymentField && isSubmitControl(control)) {
    return { allowed: false, reason: "submitting a form with a payment field is never allowed" };
  }
  if (profile === "store" && isSubmitControl(control) && control.form) {
    const { method, hasTypedText, hasPasswordField } = control.form;
    if (method.toLowerCase() === "post" && !(hasTypedText && !hasPasswordField)) {
      return { allowed: false, reason: "store profile: POST submit without a text field typed in this run" };
    }
  }

  const term = deniedName(control.name);
  if (term) {
    if (profile === "local" && mutationAllowed(control, term, ctx)) return { allowed: true };
    return { allowed: false, reason: `${profile} profile: "${term}" is on the deny list` };
  }
  return { allowed: true };
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const CARD = /(?:\d[ -]?){13,19}/;
/**
 * A phone number needs a leading `+`, a parenthesized area code, or digits in
 * three separator-delimited groups. A bare run of digits or an ISO date
 * (`2026-09-19`, `20260919`, `ORD-12345678`) is not personal data.
 */
const PHONE = /\+\d[\d ().-]{6,}\d\b|\(\d{2,4}\)[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b|\b\d{2,4}[\s.-]\d{3,4}[\s.-]\d{3,4}\b/;

function digitCount(text: string): number {
  return (text.match(/\d/g) ?? []).length;
}

/** R24: model text never lands in personal-data fields, and never looks like an email, phone or card number. */
export function isModelTextAllowed(control: Control, text: string): boolean {
  if (isPersonalDataField(control)) return false;
  if (EMAIL.test(text)) return false;
  if (CARD.test(text) && digitCount(text) >= 13) return false;
  if (PHONE.test(text) && digitCount(text) >= 8) return false;
  return true;
}
