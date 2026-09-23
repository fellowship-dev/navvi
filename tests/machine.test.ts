import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUN_VERDICTS,
  STATES,
  TRANSITIONS,
  describeStatus,
  renderMachine,
  stateForStatus,
  stateOf,
  transitionForStatus,
  transitionOf,
  transitionsForVerdict,
  transitionsFrom,
  type RunVerdictTag,
  type StateId,
  type Transition,
  type TransitionId,
} from "../src/scraper/machine.js";
import { STATUSES, type Status } from "../src/scraper/schema.js";
import { classifyRun, type RunVerdict } from "../src/investigate/blocked.js";

/**
 * U7c: the machine, walked rather than admired.
 *
 * A diagram is only worth committing if adding a word somewhere else breaks it.
 * Everything below walks the real tables in `src/scraper/machine.ts` — no test
 * here writes out a state, a transition or a requirement that `src/` owns, and
 * the two places a literal appears (the six defect names, and the four verdict
 * words) are pinned against the real unions rather than standing in for them.
 *
 * Note the import of `src/investigate/blocked.js` below. `scraper` may not
 * reach into `investigate` — that edge points up a layer and
 * `scripts/check-architecture.mjs` refuses it — but a test is outside the layer
 * check, and this file is exactly where the vocabulary and the stage that
 * decides it are allowed to be compared.
 */

// ------------------------------------------------------------------ totality

