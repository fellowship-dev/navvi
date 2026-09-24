import { z } from "zod";
import { define, type AnyHeuristic } from "../types.js";

/**
 * Replay heuristics: what a bad run means. Both of these exist because a number
 * this harness printed was read as a fact about a scraper when it was a fact
 * about the network or about the site's opinion of the IP.
 */

const everyFieldCollapsedIsBlocking = define({
  id: "every-field-collapsed-is-blocking",
  title: "Every field collapsing at once means blocking, not drift.",
  stage: "replay",
  decides: "Whether the run reports drift and heals, or reports blocked and stops.",
  encounter:
    "Store C, 2026-09-22: sku 0/111, stock 0/111, prices 3/111 and \"¡Lo sentimos!\" as a product name — the error page Apify's datacenter IPs are served. " +
    "The same URLs read perfectly from a laptop. The legacy scraper has the same no-proxy config and has failed the same way for months, looking like drift the whole time.",
  input: z.object({
    /** Fill counts per field for this run. */
    fields: z.record(z.string(), z.object({ filled: z.number().int().min(0), total: z.number().int().min(1) })).refine((fields) => Object.keys(fields).length >= 2, {
      message: "one field cannot collapse together with anything; give at least two",
    }),
    /**
     * The decisive signal (S1b): a known-good page whose fingerprint was recorded
     * at investigation. If the template stops matching and the canary still
     * resolves, the site changed. If the canary fails too, the site is refusing you.
     */
    canary: z.enum(["resolved", "failed", "unchecked"]).default("unchecked"),
    /**
     * Fields that filled but hold the same value on every sample — which
     * `no-variation-no-field` has already rejected as bindings. Store C is why
     * this input exists: its product name was 111/111 filled, with "¡Lo
     * sentimos!" in every row. A fill rate alone would have called that healthy
     * and hidden the collapse behind it.
     */
    constant: z.array(z.string()).default([]),
    /** A field at or below this fill rate counts as collapsed. */
    floor: z.number().min(0).max(1).default(0.05),
  }),
  evaluate: ({ fields, canary, constant, floor }) => {
    const rates = Object.entries(fields).map(([name, count]) => ({ name, rate: count.filled / count.total, constant: constant.includes(name), ...count }));
    const alive = rates.filter((field) => field.rate > floor && !field.constant);
    if (alive.length > 0) {
      return {
        fires: false,
        because: `${alive.map((field) => `${field.name} ${field.filled}/${field.total}`).join(", ")} still ${alive.length === 1 ? "fills with a value that varies" : "fill with values that vary"}; a page that is served is a page that drifted`,
      };
    }
    if (canary === "resolved") {
      return {
        fires: false,
        because: "every field collapsed, but the canary page still resolves: the site is serving you and the template is what changed",
        action: "treat as drift: heal against the state machine",
      };
    }
    const collapsed = rates.map((field) => `${field.name} ${field.filled}/${field.total}${field.constant ? " but identical on every sample" : ""}`).join(", ");
    return {
      fires: true,
      because: `every field collapsed at once (${collapsed})${canary === "failed" ? " and the canary page failed too" : "; the canary was not checked"}`,
      action: "report blocked with a named remedy (a proxy, and what it costs) and do not heal: recompiling against an error page destroys a good scraper",
    };
  },
});

const retryTransportNotAnAnswer = define({
  id: "retry-transport-not-an-answer",
  title: "A transport failure is retried; an answer is not.",
  stage: "replay",
  decides: "Whether a URL is re-fetched or recorded as a result.",
  encounter: "2026-09-22: nineteen timeouts were read as nineteen missing products, and a race reading response bodies produced three \"failures\" that were a measurement error.",
  input: z.object({
    outcome: z.object({
      kind: z.enum(["timeout", "reset", "dns", "http"]),
      /** For kind http. */
      status: z.number().int().min(100).max(599).optional(),
    }),
  }),
  evaluate: ({ outcome }) => {
    if (outcome.kind !== "http") {
      return { fires: true, because: `a ${outcome.kind} is the network failing to deliver an answer, not the site's answer`, action: "retry this URL; it has told you nothing about the product yet" };
    }
    const status = outcome.status;
    if (status === undefined) return { fires: false, because: "an http outcome with no status says nothing; record it and look at the row" };
    if (status === 429 || status >= 500) {
      return { fires: true, because: `HTTP ${status} is the server declining to answer right now`, action: "retry with backoff" };
    }
    if (status === 403) {
      return { fires: false, because: "HTTP 403 is an answer: the site is refusing you", action: "hand this to the blocking check rather than retrying it" };
    }
    return { fires: false, because: `HTTP ${status} is an answer; record it as the result for this URL`, action: "do not retry: a retry would turn one honest row into a second identical one" };
  },
});

export const REPLAY_HEURISTICS: readonly AnyHeuristic[] = [everyFieldCollapsedIsBlocking, retryTransportNotAnAnswer];
