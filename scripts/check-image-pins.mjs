// Fails when the Playwright version in package.json and the Apify image tags
// in the Dockerfiles disagree (KTD4: one package.json, two Dockerfiles, one
// Playwright pin; the Camoufox image tops out at the pinned version).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pin = pkg.dependencies?.playwright;
if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) {
  console.error(`check-image-pins: package.json must pin playwright to an exact version, got ${JSON.stringify(pin)}`);
  process.exit(1);
}

const dockerfiles = ["Dockerfile", "Dockerfile.camoufox"].map((name) => join(root, ".actor", name));
const FROM = /^FROM\s+apify\/actor-node-playwright-(chrome|camoufox):(\d+)-(\d+\.\d+\.\d+)(?:-[a-z-]+)?@sha256:[0-9a-f]{64}\s*$/m;
let failed = false;
for (const file of dockerfiles) {
  const text = readFileSync(file, "utf8");
  const match = FROM.exec(text);
  if (!match) {
    console.error(`check-image-pins: ${file}: no digest-pinned FROM apify/actor-node-playwright-<browser>:<node>-<playwright>@sha256:... line`);
    failed = true;
    continue;
  }
  const [, browser, node, playwright] = match;
  if (playwright !== pin) {
    console.error(`check-image-pins: ${file}: image tag carries Playwright ${playwright}, package.json pins ${pin}`);
    failed = true;
  } else {
    console.log(`check-image-pins: ${file}: ${browser} image on Node ${node}, Playwright ${playwright} matches package.json`);
  }
}
process.exit(failed ? 1 : 0);
