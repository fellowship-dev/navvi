// Copies the non-TypeScript assets the compiled code reads next to itself.
// snapshot.inject.js is evaluated in the page as text (src/browser/snapshot.ts
// reads it relative to import.meta.url), so it must sit under dist/ verbatim:
// tsc would append `export {};` and a source map comment, which are not valid
// inside `page.evaluate`.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = ["src/browser/snapshot.inject.js"];

for (const rel of assets) {
  const target = join(root, "dist", rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, rel), target);
}
