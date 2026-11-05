// The PI haul lap's new blocks: collect-launches (warp to each of the pilot's
// launch containers in this system, close in, empty it), board-previous-ship
// (go back to the hull refit-ship swapped out), refit-ship's note of that hull
// on the run's board, and unload-cargo's optional corporation division. Pure,
// over fixture observations - same idiom as scriptMacros.test.ts.

import test from "node:test";
import assert from "node:assert/strict";

import type { FlightStatus, SpaceEntity, SpaceShipStatus, SpaceSnapshot, SpaceVector, InventoryItemRow } from "../../../web/src/store/types.ts";
import type { MacroStep } from "../../../web/src/bots/botScript.ts";
import type { ScriptObservation } from "../../../web/src/nav/scriptConditions.ts";
import type { ScriptBoard } from "../../../web/src/nav/scriptDecide.ts";
import { MACROS as SCRIPT_MACROS } from "./harness.ts";
import { stepSentence } from "../../../web/src/bots/scriptText.ts";

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };
const SYSTEM = 30000142;
const DAY_MS = 24 * 60 * 60 * 1000;

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "container", typeID: 2263, groupID: 1, categoryID: 2, name: null, ownerID: null,
    radius: 10, position: ORIGIN, velocity: ORIGIN, isSelf: false,
    shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: null, beltID: null, oreGrade: null,
    oreValuePerM3: null, isNpc: false, npcEntityType: null,
    controllerID: null, droneActivity: null, targetEntityID: null,
    ...over,
  };
}

function ship(over: Partial<SpaceShipStatus> = {}): SpaceShipStatus {
  return {
    itemID: 9001, typeID: 650, name: "Epithal", mode: null, maxVelocity: 100, radius: 100,
    position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
    shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
    ...over,
  } as SpaceShipStatus;
}

function snapshot(entities: SpaceEntity[], shipOver: Partial<SpaceShipStatus> = {}): SpaceSnapshot {
  return { inSpace: true, solarSystemID: SYSTEM, shipID: 9001, sampledAtMs: 1, entities, ship: ship(shipOver) };
}

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return {
    inSpace: true, docked: false, solarSystemID: SYSTEM, stationID: null, structureID: null,
    shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null,
    ...over,
  };
}

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: flight(), snapshot: snapshot([]), lockedTargetIDs: [], holds: null,
    droneBayItemIDs: [], miningModuleIDs: [], startingStationID: null, systemName: "Test System",
    ...over,
  };
}

function docked(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return obs({
    inSpace: false, docked: true, snapshot: null,
    flightStatus: flight({ inSpace: false, docked: true, stationID: 60000004 }),
    ...over,
  });
}

function launch(over: Partial<NonNullable<ScriptObservation["piLaunches"]>[number]> = {}) {
  return {
    launchID: 7, solarSystemID: SYSTEM, planetID: 40000001, itemID: 80001,
    launchedAtMs: Date.now() - DAY_MS, x: 12_000_000, y: 0, z: 0,
    ...over,
  };
}

function invRow(over: Partial<InventoryItemRow> & { itemID: number }): InventoryItemRow {
  return { typeID: 34, groupID: null, categoryID: null, flagID: null, quantity: 1, singleton: false, ...over };
}

const NB: ScriptBoard = {};
const collect = SCRIPT_MACROS["collect-launches"]!;
const collectStep: MacroStep = { id: "cl", kind: "macro", macro: "pi-manager:collect-launches", args: {} };

// ── collect-launches ─────────────────────────────────────────────────────────

test("collect-launches: docked -> blocked, launches are collected in space", () => {
  const t = collect(collectStep, docked({ piLaunches: [launch()] }), {}, NB);
  assert.equal(t.outcome.kind, "blocked");
});

test("collect-launches: an unreadable launch list waits - never read as nothing to collect", () => {
  const t = collect(collectStep, obs({ piLaunches: null }), {}, NB);
  assert.equal(t.action.kind, "wait");
  assert.equal(t.outcome.kind, "acting");
});

test("collect-launches: no launch in this system is done, and says how many wait elsewhere", () => {
  const t = collect(collectStep, obs({ piLaunches: [launch({ solarSystemID: 30000144 })] }), {}, NB);
  assert.equal(t.outcome.kind, "done");
  assert.match(t.why, /1 more in other systems/);
});

