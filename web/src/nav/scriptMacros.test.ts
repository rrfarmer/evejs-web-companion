// B1 — the macro adapters' key transitions. Pins each block's task loop so a
// wrong turn surfaces here, not on a live ship: undock, the mine state machine
// (warp to belt / orbit / lock / activate), deliver (dock + unload), defend.

import test from "node:test";
import assert from "node:assert/strict";

import type { FlightStatus, HoldItem, MiningHold, SpaceEntity, SpaceShipStatus, SpaceSnapshot, SpaceVector } from "../store/types.ts";
import type { MacroMemory, MacroTick, ScriptBoard, ScriptMemory } from "./scriptDecide.ts";
import type { DryBelt, ScriptObservation } from "./scriptConditions.ts";
import type { BotScript, MacroStep } from "../bots/botScript.ts";
import { decideScriptAction, initialMemory } from "./scriptDecide.ts";
import type { FleetBroadcast } from "../bridge/fleetBroadcasts.ts";
import type { RatThreat } from "./ratThreat.ts";
import { SCRIPT_MACROS, scriptTravelHome } from "./scriptMacros.ts";
import { createScriptRunner } from "./scriptRunner.ts";
import { beltWarpFloorMeters } from "./miningBotLoop.ts";
import {
  emptyLedger,
  encodeLedger,
  enterSite,
  LEDGER_KEYS,
  MAX_SITE_RETURNS,
  STALL_TICKS,
} from "./siteProgress.ts";

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "celestial", typeID: 1, groupID: 1, categoryID: 2, name: null, ownerID: null,
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
    itemID: 9001, typeID: 17476, name: "Procurer", mode: null, maxVelocity: 100, radius: 100,
    position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
    shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
    ...over,
  } as SpaceShipStatus;
}

function snapshot(entities: SpaceEntity[], shipOver: Partial<SpaceShipStatus> = {}): SpaceSnapshot {
  return { inSpace: true, solarSystemID: 30000142, shipID: 9001, sampledAtMs: 1, entities, ship: ship(shipOver) };
}

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return { inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null, shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null, ...over };
}

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: flight(), snapshot: null, lockedTargetIDs: [], holds: null, droneBayItemIDs: [],
    miningModuleIDs: [], startingStationID: null,
    systemName: "Test System",
    ...over,
  };
}

/** A `Target`-shaped default so a test only spells out the fields it cares about. */
function broadcast(over: Partial<FleetBroadcast> & { name: FleetBroadcast["name"] }): FleetBroadcast {
  return { scope: 3, senderCharID: null, senderSolarSystemID: null, itemID: null, typeID: null, receivedAtMs: 1, ...over };
}

const mineStep: MacroStep = { id: "m", kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode: "nearest" } } }, until: { kind: "ore-hold-at-least", fraction: 0.9 } };
const haulStep: MacroStep = { id: "h", kind: "macro", macro: "deliver-ore", args: { station: { kind: "station", ref: { entity: "station", id: 60000004, name: "Home", systemName: null } } } };
const mine = SCRIPT_MACROS["mine-at-belt"]!;
const deliver = SCRIPT_MACROS["deliver-ore"]!;
const undock = SCRIPT_MACROS["undock"]!;
const defend = SCRIPT_MACROS["defend-with-drones"]!;
const NM: MacroMemory = {};

const scannerOperations: NonNullable<ScriptObservation["scannerOperations"]> = {
  inSpace: true,
  solarSystemID: 30000142,
  shipID: 9001,
  maxActiveProbes: 8,
  launcher: {
    moduleID: 8001,
    typeID: 17938,
    online: true,
    chargeTypeID: 30013,
    loadedCount: 8,
    launchCount: 8,
  },
  probes: [],
};

test("undock: docked -> undock, in space -> done", () => {
  assert.equal(undock({ id: "u", kind: "macro", macro: "undock", args: {} }, obs({ flightStatus: flight({ docked: true, inSpace: false }) }), NM, {}).action.kind, "undock");
  assert.equal(undock({ id: "u", kind: "macro", macro: "undock", args: {} }, obs({ flightStatus: flight({ docked: false }) }), NM, {}).outcome.kind, "done");
});

test("mine: no rocks but a distant belt -> warp to the belt", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([belt]) }), NM, {});
  assert.equal(t.action.kind, "warp");
  assert.ok(t.action.kind === "warp" && t.action.targetID === 40001);
});

test("mine: a pinned belt beats a nearer unpinned one", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const chosen = entity({ itemID: 40002, name: "Asteroid Belt 2", position: { x: 900000, y: 0, z: 0 } });
  const step: MacroStep = {
    id: "m",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: {
        kind: "belt",
        belt: { mode: "chosen", ref: { entity: "belt", id: 40002, name: "Asteroid Belt 2", systemName: null } },
      },
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const t = mine(step, obs({ snapshot: snapshot([near, chosen]) }), NM, {});
  assert.equal(t.action.kind, "warp");
  assert.ok(t.action.kind === "warp" && t.action.targetID === 40002);
});

test("mine: a pinned belt not on this grid -> blocked, never a silent fallback to nearest", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const step: MacroStep = {
    id: "m",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: {
        kind: "belt",
        belt: { mode: "chosen", ref: { entity: "belt", id: 99999, name: "Asteroid Belt 9", systemName: null } },
      },
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const t = mine(step, obs({ snapshot: snapshot([near]) }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /pinned/i);
});

const travelToBeltStep: MacroStep = {
  id: "tb", kind: "macro", macro: "travel-to-belt",
  args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
};
const travelToBelt = SCRIPT_MACROS["travel-to-belt"]!;

test("travel-to-belt: no belt in view -> blocked", () => {
  const t = travelToBelt(travelToBeltStep, obs({ snapshot: snapshot([]) }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
});

test("travel-to-belt: a distant belt -> warp to it", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const t = travelToBelt(travelToBeltStep, obs({ snapshot: snapshot([belt]) }), NM, {});
  assert.equal(t.action.kind, "warp");
  assert.ok(t.action.kind === "warp" && t.action.targetID === 40001);
});

test("travel-to-belt: already on the belt -> done, no mining involved", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const t = travelToBelt(travelToBeltStep, obs({ snapshot: snapshot([belt]) }), NM, {});
  assert.equal(t.outcome.kind, "done");
});

test("same-belt short warp uses belt surface geometry, not only the 20 km arrival radius", () => {
  const shipRadius = 100;
  const beltRadius = 1_000;
  const floor = beltWarpFloorMeters(shipRadius, beltRadius);
  assert.equal(floor, 151_600);
  const atSurface = (surface: number) => entity({ itemID: 40001, name: "Asteroid Belt 1",
    radius: beltRadius, position: { x: surface + shipRadius + beltRadius, y: 0, z: 0 } });
  const local = travelToBelt(travelToBeltStep, obs({ snapshot: snapshot([atSurface(floor - 1)]) }), NM, {});
  assert.equal(local.action.kind, "approach", "a warp EveJS refuses is closed under sublight");
  const arrived = travelToBelt(travelToBeltStep, obs({ snapshot: snapshot([atSurface(20_000)]) }), NM, {});
  assert.equal(arrived.outcome.kind, "done", "normal 20 km arrival still decides completion");
  const warpable = travelToBelt(travelToBeltStep, obs({ snapshot: snapshot([atSurface(floor)]) }), NM, {});
  assert.equal(warpable.action.kind, "warp", "exact warp floor remains warpable");
});

test("empty pinned and nearest belts use the same short-warp reachability", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", radius: 1_000,
    position: { x: 100_000, y: 0, z: 0 } });
  const pinned: MacroStep = { ...mineStep, args: { belt: { kind: "belt", belt: {
    mode: "chosen", ref: { entity: "belt", id: belt.itemID, name: belt.name!, systemName: null },
  } } } };
  const pinnedTick = mine(pinned, obs({ snapshot: snapshot([belt]) }), NM, {});
  assert.equal(pinnedTick.action.kind, "approach", "pinned empty belt closes locally before deciding depletion");
  const nearestTick = mine(mineStep, obs({ snapshot: snapshot([belt]) }), NM, {});
  assert.equal(nearestTick.action.kind, "approach", "nearest rotation must not mark a 100 km belt dry");
  const arrivedBelt = { ...belt, position: { x: 5_000, y: 0, z: 0 } };
  assert.equal(mine(pinned, obs({ snapshot: snapshot([arrivedBelt]) }), NM, {}).outcome.kind, "blocked");
  assert.equal(mine(mineStep, obs({ snapshot: snapshot([arrivedBelt]) }), NM, {}).action.kind, "rememberBeltDry");
});

test("travel-to-belt: a pinned belt not on this grid -> blocked, never a silent fallback to nearest", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const step: MacroStep = {
    id: "tb2",
    kind: "macro",
    macro: "travel-to-belt",
    args: {
      belt: {
        kind: "belt",
        belt: { mode: "chosen", ref: { entity: "belt", id: 99999, name: "Asteroid Belt 9", systemName: null } },
      },
    },
  };
  const t = travelToBelt(step, obs({ snapshot: snapshot([near]) }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /pinned/i);
});

test("mine: a rock in range -> orbit it at 5km and remember it", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, beltID: 40001, position: { x: 8000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([rock]) }), NM, {});
  assert.equal(t.action.kind, "orbit");
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50001 && t.action.range === 5000);
  assert.equal(t.nextMem["rockID"], 50001);
});

test("mine: rock locked but still out of range, not yet approached -> close in", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 15000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [] }), lockedTargetIDs: [50001], miningModuleIDs: [700, 701] }),
    { rockID: 50001, lockIssued: true, waited: 0 },
    {},
  );
  assert.equal(t.action.kind, "orbit");
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50001 && t.action.range === 5000);
  assert.equal(t.nextMem["approachedRockID"], 50001);
});

// ⚠ THE ORBIT HALF OF THE SILENT-REFUSAL RUNG. `CmdOrbit` is gated and thrown
// away exactly like `CmdFollowBall`, and a belt is where it bites: the first
// order after the warp in is the orbit, on the very tick eve.js still has the
// hull landingPending. GOTO is the deadlock's signature — SetSpeedFraction(1.0)
// took, the orbit after it did not.
test("⚠ mine: an orbit the server accepted and ignored -> re-order, STOP, re-order, then blocked", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 15000, y: 0, z: 0 } });
  const world = obs({
    snapshot: snapshot([rock], { activeModuleIDs: [], mode: "GOTO" }),
    lockedTargetIDs: [50001],
    miningModuleIDs: [700, 701],
  });
  let mem: MacroMemory = { rockID: 50001, lockIssued: true, waited: 0, approachedRockID: 50001 };
  const script: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const t = mine(mineStep, world, mem, {});
    script.push(t.action.kind);
    if (t.outcome.kind === "blocked") {
      assert.match(t.outcome.reason, /takes move orders and does not move/);
      break;
    }
    mem = t.nextMem;
  }
  assert.deepEqual(
    script.filter((kind) => kind !== "wait"),
    ["orbit", "stopShip", "orbit"],
    "it re-sends its OWN order — an orbit, never an approach",
  );
  assert.ok(script.length < 20, "a miner that cannot reach the belt says so");
});

test("mine: a hull already ORBITING is never stopped — an orbit IS closing", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 15000, y: 0, z: 0 } });
  const world = obs({
    snapshot: snapshot([rock], { activeModuleIDs: [], mode: "ORBIT" }),
    lockedTargetIDs: [50001],
    miningModuleIDs: [700, 701],
  });
  let mem: MacroMemory = { rockID: 50001, lockIssued: true, waited: 0, approachedRockID: 50001 };
  for (let i = 0; i < 20; i += 1) {
    const t = mine(mineStep, world, mem, {});
    assert.equal(t.action.kind, "wait", `tick ${i} disturbed an orbit that was running`);
    mem = t.nextMem;
  }
});

test("mine: rock locked, out of range, already closing in -> wait rather than activate", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 15000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [] }), lockedTargetIDs: [50001], miningModuleIDs: [700, 701] }),
    { rockID: 50001, lockIssued: true, waited: 0, approachedRockID: 50001 },
    {},
  );
  assert.equal(t.action.kind, "wait");
  assert.match(t.phase, /Approaching/);
});

test("mine: rock locked at 7km — an orbit of 5km overshooting a little — still activates", () => {
  // An orbit command holds APPROXIMATELY its radius, not exactly it, so a ship
  // told to orbit at 5km can genuinely settle a bit outside that. The range
  // check has to tolerate that wobble rather than treat it as still too far.
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 7000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [] }), lockedTargetIDs: [50001], miningModuleIDs: [700, 701] }),
    { rockID: 50001, lockIssued: true, waited: 0, approachedRockID: 50001 },
    {},
  );
  assert.ok(t.action.kind === "activate" && t.action.targetID === 50001 && t.action.moduleID === 700);
});

test("mine: rock locked, a miner idle -> activate it on the rock", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 4000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [] }), lockedTargetIDs: [50001], miningModuleIDs: [700, 701] }),
    { rockID: 50001, lockIssued: true, waited: 0 },
    {},
  );
  assert.ok(t.action.kind === "activate" && t.action.targetID === 50001 && t.action.moduleID === 700);
});

test("mine: rock locked, all miners running -> wait (mining)", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 4000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [700] }), lockedTargetIDs: [50001], miningModuleIDs: [700] }),
    { rockID: 50001, lockIssued: true, waited: 0 },
    {},
  );
  assert.equal(t.action.kind, "wait");
  assert.match(t.phase, /Mining/);
});

test("mine: rock locked, but no mining equipment was detected -> blocked, not a silent 'mining'", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 4000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [] }), lockedTargetIDs: [50001], miningModuleIDs: [] }),
    { rockID: 50001, lockIssued: true, waited: 0 },
    {},
  );
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /no mining equipment/i);
});

// ── mine: belt rotation (nearest mode, decision 2, shared BFF memory) ───────

test("mine: a dry belt in nearest mode reports it via the shared memory instead of blocking", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const far = entity({ itemID: 40002, name: "Asteroid Belt 2", position: { x: 500000, y: 0, z: 0 } });
  const t1 = mine(mineStep, obs({ snapshot: snapshot([near, far]) }), NM, {});
  assert.equal(t1.action.kind, "rememberBeltDry");
  assert.ok(
    t1.action.kind === "rememberBeltDry" &&
      t1.action.systemName === "Test System" &&
      t1.action.beltName === "Asteroid Belt 1" &&
      t1.action.groupID === null,
  );
  assert.match(t1.why, /moving to the next belt/i);

  // Next tick, with the shared memory now reporting belt 1 all-dry: rotate to the far belt.
  const dryBelts: DryBelt[] = [{ beltName: "Asteroid Belt 1", all: true, families: [] }];
  const t2 = mine(mineStep, obs({ snapshot: snapshot([near, far]), dryBelts }), NM, {});
  assert.equal(t2.action.kind, "warp");
  assert.ok(t2.action.kind === "warp" && t2.action.targetID === 40002);
});

test("mine: every belt in the system reported dry -> blocked with a plain reason", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const far = entity({ itemID: 40002, name: "Asteroid Belt 2", position: { x: 8000, y: 0, z: 0 } });
  const dryBelts: DryBelt[] = [
    { beltName: "Asteroid Belt 1", all: true, families: [] },
    { beltName: "Asteroid Belt 2", all: true, families: [] },
  ];
  const t = mine(mineStep, obs({ snapshot: snapshot([near, far]), dryBelts }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(t.outcome.kind === "blocked" ? t.outcome.reason : "", "Every asteroid belt in this system is mined out.");
});

test("mine: a CHOSEN (pinned) belt still just pauses when dry — no rotation", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const step: MacroStep = {
    id: "mp",
    kind: "macro",
    macro: "mine-at-belt",
    args: { belt: { kind: "belt", belt: { mode: "chosen", ref: { entity: "belt", id: 40001, name: "Asteroid Belt 1", systemName: null } } } },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const t = mine(step, obs({ snapshot: snapshot([belt]) }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(t.outcome.kind === "blocked" ? t.outcome.reason : "", "This belt has no rocks left to mine.");
  assert.equal(t.boardPatch, undefined);
});

test("mine: the shared belt memory is read from the observation, independent of per-step memory", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const far = entity({ itemID: 40002, name: "Asteroid Belt 2", position: { x: 500000, y: 0, z: 0 } });
  const dryBelts: DryBelt[] = [{ beltName: "Asteroid Belt 1", all: true, families: [] }];
  // A stale mem (as if this were mid-lock on a rock from before the haul) makes no difference.
  const t1 = mine(mineStep, obs({ snapshot: snapshot([near, far]), dryBelts }), { rockID: 999, lockIssued: true }, {});
  assert.ok(t1.action.kind === "warp" && t1.action.targetID === 40002);
  // Re-entering the step resets mem to {} and the board carries nothing either —
  // the shared memory lives on the observation and does not care.
  const t2 = mine(mineStep, obs({ snapshot: snapshot([near, far]), dryBelts }), {}, {});
  assert.ok(t2.action.kind === "warp" && t2.action.targetID === 40002);
});

test("mine: dryBelts null (unreadable) is treated as nothing known, never as all dry", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([near]), dryBelts: null }), NM, {});
  assert.equal(t.action.kind, "rememberBeltDry");
});

test("mine: on a dry belt but the system name is unreadable -> blocked, not a bare report", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([near]), systemName: null }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(t.outcome.kind === "blocked" ? t.outcome.reason : "", "The bot cannot tell which solar system this is.");
});

test("mine: rotation skips a belt dry for this tier's family but not a belt dry only for a different family", () => {
  const belt1 = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const belt2 = entity({ itemID: 40002, name: "Asteroid Belt 2", position: { x: 500000, y: 0, z: 0 } });
  const step = oreListStep([VELDSPAR, KERNITE]);
  const dryBelts: DryBelt[] = [
    { beltName: "Asteroid Belt 1", all: false, families: [VELDSPAR.groupID] },
    { beltName: "Asteroid Belt 2", all: false, families: [KERNITE.groupID] },
  ];
  const t = mine(step, obs({ snapshot: snapshot([belt1, belt2]), dryBelts }), NM, {});
  assert.equal(t.action.kind, "warp");
  assert.ok(
    t.action.kind === "warp" && t.action.targetID === 40002,
    "belt 2 is only dry for Kernite, not the active Veldspar tier, so it is still a target",
  );
});

// ── mine: ore priority (tiered oreList) ──────────────────────────────────────

const VELDSPAR = { groupID: 462, name: "Veldspar" };
const KERNITE = { groupID: 465, name: "Kernite" };

function oreListStep(ores: { groupID: number; name: string }[]): MacroStep {
  return {
    id: "mo",
    kind: "macro",
    macro: "mine-at-belt",
    args: { belt: { kind: "belt", belt: { mode: "nearest" } }, ores: { kind: "oreList", ores } },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
}

test("mine: an ore-priority list only mines the listed family, ignoring closer non-listed rocks", () => {
  const veld = entity({ itemID: 50001, name: "Veldspar", groupID: 462, miningYieldTypeID: 1230, position: { x: 9000, y: 0, z: 0 } });
  const kern = entity({ itemID: 50002, name: "Kernite", groupID: 465, miningYieldTypeID: 1229, position: { x: 3000, y: 0, z: 0 } });
  const t = mine(oreListStep([VELDSPAR]), obs({ snapshot: snapshot([veld, kern]) }), NM, {});
  assert.equal(t.action.kind, "orbit");
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50001, "the closer Kernite rock is not on the list and is ignored");
});

test("mine: within a family, the highest ore grade wins over distance; an unknown grade sorts last", () => {
  const plain = entity({ itemID: 50001, name: "Veldspar", groupID: 462, miningYieldTypeID: 1230, oreGrade: 0, position: { x: 2000, y: 0, z: 0 } });
  const graded = entity({ itemID: 50002, name: "Concentrated Veldspar", groupID: 462, miningYieldTypeID: 1231, oreGrade: 2, position: { x: 9000, y: 0, z: 0 } });
  const unknown = entity({ itemID: 50003, name: "Veldspar", groupID: 462, miningYieldTypeID: 1230, oreGrade: null,
    oreValuePerM3: null, position: { x: 500, y: 0, z: 0 } });
  const t = mine(oreListStep([VELDSPAR]), obs({ snapshot: snapshot([plain, graded, unknown]) }), NM, {});
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50002, "grade II beats both a closer plain rock and an unknown-grade one");
});

test("mine: a belt on grid dry for the tier's family reports that family's groupID, not a plain dry", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const kern = entity({ itemID: 50001, name: "Kernite", groupID: 465, miningYieldTypeID: 1229, position: { x: 9000, y: 0, z: 0 } });
  const step = oreListStep([VELDSPAR, KERNITE]);
  const t1 = mine(step, obs({ snapshot: snapshot([belt, kern]) }), NM, {});
  assert.equal(t1.action.kind, "rememberBeltDry");
  assert.ok(
    t1.action.kind === "rememberBeltDry" &&
      t1.action.systemName === "Test System" &&
      t1.action.beltName === "Asteroid Belt 1" &&
      t1.action.groupID === VELDSPAR.groupID,
  );
  assert.match(t1.why, /No Veldspar left here/i);
});

test("mine: once a tier's ore is reported gone from every belt, priority advances to the next tier (a fresh tour)", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const kern = entity({ itemID: 50001, name: "Kernite", groupID: 465, miningYieldTypeID: 1229, position: { x: 9000, y: 0, z: 0 } });
  const step = oreListStep([VELDSPAR, KERNITE]);
  // The shared memory already reports the only belt dry for Veldspar.
  const dryBelts: DryBelt[] = [{ beltName: "Asteroid Belt 1", all: false, families: [VELDSPAR.groupID] }];
  const world = () => obs({ snapshot: snapshot([belt, kern]), dryBelts });

  // Tick 1: every belt is dry for Veldspar -> advance to Kernite, fresh tour (per-pilot tier).
  const t1 = mine(step, world(), NM, {});
  assert.match(t1.why, /No Veldspar left in this system, moving to the next ore/i);
  assert.equal(t1.boardPatch?.["mineOreTier"], 1);

  // Tick 2: now on the Kernite tier, the rock right there is mineable — the
  // shared memory's Veldspar-only entry does not block a different family.
  const t2 = mine(step, world(), NM, { ...t1.boardPatch });
  assert.ok(t2.action.kind === "orbit" && t2.action.targetID === 50001);
});

test("mine: the ore-priority list running out entirely -> blocked, never a silent fallback to any rock", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const board = { mineOreTier: 1 }; // already past the end of a one-family list
  const t = mine(oreListStep([VELDSPAR]), obs({ snapshot: snapshot([belt]) }), NM, board);
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(t.outcome.kind === "blocked" ? t.outcome.reason : "", "None of the ores on your list are left in this system.");
});

// ── mine: SITE mode (the anomaly miner) ──────────────────────────────────────
// `mine-at-belt` with `belt.mode === "site"` never looks at a belt at all — it
// tours the scanner's ore sites via `oreAnomsVisited` (the same board key
// `warp-to-ore-anomaly` publishes) and its own `oreSitesBarren`, per-pilot,
// per-run list. See the `mineAtBelt`/`mineAtBeltSite` header comments in
// scriptMacros.ts for the belt-tour incident this mode exists to close.

const ARKONOR = { groupID: 601, name: "Arkonor" };
const BISTOT = { groupID: 602, name: "Bistot" };

function siteStep(ores: { groupID: number; name: string }[] = []): MacroStep {
  return {
    id: "ms",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: { kind: "belt", belt: { mode: "site" } },
      ...(ores.length > 0 ? { ores: { kind: "oreList", ores } } : {}),
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
}

/**
 * Feed `mine-at-belt` (site mode) the SAME barren grid until it stops just
 * confirming and actually acts — EMPTY_GRID_CONFIRM_TICKS (3) consecutive
 * reads, the same rule `fightUntilClear` below drives for the combat side of
 * the identical "a grid right after a warp has not arrived yet" guard. Tests
 * that only care about the eventual verdict (not the confirmation itself)
 * use this instead of spelling out all three ticks by hand.
 */
function mineUntilBarren(step: MacroStep, observation: ScriptObservation, board: ScriptBoard = {}): MacroTick {
  let mem: MacroMemory = {};
  let last = mine(step, observation, mem, board);
  for (let read = 1; read < 3; read += 1) {
    mem = last.nextMem;
    last = mine(step, observation, mem, board);
  }
  // A pick is committed by a wait tick before the warp is pressed.
  if (last.outcome.kind === "acting" && last.nextMem["siteTarget"] !== undefined) {
    last = mine(step, observation, last.nextMem, board);
  }
  return last;
}

test("mine (site mode): rocks present on the grid -> mine them, exactly like any other mode", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 8000, y: 0, z: 0 } });
  const t = mine(siteStep(), obs({ snapshot: snapshot([rock]) }), NM, { oreAnomsVisited: "QEE-100" });
  assert.equal(t.action.kind, "orbit");
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50001);
});

test("mine (site mode): the shared BELT memory changes nothing, which is why the read is not taken", () => {
  // ⚠ THE READ IS GATED OFF FOR THIS MODE IN `observe`, AND THIS IS THE
  // PROPERTY THAT MAKES THAT SAFE. `dryBelts` is the BFF-shared, belt-name-keyed
  // memory, and the only line that reads it (`dryBeltNames`) sits past the site
  // branch, on NEAREST mode's rotation. So a site step mines the rock in front
  // of it with every belt in the system marked dry — and answers identically
  // when the list is absent, which is what it now always gets.
  const rock = entity({ itemID: 50001, name: "Arkonor", miningYieldTypeID: 1230, groupID: 601, position: { x: 8000, y: 0, z: 0 } });
  const everyBeltDry = [
    { beltName: "Asteroid Belt 1", all: true, families: [] },
    { beltName: "Asteroid Belt 2", all: true, families: [] },
  ];
  const board = { oreAnomsVisited: "QEE-100" };
  const withMemory = mine(siteStep([ARKONOR]), obs({ snapshot: snapshot([rock]), dryBelts: everyBeltDry }), NM, board);
  const without = mine(siteStep([ARKONOR]), obs({ snapshot: snapshot([rock]) }), NM, board);

  assert.equal(withMemory.action.kind, "orbit", "a dry BELT says nothing about the rock on an ore site's grid");
  assert.deepEqual(without.action, withMemory.action, "the same move with the list and without it");
  assert.deepEqual(without.outcome, withMemory.outcome);
});
test("mine (site mode): a belt on the overview is never a target — site mode never evaluates the belt regex", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const sites = [
    { label: "QEE-100", kind: "ore" as const },
    { label: "QEE-200", kind: "ore" as const },
  ];
  const t = mineUntilBarren(siteStep(), obs({ snapshot: snapshot([belt]), anomalies: sites }), { oreAnomsVisited: "QEE-100" });
  assert.notEqual(t.action.kind, "warp", "warping to the belt is the NEAREST-mode bug this mode exists to close");
  assert.equal(t.action.kind, "warpScan");
  assert.ok(t.action.kind === "warpScan" && t.action.target === "QEE-200");
});

test("mine (site mode): barren grid with another ore site left -> warpScan to it, and the barren label is recorded", () => {
  const sites = [
    { label: "QEE-100", kind: "ore" as const },
    { label: "QEE-200", kind: "ore" as const },
  ];
  const t = mineUntilBarren(siteStep(), obs({ snapshot: snapshot([]), anomalies: sites }), { oreAnomsVisited: "QEE-100" });
  assert.equal(t.action.kind, "warpScan");
  assert.ok(t.action.kind === "warpScan" && t.action.target === "QEE-200");
  assert.equal(t.boardPatch?.["oreSitesBarren"], "QEE-100");
  // §3's other requirement: the label also lands in the TOUR's own visited
  // list, so `warp-to-ore-anomaly`'s next tick does not send the ship right
  // back to the site this block just walked away from.
  assert.equal(t.boardPatch?.["oreAnomsVisited"], "QEE-100,QEE-200");
});

test("mine (site mode): every ore site barren, an ore list configured -> blocked, naming the ores", () => {
  const board = { oreAnomsVisited: "QEE-100", oreSitesBarren: "QEE-050" };
  const sites = [
    { label: "QEE-100", kind: "ore" as const },
    { label: "QEE-050", kind: "ore" as const },
  ];
  const t = mineUntilBarren(siteStep([ARKONOR, BISTOT]), obs({ snapshot: snapshot([]), anomalies: sites }), board);
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(
    t.outcome.kind === "blocked" ? t.outcome.reason : "",
    "Every ore site in this system is out of Arkonor and Bistot.",
  );
  assert.equal(t.boardPatch?.["oreSitesBarren"], "QEE-050,QEE-100");
});

test("mine (site mode): every ore site barren, no ore list configured -> the plain reason", () => {
  const sites = [{ label: "QEE-100", kind: "ore" as const }];
  const t = mineUntilBarren(siteStep(), obs({ snapshot: snapshot([]), anomalies: sites }), { oreAnomsVisited: "QEE-100" });
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(t.outcome.kind === "blocked" ? t.outcome.reason : "", "Every ore site in this system is mined out.");
});

// A site the fleet just emptied is still on the scanner for a moment after the
// server tore it down. The warp at it is refused, and the refused issue commits
// nothing — so the block used to re-pick the same dead site every tick until the
// runner stopped the bot on ten refusals in a row, in space.
const SITE_GONE = "You have not scanned that site down, so you cannot warp to it yet.";
const siteWarpRefused = (count: number) => [{
  key: "ms:warpScan:-", count, firstAt: 0, lastAt: 0, words: SITE_GONE, kind: "refused" as const,
}];

test("mine (site mode): a refused next site is set aside and the scanner is read again for another", () => {
  const sites = [
    { label: "QEE-100", kind: "ore" as const },
    { label: "QEE-200", kind: "ore" as const },
    { label: "QEE-300", kind: "ore" as const },
  ];
  const board = { oreAnomsVisited: "QEE-100" };
  const issued = mineUntilBarren(siteStep(), obs({ snapshot: snapshot([]), anomalies: sites }), board);
  assert.ok(issued.action.kind === "warpScan" && issued.action.target === "QEE-200");

  // The runner did not commit the issuing tick: the next one sees the PICK
  // tick's memory, plus the refusal.
  let mem: MacroMemory = {};
  for (let read = 0; read < 3; read += 1) {
    mem = mine(siteStep(), obs({ snapshot: snapshot([]), anomalies: sites }), mem, board).nextMem;
  }
  const refusedWorld = obs({ snapshot: snapshot([]), anomalies: sites, refusals: siteWarpRefused(1) });
  const repick = mine(siteStep(), refusedWorld, mem, board);
  assert.equal(repick.action.kind, "wait", "no second press at the site that was just refused");
  assert.equal(repick.nextMem["siteTarget"], "QEE-300");
  assert.equal(repick.boardPatch?.["oreSitesBarren"], "QEE-100", "a refusal alone does not strike the site off for the run");

  const retry = mine(siteStep(), refusedWorld, repick.nextMem, board);
  assert.ok(retry.action.kind === "warpScan" && retry.action.target === "QEE-300", "it warps to the next site");
});

test("mine (site mode): when the last listed site refuses and then leaves the scanner, the run ends as mined out (and flies home)", () => {
  const sites = [
    { label: "QEE-100", kind: "ore" as const },
    { label: "QEE-200", kind: "ore" as const },
  ];
  const board = { oreAnomsVisited: "QEE-100" };
  let mem: MacroMemory = {};
  for (let read = 0; read < 3; read += 1) {
    mem = mine(siteStep(), obs({ snapshot: snapshot([]), anomalies: sites }), mem, board).nextMem;
  }
  assert.equal(mem["siteTarget"], "QEE-200");
  const doubt = mine(siteStep(), obs({ snapshot: snapshot([]), anomalies: sites, refusals: siteWarpRefused(1) }), mem, board);
  assert.equal(doubt.outcome.kind, "acting", "one refusal is not proof the site is gone");
  assert.equal(doubt.nextMem["doubted"], "QEE-200");

  // The server tore it down: it leaves the scanner, and that is the verdict.
  const gone = obs({ snapshot: snapshot([]), anomalies: [sites[0]!], refusals: siteWarpRefused(1) });
  const out = mine(siteStep(), gone, doubt.nextMem, board);
  assert.equal(out.outcome.kind, "blocked", "blocked is what sends the ship home before the run stops");
  assert.equal(out.outcome.kind === "blocked" ? out.outcome.reason : "", "Every ore site in this system is mined out.");
  assert.equal(out.boardPatch?.["oreSitesBarren"], "QEE-100,QEE-200", "a site that left the scanner is barren for the run");
});

