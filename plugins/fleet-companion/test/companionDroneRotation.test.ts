import assert from "node:assert/strict";
import test from "node:test";

import {
  BLIND_HOLD_MS,
  DEAD_DRONE_TICKS,
  HOT_MS,
  RECALL_GIVE_UP_MS,
  RELAUNCH_WAIT_MS,
  RETARGET_HOLD_MAX_MS,
  decideCompanionDroneRotation,
  emptyCompanionDroneRotation,
  readCompanionDroneRotation,
  rotationBusy,
  type CompanionDroneRotationMemory,
  type RotationBayStack,
  type RotationDroneRow,
  type RotationHostile,
} from "../lib/companionDroneRotation.ts";
import { MAX_DRONE_ROTATIONS } from "../../../web/src/nav/droneRotation.ts";

const HAMMERHEAD = 2185;
const HOBGOBLIN = 2454;
const A = 9001;
const B = 9002;
const C = 9003;
const STACK = 8001;
const RAT = 7001;
const OTHER_RAT = 7002;
const SHIP = 1;
const T0 = 1_000_000;

function drone(itemID: number, shieldRatio: number | null = 1, attackers: readonly number[] = [], typeID: number | null = HAMMERHEAD): RotationDroneRow {
  return { itemID, typeID, shieldRatio, attackers };
}

function singleton(itemID: number, typeID: number | null = HAMMERHEAD): RotationBayStack {
  return { itemID, typeID, quantity: -1 };
}

function step(
  drones: readonly RotationDroneRow[] | null,
  bay: readonly RotationBayStack[] | null,
  memory: CompanionDroneRotationMemory,
  nowMs: number,
  hostiles: readonly RotationHostile[] | null = [],
) {
  return decideCompanionDroneRotation({ drones, bay, hostiles, memory, nowMs });
}

/** Recall `ids` (hurt, with these attackers) and land them aboard; returns the memory with them aboard. */
function landed(
  ids: readonly number[],
  attackers: readonly number[],
  bay: readonly RotationBayStack[],
  nowMs: number,
): CompanionDroneRotationMemory {
  const recall = step(ids.map((id) => drone(id, 0.5, attackers)), bay, emptyCompanionDroneRotation(), nowMs);
  assert.equal(recall.action.kind, "recall");
  // Landed with no spare in the bay, so this tick only records them aboard.
  void bay;
  const aboard = step([], ids.map((id) => singleton(id)), recall.memory, nowMs + 1_000,
    attackers.map((rat) => ({ itemID: rat, targetEntityID: ids[0] as number })));
  assert.equal(aboard.action.kind, "none");
  return aboard.memory;
}

test("every drone losing shield is recalled in ONE call", () => {
  const out = step([drone(B, 0.7), drone(A, 0.4), drone(C)], [], emptyCompanionDroneRotation(), T0);
  assert.deepEqual(out.action, { kind: "recall", droneIDs: [A, B] });
  assert.equal(out.reason, "recalling");
  assert.deepEqual(out.memory.homeward.map((row) => row.itemID), [A, B]);
  assert.equal(out.memory.rotations[String(A)], 1);
  assert.equal(out.memory.rotations[String(B)], 1);
});

test("a drone flying home is not recalled again, and a newly shot one still is", () => {
  const first = step([drone(A, 0.5), drone(B)], [], emptyCompanionDroneRotation(), T0);
  const again = step([drone(A, 0.3), drone(B)], [], first.memory, T0 + 500);
  assert.deepEqual(again.action, { kind: "none" });
  const second = step([drone(A, 0.3), drone(B, 0.9)], [], again.memory, T0 + 1_000);
  assert.deepEqual(second.action, { kind: "recall", droneIDs: [B] });
});

// ⚠ SEEN LIVE 2026-10-19: the bay read shows the scooped drone a second before
// the space snapshot stops showing it, shield still short. It must land once,
// be booked once, and be replaced once.
test("a scooped drone still in the snapshot is not a new hit, and lands aboard once", () => {
  const bay = [{ itemID: STACK, typeID: HAMMERHEAD, quantity: 3 }];
  const recall = step([drone(A, 0.85, [RAT]), drone(B)], [], emptyCompanionDroneRotation(), T0);
  assert.deepEqual(recall.action, { kind: "recall", droneIDs: [A] });
  // Both reads at once: aboard by the bay, still out by the snapshot.
  let memory = recall.memory;
  const launches: unknown[] = [];
  for (let n = 1; n <= 3; n += 1) {
    const out = step([drone(A, 0.85, [RAT]), drone(B)], [...bay, singleton(A)], memory, T0 + n * 400,
      [{ itemID: RAT, targetEntityID: A }]);
    assert.notEqual(out.action.kind, "recall", `tick ${n} must not recall it again`);
    if (out.action.kind === "launch") launches.push(out.action);
    memory = out.memory;
  }
  assert.equal(memory.rotations[String(A)], 1, "one hit, one rotation booked");
  assert.deepEqual(launches, [{ kind: "launch", droneItemIDs: [STACK], quantities: { [STACK]: 1 }, spares: 1, relaunched: 0 }]);
});

