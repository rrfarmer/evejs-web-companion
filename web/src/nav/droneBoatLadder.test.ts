// The drone-boat ladder — docs/drone-boat-block-spec.md §12.
//
// Every case here is one of two shapes, and the distinction is worth keeping in
// mind while reading:
//
//   • RUNG ORDER. A tick with several things to do must issue the HIGHEST one
//     and nothing else. These tests are the reason the block does not starve its
//     own lower rungs, and they are written by handing the block a world where
//     two or three rungs would all fire and asserting on the one that wins.
//   • THE NULL WINS. An unreadable input must make the block do the safe thing,
//     which is nearly always "nothing". A test that asserts on a `wait` here is
//     not a weak test: it is the whole tri-state discipline, and the bugs it
//     catches (a burner re-lit every tick against an unreadable module list, a
//     pre-lock guessed at five slots) are the expensive ones.

import test from "node:test";
import assert from "node:assert/strict";

import type {
  SpaceEntity,
  SpaceShipStatus,
  SpaceSnapshot,
  SpaceVector,
} from "../store/types.ts";
import type { MacroMemory, ScriptBoard } from "./scriptDecide.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { RatThreat } from "./ratThreat.ts";
import { decideDroneBoat, EMPTY_GRID_CONFIRM_TICKS, type DroneBoatInputs } from "./droneBoatLadder.ts";
import { decodeLedger, encodeLedger, enterSite, emptyLedger, visitsTo, MAX_SITE_RETURNS } from "./siteProgress.ts";
import type { CombatOwnership } from "./combatOwnership.ts";

const ownedFlight: CombatOwnership = { shipID: 9001, modules: {}, locks: [], drones: [7001],
  initialDrones: [], launched: true, movement: false, fleetCall: false };

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };

/** A position `metres` away along x, so a row's distance is exactly that. */
function at(metres: number): SpaceVector {
  return { x: metres, y: 0, z: 0 };
}

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "ship", typeID: 1, groupID: 1, categoryID: 6, name: null, ownerID: null,
    radius: 0, position: ORIGIN, velocity: ORIGIN, isSelf: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: null, beltID: null, oreGrade: null,
    oreValuePerM3: null, isNpc: false, npcEntityType: null,
    controllerID: null, droneActivity: null, targetEntityID: null,
    ...over,
  } as SpaceEntity;
}

/** A rat: an NPC ship, `distance` metres out, of `typeID`. */
function rat(itemID: number, distance: number, typeID = 100): SpaceEntity {
  return entity({ itemID, typeID, isNpc: true, npcEntityType: "pirate", position: at(distance) });
}

/** One of MY drones in space — controllerID must be my hull or it cannot be ordered. */
function myDrone(itemID: number): SpaceEntity {
  return entity({ itemID, kind: "drone", controllerID: 9001, position: at(1000) });
}

function ship(over: Partial<SpaceShipStatus> = {}): SpaceShipStatus {
  return {
    itemID: 9001, typeID: 593, name: "Tristan", mode: null, maxVelocity: 315, radius: 0,
    position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1,
    capacitorRatio: 1, shieldCapacity: null, armorCapacity: null, hullCapacity: null,
    activeModuleIDs: [],
    weaponBanks: {},
    ...over,
  } as SpaceShipStatus;
}

function snapshot(entities: SpaceEntity[], shipOver: Partial<SpaceShipStatus> = {}): SpaceSnapshot {
  return { inSpace: true, solarSystemID: 30000142, shipID: 9001, sampledAtMs: 1, entities, ship: ship(shipOver) };
}

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: true, dronesOut: false,
    snapshot: null, lockedTargetIDs: [], holds: null, droneBayItemIDs: [],
    combatDroneIDs: [], combatDroneBayItemIDs: [], salvageDroneIDs: [], salvageDroneBayItemIDs: [],
    weaponModuleIDs: [],
    myDrones: [], capacitorRatio: 1,
    ...over,
  };
}

function run(over: Partial<DroneBoatInputs> & { obs: ScriptObservation }) {
  const inputs: DroneBoatInputs = {
    mem: {},
    board: {},
    targets: ["tackle", "ewar", "logi", "other"],
    holdRangeM: null,
    propMode: "auto",
    squad: "off",
    ...over,
  };
  return decideDroneBoat(inputs);
}

/**
 * Drive the block over an EMPTY grid until it believes it.
 *
 * ⚠ AN EMPTY GRID IS NOT BELIEVED ON THE FIRST READ, and these tests would be
 * asserting the bug if they pretended otherwise: the tick just after a warp
 * lands reads a grid that has not populated yet, which is why a live run warped
 * through three dens in ninety seconds declaring each one clear while the rats
 * in them shot the ship. The block re-reads before it finishes; a caller that
 * wants the FINISH has to hand it the same empty answer that many times.
 */
function runUntilClear(over: Partial<DroneBoatInputs> & { obs: ScriptObservation }) {
  let mem: MacroMemory = over.mem ?? {};
  let last = run({ ...over, mem });
  for (let read = 1; read < EMPTY_GRID_CONFIRM_TICKS; read += 1) {
    mem = last.nextMem;
    last = run({ ...over, mem });
  }
  return last;
}


/** A rat type that scrams at `rangeM`. */
function scrammer(rangeM: number): RatThreat {
  return { scram: true, scramRangeM: rangeM, web: false, ewar: false };
}
const WEBBER: RatThreat = { scram: false, scramRangeM: null, web: true, ewar: false };
const EWAR: RatThreat = { scram: false, scramRangeM: null, web: false, ewar: true };
const HARMLESS: RatThreat = { scram: false, scramRangeM: null, web: false, ewar: false };

