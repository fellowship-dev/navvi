/**
 * U2d: which URLs a compile is built from.
 *
 * The committed Store B compile input records its sample as **"lines 2-5 of
 * the Store B list"**. An arbitrary slice off the top of a catalogue is how
 * three confidently wrong scrapers were produced in one session on 2026-09-22:
 * StoreC bound `listPrice` to the sale price because every sampled page had a
 * sale; StoreC abandoned 4 of 7 templates and returned 3 items from 115 URLs;
 * Store B collapsed `listPrice` and `promoPrice` onto the same node on 46 of
 * 46 comparable products, median ratio 0.80 against legacy, with both numbers
 * plausible and every type check passing. That is R23 of the client plan: a
 * compile sample must carry, per store, at least one page of each — discounted
 * and undiscounted, in stock and out of stock, and a URL that no longer
 * resolves.
 *
 * This module is the replacement for the slice. It is also what makes the
 * variation check in `leaves.ts` mean anything: `narrow`'s `requireVariation`
 * rejects a leaf that is constant across the sample, and a sample that is all
 * one shape has nothing to be constant *against* — every binding survives, and
 * the one that cannot vary is chosen.
 *
 * Two halves, deliberately separate:
 *   - the **probe** is what is cheaply knowable about a URL (`UrlProbe`), and
 *     is not produced here — nothing in this file fetches anything. `probe.ts`
 *     reads one into being from a response the caller already has, and asks
 *     `shell-skips-tier-1` for `isShell` rather than spelling it a second time;
 *   - the **choice** is `chooseSample`, which is pure, offline and
 *     deterministic: the same probes always yield the same sample, so a compile
 *     input is reproducible and every pick can say why it is in the sample.
 */

// ------------------------------------------------------------------- probe

/**
 * What one cheap look at a URL can establish. A HEAD or a single GET answers
 * all of it; none of it needs the compile to have happened yet.
 *
 * Every field but `url` and `status` is optional because a probe is allowed to
 * be partial, and a chooser that demands complete knowledge is a chooser that
 * never runs. Absent is not false: `inStock: undefined` means the probe did not
 * look, and is never read as out of stock.
 */
export interface UrlProbe {
  url: string;
  /** The status the URL finally answered with. 0 when it never answered at all. */
  status: number;
  /** Where the response landed, when it moved. Relative values resolve against `url`. */
  redirectedTo?: string | undefined;
  /** Does the landed page declare a Product node (JSON-LD, microdata)? */
  hasDeclaredProduct?: boolean | undefined;
  /**
   * Did the plain fetch come back a JS shell — little visible text, a bundle to
   * fill it, nothing declared? A shell declares no Product *and is not dead*,
   * which is the distinction the first live run of the cascade found the hard
   * way: every Store B URL was classified `dead:no-product` and dropped from
   * the binding set, so the investigation read nothing at all. The answer lives
   * in its payload, one render away. `shell-skips-tier-1` is the detector.
   *
   * Absent is not false here either: an unknown shell state must not let the
   * no-Product rule fire, because the rule cannot tell the two apart alone.
   */
  isShell?: boolean | undefined;
  /** How many *distinct* price values the page shows. 2 or more means a discount is visible. */
  priceCount?: number | undefined;
  inStock?: boolean | undefined;
}

// ------------------------------------------------------------------ strata

export type Stratum = "dead" | "out-of-stock" | "discounted" | "undiscounted";

/** A pick either stands for a stratum or was added to widen the sample's shapes. */
export type PickReason = Stratum | "coverage";

/**
 * The order the strata are filled in, and it is not arbitrary: it runs from the
 * omission that fails most silently to the one that fails loudest.
 *
 * 1. **dead** — a scraper that never saw a dead URL has never been asked to
 *    reproduce a blank, and reproducing the blank is what parity means. It is
 *    also not an edge case: roughly 73% of client's StoreA URLs 302 away from
 *    their product page, and in the same day's legacy run 33 of 131 StoreA
 *    rows carry an empty product name — excel4node accepted every one of them,
 *    so a quarter of that column has been blank with no error raised anywhere.
 *    Omitting this stratum means compiling from the minority of the catalogue.
 * 2. **out-of-stock** — the stratum most likely to be *missing markup*. The
 *    price node a binding depends on may not render at all when nothing is for
 *    sale, and a binding compiled only on in-stock pages has never seen its own
 *    absence. StoreA already defaults to out of stock when the page says
 *    nothing, so the two readings have to be told apart from a real sample.
 * 3. **discounted** (list != promo) — two distinct prices on the page are the
 *    only condition under which the Store B collapse is visible at all.
 * 4. **undiscounted** (list == promo, or no promo) — the converse, and the one
 *    StoreC lacked: with a sale on every sampled page, binding `listPrice` to
 *    the sale price looked correct. A single-price page is what proves the
 *    binding does not secretly require a second one.
 *
 * Then the remaining slots go to whatever shape is still unrepresented, because
 * after the four strata the next most useful page is simply the least similar
 * one.
 */
