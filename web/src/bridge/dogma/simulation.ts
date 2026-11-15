// Simulate Fitting of the pilot's own ship (eve/client/script/ui/shared/fittingScreen/ghostFittingSvc.py
// LoadCurrentShip and _LoadSimulatedShipFromData; shipfitting/droneUtil.py SelectedDroneTracker), on the page's own
// dogma location (location.ts):
//
//   the ship             a ghost of its hull with the pilot's brain (LoadMyShip: loadSimulatedShip), no instance rows
//   its modules          fitted in their slots, the highest slot first (fitData.sort), then the rigs activated, every
//                        module online, then every module activated (_ActivateOnLoading: moduleStates.ts)
//   its drones           each one fitted alone while the drone bay has room for it (FitADroneToShip,
//                        FitItemOrDroneToShip: GetCapacity, each drone's volume), then selected the most damage
//                        first (RegisterTopDpsDrones, GetDronesInDamgeAmountOrder: the damage multiplier times the sum
//                        of its distinct damages) while fewer than max(5, the pilot's maxActiveDrones) are and the
//                        bandwidth lasts (RegisterDroneAsActive)
//   its charges          loaded in their modules' slots after (FitAmmoList)
//
// The drones' figures are droneUtil's with the selected drones (the Fitting window's GetActiveDrones), and the most
// that may be active is max(5, the pilot's maxActiveDrones) (FittingDogmaLocation.GetMaxActiveDrones).

import { activeDroneBandwidth, activeDroneDps, type DroneReading } from "./drones.ts";
import { academyChargeAllowed } from "./chargeCompatibility.ts";
import { loadSimulatedShip, type Brain, type DogmaItem, type DogmaLocation, type DogmaStatic, type SimulatedCharge } from "./location.ts";
import { ACTIVE, activateOnLoading, eatingFitErrors, OFFLINE, offlineSlots, ONLINE, setModuleState } from "./moduleStates.ts";
import { intDictOrder } from "../py27DictOrder.ts";
import type { PyNumber } from "../pyNumbers.ts";
import { ATTRIBUTE_FIGHTER_CAPACITY, ATTRIBUTE_FIGHTER_TUBES, FIGHTER_TUBE_FLAGS, FLAG_FIGHTER_BAY, TUBE_COUNT_ATTRIBUTE_BY_CLASS, fighterClass, fightersInTubes, maxSquadronSize } from "./fighters.ts";

const ATTRIBUTE_VOLUME = 161;
const ATTRIBUTE_DRONE_CAPACITY = 283;
const ATTRIBUTE_DRONE_BANDWIDTH_USED = 1272;
const ATTRIBUTE_MAX_ACTIVE_DRONES = 352;
const ATTRIBUTE_DAMAGE_MULTIPLIER = 64;
/** EM, thermal, kinetic, explosive. */
const DAMAGE_ATTRIBUTES = [114, 118, 117, 116] as const;

/**
 * A simulated ship: its location, hull and pilot, the drones selected (SelectedDroneTracker), each with how many, and
 * whether it has been changed since it was loaded (simulationChanged: FlagSimulationChanged on a fit or an unfit).
 */
export interface SimulatedShip {
  readonly location: DogmaLocation;
  readonly ship: DogmaItem;
  readonly pilot: DogmaItem;
  readonly selectedDrones: Map<DogmaItem, number>;
  /**
   * Its cargo hold (FittingDogmaLocation.GetHoldItems(flagCargo)): each type in it and how many, one item of each type
   * (FitAnItemToHold adds to the one there), in the order they were put in.
   */
  readonly cargo: Map<number, number>;
  changed: boolean;
  /** How many ghost items it has made (GhostFittingDataObject's keys). */
  ghosts: number;
}

/** What the hold's rules go by that the static data does not hold: a dynamic type (an Abyssal one), the type lists. */
export interface HoldFacts {
  readonly dynamic: (typeID: number) => boolean;
  readonly lists: (typeID: number) => ReadonlySet<number>;
}

/** fittingDogmaLocation.MAX_CARGO: a structure's simulated cargo hold. */
const MAX_CARGO = 2000000000;
/** itemPickerMenu.allowedCategories: what a simulated hold takes at all (IsAllowedToAddAtAll). */
const ALLOWED_HOLD_CATEGORIES: ReadonlySet<number> = new Set([5, 34, 30, 25, 9, 8, 17, 35, 22, 18, 20, 4, 7, 43, 41, 42, 6, 91, 16, 39, 66, 32, 63, 87]);
/** itemPickerMenu VALID_CHARGE_CATEGORIES, VALID_MODULE_CATEGORIES, VALID_CHARGE_GROUPS; the two type lists. */
const VALID_CARGO_CATEGORIES: ReadonlySet<number> = new Set([8, 20, 7, 32]);
const GROUP_ICE_PRODUCT = 423;
const TYPE_LIST_FILAMENTS = 324;
const TYPE_LIST_OTHER_CARGO_HOLD_TYPES = 518;

/**
 * FittingDogmaLocation.GetCapacity(shipID, None, flagCargo) (452 to 477): the cargo hold's capacity (a structure's
 * MAX_CARGO), and what its items take, each its stacksize times its volume.
 */
export function simulatedCargoCapacity(simulation: SimulatedShip): { readonly capacity: number; readonly used: number } {
  const { location, ship } = simulation;
  const capacity = ship.categoryID === CATEGORY_STRUCTURE ? MAX_CARGO : location.value(ship, ATTRIBUTE_CAPACITY);
  let used = 0;
  for (const [typeID, quantity] of simulation.cargo) used += quantity * typeAttribute(location, typeID, ATTRIBUTE_VOLUME);
  return { capacity, used };
}

/**
 * itemPickerMenu.GetMaxQty (469 to 488): how many of the types together the hold has room for (its room left over
 * their volumes added up); null where it has room for none of any of them.
 */
export function simulatedCargoRoomFor(simulation: SimulatedShip, typeIDs: readonly number[]): number | null {
  const { capacity, used } = simulatedCargoCapacity(simulation);
  const volumeLeft = capacity - used;
  let maxQtyForType = 0;
  let allTypeVol = 0;
  for (const typeID of typeIDs) {
    const typeVolume = typeAttribute(simulation.location, typeID, ATTRIBUTE_VOLUME);
    allTypeVol += typeVolume;
    maxQtyForType = Math.max(maxQtyForType, Math.trunc(volumeLeft / typeVolume));
  }
  const maxQty = allTypeVol ? volumeLeft / allTypeVol : 0;
  return maxQtyForType ? Math.trunc(maxQty) : null;
}

/** itemPickerMenu.IsValidForHold (538 to 555), for the cargo hold: what a fitting keeps in it. */
function isValidForCargo(simulation: SimulatedShip, typeID: number, facts: HoldFacts): boolean {
  const type = simulation.location.static.types[typeID];
  if (type?.categoryID != null && VALID_CARGO_CATEGORIES.has(type.categoryID)) return true;
  if (type?.groupID === GROUP_ICE_PRODUCT) return true;
  const lists = facts.lists(typeID);
  return lists.has(TYPE_LIST_FILAMENTS) || lists.has(TYPE_LIST_OTHER_CARGO_HOLD_TYPES);
}

/**
 * ghostFittingSvc.FitAnItemToHold (170 to 183) for the cargo hold: to the type's stack there as many more as the hold
 * has room for (GetMaxQty), nothing where none; else a stack of it where the hold has room for all of it
 * (FitItemOrDroneToShip: the type's volume, 265 to 276), the simulation then changed. Answers whether it was put in, and
 * whether it is a type a fitting does not keep there (IsValidForHold: ItemAddedNotInFitting is the caller's to say).
 */
function fitItemToCargo(simulation: SimulatedShip, typeID: number, qty: number, facts: HoldFacts): { readonly added: boolean; readonly notInFitting: boolean } {
  const held = simulation.cargo.get(typeID);
  let added: boolean;
  if (held !== undefined) {
    const more = Math.min(qty, simulatedCargoRoomFor(simulation, [typeID]) ?? 0);
    if (!more) return { added: true, notInFitting: false };
    simulation.cargo.set(typeID, held + more);
    added = true;
  } else {
    const { capacity, used } = simulatedCargoCapacity(simulation);
    added = used + typeAttribute(simulation.location, typeID, ATTRIBUTE_VOLUME) * qty <= capacity;
    if (added) {
      simulation.cargo.set(typeID, qty);
      // GetLoadedItem: FlagSimulationChanged.
      simulation.changed = true;
    }
  }
  return { added, notInFitting: added && !isValidForCargo(simulation, typeID, facts) };
}

/**
 * ghostFittingSvc.TryFitItemsToHold (156 to 168) for the cargo hold, each type in its dict's order: one with no volume,
 * or one the hold takes not at all (IsAllowedToAddAtAll: a dynamic type, a category not allowed), passed over; each
 * other put in (FitAnItemToHold). Answers the types put in that a fitting does not keep there.
 */
