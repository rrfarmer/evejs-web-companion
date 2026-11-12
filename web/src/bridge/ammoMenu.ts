// A charge-taking module's ammunition menu on the rack, as the client's dogma location makes it
// (clientDogmaLocation.GetAmmoMenu, 123 to 157; shipmodulebutton.GetMenu, 452 to 464).
//
//   what is offered       GetMatchingAmmo (91 to 103): the ship's cargo alone (List(flagCargo)), a charge the pilot
//                         lacks a skill for left out (GetMissingSkills), and one the launcher takes
//                         (ammoloadingUtils.IsChargeCompatibleWithLauncher: its group among the launcher's charge
//                         groups, and the size the launcher asks, or, where it asks none, room for one), by type,
//                         singletons apart from stacks
//   in what order         GetSortedCharges (159 to 192): by the reach each charge gives, farthest first, then by name;
//                         those that give none after, by name (localization.util.Sort)
//   how many at least     the bank's (len(GetModulesInBank)), else one: a kind held in fewer is not offered
//   the menu              the type last used, where there is room to reload (GetChargeReloadInfo): Reload used and
//                         Reload, and then Reload all; Unload to Cargo where a charge is loaded and not reloading; the
//                         other types, Used and their quantities (AddToMenuFromAmmoInfo, 105 to 121)
//
// Not done: the menu entries' damage-type views (_FindNumDamageTypes, AmmoMenuEntryView), Unload to Ammo Hold (a flag
// cruiser's, or a structure's), and the menu's other entries (auto-reload, auto-repeat, online, overload).

import type { DogmaStatic } from "./dogma/location.ts";

/** dogma/data.py get_charge_group_attribute_ids: the attributes named chargeGroup1 to chargeGroup5. */
export const CHARGE_GROUP_ATTRIBUTES: readonly number[] = [604, 605, 606, 609, 610];
/** dogma/const.py: chargeSize, capacity, volume, maxRange, falloff, weaponRangeMultiplier, fallofMultiplier, explosionDelay, maxVelocity. */
export const ATTRIBUTE = Object.freeze({
  CHARGE_SIZE: 128, CAPACITY: 38, VOLUME: 161, MAX_RANGE: 54, FALLOFF: 158, WEAPON_RANGE_MULTIPLIER: 120,
  FALLOFF_MULTIPLIER: 517, EXPLOSION_DELAY: 281, MAX_VELOCITY: 37,
});
/** Every static attribute the menu reads, for a type or a module. */
export const AMMO_MENU_ATTRIBUTES: readonly number[] = [...CHARGE_GROUP_ATTRIBUTES, ...Object.values(ATTRIBUTE)];

/** baseDogmaStaticSvc.GetTypeAttribute2: the type's attribute, else the attribute's default. */
function typeAttribute2(staticData: DogmaStatic, typeID: number, attributeID: number): number {
  const listed = staticData.types[typeID]?.attributes.find(([id]) => id === attributeID)?.[1];
  if (listed !== undefined && listed !== null) return listed;
  return staticData.attributes[attributeID]?.defaultValue ?? 0;
}

/** GetTypeAttribute(typeID, attributeID, default): the type's attribute, else the default given. */
function typeAttribute(staticData: DogmaStatic, typeID: number, attributeID: number, fallback: number | null = null): number | null {
  const listed = staticData.types[typeID]?.attributes.find(([id]) => id === attributeID)?.[1];
  return listed !== undefined && listed !== null ? listed : fallback;
}

/** ammoloadingUtils.IsChargeCompatibleWithLauncher (39 to 46). */
export function isChargeCompatibleWithLauncher(staticData: DogmaStatic, ammoTypeID: number, ammoGroupID: number | null, moduleTypeID: number): boolean {
  const groups = new Set<number>();
  for (const attributeID of CHARGE_GROUP_ATTRIBUTES) {
    const group = typeAttribute2(staticData, moduleTypeID, attributeID);
    if (group > 0) groups.add(Math.trunc(group));
  }
  if (ammoGroupID === null || !groups.has(ammoGroupID)) return false;
  const requiredChargeSize = typeAttribute2(staticData, moduleTypeID, ATTRIBUTE.CHARGE_SIZE);
  if (requiredChargeSize && requiredChargeSize === typeAttribute2(staticData, ammoTypeID, ATTRIBUTE.CHARGE_SIZE)) return true;
  // GetModuleCapacityForAmmoType: int(capacity / volume + 1e-07).
  if (!requiredChargeSize) {
    const volume = typeAttribute2(staticData, ammoTypeID, ATTRIBUTE.VOLUME);
    if (volume > 0 && Math.trunc(typeAttribute2(staticData, moduleTypeID, ATTRIBUTE.CAPACITY) / volume + 1e-7) > 0) return true;
  }
  return false;
}

