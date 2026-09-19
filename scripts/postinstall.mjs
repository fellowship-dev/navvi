// Fetch the Camoufox browser when it is the selected browser. Skipped on
// CI and on the Apify platform, where the image ships its own browser.
const browser = process.env.NAVVI_BROWSER ?? "camoufox";
const skip = process.env.CI || process.env.APIFY_IS_AT_HOME || process.env.NAVVI_SKIP_BROWSER_DOWNLOAD;
if (browser !== "camoufox" || skip) {
  process.exit(0);
}
try {
  const { execSync } = await import("node:child_process");
  execSync("npx camoufox-js fetch", { stdio: "inherit" });
} catch (error) {
  console.warn("[navvi] Camoufox download failed; set NAVVI_BROWSER=chromium or retry with `npx camoufox-js fetch`.");
}
