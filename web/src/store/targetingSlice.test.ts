// The R23 slice A store slice: what is locked, what is still being acquired,
// and how the two failure modes are kept apart.
//
// The lifecycle resets are the part most likely to rot, so they are pinned
// hardest: a docked ship has no locks and nothing cycling, and carrying either
// across a dock, a character swap or a logout would be a lie the moment the
// page rendered it.

import test from "node:test";
import assert from "node:assert/strict";

import { createClientStore } from "./clientStore.ts";

const ROCK_ID = 50001248;
const OTHER_ID = 50001249;

test("the slice starts empty and unloaded", () => {
  const state = createClientStore().targeting.get();
  assert.deepEqual(state.lockedTargetIDs, []);
  assert.deepEqual(state.acquiringTargetIDs, []);
  assert.equal(state.loaded, false);
  assert.equal(state.actionError, null);
  assert.equal(state.silentDecline, null);
});

test("the server's target list replaces the slice wholesale", () => {
  const store = createClientStore();
  store.apply({ type: "targeting/targets", targetIDs: [ROCK_ID, OTHER_ID] });
  assert.deepEqual(store.targeting.get().lockedTargetIDs, [ROCK_ID, OTHER_ID]);
  assert.equal(store.targeting.get().loaded, true);

  // A later read that drops one is the whole truth, not a merge: the server is
  // the only authority on what is locked.
  store.apply({ type: "targeting/targets", targetIDs: [OTHER_ID] });
  assert.deepEqual(store.targeting.get().lockedTargetIDs, [OTHER_ID]);
});

test("an acquiring note is retired as soon as the target appears in the locked list", () => {
  const store = createClientStore();
  store.apply({ type: "targeting/acquiring", targetID: ROCK_ID });
  assert.deepEqual(store.targeting.get().acquiringTargetIDs, [ROCK_ID]);

  store.apply({ type: "targeting/targets", targetIDs: [ROCK_ID] });
  const state = store.targeting.get();
  assert.deepEqual(state.lockedTargetIDs, [ROCK_ID]);
  assert.deepEqual(state.acquiringTargetIDs, [], "it landed, so stop saying 'Locking…'");
});

test("an acquiring note is never duplicated, and never shadows a landed lock", () => {
  const store = createClientStore();
  store.apply({ type: "targeting/acquiring", targetID: ROCK_ID });
  store.apply({ type: "targeting/acquiring", targetID: ROCK_ID });
  assert.deepEqual(store.targeting.get().acquiringTargetIDs, [ROCK_ID]);

  store.apply({ type: "targeting/targets", targetIDs: [ROCK_ID] });
  store.apply({ type: "targeting/acquiring", targetID: ROCK_ID });
  assert.deepEqual(
    store.targeting.get().acquiringTargetIDs,
    [],
    "something already locked is not 'being acquired'",
  );
});

test("a refusal and a silent decline are separate fields, and a success clears both", () => {
  const store = createClientStore();
  store.apply({ type: "targeting/action-error", message: "Lock refused: TargetTooFar" });
  store.apply({ type: "targeting/silent-decline", message: "…and gave no reason." });
  let state = store.targeting.get();
  assert.match(state.actionError ?? "", /TargetTooFar/);
  assert.match(state.silentDecline ?? "", /no reason/);

  // Both described the PREVIOUS action.
  store.apply({ type: "targeting/action", action: "Lock" });
  state = store.targeting.get();
  assert.equal(state.lastAction, "Lock");
  assert.equal(state.actionError, null);
  assert.equal(state.silentDecline, null);
});

// --- Lifecycle: nothing survives a dock, a swap or a logout ------------------

test("docking clears the slice — a docked ship has no locks", () => {
  const store = createClientStore();
  store.apply({ type: "targeting/targets", targetIDs: [ROCK_ID] });
  store.apply({ type: "targeting/acquiring", targetID: OTHER_ID });

  store.apply({ type: "space/cleared" });
  const state = store.targeting.get();
  assert.deepEqual(state.lockedTargetIDs, []);
  assert.deepEqual(state.acquiringTargetIDs, []);
  assert.equal(state.loaded, false);
});

test("a character swap and a logout each clear the slice too", () => {
  for (const event of [
    { type: "character/offline" } as const,
    { type: "session/logged-out" } as const,
  ]) {
    const store = createClientStore();
    store.apply({ type: "targeting/targets", targetIDs: [ROCK_ID] });
    store.apply({ type: "targeting/action-error", message: "stale" });
    store.apply(event);
    const state = store.targeting.get();
    assert.deepEqual(state.lockedTargetIDs, [], `${event.type} must clear the locks`);
    assert.equal(state.actionError, null, `${event.type} must clear the refusal`);
  }
});

test("one apply produces exactly one store notification", () => {
  const store = createClientStore();
  let notifications = 0;
  const stop = store.subscribe(() => {
    notifications += 1;
  });
  notifications = 0; // subscribe fires once with the current value
  store.apply({ type: "targeting/targets", targetIDs: [ROCK_ID] });
  assert.equal(notifications, 1);
  stop();
});

