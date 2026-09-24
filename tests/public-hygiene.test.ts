import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * navvi is a public repository, and a client's name, catalogue or captured
 * pages are not test data. The fixtures that came out of a real engagement were
 * re-synthesized as "Store A", "Store B" and "Store C" on example domains; this
 * test is what keeps them that way. It reads every file git would commit —
 * tracked, plus untracked files that are not ignored, so a fixture is caught
 * before its first commit — and fails naming file:line for any denylisted term.
 *
 * The denylist lives here and nowhere else. Every term is stored reversed, so
 * this file does not match itself, `git grep` on the tree stays at zero hits,
 * and a history rewrite that replaces the literal terms cannot mangle it. The
 * file is excluded from its own scan anyway, in case a future term reverses
 * into another.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SELF = "tests/public-hygiene.test.ts";

const unreverse = (reversed: string): string => [...reversed].reverse().join("");

/** Names, matched case-insensitively and across any spacing or separator. */
const NAMES: readonly (readonly string[])[] = [
  ["zurc", "edrev"],
  ["dnarboclas"],
  ["adamuha"],
  ["sepalc"],
  ["cpi", "dem"],
  ["niripassah"],
];

/** Literals, matched exactly: identifiers, endpoint paths and keys a capture carried. */
const LITERALS: readonly string[] = [
  "liated/stcudorp/ecivres-tcudorp",
  "yrotnevni/ecivres-kcots",
  "lc-tsil-ecirp",
  "lc-elas-ecirp",
  "9111anoZ",
];

/** Real product identifiers, matched with no digit on either side. */
const NUMBERS: readonly string[] = ["033092", "629103", "966462", "7320271", "8320271", "250371", "990371"];

/** The client's acronym, matched as an upper-case word. */
const WORDS: readonly string[] = ["CPI"];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

const DENYLIST: readonly RegExp[] = [
  ...NAMES.map((parts) => new RegExp(parts.map((part) => escape(unreverse(part))).join("[\\s_.-]?"), "i")),
  ...LITERALS.map((literal) => new RegExp(escape(unreverse(literal)))),
  ...NUMBERS.map((digits) => new RegExp(`(?<!\\d)${unreverse(digits)}(?!\\d)`)),
  ...WORDS.map((word) => new RegExp(`\\b${unreverse(word)}\\b`)),
];

/** Every path git would commit: tracked, plus untracked and not ignored. */
function committable(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.toString("utf8").split("\0").filter(Boolean))];
}

/** Each denylisted hit as `file:line: term`, over the given paths. */
function hygieneHits(paths: readonly string[], root: string = ROOT): string[] {
  const hits: string[] = [];
  for (const path of paths) {
    if (path === SELF) continue;
    // A path deleted from the working tree is not what the next commit carries.
    const file = join(root, path);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    for (const pattern of DENYLIST) {
      if (pattern.test(path)) hits.push(`${path}: (path) ${pattern.source}`);
    }
    const bytes = readFileSync(file);
    if (bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").split("\n");
    lines.forEach((line, index) => {
      for (const pattern of DENYLIST) {
        if (pattern.test(line)) hits.push(`${path}:${index + 1}: ${pattern.source}`);
      }
    });
  }
  return hits;
}

describe("public hygiene", () => {
  it("no committable file names a client, its stores or their captured identifiers", () => {
    const paths = committable();
    expect(paths.length).toBeGreaterThan(100);
    expect(hygieneHits(paths)).toEqual([]);
  });

  it("the denylist fires on each term it carries, and not on the neutral mapping", () => {
    const samples = [
      unreverse("edrev zurC"),
      unreverse("edrevzurc"),
      unreverse("edrev-zurc"),
      unreverse("DNARBOCLAS"),
      unreverse("lc.adamuhasaicamraf"),
      unreverse("dem-cpi"),
      `the ${unreverse("CPI")} plan`,
      `/p/${unreverse("250371")}.html`,
      unreverse("liated/stcudorp/ecivres-tcudorp"),
    ];
    for (const sample of samples) {
      expect(DENYLIST.some((pattern) => pattern.test(sample)), sample).toBe(true);
    }
    for (const clean of ["Store A", "store-b.example", "the client plan", "/p/883052.html", "catalog-svc/products/detail", "ipcRenderer"]) {
      expect(DENYLIST.some((pattern) => pattern.test(clean)), clean).toBe(false);
    }
  });
});
