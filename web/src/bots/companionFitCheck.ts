// Fleet companion — reading the ship it is actually in, and saying what is
// missing before it flies.
//
// ⚠ WHY THIS EXISTS AT ALL: A SQUAD HAS NOBODY TO ASK. Every module list on a
// `FleetCompanionRequest` is an `itemID` of one particular fitted module on one
// particular hull, picked by an operator looking at that ship in the fitting
// panel. A squad start has no such operator -- the pilots are not mounted,
// nobody can see their fits, and a list saved earlier would be stale the moment
// that pilot refits or swaps hull. So a squad stores settings (`CompanionSetup`),
// and the bot host, which HAS signed the pilot in and CAN read the fit, fills
// the lists in here. Nothing about a fit is ever saved.
//
// ⚠ THE WARNINGS ARE ADVISORY AND MUST STAY THAT WAY. The operator's own words:
// warn, and let a human either load the missing thing or ignore it and fly.
// Nothing in this module refuses a start. A blocking check here would ground a
// squad over one empty ammo bay.
//
// ⚠ EVERY CHECK FAILS SILENT RATHER THAN LOUD. A fit that cannot be read
// produces NO warnings, not a warning about everything: this module only ever
// speaks when it is confident, because a readout that cries wolf on an
// unreadable fit teaches an operator to ignore it -- and the one time it is
// right is the time they will ignore it too.
//
// PURE. No store, no I/O. The caller hands it plain data read elsewhere -- this
// module cannot itself resolve a drone's typeID to a group name, which is why
// the role split below arrives already computed.

import type {
  CompanionPropulsionModule,
  CompanionSetup,
  CompanionTankLayer,
  FleetCompanionRequest,
} from "../nav/fleetCompanionLoop.ts";
import type { DroneRoleIDs } from "../nav/droneRoles.ts";

/** One module as the classifier judged it, with what it is carrying. */
export interface CompanionFitModule {
  readonly itemID: number;
  readonly typeID: number;
  /** Whether anything is loaded: ammunition, or a script. Same field on the wire. */
  readonly hasCharge: boolean;
  /**
   * Whether this module has somewhere to load a charge at all.
   *
   * ⚠ THREE-STATE, AND THE THIRD IS WHY. `chargeFits` is `{}` both for a module
   * that takes no charge AND for a fit whose charge data could not be read --
   * `decodeChargeFits`'s own comment says so. Null keeps those apart from a
   * confident "this takes a charge", so an unreadable fit stays quiet instead
   * of reporting every module as missing ammunition.
   */
  readonly takesCharge: boolean | null;
}

/** One stack in the drone bay. */
export interface CompanionFitDroneStack {
  readonly typeID: number;
  readonly quantity: number;
}

