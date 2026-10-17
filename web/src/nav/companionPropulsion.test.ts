import test from "node:test";
import assert from "node:assert/strict";

import { freshLadderMemory, type CompanionLadderMemory, type FleetCompanionObservation } from "./fleetCompanionLoop.ts";
import {
  missileRatsOnGrid,
  orbitingAgainstMissiles,
  propsBecause,
  propsOnThisGrid,
  propsWanted,
} from "./companionPropulsion.ts";
import type { PropulsionModule } from "./propulsion.ts";
import { SHORT_RAT, TYPE_SHORT_RAT, companionObs, fightGrid } from "./fightFixtures.test-util.ts";

const AB: PropulsionModule = { itemID: 11, typeID: 90000910, kind: "afterburner" };
const MWD: PropulsionModule = { itemID: 12, typeID: 90000911, kind: "microwarpdrive" };
const UNKNOWN: PropulsionModule = { itemID: 13, typeID: 90000912, kind: null };
const TYPE_MISSILE = 604;
const MISSILE = { ...SHORT_RAT, missile: true };

function grid(
  typeIDs: readonly number[],
  facts: FleetCompanionObservation["ratCombatByTypeID"],
  hostileOnGrid: boolean | null = true,
): FleetCompanionObservation {
  return companionObs({
    snapshot: fightGrid({ rats: typeIDs.map((typeID, i) => ({ itemID: 200100 + i, typeID, x: 5_000 })) }),
    ratCombatByTypeID: facts,
    hostileOnGrid,
  });
}

const FACTS = { [TYPE_SHORT_RAT]: SHORT_RAT, [TYPE_MISSILE]: MISSILE };

test("propsBecause: the chat word first, rung 8's hold next, travel only without one", () => {
  const base = { held: null, ownHold: false, closing: false, missileOrbit: false, travel: false };
  assert.equal(propsBecause({ ...base, held: true }), "held-on");
  assert.equal(propsBecause({ ...base, held: false, closing: true, travel: true }), "held-off");
  assert.equal(propsBecause({ ...base, ownHold: true, closing: true, missileOrbit: true }), "closing");
  assert.equal(propsBecause({ ...base, ownHold: true, missileOrbit: true }), "missile-orbit");
  assert.equal(propsBecause({ ...base, ownHold: true, travel: true }), "none", "travel is not asked under rung 8's order");
  assert.equal(propsBecause({ ...base, travel: true }), "travel");
  assert.equal(propsBecause(base), "none");
  assert.deepEqual(
    (["held-on", "held-off", "closing", "missile-orbit", "travel", "none"] as const).map(propsWanted),
    [true, false, true, true, true, false],
  );
});

test("missileRatsOnGrid: known missile rats only, with hostiles on grid", () => {
  assert.equal(missileRatsOnGrid(grid([TYPE_MISSILE], FACTS)), true);
  assert.equal(missileRatsOnGrid(grid([TYPE_SHORT_RAT, TYPE_MISSILE], FACTS)), true);
  assert.equal(missileRatsOnGrid(grid([TYPE_SHORT_RAT], FACTS)), false);
  assert.equal(missileRatsOnGrid(grid([TYPE_MISSILE], {})), false);
  assert.equal(missileRatsOnGrid(grid([TYPE_MISSILE], null)), false);
  assert.equal(missileRatsOnGrid(grid([TYPE_MISSILE], { [TYPE_MISSILE]: { ...MISSILE, missile: null } })), false);
  assert.equal(missileRatsOnGrid(grid([TYPE_MISSILE], FACTS, false)), false);
  assert.equal(missileRatsOnGrid(grid([TYPE_MISSILE], FACTS, null)), false);
  assert.equal(missileRatsOnGrid(companionObs({ hostileOnGrid: true, ratCombatByTypeID: FACTS })), false);
});

test("orbitingAgainstMissiles needs flight auto, a standing order and a missile rat", () => {
  const observed = grid([TYPE_MISSILE], FACTS);
  const holding: CompanionLadderMemory = {
    ...freshLadderMemory(),
    flightMode: "auto",
    combatPosition: { ...freshLadderMemory().combatPosition, hold: {} as never },
  };
  assert.equal(orbitingAgainstMissiles(observed, holding), true);
  assert.equal(orbitingAgainstMissiles(observed, { ...holding, flightMode: "follow" }), false);
  assert.equal(orbitingAgainstMissiles(observed, { ...holding, combatPosition: freshLadderMemory().combatPosition }), false);
  assert.equal(orbitingAgainstMissiles(grid([TYPE_SHORT_RAT], FACTS), holding), false);
});

test("propsOnThisGrid: hostiles narrow the rack to afterburners and flag a running MWD or null-kind", () => {
  const fitted = [MWD, UNKNOWN, AB];
  const observed = grid([TYPE_SHORT_RAT], FACTS);
  const none = propsOnThisGrid(fitted, new Set<number>(), observed, freshLadderMemory());
  assert.deepEqual(none.modules, [AB]);
  assert.equal(none.standDown, null);
  assert.deepEqual(propsOnThisGrid(fitted, new Set([MWD.itemID]), observed, freshLadderMemory()).standDown, MWD);
  assert.deepEqual(propsOnThisGrid(fitted, new Set([UNKNOWN.itemID]), observed, freshLadderMemory()).standDown, UNKNOWN);
  // A running afterburner is never a stand-down.
  assert.equal(propsOnThisGrid(fitted, new Set([AB.itemID]), observed, freshLadderMemory()).standDown, null);
});

test("propsOnThisGrid: no hostiles, an unreadable flag, or a commander's word hands over the whole rack", () => {
  const fitted = [MWD, AB];
  const running = new Set([MWD.itemID]);
  for (const flag of [false, null]) {
    const result = propsOnThisGrid(fitted, running, grid([TYPE_SHORT_RAT], FACTS, flag), freshLadderMemory());
    assert.deepEqual(result, { modules: fitted, standDown: null });
  }
  for (const propsHeld of [true, false]) {
    const result = propsOnThisGrid(fitted, running, grid([TYPE_SHORT_RAT], FACTS), { ...freshLadderMemory(), propsHeld });
    assert.deepEqual(result, { modules: fitted, standDown: null });
  }
});
