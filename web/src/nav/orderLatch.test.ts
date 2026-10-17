// The standing-order latch as a state machine: each wait bounded, each cap
// backing off and then starting over. See orderLatch.ts.

import test from "node:test";
import assert from "node:assert/strict";

import { isStanding, pendingLatch, settleLatch, stepLatch, type OrderLatch } from "./orderLatch.ts";

const LIMITS = { maxRefusals: 3, maxDeferrals: 2, backoffTicks: 4, resendWaitTicks: 2 };

test("no record is ready with nothing to assume", () => {
  assert.deepEqual(stepLatch(null, LIMITS), { kind: "ready", latch: null });
});

test("a pending or issued record is ready and standing; a refused one is ready and not", () => {
  const pending = pendingLatch(null);
  assert.deepEqual(stepLatch(pending, LIMITS), { kind: "ready", latch: pending });
  assert.equal(isStanding(pending), true);
  assert.equal(isStanding(settleLatch(pending, "issued")), true);
  const refused = settleLatch(pending, "refused");
  assert.equal(isStanding(refused), false);
  assert.equal(stepLatch(refused, LIMITS).kind, "ready");
  assert.equal(pendingLatch(refused).refusals, 1, "a resend carries the count, so the cap can bite");
});

test("refusals up to the cap back off, and the back-off ends with the order starting over", () => {
  let latch: OrderLatch = pendingLatch(null);
  for (let n = 0; n < LIMITS.maxRefusals; n += 1) latch = settleLatch(pendingLatch(latch), "refused");
  let step = stepLatch(latch, LIMITS);
  assert.equal(step.kind, "wait");
  assert.equal(step.kind === "wait" ? step.reason : null, "refused");
  for (let n = 0; n < LIMITS.backoffTicks; n += 1) {
    assert.equal(step.kind, "wait");
    step = stepLatch(step.latch, LIMITS);
  }
  assert.deepEqual(step, { kind: "ready", latch: null });
});

test("a lost answer waits the resend ticks, then is sent again", () => {
  const lost = settleLatch(pendingLatch(null), "uncertain");
  const first = stepLatch(lost, LIMITS);
  assert.equal(first.kind === "wait" ? first.reason : null, "unanswered");
  const second = stepLatch(first.latch, LIMITS);
  assert.equal(second.kind === "wait" ? second.reason : null, "cooldown");
  assert.deepEqual(stepLatch(second.latch, LIMITS), { kind: "ready", latch: null });
});

test("a deferral owes one read-only tick, and too many back off", () => {
  const deferred = settleLatch(pendingLatch(null), "deferred");
  const owed = stepLatch(deferred, LIMITS);
  assert.equal(owed.kind === "wait" ? owed.reason : null, "session-change");
  assert.equal(stepLatch(owed.latch, LIMITS).kind, "ready");
  const again = settleLatch(pendingLatch(deferred), "deferred");
  assert.equal(again.deferrals, 2);
  const capped = stepLatch(again, LIMITS);
  assert.equal(capped.kind === "wait" ? capped.reason : null, "session-change-cap");
  // Any other outcome clears the deferral count.
  assert.equal(settleLatch(pendingLatch(again), "issued").deferrals, 0);
});