export function fitItemsToCargo(simulation: SimulatedShip, qtyByTypeID: ReadonlyMap<number, number>, facts: HoldFacts): number[] {
  const notInFitting: number[] = [];
  for (const typeID of intDictOrder([...qtyByTypeID.keys()])) {
    const qty = qtyByTypeID.get(typeID) ?? 0;
    if (typeAttribute(simulation.location, typeID, ATTRIBUTE_VOLUME) <= 0) continue;
    const categoryID = simulation.location.static.types[typeID]?.categoryID ?? null;
    if (facts.dynamic(typeID) || categoryID === null || !ALLOWED_HOLD_CATEGORIES.has(categoryID)) continue;
    if (fitItemToCargo(simulation, typeID, qty, facts).notInFitting) notInFitting.push(typeID);
  }
  return notInFitting;
}

/**
 * ghostFittingSvc.ModifyHoldItemStackSize (190 to 200) for the cargo hold: a type's stack made as many as wanted, no
 * more than it and the room left take, taken out at none (UnfitModule: the simulation changed); a type not there put
 * in (FitAnItemToHold). Answers whether a type a fitting does not keep there was put in.
 */
export function setCargoQuantity(simulation: SimulatedShip, typeID: number, wanted: number, facts: HoldFacts): boolean {
  const held = simulation.cargo.get(typeID);
  if (held === undefined) return fitItemToCargo(simulation, typeID, wanted, facts).notInFitting;
  const maxExtra = simulatedCargoRoomFor(simulation, [typeID]) ?? 0;
  const qty = Math.min(wanted, held + maxExtra);
  if (qty <= 0) {
    simulation.cargo.delete(typeID);
    simulation.changed = true;
  } else simulation.cargo.set(typeID, qty);
  return false;
}

/** A UserError of the client's the fighters' fitting raises or says, with its values. */
export interface SimulationUserError {
  readonly key: string;
  readonly values: Readonly<Record<string, number>>;
}

const CATEGORY_FIGHTER = 87;
/** fighters SquadronIsHeavy, SquadronIsSupport, SquadronIsLight: a fighter's kind, the standup kinds with them. */
function squadronKind(simulation: SimulatedShip, typeID: number): "heavy" | "support" | "light" | null {
  const has = (attributeID: number) => Boolean(typeAttribute(simulation.location, typeID, attributeID));
  if (has(2214) || has(2742)) return "heavy";
  if (has(2213) || has(2741)) return "support";
  if (has(2212) || has(2740)) return "light";
  return null;
}

/** The ship's fighters in its fighter bay (GetHoldItems(flagFighterBay)). */
function fighterBayItems(simulation: SimulatedShip): DogmaItem[] {
  return [...simulation.ship.fighters.values()].filter((fighter) => fighter.flagID === FLAG_FIGHTER_BAY);
}

/** GetCapacity(shipID, None, flagFighterBay) (472 to 477): the ship's fighterCapacity, against each squadron's size times its volume. */
export function simulatedFighterBayCapacity(simulation: SimulatedShip): { readonly capacity: number; readonly used: number } {
  const { location, ship } = simulation;
  let used = 0;
  for (const fighter of fighterBayItems(simulation)) used += fighter.stacksize * location.value(fighter, ATTRIBUTE_VOLUME);
  return { capacity: location.value(ship, ATTRIBUTE_FIGHTER_CAPACITY), used };
}

/**
 * GetMaxQty for the fighter bay of several types at once: the room left over the types' volumes added up, whole; null
 * where not one of any type would fit.
 */
export function fighterBayRoomForAll(simulation: SimulatedShip, typeIDs: readonly number[]): number | null {
  const { capacity, used } = simulatedFighterBayCapacity(simulation);
  const volumeLeft = capacity - used;
  let maxQtyForType = 0;
  let allTypeVol = 0;
  for (const typeID of typeIDs) {
    const typeVolume = typeAttribute(simulation.location, typeID, ATTRIBUTE_VOLUME);
    allTypeVol += typeVolume;
    maxQtyForType = Math.max(maxQtyForType, Math.trunc(volumeLeft / typeVolume));
  }
  const maxQty = allTypeVol ? volumeLeft / allTypeVol : 0;
  return maxQtyForType ? Math.trunc(maxQty) : null;
}

/** GetMaxQty for the fighter bay: as many more of the type as its room left takes; null where none. */
export function fighterBayRoomFor(simulation: SimulatedShip, typeID: number): number | null {
  const { capacity, used } = simulatedFighterBayCapacity(simulation);
  const typeVolume = typeAttribute(simulation.location, typeID, ATTRIBUTE_VOLUME);
  const most = Math.trunc((capacity - used) / typeVolume);
  return most ? most : null;
}

/**
 * TryFitItemsToFighterBay (TryFitItemsToHold, flagFighterBay): each type, its volume and the hold's taking it at all
 * as the cargo's (IsAllowedToAddAtAll), put in (FitAnItemToHold: to its squadron there as many more as the room left
 * takes; else a squadron of all of it where the bay has room, FitItemOrDroneToShip). Answers the types put in that are
 * no fighters (IsValidForHold: ItemAddedNotInFitting).
 */
export function fitItemsToFighterBay(simulation: SimulatedShip, qtyByTypeID: ReadonlyMap<number, number>, facts: HoldFacts): number[] {
  const { location } = simulation;
  const notInFitting: number[] = [];
  for (const typeID of intDictOrder([...qtyByTypeID.keys()])) {
    const qty = qtyByTypeID.get(typeID) ?? 0;
    const volume = typeAttribute(location, typeID, ATTRIBUTE_VOLUME);
    if (volume <= 0) continue;
    const categoryID = location.static.types[typeID]?.categoryID ?? null;
    if (facts.dynamic(typeID) || categoryID === null || !ALLOWED_HOLD_CATEGORIES.has(categoryID)) continue;
    if (fitAnItemToFighterBay(simulation, typeID, qty)) notInFitting.push(typeID);
  }
  return notInFitting;
}

/**
 * FitAnItemToHold (170 to 183) for the fighter bay: to the type's squadron there as many more as the room left takes,
 * nothing where none; else a squadron of all of it where the bay has room (FitItemOrDroneToShip), the simulation then
 * changed. Answers whether it was put in and is no fighter (IsValidForHold: ItemAddedNotInFitting).
 */
function fitAnItemToFighterBay(simulation: SimulatedShip, typeID: number, qty: number): boolean {
  const { location, ship } = simulation;
  const held = fighterBayItems(simulation).find((fighter) => fighter.typeID === typeID);
  let added = false;
  if (held) {
    const more = Math.min(qty, fighterBayRoomFor(simulation, typeID) ?? 0);
    if (!more) return false;
    held.stacksize += more;
    added = true;
  } else {
    const { capacity, used } = simulatedFighterBayCapacity(simulation);
    if (used + typeAttribute(location, typeID, ATTRIBUTE_VOLUME) * qty <= capacity) {
      simulation.ghosts += 1;
      location.loadFighter(ship, `${ship.key}|fighter|${simulation.ghosts}`, typeID, FLAG_FIGHTER_BAY, qty);
      simulation.changed = true;
      added = true;
    }
  }
  return added && location.static.types[typeID]?.categoryID !== CATEGORY_FIGHTER;
}

/**
 * _CheckEmptyTubeCanAcceptFighter (338 to 355): the ship has tubes for the fighter's class (shipTubeCountAttribute-
 * ByFighterClass), a tube free of the ship's fighterTubes, and fewer squadrons of the kind in its tubes than it takes.
 */
function emptyTubeCanTake(simulation: SimulatedShip, typeID: number): boolean {
  const { location, ship } = simulation;
  const kind = fighterClass(location, typeID);
  const counts = { heavy: 0, support: 0, light: 0 };
  for (const fighter of fightersInTubes(ship)) {
    const of = squadronKind(simulation, fighter.typeID);
    if (of) counts[of] += 1;
  }
  const total = counts.heavy + counts.support + counts.light;
  const allowed = kind === null ? 0 : location.value(ship, TUBE_COUNT_ATTRIBUTE_BY_CLASS[kind] ?? 0);
  const tubes = Math.trunc(location.value(ship, ATTRIBUTE_FIGHTER_TUBES));
  if (!allowed) return false;
  if (tubes <= total) return false;
  if (kind === "light" || kind === "standupLight") return counts.light < allowed;
  if (kind === "support" || kind === "standupSupport") return counts.support < allowed;
  if (kind === "heavy" || kind === "standupHeavy") return counts.heavy < allowed;
  return true;
}

/**
 * FitFighterToTube (292 to 312): a squadron of another type in the tube refuses it
 * (CannotLoadFighterTubeDifferentTypeAlreadyLoaded); as many more as its squadron takes (GetMaxExtraFighters), none
 * said as CannotLoadFighterTubeSquadronIsFull; an empty tube that may not take it refuses it
 * (CannotLoadFighterTubeNoTubesAvailableForClass); else a squadron of them in the tube. Answers the client's word where
 * there is one: a refusal it raises (thrown: "raised"), or the one it says.
 */