// ─── The last site refuses while the scanner still lists it ──────────────────
// See the warp-to-ore-anomaly twin below: the server words a torn-down site and
// a ship it still files under a site's pocket the same way.

const SITE_FAR = 4 * 149_597_870_700;
const SITE_HOME = 60000004;

test("mine (site mode): a last refused site the scanner keeps listing gets the dock trip, then the warp again", () => {
  const sites = [
    { label: "QEE-100", kind: "ore" as const, position: ORIGIN },
    { label: "QEE-200", kind: "ore" as const, position: { x: SITE_FAR, y: 0, z: 0 } },
  ];
  const board = { oreAnomsVisited: "QEE-100" };
  const world = (over: Partial<ScriptObservation> = {}) =>
    obs({ snapshot: snapshot([]), anomalies: sites, homeStationID: SITE_HOME, ...over });
  let mem: MacroMemory = {};
  for (let read = 0; read < 3; read += 1) {
    mem = mine(siteStep(), world(), mem, board).nextMem;
  }
  let t = mine(siteStep(), world({ refusals: siteWarpRefused(1) }), mem, board);
  for (let read = 0; read < 20 && t.nextMem["rejoin"] === undefined && t.outcome.kind === "acting"; read += 1) {
    t = mine(siteStep(), world({ refusals: siteWarpRefused(1) }), t.nextMem, board);
  }
  assert.equal(t.outcome.kind, "acting", "a site still listed is not mined out");
  assert.equal(t.nextMem["rejoin"], "home");
  assert.equal(t.boardPatch?.["oreSitesBarren"], "QEE-100", "and it is not struck off");

  const fly = mine(siteStep(), world({ refusals: siteWarpRefused(1) }), t.nextMem, board);
  assert.deepEqual(fly.action, { kind: "startRoute", stationID: SITE_HOME });

  const docked = world({ inSpace: false, docked: true, snapshot: null, flightStatus: flight({ docked: true, inSpace: false, stationID: SITE_HOME }) });
  const undock = mine(siteStep(), docked, fly.nextMem, board);
  assert.deepEqual(undock.action, { kind: "undock" });
  assert.equal(mine(siteStep(), docked, undock.nextMem, board).action.kind, "undock", "pressed until the ship is out");

  // Out on the station's grid, nowhere near either site: the empty grid marks
  // nothing barren, and the doubted site is the next warp.
  const station = { x: 2 * SITE_FAR, y: 0, z: 0 };
  const out = world({ refusals: siteWarpRefused(1), snapshot: snapshot([], { position: station }) });
  let back = mine(siteStep(), out, undock.nextMem, board);
  for (let read = 0; read < 5 && back.action.kind === "wait"; read += 1) {
    back = mine(siteStep(), out, back.nextMem, board);
  }
  assert.deepEqual(back.action, { kind: "warpScan", target: "QEE-200" });
});

test("mine (site mode): refused again after the dock trip, it stops and says the site is still listed", () => {
  const sites = [
    { label: "QEE-100", kind: "ore" as const },
    { label: "QEE-200", kind: "ore" as const },
  ];
  const board = { oreAnomsVisited: "QEE-100" };
  const world = obs({ snapshot: snapshot([]), anomalies: sites, homeStationID: SITE_HOME, refusals: siteWarpRefused(2) });
  // Where the trip leaves it: the doubted site committed, the old refusal the baseline.
  let t = mine(siteStep(), world, { rejoined: true, siteTarget: "QEE-200", siteRefusalsSeen: 1, oreGridEmptyReads: 3 }, board);
  for (let read = 0; read < 20 && t.outcome.kind === "acting"; read += 1) {
    t = mine(siteStep(), world, t.nextMem, board);
  }
  assert.equal(t.outcome.kind, "blocked", "one trip, not a commute");
  const reason = t.outcome.kind === "blocked" ? t.outcome.reason : "";
  assert.doesNotMatch(reason, /mined out/);
  assert.match(reason, /QEE-200 after docking and undocking/);
});

test("mine (site mode): an empty grid far from the site the board names does not make that site barren", () => {
  // A server restart caught the pilot mid-warp: she wakes in open space with
  // the board still naming the site she was flying to.
  const sites = [{ label: "QEE-100", kind: "ore" as const, position: { x: SITE_FAR, y: 0, z: 0 } }];
  const t = mineUntilBarren(siteStep(), obs({ snapshot: snapshot([]), anomalies: sites }), { oreAnomsVisited: "QEE-100" });
  assert.deepEqual(t.action, { kind: "warpScan", target: "QEE-100" }, "it flies back to the site instead of calling it mined out");
  assert.notEqual(t.outcome.kind, "blocked");
});

test("mine (site mode): a refusal already on record is not read as a refusal of the new warp", () => {
  const sites = [
    { label: "QEE-100", kind: "ore" as const },
    { label: "QEE-200", kind: "ore" as const },
  ];
  const board = { oreAnomsVisited: "QEE-100" };
  const stale = obs({ snapshot: snapshot([]), anomalies: sites, refusals: siteWarpRefused(2) });
  let mem: MacroMemory = {};
  for (let read = 0; read < 3; read += 1) {
    mem = mine(siteStep(), stale, mem, board).nextMem;
  }
  const out = mine(siteStep(), stale, mem, board);
  assert.ok(out.action.kind === "warpScan" && out.action.target === "QEE-200");
});

test("mine (site mode): a barren grid with no ore-site tour ahead of it -> blocked asking for one, never a guessed label", () => {
  const sites = [{ label: "QEE-100", kind: "ore" as const }];
  const t = mineUntilBarren(siteStep(), obs({ snapshot: snapshot([]), anomalies: sites }), {});
  assert.equal(t.outcome.kind, "blocked");
  assert.match(
    t.outcome.kind === "blocked" ? t.outcome.reason : "",
    /Fly-to-an-ore-site/i,
  );
  assert.equal(t.boardPatch, undefined, "nothing to mark barren without a label");
});

// ── mine (site mode): the empty-grid confirmation guard ─────────────────────
// A ship fresh off a warp reads its own new grid as empty for a tick or two
// before the snapshot catches up — `fightRatsLadder`'s own
// EMPTY_GRID_CONFIRM_TICKS comment names the live incident. For site mode
// believing that first read would strike a full ore site off `oreSitesBarren`
// for the rest of the run before anyone ever saw the rock, so the same
// constant gates every barren mark and every `warpScan` this block issues.

test("mine (site mode): a grid that reads empty on tick one but has rock by tick two is mined, never marked barren", () => {
  const board = { oreAnomsVisited: "QEE-100" };

  // Tick 1: freshly arrived, the snapshot has not filled in yet -> reads empty.
  const t1 = mine(siteStep(), obs({ snapshot: snapshot([]) }), NM, board);
  assert.equal(t1.outcome.kind, "acting", "still confirming, not a verdict yet");
  assert.equal(t1.boardPatch, undefined, "nothing marked barren on a single unconfirmed read");
  assert.equal(t1.nextMem["oreGridEmptyReads"], 1);
  assert.match(t1.why, /reading it again/i, "still checking, not a decision — see the tour's own EMPTY_SCAN_CONFIRM_READS sentence this must not borrow");

  // Tick 2: the snapshot has caught up and the rock is there — mined outright,
  // and the confirm count is simply not among what `mineWithRocks` carries
  // forward (it rebuilds its own memory on every return).
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 8000, y: 0, z: 0 } });
  const t2 = mine(siteStep(), obs({ snapshot: snapshot([rock]) }), t1.nextMem, board);
  assert.equal(t2.action.kind, "orbit");
  assert.ok(t2.action.kind === "orbit" && t2.action.targetID === 50001);
  assert.equal(t2.nextMem["oreGridEmptyReads"], undefined, "the confirm count did not survive a rock being found");
});

test("mine (site mode): a grid empty for the full confirm count is marked barren and left", () => {
  const sites = [
    { label: "QEE-100", kind: "ore" as const },
    { label: "QEE-200", kind: "ore" as const },
  ];
  const world = obs({ snapshot: snapshot([]), anomalies: sites });
  const board = { oreAnomsVisited: "QEE-100" };

  let mem: MacroMemory = {};
  let last = mine(siteStep(), world, mem, board);
  assert.equal(last.outcome.kind, "acting", "read 1 of 3 — not yet confirmed");
  assert.equal(last.boardPatch, undefined);

  mem = last.nextMem;
  last = mine(siteStep(), world, mem, board);
  assert.equal(last.outcome.kind, "acting", "read 2 of 3 — still not confirmed");
  assert.equal(last.boardPatch, undefined);

  mem = last.nextMem;
  last = mine(siteStep(), world, mem, board);
  assert.equal(last.action.kind, "wait", "read 3 of 3 — the next site is committed before the press");
  assert.equal(last.nextMem["siteTarget"], "QEE-200");
  assert.equal(last.boardPatch?.["oreSitesBarren"], "QEE-100");

  last = mine(siteStep(), world, last.nextMem, board);
  assert.equal(last.action.kind, "warpScan", "then it warps");
  assert.ok(last.action.kind === "warpScan" && last.action.target === "QEE-200");
  assert.equal(last.boardPatch?.["oreSitesBarren"], "QEE-100");
});

test("mine (site mode): ore priority is evaluated PER GRID — Arkonor is mineable again at a later site after an earlier site had none", () => {
  const step = siteStep([ARKONOR, BISTOT]);

  // Site 1: only Bistot is on this grid. Arkonor being absent HERE must not
  // read as "Arkonor is gone for the run" the way the system-wide ladder
  // (`mineOreTier`) would have made it.
  const bistotOnly = entity({ itemID: 50001, name: "Bistot", groupID: BISTOT.groupID, miningYieldTypeID: 1240, position: { x: 8000, y: 0, z: 0 } });
  const t1 = mine(step, obs({ snapshot: snapshot([bistotOnly]) }), NM, { oreAnomsVisited: "QEE-100" });
  assert.ok(t1.action.kind === "orbit" && t1.action.targetID === 50001, "Bistot mined because Arkonor is not on this grid, not because it ran out");

  // Site 2: a fresh grid where Arkonor IS present, and closer competing
  // Bistot must not win — Arkonor is still the higher-priority family.
  const arkonor = entity({ itemID: 50002, name: "Arkonor", groupID: ARKONOR.groupID, miningYieldTypeID: 1241, position: { x: 9000, y: 0, z: 0 } });
  const bistot2 = entity({ itemID: 50003, name: "Bistot", groupID: BISTOT.groupID, miningYieldTypeID: 1240, position: { x: 3000, y: 0, z: 0 } });
  const t2 = mine(step, obs({ snapshot: snapshot([arkonor, bistot2]) }), NM, { oreAnomsVisited: "QEE-100,QEE-200" });
  assert.ok(t2.action.kind === "orbit" && t2.action.targetID === 50002, "Arkonor wins over the closer Bistot rock — the ladder never retired it");
});

test("deliver: docked with ore -> unload; docked empty -> done", () => {
  const withOre: MiningHold[] = [{ key: "ore", label: "Ore Hold", items: [{ itemID: 8, typeID: 1230, groupID: 462, categoryID: 25, quantity: 100 }], capacity: null, present: true, error: null }];
  const unload = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds: withOre }), NM, {});
  assert.ok(unload.action.kind === "unloadOre" && unload.action.itemIDs.includes(8));

  const done = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds: [] }), NM, {});
  assert.equal(done.outcome.kind, "done");
});

test("deliver: unreadable freight stays incomplete until an authoritative empty read", () => {
  const cargo: MiningHold = { key: "cargo", label: "Cargo Hold", items: [], capacity: { capacity: 400, used: 0 }, present: true, error: null };
  const ore: MiningHold = { key: "ore", label: "Ore Hold", items: null, capacity: { capacity: 5_000, used: 4_900 }, present: true, error: "READ_FAILED" };
  const atHome = obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds: [ore, cargo] });
  const unread = deliver(haulStep, atHome, NM, {});
  assert.equal(unread.action.kind, "wait");
  assert.equal(unread.outcome.kind, "acting");
  assert.equal(deliver(haulStep, { ...atHome, holds: [{ ...ore, present: false, capacity: null }, cargo] }, NM, {}).outcome.kind, "acting");
  const read = deliver(haulStep, { ...atHome, holds: [{ ...ore, items: [], error: null }, cargo] }, unread.nextMem, {});
  assert.equal(read.outcome.kind, "done");
});

test("deliver: a corporation division is carried on the action; without one the key is ABSENT", () => {
  const withOre: MiningHold[] = [{ key: "ore", label: "Ore Hold", items: [{ itemID: 8, typeID: 1230, groupID: 462, categoryID: 25, quantity: 100 }], capacity: null, present: true, error: null }];
  const docked = obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds: withOre });

  const corpStep: MacroStep = {
    ...haulStep,
    args: { ...haulStep.args, into: { kind: "corpDivision", division: 5, name: "Ore Buffer" } },
  };
  const aimed = deliver(corpStep, docked, NM, {});
  assert.ok(aimed.action.kind === "unloadOre" && aimed.action.division === 5);
  // It is still an ordinary unload otherwise: the block is done when the holds
  // are empty, whoever ends up holding the ore.
  assert.equal(aimed.outcome.kind, "acting");

  // A block nobody aimed issues exactly what it always did — no division key at
  // all, not a null one.
  const plain = deliver(haulStep, docked, NM, {});
  assert.ok(plain.action.kind === "unloadOre");
  assert.deepEqual(plain.action, { kind: "unloadOre", itemIDs: [8] });
});

test("deliver: the ore hold goes ashore, the CARGO hold stays aboard", () => {
  // A barge carrying spare mining crystals in cargo. Before this, the delivery
  // took them too — the mining-holds route reports cargo as a fallback entry on
  // every hull and the block emptied every hold it was handed.
  const holds: MiningHold[] = [
    { key: "ore", label: "Ore Hold", items: [{ itemID: 8, typeID: 1230, groupID: 462, categoryID: 25, quantity: 100 }], capacity: null, present: true, error: null },
    { key: "cargo", label: "Cargo Hold", items: [{ itemID: 99, typeID: 3389, groupID: 483, categoryID: 8, quantity: 4 }], capacity: null, present: true, error: null },
  ];
  const t = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds }), NM, {});
  assert.ok(t.action.kind === "unloadOre");
  assert.deepEqual(t.action.kind === "unloadOre" ? [...t.action.itemIDs] : [], [8], "the crystals stayed in cargo");
});

test("deliver: a hull with no ore hold still delivers what it mined into cargo", () => {
  const holds: MiningHold[] = [
    { key: "cargo", label: "Cargo Hold", items: [{ itemID: 42, typeID: 1230, groupID: 462, categoryID: 25, quantity: 50 }], capacity: null, present: true, error: null },
  ];
  const t = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds }), NM, {});
  assert.ok(t.action.kind === "unloadOre" && t.action.itemIDs.includes(42));
});

test("deliver: an empty ore hold is DONE even with cargo aboard", () => {
  const holds: MiningHold[] = [
    { key: "ore", label: "Ore Hold", items: [], capacity: null, present: true, error: null },
    { key: "cargo", label: "Cargo Hold", items: [{ itemID: 99, typeID: 3389, groupID: 483, categoryID: 8, quantity: 4 }], capacity: null, present: true, error: null },
  ];
  const t = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds }), NM, {});
  assert.equal(t.outcome.kind, "done", "the trip delivered its ore; the cargo hold is not its business");
});

test("deliver: in space, away from the station -> ride the autopilot there (multi-system)", () => {
  const t = deliver(haulStep, obs({ snapshot: snapshot([]) }), NM, {});
  assert.ok(t.action.kind === "startRoute" && t.action.stationID === 60000004);
});

test("deliver: docked at the WRONG station -> not done, heads for the right one", () => {
  const t = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000099 }), snapshot: null }), NM, {});
  assert.ok(t.action.kind === "startRoute" && t.action.stationID === 60000004);
});

test("deliver: drones out -> recall them first (never abandon them)", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = deliver(haulStep, obs({ snapshot: snapshot([drone]), dronesOut: true }), NM, {});
  assert.ok(t.action.kind === "recallDrones" && t.action.droneIDs.includes(111));
  assert.equal(t.nextMem["recalled"], true);
});

test("deliver: recalled but still out -> align out toward the station while they come home", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  // The station is ON THIS GRID, so the wait is spent already aligned toward it.
  const station = entity({ itemID: 60000004, kind: "station", position: { x: 900000, y: 0, z: 0 } });
  const t = deliver(haulStep, obs({ snapshot: snapshot([drone, station]), dronesOut: true }), { recalled: true }, {});
  assert.ok(t.action.kind === "align" && t.action.targetID === 60000004);
});

test("deliver: recalled, station OFF-grid -> no align (nothing to align to), just hold", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = deliver(haulStep, obs({ snapshot: snapshot([drone]), dronesOut: true }), { recalled: true }, {});
  assert.equal(t.action.kind, "wait");
});

test("deliver: recalled + aligned, still out -> hold until they're all in", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = deliver(haulStep, obs({ snapshot: snapshot([drone]), dronesOut: true }), { recalled: true, aligned: true, recallWaited: 1 }, {});
  assert.equal(t.action.kind, "wait");
});

test("deliver: 0 drones in space -> head out", () => {
  const t = deliver(haulStep, obs({ snapshot: snapshot([]), dronesOut: false }), { recalled: true, aligned: true, recallWaited: 3 }, {});
  assert.ok(t.action.kind === "startRoute" && t.action.stationID === 60000004);
});

test("deliver: drones never make it home -> leave anyway once the wait is spent", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = deliver(haulStep, obs({ snapshot: snapshot([drone]), dronesOut: true }), { recalled: true, aligned: true, recallWaited: 999 }, {});
  assert.ok(t.action.kind === "startRoute" && t.action.stationID === 60000004);
});

const defendStep = { id: "d", kind: "macro", macro: "defend-with-drones", args: {} } as const;
const pirate = () => entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });

test("defend: a pirate and combat drones in the bay, none out -> launch ONLY the combat drones", () => {
  // A mixed bay: two Hobgoblins and a Salvage Drone. The salvage drone stays in.
  const t = defend(defendStep, obs({ snapshot: snapshot([pirate()]), dronesOut: false, droneBayItemIDs: [111, 112, 113], combatDroneBayItemIDs: [111, 112], salvageDroneBayItemIDs: [113] }), NM, {});
  assert.ok(t.action.kind === "launchDrones");
  assert.deepEqual(t.action.droneItemIDs, [111, 112]);
});

test("defend: a bay of salvage drones is NOT a defence -> blocked with a plain reason", () => {
  const t = defend(defendStep, obs({ snapshot: snapshot([pirate()]), dronesOut: false, droneBayItemIDs: [113], combatDroneBayItemIDs: [], salvageDroneBayItemIDs: [113] }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /no combat drones/i);
});

test("defend: salvage drones out, combat drones in the bay -> call the salvage drones in first, launch once they are home", () => {
  const salvager = entity({ itemID: 113, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const world = (out: SpaceEntity[]) =>
    obs({ snapshot: snapshot([pirate(), ...out]), dronesOut: out.length > 0, droneBayItemIDs: [111], combatDroneBayItemIDs: [111], salvageDroneBayItemIDs: [], combatDroneIDs: [], salvageDroneIDs: out.map((e) => e.itemID) });
  // Tick 1: the salvage drone holds the slot — recall it, not the bay.
  const recall = defend(defendStep, world([salvager]), {}, {});
  assert.ok(recall.action.kind === "recallDrones" && recall.action.droneIDs.includes(113));
  // Tick 2: still coming home — wait, do not spam the launch.
  const wait = defend(defendStep, world([salvager]), recall.nextMem, {});
  assert.equal(wait.action.kind, "wait");
  assert.equal(wait.outcome.kind, "acting");
  // Tick 3: home — the combat drones go out.
  const launch = defend(defendStep, world([]), wait.nextMem, {});
  assert.ok(launch.action.kind === "launchDrones");
  assert.deepEqual(launch.action.droneItemIDs, [111]);
});

test("defend: a mixed flight out -> only the combat drones are sent onto the pirate", () => {
  const hob = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const salvager = entity({ itemID: 113, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = defend(defendStep, obs({ snapshot: snapshot([pirate(), hob, salvager]), dronesOut: true, combatDroneIDs: [111], salvageDroneIDs: [113] }), NM, {});
  assert.ok(t.action.kind === "engageDrones" && t.action.targetID === 6661);
  assert.deepEqual(t.action.droneIDs, [111]);
});

test("defend: the launch is bounded — a bay that will not launch blocks rather than spinning", () => {
  const t = defend(defendStep, obs({ snapshot: snapshot([pirate()]), dronesOut: false, combatDroneBayItemIDs: [111] }), { launchTries: 3 }, {});
  assert.equal(t.outcome.kind, "blocked");
});

test("defend: pirate dead but drones still out -> recall them, not done yet", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = defend({ id: "d", kind: "macro", macro: "defend-with-drones", args: {} }, obs({ snapshot: snapshot([drone]), dronesOut: true }), NM, {});
  assert.ok(t.action.kind === "recallDrones" && t.action.droneIDs.includes(111));
  assert.notEqual(t.outcome.kind, "done");
});

test("travel-to-station: rides the shared autopilot (multi-system) and is done only at the TARGET", () => {
  const travelTo = SCRIPT_MACROS["travel-to-station"]!;
  const s: MacroStep = { id: "t", kind: "macro", macro: "travel-to-station", args: { station: { kind: "station", ref: { entity: "station", id: 60000007, name: "Far", systemName: null } } } };

  // In space, target off-grid -> hand the trip to the autopilot.
  const go = travelTo(s, obs({ snapshot: snapshot([]) }), {}, {});
  assert.ok(go.action.kind === "startRoute" && go.action.stationID === 60000007);

  // The autopilot flying it -> wait, don't re-issue.
  const riding = travelTo(
    s,
    obs({ snapshot: snapshot([]), travel: { status: "running", destinationStationID: 60000007, remainingJumps: 3, failureReason: null } }),
    {},
    {},
  );
  assert.equal(riding.action.kind, "wait");

  // Docked SOMEWHERE ELSE is not arrived — it heads out again.
  const wrongStation = travelTo(s, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), snapshot: null }), {}, {});
  assert.ok(wrongStation.action.kind === "startRoute");

  // Docked at the target -> done.
  const arrived = travelTo(s, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000007 }), snapshot: null }), {}, {});
  assert.equal(arrived.outcome.kind, "done");

  // A STALE failure from an old route does not block a fresh trip.
  const staleFailure = travelTo(
    s,
    obs({ snapshot: snapshot([]), travel: { status: "idle", destinationStationID: 60000099, remainingJumps: 0, failureReason: "old news" } }),
    {},
    {},
  );
  assert.ok(staleFailure.action.kind === "startRoute", "a failure on ANOTHER destination is ignored");
});

// ── travel-to-system ─────────────────────────────────────────────────────────
//
// The block exists because set-destination does NOT wait, and a bot whose next
// step reads the grid stops the run when it starts two gates early. These tests
// pin the one property that difference lives in: arrival, and only arrival,
// finishes it.

const HOME_SYSTEM = 30000142;
const FAR_SYSTEM = 30000144;
const flyToSystem = SCRIPT_MACROS["travel-to-system"]!;
const systemStep: MacroStep = {
  id: "ts",
  kind: "macro",
  macro: "travel-to-system",
  args: { system: { kind: "system", ref: { entity: "system", id: FAR_SYSTEM, name: "Far", systemName: "Far" } } },
};

test("travel-to-system: rides the shared autopilot and is done ONLY once the ship is in the system", () => {
  // Elsewhere -> hand the trip to the autopilot's system plan (no final dock).
  const go = flyToSystem(systemStep, obs({ snapshot: snapshot([]) }), {}, {});
  assert.ok(go.action.kind === "startSystemRoute" && go.action.systemID === FAR_SYSTEM);
  assert.notEqual(go.outcome.kind, "done");

  // Under way -> wait, never re-issue the route every tick.
  const riding = flyToSystem(
    systemStep,
    obs({ snapshot: snapshot([]), travel: { status: "running", destinationSystemID: FAR_SYSTEM, destinationStationID: null, remainingJumps: 2, failureReason: null } }),
    {},
    {},
  );
  assert.equal(riding.action.kind, "wait");
  assert.notEqual(riding.outcome.kind, "done");

  // ⚠ THE WHOLE POINT. Mid-route, one gate short, is NOT arrived — this is the
  // tick where set-destination would already have handed the next block a grid
  // in the wrong system.
  const oneGateShort = flyToSystem(systemStep, obs({ flightStatus: flight({ solarSystemID: 30000148 }), snapshot: snapshot([]) }), {}, {});
  assert.notEqual(oneGateShort.outcome.kind, "done");

  // There -> done.
  const arrived = flyToSystem(systemStep, obs({ flightStatus: flight({ solarSystemID: FAR_SYSTEM }), snapshot: snapshot([]) }), {}, {});
  assert.equal(arrived.outcome.kind, "done");
});

test("travel-to-system: DOCKED in the destination system counts as arrived", () => {
  // The autopilot's own system plan treats a dock in the destination system as
  // arrival and will not undock for it, so a stricter rule here would hang
  // forever. A program that needs to be in space says so with an undock block.
  const dockedThere = flyToSystem(
    systemStep,
    obs({ flightStatus: flight({ docked: true, inSpace: false, solarSystemID: FAR_SYSTEM, stationID: 60000007 }), snapshot: null }),
    {},
    {},
  );
  assert.equal(dockedThere.outcome.kind, "done");
});

test("travel-to-system: a failure on THIS trip blocks; a stale one from another does not", () => {
  const failed = flyToSystem(
    systemStep,
    obs({ snapshot: snapshot([]), travel: { status: "idle", destinationSystemID: FAR_SYSTEM, destinationStationID: null, remainingJumps: 0, failureReason: "Off route" } }),
    {},
    {},
  );
  assert.equal(failed.outcome.kind, "blocked");

  const stale = flyToSystem(
    systemStep,
    obs({ snapshot: snapshot([]), travel: { status: "idle", destinationSystemID: HOME_SYSTEM, destinationStationID: null, remainingJumps: 0, failureReason: "old news" } }),
    {},
    {},
  );
  assert.ok(stale.action.kind === "startSystemRoute", "a failure on ANOTHER destination is ignored");
});

test("travel-to-system: drones out come home before the ship warps off", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = flyToSystem(systemStep, obs({ snapshot: snapshot([drone]), dronesOut: true }), {}, {});
  assert.ok(t.action.kind === "recallDrones" && t.action.droneIDs.includes(111));
});

test("travel-to-system: an unpicked system blocks instead of flying somewhere arbitrary", () => {
  const unbound: MacroStep = {
    id: "ts",
    kind: "macro",
    macro: "travel-to-system",
    args: { system: { kind: "system", ref: { entity: "system", id: null, name: null, systemName: null } } },
  };
  assert.equal(flyToSystem(unbound, obs({ snapshot: snapshot([]) }), {}, {}).outcome.kind, "blocked");
});

test("salvage: wrecks + drones out -> lock the wreck, send the drones at IT; grid clean -> recall, then done", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", name: "Wreck", position: { x: 3000, y: 0, z: 0 } });
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const world = (locked: number[]) =>
    obs({ snapshot: snapshot([wreck, drone]), dronesOut: true, salvageDroneIDs: [111], lockedTargetIDs: locked });

  // ⚠ NEVER targetID 0: the server's auto-pick only takes the pilot's or a
  // current fleet mate's wrecks, and left the drones idle beside everyone else's.
  const lock = salvage(s, world([]), {}, {});
  assert.ok(lock.action.kind === "lock" && lock.action.targetID === 70001);
  const send = salvage(s, world([70001]), lock.nextMem, {});
  assert.ok(send.action.kind === "salvageDrones" && send.action.targetID === 70001 && send.action.droneIDs.includes(111));
  const hold = salvage(s, world([70001]), send.nextMem, {});
  assert.equal(hold.action.kind, "wait", "sent once: a repeated order restarts the salvage cycle");

  const recall = salvage(s, obs({ snapshot: snapshot([drone]), dronesOut: true, salvageDroneIDs: [111] }), {}, {});
  assert.ok(recall.action.kind === "recallDrones");

  const done = salvage(s, obs({ snapshot: snapshot([]) }), {}, {});
  assert.equal(done.outcome.kind, "done");
});

test("salvage: a mixed flight out -> only the SALVAGE drones get the order; the combat drones are left alone", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const hob = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const salvager = entity({ itemID: 113, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = salvage(s, obs({ snapshot: snapshot([wreck, hob, salvager]), dronesOut: true, combatDroneIDs: [111], salvageDroneIDs: [113], lockedTargetIDs: [70001] }), { wreckID: 70001, lockIssued: true }, {});
  assert.ok(t.action.kind === "salvageDrones");
  assert.deepEqual(t.action.droneIDs, [113]);
  // Grid swept: EVERY drone comes home, whatever it is.
  const recall = salvage(s, obs({ snapshot: snapshot([hob, salvager]), dronesOut: true, combatDroneIDs: [111], salvageDroneIDs: [113] }), {}, {});
  assert.ok(recall.action.kind === "recallDrones");
  assert.deepEqual([...recall.action.droneIDs].sort(), [111, 113]);
});

test("salvage: drones only -> close to lock range when outside it; a wreck that will not lock is passed, then the block finishes", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 50000, y: 0, z: 0 } });
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const world = (range: number | null) =>
    obs({ snapshot: snapshot([wreck, drone]), dronesOut: true, salvageDroneIDs: [111], maxTargetRangeM: range });

  const close = salvage(s, world(30000), {}, {});
  assert.ok(close.action.kind === "approach" && close.action.targetID === 70001);

  // Lock range unreadable: no approach, the bounded lock wait is the backstop.
  let mem: MacroMemory = {};
  let last = salvage(s, world(null), mem, {});
  for (let i = 0; i < 20 && last.action.kind !== "recallDrones"; i += 1) {
    mem = last.nextMem;
    last = salvage(s, world(null), mem, {});
  }
  assert.ok(last.action.kind === "recallDrones", "the only wreck would not lock, so the drones come home");
});

test("salvage: combat drones out from the fight, salvage drones in the bay -> call the combat drones in, then launch ONLY the salvage drones", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const hob = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const world = (out: SpaceEntity[]) =>
    obs({
      snapshot: snapshot([wreck, ...out]),
      dronesOut: out.length > 0,
      droneBayItemIDs: [112, 113],
      combatDroneBayItemIDs: [112],
      salvageDroneBayItemIDs: [113],
      combatDroneIDs: out.map((e) => e.itemID),
      salvageDroneIDs: [],
    });
  const recall = salvage(s, world([hob]), {}, {});
  assert.ok(recall.action.kind === "recallDrones" && recall.action.droneIDs.includes(111), "the Hobgoblin goes home first");
  const wait = salvage(s, world([hob]), recall.nextMem, {});
  assert.equal(wait.action.kind, "wait");
  assert.equal(wait.outcome.kind, "acting", "still working — not blocked, not done");
  const launch = salvage(s, world([]), wait.nextMem, {});
  assert.ok(launch.action.kind === "launchDrones");
  assert.deepEqual(launch.action.droneItemIDs, [113], "the Hobgoblin stays in the bay");
});

test("salvage: a bay of combat drones and no salvager is NO way to salvage -> skipped", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const t = salvage(s, obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [], droneBayItemIDs: [111, 112], combatDroneBayItemIDs: [111, 112], salvageDroneBayItemIDs: [] }), {}, {});
  assert.equal(t.outcome.kind, "skipped");
  assert.match(t.outcome.kind === "skipped" ? t.outcome.reason : "", /no salvage drones/i);
});

test("salvage: combat drones out, nothing that can salvage -> skipped, and it says why", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const hob = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = salvage(s, obs({ snapshot: snapshot([wreck, hob]), dronesOut: true, combatDroneIDs: [111], salvageDroneIDs: [], salvageDroneBayItemIDs: [] }), {}, {});
  assert.equal(t.outcome.kind, "skipped");
  assert.match(t.outcome.kind === "skipped" ? t.outcome.reason : "", /cannot salvage/i);
});

test("salvage: no drones, salvager fitted -> approach, lock, run it on the wreck", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });

  const go = salvage(s, obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [800] }), {}, {});
  assert.ok(go.action.kind === "approach" && go.action.targetID === 70001);

  const run = salvage(
    s,
    obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [800], lockedTargetIDs: [70001] }),
    { wreckID: 70001, lockIssued: true, waited: 0 },
    {},
  );
  assert.ok(run.action.kind === "activate" && run.action.moduleID === 800 && run.action.targetID === 70001);
});