// ─── Guards ──────────────────────────────────────────────────────────────────

test("docked blocks with a sentence the player can act on", () => {
  const out = run({ obs: obs({ docked: true, inSpace: false }) });
  assert.equal(out.outcome.kind, "blocked");
  assert.match((out.outcome as { reason: string }).reason, /undock/i);
});

test("in warp decides nothing", () => {
  const out = run({ obs: obs({ inWarp: true, snapshot: snapshot([rat(1, 10_000)]) }) });
  assert.equal(out.action.kind, "wait");
  assert.equal(out.outcome.kind, "acting");
});

// ─── Rung order ──────────────────────────────────────────────────────────────

test("rung order: drones out beats the band, the lock and the guns", () => {
  // Everything below rung 1 also has work: no standing hold, nothing locked,
  // an idle gun. Only the launch may be issued.
  const out = run({
    obs: obs({
      snapshot: snapshot([rat(1, 30_000)]),
      combatDroneBayItemIDs: [7001],
      weaponModuleIDs: [5001],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
    }),
  });
  assert.equal(out.action.kind, "launchDrones");
});

test("rung order: the band beats the lock and the guns", () => {
  const out = run({
    obs: obs({
      snapshot: snapshot([rat(1, 30_000), myDrone(7001)]),
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      weaponModuleIDs: [5001],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
    }),
  });
  assert.equal(out.action.kind, "keepAtRange");
  // Floor = 20 km scram + 5 km buffer; ceiling = min(45-3, 40-3) = 37 km.
  assert.deepEqual(
    { targetID: (out.action as { targetID: number }).targetID, range: (out.action as { range: number }).range },
    { targetID: 1, range: 25_000 },
  );
});

test("rung order: the lock beats the guns", () => {
  const out = run({
    // The hold is already standing at the band's own answer, so rung 2 falls
    // through and rung 4 gets the tick even though a gun is idle.
    mem: { holdM: 25_000, anchorID: 1 },
    obs: obs({
      snapshot: snapshot([rat(1, 25_000), myDrone(7001)]),
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      weaponModuleIDs: [5001],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
    }),
  });
  assert.equal(out.action.kind, "lock");
  assert.equal((out.action as { targetID: number }).targetID, 1);
});

test("rung order: the drones go on the primary before the guns do", () => {
  const out = run({
    mem: { holdM: 25_000, anchorID: 1, targetID: 1, lockIssued: true },
    obs: obs({
      snapshot: snapshot([rat(1, 25_000), myDrone(7001)]),
      lockedTargetIDs: [1],
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      weaponModuleIDs: [5001],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
    }),
  });
  assert.equal(out.action.kind, "engageDrones");
  assert.deepEqual((out.action as { droneIDs: readonly number[] }).droneIDs, [7001]);
});

// ─── The band ────────────────────────────────────────────────────────────────

// ─── The empty band never closes ─────────────────────────────────────────────
//
// ⚠ THESE ARE THE TESTS FOR A SHIP THAT WAS LOST ON 2026-09-14, and the one
// they replaced asserted the behaviour that lost it. §2 said an empty band is
// answered by "holding at the ceiling and saying so"; the ship was 25.5 km out
// with a 17 km ceiling, so holding at the ceiling meant CLOSING 8.5 km, into a
// 20 km scram, on a prop mod. It got pointed and could not warp when the armour
// watch fired. The band being empty says there is no room to kite — it says
// nothing whatever in favour of flying closer.

/** The spec's low-skill Tristan world: 20 km scram, and a leash argued below. */
function emptyBandWorld(over: Partial<ScriptObservation> = {}): Partial<ScriptObservation> {
  return {
    combatDroneIDs: [7001],
    myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    maxTargetRangeM: 40_000,
    // 27.5 km of control range: ceiling 24.5 km under a floor of 25 km. Empty,
    // and empty on a MEASURED leash, so nothing here depends on the guess.
    droneControlRangeM: 27_500,
    threatByTypeID: { 100: scrammer(20_000) },
    ...over,
  };
}

test("⚠ an empty band with the ship OUTSIDE the ceiling never issues a closing hold", () => {
  const out = run({
    obs: obs(emptyBandWorld({ snapshot: snapshot([rat(1, 30_000), myDrone(7001)]) })),
  });
  assert.equal(out.action.kind, "keepAtRange");
  // The band's own answer is 24.5 km and the ship is at 30 km. Asking for 24.5
  // would be an order to burn 5.5 km into a 20 km scram, so the hold is pinned
  // where the ship already is.
  assert.equal((out.action as { range: number }).range, 30_000);
  assert.match(out.why, /no room to kite/i);
  assert.match(out.why, /staying here/i);
});

test("⚠ an empty band never lights the prop mod to close", () => {
  const out = run({
    // The hold is already pinned where the ship is, so rung 2 falls through and
    // rung 3 gets the tick. Against the band's 24.5 km there is a 5.5 km gap
    // here, which is over PROP_GAP_M — the old code burned exactly this.
    mem: { holdM: 30_000, anchorID: 1 },
    obs: obs(
      emptyBandWorld({
        snapshot: snapshot([rat(1, 30_000), myDrone(7001)], { activeModuleIDs: [] }),
        propulsionModules: [{ itemID: 6001, typeID: 434, kind: "microwarpdrive" }],
        capacitorRatio: 1,
      }),
    ),
  });
  assert.notEqual(out.action.kind, "activate");
  assert.equal(out.action.kind, "lock");
});

