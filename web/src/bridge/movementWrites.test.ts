// A ship sent to a point in space by the page itself, held to the ship and the system the point was measured in.

import test from "node:test";
import assert from "node:assert/strict";

import { goToPoint, type FlightNow } from "./movementWrites.ts";

const [SHIP, SYSTEM] = [9988400023309, 30000144];
const POINT = { x: 1000, y: -2500.5, z: 300000000000 };
const MEASURED = { shipID: SHIP, solarSystemID: SYSTEM };
const HERE: FlightNow = { inSpace: true, shipID: SHIP, solarSystemID: SYSTEM };

/** An asker and a reader of the pilot's flight that say what was done, in order. */
function harness(now: FlightNow | Error = HERE, refusal: Error | null = null) {
  const did: string[] = [];
  const asked: unknown[][] = [];
  const act = async (service: string, method: string, args: readonly unknown[], kwargs?: unknown) => {
    did.push("sent");
    asked.push([service, method, args, kwargs ?? null]);
    if (refusal) throw refusal;
    return null;
  };
  const flightNow = async (): Promise<FlightNow> => {
    did.push("read");
    if (now instanceof Error) throw now;
    return now;
  };
  return { did, asked, act, flightNow };
}

test("the point's three go to beyonce's CmdGotoPoint, once the pilot's flight has been read", async () => {
  const { did, asked, act, flightNow } = harness();

  await goToPoint(act, flightNow, POINT, MEASURED);

  // movementFunctions.py 324: bp.CmdGotoPoint(*position), and nothing else.
  assert.deepEqual(asked, [["beyonce", "CmdGotoPoint", [1000, -2500.5, 300000000000], null]]);
  assert.deepEqual(did, ["read", "sent"]);
});

test("a point measured for another ship is not flown to", async () => {
  const { did, act, flightNow } = harness({ ...HERE, shipID: SHIP + 1 });

  await assert.rejects(goToPoint(act, flightNow, POINT, MEASURED), /The observed movement ship changed\./);
  assert.deepEqual(did, ["read"]);
});

test("nor one measured in another system", async () => {
  const { did, act, flightNow } = harness({ ...HERE, solarSystemID: SYSTEM + 1 });

  await assert.rejects(goToPoint(act, flightNow, POINT, MEASURED), /The measured movement system changed\./);
  assert.deepEqual(did, ["read"]);
});

test("nothing is sent for a pilot that is not in space", async () => {
  const { did, act, flightNow } = harness({ ...HERE, inSpace: false });

  await assert.rejects(goToPoint(act, flightNow, POINT, MEASURED), /The ship is not in space; undock first\./);
  assert.deepEqual(did, ["read"]);
});

test("a ship or a system that is not known now is not taken for the measured one", async () => {
  for (const now of [{ ...HERE, shipID: null }, { ...HERE, solarSystemID: null }]) {
    const { did, act, flightNow } = harness(now);
    await assert.rejects(goToPoint(act, flightNow, POINT, MEASURED), /changed\./);
    assert.deepEqual(did, ["read"]);
  }
});

test("what is no point, or no ship or system, never leaves: nothing is read either", async () => {
  const bad: [typeof POINT, typeof MEASURED][] = [
    [{ ...POINT, x: Number.NaN }, MEASURED],
    [{ ...POINT, y: Number.POSITIVE_INFINITY }, MEASURED],
    [{ ...POINT, z: Number.NEGATIVE_INFINITY }, MEASURED],
    [POINT, { ...MEASURED, shipID: 0 }],
    [POINT, { ...MEASURED, shipID: 1.5 }],
    [POINT, { ...MEASURED, solarSystemID: -1 }],
    [POINT, { ...MEASURED, solarSystemID: Number.NaN }],
  ];
  for (const [point, measured] of bad) {
    const { did, act, flightNow } = harness();
    await assert.rejects(goToPoint(act, flightNow, point, measured), /Unknown movement geometry or scope\./, JSON.stringify([point, measured]));
    assert.deepEqual(did, []);
  }
});

test("a flight that cannot be read sends nothing, and the failure is the caller's", async () => {
  const { did, act, flightNow } = harness(new Error("the session was lost"));

  await assert.rejects(goToPoint(act, flightNow, POINT, MEASURED), /the session was lost/);
  assert.deepEqual(did, ["read"]);
});

test("the call's refusal is the caller's, as it came", async () => {
  const { did, act, flightNow } = harness(HERE, new Error("You are warping."));

  await assert.rejects(goToPoint(act, flightNow, POINT, MEASURED), /You are warping\./);
  assert.deepEqual(did, ["read", "sent"]);
});