// ⚠ THE SILENT-REFUSAL TESTS. `CmdFollowBall` answers 200 whether the server
// flew the order or threw it away — a hull with a pending warp landing has every
// approach refused while the approach route's own SetSpeedFraction leaves it
// coasting in GOTO, which is the deadlock that used to leave this block saying
// "Flying to the wreck" all night. The hull's MODE is the only evidence, so
// these two pin both readings of it.
const farWreck = () => entity({ itemID: 70001, kind: "wreck", position: { x: 30000, y: 0, z: 0 } });

test("salvage: a hull that IS following is left alone — no re-order, however long the leg", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const world = obs({ snapshot: snapshot([farWreck()], { mode: "FOLLOW" }), salvageModuleIDs: [800] });
  let mem: MacroMemory = { wreckID: 70001, lockIssued: false, waited: 0 };
  for (let i = 0; i < 20; i += 1) {
    const t = salvage(s, world, mem, {});
    assert.equal(t.action.kind, "wait", `tick ${i} re-ordered a flight that was already running`);
    assert.equal(t.why, "Flying to the wreck.");
    mem = t.nextMem;
  }
});

test("⚠ salvage: an approach the server accepted and ignored -> re-order, STOP, re-order, then blocked", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  // GOTO is the deadlock's own signature: full speed on a straight line, which
  // is what SetSpeedFraction(1.0) leaves behind when the FollowBall after it is
  // refused for the pending landing.
  const world = obs({ snapshot: snapshot([farWreck()], { mode: "GOTO" }), salvageModuleIDs: [800] });
  let mem: MacroMemory = { wreckID: 70001, lockIssued: false, waited: 0 };
  const script: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const t = salvage(s, world, mem, {});
    script.push(t.action.kind);
    if (t.outcome.kind === "blocked") {
      assert.match(t.outcome.reason, /takes move orders and does not move/);
      assert.match(t.outcome.reason, /Sign this pilot in again/);
      break;
    }
    mem = t.nextMem;
  }
  const ordered = script.filter((kind) => kind !== "wait");
  assert.deepEqual(ordered, ["approach", "stopShip", "approach"], "the stop is what frees a stuck landing");
  assert.ok(script.length < 20, "it gives up rather than narrating a flight that is not happening");
});

test("salvage: nothing to salvage with -> SKIPPED with a plain reason, not a stop", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const t = salvage(s, obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [], droneBayItemIDs: [] }), {}, {});
  assert.equal(t.outcome.kind, "skipped");
  assert.match(t.outcome.kind === "skipped" ? t.outcome.reason : "", /no salvage drones in the bay and no salvager fitted/);
  // A bay stack whose group could not be read is NAMED, not passed off as an empty bay.
  const unread = salvage(s, obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [], droneBayItemIDs: [111], salvageDroneBayItemIDs: [], unclassifiedDroneBayItemIDs: [111] }), {}, {});
  assert.equal(unread.outcome.kind, "skipped");
  assert.match(unread.outcome.kind === "skipped" ? unread.outcome.reason : "", /could not be identified/);
});

test("loot: only YOUR wrecks are ever opened — others' and unknown-owner wrecks never", () => {
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const s = { id: "lw", kind: "macro", macro: "loot-wrecks", args: {} } as const;
  const mine = entity({ itemID: 70001, kind: "wreck", ownerID: 90000001, position: { x: 1000, y: 0, z: 0 } });
  // Another PILOT's: an owner in the players' range. (An owner below it is the system's or an NPC's, and the
  // server lets anyone take from that: see the system-owned case below.)
  const theirs = entity({ itemID: 70002, kind: "wreck", ownerID: 90000555, position: { x: 500, y: 0, z: 0 } });
  const unknown = entity({ itemID: 70003, kind: "wreck", ownerID: null, position: { x: 200, y: 0, z: 0 } });

  // Mine is FARTHEST, yet it is the only one this block will ever touch.
  const t = loot(s, obs({ snapshot: snapshot([mine, theirs, unknown]), myCharacterID: 90000001 }), {}, {});
  assert.ok(t.action.kind === "lootWreck" && t.action.wreckID === 70001);

  // Nothing of ours left -> done, with the other wrecks still on grid untouched.
  const done = loot(s, obs({ snapshot: snapshot([theirs, unknown]), myCharacterID: 90000001 }), {}, {});
  assert.equal(done.outcome.kind, "done");

  // A wreck no player owns (a site's own, owner 1) is free to anyone, as the server's loot right has it.
  const sites = entity({ itemID: 70004, kind: "wreck", ownerID: 1, position: { x: 300, y: 0, z: 0 } });
  const free = loot(s, obs({ snapshot: snapshot([theirs, unknown, sites]), myCharacterID: 90000001 }), {}, {});
  assert.ok(free.action.kind === "lootWreck" && free.action.wreckID === 70004);
});

test("loot: far from your wreck -> approach first; looted wrecks are not reopened", () => {
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const s = { id: "lw", kind: "macro", macro: "loot-wrecks", args: {} } as const;
  const far = entity({ itemID: 70001, kind: "wreck", ownerID: 90000001, position: { x: 90000, y: 0, z: 0 } });

  const go = loot(s, obs({ snapshot: snapshot([far]), myCharacterID: 90000001 }), {}, {});
  assert.ok(go.action.kind === "approach" && go.action.targetID === 70001);

  const skip = loot(s, obs({ snapshot: snapshot([far]), myCharacterID: 90000001 }), { looted: [70001] }, {});
  assert.equal(skip.outcome.kind, "done", "an already-looted wreck is never reopened");
});

test("loot-containers: any container is fair game, no ownership check", () => {
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const mine = entity({ itemID: 80001, kind: "container", ownerID: 90000001, position: { x: 1000, y: 0, z: 0 } });
  const theirs = entity({ itemID: 80002, kind: "container", ownerID: 555, position: { x: 500, y: 0, z: 0 } });
  const unknown = entity({ itemID: 80003, kind: "container", ownerID: null, position: { x: 200, y: 0, z: 0 } });

  // Nearest wins regardless of owner — unlike loot-wrecks, nothing here is off limits.
  const t = loot(s, obs({ snapshot: snapshot([mine, theirs, unknown]), myCharacterID: 90000001 }), {}, {});
  assert.ok(t.action.kind === "lootContainer" && t.action.containerID === 80003);

  // Nothing left, and the settle window (see the dedicated test below) has
  // already run out -> done.
  const done = loot(
    s,
    obs({ snapshot: snapshot([]), myCharacterID: 90000001 }),
    { emptyChecks: 30 },
    {},
  );
  assert.equal(done.outcome.kind, "done");
});

test("loot-containers: an empty read right after arrival waits out a settle window instead of leaving immediately", () => {
  // No natural pause the way a player starting the bot by hand gets — landing
  // on a belt and checking for containers on the very next tick can read one
  // tick ahead of a not-yet-caught-up snapshot. A single empty read must not
  // send the bot straight back to the station.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;

  const firstCheck = loot(s, obs({ snapshot: snapshot([]) }), {}, {});
  assert.equal(firstCheck.action.kind, "wait");
  assert.notEqual(firstCheck.outcome.kind, "done", "one empty read is not proof the grid never had a can");
  assert.equal(firstCheck.nextMem["emptyChecks"], 1);

  // A can showing up mid-window resets the count and gets worked normally.
  const can = entity({ itemID: 80001, kind: "container", position: { x: 90000, y: 0, z: 0 } });
  const found = loot(s, obs({ snapshot: snapshot([can]) }), firstCheck.nextMem, {});
  assert.ok(found.action.kind === "approach" && found.action.targetID === 80001);
  assert.equal(found.nextMem["emptyChecks"], 0);

  // Genuinely nothing there for the whole window -> done, not stuck forever.
  const stillEmpty = loot(s, obs({ snapshot: snapshot([]) }), { emptyChecks: 30 }, {});
  assert.equal(stillEmpty.outcome.kind, "done");
});

test("loot-containers: far from a container -> approach first", () => {
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const far = entity({ itemID: 80001, kind: "container", position: { x: 90000, y: 0, z: 0 } });

  const go = loot(s, obs({ snapshot: snapshot([far]) }), {}, {});
  assert.ok(go.action.kind === "approach" && go.action.targetID === 80001);
});

/** One entry as the run's refusal ledger would report it. */
function refusal(
  stepID: string,
  actionKind: string,
  targetID: number,
  count: number,
  kind: "refused" | "unreachable" | "gone" = "refused",
) {
  return {
    key: `${stepID}:${actionKind}:${targetID}`,
    count,
    firstAt: 0,
    lastAt: 0,
    words: "There isn't enough room in that hold.",
    kind,
  };
}

test("loot-containers: still on grid after a loot attempt -> tried again, never silently believed emptied", () => {
  // A jetcan the server has not despawned is a jetcan that is NOT actually
  // empty yet (jettisonRuntime.js's maybeExpireEmptySpaceContainer despawns it
  // the instant it truly is) — so seeing it again next tick means the transfer
  // likely declined, and the block has to retry rather than trust its own
  // "I already issued the action" memory and move on leaving the ore behind.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const can = entity({ itemID: 80001, kind: "container", position: { x: 1000, y: 0, z: 0 } });

  const retry = loot(s, obs({ snapshot: snapshot([can]), refusals: [refusal("lc", "lootContainer", 80001, 1)] }), {}, {});
  assert.ok(retry.action.kind === "lootContainer" && retry.action.containerID === 80001);
});

test("loot-containers: a can that keeps refusing is set aside — and the bound SURVIVES the lap", () => {
  // The bound now lives on the RUN's ledger, not in step memory. That is the
  // whole change: `scriptDecide` drops step memory every time the block is left,
  // so the old `tries` counter handed each stubborn can a fresh five attempts on
  // every lap of a `forever` loop — which is exactly why the original log shows
  // repeating bursts of five instead of one burst and then silence.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const stuck = entity({ itemID: 80001, kind: "container", position: { x: 1000, y: 0, z: 0 } });
  const other = entity({ itemID: 80002, kind: "container", position: { x: 2000, y: 0, z: 0 } });
  const ledger = [refusal("lc", "lootContainer", 80001, 5)];

  // Set aside, so a different can on the grid is picked instead.
  const next = loot(s, obs({ snapshot: snapshot([stuck, other]), refusals: ledger }), {}, {});
  assert.ok(next.action.kind === "lootContainer" && next.action.containerID === 80002);

  // ⚠ WITH FRESH MEMORY — a new lap. The old counter lived here and was wiped;
  // the ledger is not, so the can stays set aside.
  const nextLap = loot(s, obs({ snapshot: snapshot([stuck, other]), refusals: ledger }), {}, {});
  assert.ok(nextLap.action.kind === "lootContainer" && nextLap.action.containerID === 80002);

  // And with only the stuck can on grid, the block finishes rather than looping.
  const alone = loot(s, obs({ snapshot: snapshot([stuck]), refusals: ledger }), { emptyChecks: 99 }, {});
  assert.equal(alone.outcome.kind, "done");
});

/** Holds with a given amount of free room, as the mining-holds read reports it. */
function holdsWithFree(freeM3: number) {
  return [
    { key: "ore", label: "Ore hold", items: [], capacity: { capacity: 16000, used: 16000 - freeM3 }, present: true, error: null },
    { key: "cargo", label: "Cargo hold", items: [], capacity: { capacity: 0, used: 0 }, present: false, error: null },
  ];
}

test("loot-containers: a FULL ship finishes the block instead of reaching into the can", () => {
  // With nowhere to put anything there is nothing to attempt. Asking anyway is
  // the refusal loop; stopping the whole bot over it is not much better.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const can = entity({ itemID: 80001, kind: "container", position: { x: 10, y: 0, z: 0 } });
  const t = loot(s, obs({ snapshot: snapshot([can]), holds: holdsWithFree(0) as never }), {}, {});
  assert.equal(t.outcome.kind, "done");
  assert.match(t.why, /full/i);
});

test("loot-containers: room left -> it still loots", () => {
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const can = entity({ itemID: 80001, kind: "container", position: { x: 10, y: 0, z: 0 } });
  const t = loot(s, obs({ snapshot: snapshot([can]), holds: holdsWithFree(500) as never }), {}, {});
  assert.ok(t.action.kind === "lootContainer");
});

test("loot-containers: holds that could not be READ are never taken for full", () => {
  // "We could not look" is not "there is no room" — the block carries on and
  // lets the transfer decide, exactly as it did before.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const can = entity({ itemID: 80001, kind: "container", position: { x: 10, y: 0, z: 0 } });
  const t = loot(s, obs({ snapshot: snapshot([can]), holds: null }), {}, {});
  assert.ok(t.action.kind === "lootContainer");
});

test("loot-wrecks: a FULL ship finishes the block too", () => {
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const s = { id: "lw", kind: "macro", macro: "loot-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", ownerID: 90000001, position: { x: 10, y: 0, z: 0 } });
  const t = loot(
    s,
    obs({ snapshot: snapshot([wreck]), myCharacterID: 90000001, holds: holdsWithFree(0) as never }),
    {},
    {},
  );
  assert.equal(t.outcome.kind, "done");
});

test("loot-containers: the FIRST no-room ends the block — it is not proved once per can", () => {
  // The failure this closes: the ore hold is full after mining, the cans hold
  // ore, and ore does not fall through to cargo. Every can then answers "no
  // room", and the block spent five attempts with a growing backoff on EACH
  // before setting it aside. With a belt full of cans that is minutes of a bot
  // doing nothing, which is indistinguishable from a hang.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const a = entity({ itemID: 80001, kind: "container", position: { x: 10, y: 0, z: 0 } });
  const b = entity({ itemID: 80002, kind: "container", position: { x: 20, y: 0, z: 0 } });
  const noRoom = {
    key: "lc:lootContainer:80001",
    count: 1,
    firstAt: 0,
    lastAt: 0,
    words: "There is no room aboard for what is in that container.",
    kind: "no-room" as const,
  };
  // The ship is NOT full by the block's own measure — the cargo hold has room,
  // it is the ore hold that does not — so only the no-room record can end this.
  const t = loot(s, obs({ snapshot: snapshot([a, b]), refusals: [noRoom] }), {}, {});
  assert.equal(t.outcome.kind, "done", "one refusal answers for the whole belt");
  assert.match(t.why, /unload/i);
});

test("loot-wrecks: the same, so a full ship stops looting wrecks too", () => {
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const s = { id: "lw", kind: "macro", macro: "loot-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", ownerID: 90000001, position: { x: 10, y: 0, z: 0 } });
  const noRoom = {
    key: "lw:lootWreck:70001",
    count: 1,
    firstAt: 0,
    lastAt: 0,
    words: "There is no room aboard for what is in that container.",
    kind: "no-room" as const,
  };
  const t = loot(s, obs({ snapshot: snapshot([wreck]), myCharacterID: 90000001, refusals: [noRoom] }), {}, {});
  assert.equal(t.outcome.kind, "done");
});

test("loot-containers: a can that CANNOT BE REACHED is closed in on, never set aside", () => {
  // eve.js answers the same FakeItemNotFound for a despawned can and for one
  // merely out of range. Retiring on that would abandon every can the ship
  // drifted away from — most of them, on a hauling loop.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const can = entity({ itemID: 80001, kind: "container", position: { x: 10, y: 0, z: 0 } });
  const t = loot(
    s,
    obs({ snapshot: snapshot([can]), refusals: [refusal("lc", "lootContainer", 80001, 9, "unreachable")] }),
    {},
    {},
  );
  // In range by our own arithmetic, and it still closes in: the gateway's range
  // check beats the snapshot's.
  assert.ok(t.action.kind === "approach" && t.action.targetID === 80001);
});

test("loot-containers: a can that is GONE is set aside at once, without spending the budget", () => {
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const ghost = entity({ itemID: 80001, kind: "container", position: { x: 1000, y: 0, z: 0 } });
  const real = entity({ itemID: 80002, kind: "container", position: { x: 2000, y: 0, z: 0 } });
  const t = loot(
    s,
    obs({ snapshot: snapshot([ghost, real]), refusals: [refusal("lc", "lootContainer", 80001, 1, "gone")] }),
    {},
    {},
  );
  assert.ok(t.action.kind === "lootContainer" && t.action.containerID === 80002);
});

test("loot-wrecks: a wreck is marked emptied only once the attempt was NOT refused", () => {
  // It used to be marked the instant the action went out, which believed a
  // refused transfer exactly as readily as a real one — the behaviour
  // loot-containers' own comment calls out and this block never fixed.
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const s = { id: "lw", kind: "macro", macro: "loot-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", ownerID: 90000001, position: { x: 10, y: 0, z: 0 } });
  const world = { snapshot: snapshot([wreck]), myCharacterID: 90000001 };

  const issued = loot(s, obs(world), {}, {});
  assert.ok(issued.action.kind === "lootWreck" && issued.action.wreckID === 70001);
  assert.equal(issued.nextMem["attempted"], 70001, "remembered as ATTEMPTED, not as emptied");
  assert.deepEqual(issued.nextMem["looted"], [], "nothing is claimed emptied yet");

  // Next tick with NO refusal recorded: the attempt stood, so the wreck is
  // ticked off — and with nothing else of ours on the grid, the block finishes.
  const confirmed = loot(s, obs(world), issued.nextMem, {});
  assert.equal(confirmed.outcome.kind, "done");

  // The other branch: the attempt WAS refused, so the wreck is NOT ticked off
  // and the block tries it again instead of declaring the grid clear.
  const refused = loot(
    s,
    obs({ ...world, refusals: [refusal("lw", "lootWreck", 70001, 1)] }),
    issued.nextMem,
    {},
  );
  assert.notEqual(refused.outcome.kind, "done", "a refused wreck is not ticked off");
  assert.ok(refused.action.kind === "lootWreck", "it tries again");
});

test("hardeners-on: switches idle hardeners on one per tick; all running -> done; none fitted -> skipped", () => {
  const hardeners = SCRIPT_MACROS["hardeners-on"]!;
  const s = { id: "hd", kind: "macro", macro: "hardeners-on", args: {} } as const;

  const on = hardeners(s, obs({ snapshot: snapshot([], { activeModuleIDs: [] }), hardenerModuleIDs: [900, 901] }), {}, {});
  assert.ok(on.action.kind === "activate" && on.action.moduleID === 900 && on.action.targetID === 0);

  const done = hardeners(s, obs({ snapshot: snapshot([], { activeModuleIDs: [900, 901] }), hardenerModuleIDs: [900, 901] }), {}, {});
  assert.equal(done.outcome.kind, "done");

  // ⚠ A BARE RACK IS SKIPPED, IT DOES NOT STOP THE BOT. Nothing a stop could
  // achieve is available here: a hull either carries a hardener or it does not,
  // and hardening is done on the way to the work rather than being the work.
  // The orchestrator says so once and carries on to the block underneath.
  const none = hardeners(s, obs({ snapshot: snapshot([]), hardenerModuleIDs: [] }), {}, {});
  assert.equal(none.outcome.kind, "skipped");
  assert.ok(
    none.outcome.kind === "skipped" && none.outcome.reason.length > 0,
    "the one notice a skipped step gets has to say why",
  );
});

// ─── Fighting the way out of a tackle ────────────────────────────────────────
//
// The one that cost four ships: shields dropped, the watch latched and told the
// ship to run, the rat had it scrambled so the warp was refused, the autopilot
// paused with that refusal — and the bot sat still in the belt with its guns off
// until it died. A ship that cannot leave has to fight.

const HOME = 60000004;
/** The travel reading the autopilot leaves behind when a warp is refused. */
const scrambled = {
  status: "paused" as const,
  destinationStationID: HOME,
  remainingJumps: 2,
  failureReason: "Warp refused: you are being warp scrambled.",
};

test("tackled: a refused trip home is fought, not sat through", () => {
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });

  // The tank goes up first — one hardener per tick, same as everywhere else.
  const harden = scriptTravelHome(
    obs({ snapshot: snapshot([rat]), travel: scrambled, homeStationID: HOME, hardenerModuleIDs: [40], weaponModuleIDs: [500] }),
    {},
  );
  assert.equal(harden.outcome.kind, "acting", "it must NOT report blocked and stop");
  assert.ok(harden.action.kind === "activate" && harden.action.moduleID === 40, "hardener on");
  assert.equal(harden.phase, "Fighting free");

  // Hardened: now shoot whatever is holding the ship.
  const fight = scriptTravelHome(
    obs({
      snapshot: snapshot([rat], { activeModuleIDs: [40] }),
      travel: scrambled,
      homeStationID: HOME,
      hardenerModuleIDs: [40],
      weaponModuleIDs: [500],
    }),
    harden.nextMem,
  );
  assert.ok(fight.action.kind === "lock" && fight.action.targetID === 6661, "locks the tackler");
  assert.equal(fight.outcome.kind, "acting");
});

test("tackled: once the grid is clear the trip home is asked for again", () => {
  // The autopilot's failure is sticky, so a cleared grid alone would leave the
  // trip blocked forever. The escape re-issues the route, which resets it.
  const clear = scriptTravelHome(
    obs({ snapshot: snapshot([]), travel: scrambled, homeStationID: HOME, hardenerModuleIDs: [40] }),
    { escaping: true, recalled: true },
  );
  assert.ok(clear.action.kind === "startRoute" && clear.action.stationID === HOME);
  assert.equal(clear.nextMem["escaping"], false);
  assert.equal(clear.nextMem["escapeTries"], 1);
  assert.equal(clear.nextMem["recalled"], false, "the drones are called in again before the next warp");
});

// ─── The last door: a trip home that cannot fly ──────────────────────────────
//
// `stopSafely` is explicit that docked is the only place a bot may come to rest,
// and it flies the ship home to get there. When THAT flight is blocked and there
// is nothing to shoot, the old code paused anyway — in space, guns off — which
// is the exact state the doctrine exists to prevent. Home being unreachable
// says nothing about the station on this grid.

/** The autopilot's leftovers when the route home failed for a non-combat reason. */
const routeDead = {
  status: "paused" as const,
  destinationStationID: HOME,
  remainingJumps: 2,
  failureReason: "The warp was turned down 5 times running and the ship has not moved.",
};

test("stranded: a trip home that cannot fly docks at the station on THIS grid", () => {
  const station = entity({ itemID: 7001, kind: "station", position: { x: 1_000, y: 0, z: 0 } });

  const out = scriptTravelHome(
    obs({ snapshot: snapshot([station]), travel: routeDead, homeStationID: HOME }),
    {},
  );

  assert.notEqual(out.outcome.kind, "blocked", "stopping in space is the bug, not the answer");
  assert.ok(
    out.action.kind === "dock" && out.action.stationID === 7001,
    `it must take the door on this grid (got ${out.action.kind})`,
  );
});

test("stranded: with no door in sight it stops, and the reason names BOTH failures", () => {
  const out = scriptTravelHome(
    obs({ snapshot: snapshot([]), travel: routeDead, homeStationID: HOME }),
    {},
  );

  assert.equal(out.outcome.kind, "blocked", "nowhere to go really is a stop");
  const reason = out.outcome.kind === "blocked" ? out.outcome.reason : "";
  // Both halves, because "the trip home failed" alone sends a reader looking at
  // the route when the ship could not have docked ten metres away either.
  assert.match(reason, /turned down 5 times running/i, "the trip's own failure survives");
  assert.match(reason, /could not dock here either/i, "and the fallback says it tried");
});

test("tackled: the way out is fought against the ship HOLDING it, not the nearest one", () => {
  // ⚠ THE LOSS THIS PARCEL EXISTS FOR, END TO END. The watch fired, the drones
  // came home, the warp was refused — and the escape shot the nearest rat while
  // the one with the point sat at 30 km untouched. `fightTheWayOut` needed
  // nothing of its own to fix: it borrows `fight-the-rats` whole, so repairing
  // the pick repaired the escape. This asserts that the borrowing is real.
  const near = entity({ itemID: 6661, typeID: 30100, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5_000, y: 0, z: 0 } });
  const holding = entity({ itemID: 6662, typeID: 30100, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 30_000, y: 0, z: 0 } });
  const held = scriptTravelHome(
    obs({
      snapshot: snapshot([near, holding]),
      travel: scrambled,
      homeStationID: HOME,
      weaponModuleIDs: [500],
      // The server's own OnJamStart fold: THAT frigate is the one on us.
      jammingSourceIDs: [6662],
    }),
    {},
  );
  assert.equal(held.phase, "Fighting free");
  assert.ok(held.action.kind === "lock" && held.action.targetID === 6662, "the one whose death frees the ship");

  // And with nothing on the wire it is the old behaviour, unchanged.
  const blind = scriptTravelHome(
    obs({ snapshot: snapshot([near, holding]), travel: scrambled, homeStationID: HOME, weaponModuleIDs: [500] }),
    {},
  );
  assert.ok(blind.action.kind === "lock" && blind.action.targetID === 6661);
});

test("tackled: the escape is bounded — a trip that keeps failing eventually stops", () => {
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const spent = scriptTravelHome(
    obs({ snapshot: snapshot([rat]), travel: scrambled, homeStationID: HOME, weaponModuleIDs: [500] }),
    { escapeTries: 3 },
  );
  assert.equal(spent.outcome.kind, "blocked", "three cleared grids is enough");
  assert.match(spent.outcome.kind === "blocked" ? spent.outcome.reason : "", /could not be finished/i);
});

test("tackled: a blocked trip with nothing to shoot still stops honestly", () => {
  const nothing = scriptTravelHome(
    obs({ snapshot: snapshot([]), travel: scrambled, homeStationID: HOME }),
    {},
  );
  assert.equal(nothing.outcome.kind, "blocked", "no fight was started, so there is nothing to retry");
});

test("tackled: a hull with no way to fight stops rather than pretending", () => {
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const unarmed = scriptTravelHome(
    obs({ snapshot: snapshot([rat]), travel: scrambled, homeStationID: HOME, weaponModuleIDs: [], combatDroneBayItemIDs: [] }),
    {},
  );
  assert.equal(unarmed.outcome.kind, "blocked");
});

test("a trip home that is NOT blocked is untouched by the escape", () => {
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  // Rats on grid, but the autopilot is flying fine: keep flying, do not brawl.
  const flying = scriptTravelHome(
    obs({
      snapshot: snapshot([rat]),
      travel: { status: "running", destinationStationID: HOME, remainingJumps: 2, failureReason: null },
      homeStationID: HOME,
      hardenerModuleIDs: [40],
      weaponModuleIDs: [500],
    }),
    {},
  );
  assert.equal(flying.action.kind, "wait");
  assert.match(flying.why, /autopilot has the ship/i);
});

test("fight: locks the NEAREST rat, drones on it, then every idle gun on it", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const near = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const far = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 90000, y: 0, z: 0 } });
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });

  // First tick: lock the NEAR one (concentrated fire), remember it.
  const lock = fight(s, obs({ snapshot: snapshot([far, near, drone]), dronesOut: true, combatDroneIDs: [111], weaponModuleIDs: [500] }), {}, {});
  assert.ok(lock.action.kind === "lock" && lock.action.targetID === 6661);

  // Locked: drones onto it first…
  const engage = fight(
    s,
    obs({ snapshot: snapshot([near, drone]), dronesOut: true, combatDroneIDs: [111], lockedTargetIDs: [6661], weaponModuleIDs: [500] }),
    { targetID: 6661, lockIssued: true, waited: 0, dronesOn: null },
    {},
  );
  assert.ok(engage.action.kind === "engageDrones" && engage.action.targetID === 6661);

  // …then the idle gun.
  const guns = fight(
    s,
    obs({ snapshot: snapshot([near, drone]), dronesOut: true, lockedTargetIDs: [6661], weaponModuleIDs: [500] }),
    { targetID: 6661, lockIssued: true, waited: 0, dronesOn: 6661 },
    {},
  );
  assert.ok(guns.action.kind === "activate" && guns.action.moduleID === 500 && guns.action.targetID === 6661);
});

test("fight: target died -> next rat; grid clear -> recall drones, then done", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const remaining = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 90000, y: 0, z: 0 } });
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });

  // 6661 died: pick + lock 6662.
  const next = fight(s, obs({ snapshot: snapshot([remaining, drone]), dronesOut: true, weaponModuleIDs: [500] }), { targetID: 6661, lockIssued: true, waited: 0, dronesOn: 6661 }, {});
  assert.ok(next.action.kind === "lock" && next.action.targetID === 6662);

  // All dead, drones out -> recall; drones home -> done.
  const recall = fightUntilClear(fight, s, obs({ snapshot: snapshot([drone]), dronesOut: true }));
  assert.ok(recall.action.kind === "recallDrones");
  const done = fightUntilClear(fight, s, obs({ snapshot: snapshot([]) }));
  assert.equal(done.outcome.kind, "done");
});

test("fight: a rat beyond the hull's targeting range is not a target at all", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const near = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const far = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 90000, y: 0, z: 0 } });

  // 30 km of lock range: the near rat is fair game, the far one is invisible to
  // the ladder — so it does not burn ticks locking something it cannot reach.
  const inRange = fight(
    s,
    obs({ snapshot: snapshot([far, near]), dronesOut: true, weaponModuleIDs: [500], maxTargetRangeM: 30_000 }),
    {},
    {},
  );
  assert.ok(inRange.action.kind === "lock" && inRange.action.targetID === 6661);

  // Only the far one left: nothing is reachable, so the block FINISHES rather
  // than locking-and-giving-up forever. As a watch response, that hands the ship
  // back to the step under it.
  const unreachable = fightUntilClear(
    fight,
    s,
    obs({ snapshot: snapshot([far]), weaponModuleIDs: [500], maxTargetRangeM: 30_000 }),
  );
  assert.equal(unreachable.outcome.kind, "done");
});

test("fight: the BLOCK still spends its confirm reads when only an out-of-reach rat is visible", () => {
  // The fight-back watch stands aside for this grid (scriptDecide), but the block
  // keeps the 2026-09-14 rule untouched: "done" here can mean warping on to the
  // next site, so it is still read three times before it is believed.
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const far = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 90000, y: 0, z: 0 } });
  const o = obs({ snapshot: snapshot([far]), weaponModuleIDs: [500], maxTargetRangeM: 30_000 });
  const first = fight(s, o, {}, {});
  assert.equal(first.outcome.kind, "acting");
  assert.equal(first.action.kind, "wait");
  assert.match(first.why, /reading it again/);
  const second = fight(s, o, first.nextMem, {});
  assert.equal(second.outcome.kind, "acting");
  assert.equal(fight(s, o, second.nextMem, {}).outcome.kind, "done");
});

test("fight-back watch + the real ladder: a rat beyond targeting range no longer starves the step", () => {
  // The 2026-09-30 cycle end to end: before the reach gate the watch borrowed
  // the ladder, it confirmed an "empty" grid for three ticks, released for one,
  // and was borrowed again — the step under it got one tick in four.
  const work = (): MacroTick => ({
    action: { kind: "activate", moduleID: 1, targetID: 2 }, why: "working", phase: "Working", armed: true,
    outcome: { kind: "acting" }, nextMem: {},
  });
  const script: BotScript = {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 1, name: "Home", systemName: null },
    interrupts: [{ id: "fb", when: { kind: "hostile-on-grid" }, respond: "fight-back" }],
    program: [{ id: "m", kind: "macro", macro: "mine-at-belt", args: {}, until: { kind: "ore-hold-at-least", fraction: 0.9 } }],
  };
  const registry = { ...SCRIPT_MACROS, "mine-at-belt": work };
  const far = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 90000, y: 0, z: 0 } });
  const o = obs({ hostileOnGrid: true, snapshot: snapshot([far]), weaponModuleIDs: [500], maxTargetRangeM: 30_000 });
  let mem = initialMemory(script);
  for (let t = 0; t < 8; t += 1) {
    const r = decideScriptAction(script, o, mem, registry, scriptTravelHome);
    assert.equal(r.stepPath, "m", `tick ${t}: the step has the ship`);
    assert.equal(r.interruptID, null);
    mem = r.memory;
  }
});

// Variant B, caught live 2026-09-30 on nine belt miners: combat drones OUT on a
// rat parked beyond targeting range, the program on mine-at-belt. The mining
// flight counted the whole grid and kept the drones on the rat; the ladder
// counted only what was in reach, ordered them home, and the flight wrapper
// swallowed that recall every tick — so the watch never released and the step
// starved until the rat died. The flight and the ladder now share one reach.
const COMBAT_DRONE_TYPE = 2488;
const MINING_DRONE_TYPE = 10246;