export function fitFighterToTube(simulation: SimulatedShip, typeID: number, tubeFlagID: number, wanted: number): { readonly raised: boolean; readonly error: SimulationUserError } | null {
  const { location, ship } = simulation;
  const held = fightersInTubes(ship).find((fighter) => fighter.flagID === tubeFlagID) ?? null;
  if (held && held.typeID !== typeID) {
    return { raised: true, error: { key: "CannotLoadFighterTubeDifferentTypeAlreadyLoaded", values: { loadedType: held.typeID, newType: typeID } } };
  }
  const qty = Math.min(wanted, maxSquadronSize(location, typeID) - (held?.stacksize ?? 0));
  if (held) {
    if (qty < 1) return { raised: false, error: { key: "CannotLoadFighterTubeSquadronIsFull", values: { loadedType: held.typeID } } };
    held.stacksize += qty;
    return null;
  }
  if (!emptyTubeCanTake(simulation, typeID)) {
    return { raised: true, error: { key: "CannotLoadFighterTubeNoTubesAvailableForClass", values: { newType: typeID } } };
  }
  simulation.ghosts += 1;
  location.loadFighter(ship, `${ship.key}|fighter|${simulation.ghosts}`, typeID, tubeFlagID, qty);
  simulation.changed = true;
  return null;
}

/**
 * FitFighters (958 to 965): the fitting's fighter bay put in the bay (TryFitItemsToFighterBay), then each squadron of
 * its tubes into its tube (FitFighterToTube). A refusal it raises ends the loading there (the client's raise leaves the
 * rest unloaded); answers the client's words.
 */
function fitFighters(simulation: SimulatedShip, items: readonly { readonly typeID: number; readonly flagID: number; readonly quantity: number }[], facts: HoldFacts, notInFitting: number[]): { readonly errors: SimulationUserError[]; readonly raised: boolean } {
  const bay = new Map<number, number>();
  for (const item of items) if (item.flagID === FLAG_FIGHTER_BAY) bay.set(item.typeID, (bay.get(item.typeID) ?? 0) + item.quantity);
  notInFitting.push(...fitItemsToFighterBay(simulation, bay, facts));
  const errors: SimulationUserError[] = [];
  for (const item of items) {
    if (!FIGHTER_TUBE_FLAGS.includes(item.flagID)) continue;
    const said = fitFighterToTube(simulation, item.typeID, item.flagID, item.quantity);
    if (said) {
      errors.push(said.error);
      if (said.raised) return { errors, raised: true };
    }
  }
  return { errors, raised: false };
}

/** dogma const attributeQuantity: what a squadron dragged out of its tube counts as (GetFittingItemDragData). */
const ATTRIBUTE_QUANTITY = 805;
/** dogma const attributeFighterSquadronRole. */
const ATTRIBUTE_FIGHTER_SQUADRON_ROLE = 2270;

/** The squadron in a tube of the simulated ship's (GetFightersInTubeInfo), where there is one. */
function squadronInTube(simulation: SimulatedShip, tubeFlagID: number): DogmaItem | null {
  return fightersInTubes(simulation.ship).find((fighter) => fighter.flagID === tubeFlagID) ?? null;
}

/** UnfitModule of a squadron or a fighter bay's stack: unloaded (UnfitItemFromShip), the simulation changed. */
function unfitFighter(simulation: SimulatedShip, fighter: DogmaItem): void {
  simulation.location.unfitItem(simulation.ship, fighter);
  simulation.changed = true;
}

/** A tube of the simulated ship's as the fighter bay's picker shows it (AddTubeConts, SingleTube.LoadFighterInfo). */
export interface SimulatedTube {
  readonly flagID: number;
  /** SLOTNUMBER_BY_TUBEFLAG: its number, from one. */
  readonly number: number;
  /** One of the ship's fighterTubes; a tube past them is shown disabled (SetAsDisabled). */
  readonly present: boolean;
  /**
   * The squadron in it (GetFightersInTubeInfo): its type and size, its most (GetMaxSquadronSize: a dash each, as many
   * lit as its size) and its role (GetSquadronRole: fighterSquadronRole, int).
   */
  readonly squadron: { readonly typeID: number; readonly size: number; readonly max: number; readonly role: number } | null;
}

/** The five tubes (const.fighterTubeFlags), as many of them the ship's as its fighterTubes (int), each its squadron. */
export function simulatedFighterTubes(simulation: SimulatedShip): SimulatedTube[] {
  const { location, ship } = simulation;
  const tubes = Math.trunc(location.value(ship, ATTRIBUTE_FIGHTER_TUBES));
  return FIGHTER_TUBE_FLAGS.map((flagID, index) => {
    const fighter = squadronInTube(simulation, flagID);
    const squadron = fighter
      ? { typeID: fighter.typeID, size: fighter.stacksize, max: maxSquadronSize(location, fighter.typeID), role: Math.trunc(typeAttribute(location, fighter.typeID, ATTRIBUTE_FIGHTER_SQUADRON_ROLE)) }
      : null;
    return { flagID, number: index + 1, present: index < tubes, squadron };
  });
}

/**
 * The squadrons of each kind the ship may have in its tubes (GetLightSupportHeavySlotsForShipAndDogmaLocation: a
 * kind's slots and its standup kind's, int each) and has there (GetSquadronTypes of GetFighterNumByTypeIDsInTubes).
 */
export function simulatedSquadronSlots(simulation: SimulatedShip): Readonly<Record<"light" | "support" | "heavy", { readonly total: number; readonly used: number }>> {
  const { location, ship } = simulation;
  const slots = (attributeID: number, standupAttributeID: number) => Math.trunc(location.value(ship, attributeID)) + Math.trunc(location.value(ship, standupAttributeID));
  const used = { heavy: 0, support: 0, light: 0 };
  for (const fighter of fightersInTubes(ship)) {
    const kind = squadronKind(simulation, fighter.typeID);
    if (kind) used[kind] += 1;
  }
  return {
    light: { total: slots(2217, 2737), used: used.light },
    support: { total: slots(2218, 2738), used: used.support },
    heavy: { total: slots(2219, 2739), used: used.heavy },
  };
}

/**
 * The simulated fighter bay by type (FighterBayItemPickerMenu's nodes, GetSortedItemsInfo): each type's fighters there,
 * and the most it may be made (its count and the room left for more: LoadItemScroll's intRange).
 */
export function simulatedFighterBayTypes(simulation: SimulatedShip): { readonly typeID: number; readonly quantity: number; readonly most: number }[] {
  const byType = new Map<number, number>();
  for (const fighter of fighterBayItems(simulation)) byType.set(fighter.typeID, (byType.get(fighter.typeID) ?? 0) + fighter.stacksize);
  return [...byType].map(([typeID, quantity]) => ({ typeID, quantity, most: quantity + (fighterBayRoomFor(simulation, typeID) ?? 0) }));
}

/**
 * FitFighterToEmptyTube (278 to 290): the first of the five tubes with no squadron in it (the ship's or not;
 * FitFighterToTube's rule refuses one past its tubes), a full squadron of the type put in it (GetMaxSquadronSize).
 * "noTube" where each holds one; else FitFighterToTube's answer.
 */
export function fitFighterToEmptyTube(simulation: SimulatedShip, typeID: number): "noTube" | ReturnType<typeof fitFighterToTube> {
  const tube = FIGHTER_TUBE_FLAGS.find((flagID) => squadronInTube(simulation, flagID) === null);
  if (tube === undefined) return "noTube";
  return fitFighterToTube(simulation, typeID, tube, maxSquadronSize(simulation.location, typeID));
}

/**
 * ModifyFighterStackSize (325 to 337): the tube's squadron made as many as wanted, no more than its size and
 * GetMaxExtraFighters of its size take; under one taken out (UnfitModule); an empty tube given a squadron of as many
 * (FitFighterToTube), whose word is answered.
 */
export function setSquadronSize(simulation: SimulatedShip, typeID: number, wanted: number, tubeFlagID: number): ReturnType<typeof fitFighterToTube> {
  const held = squadronInTube(simulation, tubeFlagID);
  if (!held) return fitFighterToTube(simulation, typeID, tubeFlagID, wanted);
  const size = held.stacksize;
  const maxExtra = Math.min(size, maxSquadronSize(simulation.location, typeID) - size);
  const qty = Math.min(wanted, size + maxExtra);
  if (wanted < 1) {
    unfitFighter(simulation, held);
    return null;
  }
  held.stacksize = qty;
  return null;
}

/** SimulatedSquadronCont.RemoveSquadron: the tube's squadron taken out (UnfitModule). */
export function removeSquadron(simulation: SimulatedShip, tubeFlagID: number): void {
  const held = squadronInTube(simulation, tubeFlagID);
  if (held) unfitFighter(simulation, held);
}

/**
 * A squadron dragged out of its tube (GetFittingItemDragData): its type, and what it counts as (its quantity
 * attribute, else its size).
 */
export function squadronDragged(simulation: SimulatedShip, tubeFlagID: number): { readonly typeID: number; readonly quantity: number } | null {
  const held = squadronInTube(simulation, tubeFlagID);
  if (!held) return null;
  return { typeID: held.typeID, quantity: simulation.location.value(held, ATTRIBUTE_QUANTITY) || held.stacksize };
}

/**
 * ModifyHoldItemStackSize (190 to 200) for the fighter bay: a type's stack there made as many as wanted, no more than
 * it and the room left take (GetMaxQty), taken out at none (UnfitModule); a type not there put in (FitAnItemToHold).
 * Answers the types put in that are no fighters (ItemAddedNotInFitting).
 */
