import test from "node:test";
import assert from "node:assert/strict";
import type { BotScript } from "../../../web/src/bots/botScript.ts";
import type { SpaceEntity, SpaceSnapshot } from "../../../web/src/store/types.ts";
import type { ScriptObservation } from "../../../web/src/nav/scriptConditions.ts";
import type { ScriptAction } from "../../../web/src/nav/scriptDecide.ts";
import { MACROS as SCRIPT_MACROS } from "./harness.ts";
import { scriptTravelHome } from "../../../web/src/nav/scriptMacros.ts";
import { createScriptRunner } from "../../../web/src/nav/scriptRunner.ts";
import { refusalKey } from "../../../web/src/nav/refusalLedger.ts";

const HOME = 60000004;
const SHIP = 9001;
const FIRST_RAT = 6661;
const SECOND_RAT = 6662;
const ORIGIN = { x: 0, y: 0, z: 0 };

function rat(itemID: number, x: number): SpaceEntity {
  return {
    itemID, kind: "ship", typeID: 1, groupID: 1, categoryID: 6, name: "Rat", ownerID: null,
    radius: 10, position: { x, y: 0, z: 0 }, velocity: ORIGIN, isSelf: false,
    shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: null, beltID: null, oreGrade: null,
    oreValuePerM3: null, isNpc: true, npcEntityType: "npc",
    controllerID: null, droneActivity: null, targetEntityID: null,
  };
}

const scene: SpaceSnapshot = {
  inSpace: true, solarSystemID: 30000142, shipID: SHIP, sampledAtMs: 1,
  entities: [rat(FIRST_RAT, 5000), rat(SECOND_RAT, 10000)],
  ship: {
    itemID: SHIP, typeID: 17476, name: "Procurer", mode: null, maxVelocity: 100, radius: 100,
    position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
    shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
    overloadedModuleIDs: null, moduleDamage: null, weaponBanks: null,
  },
};

test("boarding a planetary hauler bounds refused escape locks under its step and continues after docking", async () => {
  let observation: ScriptObservation = {
    inSpace: true, docked: false, inWarp: false, health: 1,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, oreHoldFraction: 0, holdEmpty: true,
    hostileOnGrid: true, dronesOut: false,
    flightStatus: {
      inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null,
      shipID: SHIP, shipTypeID: 17476, shipIsCapsule: false, shipMode: null, shipSpeedFraction: null,
    },
    activeShipID: SHIP, planetaryHaulerShipIDs: [], startingStationID: HOME, homeStationID: HOME,
    travel: {
      status: "paused", destinationStationID: HOME, remainingJumps: 2,
      failureReason: "Warp refused: you are being warp scrambled.",
    },
    weaponModuleIDs: [500], hardenerModuleIDs: [], miningModuleIDs: [],
    combatDroneIDs: [], combatDroneBayItemIDs: [], droneBayItemIDs: [],
    lockedTargetIDs: [], maxTargetRangeM: 40000, holds: null, snapshot: scene, systemName: "Test System",
  };
  const doc: BotScript = {
    format: "evejs-bot-script", version: 1, name: "Recover the hauler", notes: "",
    home: { entity: "station", id: HOME, name: "Home", systemName: null }, interrupts: [],
    program: [
      { id: "board-hauler", kind: "macro", macro: "pi-manager:board-hauler", args: {} },
      { id: "after-hauler", kind: "macro", macro: "wait", args: { seconds: { kind: "count", value: 500 } } },
    ],
  };
  const issued: ScriptAction[] = [];
  const said: string[] = [];
  const visited: (string | null)[] = [];
  const runner = createScriptRunner({
    observe: async () => observation,
    issue: async action => {
      issued.push(action);
      if (action.kind === "lock" && action.targetID === FIRST_RAT) {
        throw Object.assign(new Error("TargetNotWithinRangeGeneric"), { code: "CALL_REFUSED" });
      }
      if (action.kind === "lock") observation = { ...observation, lockedTargetIDs: [action.targetID] };
    },
    sleep: async () => {},
    onProgress: state => {
      if (state.why !== null) said.push(state.why);
      visited.push(state.stepPath);
    },
    isSessionLost: () => false,
    refusalReason: error => error instanceof Error ? error.message : String(error),
    registry: SCRIPT_MACROS, travelHome: scriptTravelHome,
  });
  runner.start(doc);
  try {
    for (let i = 0; i < 220 && runner.getStatus() === "running" && !said.some(why => /would not lock/.test(why)); i++) {
      await runner.tick();
    }
    assert.ok(said.some(why => /would not lock/.test(why)), "escape recovery reaches its bounded lock wait");
    assert.equal(runner.getStatus(), "running", "one refusing rat must not stop the entire run");
    // The combat decider confirms a fresh refusal with one retry, then waits
    // for the lock outcome instead of exhausting the run's ten-refusal limit.
    assert.deepEqual(issued.filter(action => action.kind === "lock").map(action => action.targetID), [FIRST_RAT, FIRST_RAT]);
    assert.equal(runner.snapshot().stepPath, "board-hauler");
    assert.ok(!said.some(why => /Stopped after 10 refusals/.test(why)));
    assert.deepEqual(runner.snapshot().refusals.map(record => ({ key: record.key, count: record.count, targetID: record.targetID })), [
      { key: refusalKey("board-hauler", "lock", null), count: 2, targetID: FIRST_RAT },
    ]);

    observation = {
      ...observation, inSpace: false, docked: true, snapshot: null, stationHangar: [], planetaryHaulerShipIDs: [SHIP],
      flightStatus: { ...observation.flightStatus!, inSpace: false, docked: true, stationID: HOME },
    };
    for (let i = 0; i < 20 && runner.getStatus() === "running" && !visited.includes("after-hauler"); i++) {
      await runner.tick();
    }
    assert.ok(visited.includes("after-hauler"), "boarding completes and the following program step runs");
  } finally {
    runner.stop();
  }
});