function driftingMiner(combatOut: boolean): ScriptObservation {
  const far = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 90000, y: 0, z: 0 } });
  const drones = combatOut
    ? [501, 502].map((itemID) => entity({ itemID, kind: "drone", typeID: COMBAT_DRONE_TYPE, controllerID: 9001, position: { x: 80000, y: 0, z: 0 } }))
    : [];
  return obs({
    hostileOnGrid: true,
    snapshot: snapshot([far, ...drones]),
    maxTargetRangeM: 30_000,
    weaponModuleIDs: [],
    dronesOut: combatOut,
    combatDroneIDs: combatOut ? [501, 502] : [],
    combatDroneBayItemIDs: combatOut ? [] : [601],
    miningDrones: {
      bay: [{ itemID: 701, typeID: MINING_DRONE_TYPE, quantity: 2 }, ...(combatOut ? [] : [{ itemID: 601, typeID: COMBAT_DRONE_TYPE, quantity: 2 }])],
      out: combatOut
        ? [501, 502].map((itemID) => ({
          itemID, typeID: COMBAT_DRONE_TYPE, name: null, activity: "fighting", targetID: 6662,
          shieldRatio: 1, armorRatio: 1, hullRatio: 1, controlled: true,
        }) as unknown as NonNullable<NonNullable<ScriptObservation["miningDrones"]>["out"]>[number])
        : [],
      maxActive: 2,
      roles: { [COMBAT_DRONE_TYPE]: "combat", [MINING_DRONE_TYPE]: "mining" },
    },
  });
}

function minerScript(): BotScript {
  return {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 1, name: "Home", systemName: null },
    interrupts: [{ id: "fb", when: { kind: "hostile-on-grid" }, respond: "fight-back" }],
    program: [{ id: "m", kind: "macro", macro: "mine-at-belt", args: {}, until: { kind: "ore-hold-at-least", fraction: 0.9 } }],
  };
}

// The mine block itself would need a belt fixture this test is not about, so it
// stands in; the fight ladder, the watch and the drone-flight wrapper are real.
const MINER_REGISTRY = {
  ...SCRIPT_MACROS,
  "mine-at-belt": (): MacroTick => ({
    action: { kind: "activate", moduleID: 1, targetID: 2 }, why: "working", phase: "Working", armed: true,
    outcome: { kind: "acting" }, nextMem: {},
  }),
};

test("fight-back + mining flight: combat drones on a rat beyond targeting range come home", () => {
  const s = minerScript();
  const r = decideScriptAction(s, driftingMiner(true), initialMemory(s), MINER_REGISTRY, scriptTravelHome);
  assert.equal(r.interruptID, null, "the watch does not hold the ship for a rat it cannot reach");
  assert.equal(r.action.kind, "recallDrones", "the flight stands its combat drones down");
  assert.deepEqual(r.action.kind === "recallDrones" ? [...r.action.droneIDs].sort() : [], [501, 502]);
});

test("fight-back + mining flight: a watch mid-fight releases once the flight brings the drones home", () => {
  // The live shape: the watch was fighting (ladder memory present) when the
  // last rat in reach died, one stayed out of reach, drones still out.
  const s = minerScript();
  let mem: ScriptMemory = { ...initialMemory(s), macroMem: { fb: { targetID: 6660 } } };
  const recalls: number[][] = [];
  for (let t = 0; t < 6; t += 1) {
    const r = decideScriptAction(s, driftingMiner(true), mem, MINER_REGISTRY, scriptTravelHome);
    if (r.action.kind === "recallDrones") recalls.push([...r.action.droneIDs]);
    mem = r.memory;
  }
  assert.ok(recalls.length > 0, "a recall reaches the world instead of being swallowed every tick");

  // Drones aboard: the ladder sees its flight home and the watch lets go.
  let released = false;
  for (let t = 0; t < 4 && !released; t += 1) {
    const r = decideScriptAction(s, driftingMiner(false), mem, MINER_REGISTRY, scriptTravelHome);
    released = r.interruptID === null && !("fb" in r.memory.macroMem);
    mem = r.memory;
  }
  assert.ok(released, "the fight-back watch released the ship");
});

// Off a mining step, the drone-flight wrapper read "not mining" as "leaving" and
// recalled every controlled drone — including the combat flight a fight-back
// watch (or a Fight-the-rats step) had just launched. Caught live 2026-09-30 on
// a loot step: launch, recall ~4 s later, seven cycles in a row. Leaving now
// means MOVING; sitting on grid off a mining step, combat drones belong to
// whoever launched them.

function droneGrid(over: { ratM?: number | null; combat?: readonly number[]; mining?: readonly number[] } = {}): ScriptObservation {
  const combat = over.combat ?? [];
  const miningOut = over.mining ?? [];
  const rat = over.ratM === null
    ? []
    : [entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: over.ratM ?? 10_000, y: 0, z: 0 } })];
  const ids = [...combat, ...miningOut];
  const drones = ids.map((itemID) =>
    entity({ itemID, kind: "drone", typeID: combat.includes(itemID) ? COMBAT_DRONE_TYPE : MINING_DRONE_TYPE, controllerID: 9001, position: { x: 2000, y: 0, z: 0 } }));
  return obs({
    hostileOnGrid: rat.length > 0,
    snapshot: snapshot([...rat, ...drones]),
    maxTargetRangeM: 30_000,
    weaponModuleIDs: [],
    lockedTargetIDs: rat.length > 0 ? [6662] : [],
    dronesOut: ids.length > 0,
    combatDroneIDs: [...combat],
    combatDroneBayItemIDs: [],
    miningDrones: {
      bay: [],
      out: ids.map((itemID) => ({
        itemID, typeID: combat.includes(itemID) ? COMBAT_DRONE_TYPE : MINING_DRONE_TYPE, name: null,
        activity: combat.includes(itemID) ? "fighting" : "mining", targetID: combat.includes(itemID) ? 6662 : 40001,
        shieldRatio: 1, armorRatio: 1, hullRatio: 1, controlled: true,
      }) as unknown as NonNullable<NonNullable<ScriptObservation["miningDrones"]>["out"]>[number]),
      maxActive: 5,
      roles: { [COMBAT_DRONE_TYPE]: "combat", [MINING_DRONE_TYPE]: "mining" },
    },
  });
}

function lootScript(interrupts: BotScript["interrupts"]): BotScript {
  return {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 1, name: "Home", systemName: null },
    interrupts,
    program: [{ id: "n2", kind: "macro", macro: "loot-containers", args: {} }],
  };
}

/** The loot block stands in: it either sits (opening a can) or moves (approaching one). */
function lootRegistry(moving: boolean) {
  return {
    ...SCRIPT_MACROS,
    "loot-containers": (): MacroTick => ({
      action: moving ? { kind: "approach", targetID: 80001 } : { kind: "wait" },
      why: "looting", phase: "Looting", armed: true, outcome: { kind: "acting" }, nextMem: {},
    }),
  };
}

const FIGHT_BACK_ROW: BotScript["interrupts"][number] = { id: "fb", when: { kind: "hostile-on-grid" }, respond: "fight-back" };

test("drone flight: a fight-back watch on a loot step keeps the combat drones it launched", () => {
  const s = lootScript([FIGHT_BACK_ROW]);
  // The earlier mining step left flight memory behind — the live shape.
  const mem: ScriptMemory = { ...initialMemory(s), miningFlight: { combat: false, clearTicks: 0, returning: [], recallTicks: 0, orderKey: "", orderAttempts: 0, orderCooldown: 0, blockedLaunchKey: null } };
  let m = mem;
  for (let t = 0; t < 4; t += 1) {
    const r = decideScriptAction(s, droneGrid({ combat: [501, 502, 503] }), m, lootRegistry(false), scriptTravelHome);
    assert.equal(r.interruptID, "fb", `tick ${t}: the watch has the ship`);
    assert.notEqual(r.action.kind, "recallDrones", `tick ${t}: the fight keeps its drones`);
    m = r.memory;
  }
});

test("drone flight: a Fight-the-rats STEP keeps its drones out on grid too", () => {
  const s: BotScript = { ...lootScript([]), program: [{ id: "f", kind: "macro", macro: "fight-the-rats", args: {} }] };
  const r = decideScriptAction(s, droneGrid({ combat: [501, 502] }), initialMemory(s), SCRIPT_MACROS, scriptTravelHome);
  assert.notEqual(r.action.kind, "recallDrones");
  assert.equal(r.stepPath, "f");
});

test("drone flight: combat drones still come home before the ship MOVES off a mining step", () => {
  const s = lootScript([]);
  const r = decideScriptAction(s, droneGrid({ ratM: null, combat: [501, 502] }), initialMemory(s), lootRegistry(true), scriptTravelHome);
  assert.equal(r.action.kind, "recallDrones", "the flight still protects movement");
  assert.deepEqual(r.action.kind === "recallDrones" ? [...r.action.droneIDs].sort() : [], [501, 502]);
});

test("drone flight: mining drones left out by a finished mining step still come home", () => {
  const s = lootScript([]);
  const mem: ScriptMemory = { ...initialMemory(s), miningFlight: { combat: false, clearTicks: 0, returning: [], recallTicks: 0, orderKey: "", orderAttempts: 0, orderCooldown: 0, blockedLaunchKey: null } };
  const r = decideScriptAction(s, droneGrid({ ratM: null, mining: [801, 802] }), mem, lootRegistry(false), scriptTravelHome);
  assert.equal(r.action.kind, "recallDrones");
  assert.deepEqual(r.action.kind === "recallDrones" ? [...r.action.droneIDs].sort() : [], [801, 802]);
});

test("fight: an unreadable targeting range does NOT gate — the bounded lock stays the backstop", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const far = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 900000, y: 0, z: 0 } });
  const t = fight(s, obs({ snapshot: snapshot([far]), dronesOut: true, weaponModuleIDs: [500] }), {}, {});
  assert.ok(t.action.kind === "lock" && t.action.targetID === 6662);
});

test("fight: no guns and no drones -> blocked with a plain reason", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const t = fight(s, obs({ snapshot: snapshot([rat]), weaponModuleIDs: [], droneBayItemIDs: [] }), {}, {});
  assert.equal(t.outcome.kind, "blocked");
  // A bay of salvage drones is no way to fight either.
  const salvageOnly = fight(s, obs({ snapshot: snapshot([rat]), weaponModuleIDs: [], droneBayItemIDs: [113], combatDroneBayItemIDs: [], salvageDroneBayItemIDs: [113] }), {}, {});
  assert.equal(salvageOnly.outcome.kind, "blocked");
});

test("fight: a mixed bay -> only the COMBAT drones are launched; a mixed flight -> only they are set on the rat", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const launch = fight(s, obs({ snapshot: snapshot([rat]), dronesOut: false, droneBayItemIDs: [111, 113], combatDroneBayItemIDs: [111], salvageDroneBayItemIDs: [113] }), {}, {});
  assert.ok(launch.action.kind === "launchDrones");
  assert.deepEqual(launch.action.droneItemIDs, [111]);

  const hob = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const salvager = entity({ itemID: 113, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const engage = fight(
    s,
    obs({ snapshot: snapshot([rat, hob, salvager]), dronesOut: true, combatDroneIDs: [111], salvageDroneIDs: [113], lockedTargetIDs: [6661], weaponModuleIDs: [500] }),
    { targetID: 6661, lockIssued: true, waited: 0, dronesOn: null },
    {},
  );
  assert.ok(engage.action.kind === "engageDrones");
  assert.deepEqual(engage.action.droneIDs, [111]);
});

test("fight: salvage drones out, combat drones in the bay -> recall the salvage drones, and keep shooting meanwhile", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const salvager = entity({ itemID: 113, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([rat, salvager]), dronesOut: true, combatDroneBayItemIDs: [111], salvageDroneBayItemIDs: [], combatDroneIDs: [], salvageDroneIDs: [113], lockedTargetIDs: [6661], weaponModuleIDs: [500] });
  const recall = fight(s, world, {}, {});
  assert.ok(recall.action.kind === "recallDrones" && recall.action.droneIDs.includes(113));
  // Next tick the salvage drone is still coming home: the ladder does NOT wait on it — the guns go on.
  const guns = fight(s, world, { ...recall.nextMem, targetID: 6661, lockIssued: true, waited: 0, dronesOn: null }, {});
  assert.ok(guns.action.kind === "activate" && guns.action.moduleID === 500, `expected the gun, got ${guns.action.kind}`);
});

// ─── fight: rotating a hurt drone ────────────────────────────────────────────
//
// The rats in a null-sec belt shoot drones. A drone whose shield has started to
// go is pulled into the bay and sent straight back out, one at a time — the
// drone boat's rotation, now on the ladder the fight-back watch borrows.

const ROT_RAT = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
const ROT_A = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
const ROT_B = entity({ itemID: 112, kind: "drone", controllerID: 9001, position: { x: 300, y: 0, z: 0 } });
const ROT_ENGAGED: MacroMemory = { targetID: 6661, lockIssued: true, waited: 0, dronesOn: 6661 };

function rotationWorld(out: readonly SpaceEntity[], shields: Readonly<Record<number, number>>, bay: readonly number[]): ScriptObservation {
  return obs({
    snapshot: snapshot([ROT_RAT, ...out]),
    dronesOut: out.length > 0,
    combatDroneIDs: out.map((d) => d.itemID),
    combatDroneBayItemIDs: [...bay],
    myDrones: out.map((d) => ({ itemID: d.itemID, shieldRatio: shields[d.itemID] ?? 1, armorRatio: 1, hullRatio: 1 })),
    lockedTargetIDs: [6661],
    weaponModuleIDs: [500],
  });
}

test("fight: a drone that starts losing shield is recalled, relaunched, and set back on the rat", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;

  const recall = fight(s, rotationWorld([ROT_A, ROT_B], { 112: 0.9 }, []), ROT_ENGAGED, {});
  assert.ok(recall.action.kind === "recallDrones", `expected a recall, got ${recall.action.kind}`);
  assert.deepEqual(recall.action.droneIDs, [112], "only the hurt drone comes home");

  const relaunch = fight(s, rotationWorld([ROT_A], {}, [112]), recall.nextMem, {});
  assert.ok(relaunch.action.kind === "launchDrones", `expected a relaunch, got ${relaunch.action.kind}`);
  assert.deepEqual(relaunch.action.droneItemIDs, [112]);

  // Back out: the rotation is over, the guns keep going this tick…
  const back = fight(s, rotationWorld([ROT_A, ROT_B], {}, []), relaunch.nextMem, {});
  assert.equal(back.action.kind, "activate");
  // …and the next tick puts the whole flight back on the rat.
  const reengage = fight(s, rotationWorld([ROT_A, ROT_B], {}, []), back.nextMem, {});
  assert.ok(reengage.action.kind === "engageDrones" && reengage.action.targetID === 6661);
  assert.deepEqual([...reengage.action.droneIDs].sort(), [111, 112]);
});

test("fight: a flight of ONE is never pulled — the rat would be left unattended", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const t = fight(s, rotationWorld([ROT_A], { 111: 0.4 }, []), ROT_ENGAGED, {});
  assert.equal(t.action.kind, "activate", "the guns, not a recall");
});

test("fight: a full-shielded flight is left alone", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const t = fight(s, rotationWorld([ROT_A, ROT_B], {}, []), ROT_ENGAGED, {});
  assert.equal(t.action.kind, "activate");
});

test("the fight-back WATCH rotates a hurt drone while the program is mining", () => {
  const s: BotScript = {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 60000004, name: "Home", systemName: null },
    interrupts: [{ id: "fb", when: { kind: "hostile-on-grid" }, respond: "fight-back", targets: ["tackle", "ewar"] }],
    program: [mineStep],
  };
  const world = (shields: Readonly<Record<number, number>>, locked: readonly number[]) => ({
    ...rotationWorld([ROT_A, ROT_B], shields, []),
    hostileOnGrid: true,
    lockedTargetIDs: [...locked],
  });
  let mem = initialMemory(s);
  const lock = decideScriptAction(s, world({}, []), mem, SCRIPT_MACROS, scriptTravelHome);
  assert.equal(lock.action.kind, "lock");
  assert.equal(lock.interruptID, "fb");
  mem = lock.memory;
  const engage = decideScriptAction(s, world({}, [6661]), mem, SCRIPT_MACROS, scriptTravelHome);
  assert.equal(engage.action.kind, "engageDrones");
  mem = engage.memory;
  const recall = decideScriptAction(s, world({ 111: 0.95 }, [6661]), mem, SCRIPT_MACROS, scriptTravelHome);
  assert.ok(recall.action.kind === "recallDrones", `expected a recall, got ${recall.action.kind}`);
  assert.deepEqual(recall.action.droneIDs, [111]);
  assert.equal(recall.interruptID, "fb", "the watch did it, not a block");
});

// ⚠ THE CASE THAT MATTERS. While the program is on a mining step, the mining
// drone flight owns every drone order and turns the watch's own drone orders
// into waits. So the recall has to come out of THAT flight, or a miner never
// gets it: this drives the real orchestrator to prove the order reaches the world.
test("mining under a fight-back watch: the drone flight pulls the drone being shot", () => {
  const s: BotScript = {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 60000004, name: "Home", systemName: null },
    interrupts: [{ id: "fb", when: { kind: "hostile-on-grid" }, respond: "fight-back", targets: ["tackle", "ewar"] }],
    program: [mineStep],
  };
  const rat = entity({ itemID: 500, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const drone = (itemID: number, shieldRatio: number) => ({
    itemID, typeID: 2454, name: null, activity: "fighting", targetID: 500, controlled: true,
    shieldRatio, armorRatio: 1, hullRatio: 1,
  });
  const onGrid = [22, 23].map((itemID) =>
    entity({ itemID, kind: "drone", controllerID: 9001, position: { x: 300, y: 0, z: 0 } }));
  const world = (shield23: number) => obs({
    snapshot: snapshot([rat, ...onGrid]),
    hostileOnGrid: true,
    dronesOut: true,
    combatDroneIDs: [22, 23],
    lockedTargetIDs: [500],
    miningDrones: { bay: [], out: [drone(22, 1), drone(23, shield23)], maxActive: 5, roles: { 2454: "combat" } },
  });
  const first = decideScriptAction(s, world(1), initialMemory(s), SCRIPT_MACROS, scriptTravelHome);
  assert.notEqual(first.action.kind, "recallDrones", "nothing is hurt yet");
  const hit = decideScriptAction(s, world(0.8), first.memory, SCRIPT_MACROS, scriptTravelHome);
  assert.ok(hit.action.kind === "recallDrones", `expected the recall to reach the world, got ${hit.action.kind}`);
  assert.deepEqual(hit.action.droneIDs, [23]);
});

test("defend: pirate dead and drones home -> done", () => {
  const t = defend({ id: "d", kind: "macro", macro: "defend-with-drones", args: {} }, obs({ snapshot: snapshot([]), dronesOut: true }), NM, {});
  assert.equal(t.outcome.kind, "done");
});

// ── Named board slots ────────────────────────────────────────────────────────

test("a station arg can point at a BOARD SLOT an earlier block filled in", () => {
  const travel = SCRIPT_MACROS["travel-to-station"]!;
  const slotStep: MacroStep = {
    id: "t",
    kind: "macro",
    macro: "travel-to-station",
    args: { station: { kind: "station", ref: { entity: "station", id: null, name: null, systemName: null, slot: "agent-station" } } },
  };
  // The board says the agent's station is 60009999 — and we are docked there, so
  // the block resolves the slot and reports arrival rather than "no station".
  const docked = obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60009999 }) });
  const done = travel(slotStep, docked, {}, { agentStationID: 60009999 });
  assert.equal(done.outcome.kind, "done", "resolved the slot to the board's station");

  // With the slot UNFILLED the block blocks with a plain reason — never a guess.
  const empty = travel(slotStep, docked, {}, {});
  assert.equal(empty.outcome.kind, "blocked");
});

// ── The market set ───────────────────────────────────────────────────────────

function invRow(over: Partial<import("../store/types.ts").InventoryItemRow> & { itemID: number }): import("../store/types.ts").InventoryItemRow {
  return { typeID: 34, groupID: null, categoryID: null, flagID: null, quantity: 100, singleton: false, ...over };
}

const buy = SCRIPT_MACROS["buy-item"]!;
const sell = SCRIPT_MACROS["sell-item"]!;
const buyStep: MacroStep = {
  id: "b", kind: "macro", macro: "buy-item",
  args: { item: { kind: "itemType", typeID: 34, name: "Tritanium" }, quantity: { kind: "qty", value: 5000 }, price: { kind: "isk", value: 6 } },
};
const sellStep: MacroStep = {
  id: "s", kind: "macro", macro: "sell-item",
  args: { item: { kind: "itemType", typeID: 34, name: "Tritanium" }, price: { kind: "isk", value: 5 } },
};

test("buy-item: docked -> places one buy order, then done; not docked -> blocked", () => {
  const first = buy(buyStep, obs({ flightStatus: flight({ docked: true, inSpace: false }) }), {}, {});
  assert.ok(first.action.kind === "placeBuyOrder" && first.action.typeID === 34 && first.action.quantity === 5000 && first.action.price === 6);
  // The mem it returns marks it placed -> the next tick is done (no double buy).
  const second = buy(buyStep, obs({ flightStatus: flight({ docked: true, inSpace: false }) }), first.nextMem, {});
  assert.equal(second.outcome.kind, "done");
  assert.equal(buy(buyStep, obs({ flightStatus: flight({ docked: false }) }), {}, {}).outcome.kind, "blocked");
});

test("buy-item: an unfilled item/price/quantity -> blocked, never a bad order", () => {
  const bad: MacroStep = { id: "b", kind: "macro", macro: "buy-item", args: { item: { kind: "itemType", typeID: null, name: null }, quantity: { kind: "qty", value: 1 }, price: { kind: "isk", value: 1 } } };
  assert.equal(buy(bad, obs({ flightStatus: flight({ docked: true, inSpace: false }) }), {}, {}).outcome.kind, "blocked");
});

test("sell-item: lists each hangar stack, done when none left; not docked -> blocked", () => {
  const docked = obs({ flightStatus: flight({ docked: true, inSpace: false }), stationHangar: [invRow({ itemID: 111, quantity: 200 }), invRow({ itemID: 222, typeID: 99, quantity: 5 })] });
  const t = sell(sellStep, docked, {}, {});
  assert.ok(t.action.kind === "placeSellOrder" && t.action.itemID === 111 && t.action.quantity === 200 && t.action.price === 5);
  // Hangar now empty of type 34 -> done (the listed stack left the hangar).
  const empty = obs({ flightStatus: flight({ docked: true, inSpace: false }), stationHangar: [invRow({ itemID: 222, typeID: 99 })] });
  assert.equal(sell(sellStep, empty, {}, {}).outcome.kind, "done");
  // A singleton (an assembled item) of the type is never listed.
  const onlySingleton = obs({ flightStatus: flight({ docked: true, inSpace: false }), stationHangar: [invRow({ itemID: 333, singleton: true })] });
  assert.equal(sell(sellStep, onlySingleton, {}, {}).outcome.kind, "done");
  assert.equal(sell(sellStep, obs({ flightStatus: flight({ docked: false }) }), {}, {}).outcome.kind, "blocked");
});

// ── The fleet-support set ────────────────────────────────────────────────────

const remoteRep = SCRIPT_MACROS["remote-rep"]!;
const orbitBoost = SCRIPT_MACROS["orbit-and-boost"]!;
const repStep: MacroStep = { id: "rr", kind: "macro", macro: "remote-rep", args: {} };
const boostStep: MacroStep = { id: "ob", kind: "macro", macro: "orbit-and-boost", args: {} };

test("remote-rep: no remote reps fitted -> blocked", () => {
  const hurt = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4 });
  assert.equal(remoteRep(repStep, obs({ snapshot: snapshot([hurt]), remoteShieldRepairerIDs: [] }), {}, {}).outcome.kind, "blocked");
});

test("remote-rep: hurt friendly -> lock then rep it; everyone full -> done", () => {
  const hurt = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1 });
  const lock = remoteRep(repStep, obs({ snapshot: snapshot([hurt]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [5001] }), {}, {});
  assert.ok(lock.action.kind === "lock" && lock.action.targetID === 7001);
  const rep = remoteRep(repStep, obs({ snapshot: snapshot([hurt]), remoteShieldRepairerIDs: [600], lockedTargetIDs: [7001], fleetMemberCharacterIDs: [5001] }), lock.nextMem, {});
  assert.ok(rep.action.kind === "activate" && rep.action.moduleID === 600 && rep.action.targetID === 7001);
  const full = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 });
  assert.equal(remoteRep(repStep, obs({ snapshot: snapshot([full]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [5001] }), {}, {}).outcome.kind, "done");
});

test("probe sweep blocks launch, analyze once, and recover against observed state", () => {
  const launchStep: MacroStep = { id: "pl", kind: "macro", macro: "launch-scan-probes", args: {} };
  const analyzeStep: MacroStep = { id: "pa", kind: "macro", macro: "analyze-signatures", args: {} };
  const recoverStep: MacroStep = { id: "pr", kind: "macro", macro: "recover-scan-probes", args: {} };
  const launch = SCRIPT_MACROS["launch-scan-probes"];
  const analyze = SCRIPT_MACROS["analyze-signatures"];
  const recover = SCRIPT_MACROS["recover-scan-probes"];
  const probe = {
    probeID: 7001,
    typeID: 30013,
    pos: [1, 2, 3] as const,
    destination: [4, 5, 6] as const,
    scanRange: 1,
    rangeStep: 1,
    state: 1,
    expiry: "1",
  };

  assert.equal(launch(launchStep, obs({ scannerOperations }), NM, {}).action.kind, "scannerLaunch");
  assert.equal(
    launch(launchStep, obs({ scannerOperations: { ...scannerOperations, probes: [probe] } }), NM, {}).outcome.kind,
    "done",
  );
  const firstAnalysis = analyze(
    analyzeStep,
    obs({ scannerOperations: { ...scannerOperations, probes: [probe] } }),
    NM,
    {},
  );
  assert.equal(firstAnalysis.action.kind, "scannerAnalyze");
  assert.equal(
    analyze(
      analyzeStep,
      obs({ scannerOperations: { ...scannerOperations, probes: [probe] } }),
      firstAnalysis.nextMem,
      {},
    ).outcome.kind,
    "done",
  );
  assert.equal(
    recover(recoverStep, obs({ scannerOperations: { ...scannerOperations, probes: [probe] } }), NM, {}).action.kind,
    "scannerRecover",
  );
  assert.equal(recover(recoverStep, obs({ scannerOperations }), NM, {}).outcome.kind, "done");
});

test("fleet support waits for an authoritative roster and never targets a non-member", () => {
  const stranger = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.2, armorRatio: 1, hullRatio: 1, position: { x: 500, y: 0, z: 0 } });
  const member = entity({ itemID: 7002, kind: "ship", characterID: 5002, shieldRatio: 1, armorRatio: 1, hullRatio: 1, position: { x: 5000, y: 0, z: 0 } });

  const unavailable = remoteRep(repStep, obs({
    snapshot: snapshot([stranger]),
    remoteShieldRepairerIDs: [600],
    fleetMemberCharacterIDs: null,
  }), {}, {});
  assert.equal(unavailable.action.kind, "wait");
  assert.match(unavailable.why, /fleet roster/i);

  const filtered = remoteRep(repStep, obs({
    snapshot: snapshot([stranger, member]),
    remoteShieldRepairerIDs: [600],
    fleetMemberCharacterIDs: [5002],
  }), {}, {});
  assert.equal(filtered.outcome.kind, "done", "a hurt non-member must not be locked or repped");

  const anchor = orbitBoost(boostStep, obs({
    snapshot: snapshot([stranger, member]),
    remoteShieldRepairerIDs: [600],
    fleetMemberCharacterIDs: [5002],
  }), {}, {});
  assert.ok(anchor.action.kind === "orbit" && anchor.action.targetID === 7002);
});

test("a ship that leaves the authoritative roster stops receiving assistance immediately", () => {
  const formerMate = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.3, armorRatio: 1, hullRatio: 1 });
  const first = remoteRep(repStep, obs({
    snapshot: snapshot([formerMate]),
    remoteShieldRepairerIDs: [600],
    fleetMemberCharacterIDs: [5001],
  }), {}, {});
  assert.equal(first.action.kind, "lock");

  const afterLeave = remoteRep(repStep, obs({
    snapshot: snapshot([formerMate]),
    remoteShieldRepairerIDs: [600],
    lockedTargetIDs: [7001],
    fleetMemberCharacterIDs: [],
  }), first.nextMem, {});
  assert.equal(afterLeave.outcome.kind, "done");
  assert.notEqual(afterLeave.action.kind, "activate");
});

// ── Remote assistance has a range, and a bound ───────────────────────────────
//
// ⚠ BOTH REMOTE BLOCKS USED TO RETURN `mem` UNCHANGED after issuing an activate.
// A module that would not come on was found idle again next tick and re-fired,
// forever: no counter, no progress, no reason surfaced. And because remote-rep
// only reports `done` when everyone on grid is full (remote-cap likewise), a mate
// parked out of reach was an infinite loop — the bot would sit there locking and
// firing into nothing for as long as it was left running.

test("remote-rep: a mate out of rep range is CLOSED ON, not repped hopefully", () => {
  const far = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1, position: { x: 40000, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([far]), remoteShieldRepairerIDs: [600], lockedTargetIDs: [7001], fleetMemberCharacterIDs: [5001] });
  const t = remoteRep(repStep, world, { repLockOn: 7001, repWaited: 0 }, {});
  assert.ok(t.action.kind === "approach" && t.action.targetID === 7001, "it must close before it fires");
  assert.match(t.why, /Closing in/);
  // Issued once, then it stops asking and lets the rest of the tick happen.
  const next = remoteRep(repStep, world, t.nextMem, {});
  assert.notEqual(next.action.kind, "approach");
  assert.equal(next.nextMem["repTries"] ?? 0, 0, "and an out-of-reach tick spends no budget");
});

test("remote-rep: reps that never come on are BOUNDED (this was an infinite loop)", () => {
  const hurt = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1 });
  const world = obs({
    // The rep never appears in activeModuleIDs — the shape of a silent refusal.
    snapshot: snapshot([hurt], { activeModuleIDs: [] }),
    remoteShieldRepairerIDs: [600], lockedTargetIDs: [7001],
    fleetMemberCharacterIDs: [5001],
  });
  let mem: MacroMemory = { repLockOn: 7001, repWaited: 0 };
  let fired = 0;
  for (let i = 0; i < 8; i++) {
    const t = remoteRep(repStep, world, mem, {});
    if (t.action.kind === "activate") fired += 1;
    mem = t.nextMem;
  }
  assert.equal(fired, 3, `the rep is offered exactly MAX_REMOTE_ASSIST_ATTEMPTS times; got ${fired}`);
});

test("remote-rep: a rep that IS cycling refills the budget — no mid-fight stall", () => {
  // The bound must only ever catch a module that is not landing. A ship with two
  // reps where one is already running has to be able to switch the other on, and
  // keep doing so, however long the fight lasts.
  const hurt = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1 });
  const world = obs({
    snapshot: snapshot([hurt], { activeModuleIDs: [600] }), // 600 landed, 601 idle
    remoteShieldRepairerIDs: [600, 601], lockedTargetIDs: [7001],
    fleetMemberCharacterIDs: [5001],
  });
  // Arrive with the budget already spent from an earlier dry spell.
  let mem: MacroMemory = { repLockOn: 7001, repWaited: 0, repTries: 3, "repTarget:600": 7001 };
  let fired = 0;
  for (let i = 0; i < 6; i++) {
    const t = remoteRep(repStep, world, mem, {});
    if (t.action.kind === "activate") fired += 1;
    mem = t.nextMem;
  }
  assert.equal(fired, 6, "a landed rep means the budget is not spent — keep working the second one");
});

test("remote-rep: a NEW mate gets a fresh budget", () => {
  const first = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1 });
  const second = entity({ itemID: 7009, kind: "ship", characterID: 5009, shieldRatio: 0.3, armorRatio: 1, hullRatio: 1 });
  // Memory from a spent attempt on 7001, which has since left the grid.
  const t = remoteRep(
    repStep,
    obs({ snapshot: snapshot([second]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [5009] }),
    { repLockOn: 7001, repWaited: 0, repTries: 3, repApproached: 7001 },
    {},
  );
  assert.ok(t.action.kind === "lock" && t.action.targetID === 7009);
  assert.equal(t.nextMem["repTries"], 0, "the last mate's spent budget must not disarm the reps for this one");
  assert.equal(t.nextMem["repApproached"], null);
  assert.ok(first.itemID === 7001);
});