export function setFighterBayQuantity(simulation: SimulatedShip, typeID: number, wanted: number): number[] {
  const held = fighterBayItems(simulation).find((fighter) => fighter.typeID === typeID);
  if (!held) return fitAnItemToFighterBay(simulation, typeID, wanted) ? [typeID] : [];
  const qty = Math.min(wanted, held.stacksize + (fighterBayRoomFor(simulation, typeID) ?? 0));
  if (qty === 0) unfitFighter(simulation, held);
  else held.stacksize = qty;
  return [];
}

/** ItemPickerMenu.RemoveItem: the first of a type's stacks in the fighter bay taken out (UnfitModule). */
export function removeFighterBayType(simulation: SimulatedShip, typeID: number): void {
  const held = fighterBayItems(simulation).find((fighter) => fighter.typeID === typeID);
  if (held) unfitFighter(simulation, held);
}

/**
 * FighterBayItemPickerMenu.RemoveAll: the fighter bay emptied (RemoveAllItemsFromHold: each unloaded), then each tube's
 * squadron taken out (UnfitModule).
 */
export function emptyFighterBay(simulation: SimulatedShip): void {
  for (const fighter of fighterBayItems(simulation)) simulation.location.unfitItem(simulation.ship, fighter);
  for (const flagID of FIGHTER_TUBE_FLAGS) removeSquadron(simulation, flagID);
}

/** FittingDogmaLocation.RemoveAllItemsFromHold(flagCargo): the hold emptied. */
export function emptyCargo(simulation: SimulatedShip): void {
  simulation.cargo.clear();
}

/** The cargo hold's stacks of a fitting's or a ship's items (_GetItemInFlagQtyBytTypeID(fitData, flagCargo)), by type. */
function cargoQuantities(items: readonly { readonly typeID: number; readonly flagID: number; readonly quantity: number }[]): Map<number, number> {
  const quantities = new Map<number, number>();
  for (const item of items) if (item.flagID === FLAG_CARGO) quantities.set(item.typeID, (quantities.get(item.typeID) ?? 0) + item.quantity);
  return quantities;
}
const FLAG_CARGO = 5;

/** A module of the ship as it is fitted: its key, type and slot. */
export interface CurrentModule {
  readonly key: string;
  readonly typeID: number;
  readonly flagID: number;
}

/**
 * fittingSvc.GetFittingDictForSimulatedShip (1188 to 1203): the items CreateFittingData is given of the simulated ship:
 * its fitted items (the modules and their charges, each charge's stacksize the rounds it holds fully loaded,
 * FitAmmoToLocation), its drones (each stack's) and its cargo hold's stacks, each its type, flag and quantity. The
 * page's simulation holds no fighters yet.
 */
export function simulatedShipItems(simulation: SimulatedShip): { readonly typeID: number; readonly flagID: number | null; readonly quantity: number }[] {
  const { ship, pilot } = simulation;
  const items: { readonly typeID: number; readonly flagID: number | null; readonly quantity: number }[] = [];
  for (const item of ship.fitted.values()) {
    if (item === ship || item === pilot) continue;
    items.push({ typeID: item.typeID, flagID: item.flagID, quantity: item.stacksize });
  }
  for (const drone of ship.drones.values()) items.push({ typeID: drone.typeID, flagID: drone.flagID, quantity: drone.stacksize });
  for (const [typeID, quantity] of simulation.cargo) items.push({ typeID, flagID: FLAG_CARGO, quantity });
  // fightersInTubes and the fighter bay's items (GetHoldItems(flagFighterBay)), each squadron's size.
  for (const fighter of ship.fighters.values()) items.push({ typeID: fighter.typeID, flagID: fighter.flagID, quantity: fighter.stacksize });
  return items;
}

/** FittingDogmaLocation.GetMaxActiveDrones: max(5, the pilot's maxActiveDrones). */
export function simulatedMaxActiveDrones(simulation: SimulatedShip): number {
  return Math.max(5, simulation.location.value(simulation.pilot, ATTRIBUTE_MAX_ACTIVE_DRONES));
}

/**
 * SelectedDroneTracker.RegisterDroneAsActive: the drone selected where fewer than the most that may be active are
 * (else "limit": ActiveDronesLimitWarning) and the bandwidth it takes is left (else "bandwidth":
 * ActiveDroneBandwithWarning); null where it is selected.
 */
function registerDrone(simulation: SimulatedShip, drone: DogmaItem, quantity = 1): "limit" | "bandwidth" | null {
  let selected = 0;
  for (const count of simulation.selectedDrones.values()) selected += count;
  if (selected >= Math.max(simulatedMaxActiveDrones(simulation), 5)) return "limit";
  const value = (item: DogmaItem, attributeID: number): number => simulation.location.value(item, attributeID);
  const { used, ship } = activeDroneBandwidth(simulation.ship, { accurate: value, value }, simulation.selectedDrones);
  if (quantity * value(drone, ATTRIBUTE_DRONE_BANDWIDTH_USED) + used > ship) return "bandwidth";
  simulation.selectedDrones.set(drone, (simulation.selectedDrones.get(drone) ?? 0) + quantity);
  return null;
}

/** GetDronesInDamgeAmountOrder: the damage multiplier times the sum of the drone's distinct damages, the most first. */
function dronesByDamage(location: DogmaLocation, drones: readonly DogmaItem[]): DogmaItem[] {
  const ranked = drones.map((drone) => {
    const damages = new Set(DAMAGE_ATTRIBUTES.map((attributeID) => location.value(drone, attributeID)));
    let sum = 0;
    for (const damage of damages) sum += damage;
    return { drone, total: location.value(drone, ATTRIBUTE_DAMAGE_MULTIPLIER) * sum };
  });
  // sorted(..., key=data[0], reverse=True): a stable sort, the most first.
  return ranked.sort((left, right) => right.total - left.total).map((entry) => entry.drone);
}

/** LoadCurrentShip: the pilot's own ship simulated as the Fitting window loads it. */
export function simulateCurrentShip(
  staticData: DogmaStatic,
  shipTypeID: number,
  pilot: { readonly characterID: number; readonly typeID: number; readonly securityStatus: number },
  brain: Brain | null,
  modules: readonly CurrentModule[],
  charges: readonly SimulatedCharge[],
  drones: readonly { readonly typeID: number; readonly quantity: number }[],
  clock: () => number,
  /**
   * The ship's cargo, fighter bay and squadrons in its tubes, each its flag; the holds' facts; and the types put in them
   * a fitting does not keep there (for ItemAddedNotInFitting) and the fighters' refusals (the client's words).
   */
  hold: { readonly items: readonly { readonly typeID: number; readonly flagID: number; readonly quantity: number }[]; readonly facts: HoldFacts; readonly notInFitting: number[]; readonly errors: SimulationUserError[] },
): SimulatedShip {
  const loaded = loadSimulatedShip(staticData, shipTypeID, pilot, brain, { clock });
  const simulation: SimulatedShip = { ...loaded, selectedDrones: new Map(), cargo: new Map(), changed: false, ghosts: 0 };
  const { location, ship } = simulation;
  // _LoadSimulatedShipFromData: each module fitted as FitModuleToShip fits it, one that does not fit passed over.
  for (const module of [...modules].sort((left, right) => right.flagID - left.flagID)) {
    fitModuleChecked(simulation, module.typeID, module.flagID, module.key);
  }
  activateOnLoading(location, ship);
  // FitDrones: each one alone, while the drone bay has room for it.
  const fitted: DogmaItem[] = [];
  for (const stack of drones) {
    for (let at = 0; at < stack.quantity; at += 1) {
      const drone = fitDrone(simulation, stack.typeID);
      if (!drone) break;
      fitted.push(drone);
    }
  }
  for (const drone of dronesByDamage(location, fitted)) registerDrone(simulation, drone);
  // FitFighters, then AddItemsToCargo: the ship's own (LoadCurrentShip: each visible item in its cargo hold and its
  // fighter bay with its stack, each squadron in a tube with its size).
  const fighters = fitFighters(simulation, hold.items, hold.facts, hold.notInFitting);
  hold.errors.push(...fighters.errors);
  if (!fighters.raised) hold.notInFitting.push(...fitItemsToCargo(simulation, cargoQuantities(hold.items), hold.facts));
  for (const charge of charges) location.loadCharge(ship, charge.flagID, charge.typeID);
  // LoadCurrentShip: ResetSimulationChangedFlag.
  simulation.changed = false;
  return simulation;
}

/** FitItemOrDroneToShip for a drone: one more in the drone bay where it has room (GetCapacity: each drone's volume). */
function fitDrone(simulation: SimulatedShip, typeID: number): DogmaItem | null {
  const { location, ship } = simulation;
  let used = 0;
  for (const drone of ship.drones.values()) used += location.value(drone, ATTRIBUTE_VOLUME);
  const volume = location.static.types[typeID]?.attributes.find(([id]) => id === ATTRIBUTE_VOLUME)?.[1] ?? 0;
  if (used + volume > location.value(ship, ATTRIBUTE_DRONE_CAPACITY)) return null;
  simulation.ghosts += 1;
  return location.loadDrone(ship, `${ship.key}|drone|${simulation.ghosts}`, typeID, 1);
}

