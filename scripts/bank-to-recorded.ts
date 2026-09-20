import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBank } from "../src/measure/bank.js";
import type { RecordedAnswerFile } from "../src/chooser/recorded.js";

/**
 * Turns a reviewed bank scenario into a recorded fixture for the agent replay:
 *   npx tsx scripts/bank-to-recorded.ts F1-search flows/search
 * Each bank entry's gold answer becomes tests/recorded/<fixture>/<id>.json.
 * Review the bank first (docs/measurements.md, honesty notes): the gold is
 * whatever chooser produced the bank, checked by the host agent.
 */
const [scenario, fixture] = process.argv.slice(2);
if (!scenario || !fixture) {
  process.stderr.write("usage: tsx scripts/bank-to-recorded.ts <scenario> <fixture>\n");
  process.exit(2);
}
const batches = loadBank(undefined, [scenario]);
if (batches.length === 0) {
  process.stderr.write(`no bank for ${scenario}\n`);
  process.exit(1);
}
const dir = join("tests", "recorded", fixture);
mkdirSync(dir, { recursive: true });
let n = 0;
for (const batch of batches) {
  for (const entry of batch.entries) {
    const file: RecordedAnswerFile = { id: entry.question.id, kind: entry.question.kind, index: entry.gold, inputTokens: 0, outputTokens: 0, chooser: "agent" };
    if (entry.goldText !== undefined) file.text = entry.goldText;
    writeFileSync(join(dir, `${entry.question.id}.json`), JSON.stringify(file, null, 2) + "\n");
    n += 1;
  }
}
process.stdout.write(`${n} answers written to ${dir}\n`);