test("a drone in the bay is never recalled, whatever the snapshot says of it", () => {
  const out = step([drone(A, 0.5)], [singleton(A)], emptyCompanionDroneRotation(), T0);
  assert.deepEqual(out.action, { kind: "none" });
});

test("a whole, an unreadable and an armour-only drone are all left alone", () => {
  const out = step([drone(A, 1), drone(B, null)], [], emptyCompanionDroneRotation(), T0);
  assert.deepEqual(out.action, { kind: "none" });
  assert.equal(out.reason, "idle");
});

test("an unreadable space list starts nothing", () => {
  const out = step(null, [], emptyCompanionDroneRotation(), T0);
  assert.deepEqual(out.action, { kind: "none" });
  assert.equal(out.reason, "unreadable");
});

test("aboard with a spare of its type: the spare goes out at once, one from the stack", () => {
  const bay = [{ itemID: STACK, typeID: HAMMERHEAD, quantity: 3 }];
  const memory = landed([A], [RAT], bay, T0);
  const out = step([], [...bay, singleton(A)], memory, T0 + 1_500, [{ itemID: RAT, targetEntityID: A }]);
  assert.equal(out.action.kind, "launch");
  if (out.action.kind !== "launch") return;
  assert.deepEqual(out.action.droneItemIDs, [STACK]);
  assert.deepEqual(out.action.quantities, { [STACK]: 1 });
  assert.equal(out.action.spares, 1);
  assert.equal(out.memory.aboard.length, 0, "the shot drone stays in the bay as a reserve");
});

test("two drones replaced from one stack take two from it", () => {
  const bay = [{ itemID: STACK, typeID: HAMMERHEAD, quantity: 3 }];
  const memory = landed([A, B], [], bay, T0);
  const out = step([], [...bay, singleton(A), singleton(B)], memory, T0 + 1_500);
  assert.equal(out.action.kind, "launch");
  if (out.action.kind !== "launch") return;
  assert.deepEqual(out.action.droneItemIDs, [STACK]);
  assert.deepEqual(out.action.quantities, { [STACK]: 2 });
});

test("a stack of another type is not a spare", () => {
  const bay = [{ itemID: STACK, typeID: HOBGOBLIN, quantity: 5 }];
  const memory = landed([A], [RAT], bay, T0);
  const out = step([], [...bay, singleton(A)], memory, T0 + 1_500, [{ itemID: RAT, targetEntityID: A }]);
  assert.deepEqual(out.action, { kind: "none" });
});

test("a drone recalled for being shot within HOT_MS is not somebody else's spare", () => {
  // B came home hurt a moment ago and sits aboard; A is shot now. B is hot:
  // the rat that shot B still has it in its retaliation memory.
  let memory = landed([B], [OTHER_RAT], [], T0);
  memory = { ...memory, aboard: [] };
  const recall = step([drone(A, 0.5, [RAT])], [singleton(B)], memory, T0 + 2_000);
  assert.deepEqual(recall.action, { kind: "recall", droneIDs: [A] });
  const aboard = step([], [singleton(B), singleton(A)], recall.memory, T0 + 3_000, [{ itemID: RAT, targetEntityID: A }]);
  const out = step([], [singleton(B), singleton(A)], aboard.memory, T0 + 3_500, [{ itemID: RAT, targetEntityID: A }]);
  assert.deepEqual(out.action, { kind: "none" }, "held: no cold spare, and the rat is still on it");
  // Once B has cooled, it is a spare like any other.
  const cooled = step([], [singleton(B), singleton(A)], out.memory, T0 + 2_000 + HOT_MS, [{ itemID: RAT, targetEntityID: A }]);
  assert.equal(cooled.action.kind, "launch");
});

