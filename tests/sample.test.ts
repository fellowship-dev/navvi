import { describe, expect, it } from "vitest";
import { STRATA, bindable, chooseSample, classify, type Stratum, type UrlProbe } from "../src/investigate/sample.js";

/**
 * U2d: the compile sample chooser.
 *
 * The thing under test is the replacement for a line in a committed compile
 * input that reads "lines 2-5 of the Store B list". The catalogue below is
 * synthetic — navvi is a public repository and a client's URL list is not test
 * data — but the *mix* is the one measured on 2026-09-22: a fifth of the list
 * no longer resolving, a handful out of stock, and a large majority carrying a
 * visible discount, with the top of the list uniform because catalogues are
 * ordered by category and a slice off the top sees one shape.
 */

const HOST = "https://farmacia.example";

type Kind = "discounted" | "undiscounted" | "out-of-stock" | "out-of-stock-no-price" | "redirect" | "gone" | "no-product" | "blocked" | "unanswered" | "server-error";

/** Counts, stated once so the fixture's shape is readable rather than implied. */
const MIX: Array<[Kind, number]> = [
  ["discounted", 61],
  ["undiscounted", 15],
  ["out-of-stock", 4],
  ["out-of-stock-no-price", 2],
  ["redirect", 14],
  ["gone", 5],
  ["no-product", 3],
  ["blocked", 2],
  ["unanswered", 1],
  ["server-error", 1],
];

/** Deterministic, so the fixture is the same list on every run and on every machine. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function probeOf(kind: Kind, url: string): UrlProbe {
  switch (kind) {
    case "discounted":
      return { url, status: 200, hasDeclaredProduct: true, priceCount: 2, inStock: true };
    case "undiscounted":
      return { url, status: 200, hasDeclaredProduct: true, priceCount: 1, inStock: true };
    case "out-of-stock":
      return { url, status: 200, hasDeclaredProduct: true, priceCount: 1, inStock: false };
    case "out-of-stock-no-price":
      // The silent one: nothing for sale, so the price node is not rendered at all.
      return { url, status: 200, hasDeclaredProduct: true, priceCount: 0, inStock: false };
    case "redirect":
      return { url, status: 200, redirectedTo: `${HOST}/categoria/medicamentos`, hasDeclaredProduct: false, isShell: false };
    case "gone":
      return { url, status: 404 };
    case "no-product":
      // StoreA's shape: a 200 that declares Organization and no Product.
      return { url, status: 200, hasDeclaredProduct: false, isShell: false };
    case "blocked":
      return { url, status: 403 };
    case "unanswered":
      return { url, status: 0 };
    case "server-error":
      return { url, status: 503 };
  }
}

/**
 * 108 URLs. The first twelve are all discounted and in stock, which is the
 * whole point: "lines 2-5" of this list sees exactly one shape. Slugs are
 * drawn from the same seeded stream as the shuffle so lexicographic order is
 * uncorrelated with position — a real list is not sorted by the chooser's
 * tiebreak.
 */
function catalogue(): UrlProbe[] {
  const rand = lcg(2026_09_22);
  const slugs = new Set<string>();
  const slug = (): string => {
    for (;;) {
      const candidate = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0");
      if (!slugs.has(candidate)) {
        slugs.add(candidate);
        return candidate;
      }
    }
  };

  const kinds: Kind[] = [];
  for (const [kind, n] of MIX) for (let i = 0; i < n; i++) kinds.push(kind);

  // Twelve uniform entries off the top, then everything else scattered.
  const head: Kind[] = [];
  for (let i = 0; i < 12; i++) head.push(kinds.splice(kinds.indexOf("discounted"), 1)[0]!);
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
  }

  return [...head, ...kinds].map((kind) => probeOf(kind, `${HOST}/producto/${slug()}`));
}

const shapeOf = (url: string, probes: readonly UrlProbe[]): string => classify(probes.find((probe) => probe.url === url)!).signature;