/** fittingSlotController GetChargeCapacity's used over capacity: the loaded charges' volume over the module's capacity (1 where it has none). */
export function chargePortion(staticData: DogmaStatic, moduleTypeID: number, chargeTypeID: number, chargeQuantity: number): number {
  const capacity = typeAttribute2(staticData, moduleTypeID, ATTRIBUTE.CAPACITY);
  if (!(capacity > 0)) return 1;
  return (typeAttribute2(staticData, chargeTypeID, ATTRIBUTE.VOLUME) * chargeQuantity) / capacity;
}

/** shipmodulebutton.GetChargeReloadInfo's room: int(capacity / the charge's volume - what is loaded + 1e-07), nought for no charge type. */
export function roomForReload(staticData: DogmaStatic, moduleTypeID: number, chargeTypeID: number | null, chargeQuantity: number): number {
  if (chargeTypeID === null) return 0;
  const volume = typeAttribute2(staticData, chargeTypeID, ATTRIBUTE.VOLUME);
  if (!(volume > 0)) return 0;
  return Math.trunc(typeAttribute2(staticData, moduleTypeID, ATTRIBUTE.CAPACITY) / volume - chargeQuantity + 1e-7);
}

/** localization.util.Sort by name (GetSortFunc): the collator on the names in lower case, then the names as they are, the other way about. */
function byName(nameOf: (typeID: number) => string): (left: number, right: number) => number {
  const collator = new Intl.Collator("en");
  return (left, right) => {
    const [a, b] = [nameOf(left), nameOf(right)];
    return collator.compare(a.toLowerCase(), b.toLowerCase()) || collator.compare(b, a);
  };
}

/** Python 2's comparison of two unicode strings: by code point. */
const codePointCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * GetSortedCharges (159 to 192): the module's reach as the dogma location has it now (GetAccurateAttributeValue: its
 * maxRange and falloff, each over the loaded charge's multiplier where one is loaded), and for each charge type the
 * reach it gives: its falloff multiplier (one where it has none) times the falloff and its range multiplier times the
 * range, or for one with no range multiplier its flight (explosionDelay times maxVelocity, over a thousand). Those that
 * give a reach by it, farthest first, then by name (SortListOfTuples on (-reach, name)); the rest after, by name.
 */
export function sortedCharges(
  staticData: DogmaStatic,
  typeIDs: readonly number[],
  module: { readonly maxRange: number | null; readonly falloff: number | null },
  existingCharge: { readonly rangeMultiplier: number | null; readonly falloffMultiplier: number | null } | null,
  nameOf: (typeID: number) => string,
): number[] {
  let range = module.maxRange ?? 0;
  let falloff = module.falloff ?? 0;
  if (range && existingCharge) {
    if (existingCharge.rangeMultiplier) range /= existingCharge.rangeMultiplier;
    if (existingCharge.falloffMultiplier) falloff /= existingCharge.falloffMultiplier;
  }
  const withReach: { readonly reach: number; readonly name: string; readonly typeID: number }[] = [];
  const rest: number[] = [];
  for (const typeID of typeIDs) {
    let reach: number | null = null;
    const rangeMultiplier = typeAttribute(staticData, typeID, ATTRIBUTE.WEAPON_RANGE_MULTIPLIER);
    if (rangeMultiplier) {
      reach = (typeAttribute(staticData, typeID, ATTRIBUTE.FALLOFF_MULTIPLIER, 1) ?? 1) * falloff + rangeMultiplier * range;
    } else {
      const flightTime = typeAttribute(staticData, typeID, ATTRIBUTE.EXPLOSION_DELAY);
      if (flightTime) reach = (flightTime * (typeAttribute(staticData, typeID, ATTRIBUTE.MAX_VELOCITY) ?? 0)) / 1000;
    }
    if (reach) withReach.push({ reach, name: nameOf(typeID), typeID });
    else rest.push(typeID);
  }
  withReach.sort((a, b) => b.reach - a.reach || codePointCompare(a.name, b.name));
  return [...withReach.map((entry) => entry.typeID), ...[...rest].sort(byName(nameOf))];
}

/** A charge in the cargo, as the menu takes it. */
export interface CargoCharge {
  readonly itemID: number;
  readonly typeID: number;
  readonly groupID: number | null;
  /** A singleton's stack is one. */
  readonly stacksize: number;
  readonly singleton: boolean;
}