// --- the pushed lock event (`OnTarget`) --------------------------------------
//
// ⚠ WHY THE SLICE TAKES A PUSH AT ALL. `targeting/targets` is the server's
// answer to `GetTargets` and stays the authority, but it only ever arrives on a
// POLL — so a lock that completed a moment after one read was invisible until
// the next. That is dead time the fleet companion cannot afford: it will not
// send drones onto a ship it has not locked, and will not open fire until the
// lock is observed. These events let the same fact land the instant the server
// states it.

test("a pushed lock joins the list without waiting for a poll", () => {
  const store = createClientStore();
  store.apply({
    type: "targeting/lock-event",
    event: { kind: "locked", targetID: ROCK_ID, reason: null },
  });
  assert.deepEqual(store.targeting.get().lockedTargetIDs, [ROCK_ID]);
});

// The acquiring note is what the page shows as "Locking…". A landed lock ends
// it, on exactly the rule `targeting/targets` already applies.
test("a pushed lock retires the acquiring note it belongs to", () => {
  const store = createClientStore();
  store.apply({ type: "targeting/acquiring", targetID: ROCK_ID });
  store.apply({ type: "targeting/acquiring", targetID: OTHER_ID });
  store.apply({
    type: "targeting/lock-event",
    event: { kind: "locked", targetID: ROCK_ID, reason: null },
  });
  const state = store.targeting.get();
  assert.deepEqual(state.lockedTargetIDs, [ROCK_ID]);
  assert.deepEqual(state.acquiringTargetIDs, [OTHER_ID], "only the landed one is retired");
});

// ⚠ AND SO DOES A FAILURE. An abandoned or refused lock is not still being
// acquired either, and the only other place the note is cleared is a successful
// poll — which by definition never names a target that failed to lock.
test("a pushed lock failure retires the acquiring note too", () => {
  const store = createClientStore();
  store.apply({ type: "targeting/acquiring", targetID: ROCK_ID });
  store.apply({
    type: "targeting/lock-event",
    event: { kind: "lost", targetID: ROCK_ID, reason: "TargetingAttemptCancelled" },
  });
  const state = store.targeting.get();
  assert.deepEqual(state.acquiringTargetIDs, []);
  assert.deepEqual(state.lockedTargetIDs, []);
});

test("a pushed clear empties the locks and everything being acquired", () => {
  const store = createClientStore();
  store.apply({ type: "targeting/targets", targetIDs: [ROCK_ID, OTHER_ID] });
  store.apply({ type: "targeting/acquiring", targetID: 50001250 });
  store.apply({
    type: "targeting/lock-event",
    event: { kind: "cleared", targetID: null, reason: null },
  });
  const state = store.targeting.get();
  assert.deepEqual(state.lockedTargetIDs, []);
  assert.deepEqual(state.acquiringTargetIDs, []);
});

// ⚠ A PUSH IS NOT A LOAD. `loaded` says the list has been read from the server
// at least once; a single push says one lock landed and nothing about the rest,
// so a page that hid its panel until `loaded` must stay hidden.
test("a pushed lock does not mark the slice loaded", () => {
  const store = createClientStore();
  store.apply({
    type: "targeting/lock-event",
    event: { kind: "locked", targetID: ROCK_ID, reason: null },
  });
  assert.equal(store.targeting.get().loaded, false);
});

// The drain and the live stream are two paths into the same dispatch, so the
// same push arriving twice is ordinary rather than exceptional.
//
// ⚠ THE WHOLE-STORE VERSION STILL BUMPS on every apply — that is the store's
// standing contract and not this event's business. What the fold buys is that
// the SLICE is not re-set, so a per-slice reader sees the same object and any
// memo over it holds.
test("the same pushed lock twice is one lock, and does not churn the slice", () => {
  const store = createClientStore();
  store.apply({
    type: "targeting/lock-event",
    event: { kind: "locked", targetID: ROCK_ID, reason: null },
  });
  const before = store.targeting.get();
  store.apply({
    type: "targeting/lock-event",
    event: { kind: "locked", targetID: ROCK_ID, reason: null },
  });
  assert.deepEqual(store.targeting.get().lockedTargetIDs, [ROCK_ID]);
  assert.equal(store.targeting.get(), before, "a fold that changed nothing must not re-set the slice");
});

// ⚠ THE POLL STILL WINS. Whatever a push folded, the next `GetTargets` answer
// replaces wholesale — which is what makes a lost, doubled or out-of-order push
// cost freshness and never correctness.
test("the next poll overrides whatever a push folded", () => {
  const store = createClientStore();
  store.apply({
    type: "targeting/lock-event",
    event: { kind: "locked", targetID: ROCK_ID, reason: null },
  });
  store.apply({ type: "targeting/targets", targetIDs: [OTHER_ID] });
  assert.deepEqual(store.targeting.get().lockedTargetIDs, [OTHER_ID]);
});

// The server's FailLockTarget: the only word a page gets of a lock that ended without being made.
test("a failed lock ends its note alone, and leaves locks already made", () => {
  const store = createClientStore();
  store.apply({ type: "targeting/targets", targetIDs: [ROCK_ID] });
  store.apply({ type: "targeting/acquiring", targetID: OTHER_ID });
  store.apply({ type: "targeting/lock-failed", targetID: OTHER_ID });
  store.apply({ type: "targeting/lock-failed", targetID: ROCK_ID });
  const state = store.targeting.get();
  assert.deepEqual(state.acquiringTargetIDs, []);
  assert.deepEqual(state.lockedTargetIDs, [ROCK_ID]);
});