test("no spare: held while its rat still names it, relaunched once the rat picks someone else", () => {
  const memory = landed([A], [RAT], [], T0);
  const still = step([], [singleton(A)], memory, T0 + 2_000, [{ itemID: RAT, targetEntityID: A }]);
  assert.deepEqual(still.action, { kind: "none" });
  assert.equal(still.reason, "waiting");
  const moved = step([], [singleton(A)], still.memory, T0 + 3_000, [{ itemID: RAT, targetEntityID: SHIP }]);
  assert.equal(moved.action.kind, "launch");
  if (moved.action.kind !== "launch") return;
  assert.deepEqual(moved.action.droneItemIDs, [A]);
  assert.deepEqual(moved.action.quantities, { [A]: 1 });
  assert.equal(moved.action.relaunched, 1);
});

// ⚠ A RAT WITH NO TARGET IS THE DANGEROUS ONE. On this server it falls back to
// its retaliation and preferred target -- the drone's own id -- the moment the
// drone is back in space.
test("a rat that names no ball has not moved on", () => {
  const memory = landed([A], [RAT], [], T0);
  const out = step([], [singleton(A)], memory, T0 + 2_000, [{ itemID: RAT, targetEntityID: null }]);
  assert.deepEqual(out.action, { kind: "none" });
});

test("a rat that left the grid has moved on", () => {
  const memory = landed([A], [RAT], [], T0);
  const out = step([], [singleton(A)], memory, T0 + 1_500, [{ itemID: OTHER_RAT, targetEntityID: SHIP }]);
  assert.equal(out.action.kind, "launch");
});

test("the hold is bounded: after RETARGET_HOLD_MAX_MS the drone goes back out regardless", () => {
  const memory = landed([A], [RAT], [], T0);
  const held = step([], [singleton(A)], memory, T0 + 1_000 + RETARGET_HOLD_MAX_MS - 1, [{ itemID: RAT, targetEntityID: A }]);
  assert.deepEqual(held.action, { kind: "none" });
  const out = step([], [singleton(A)], held.memory, T0 + 1_000 + RETARGET_HOLD_MAX_MS, [{ itemID: RAT, targetEntityID: A }]);
  assert.equal(out.action.kind, "launch");
});

test("with no rat ever seen on it, the drone waits BLIND_HOLD_MS", () => {
  const memory = landed([A], [], [], T0);
  const early = step([], [singleton(A)], memory, T0 + 1_000 + BLIND_HOLD_MS - 1);
  assert.deepEqual(early.action, { kind: "none" });
  const out = step([], [singleton(A)], early.memory, T0 + 1_000 + BLIND_HOLD_MS);
  assert.equal(out.action.kind, "launch");
});

test("a rat that takes the drone on during its flight home is waited out too", () => {
  const recall = step([drone(A, 0.5, [RAT])], [], emptyCompanionDroneRotation(), T0);
  const flying = step([drone(A, 0.4, [RAT, OTHER_RAT])], [], recall.memory, T0 + 500);
  assert.deepEqual(flying.memory.homeward[0]?.attackers, [RAT, OTHER_RAT]);
  const aboard = step([], [singleton(A)], flying.memory, T0 + 1_000,
    [{ itemID: RAT, targetEntityID: A }, { itemID: OTHER_RAT, targetEntityID: A }]);
  assert.deepEqual(aboard.action, { kind: "none" });
  const half = step([], [singleton(A)], aboard.memory, T0 + 2_000,
    [{ itemID: RAT, targetEntityID: SHIP }, { itemID: OTHER_RAT, targetEntityID: A }]);
  assert.deepEqual(half.action, { kind: "none" }, "one rat moved on, the other has not");
});

test("a recall comes first: the tick that sees a new hurt drone does not also launch", () => {
  const memory = landed([A], [], [], T0);
  const out = step([drone(B, 0.5)], [singleton(A)], memory, T0 + 1_000 + BLIND_HOLD_MS);
  assert.deepEqual(out.action, { kind: "recall", droneIDs: [B] });
  const next = step([drone(B, 0.5)], [singleton(A)], out.memory, T0 + 1_500 + BLIND_HOLD_MS);
  assert.equal(next.action.kind, "launch");
});

test("a launch is over once its stack gave a drone up", () => {
  const bay = [{ itemID: STACK, typeID: HAMMERHEAD, quantity: 3 }];
  const memory = landed([A], [RAT], bay, T0);
  const sent = step([], [...bay, singleton(A)], memory, T0 + 1_500);
  assert.equal(rotationBusy(sent.memory), true);
  const done = step([drone(C)], [{ itemID: STACK, typeID: HAMMERHEAD, quantity: 2 }, singleton(A)], sent.memory, T0 + 2_500);
  assert.equal(rotationBusy(done.memory), false);
});