describe("the machine is total over the unions it claims to cover", () => {
  it("every STATUSES member is carried by exactly one transition, and lands in a real state", () => {
    // Walked, not listed: a status added to `schema.ts` arrives here by itself.
    expect(STATUSES.length).toBeGreaterThan(0);
    const carriers = new Map<Status, TransitionId[]>();
    for (const status of STATUSES) carriers.set(status, []);
    for (const transition of TRANSITIONS) {
      if (transition.status === undefined) continue;
      carriers.get(transition.status)?.push(transition.id as TransitionId);
    }
    // Two failures in one assertion, and both readable: a status nothing
    // carries shows as [], a status two transitions carry shows as both.
    expect(Object.fromEntries([...carriers].map(([status, ids]) => [status, ids.length]))).toEqual(
      Object.fromEntries(STATUSES.map((status) => [status, 1])),
    );
    for (const status of STATUSES) {
      const transition = transitionForStatus(status);
      const state = stateForStatus(status);
      expect(transition.status, status).toBe(status);
      expect(state.id, status).toBe(transition.to);
      expect(stateOf(transition.from), `${status}: ${transition.from}`).toBeDefined();
    }
  });

  it("a run that ends in a status can say where it stopped and whether the next run repairs it", () => {
    for (const status of STATUSES) {
      const sentence = describeStatus(status);
      const transition = transitionForStatus(status);
      // The U9a property, asserted at its weakest useful form: the sentence a
      // failure prints names a state and the transition that reached it.
      expect(sentence, status).toContain(transition.id);
      expect(sentence, status).toContain(transition.from);
      expect(sentence, status).toContain(transition.to);
    }
    // And the only status a healthy run reports is the only one that does not
    // name a repair, because there is nothing to repair.
    expect(describeStatus("drift")).toContain("the next run can repair it");
    expect(describeStatus("blocked_bot_detection")).toContain("no run continues from here without a person");
  });

  /**
   * The verdict union is spelled twice — once in `src/investigate/blocked.ts`
   * as `RunVerdict["state"]`, once in `src/scraper/machine.ts` as
   * `RUN_VERDICTS` — because an import would point an edge up a layer. The
   * house rule (`tests/second-spelling.test.ts`) makes a differential mandatory
   * for exactly this case, and these two assignments are it: they fail the test
   * lane's typecheck, not a run, the moment either side gains or loses a word.
   */
  it("RUN_VERDICTS is the same union classifyRun answers with, in both directions", () => {
    const machineCoversStage: Record<RunVerdict["state"], RunVerdictTag> = {
      healthy: "healthy",
      drift: "drift",
      blocked: "blocked",
      deferred: "deferred",
    };
    const stageCoversMachine: Record<RunVerdictTag, RunVerdict["state"]> = machineCoversStage;
    expect(Object.keys(stageCoversMachine).sort()).toEqual([...RUN_VERDICTS].sort());
    // Every word is load-bearing: a verdict no transition names would be a word
    // the machine knows and cannot act on.
    for (const verdict of RUN_VERDICTS) expect(transitionsForVerdict(verdict).length, verdict).toBeGreaterThan(0);
  });

  /**
   * The other half of the verdict claim, and the one a type cannot make: every
   * variant `classifyRun` can actually *return* maps to a transition. The four
   * observations below are the shapes that produce them, driven through the
   * real function rather than constructed.
   */
  it("every verdict classifyRun really returns maps to a transition that licenses it", () => {
    // The shell that carries Imperva's always-on resource: the same fixture the
    // cascade's own tests use, because a hand-written shell would be a second
    // spelling of what a shell is and `shell-skips-tier-1` owns that.
    const shellWaf = readFileSync(join(import.meta.dirname, "fixtures", "investigate", "storeb-shell-waf.html"), "utf8");
    const product = readFileSync(join(import.meta.dirname, "fixtures", "investigate", "product.html"), "utf8");

    const observed: Array<{ verdict: RunVerdict; because: string }> = [
      {
        because: "nothing wrong: every field fills with values that vary",
        verdict: classifyRun({
          pages: [{ url: "https://example.cl/p/1", status: 200, body: product }],
          fields: { name: { filled: 6, total: 6 }, price: { filled: 6, total: 6 } },
          values: { name: ["a", "b"], price: [1, 2] },
          canary: "resolved",
        }),
      },
      {
        because: "the fields collapsed and the canary still resolves",
        verdict: classifyRun({
          fields: { name: { filled: 0, total: 40 }, price: { filled: 40, total: 40 } },
          canary: "resolved",
        }),
      },
      {
        because: "403 on every URL, with nothing to heal against",
        verdict: classifyRun({
          pages: [
            { url: "https://example.cl/p/1", status: 403, body: "" },
            { url: "https://example.cl/p/2", status: 403, body: "" },
          ],
          canary: "failed",
        }),
      },
      {
        because: "the 2026-09-22 shape: every page that says refused is a shell",
        verdict: classifyRun({
          pages: [
            { url: "https://example.cl/p/1", status: 200, body: shellWaf },
            { url: "https://example.cl/p/2", status: 200, body: shellWaf },
            { url: "https://example.cl/p/3", status: 200, body: shellWaf },
          ],
        }),
      },
    ];

    // All four variants really are reachable, or the walk below proves nothing.
    expect(observed.map((o) => o.verdict.state).sort()).toEqual(["blocked", "deferred", "drift", "healthy"]);
    for (const { verdict, because } of observed) {
      const licensed = transitionsForVerdict(verdict.state);
      expect(licensed.map((t) => t.id), `${verdict.state}: ${because}`).not.toEqual([]);
      for (const transition of licensed) expect(stateOf(transition.to), transition.id).toBeDefined();
    }
  });
});

// -------------------------------------------------------------- the topology