// journal.py 453: the client's "warp to" on a launch is CmdWarpToStuff('launch', launchID). The container is on no
// grid the pilot is on, and the launch's own ID is the one thing of the client's that names where it is.
test("collect-launches: an off-grid container is warped to as the launch it is, by the launch's ID", () => {
  const t = collect(collectStep, obs({ piLaunches: [launch()] }), {}, NB);
  assert.deepEqual(t.action, { kind: "warpLaunch", launchID: 7 });
  // Remembered by the container's own ID, which is what shows on the grid once the ship lands.
  assert.equal(t.nextMem["warpingTo"], 80001);
});

test("collect-launches: a launch whose row has no launch ID is warped to as the item its container is", () => {
  const t = collect(collectStep, obs({ piLaunches: [launch({ launchID: 0 })] }), {}, NB);
  assert.deepEqual(t.action, { kind: "warp", targetID: 80001 });
  assert.equal(t.nextMem["warpingTo"], 80001);
});

test("collect-launches: a launch list that stays unreadable is waited on, then the block says so and stops", () => {
  let mem: Record<string, unknown> = {};
  const outcomes: string[] = [];
  for (let tickNumber = 0; tickNumber < 11; tickNumber += 1) {
    const t = collect(collectStep, obs({ piLaunches: null }), mem, NB);
    assert.equal(t.action.kind, "wait");
    outcomes.push(t.outcome.kind);
    if (t.outcome.kind === "blocked") assert.match(t.outcome.reason, /could not be read/);
    mem = t.nextMem;
  }
  assert.deepEqual(outcomes, [...Array(10).fill("acting"), "blocked"]);
});

test("collect-launches: drones out are called home before the warp", () => {
  const drone = entity({ itemID: 555, kind: "drone", controllerID: 9001 });
  const t = collect(collectStep, obs({ piLaunches: [launch()], dronesOut: true, snapshot: snapshot([drone]) }), {}, NB);
  assert.equal(t.action.kind, "recallDrones");
});

test("collect-launches: the nearest launch goes first", () => {
  const far = launch({ launchID: 1, itemID: 80001, x: 90_000_000 });
  const near = launch({ launchID: 2, itemID: 80002, x: 11_000_000 });
  const t = collect(collectStep, obs({ piLaunches: [far, near] }), {}, NB);
  assert.deepEqual(t.action, { kind: "warpLaunch", launchID: 2 });
  assert.equal(t.nextMem["warpingTo"], 80002);
});

test("collect-launches: on grid but outside loot range -> approach the container", () => {
  const can = entity({ itemID: 80001, position: { x: 20_000, y: 0, z: 0 } });
  const t = collect(
    collectStep,
    obs({ piLaunches: [launch({ x: 20_000 })], snapshot: snapshot([can]) }),
    {},
    NB,
  );
  assert.deepEqual(t.action, { kind: "approach", targetID: 80001 });
});

test("collect-launches: inside loot range -> collect, naming both the container and the launch", () => {
  const can = entity({ itemID: 80001, position: { x: 1_000, y: 0, z: 0 } });
  const t = collect(
    collectStep,
    obs({ piLaunches: [launch({ x: 1_000 })], snapshot: snapshot([can]) }),
    {},
    NB,
  );
  assert.deepEqual(t.action, { kind: "collectLaunch", containerID: 80001, launchID: 7 });
});

test("collect-launches: a container not found after landing is set aside, and the block goes on", () => {
  // Landed (a completed warp counted since the issue), the grid still empty.
  let mem: Record<string, unknown> = { issued: true, warpingTo: 80001, warpsAtIssue: 0, waited: 0, missing: [] };
  let t = collect(collectStep, obs({ piLaunches: [launch()], completedWarps: 1 }), mem as never, NB);
  for (let i = 0; i < 20 && t.action.kind === "wait" && t.outcome.kind === "acting"; i += 1) {
    mem = t.nextMem as never;
    if (Array.isArray(mem["missing"]) && (mem["missing"] as number[]).includes(80001)) break;
    t = collect(collectStep, obs({ piLaunches: [launch()], completedWarps: 1 }), mem as never, NB);
  }
  assert.deepEqual(t.nextMem["missing"], [80001]);
  const after = collect(collectStep, obs({ piLaunches: [launch()] }), t.nextMem, NB);
  assert.equal(after.outcome.kind, "done");
});

