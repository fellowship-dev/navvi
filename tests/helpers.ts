import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Actor } from "apify";
import { MemoryStorage } from "crawlee";
import type { Answer, Chooser, ChooserUsage, Question } from "../src/chooser/chooser.js";
import { RecordedChooser } from "../src/chooser/recorded.js";
import { parseInput, type RunInput } from "../src/input/schema.js";
import type { CrawlDeps } from "../src/replay/crawler.js";

/** Shared crawler-test helpers, used by billing.test.ts, crawler.test.ts and typed-fields.test.ts. */

/** One isolated Actor per test: in-memory storage, nothing under ./storage. */
export function makeActor(dir: string): Actor {
  return new Actor({ storageClient: new MemoryStorage({ localDataDirectory: mkdtempSync(join(dir, "storage-")), persistStorage: false }) });
}

export function makeDeps(dir: string, actor: CrawlDeps["actor"], chooser: Chooser, over: Partial<CrawlDeps> = {}): CrawlDeps {
  return { actor, chooser, env: {}, storageDir: join(dir, "st"), attended: false, maxConcurrency: 2, ...over };
}

export function fixtureInput(over: Record<string, unknown>): RunInput {
  return parseInput({ browser: "chromium", allowPrivateHosts: ["127.0.0.1"], ...over });
}

export const F = (...names: string[]) => names.map((name) => ({ name }));

export async function datasetItems(actor: Actor): Promise<Array<Record<string, unknown>>> {
  const dataset = await actor.openDataset();
  return (await dataset.getData()).items as Array<Record<string, unknown>>;
}

/** Picks the recorded fixture by the sample URL in the question state, so one run can compile two templates. */
export class RoutingChooser implements Chooser {
  readonly name = "recorded" as const;
  private readonly inner = new Map<string, RecordedChooser>();
  constructor(private readonly routes: Array<[string, string]>) {}
  async ask(batch: Question[]): Promise<Answer[]> {
    const state = batch[0]?.state ?? "";
    const route = this.routes.find(([needle]) => state.includes(needle));
    if (!route) throw new Error(`no recorded fixture routes to a batch whose state starts with ${state.slice(0, 80)}`);
    let chooser = this.inner.get(route[1]);
    if (!chooser) this.inner.set(route[1], (chooser = new RecordedChooser({ fixture: route[1] })));
    return chooser.ask(batch);
  }
  usage(): ChooserUsage {
    const all = [...this.inner.values()].map((c) => c.usage());
    const sum = (k: "questions" | "textQuestions" | "batches" | "inputTokens" | "outputTokens" | "waitMs" | "costUsd") => all.reduce((n, u) => n + u[k], 0);
    return { chooser: "recorded", questions: sum("questions"), textQuestions: sum("textQuestions"), batches: sum("batches"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), waitMs: sum("waitMs"), costUsd: sum("costUsd"), zeroDataRetention: "not_applicable" };
  }
}
