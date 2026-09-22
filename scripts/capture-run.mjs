// Tier 2 end to end: render each URL, read the payload the page fetches for
// itself, and write rows in the Navvi dataset shape.
//
//   node scripts/capture-run.mjs --urls list.txt --match catalog-svc/products/detail \
//     --field productName=productData.name --field listPrice='productData.prices[price-list-std]' \
//     --out rows.json [--concurrency 3] [--limit 40]
//
// Nothing here authenticates. The page signs itself in as it always does and
// the capture watches; Store B's detail endpoint answers 401 to a bare
// request and 200 to the page's own.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { captureJson, extractCaptured } from "../dist/src/browser/network-capture.js";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const fields = {};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== "--field") continue;
  const [k, ...rest] = argv[i + 1].split("=");
  fields[k] = rest.join("=");
}

const urls = readFileSync(arg("urls"), "utf8").split("\n").map((u) => u.trim()).filter(Boolean);
const limit = Number(arg("limit", 0));
const targets = limit > 0 ? urls.slice(0, limit) : urls;
const match = arg("match");
const concurrency = Number(arg("concurrency", 3));
const out = arg("out", "rows.json");

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
});

const rows = new Array(targets.length);
let next = 0;
let done = 0;

async function worker() {
  const page = await ctx.newPage();
  for (;;) {
    const i = next++;
    if (i >= targets.length) break;
    const url = targets[i];
    const { responses } = captureJson(page, { match });
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      const got = extractCaptured(responses, fields);
      rows[i] = { _source: url, url, ...got };
    } catch (error) {
      rows[i] = { _source: url, url, error: String(error.message).slice(0, 120) };
    }
    responses.length = 0;
    done += 1;
    if (done % 10 === 0) console.error(`  ${done}/${targets.length}`);
  }
  await page.close();
}

const started = Date.now();
await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
await browser.close();

writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
const withData = rows.filter((r) => r && r.productName).length;
console.error(`${targets.length} pages in ${((Date.now() - started) / 1000).toFixed(1)}s; ${withData} carried a product -> ${out}`);