// --- fitting in the simulation (ghostFittingSvc FitModuleToShipAndChangeState, UnfitModule; shipfitting/fittingStuff)

/** shipfitting/errorConst: why a module does not fit. */
export const FIT_ERRORS = Object.freeze({
  CANT_FIT_MODULE_TO_SHIP: 1,
  MODULE_TOO_BIG: 2,
  CANT_FIT_TOO_MANY_BY_GROUP: 3,
  CANT_FIT_TOO_MANY_BY_TYPE: 4,
  NOT_ENOUGH_LAUNCHER_SLOTS: 5,
  NOT_ENOUGH_TURRET_SLOTS: 6,
  NOT_ENOUGH_RIG_SLOTS: 7,
  RIG_WRONG_SIZE: 8,
  SLOT_NOT_PRESENT: 9,
  WRONG_SLOT: 10,
  SLOT_IN_USE: 11,
  MODULE_NOT_POWERED: 12,
  MODULE_NOT_APPROPRIATE_FOR_CATEGORY: 13,
});

/** An error's key (FIT_ERRORS) and its extra (the most that may be fitted, for the two that have one). */
export interface FitError {
  readonly errorKey: number;
  readonly extraInfo: number | null;
}

const EFFECT_LO_POWER = 11;
const EFFECT_HI_POWER = 12;
const EFFECT_MED_POWER = 13;
const EFFECT_LAUNCHER_FITTED = 40;
const EFFECT_TURRET_FITTED = 42;
const EFFECT_RIG_SLOT = 2663;
const EFFECT_SUBSYSTEM = 3772;
const EFFECT_SERVICE_SLOT = 6306;
const range = (first: number, count: number): number[] => Array.from({ length: count }, (_, at) => first + at);
/** POWER_TO_FLAG_DICT: the slots a type's slot effect fits it to. */
const POWER_TO_FLAGS: ReadonlyMap<number, readonly number[]> = new Map([
  [EFFECT_HI_POWER, range(27, 8)],
  [EFFECT_MED_POWER, range(19, 8)],
  [EFFECT_LO_POWER, range(11, 8)],
  [EFFECT_RIG_SLOT, range(92, 3)],
  [EFFECT_SUBSYSTEM, range(125, 4)],
  [EFFECT_SERVICE_SLOT, range(164, 8)],
]);
const ATTRIBUTE_LOW_SLOTS = 12;
const ATTRIBUTE_MED_SLOTS = 13;
const ATTRIBUTE_HI_SLOTS = 14;
const ATTRIBUTE_LAUNCHER_SLOTS_LEFT = 101;
const ATTRIBUTE_TURRET_SLOTS_LEFT = 102;
const ATTRIBUTE_RIG_SLOTS = 1137;
const ATTRIBUTE_MAX_SUBSYSTEMS = 1367;
const ATTRIBUTE_SUBSYSTEM_SLOT = 1366;
const ATTRIBUTE_SERVICE_SLOTS = 2056;
const ATTRIBUTE_RIG_SIZE = 1547;
const ATTRIBUTE_MAX_GROUP_FITTED = 1544;
const ATTRIBUTE_MAX_TYPE_FITTED = 2431;
const ATTRIBUTE_CHARGE_SIZE = 128;
const ATTRIBUTE_CAPACITY = 38;
/** IsShipFittable: a module, a subsystem, a structure module. */
const SHIP_FITTABLE_CATEGORIES: ReadonlySet<number> = new Set([7, 32, 66]);
const CATEGORY_STRUCTURE = 65;
const CATEGORY_STRUCTURE_MODULE = 66;
const CATEGORY_DRONE = 18;
/** GetShipGroupByClassType()[GROUP_CAPITALSHIPS] */
const CAPITAL_GROUPS: ReadonlySet<number> = new Set([547, 5120, 883, 485, 30, 659, 1538, 4594]);
/** inventorycommon/const.py maxNonCapitalModuleSize */
const MAX_NON_CAPITAL_MODULE_SIZE = 3500;
/** TYPEIDS_NOT_ACTIVE_BY_DEFAULT: the cloaking devices and the mass entanglers, by group. */
const GROUPS_NOT_ACTIVE_BY_DEFAULT: ReadonlySet<number> = new Set([330, 2008]);

/** GetTypeAttribute2: a type's attribute as the static data has it, else the attribute's default. */
function typeAttribute(location: DogmaLocation, typeID: number, attributeID: number): number {
  const listed = location.static.types[typeID]?.attributes.find(([id]) => id === attributeID)?.[1];
  if (listed !== undefined && listed !== null) return listed;
  return location.static.attributes[attributeID]?.defaultValue ?? 0;
}

const typeHasEffect = (location: DogmaLocation, typeID: number, effectID: number): boolean =>
  location.static.types[typeID]?.effects.includes(effectID) ?? false;

/** GetSlotListForTypeID: the slots of its slot effect (the first fittable one of its effects); a subsystem's own. */
export function slotListForType(location: DogmaLocation, typeID: number): readonly number[] {
  const effects = location.static.types[typeID]?.effects ?? [];
  const slotType = effects.find((effectID) => POWER_TO_FLAGS.has(effectID));
  if (slotType === undefined) return [];
  if (slotType === EFFECT_SUBSYSTEM) return [Math.trunc(typeAttribute(location, typeID, ATTRIBUTE_SUBSYSTEM_SLOT))];
  return POWER_TO_FLAGS.get(slotType) ?? [];
}

/** The modules fitted to the ship (GetFittedItems), not the ship itself, nor a charge. */
function fittedModules(simulation: SimulatedShip): DogmaItem[] {
  const { ship } = simulation;
  return [...ship.fitted.values()].filter((item) => item !== ship && !(item.flagID !== null && ship.subLocations.get(item.flagID) === item));
}

/** inventorycommon.util.IsSubsystemFlag: flagSubSystemSlot0 to 7. */
function isSubsystemFlag(flagID: number): boolean {
  return flagID >= 125 && flagID <= 132;
}

/**
 * baseDogmaStaticSvc.shipHardwareModifierAttribs (111 to 119): each count of the hull's a fitted subsystem adds to,
 * with the subsystem's attribute that adds it.
 */
const SHIP_HARDWARE_MODIFIER_ATTRIBUTES: readonly (readonly [number, number])[] = [
  [ATTRIBUTE_HI_SLOTS, 1374], [ATTRIBUTE_MED_SLOTS, 1375], [ATTRIBUTE_LOW_SLOTS, 1376], [ATTRIBUTE_TURRET_SLOTS_LEFT, 1368], [ATTRIBUTE_LAUNCHER_SLOTS_LEFT, 1369],
];

/**
 * GetErrorInfoFromHardware, with GetHardwareLayoutForShip (fittingStuff.py 15 to 70: the hull's counts, each fitted
 * subsystem's modifiers added) and GetValidSlotsForType.
 */
