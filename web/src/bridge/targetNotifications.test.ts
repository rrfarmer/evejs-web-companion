import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTargetEvent,
  decodeTargetNotification,
  type TargetEvent,
  decodeLockFailure,
} from "./targetNotifications.ts";

// Synthetic ids. `90000001` is the id the upstream spec publishes as its own
// example; the rest are obviously made up.
const RAT = 9001;
const OTHER_RAT = 9002;
const MY_SHIP = 90000001;

// --- decoding ---------------------------------------------------------------

test("an `add` is this ship's own lock landing", () => {
  assert.deepEqual(decodeTargetNotification("OnTarget", ["add", RAT]), {
    kind: "locked",
    targetID: RAT,
    reason: null,
  });
});

test("a `lost` carries the server's own reason, verbatim", () => {
  assert.deepEqual(decodeTargetNotification("OnTarget", ["lost", RAT, "TargetingAttemptCancelled"]), {
    kind: "lost",
    targetID: RAT,
    reason: "TargetingAttemptCancelled",
  });
});

test("a `lost` with no reason is still a `lost`", () => {
  assert.deepEqual(decodeTargetNotification("OnTarget", ["lost", RAT]), {
    kind: "lost",
    targetID: RAT,
    reason: null,
  });
});

// `clear` names nothing because it is about every lock at once — the server
// sends it with a one-element payload (`notifyTargetEvent(session, "clear")`).
test("a `clear` names no target and is not treated as a malformed one", () => {
  assert.deepEqual(decodeTargetNotification("OnTarget", ["clear"]), {
    kind: "cleared",
    targetID: null,
    reason: null,
  });
});

// ⚠ THE HALF THAT WOULD CORRUPT THE LOCK LIST. `otheradd`/`otherlost` carry the
// id of a ship that locked US, not one we locked. Folding either into this
// ship's own locked list would have every `isAlreadyLocked` check downstream
// read another ship's id as a lock this hull holds — and rung 6 would send
// drones onto it.
test("somebody else's lock on this ship is NOT a lock of ours", () => {
  assert.equal(decodeTargetNotification("OnTarget", ["otheradd", RAT]), null);
  assert.equal(decodeTargetNotification("OnTarget", ["otherlost", RAT]), null);
});

test("another method is not an OnTarget", () => {
  assert.equal(decodeTargetNotification("OnJamStart", ["add", RAT]), null);
  assert.equal(decodeTargetNotification(null, ["add", RAT]), null);
});

// ⚠ DROPPED, NOT GUESSED. An `add` or a `lost` is a statement about ONE ship,
// and a fold that cannot say which ship would have to touch the whole list.
// Returning null leaves the client doing what it did before this decoder
// existed: waiting for the tick's own GetTargets read.
test("an add or a lost with no readable id is dropped", () => {
  assert.equal(decodeTargetNotification("OnTarget", ["add"]), null);
  assert.equal(decodeTargetNotification("OnTarget", ["add", 0]), null);
  assert.equal(decodeTargetNotification("OnTarget", ["lost", "not-an-id"]), null);
});

// The wire's three shapes for a game id, all of which reach this client.
test("an id decodes from a long wrapper, a bare integer, or a decimal string", () => {
  assert.equal(decodeTargetNotification("OnTarget", ["add", { type: "long", value: String(RAT) }])?.targetID, RAT);
  assert.equal(decodeTargetNotification("OnTarget", ["add", RAT])?.targetID, RAT);
  assert.equal(decodeTargetNotification("OnTarget", ["add", String(RAT)])?.targetID, RAT);
});

// --- folding ----------------------------------------------------------------

const locked = (targetID: number): TargetEvent => ({ kind: "locked", targetID, reason: null });
const lost = (targetID: number): TargetEvent => ({ kind: "lost", targetID, reason: null });
const cleared: TargetEvent = { kind: "cleared", targetID: null, reason: null };

test("a landed lock joins the list", () => {
  assert.deepEqual(applyTargetEvent([], locked(RAT)), [RAT]);
  assert.deepEqual(applyTargetEvent([RAT], locked(OTHER_RAT)), [RAT, OTHER_RAT]);
});

test("a lost lock leaves it, and a clear empties it", () => {
  assert.deepEqual(applyTargetEvent([RAT, OTHER_RAT], lost(RAT)), [OTHER_RAT]);
  assert.deepEqual(applyTargetEvent([RAT, OTHER_RAT], cleared), []);
});

// ⚠ SAME REFERENCE WHEN NOTHING CHANGED, so a store can skip a needless notify
// — the contract `applyJamEvent` keeps. A doubled push is common: the drain and
// the live stream are two paths to the same dispatch.
test("a no-op fold returns the same array, not a copy", () => {
  const list = [RAT];
  assert.equal(applyTargetEvent(list, locked(RAT)), list, "a lock already held changes nothing");
  assert.equal(applyTargetEvent(list, lost(OTHER_RAT)), list, "dropping one we never held changes nothing");
  const empty: readonly number[] = [];
  assert.equal(applyTargetEvent(empty, cleared), empty, "clearing an empty list allocates nothing");
});

test("this ship's own id is not special to the fold — it is never a target of its own", () => {
  // Nothing here filters self-locks, because the server never sends one: a
  // lock is always source-to-target and the source is this ship.
  assert.deepEqual(applyTargetEvent([], locked(MY_SHIP)), [MY_SHIP]);
});

test("FailLockTarget names the thing whose lock ended, and nothing else is read as one", () => {
  assert.equal(decodeLockFailure("FailLockTarget", [50001248]), 50001248);
  assert.equal(decodeLockFailure("FailLockTarget", []), null);
  assert.equal(decodeLockFailure("FailLockTarget", ["not an id"]), null);
  assert.equal(decodeLockFailure("OnTarget", [50001248]), null);
});
