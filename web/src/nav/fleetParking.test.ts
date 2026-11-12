import test from "node:test";
import assert from "node:assert/strict";
import { parkingScript, runFleetParking, type FleetParkingPolicy } from "./fleetParking.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { MiningHold, FlightStatus } from "../store/types.ts";
import type { ScriptRunnerDeps } from "./scriptRunner.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import { decideScriptAction, initialMemory, type ScriptAction } from "./scriptDecide.ts";
import { decodeScriptValue } from "../bots/scriptCodec.ts";

const policy: FleetParkingPolicy = { mode: "RETURN_HOME_UNLOAD_DOCK",
  destination: { stationID: 60003760, stationName: "Home", systemName: "Jita" }, corporationDivision: 1 };
function observation(docked: boolean, holds: readonly MiningHold[] | null, structure = false): ScriptObservation {
  return { inSpace: !docked, docked, inWarp: false, health: 1, shieldRatio: 1, armorRatio: 1, hullRatio: 1,
    hostileOnGrid: false, dronesOut: false, oreHoldFraction: 0, holdEmpty: false, snapshot: null,
    holds, lockedTargetIDs: [], miningModuleIDs: [], droneBayItemIDs: [], startingStationID: 12345,
    flightStatus: { docked, inSpace: !docked, stationID: docked && !structure ? 60003760 : null,
      structureID: docked && structure ? 1030000000001 : null, shipID: 9, shipIsCapsule: false } as FlightStatus,
    miningDrones: { bay: [], out: [], roles: {}, maxActive: 5 },
    // Normal operation is STOPPING and may have no target. Only the fixed,
    // trusted parking program is allowed to travel in this situation.
    miningOperationRequired: true, miningOperation: { operationID: "A", operationName: "Fleet", role: "MINER", state: "STOPPING", stopRequested: true,
      unloadPolicy: "HAULER_SERVICE", area: { anchorSystemID: 30000142, anchorSystemName: "Jita", reach: "CURRENT_SYSTEM", targetClasses: ["BELT"] },
      currentTarget: null, logisticsTarget: null, rendezvous: null },
  };
}
function hold(key: "ore" | "cargo", id: number, categoryID: number): MiningHold {
  return { key, label: key, present: true, error: null, capacity: null, items: [{ itemID: id, typeID: 1, quantity: 2, groupID: 1, categoryID }] };
}
function harness(options: { badHold?: boolean; refuseTravel?: boolean; refuseUnload?: boolean; initiallyDocked?: boolean; structure?: boolean; family?: "ORE_ANOMALY" | "ICE" } = {}) {
  let docked = !!options.initiallyDocked;
  let holds = [hold("ore", 10, 25), hold("cargo", 20, 7)];
  if (options.family === "ICE") holds[0] = { ...holds[0]!, key: "ice", items: [{ itemID: 10, typeID: 16265, categoryID: 25, groupID: 465, quantity: 2 }] };
  let reads = 0;
  const actions: ScriptAction[] = [];
  const deps: ScriptRunnerDeps = {
    observe: async () => {
      if (++reads > 160) throw new Error("test exceeded bounded runner attempts");
      const obs = observation(docked, options.badHold ? null : holds, options.structure);
      if (options.family) Object.assign(obs, { miningOperation: { ...obs.miningOperation!, area: { ...obs.miningOperation!.area, targetClasses: [options.family] } } });
      return options.refuseTravel ? { ...obs, travel: { status: "paused", destinationStationID: 60003760, failureReason: "Dock refused", remainingJumps: 0 } } : obs;
    },
    issue: async action => {
      actions.push(action);
      if (action.kind === "startRoute") { assert.equal(action.stationID, options.structure ? 1030000000001 : 60003760); docked = true; }
      if (action.kind === "unloadOre") {
        if (options.refuseUnload) throw new Error("No permission to unload");
        assert.equal(docked, true);
        holds = holds.map(row => ({ ...row, items: row.items!.filter(item => !action.itemIDs.includes(item.itemID)) }));
      }
    },
    sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false,
    refusalReason: error => String(error), registry: SCRIPT_MACROS,
    travelHome: () => { throw new Error("no alternate home must be used"); },
  };
  return { deps, actions, currentHolds: () => holds, reads: () => reads, docked: () => docked };
}

test("parking is a finite existing macro with explicit home, no starting station or mining selector", () => {
  assert.equal(decodeScriptValue(parkingScript(policy)).ok, true);
  assert.deepEqual(parkingScript(policy).program.map(row => row.kind === "macro" ? row.macro : null), ["deliver-ore"]);
  assert.throws(() => parkingScript({ ...policy, destination: null! }), /explicit dockable destination/);
});

