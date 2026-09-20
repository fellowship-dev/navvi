// Pushes the private beta builds to Apify (U4). Default: the Chromium image
// under the `beta` tag from .actor/actor.json. With --camoufox the manifest is
// rewritten for the push only (Dockerfile.camoufox, tag beta-camoufox,
// NAVVI_BROWSER=camoufox) and restored afterwards, so one actor version
// carries both builds under two tags. Needs `apify login` (Max's account).
//
//   node scripts/push-beta.mjs              # Chromium, tag beta
//   node scripts/push-beta.mjs --camoufox   # Camoufox, tag beta-camoufox
//   node scripts/push-beta.mjs --dry-run    # print the manifest and the command
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, ".actor", "actor.json");
const camoufox = process.argv.includes("--camoufox");
const dryRun = process.argv.includes("--dry-run");

const original = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(original);
const tag = camoufox ? "beta-camoufox" : manifest.buildTag;
if (camoufox) {
  manifest.dockerfile = "./Dockerfile.camoufox";
  manifest.buildTag = tag;
  manifest.environmentVariables = { ...manifest.environmentVariables, NAVVI_BROWSER: "camoufox" };
}

const pinCheck = spawnSync(process.execPath, [join(root, "scripts", "check-image-pins.mjs")], { stdio: "inherit" });
if (pinCheck.status !== 0) process.exit(pinCheck.status ?? 1);

const args = ["apify-cli", "push", "--build-tag", tag, "--wait-for-finish", "1800"];
if (dryRun) {
  console.log(JSON.stringify(manifest, null, 2));
  console.log(`npx ${args.join(" ")}`);
  process.exit(0);
}

try {
  if (camoufox) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const push = spawnSync("npx", args, { cwd: root, stdio: "inherit", env: { ...process.env, APIFY_CLI_DISABLE_TELEMETRY: "1" } });
  process.exitCode = push.status ?? 1;
} finally {
  if (camoufox) writeFileSync(manifestPath, original);
}