test("collect-launches: a launch past its five-day decay is not flown to", () => {
  const t = collect(collectStep, obs({ piLaunches: [launch({ launchedAtMs: Date.now() - 6 * DAY_MS })] }), {}, NB);
  assert.equal(t.outcome.kind, "done");
});

test("collect-launches: a full ship finishes the block so the lap can go and unload", () => {
  const full = [{ key: "planetary", label: "Planetary hold", items: [], capacity: { capacity: 1000, used: 1000 }, present: true, error: null }];
  const t = collect(collectStep, obs({ piLaunches: [launch()], holds: full as never }), {}, NB);
  assert.equal(t.outcome.kind, "done");
});

// ── refit-ship -> board-previous-ship ────────────────────────────────────────

const refit = SCRIPT_MACROS["refit-ship"]!;
const backAgain = SCRIPT_MACROS["board-previous-ship"]!;
const refitStep: MacroStep = {
  id: "r", kind: "macro", macro: "refit-ship",
  args: { fitting: { kind: "fitting", fittingID: 1, name: "PI hauler" } },
};
const backStep: MacroStep = { id: "b", kind: "macro", macro: "board-previous-ship", args: {} };
const hangar = [
  invRow({ itemID: 5001, typeID: 17476, categoryID: 6, singleton: true }),
  invRow({ itemID: 5002, typeID: 650, categoryID: 6, singleton: true }),
];
const fittings = [{ fittingID: 1, name: "PI hauler", shipTypeID: 650 }];

test("refit-ship: boarding a different hull notes the one it left on the run's board", () => {
  const t = refit(refitStep, docked({ stationHangar: hangar, activeShipID: 5001, savedFittings: fittings } as never), {}, NB);
  assert.deepEqual(t.action, { kind: "boardShip", shipID: 5002 });
  assert.deepEqual(t.boardPatch, { shipBeforeRefit: 5001 });
});

test("refit-ship: a second refit keeps the FIRST ship as the one to go back to", () => {
  const t = refit(refitStep, docked({ stationHangar: hangar, activeShipID: 5001, savedFittings: fittings } as never), {}, { shipBeforeRefit: 4000 });
  assert.equal(t.action.kind, "boardShip");
  assert.equal(t.boardPatch, undefined);
});

test("board-previous-ship: nothing noted -> done, there is nothing to go back to", () => {
  const t = backAgain(backStep, docked({ stationHangar: hangar, activeShipID: 5002 } as never), {}, NB);
  assert.equal(t.outcome.kind, "done");
});

test("board-previous-ship: not docked -> blocked", () => {
  const t = backAgain(backStep, obs(), {}, { shipBeforeRefit: 5001 });
  assert.equal(t.outcome.kind, "blocked");
});

test("board-previous-ship: boards the noted hull when it is parked here", () => {
  const t = backAgain(backStep, docked({ stationHangar: hangar, activeShipID: 5002 } as never), {}, { shipBeforeRefit: 5001 });
  assert.deepEqual(t.action, { kind: "boardShip", shipID: 5001 });
});

test("board-previous-ship: once aboard it is done and clears the note for the next lap", () => {
  const t = backAgain(backStep, docked({ stationHangar: hangar, activeShipID: 5001 } as never), {}, { shipBeforeRefit: 5001 });
  assert.equal(t.outcome.kind, "done");
  assert.deepEqual(t.boardPatch, { shipBeforeRefit: null });
});

test("board-previous-ship: the noted hull is not in this hangar -> blocked with where to dock", () => {
  const t = backAgain(backStep, docked({ stationHangar: [hangar[1]!], activeShipID: 5002 } as never), {}, { shipBeforeRefit: 5001 });
  assert.equal(t.outcome.kind, "blocked");
  assert.ok(t.outcome.kind === "blocked" && /dock where you reshipped/.test(t.outcome.reason));
});

// ── unload-cargo into a corporation division ────────────────────────────────

const unload = SCRIPT_MACROS["unload-cargo"]!;
const planetaryBay = [{ key: "planetary", label: "Planetary hold", present: true, items: [invRow({ itemID: 9100, typeID: 2393, quantity: 500 })], capacity: null, error: null }];