describe("the graph is connected and every state earns its place", () => {
  it("every transition runs between states the machine has", () => {
    const ids = new Set(STATES.map((state) => state.id));
    const dangling = TRANSITIONS.filter((t) => !ids.has(t.from) || !ids.has(t.to)).map((t) => [t.id, t.from, t.to]);
    expect(dangling).toEqual([]);
    // Ids are unique on both tables, or `transitionOf` silently answers for the
    // wrong edge and every lookup above is decoration.
    expect(new Set(STATES.map((s) => s.id)).size).toBe(STATES.length);
    expect(new Set(TRANSITIONS.map((t) => t.id)).size).toBe(TRANSITIONS.length);
    for (const state of STATES) expect(stateOf(state.id)?.id).toBe(state.id);
    for (const transition of TRANSITIONS) expect(transitionOf(transition.id)?.id).toBe(transition.id);
  });

  it("every state is reachable from the start, and nothing but a terminal is a dead end", () => {
    const start = STATES.filter((state) => state.kind === "start");
    expect(start.map((state) => state.id)).toEqual(["requested"]);

    const reached = new Set<string>(start.map((state) => state.id));
    for (let changed = true; changed; ) {
      changed = false;
      for (const transition of TRANSITIONS) {
        if (reached.has(transition.from) && !reached.has(transition.to)) {
          reached.add(transition.to);
          changed = true;
        }
      }
    }
    const unreachable = STATES.filter((state) => !reached.has(state.id)).map((state) => state.id);
    expect(unreachable).toEqual([]);

    // A state a field can enter and never leave is a terminal, and must say so:
    // it is the `rest`/`terminal` line that decides whether healing is even the
    // right question, so a state that is quietly one of them is a bug.
    const stuck = STATES.filter((state) => transitionsFrom(state.id as StateId).length === 0).map((state) => state.id);
    expect(stuck).toEqual(STATES.filter((state) => state.kind === "terminal").map((state) => state.id));
  });

  it("every transition names what it requires, and every requirement names who decides it", () => {
    const silent = TRANSITIONS.filter((t) => t.requires.length === 0).map((t) => t.id);
    // A transition with no requirements is a line on a diagram. The whole
    // diagnostic content of this file is in the requirements.
    expect(silent).toEqual([]);
    const undecided = TRANSITIONS.flatMap((t) =>
      t.requires.filter((r) => r.decidedBy.trim() === "" || r.must.trim() === "").map((r) => [t.id, r.must]),
    );
    expect(undecided).toEqual([]);
  });
});

// -------------------------------------------------- the defects of 2026-09-22

/**
 * The unit's verification line: *each of the three defects of 2026-09-22 is a
 * named state and a failed transition.*
 *
 * The date carries two incidents and this file covers both, because the
 * repository names both with that date. The three below are the ones
 * `src/investigate/manuscript.ts`'s header calls canonical — the three
 * committed client scrapers, "a seasonal CSS class, a list price bound to a sale
 * price, two fields collapsed onto one node" — and they are compile-time
 * wrongness, which is why every one of them came back `succeeded`.
 *
 * Each case names the state the field was in, the transition that was taken and
 * should not have been, and the module or rule that now decides the requirement
 * it did not meet. The `must` sentences are not repeated here: they live in
 * `src/` and the assertion is that the transition carries one from that owner,
 * so re-wording a requirement does not break this test and deleting the guard
 * does.
 */
describe("the three defects of 2026-09-22 are each a state and a failed transition", () => {
  const cases: Array<{ defect: string; state: StateId; transition: TransitionId; guard: string }> = [
    {
      defect: "a seasonal CSS class bound as if it were meaning (StoreA stock, body.one-col.christmas-pattern)",
      state: "bound",
      transition: "accept-binding",
      guard: "selector gate",
    },
    {
      defect: "a list price bound to a sale price (Store B listPrice, p.font-semibold.leading-16.leading-22)",
      state: "narrowed",
      transition: "settle",
      guard: "key-names-carry-the-signal",
    },
    {
      defect: "two distinct facts collapsed onto one node (StoreA productName, the Organization node's name)",
      state: "offered",
      transition: "narrow",
      guard: "json-ld-needs-product-node",
    },
  ];

  it.each(cases)("$defect", ({ state, transition, guard }) => {
    const edge = transitionOf(transition);
    expect(edge, transition).toBeDefined();
    expect(edge?.from).toBe(state);
    expect(stateOf(state), state).toBeDefined();
    // The requirement exists, it names the guard that decides it, and it carries
    // the encounter — without one it is a policy someone invented, which is the
    // shape this repository keeps refusing.
    const requirement = edge?.requires.find((r) => r.decidedBy.includes(guard));
    expect(requirement?.decidedBy, `${transition} has no requirement decided by ${guard}`).toContain(guard);
    expect(requirement?.encounter, `${transition}/${guard} states no encounter`).toContain("2026-09-22");
  });

  it("all three were `succeeded`, which is why the status union could not name them", () => {
    // The point of the whole file in one assertion. Each defect's state is a
    // place a run passes *through* on the way to `succeeded`, so no status
    // distinguishes a run that met the requirement from one that did not.
    const succeeded = stateForStatus("succeeded");
    expect(succeeded.id).toBe("replayed");
    for (const { state } of cases) {
      expect(stateOf(state)?.kind, state).toBe("progress");
      expect(state).not.toBe(succeeded.id);
    }
  });
});

