// Which fitted modules salvage and which tractor, by the game's own group names ("Salvager", "Tractor Beam"),
// and how far each reaches. Pure: the caller hands in the fitting slots, a group-name lookup and (optionally) a
// range lookup, the same inputs flow.ts's resolveSalvageModuleIDs reads from its stores.
//
// The judging is the one resolveSalvageModuleIDs makes: a HIGH slot, ONLINE, whose group name matches. An
// unresolved group name (null) is never a match, so a module whose name has not been fetched yet is simply
// not listed until it has.

import type { FittingSlot } from "../store/types.ts";

/** Dogma attribute 54, maxRange: the reach of a tractor beam or salvager, ship and skill bonuses included. */
export const ATTRIBUTE_MAX_RANGE = 54;

export interface FittedReachModule {
  readonly moduleID: number;
  readonly typeID: number;
  /** Metres, or null when it could not be read (never guessed). */
  readonly rangeM: number | null;
}

export interface SalvageModules {
  readonly tractors: readonly FittedReachModule[];
  readonly salvagers: readonly FittedReachModule[];
}

export const NO_SALVAGE_MODULES: SalvageModules = Object.freeze({ tractors: Object.freeze([]), salvagers: Object.freeze([]) });

const SALVAGER_GROUP = /salvager/i;
// "Tractor Beam" only: the Mobile Tractor Unit is a deployable, never a fitted module.
const TRACTOR_GROUP = /tractor beam/i;

export function isSalvagerGroup(groupName: string | null): boolean {
  return groupName !== null && SALVAGER_GROUP.test(groupName);
}

export function isTractorBeamGroup(groupName: string | null): boolean {
  return groupName !== null && TRACTOR_GROUP.test(groupName);
}

/**
 * The fitted salvagers and tractor beams. `slots` null (fit unreadable) gives none. `rangeOf` answers a module's
 * reach in metres or null; omit it and every range is null.
 */
export function classifySalvageModules(
  slots: readonly FittingSlot[] | null,
  groupOf: (typeID: number) => string | null,
  rangeOf?: (moduleID: number, typeID: number) => number | null,
): SalvageModules {
  if (slots === null) return NO_SALVAGE_MODULES;
  const tractors: FittedReachModule[] = [];
  const salvagers: FittedReachModule[] = [];
  for (const slot of slots) {
    const module = slot.module;
    if (slot.family !== "high" || module === null || !module.online) continue;
    const group = groupOf(module.typeID);
    const tractor = isTractorBeamGroup(group);
    const salvager = !tractor && isSalvagerGroup(group);
    if (!tractor && !salvager) continue;
    const raw = rangeOf ? rangeOf(module.itemID, module.typeID) : null;
    const rangeM = raw !== null && Number.isFinite(raw) && raw >= 0 ? raw : null;
    (tractor ? tractors : salvagers).push({ moduleID: module.itemID, typeID: module.typeID, rangeM });
  }
  return { tractors, salvagers };
}

/** The structural slice of a GetAllInfo item row this reads (see bridge/boundDogma.ts BoundDogmaItem). */
export interface DogmaItemRow {
  readonly itemID: number | string | bigint;
  readonly typeID: number;
  readonly locationID: number | string | bigint;
  readonly attributes: readonly { readonly attributeID: number; readonly value: unknown }[];
}

/**
 * A `rangeOf` over the pilot's own dogma: attribute 54 of the row matching the module's id and type, located in
 * the ship. Null for no matching row or no finite attribute. Same match miningSupportCapabilities makes.
 */
export function maxRangeFromDogma(
  ships: readonly DogmaItemRow[] | null,
  shipID: number,
): (moduleID: number, typeID: number) => number | null {
  return (moduleID, typeID) => {
    const row = ships?.find(item => Number(item.itemID) === moduleID && item.typeID === typeID && Number(item.locationID) === shipID);
    const value = row?.attributes.find(attribute => attribute.attributeID === ATTRIBUTE_MAX_RANGE)?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
}

/** The tractors in reach of a wreck `surfaceDistanceM` away, nearest-reaching last, unknown reach excluded. */
export function tractorsInReach(modules: SalvageModules, surfaceDistanceM: number): readonly FittedReachModule[] {
  return modules.tractors
    .filter(m => m.rangeM !== null && surfaceDistanceM <= m.rangeM)
    .sort((a, b) => b.rangeM! - a.rangeM! || a.moduleID - b.moduleID);
}