export const STRATA: readonly Stratum[] = ["dead", "out-of-stock", "discounted", "undiscounted"];

/** Why each stratum is worth a slot — quoted back when one cannot be filled. */
export const STRATUM_RATIONALE: Record<Stratum, string> = {
  dead: "reproducing a blank is parity, and a scraper that never saw a dead URL has never been asked to reproduce one",
  "out-of-stock": "the price node a binding depends on may not render when nothing is for sale",
  discounted: "two distinct prices are the only condition under which two fields collapsing onto one is visible",
  undiscounted: "a single-price page proves the binding does not secretly require a second price",
};

/**
 * Why a probe cannot be compiled from at all — as opposed to being dead, which
 * is a fact about the catalogue and belongs in the sample.
 */
export type ExcludedReason = "blocked" | "transient";

// -------------------------------------------------------------- classifying

export interface Classification {
  url: string;
  /** Every stratum this probe could stand for; a page is often several at once. */
  strata: Stratum[];
  /**
   * The probe's observable shape, as a stable string. Two URLs with the same
   * signature teach the compile the same thing, so this is both the tiebreak
   * within a stratum (prefer the majority form, since parity is reproducing
   * what the catalogue actually does) and the measure of "most different" when
   * filling the remaining slots.
   */
  signature: string;
  /** Plain language for what the probe saw; the seed of every pick's `because`. */
  note: string;
  /** Set when the probe is not usable as compile input at all. */
  excluded?: { reason: ExcludedReason; because: string };
}

/** Status codes that mean "we were refused", not "this URL is gone". */
const BLOCKED_STATUS = new Set([401, 403, 407, 429]);

/**
 * host + path, case-folded, trailing slash and query dropped.
 *
 * A redirect that only adds a tracking query or a trailing slash still landed
 * on the product page and must not be read as dead; a redirect to
 * `/categoria/…` did not. Query strings are dropped rather than compared
 * because that is the difference between the two.
 */