describe("classify", () => {
  it("separates a dead URL from a refused one, which is the difference between parity and a lie", () => {
    // 403 is the blocked state, not a gone product. Compiling a blank from it
    // teaches the scraper to write an empty row every time it is turned away.
    expect(classify({ url: `${HOST}/a`, status: 403 }).excluded?.reason).toBe("blocked");
    expect(classify({ url: `${HOST}/a`, status: 429 }).excluded?.reason).toBe("blocked");
    expect(classify({ url: `${HOST}/a`, status: 503 }).excluded?.reason).toBe("transient");
    expect(classify({ url: `${HOST}/a`, status: 0 }).excluded?.reason).toBe("transient");
    expect(classify({ url: `${HOST}/a`, status: 404 }).strata).toEqual(["dead"]);
    expect(classify({ url: `${HOST}/a`, status: 403 }).strata).toEqual([]);
  });

  it("reads a 302 away from the product page as dead, and a cosmetic redirect as alive", () => {
    const moved = classify({ url: `${HOST}/producto/x`, status: 200, redirectedTo: `${HOST}/categoria/medicamentos` });
    expect(moved.strata).toEqual(["dead"]);
    expect(moved.signature).toBe("dead:redirect");
    // A tracking query or a trailing slash still landed on the product page.
    const same = classify({ url: `${HOST}/producto/x`, status: 200, redirectedTo: `${HOST}/producto/x/?srsltid=abc`, priceCount: 2, inStock: true });
    expect(same.strata).toEqual(["discounted"]);
    // Relative redirects resolve against the URL rather than being read as a move.
    expect(classify({ url: `${HOST}/producto/x`, status: 200, redirectedTo: "/producto/x", priceCount: 1, inStock: true }).strata).toEqual(["undiscounted"]);
  });

  it("reads a 200 with no declared Product as dead, because it is the same blank in a different coat", () => {
    const entry = classify({ url: `${HOST}/producto/x`, status: 200, hasDeclaredProduct: false, isShell: false });
    expect(entry.strata).toEqual(["dead"]);
    expect(entry.signature).toBe("dead:no-product");
  });

  it("does not read an absent field as a negative one", () => {
    // inStock undefined means the probe did not look; it is not out of stock.
    const unknown = classify({ url: `${HOST}/producto/x`, status: 200, hasDeclaredProduct: true });
    expect(unknown.strata).toEqual([]);
    expect(unknown.excluded).toBeUndefined();
    // A page with no price at all cannot stand for "a discount is visible" or for its opposite.
    expect(classify({ url: `${HOST}/producto/x`, status: 200, priceCount: 0, inStock: true }).strata).toEqual([]);
  });
});

