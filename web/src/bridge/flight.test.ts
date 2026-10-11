// The R5a flight-status decoder: plain scalars and long-aware IDs
// (docs/bridge-wire-contract.md decoder rule). Proves the docked/in-space
// derivation and that {type:"long"} ID wrappers decode instead of zeroing.

import test from "node:test";
import assert from "node:assert/strict";

import { decodeFlightStatus } from "./flight.ts";

test("decodes an in-space snapshot (plain scalars)", () => {
  const status = decodeFlightStatus({
    inSpace: true,
    docked: false,
    solarSystemID: 30000142,
    stationID: null,
    structureID: null,
    shipID: 9988400022009,
    shipMode: "WARP",
    shipSpeedFraction: 1,
  });
  assert.equal(status.inSpace, true);
  assert.equal(status.docked, false);
  assert.equal(status.solarSystemID, 30000142);
  assert.equal(status.stationID, null);
  assert.equal(status.shipID, 9988400022009);
  assert.equal(status.shipMode, "WARP");
  assert.equal(status.shipSpeedFraction, 1);
});

test("decodes a docked snapshot", () => {
  const status = decodeFlightStatus({
    inSpace: false,
    docked: true,
    solarSystemID: 30000142,
    stationID: 60003760,
    structureID: null,
    shipID: 9988400022009,
    shipMode: null,
    shipSpeedFraction: null,
  });
  assert.equal(status.inSpace, false);
  assert.equal(status.docked, true);
  assert.equal(status.stationID, 60003760);
  assert.equal(status.shipMode, null);
  assert.equal(status.shipSpeedFraction, null);
});

test("is long-aware: {type:'long'} ID wrappers decode instead of zeroing", () => {
  const status = decodeFlightStatus({
    inSpace: true,
    docked: false,
    // A forwarded OnSessionChanged carries long-encoded IDs; the decoder must
    // unwrap them, not fall back to 0/null.
    solarSystemID: { type: "long", value: 30000140 },
    shipID: { type: "long", value: "9988400022009" },
    shipMode: "STOP",
  });
  assert.equal(status.solarSystemID, 30000140);
  assert.equal(status.shipID, 9988400022009);
});

test("derives docked when the gateway omits the explicit flag", () => {
  const inSpace = decodeFlightStatus({ inSpace: true, stationID: null });
  assert.equal(inSpace.docked, false);
  const docked = decodeFlightStatus({ inSpace: false, stationID: 60003760 });
  assert.equal(docked.docked, true);
  const nowhere = decodeFlightStatus({ inSpace: false, stationID: null, structureID: null });
  assert.equal(nowhere.docked, false);
});

test("tolerates a malformed/empty snapshot", () => {
  const status = decodeFlightStatus(null);
  assert.equal(status.inSpace, false);
  assert.equal(status.docked, false);
  assert.equal(status.solarSystemID, null);
  assert.equal(status.shipID, null);
  assert.equal(status.shipMode, null);
});

test("decodes readiness separately from the next session-change cooldown", () => {
  const status = decodeFlightStatus({
    inSpace: true,
    shipID: 9001,
    transition: {
      epoch: 4,
      kind: "stargate",
      phase: "session-changing",
      cooldownUntilMs: 123_456,
      fromSolarSystemID: 30000142,
      toSolarSystemID: null,
      stationID: null,
      shipID: 9001,
      sessionStable: false,
      locationReady: true,
      sceneReady: false,
      egoReady: false,
      shipReady: true,
      boundContextReady: false,
      failure: null,
    },
  });
  assert.equal(status.transition?.epoch, 4);
  assert.equal(status.transition?.cooldownUntilMs, 123_456);
  assert.equal(status.transition?.locationReady, true);
  assert.equal(status.transition?.sceneReady, false);
  assert.equal(status.transition?.sessionStable, false);
});

test("the hull's group is the flight's where the BFF says it, and not known where it does not", () => {
  // station.CreateNewbieShip (base.py 604 to 607) goes by the group of godma's own ship item: a corvette's is 237.
  const of = (more: Record<string, unknown>) => decodeFlightStatus({ inSpace: false, docked: true, stationID: 60003760, shipID: 9001, ...more } as never).shipGroupID;
  assert.deepEqual([of({ shipGroupID: 237 }), of({ shipGroupID: { type: "long", value: "25" } }), of({}), of({ shipGroupID: null }), of({ shipGroupID: "a corvette" })], [237, 25, null, null, null]);
  assert.equal(decodeFlightStatus(undefined).shipGroupID, null);
});