test("a spare that never left the bay falls back to the drone itself", () => {
  const bay = [{ itemID: STACK, typeID: HAMMERHEAD, quantity: 3 }];
  const memory = landed([A], [RAT], bay, T0);
  const sent = step([], [...bay, singleton(A)], memory, T0 + 1_500);
  const waiting = step([], [...bay, singleton(A)], sent.memory, T0 + 1_500 + RELAUNCH_WAIT_MS - 1);
  assert.deepEqual(waiting.action, { kind: "none" });
  const fallback = step([], [...bay, singleton(A)], waiting.memory, T0 + 1_500 + RELAUNCH_WAIT_MS);
  assert.equal(fallback.action.kind, "launch");
  if (fallback.action.kind !== "launch") return;
  assert.deepEqual(fallback.action.droneItemIDs, [A], "not the same refused stack again");
  // And if that does not land either, the machine lets go.
  const gaveUp = step([], [...bay, singleton(A)], fallback.memory, T0 + 1_500 + 2 * RELAUNCH_WAIT_MS);
  assert.equal(rotationBusy(gaveUp.memory), false);
});

test("a drone that dies on its way home is written off after DEAD_DRONE_TICKS readable ticks", () => {
  let memory = step([drone(A, 0.2)], [], emptyCompanionDroneRotation(), T0).memory;
  for (let n = 1; n < DEAD_DRONE_TICKS; n += 1) {
    memory = step([], [], memory, T0 + n * 500).memory;
    assert.equal(rotationBusy(memory), true);
  }
  memory = step([], [], memory, T0 + DEAD_DRONE_TICKS * 500).memory;
  assert.equal(rotationBusy(memory), false);
  assert.equal(memory.rotations[String(A)], 1, "the rotation stays booked");
});

test("a tick that cannot see the bay never writes a drone off", () => {
  let memory = step([drone(A, 0.2)], [], emptyCompanionDroneRotation(), T0).memory;
  for (let n = 1; n <= DEAD_DRONE_TICKS + 2; n += 1) {
    memory = step([], null, memory, T0 + n * 500).memory;
  }
  assert.equal(memory.homeward.length, 1);
});

// The order may simply have been lost, so it is asked again -- as a new
// rotation, which the cap bounds.
test("a recall that never lands is given up after RECALL_GIVE_UP_MS and asked again", () => {
  const first = step([drone(A, 0.5)], [], emptyCompanionDroneRotation(), T0);
  const still = step([drone(A, 0.4)], [], first.memory, T0 + RECALL_GIVE_UP_MS - 1);
  assert.deepEqual(still.action, { kind: "none" });
  const again = step([drone(A, 0.4)], [], still.memory, T0 + RECALL_GIVE_UP_MS);
  assert.deepEqual(again.action, { kind: "recall", droneIDs: [A] });
  assert.equal(again.memory.rotations[String(A)], 2);
});

test("past MAX_DRONE_ROTATIONS a drone fights on, and another is still pulled", () => {
  const memory: CompanionDroneRotationMemory = {
    ...emptyCompanionDroneRotation(),
    rotations: { [String(A)]: MAX_DRONE_ROTATIONS },
  };
  const capped = step([drone(A, 0.3)], [], memory, T0);
  assert.deepEqual(capped.action, { kind: "none" });
  assert.equal(capped.reason, "capped");
  const other = step([drone(A, 0.3), drone(B, 0.9)], [], memory, T0);
  assert.deepEqual(other.action, { kind: "recall", droneIDs: [B] });
});

test("a mangled record reads as an empty one, never a throw", () => {
  assert.deepEqual(readCompanionDroneRotation(null), emptyCompanionDroneRotation());
  assert.deepEqual(readCompanionDroneRotation({ homeward: [{ itemID: "x" }], aboard: 3, rotations: { a: -1 } }), emptyCompanionDroneRotation());
  // The block's old record shape is not this one: it is dropped, not misread.
  assert.equal(rotationBusy(readCompanionDroneRotation({ active: { itemID: A, phase: "recalling" }, rotations: {} })), false);
});

test("the record survives a JSON round trip unchanged", () => {
  const memory = landed([A, B], [], [], T0);
  assert.deepEqual(readCompanionDroneRotation(JSON.parse(JSON.stringify(memory))), memory);
});