describe("chooseSample over a 108-URL catalogue", () => {
  const probes = catalogue();

  it("builds the list the mix says it does", () => {
    expect(probes).toHaveLength(108);
    expect(new Set(probes.map((probe) => probe.url)).size).toBe(108);
  });

  it("spans discounted, undiscounted, out of stock and dead, rather than taking a slice", () => {
    const choice = chooseSample(probes);
    expect(choice.picks).toHaveLength(5);
    expect(choice.picks.map((pick) => pick.stratum)).toEqual([...STRATA, "coverage"]);
    expect(choice.unfilled).toEqual([]);
    expect(choice.considered).toBe(108);
    // Five URLs, five different observable shapes.
    expect(new Set(choice.picks.map((pick) => shapeOf(pick.url, probes))).size).toBe(5);
    // Every pick says why it is in the sample; none of them says "line 2".
    for (const pick of choice.picks) expect(pick.because.length).toBeGreaterThan(20);
    expect(choice.because).toContain("dead, out-of-stock, discounted, undiscounted");
  });

  it("beats the slice it replaces on the same list", () => {
    // "lines 2-5 of the Store B list", literally: four URLs off the top.
    const slice = chooseSample(probes.slice(1, 5), { size: 4 });
    expect(new Set(slice.picks.map((pick) => shapeOf(pick.url, probes))).size).toBe(1);
    expect(slice.unfilled.map((entry) => entry.stratum)).toEqual(["dead", "out-of-stock", "undiscounted"]);
    // And it says so, instead of looking like a sample.
    expect(slice.because).toContain("no URL available for dead, out-of-stock, undiscounted");
  });

  it("picks the majority form of deadness, because parity is reproducing what the catalogue does", () => {
    const choice = chooseSample(probes);
    const dead = choice.picks.find((pick) => pick.stratum === "dead")!;
    // 14 redirects against 5 gone and 3 undeclared: the redirect is the shape
    // the scraper will meet, and the one legacy silently wrote a blank for.
    expect(shapeOf(dead.url, probes)).toBe("dead:redirect");
    expect(dead.because).toContain("14 of 104");
  });

  it("spends the out-of-stock slot on the page that shows no price at all", () => {
    const choice = chooseSample(probes);
    const oos = choice.picks.find((pick) => pick.stratum === "out-of-stock")!;
    // Two of the six out-of-stock pages render no price node; four also carry a
    // single price and could stand for `undiscounted`. Taking one of those
    // would spend a stratum that is still to come, so the no-price page wins —
    // and it is the shape a binding has never seen its own absence in.
    expect(oos.probe.priceCount).toBe(0);
  });

  it("is deterministic: the same probes in any order give the same sample", () => {
    const forward = chooseSample(probes).picks.map((pick) => pick.url);
    const backward = chooseSample([...probes].reverse()).picks.map((pick) => pick.url);
    expect(new Set(backward)).toEqual(new Set(forward));
    expect(chooseSample(probes).picks.map((pick) => pick.url)).toEqual(forward);
  });

  it("reports the refused and transient probes instead of compiling blanks from them", () => {
    const choice = chooseSample(probes);
    expect(choice.excluded).toHaveLength(4);
    expect(choice.excluded.filter((entry) => entry.reason === "blocked")).toHaveLength(2);
    expect(choice.excluded.filter((entry) => entry.reason === "transient")).toHaveLength(2);
    expect(choice.picks.map((pick) => pick.probe.status)).not.toContain(403);
  });

  it("widens the sample when asked for more, without repeating a URL", () => {
    const choice = chooseSample(probes, { size: 8 });
    expect(choice.picks).toHaveLength(8);
    expect(new Set(choice.picks.map((pick) => pick.url)).size).toBe(8);
    // The extra slots go to shapes, so every distinct shape in the list is in.
    const shapes = new Set(probes.map((probe) => classify(probe).signature));
    shapes.delete("excluded:blocked");
    shapes.delete("excluded:transient");
    expect(new Set(choice.picks.map((pick) => shapeOf(pick.url, probes)))).toEqual(shapes);
  });

  it("names the strata a small size left out, rather than silently dropping them", () => {
    const choice = chooseSample(probes, { size: 2 });
    expect(choice.picks.map((pick) => pick.stratum)).toEqual(["dead", "out-of-stock"]);
    expect(choice.unfilled.map((entry) => entry.stratum)).toEqual(["discounted", "undiscounted"]);
    for (const entry of choice.unfilled) expect(entry.because).toContain("size 2 was filled");
  });
});

