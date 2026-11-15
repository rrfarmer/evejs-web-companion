// The Fitting window's warnings as the client evaluates them (shipfitting/fittingWarnings.py EvaluateFit,
// shipfitting/fittingWarningConst.py) and as its warnings tooltip lists them
// (ui/shared/fittingScreen/warningIconTooltip.py EvaluateFitAndPopulateTooltip): which warnings a fitting has, each
// its level, the slots it is shown on and the rows under it, in the tooltip's order.
//
// Reckoned so far: the missing subsystems, modules in slots the hull has not, the CPU, powergrid and calibration
// overloaded, the cargo hold overloaded, the tanking warnings (dual tanked, a shield hull armour tanked and the other
// way round), mixed turret groups, launcher groups and turret sizes, polarized weapons, offline modules, undersized and
// inefficient propulsion modules, bubble immunity disabled, the modules missing their charges, the stacking
// penalties, and the modules giving no bonus. Not read: a mutated item's own attributes (GetMutaplasmidAttributeIDs),
// which the bonus check adds to its type's.

import type { DogmaStatic } from "./location.ts";
import { usedWithCandidate, usedWithChargeGroups, usedWithPair } from "./chargeCompatibility.ts";
import { intDictOrder } from "../py27DictOrder.ts";

/** fittingWarningConst's levels. */
export const WARNING_LEVEL_LOW = 1;
export const WARNING_LEVEL_MEDIUM = 2;
export const WARNING_LEVEL_HIGH = 3;
export const WARNING_LEVEL_SKILL = 4;

/** colorByWarningLevel: WHITE, YELLOW, RED, ORANGE, as the client's RGBA fractions. */
export const COLOR_BY_LEVEL: Readonly<Record<number, string>> = {
  [WARNING_LEVEL_LOW]: "rgb(90% 90% 90%)",
  [WARNING_LEVEL_MEDIUM]: "rgb(100% 78% 0%)",
  [WARNING_LEVEL_HIGH]: "rgb(80% 0% 0%)",
  [WARNING_LEVEL_SKILL]: "rgb(100% 50% 0%)",
};

/** headerByWarningLevel. */
export const HEADER_BY_LEVEL: Readonly<Record<number, string>> = {
  [WARNING_LEVEL_LOW]: "UI/Fitting/FittingWindow/Warnings/HeaderLow",
  [WARNING_LEVEL_MEDIUM]: "UI/Fitting/FittingWindow/Warnings/HeaderMedium",
  [WARNING_LEVEL_HIGH]: "UI/Fitting/FittingWindow/Warnings/HeaderHigh",
  [WARNING_LEVEL_SKILL]: "UI/Fitting/FittingWindow/Warnings/HeaderSkills",
};

/** fittingWarningConst's warning IDs. */
export const WARNING = Object.freeze({
  MISSING_SUBSYSTEMS: 1,
  MODULES_IN_INVALID_FLAGS: 2,
  ARMOR_TANKED_SHIELD_SHIP: 3,
  SHIELD_TANKED_ARMOR_SHIP: 4,
  WRONG_TANKING: 5,
  NOT_PROVIDING_BONUS: 6,
  MIXING_TURRET_GROUPS: 7,
  MIXING_LAUNCHER_GROUPS: 8,
  MIXING_TURRET_SIZES: 9,
  POLARIZED_WEAPONS: 10,
  DUAL_TANKED: 11,
  MULTI_TANKED: 12,
  OVER_CPU_POWER: 13,
  OVER_CPU: 14,
  OVER_POWERGRID: 15,
  OVERLOADED_CARGO: 16,
  OFFLINE_MODULES: 17,
  OVER_CALIBRATION: 18,
  MISSING_REQ_CHARGES: 19,
  MISSING_OPTIONAL_CHARGES: 20,
  STACKING_PENALTY_MED: 21,
  STACKING_PENALTY_LOW: 22,
  STACKING_PENALTY_TARGETED_LOW: 23,
  UNDERSIZED_PROP_MOD: 24,
  DISABLED_BUBBLE_IMMUNITY: 25,
  INEFFICIENT_PROP_MOD: 26,
});

