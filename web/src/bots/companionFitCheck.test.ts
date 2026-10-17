import test from "node:test";
import assert from "node:assert/strict";

import {
  companionFitWarnings,
  requestForFit,
  type CompanionFitDroneStack,
  type CompanionFitFacts,
  type CompanionFitModule,
} from "./companionFitCheck.ts";
import { DEFAULT_COMPANION_SETUP } from "../nav/fleetCompanionLoop.ts";
import type { DroneRoleIDs } from "../nav/droneRoles.ts";

// Obviously synthetic ids throughout. 90000001-and-up mirrors ESI's own
// documented example CharacterID; the module ids below are the same family.
const GUN_A = 90000101;
const GUN_B = 90000102;
const HARDENER = 90000103;
const REMOTE_ARMOR = 90000104;

const NO_DRONE_ROLES: DroneRoleIDs = Object.freeze({
  combat: Object.freeze([]),
  salvage: Object.freeze([]),
  logistic: Object.freeze([]),
  unknown: Object.freeze([]),
});

function module(over: Partial<CompanionFitModule> & { itemID: number }): CompanionFitModule {
  return { typeID: 90000900, hasCharge: true, takesCharge: true, ...over };
}

function droneStack(over: Partial<CompanionFitDroneStack> = {}): CompanionFitDroneStack {
  return { typeID: 90000900, quantity: 1, ...over };
}

function facts(over: Partial<CompanionFitFacts> = {}): CompanionFitFacts {
  return {
    defenseModuleIDs: [HARDENER],
    shieldBoosterModuleIDs: [],
    armorRepairerModuleIDs: [],
    hullRepairerModuleIDs: [],
    remoteShieldModuleIDs: [],
    remoteArmorModuleIDs: [],
    remoteCapacitorModuleIDs: [],
    propulsionModules: [],
    weaponModuleIDs: [GUN_A],
    salvagerModuleIDs: [],
    droneAssistModuleIDs: [],
    // A fit that said nothing about where its tank is — which is what a hull
    // with one hardener and a gun genuinely does say.
    tankLayer: null,
    modules: [module({ itemID: HARDENER, takesCharge: false }), module({ itemID: GUN_A })],
    droneBay: null,
    droneBayRoles: NO_DRONE_ROLES,
    fitReadable: true,
    ...over,
  };
}

// --- requestForFit ----------------------------------------------------------

test("requestForFit always fills the eight lists from the hull", () => {
  const flown = requestForFit(DEFAULT_COMPANION_SETUP, facts());
  assert.deepEqual(flown.weaponModuleIDs, [GUN_A]);
  assert.deepEqual(flown.defenseModuleIDs, [HARDENER]);
  assert.deepEqual(flown.shieldBoosterModuleIDs, []);
  assert.deepEqual(flown.armorRepairerModuleIDs, []);
  assert.deepEqual(flown.hullRepairerModuleIDs, []);
  assert.deepEqual(flown.remoteShieldModuleIDs, []);
  assert.deepEqual(flown.remoteArmorModuleIDs, []);
  assert.deepEqual(flown.remoteCapacitorModuleIDs, []);
});

test("requestForFit keeps every setting that is not read off the fit", () => {
  // ⚠ THE POINT OF THE SPLIT. A squad stores thresholds and toggles; only the
  // eight module lists come from the hull. Filling them in must not disturb an
  // operator's actual configuration.
  const configured = {
    ...DEFAULT_COMPANION_SETUP,
    fleeHealthFloor: 0.45,
    maxFleeAttempts: 7,
    repairsAtStation: true,
    capacitorFloor: 0.2,
  };
  const flown = requestForFit(configured, facts());
  assert.equal(flown.fleeHealthFloor, 0.45);
  assert.equal(flown.maxFleeAttempts, 7);
  assert.equal(flown.repairsAtStation, true);
  assert.equal(flown.capacitorFloor, 0.2);
});

// --- the warnings -----------------------------------------------------------