describe("chooseSample — the degenerate catalogues, answered honestly", () => {
  const live = (url: string, priceCount: number, inStock = true): UrlProbe => ({ url, status: 200, hasDeclaredProduct: true, priceCount, inStock });

  it("says a list with nothing dead is untested there, and spends the slot on a shape", () => {
    const probes = [live("a", 2), live("b", 2), live("c", 1), live("d", 1, false), live("e", 0)];
    const choice = chooseSample(probes);
    expect(choice.unfilled.map((entry) => entry.stratum)).toEqual(["dead"]);
    expect(choice.unfilled[0]!.because).toContain("no URL of the 5 probed is dead");
    expect(choice.unfilled[0]!.because).toContain("reproducing a blank is parity");
    expect(choice.picks.map((pick) => pick.stratum)).toEqual(["out-of-stock", "discounted", "undiscounted", "coverage", "coverage"]);
    expect(new Set(choice.picks.map((pick) => pick.url)).size).toBe(5);
  });

  it("says a list that is entirely dead has nothing to bind against", () => {
    const probes: UrlProbe[] = [
      { url: "a", status: 404 },
      { url: "b", status: 404 },
      { url: "c", status: 200, redirectedTo: "https://farmacia.example/categoria/x" },
      { url: "d", status: 200, hasDeclaredProduct: false, isShell: false },
    ];
    const choice = chooseSample(probes);
    expect(choice.unfilled.map((entry) => entry.stratum)).toEqual(["out-of-stock", "discounted", "undiscounted"]);
    expect(choice.picks[0]!.stratum).toBe("dead");
    // The fill still widens across the forms of deadness rather than repeating one.
    expect(choice.picks).toHaveLength(4);
    expect(new Set(choice.picks.map((pick) => pick.url)).size).toBe(4);
    expect(new Set(choice.picks.map((pick) => shapeOf(pick.url, probes))).size).toBe(3);
  });

  it("never pads a short list with duplicates", () => {
    const probes = [live("a", 2), live("b", 1)];
    const choice = chooseSample(probes, { size: 5 });
    expect(choice.picks.map((pick) => pick.url)).toEqual(["a", "b"]);
    expect(choice.unfilled.map((entry) => entry.stratum)).toEqual(["dead", "out-of-stock"]);
  });

  it("drops a URL repeated in the probe list rather than sampling it twice", () => {
    const probes = [live("a", 2), live("a", 2), live("a", 2), live("b", 1)];
    const choice = chooseSample(probes, { size: 4 });
    expect(choice.considered).toBe(2);
    expect(choice.picks.map((pick) => pick.url)).toEqual(["a", "b"]);
  });

  it("does not spend a stratum's only representative on an earlier stratum", () => {
    // `scarce` is the list's only discounted page and is also out of stock.
    const probes: UrlProbe[] = [live("scarce", 2, false), live("plain-oos", 1, false), live("plain", 1)];
    const choice = chooseSample(probes, { size: 3 });
    const byStratum = new Map(choice.picks.map((pick) => [pick.stratum, pick.url]));
    expect(byStratum.get("out-of-stock")).toBe("plain-oos");
    expect(byStratum.get("discounted")).toBe("scarce");
    // Only `dead` goes unfilled, and it is unfilled because the list holds none.
    expect(choice.unfilled.map((entry) => entry.stratum)).toEqual(["dead"]);
  });

  it("returns an empty sample rather than an invented one", () => {
    expect(chooseSample([]).picks).toEqual([]);
    expect(chooseSample([]).unfilled.map((entry) => entry.stratum)).toEqual([...STRATA] as Stratum[]);
    expect(chooseSample([{ url: "a", status: 403 }]).picks).toEqual([]);
    expect(chooseSample([{ url: "a", status: 403 }]).excluded[0]!.reason).toBe("blocked");
  });
  it("a shell is not a dead URL, however little it declares", () => {
    // The first live run of the cascade: every Store B URL came back a 200
    // with 2,863 characters and no declared Product, was classified dead, was
    // dropped from the binding set, and the investigation read nothing at all.
    // Both units' own tests passed throughout, because each was written against
    // its own fixture.
    const shell = classify({ url: `${HOST}/producto/x`, status: 200, hasDeclaredProduct: false, isShell: true });
    expect(shell.strata).not.toContain("dead");
    expect(shell.excluded).toBeUndefined();

    // A real page that declares nothing is still dead -- the StoreA case.
    const served = classify({ url: `${HOST}/producto/y`, status: 200, hasDeclaredProduct: false, isShell: false });
    expect(served.strata).toContain("dead");
    expect(served.signature).toBe("dead:no-product");

    // Unknown shell state may not fire the rule: absent is not false.
    const unsure = classify({ url: `${HOST}/producto/z`, status: 200, hasDeclaredProduct: false });
    expect(unsure.strata).not.toContain("dead");
  });

  it("keeps a shell catalogue bindable end to end", () => {
    // Store B in miniature: every URL a shell, none declaring a Product.
    const probes = Array.from({ length: 8 }, (_, i) => ({
      url: `${HOST}/producto/${i}`,
      status: 200,
      hasDeclaredProduct: false,
      isShell: true,
      priceCount: i % 2 === 0 ? 2 : 1,
      inStock: i !== 3,
    }));
    const choice = chooseSample(probes, { size: 4 });
    expect(choice.picks.length).toBe(4);
    // `bindable` is where "may this pick be compared against the others" is
    // written; a test that spells the rule out again is a second copy that
    // drifts silently, which is what `second-spelling.test.ts` exists to forbid.
    expect(choice.picks.every((pick) => bindable(pick).bind)).toBe(true);
  });
});