function errorFromHardware(simulation: SimulatedShip, typeID: number, flagID: number | null): FitError | null {
  const { location, ship } = simulation;
  const shipTypeID = ship.typeID;
  const has = (effectID: number) => typeHasEffect(location, typeID, effectID);
  const layout = new Map<number, number>();
  const GTA = (attributeID: number) => Math.trunc(typeAttribute(location, shipTypeID, attributeID));
  let isTurret = false;
  let isLauncher = false;
  if (has(EFFECT_HI_POWER)) {
    layout.set(ATTRIBUTE_HI_SLOTS, GTA(ATTRIBUTE_HI_SLOTS));
    if (has(EFFECT_TURRET_FITTED)) {
      layout.set(ATTRIBUTE_TURRET_SLOTS_LEFT, GTA(ATTRIBUTE_TURRET_SLOTS_LEFT));
      isTurret = true;
    } else if (has(EFFECT_LAUNCHER_FITTED)) {
      layout.set(ATTRIBUTE_LAUNCHER_SLOTS_LEFT, GTA(ATTRIBUTE_LAUNCHER_SLOTS_LEFT));
      isLauncher = true;
    }
  } else if (has(EFFECT_MED_POWER)) layout.set(ATTRIBUTE_MED_SLOTS, GTA(ATTRIBUTE_MED_SLOTS));
  else if (has(EFFECT_LO_POWER)) layout.set(ATTRIBUTE_LOW_SLOTS, GTA(ATTRIBUTE_LOW_SLOTS));
  else if (has(EFFECT_RIG_SLOT)) layout.set(ATTRIBUTE_RIG_SLOTS, GTA(ATTRIBUTE_RIG_SLOTS));
  else if (has(EFFECT_SUBSYSTEM)) layout.set(ATTRIBUTE_MAX_SUBSYSTEMS, GTA(ATTRIBUTE_MAX_SUBSYSTEMS));
  else if (has(EFFECT_SERVICE_SLOT)) layout.set(ATTRIBUTE_SERVICE_SLOTS, GTA(ATTRIBUTE_SERVICE_SLOTS));
  let turretsFitted = 0;
  let launchersFitted = 0;
  let rigsFitted = 0;
  for (const item of fittedModules(simulation)) {
    const flag = item.flagID ?? 0;
    if (flag >= 27 && flag <= 34) {
      if (isTurret && typeHasEffect(location, item.typeID, EFFECT_TURRET_FITTED)) turretsFitted += 1;
      else if (isLauncher && typeHasEffect(location, item.typeID, EFFECT_LAUNCHER_FITTED)) launchersFitted += 1;
    } else if (flag >= 92 && flag <= 99) rigsFitted += 1;
    else if (isSubsystemFlag(flag)) {
      // A subsystem fitted: its modifiers added to the counts asked of the hull (shipHardwareModifierAttribs).
      for (const [attributeID, modifyingAttributeID] of SHIP_HARDWARE_MODIFIER_ATTRIBUTES) {
        const held = layout.get(attributeID);
        if (held !== undefined) layout.set(attributeID, held + typeAttribute(location, item.typeID, modifyingAttributeID));
      }
    }
  }
  if (has(EFFECT_LAUNCHER_FITTED) && (layout.get(ATTRIBUTE_LAUNCHER_SLOTS_LEFT) ?? 0) - launchersFitted < 1) {
    return { errorKey: FIT_ERRORS.NOT_ENOUGH_LAUNCHER_SLOTS, extraInfo: null };
  }
  if (has(EFFECT_TURRET_FITTED) && (layout.get(ATTRIBUTE_TURRET_SLOTS_LEFT) ?? 0) - turretsFitted < 1) {
    return { errorKey: FIT_ERRORS.NOT_ENOUGH_TURRET_SLOTS, extraInfo: null };
  }
  if (has(EFFECT_RIG_SLOT)) {
    if ((layout.get(ATTRIBUTE_RIG_SLOTS) ?? 0) - rigsFitted < 1) return { errorKey: FIT_ERRORS.NOT_ENOUGH_RIG_SLOTS, extraInfo: null };
    // IsRigTooSmall: a ship with a rig size, the rig's not the same.
    const shipRigSize = typeAttribute(location, shipTypeID, ATTRIBUTE_RIG_SIZE);
    if (shipRigSize && typeAttribute(location, typeID, ATTRIBUTE_RIG_SIZE) !== shipRigSize) return { errorKey: FIT_ERRORS.RIG_WRONG_SIZE, extraInfo: null };
  }
  // GetValidSlotsForType: the slots the ship has of the kind; none, ModuleNotPowered.
  let first = 0;
  let allowed = 0;
  let last = 0;
  if (has(EFFECT_LO_POWER)) [first, allowed, last] = [11, layout.get(ATTRIBUTE_LOW_SLOTS) ?? 0, 18];
  else if (has(EFFECT_HI_POWER)) [first, allowed, last] = [27, layout.get(ATTRIBUTE_HI_SLOTS) ?? 0, 34];
  else if (has(EFFECT_MED_POWER)) [first, allowed, last] = [19, layout.get(ATTRIBUTE_MED_SLOTS) ?? 0, 26];
  else if (has(EFFECT_RIG_SLOT)) [first, allowed, last] = [92, layout.get(ATTRIBUTE_RIG_SLOTS) ?? 0, 99];
  else if (has(EFFECT_SUBSYSTEM)) {
    const desired = Math.trunc(typeAttribute(location, typeID, ATTRIBUTE_SUBSYSTEM_SLOT));
    allowed = layout.get(ATTRIBUTE_MAX_SUBSYSTEMS) ?? 0;
    if (allowed > 0 && (flagID === null || flagID < desired || flagID >= desired + 1)) return { errorKey: FIT_ERRORS.SLOT_NOT_PRESENT, extraInfo: null };
    if (allowed <= 0) return { errorKey: FIT_ERRORS.MODULE_NOT_POWERED, extraInfo: null };
    return null;
  } else if (has(EFFECT_SERVICE_SLOT)) [first, allowed, last] = [164, layout.get(ATTRIBUTE_SERVICE_SLOTS) ?? 0, 171];
  if (allowed <= 0) return { errorKey: FIT_ERRORS.MODULE_NOT_POWERED, extraInfo: null };
  const firstNonSlot = Math.min(first + allowed, last + 1);
  if (flagID === null || flagID < first || flagID >= firstNonSlot) return { errorKey: FIT_ERRORS.SLOT_NOT_PRESENT, extraInfo: null };
  return null;
}

/** CheckCanFitType: no more of the module's group, or of its type, than its maxGroupFitted and maxTypeFitted. */
function errorFromFitLimits(simulation: SimulatedShip, typeID: number): FitError | null {
  const { location } = simulation;
  const facts = location.static.types[typeID];
  const listed = (attributeID: number) => facts?.attributes.find(([id]) => id === attributeID)?.[1] ?? null;
  const fitted = fittedModules(simulation);
  const maxGroupFitted = listed(ATTRIBUTE_MAX_GROUP_FITTED);
  if (maxGroupFitted && fitted.filter((item) => item.groupID === facts?.groupID).length >= maxGroupFitted) {
    return { errorKey: FIT_ERRORS.CANT_FIT_TOO_MANY_BY_GROUP, extraInfo: Math.trunc(maxGroupFitted) };
  }
  const maxTypeFitted = listed(ATTRIBUTE_MAX_TYPE_FITTED);
  if (maxTypeFitted && fitted.filter((item) => item.typeID === typeID).length >= maxTypeFitted) {
    return { errorKey: FIT_ERRORS.CANT_FIT_TOO_MANY_BY_TYPE, extraInfo: Math.trunc(maxTypeFitted) };
  }
  return null;
}

/**
 * GetErrorInfoDoesModuleTypeIDFit: GetModuleErrorInfo (a category a ship fits; a structure's modules for a structure
 * only; the ships the type may be fitted to; a module too big for a ship not capital), the fit limits, then the
 * hardware.
 */
function errorDoesModuleFit(simulation: SimulatedShip, typeID: number, flagID: number | null): FitError | null {
  const { location, ship } = simulation;
  const facts = location.static.types[typeID];
  const categoryID = facts?.categoryID ?? null;
  if (categoryID === null || !SHIP_FITTABLE_CATEGORIES.has(categoryID)) return { errorKey: FIT_ERRORS.MODULE_NOT_APPROPRIATE_FOR_CATEGORY, extraInfo: null };
  const shipIsStructure = ship.categoryID === CATEGORY_STRUCTURE;
  if (shipIsStructure ? categoryID !== CATEGORY_STRUCTURE_MODULE : categoryID === CATEGORY_STRUCTURE_MODULE) {
    return { errorKey: FIT_ERRORS.MODULE_NOT_APPROPRIATE_FOR_CATEGORY, extraInfo: null };
  }
  const groups = facts?.fitsShipGroups ?? [];
  const types = facts?.fitsShipTypes ?? [];
  if ((groups.length > 0 || types.length > 0) && !(ship.groupID !== null && groups.includes(ship.groupID)) && !types.includes(ship.typeID)) {
    return { errorKey: FIT_ERRORS.CANT_FIT_MODULE_TO_SHIP, extraInfo: null };
  }
  const isCapital = ship.groupID !== null && CAPITAL_GROUPS.has(ship.groupID);
  if (!isCapital && !shipIsStructure && typeAttribute(location, typeID, ATTRIBUTE_VOLUME) > MAX_NON_CAPITAL_MODULE_SIZE) {
    return { errorKey: FIT_ERRORS.MODULE_TOO_BIG, extraInfo: null };
  }
  return errorFromFitLimits(simulation, typeID) ?? errorFromHardware(simulation, typeID, flagID);
}

/** CanFitModuleInSlot: the module's fit, the slot free (a subsystem's taken over), the right kind of slot. */
function errorFittingInSlot(simulation: SimulatedShip, typeID: number, flagID: number | null): FitError | null {
  const isSubsystem = flagID !== null && flagID >= 125 && flagID <= 132;
  const error = errorDoesModuleFit(simulation, typeID, flagID);
  if (error && !(isSubsystem && error.errorKey === FIT_ERRORS.SLOT_NOT_PRESENT)) return error;
  if (flagID !== null && !isSubsystem && fittedModules(simulation).some((item) => item.flagID === flagID)) {
    return { errorKey: FIT_ERRORS.SLOT_IN_USE, extraInfo: null };
  }
  if (flagID === null || !slotListForType(simulation.location, typeID).includes(flagID)) return { errorKey: FIT_ERRORS.WRONG_SLOT, extraInfo: null };
  return error;
}

/**
 * FitModuleToShip: the slot to use (GetFlagIdToUse: the one asked where the type goes there, the first free of its
 * kind where any will do, 0); its fit checked (CanFitModuleInSlot); the module loaded in it (GetLoadedItem: a ghost of
 * its type, or keyed as the item it stands for). The module, or why it does not fit.
 */
function fitModuleChecked(simulation: SimulatedShip, typeID: number, flagID: number, key?: string): DogmaItem | FitError {
  const { location, ship } = simulation;
  const slots = slotListForType(location, typeID);
  const used = new Set(fittedModules(simulation).map((item) => item.flagID));
  let flag: number | null = null;
  if (flagID === 0) flag = slots.find((slot) => !used.has(slot)) ?? null;
  else if (slots.includes(flagID)) flag = flagID;
  const error = errorFittingInSlot(simulation, typeID, flag);
  if (error || flag === null) return error ?? { errorKey: FIT_ERRORS.SLOT_NOT_PRESENT, extraInfo: null };
  // GetLoadedItem: a subsystem takes the place of the one in its slot (GetSubSystemInFlag, UnfitItemFromShip).
  if (isSubsystemFlag(flag)) {
    const held = fittedModules(simulation).find((item) => item.flagID === flag);
    if (held) location.unfitItem(ship, held);
  }
  simulation.ghosts += 1;
  return location.fitModule(ship, key ?? `${ship.key}|module|${simulation.ghosts}`, typeID, flag);
}