test("an unreadable fit says NOTHING, rather than everything", () => {
  // ⚠ FAIL SILENT, NOT LOUD. A fit that could not be read would otherwise
  // report every list as empty and every gun as unloaded. A readout that cries
  // wolf on an unreadable fit teaches an operator to ignore it, and the one
  // time it is right is the time they ignore it too.
  const blind = facts({
    fitReadable: false,
    defenseModuleIDs: [],
    shieldBoosterModuleIDs: [],
    armorRepairerModuleIDs: [],
    hullRepairerModuleIDs: [],
    weaponModuleIDs: [],
    modules: [],
    droneBay: [],
  });
  const flown = requestForFit(DEFAULT_COMPANION_SETUP, blind);
  assert.deepEqual(companionFitWarnings(flown, blind), []);
});

test("a gun with nothing in it is worth saying, once per count", () => {
  const oneFacts = facts({ modules: [module({ itemID: GUN_A, hasCharge: false })] });
  const one = companionFitWarnings(requestForFit(DEFAULT_COMPANION_SETUP, oneFacts), oneFacts);
  assert.equal(one.length, 1);
  assert.match(one[0]!, /One weapon has nothing loaded/);

  const twoFacts = facts({
    weaponModuleIDs: [GUN_A, GUN_B],
    modules: [
      module({ itemID: GUN_A, hasCharge: false }),
      module({ itemID: GUN_B, hasCharge: false }),
    ],
  });
  const two = companionFitWarnings(requestForFit(DEFAULT_COMPANION_SETUP, twoFacts), twoFacts);
  assert.match(two[0]!, /2 weapons have nothing loaded/);
});

test("a module that takes no charge is never reported as missing one", () => {
  // A hardener has nowhere to load anything. Reporting it would be noise, and
  // noise is how a real warning gets ignored.
  const quietFacts = facts({
    modules: [module({ itemID: HARDENER, takesCharge: false, hasCharge: false })],
  });
  const quiet = companionFitWarnings(requestForFit(DEFAULT_COMPANION_SETUP, quietFacts), quietFacts);
  assert.deepEqual(quiet, []);
});

test("a module whose charge data could not be read is not reported either", () => {
  // ⚠ THE THIRD STATE EARNS ITS KEEP HERE. `chargeFits` is empty both for a
  // module that takes no charge and for a fit whose charge data is missing, so
  // `takesCharge: null` must be treated as "cannot say", never as "yes".
  const unknownFacts = facts({
    modules: [module({ itemID: GUN_A, takesCharge: null, hasCharge: false })],
  });
  const unknown = companionFitWarnings(
    requestForFit(DEFAULT_COMPANION_SETUP, unknownFacts),
    unknownFacts,
  );
  assert.deepEqual(unknown, []);
});

test("a remote repairer with no charge reads as a module, not as a weapon", () => {
  const logiFacts = facts({
    weaponModuleIDs: [],
    remoteArmorModuleIDs: [REMOTE_ARMOR],
    modules: [
      module({ itemID: HARDENER, takesCharge: false }),
      module({ itemID: REMOTE_ARMOR, hasCharge: false }),
    ],
  });
  const logi = companionFitWarnings(requestForFit(DEFAULT_COMPANION_SETUP, logiFacts), logiFacts);
  assert.equal(logi.length, 1);
  assert.match(logi[0]!, /One fitted module has nothing loaded/);
  assert.doesNotMatch(logi[0]!, /weapon/i);
});

// --- drones -------------------------------------------------------------

test("a bay of only wrong-role drones warns; a bay with combat drones does not", () => {
  const wrongRoleFacts = facts({
    droneBay: [droneStack({ typeID: 1, quantity: 5 })], // webifiers, mining -- "other"
    droneBayRoles: NO_DRONE_ROLES,
  });
  assert.ok(
    companionFitWarnings(requestForFit(DEFAULT_COMPANION_SETUP, wrongRoleFacts), wrongRoleFacts).some(
      (line) => /will never launch/i.test(line),
    ),
  );

  const combatFacts = facts({
    droneBay: [droneStack({ typeID: 2, quantity: 5 })],
    droneBayRoles: { ...NO_DRONE_ROLES, combat: [123] },
  });
  assert.ok(
    !companionFitWarnings(requestForFit(DEFAULT_COMPANION_SETUP, combatFacts), combatFacts).some(
      (line) => /never launch/i.test(line),
    ),
  );
});

