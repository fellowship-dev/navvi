/**
 * R27: a prompt, goal or description carrying a credential literal is refused
 * before any model call. The check lives here, import-free, so the input
 * schema, the prompt parser and the pre-steps share one detector.
 */

export type CredentialKind = "password" | "token" | "api key" | "user:pass pair" | "token-looking string";

const CREDENTIAL_LITERALS: ReadonlyArray<readonly [CredentialKind, RegExp]> = [
  ["password", /(?<!\{\{)\b(password|contraseña|contrasena|passwd|pwd|clave)\s*[:=]\s*(?!\{\{secret:)\S+/iu],
  ["api key", /(?<!\{\{)\b(api[ _-]?key)\s*[:=]\s*(?!\{\{secret:)\S+/iu],
  ["token", /(?<!\{\{)\b(token|secret)\s*[:=]\s*(?!\{\{secret:)\S+/iu],
  ["user:pass pair", /(?<![\w.:/-])[^\s:@/]+:[^\s:@/]+@[^\s@]+/u],
  ["token-looking string", /\b(sk|ghp|gho|xox[abps]|vck|AKIA|pk|rk)[-_][A-Za-z0-9_-]{8,}\b/u],
  ["token-looking string", /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/u],
];

const URL_PATTERN = /https?:\/\/\S+/giu;

/** The kind of credential literal `text` carries, or null when it carries none. */
export function looksLikeCredential(text: string): CredentialKind | null {
  const withoutUrls = text.replace(URL_PATTERN, " ");
  for (const [kind, pattern] of CREDENTIAL_LITERALS) {
    if (pattern.test(withoutUrls)) return kind;
  }
  return null;
}

/** The texts the run reads instructions from, in the order they are checked. */
export type CredentialTexts = { prompt?: string | undefined; goal?: string | undefined; description?: string | undefined };
export type CredentialWhere = keyof CredentialTexts;
export interface CredentialFound {
  kind: CredentialKind;
  where: CredentialWhere;
}

/** The first credential literal among prompt, goal and description, or null. */
export function findCredential(texts: CredentialTexts): CredentialFound | null {
  for (const where of ["prompt", "goal", "description"] as const) {
    const text = texts[where];
    if (!text) continue;
    const kind = looksLikeCredential(text);
    if (kind) return { kind, where };
  }
  return null;
}

/** The refusal, naming the `{{secret:name}}` form the text should use instead. */
export function credentialMessage(kind: string, where: string): string {
  return (
    `the ${where} carries a ${kind}; never put credentials in the prompt, goal or description. ` +
    `Reference them as {{secret:name}} placeholders and pass the values in the secrets input with profile: local.`
  );
}