test("orbit-and-boost: closes by ORBITING — it must not also issue an approach", () => {
  // Its orbit at ORBIT_BOOST_RANGE_M is how this block gets in range. An approach
  // from the shared helper would fight that orbit command every tick.
  const far = entity({ itemID: 7003, kind: "ship", characterID: 5002, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1, position: { x: 40000, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([far]), remoteShieldRepairerIDs: [600], lockedTargetIDs: [7003], fleetMemberCharacterIDs: [5002] });
  // `orbiting` already set, so the orbit is not re-issued and we reach the reps.
  const t = orbitBoost(boostStep, world, { orbiting: 7003, repLockOn: 7003, repWaited: 0 }, {});
  assert.notEqual(t.action.kind, "approach");
});

test("remote-rep: an NPC or your own hull is never a rep target", () => {
  const npc = entity({ itemID: 7002, kind: "ship", isNpc: true, shieldRatio: 0.2 });
  // No FRIENDLY is hurt (the NPC is skipped), so the block is done — never reps a rat.
  assert.equal(remoteRep(repStep, obs({ snapshot: snapshot([npc]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [] }), {}, {}).outcome.kind, "done");
});

test("orbit-and-boost: no mate -> waits (never done); a mate present -> orbit it", () => {
  const none = orbitBoost(boostStep, obs({ snapshot: snapshot([]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [] }), {}, {});
  assert.equal(none.outcome.kind, "acting");
  assert.equal(none.action.kind, "wait");
  const mate = entity({ itemID: 7003, kind: "ship", characterID: 5002, shieldRatio: 1, armorRatio: 1, hullRatio: 1, position: { x: 5000, y: 0, z: 0 } });
  const orb = orbitBoost(boostStep, obs({ snapshot: snapshot([mate]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [5002] }), {}, {});
  assert.ok(orb.action.kind === "orbit" && orb.action.targetID === 7003);
});

// ── The fleet-management set ─────────────────────────────────────────────────

const createF = SCRIPT_MACROS["create-fleet"]!;
const inviteF = SCRIPT_MACROS["invite-to-fleet"]!;
const joinF = SCRIPT_MACROS["join-fleet"]!;
const createStep: MacroStep = { id: "cf", kind: "macro", macro: "create-fleet", args: {} };
const inviteStep: MacroStep = { id: "if", kind: "macro", macro: "invite-to-fleet", args: { who: { kind: "character", charID: 90001, name: "Alt" } } };
const joinStep: MacroStep = { id: "jf", kind: "macro", macro: "join-fleet", args: {} };

test("create-fleet: not in a fleet -> form one; already in one -> done; unread -> wait", () => {
  assert.equal(createF(createStep, obs({ inFleet: false }), {}, {}).action.kind, "createFleet");
  assert.equal(createF(createStep, obs({ inFleet: true }), {}, {}).outcome.kind, "done");
  assert.equal(createF(createStep, obs({ inFleet: null }), {}, {}).action.kind, "wait"); // reading, not deciding blind
});

test("invite-to-fleet: in a fleet -> invite once then done; not in a fleet -> blocked; no pilot -> blocked", () => {
  const inv = inviteF(inviteStep, obs({ inFleet: true }), {}, {});
  assert.ok(inv.action.kind === "inviteToFleet" && inv.action.charID === 90001);
  assert.equal(inviteF(inviteStep, obs({ inFleet: true }), inv.nextMem, {}).outcome.kind, "done");
  assert.equal(inviteF(inviteStep, obs({ inFleet: false }), {}, {}).outcome.kind, "blocked");
  const noWho: MacroStep = { id: "if", kind: "macro", macro: "invite-to-fleet", args: { who: { kind: "character", charID: null, name: null } } };
  assert.equal(inviteF(noWho, obs({ inFleet: true }), {}, {}).outcome.kind, "blocked");
});

test("join-fleet: not in a fleet -> keep accepting; in a fleet -> done", () => {
  assert.equal(joinF(joinStep, obs({ inFleet: false }), {}, {}).action.kind, "acceptFleetInvite");
  assert.equal(joinF(joinStep, obs({ inFleet: true }), {}, {}).outcome.kind, "done");
});


// ── join-advertised-fleet ────────────────────────────────────────────────────
// The opportunistic twin of join-fleet. The tests that matter most are the ones
// proving it does NOT stop the run when the fleet simply is not there, and that
// it will not join a fleet whose name merely resembles the one asked for.

const joinAdv = SCRIPT_MACROS["join-advertised-fleet"]!;
const joinAdvStep: MacroStep = {
  id: "jaf", kind: "macro", macro: "join-advertised-fleet",
  args: { fleetName: { kind: "text", text: "Mining Op" } },
};
/** One fleet-finder row. */
const ad = (fleetID: number, fleetName: string, numMembers = 1) => ({ fleetID, fleetName, numMembers });

test("join-advertised-fleet: already in a fleet -> done without reading the finder", () => {
  const done = joinAdv(joinAdvStep, obs({ inFleet: true }), {}, {});
  assert.equal(done.outcome.kind, "done");
  assert.equal(done.action.kind, "wait");
});

test("join-advertised-fleet: the named fleet is advertised -> apply to it", () => {
  const t = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: [ad(42, "Other Op"), ad(77, "Mining Op")] }), {}, {});
  assert.ok(t.action.kind === "applyToJoinFleet" && t.action.fleetID === 77);
  assert.equal(t.outcome.kind, "acting");
});

test("join-advertised-fleet: the name matches past case and padding, but never as a substring", () => {
  const loose = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: [ad(88, "  mining op ")] }), {}, {});
  assert.ok(loose.action.kind === "applyToJoinFleet" && loose.action.fleetID === 88);
  // "Sunday Mining Op" CONTAINS the typed name; an unattended ship must not join it.
  const substring = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: [ad(99, "Sunday Mining Op")] }), {}, {});
  assert.equal(substring.outcome.kind, "done");
  assert.equal(substring.action.kind, "wait");
});

test("join-advertised-fleet: nobody advertising that name -> DONE, so the loop carries on", () => {
  // The whole point of the block: an empty or non-matching finder is a real
  // answer, not a failure, and must never stop a bot that mines on alone.
  for (const ads of [[], [ad(42, "Other Op")]]) {
    const t = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: ads }), {}, {});
    assert.equal(t.outcome.kind, "done");
    assert.equal(t.action.kind, "wait");
  }
});

test("join-advertised-fleet: two fleets share the name -> the bigger one, stably", () => {
  const t = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: [ad(5, "Mining Op", 2), ad(6, "Mining Op", 9)] }), {}, {});
  assert.ok(t.action.kind === "applyToJoinFleet" && t.action.fleetID === 6);
  // Equal sizes must not flap between ticks: the lower id wins, both orderings.
  const tie = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: [ad(6, "Mining Op", 4), ad(5, "Mining Op", 4)] }), {}, {});
  assert.ok(tie.action.kind === "applyToJoinFleet" && tie.action.fleetID === 5);
});

test("join-advertised-fleet: an unreadable finder or fleet status waits, never guesses", () => {
  const noAds = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: null }), {}, {});
  assert.equal(noAds.outcome.kind, "acting");
  assert.equal(noAds.action.kind, "wait");
  const noFleet = joinAdv(joinAdvStep, obs({ inFleet: null }), {}, {});
  assert.equal(noFleet.outcome.kind, "acting");
  assert.equal(noFleet.action.kind, "wait");
});

// ⚠ THE REGRESSION THIS SECTION EXISTS FOR. The first version of this block
// applied and then waited for membership to appear, which it never does: an
// apply mints an INVITE and the client has to accept it. Every test below the
// apply is about the half that was missing, because the original tests all
// stopped at "emits an applyToJoinFleet action" and passed while the block hung
// on a live fleet.

/** The state after this block has applied to fleet 77 this activation. */
const APPLIED = { waited: 1, appliedTo: 77 };
const ads77 = [ad(77, "Mining Op")];

test("join-advertised-fleet: an apply is followed by ACCEPTING the invite it minted", () => {
  const applied = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: ads77 }), {}, {});
  assert.ok(applied.action.kind === "applyToJoinFleet" && applied.action.fleetID === 77);

  // The server minted an invite. Accept it, naming the fleet applied to rather
  // than depending on the notification having reached the store.
  const accepting = joinAdv(
    joinAdvStep,
    obs({ inFleet: false, fleetAds: ads77, fleetApplication: { fleetID: 77, outcome: "invited" } }),
    applied.nextMem,
    {},
  );
  assert.ok(accepting.action.kind === "acceptFleetInvite" && accepting.action.fleetID === 77);
  // And it does not apply a second time.
  assert.notEqual(accepting.action.kind, "applyToJoinFleet");

  // Membership ends the block.
  assert.equal(joinAdv(joinAdvStep, obs({ inFleet: true }), accepting.nextMem, {}).outcome.kind, "done");
});

test("join-advertised-fleet: an approval-gated fleet stops at once, it does not sit out the bound", () => {
  // No invite exists and none is coming -- only the boss can act. Saying so
  // beats timing out and blaming the fleet several minutes later.
  const t = joinAdv(
    joinAdvStep,
    obs({ inFleet: false, fleetAds: ads77, fleetApplication: { fleetID: 77, outcome: "needs-approval" } }),
    APPLIED,
    {},
  );
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /approve/i);
});

test("join-advertised-fleet: an answer it does not recognise still tries the accept", () => {
  // "unknown" is the honest third state. The invite half is the common one, and
  // a wasted accept costs one swallowed call where refusing to accept would
  // strand a bot that had an invite waiting.
  const t = joinAdv(
    joinAdvStep,
    obs({ inFleet: false, fleetAds: ads77, fleetApplication: { fleetID: 77, outcome: "unknown" } }),
    APPLIED,
    {},
  );
  assert.ok(t.action.kind === "acceptFleetInvite" && t.action.fleetID === 77);
});

test("join-advertised-fleet: an answer about a DIFFERENT fleet is not this application", () => {
  // The observation outlives a lap; step memory does not. A previous lap's
  // answer must not decide this one -- the fleet id is what keeps them apart.
  const t = joinAdv(
    joinAdvStep,
    obs({ inFleet: false, fleetAds: ads77, fleetApplication: { fleetID: 42, outcome: "needs-approval" } }),
    APPLIED,
    {},
  );
  assert.equal(t.outcome.kind, "acting");
  assert.equal(t.action.kind, "wait");
});

test("join-advertised-fleet: no answer yet waits; accepted but never landed gives up", () => {
  // The apply is in flight, or it threw and the runner swallowed it.
  const inFlight = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: ads77 }), APPLIED, {});
  assert.equal(inFlight.outcome.kind, "acting");
  assert.equal(inFlight.action.kind, "wait");

  // A join applied for AND accepted that still never lands is a real failure.
  const overdue = joinAdv(
    joinAdvStep,
    obs({ inFleet: false, fleetAds: ads77, fleetApplication: { fleetID: 77, outcome: "invited" } }),
    { waited: 10_000, appliedTo: 77 },
    {},
  );
  assert.equal(overdue.outcome.kind, "blocked");
});

test("join-advertised-fleet: no name typed -> blocked before anything is read", () => {
  const blank: MacroStep = {
    id: "jaf0", kind: "macro", macro: "join-advertised-fleet",
    args: { fleetName: { kind: "text", text: "   " } },
  };
  assert.equal(joinAdv(blank, obs({ inFleet: false, fleetAds: [ad(77, "Mining Op")] }), {}, {}).outcome.kind, "blocked");
});

// ── Movement extras, cargo extras, cap chain ─────────────────────────────────

const setDest = SCRIPT_MACROS["set-destination"]!;
const dockNearest = SCRIPT_MACROS["dock-at-nearest"]!;
const remoteCapBlock = SCRIPT_MACROS["remote-cap"]!;
const jettison = SCRIPT_MACROS["jettison-cargo"]!;
const tidy = SCRIPT_MACROS["tidy-hangar"]!;

const toStationStep: MacroStep = {
  id: "sd", kind: "macro", macro: "set-destination",
  args: { destination: { kind: "destination", ref: { entity: "station", id: 60008143, name: "Home", systemName: null } } },
};
const toSystemStep: MacroStep = {
  id: "sd2", kind: "macro", macro: "set-destination",
  args: { destination: { kind: "destination", ref: { entity: "system", id: 30005239, name: "Aring", systemName: null } } },
};

test("set-destination: a STATION destination starts a station route; a SYSTEM one a system route", () => {
  const st = setDest(toStationStep, obs({}), {}, {});
  assert.ok(st.action.kind === "startRoute" && st.action.stationID === 60008143);
  const sys = setDest(toSystemStep, obs({}), {}, {});
  assert.ok(sys.action.kind === "startSystemRoute" && sys.action.systemID === 30005239);
});

test("set-destination: done once the trip is under way, NOT on arrival", () => {
  const t = setDest(
    toStationStep,
    obs({ travel: { status: "running", destinationStationID: 60008143, destinationSystemID: null, remainingJumps: 4, failureReason: null } }),
    { issued: true },
    {},
  );
  assert.equal(t.outcome.kind, "done", "the block finishes with the ship still flying");
});

test("set-destination: a failure on THIS destination blocks; an unset destination blocks", () => {
  const failed = setDest(
    toStationStep,
    obs({ travel: { status: "paused", destinationStationID: 60008143, destinationSystemID: null, remainingJumps: 0, failureReason: "No gate route." } }),
    {},
    {},
  );
  assert.equal(failed.outcome.kind, "blocked");
  const unset: MacroStep = {
    id: "sd3", kind: "macro", macro: "set-destination",
    args: { destination: { kind: "destination", ref: { entity: "station", id: null, name: null, systemName: null } } },
  };
  assert.equal(setDest(unset, obs({}), {}, {}).outcome.kind, "blocked");
});

const dockNearStep: MacroStep = { id: "dn", kind: "macro", macro: "dock-at-nearest", args: {} };

test("dock-at-nearest: picks the CLOSEST dockable and docks when in range", () => {
  const near = entity({ itemID: 60001, kind: "station", name: "Near", radius: 1000, position: { x: 1500, y: 0, z: 0 } });
  const far = entity({ itemID: 60002, kind: "station", name: "Far", radius: 1000, position: { x: 9_000_000, y: 0, z: 0 } });
  const t = dockNearest(dockNearStep, obs({ snapshot: snapshot([near, far]) }), {}, {});
  assert.ok(t.action.kind === "dock" && t.action.stationID === 60001);
});

test("dock-at-nearest: far away warps; docked is done; nothing in view is blocked", () => {
  const far = entity({ itemID: 60002, kind: "station", name: "Far", radius: 1000, position: { x: 900_000_000, y: 0, z: 0 } });
  const warp = dockNearest(dockNearStep, obs({ snapshot: snapshot([far]) }), {}, {});
  assert.ok(warp.action.kind === "warp" && warp.action.targetID === 60002);

  const done = dockNearest(
    dockNearStep,
    obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60002 }) }),
    {},
    {},
  );
  assert.equal(done.outcome.kind, "done");

  const empty = dockNearest(dockNearStep, obs({ snapshot: snapshot([]) }), {}, {});
  assert.equal(empty.outcome.kind, "blocked");
});

test("dock-at-nearest: drones out means call them home before warping off", () => {
  const station = entity({ itemID: 60002, kind: "station", radius: 1000, position: { x: 900_000_000, y: 0, z: 0 } });
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = dockNearest(dockNearStep, obs({ snapshot: snapshot([station, drone]), dronesOut: true }), {}, {});
  assert.ok(t.action.kind === "recallDrones" && t.action.droneIDs.includes(111));
});

test("remote-cap: feeds the EMPTIEST mate; all healthy is done; none fitted is blocked", () => {
  const capStep: MacroStep = { id: "rc", kind: "macro", macro: "remote-cap", args: {} };
  const thirsty = entity({ itemID: 801, kind: "ship", characterID: 90001, isNpc: false, capacitorRatio: 0.2, position: { x: 1000, y: 0, z: 0 } });
  const fine = entity({ itemID: 802, kind: "ship", characterID: 90002, isNpc: false, capacitorRatio: 0.99, position: { x: 900, y: 0, z: 0 } });

  const lock = remoteCapBlock(capStep, obs({ snapshot: snapshot([thirsty, fine]), remoteCapModuleIDs: [640], fleetMemberCharacterIDs: [90001, 90002] }), {}, {});
  assert.ok(lock.action.kind === "lock" && lock.action.targetID === 801, "the emptiest one, not the nearest");

  const run = remoteCapBlock(
    capStep,
    obs({ snapshot: snapshot([thirsty], { activeModuleIDs: [] }), lockedTargetIDs: [801], remoteCapModuleIDs: [640], fleetMemberCharacterIDs: [90001] }),
    { capLockOn: 801 },
    {},
  );
  assert.ok(run.action.kind === "activate" && run.action.moduleID === 640 && run.action.targetID === 801);

  const allFine = remoteCapBlock(capStep, obs({ snapshot: snapshot([fine]), remoteCapModuleIDs: [640], fleetMemberCharacterIDs: [90002] }), {}, {});
  assert.equal(allFine.outcome.kind, "done");

  const noModule = remoteCapBlock(capStep, obs({ snapshot: snapshot([thirsty]), remoteCapModuleIDs: [] }), {}, {});
  assert.equal(noModule.outcome.kind, "blocked");

  const unavailable = remoteCapBlock(capStep, obs({
    snapshot: snapshot([thirsty]),
    remoteCapModuleIDs: [640],
    fleetMemberCharacterIDs: null,
  }), {}, {});
  assert.equal(unavailable.action.kind, "wait");
  assert.match(unavailable.why, /fleet roster/i);

  const stranger = remoteCapBlock(capStep, obs({
    snapshot: snapshot([thirsty, fine]),
    remoteCapModuleIDs: [640],
    fleetMemberCharacterIDs: [90002],
  }), {}, {});
  assert.equal(stranger.outcome.kind, "done", "a cap-starved non-member must not receive a transmitter");
});

test("remote-cap: a mate out of reach is closed on, and the transfer is bounded", () => {
  // The same two faults remote-rep had. Measured live: a Small Remote Capacitor
  // Transmitter I refused TargetNotWithinRangeGeneric at 17.9 km.
  const capStep: MacroStep = { id: "rc", kind: "macro", macro: "remote-cap", args: {} };
  const far = entity({ itemID: 801, kind: "ship", characterID: 90001, isNpc: false, capacitorRatio: 0.2, position: { x: 30000, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([far]), lockedTargetIDs: [801], remoteCapModuleIDs: [640], fleetMemberCharacterIDs: [90001] });
  const close = remoteCapBlock(capStep, world, { capLockOn: 801, capWaited: 0 }, {});
  assert.ok(close.action.kind === "approach" && close.action.targetID === 801);
  assert.match(close.why, /Closing in/);
  assert.equal(close.nextMem["capTries"] ?? 0, 0, "out of reach spends no budget");

  const near = entity({ itemID: 801, kind: "ship", characterID: 90001, isNpc: false, capacitorRatio: 0.2, position: { x: 1000, y: 0, z: 0 } });
  const inRange = obs({ snapshot: snapshot([near], { activeModuleIDs: [] }), lockedTargetIDs: [801], remoteCapModuleIDs: [640], fleetMemberCharacterIDs: [90001] });
  let mem: MacroMemory = { capLockOn: 801, capWaited: 0 };
  let fired = 0;
  for (let i = 0; i < 8; i++) {
    const t = remoteCapBlock(capStep, inRange, mem, {});
    if (t.action.kind === "activate") fired += 1;
    mem = t.nextMem;
  }
  assert.equal(fired, 3, `the transmitter is offered exactly MAX_REMOTE_ASSIST_ATTEMPTS times; got ${fired}`);
});

const assistanceCases: readonly { macro: "remote-rep" | "remote-cap" | "orbit-and-boost"; prefix: "rep" | "cap"; modules: Partial<ScriptObservation> }[] = [
  { macro: "remote-rep", prefix: "rep", modules: { remoteShieldRepairerIDs: [600] } },
  { macro: "remote-cap", prefix: "cap", modules: { remoteCapModuleIDs: [600] } },
  { macro: "orbit-and-boost", prefix: "rep", modules: { remoteShieldRepairerIDs: [600] } },
];
function assistanceWorld(modules: Partial<ScriptObservation>, a: number, b: number, active: readonly number[] | null): ScriptObservation {
  return obs({
    snapshot: snapshot([
      entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: a, armorRatio: 1, hullRatio: 1, capacitorRatio: a, position: { x: 1_000, y: 0, z: 0 } }),
      entity({ itemID: 7002, kind: "ship", characterID: 5002, shieldRatio: b, armorRatio: 1, hullRatio: 1, capacitorRatio: b, position: { x: 2_000, y: 0, z: 0 } }),
    ], { activeModuleIDs: active }),
    lockedTargetIDs: [7001, 7002], fleetMemberCharacterIDs: [5001, 5002], ...modules,
  });
}
for (const scenario of assistanceCases) {
  const step: MacroStep = { id: "assist", kind: "macro", macro: scenario.macro, args: {} };
  const decide = SCRIPT_MACROS[scenario.macro]!;
  test(`${scenario.macro}: stops the old recipient, observes off, then activates the already locked new recipient`, () => {
    const first = decide(step, assistanceWorld(scenario.modules, 0.2, 0.7, []), { orbiting: 7001 }, {});
    assert.deepEqual(first.action, { kind: "activate", moduleID: 600, targetID: 7001 });
    const changed = assistanceWorld(scenario.modules, 0.7, 0.1, [600]);
    const stop = decide(step, changed, first.nextMem, {});
    assert.deepEqual(stop.action, { kind: "deactivate", moduleID: 600 });
    const settling = decide(step, changed, stop.nextMem, {});
    assert.equal(settling.action.kind, "wait", "a successful stop request alone does not allow retargeting");
    const off = { ...changed, snapshot: { ...changed.snapshot!, ship: { ...changed.snapshot!.ship!, activeModuleIDs: [] } } };
    const confirmed = decide(step, off, settling.nextMem, {});
    assert.equal(confirmed.action.kind, "wait");
    const next = decide(step, off, confirmed.nextMem, {});
    assert.deepEqual(next.action, { kind: "activate", moduleID: 600, targetID: 7002 });
    const running = decide(step, changed, next.nextMem, {});
    assert.equal(running.action.kind, "wait", "the confirmed recipient is not stopped again");
    const full = assistanceWorld(scenario.modules, 1, 1, [600]);
    assert.equal(decide(step, full, running.nextMem, {}).action.kind, "deactivate", "active assistance is settled before completion");
  });
  test(`${scenario.macro}: an unreadable active map cannot activate, and an unknown active recipient must settle`, () => {
    const unreadable = decide(step, assistanceWorld(scenario.modules, 0.2, 0.7, null), { orbiting: 7001 }, {});
    assert.equal(unreadable.action.kind, "wait");
    const unknown = decide(step, assistanceWorld(scenario.modules, 0.2, 0.7, [600]), { orbiting: 7001 }, {});
    assert.deepEqual(unknown.action, { kind: "deactivate", moduleID: 600 });
    let mem = unknown.nextMem;
    let last = unknown;
    for (let i = 0; i < 20 && last.outcome.kind !== "blocked"; i++) {
      last = decide(step, assistanceWorld(scenario.modules, 0.2, 0.7, [600]), mem, {});
      assert.equal(last.action.kind, "wait");
      mem = last.nextMem;
    }
    assert.equal(last.outcome.kind, "blocked", "a module that never stops has a finite confirmation bound");
  });
  test(`${scenario.macro}: changing to an already locked mate resets that mate's activation budget`, () => {
    const next = decide(step, assistanceWorld(scenario.modules, 0.7, 0.1, []), {
      orbiting: 7001, [`${scenario.prefix}LockOn`]: 7001, [`${scenario.prefix}Tries`]: 3,
    }, {});
    assert.deepEqual(next.action, { kind: "activate", moduleID: 600, targetID: 7002 });
  });
}

test("remote assistance settles each active module before assigning the new recipient", () => {
  const modules = { remoteShieldRepairerIDs: [600, 601] };
  const first = remoteRep(repStep, assistanceWorld(modules, 0.2, 0.7, []), {}, {});
  const second = remoteRep(repStep, assistanceWorld(modules, 0.2, 0.7, [600]), first.nextMem, {});
  assert.deepEqual(second.action, { kind: "activate", moduleID: 601, targetID: 7001 });
  const stopFirst = remoteRep(repStep, assistanceWorld(modules, 0.7, 0.1, [600, 601]), second.nextMem, {});
  assert.deepEqual(stopFirst.action, { kind: "deactivate", moduleID: 600 });
  const confirmFirst = remoteRep(repStep, assistanceWorld(modules, 0.7, 0.1, [601]), stopFirst.nextMem, {});
  const stopSecond = remoteRep(repStep, assistanceWorld(modules, 0.7, 0.1, [601]), confirmFirst.nextMem, {});
  assert.deepEqual(stopSecond.action, { kind: "deactivate", moduleID: 601 }, "starting one rep must not bless the other's old recipient");
  const confirmed = remoteRep(repStep, assistanceWorld(modules, 0.7, 0.1, []), stopSecond.nextMem, {});
  const retarget = remoteRep(repStep, assistanceWorld(modules, 0.7, 0.1, []), confirmed.nextMem, {});
  assert.deepEqual(retarget.action, { kind: "activate", moduleID: 600, targetID: 7002 });
});

test("remote assistance stops a previously assigned module when its recipient leaves the fleet", () => {
  const modules = { remoteShieldRepairerIDs: [600] };
  const first = remoteRep(repStep, assistanceWorld(modules, 0.2, 0.7, []), {}, {});
  const departed = { ...assistanceWorld(modules, 0.2, 1, [600]), fleetMemberCharacterIDs: [5002] };
  assert.deepEqual(remoteRep(repStep, departed, first.nextMem, {}).action, { kind: "deactivate", moduleID: 600 });
});

for (const code of ["CALL_REFUSED", "EVE_GATEWAY_TIMEOUT"]) {
  test(`remote assistance handles ${code} without assigning an unconfirmed recipient`, async () => {
    const modules = { remoteShieldRepairerIDs: [600] };
    let world = assistanceWorld(modules, 0.2, 0.7, []);
    let fail = true;
    const issued: string[] = [];
    const runner = createScriptRunner({
      observe: async () => world,
      issue: async action => { issued.push(action.kind); if (fail) throw Object.assign(new Error(code), { code }); },
      sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
      registry: SCRIPT_MACROS, travelHome: scriptTravelHome,
    });
    runner.start({ format: "evejs-bot-script", version: 1, name: "Assistance", notes: "",
      home: { entity: "station", id: 60000004, name: "Home", systemName: null }, interrupts: [], program: [repStep] });
    await runner.tick();
    if (code === "EVE_GATEWAY_TIMEOUT") {
      assert.equal(runner.getStatus(), "paused");
      runner.resume();
      world = assistanceWorld(modules, 0.7, 0.1, [600]);
      for (let i = 0; i < 10; i++) await runner.tick();
      assert.deepEqual(issued, ["activate"], "an activation with an ambiguous outcome cannot blindly retarget");
    } else {
      fail = false;
      world = assistanceWorld(modules, 0.7, 0.1, [600]);
      for (let i = 0; i < 10 && issued.length < 2; i++) await runner.tick();
      assert.deepEqual(issued, ["activate", "deactivate"], "a refused activation did not establish ownership of the active module");
    }
  });
}

const jettisonStep: MacroStep = { id: "jc", kind: "macro", macro: "jettison-cargo", args: {} };

test("jettison-cargo: keepItems is honoured, and an UNREADABLE row is never thrown out", () => {
  // ⚠ The one block where getting this wrong cannot be undone: a jettisoned
  // stack goes into a can that despawns. So unlike the unload block, a row this
  // client cannot classify stays aboard.
  const keepCrystals: MacroStep = {
    id: "jc3", kind: "macro", macro: "jettison-cargo",
    args: { keepItems: { kind: "itemList", items: [{ match: "group", groupID: 483, name: "crystal" }] } },
  } as never;
  const rows = [
    { itemID: 11, typeID: 1230, groupID: 462, categoryID: 25, quantity: 50, singleton: false },
    { itemID: 12, typeID: 3389, groupID: 483, categoryID: 8, quantity: 2, singleton: false },
    { itemID: 13, typeID: 999, groupID: null, categoryID: null, quantity: 1, singleton: false },
  ];
  const cargo = { rows, capacity: null } as unknown as ScriptObservation["cargo"];
  const t = jettison(keepCrystals, obs({ cargo }), {}, {});
  assert.ok(t.action.kind === "jettison");
  assert.deepEqual(
    t.action.kind === "jettison" ? [...t.action.itemIDs] : [],
    [11],
    "the ore went out; the crystals and the unidentifiable stack stayed",
  );
});

test("jettison-cargo: dumps the whole hold, or only the picked item; empty is done", () => {
  const rows = [
    { itemID: 11, typeID: 34, quantity: 100, singleton: false },
    { itemID: 12, typeID: 1230, quantity: 50, singleton: false },
  ];
  const cargo = { rows, capacity: null } as unknown as ScriptObservation["cargo"];
  const all = jettison(jettisonStep, obs({ cargo }), {}, {});
  assert.ok(all.action.kind === "jettison" && all.action.itemIDs.length === 2);

  const onlyOre: MacroStep = {
    id: "jc2", kind: "macro", macro: "jettison-cargo",
    args: { item: { kind: "itemType", typeID: 1230, name: "Veldspar" } },
  };
  const one = jettison(onlyOre, obs({ cargo }), {}, {});
  assert.ok(one.action.kind === "jettison" && one.action.itemIDs.length === 1 && one.action.itemIDs[0] === 12);

  const emptied = jettison(
    jettisonStep,
    obs({ cargo: { rows: [], capacity: null } as unknown as ScriptObservation["cargo"] }),
    {},
    {},
  );
  assert.equal(emptied.outcome.kind, "done", "the hold emptying IS the confirmation");
});

test("jettison-cargo: docked is blocked, since a can needs space to float in", () => {
  const t = jettison(
    jettisonStep,
    obs({ inSpace: false, flightStatus: flight({ docked: true, inSpace: false }) }),
    {},
    {},
  );
  assert.equal(t.outcome.kind, "blocked");
});

const jettisonOreStep: MacroStep = { id: "jo", kind: "macro", macro: "jettison-ore", args: {} };
const jettisonOre = SCRIPT_MACROS["jettison-ore"]!;

test("jettison-ore: dumps the ore hold, never the (empty) cargo hold", () => {
  const holds: NonNullable<ScriptObservation["holds"]> = [
    { key: "cargo", label: "Cargo Hold", items: [], capacity: null, present: true, error: null },
    {
      key: "ore",
      label: "Ore Hold",
      items: [
        { itemID: 21, typeID: 1230, quantity: 500, singleton: false },
        { itemID: 22, typeID: 1228, quantity: 300, singleton: false },
      ] as unknown as NonNullable<ScriptObservation["holds"]>[number]["items"],
      capacity: null,
      present: true,
      error: null,
    },
  ];
  const all = jettisonOre(jettisonOreStep, obs({ holds }), {}, {});
  assert.ok(all.action.kind === "jettison" && all.action.itemIDs.length === 2);

  const onlyVeldspar: MacroStep = {
    id: "jo2", kind: "macro", macro: "jettison-ore",
    args: { item: { kind: "itemType", typeID: 1230, name: "Veldspar" } },
  };
  const one = jettisonOre(onlyVeldspar, obs({ holds }), {}, {});
  assert.ok(one.action.kind === "jettison" && one.action.itemIDs.length === 1 && one.action.itemIDs[0] === 21);
});

test("jettison-ore: an empty ore hold is done; a ship with no ore hold is blocked", () => {
  const emptyOre: NonNullable<ScriptObservation["holds"]> = [
    { key: "ore", label: "Ore Hold", items: [], capacity: null, present: true, error: null },
  ];
  const emptied = jettisonOre(jettisonOreStep, obs({ holds: emptyOre }), {}, {});
  assert.equal(emptied.outcome.kind, "done");

  const cargoOnly: NonNullable<ScriptObservation["holds"]> = [
    { key: "cargo", label: "Cargo Hold", items: [], capacity: null, present: true, error: null },
  ];
  const noHold = jettisonOre(jettisonOreStep, obs({ holds: cargoOnly }), {}, {});
  assert.equal(noHold.outcome.kind, "blocked");
  assert.match(noHold.outcome.kind === "blocked" ? noHold.outcome.reason : "", /no ore hold/i);
});