/** What the ship turned out to be carrying, and what the classifier made of it. */
export interface CompanionFitFacts {
  /** The eight lists, as derived from the hull. */
  readonly defenseModuleIDs: readonly number[];
  readonly shieldBoosterModuleIDs: readonly number[];
  readonly armorRepairerModuleIDs: readonly number[];
  readonly hullRepairerModuleIDs: readonly number[];
  /** The ancillary ones among the three above. See the request's field. */
  readonly ancillaryRepairerModuleIDs?: readonly number[];
  readonly remoteShieldModuleIDs: readonly number[];
  readonly remoteArmorModuleIDs: readonly number[];
  readonly remoteCapacitorModuleIDs: readonly number[];
  readonly weaponModuleIDs: readonly number[];
  /** Fitted salvagers, for the `salvage` chat order. See the request's field. */
  readonly salvagerModuleIDs: readonly number[];
  /** Fitted drone tracking links and navigation computers. See the request's field. */
  readonly droneAssistModuleIDs: readonly number[];
  /**
   * Fitted afterburners/MWDs. Objects rather than ids because stopping one
   * needs its typeID and gating one on a scram needs to know which it is — see
   * the request's `propulsionModules`.
   */
  readonly propulsionModules: readonly CompanionPropulsionModule[];
  /** Every online module the fit carries, for the charge checks. */
  readonly modules: readonly CompanionFitModule[];
  /**
   * Drones in the bay.
   *
   * ⚠ NULL IS UNREADABLE AND `[]` IS CONFIDENTLY EMPTY, which is the same
   * distinction `decodeDroneBay` is built around and states in its own header.
   * An empty bay is NOT warned about here -- see `companionFitWarnings` -- a
   * ship with no drones is a ship doing something else, the same reasoning
   * that already applied when drones were an operator toggle.
   */
  readonly droneBay: readonly CompanionFitDroneStack[] | null;
  /**
   * The same bay, split by launchable role.
   *
   * ⚠ COMPUTED BY THE CALLER, NEVER HERE. Splitting a stack by role means
   * resolving a typeID to an SDE group name (`splitDroneRoles`,
   * `nav/droneRoles.ts`), which is I/O this module deliberately has none of.
   * The caller runs that resolve-then-judge pass once and hands the answer in.
   * Meaningless while `droneBay` is null -- the caller may pass empty lists
   * then, since nothing here reads it in that case.
   */
  readonly droneBayRoles: DroneRoleIDs;
  /**
   * Which layer the hull is built around, for a fit with nothing to cycle.
   *
   * ⚠ THE ONLY FACT HERE THAT IS A VERDICT RATHER THAN A LIST, and it is one
   * because the evidence for it is PASSIVE. Every list above names modules the
   * ladder switches on, so a plate, a coating, an extender or a rig — the things
   * that actually say "this hull expects to be hit in its armour" — can never
   * appear in one. Counting them is the caller's resolve-then-judge pass, the
   * same as `droneBayRoles`; what arrives here is the answer.
   *
   * `null` is "the fit did not say": no tank modules at all, or one of each.
   */
  readonly tankLayer: CompanionTankLayer | null;
  /** False when the fit itself could not be read; nothing is judged then. */
  readonly fitReadable: boolean;
}

/**
 * The request this pilot will actually fly: the setup's six stored fields
 * carried through untouched, and the eight module lists always read off the
 * hull.
 *
 * ⚠ THE HULL IS THE ONLY AUTHORITY, AND THERE IS NO OTHER PATH TO CHOOSE
 * BETWEEN ANY MORE. A squad start has no operator looking at the ship in front
 * of it, and a list saved earlier would describe whatever hull an operator was
 * looking at when they last touched this squad's settings -- stale the moment
 * this pilot refits or swaps hull, with nobody watching to notice. This used to
 * be conditional on `deriveModulesFromFit`, a flag choosing between this and a
 * hand-picked alternative; the alternative is gone
 * (docs/fleet-companion-simplification.md), so there is nothing left to choose
 * between and this function is now total.
 */
export function requestForFit(
  setup: CompanionSetup,
  facts: CompanionFitFacts,
): FleetCompanionRequest {
  return {
    ...setup,
    defenseModuleIDs: [...facts.defenseModuleIDs],
    shieldBoosterModuleIDs: [...facts.shieldBoosterModuleIDs],
    armorRepairerModuleIDs: [...facts.armorRepairerModuleIDs],
    hullRepairerModuleIDs: [...facts.hullRepairerModuleIDs],
    ...(facts.ancillaryRepairerModuleIDs === undefined
      ? {}
      : { ancillaryRepairerModuleIDs: [...facts.ancillaryRepairerModuleIDs] }),
    remoteShieldModuleIDs: [...facts.remoteShieldModuleIDs],
    remoteArmorModuleIDs: [...facts.remoteArmorModuleIDs],
    remoteCapacitorModuleIDs: [...facts.remoteCapacitorModuleIDs],
    weaponModuleIDs: [...facts.weaponModuleIDs],
    salvagerModuleIDs: [...facts.salvagerModuleIDs],
    droneAssistModuleIDs: [...facts.droneAssistModuleIDs],
    propulsionModules: [...facts.propulsionModules],
    tankLayer: facts.tankLayer,
  };
}

