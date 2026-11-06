// Which layer a hull is BUILT to be hit in, read off the group names of what it
// is carrying.
//
// ⚠ WHY THIS EXISTS: A BUFFER FIT CYCLES NOTHING, SO IT SAYS NOTHING. Every
// other answer the companion has about a ship's tank comes from a list of
// modules it can switch on -- `shieldBoosterModuleIDs`, `armorRepairerModuleIDs`
// -- and those lists are the strongest possible statement, which is why
// `tankHealth` (nav/fleetCompanionLoop.ts) asks them first and only reaches this
// module when they are all empty. A brick makes no such statement: plates,
// coatings, membranes, extenders and rigs are PASSIVE, so they can never appear
// in a list of things to activate, and before this a plated hull with no
// repairer fell back to the worst-layer fold -- which means fleeing over a
// shield that was never its tank.
//
// ⚠ SO THIS IS THE ONE CLASSIFIER IN THE COMPANION THAT WANTS PASSIVE MODULES,
// and that inverts the rule its neighbours follow (`resolveDefenseModuleIDs`
// drops anything without a dogma-73 cycle, because a passive module in an
// activation list is a call wasted every tick). Nothing here is ever activated.
// It is evidence about intent, and on a brick ALL of the evidence is passive.
//
// PURE, and over GROUP NAMES rather than type ids — the same resolve-then-judge
// shape `splitDroneRoles` (nav/droneRoles.ts) uses, for the same reason: asking
// the game what a type IS belongs to the caller, and deciding what the answer
// MEANS belongs here, where it can be tested without a store.

import type { CompanionTankLayer } from "./fleetCompanionLoop.ts";

/**
 * Group names that say "this hull expects to be hit in its shield".
 *
 * ⚠ ANCHORED, for a reason this codebase has already paid for once. An
 * unanchored `/shield/` sweeps in "Remote Shield Booster" (somebody else's tank,
 * and the exact bug `resolveDefenseModuleIDs`'s own comment warns about) and
 * "Shield Command Burst" (the fleet's tank, not this hull's).
 *
 * Verified against the SDE (`groups.jsonl`, category 7 unless noted): 38 Shield
 * Extender, 39 Shield Recharger, 57 Shield Power Relay, 77 Shield Hardener, 295
 * Shield Resistance Amplifier, 338 Shield Boost Amplifier, 1700 Flex Shield
 * Hardener, 1722 Shield Resistance Shift Hardener, 774 Rig Shield.
 */
const SHIELD_TANK_GROUP =
  /^(flex )?shield (extender|recharger|power relay|hardener|boost amplifier|resistance (amplifier|shift hardener))$|^rig shield$/i;

/**
 * And in its armour: 98 Armor Coating, 326 Energized Armor Membrane, 328 Armor
 * Hardener, 329 Armor Plate, 1150 Armor Resistance Shift Hardener, 1699 Flex
 * Armor Hardener, 773 Rig Armor.
 */
const ARMOR_TANK_GROUP =
  /^(flex )?armor (plate|coating|hardener|resistance (plating|shift hardener))$|^energized armor membrane$|^rig armor$/i;

/**
 * ⚠ WHAT DELIBERATELY DOES NOT VOTE, because each of these would be noise
 * rather than evidence:
 *
 *   • A DAMAGE CONTROL (group 60). It hardens shield, armour AND hull at once,
 *     so it is evidence for neither side — and it is close to the most common
 *     module in the game, so letting it vote would drown every honest signal on
 *     every fit that carries one.
 *   • Anything REMOTE. A remote repairer is this hull's contribution to somebody
 *     else's tank; it says nothing about where this one keeps its own.
 *   • Anything STRUCTURE-*. Those groups are for citadels, and a fit cannot hold
 *     one — the guard is here because the names read alike and the cost of being
 *     wrong is a silent miscount.
 *   • The self-repairers themselves (Shield Booster, Armor Repair Unit). Not
 *     because they are poor evidence — they are the BEST evidence — but because
 *     `tankHealth` has already decided on them before it asks this module
 *     anything. Counting them here would be a second, weaker answer to a
 *     question that already has a stronger one.
 */
const NEVER_VOTES = /remote|structure|damage control/i;

/**
 * The hull's own answer, or `null` when it did not give one.
 *
 * ⚠ A TIE IS `null`, NOT A COIN TOSS. A shield extender in the mids over a plate
 * in the lows is a real (if unhappy) fit, and a hull that is building both tanks
 * has genuinely not said which one matters. `null` sends the caller back to the
 * worst-layer fold, which is the honest answer for a ship that does not say —
 * and is exactly the behaviour every fit had before this module existed, so the
 * failure mode of an unrecognised group name is "no worse than before".
 *
 * Takes group names as the caller resolved them; `null` entries (a type whose
 * group could not be resolved) simply do not vote.
 */
export function voteTankLayer(groupNames: Iterable<string | null>): CompanionTankLayer | null {
  let shield = 0;
  let armor = 0;
  for (const raw of groupNames) {
    if (raw === null) {
      continue;
    }
    const group = raw.trim();
    if (group === "" || NEVER_VOTES.test(group)) {
      continue;
    }
    if (SHIELD_TANK_GROUP.test(group)) {
      shield += 1;
    } else if (ARMOR_TANK_GROUP.test(group)) {
      armor += 1;
    }
  }
  if (shield === armor) {
    return null;
  }
  return shield > armor ? "shield" : "armor";
}