/**
 * The second incident of 2026-09-22: the first live run of the discovery
 * cascade, whose three defects `src/agree/agree.ts`, `tests/probe.test.ts` and
 * `src/investigate/blocked.ts` each call "defect 1/2/3 of that run". These are
 * run-time wrongness — nothing bound at all — and they are what bought the
 * `deferred` state and two of `narrow`'s requirements.
 */
describe("and the three defects of the live run of 2026-09-22 are too", () => {
  it("defect 1: a shell was classified dead — `sampled`, `nothing-on-the-page`", () => {
    const edge = transitionOf("nothing-on-the-page");
    expect(edge?.from).toBe("sampled");
    expect(edge?.to).toBe("absent");
    expect(edge?.status).toBe("no_items_found");
    const requirement = edge?.requires.find((r) => r.decidedBy.includes("shell-skips-tier-1"));
    expect(requirement?.encounter).toContain("2026-09-22");
    // And the state carries the incident, so a reader of the diagram meets it
    // without opening the table.
    expect(stateOf("sampled")?.encounter).toContain("Store B");
  });

  it("defect 2: the same shell was classified blocked — `sampled`, `bot-challenge`, with `deferred` the state that did not exist", () => {
    const edge = transitionOf("bot-challenge");
    expect(edge?.from).toBe("sampled");
    expect(edge?.to).toBe("refused");
    expect(edge?.requires.some((r) => r.encounter?.includes("2026-09-22"))).toBe(true);

    // The fix was a state, not a weaker rule: `deferred` is undecided, leaves
    // only by a render, and is not reachable from `bot-challenge`.
    const deferred = stateOf("deferred");
    expect(deferred?.kind).toBe("undecided");
    expect(deferred?.encounter).toContain("2026-09-22");
    expect(transitionsFrom("deferred").map((t) => t.to).sort()).toEqual(["offered", "refused"]);
    expect(TRANSITIONS.filter((t) => t.to === "deferred").map((t) => t.id)).toEqual(["hold-for-a-render"]);
    // Nothing binds out of an undecided run either, which is the half that
    // makes `deferred` a real hold rather than a softer word for healthy.
    expect(transitionsFrom("deferred").map((t) => t.id)).not.toContain("narrow");
  });

  it("defect 3: tier 2 deleted the endpoint that mattered — `offered`, `narrow` refused", () => {
    const edge = transitionOf("narrow");
    expect(edge?.from).toBe("offered");
    const requirement = edge?.requires.find((r) => r.decidedBy.includes("src/agree/agree.ts"));
    expect(requirement?.encounter).toContain("2026-09-22");
    // The alternative the run actually took, and the one that made it look like
    // a decision rather than a deletion.
    expect(transitionsFrom("offered").map((t) => t.id)).toContain("every-candidate-eliminated");
  });
});

// ------------------------------------------------------------ what U9a inherits

describe("a failure names a state, which is what Phase F's U9a is defined against", () => {
  it("healing leaves exactly one state, and it is a rest state", () => {
    const heals = TRANSITIONS.filter((t) => t.to === "healed");
    expect(heals.map((t) => t.id)).toEqual(["append-an-alternative"]);
    expect(heals[0]?.from).toBe("drifted");
    expect(stateOf("drifted")?.kind).toBe("rest");
    // The guarantee `mayHeal` makes, stated in the machine: there is no path
    // from a refused run to a heal.
    expect(TRANSITIONS.filter((t) => t.from === "refused")).toEqual([]);
    expect(heals[0]?.requires.some((r) => r.decidedBy.includes("mayHeal"))).toBe(true);
  });

  it("a terminal state never continues, and a rest state always does", () => {
    for (const state of STATES) {
      const out = transitionsFrom(state.id as StateId);
      if (state.kind === "terminal") expect(out.map((t) => t.id), state.id).toEqual([]);
      if (state.kind === "rest") expect(out.length, state.id).toBeGreaterThan(0);
    }
  });
});

// ----------------------------------------------------------------- the render