test("ore inventory blocks wait on unreadable contents instead of finishing or declaring absence", () => {
  const ore: MiningHold = { key: "ore", label: "Ore Hold", items: null, capacity: { capacity: 5_000, used: 4_900 }, present: true, error: "READ_FAILED" };
  const cargo: MiningHold = { key: "cargo", label: "Cargo Hold", items: [], capacity: { capacity: 400, used: 0 }, present: true, error: null };
  const moveStep: MacroStep = { id: "move", kind: "macro", macro: "move-items", args: {
    item: { kind: "itemType", typeID: 1230, name: "Veldspar" }, from: { kind: "place", place: "ore-hold" }, to: { kind: "place", place: "hangar" },
  } };
  for (const unreadable of [ore, { ...ore, present: false, capacity: null }]) {
    const world = obs({ snapshot: snapshot([]), holds: [unreadable, cargo] });
    for (const result of [
      jettisonOre(jettisonOreStep, world, NM, {}),
      SCRIPT_MACROS["move-items"]!(moveStep, { ...world, flightStatus: flight({ docked: true, inSpace: false }) }, NM, {}),
      SCRIPT_MACROS["compress-ore"]!({ id: "compress", kind: "macro", macro: "compress-ore", args: {} }, world, NM, {}),
    ]) {
      assert.equal(result.action.kind, "wait");
      assert.equal(result.outcome.kind, "acting");
    }
  }
});

test("jettison-ore: docked is blocked, since a can needs space to float in", () => {
  const t = jettisonOre(
    jettisonOreStep,
    obs({ inSpace: false, flightStatus: flight({ docked: true, inSpace: false }) }),
    {},
    {},
  );
  assert.equal(t.outcome.kind, "blocked");
});

test("tidy-hangar: stacks once then done; undocked is blocked", () => {
  const step: MacroStep = { id: "th", kind: "macro", macro: "tidy-hangar", args: {} };
  const docked = obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60008143 }) });
  const first = tidy(step, docked, {}, {});
  assert.equal(first.action.kind, "stackHangar");
  assert.equal(tidy(step, docked, first.nextMem, {}).outcome.kind, "done");
  assert.equal(tidy(step, obs({}), {}, {}).outcome.kind, "blocked");
});

test("mine: the biggest-rock order prefers the most ore left; the default stays nearest", () => {
  const small = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, remainingQuantity: 100, position: { x: 3000, y: 0, z: 0 } });
  const big = entity({ itemID: 50002, name: "Veldspar", miningYieldTypeID: 1230, remainingQuantity: 9000, position: { x: 9000, y: 0, z: 0 } });
  const unknown = entity({ itemID: 50003, name: "Veldspar", miningYieldTypeID: 1230, remainingQuantity: null, position: { x: 1000, y: 0, z: 0 } });
  const biggestStep: MacroStep = {
    ...mineStep, id: "mb",
    args: { ...mineStep.args, pick: { kind: "rockPick", pick: "biggest" } },
  };
  const t = mine(biggestStep, obs({ snapshot: snapshot([small, big, unknown]) }), NM, {});
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50002, "the big one, though it is furthest");

  const near = mine(mineStep, obs({ snapshot: snapshot([small, big, unknown]) }), NM, {});
  assert.ok(near.action.kind === "orbit" && near.action.targetID === 50003, "default still picks the nearest");
});

test("mine: the most-valuable order prefers ISK per m³, and breaks ties by distance", () => {
  // Two ores in the belt. The cheap one is nearer and holds more; the valuable
  // one is what a hold-sized trip is actually worth, which is the whole point.
  const cheapNear = entity({ itemID: 50101, name: "Veldspar", miningYieldTypeID: 1230, remainingQuantity: 9000, oreValuePerM3: 52.8, position: { x: 1000, y: 0, z: 0 } });
  const cheapFar = entity({ itemID: 50102, name: "Veldspar", miningYieldTypeID: 1230, remainingQuantity: 9000, oreValuePerM3: 52.8, position: { x: 4000, y: 0, z: 0 } });
  const richFar = entity({ itemID: 50103, name: "Kernite", miningYieldTypeID: 1228, remainingQuantity: 500, oreValuePerM3: 120.5, position: { x: 9000, y: 0, z: 0 } });
  const valuableStep: MacroStep = {
    ...mineStep, id: "mv",
    args: { ...mineStep.args, pick: { kind: "rockPick", pick: "valuable" } },
  };
  const rich = mine(valuableStep, obs({ snapshot: snapshot([cheapNear, cheapFar, richFar]) }), NM, {});
  assert.ok(rich.action.kind === "orbit" && rich.action.targetID === 50103, "the richer ore, though it is furthest and smaller");

  // ⚠ THE TIE IS THE COMMON CASE: a belt of one ore prices every rock the same.
  // Without a distance tie-break this pick would be "whichever rock came first".
  const tied = mine(valuableStep, obs({ snapshot: snapshot([cheapFar, cheapNear]) }), NM, {});
  assert.ok(tied.action.kind === "orbit" && tied.action.targetID === 50101, "same ore, so the nearest of them");
});

test("mine: an unpriced rock sorts last, and a belt nobody could price falls back to nearest", () => {
  const priced = entity({ itemID: 50201, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: 52.8, position: { x: 9000, y: 0, z: 0 } });
  const unpriced = entity({ itemID: 50202, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: null, position: { x: 1000, y: 0, z: 0 } });
  const valuableStep: MacroStep = {
    ...mineStep, id: "mv2",
    args: { ...mineStep.args, pick: { kind: "rockPick", pick: "valuable" } },
  };
  const known = mine(valuableStep, obs({ snapshot: snapshot([priced, unpriced]) }), NM, {});
  assert.ok(known.action.kind === "orbit" && known.action.targetID === 50201, "a null price is not a cheap rock");

  // Nothing priced at all: the pick has no opinion, so it stops inventing one.
  const blind = mine(valuableStep, obs({ snapshot: snapshot([unpriced, priced2()]) }), NM, {});
  assert.ok(blind.action.kind === "orbit" && blind.action.targetID === 50202, "back to the nearest rock");
});

/** A second unpriced rock, further out — for the "nothing is priced" case. */
function priced2() {
  return entity({ itemID: 50203, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: null, position: { x: 7000, y: 0, z: 0 } });
}

// ── the ore priority nobody typed ────────────────────────────────────────────

test("mine: with NO ore list the block works the richest ore on the belt, not the nearest rock", () => {
  // The default pick is "nearest" — and it still is, WITHIN the ore worth most.
  // This is the whole of the automatic ordering: which ore comes first is a
  // different question from which of that ore's rocks to fly to.
  const cheapNear = entity({ itemID: 50301, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: 52.8, position: { x: 1000, y: 0, z: 0 } });
  const richFar = entity({ itemID: 50302, name: "Kernite", miningYieldTypeID: 1228, oreValuePerM3: 95.04, position: { x: 8000, y: 0, z: 0 } });
  const richFarther = entity({ itemID: 50303, name: "Kernite", miningYieldTypeID: 1228, oreValuePerM3: 95.04, position: { x: 12000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([cheapNear, richFar, richFarther]) }), NM, {});
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50302, "the Kernite, and the nearer of the two");
});

test("mine: a rock already being WORKED is not dropped when a richer one drifts into view", () => {
  // Half a cycle into a Veldspar rock is not the moment to fly off: the ore
  // priority restricts what to pick NEXT, it does not re-open a rock in hand.
  const working = entity({ itemID: 50311, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: 52.8, position: { x: 1000, y: 0, z: 0 } });
  const richer = entity({ itemID: 50312, name: "Kernite", miningYieldTypeID: 1228, oreValuePerM3: 95.04, position: { x: 2000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([working, richer]) }), { rockID: 50311 }, {});
  assert.ok(t.action.kind === "lock" && t.action.targetID === 50311, "it carries on with the rock it was working");
});

test("mine: with nothing priced the block picks exactly as it always did", () => {
  // An older BFF (or ore nobody could price) leaves every value null. That must
  // read as "no opinion", not as "every rock is worthless".
  const near = entity({ itemID: 50321, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: null, position: { x: 1000, y: 0, z: 0 } });
  const far = entity({ itemID: 50322, name: "Kernite", miningYieldTypeID: 1228, oreValuePerM3: null, position: { x: 9000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([far, near]) }), NM, {});
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50321, "the nearest rock, as before");
});

test("mine: a HAND-WRITTEN ore list outranks the value ordering, because it answers a different question", () => {
  // A player who typed "Veldspar" is not asking what the belt is worth — they
  // want Veldspar, and a richer rock sitting next to it changes nothing.
  const veld = entity({ itemID: 50331, name: "Veldspar", groupID: VELDSPAR.groupID, miningYieldTypeID: 1230, oreValuePerM3: 52.8, position: { x: 9000, y: 0, z: 0 } });
  const kern = entity({ itemID: 50332, name: "Kernite", groupID: KERNITE.groupID, miningYieldTypeID: 1228, oreValuePerM3: 95.04, position: { x: 1000, y: 0, z: 0 } });
  const t = mine(oreListStep([VELDSPAR]), obs({ snapshot: snapshot([veld, kern]) }), NM, {});
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50331, "the ore on the list, though the other is nearer AND richer");
});

// ── compress-ore (the fleet mechanic) ────────────────────────────────────────

const compress = SCRIPT_MACROS["compress-ore"]!;
const compressStep: MacroStep = { id: "co", kind: "macro", macro: "compress-ore", args: {} };

/** A hold with these stacks in it. */
function oreHold(items: readonly { itemID: number; typeID: number; quantity: number }[]): MiningHold[] {
  // Everything in an ore hold is ore, so the helper classifies it as such —
  // callers say what is there, not what kind of thing it is.
  const rows: HoldItem[] = items.map((item) => ({ ...item, groupID: 462, categoryID: 25 }));
  return [{ key: "ore", label: "Ore Hold", items: rows, capacity: null, present: true, error: null }];
}

/** A support ship that IS running its compression gear. */
function facilityShip(itemID: number, characterID: number, x: number, rangeMeters = 60_000): SpaceEntity {
  return entity({
    itemID, kind: "ship", characterID, isNpc: false, radius: 3000,
    position: { x, y: 0, z: 0 },
    compressionFacility: { rangeMeters, typeListIDs: [1] },
  });
}

test("compress-ore: an in-range support ship on grid -> compress the first stack", () => {
  const orca = facilityShip(7001, 90002, 20_000);
  const t = compress(compressStep, obs({ snapshot: snapshot([orca]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 5000 }]) }), {}, {});
  assert.ok(t.action.kind === "compressOre" && t.action.itemID === 11 && t.action.facilityID === 7001);
});

test("compress-ore: no support ship running its gear -> blocked, and says so", () => {
  // An ordinary ship on grid is NOT a facility, and neither is one whose modules
  // are off (compressionFacility null).
  const plain = entity({ itemID: 7002, kind: "ship", characterID: 90003, isNpc: false, position: { x: 1000, y: 0, z: 0 } });
  const off = entity({ itemID: 7003, kind: "ship", characterID: 90004, isNpc: false, compressionFacility: null, position: { x: 1200, y: 0, z: 0 } });
  const t = compress(compressStep, obs({ snapshot: snapshot([plain, off]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 5000 }]) }), {}, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /compression gear/i);
});

test("compress-ore: an ABSENT facility reading is not a facility (no hopeful firing)", () => {
  // An older server, or a row the gateway did not project: the field is missing
  // entirely. That must read as "not a facility", not as an unknown worth trying.
  const unknown = entity({ itemID: 7004, kind: "ship", characterID: 90005, isNpc: false, position: { x: 900, y: 0, z: 0 } });
  delete (unknown as { compressionFacility?: unknown }).compressionFacility;
  const t = compress(compressStep, obs({ snapshot: snapshot([unknown]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 5000 }]) }), {}, {});
  assert.equal(t.outcome.kind, "blocked");
});

test("compress-ore: an NPC hull is never a facility", () => {
  const rat = entity({
    itemID: 7005, kind: "ship", isNpc: true, npcEntityType: "npc",
    position: { x: 500, y: 0, z: 0 },
    compressionFacility: { rangeMeters: 60_000, typeListIDs: [1] },
  });
  const t = compress(compressStep, obs({ snapshot: snapshot([rat]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 1 }]) }), {}, {});
  assert.equal(t.outcome.kind, "blocked");
});

test("compress-ore: out of the facility's range -> close in first, then compress", () => {
  // 200 km away with a 60 km reach: too far for the server to accept.
  const far = facilityShip(7001, 90002, 200_000, 60_000);
  const holds = oreHold([{ itemID: 11, typeID: 1230, quantity: 5000 }]);
  const closing = compress(compressStep, obs({ snapshot: snapshot([far]), holds }), {}, {});
  assert.ok(
    closing.action.kind === "approach" || closing.action.kind === "warp",
    `expected to close the gap, got ${closing.action.kind}`,
  );

  // Inside its reach, it compresses.
  const near = facilityShip(7001, 90002, 30_000, 60_000);
  const inRange = compress(compressStep, obs({ snapshot: snapshot([near]), holds }), {}, {});
  assert.equal(inRange.action.kind, "compressOre");
});

test("compress-ore: OWN ship as the facility needs no closing in", () => {
  // The ego ship itself is running the gear (a Rorqual compressing its own ore).
  const self = entity({
    itemID: 9001, kind: "ship", isSelf: true, isNpc: false, characterID: 90001,
    position: { x: 0, y: 0, z: 0 },
    compressionFacility: { rangeMeters: 1, typeListIDs: [1] },
  });
  const t = compress(compressStep, obs({ snapshot: snapshot([self]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 5000 }]) }), {}, {});
  assert.ok(t.action.kind === "compressOre" && t.action.facilityID === 9001);
});

test("compress-ore: own ship is preferred over a fleet-mate's facility", () => {
  const self = entity({
    itemID: 9001, kind: "ship", isSelf: true, isNpc: false, characterID: 90001,
    position: { x: 0, y: 0, z: 0 },
    compressionFacility: { rangeMeters: 1, typeListIDs: [1] },
  });
  const mate = facilityShip(7001, 90002, 5000);
  const t = compress(compressStep, obs({ snapshot: snapshot([self, mate]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 1 }]) }), {}, {});
  assert.ok(t.action.kind === "compressOre" && t.action.facilityID === 9001);
});

test("compress-ore: each stack gets ONE attempt, then the block finishes", () => {
  const orca = facilityShip(7001, 90002, 20_000);
  const holds = oreHold([
    { itemID: 11, typeID: 1230, quantity: 5000 },
    { itemID: 12, typeID: 1228, quantity: 3000 },
  ]);
  let mem: MacroMemory = {};
  const attempted: number[] = [];
  let finishedOnTick = -1;
  for (let i = 0; i < 5; i++) {
    const t = compress(compressStep, obs({ snapshot: snapshot([orca]), holds }), mem, {});
    if (t.action.kind === "compressOre") attempted.push(t.action.itemID);
    mem = t.nextMem;
    if (t.outcome.kind === "done") {
      finishedOnTick = i;
      break;
    }
  }
  assert.deepEqual(attempted, [11, 12], "each stack once, in order — an ore with no compressed form is not retried forever");
  assert.equal(finishedOnTick, 2, "it finishes the tick after the last stack, never looping on a stubborn one");
  // ⚠ The memory it finishes with is CLEARED, on purpose: the runner resets
  // per-step memory at a step boundary anyway, and inside a Repeat loop the next
  // lap must reconsider ore mined since rather than remember an empty hold.
  assert.equal(mem["triedItemIDs"], undefined);
});

test("compress-ore: an EMPTY hold is done; an UNREADABLE hold waits", () => {
  const orca = facilityShip(7001, 90002, 20_000);
  const empty = compress(compressStep, obs({ snapshot: snapshot([orca]), holds: oreHold([]) }), {}, {});
  assert.equal(empty.outcome.kind, "done");

  // items:null is "we could not look", NOT "it is empty" — it must not finish.
  const blind: MiningHold[] = [{ key: "ore", label: "Ore Hold", items: null, capacity: null, present: true, error: "read failed" }];
  const waiting = compress(compressStep, obs({ snapshot: snapshot([orca]), holds: blind }), {}, {});
  assert.equal(waiting.action.kind, "wait");
  assert.notEqual(waiting.outcome.kind, "done", "a failed read must never look like an empty hold");
});

test("compress-ore: docked -> blocked; mid-warp -> waits", () => {
  const docked = compress(compressStep, obs({ inSpace: false, flightStatus: flight({ docked: true, inSpace: false }) }), {}, {});
  assert.equal(docked.outcome.kind, "blocked");
  const warping = compress(compressStep, obs({ inWarp: true, snapshot: snapshot([]) }), {}, {});
  assert.equal(warping.action.kind, "wait");
  assert.equal(warping.outcome.kind, "acting");
});

test("compress-ore / jettison: an UNREADABLE location waits, it does not say 'undock first'", () => {
  // The whole flight status is missing (a first tick, or a failed read). Docked is
  // a verdict; unreadable is not — telling a player to undock a ship whose place
  // has not been read yet is exactly the mistake the tri-state rule prevents.
  const blind = obs({ inSpace: null, flightStatus: null, snapshot: null, holds: null, cargo: null });
  const c = compress(compressStep, blind, {}, {});
  assert.equal(c.action.kind, "wait");
  assert.equal(c.outcome.kind, "acting", "an unread location must not be a blocked verdict");

  const j = jettison(jettisonStep, blind, {}, {});
  assert.equal(j.action.kind, "wait");
  assert.equal(j.outcome.kind, "acting");

  // And a genuinely docked ship still blocks, with the plain hint.
  const parked = obs({ inSpace: false, flightStatus: flight({ docked: true, inSpace: false }) });
  assert.equal(compress(compressStep, parked, {}, {}).outcome.kind, "blocked");
  assert.equal(jettison(jettisonStep, parked, {}, {}).outcome.kind, "blocked");
});

// ── target priority (nav/targetPriority.ts) ──────────────────────────────────
//
// The ladder decides WHICH hostile is primary; the rest of the engage is
// unchanged, so these only assert the pick. Group names arrive on the
// observation the same way drone roles do — resolved, or not resolved at all.

const TACKLE_TYPE = 11176; // an Interceptor hull
const BRICK_TYPE = 645; // a battleship hull
const GRID_GROUPS = { [TACKLE_TYPE]: "Interceptor", [BRICK_TYPE]: "Battleship" };

test("fight: the far tackle is primary over the near battleship", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const step = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const near = entity({ itemID: 6661, typeID: BRICK_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 2000, y: 0, z: 0 } });
  const far = entity({ itemID: 6662, typeID: TACKLE_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 40000, y: 0, z: 0 } });
  const tick = fight(step, obs({ snapshot: snapshot([near, far]), weaponModuleIDs: [500], targetGroupNames: GRID_GROUPS }), {}, {});
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6662);
});

test("fight: with no groups resolved the pick is the old nearest-first", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const step = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const near = entity({ itemID: 6661, typeID: BRICK_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 2000, y: 0, z: 0 } });
  const far = entity({ itemID: 6662, typeID: TACKLE_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 40000, y: 0, z: 0 } });
  const blind = fight(step, obs({ snapshot: snapshot([near, far]), weaponModuleIDs: [500] }), {}, {});
  assert.ok(blind.action.kind === "lock" && blind.action.targetID === 6661);
  // A map that answers null for these types is the same "cannot tell".
  const unresolved = fight(
    step,
    obs({ snapshot: snapshot([near, far]), weaponModuleIDs: [500], targetGroupNames: { [TACKLE_TYPE]: null, [BRICK_TYPE]: null } }),
    {},
    {},
  );
  assert.ok(unresolved.action.kind === "lock" && unresolved.action.targetID === 6661);
});

test("fight: the player's own ladder is followed", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const step = {
    id: "f",
    kind: "macro",
    macro: "fight-the-rats",
    args: { targets: { kind: "targetList", classes: ["other", "tackle"] } },
  } as const;
  const near = entity({ itemID: 6661, typeID: BRICK_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 40000, y: 0, z: 0 } });
  const far = entity({ itemID: 6662, typeID: TACKLE_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 2000, y: 0, z: 0 } });
  const tick = fight(step, obs({ snapshot: snapshot([near, far]), weaponModuleIDs: [500], targetGroupNames: GRID_GROUPS }), {}, {});
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6661, "battleships first, because that is what was asked");
});

// ── the rat's own dogma, and the live jam feed ───────────────────────────────
//
// ⚠ THE PARCEL A HULL PAID FOR. Live run, 2026-09-14: the armour watch fired at
// its threshold and did everything right — drones home, aligned out, course set
// — and the warp came back REFUSED, because a frigate had the ship scrammed.
// The escape borrowed `fight-the-rats`, which is the correct answer in
// principle, and `fight-the-rats` shot the NEAREST rat. The frigate with the
// point on it was never touched, and the ship died forty seconds later killing
// something whose death freed nothing.
//
// Two reads were missing from the pick, and the server had both of them:
//
//   `threatByTypeID` — the rat's OWN dogma. Every NPC's group name is an
//   "Asteroid Serpentis Frigate", which the group classifier calls "other", so
//   without the dogma the WHOLE grid ties and the player's target priority is
//   decoration. That is a second real bug this fixes, for every ratting bot and
//   not only for the escape.
//
//   `jammingSourceIDs` — the server naming, on this ship's own wire, the exact
//   entities whose hostile modules are landing on it RIGHT NOW. Not a guess
//   about a type: ground truth about this fight.

const PLAIN_RAT_TYPE = 30100; // a rat whose dogma says it does nothing to us
const SCRAM_RAT_TYPE = 30101; // its sibling, one attribute apart, that holds us
// Same faction, same size, same words in the name bar — and the group name the
// game gives both of them is one the player-hull classifier has never heard of.
const RAT_GROUPS = {
  [PLAIN_RAT_TYPE]: "Asteroid Serpentis Frigate",
  [SCRAM_RAT_TYPE]: "Asteroid Serpentis Frigate",
};
const SCRAMMER: RatThreat = { scram: true, scramRangeM: 20_000, web: false, ewar: false };
const HARMLESS: RatThreat = { scram: false, scramRangeM: null, web: false, ewar: false };

/** A rat at a distance, hostile the way `hostileRows` reads hostility. */
function rat(itemID: number, metres: number, typeID = PLAIN_RAT_TYPE): SpaceEntity {
  return entity({ itemID, typeID, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: metres, y: 0, z: 0 } });
}

test("fight: the rat that is HOLDING the ship is primary over a nearer one", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const step = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const world = {
    snapshot: snapshot([rat(6661, 5_000), rat(6662, 30_000)]),
    weaponModuleIDs: [500],
    targetGroupNames: RAT_GROUPS,
    threatByTypeID: { [PLAIN_RAT_TYPE]: HARMLESS },
  } satisfies Partial<ScriptObservation>;

  // Same type, same class, same sub-rank: distance alone decides, so the near
  // one is primary. This is the pick that killed a ship.
  const quiet = fight(step, obs(world), {}, {});
  assert.ok(quiet.action.kind === "lock" && quiet.action.targetID === 6661);

  // Now the server says the FAR one is the thing actually holding us.
  const held = fight(step, obs({ ...world, jammingSourceIDs: [6662] }), {}, {});
  assert.ok(held.action.kind === "lock" && held.action.targetID === 6662, "shoot what is holding the ship");
});

test("fight: with no dogma and no jam fold the pick is exactly the old nearest-first", () => {
  // ⚠ THE REGRESSION GUARD FOR EVERY BOT ALREADY FLYING. Both new readers are
  // three-state and both default to "nobody looked": an observation that never
  // resolved a dogma map and never folded a jam push must collapse the ordering
  // back to (class, distance) and pick byte-for-byte what it picked before.
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const step = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const blind = fight(step, obs({ snapshot: snapshot([rat(6661, 5_000), rat(6662, 30_000)]), weaponModuleIDs: [500] }), {}, {});
  assert.ok(blind.action.kind === "lock" && blind.action.targetID === 6661);

  // An EMPTY jam fold is a different statement — "we looked, nothing is on us"
  // — and it must not move the pick either.
  const looked = fight(
    step,
    obs({ snapshot: snapshot([rat(6661, 5_000), rat(6662, 30_000)]), weaponModuleIDs: [500], jammingSourceIDs: [] }),
    {},
    {},
  );
  assert.ok(looked.action.kind === "lock" && looked.action.targetID === 6661);
});

test("fight: a rat whose dogma says it scrams outranks one that does not, same group and same distance", () => {
  // The two rows are indistinguishable to every other read on the grid: same
  // faction group name, same distance, and the harmless one is listed FIRST so
  // a tie would keep it. Only attribute 504 separates them.
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const step = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const grid = snapshot([rat(6661, 10_000, PLAIN_RAT_TYPE), rat(6662, 10_000, SCRAM_RAT_TYPE)]);

  const withoutDogma = fight(step, obs({ snapshot: grid, weaponModuleIDs: [500], targetGroupNames: RAT_GROUPS }), {}, {});
  assert.ok(withoutDogma.action.kind === "lock" && withoutDogma.action.targetID === 6661, "the group name cannot tell them apart");

  const withDogma = fight(
    step,
    obs({
      snapshot: grid,
      weaponModuleIDs: [500],
      targetGroupNames: RAT_GROUPS,
      threatByTypeID: { [PLAIN_RAT_TYPE]: HARMLESS, [SCRAM_RAT_TYPE]: SCRAMMER },
    }),
    {},
    {},
  );
  assert.ok(withDogma.action.kind === "lock" && withDogma.action.targetID === 6662, "the scrammer dies first");
});

test("fight: a class the player left off is still shot — the ladder RANKS, it never filters", () => {
  // ⚠ THE RULE THAT MUST SURVIVE THE DOGMA READER. Now that a rat can actually
  // be classified, a priority list that omits its class could plausibly be read
  // as "do not shoot that" — and a combat block that refused to shoot would sit
  // there being killed by the only thing on the grid. A list the scrammer is
  // absent from ranks it LAST, never out.
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const step = {
    id: "f",
    kind: "macro",
    macro: "fight-the-rats",
    args: { targets: { kind: "targetList", classes: ["logi"] } },
  } as const;
  const tick = fight(
    step,
    obs({
      snapshot: snapshot([rat(6662, 10_000, SCRAM_RAT_TYPE)]),
      weaponModuleIDs: [500],
      targetGroupNames: RAT_GROUPS,
      threatByTypeID: { [SCRAM_RAT_TYPE]: SCRAMMER },
    }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6662, "nothing on the list, so the tackle is still shot");
});

test("follow: the fleet's TAG still outranks the live jam feed", () => {
  // ⚠ AUTHORITY, AND IT IS THE ONE PRECEDENCE THE JAM FOLD DOES NOT WIN. A jam
  // source is a fact about the grid; a tag is a fleet commander LOOKING at the
  // fight and saying "this one, now", and the server proves that authorship
  // (setFleetTargetTag refuses any writer who is not a commander). So the human
  // wins — the tagged near rat is locked even though the server says the far one
  // is what is holding this ship.
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const tick = fight(
    fightStep("follow"),
    obs({
      snapshot: snapshot([rat(6661, 5_000), rat(6662, 30_000)]),
      weaponModuleIDs: [500],
      targetGroupNames: RAT_GROUPS,
      threatByTypeID: { [PLAIN_RAT_TYPE]: HARMLESS },
      fleetTargetTags: new Map([[6661, "A"]]),
      jammingSourceIDs: [6662],
    }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6661, "the FC's tag, not the jam feed");
  assert.match(tick.why, /fleet called/i);
});

test("fleet-tag-target: the tag marks what the fight block would shoot, jam feed included", () => {
  // Two ladders in one squad is one ladder too many: whatever this block writes
  // is read straight back by every follower's `calledByTag`, where a tag
  // outranks the jam fold. A tag block still picking nearest-first would hand
  // the squad a commander-authority instruction to shoot the wrong rat.
  const tagBlock = SCRIPT_MACROS["fleet-tag-target"]!;
  const step = { id: "t", kind: "macro", macro: "fleet-tag-target", args: {} } as const;
  const tick = tagBlock(
    step,
    obs({
      snapshot: snapshot([rat(6661, 5_000), rat(6662, 30_000)]),
      canTag: true,
      targetGroupNames: RAT_GROUPS,
      threatByTypeID: { [PLAIN_RAT_TYPE]: HARMLESS },
      jammingSourceIDs: [6662],
    }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "setFleetTargetTag" && tick.action.targetID === 6662);
});

// ── flying with the fleet (the shared squad board) ───────────────────────────
//
// `squad: follow` shoots what the fleet called WHEN that ship is here; `squad:
// call` says what this pilot is on, once per primary. Everything else is the
// same engage, so these assert the pick and the one extra action.

function fightStep(squad: "off" | "call" | "follow"): MacroStep {
  return {
    id: "f",
    kind: "macro",
    macro: "fight-the-rats",
    args: squad === "off" ? {} : { squad: { kind: "squadRole", role: squad } },
  };
}

const RAT_NEAR = entity({ itemID: 6661, typeID: BRICK_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 2000, y: 0, z: 0 } });
const RAT_FAR = entity({ itemID: 6662, typeID: BRICK_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 40000, y: 0, z: 0 } });

test("follow: the fleet's call outranks this pilot's own pick", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const tick = fight(
    fightStep("follow"),
    obs({ snapshot: snapshot([RAT_NEAR, RAT_FAR]), weaponModuleIDs: [500], squadPrimaryTargetID: 6662 }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6662);
  assert.match(tick.why, /fleet called/i);
});

test("follow: a call for a ship that is NOT here changes nothing", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const elsewhere = fight(
    fightStep("follow"),
    obs({ snapshot: snapshot([RAT_NEAR, RAT_FAR]), weaponModuleIDs: [500], squadPrimaryTargetID: 999999 }),
    {},
    {},
  );
  assert.ok(elsewhere.action.kind === "lock" && elsewhere.action.targetID === 6661, "its own ladder, unchanged");

  // No call at all reads the same way — a quiet fleet never stalls a follower.
  const quiet = fight(fightStep("follow"), obs({ snapshot: snapshot([RAT_NEAR, RAT_FAR]), weaponModuleIDs: [500] }), {}, {});
  assert.ok(quiet.action.kind === "lock" && quiet.action.targetID === 6661);
});

test("follow: a NEW call mid-fight switches the primary", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const switched = fight(
    fightStep("follow"),
    obs({ snapshot: snapshot([RAT_NEAR, RAT_FAR]), weaponModuleIDs: [500], lockedTargetIDs: [6661], squadPrimaryTargetID: 6662 }),
    { targetID: 6661, lockIssued: true, waited: 0, dronesOn: 6661 },
    {},
  );
  assert.ok(switched.action.kind === "lock" && switched.action.targetID === 6662);
});

test("call: the fleet is told once per primary, then the fight goes on", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const state = obs({ snapshot: snapshot([RAT_NEAR]), weaponModuleIDs: [500], lockedTargetIDs: [6661] });

  const called = fight(fightStep("call"), state, { targetID: 6661, lockIssued: true, waited: 0, dronesOn: null }, {});
  assert.ok(called.action.kind === "callPrimary" && called.action.targetID === 6661);
  assert.equal(called.nextMem["calledTargetID"], 6661);

  // Next tick, with the call remembered, the guns come up as usual.
  const shooting = fight(fightStep("call"), state, { ...called.nextMem }, {});
  assert.ok(shooting.action.kind === "activate" && shooting.action.targetID === 6661);
});

test("call: the call is stood down when the grid clears", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const cleared = fightUntilClear(fight, fightStep("call"), obs({ snapshot: snapshot([]) }), { calledTargetID: 6661 });
  assert.ok(cleared.action.kind === "callPrimary" && cleared.action.targetID === null);

  // …and once it is down, the block finishes as it always did.
  const done = fightUntilClear(fight, fightStep("call"), obs({ snapshot: snapshot([]) }), { calledTargetID: null });
  assert.equal(done.outcome.kind, "done");
});

test("off: a block that never mentions the fleet never calls anything", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const state = obs({ snapshot: snapshot([RAT_NEAR]), weaponModuleIDs: [500], lockedTargetIDs: [6661], squadPrimaryTargetID: 6662 });
  const tick = fight(fightStep("off"), state, { targetID: 6661, lockIssued: true, waited: 0, dronesOn: null }, {});
  assert.notEqual(tick.action.kind, "callPrimary");
  assert.ok(tick.action.kind === "activate" && tick.action.targetID === 6661, "and a call it is not following is ignored");
});