/**
 * What is missing or unusable about this pilot's fit, in the player's words.
 *
 * ⚠ TAKES THE DERIVED REQUEST -- the one `requestForFit` already produced --
 * because its eight lists ARE what this run will actually cycle. There is no
 * flag any more and so nothing left to choose between a hand-picked set and the
 * hull's own; the request's lists are the hull's own.
 *
 * Empty means nothing worth saying -- which is also what an unreadable fit
 * gives, deliberately (see the header).
 */
export function companionFitWarnings(
  request: FleetCompanionRequest,
  facts: CompanionFitFacts,
): readonly string[] {
  if (!facts.fitReadable) {
    return [];
  }
  const warnings: string[] = [];
  const byID = new Map(facts.modules.map((module) => [module.itemID, module]));

  const unloaded = (ids: readonly number[]): number =>
    ids.filter((id) => {
      const module = byID.get(id);
      return module !== undefined && module.takesCharge === true && !module.hasCharge;
    }).length;

  const gunsUnloaded = unloaded(request.weaponModuleIDs);
  if (gunsUnloaded > 0) {
    warnings.push(
      gunsUnloaded === 1
        ? "One weapon has nothing loaded. It will not fire until you load it."
        : `${gunsUnloaded} weapons have nothing loaded. They will not fire until you load them.`,
    );
  }

  // Everything that is not a weapon but still wants something in it: a script
  // in a tracking computer, a charge in an ancillary repairer. Counted together
  // because the fit read cannot tell a script from a round -- they are the same
  // field on the wire -- so naming one would be a guess.
  const others = [
    ...request.defenseModuleIDs,
    ...request.shieldBoosterModuleIDs,
    ...request.armorRepairerModuleIDs,
    ...request.hullRepairerModuleIDs,
    ...request.remoteShieldModuleIDs,
    ...request.remoteArmorModuleIDs,
    ...request.remoteCapacitorModuleIDs,
  ];
  const othersUnloaded = unloaded(others);
  if (othersUnloaded > 0) {
    warnings.push(
      othersUnloaded === 1
        ? "One fitted module has nothing loaded in it - it may want a script or a charge."
        : `${othersUnloaded} fitted modules have nothing loaded in them - they may want scripts or charges.`,
    );
  }

  // ⚠ ONLY WHEN THE BAY HOLDS NOTHING THIS COMPANION CAN LAUNCH. There is no
  // "use drones" setting any more -- a companion launches whatever it has, in
  // whatever role it can (`nav/droneRoles.ts`: combat, logistic, salvage). An
  // EMPTY bay is not warned about at all: a ship with no drones is a ship doing
  // something else, the same reasoning that already excused it when drones were
  // a toggle. What IS worth a warning is a bay that is not empty and still
  // launches nothing, because that is not a choice anybody made on purpose --
  // it is webifier, neutralizer, mining or EW drones sitting where combat,
  // logistic or salvage drones belong.
  //
  // ⚠ SILENT WHENEVER A ROW COULD NOT BE RESOLVED. `droneBayRoles.unknown`
  // holds stacks whose type or group did not resolve, and an unresolved stack
  // might well be a launchable role that failed to classify. Warning anyway
  // would risk telling an operator their combat drones are useless because a
  // name lookup timed out -- exactly the false confidence the header's
  // fail-silent rule exists to prevent.
  if (facts.droneBay !== null) {
    const carried = facts.droneBay.reduce((total, stack) => total + stack.quantity, 0);
    const launchable =
      facts.droneBayRoles.combat.length +
      facts.droneBayRoles.logistic.length +
      facts.droneBayRoles.salvage.length;
    if (carried > 0 && launchable === 0 && facts.droneBayRoles.unknown.length === 0) {
      warnings.push(
        "The drone bay holds drones this companion will never launch - only combat, logistic and salvage drones are ever used.",
      );
    }
  }

  if (
    facts.defenseModuleIDs.length === 0 &&
    facts.shieldBoosterModuleIDs.length === 0 &&
    facts.armorRepairerModuleIDs.length === 0 &&
    facts.hullRepairerModuleIDs.length === 0
  ) {
    warnings.push("Nothing on this ship defends it - no hardener and no repairer was found.");
  }

  return warnings;
}