test("⚠ an empty band still fights — the rungs below are not starved", () => {
  const out = run({
    mem: { holdM: 30_000, anchorID: 1, targetID: 1, lockIssued: true },
    obs: obs(
      emptyBandWorld({
        snapshot: snapshot([rat(1, 30_000), myDrone(7001)]),
        lockedTargetIDs: [1],
        weaponModuleIDs: [5001],
      }),
    ),
  });
  // Not `done`, not `blocked`, not a wait: an unkitable band is a reason to
  // brawl, never a reason to stop shooting or to leave the site.
  assert.equal(out.action.kind, "engageDrones");
  assert.equal(out.outcome.kind, "acting");
});

test("an empty band with the ship INSIDE the ceiling may still open range outward", () => {
  const out = run({
    // 8 km out, ceiling 24.5 km: opening to the ceiling moves AWAY from the
    // scram, which is the one direction the guard does not touch.
    obs: obs(emptyBandWorld({ snapshot: snapshot([rat(1, 8_000), myDrone(7001)]) })),
  });
  assert.equal(out.action.kind, "keepAtRange");
  assert.equal((out.action as { range: number }).range, 24_500);
  assert.match(out.why, /fighting at 24\.5 km/i);
});

test("a NON-empty band still closes normally", () => {
  const out = run({
    // 45 km of control range: ceiling 37 km over a floor of 25 km. There IS room
    // to kite, the ship is 38 km out, and closing to 25 km is the whole point of
    // the block. The fix must not disarm ordinary kiting.
    obs: obs(
      emptyBandWorld({
        snapshot: snapshot([rat(1, 38_000), myDrone(7001)]),
        droneControlRangeM: 45_000,
      }),
    ),
  });
  assert.equal(out.action.kind, "keepAtRange");
  assert.equal((out.action as { range: number }).range, 25_000);
});

test("⚠ the empty-band readout names the hold override when the leash was GUESSED", () => {
  const out = run({
    // The live fit: no drone control range at all, so the leash is the 20 km
    // no-skills guess and the ceiling is 17 km. The player cannot fix a leash
    // they are never told was invented.
    obs: obs(
      emptyBandWorld({
        snapshot: snapshot([rat(1, 30_000), myDrone(7001)]),
        droneControlRangeM: null,
      }),
    ),
  });
  assert.equal(out.action.kind, "keepAtRange");
  assert.equal((out.action as { range: number }).range, 30_000);
  assert.match(out.why, /could not read your drone control range/i);
  assert.match(out.why, /set the hold range/i);
});

test("a hold the PLAYER asked for is still flown to, scram or no scram", () => {
  const out = run({
    // §2 is explicit that someone who types a brawling range may have one, and
    // the override is the fix the readout above points at. The guard forbids the
    // block closing into a point of its OWN accord, not obeying an instruction.
    holdRangeM: 15_000,
    obs: obs(
      emptyBandWorld({
        snapshot: snapshot([rat(1, 30_000), myDrone(7001)]),
        droneControlRangeM: null,
      }),
    ),
  });
  assert.equal(out.action.kind, "keepAtRange");
  assert.equal((out.action as { range: number }).range, 15_000);
});

test("hysteresis: a sub-2 km change does not spend a second keepAtRange", () => {
  const world = {
    snapshot: snapshot([rat(1, 26_000), myDrone(7001)]),
    combatDroneIDs: [7001],
    myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    maxTargetRangeM: 40_000,
    droneControlRangeM: 45_000,
    threatByTypeID: { 100: scrammer(20_000) },
  };
  // Standing order is 1 km off the band's 25 km answer and the anchor is the
  // same rock: the rung has to fall through to the lock.
  const out = run({ mem: { holdM: 24_000, anchorID: 1 }, obs: obs(world) });
  assert.equal(out.action.kind, "lock");
});

test("an unreadable drone leash holds shorter and says the leash was guessed", () => {
  const out = run({
    obs: obs({
      snapshot: snapshot([rat(1, 30_000), myDrone(7001)]),
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      maxTargetRangeM: 40_000,
      droneControlRangeM: null,
      threatByTypeID: { 100: HARMLESS },
    }),
  });
  assert.equal(out.action.kind, "keepAtRange");
  // 20 km no-skills guess minus the 3 km leash buffer — NOT the 37 km the lock
  // range would have given if the two leashes were allowed to substitute.
  assert.equal((out.action as { range: number }).range, 17_000);
  assert.match(out.why, /could not read your drone control range/i);
});

// ─── Propulsion ──────────────────────────────────────────────────────────────

const MWD = { itemID: 6001, typeID: 434, kind: "microwarpdrive" as const };

test("wantBurn is false while the ship is inside the band", () => {
  const out = run({
    // Anchor at 26 km, hold at 25 km: a 1 km gap, nothing worth blooming for.
    mem: { holdM: 25_000, anchorID: 1, targetID: 1, lockIssued: true, dronesOn: 1 },
    obs: obs({
      snapshot: snapshot([rat(1, 26_000), myDrone(7001)], { activeModuleIDs: [] }),
      lockedTargetIDs: [1],
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
      propulsionModules: [MWD],
      capacitorRatio: 1,
    }),
  });
  assert.notEqual(out.action.kind, "activate");
});