// ── the "follow" precedence resolver: tag, then broadcast, then board ───────
//
// calledOnGrid tries three sources in order, each falling through to the next
// when its own candidate is not among the rows this pilot can act on. Pinned
// through fight-the-rats' `follow` role.

test("follow: a fleet tag outranks a squad-board call", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const tick = fight(
    fightStep("follow"),
    obs({
      snapshot: snapshot([RAT_NEAR, RAT_FAR]),
      weaponModuleIDs: [500],
      fleetTargetTags: new Map([[6661, "A"]]),
      squadPrimaryTargetID: 6662,
    }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6661, "the tag wins, not the board");
});

test("follow: a fleet tag outranks a conflicting Target broadcast", () => {
  // ⚠ Authority, not freshness: setFleetTargetTag refuses any writer who is
  // not a fleet commander, so a tag that exists is PROVABLY a commander's.
  // sendBroadcast checks only fleet membership, so any member can broadcast
  // Target — receiving one says nothing about who sent it. The tag is the
  // one signal here guaranteed to come from command, so it wins even though
  // the broadcast is the fresher, more deliberate-looking act.
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const tick = fight(
    fightStep("follow"),
    obs({
      snapshot: snapshot([RAT_NEAR, RAT_FAR]),
      weaponModuleIDs: [500],
      fleetTargetTags: new Map([[6661, "A"]]),
      fleetBroadcast: broadcast({ name: "Target", itemID: 6662 }),
    }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6661, "the tag wins, not the broadcast");
});

test("follow: a Target broadcast outranks a squad-board call", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const tick = fight(
    fightStep("follow"),
    obs({
      snapshot: snapshot([RAT_NEAR, RAT_FAR]),
      weaponModuleIDs: [500],
      fleetBroadcast: broadcast({ name: "Target", itemID: 6662 }),
      squadPrimaryTargetID: 6661,
    }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6662, "the broadcast wins, not the board");
});

test("follow: a tag for a ship NOT here falls through to a broadcast that is", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const tick = fight(
    fightStep("follow"),
    obs({
      snapshot: snapshot([RAT_NEAR, RAT_FAR]),
      weaponModuleIDs: [500],
      fleetTargetTags: new Map([[999999, "A"]]), // the tagged ship is two systems away
      fleetBroadcast: broadcast({ name: "Target", itemID: 6662 }),
    }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6662, "no tag on this grid — the broadcast is still followed");
});

test("follow: a broadcast for a ship NOT here falls through to the board", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const tick = fight(
    fightStep("follow"),
    obs({
      snapshot: snapshot([RAT_NEAR, RAT_FAR]),
      weaponModuleIDs: [500],
      fleetBroadcast: broadcast({ name: "Target", itemID: 999999 }), // the broadcast ship is elsewhere
      squadPrimaryTargetID: 6662,
    }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6662, "no broadcast on this grid — the board is still followed");
});

test("follow: a non-Target broadcast is never read as a primary call", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const tick = fight(
    fightStep("follow"),
    obs({
      snapshot: snapshot([RAT_NEAR, RAT_FAR]),
      weaponModuleIDs: [500],
      fleetBroadcast: broadcast({ name: "AlignTo", itemID: 6662 }),
      squadPrimaryTargetID: 6661,
    }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6661, "AlignTo is not a target call — the board is followed instead");
});

test("follow: an unrecognised tag string is still obeyed", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const tick = fight(
    fightStep("follow"),
    obs({
      snapshot: snapshot([RAT_NEAR, RAT_FAR]),
      weaponModuleIDs: [500],
      fleetTargetTags: new Map([[6662, "Bloop"]]), // not in the stock tag menu
      squadPrimaryTargetID: 6661,
    }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6662, "not a stock tag, but still a tag — it wins");
});

test("off: a block not set to follow ignores tags, broadcasts, and the board alike", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const state = obs({
    snapshot: snapshot([RAT_NEAR, RAT_FAR]),
    weaponModuleIDs: [500],
    lockedTargetIDs: [6661],
    fleetTargetTags: new Map([[6662, "A"]]),
    fleetBroadcast: broadcast({ name: "Target", itemID: 6662 }),
    squadPrimaryTargetID: 6662,
  });
  const tick = fight(fightStep("off"), state, { targetID: 6661, lockIssued: true, waited: 0, dronesOn: null }, {});
  assert.notEqual(tick.action.kind, "callPrimary");
  assert.ok(
    tick.action.kind === "activate" && tick.action.targetID === 6661,
    "not following — the fleet's tag, broadcast, and board call are all ignored",
  );
});

// ── §13: effort without progress — giving up on a site ───────────────────────
//
// The loop under test: the bot warps into a den it cannot beat, fights until a
// watch pulls it home, repairs PERFECTLY, comes back to the same den, and does
// it again until somebody notices. `MAX_RECOVER_TRIPS` cannot catch it, because
// `releaseRecoverTrips` drops its whole tally the moment the watched condition
// reads not-met — a repair that WORKS resets the cap, every one of these repairs
// works, and the thing that is broken is not the ship.
//
// The arithmetic is nav/siteProgress.ts and is tested there. These pin the
// WIRING: what the fight block feeds it, what it does with the answer, and how
// the anomaly block counts arrivals and stops touring dens it has given up on.
// The first test is the most important one in the group — a bot that is winning
// must behave exactly as it did before any of this existed.

const GIVE_UP_STEP: MacroStep = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} };

// ─── Arriving, when the macro is never told the ship warped ──────────────────
//
// ⚠ THE REGRESSION THAT COST A LIVE RUN. `decideScriptAction` holds every macro
// while the ship is in warp, so a block is NOT CALLED AT ALL between the tick it
// issues a warp and the tick the ship lands. These blocks used to decide they
// had arrived by watching for `inWarp === true`, which they can therefore never
// see: caught live on 2026-09-14 as a ratting bot that warped into a den, sat
// there with its guns off reporting "the warp never started", took the damage,
// went home on a watch, repaired, and did it again — the fight block after it
// never once ran. The fix is `obs.completedWarps`, which the OBSERVATION counts
// because the observation is read on every tick and a macro is not.
//
// The drive loop below is the guard's behaviour, and it is the whole point of
// the test: while `inWarp` is true the macro is SKIPPED, exactly as the runner
// skips it.

test("⚠ warp-to-anomaly: it arrives even though it is never called during the warp", () => {
  const anomMacro = SCRIPT_MACROS["warp-to-anomaly"]!;
  let mem: MacroMemory = {};
  let warps = 0;
  const fly = (inWarp: boolean): MacroTick | null => {
    if (inWarp) {
      return null; // the runner's in-warp guard: the macro is not called
    }
    const r = anomMacro(ANOM_STEP, obs({ anomalies: [den("QEE-288")], inWarp: false, completedWarps: warps }), mem, {});
    mem = r.nextMem;
    return r;
  };

  assert.equal(fly(false)?.action.kind, "wait", "the first tick only commits which site it picked");
  const issued = fly(false);
  assert.equal(issued?.action.kind, "warpScan", "it issues the warp");

  // The flight: the macro is skipped for every tick of it, and the warp ends.
  for (let i = 0; i < 12; i += 1) {
    assert.equal(fly(true), null);
  }
  warps += 1;

  const landed = fly(false);
  assert.deepEqual(landed?.outcome, { kind: "done" }, "the tick after the warp ends is an arrival");
  assert.equal(landed?.phase, "Arrived");
});

test("⚠ warp-to-anomaly: a warp that truly never starts is still reported, not waited on for ever", () => {
  const anomMacro = SCRIPT_MACROS["warp-to-anomaly"]!;
  let mem: MacroMemory = {};
  const still = () => {
    const r = anomMacro(ANOM_STEP, obs({ anomalies: [den("QEE-288")], inWarp: false, completedWarps: 7 }), mem, {});
    mem = r.nextMem;
    return r;
  };
  assert.equal(still().action.kind, "wait", "commits the pick");
  assert.equal(still().action.kind, "warpScan");
  let last = still();
  for (let i = 0; i < 20 && last.outcome.kind === "acting"; i += 1) {
    last = still();
  }
  assert.equal(last.outcome.kind, "blocked", "the count never moved, so the warp never started");
});

test("an unreadable warp count is never an arrival — the block waits its budget out", () => {
  const anomMacro = SCRIPT_MACROS["warp-to-anomaly"]!;
  let mem: MacroMemory = {};
  const blind = () => {
    const r = anomMacro(ANOM_STEP, obs({ anomalies: [den("QEE-288")], inWarp: false, completedWarps: null }), mem, {});
    mem = r.nextMem;
    return r;
  };
  assert.equal(blind().action.kind, "wait", "commits the pick");
  assert.equal(blind().action.kind, "warpScan");
  const next = blind();
  assert.equal(next.outcome.kind, "acting", "a null count decides nothing");
  assert.notEqual(next.phase, "Arrived");
});

// ─── A refused warp to a site is not a slow one ──────────────────────────────
//
// Four pilots parked INSIDE the den they had been stranded in each started a
// run, and each stopped at this block: "warp to the den" came back
// WARP_DISTANCE_TOO_CLOSE — already there — and the block, which never looked at
// what came back, waited out its budget and reported that the warp never
// started. They sat docked while rats floated in front of them.

/** The ledger row the runner leaves after the server turns a site warp down. */
const warpRefused = (words: string) => [{
  key: "w:warpScan:-",
  count: 1,
  firstAt: 0,
  lastAt: 0,
  words,
  kind: "refused" as const,
}];

const CANNOT_WARP = "You cannot warp there right now.";

/**
 * Drive a warp block to the tick that issues the warp, the way the runner does.
 *
 * ⚠ UNDER THE REAL RUNNER A REFUSED ISSUE COMMITS NOTHING (2fd4a77: a world-call
 * action's memory and board patch are kept only if it succeeds). So a refusal
 * test must feed the memory of the phase-1 tick, which is a WAIT and is
 * committed, and never `issued.nextMem`, which the runner throws away on a
 * refusal. Feeding `issued.nextMem` is the test that passed while the block
 * was unreachable live.
 */
function pickThenIssue(
  macro: (typeof SCRIPT_MACROS)["warp-to-anomaly"],
  step: MacroStep,
  observation: ScriptObservation,
  board: ScriptBoard = {},
): { readonly committed: MacroTick; readonly issued: MacroTick } {
  const committed = macro!(step, observation, {}, board);
  assert.equal(committed.action.kind, "wait", "phase 1 commits the pick and presses nothing");
  assert.equal(committed.boardPatch, undefined, "and writes no board patch");
  return { committed, issued: macro!(step, observation, committed.nextMem, board) };
}

test("warp-to-anomaly: refused with rats already on the grid is an ARRIVAL, not a stop", () => {
  const anomMacro = SCRIPT_MACROS["warp-to-anomaly"]!;
  const { committed, issued } = pickThenIssue(anomMacro, ANOM_STEP, obs({ anomalies: [den("QEE-288")], completedWarps: 3 }));
  assert.equal(issued.action.kind, "warpScan", "it still issues the warp");

  // The refused issue committed nothing, so the next tick sees phase 1's memory.
  const out = anomMacro(
    ANOM_STEP,
    obs({
      anomalies: [den("QEE-288")],
      completedWarps: 3,          // no warp ever happened
      refusals: warpRefused(CANNOT_WARP),
      hostileOnGrid: true,        // ...because the den is already underfoot
    }),
    committed.nextMem,
    {},
  );

  assert.deepEqual(out.outcome, { kind: "done" }, "standing in the den is arriving at it");
  assert.equal(out.phase, "Arrived");
  // The refused issue's patch was lost with it, so the done tick has to carry it.
  assert.equal(out.boardPatch?.["anomsVisited"], "QEE-288", "the site is on the board for the block after this one");
});

test("warp-to-anomaly: refused with nothing on the grid stops, carrying the SERVER's words", () => {
  const anomMacro = SCRIPT_MACROS["warp-to-anomaly"]!;
  const { committed } = pickThenIssue(anomMacro, ANOM_STEP, obs({ anomalies: [den("QEE-288")], completedWarps: 3 }));

  const out = anomMacro(
    ANOM_STEP,
    obs({
      anomalies: [den("QEE-288")],
      completedWarps: 3,
      refusals: warpRefused(CANNOT_WARP),
      hostileOnGrid: false,
    }),
    committed.nextMem,
    {},
  );

  assert.equal(out.outcome.kind, "blocked");
  const reason = out.outcome.kind === "blocked" ? out.outcome.reason : "";
  assert.match(reason, /cannot warp there right now/i, "what the server said must survive");
  assert.doesNotMatch(reason, /never started/i, "it was refused, not ignored — do not send the reader at the ship");
});

test("warp-to-anomaly: a refusal is read on the NEXT tick, not after the whole wait budget", () => {
  // The point of reading the ledger at all: the answer was already on the wire.
  const anomMacro = SCRIPT_MACROS["warp-to-anomaly"]!;
  const { committed } = pickThenIssue(anomMacro, ANOM_STEP, obs({ anomalies: [den("QEE-288")], completedWarps: 3 }));
  const out = anomMacro(
    ANOM_STEP,
    obs({ anomalies: [den("QEE-288")], completedWarps: 3, refusals: warpRefused(CANNOT_WARP), hostileOnGrid: null }),
    committed.nextMem,
    {},
  );
  assert.notEqual(out.outcome.kind, "acting", "one tick, not WARP_START_WAIT_TICKS of them");
});

test("warp-to-anomaly: a ledger record left from an earlier visit is NOT a refusal of a warp never issued", () => {
  // The record lives until a SUCCESS clears it, so one can be sitting there when
  // the step is entered. Phase 1 commits the count it found as the baseline.
  const anomMacro = SCRIPT_MACROS["warp-to-anomaly"]!;
  const stale = obs({ anomalies: [den("QEE-288")], completedWarps: 3, refusals: warpRefused(CANNOT_WARP), hostileOnGrid: false });
  const committed = anomMacro(ANOM_STEP, stale, {}, {});
  assert.equal(committed.action.kind, "wait");
  assert.equal(committed.nextMem["target"], "QEE-288");
  assert.equal(committed.nextMem["refusalsSeen"], 1, "the baseline is the stale count");
  const issued = anomMacro(ANOM_STEP, stale, committed.nextMem, {});
  assert.deepEqual(issued.action, { kind: "warpScan", target: "QEE-288" }, "it presses; it does not stop on the old record");
  // ...and a refusal NEWER than the baseline is read.
  const fresh = obs({
    anomalies: [den("QEE-288")], completedWarps: 3, hostileOnGrid: false,
    refusals: [{ ...warpRefused(CANNOT_WARP)[0]!, count: 2 }],
  });
  assert.equal(anomMacro(ANOM_STEP, fresh, committed.nextMem, {}).outcome.kind, "blocked");
});

test("warp-to-anomaly: a committed target that has left the scanner is dropped and re-picked", () => {
  const anomMacro = SCRIPT_MACROS["warp-to-anomaly"]!;
  const both = obs({ anomalies: [den("QEE-288"), den("ABC-123")], completedWarps: 3 });
  const { committed } = pickThenIssue(anomMacro, ANOM_STEP, both);
  assert.equal(committed.nextMem["target"], "QEE-288");
  const gone = obs({ anomalies: [den("ABC-123")], completedWarps: 3 });
  const dropped = anomMacro(ANOM_STEP, gone, committed.nextMem, {});
  assert.equal(dropped.action.kind, "wait", "it does not warp at a site that is no longer listed");
  assert.equal(dropped.nextMem["target"], undefined);
  const repick = anomMacro(ANOM_STEP, gone, dropped.nextMem, {});
  assert.equal(repick.nextMem["target"], "ABC-123");
});

test("warp-to-ore-anomaly: rock (or rats) on the grid is still not evidence of an ore site", () => {
  // ⚠ THE SHORTCUT THAT MUST STAY SHUT. Rock on the grid is NOT evidence of an
  // ore site — a plain belt looks the same from here — and neither is anything
  // else the overview lists. The block now CAN answer this question, but only
  // from the two positions (see the two tests below); with no position on the
  // scanner row it is back to "cannot tell", whatever is floating outside.
  const oreMacro = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const { committed } = pickThenIssue(oreMacro, ORE_ANOM_STEP, obs({ anomalies: [rocks("ABC-123")], completedWarps: 3 }));

  const out = oreMacro(
    ORE_ANOM_STEP,
    obs({
      anomalies: [rocks("ABC-123")],
      completedWarps: 3,
      refusals: warpRefused(CANNOT_WARP),
      hostileOnGrid: true,   // even this must not be read as "in the ore site"
    }),
    committed.nextMem,
    {},
  );

  assert.notEqual(out.outcome.kind, "done", "no shortcut without a reading to justify it");
  assert.notEqual(out.phase, "Arrived");
});

/**
 * Hand `fight-the-rats` the same empty-grid answer until it believes it.
 *
 * ⚠ AN EMPTY GRID IS NOT BELIEVED ON THE FIRST READ. The tick just after a warp
 * lands reads a grid that has not populated yet, and believing that one is what
 * sent a live bot through three dens in ninety seconds calling each of them
 * clear while the rats in them shot its shields off. Tests that want the FINISH
 * have to pay the same confirmation a real arrival does.
 */
function fightUntilClear(
  fight: (typeof SCRIPT_MACROS)["fight-the-rats"],
  step: MacroStep,
  observation: ScriptObservation,
  startMem: MacroMemory = {},
  board: ScriptBoard = {},
): MacroTick {
  let mem = startMem;
  let last = fight!(step, observation, mem, board);
  for (let read = 1; read < 3; read += 1) {
    mem = last.nextMem;
    last = fight!(step, observation, mem, board);
  }
  return last;
}

const ANOM_STEP = { id: "w", kind: "macro", macro: "warp-to-anomaly", args: {} } as MacroStep;
const ORE_ANOM_STEP = { id: "w", kind: "macro", macro: "warp-to-ore-anomaly", args: {} } as MacroStep;

// ─── Standing in the ore site the warp was refused for ──────────────────
//
// Five pilots were parked in the ore site an earlier run had left them in. The
// tour picked that same site first — it is the first one the scanner lists and
// nothing had visited it yet this run — the server refused the warp for standing
// in it, and every one of them stopped on "The ship would not warp to the ore
// site" with the rock right there in front of the ship.

/** The scanner row for an ore site at a point in the system, in metres. */
const rocksAt = (label: string, x: number) => ({ label, kind: "ore" as const, position: { x, y: 0, z: 0 } });

test("the belt short-warp rule does not turn a nearby scanner ore site into an arrival", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", radius: 1_000,
    position: { x: 100_000, y: 0, z: 0 } });
  assert.equal(travelToBelt(travelToBeltStep, obs({ snapshot: snapshot([belt]) }), NM, {}).action.kind, "approach");
  const oreMacro = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const nearbySite = rocksAt("ABC-123", 100_000);
  const { committed, issued } = pickThenIssue(oreMacro, ORE_ANOM_STEP, obs({ anomalies: [nearbySite], completedWarps: 3 }));
  assert.equal(issued.action.kind, "warpScan", "site point distance alone never implies arrival");
  const refused = oreMacro(ORE_ANOM_STEP, obs({ anomalies: [nearbySite], completedWarps: 3,
    refusals: warpRefused(CANNOT_WARP), snapshot: snapshot([]), hostileOnGrid: false }), committed.nextMem, {});
  assert.equal(refused.outcome.kind, "done", "only the targeted scanner refusal proves already-at-site");
});
test("generic travel treats an Upwell as arrived only at its authoritative structureID", () => {
  const id = 1_000_000_000_001;
  const step: MacroStep = { id: "u", kind: "macro", macro: "travel-to-station", args: {
    station: { kind: "station", ref: { entity: "structure", id, name: "QA Astrahus", systemName: "Nonni" } },
  } };
  const travel = SCRIPT_MACROS["travel-to-station"]!;
  assert.equal(travel(step, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }) }), NM, {}).action.kind, "startRoute");
  assert.equal(travel(step, obs({ flightStatus: flight({ docked: true, inSpace: false, structureID: id }) }), NM, {}).outcome.kind, "done");
  assert.equal(travel(step, obs({ flightStatus: flight({ docked: true, inSpace: false, structureID: id + 1 }) }), NM, {}).action.kind, "startRoute");
});

test("warp-to-ore-anomaly: a refusal with the ship INSIDE the site it aimed at is an arrival", () => {
  const oreMacro = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  // 100 km out — under the server's own 150 km warp floor, which is the exact
  // condition it refused on (MIN_WARP_DISTANCE_METERS in space/runtime.js).
  const site = rocksAt("ABC-123", 100_000);
  const { committed, issued } = pickThenIssue(oreMacro, ORE_ANOM_STEP, obs({ anomalies: [site], completedWarps: 3 }));
  assert.equal(issued.action.kind, "warpScan", "it still issues the warp");

  // The refused issue committed nothing: the next tick sees phase 1's memory.
  const out = oreMacro(
    ORE_ANOM_STEP,
    obs({
      anomalies: [site],
      completedWarps: 3,               // no warp ever happened
      refusals: warpRefused(CANNOT_WARP),
      snapshot: snapshot([]),          // ship at the origin
      hostileOnGrid: false,            // and NOT because of anything on the grid
    }),
    committed.nextMem,
    {},
  );

  assert.deepEqual(out.outcome, { kind: "done" }, "standing in the ore site is arriving at it");
  assert.equal(out.phase, "Arrived");
  // `currentOreSiteLabel` is what mine-at-a-belt reads; the refused issue's patch
  // was lost, so the done tick carries it.
  assert.equal(out.boardPatch?.["oreAnomsVisited"], "ABC-123", "the site is named on the board for the miner");
});

test("warp-to-ore-anomaly: a refusal with the site a real warp away is mined out only once the scanner drops it, in the server's words", () => {
  const oreMacro = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  // 4 AU out: whatever the server refused for, it was not that the ship is there.
  const site = rocksAt("ABC-123", 4 * 149_597_870_700);
  const { committed } = pickThenIssue(oreMacro, ORE_ANOM_STEP, obs({ anomalies: [site], completedWarps: 3 }));

  const out = oreMacro(
    ORE_ANOM_STEP,
    obs({
      anomalies: [site],
      completedWarps: 3,
      refusals: warpRefused(CANNOT_WARP),
      snapshot: snapshot([]),
    }),
    committed.nextMem,
    {},
  );
  assert.equal(out.outcome.kind, "acting", "one refusal is not proof the site is gone");
  assert.equal(out.action.kind, "wait");

  const gone = oreMacro(ORE_ANOM_STEP, obs({ anomalies: [], completedWarps: 3, refusals: warpRefused(CANNOT_WARP), snapshot: snapshot([]) }), out.nextMem, {});
  // An EMPTY scanner is its own dead end (read three times); a scanner that
  // still lists other things but not this site is the torn-down case.
  const other = { label: "DEN-1", kind: "combat" as const };
  const dropped = oreMacro(ORE_ANOM_STEP, obs({ anomalies: [other], completedWarps: 3, refusals: warpRefused(CANNOT_WARP), snapshot: snapshot([]) }), out.nextMem, {});
  assert.equal(gone.outcome.kind, "acting");
  assert.equal(dropped.outcome.kind, "blocked");
  const reason = dropped.outcome.kind === "blocked" ? dropped.outcome.reason : "";
  assert.match(reason, /Every ore site in this system is mined out/);
  assert.match(reason, /cannot warp there right now/i, "what the server said must survive");
});

// ─── A site the server refuses while the scanner still lists it ────────────
//
// A server restart caught a pilot mid-warp and restored her off the ice
// field's grid with the server still filing her ship under that field's pocket.
// Every warp at the field came back "You cannot warp there right now" while
// four pilots mined in it, and the block flew her home calling the system
// mined out. A dock clears the pocket: she warped straight in after one.

const FAR = 4 * 149_597_870_700;
const REJOIN_HOME = 60000004;

/** Drive the block from a fresh pick to the end of the scanner re-check. */
function refusedAndStillListed(
  oreMacro: NonNullable<(typeof SCRIPT_MACROS)["warp-to-ore-anomaly"]>,
  site: ReturnType<typeof rocksAt>,
  count: number,
  over: Partial<ScriptObservation>,
  startMem: MacroMemory = {},
): MacroTick {
  let mem = oreMacro(ORE_ANOM_STEP, obs({ anomalies: [site], completedWarps: 3, refusals: count > 1 ? [{ ...warpRefused(CANNOT_WARP)[0]!, count: count - 1 }] : undefined, ...over }), startMem, {}).nextMem;
  const refused = obs({ anomalies: [site], completedWarps: 3, refusals: [{ ...warpRefused(CANNOT_WARP)[0]!, count }], snapshot: snapshot([]), ...over });
  let t = oreMacro(ORE_ANOM_STEP, refused, mem, {});
  for (let read = 0; read < 20 && t.outcome.kind === "acting" && t.nextMem["doubted"] !== undefined && t.nextMem["rejoin"] === undefined; read += 1) {
    mem = t.nextMem;
    t = oreMacro(ORE_ANOM_STEP, refused, mem, {});
  }
  return t;
}

test("warp-to-ore-anomaly: a refused site the scanner keeps listing sends the ship to dock and back, not home to stop", () => {
  const oreMacro = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const site = rocksAt("ETY-001", FAR);
  const start = refusedAndStillListed(oreMacro, site, 1, { homeStationID: REJOIN_HOME });
  assert.equal(start.outcome.kind, "acting", "a site still listed is not mined out");
  assert.equal(start.nextMem["rejoin"], "home");

  // In space: the autopilot takes it home.
  const fly = oreMacro(ORE_ANOM_STEP, obs({ anomalies: [site], homeStationID: REJOIN_HOME }), start.nextMem, {});
  assert.deepEqual(fly.action, { kind: "startRoute", stationID: REJOIN_HOME });
  assert.equal(fly.nextMem["rejoin"], "home", "the trip is remembered across the ride");

  // Docked: undock, and keep pressing it until the ship is out.
  const docked = obs({ anomalies: null, homeStationID: REJOIN_HOME, flightStatus: flight({ docked: true, inSpace: false, stationID: REJOIN_HOME }) });
  const undock = oreMacro(ORE_ANOM_STEP, docked, fly.nextMem, {});
  assert.deepEqual(undock.action, { kind: "undock" });
  assert.equal(oreMacro(ORE_ANOM_STEP, docked, undock.nextMem, {}).action.kind, "undock", "never 'Undock first' on its own trip");

  // Out: pick the site again and warp at it.
  const out = obs({ anomalies: [site], completedWarps: 3, homeStationID: REJOIN_HOME });
  const repick = oreMacro(ORE_ANOM_STEP, out, undock.nextMem, {});
  assert.equal(repick.nextMem["target"], "ETY-001");
  const issued = oreMacro(ORE_ANOM_STEP, out, repick.nextMem, {});
  assert.deepEqual(issued.action, { kind: "warpScan", target: "ETY-001" });
});

test("warp-to-ore-anomaly: refused again after the dock trip, it stops and says the site is still listed", () => {
  const oreMacro = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const site = rocksAt("ETY-001", FAR);
  const out = refusedAndStillListed(oreMacro, site, 2, { homeStationID: REJOIN_HOME }, { rejoined: true });
  assert.equal(out.outcome.kind, "blocked", "one trip, not a commute");
  const reason = out.outcome.kind === "blocked" ? out.outcome.reason : "";
  assert.doesNotMatch(reason, /mined out/);
  assert.match(reason, /ETY-001 after docking and undocking/);
  assert.match(reason, /cannot warp there right now/i);
});

test("warp-to-ore-anomaly: with no home to dock at, a still-listed refused site stops honestly", () => {
  const oreMacro = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const site = rocksAt("ETY-001", FAR);
  const out = refusedAndStillListed(oreMacro, site, 1, {});
  assert.equal(out.outcome.kind, "blocked");
  const reason = out.outcome.kind === "blocked" ? out.outcome.reason : "";
  assert.doesNotMatch(reason, /mined out/);
  assert.match(reason, /still lists it/);
});

test("warp-to-ore-anomaly: the position read is of the TARGETED site, not of whichever one is nearest", () => {
  // ⚠ A system holds several ore sites. Sitting in one of them says nothing
  // about the warp to ANOTHER, and answering "already here" from the nearest row
  // would call every refusal in a busy system an arrival.
  const oreMacro = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const here = rocksAt("ABC-123", 0);                       // the ship is in this one
  const far = rocksAt("XYZ-789", 4 * 149_597_870_700);
  // Already visited the one underfoot, so the tour aims at the far one.
  const board = { oreAnomsVisited: "ABC-123" };
  const { committed, issued } = pickThenIssue(oreMacro, ORE_ANOM_STEP, obs({ anomalies: [here, far], completedWarps: 3 }), board);
  assert.deepEqual(issued.action, { kind: "warpScan", target: "XYZ-789" }, "it aims at the unvisited site");

  // The refused issue committed nothing: the next tick sees phase 1's memory.
  const out = oreMacro(
    ORE_ANOM_STEP,
    obs({
      anomalies: [here, far],
      completedWarps: 3,
      refusals: warpRefused(CANNOT_WARP),
      snapshot: snapshot([]),
    }),
    committed.nextMem,
    board,
  );

  assert.notEqual(out.phase, "Arrived", "the site underfoot is not the site it was refused for");
  const refusedObs = obs({ anomalies: [here, far], completedWarps: 3, refusals: warpRefused(CANNOT_WARP), snapshot: snapshot([]) });
  const repick = oreMacro(ORE_ANOM_STEP, refusedObs, out.nextMem, board);
  const retry = oreMacro(ORE_ANOM_STEP, refusedObs, repick.nextMem, board);
  assert.deepEqual(retry.action, { kind: "warpScan", target: "ABC-123" }, "it tries the other site instead");
});

// ─── A site mined out while the ship was away ────────────────────────────────
//
// A pilot came back from unloading and read the scanner just as the fleet
// finished emptying an ore site. The site was still listed, the server had
// already torn it down and refused the warp ("not scanned down"), and the pilot
// stopped while the other eight flew on to the next site.

const NOT_SCANNED = "You have not scanned that site down, so you cannot warp to it yet.";

test("warp-to-ore-anomaly: a refused site is set aside and the next one is tried", () => {
  const oreMacro = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const dying = rocksAt("GUN-001", 4 * 149_597_870_700);
  const fresh = rocksAt("GUV-002", 6 * 149_597_870_700);
  const { committed, issued } = pickThenIssue(oreMacro, ORE_ANOM_STEP, obs({ anomalies: [dying, fresh], completedWarps: 3 }));
  assert.deepEqual(issued.action, { kind: "warpScan", target: "GUN-001" });

  const refusedObs = obs({
    anomalies: [dying, fresh],
    completedWarps: 3,
    refusals: warpRefused(NOT_SCANNED),
    snapshot: snapshot([]),
  });
  // The refused issue committed nothing (and neither did its board patch), so the
  // next tick sees phase 1's memory and the unpatched board.
  const out = oreMacro(ORE_ANOM_STEP, refusedObs, committed.nextMem, {});
  assert.equal(out.outcome.kind, "acting", "a refused site is not a reason to stop the bot");

  const repick = oreMacro(ORE_ANOM_STEP, refusedObs, out.nextMem, {});
  const retry = oreMacro(ORE_ANOM_STEP, refusedObs, repick.nextMem, {});
  assert.deepEqual(retry.action, { kind: "warpScan", target: "GUV-002" });

  // The old refusal is still in the ledger — no success has cleared it yet — and
  // it must not be read as a refusal of the NEW warp.
  const waiting = oreMacro(ORE_ANOM_STEP, refusedObs, retry.nextMem, {});
  assert.equal(waiting.outcome.kind, "acting", "the stale refusal is not about this warp");
  assert.equal(waiting.phase, "Flying to the ore site");
});