describe("machine.mmd", () => {
  const body = renderMachine();

  it("is a mermaid state diagram with a start marker and an end on every stop", () => {
    const lines = body.split("\n");
    expect(lines).toContain("stateDiagram-v2");
    expect(lines).toContain("  [*] --> requested");
    // `stateDiagram-v2` rather than `graph TD` because `[*]` is notation: where
    // a run stops is the diagnostic payload, and a reader should not have to
    // count arrowheads to find it.
    const ends = STATES.filter((state) => state.kind === "rest" || state.kind === "terminal");
    for (const state of ends) expect(lines, state.id).toContain(`  ${state.id} --> [*]`);
    for (const state of STATES.filter((s) => s.kind !== "rest" && s.kind !== "terminal")) {
      expect(lines, state.id).not.toContain(`  ${state.id} --> [*]`);
    }
  });

  it("draws every state and every transition, and nothing it does not have", () => {
    for (const state of STATES) expect(body, state.id).toContain(`\n  ${state.id} : `);
    for (const transition of TRANSITIONS) {
      expect(body, transition.id).toContain(`  ${transition.from} --> ${transition.to} : ${transition.id}`);
    }
    // Every edge line in the body is one of ours; a drawn edge that is not in
    // the table is the failure mode a hand-drawn diagram has and this one may
    // not.
    const drawn = body
      .split("\n")
      .filter((line) => line.includes("-->") && !line.includes("[*]"))
      .map((line) => line.trim().split(" : ")[1]?.split(" ")[0]);
    expect([...new Set(drawn)].sort()).toEqual([...new Set(TRANSITIONS.map((t) => t.id))].sort());
  });

  it("names the status and the verdict on the edges that carry them", () => {
    for (const transition of TRANSITIONS) {
      const line = body.split("\n").find((l) => l.includes(` : ${transition.id}`));
      expect(line, transition.id).toBeDefined();
      if (transition.status) expect(line, transition.id).toContain(`= ${transition.status}`);
      if (transition.onVerdict) expect(line, transition.id).toContain(`(${transition.onVerdict})`);
    }
  });

  it("carries the encounters as notes, and no label can break the parse", () => {
    const withEncounter = STATES.filter((state) => state.encounter);
    expect(withEncounter.length).toBeGreaterThan(0);
    for (const state of withEncounter) expect(body).toContain(`  note right of ${state.id}\n`);
    expect(body.match(/^ {2}note right of /gm)?.length).toBe(withEncounter.length);
    expect(body.match(/^ {2}end note$/gm)?.length).toBe(withEncounter.length);

    // Mermaid reads `:` as the id/label separator and `;` as end of statement,
    // so a stray one in a label silently redraws the graph. The encounters are
    // prose written by people and full of both.
    for (const line of body.split("\n")) {
      if (line.startsWith("%%") || line === "stateDiagram-v2") continue;
      const colons = (line.match(/:/g) ?? []).length;
      expect(colons, line).toBeLessThanOrEqual(1);
      expect(line, line).not.toContain(";");
      // One statement is one line: a label carrying a newline would split into
      // two statements, the second of which is not valid mermaid.
      expect(line, line).not.toContain("\r");
    }
  });

  it("is stable, because a regenerated artifact that reorders is a diff nobody can read", () => {
    expect(renderMachine()).toBe(body);
  });
});

/** A hand-check on the shape of the thing, so a reader of this file sees one. */
describe("a sample of the rendered body", () => {
  it("reads as a lifecycle", () => {
    const edge = (id: string): Transition => {
      const found = transitionOf(id);
      if (!found) throw new Error(`no transition ${id}`);
      return found;
    };
    const spine = ["choose-a-sample", "candidates-found", "narrow", "settle", "accept-binding", "resolve"].map(edge);
    // The happy path really is a path: each transition starts where the last
    // one ended, from the start state to the one `succeeded` names.
    expect(spine[0]?.from).toBe("requested");
    for (const [index, transition] of spine.entries()) {
      if (index === 0) continue;
      expect(transition.from, transition.id).toBe(spine[index - 1]?.to);
    }
    expect(spine[spine.length - 1]?.to).toBe(stateForStatus("succeeded").id);
  });
});