test("wantBurn is true while the gap is real", () => {
  const out = run({
    // Anchor at 38 km against a 25 km hold: 13 km of gap, worth the signature.
    mem: { holdM: 25_000, anchorID: 1 },
    obs: obs({
      snapshot: snapshot([rat(1, 38_000), myDrone(7001)], { activeModuleIDs: [] }),
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
      propulsionModules: [MWD],
      capacitorRatio: 1,
    }),
  });
  assert.equal(out.action.kind, "activate");
  assert.equal((out.action as { moduleID: number }).moduleID, 6001);
});

test('propMode "off" still stops a burner this invocation owns', () => {
  const out = run({
    propMode: "off",
    mem: { holdM: 25_000, anchorID: 1, combatOwned: { ...ownedFlight, modules: { 6001: { typeID: MWD.typeID } } } },
    obs: obs({
      snapshot: snapshot([rat(1, 38_000), myDrone(7001)], { activeModuleIDs: [6001] }),
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
      propulsionModules: [MWD],
      capacitorRatio: 1,
    }),
  });
  assert.equal(out.action.kind, "deactivate");
  assert.equal((out.action as { moduleID: number }).moduleID, 6001);
});

test("an unreadable active-module list never touches the rack", () => {
  const out = run({
    mem: { holdM: 25_000, anchorID: 1 },
    obs: obs({
      snapshot: snapshot([rat(1, 38_000), myDrone(7001)], { activeModuleIDs: null }),
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
      propulsionModules: [MWD],
      capacitorRatio: 1,
    }),
  });
  assert.equal(out.action.kind, "lock");
});

// ─── Target priority ─────────────────────────────────────────────────────────

/** A grid of four rats, one of each class, the harmless one NEAREST. */
function ladderGrid() {
  return {
    snapshot: snapshot(
      [
        rat(1, 5_000, 100), // harmless, and closest
        rat(2, 10_000, 101), // ewar
        rat(3, 15_000, 102), // webber  -> tackle, sub-rank 1
        rat(4, 20_000, 103), // scrammer -> tackle, sub-rank 0
        myDrone(7001),
      ],
    ),
    combatDroneIDs: [7001],
    myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    maxTargetRangeM: 40_000,
    droneControlRangeM: 45_000,
    threatByTypeID: {
      100: HARMLESS,
      101: EWAR,
      102: WEBBER,
      103: scrammer(20_000),
    },
  } satisfies Partial<ScriptObservation>;
}

test("priority: scram before web before ewar before nearest", () => {
  const world = ladderGrid();
  const first = run({ mem: { holdM: 25_000, anchorID: 4 }, obs: obs(world) });
  assert.equal(first.action.kind, "lock");
  assert.equal((first.action as { targetID: number }).targetID, 4); // the scrammer

  // Take the scrammer off the grid: the webber is next, not the nearest.
  // ⚠ Nothing scrams now, so the band's answer moves to the CEILING (37 km) and
  // the standing hold has to be told that, or rung 2 wins the tick and the
  // assertion below reads a keepAtRange's anchor instead of a lock's target.
  const noScram = {
    ...world,
    snapshot: snapshot([rat(1, 5_000, 100), rat(2, 10_000, 101), rat(3, 15_000, 102), myDrone(7001)]),
  };
  const second = run({ mem: { holdM: 37_000, anchorID: 3 }, obs: obs(noScram) });
  assert.equal(second.action.kind, "lock");
  assert.equal((second.action as { targetID: number }).targetID, 3); // the webber

  // And with neither tackle row on grid, ewar beats the nearest harmless one.
  const noTackle = {
    ...world,
    snapshot: snapshot([rat(1, 5_000, 100), rat(2, 10_000, 101), myDrone(7001)]),
    threatByTypeID: { 100: HARMLESS, 101: EWAR },
  };
  const third = run({ mem: { holdM: 37_000, anchorID: 1 }, obs: obs(noTackle) });
  assert.equal(third.action.kind, "lock");
  assert.equal((third.action as { targetID: number }).targetID, 2); // the ewar rat
});

test("a live jam source is promoted over a statically equal rat", () => {
  const world = {
    snapshot: snapshot([rat(1, 5_000, 100), rat(2, 20_000, 100), myDrone(7001)]),
    combatDroneIDs: [7001],
    myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    maxTargetRangeM: 40_000,
    droneControlRangeM: 45_000,
    threatByTypeID: { 100: HARMLESS },
  } satisfies Partial<ScriptObservation>;
  // Same type, same class, same sub-rank: distance alone decides, so rat 1 wins.
  // (Nothing on this grid scrams, so the band holds at the 37 km ceiling and the
  // standing hold is set there to keep rung 2 out of the way.)
  const quiet = run({ mem: { holdM: 37_000, anchorID: 1 }, obs: obs(world) });
  assert.equal(quiet.action.kind, "lock");
  assert.equal((quiet.action as { targetID: number }).targetID, 1);

  // Now the server says the FAR one is the one actually holding us.
  const jammed = run({
    mem: { holdM: 37_000, anchorID: 1 },
    obs: obs({ ...world, jammingSourceIDs: [2] }),
  });
  assert.equal(jammed.action.kind, "lock");
  assert.equal((jammed.action as { targetID: number }).targetID, 2);
});

// ─── Guns ────────────────────────────────────────────────────────────────────

/** The state one tick after the drones were set on the primary. */
function engaged(over: Partial<ScriptObservation> = {}) {
  return {
    mem: { holdM: 25_000, anchorID: 1, targetID: 1, lockIssued: true, dronesOn: 1 } as MacroMemory,
    obs: obs({
      snapshot: snapshot([rat(1, 25_000), myDrone(7001)], { activeModuleIDs: [] }),
      lockedTargetIDs: [1],
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
      ...over,
    }),
  };
}