test("warp-to-ore-anomaly: when every ore site has refused, it stops as mined out", () => {
  const oreMacro = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const a = rocksAt("GUN-001", 4 * 149_597_870_700);
  const b = rocksAt("GUV-002", 6 * 149_597_870_700);
  // Each refused issue commits nothing: every refusal is read from the memory of
  // the phase-1 tick that committed the target, never from an issuing tick.
  const { committed: first } = pickThenIssue(oreMacro, ORE_ANOM_STEP, obs({ anomalies: [a, b], completedWarps: 3 }));
  const once = obs({ anomalies: [a, b], completedWarps: 3, refusals: warpRefused(NOT_SCANNED), snapshot: snapshot([]) });
  const skip = oreMacro(ORE_ANOM_STEP, once, first.nextMem, {});
  const picked = oreMacro(ORE_ANOM_STEP, once, skip.nextMem, {});
  const second = oreMacro(ORE_ANOM_STEP, once, picked.nextMem, {});
  assert.deepEqual(second.action, { kind: "warpScan", target: "GUV-002" });

  const twice = obs({
    anomalies: [a, b],
    completedWarps: 3,
    refusals: [{ ...warpRefused(NOT_SCANNED)[0]!, count: 2 }],
    snapshot: snapshot([]),
  });
  const out = oreMacro(ORE_ANOM_STEP, twice, picked.nextMem, {});
  assert.equal(out.outcome.kind, "acting", "the last refusal is checked against the scanner first");
  // The server tore both down: they leave the scanner, and that is the verdict.
  const torn = obs({ anomalies: [{ label: "DEN-1", kind: "combat" as const }], completedWarps: 3, refusals: twice.refusals, snapshot: snapshot([]) });
  const gone = oreMacro(ORE_ANOM_STEP, torn, out.nextMem, {});
  assert.equal(gone.outcome.kind, "blocked");
  const reason = gone.outcome.kind === "blocked" ? gone.outcome.reason : "";
  assert.match(reason, /Every ore site in this system is mined out/);
});

const den = (label: string) => ({ label, kind: "combat" as const });
const rocks = (label: string) => ({ label, kind: "ore" as const });

/** The board a run would be carrying after `visits` arrivals at one label. */
function ledgerBoard(label: string, visits: number): ScriptBoard {
  let ledger = emptyLedger();
  for (let i = 0; i < visits; i += 1) {
    ledger = enterSite(ledger, label);
  }
  return encodeLedger(ledger);
}

/** One rat at `distanceM` with `health` in each layer, and one combat drone out.
 *  The gun is already running, so the ladder settles on its "holding it" rung. */
function ratGrid(over: { health?: number; distanceM?: number } = {}): SpaceSnapshot {
  const rat = entity({
    itemID: 6661,
    kind: "ship",
    isNpc: true,
    npcEntityType: "npc",
    position: { x: over.distanceM ?? 5000, y: 0, z: 0 },
    shieldRatio: over.health ?? 1,
    armorRatio: 1,
    hullRatio: 1,
  });
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  return snapshot([rat, drone], { activeModuleIDs: [500] });
}

/** Drive fight-the-rats for `ticks` ticks, threading BOTH its step memory and
 *  the run board the way the runner does — the ledger only works if the board
 *  it publishes comes back to it on the next tick. */
function runFight(
  world: (i: number) => ScriptObservation,
  ticks: number,
  board: ScriptBoard = {},
): { readonly out: readonly MacroTick[]; readonly board: ScriptBoard } {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const out: MacroTick[] = [];
  let mem: MacroMemory = {};
  let carried: ScriptBoard = board;
  for (let i = 0; i < ticks; i += 1) {
    const t = fight(GIVE_UP_STEP, world(i), mem, carried);
    out.push(t);
    mem = t.nextMem;
    carried = { ...carried, ...(t.boardPatch ?? {}) };
  }
  return { out, board: carried };
}

/** Everything about a tick EXCEPT the ledger's own board write. */
const fightShape = (t: MacroTick) => ({
  action: t.action,
  why: t.why,
  phase: t.phase,
  armed: t.armed,
  outcome: t.outcome,
  nextMem: t.nextMem,
});

const dronesOnIt = (over: Partial<ScriptObservation> = {}): ScriptObservation =>
  obs({
    snapshot: ratGrid(),
    dronesOut: true,
    combatDroneIDs: [111],
    lockedTargetIDs: [6661],
    weaponModuleIDs: [500],
    droneControlRangeM: 45_000,
    ...over,
  });

test("fight: a bot that is WINNING is untouched — the ledger only ever speaks when nothing is dying", () => {
  // The rat's health bar moves down a hundredth of a layer per tick: slow, but
  // moving, which is the whole test the ledger applies ("not going down AT ALL",
  // never "not dead yet"). A block that abandoned this would abandon every
  // battlecruiser rat in the game.
  const winning = (i: number) => dronesOnIt({ snapshot: ratGrid({ health: Math.max(0.05, 1 - i * 0.01) }) });
  const ticksRun = STALL_TICKS * 3;

  // Run it with NO site on the board (a belt spawn) and with a den's label on
  // it: the two have to be the same sequence, action for action and word for
  // word. Nothing about a fight that is going well may depend on the ledger.
  const bare = runFight(winning, ticksRun);
  const atADen = runFight(winning, ticksRun, ledgerBoard("QEE-288", 1));
  assert.deepEqual(bare.out.map(fightShape), atADen.out.map(fightShape));

  // …and it is the fight it always was: lock it, set the drones on it, hold it.
  assert.equal(bare.out[0]!.action.kind, "lock");
  assert.equal(bare.out[1]!.action.kind, "engageDrones");
  for (const t of bare.out.slice(2)) {
    assert.equal(t.action.kind, "wait");
    assert.equal(t.outcome.kind, "acting");
    assert.match(t.why, /Fighting it/, "no verdict, no leaving, no new words");
  }
  assert.equal(atADen.board[LEDGER_KEYS.stall], 0, "health going down at all keeps the counter pinned at zero");
});

test("fight: nothing dying with the drones ON it -> leave the den, drones first, reason in the readout", () => {
  const run = runFight(() => dronesOnIt(), STALL_TICKS + 5, ledgerBoard("QEE-288", 1));
  const leaving = run.out.findIndex((t) => t.action.kind === "recallDrones");

  // ⚠ THE BUDGET IS APPLYING TICKS, NOT ELAPSED ONES. The first tick locks and
  // the second orders the drones; neither has applied any damage, so the counter
  // starts on the third and the verdict lands exactly STALL_TICKS later.
  assert.equal(leaving, STALL_TICKS + 1, "not one tick sooner than the drones earned");
  assert.match(run.out[leaving]!.why, /Nothing here was dying/, "WHICH evidence fired, in the player's words");
  assert.match(run.out[leaving]!.why, /QEE-288/, "against the label the anomaly block published, not 'this den'");
  // ⚠ It must not pause the run: one bad den is not a broken bot, and the block
  // that decides the whole SYSTEM is finished is warp-to-anomaly.
  assert.notEqual(run.out[leaving]!.outcome.kind, "blocked");

  // With the drones home it finishes the way a cleared grid finishes — even
  // though the rat is still very much alive on the grid.
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const rat = entity({
    itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc",
    position: { x: 5000, y: 0, z: 0 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1,
  });
  const home = fight(
    GIVE_UP_STEP,
    obs({ snapshot: snapshot([rat]), weaponModuleIDs: [500], lockedTargetIDs: [6661], droneControlRangeM: 45_000 }),
    run.out[leaving]!.nextMem,
    run.board,
  );
  assert.equal(home.outcome.kind, "done");
  assert.equal(home.action.kind, "wait", "nothing left in space to call in");
});

test("⚠ fight: the stall counter runs ONLY while the drones are on the primary, locked and inside their leash", () => {
  const ticksRun = STALL_TICKS * 3;
  const site = () => ledgerBoard("QEE-288", 1);
  const gave = (run: { readonly out: readonly MacroTick[] }) =>
    run.out.some((t) => t.action.kind === "recallDrones" || t.outcome.kind === "done");

  // (a) A GUN BOAT. Guns are never counted: this block cannot see a turret's
  //     optimal, its falloff, its tracking, or an empty charge bay, so the only
  //     honest thing it could say about one is "I pressed the button".
  const bareRat = entity({
    itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc",
    position: { x: 5000, y: 0, z: 0 }, shieldRatio: 1, armorRatio: 1, hullRatio: 1,
  });
  const guns = runFight(
    () => obs({ snapshot: snapshot([bareRat], { activeModuleIDs: [500] }), lockedTargetIDs: [6661], weaponModuleIDs: [500] }),
    ticksRun,
    site(),
  );
  assert.equal(guns.board[LEDGER_KEYS.stall], 0);
  assert.ok(!gave(guns), "a gun boat never blames the den for what the block cannot measure");

  // (b) THE RAT IS OUTSIDE THE DRONE LEASH. fight-the-rats has no range control
  //     at all, so this is our own position and never the site's difficulty —
  //     and a pilot told "this den is too hard" never goes looking for the
  //     drones that were sitting 60 km out doing nothing.
  const far = runFight(() => dronesOnIt({ snapshot: ratGrid({ distanceM: 60_000 }) }), ticksRun, site());
  assert.equal(far.board[LEDGER_KEYS.stall], 0);
  assert.ok(!gave(far));

  // (c) NOTHING IS LOCKED. Waiting on a lock is our end of the problem too.
  const unlocked = runFight(() => dronesOnIt({ lockedTargetIDs: [] }), ticksRun, site());
  assert.equal(unlocked.board[LEDGER_KEYS.stall], 0);
  assert.ok(!gave(unlocked));

  // (d) THE DRONES ARE IN THE BAY. Nothing is being applied by a flight that
  //     has not launched, however long the ship sits there.
  const inTheBay = runFight(
    () => obs({ snapshot: snapshot([bareRat], { activeModuleIDs: [500] }), combatDroneBayItemIDs: [111], droneBayItemIDs: [111], lockedTargetIDs: [6661], weaponModuleIDs: [500] }),
    ticksRun,
    site(),
  );
  assert.equal(inTheBay.board[LEDGER_KEYS.stall], 0);
});

test("⚠ fight: an unreadable drone leash is read as the 20 km no-skills base, never as infinity", () => {
  // Control range is skill-derived and rides a fitting read a bot run does not
  // force, so null is the COMMON case. Guessing LOW only ever refuses to count
  // ticks; guessing high would count every long-range tick as damage going in.
  const at30km = (control: number | null) => () =>
    dronesOnIt({ snapshot: ratGrid({ distanceM: 30_000 }), droneControlRangeM: control });
  const guessed = runFight(at30km(null), STALL_TICKS * 2, ledgerBoard("QEE-288", 1));
  assert.equal(guessed.board[LEDGER_KEYS.stall], 0, "30 km is outside the guessed 20 km leash — no evidence either way");
  const known = runFight(at30km(45_000), STALL_TICKS * 2, ledgerBoard("QEE-288", 1));
  assert.equal(known.board[LEDGER_KEYS.stall], STALL_TICKS, "a leash that READS 45 km puts the rat well inside it");
});

test("fight: a den that has sent the ship home its allowance of times is left on arrival", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const board = ledgerBoard("QEE-288", MAX_SITE_RETURNS + 1);
  const arrival = fight(GIVE_UP_STEP, dronesOnIt({ lockedTargetIDs: [] }), {}, board);
  assert.equal(arrival.action.kind, "recallDrones", "drones first — the block never comes to rest leaving them in space");
  assert.match(arrival.why, /third time/i, "the OTHER evidence, and a different sentence for it");
  assert.match(arrival.why, /QEE-288/);
  assert.notEqual(arrival.outcome.kind, "blocked");
  // ⚠ THE VERDICT LIVES ON THE BOARD AND NOWHERE ELSE. Step memory is wiped
  // every time the step is left, so a budget kept there would hand a failing den
  // a fresh allowance on every lap — this codebase has paid for that lesson once
  // already (227 refusals in repeating bursts of five).
  assert.ok(Object.keys(arrival.nextMem).every((key) => !key.startsWith("siteProgress")));
});

test("fight: a den the bot keeps CLEARING is never given up on, however many times it is flown to", () => {
  // ⚠ THE TALLY COUNTS CONSECUTIVE BAD VISITS, NOT ARRIVALS. §13's words are
  // "the same site keeps SENDING US HOME", and the two readings differ in
  // exactly the case a working bot lives in: a visit that ended with the den
  // CLEARED. Counting arrivals would retire the only den in a system from a bot
  // that was farming it happily — a bot that stops working, which is the mirror
  // image of the bug this whole feature exists to fix.
  const anom = SCRIPT_MACROS["warp-to-anomaly"]!;
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const sites = [den("QEE-288")];
  let board: ScriptBoard = {};

  for (let visit = 1; visit <= MAX_SITE_RETURNS + 2; visit += 1) {
    const go = pickThenIssue(anom, ANOM_STEP, obs({ anomalies: sites }), board).issued;
    assert.ok(go.action.kind === "warpScan" && go.action.target === "QEE-288", `visit ${visit} is still flown to`);
    board = { ...board, ...(go.boardPatch ?? {}) };
    assert.equal(board[LEDGER_KEYS.sites], "QEE-288:1", `visit ${visit} arrives with a clean sheet`);

    // The den dies: an empty grid with the drones aboard is the block's own
    // "I finished this site", and the only success it is able to observe.
    const cleared = fightUntilClear(fight, GIVE_UP_STEP, obs({ snapshot: snapshot([]) }), {}, board);
    assert.equal(cleared.outcome.kind, "done", `visit ${visit} clears the den`);
    assert.equal(cleared.why, "The grid is clear.", "and it finishes the way it always did");
    board = { ...board, ...(cleared.boardPatch ?? {}) };
    assert.equal(board[LEDGER_KEYS.sites], "", `visit ${visit}: a cleared den is held against nobody`);
  }
});

test("fight: clears buy no extra allowance — three CONSECUTIVE bad visits still end the den", () => {
  const anom = SCRIPT_MACROS["warp-to-anomaly"]!;
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const sites = [den("QEE-288")];
  // A den cleared twice, and then it stops dying. The two clears are spent
  // history: the count that matters starts again at the first bad visit.
  let board: ScriptBoard = {};
  for (let good = 0; good < 2; good += 1) {
    board = { ...board, ...(pickThenIssue(anom, ANOM_STEP, obs({ anomalies: sites }), board).issued.boardPatch ?? {}) };
    board = { ...board, ...(fight(GIVE_UP_STEP, obs({ snapshot: snapshot([]) }), {}, board).boardPatch ?? {}) };
  }

  let gaveUp: MacroTick | null = null;
  for (let bad = 1; bad <= MAX_SITE_RETURNS + 1; bad += 1) {
    const go = pickThenIssue(anom, ANOM_STEP, obs({ anomalies: sites }), board).issued;
    assert.ok(go.action.kind === "warpScan" && go.action.target === "QEE-288", `bad visit ${bad} is still flown to`);
    board = { ...board, ...(go.boardPatch ?? {}) };
    // Driven off: the ship leaves with the rats still on the grid, so nothing
    // about this visit says the den was winnable.
    const t = fight(GIVE_UP_STEP, dronesOnIt({ lockedTargetIDs: [] }), {}, board);
    board = { ...board, ...(t.boardPatch ?? {}) };
    if (/third time/i.test(t.why)) {
      gaveUp = t;
    }
  }
  assert.ok(gaveUp !== null, "the third consecutive bad visit is the one that gives up");
  assert.equal(gaveUp!.action.kind, "recallDrones");
  const stop = anom(ANOM_STEP, obs({ anomalies: sites }), {}, board);
  assert.equal(stop.outcome.kind, "blocked", "and the tour stops touring it");
});

test("⚠ fight: a grid that clears with a stall already pending -> the clear wins, and the den keeps no tally", () => {
  // The interaction worth pinning: the budget has run out and the block is on
  // its way out of the den when the last rat finally dies. An empty grid is the
  // strongest evidence obtainable that the site was winnable, so it has to
  // outrank the verdict — and it does so twice over, because siteProgress reads
  // the hostile count going down as progress AND the ladder tests "grid clear"
  // before it tests the verdict.
  const stalled = runFight(() => dronesOnIt(), STALL_TICKS + 5, ledgerBoard("QEE-288", 1));
  assert.equal(stalled.board[LEDGER_KEYS.stall], STALL_TICKS, "the stall really is pending");

  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const clear = fightUntilClear(fight, GIVE_UP_STEP, obs({ snapshot: snapshot([]) }), {}, stalled.board);
  assert.equal(clear.outcome.kind, "done");
  assert.equal(clear.why, "The grid is clear.", "not a leaving sentence — the bot won");
  const after: ScriptBoard = { ...stalled.board, ...clear.boardPatch };
  assert.equal(after[LEDGER_KEYS.sites], "", "the visits that led up to a clear are not a pattern");
  assert.equal(after[LEDGER_KEYS.stall], 0, "and no spent stall counter leaves the den with the ship");
});

test("warp-to-anomaly: the arrival is counted on the BOARD, where a repair trip cannot wipe it", () => {
  const anom = SCRIPT_MACROS["warp-to-anomaly"]!;
  const go = pickThenIssue(anom, ANOM_STEP, obs({ anomalies: [den("QEE-288"), den("ABC-123")] })).issued;
  assert.ok(go.action.kind === "warpScan" && go.action.target === "QEE-288");
  assert.equal(go.boardPatch?.["anomsVisited"], "QEE-288", "the lap list still works exactly as it always did");
  assert.equal(go.boardPatch?.[LEDGER_KEYS.sites], "QEE-288:1", "and the arrival is counted beside it");
  assert.equal(go.boardPatch?.[LEDGER_KEYS.label], "QEE-288", "which is also how the fight block learns where it is");
  // ⚠ THE COUNT BELONGS TO THIS BLOCK, NOT THE FIGHT BLOCK. After a
  // dock-and-repair the runner resumes at the very step it was interrupted on
  // and carries macroMem across, so an "already counted this visit" flag kept in
  // the fight block's step memory would SURVIVE the round trip and the return
  // would never be counted — zero returns, for precisely the loop this exists
  // to catch. This block issued the warp, so it knows an arrival happened.
  assert.ok(Object.keys(go.nextMem).every((key) => !key.startsWith("siteProgress")));
});

test("warp-to-anomaly: a den the run has given up on is skipped the way a visited one is", () => {
  const anom = SCRIPT_MACROS["warp-to-anomaly"]!;
  const t = pickThenIssue(
    anom,
    ANOM_STEP,
    obs({ anomalies: [den("QEE-288"), den("ABC-123")] }),
    ledgerBoard("QEE-288", MAX_SITE_RETURNS + 1),
  ).issued;
  assert.ok(t.action.kind === "warpScan" && t.action.target === "ABC-123");
});

test("⚠ warp-to-anomaly: the lap restart wipes the VISITED list and never the given-up one", () => {
  const anom = SCRIPT_MACROS["warp-to-anomaly"]!;
  const sites = [den("QEE-288"), den("ABC-123")];
  // QEE-288 has beaten the bot its allowance of times; both dens have been
  // worked on this lap, so the tour restarts.
  const board: ScriptBoard = {
    ...ledgerBoard("QEE-288", MAX_SITE_RETURNS + 1),
    anomsVisited: "QEE-288,ABC-123",
  };
  const lap = pickThenIssue(anom, ANOM_STEP, obs({ anomalies: sites }), board).issued;
  assert.ok(lap.action.kind === "warpScan" && lap.action.target === "ABC-123", "the new lap starts at the den that has NOT beaten it");
  assert.equal(lap.boardPatch?.["anomsVisited"], "ABC-123", "the lap list is replaced, as it always was");
  // The whole point: the count that says "this den has beaten me" survives the
  // wipe. §13 calls a lap restart that forgets it the same loop closing again
  // with extra steps, and it is right — the tour would fly straight back into
  // the den it walked out of an hour ago.
  assert.match(String(lap.boardPatch?.[LEDGER_KEYS.sites]), /QEE-288:3/);
  const after: ScriptBoard = { ...board, ...lap.boardPatch };
  const nextLap = pickThenIssue(anom, ANOM_STEP, obs({ anomalies: sites }), after).issued;
  assert.ok(nextLap.action.kind === "warpScan" && nextLap.action.target === "ABC-123", "still skipped on the lap after that");
});

test("warp-to-anomaly: every den given up on -> blocked with a sentence a player can act on", () => {
  const anom = SCRIPT_MACROS["warp-to-anomaly"]!;
  const t = anom(ANOM_STEP, obs({ anomalies: [den("QEE-288")] }), {}, ledgerBoard("QEE-288", MAX_SITE_RETURNS + 1));
  assert.equal(t.outcome.kind, "blocked", "not a silent tour of dens it has already given up on");
  const reason = t.outcome.kind === "blocked" ? t.outcome.reason : "";
  assert.match(reason, /given up on/);
  assert.match(reason, /Move the bot to another system/, "something the player can actually do");
  // …and it is NOT the "there is nothing of this kind here" sentence: that is a
  // different problem with a different fix, and saying the same words for both
  // leaves the player unable to choose between them.
  assert.ok(!reason.includes("not one of them is a den"));
});

test("warp-to-ore-anomaly: the ore tour never gives up on a site — the miner decides a cluster is empty", () => {
  // ⚠ The ledger counts ARRIVALS and abandons a label on its third one, whoever
  // made them. Mine-at-a-belt never fights and never feeds it, so an ore tour
  // that kept the ledger would retire perfectly good clusters purely for having
  // been flown to three times — and a completed lap starting another one is that
  // block's whole documented behaviour.
  const ore = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  let board: ScriptBoard = {};
  for (let lap = 0; lap < MAX_SITE_RETURNS + 3; lap += 1) {
    const t = pickThenIssue(ore, ORE_ANOM_STEP, obs({ anomalies: [rocks("ORE-111")] }), board).issued;
    assert.ok(t.action.kind === "warpScan" && t.action.target === "ORE-111", `lap ${lap} still flies to the ore site`);
    board = { ...board, ...(t.boardPatch ?? {}) };
  }
  assert.equal(board[LEDGER_KEYS.sites], undefined, "the ore tour writes no site ledger at all");
});

// ─── A lock the server refused is not pressed again until something changed ───
//
// Under the real runner a refused lock commits nothing, so `lockIssued` is never
// set by it and the block used to press again on every backoff until the runner's
// ten-refusal cap sent the ship home (a rock beyond lock range, the ship closing
// under an accepted orbit, TargetNotWithinRangeGeneric ten times in four
// minutes). The ledger is keyed by step + action kind with NO target id for a
// lock, and the block reads it against a baseline committed when it picked the
// rock. scriptRunnerRefusals.test.ts drives the same thing through the runner.

/** The ledger row the runner leaves after the server refuses a lock for this step. */
const lockRefused = (count: number) => [{
  key: "m:lock:-",
  count,
  firstAt: 0,
  lastAt: 0,
  words: "TargetNotWithinRangeGeneric",
  kind: "refused" as const,
}];

const unlockedMem = (over: MacroMemory = {}): MacroMemory =>
  ({ rockID: 50001, lockIssued: false, waited: 0, approachedRockID: 50001, lockRefusalsSeen: 0, ...over });

const rockAtX = (x: number) => entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x, y: 0, z: 0 } });

test("mine: a known lock range is a pre-gate — nothing is pressed beyond it, the lock goes out inside it", () => {
  const far = mine(mineStep, obs({ snapshot: snapshot([rockAtX(60_000)]), miningModuleIDs: [700], maxTargetRangeM: 40_000 }), unlockedMem(), {});
  assert.equal(far.action.kind, "wait", "no lock beyond range");
  assert.equal(far.why, "Closing in — too far out to lock yet.");
  assert.equal(far.phase, "Approaching a rock");
  assert.equal(far.nextMem["rockID"], 50001, "the hand-built memory still names the rock");
  assert.equal(far.nextMem["lockIssued"], false);

  const near = mine(mineStep, obs({ snapshot: snapshot([rockAtX(39_000)]), miningModuleIDs: [700], maxTargetRangeM: 40_000 }), far.nextMem, {});
  assert.deepEqual(near.action, { kind: "lock", targetID: 50001 });
});

test("mine: an unknown lock range does not gate the press", () => {
  const t = mine(mineStep, obs({ snapshot: snapshot([rockAtX(60_000)]), miningModuleIDs: [700], maxTargetRangeM: null }), unlockedMem(), {});
  assert.deepEqual(t.action, { kind: "lock", targetID: 50001 });
});

test("mine: a lock refused FAR out is not pressed again until the rock is 20% closer", () => {
  const world = (x: number, count = 1) =>
    obs({ snapshot: snapshot([rockAtX(x)]), miningModuleIDs: [700], refusals: lockRefused(count) });
  const refused = mine(mineStep, world(60_000), unlockedMem(), {});
  assert.equal(refused.action.kind, "wait", "a refusal newer than the baseline is not answered with another press");
  assert.equal(refused.nextMem["lockRefusalsSeen"], 1);
  assert.equal(refused.nextMem["lockIssued"], false, "far: a range problem, so no timed path");
  assert.ok(typeof refused.nextMem["lockRefusedAtM"] === "number");

  const holding = mine(mineStep, world(59_000), refused.nextMem, {});
  assert.equal(holding.action.kind, "wait", "barely closer is not progress");
  assert.equal(holding.nextMem["lockRefusedAtM"], refused.nextMem["lockRefusedAtM"], "the hold remembers where it was refused");

  const closer = mine(mineStep, world(47_000), holding.nextMem, {});
  assert.deepEqual(closer.action, { kind: "lock", targetID: 50001 }, "real progress buys another press");
});

test("mine: a lock refused CLOSE in takes the timed path and moves on, as it did before the runner change", () => {
  const world = obs({ snapshot: snapshot([rockAtX(8_000)]), miningModuleIDs: [700], refusals: lockRefused(1) });
  let t = mine(mineStep, world, unlockedMem(), {});
  assert.equal(t.why, "Waiting for the lock.");
  assert.equal(t.nextMem["lockIssued"], true);
  assert.equal(t.nextMem["waited"], 0);
  let moved = false;
  for (let i = 0; i < 12 && !moved; i += 1) {
    t = mine(mineStep, world, t.nextMem, {});
    moved = t.why === "That rock would not lock, so moving on.";
  }
  assert.ok(moved, "the rock is given up on after the lock wait budget");
});

test("mine: a stale lock record does not hold back a rock that was just picked", () => {
  const stale = obs({ snapshot: snapshot([rockAtX(8_000)]), miningModuleIDs: [700], refusals: lockRefused(3) });
  const picked = mine(mineStep, stale, NM, {});
  assert.equal(picked.action.kind, "orbit");
  assert.equal(picked.nextMem["lockRefusalsSeen"], 3, "the count found at pick time is the baseline");
  const next = mine(mineStep, stale, picked.nextMem, {});
  assert.deepEqual(next.action, { kind: "lock", targetID: 50001 }, "the old record is not a refusal of a lock never pressed");
});

// ── A lock record with no committed count ────────────────────────────────────
//
// The runner drops a step's memory when the step is left and keeps the ledger,
// so a block can start a visit facing a lock refusal it did not just cause. The
// refused-press path itself is only visible through the real runner and is
// tested in scriptRunnerRefusals.test.ts.
const leftoverLock = (stepID: string) => ({ ...refusal(stepID, "lock", 0, 2), key: `${stepID}:lock:-` });

test("fight: a lock record left from an earlier visit costs one tick, not the timed wait", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([rat]), weaponModuleIDs: [500], refusals: [leftoverLock("f")] });

  const read = fight(s, world, {}, {});
  assert.equal(read.action.kind, "wait");
  assert.equal(read.nextMem["lockRefusalsSeen"], 2);
  assert.equal(read.nextMem["targetID"], undefined, "no target is adopted for a lock that was never asked for");

  const press = fight(s, world, read.nextMem, {});
  assert.ok(press.action.kind === "lock" && press.action.targetID === 6661);

  // One more on the ledger than the count carried: that press was refused.
  const refused = fight(s, obs({ ...world, refusals: [{ ...leftoverLock("f"), count: 3 }] }), read.nextMem, {});
  assert.equal(refused.action.kind, "wait");
  assert.equal(refused.why, "Waiting for the lock.");
  assert.equal(refused.nextMem["lockIssued"], true);
  assert.equal(refused.nextMem["lockRefusalsSeen"], 3);
});

test("salvage: a lock record left from an earlier visit costs one tick, not the timed wait", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [800], refusals: [leftoverLock("sv")] });
  const picked: MacroMemory = { wreckID: 70001, lockIssued: false, waited: 0 };

  const read = salvage(s, world, picked, {});
  assert.equal(read.action.kind, "wait");
  assert.equal(read.nextMem["lockRefusalsSeen"], 2);

  const press = salvage(s, world, read.nextMem, {});
  assert.ok(press.action.kind === "lock" && press.action.targetID === 70001);

  const refused = salvage(s, obs({ ...world, refusals: [{ ...leftoverLock("sv"), count: 3 }] }), read.nextMem, {});
  assert.equal(refused.action.kind, "wait");
  assert.equal(refused.why, "Waiting for the lock.");
  assert.equal(refused.nextMem["lockIssued"], true);
});

test("fight-with-drones: a lock record left from an earlier visit costs one tick, not the timed wait", () => {
  const fight = SCRIPT_MACROS["fight-with-drones"]!;
  const s = { id: "d", kind: "macro", macro: "fight-with-drones", args: {} } as const;
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([rat]), weaponModuleIDs: [500], refusals: [leftoverLock("d")] });
  // The hold comes first on this ladder; the lock rung is what is under test.
  const holding = fight(s, world, {}, {});
  assert.equal(holding.action.kind, "keepAtRange");

  const read = fight(s, world, holding.nextMem, {});
  assert.equal(read.action.kind, "wait");
  assert.equal(read.nextMem["lockRefusalsSeen"], 2);
  assert.equal(read.nextMem["targetID"], undefined, "no target is adopted for a lock that was never asked for");

  const press = fight(s, world, read.nextMem, {});
  assert.ok(press.action.kind === "lock" && press.action.targetID === 6661);

  const refused = fight(s, obs({ ...world, refusals: [{ ...leftoverLock("d"), count: 3 }] }), read.nextMem, {});
  assert.equal(refused.action.kind, "wait");
  assert.equal(refused.why, "Waiting for the lock.");
  assert.equal(refused.nextMem["targetID"], 6661);
  assert.equal(refused.nextMem["lockRefusalsSeen"], 3);
});

test("fight-with-drones: a leftover lock record is not booked against a pre-lock that was never pressed", () => {
  const fight = SCRIPT_MACROS["fight-with-drones"]!;
  const s = { id: "d", kind: "macro", macro: "fight-with-drones", args: {} } as const;
  const at = (itemID: number, x: number) =>
    entity({ itemID, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x, y: 0, z: 0 } });
  // The primary is already locked on arrival, so no press of this visit has
  // committed a count and the record on the ledger is somebody else's.
  const world = obs({
    snapshot: snapshot([at(6661, 5000), at(6662, 6000)]),
    weaponModuleIDs: [500],
    lockedTargetIDs: [6661],
    maxLockedTargets: 3,
    refusals: [leftoverLock("d")],
  });
  const holding = fight(s, world, {}, {});
  assert.equal(holding.action.kind, "keepAtRange");
  const held: MacroMemory = { ...holding.nextMem, targetID: 6661, lockIssued: true, waited: 0 };

  const read = fight(s, world, held, {});
  assert.notEqual(read.action.kind, "lock");
  assert.equal(read.nextMem["lockRefusalsSeen"], 2);
  assert.deepEqual(read.nextMem["preLocked"] ?? [], [], "nothing is marked as asked for");

  const press = fight(s, world, read.nextMem, {});
  assert.ok(press.action.kind === "lock" && press.action.targetID === 6662, "and the pre-lock goes out on the next tick");
});

test("remote-rep / remote-cap: a leftover lock record costs one tick and does not adopt the mate", () => {
  const hurt = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1, capacitorRatio: 0.2, position: { x: 3000, y: 0, z: 0 } });
  const cases = [
    { block: remoteRep, s: repStep, fit: { remoteShieldRepairerIDs: [600] }, lockOn: "repLockOn" },
    {
      block: remoteCapBlock,
      s: { id: "rc", kind: "macro", macro: "remote-cap", args: {} } as MacroStep,
      fit: { remoteCapModuleIDs: [640] },
      lockOn: "capLockOn",
    },
  ];
  for (const { block, s, fit, lockOn } of cases) {
    const world = obs({ snapshot: snapshot([hurt], { activeModuleIDs: [] }), fleetMemberCharacterIDs: [5001], ...fit, refusals: [leftoverLock(s.id)] });

    const read = block(s, world, {}, {});
    assert.equal(read.action.kind, "wait", s.macro);
    assert.equal(read.nextMem["lockRefusalsSeen"], 2);
    assert.equal(read.nextMem[lockOn], null, "the mate is not adopted, so the next tick still presses");

    const press = block(s, world, read.nextMem, {});
    assert.ok(press.action.kind === "lock" && press.action.targetID === 7001, s.macro);

    const refused = block(s, obs({ ...world, refusals: [{ ...leftoverLock(s.id), count: 3 }] }), read.nextMem, {});
    assert.equal(refused.action.kind, "wait");
    assert.equal(refused.why, "Waiting for the lock.");
    assert.equal(refused.nextMem[lockOn], 7001, "a refused press is waited out against the mate it was for");
  }
});
