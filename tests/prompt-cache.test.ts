import { describe, expect, it, vi } from "vitest";
import { promptToInput, promptCacheKey } from "../src/input/prompt.js";
import type { Chooser } from "../src/chooser/chooser.js";
import type { ActorLike } from "../src/scraper/store.js";

const prompt = "Get job titles";
const structured = { mode: "list", description: "Job listings", fields: [{ name: "title" }], paginate: false };
function setup() {
  const records = new Map<string, unknown>();
  const store = { getValue: vi.fn(async (key: string) => records.get(key) ?? null), setValue: vi.fn(async (key: string, value: unknown) => { records.set(key, value); }) };
  const actor = { openKeyValueStore: vi.fn(async () => store) } as unknown as ActorLike;
  const ask = vi.fn(async (qs) => qs.map((q: { id: string }) => ({ id: q.id, index: null, text: JSON.stringify(structured) })));
  const chooser = { name: "model", ask } as unknown as Chooser;
  return { records, store, actor, chooser, ask };
}
describe("persisted prompt interpretation", () => {
  it("reuses interpretation across calls while applying fresh URLs and explicit policy", async () => {
    const s = setup();
    await promptToInput(prompt, { startUrls: ["https://example.com"], maxItems: 2 }, s.chooser, s.actor);
    const second = await promptToInput(prompt, { startUrls: ["https://other.example"], maxPages: 4, maxItems: 7, allowMutations: ["search"] }, s.chooser, s.actor);
    expect(s.ask).toHaveBeenCalledTimes(1);
    expect(second.input).toMatchObject({ startUrls: ["https://other.example"], maxPages: 4, maxItems: 7, allowMutations: ["search"] });
    expect(JSON.stringify([...s.records.values()])).not.toContain("example.com");
    expect(JSON.stringify([...s.records.values()])).not.toContain("maxItems");
  });
});

 it("invalidates full prompts, profiles and explicit forceRecompile", async () => {
   const s = setup();
   for (const base of [{}, {}, { forceRecompile: true }, { profile: "local" as const }]) await promptToInput(prompt, base, s.chooser, s.actor);
   expect(s.ask).toHaveBeenCalledTimes(3);
   expect(promptCacheKey("a".repeat(4000) + "x", "store")).not.toBe(promptCacheKey("a".repeat(4000) + "y", "store"));
   await promptToInput(prompt + " please", {}, s.chooser, s.actor);
   expect(s.ask).toHaveBeenCalledTimes(4);
 });
 it.each([{ version: 0 }, { version: 1, structured: {} }, { version: 1, structured: { ...structured, goal: "password: unsafe" } }])("reparses invalid or stale cached records", async (bad) => {
   const s = setup();
   const key = promptCacheKey(prompt, "store");
   s.records.set(key, { ...bad, key });
   await promptToInput(prompt, {}, s.chooser, s.actor);
   expect(s.ask).toHaveBeenCalledTimes(1);
 });
 it("validates fresh overrides even on a cache hit", async () => {
   const s = setup();
   await promptToInput(prompt, {}, s.chooser, s.actor);
   await expect(promptToInput(prompt, { startUrls: ["http://127.0.0.1"] }, s.chooser, s.actor)).rejects.toThrow();
   expect(s.ask).toHaveBeenCalledTimes(1);
 });
 it.each([
   { ...structured, goal: "use password: unsafe" },
   { ...structured, fields: [{ name: "title", description: "token: unsafe" }] },
   { ...structured, extra: "api_key: unsafe" },
   { ...structured, secret: "unsafe" },
   { ...structured, description: "open https://user:password@example.com" },
   { ...structured, description: "open https://example.com?token=unsafe" },
 ])("refuses unsafe derived values before overrides or persistence", async (answer) => {
   const s = setup();
   s.ask.mockImplementation(async (qs) => qs.map((q: { id: string }) => ({ id: q.id, index: null, text: JSON.stringify(answer) })));
   await expect(promptToInput(prompt, { goal: "safe override", description: "safe override" }, s.chooser, s.actor)).rejects.toThrow();
   expect(s.store.setValue).not.toHaveBeenCalled();
 });
 it("refuses secret-bearing prompts before touching cache or chooser", async () => {
   const s = setup();
   await expect(promptToInput("get password: unsafe", {}, s.chooser, s.actor)).rejects.toThrow();
   await expect(promptToInput("get https://example.com?token=unsafe", {}, s.chooser, s.actor)).rejects.toThrow();
   expect(s.actor.openKeyValueStore).not.toHaveBeenCalled();
   expect(s.ask).not.toHaveBeenCalled();
 });
 it("persists secret references but never runtime secret values", async () => {
   const s = setup();
   await promptToInput(prompt, { profile: "local", secrets: { password: "runtime-secret" } }, s.chooser, s.actor);
   expect(JSON.stringify([...s.records.values()])).not.toContain("runtime-secret");
 });
 it("reparses a cache record that cannot be decoded", async () => {
   const s = setup();
   s.store.getValue.mockRejectedValueOnce(new SyntaxError("invalid JSON"));
   await promptToInput(prompt, {}, s.chooser, s.actor);
   expect(s.ask).toHaveBeenCalledTimes(1);
   expect(s.store.setValue).toHaveBeenCalledTimes(1);
 });