test("an unloaded gun is never activated", () => {
  const out = run(engaged({ weaponModuleIDs: [5001, 5002], unloadedWeaponIDs: [5001],
    combatWeapons: { shipID: 9001, cargo: [], weapons: [5001, 5002].map(itemID => ({
      itemID, typeID: 10, chargeTypeID: itemID === 5001 ? null : 222, chargeQuantity: itemID === 5001 ? 0 : 10,
      acceptedGroups: [83], chargeSize: 1, reachM: 30_000, tracking: 1 })) } }));
  assert.equal(out.action.kind, "activate");
  assert.equal((out.action as { moduleID: number }).moduleID, 5002);
});

test("a boat whose guns are all empty still fights with its drones and says so", () => {
  const out = run(engaged({ weaponModuleIDs: [5001, 5002], unloadedWeaponIDs: [5001, 5002] }));
  assert.equal(out.action.kind, "wait");
  assert.equal(out.outcome.kind, "acting");
  assert.match(out.why, /every gun aboard is empty/i);
});

test("no guns and no combat drones at all is a fit fault, not a site verdict", () => {
  const out = run({
    obs: obs({
      snapshot: snapshot([rat(1, 25_000)]),
      weaponModuleIDs: [],
      combatDroneIDs: [],
      combatDroneBayItemIDs: [],
    }),
  });
  assert.equal(out.outcome.kind, "blocked");
  assert.match((out.outcome as { reason: string }).reason, /no guns fitted and no combat drones/i);
});

// ─── Rotation ────────────────────────────────────────────────────────────────

test("the rotation rung never fires while the primary is unattended", () => {
  // Two drones out, one of them losing shield — but they have not been put on
  // the primary yet. The engage rung must win.
  const out = run({
    mem: { holdM: 25_000, anchorID: 1, targetID: 1, lockIssued: true },
    obs: obs({
      snapshot: snapshot([rat(1, 25_000), myDrone(7001), myDrone(7002)]),
      lockedTargetIDs: [1],
      combatDroneIDs: [7001, 7002],
      myDrones: [
        { itemID: 7001, shieldRatio: 0.99, armorRatio: 1, hullRatio: 1 },
        { itemID: 7002, shieldRatio: 1, armorRatio: 1, hullRatio: 1 },
      ],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
    }),
  });
  assert.equal(out.action.kind, "engageDrones");
});

test("a drone that has started losing shield is pulled once the primary is attended", () => {
  const out = run(
    engaged({
      snapshot: snapshot([rat(1, 25_000), myDrone(7001), myDrone(7002)], { activeModuleIDs: [] }),
      combatDroneIDs: [7001, 7002],
      myDrones: [
        { itemID: 7001, shieldRatio: 0.99, armorRatio: 1, hullRatio: 1 },
        { itemID: 7002, shieldRatio: 1, armorRatio: 1, hullRatio: 1 },
      ],
    }),
  );
  assert.equal(out.action.kind, "recallDrones");
  assert.deepEqual((out.action as { droneIDs: readonly number[] }).droneIDs, [7001]);
});

test("the last drone out is never rotated, however hurt it is", () => {
  const out = run(
    engaged({
      myDrones: [{ itemID: 7001, shieldRatio: 0.2, armorRatio: 1, hullRatio: 1 }],
      weaponModuleIDs: [],
    }),
  );
  assert.equal(out.action.kind, "wait");
  assert.match(out.why, /fighting it/i);
});

// ─── Finishing, and the wave fix ─────────────────────────────────────────────

test("a wave outside lock range is approached, not finished on", () => {
  const out = run({
    obs: obs({
      snapshot: snapshot([rat(1, 50_000), rat(2, 60_000)]),
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      combatDroneBayItemIDs: [7001],
      weaponModuleIDs: [5001],
      threatByTypeID: { 100: HARMLESS },
    }),
  });
  assert.equal(out.action.kind, "approach");
  assert.equal((out.action as { targetID: number }).targetID, 1);
  assert.notEqual(out.outcome.kind, "done");
});

test("the approach is a standing order: it is not re-issued every tick", () => {
  const world = obs({
    snapshot: snapshot([rat(1, 50_000)]),
    maxTargetRangeM: 40_000,
    combatDroneBayItemIDs: [7001],
    threatByTypeID: { 100: HARMLESS },
  });
  const out = run({ mem: { approachID: 1, closeTicks: 3 }, obs: world });
  assert.equal(out.action.kind, "wait");
  assert.equal(out.outcome.kind, "acting");
});

// ⚠ THE SILENT-REFUSAL RUNG ON THE HOT PATH. This block reaches its site by
// WARP, which is precisely when eve.js still has the hull landingPending and
// throws the first approach away with a 200. GOTO is the signature — the
// SetSpeedFraction that precedes every approach took, the approach did not.
test("⚠ an approach the server accepted and ignored -> re-order, then STOP, and never a silent two-minute wait", () => {
  const world = obs({
    snapshot: snapshot([rat(1, 50_000)], { mode: "GOTO" }),
    maxTargetRangeM: 40_000,
    combatDroneBayItemIDs: [7001],
    threatByTypeID: { 100: HARMLESS },
  });
  let mem: MacroMemory = { approachID: 1, closeTicks: 0 };
  const script: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const out = run({ mem, obs: world });
    script.push(out.action.kind);
    mem = out.nextMem;
  }
  assert.deepEqual(
    script.filter((kind) => kind !== "wait"),
    ["approach", "stopShip", "approach"],
    "the order goes back in, the engines are cut — which frees a stuck landing — and the order goes in again",
  );
});

