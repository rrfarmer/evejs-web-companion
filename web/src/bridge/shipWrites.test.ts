// A ship left by the page itself.

import test from "node:test";
import assert from "node:assert/strict";

import { leaveShip } from "./shipWrites.ts";

const SHIP = 9988400103291;

function harness(refusal: Error | null = null) {
  const asked: unknown[][] = [];
  const act = async (...call: unknown[]) => { asked.push(call); if (refusal) throw refusal; return null; };
  return { asked, act };
}

test("the ship is left by one call of the ship's own service: the ship, and nothing else", async () => {
  const { asked, act } = harness();

  await leaveShip(act, SHIP);

  // station.TryLeaveShip (248): gameui.GetShipAccess().LeaveShip(shipid).
  assert.deepEqual(asked, [["ship", "LeaveShip", [SHIP]]]);
});

test("a ship that is not known is not left: nothing is asked", async () => {
  for (const shipID of [0, -1, 1.5, Number.NaN]) {
    const { asked, act } = harness();
    await assert.rejects(leaveShip(act, shipID), /Which ship this is is not known yet\./, String(shipID));
    assert.deepEqual(asked, []);
  }
});

test("the call's refusal is the caller's, as it came", async () => {
  const { act } = harness(new Error("ShipCannotBeLeftHere"));

  await assert.rejects(leaveShip(act, SHIP), /ShipCannotBeLeftHere/);
});