function locus(url: string, base?: string): string {
  try {
    const parsed = base === undefined ? new URL(url) : new URL(url, base);
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

/** 0 -> "0", 1 -> "1", anything above -> "2+": the only distinction a discount needs. */
function priceBand(count: number | undefined): string {
  if (count === undefined) return "prices?";
  if (count <= 0) return "no-price";
  return count === 1 ? "one-price" : "two-or-more-prices";
}

function stockBand(inStock: boolean | undefined): string {
  return inStock === undefined ? "stock?" : inStock ? "in-stock" : "out-of-stock";
}

/**
 * One probe, read as strata and a shape. Pure, and the only place the meaning
 * of "dead" is decided.
 *
 * Dead and refused are kept apart on purpose. A 403 or a 429 is the blocked
 * state U3a detects, and compiling a blank from it would teach the scraper to
 * write an empty row every time a datacenter IP is turned away — the StoreC
 * failure mode, arriving as data instead of as an error. A 5xx is the site
 * having a bad minute; it is not a property of the catalogue and will not
 * reproduce. Neither belongs in a compile sample, and both are reported rather
 * than quietly dropped.
 */
export function classify(probe: UrlProbe): Classification {
  const { url, status } = probe;

  if (status === 0) {
    return {
      url,
      strata: [],
      signature: "excluded:transient",
      note: "never answered",
      excluded: { reason: "transient", because: "the URL never answered; one silent probe is not evidence the catalogue lost it" },
    };
  }
  if (BLOCKED_STATUS.has(status)) {
    return {
      url,
      strata: [],
      signature: "excluded:blocked",
      note: `answers ${status}`,
      excluded: { reason: "blocked", because: `${status} is a refusal, not a dead URL; compiling a blank from it teaches the scraper to write an empty row whenever it is turned away` },
    };
  }
  if (status >= 500) {
    return {
      url,
      strata: [],
      signature: "excluded:transient",
      note: `answers ${status}`,
      excluded: { reason: "transient", because: `${status} is the site having a bad minute, not a fact about the catalogue` },
    };
  }

  // --- dead, in the three shapes a catalogue actually produces
  if (status >= 400) {
    return { url, strata: ["dead"], signature: `dead:status-${status}`, note: `answers ${status}` };
  }
  const moved = probe.redirectedTo !== undefined && locus(probe.redirectedTo, url) !== locus(url);
  if (moved || (status >= 300 && status < 400)) {
    const where = probe.redirectedTo === undefined ? "somewhere it did not report" : probe.redirectedTo;
    return { url, strata: ["dead"], signature: "dead:redirect", note: `redirects to ${where}, which is not its product page` };
  }
  if (probe.hasDeclaredProduct === false && probe.isShell === false) {
    // StoreA, 2026-09-22: a 200 that declares Organization and no Product.
    // The graph walk bound productName to "StoreA" on all 33 of them, so
    // the row looked extracted. Same blank, wearing a different coat.
    //
    // It takes `isShell === false` to say that, and the qualifier is the whole
    // point. Store B's plain fetch declares no Product on *every* URL in the
    // catalogue -- 2,863 characters of shell, with the answer in the payload
    // the page fetches for itself. Without the qualifier this rule reads a
    // perfectly healthy store as 100% dead, drops every URL from the binding
    // set, and the investigation reads nothing. That is not a hypothetical: it
    // is what the first live run of the cascade did, and the unit tests on both
    // sides passed while it happened, because each was written against its own
    // fixture.
    return { url, strata: ["dead"], signature: "dead:no-product", note: `answers ${status} but declares no Product node and is not a shell` };
  }

  // --- live
  const strata: Stratum[] = [];
  if (probe.inStock === false) strata.push("out-of-stock");
  if (probe.priceCount !== undefined && probe.priceCount >= 2) strata.push("discounted");
  if (probe.priceCount === 1) strata.push("undiscounted");
  // priceCount 0 or undefined is neither: a page with nothing to compare cannot
  // stand for "a discount is visible" or for "there is no discount". It is
  // still a shape, so it can still be picked for coverage.
  const declared = probe.hasDeclaredProduct === true ? "declared" : "declared?";
  return {
    url,
    strata,
    signature: `live:${stockBand(probe.inStock)}:${priceBand(probe.priceCount)}:${declared}`,
    note: `answers ${status}, ${stockBand(probe.inStock)}, ${priceBand(probe.priceCount)}`,
  };
}

// ----------------------------------------------------------------- choosing

export interface SamplePick {
  url: string;
  /** Which stratum this URL is in the sample for, or `coverage` for a fill slot. */
  stratum: PickReason;
  /** Why this URL and not another. The compile input has to be explicable. */
  because: string;
  probe: UrlProbe;
}

export interface UnfilledStratum {
  stratum: Stratum;
  /** What the catalogue (or the size) said about why it could not be filled. */
  because: string;
}

export interface ExcludedProbe {
  url: string;
  reason: ExcludedReason;
  because: string;
}

export interface SampleChoice {
  picks: SamplePick[];
  /**
   * Strata no URL could stand for. Not a failure: a list with nothing out of
   * stock is a statement about the catalogue (or about the probe run), and it
   * is the statement the compile rationale has to carry, because it names
   * exactly what the resulting scraper was never tested against.
   */
  unfilled: UnfilledStratum[];
  /** Probes that are not compile input — refused or transient. See `classify`. */
  excluded: ExcludedProbe[];
  /** How many distinct URLs were considered, after duplicates were dropped. */
  considered: number;
  /** One line naming what the sample spans. This is the thing that replaces "lines 2-5". */
  because: string;
}

export interface ChooseOptions {
  /** How many URLs to build the compile from. Four strata plus one shape. */
  size?: number;
}

const DEFAULT_SIZE = 5;

function share(n: number, total: number): string {
  return `${n} of ${total}`;
}

/**
 * Pick the handful of URLs a compile should be built from.
 *
 * Deterministic by construction: no `Math.random`, no dependence on input
 * order. Every comparison ends in a lexicographic tiebreak on the signature and
 * then the URL, so the same probes in any order yield the same sample — which
 * matters because a compile input that cannot be regenerated cannot be audited,
 * and auditing it is the whole point of not writing "lines 2-5".
 */
export function chooseSample(probes: readonly UrlProbe[], options: ChooseOptions = {}): SampleChoice {
  const size = options.size ?? DEFAULT_SIZE;

  // Never pad with duplicates: the same URL twice teaches the compile nothing
  // twice, and a five-URL sample holding three copies of one page is the
  // narrow sample again with a bigger number on it.
  const unique = new Map<string, UrlProbe>();
  for (const probe of probes) if (!unique.has(probe.url)) unique.set(probe.url, probe);

  const classified = [...unique.values()].map((probe) => ({ probe, ...classify(probe) }));
  const excluded: ExcludedProbe[] = classified
    .filter((entry) => entry.excluded !== undefined)
    .map((entry) => ({ url: entry.url, reason: entry.excluded!.reason, because: entry.excluded!.because }))
    .sort((a, b) => a.url.localeCompare(b.url));

  const pool = classified.filter((entry) => entry.excluded === undefined);
  const total = pool.length;

  const frequency = new Map<string, number>();
  for (const entry of pool) frequency.set(entry.signature, (frequency.get(entry.signature) ?? 0) + 1);
  const freq = (signature: string): number => frequency.get(signature) ?? 0;

  const count = (stratum: Stratum): number => pool.filter((entry) => entry.strata.includes(stratum)).length;

  const picks: SamplePick[] = [];
  const unfilled: UnfilledStratum[] = [];
  const taken = new Set<string>();

  for (const [index, stratum] of STRATA.entries()) {
    if (picks.length >= size) {
      unfilled.push({ stratum, because: `size ${size} was filled before this stratum was reached; ${STRATUM_RATIONALE[stratum]}` });
      continue;
    }
    const candidates = pool.filter((entry) => !taken.has(entry.url) && entry.strata.includes(stratum));
    if (candidates.length === 0) {
      const present = count(stratum);
      unfilled.push({
        stratum,
        because:
          present === 0
            ? `no URL of the ${total} probed is ${stratum} — ${STRATUM_RATIONALE[stratum]}, so the compile is untested there`
            : `every ${stratum} URL was already picked for an earlier stratum; ${STRATUM_RATIONALE[stratum]}`,
      });
      continue;
    }

    /**
     * Prefer a candidate that is not also the scarce representative of a
     * stratum still to come. An out-of-stock page that happens to be the list's
     * only discounted one would otherwise be spent on the stock slot and leave
     * `discounted` unfillable — the sample shrinking itself.
     */
    const later = new Set(STRATA.slice(index + 1));
    const contested = (entry: (typeof pool)[number]): number => entry.strata.filter((other) => other !== stratum && later.has(other)).length;

    const best = [...candidates].sort(
      (a, b) =>
        contested(a) - contested(b) ||
        // Then the majority form of this stratum: parity means reproducing what
        // the catalogue actually does, and on StoreA what it does is 302.
        freq(b.signature) - freq(a.signature) ||
        a.signature.localeCompare(b.signature) ||
        a.url.localeCompare(b.url),
    )[0]!;

    taken.add(best.url);
    picks.push({
      url: best.url,
      stratum,
      because: `${stratum}: ${best.note} (${share(freq(best.signature), total)} probed URLs share this shape)`,
      probe: best.probe,
    });
  }

  // Remaining slots go to the most different URL still unpicked: the shape that
  // no pick covers yet, and among those the one the catalogue holds most of.
  while (picks.length < size) {
    const covered = new Map<string, number>();
    for (const pick of picks) {
      const signature = classified.find((entry) => entry.url === pick.url)!.signature;
      covered.set(signature, (covered.get(signature) ?? 0) + 1);
    }
    const remaining = pool.filter((entry) => !taken.has(entry.url));
    if (remaining.length === 0) break;
    const next = [...remaining].sort(
      (a, b) =>
        (covered.get(a.signature) ?? 0) - (covered.get(b.signature) ?? 0) ||
        freq(b.signature) - freq(a.signature) ||
        a.signature.localeCompare(b.signature) ||
        a.url.localeCompare(b.url),
    )[0]!;
    taken.add(next.url);
    const seen = covered.get(next.signature) ?? 0;
    picks.push({
      url: next.url,
      stratum: "coverage",
      because:
        seen === 0
          ? `coverage: ${next.note} — a shape no other pick covers (${share(freq(next.signature), total)} probed URLs share it)`
          : `coverage: ${next.note} — the widest shape still unpicked (${share(freq(next.signature), total)} probed URLs share it)`,
      probe: next.probe,
    });
  }

  const spanned = [...new Set(picks.map((pick) => pick.stratum))];
  const missing = unfilled.map((entry) => entry.stratum);
  const because = [
    `${picks.length} of ${unique.size} URLs, chosen to span ${spanned.join(", ") || "nothing — no URL was usable"}`,
    missing.length > 0 ? `no URL available for ${missing.join(", ")}` : undefined,
    excluded.length > 0 ? `${excluded.length} probe(s) excluded as blocked or transient` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");

  return { picks, unfilled, excluded, considered: unique.size, because };
}

// ----------------------------------------------------------------- binding

/**
 * Whether a pick may be compared against the other picks.
 *
 * `bind: false` never means "drop this URL". It is fetched, it is rendered, it
 * is recorded as a source and it may still be the page tier 2 binds from. What
 * it is kept out of is the *comparison* — the "present on every sample"
 * intersection that tier 1's `bindRole` and `bind.ts`'s `narrow` both are.
 */
export interface Bindable {
  bind: boolean;
  /** Why, in the words the manuscript prints. */
  because: string;
}

/**
 * The shell set as it stands before a single byte has been fetched: empty, and
 * honestly so. See `bindable` for why this is a parameter at all.
 */
export const NO_SHELLS_YET: ReadonlySet<string> = new Set<string>();

/**
 * One answer to "does this pick belong in a comparison set", asked once.
 *
 * Before 2026-09-23 the question was asked three times in `investigate.ts` with
 * three different filters: dead-only when recording `bound`, **no filter at
 * all** when building tier 1's declared samples, and shells-only when picking
 * the canary — the same set, the same function, twenty lines apart, two of them
 * disagreeing. The middle one was the defect: one JS shell among N real pages
 * contributes an empty declaration list, `bindRole` opens with "every sample
 * must declare this role", and tier 1 therefore bound *nothing* on a site the
 * cascade had just deliberately decided was worth the cheapest request. It is
 * the fourth instance of one cause — a rule correct in its own encounter,
 * contradicting another rule at a seam — and the first with a test.
 *
 * Two exclusions, and they are known at different moments, which is why one is
 * read off the pick and the other is handed in:
 *
 *  - **dead** is a fact about the probe. `classify` owns it and this function
 *    does not get a second opinion. A dead pick belongs in the sample — 73% of
 *    client's StoreA URLs 302 away, and reproducing a blank is what parity
 *    means — but it declares nothing, and a sample that declares nothing does
 *    not merely fail to contribute: it deletes every candidate for every field.
 *  - **shell** cannot be known until the plain fetch has happened, because it
 *    is a property of the bytes that came back, not of the probe.
 *    `shell-skips-tier-1` is the detector and `investigate.ts` runs it. So the
 *    caller hands in what it knows so far, and `NO_SHELLS_YET` is what that is
 *    before the fetch. The asymmetry is real; hiding it behind a field on the
 *    pick would only mean storing an answer nobody had yet.
 */
export function bindable(pick: SamplePick, shells: ReadonlySet<string> = NO_SHELLS_YET): Bindable {
  const reading = classify(pick.probe);
  if (reading.strata.includes("dead")) {
    return {
      bind: false,
      because: `dead (${reading.note}): in the sample because reproducing a blank is parity, out of every comparison because a page that declares nothing deletes every candidate for every field`,
    };
  }
  if (shells.has(pick.url)) {
    return {
      bind: false,
      because:
        "a JS shell: the content arrives later, so there is nothing here for the other samples to agree with — it is still fetched, still rendered, and still where tier 2 binds from",
    };
  }
  return { bind: true, because: `${reading.note}: a page that was served, so what it declares can be compared with what the others declare` };
}