test("a hull that IS following is left to close — the standing-order bound still holds", () => {
  const world = obs({
    snapshot: snapshot([rat(1, 50_000)], { mode: "FOLLOW" }),
    maxTargetRangeM: 40_000,
    combatDroneBayItemIDs: [7001],
    threatByTypeID: { 100: HARMLESS },
  });
  let mem: MacroMemory = { approachID: 1, closeTicks: 0 };
  for (let i = 0; i < 12; i += 1) {
    const out = run({ mem, obs: world });
    assert.equal(out.action.kind, "wait", `tick ${i} disturbed an approach that was running`);
    mem = out.nextMem;
  }
});

test("the close-in budget runs out: the drones come home and the block finishes", () => {
  // ⚠ A gun is fitted on purpose. "No guns and no drones" is a FIT fault and is
  // answered above the closing rung with `blocked`, which is the right answer to
  // a different question than the one this test is asking.
  const world = obs({
    snapshot: snapshot([rat(1, 50_000), myDrone(7001)]),
    maxTargetRangeM: 40_000,
    weaponModuleIDs: [5001],
    combatDroneIDs: [7001],
    myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    threatByTypeID: { 100: HARMLESS },
  });
  const recall = run({ mem: { approachID: 1, closeTicks: 999, combatOwned: ownedFlight }, obs: world });
  assert.equal(recall.action.kind, "recallDrones");
  assert.notEqual(recall.outcome.kind, "done");

  // Drones home: now it may finish.
  const done = run({
    mem: { approachID: 1, closeTicks: 999 },
    obs: obs({
      snapshot: snapshot([rat(1, 50_000)]),
      maxTargetRangeM: 40_000,
      weaponModuleIDs: [5001],
      threatByTypeID: { 100: HARMLESS },
    }),
  });
  assert.equal(done.outcome.kind, "done");
});

// ─── The anchor is sticky ────────────────────────────────────────────────────
//
// ⚠ CAUGHT LIVE ON 2026-09-14, one run after the loss. `kiteBand` answers "the
// nearest thing that can grab you", which is a fresh answer every tick, and on a
// live grid the nearest rat changes constantly. The log was five consecutive
// cycles of "keep range off 225 / 226 / 227 / 228 / 229 at 17000m" — a new
// keepAtRange at a different rat every few seconds, each one stopping the ship,
// turning it and burning it somewhere new. It never settled at any range and the
// drones were dragged along behind it. The pilot's words: "it constantly loses
// target and needs to reapproach".
//
// ⚠ EVERY FIXTURE HERE FIGHTS. Written without drones, the block answers "No way
// to fight" ABOVE the band rung and an assertion that no re-aim happened passes
// for the wrong reason — which is exactly what the first draft of these tests
// did.

/** A world where the block can actually fight, so the band rung is reached. */
function anchorWorld(rats: readonly SpaceEntity[], threats: Record<number, RatThreat>) {
  return obs({
    snapshot: snapshot([...rats, myDrone(7001)]),
    combatDroneIDs: [7001],
    myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    threatByTypeID: threats,
    droneControlRangeM: 45_000,
    maxTargetRangeM: 40_000,
  });
}

/** The target of a keepAtRange this tick, or null when it issued none. */
function reAimedAt(out: ReturnType<typeof run>): number | null {
  return out.action.kind === "keepAtRange" ? out.action.targetID : null;
}

test("⚠ the anchor is KEPT while it is still a threat on grid, however the grid shuffles", () => {
  // Rat 2 is nearer, so a FRESH band would anchor on it. The block is already
  // holding off rat 1, and rat 1 is still here and still a scrammer.
  const out = run({
    mem: { holdM: 25_000, anchorID: 1 },
    obs: anchorWorld([rat(1, 24_000), rat(2, 12_000)], { 100: scrammer(20_000) }),
  });
  assert.notEqual(out.why, "No way to fight.", "the fixture must reach the band rung");
  assert.notEqual(reAimedAt(out), 2, "a nearer rat is not a reason to re-aim");
});

test("⚠ a new anchor is picked when the held one leaves the grid", () => {
  const out = run({
    mem: { holdM: 25_000, anchorID: 1 },
    obs: anchorWorld([rat(2, 12_000)], { 100: scrammer(20_000) }),
  });
  assert.equal(reAimedAt(out), 2, "rat 1 died, so the hold moves to what is left");
});

test("⚠ a SCRAMMER takes the anchor from a webber — the one upgrade worth a re-aim", () => {
  const out = run({
    mem: { holdM: 25_000, anchorID: 1 },
    obs: anchorWorld([rat(1, 10_000, 101), rat(2, 24_000, 100)], {
      100: scrammer(20_000),
      101: WEBBER,
    }),
  });
  assert.equal(reAimedAt(out), 2, "a scram stops the ship leaving and a web does not");
});

test("a held anchor that stops being a threat at all is dropped", () => {
  const out = run({
    mem: { holdM: 25_000, anchorID: 1 },
    obs: anchorWorld([rat(1, 24_000, 102), rat(2, 12_000, 100)], {
      100: scrammer(20_000),
      102: HARMLESS,
    }),
  });
  assert.equal(reAimedAt(out), 2);
});

