import type { ChargeResult } from "apify";
import { NavviError } from "./budget.js";

/**
 * R20 / KTD10: pay-per-event charging. Five events, priced in Console, never
 * in code; the fifth, `decision`, is U12 / R16 (see `billDecisions`). The charger is a thin wrapper over `Actor.charge` that counts what
 * was charged and remembers a reached limit, so the crawler can check
 * `canAfford` before every page (R28 style) and end the run `charge_limit`
 * with the items pushed so far (AE13). Without pay-per-event pricing (every
 * local run, a run under a different pricing model) it is a no-op.
 */

export const CHARGE_EVENTS = ["actor-start", "scraper-compiled", "page-scraped", "result-item", "decision"] as const;
export type ChargeEvent = (typeof CHARGE_EVENTS)[number];
export type ChargeCounts = Record<ChargeEvent, number>;

/** What the charger needs from `Actor`; the static class, an instance and a test fake all satisfy it. */
export interface ChargingActor {
  charge?(options: { eventName: string; count?: number }): Promise<ChargeResult>;
  getChargingManager?(): {
    getPricingInfo(): { isPayPerEvent: boolean };
    /** How many more events of this name fit within the run's limit; Infinity for an unpriced event. */
    calculateMaxEventChargeCountWithinLimit?(eventName: string): number;
  };
}

export interface ChargeOutcome {
  /** Events actually charged; fewer than asked when the budget ran out, zero when charging is off. */
  charged: number;
  limitReached: boolean;
}

export function zeroCharges(): ChargeCounts {
  return { "actor-start": 0, "scraper-compiled": 0, "page-scraped": 0, "result-item": 0, decision: 0 };
}

export class Charger {
  readonly counts: ChargeCounts = zeroCharges();
  /** Set once a charge came back short: the run cannot continue as asked. Per-event exhaustion is tracked separately, as the SDK reports it. */
  limitReached = false;
  private readonly exhausted = new Set<ChargeEvent>();

  private constructor(
    private readonly actor: ChargingActor,
    readonly enabled: boolean,
  ) {}

  /** Enabled only when the actor charges and its pricing is pay-per-event; a pricing read that throws (no `Actor.init`) means off. */
  static for(actor: ChargingActor): Charger {
    let enabled = false;
    try {
      enabled = typeof actor.charge === "function" && Boolean(actor.getChargingManager?.().getPricingInfo().isPayPerEvent);
    } catch {
      enabled = false;
    }
    return new Charger(actor, enabled);
  }

  static disabled(): Charger {
    return new Charger({}, false);
  }

  /** How many more `event`s fit within the limit; Infinity when charging is off or the event has no price. */
  room(event: ChargeEvent): number {
    if (!this.enabled) return Infinity;
    if (this.exhausted.has(event)) return 0;
    let n: number | undefined;
    try {
      n = this.actor.getChargingManager?.().calculateMaxEventChargeCountWithinLimit?.(event);
    } catch {
      n = undefined;
    }
    return n === undefined ? Infinity : Math.max(0, n);
  }

  canAfford(event: ChargeEvent): boolean {
    return this.room(event) > 0;
  }

  /** Charges up to `count` events and records the outcome; never throws for a reached limit, never calls the platform for an exhausted event. */
  async charge(event: ChargeEvent, count = 1): Promise<ChargeOutcome> {
    if (!this.enabled || count <= 0) return { charged: 0, limitReached: false };
    if (this.room(event) === 0) {
      this.exhausted.add(event);
      this.limitReached = true;
      return { charged: 0, limitReached: true };
    }
    const result = await this.actor.charge!({ eventName: event, count });
    const charged = Math.max(0, Math.min(count, result.chargedCount));
    this.counts[event] += charged;
    if (result.eventChargeLimitReached) this.exhausted.add(event);
    if (charged < count) this.limitReached = true;
    return { charged, limitReached: charged < count };
  }
}

/**
 * What `billDecisions` wraps: the chooser's shape, spelled structurally so
 * billing does not import the chooser. `Chooser` satisfies it both ways.
 */
export interface AnsweringSource<N extends string, Q, A, U> {
  readonly name: N;
  ask(batch: Q[]): Promise<A[]>;
  usage(): U;
}

/**
 * U12 / R16: the `decision` event, one per chooser question answered (a batch
 * of N is N events). The caller wraps the run's chooser only when the
 * operator's key is in use: a bring-your-own-key run pays its provider and is
 * never billed twice for the same question (Max, 2026-09-20). A pinned replay
 * asks nothing, so charges nothing.
 *
 * The room is checked before the chooser is asked, so a spent budget buys no
 * model call; a batch the budget covers only in part ends the run
 * `charge_limit` like the other events (thrown as a NavviError, which the
 * crawler turns into the run's stop).
 */
export function billDecisions<N extends string, Q, A, U>(source: AnsweringSource<N, Q, A, U>, charger: Charger): AnsweringSource<N, Q, A, U> {
  return {
    // A chain reports the member currently answering, so the name is read, not copied.
    get name() {
      return source.name;
    },
    usage: () => source.usage(),
    ask: async (batch) => {
      if (batch.length > 0 && !charger.canAfford("decision")) {
        charger.limitReached = true;
        throw new NavviError("charge_limit", "charge limit reached before a chooser decision");
      }
      const answers = await source.ask(batch);
      await chargeAnswered(charger, answers.length);
      return answers;
    },
  };
}

/** Charges `n` answered questions as `decision`, at most what the room allows; throws `charge_limit` when that is fewer. */
export async function chargeAnswered(charger: Charger, n: number): Promise<void> {
  // Clamped to the room like `result-item`: asking for more would have the
  // platform charge one event over the limit.
  const want = Math.min(n, charger.room("decision"));
  const outcome = await charger.charge("decision", want);
  if (charger.enabled && outcome.charged < n) {
    charger.limitReached = true;
    throw new NavviError("charge_limit", `charge limit reached after ${charger.counts.decision} chooser decisions`);
  }
}