/**
 * FitModuleToShipAndChangeState: the module fitted (FitModuleToShip), then put online and activated, the fit errors
 * passed over (a cloak or a mass entangler not activated). Null where it is fitted, else why not.
 */
export function fitToSimulation(simulation: SimulatedShip, typeID: number, flagID: number): FitError | null {
  const { location } = simulation;
  const fitted = fitModuleChecked(simulation, typeID, flagID);
  if (!("key" in fitted)) return fitted;
  const module = fitted;
  simulation.changed = true;
  eatingFitErrors(() => setModuleState(location, module, ONLINE));
  eatingFitErrors(() => {
    if (module.groupID === null || !GROUPS_NOT_ACTIVE_BY_DEFAULT.has(module.groupID)) setModuleState(location, module, ACTIVE);
  });
  if (module.flagID !== null && isSubsystemFlag(module.flagID)) offlineModulesWithoutSlots(simulation);
  return null;
}

/**
 * ghostControllerMixin.OnSubSystemsReallyChanged (61 to 70), on a subsystem fitted or unfitted: each module online in
 * a slot the ship no longer has (the slot's IsOnlineable: SlotExists) taken offline (OfflineSlotList); it stays fitted.
 */
function offlineModulesWithoutSlots(simulation: SimulatedShip): void {
  const { location, ship } = simulation;
  const flags = fittedModules(simulation)
    .filter((item) => item.flagID !== null && !isSubsystemFlag(item.flagID) && location.isOnline(item) && !location.slotExists(ship, item.flagID))
    .map((item) => item.flagID as number);
  if (flags.length > 0) offlineSlots(location, ship, flags);
}

/** FittingSlotController.IsOnlineable: a module in a slot the ship has, its type with the online effect. */
export function isOnlineable(simulation: SimulatedShip, module: DogmaItem): boolean {
  const { location, ship } = simulation;
  return module.flagID !== null && location.slotExists(ship, module.flagID) && (location.static.types[module.typeID]?.effects.includes(16) ?? false);
}

/**
 * TryFitModuleToOneSlot: a drone one more in the drone bay (selected where it may be); a module fitted to the first of
 * its kind of slot it fits in. Null where it is fitted, else why the last slot tried would not take it.
 */
export function fitToOneSlot(simulation: SimulatedShip, typeID: number): FitError | null {
  if (simulation.location.static.types[typeID]?.categoryID === CATEGORY_DRONE) {
    const drone = fitDrone(simulation, typeID);
    if (!drone) return { errorKey: FIT_ERRORS.SLOT_NOT_PRESENT, extraInfo: null };
    simulation.changed = true;
    registerDrone(simulation, drone);
    return null;
  }
  let error: FitError | null = { errorKey: FIT_ERRORS.SLOT_NOT_PRESENT, extraInfo: null };
  for (const flagID of slotListForType(simulation.location, typeID)) {
    error = fitToSimulation(simulation, typeID, flagID);
    if (error === null) break;
  }
  return error;
}

/** The simulated drone bay by type (dronePickerMenu's nodes): each type's drones, and how many of them are selected. */
export function simulatedDroneTypes(simulation: SimulatedShip): { readonly typeID: number; readonly drones: readonly DogmaItem[]; readonly active: number }[] {
  const byType = new Map<number, DogmaItem[]>();
  for (const drone of simulation.ship.drones.values()) {
    const list = byType.get(drone.typeID) ?? [];
    list.push(drone);
    byType.set(drone.typeID, list);
  }
  return [...byType].map(([typeID, drones]) => ({
    typeID,
    drones,
    active: drones.filter((drone) => simulation.selectedDrones.has(drone)).length,
  }));
}

/**
 * dronePickerMenu.ChangeActiveNum: as many of a type's drones selected as wanted (the number selected already
 * wanted, one fewer), the unselected ones selected in turn or the selected ones let go; a selection the tracker
 * refuses stops it, and its warning is answered.
 */
export function setActiveDronesOfType(simulation: SimulatedShip, typeID: number, wanted: number): "limit" | "bandwidth" | null {
  const drones = [...simulation.ship.drones.values()].filter((drone) => drone.typeID === typeID);
  const active = drones.filter((drone) => simulation.selectedDrones.has(drone));
  let want = wanted;
  if (active.length === want) want = Math.max(0, want - 1);
  const diff = want - active.length;
  if (active.length > 0 && diff < 0) {
    for (const drone of active.slice(0, -diff)) simulation.selectedDrones.delete(drone);
    return null;
  }
  let added = 0;
  for (const drone of drones) {
    if (added >= diff) break;
    if (simulation.selectedDrones.has(drone)) continue;
    const warning = registerDrone(simulation, drone);
    if (warning) return warning;
    added += 1;
  }
  return null;
}

/**
 * dronePickerMenu.ChangeNumDrones: as many of a type in the drone bay as wanted: more fitted while the bay has room,
 * the new ones selected where they may be (TryFitDronesToDroneBay: RegisterTopDpsDrones); or the unselected ones
 * unfitted first.
 */
export function setDronesOfType(simulation: SimulatedShip, typeID: number, wanted: number): void {
  const drones = [...simulation.ship.drones.values()].filter((drone) => drone.typeID === typeID);
  const diff = wanted - drones.length;
  if (diff > 0) {
    addDronesOfType(simulation, typeID, diff);
  } else if (diff < 0) {
    // sorted(key=x in activeDrones): the unselected first.
    const order = [...drones].sort((left, right) => Number(simulation.selectedDrones.has(left)) - Number(simulation.selectedDrones.has(right)));
    for (const drone of order.slice(0, -diff)) unfitFromSimulation(simulation, drone);
  }
}

/**
 * TryFitDronesToDroneBay of one type: as many more as asked, each while the bay has room (FitDronesToShip,
 * selectByDefault False: FitADroneToShip, FitItemOrDroneToShip), then those fitted selected in their damage's order where
 * they may be (RegisterTopDpsDrones, raiseError False). Answers how many were fitted.
 */
export function addDronesOfType(simulation: SimulatedShip, typeID: number, qty: number): number {
  const fitted: DogmaItem[] = [];
  for (let at = 0; at < qty; at += 1) {
    const drone = fitDrone(simulation, typeID);
    if (!drone) break;
    fitted.push(drone);
  }
  for (const drone of dronesByDamage(simulation.location, fitted)) registerDrone(simulation, drone);
  // GetLoadedItem: FlagSimulationChanged.
  if (fitted.length > 0) simulation.changed = true;
  return fitted.length;
}

/**
 * itemPickerMenu.GetMaxQty for the drone bay, of one type: as many as the room left takes (GetCapacity(flagDroneBay):
 * the ship's droneCapacity, each drone's volume); null where it takes none.
 */
export function droneBayRoomFor(simulation: SimulatedShip, typeID: number): number | null {
  const { location, ship } = simulation;
  let used = 0;
  for (const drone of ship.drones.values()) used += location.value(drone, ATTRIBUTE_VOLUME);
  const typeVolume = typeAttribute(location, typeID, ATTRIBUTE_VOLUME);
  const most = Math.trunc((location.value(ship, ATTRIBUTE_DRONE_CAPACITY) - used) / typeVolume);
  return most ? most : null;
}

/**
 * What the simulated holds' readouts write as their use (minihangar GetSimulatedCapacity: the fitting location's
 * GetCapacity, 452 to 477): each a Python int nought where the hold holds nothing (its `used = 0`), else the float of
 * its items' volumes added up: the cargo's and the fighter bay's each stack's size times its volume, the drone bay's each
 * drone's volume.
 */
export function simulatedHoldUse(simulation: SimulatedShip): { readonly cargo: PyNumber; readonly drone: PyNumber; readonly fighter: PyNumber } {
  const { location, ship } = simulation;
  const cargo: PyNumber = simulation.cargo.size === 0 ? { int: 0 } : simulatedCargoCapacity(simulation).used;
  const drones = [...ship.drones.values()];
  const drone: PyNumber = drones.length === 0 ? { int: 0 } : drones.reduce((sum, each) => sum + location.value(each, ATTRIBUTE_VOLUME), 0);
  const fighter: PyNumber = fighterBayItems(simulation).length === 0 ? { int: 0 } : simulatedFighterBayCapacity(simulation).used;
  return { cargo, drone, fighter };
}