test("unload-cargo: with no division picked the action is exactly the old one", () => {
  const s: MacroStep = { id: "u", kind: "macro", macro: "unload-cargo", args: {} };
  const t = unload(s, docked({ cargo: { rows: [], capacity: null }, shipBays: planetaryBay } as never), {}, NB);
  assert.deepEqual(t.action, { kind: "unloadHolds", groups: [{ bay: "planetary", itemIDs: [9100] }] });
});

test("unload-cargo: a picked division is carried on the action", () => {
  const s: MacroStep = {
    id: "u", kind: "macro", macro: "unload-cargo",
    args: { into: { kind: "corpDivision", division: 3, name: "Industry" } },
  };
  const t = unload(s, docked({ cargo: { rows: [], capacity: null }, shipBays: planetaryBay } as never), {}, NB);
  assert.deepEqual(t.action, { kind: "unloadHolds", groups: [{ bay: "planetary", itemIDs: [9100] }], division: 3 });
});

// ── the editor's sentences ───────────────────────────────────────────────────

test("the new blocks read as what they do", () => {
  assert.match(stepSentence(collectStep), /Collect every launch container of yours in this system/);
  assert.match(stepSentence(backStep), /before the refit/);
  const intoCorp: MacroStep = {
    id: "u", kind: "macro", macro: "unload-cargo",
    args: { into: { kind: "corpDivision", division: 3, name: "Industry" } },
  };
  assert.match(stepSentence(intoCorp), /Empty the ship into the corporation's/);
});

// ── board-planetary-hauler ───────────────────────────────────────────────────

const boardHauler = SCRIPT_MACROS["board-planetary-hauler"]!;
const haulerStep: MacroStep = { id: "h", kind: "macro", macro: "pi-manager:board-hauler", args: {} };

test("board-planetary-hauler: already in a ship with a planetary hold -> done, nothing noted", () => {
  const t = boardHauler(haulerStep, docked({ stationHangar: hangar, activeShipID: 5002, planetaryHaulerShipIDs: [5002] } as never), {}, NB);
  assert.equal(t.outcome.kind, "done");
  assert.equal(t.boardPatch, undefined);
});

test("board-planetary-hauler: boards the parked hull whose hold says planetary, noting the one it leaves", () => {
  const t = boardHauler(haulerStep, docked({ stationHangar: hangar, activeShipID: 5001, planetaryHaulerShipIDs: [5002] } as never), {}, NB);
  assert.deepEqual(t.action, { kind: "boardShip", shipID: 5002 });
  assert.deepEqual(t.boardPatch, { shipBeforeRefit: 5001 });
});

test("board-planetary-hauler: no parked hull has a planetary hold -> blocked, saying so", () => {
  const t = boardHauler(haulerStep, docked({ stationHangar: hangar, activeShipID: 5001, planetaryHaulerShipIDs: [] } as never), {}, NB);
  assert.ok(t.outcome.kind === "blocked" && /planetary commodities hold/.test(t.outcome.reason));
});

test("board-planetary-hauler: unreadable holds wait, and only a long blind spell blocks", () => {
  const t = boardHauler(haulerStep, docked({ stationHangar: hangar, activeShipID: 5001, planetaryHaulerShipIDs: null } as never), {}, NB);
  assert.equal(t.outcome.kind, "acting");
  const late = boardHauler(haulerStep, docked({ stationHangar: hangar, activeShipID: 5001, planetaryHaulerShipIDs: null } as never), { blindChecks: 99 }, NB);
  assert.equal(late.outcome.kind, "blocked");
});

test("board-planetary-hauler: in space in a planetary hauler -> done, it hauls from where it is", () => {
  const t = boardHauler(haulerStep, obs({ activeShipID: 5002, planetaryHaulerShipIDs: [5002], homeStationID: 60000004 } as never), {}, NB);
  assert.equal(t.outcome.kind, "done");
  assert.equal(t.boardPatch, undefined);
});

test("board-planetary-hauler: in space in another ship -> flies home to board there", () => {
  const t = boardHauler(haulerStep, obs({ activeShipID: 5001, planetaryHaulerShipIDs: [], homeStationID: 60000004 } as never), {}, NB);
  assert.equal(t.outcome.kind, "acting");
  assert.notEqual(t.action.kind, "wait");
  assert.equal(t.phase, "Flying home to board the hauler");
  // Docked there on a later tick, the parked hauler is boarded as ever.
  const there = boardHauler(haulerStep, docked({ stationHangar: hangar, activeShipID: 5001, planetaryHaulerShipIDs: [5002] } as never), t.nextMem, NB);
  assert.deepEqual(there.action, { kind: "boardShip", shipID: 5002 });
});

test("board-planetary-hauler: emergency docking elsewhere keeps the ship safe without boarding there", () => {
  const home = 60000004;
  const refuge = 60000005;
  const landing = boardHauler(haulerStep, obs({
    activeShipID: 5001, planetaryHaulerShipIDs: [], homeStationID: home,
    travel: { status: "paused", destinationStationID: home, remainingJumps: 2, failureReason: "No route to home." },
    snapshot: snapshot([entity({ itemID: refuge, kind: "station", position: { x: 1000, y: 0, z: 0 } })]),
  }), {}, NB);
  assert.deepEqual(landing.action, { kind: "dock", stationID: refuge }, "the emergency door remains available");
  const there = boardHauler(haulerStep, docked({
    flightStatus: flight({ inSpace: false, docked: true, stationID: refuge }),
    activeShipID: 5001, planetaryHaulerShipIDs: [5002], stationHangar: hangar, homeStationID: home,
  }), landing.nextMem, NB);
  assert.equal(there.outcome.kind, "blocked", "a safe refuge is not the station chosen for reshipping");
  assert.equal(there.action.kind, "wait");
  assert.equal(there.boardPatch, undefined, "the original hull is never left at the wrong station");
  if (there.outcome.kind === "blocked") assert.match(there.outcome.reason, /home.*board|board.*home/i);
});

test("board-planetary-hauler: a run starting docked boards here even when home is elsewhere", () => {
  const t = boardHauler(haulerStep, docked({
    stationHangar: hangar, activeShipID: 5001, planetaryHaulerShipIDs: [5002], homeStationID: 60000005,
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "boardShip", shipID: 5002 });
  assert.deepEqual(t.boardPatch, { shipBeforeRefit: 5001 });
});

test("board-planetary-hauler: arriving at the intended home structure allows boarding", () => {
  const home = 1000000000001;
  const flying = boardHauler(haulerStep, obs({
    activeShipID: 5001, planetaryHaulerShipIDs: [], homeStationID: home, homeDockableKind: "structure",
  }), {}, NB);
  const there = boardHauler(haulerStep, docked({
    flightStatus: flight({ inSpace: false, docked: true, stationID: null, structureID: home }),
    activeShipID: 5001, planetaryHaulerShipIDs: [5002], stationHangar: hangar, homeStationID: home, homeDockableKind: "structure",
  }), flying.nextMem, NB);
  assert.deepEqual(there.action, { kind: "boardShip", shipID: 5002 });
  assert.deepEqual(there.boardPatch, { shipBeforeRefit: 5001 });
});

test("board-planetary-hauler: in space in another ship with no home known -> blocked, never a guessed station", () => {
  const t = boardHauler(haulerStep, obs({ activeShipID: 5001, planetaryHaulerShipIDs: [], homeStationID: null } as never), {}, NB);
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /does not know which station is home/);
});

test("board-planetary-hauler: in space with the ship's holds unread waits, and only a long blind spell blocks", () => {
  const t = boardHauler(haulerStep, obs({ activeShipID: 5001, planetaryHaulerShipIDs: null, homeStationID: 60000004 } as never), {}, NB);
  assert.equal(t.outcome.kind, "acting");
  assert.equal(t.action.kind, "wait");
  const late = boardHauler(haulerStep, obs({ activeShipID: 5001, planetaryHaulerShipIDs: null } as never), { blindChecks: 99 }, NB);
  assert.equal(late.outcome.kind, "blocked");
});

test("a planet-limited launch reads with its colonies, never their ids", () => {
  const s: MacroStep = {
    id: "l", kind: "macro", macro: "pi-manager:launch-commodities",
    args: { planets: { kind: "planetList", planets: [{ planetID: 40000001, name: "Alpha II" }, { planetID: 40000002, name: null }] } },
  };
  const sentence = stepSentence(s);
  assert.match(sentence, /of Alpha II and 1 more colony/);
  assert.doesNotMatch(sentence, /40000002/);
});