test("⚠ an empty grid on the tick a warp LANDS is not believed", () => {
  // THE LIVE BUG, 2026-09-14. The block arrived in a den, read a grid that had
  // not populated yet, called it clear, and the loop warped straight on — three
  // dens in ninety seconds while the pilot watched the ship take shield damage
  // from the rats it had just decided were not there. A grid that has not
  // arrived is byte-identical to a grid with nothing on it, so the first empty
  // read is not evidence of anything.
  const first = run({ obs: obs({ snapshot: snapshot([]) }) });
  assert.equal(first.outcome.kind, "acting", "the first empty read decides nothing");
  assert.equal(first.action.kind, "wait");
  assert.notEqual(first.outcome.kind, "done");

  // And the rats turning up on the very next read puts the count straight back,
  // so a fight that is genuinely still going never creeps toward finishing.
  const fighting = run({ obs: obs({ snapshot: snapshot([rat(1, 5_000)]) }), mem: first.nextMem });
  assert.notEqual(fighting.outcome.kind, "done");
  const again = run({ obs: obs({ snapshot: snapshot([]) }), mem: fighting.nextMem });
  assert.equal(again.outcome.kind, "acting", "the count restarted when the grid came back");
});

test("a cleared grid calls the drones home and then finishes", () => {
  // The recall waits on the same confirmation the finish does: pulling the
  // drones in on an unpopulated grid is the same mistake one rung earlier.
  const recall = runUntilClear({
    mem: { combatOwned: ownedFlight },
    obs: obs({
      snapshot: snapshot([myDrone(7001)]),
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    }),
  });
  assert.equal(recall.action.kind, "recallDrones");

  const done = runUntilClear({ obs: obs({ snapshot: snapshot([]) }) });
  assert.equal(done.outcome.kind, "done");
  assert.match(done.why, /grid is clear/i);
});

// ─── The give-up ledger (§13) ────────────────────────────────────────────────

/** A board whose ledger has already spent this label's returns. */
function spentBoard(label: string): ScriptBoard {
  let ledger = emptyLedger();
  for (let visit = 0; visit <= MAX_SITE_RETURNS; visit += 1) {
    ledger = enterSite(ledger, label);
  }
  return encodeLedger(ledger);
}

test("a site that has been given up on recalls the drones before finishing", () => {
  const board = spentBoard("QEE-288");
  const world = {
    snapshot: snapshot([rat(1, 25_000), myDrone(7001)]),
    lockedTargetIDs: [1],
    combatDroneIDs: [7001],
    myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    maxTargetRangeM: 40_000,
    droneControlRangeM: 45_000,
    // A gun, so the second half below is judged on the site verdict and not on
    // the fit fault that outranks it.
    weaponModuleIDs: [5001],
    threatByTypeID: { 100: scrammer(20_000) },
  } satisfies Partial<ScriptObservation>;

  const recall = run({ board, mem: { holdM: 25_000, anchorID: 1, combatOwned: ownedFlight }, obs: obs(world) });
  assert.equal(recall.action.kind, "recallDrones");
  assert.match(recall.why, /giving up on it/i);
  assert.notEqual(recall.outcome.kind, "done");

  // With nothing left in space the same verdict finishes, still naming the
  // evidence rather than saying "site too hard".
  const done = run({
    board,
    mem: { holdM: 25_000, anchorID: 1 },
    obs: obs({ ...world, snapshot: snapshot([rat(1, 25_000)]), combatDroneIDs: [], myDrones: [] }),
  });
  assert.equal(done.outcome.kind, "done");
  assert.match(done.why, /come back to QEE-288/i);
});

test("applying is false on the tick that merely ISSUES the engage order", () => {
  // The engage tick writes `dronesOn` into the NEXT tick's memory, so the stall
  // counter must not move on it. Evidence of that: the board patch's stall
  // count stays at 0 across the engage tick.
  const out = run({
    mem: { holdM: 25_000, anchorID: 1, targetID: 1, lockIssued: true },
    board: encodeLedger(enterSite(emptyLedger(), "QEE-288")),
    obs: obs({
      snapshot: snapshot([rat(1, 25_000), myDrone(7001)]),
      lockedTargetIDs: [1],
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
    }),
  });
  assert.equal(out.action.kind, "engageDrones");
  assert.equal(out.boardPatch?.["siteProgressStall"] ?? 0, 0);
});

test("applying is false while the primary sits outside the drone leash", () => {
  // Everything else holds — locked, engaged, drones out — but the rat is 30 km
  // away on a 20 km guessed leash. That is our own position, not the site's
  // fault, so no stall may accrue.
  const out = run({
    mem: { holdM: 17_000, anchorID: 1, targetID: 1, lockIssued: true, dronesOn: 1 },
    board: encodeLedger(enterSite(emptyLedger(), "QEE-288")),
    obs: obs({
      snapshot: snapshot([rat(1, 30_000), myDrone(7001)]),
      lockedTargetIDs: [1],
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      maxTargetRangeM: 40_000,
      droneControlRangeM: null,
      threatByTypeID: { 100: HARMLESS },
    }),
  });
  assert.equal(out.boardPatch?.["siteProgressStall"] ?? 0, 0);
});

