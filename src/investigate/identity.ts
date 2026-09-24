import type { TypedValue } from "../scraper/extract.js";
import { normalize } from "../util/text.js";
import type { Leaf } from "./leaves.js";

/**
 * KTD4: a payload may bind only if it is about *this* page.
 *
 * Found on a live pharmacy run, 2026-09-23: `make` bound `sku` and `stock`
 * to `total` on a recommendations endpoint — the count of other products the
 * page suggested — and every gate downstream passed. Tier 2's only notion of
 * identity was "the endpoint that names the most uncovered fields is the
 * product", which says nothing about an endpoint that names none and offers a
 * lone anchored number to any field that asks. A recommendations payload is
 * served on the product page, fetched by the product page, varies with the
 * product page, and describes every product except that one.
 *
 * So an endpoint has to show, in its own leaves, that it is describing the
 * page it was captured on: one path whose value, on every sample that answered
 * it, is that sample's own identity — the id or slug in its URL, the sku or
 * name it declares about itself, its headline. A product endpoint carries its
 * product's id as a matter of course; a recommendations endpoint carries other
 * products' ids, and that is the whole difference this file reads.
 *
 * Deliberately leaves only, and not the endpoint's own request URL. A
 * recommendations call is addressed by this product's id as often as a detail
 * call is (`recommendations/<id>`), so "the request names the page" is exactly
 * the evidence that could not tell the two apart. The cost is known: a thin
 * satellite (`stock/<id>` answering `{available: 7}`) states nothing about
 * which product it is, cannot prove it is this page's, and goes to the next
 * tier. Refusing a right binding costs a DOM compile; accepting a wrong one
 * costs a scraper that reports a count of recommendations as a stock level.
 */

/**
 * Tokens shorter than this are not an identity. A two-digit id or a `p`
 * path segment matches half of any payload.
 */
const MIN_TOKEN = 4;

/** Lower-cased, accent-folded, alphanumerics only: `Jarabe Ejemplo 120 ml` and `jarabe-ejemplo-120ml` are one spelling. */
function compact(text: string): string {
  return normalize(text).replace(/[^a-z0-9]/g, "");
}

/** The path segments of a URL, each with its file extension dropped, plus every digit run of an id's length inside them. */
function urlTokens(url: string): string[] {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
  }
  const out: string[] = [];
  for (const raw of path.split("/")) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // A malformed escape is still a segment; compare it as it was written.
    }
    segment = segment.replace(/\.[a-z0-9]{2,5}$/i, "");
    if (segment === "") continue;
    out.push(segment);
    for (const run of segment.match(/\d{4,}/g) ?? []) out.push(run);
  }
  return out;
}

/** The headline a reader was shown, when the rendered HTML was kept. */
export function headlineOf(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;
  const found = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (found === null) return undefined;
  const text = found[1]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

export interface PageIdentity {
  /** Values that are this page and no other, compacted: URL ids and slugs, declared sku and name, the headline. */
  exact: string[];
  /** URL slugs, compacted, which a product name may be spelled *inside* of (`paracetamol-500-mg-16-comprimidos-881926`). */
  slugs: string[];
}

/**
 * What each sample page says it is.
 *
 * `declared` is what the page stated about itself — the sku and name tier 1
 * read, whether or not the spec asked for them — and `headline` is its `<h1>`.
 * Both optional per sample: a shell declares nothing, and a capture imported
 * from a HAR kept no HTML.
 *
 * A URL token every sample shares is the template, not the item — `producto`
 * in `/producto/<slug>` — and is dropped. With one sample there is nothing to
 * compare against, so nothing is dropped, and the manuscript already says a
 * one-sample investigation is the weaker kind.
 */
export function pageIdentities(samples: ReadonlyArray<{ url: string; declared?: readonly TypedValue[] | undefined; headline?: string | undefined }>): PageIdentity[] {
  const perSample = samples.map((sample) => urlTokens(sample.url).map(compact).filter((token) => token.length >= MIN_TOKEN));
  const shared = samples.length > 1 ? new Set(perSample[0]!.filter((token) => perSample.every((tokens) => tokens.includes(token)))) : new Set<string>();
  return samples.map((sample, index) => {
    const own = perSample[index]!.filter((token) => !shared.has(token));
    const stated = [...(sample.declared ?? []), ...(sample.headline === undefined ? [] : [sample.headline])]
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map((value) => compact(String(value)))
      .filter((token) => token.length >= MIN_TOKEN);
    return { exact: [...new Set([...own, ...stated])], slugs: own.filter((token) => /[a-z]/.test(token)) };
  });
}

/** Is this value the page's own identity? */
function names(value: TypedValue, identity: PageIdentity): boolean {
  if (value === null || typeof value === "boolean") return false;
  const token = compact(String(value));
  if (token.length < MIN_TOKEN) return false;
  if (identity.exact.includes(token)) return true;
  // A name spelled inside the slug. Eight characters is the floor because a
  // shorter string turns up inside any slug by accident.
  return token.length >= 8 && identity.slugs.some((slug) => slug.includes(token));
}

export interface IdentityAnchor {
  path: string;
  values: TypedValue[];
}

/**
 * The first path (in path order, so two runs agree) whose value is, on every
 * sample, that sample's own identity — or `undefined` when this payload never
 * says which product it is about.
 *
 * `samples` and `identities` are in the same order: the endpoint's
 * contributors, not the run's samples.
 */
export function identityAnchor(samples: readonly Leaf[][], identities: readonly PageIdentity[]): IdentityAnchor | undefined {
  if (samples.length === 0 || samples.length !== identities.length) return undefined;
  // Indexed once: a CMS payload flattens to thousands of leaves and this is asked of every endpoint.
  const byPath = samples.map((leaves) => new Map(leaves.map((leaf) => [leaf.path, leaf.value] as const)));
  const paths = [...byPath[0]!.keys()].sort();
  for (const path of paths) {
    const values: TypedValue[] = [];
    let every = true;
    for (const [index, leaves] of byPath.entries()) {
      if (!leaves.has(path)) {
        every = false;
        break;
      }
      const value = leaves.get(path)!;
      if (!names(value, identities[index]!)) {
        every = false;
        break;
      }
      values.push(value);
    }
    if (every) return { path, values };
  }
  return undefined;
}
