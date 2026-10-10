// R102 Phase-4 bound entity drone-command write-ack decoder tests — WB-ENTITY
// (CmdReturnHome / CmdSalvage / CmdAbandonDrone / CmdReconnectToDrones). PLUMBING
// ONLY. None fired live.

import test from "node:test";
import assert from "node:assert/strict";

import { decodeEntityDroneWriteAck, salvageWithDrones } from "./boundEntityWrites.ts";
import type { JsonValue } from "./wire.ts";

function plainAck(fields: Record<string, JsonValue>): JsonValue {
  return { ...fields };
}

test("R102 — a per-drone multi-result dict is carried through untouched", () => {
  const multi: JsonValue = {
    type: "object",
    name: "util.KeyVal",
    args: {
      type: "dict",
      entries: [["9000000001", { type: "list", items: ["returned"] }]],
    },
  };
  const ack = decodeEntityDroneWriteAck(plainAck({ ok: true, applied: true, result: multi }));
  assert.equal(ack.applied, true);
  assert.deepEqual(ack.result, multi);
});

test("R102 — a null-returning drone command decodes to {ok, applied, result:null}", () => {
  const ack = decodeEntityDroneWriteAck(plainAck({ ok: true, applied: true, result: null }));
  assert.deepEqual(ack, { ok: true, applied: true, result: null });
});

test("R102 — a refused (unconfirmed) drone command is not-applied, not a throw", () => {
  const ack = decodeEntityDroneWriteAck(plainAck({ ok: true, applied: false }));
  assert.equal(ack.ok, true);
  assert.equal(ack.applied, false);
  assert.equal(ack.result, null);
});

// droneFunctions.py 156 to 161: Salvage(droneIDs) is eveMoniker.GetEntityAccess().CmdSalvage(droneIDs, targetID),
// the target the active one, or None where the pilot has nothing targeted.

test("drones are sent to salvage by the entity's CmdSalvage: the drones, and the wreck", async () => {
  const asked: unknown[] = [];
  await salvageWithDrones(async (service, method, args) => { asked.push([service, method, args]); return null; }, [9988400023500, 9988400023501], 9001);
  assert.deepEqual(asked, [["entity", "CmdSalvage", [[9988400023500, 9988400023501], 9001]]]);
});

test("with no wreck named it is the client's None, and nought is none", async () => {
  const asked: unknown[] = [];
  const act = async (service: string, method: string, args: readonly JsonValue[]) => { asked.push([service, method, args]); return null; };
  await salvageWithDrones(act, [9988400023500], null);
  await salvageWithDrones(act, [9988400023500], 0);
  assert.deepEqual(asked, [["entity", "CmdSalvage", [[9988400023500], null]], ["entity", "CmdSalvage", [[9988400023500], null]]]);
});

test("with no drones nothing is asked", async () => {
  // The client's own callers never order none: the menu names one drone, and the primary action only what it found.
  let asked = 0;
  assert.equal(await salvageWithDrones(async () => { asked += 1; return null; }, [], 9001), null);
  assert.equal(asked, 0);
});

test("what the server says of each drone is handed on as it came, and a refusal fails as the call fails", async () => {
  // The answer is the drones that could not do it, each with why: none where every drone went.
  const failures: JsonValue = { type: "dict", entries: [[9988400023500, ["No salvageable wreck owned by you or a fleet member is available.", { type: "dict", entries: [] }]]] };
  assert.deepEqual(await salvageWithDrones(async () => failures, [9988400023500], null), failures);
  await assert.rejects(() => salvageWithDrones(async () => { throw new Error("the pilot is docked"); }, [9988400023500], null), /docked/);
});