test("player-structure parking uses the same finite route and proves structureID on arrival", async () => {
  const destination = { kind: "structure" as const, id: 1030000000001, name: "My Astrahus",
    solarSystemID: 30000142, solarSystemName: "Jita" };
  const dockOnly: FleetParkingPolicy = { mode: "RETURN_HOME_DOCK", destination, corporationDivision: null };
  assert.equal(decodeScriptValue(parkingScript(dockOnly)).ok, true);
  assert.equal(parkingScript(dockOnly).home.entity, "structure");
  const h = harness({ structure: true });
  await runFleetParking(h.deps, dockOnly, Date.now() + 60_000, () => {});
  assert.deepEqual(h.actions.map(action => action.kind), ["startRoute"]);
  const unload: FleetParkingPolicy = { ...dockOnly, mode: "RETURN_HOME_UNLOAD_DOCK" };
  const u = harness({ structure: true });
  await runFleetParking(u.deps, unload, Date.now() + 60_000, () => {});
  assert.deepEqual(u.actions.map(action => action.kind), ["startRoute", "unloadOre"]);
  const strict = parkingScript({ ...unload, corporationDivision: 1 });
  assert.equal(decodeScriptValue(strict).ok, true);
  const corp = harness({ structure: true });
  await runFleetParking(corp.deps, { ...unload, corporationDivision: 1 }, Date.now() + 60_000, () => {});
  assert.deepEqual(corp.actions.at(-1), { kind: "unloadOre", itemIDs: [10], division: 1, strictCorp: true,
    expectedDestination: { kind: "structure", id: destination.id } });
});

test("return, dock, unload only existing freight, confirm empty freight, remain docked", async () => {
  const h = harness();
  await runFleetParking(h.deps, policy, Date.now() + 60_000, () => {});
  assert.deepEqual(h.actions, [{ kind: "startRoute", stationID: 60003760 }, { kind: "unloadOre", itemIDs: [10], division: 1, strictCorp: true,
    expectedDestination: { kind: "station", id: 60003760 } }]);
  assert.equal(h.docked(), true);
  assert.deepEqual(h.currentHolds()[1]!.items?.map(row => row.itemID), [20], "cargo ammunition stays aboard a hull with ore hold");
  assert.deepEqual(h.currentHolds()[0]!.items, []);
});

for (const family of ["ORE_ANOMALY", "ICE"] as const) {
  test(`${family}: Parking returns to the explicit station, optionally delivers freight, never reserves a target`, async () => {
    for (const mode of ["RETURN_HOME_DOCK", "RETURN_HOME_UNLOAD_DOCK"] as const) {
      const h = harness({ family });
      await runFleetParking(h.deps, { ...policy, mode }, Date.now() + 60_000, () => {});
      assert.deepEqual(h.actions.map(a => a.kind), mode === "RETURN_HOME_DOCK" ? ["startRoute"] : ["startRoute", "unloadOre"]);
      assert.deepEqual(h.currentHolds()[1]!.items?.map(item => item.itemID), [20]);
      assert.equal(h.docked(), true);
    }
  });
}

test("dock-only does not unload and already parked does not undock", async () => {
  for (const initiallyDocked of [false, true]) {
    const h = harness({ initiallyDocked });
    await runFleetParking(h.deps, { ...policy, mode: "RETURN_HOME_DOCK" }, Date.now() + 60_000, () => {});
    assert.deepEqual(h.actions.map(row => row.kind), initiallyDocked ? [] : ["startRoute"]);
    assert.equal(h.currentHolds()[0]!.items?.length, 1);
  }
});

test("unreadable holds, travel refusal, and unload refusal never report successful parking", async () => {
  for (const options of [{ initiallyDocked: true, badHold: true }, { refuseTravel: true }, { refuseUnload: true }]) {
    const h = harness(options);
    await assert.rejects(runFleetParking(h.deps, policy, Date.now() + 60_000, () => {}));
    assert.ok(h.reads() <= 160);
    assert.ok(h.actions.every(row => row.kind === "startRoute" || row.kind === "unloadOre"));
  }
});

test("expired grant prevents parking movement; no new indefinite retry or polling loop", async () => {
  const h = harness();
  await assert.rejects(runFleetParking(h.deps, policy, 100, () => {}, () => 101), /approved run deadline/);
  assert.equal(h.reads(), 0);
  assert.deepEqual(h.actions, []);
});

test("ordinary operation runner stops before any macro decision or independent target fallback", () => {
  const doc = parkingScript(policy);
  const obs = observation(false, []);
  const result = decideScriptAction(doc, obs, initialMemory(doc), { "deliver-ore": () => { throw new Error("must not be called"); } }, () => { throw new Error("no fallback"); });
  assert.equal(result.action.kind, "wait");
  assert.equal(result.phase, "Stopping operation");
});
