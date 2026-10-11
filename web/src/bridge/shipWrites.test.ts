// A ship left by the page itself.

import test from "node:test";
import assert from "node:assert/strict";

import { boardCorvette, GROUP_CORVETTE, leaveShip, type PilotsShip } from "./shipWrites.ts";

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

const DOCKED = 60003760;
/** A hull that is neither a capsule nor a corvette, docked. */
const IN_A_HULL: PilotsShip = { shipID: SHIP, dockedAt: DOCKED, groupID: 28, isCapsule: false };

/** The question the pilot is asked, answered as told; and how often it was asked. */
function pilotSays(answer: boolean) {
  const asked: string[] = [];
  return { asked, sure: async () => { asked.push("sure"); return answer; } };
}

test("a corvette is boarded by one call of dogmaIM by its name, once the pilot has said yes: the ship the pilot is in, and where it is docked", async () => {
  const { asked, act } = harness();
  const pilot = pilotSays(true);

  assert.equal(await boardCorvette(act, IN_A_HULL, pilot.sure), true);

  // station.CreateNewbieShip (613): sm.RemoteSvc('dogmaIM').CreateNewbieShip(shipID, locationID).
  assert.deepEqual(asked, [["dogmaIM", "CreateNewbieShip", [SHIP, DOCKED]]]);
  assert.deepEqual(pilot.asked, ["sure"]);
});

test("a pilot that says no boards nothing: nothing is asked of the server", async () => {
  const { asked, act } = harness();
  const pilot = pilotSays(false);

  assert.equal(await boardCorvette(act, IN_A_HULL, pilot.sure), false);

  assert.deepEqual([asked, pilot.asked], [[], ["sure"]]);
});

test("from a capsule the pilot is asked nothing; where it is not known whether the hull is one, the pilot is asked", async () => {
  // The gateway's flight says a capsule and not the hull's group: a capsule all the same.
  for (const [isCapsule, groupID, questions] of [[true, 29, []], [true, null, []], [null, null, ["sure"]], [false, null, ["sure"]], [null, 28, ["sure"]]] as const) {
    const { asked, act } = harness();
    const pilot = pilotSays(true);
    assert.equal(await boardCorvette(act, { ...IN_A_HULL, isCapsule, groupID }, pilot.sure), true);
    assert.deepEqual([asked, pilot.asked], [[["dogmaIM", "CreateNewbieShip", [SHIP, DOCKED]]], questions], `${isCapsule}, ${groupID}`);
  }
});

test("aboard a corvette nothing is asked, of the pilot or of the server", async () => {
  const { asked, act } = harness();
  const pilot = pilotSays(true);

  // station.CreateNewbieShip (606): IsNewbieShip(shipGroupID), refused by the client itself.
  assert.equal(GROUP_CORVETTE, 237);
  await assert.rejects(boardCorvette(act, { ...IN_A_HULL, groupID: GROUP_CORVETTE }, pilot.sure), /already aboard a corvette/);
  assert.deepEqual([asked, pilot.asked], [[], []]);
});

test("a pilot that is not docked, or whose ship is not known, boards nothing and is asked nothing", async () => {
  for (const [more, words] of [
    [{ dockedAt: null }, /docked/],
    [{ dockedAt: 0 }, /docked/],
    [{ dockedAt: 1.5 }, /docked/],
    // The client looks at where it is docked first (598 to 600), and at the ship after (601 to 603).
    [{ dockedAt: null, shipID: null }, /docked/],
    [{ shipID: null }, /Which ship this is is not known yet\./],
    [{ shipID: 0 }, /Which ship this is is not known yet\./],
    [{ shipID: 1.5 }, /Which ship this is is not known yet\./],
  ] as const) {
    const { asked, act } = harness();
    const pilot = pilotSays(true);
    await assert.rejects(boardCorvette(act, { ...IN_A_HULL, ...more }, pilot.sure), words, JSON.stringify(more));
    assert.deepEqual([asked, pilot.asked], [[], []], JSON.stringify(more));
  }
});

test("the corvette's refusal is the caller's, as it came", async () => {
  const { act } = harness(new Error("AlreadyInNewbieShip"));

  await assert.rejects(boardCorvette(act, IN_A_HULL, pilotSays(true).sure), /AlreadyInNewbieShip/);
});
