// The bookkeeping a STANDING movement order carries from one tick to the next:
// was it sent, did the server take it, and when may it be sent again.
//
// WHY THIS IS A FILE OF ITS OWN. The fleet companion's formation order
// (`decideFollow` / `settleFollow` in fleetCompanionLoop.ts) grew this shape
// first, and the `flight auto` positioning rung needs exactly the same one. A
// second copy pasted beside the first is two rules for "how often may a refused
// order be re-sent" with nothing to fail when one drifts. This module is that
// rule once, for the new code; upstream's formation order keeps its own copy
// untouched, because a fork that rewrites upstream's rungs to share a helper
// turns every later upstream edit of them into a conflict.
//
// ─── THE RECORD ──────────────────────────────────────────────────────────────
//
//     pending     sent this tick; the controller has not settled it yet
//     issued      the server took it: the order is standing
//     refused     a definite refusal (counted against `maxRefusals`)
//     deferred    a session change blocked it (counted against `maxDeferrals`)
//     uncertain   no answer: it may or may not have landed
//
// ⚠ EVERY WAIT IS BOUNDED, AND THAT IS THE WHOLE POINT OF THE RECORD. Refusals
// are counted to `maxRefusals` and then backed off for `backoffTicks`; an
// unanswered call is re-sent after `resendWaitTicks` (re-sending a STANDING order
// is safe: a second copy lands on the state the first one set); a deferral
// waits one tick and is capped by `maxDeferrals`. When a cooldown runs out the
// record is dropped and the order goes out again FROM SCRATCH, counters and all:
// back off, never give up, because the order is still wanted.
//
// This module is PURE: records in, records out. The caller decides what the
// order is and whether the standing one is still the right one.

/** Where a standing order stands. See the header. */
export type OrderStatus = "pending" | "issued" | "refused" | "deferred" | "uncertain";

/** What the controller learned when it issued a pending order. */
export type OrderOutcome = Exclude<OrderStatus, "pending">;

export interface OrderLatch {
  readonly status: OrderStatus;
  readonly refusals: number;
  readonly deferrals: number;
  /** One read-only tick owed after a deferral, before the order is retried. */
  readonly deferralWait: boolean;
  /** Ticks left before the order is sent again, or absent. */
  readonly cooldown?: number;
}

export interface OrderLatchLimits {
  /** Refusals one attempt may take before it backs off. */
  readonly maxRefusals: number;
  /** Session-change deferrals one attempt may take before it backs off. */
  readonly maxDeferrals: number;
  /** Ticks to back off after too many refusals or deferrals. */
  readonly backoffTicks: number;
  /** Ticks to wait before re-sending an order whose answer was lost. */
  readonly resendWaitTicks: number;
}

/** Why the latch says "not this tick". Each maps to one readout sentence at the caller. */
export type LatchWaitReason = "cooldown" | "session-change-cap" | "session-change" | "unanswered" | "refused";

export type LatchStep<T extends OrderLatch> =
  /** Send nothing this tick; carry `latch` (the record with its wait advanced). */
  | { readonly kind: "wait"; readonly reason: LatchWaitReason; readonly latch: T }
  /**
   * The latch does not hold the order back. `latch` is the record to judge the
   * standing order by, or null when there is none to assume (never sent, or a
   * cooldown just ran out and the order starts over).
   */
  | { readonly kind: "ready"; readonly latch: T | null };

/**
 * One tick of the latch, in `decideFollow`'s order: a running cooldown first,
 * then the deferral cap, the owed deferral tick, the resend wait for a lost
 * answer, and the refusal cap. See the header for why each is bounded.
 */
export function stepLatch<T extends OrderLatch>(latch: T | null, limits: OrderLatchLimits): LatchStep<T> {
  if (latch === null) {
    return { kind: "ready", latch: null };
  }
  if (latch.cooldown !== undefined) {
    if (latch.cooldown > 1) {
      return { kind: "wait", reason: "cooldown", latch: { ...latch, cooldown: latch.cooldown - 1 } };
    }
    // The wait is over: sent again from scratch, counters and all.
    return { kind: "ready", latch: null };
  }
  if (latch.deferrals >= limits.maxDeferrals) {
    return { kind: "wait", reason: "session-change-cap", latch: { ...latch, cooldown: limits.backoffTicks } };
  }
  if (latch.deferralWait) {
    return { kind: "wait", reason: "session-change", latch: { ...latch, deferralWait: false } };
  }
  if (latch.status === "uncertain") {
    return { kind: "wait", reason: "unanswered", latch: { ...latch, cooldown: limits.resendWaitTicks } };
  }
  if (latch.refusals >= limits.maxRefusals) {
    return { kind: "wait", reason: "refused", latch: { ...latch, cooldown: limits.backoffTicks } };
  }
  return { kind: "ready", latch };
}

/**
 * Is this order standing, or about to be? `pending` counts: re-sending an order
 * the controller has not settled yet would be a second call for one intent.
 */
export function isStanding(latch: OrderLatch | null): boolean {
  return latch !== null && (latch.status === "pending" || latch.status === "issued");
}

/**
 * The record for an order being sent now. The counters carry over from the
 * attempt it repeats, which is what lets the caps above bite; a cooldown never
 * does, because a record being sent is not waiting.
 */
export function pendingLatch(previous: OrderLatch | null): OrderLatch {
  return {
    status: "pending",
    refusals: previous?.refusals ?? 0,
    deferrals: previous?.deferrals ?? 0,
    deferralWait: false,
  };
}

/** The pending record, settled with what the controller learned. As `settleFollow`. */
export function settleLatch<T extends OrderLatch>(pending: T, outcome: OrderOutcome): T {
  return {
    ...pending,
    status: outcome,
    refusals: pending.refusals + (outcome === "refused" ? 1 : 0),
    deferrals: outcome === "deferred" ? pending.deferrals + 1 : 0,
    deferralWait: outcome === "deferred",
  };
}