/** One entry of the menu. */
export type AmmoMenuEntry =
  | {
      readonly kind: "load";
      readonly typeID: number;
      /** The stacks given to LoadChargesToModule: the kind's singletons, or its stacks. */
      readonly itemIDs: readonly number[];
      readonly sumqty: number;
      /** ReloadUsed, Reload, AmmoTypeAndStatus or AmmoTypeAndQuantity (UI/Inflight/ModuleRacks/). */
      readonly label: string;
    }
  | { readonly kind: "reloadAll"; readonly label: string }
  | { readonly kind: "unload"; readonly label: string };

/** GetAmmoMenu's inputs: what the module holds and last held, and what the dogma location and the static data say. */
export interface AmmoMenuInput {
  readonly moduleTypeID: number;
  /** The charge loaded (existingCharge), with its accurate multipliers for the sort. */
  readonly charge: { readonly typeID: number; readonly quantity: number; readonly rangeMultiplier: number | null; readonly falloffMultiplier: number | null } | null;
  /** godma's GetAmmoTypeForModule: the type last loaded in it, or null. */
  readonly usedChargeTypeID: number | null;
  /** godma's IsModuleReloading. */
  readonly reloading: boolean;
  /** len(GetModulesInBank), one where it is in none. */
  readonly bankCount: number;
  /** The module's accurate maxRange and falloff. */
  readonly module: { readonly maxRange: number | null; readonly falloff: number | null };
  readonly cargo: readonly CargoCharge[];
  /** GetMissingSkills(typeID) is empty. */
  readonly usable: (typeID: number) => boolean;
  readonly nameOf: (typeID: number) => string;
}

const LABEL = "UI/Inflight/ModuleRacks/";

/** AddToMenuFromAmmoInfo (105 to 121): the singletons, then the stacks, each where at least the bank's count is held. */
function entriesOf(typeID: number, info: { singletons: CargoCharge[]; nonSingletons: CargoCharge[] }, minimum: number, labels: readonly [string, string]): AmmoMenuEntry[] {
  const entries: AmmoMenuEntry[] = [];
  const singles = info.singletons.reduce((sum, item) => sum + item.stacksize, 0);
  if (singles >= minimum && info.singletons.length > 0) {
    entries.push({ kind: "load", typeID, itemIDs: info.singletons.map((item) => item.itemID), sumqty: singles, label: LABEL + labels[0] });
  }
  const stacked = info.nonSingletons.reduce((sum, item) => sum + item.stacksize, 0);
  if (stacked >= minimum && info.nonSingletons.length > 0) {
    entries.push({ kind: "load", typeID, itemIDs: info.nonSingletons.map((item) => item.itemID), sumqty: stacked, label: LABEL + labels[1] });
  }
  return entries;
}

/** GetAmmoMenu (123 to 157), for the ship flown, not a structure. */
export function ammoMenu(staticData: DogmaStatic, input: AmmoMenuInput): readonly AmmoMenuEntry[] {
  // GetMatchingAmmo: by type in the order the cargo lists them first.
  const byType = new Map<number, { singletons: CargoCharge[]; nonSingletons: CargoCharge[] }>();
  for (const item of input.cargo) {
    if (!input.usable(item.typeID)) continue;
    if (!isChargeCompatibleWithLauncher(staticData, item.typeID, item.groupID, input.moduleTypeID)) continue;
    if (!byType.has(item.typeID)) byType.set(item.typeID, { singletons: [], nonSingletons: [] });
    (item.singleton ? byType.get(item.typeID)!.singletons : byType.get(item.typeID)!.nonSingletons).push(item);
  }
  const sorted = sortedCharges(staticData, [...byType.keys()], input.module, input.charge, input.nameOf);
  const minimum = Math.max(1, input.bankCount);
  const used = input.usedChargeTypeID;
  // GetChargeReloadInfo: the loaded charge's type and count, else the last used type with none.
  const reloadType = input.charge?.typeID ?? used;
  const room = roomForReload(staticData, input.moduleTypeID, reloadType, input.charge?.quantity ?? 0);
  const menu: AmmoMenuEntry[] = [];
  if (used !== null && byType.has(used) && room) {
    const items = entriesOf(used, byType.get(used)!, minimum, ["ReloadUsed", "Reload"]);
    if (items.length > 0) {
      menu.push(...items);
      menu.push({ kind: "reloadAll", label: LABEL + "ReloadAll" });
    }
  }
  if (input.charge && !input.reloading) menu.push({ kind: "unload", label: LABEL + "UnloadToCargo" });
  for (const typeID of sorted) {
    if (typeID === used) continue;
    menu.push(...entriesOf(typeID, byType.get(typeID)!, minimum, ["AmmoTypeAndStatus", "AmmoTypeAndQuantity"]));
  }
  return menu;
}