test("an empty drone bay is not warned about at all", () => {
  // A ship with no drones is a ship doing something else -- not a fault.
  const emptyFacts = facts({ droneBay: [], droneBayRoles: NO_DRONE_ROLES });
  assert.ok(
    !companionFitWarnings(requestForFit(DEFAULT_COMPANION_SETUP, emptyFacts), emptyFacts).some(
      (line) => /drone/i.test(line),
    ),
  );
});

test("a null drone bay warns about nothing, even with wrong-role facts sitting unused", () => {
  // ⚠ NULL IS UNREADABLE, NOT EMPTY -- the distinction decodeDroneBay is built
  // around. An unread bay must not be reported as a wrongly-loaded one.
  const unreadableBay = facts({ droneBay: null, droneBayRoles: NO_DRONE_ROLES });
  assert.ok(
    !companionFitWarnings(
      requestForFit(DEFAULT_COMPANION_SETUP, unreadableBay),
      unreadableBay,
    ).some((line) => /drone/i.test(line)),
  );
});

test("an unresolved drone row silences the warning rather than risking a false one", () => {
  // A stack whose type/group did not resolve might well be a launchable role
  // that failed to classify. Warning anyway would be the exact false confidence
  // the fail-silent rule exists to prevent.
  const unresolvedFacts = facts({
    droneBay: [droneStack({ typeID: 3, quantity: 1 })],
    droneBayRoles: { ...NO_DRONE_ROLES, unknown: [999] },
  });
  assert.ok(
    !companionFitWarnings(requestForFit(DEFAULT_COMPANION_SETUP, unresolvedFacts), unresolvedFacts).some(
      (line) => /drone/i.test(line),
    ),
  );
});

// --- no defence -----------------------------------------------------------

test("the no-defence warning fires when the hull classified no hardener and no repairer", () => {
  const nakedFacts = facts({
    defenseModuleIDs: [],
    shieldBoosterModuleIDs: [],
    armorRepairerModuleIDs: [],
    hullRepairerModuleIDs: [],
    modules: [module({ itemID: GUN_A })],
  });
  assert.ok(
    companionFitWarnings(requestForFit(DEFAULT_COMPANION_SETUP, nakedFacts), nakedFacts).some((line) =>
      /Nothing on this ship defends it/.test(line),
    ),
  );

  // A ship that does have a hardener, even alone, does not trip it.
  assert.ok(
    !companionFitWarnings(requestForFit(DEFAULT_COMPANION_SETUP, facts()), facts()).some((line) =>
      /defends it/.test(line),
    ),
  );
});

test("every warning is plain ASCII", () => {
  // Player-facing, so the repo's plain-ASCII rule applies. Gathered from a fit
  // that trips every branch at once.
  const everythingFacts = facts({
    defenseModuleIDs: [],
    shieldBoosterModuleIDs: [],
    armorRepairerModuleIDs: [],
    hullRepairerModuleIDs: [],
    weaponModuleIDs: [GUN_A, GUN_B],
    remoteArmorModuleIDs: [REMOTE_ARMOR],
    modules: [
      module({ itemID: GUN_A, hasCharge: false }),
      module({ itemID: GUN_B, hasCharge: false }),
      module({ itemID: REMOTE_ARMOR, hasCharge: false }),
    ],
    droneBay: [droneStack({ typeID: 1, quantity: 3 })],
    droneBayRoles: NO_DRONE_ROLES,
  });
  const everything = companionFitWarnings(
    requestForFit(DEFAULT_COMPANION_SETUP, everythingFacts),
    everythingFacts,
  );
  assert.ok(everything.length >= 4, "this fixture should trip several branches");
  for (const line of everything) {
    const offenders = [...line].filter((ch) => (ch.codePointAt(0) ?? 0) > 127);
    assert.deepEqual(offenders, [], `non-ASCII in: ${line}`);
  }
});
