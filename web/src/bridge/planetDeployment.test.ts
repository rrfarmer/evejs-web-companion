import assert from "node:assert/strict";
import test from "node:test";
import { abandonmentBasis, deploymentLocationError, findCommandCenterSource, localPlanetSurface } from "./planetDeployment.ts";
import { decodeColonyReport } from "./planets.ts";
import { abandonPlanet, deployCommandCenter } from "./planetWrites.ts";
import { decodeShipBays } from "./shipBays.ts";
import { decodeFlightStatus } from "./flight.ts";
import type { Ask } from "./ask.ts";

const planetID = 40009082;
const systemID = 30000142;
const shipID = 9988400004455;
const typeID = 2534;

test("deployment checks the active flight and uses the matching source item in native hold order", () => {
  const flight = decodeFlightStatus({ inSpace: true, docked: false, shipID, solarSystemID: systemID, shipIsCapsule: false });
  assert.equal(deploymentLocationError(flight, systemID), "");
  assert.match(deploymentLocationError({ ...flight, docked: true }, systemID), /in space/);
  assert.match(deploymentLocationError({ ...flight, shipIsCapsule: true }, systemID), /aboard a ship/);
  assert.match(deploymentLocationError(flight, systemID + 1), /solar system/);
  const bays = decodeShipBays([
    { key: "cargo", label: "Cargo", present: true, items: [{ itemID: 20, typeID, quantity: 3 }] },
    { key: "colony", label: "Colony resources hold", present: true, items: [{ itemID: 30, typeID, quantity: 1 }] },
    { key: "commandCenter", label: "Command center hold", present: true, items: [
      { itemID: 40, typeID: 2524, quantity: 2 }, { itemID: 41, typeID, quantity: 1 },
    ] },
  ]);
  assert.deepEqual(findCommandCenterSource(typeID, shipID, bays), { itemID: 41, typeID, shipID, hold: "Command center hold" });
  assert.equal(findCommandCenterSource(typeID, shipID, bays.slice(0, 2))?.itemID, 30);
  assert.equal(findCommandCenterSource(typeID, shipID, bays.slice(0, 1))?.itemID, 20);
  assert.equal(findCommandCenterSource(2551, shipID, bays), null);
});

test("the empty view is restricted to the current system and abandonment compares network revisions", () => {
  const row = { planetID, planetName: "Jita IV", planetTypeID: 13, solarSystemID: systemID };
  assert.equal(localPlanetSurface({ planets: [row] }, planetID, systemID + 1), undefined);
  assert.deepEqual(localPlanetSurface({ planets: [row] }, planetID, systemID)?.pins, []);
  const colony = decodeColonyReport({ coloniesReadable: true, colonies: [{
    ...row, pins: [{ pinID: 41, typeID, kind: "command", latitude: 1, longitude: 2 }],
  }] }, 0).colonies[0]!;
  const old = abandonmentBasis(colony);
  assert.equal(abandonmentBasis({ ...colony, lastSimulatedAtMs: 500 }), old);
  assert.notEqual(abandonmentBasis({ ...colony, commandCenterLevel: 2 }), old);
  assert.notEqual(abandonmentBasis({ ...colony, pins: [] }), old);
});

test("deployment sends the real item ID and abandonment uses its own no-argument call", async () => {
  const calls: unknown[][] = [];
  const act: Ask = async (...args) => { calls.push(args); return null; };
  await deployCommandCenter(act, planetID, { latitude: 1, longitude: 2, source: { itemID: 41, typeID, shipID, hold: "Cargo" } });
  await abandonPlanet(act, planetID);
  assert.deepEqual(calls, [
    ["planetMgr", "UserUpdateNetwork", [[[1, [41, typeID, 1, 2]]]], null, planetID],
    ["planetMgr", "UserAbandonPlanet", [], null, planetID],
  ]);
});