test("applying is true when the damage really is going in", () => {
  const out = run({
    mem: { holdM: 25_000, anchorID: 1, targetID: 1, lockIssued: true, dronesOn: 1 },
    board: encodeLedger(enterSite(emptyLedger(), "QEE-288")),
    obs: obs({
      snapshot: snapshot([rat(1, 25_000), myDrone(7001)]),
      lockedTargetIDs: [1],
      combatDroneIDs: [7001],
      myDrones: [{ itemID: 7001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      threatByTypeID: { 100: scrammer(20_000) },
    }),
  });
  assert.equal(out.boardPatch?.["siteProgressStall"], 1);
});

// ─── Pre-lock ────────────────────────────────────────────────────────────────

test("an unreadable lock count never pre-locks", () => {
  // Two rats, one locked and engaged, a spare slot by any guess — and nothing
  // said how many slots this hull has, so the rung does not fire.
  const out = run(
    engaged({
      snapshot: snapshot([rat(1, 25_000), rat(2, 26_000), myDrone(7001)], { activeModuleIDs: [] }),
      weaponModuleIDs: [],
    }),
  );
  assert.equal(out.action.kind, "wait");
});

test("with a readable lock count the next target is locked while this one dies", () => {
  const base = engaged({
    snapshot: snapshot([rat(1, 25_000), rat(2, 26_000), myDrone(7001)], { activeModuleIDs: [] }),
    weaponModuleIDs: [],
  });
  const out = run({
    ...base,
    obs: { ...base.obs, maxLockedTargets: 5 } as ScriptObservation,
  });
  assert.equal(out.action.kind, "lock");
  assert.equal((out.action as { targetID: number }).targetID, 2);
});

test("pre-lock asks for each target at most once", () => {
  const base = engaged({
    snapshot: snapshot([rat(1, 25_000), rat(2, 26_000), myDrone(7001)], { activeModuleIDs: [] }),
    weaponModuleIDs: [],
  });
  const out = run({
    ...base,
    mem: { ...base.mem, preLocked: [2] },
    obs: { ...base.obs, maxLockedTargets: 5 } as ScriptObservation,
  });
  assert.equal(out.action.kind, "wait");
});

// ─── The fleet's call ────────────────────────────────────────────────────────

test("a follower shoots what the fleet called, not what its own ladder ranked", () => {
  const world = ladderGrid();
  const out = run({
    squad: "follow",
    calledTargetID: 1, // the harmless, nearest one
    mem: { holdM: 25_000, anchorID: 4 },
    obs: obs(world),
  });
  assert.equal(out.action.kind, "lock");
  assert.equal((out.action as { targetID: number }).targetID, 1);
});

test("a caller publishes its primary once, not every tick", () => {
  const world = ladderGrid();
  const first = run({ squad: "call", mem: { holdM: 25_000, anchorID: 4, targetID: 4, lockIssued: true }, obs: obs(world) });
  assert.equal(first.action.kind, "callPrimary");
  assert.equal((first.action as { targetID: number | null }).targetID, 4);

  const second = run({
    squad: "call",
    mem: { holdM: 25_000, anchorID: 4, targetID: 4, lockIssued: true, calledTargetID: 4 },
    obs: obs(world),
  });
  assert.notEqual(second.action.kind, "callPrimary");
});

// ─── A den that pays out (§13, the half that keeps a working bot working) ────
//
// The give-up ledger has two directions and this block wires up both, but only
// the retiring one was tested here. These two cover the other: a visit that ends
// with the grid CLEAR hands the label's tally back, and — the part unique to
// this block — the clear is judged on the TRUE grid and never on the in-reach
// one. `fight-the-rats` has no such distinction to get wrong, because it has no
// rung that closes on a wave it cannot reach.

test("⚠ a cleared grid hands this den's tally back, so a den that keeps paying out is never retired", () => {
  // The count is CONSECUTIVE bad visits. Two visits already stand against this
  // label and the third would spend it — but the grid came up clear, so the
  // tally goes rather than the den. Counting arrivals instead retires the only
  // anomaly in the system after two successful clears, and the player sees a bot
  // that stops working with nothing in the readout to explain it.
  const label = "QEE-288";
  const before = enterSite(enterSite(emptyLedger(), label), label);
  assert.equal(visitsTo(before, label), 2);

  const out = runUntilClear({ board: encodeLedger(before), obs: obs({ snapshot: snapshot([]) }) });
  assert.equal(out.outcome.kind, "done");
  assert.equal(visitsTo(decodeLedger(out.boardPatch), label), 0);
});

test("⚠ a wave merely out of REACH is not a clear, and keeps the tally it earned", () => {
  // A wave landing at 50 km reads as an empty IN-REACH grid, which is the bug
  // this block's closing rung exists for. Reading it as a success here would be
  // the same bug wearing the ledger's clothes: a den that drives the bot off
  // every time would hand its tally back on every trip and could never be
  // retired, so the give-up feature would quietly never fire on the one shape it
  // was written for.
  const label = "QEE-288";
  const before = enterSite(enterSite(emptyLedger(), label), label);

  const out = run({
    board: encodeLedger(before),
    obs: obs({
      snapshot: snapshot([rat(1, 50_000)]),
      maxTargetRangeM: 40_000,
      droneControlRangeM: 45_000,
      combatDroneBayItemIDs: [7001],
      threatByTypeID: { 100: HARMLESS },
    }),
  });
  assert.notEqual(out.outcome.kind, "done");
  // Either nothing was published this tick, or what was published still counts
  // both visits — the one thing that must not happen is the tally going away.
  assert.equal(visitsTo(decodeLedger(out.boardPatch ?? encodeLedger(before)), label), 2);
});

test("a clear at a den the ledger is not tracking publishes no tally for it", () => {
  // A belt spawn has no scan label: there is nothing to count and nothing to
  // forgive, and the block must not invent a row for a den it was never at.
  const out = runUntilClear({ board: {}, obs: obs({ snapshot: snapshot([]) }) });
  assert.equal(out.outcome.kind, "done");
  assert.deepEqual(decodeLedger(out.boardPatch).sites, []);
});