const LABELS = "UI/Fitting/FittingWindow/Warnings/";
/** warningsByWarningID: each warning's level, its line's label and its hint's. */
export const WARNINGS_BY_ID: Readonly<Record<number, { readonly level: number; readonly short: string; readonly hint: string }>> = {
  [WARNING.MISSING_SUBSYSTEMS]: { level: WARNING_LEVEL_HIGH, short: `${LABELS}SubsystemShort`, hint: `${LABELS}SubsystemHint` },
  [WARNING.OVER_CPU]: { level: WARNING_LEVEL_HIGH, short: `${LABELS}CpuOverloadedShort`, hint: `${LABELS}CpuOverloadedHint` },
  [WARNING.OVER_POWERGRID]: { level: WARNING_LEVEL_HIGH, short: `${LABELS}PowergridOverloadedShort`, hint: `${LABELS}PowergridOverloadedHint` },
  [WARNING.OVER_CPU_POWER]: { level: WARNING_LEVEL_HIGH, short: `${LABELS}CpuPowergridOverloadedShort`, hint: `${LABELS}CpuPowergridOverloadedHint` },
  [WARNING.OVER_CALIBRATION]: { level: WARNING_LEVEL_HIGH, short: `${LABELS}CalibrationOverloadedShort`, hint: `${LABELS}CalibrationOverloadedHint` },
  [WARNING.OVERLOADED_CARGO]: { level: WARNING_LEVEL_HIGH, short: `${LABELS}CargoOverloadedShort`, hint: `${LABELS}CargoOverloadedHint` },
  [WARNING.MODULES_IN_INVALID_FLAGS]: { level: WARNING_LEVEL_HIGH, short: `${LABELS}ModulesInInvalidSlotsShort`, hint: `${LABELS}ModulesInInvalidSlotsHint` },
  [WARNING.WRONG_TANKING]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}IncorrectTankingShort`, hint: `${LABELS}IncorrectTankingHint` },
  [WARNING.NOT_PROVIDING_BONUS]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}NotProvidingBonusShort`, hint: `${LABELS}NotProvidingBonusHint` },
  [WARNING.MIXING_TURRET_GROUPS]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}MixingTurretGroupsShort`, hint: `${LABELS}MixingTurretGroupsHint` },
  [WARNING.MIXING_LAUNCHER_GROUPS]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}MixingLauncherGroupsShort`, hint: `${LABELS}MixingLauncherGroupsHint` },
  [WARNING.MIXING_TURRET_SIZES]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}MixingTurretSizesShort`, hint: `${LABELS}MixingTurretSizesHint` },
  [WARNING.DUAL_TANKED]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}ShipIsDualTankedShort`, hint: `${LABELS}ShipIsDualTankedHint` },
  [WARNING.MULTI_TANKED]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}ShipIsMultiTankedShort`, hint: `${LABELS}ShipIsMultiTankedHint` },
  [WARNING.OFFLINE_MODULES]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}OfflineModulesShort`, hint: `${LABELS}OfflineModulesHint` },
  [WARNING.STACKING_PENALTY_MED]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}StackingPenaltyMedShort`, hint: `${LABELS}StackingPenaltyMedHint` },
  [WARNING.UNDERSIZED_PROP_MOD]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}UndersizedPropModShort`, hint: `${LABELS}UndersizedPropModHint` },
  [WARNING.DISABLED_BUBBLE_IMMUNITY]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}BubbleImmunityDisabledShort`, hint: `${LABELS}BubbleImmunityDisabledHint` },
  [WARNING.INEFFICIENT_PROP_MOD]: { level: WARNING_LEVEL_MEDIUM, short: `${LABELS}InefficientPropModShort`, hint: `${LABELS}InefficientPropModHint` },
  [WARNING.POLARIZED_WEAPONS]: { level: WARNING_LEVEL_LOW, short: `${LABELS}PolarizedWeaponsFittedShort`, hint: `${LABELS}PolarizedWeaponsFittedHint` },
  [WARNING.ARMOR_TANKED_SHIELD_SHIP]: { level: WARNING_LEVEL_LOW, short: `${LABELS}ArmorTankingShieldShipShort`, hint: `${LABELS}ArmorTankingShieldShipHint` },
  [WARNING.SHIELD_TANKED_ARMOR_SHIP]: { level: WARNING_LEVEL_LOW, short: `${LABELS}ShieldTankingArmorShipShort`, hint: `${LABELS}ShieldTankingArmorShipHint` },
  [WARNING.MISSING_REQ_CHARGES]: { level: WARNING_LEVEL_LOW, short: `${LABELS}MissingChargesForRequiredShort`, hint: `${LABELS}MissingChargesForRequiredHint` },
  [WARNING.MISSING_OPTIONAL_CHARGES]: { level: WARNING_LEVEL_LOW, short: `${LABELS}MissingChargesForOptionalShort`, hint: `${LABELS}MissingChargesForOptionalHint` },
  [WARNING.STACKING_PENALTY_LOW]: { level: WARNING_LEVEL_LOW, short: `${LABELS}StackingPenaltyLowShort`, hint: `${LABELS}StackingPenaltyLowHint` },
  [WARNING.STACKING_PENALTY_TARGETED_LOW]: { level: WARNING_LEVEL_LOW, short: `${LABELS}StackingPenaltyTargetedLowShort`, hint: `${LABELS}StackingPenaltyTargetedLowHint` },
};

/** warningIconTooltip: the warnings' lines in the tooltip's order (EvaluateFitAndPopulateTooltip). */
const TOOLTIP_ORDER: readonly number[] = [
  WARNING.MISSING_SUBSYSTEMS, WARNING.MODULES_IN_INVALID_FLAGS, WARNING.OVER_CPU, WARNING.OVER_POWERGRID, WARNING.OVER_CALIBRATION,
  WARNING.OVERLOADED_CARGO, WARNING.DUAL_TANKED, WARNING.MULTI_TANKED, WARNING.ARMOR_TANKED_SHIELD_SHIP, WARNING.SHIELD_TANKED_ARMOR_SHIP,
  WARNING.NOT_PROVIDING_BONUS, WARNING.MIXING_TURRET_GROUPS, WARNING.MIXING_LAUNCHER_GROUPS, WARNING.MIXING_TURRET_SIZES,
  WARNING.OFFLINE_MODULES, WARNING.POLARIZED_WEAPONS, WARNING.MISSING_REQ_CHARGES, WARNING.MISSING_OPTIONAL_CHARGES,
  WARNING.UNDERSIZED_PROP_MOD, WARNING.INEFFICIENT_PROP_MOD, WARNING.STACKING_PENALTY_MED, WARNING.STACKING_PENALTY_LOW,
  WARNING.STACKING_PENALTY_TARGETED_LOW, WARNING.DISABLED_BUBBLE_IMMUNITY,
];

/** The semiflags a warning on the CPU's and the powergrid's gauges is shown on (-WARNING_OVER_CPU, -WARNING_OVER_POWERGRID). */
export const FLAG_CPU_GAUGE = -WARNING.OVER_CPU;
export const FLAG_POWERGRID_GAUGE = -WARNING.OVER_POWERGRID;
const FLAG_CARGO = 5;

/** inventorycommon const: the slots' flags. */
const MODULE_SLOT_FLAGS: readonly number[] = Array.from({ length: 24 }, (_, at) => 11 + at);
const HI_SLOT_FLAGS: readonly number[] = [27, 28, 29, 30, 31, 32, 33, 34];
const SUBSYSTEM_SLOT_FLAGS: readonly number[] = [125, 126, 127, 128];
const RIG_SLOT_FLAGS: readonly number[] = [92, 93, 94];
const FITTING_FLAGS: ReadonlySet<number> = new Set([...MODULE_SLOT_FLAGS, ...SUBSYSTEM_SLOT_FLAGS, ...RIG_SLOT_FLAGS, 164, 165, 166, 167, 168, 169, 170, 171]);

const GROUP_STRATEGIC_CRUISER = 963;
const CATEGORY_MODULE = 7;
const CATEGORY_STRUCTURE = 65;
const CATEGORY_STRUCTURE_MODULE = 66;
const ATTRIBUTE_CHARGE_SIZE = 128;
const ATTRIBUTE_TECH_LEVEL = 422;
const EFFECT_LAUNCHER_FITTED = 40;
const EFFECT_RESISTANCE_KILLER_HULL_ALL = 5994;
const EFFECT_RESISTANCE_KILLER_SHIELD_ARMOR_ALL = 5995;
/** carbon const FLOAT_TOLERANCE. */
const FLOAT_TOLERANCE = 0.001;

/** TURRET_GROUPS: projectile, hybrid, energy and precursor weapons; and iconPathsByTurretGroup. */
const TURRET_GROUPS: readonly number[] = [55, 74, 53, 1986];
const ICON_BY_TURRET_GROUP: Readonly<Record<number, string>> = {
  55: "res:/UI/Texture/Icons/12_64_9.png",
  74: "res:/UI/Texture/Icons/13_64_1.png",
  53: "res:/UI/Texture/Icons/13_64_9.png",
  1986: "res:/UI/Texture/Icons/Modules/disintegratorCannonS.png",
};
/** HARD_CODED_GROUPIDS: the civilian turrets, each taken for its weapon group. */
const HARD_CODED_GROUP_IDS: Readonly<Record<number, number>> = { 3636: 55, 3638: 74, 3640: 74, 3634: 53 };
/** iconPathForSizes. */
const ICON_BY_SIZE: Readonly<Record<number, string>> = {
  1: "res:/UI/Texture/classes/Fitting/Small.png",
  2: "res:/UI/Texture/classes/Fitting/Medium.png",
  3: "res:/UI/Texture/classes/Fitting/Large.png",
  4: "res:/UI/Texture/classes/Fitting/XLarge.png",
};
/** SUBSYSTEM_INFO_BY_SLOT: each subsystem slot's group and icon. */
const SUBSYSTEM_INFO_BY_SLOT: Readonly<Record<number, { readonly groupID: number; readonly icon: string }>> = {
  125: { groupID: 958, icon: "res:/UI/Texture/Icons/81_64_11.png" },
  126: { groupID: 954, icon: "res:/UI/Texture/Icons/81_64_10.png" },
  127: { groupID: 956, icon: "res:/UI/Texture/Icons/81_64_12.png" },
  128: { groupID: 957, icon: "res:/UI/Texture/Icons/81_64_13.png" },
};
/** evetypes TYPE_LIST_FITTING_WARNINGS_SHIELD, ARMOR, HULL: the tanking modules of each layer. */
export const TYPE_LIST_FITTING_WARNINGS_SHIELD = 145;
export const TYPE_LIST_FITTING_WARNINGS_ARMOR = 146;
export const TYPE_LIST_FITTING_WARNINGS_HULL = 147;
/** evetypes TYPE_LIST_FITTING_WARNINGS_USE_OPTIONAL_CHARGES and _NEED_CHARGES. */
export const TYPE_LIST_FITTING_WARNINGS_USE_OPTIONAL_CHARGES = 216;
export const TYPE_LIST_FITTING_WARNINGS_NEED_CHARGES = 217;
/** evetypes TYPE_LIST_FITTING_WARNINGS_BUFFING: the modules whose bonus the warnings look for something to take. */
export const TYPE_LIST_FITTING_WARNINGS_BUFFING = 148;
/** The type lists the warnings go by, to read for the fitted types. */
export const WARNING_TYPE_LISTS: readonly number[] = [
  TYPE_LIST_FITTING_WARNINGS_SHIELD, TYPE_LIST_FITTING_WARNINGS_ARMOR, TYPE_LIST_FITTING_WARNINGS_HULL,
  TYPE_LIST_FITTING_WARNINGS_BUFFING, TYPE_LIST_FITTING_WARNINGS_USE_OPTIONAL_CHARGES, TYPE_LIST_FITTING_WARNINGS_NEED_CHARGES,
];
/**
 * GROUPS_AFFECTING_MODULE_GROUPS: a module group and the groups it gives its bonus to. The drone link augmentor's and
 * the drone navigation computer's are every group of the drone category, and of the drone and fighter categories
 * (GetGroupIDsByCategory, GetGroupIDsByCategories), held here as those categories.
 */
const GROUPS_AFFECTING_MODULE_GROUPS: Readonly<Record<number, { readonly groups: readonly number[]; readonly categories: readonly number[] }>> = {
  59: { groups: [55], categories: [] },
  302: { groups: [74], categories: [] },
  205: { groups: [53], categories: [] },
  645: { groups: [100, 1653, 1652, 4777, 4779], categories: [] },
  1988: { groups: [1986], categories: [] },
  647: { groups: [], categories: [18] },
  644: { groups: [], categories: [18, 87] },
};
/** DRONE_AND_FIGHTER_BAYS: flagDroneBay, flagFighterBay and fighterTubeFlags. */
const DRONE_AND_FIGHTER_BAYS: ReadonlySet<number> = new Set([87, 158, 159, 160, 161, 162, 163]);
/**
 * The effects baseEffectCompiler.GetPythonEffects makes python ones in the client's effect compiler
 * (clientEffectCompiler), which hold no compiled modifiers (taken from the compiled classes through the python27 oracle).
 */
const BASE_PYTHON_EFFECT_IDS: ReadonlySet<number> = new Set([
  16, 40, 42, 54, 660, 661, 662, 668, 848, 876, 878, 1730, 1851, 2192, 2193, 2194, 2195, 2196, 2197, 2663, 3772, 3773, 3774,
]);
/** The kinds of modifier CreateEffect makes (modifierGetterByType, GetSideEffectClassByTypeString); an effect with another fails to load. */
const COMPILED_MODIFIER_FUNCS: ReadonlySet<string> = new Set([
  "ItemModifier", "LocationRequiredSkillModifier", "OwnerRequiredSkillModifier", "LocationModifier", "LocationGroupModifier", "EffectStopper",
]);
/** appConst categoryCharge, flagCargo, flagSpecializedAmmoHold; attributeCapacity, attributeVolume. */
const CATEGORY_CHARGE = 8;
const FLAG_SPECIALIZED_AMMO_HOLD = 143;
const ATTRIBUTE_CAPACITY = 38;
const ATTRIBUTE_VOLUME = 161;
/** fittingWarningsCharges TREAT_AS_FULL: a scan probe launcher full at eight. */
const TREAT_AS_FULL: Readonly<Record<number, number>> = { 481: 8 };
/** fittingWarningConst INFO_BUBBLE_SHIELD, INFO_BUBBLE_ARMOR, INFO_BUBBLE_SHIELD_OR_ARMOR: a hull's tanking elements. */
const INFO_BUBBLE_SHIELD = 20;
const INFO_BUBBLE_ARMOR = 7;
const INFO_BUBBLE_SHIELD_OR_ARMOR = 2046;
/** NON_PROP_MOD_GROUPS (groupFreighter), groupPropulsionModule, groupInterdictionNullifier. */
const GROUP_FREIGHTER = 513;
const GROUP_PROPULSION_MODULE = 46;
const GROUP_INTERDICTION_NULLIFIER = 4117;
/** dogma const attributeMass, attributeSpeedBoostFactor, attributeWarpBubbleImmune, attributeWarpBubbleImmuneModifier. */
const ATTRIBUTE_MASS = 4;
const ATTRIBUTE_SPEED_BOOST_FACTOR = 567;
const ATTRIBUTE_WARP_BUBBLE_IMMUNE = 1538;
const ATTRIBUTE_WARP_BUBBLE_IMMUNE_MODIFIER = 1539;
/** MASS_SPEEDBOOST_MAX_RATIO. */
const MASS_SPEEDBOOST_MAX_RATIO = 2.0;

/** shipmode/data.py _DATA: the hulls that have stances (ship_has_stances). */
const HULLS_WITH_STANCES: ReadonlySet<number> = new Set([34317, 34562, 34828, 35683, 89808, 89807]);

/** A row under a warning's line in the tooltip (its fullVersion), with the slots it is shown on. */
export type FitWarningRow =
  | { readonly kind: "subsystem"; readonly flagID: number; readonly groupID: number; readonly icon: string }
  | { readonly kind: "module"; readonly typeID: number; readonly flagID: number }
  | { readonly kind: "group"; readonly groupID: number; readonly icon: string | null; readonly flags: readonly number[] }
  | { readonly kind: "size"; readonly size: number; readonly icon: string | null; readonly flags: readonly number[] }
  /** AddAttributes: an attribute penalized, the skill its change is for, the modules making it (modulesKey: which, sorted). */
  | { readonly kind: "attribute"; readonly attributeID: number; readonly skillTypeID: number | null; readonly flags: readonly number[]; readonly modulesKey: string };

/** A warning the fitting has: its level, the slots it is shown on, the rows under its line. */
export interface FitWarning {
  readonly warningID: number;
  readonly level: number;
  readonly flags: readonly number[];
  readonly rows: readonly FitWarningRow[];
}

/** What EvaluateFit goes by, as the window's controller and the current fitting give it. */
export interface FitWarningInputs {
  readonly static: DogmaStatic;
  readonly shipTypeID: number;
  /** GetFittingDictForCurrentFittingWindowShip's fitting (CreateFittingData): each (typeID, flagID, qty). */
  readonly fit: readonly (readonly [number, number, number])[];
  /** The controller's dogma location's SlotExists of the ship. */
  readonly slotExists: (flagID: number) => boolean;
  /** GetCPULoad/Output, GetPowerLoad/Output, GetCalibrationLoad/Output (GetStatsInfo), where known. */
  readonly resources: Readonly<Record<"cpu" | "powergrid" | "calibration", { readonly load: number; readonly output: number } | null>>;
  /** The cargo hold's capacity and use (GetCapacity(flagCargo)); null where it is not read. */
  readonly cargo: { readonly capacity: number; readonly used: number } | null;
  /** FindOfflineModules: the ship's offline modules, (typeID, flagID); none while simulating. */
  readonly offlineModules: readonly (readonly [number, number])[];
  /** The dogma location's GetFittedItemsToShip: each item fitted to the ship, (typeID, flagID). */
  readonly fittedItems: readonly (readonly [number, number])[];
  /** The type lists a type is on, of the warnings' (WARNING_TYPE_LISTS). */
  readonly typeLists: (typeID: number) => ReadonlySet<number>;
  /** cfg.infoBubbleTypeElements of the ship's type: its elements; null where it has none. */
  readonly shipElements: readonly number[] | null;
  /**
   * FindModulesWithMissingCharges' fitting: each item fitted in a module slot (a module one, a charge its quantity:
   * GetQuantity) and each stack in the cargo hold and the specialized ammo hold (GetHoldItems), (typeID, flagID, qty);
   * null where the ship's item is no ship.
   */
  readonly chargesFit: readonly (readonly [number, number, number])[] | null;
  /** fittingSvc.GetFighterTypesInTubes: the types of the squadrons in the tubes. */
  readonly fighterTypesInTubes: readonly number[];
  /** evetypes.GetTypeIDsByGroup of a group, for the used-with table; undefined where it is not read. */
  readonly groupTypes: (groupID: number) => readonly number[] | undefined;
  /** skills.GetRequiredSkillsRecursive of a type: every skill it needs however deep; null where it is not read. */
  readonly requiredSkillsOf: (typeID: number) => ReadonlySet<number> | null;
}

/**
 * infoSvc.GetUsedWithTypeIDs of a module, of the charges named: a published charge in one of the module's charge
 * groups, its volume within the module's capacity, its size the module's where the module has one
 * (_AddUsedWithTypeIDs). Null for a module not published or with no charge groups.
 */
function usedWithOf(staticData: DogmaStatic, moduleTypeID: number, chargeTypeIDs: readonly number[]): number[] | null {
  const module = staticData.types[moduleTypeID];
  if (!usedWithCandidate(module) || usedWithChargeGroups(module).length === 0) return null;
  return chargeTypeIDs.filter(chargeTypeID => usedWithPair(module, staticData.types[chargeTypeID]));
}

/**
 * fittingWarningsCharges.FindModulesMissingCharges: the modules that need charges (list 217) and those that take
 * optional ones (list 216), each with no charge, or short by more than one of full (its capacity over the charge's
 * volume, a scan probe launcher's eight), that the charges in the cargo and ammo holds cannot fill
 * (FindModulesThatCannotBeFilled: the modules of the same usable charges and capacity together, each charge's full
 * rounds taken off them in turn).
 */
/**
 * infoSvc.GetUsedWithTypeIDs of a module as the table of every type gives it: the charges of its groups it may use.
 * Null where the table has nothing for it (no charge it may use at all); undefined where a group's types or a charge's
 * facts are not read.
 */
export function usedWithTypeIDs(staticData: DogmaStatic, moduleTypeID: number, groupTypes: (groupID: number) => readonly number[] | undefined): number[] | null | undefined {
  const module = staticData.types[moduleTypeID];
  const chargeGroups = usedWithChargeGroups(module);
  if (!usedWithCandidate(module) || chargeGroups.length === 0) return null;
  const candidates = new Set<number>();
  for (const groupID of chargeGroups) {
    const types = groupTypes(groupID);
    if (types === undefined) return undefined;
    for (const typeID of types) candidates.add(typeID);
  }
  if ([...candidates].some((typeID) => !Object.hasOwn(staticData.types, typeID))) return undefined;
  const usable = usedWithOf(staticData, moduleTypeID, [...candidates]) ?? [];
  return usable.length > 0 ? usable : null;
}

function findModulesMissingCharges(
  staticData: DogmaStatic,
  currentFit: readonly (readonly [number, number, number])[],
  lists: (typeID: number) => ReadonlySet<number>,
  usedWithTable: (typeID: number) => number[] | null | undefined,
): { readonly required: [number, number][]; readonly optional: [number, number][] } {
  const chargesInFlags = new Map<number, [number, number][]>();
  for (const [typeID, flagID, qty] of currentFit) {
    if (staticData.types[typeID]?.categoryID !== CATEGORY_CHARGE) continue;
    const list = chargesInFlags.get(flagID) ?? [];
    list.push([typeID, qty]);
    chargesInFlags.set(flagID, list);
  }
  // _GetAllChargesInHolds: the cargo hold's and the ammo hold's charges by type.
  const chargesLeft = new Map<number, number>();
  for (const flagID of intDictOrder([...chargesInFlags.keys()])) {
    if (flagID !== FLAG_CARGO && flagID !== FLAG_SPECIALIZED_AMMO_HOLD) continue;
    for (const [chargeTypeID, qty] of chargesInFlags.get(flagID) ?? []) chargesLeft.set(chargeTypeID, (chargesLeft.get(chargeTypeID) ?? 0) + qty);
  }
  const needing: [number, number][] = currentFit.filter(([typeID]) => lists(typeID).has(TYPE_LIST_FITTING_WARNINGS_NEED_CHARGES)).map(([typeID, flagID]) => [typeID, flagID]);
  const optional: [number, number][] = currentFit.filter(([typeID]) => lists(typeID).has(TYPE_LIST_FITTING_WARNINGS_USE_OPTIONAL_CHARGES)).map(([typeID, flagID]) => [typeID, flagID]);
  const withoutCharges: [number, number][] = [];
  const partiallyFull = new Map<number, [number, number, number][]>();
  for (const [moduleTypeID, flagID] of [...needing, ...optional]) {
    const loaded = chargesInFlags.get(flagID);
    if (!loaded) {
      withoutCharges.push([moduleTypeID, flagID]);
      continue;
    }
    const [chargeTypeID, chargeQty] = loaded[0]!;
    let qtyFull = Math.trunc((typeAttribute(staticData, moduleTypeID, ATTRIBUTE_CAPACITY) ?? 0) / (typeAttribute(staticData, chargeTypeID, ATTRIBUTE_VOLUME) ?? 0));
    const overridden = TREAT_AS_FULL[staticData.types[moduleTypeID]?.groupID ?? -1];
    if (overridden && overridden < qtyFull) qtyFull = overridden;
    if (qtyFull - chargeQty > 1) {
      const list = partiallyFull.get(chargeTypeID) ?? [];
      list.push([moduleTypeID, flagID, chargeQty]);
      partiallyFull.set(chargeTypeID, list);
    }
  }
  for (const chargeTypeID of intDictOrder([...partiallyFull.keys()])) {
    for (const [moduleTypeID, flagID, chargeQty] of partiallyFull.get(chargeTypeID) ?? []) {
      withoutCharges.push([moduleTypeID, flagID]);
      chargesLeft.set(chargeTypeID, (chargesLeft.get(chargeTypeID) ?? 0) + chargeQty);
    }
  }
  // GetGroupsDict and FindModulesThatCannotBeFilled.
  const chargeTypesLeft = [...chargesLeft.keys()];
  const groupings = new Map<string, { readonly chargeTypeIDs: readonly number[]; readonly capacity: number; readonly modules: [number, number][] }>();
  for (const [moduleTypeID, flagID] of withoutCharges) {
    // _GetUsedWithTuple: the table's charges of the module that are left in the holds (where the table is not read,
    // those left reckoned alone); a module the table has nothing for passed over.
    const all = usedWithTable(moduleTypeID);
    const usedWith = all === undefined ? usedWithOf(staticData, moduleTypeID, chargeTypesLeft) : all === null ? null : all.filter((typeID) => chargesLeft.has(typeID));
    if (usedWith === null) continue;
    const chargeTypeIDs = [...new Set(usedWith)].sort((a, b) => a - b);
    const capacity = typeAttribute(staticData, moduleTypeID, ATTRIBUTE_CAPACITY) ?? 0;
    const key = `${chargeTypeIDs.join(",")}|${capacity}`;
    const group = groupings.get(key) ?? { chargeTypeIDs, capacity, modules: [] };
    group.modules.push([moduleTypeID, flagID]);
    groupings.set(key, group);
  }
  const cannotBeFilled: [number, number][] = [];
  for (const { chargeTypeIDs, capacity, modules } of groupings.values()) {
    let leftToFill = modules.length;
    let filled = false;
    for (const chargeTypeID of chargeTypeIDs) {
      const qtyForFull = Math.trunc(capacity / (typeAttribute(staticData, chargeTypeID, ATTRIBUTE_VOLUME) ?? 0));
      leftToFill -= Math.trunc((chargesLeft.get(chargeTypeID) ?? 0) / qtyForFull);
      if (leftToFill <= 0) {
        filled = true;
        break;
      }
    }
    if (!filled) cannotBeFilled.push(...modules);
  }
  const among = (pairs: readonly [number, number][]) => (pair: [number, number]) => pairs.some(([typeID, flagID]) => typeID === pair[0] && flagID === pair[1]);
  return { required: cannotBeFilled.filter(among(needing)), optional: cannotBeFilled.filter(among(optional)) };
}

function typeAttribute(staticData: DogmaStatic, typeID: number, attributeID: number): number | null {
  return staticData.types[typeID]?.attributes.find(([id]) => id === attributeID)?.[1] ?? null;
}

function hasEffect(staticData: DogmaStatic, typeID: number, effectID: number): boolean {
  return staticData.types[typeID]?.effects.includes(effectID) ?? false;
}

/**
 * _GetSkillsAnModifiedAttributesForSkillModifier: of each of a type's effects as the client's effect compiler holds it
 * (one with modifierInfo a ModifierEffect of its modifiers, CreateEffect; none where it has no modifierInfo, where one
 * of its kinds is none CreateEffect makes, or where it is one of baseEffectCompiler's python effects, which hold no
 * modifiers), each LocationRequiredSkillModifier on the ship: its skill and the attribute it changes.
 */
function shipSkillModifiers(staticData: DogmaStatic, typeID: number): (readonly [number, number])[] {
  const pairs: (readonly [number, number])[] = [];
  for (const effectID of staticData.types[typeID]?.effects ?? []) {
    if (BASE_PYTHON_EFFECT_IDS.has(effectID)) continue;
    const modifiers = staticData.effects[effectID]?.modifiers ?? [];
    if (modifiers.length === 0 || modifiers.some((modifier) => !COMPILED_MODIFIER_FUNCS.has(modifier.func ?? ""))) continue;
    for (const modifier of modifiers) {
      // IsShipModifier: the ship its domain. A skill or attribute that is none matches no type.
      if (modifier.func !== "LocationRequiredSkillModifier" || modifier.domain !== "shipID") continue;
      if (modifier.skillTypeID === null || modifier.modifiedAttributeID === null) continue;
      pairs.push([modifier.skillTypeID, modifier.modifiedAttributeID]);
    }
  }
  return pairs;
}

/** GetTypeIDsBySkill: of the types, those whose skills (GetRequiredSkillsRecursive) take in each skill asked; null where any type's are not read. */
function typesBySkill(typeIDs: Iterable<number>, skills: ReadonlySet<number>, requiredSkillsOf: (typeID: number) => ReadonlySet<number> | null): Map<number, Set<number>> | null {
  const bySkill = new Map<number, Set<number>>();
  for (const typeID of typeIDs) {
    const required = requiredSkillsOf(typeID);
    if (required === null) return null;
    for (const skillTypeID of required) {
      if (!skills.has(skillTypeID)) continue;
      const types = bySkill.get(skillTypeID) ?? new Set<number>();
      types.add(typeID);
      bySkill.set(skillTypeID, types);
    }
  }
  return bySkill;
}

/** GetTypeIDsByAttributeIDs: of the types, those with each attribute asked among theirs (get_type_attributes_by_id). */
function typesByAttribute(staticData: DogmaStatic, typeIDs: Iterable<number>, attributes: ReadonlySet<number>): Map<number, Set<number>> {
  const byAttribute = new Map<number, Set<number>>();
  for (const typeID of typeIDs) {
    for (const [attributeID] of staticData.types[typeID]?.attributes ?? []) {
      if (!attributes.has(attributeID)) continue;
      const types = byAttribute.get(attributeID) ?? new Set<number>();
      types.add(typeID);
      byAttribute.set(attributeID, types);
    }
  }
  return byAttribute;
}

/**
 * FindModulesNotProvidingBonusBasedOnSkillModifier: of the modules looked into, those with a skill modifier on the ship
 * (shipSkillModifiers) that no fitted type takes, one needing the skill and having the attribute; nor any charge a
 * fitted launcher may use (infoSvc.GetUsedWithTypeIDs). Where a type's skills or a launcher's charges are not read, the
 * module is not said to give none.
 */
function modulesNotProvidingBonusBySkill(
  staticData: DogmaStatic,
  fittedTypeIDs: readonly number[],
  lookedInto: ReadonlySet<number>,
  requiredSkillsOf: (typeID: number) => ReadonlySet<number> | null,
  usedWith: (typeID: number) => number[] | null | undefined,
): Set<number> {
  const skillsOfInterest = new Set<number>();
  const attributesOfInterest = new Set<number>();
  const needed = new Map<number, (readonly [number, number])[]>();
  for (const typeID of lookedInto) {
    const pairs = shipSkillModifiers(staticData, typeID);
    if (pairs.length === 0) continue;
    for (const [skillTypeID, attributeID] of pairs) {
      skillsOfInterest.add(skillTypeID);
      attributesOfInterest.add(attributeID);
    }
    needed.set(typeID, pairs);
  }
  if (needed.size === 0) return new Set();
  const takes = (bySkill: ReadonlyMap<number, ReadonlySet<number>>, byAttribute: ReadonlyMap<number, ReadonlySet<number>>, pairs: readonly (readonly [number, number])[]) =>
    pairs.some(([skillTypeID, attributeID]) => {
      const withAttribute = byAttribute.get(attributeID);
      return withAttribute !== undefined && [...(bySkill.get(skillTypeID) ?? [])].some((typeID) => withAttribute.has(typeID));
    });
  const bySkill = typesBySkill(fittedTypeIDs, skillsOfInterest, requiredSkillsOf);
  if (bySkill === null) return new Set();
  const byAttribute = typesByAttribute(staticData, fittedTypeIDs, attributesOfInterest);
  const providing = new Set<number>();
  for (const [typeID, pairs] of needed) if (takes(bySkill, byAttribute, pairs)) providing.add(typeID);
  for (const [typeID, pairs] of needed) {
    if (providing.has(typeID)) continue;
    for (const fittedTypeID of fittedTypeIDs) {
      if (!hasEffect(staticData, fittedTypeID, EFFECT_LAUNCHER_FITTED)) continue;
      const charges = usedWith(fittedTypeID);
      const chargesBySkill = charges ? typesBySkill(charges, skillsOfInterest, requiredSkillsOf) : charges;
      if (chargesBySkill === undefined || (charges && chargesBySkill === null)) {
        providing.add(typeID);
        break;
      }
      if (!charges || !chargesBySkill) continue;
      if (takes(chargesBySkill, typesByAttribute(staticData, charges, attributesOfInterest), pairs)) {
        providing.add(typeID);
        break;
      }
    }
  }
  return new Set([...needed.keys()].filter((typeID) => !providing.has(typeID)));
}

/**
 * FindModulesNotProvidingBonus: a fitted module whose group gives its bonus to groups (GROUPS_AFFECTING_MODULE_GROUPS)
 * none of which is fitted or among the drones and fighters; and each fitted module of a type on the buffing list that
 * gives no bonus by its skill modifiers. A module of such a group is not looked into further (its compiled loop goes
 * on to the next module either way, which the decompiled text does not show).
 */
function findModulesNotProvidingBonus(
  staticData: DogmaStatic,
  fittedModules: readonly (readonly [number, number, number])[],
  dronesAndFighters: ReadonlySet<number>,
  lists: (typeID: number) => ReadonlySet<number>,
  requiredSkillsOf: (typeID: number) => ReadonlySet<number> | null,
  usedWith: (typeID: number) => number[] | null | undefined,
): [number, number][] {
  const missing: [number, number][] = [];
  const items = [...fittedModules.map(([typeID]) => typeID), ...dronesAndFighters];
  const allFittedGroups = new Set(items.map((typeID) => staticData.types[typeID]?.groupID ?? null));
  const allFittedCategories = new Set(items.map((typeID) => staticData.types[typeID]?.categoryID ?? null));
  const lookedInto = new Set<number>();
  for (const [typeID, flagID] of fittedModules) {
    const affected = GROUPS_AFFECTING_MODULE_GROUPS[staticData.types[typeID]?.groupID ?? -1];
    if (affected) {
      if (!affected.groups.some((groupID) => allFittedGroups.has(groupID)) && !affected.categories.some((categoryID) => allFittedCategories.has(categoryID))) {
        missing.push([typeID, flagID]);
      }
      continue;
    }
    if (lists(typeID).has(TYPE_LIST_FITTING_WARNINGS_BUFFING)) lookedInto.add(typeID);
  }
  const fittedTypeIDs = [...new Set(fittedModules.map(([typeID]) => typeID))];
  const notProviding = modulesNotProvidingBonusBySkill(staticData, fittedTypeIDs, lookedInto, requiredSkillsOf, usedWith);
  for (const [typeID, flagID] of fittedModules) if (notProviding.has(typeID)) missing.push([typeID, flagID]);
  return missing;
}

/** _IsOverloaded: a difference below nought by more than the tolerance. */
function isOverloaded(value: number): boolean {
  return !(value > -FLOAT_TOLERANCE);
}

/** Pairs (typeID, flagID) grouped by a key, in the order each key is first met. */
function groupedBy(pairs: readonly (readonly [number, number])[], keyOf: (typeID: number) => number | null): Map<number, [number, number][]> {
  const grouped = new Map<number, [number, number][]>();
  for (const [typeID, flagID] of pairs) {
    const key = keyOf(typeID);
    if (key === null) continue;
    const list = grouped.get(key) ?? [];
    list.push([typeID, flagID]);
    grouped.set(key, list);
  }
  return grouped;
}

/**
 * EvaluateFit, of the warnings reckoned (see the head of this file), as the tooltip lists them: each warning with a
 * truthy result, in the tooltip's order (GetActiveWarningsByLevelFromResults counts the same ones).
 */
export function evaluateFit(inputs: FitWarningInputs): FitWarning[] {
  const { static: staticData, shipTypeID, fit } = inputs;
  const fittedModules = fit.filter(([, flagID]) => MODULE_SLOT_FLAGS.includes(flagID));
  const highSlotModules: [number, number][] = fittedModules.filter(([, flagID]) => HI_SLOT_FLAGS.includes(flagID)).map(([typeID, flagID]) => [typeID, flagID]);
  const shipType = staticData.types[shipTypeID];
  const found = new Map<number, Omit<FitWarning, "warningID" | "level">>();

  // FindMissingSubsystemFlags: a strategic cruiser's subsystem slots with nothing in them.
  if (shipType?.groupID === GROUP_STRATEGIC_CRUISER) {
    const filled = new Set(fit.filter(([, flagID]) => SUBSYSTEM_SLOT_FLAGS.includes(flagID)).map(([, flagID]) => flagID));
    const missing = SUBSYSTEM_SLOT_FLAGS.filter((flagID) => !filled.has(flagID));
    if (missing.length > 0) {
      found.set(WARNING.MISSING_SUBSYSTEMS, {
        flags: missing,
        rows: missing.map((flagID) => ({ kind: "subsystem", flagID, groupID: SUBSYSTEM_INFO_BY_SLOT[flagID]!.groupID, icon: SUBSYSTEM_INFO_BY_SLOT[flagID]!.icon })),
      });
    }
  }
  // FindModulesInNonExisitingSlots: a subsystem where the hull has a stance or no subsystems (HasSubsystems: tech
  // level above two); any other in a slot the hull has not.
  const hasStance = HULLS_WITH_STANCES.has(shipTypeID);
  const hasSubsystems = (typeAttribute(staticData, shipTypeID, ATTRIBUTE_TECH_LEVEL) ?? 0) > 2;
  const invalid: [number, number][] = [];
  for (const [typeID, flagID] of fit) {
    if (!FITTING_FLAGS.has(flagID)) continue;
    if (SUBSYSTEM_SLOT_FLAGS.includes(flagID)) {
      if (hasStance || !hasSubsystems) invalid.push([typeID, flagID]);
    } else if (!inputs.slotExists(flagID)) invalid.push([typeID, flagID]);
  }
  if (invalid.length > 0) found.set(WARNING.MODULES_IN_INVALID_FLAGS, { flags: [...new Set(invalid.map(([, flagID]) => flagID))], rows: [] });
  // IsOverOnPowergrid, IsOverOnCPU, IsOverOnCalibration: the output less the load below nought.
  const over = (resource: { readonly load: number; readonly output: number } | null) => resource !== null && isOverloaded(resource.output - resource.load);
  if (over(inputs.resources.powergrid)) found.set(WARNING.OVER_POWERGRID, { flags: [FLAG_POWERGRID_GAUGE], rows: [] });
  if (over(inputs.resources.cpu)) found.set(WARNING.OVER_CPU, { flags: [FLAG_CPU_GAUGE], rows: [] });
  if (over(inputs.resources.calibration)) found.set(WARNING.OVER_CALIBRATION, { flags: [...RIG_SLOT_FLAGS], rows: [] });
  // GetCargoOverloadedWarningID: the cargo hold's capacity less its use below nought; never a structure's.
  if (shipType?.categoryID !== CATEGORY_STRUCTURE && inputs.cargo !== null && isOverloaded(inputs.cargo.capacity - inputs.cargo.used)) {
    found.set(WARNING.OVERLOADED_CARGO, { flags: [FLAG_CARGO], rows: [] });
  }
  // GetModulesByTankGroup: each fitted module on the armour list, else the shield list, else the hull list.
  const shieldModules: [number, number][] = [];
  const armorModules: [number, number][] = [];
  for (const [typeID, flagID] of fittedModules) {
    const lists = inputs.typeLists(typeID);
    if (lists.has(TYPE_LIST_FITTING_WARNINGS_ARMOR)) armorModules.push([typeID, flagID]);
    else if (lists.has(TYPE_LIST_FITTING_WARNINGS_SHIELD)) shieldModules.push([typeID, flagID]);
  }
  // GetShieldArmorDualTankingModules: shield modules and armour modules both, every one of them.
  if (shieldModules.length > 0 && armorModules.length > 0) {
    found.set(WARNING.DUAL_TANKED, { flags: [...shieldModules, ...armorModules].map(([, flagID]) => flagID), rows: [] });
  }
  // GetProblematicShipAndTankingCombo (GetProblematicCombo): a hull of one tanking kind by its info bubble elements, none
  // where one is shield or armour; a shield hull's armour modules, an armour hull's shield modules.
  const elements = new Set(inputs.shipElements ?? []);
  if (!elements.has(INFO_BUBBLE_SHIELD_OR_ARMOR)) {
    const isShieldShip = elements.has(INFO_BUBBLE_SHIELD);
    const isArmorShip = elements.has(INFO_BUBBLE_ARMOR);
    if (Number(isShieldShip) + Number(isArmorShip) === 1) {
      if (isShieldShip && armorModules.length > 0) {
        found.set(WARNING.ARMOR_TANKED_SHIELD_SHIP, { flags: armorModules.map(([, flagID]) => flagID), rows: [] });
      } else if (isArmorShip && shieldModules.length > 0) {
        found.set(WARNING.SHIELD_TANKED_ARMOR_SHIP, { flags: shieldModules.map(([, flagID]) => flagID), rows: [] });
      }
    }
  }
  // GetMixedTurrets: the high slots' turrets by their weapon group (a civilian turret its HARD_CODED_GROUPIDS group),
  // more than one group.
  const turretsByGroup = groupedBy(highSlotModules, (typeID) => {
    const groupID = HARD_CODED_GROUP_IDS[typeID] ?? staticData.types[typeID]?.groupID ?? null;
    return groupID !== null && TURRET_GROUPS.includes(groupID) ? groupID : null;
  });
  if (turretsByGroup.size > 1) {
    found.set(WARNING.MIXING_TURRET_GROUPS, {
      flags: [...turretsByGroup.values()].flatMap((pairs) => pairs.map(([, flagID]) => flagID)),
      rows: [...turretsByGroup].map(([groupID, pairs]) => ({ kind: "group", groupID, icon: ICON_BY_TURRET_GROUP[groupID] ?? null, flags: pairs.map(([, flagID]) => flagID) })),
    });
  }
  // GetMixedLauncherGroups: the high slots' launchers (effectLauncherFitted) by group, more than one.
  const launchersByGroup = groupedBy(highSlotModules.filter(([typeID]) => hasEffect(staticData, typeID, EFFECT_LAUNCHER_FITTED)), (typeID) => staticData.types[typeID]?.groupID ?? null);
  if (launchersByGroup.size > 1) {
    found.set(WARNING.MIXING_LAUNCHER_GROUPS, {
      flags: [...launchersByGroup.values()].flatMap((pairs) => pairs.map(([, flagID]) => flagID)),
      // GetIconPathForTurretGroup: no launcher group has an icon.
      rows: [...launchersByGroup].map(([groupID, pairs]) => ({ kind: "group", groupID, icon: ICON_BY_TURRET_GROUP[groupID] ?? null, flags: pairs.map(([, flagID]) => flagID) })),
    });
  }
  // GetMixedTurretSizes: the high slots' turrets (their own group) by the chargeSize their type has, more than one
  // size. (A mutated turret's own size is not read yet.)
  const turretsBySize = groupedBy(
    highSlotModules.filter(([typeID]) => TURRET_GROUPS.includes(staticData.types[typeID]?.groupID ?? -1)),
    (typeID) => typeAttribute(staticData, typeID, ATTRIBUTE_CHARGE_SIZE) || null,
  );
  if (turretsBySize.size > 1) {
    found.set(WARNING.MIXING_TURRET_SIZES, {
      flags: [...turretsBySize.values()].flatMap((pairs) => pairs.map(([, flagID]) => flagID)),
      rows: [...turretsBySize].sort(([left], [right]) => left - right)
        .map(([size, pairs]) => ({ kind: "size", size, icon: ICON_BY_SIZE[size] ?? null, flags: pairs.map(([, flagID]) => flagID) })),
    });
  }
  // The used-with table of every type (infoSvc.GetUsedWithTypeIDs), as far as it is read.
  const usedWith = (typeID: number) => usedWithTypeIDs(staticData, typeID, inputs.groupTypes);
  // FindModulesNotProvidingBonus: of the fitted modules, with the drones and fighters (the fitting's in the drone bay,
  // the fighter bay and the tubes, and GetFighterTypesInTubes); AddModuleRows: by their slots' order.
  const dronesAndFighters = new Set([...fit.filter(([, flagID]) => DRONE_AND_FIGHTER_BAYS.has(flagID)).map(([typeID]) => typeID), ...inputs.fighterTypesInTubes]);
  const notProvidingBonus = findModulesNotProvidingBonus(staticData, fittedModules, dronesAndFighters, inputs.typeLists, inputs.requiredSkillsOf, usedWith)
    .sort(([, left], [, right]) => MODULE_SLOT_FLAGS.indexOf(left) - MODULE_SLOT_FLAGS.indexOf(right));
  if (notProvidingBonus.length > 0) {
    found.set(WARNING.NOT_PROVIDING_BONUS, {
      flags: [...new Set(notProvidingBonus.map(([, flagID]) => flagID))],
      rows: notProvidingBonus.map(([typeID, flagID]) => ({ kind: "module", typeID, flagID })),
    });
  }
  // FindModulesWithMissingCharges: of a ship.
  if (inputs.chargesFit !== null) {
    const missing = findModulesMissingCharges(staticData, inputs.chargesFit, inputs.typeLists, usedWith);
    if (missing.required.length > 0) found.set(WARNING.MISSING_REQ_CHARGES, { flags: [...new Set(missing.required.map(([, flagID]) => flagID))], rows: [] });
    if (missing.optional.length > 0) found.set(WARNING.MISSING_OPTIONAL_CHARGES, { flags: [...new Set(missing.optional.map(([, flagID]) => flagID))], rows: [] });
  }
  // FindFittedModulesWithStackingPenalty: of the items in the fitting's slots; each penalized attribute a row under its
  // line (AddAttributes), the modules making the change.
  const stacking = fittedModulesWithStackingPenalty(staticData, fit.filter(([, flagID]) => FITTING_FLAGS.has(flagID)).map(([typeID, flagID]) => [typeID, flagID] as const));
  const stackingWarnings = [
    [WARNING.STACKING_PENALTY_MED, stacking.medium],
    [WARNING.STACKING_PENALTY_LOW, stacking.low],
    [WARNING.STACKING_PENALTY_TARGETED_LOW, stacking.targetedLow],
  ] as const;
  for (const [warningID, penalized] of stackingWarnings) {
    if (penalized.length === 0) continue;
    const flags = new Set<number>();
    const rows: FitWarningRow[] = [];
    for (const { change, modules } of penalized) {
      const pairs = [...modules.values()];
      for (const [, flagID] of pairs) flags.add(flagID);
      rows.push({
        kind: "attribute",
        attributeID: change.modifiedAttributeID,
        skillTypeID: change.skillTypeID,
        flags: pairs.map(([, flagID]) => flagID),
        modulesKey: pairs.map(([typeID, flagID]) => `${typeID}:${flagID}`).sort().join(","),
      });
    }
    found.set(warningID, { flags: [...flags], rows });
  }
  // FindOfflineModules (AddModuleRows: by their slots' order).
  const offline = [...inputs.offlineModules]
    .filter(([typeID, flagID]) => MODULE_SLOT_FLAGS.includes(flagID) && [CATEGORY_MODULE, CATEGORY_STRUCTURE_MODULE].includes(staticData.types[typeID]?.categoryID ?? -1))
    .sort(([, left], [, right]) => MODULE_SLOT_FLAGS.indexOf(left) - MODULE_SLOT_FLAGS.indexOf(right));
  if (offline.length > 0) {
    found.set(WARNING.OFFLINE_MODULES, { flags: offline.map(([, flagID]) => flagID), rows: offline.map(([typeID, flagID]) => ({ kind: "module", typeID, flagID })) });
  }
  // GetPolarizedWeapons: the fitted modules with a resistance killer's effect.
  const polarized = fittedModules.filter(([typeID]) =>
    hasEffect(staticData, typeID, EFFECT_RESISTANCE_KILLER_HULL_ALL) || hasEffect(staticData, typeID, EFFECT_RESISTANCE_KILLER_SHIELD_ARMOR_ALL));
  if (polarized.length > 0) found.set(WARNING.POLARIZED_WEAPONS, { flags: polarized.map(([, flagID]) => flagID), rows: [] });

  // FindUndersizedPropMod: not a freighter; each fitted module with a speedBoostFactor, the hull's mass over it above
  // MASS_SPEEDBOOST_MAX_RATIO (the type's figures).
  if (shipType?.groupID !== GROUP_FREIGHTER) {
    const mass = typeAttribute(staticData, shipTypeID, ATTRIBUTE_MASS);
    const undersized = fittedModules.filter(([typeID]) => {
      const boostFactor = typeAttribute(staticData, typeID, ATTRIBUTE_SPEED_BOOST_FACTOR);
      return boostFactor !== null && mass !== null && mass / boostFactor > MASS_SPEEDBOOST_MAX_RATIO;
    });
    if (undersized.length > 0) found.set(WARNING.UNDERSIZED_PROP_MOD, { flags: undersized.map(([, flagID]) => flagID), rows: [] });
  }
  // FindInefficientPropMod: a freighter's fitted propulsion modules.
  if (shipType?.groupID === GROUP_FREIGHTER) {
    const inefficient = fittedModules.filter(([typeID]) => staticData.types[typeID]?.groupID === GROUP_PROPULSION_MODULE);
    if (inefficient.length > 0) found.set(WARNING.INEFFICIENT_PROP_MOD, { flags: inefficient.map(([, flagID]) => flagID), rows: [] });
  }
  // FindModsDisablingBubbleImmunity: of the items fitted to the ship, those with a warpBubbleImmuneModifier, where the
  // hull is immune; with an interdiction nullifier fitted, those and the nullifiers.
  const nullifiers = inputs.fittedItems.filter(([typeID]) => staticData.types[typeID]?.groupID === GROUP_INTERDICTION_NULLIFIER);
  const disabling = inputs.fittedItems.filter(([typeID]) => typeAttribute(staticData, typeID, ATTRIBUTE_WARP_BUBBLE_IMMUNE_MODIFIER) !== null);
  const immuneHull = typeAttribute(staticData, shipTypeID, ATTRIBUTE_WARP_BUBBLE_IMMUNE);
  const bubbleWarned = immuneHull && disabling.length > 0 ? disabling : nullifiers.length > 0 && disabling.length > 0 ? [...disabling, ...nullifiers] : [];
  if (bubbleWarned.length > 0) found.set(WARNING.DISABLED_BUBBLE_IMMUNITY, { flags: bubbleWarned.map(([, flagID]) => flagID), rows: [] });

  return TOOLTIP_ORDER.flatMap((warningID) => {
    const warning = found.get(warningID);
    return warning ? [{ warningID, level: WARNINGS_BY_ID[warningID]!.level, ...warning }] : [];
  });
}

/**
 * The Fitting window's effect compiler's python effects (GhostFittingEffectCompiler.GetPythonEffects, with
 * baseEffectCompiler's before them, a later one of an effect in its place): every effect one of them is, and of those
 * with any, its MODIFIER_CHANGES (operation, modified attribute, modifying attribute) and its
 * SKILL_MODIFIER_CHANGES_FOR_LOCATION (operation, skill, modified, modifying). Taken from the compiled classes through the
 * python27 oracle (nf338-py-oracle.py).
 */
export const PYTHON_EFFECT_IDS: ReadonlySet<number> = new Set([
  10, 16, 17, 34, 38, 40, 42, 46, 47, 48, 54, 55, 67, 81, 607, 660,
  661, 662, 668, 848, 876, 878, 980, 1086, 1199, 1730, 1851, 2192, 2193, 2194, 2195, 2196,
  2197, 2663, 2726, 3380, 3772, 3773, 3774, 4921, 4928, 5788, 5945, 6063, 6208, 6421, 6422, 6423,
  6424, 6425, 6426, 6427, 6428, 6443, 6484, 6682, 6683, 6684, 6686, 6719, 6730, 6731, 6753, 6995,
  12126,
]);
interface PythonEffectModifiers {
  readonly modifiers: readonly (readonly [number, number, number])[];
  readonly skillModifiers: readonly (readonly [number, number, number, number])[];
}
export const PYTHON_EFFECT_MODIFIERS: Readonly<Record<number, PythonEffectModifiers>> = {
  3380: {
    modifiers: [[6, 4, 1131], [6, 37, 1076], [6, 552, 554]],
    skillModifiers: [],
  },
  4928: {
    modifiers: [[0, 267, 267], [0, 268, 268], [0, 269, 269], [0, 270, 270]],
    skillModifiers: [],
  },
  5788: {
    modifiers: [
      [7, 192, 192], [0, 564, 565], [6, 37, 20], [2, 104, 852], [4, 4, 1471], [7, 872, 872],
      [0, 267, 267], [0, 268, 268], [0, 269, 269], [0, 270, 270], [0, 113, 974], [0, 111, 975],
      [0, 109, 976], [0, 110, 977], [0, 271, 271], [0, 272, 272], [0, 273, 273], [0, 274, 274],
    ],
    skillModifiers: [
      [6, 21803, 84, 895], [6, 21803, 73, 896], [6, 21802, 68, 548], [6, 21802, 73, 897], [6, 21666, 64, 292],
      [6, 21666, 160, 767], [6, 20327, 64, 292], [6, 20327, 160, 767], [6, 21667, 64, 292], [6, 21667, 160, 767],
      [6, 3309, 54, 351], [6, 3307, 54, 351], [6, 3308, 54, 351], [6, 3309, 158, 349], [6, 3307, 158, 349],
      [6, 3308, 158, 349], [6, 3393, 84, 895], [6, 3416, 68, 548], [2, 4385, 1349, 1350],
    ],
  },
  6063: {
    modifiers: [[6, 208, 1030], [6, 210, 1029], [6, 211, 1027], [6, 209, 1028]],
    skillModifiers: [],
  },
  6422: {
    modifiers: [[6, 211, 2255], [6, 209, 2256], [6, 210, 2257], [6, 208, 2258], [6, 564, 2137], [6, 76, 2136]],
    skillModifiers: [],
  },
  6423: {
    modifiers: [],
    skillModifiers: [[6, 3319, 37, 547], [6, 3319, 281, 596], [6, 3319, 653, 847], [6, 3319, 654, 848]],
  },
  6424: {
    modifiers: [],
    skillModifiers: [[6, 3300, 54, 351], [6, 3300, 158, 349], [6, 3300, 160, 767]],
  },
  6425: {
    modifiers: [[6, 552, 2147]],
    skillModifiers: [],
  },
  6426: {
    modifiers: [[6, 37, 2148]],
    skillModifiers: [],
  },
  6427: {
    modifiers: [[6, 211, 2255], [6, 209, 2256], [6, 210, 2257], [6, 208, 2258], [6, 564, 2137], [6, 76, 2136]],
    skillModifiers: [],
  },
  6428: {
    modifiers: [],
    skillModifiers: [[6, 3300, 54, 351], [6, 3300, 158, 349], [6, 3300, 160, 767]],
  },
  6484: {
    modifiers: [[4, 113, 974], [4, 110, 977], [4, 109, 976], [4, 111, 975]],
    skillModifiers: [],
  },
  6682: {
    modifiers: [[6, 37, 2148]],
    skillModifiers: [],
  },
  6683: {
    modifiers: [[6, 552, 2147]],
    skillModifiers: [],
  },
  6684: {
    modifiers: [[6, 211, 2255], [6, 209, 2256], [6, 210, 2257], [6, 208, 2258], [6, 564, 2137], [6, 76, 2136]],
    skillModifiers: [],
  },
  6686: {
    modifiers: [],
    skillModifiers: [
      [6, 3300, 54, 351], [6, 3300, 158, 349], [6, 3300, 160, 767], [6, 3319, 37, 547], [6, 3319, 281, 596],
      [6, 3319, 653, 847], [6, 3319, 654, 848],
    ],
  },
  6730: {
    modifiers: [[2, 4, 796], [6, 552, 554]],
    skillModifiers: [],
  },
  6731: {
    modifiers: [[2, 4, 796]],
    skillModifiers: [],
  },
};

/** dogma const: the effect categories and the operations the stacking warnings go by. */
const EFFECT_CATEGORY_TARGET = 2;
const EFFECT_CATEGORY_OVERLOAD = 5;
const OPERATION = Object.freeze({ PRE_MUL: 0, PRE_DIV: 1, MOD_ADD: 2, MOD_SUB: 3, POST_MUL: 4, POST_DIV: 5, POST_PERCENT: 6 });
/** fittingWarningsStackingPenalty ITEM_MODIFIER and NOT_ITEM_MOTIFIER: a modifier's domain told apart by its kind. */
const ITEM_MODIFIER = 1;
const NOT_ITEM_MODIFIER = 2;

/** IsItGoodChange: whether a modifier's value makes its attribute better, by its operation and the attribute's highIsGood. */
function isItGoodChange(value: number | null, operation: number, wantHigh: boolean): boolean {
  if (value === null) return false;
  if (operation === OPERATION.MOD_ADD || operation === OPERATION.MOD_SUB) return false;
  const multiplies = operation === OPERATION.PRE_MUL || operation === OPERATION.POST_MUL;
  const divides = operation === OPERATION.PRE_DIV || operation === OPERATION.POST_DIV;
  if (wantHigh) {
    if (multiplies) return value > 1.0;
    if (operation === OPERATION.POST_PERCENT) return value > 0;
    if (divides) return value < 1.0;
    return false;
  }
  if (multiplies) return value < 1.0 && value !== 0;
  if (operation === OPERATION.POST_PERCENT) return value < 0;
  if (divides) return value > 1.0;
  return false;
}

/** One unstackable change a module makes: the attribute, the operation, the skill it is for, the domain and its kind. */
interface UnstackableChange {
  readonly modifiedAttributeID: number;
  readonly operation: number;
  readonly skillTypeID: number | null;
  readonly domain: string;
}
const changeKey = (change: UnstackableChange, skillTypeID = change.skillTypeID): string =>
  `${change.modifiedAttributeID}|${change.operation}|${skillTypeID ?? "None"}|${change.domain}`;

/**
 * _FindModulesWithStackingPenalty: of each published module (IsModuleOfInterestForStacking), each effect but an
 * overload's, its modifiers (a python effect's MODIFIER_CHANGES and SKILL_MODIFIER_CHANGES_FOR_LOCATION, on the target
 * for a target effect, else on the ship; any other's modifierInfo) on an unstackable attribute; a target effect's all of
 * them, any other's those its value makes better (IsItGoodChange).
 */
function unstackableChanges(staticData: DogmaStatic, typeID: number): { readonly own: UnstackableChange[]; readonly targeted: UnstackableChange[] } {
  const own: UnstackableChange[] = [];
  const targeted: UnstackableChange[] = [];
  const type = staticData.types[typeID];
  if (!type || type.published === false || ![CATEGORY_MODULE, CATEGORY_STRUCTURE_MODULE].includes(type.categoryID ?? -1)) return { own, targeted };
  for (const effectID of type.effects) {
    const effect = staticData.effects[effectID];
    if (!effect || effect.category === EFFECT_CATEGORY_OVERLOAD) continue;
    type Modifier = { readonly modifiedAttributeID: number | null; readonly modifyingAttributeID: number | null; readonly operation: number | null; readonly skillTypeID: number | null; readonly domain: string | null; readonly func: string | null };
    let modifiers: Modifier[];
    if (PYTHON_EFFECT_IDS.has(effectID)) {
      const domain = effect.category === EFFECT_CATEGORY_TARGET ? "target" : "shipID";
      const python = PYTHON_EFFECT_MODIFIERS[effectID];
      modifiers = [
        ...(python?.modifiers ?? []).map(([operation, to, from]): Modifier => ({ operation, modifiedAttributeID: to, modifyingAttributeID: from, domain, skillTypeID: null, func: "ItemModifier" })),
        ...(python?.skillModifiers ?? []).map(([operation, skillTypeID, to, from]): Modifier => ({ operation, modifiedAttributeID: to, modifyingAttributeID: from, domain, skillTypeID, func: "LocationRequiredSkillModifier" })),
      ];
    } else {
      modifiers = [...(effect.modifiers ?? [])];
    }
    for (const modifier of modifiers) {
      if (modifier.modifiedAttributeID === null || modifier.operation === null) continue;
      const modified = staticData.attributes[modifier.modifiedAttributeID];
      if (!modified || modified.stackable) continue;
      const change = {
        modifiedAttributeID: modifier.modifiedAttributeID,
        operation: modifier.operation,
        skillTypeID: modifier.skillTypeID ?? null,
        domain: `${modifier.domain}|${modifier.func === "ItemModifier" ? ITEM_MODIFIER : NOT_ITEM_MODIFIER}`,
      };
      if (effect.category === EFFECT_CATEGORY_TARGET) targeted.push(change);
      else if (isItGoodChange(modifier.modifyingAttributeID === null ? null : typeAttribute(staticData, typeID, modifier.modifyingAttributeID), modifier.operation, modified.highIsGood)) own.push(change);
    }
  }
  return { own, targeted };
}

/** A change and the fitted modules making it, each (typeID, flagID). */
interface PenalizedChange {
  readonly change: UnstackableChange;
  readonly modules: Map<string, readonly [number, number]>;
}

/**
 * FindFittedModulesWithStackingPenalty (FindModulesWithStackingPenalty, _GetStackingWarnings): of the items in the
 * fitting's slots, each unstackable change and the modules making it (a skill's with those making it for every skill);
 * more than three a medium warning, more than two a low one. The targeted ones low either way.
 */
function fittedModulesWithStackingPenalty(staticData: DogmaStatic, fittedModules: readonly (readonly [number, number])[]): { readonly medium: PenalizedChange[]; readonly low: PenalizedChange[]; readonly targetedLow: PenalizedChange[] } {
  const own = new Map<string, PenalizedChange>();
  const targeted = new Map<string, PenalizedChange>();
  const changesOf = new Map<number, ReturnType<typeof unstackableChanges>>();
  for (const [typeID, flagID] of fittedModules) {
    let changes = changesOf.get(typeID);
    if (!changes) {
      changes = unstackableChanges(staticData, typeID);
      changesOf.set(typeID, changes);
    }
    for (const [list, into] of [[changes.own, own], [changes.targeted, targeted]] as const) {
      for (const change of list) {
        const key = changeKey(change);
        const held = into.get(key) ?? { change, modules: new Map<string, readonly [number, number]>() };
        held.modules.set(`${typeID}|${flagID}`, [typeID, flagID]);
        into.set(key, held);
      }
    }
  }
  const warnings = (changes: ReadonlyMap<string, PenalizedChange>) => {
    const medium: PenalizedChange[] = [];
    const low: PenalizedChange[] = [];
    for (const held of changes.values()) {
      const modules = new Map(held.modules);
      if (held.change.skillTypeID) {
        for (const [key, pair] of changes.get(changeKey(held.change, null))?.modules ?? []) modules.set(key, pair);
      }
      if (modules.size > 3) medium.push({ change: held.change, modules });
      else if (modules.size > 2) low.push({ change: held.change, modules });
    }
    return { medium, low };
  };
  const ofOwn = warnings(own);
  const ofTargeted = warnings(targeted);
  return { medium: ofOwn.medium, low: ofOwn.low, targetedLow: [...ofTargeted.low, ...ofTargeted.medium] };
}

/** The attributes the python effects' changes name, for the static data to hold their records. */
export const PYTHON_EFFECT_ATTRIBUTES: readonly number[] = [...new Set(Object.values(PYTHON_EFFECT_MODIFIERS)
  .flatMap(({ modifiers, skillModifiers }) => [...modifiers.flatMap(([, to, from]) => [to, from]), ...skillModifiers.flatMap(([, , to, from]) => [to, from])]))];

/** GetActiveWarningsByLevelFromResults: how many warnings at each level. */
export function warningsByLevel(warnings: readonly FitWarning[]): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const warning of warnings) counts.set(warning.level, (counts.get(warning.level) ?? 0) + 1);
  return counts;
}

/** The effects and attributes the warnings ask of a type, to read with the static data. */
export const WARNING_EFFECTS: readonly number[] = [EFFECT_LAUNCHER_FITTED, EFFECT_RESISTANCE_KILLER_HULL_ALL, EFFECT_RESISTANCE_KILLER_SHIELD_ARMOR_ALL];
export const WARNING_ATTRIBUTES: readonly number[] = [ATTRIBUTE_CHARGE_SIZE, ATTRIBUTE_TECH_LEVEL];