/** ammoloadingUtils.IsChargeCompatibleWithLauncher: a group the module takes, and its charge size (or room for one). */
export function chargeFitsModule(location: DogmaLocation, chargeTypeID: number, moduleTypeID: number): boolean {
  if (!academyChargeAllowed(location.static.types[chargeTypeID], location.static.types[moduleTypeID])) return false;
  const chargeGroups = (location.static.types[moduleTypeID]?.chargeGroups ?? []).filter((groupID) => groupID > 0).map(Math.trunc);
  const groupID = location.static.types[chargeTypeID]?.groupID ?? null;
  if (groupID === null || !chargeGroups.includes(groupID)) return false;
  const requiredChargeSize = typeAttribute(location, moduleTypeID, ATTRIBUTE_CHARGE_SIZE);
  if (requiredChargeSize && requiredChargeSize === typeAttribute(location, chargeTypeID, ATTRIBUTE_CHARGE_SIZE)) return true;
  if (!requiredChargeSize) {
    // GetModuleCapacityForAmmoType: int(the module's capacity / the charge's volume + 1e-07).
    const chargeVolume = typeAttribute(location, chargeTypeID, ATTRIBUTE_VOLUME);
    if (chargeVolume && Math.trunc(typeAttribute(location, moduleTypeID, ATTRIBUTE_CAPACITY) / chargeVolume + 1e-7) > 0) return true;
  }
  return false;
}

/**
 * FitAmmoToLocation: a charge loaded into the simulated module in a slot, where the module takes it; the charge loaded
 * there before unfitted; as many as the module holds (GetNumChargesFullyLoaded: int(its capacity / the charge's
 * volume)), none and it is unfitted again. True where it is loaded.
 */
export function loadChargeToSimulation(simulation: SimulatedShip, flagID: number, chargeTypeID: number): boolean {
  const { location, ship } = simulation;
  const module = fittedModules(simulation).find((item) => item.flagID === flagID) ?? null;
  if (!module || !chargeFitsModule(location, chargeTypeID, module.typeID)) return false;
  const old = ship.subLocations.get(flagID);
  if (old) unfitFromSimulation(simulation, old);
  const charge = location.loadCharge(ship, flagID, chargeTypeID);
  const chargeVolume = location.value(charge, ATTRIBUTE_VOLUME);
  const numCharges = chargeVolume ? Math.trunc(location.value(module, ATTRIBUTE_CAPACITY) / chargeVolume) : 0;
  if (numCharges < 1) {
    unfitFromSimulation(simulation, charge);
    return false;
  }
  charge.stacksize = numCharges;
  simulation.changed = true;
  return true;
}

/** UnfitModule (and UnfitDrone): the module put offline, the fit errors passed over, then unfitted with its charge. */
export function unfitFromSimulation(simulation: SimulatedShip, item: DogmaItem): void {
  const { location, ship } = simulation;
  const flagID = item.flagID;
  simulation.selectedDrones.delete(item);
  if (!ship.drones.has(item.key)) eatingFitErrors(() => setModuleState(location, item, OFFLINE));
  location.unfitItem(ship, item);
  simulation.changed = true;
  if (flagID !== null && isSubsystemFlag(flagID)) offlineModulesWithoutSlots(simulation);
}

/** ghostFittingSvc allSlots: the rigs, then the subsystems, the low, medium and high slots and the services. */
const ALL_SLOT_FLAGS: ReadonlySet<number> = new Set([92, 93, 94, 125, 126, 127, 128, ...range(11, 24), ...range(164, 8)]);
const FLAG_DRONE_BAY = 87;

/** A saved fitting's item (fitData's ItemInfo): its type, its flag, how many. */
export interface FitDataItem {
  readonly typeID: number;
  readonly flagID: number;
  readonly quantity: number;
}

/**
 * _LoadSimulatedShipFromData, for a fitting (SimulateFitting: a saved one, or a hull alone): a ghost of the hull with
 * the pilot's brain; the fitting's modules fitted, the highest slot first, a subsystem in its own slot
 * (attributeSubSystemSlot), one that does not fit passed over (FitModuleToShip); then the rigs activated, every module
 * online, every module activated (_ActivateOnLoading); then its drones, each one alone while the bay has room, the most
 * damage first selected (FitDrones: TryFitDronesToDroneBay, RegisterTopDpsDrones). Its cargo and fighters are not
 * loaded here; its charges stay in its cargo (the browser's SimulateFitting loads none).
 */
export function simulateFitData(
  staticData: DogmaStatic,
  shipTypeID: number,
  pilot: { readonly characterID: number; readonly typeID: number; readonly securityStatus: number },
  brain: Brain | null,
  fitData: readonly FitDataItem[],
  clock: () => number,
  /** The holds' facts, the types put in them a fitting does not keep there (ItemAddedNotInFitting), the fighters' refusals. */
  hold: { readonly facts: HoldFacts; readonly notInFitting: number[]; readonly errors: SimulationUserError[] },
): SimulatedShip {
  const loaded = loadSimulatedShip(staticData, shipTypeID, pilot, brain, { clock });
  const simulation: SimulatedShip = { ...loaded, selectedDrones: new Map(), cargo: new Map(), changed: false, ghosts: 0 };
  const { location, ship } = simulation;
  const modules = fitData.filter((item) => ALL_SLOT_FLAGS.has(item.flagID)).sort((left, right) => right.flagID - left.flagID);
  for (const item of modules) {
    const subsystemSlot = location.static.types[item.typeID]?.attributes.find(([id]) => id === ATTRIBUTE_SUBSYSTEM_SLOT)?.[1];
    fitModuleChecked(simulation, item.typeID, subsystemSlot ? Math.trunc(subsystemSlot) : item.flagID);
  }
  activateOnLoading(location, ship);
  const quantities = new Map<number, number>();
  for (const item of fitData) if (item.flagID === FLAG_DRONE_BAY) quantities.set(item.typeID, (quantities.get(item.typeID) ?? 0) + item.quantity);
  const fitted: DogmaItem[] = [];
  for (const [typeID, quantity] of quantities) {
    for (let at = 0; at < quantity; at += 1) {
      const drone = fitDrone(simulation, typeID);
      if (!drone) break;
      fitted.push(drone);
    }
  }
  for (const drone of dronesByDamage(location, fitted)) registerDrone(simulation, drone);
  // FitFighters, then AddItemsToCargo: the fitting's fighters, and its cargo each type as much as it holds.
  const fighters = fitFighters(simulation, fitData, hold.facts, hold.notInFitting);
  hold.errors.push(...fighters.errors);
  if (!fighters.raised) hold.notInFitting.push(...fitItemsToCargo(simulation, cargoQuantities(fitData), hold.facts));
  simulation.changed = false;
  return simulation;
}

/**
 * The simulated hull's slots, as many of each kind as it has (its hiSlots, medSlots, lowSlots, rigSlots and
 * maxSubSystems as the simulation reckons them, a strategic cruiser's of its subsystems), by family and index, with
 * their flags; and a slot it no longer has that still holds a module (a subsystem taken away), which the client draws
 * with its module (slot.UpdateFitting: enabled where it has a module).
 */
export function simulatedSlotLayout(simulation: SimulatedShip): { readonly family: "high" | "mid" | "low" | "rig" | "subsystem"; readonly index: number; readonly flagID: number; readonly present: boolean }[] {
  const { location, ship } = simulation;
  const count = (attributeID: number, most: number) => Math.max(0, Math.min(most, Math.trunc(location.value(ship, attributeID))));
  const layout: { family: "high" | "mid" | "low" | "rig" | "subsystem"; index: number; flagID: number; present: boolean }[] = [];
  const add = (family: "high" | "mid" | "low" | "rig" | "subsystem", first: number, total: number) => {
    for (let index = 0; index < total; index += 1) layout.push({ family, index, flagID: first + index, present: true });
  };
  add("high", 27, count(ATTRIBUTE_HI_SLOTS, 8));
  add("mid", 19, count(ATTRIBUTE_MED_SLOTS, 8));
  add("low", 11, count(ATTRIBUTE_LOW_SLOTS, 8));
  add("rig", 92, count(ATTRIBUTE_RIG_SLOTS, 3));
  add("subsystem", 125, count(ATTRIBUTE_MAX_SUBSYSTEMS, 4));
  const families: readonly (readonly ["high" | "mid" | "low" | "rig", number, number])[] = [["high", 27, 34], ["mid", 19, 26], ["low", 11, 18], ["rig", 92, 94]];
  for (const item of fittedModules(simulation)) {
    const flag = item.flagID;
    const family = flag === null ? undefined : families.find(([, first, last]) => flag >= first && flag <= last);
    if (flag === null || family === undefined || layout.some((slot) => slot.flagID === flag)) continue;
    layout.push({ family: family[0], index: flag - family[1], flagID: flag, present: false });
  }
  const order = ["high", "mid", "low", "rig", "subsystem"];
  layout.sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family) || a.index - b.index);
  return layout;
}

/** The drone panel of a simulated ship: the drones selected, the bandwidth they take, their damage a second. */
export function simulatedDrones(simulation: SimulatedShip): DroneReading {
  const value = (item: DogmaItem, attributeID: number): number => simulation.location.value(item, attributeID);
  const readings = { accurate: value, value };
  let count = 0;
  for (const quantity of simulation.selectedDrones.values()) count += quantity;
  return {
    activeDrones: count,
    bandwidthUsed: activeDroneBandwidth(simulation.ship, readings, simulation.selectedDrones).used,
    dps: activeDroneDps(simulation.ship, readings, simulation.selectedDrones, simulatedMaxActiveDrones(simulation)),
  };
}
