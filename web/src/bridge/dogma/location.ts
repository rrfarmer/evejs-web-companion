// The client's dogma location (eve/common/script/dogma/baseDogmaLocation.py, and the Fitting window's
// FittingDogmaLocation on it): the items a simulated ship is reckoned with, the modifiers between their attributes, and
// how a type's passive effects and the server's brain put those modifiers in place. The second part of the page's own
// dogma, on attribute.ts.
//
//   LoadMyShip            the pilot loaded, then the ship (its attributes as its type has them, fitted to itself,
//                         its passive effects started), then MakeShipActive: the brain's effects applied
//   StartPassiveEffects   each of a type's passive effects (dgmEffPassive; a system effect is not started in the
//                         Fitting window, and the slot-power and skill effects never are), the effect's modifiers
//                         started in its environment, unless it modifies a character and the item has no pilot, a ship
//                         and it has no ship, or names another item (otherID) it has none of, or goes by a chance the
//                         type has (ShouldStartChanceBasedEffect: never, in the Fitting window)
//   the modifiers         dogma/effects/modifiers.py: an ItemModifier on one item's attribute; a LocationModifier, a
//                         LocationGroupModifier and a LocationRequiredSkillModifier on every item fitted to a location
//                         (of a group, or requiring a skill) that has the attribute; an OwnerRequiredSkillModifier on
//                         what an owner owns that requires the skill. Each modifier's domain is the item it starts from
//                         (none: the effect's own item), the ship, the pilot or another item.
//   ApplyBrainEffects     the server's brain (eve/common/script/dogma/effect.py BrainEffect: what the pilot's skills
//                         and implants do, worked out on the server): its ship effects on the ship (a modifier of one
//                         attribute only where the hull's type has it, or it is capacity), its character effects on the
//                         pilot; each from a BrainLiteralAttribute of its value, one for each set of skills and value
//                         (brainLiterals), which no stacking penalty falls on (forceUnnurfed)
//   _ApplyPilotSecurityStatusToShip   the pilot's security status set on the ship (pilotSecurityStatus)
//   FitModuleToShip       a module loaded into a slot of the ship (its location the ship, so its attributes take the
//                         ship's location modifiers as they are made), fitted (RegisterFittedItem) and its passive
//                         effects started; the fitted effects are written in Python (dogma/fitting.py: a turret or a
//                         launcher takes a turret or launcher slot, a rig an upgrade slot and its calibration)
//   OnlineModule          the online effect (ghost fitting's pythonEffects.OnlineEffect: isOnline, the module's CPU
//                         and power added to the ship's loads, no check of either), then each of the module's online
//                         effects (dgmEffOnline) started (_StartEffect)
//   FitAmmoToLocation     a charge loaded into a module's slot: a sublocation of the ship (its key the ship, the flag
//                         and its type), fitted, its passive effects started; a charge is owner-modifiable, so its
//                         attributes take the pilot's owner modifiers (the brain's ORS) as they are made
//   the other item        an effect's otherID: a module's charge in its slot (GetOtherID), a charge's module
//                         (GetSlotOther); a modifier whose item is not there is let go (the Fitting window's
//                         CheckItemsMissingInAddModifier lets it through to _FindOrDefer, and nothing is waiting)
//
// An attribute is made the first time it is asked for (keydefaultdict, itemAttributeFactory) with its type's value or
// its default, and on being made takes the modifiers its item's location and owner hold for it
// (_PickUpInitialModifiers). A modifier from a location reaches only those of its items' attributes made already. A
// ship is fitted to itself but has no location of its own, so an attribute of the ship made after a location modifier
// was put in place never takes it.
//
// An item is loaded with its type's attributes, then its instance row's (GetInstance: the server's instance cache, the
// ship's state; dgmAttributesByIdx, each that is not nought: online, damage, the capacitor's charge, skill points,
// armour damage, the shield's charge, incapacitated), before it is fitted (BaseDogmaItem.Load, _LoadItem).
//
// A charged attribute (dogma/attributes/chargedAttribute.py: one the static data gives a recharge time, the capacitor's
// charge and the shield's) takes no modifier, and runs by the clock (gametime.GetSimTime): made, it is its type's value
// held to its cap; set, it is what it is set to from then on; each time it is read, and each time its cap or its
// recharge time changes, it is brought up to that moment: scaled with its cap where the cap has changed, then
// recharged by the time since it was last brought up, the root of its share of the cap closing on one by
// exp(-t / (recharge time / 5)); at its cap or above it is its cap. (The client marks it dirty whenever anything its
// cap or recharge time is reckoned from changes; here it is brought up where the cap's or the recharge time's value
// has changed.)
//
// An effect is started (StartEffect: ChangeModuleStatus) and stopped (StopEffect) on an item: its Python version where
// the Fitting window's effect compiler has one (GhostFittingEffectCompiler on ClientEffectCompiler: PYTHON_EFFECTS),
// else its modifierInfo's modifiers (ModifierEffect), else nothing (NEUTRAL_EFFECT). Before it starts, the checks the
// Fitting window makes (StartEffect_PreChecks: an online module too damaged; an activated one blocked, or one more of
// its group than may be active; the Python effect's own PreStartChecks), each a UserError (DogmaUserError). The online
// effect starts the type's online effects after it, and stopping it stops every other running effect with no duration.
// A modifier is let go as it was put in place (RemoveModifier and the location and owner kinds).
//
// Not yet (later parts): the command bursts' buffs (the buff registry: their effects start as nothing), the subsystems'
// hardpoint and slot effects (Python), fighters, the skill level, heat, security and TiDi attribute classes.

import type { JsonValue } from "../wire.ts";
import { readDictPairs, isListValue, unwrapLong, unwrapReal } from "../wire.ts";
import { attributeValue, type IncomingModifier } from "./attribute.ts";

/** One modifier of an effect's modifierInfo (dogmaEffects.fsdbinary). */
export interface DogmaModifierInfo {
  readonly func: string | null;
  readonly domain: string | null;
  readonly modifiedAttributeID: number | null;
  readonly modifyingAttributeID: number | null;
  readonly operation: number | null;
  readonly skillTypeID: number | null;
  readonly groupID: number | null;
}

/** An effect's record, as far as the location goes by it. */
export interface DogmaEffectFacts {
  /** effectName, which godma keys a module's effects by (RefreshItemEffects). */
  readonly name?: string | null;
  readonly category: number | null;
  /** fittingUsageChanceAttributeID */
  readonly chanceAttributeID: number | null;
  /** Its modifierInfo; null where it has none (a neutral effect). */
  readonly modifiers: readonly DogmaModifierInfo[] | null;
  /** The attributes it goes by: its cycle (durationAttributeID), what it drains (dischargeAttributeID), its range, falloff and tracking. */
  readonly durationAttributeID?: number | null;
  readonly dischargeAttributeID?: number | null;
  readonly rangeAttributeID?: number | null;
  readonly falloffAttributeID?: number | null;
  readonly trackingSpeedAttributeID?: number | null;
}

/** A type as the location goes by it. */
export interface DogmaTypeFacts {
  /** dogma/data.py get_type_attributes: [attributeID, value], in its order. */
  readonly attributes: readonly (readonly [number, number | null])[];
  /** Its effects, in its typeDogma's order. */
  readonly effects: readonly number[];
  /** Its default effect (dogmaStaticMgr.GetDefaultEffect), where it has one. */
  readonly defaultEffectID?: number | null;
  /** Every effect its typeDogma marks isDefault, in its order. */
  readonly defaultEffectIDs?: readonly number[];
  /** evetypes.GetBasePrice, and inventoryUtil.GetComputedBasePrice(typeID, 1) (by its materials); null where not read. */
  readonly basePrice?: number | null;
  readonly computedBasePrice?: number | null;
  readonly groupID: number | null;
  readonly categoryID: number | null;
  /** get_dogma_required_skills: the skills it requires (an item's reqSkills). */
  readonly requiredSkills: readonly number[];
  /** evetypes.IsPublished; unknown where it was not read. */
  readonly published?: boolean | null;
  /** Membership in the client’s Academy equipment list (992). */
  readonly academy?: boolean;
  /** GetCanFitShipGroups and GetCanFitShipTypes: the ship groups and types it may be fitted to (none: any). */
  readonly fitsShipGroups?: readonly number[];
  readonly fitsShipTypes?: readonly number[];
  /** GetChargeGroupsForLauncher: the charge groups it takes (its chargeGroup attributes above nought). */
  readonly chargeGroups?: readonly number[];
}

/** An attribute's static record, as Attribute and itemAttributeFactory go by it. */
export interface DogmaAttributeRecord {
  readonly stackable: boolean;
  readonly dataType: number | null;
  readonly defaultValue: number | null;
  readonly highIsGood: boolean;
  readonly maxAttributeID: number | null;
  readonly minAttributeID: number | null;
  readonly chargeRechargeTimeID: number | null;
}

/** The static data the location reckons with (GET /api/client-data/dogma-types). */
export interface DogmaStatic {
  readonly types: Readonly<Record<number, DogmaTypeFacts | null>>;
  readonly effects: Readonly<Record<number, DogmaEffectFacts | null>>;
  readonly attributes: Readonly<Record<number, DogmaAttributeRecord | null>>;
}

/** One of the brain's effects (BrainEffect): the kind of modifier, its target attribute and operator, its value. */
export interface BrainEffect {
  /** M, L, LG, LRS or ORS (ApplyBrainEffect). */
  readonly modifierType: string;
  readonly toAttribID: number;
  readonly operation: number;
  readonly value: number;
  /** The skills it comes from (its literal is one for each set of skills and value). */
  readonly skills: readonly number[];
  /** The group (LG) or skill (LRS, ORS) it goes by. */
  readonly extras: readonly number[];
}

/** The server's brain: (version, charEffects, shipEffects, structureEffects). */
export interface Brain {
  readonly version: number;
  readonly charEffects: readonly BrainEffect[];
  readonly shipEffects: readonly BrainEffect[];
  readonly structureEffects: readonly BrainEffect[];
}

/** dogma/const.py, inventorycommon/const.py */
const EFFECT_CATEGORY_PASSIVE = 0;
/** baseDogmaStaticSvc unwantedEffects: effectHiPower, effectLoPower, effectMedPower, effectSkillEffect. */
const UNWANTED_EFFECTS: ReadonlySet<number> = new Set([12, 11, 13, 132]);
const EFFECT_CATEGORY_ONLINE = 4;
const EFFECT_ONLINE = 16;
const ATTRIBUTE_CAPACITY = 38;
const ATTRIBUTE_PILOT_SECURITY_STATUS = 2610;
const ATTRIBUTE_IS_ONLINE = 2;
const ATTRIBUTE_QUANTITY = 805;
const ATTRIBUTE_CPU = 50;
const ATTRIBUTE_CPU_LOAD = 49;
const ATTRIBUTE_POWER = 30;
const ATTRIBUTE_POWER_LOAD = 15;
const ATTRIBUTE_SLOTS = 47;
/** dogma/const.py: the ship's slot counts, and a subsystem's modifiers of them and of its hardpoints. */
const ATTRIBUTE_LOW_SLOTS = 12;
const ATTRIBUTE_MED_SLOTS = 13;
const ATTRIBUTE_HI_SLOTS = 14;
const ATTRIBUTE_RIG_SLOTS = 1137;
const ATTRIBUTE_SERVICE_SLOTS = 2056;
const ATTRIBUTE_TURRET_HARDPOINT_MODIFIER = 1368;
const ATTRIBUTE_LAUNCHER_HARDPOINT_MODIFIER = 1369;
const ATTRIBUTE_HI_SLOT_MODIFIER = 1374;
const ATTRIBUTE_MED_SLOT_MODIFIER = 1375;
const ATTRIBUTE_LOW_SLOT_MODIFIER = 1376;
const ATTRIBUTE_LAUNCHER_SLOTS_LEFT = 101;
const ATTRIBUTE_TURRET_SLOTS_LEFT = 102;
const ATTRIBUTE_UPGRADE_SLOTS_LEFT = 1154;
const ATTRIBUTE_UPGRADE_LOAD = 1152;
const ATTRIBUTE_UPGRADE_COST = 1153;
const OP_PRE_MUL = 0;
const OP_MOD_ADD = 2;
const OP_MOD_SUB = 3;
const OP_POST_MUL = 4;
const OP_POST_PERCENT = 6;
const OP_POST_ASSIGNMENT = 7;
const EFFECT_CATEGORY_ACTIVATION = 1;
const EFFECT_CATEGORY_TARGET = 2;
const EFFECT_CATEGORY_AREA = 3;
const EFFECT_CATEGORY_OVERLOAD = 5;
const EFFECT_CATEGORY_SYSTEM = 7;
const ATTRIBUTE_HP = 9;
const ATTRIBUTE_DAMAGE = 3;
const ATTRIBUTE_MASS = 4;
const ATTRIBUTE_SPEED_FACTOR = 20;
const ATTRIBUTE_SPEED_BOOST_FACTOR = 567;
const ATTRIBUTE_MAX_VELOCITY = 37;
const ATTRIBUTE_MAX_GROUP_ONLINE = 978;
const ATTRIBUTE_MAX_GROUP_ACTIVE = 763;
const ATTRIBUTE_MAX_SHIP_GROUP_ACTIVE = 910;
const ATTRIBUTE_MAX_SHIP_GROUP_ACTIVE_ID = 909;
const ATTRIBUTE_ACTIVATION_BLOCKED = 1349;
const ATTRIBUTE_CHARGE = 18;
const ATTRIBUTE_CAPACITOR_BONUS = 67;
const ATTRIBUTE_CAN_CLOAK = 1163;
const ATTRIBUTE_DISALLOW_CLOAKING = 2454;
const ATTRIBUTE_DISALLOW_EARLY_DEACTIVATION = 906;
const ATTRIBUTE_MAX_VELOCITY_MODIFIER = 306;
const GROUP_CLOAKING_DEVICE = 330;
const GROUP_PROPULSION_MODULE = 46;
/** fittingDogmaLocation SPEED_CHANGING_EFFECTS: effectModuleBonusAfterburner, effectModuleBonusMicrowarpdrive. */
const SPEED_CHANGING_EFFECTS: ReadonlySet<number> = new Set([6731, 6730]);
/** propulsionModules SPEED_BOOST_FACTOR_CALC */
const SPEED_BOOST_FACTOR_CALC = 0.01;
/** inventorycommon/const.py rigSlotFlags */
const RIG_SLOT_FLAGS: ReadonlySet<number> = new Set([92, 93, 94]);
/** dogma/const.py dgmAttributesByIdx: an instance row's attributes, by their index in it. */
export const INSTANCE_ROW_ATTRIBUTES: readonly number[] = [2, 3, 18, 276, 266, 264, 1168];

/**
 * baseDogmaStaticSvc damageStateAttributes: damage, armour damage, the shield's charge, the attributes the client's dogma
 * location takes from the server's word of a change (OnModuleAttributeChanges).
 */
export const DAMAGE_STATE_ATTRIBUTES: ReadonlySet<number> = new Set([3, 266, 264]);

/** An instance row's values (in its order, after the item's ID) by attribute, as BaseDogmaItem.Load takes them. */
export function instanceRowAttributes(values: readonly number[]): Map<number, number> {
  return new Map(INSTANCE_ROW_ATTRIBUTES.map((attributeID, index) => [attributeID, values[index] ?? 0]));
}
const CATEGORY_SHIP = 6;
const CATEGORY_DRONE = 18;
const FLAG_DRONE_BAY = 87;
/** inventorycommon/util.py IsFittingModule: a module or a structure module. */
const FITTING_MODULE_CATEGORIES: ReadonlySet<number> = new Set([7, 66]);

/** inventorycommon/const.py fittingFlags: the low, medium and high slots, the subsystems, the rigs, the services. */
export function isFittingFlag(flagID: number): boolean {
  return (flagID >= 11 && flagID <= 34) || (flagID >= 125 && flagID <= 128) || (flagID >= 92 && flagID <= 94) || (flagID >= 164 && flagID <= 171);
}

/** A UserError the client raises (eveexceptions.UserError): its message key, and the values its words are filled with. */
export class DogmaUserError extends Error {
  readonly key: string;
  readonly values: Readonly<Record<string, number>>;

  constructor(key: string, values: Readonly<Record<string, number>> = {}) {
    super(key);
    this.key = key;
    this.values = values;
  }
}

/**
 * An effect written in Python (dogma/effects Effect): its Start and Stop on an item, and its PreStartChecks where it
 * has its own (each raises a DogmaUserError where it cannot start).
 */
interface PythonEffect {
  readonly start: (location: DogmaLocation, item: DogmaItem) => void;
  readonly stop: (location: DogmaLocation, item: DogmaItem) => void;
  readonly preStart?: (location: DogmaLocation, item: DogmaItem) => void;
}

/** (operation, the ship's attribute, the item's): an Effect's MODIFIER_CHANGES, from the item on its ship. */
type ModifierChange = readonly [number, number, number];
/** (operation, group or skill, the attribute modified, the item's): LOCATION_AND_GROUP_ and SKILL_MODIFIER_CHANGES. */
type FilteredChange = readonly [number, number, number, number];

/** Effect.AddModifiers and RemoveModifiers: the changes from the item on its ship. */
function addChanges(location: DogmaLocation, item: DogmaItem, changes: readonly ModifierChange[]): void {
  for (const [op, toAttributeID, fromAttributeID] of changes) location.addItemModifier(op, item.ship, toAttributeID, item, fromAttributeID);
}
function removeChanges(location: DogmaLocation, item: DogmaItem, changes: readonly ModifierChange[]): void {
  for (const [op, toAttributeID, fromAttributeID] of changes) location.removeItemModifier(op, item.ship, toAttributeID, item, fromAttributeID);
}

/** An Effect that adds its MODIFIER_CHANGES on Start and takes them away on Stop. */
function changesEffect(changes: readonly ModifierChange[]): PythonEffect {
  return { start: (location, item) => addChanges(location, item, changes), stop: (location, item) => removeChanges(location, item, changes) };
}

/** Effect: Start and Stop do nothing (an Effect with neither, and the Fitting window's stand-ins of the targeted ones). */
const NEUTRAL_PYTHON: PythonEffect = { start: () => undefined, stop: () => undefined };

/**
 * propulsionModules.Afterburner and Microwarpdrive: their MODIFIER_CHANGES (the module's massAddition added to the
 * ship's mass; a microwarpdrive's signatureRadiusBonus too), then the ship's maxVelocity multiplied by a literal,
 * 1 + 0.01 x speedFactor x speedBoostFactor / the ship's mass (the mass as the changes left it).
 */
function propulsionEffect(changes: readonly ModifierChange[]): PythonEffect {
  return {
    start: (location, item) => {
      addChanges(location, item, changes);
      location.addSpeedMultiplier(item);
    },
    stop: (location, item) => {
      removeChanges(location, item, changes);
      location.removeSpeedMultiplier(item);
    },
  };
}

/** BaseBastionMode's SKILL_MODIFIER_CHANGES_FOR_LOCATION and _FOR_OWNER (skill, attribute modified, the item's). */
const BASTION_LOCATION: readonly FilteredChange[] = [
  [OP_POST_PERCENT, 21803, 84, 895], [OP_POST_PERCENT, 21803, 73, 896], [OP_POST_PERCENT, 21802, 68, 548],
  [OP_POST_PERCENT, 21802, 73, 897], [OP_POST_PERCENT, 21666, 64, 292], [OP_POST_PERCENT, 21666, 160, 767],
  [OP_POST_PERCENT, 20327, 64, 292], [OP_POST_PERCENT, 20327, 160, 767], [OP_POST_PERCENT, 21667, 64, 292],
  [OP_POST_PERCENT, 21667, 160, 767], [OP_POST_PERCENT, 3309, 54, 351], [OP_POST_PERCENT, 3307, 54, 351],
  [OP_POST_PERCENT, 3308, 54, 351], [OP_POST_PERCENT, 3309, 158, 349], [OP_POST_PERCENT, 3307, 158, 349],
  [OP_POST_PERCENT, 3308, 158, 349], [OP_POST_PERCENT, 3393, 84, 895], [OP_POST_PERCENT, 3416, 68, 548],
  [OP_MOD_ADD, 4385, ATTRIBUTE_ACTIVATION_BLOCKED, 1350],
];
const BASTION_OWNER: readonly FilteredChange[] = [
  [OP_POST_PERCENT, 3324, 37, 547], [OP_POST_PERCENT, 32435, 653, 847], [OP_POST_PERCENT, 32435, 117, 292],
  [OP_POST_PERCENT, 32435, 114, 292], [OP_POST_PERCENT, 32435, 116, 292], [OP_POST_PERCENT, 21668, 114, 292],
  [OP_POST_PERCENT, 21668, 116, 292], [OP_POST_PERCENT, 21668, 117, 292], [OP_POST_PERCENT, 21668, 118, 292],
  [OP_POST_PERCENT, 21668, 653, 847], [OP_POST_PERCENT, 21668, 655, 857], [OP_POST_PERCENT, 3325, 37, 547],
  [OP_POST_PERCENT, 3326, 37, 547],
];
const BASTION_SHIP: readonly ModifierChange[] = [
  [OP_POST_ASSIGNMENT, 192, 192], [OP_PRE_MUL, 564, 565], [OP_POST_PERCENT, 37, 20], [OP_MOD_ADD, 104, 852],
  [OP_POST_MUL, 4, 1471], [OP_POST_ASSIGNMENT, 872, 872], [OP_PRE_MUL, 267, 267], [OP_PRE_MUL, 268, 268],
  [OP_PRE_MUL, 269, 269], [OP_PRE_MUL, 270, 270], [OP_PRE_MUL, 113, 974], [OP_PRE_MUL, 111, 975], [OP_PRE_MUL, 109, 976],
  [OP_PRE_MUL, 110, 977], [OP_PRE_MUL, 271, 271], [OP_PRE_MUL, 272, 272], [OP_PRE_MUL, 273, 273], [OP_PRE_MUL, 274, 274],
];

/** microJumpDrive AddSignatureRadiusBonusPercentModifier; microJumpPortalDrive AddDisallowTetheringModifier. */
const MJD_CHANGES: readonly ModifierChange[] = [[OP_POST_PERCENT, 552, 973]];
const MJPD_TETHER: readonly ModifierChange[] = [[OP_MOD_ADD, 2343, 2343]];

/** BaseWarpDisruptSphere's LOCATION_AND_GROUP_MODIFIER_CHANGES (on the propulsion modules) and MODIFIER_CHANGES. */
const WDS_GROUP: readonly FilteredChange[] = [
  [OP_POST_PERCENT, GROUP_PROPULSION_MODULE, ATTRIBUTE_SPEED_BOOST_FACTOR, 1270],
  [OP_POST_PERCENT, GROUP_PROPULSION_MODULE, ATTRIBUTE_SPEED_FACTOR, 1164],
];
const WDS_SHIP: readonly ModifierChange[] = [[OP_POST_PERCENT, 4, 1131], [OP_POST_PERCENT, 37, 1076], [OP_POST_PERCENT, 552, 554]];

/**
 * The effects written in Python that the Fitting window's effect compiler starts in place of their modifierInfo, by
 * effect (a later class in its list taking the place of an earlier one of the same effect):
 *   the fitted effects        effectLauncherFitted (40), effectTurretFitted (42), effectRigSlot (2663) take a hardpoint
 *                             or an upgrade slot and its calibration (dogma/fitting.py); effectSubSystem (3772) and
 *                             effectServiceSlot (6306) do nothing
 *   effectOnline (16)         the Fitting window's OnlineEffect: no more of the group online than the lowest
 *                             maxGroupOnline of the ship's modules of it (CheckCanOnlineItem), the CPU and power not
 *                             checked; isOnline, and the module's CPU and power added to the ship's loads
 *   propulsion                effectModuleBonusAfterburner (6731), effectModuleBonusMicrowarpdrive (6730)
 *   effect 48                 Powerboost: the charge in the module's slot (one at least), its capacitorBonus added to the
 *                             ship's capacitor charge
 *   hardeners and modes       effectAdaptiveArmorHardener (4928), the bastion module (5788), the Fitting window's
 *                             emergency hull energizer (6484: its modifiers only), the entosis link (6063)
 *   jump drives               effectMicroJumpDrive (4921), effectFighterMicroJumpDrive (6421), effectMicroJumpPortalDrive
 *                             (6208, 12126); effectWarpDisruptSphere (3380), whose Stop lets its modifiers go only
 *                             where the module has no charge (otherID)
 *   cloaking                  effectCloaking (607), effectCloakingWarpSafe (980), effectCloakingPrototype (5945)
 *   nothing                   the weapons (10, 1199, 34, 1086), mining (17, 67, 2726), the scans and the Fitting
 *                             window's stand-ins of the targeted modules (47, 46, 6443, 55, 38, 81, 6995, 6422 to 6428,
 *                             6682 to 6686), and the command bursts (6732 to 6737, 6753, 6719: their buffs are a later
 *                             part)
 */
const PYTHON_EFFECTS: ReadonlyMap<number, PythonEffect> = new Map<number, PythonEffect>([
  [40, {
    start: (location, item) => location.addItemModifier(OP_MOD_SUB, item.ship, ATTRIBUTE_LAUNCHER_SLOTS_LEFT, item, ATTRIBUTE_SLOTS),
    stop: (location, item) => location.removeItemModifier(OP_MOD_SUB, item.ship, ATTRIBUTE_LAUNCHER_SLOTS_LEFT, item, ATTRIBUTE_SLOTS),
  }],
  [42, {
    start: (location, item) => location.addItemModifier(OP_MOD_SUB, item.ship, ATTRIBUTE_TURRET_SLOTS_LEFT, item, ATTRIBUTE_SLOTS),
    stop: (location, item) => location.removeItemModifier(OP_MOD_SUB, item.ship, ATTRIBUTE_TURRET_SLOTS_LEFT, item, ATTRIBUTE_SLOTS),
  }],
  [2663, changesEffect([[OP_MOD_SUB, ATTRIBUTE_UPGRADE_SLOTS_LEFT, ATTRIBUTE_SLOTS], [OP_MOD_ADD, ATTRIBUTE_UPGRADE_LOAD, ATTRIBUTE_UPGRADE_COST]])],
  [3772, NEUTRAL_PYTHON],
  // hardPointModifierEffect.HardpointModifierEffect (effectHardPointModifier): a subsystem's hardpoints added to the ship's.
  [3773, changesEffect([[OP_MOD_ADD, ATTRIBUTE_LAUNCHER_SLOTS_LEFT, ATTRIBUTE_LAUNCHER_HARDPOINT_MODIFIER], [OP_MOD_ADD, ATTRIBUTE_TURRET_SLOTS_LEFT, ATTRIBUTE_TURRET_HARDPOINT_MODIFIER]])],
  // slotModifier.SlotModifier (effectSlotModifier): a subsystem's high, medium and low slots added to the ship's.
  [3774, changesEffect([[OP_MOD_ADD, ATTRIBUTE_HI_SLOTS, ATTRIBUTE_HI_SLOT_MODIFIER], [OP_MOD_ADD, ATTRIBUTE_MED_SLOTS, ATTRIBUTE_MED_SLOT_MODIFIER], [OP_MOD_ADD, ATTRIBUTE_LOW_SLOTS, ATTRIBUTE_LOW_SLOT_MODIFIER]])],
  [6306, NEUTRAL_PYTHON],
  [EFFECT_ONLINE, {
    start: (location, item) => {
      location.checkCanOnline(item);
      location.setBaseValue(item, ATTRIBUTE_IS_ONLINE, 1);
      location.addItemModifier(OP_MOD_ADD, item.ship, ATTRIBUTE_CPU_LOAD, item, ATTRIBUTE_CPU);
      location.addItemModifier(OP_MOD_ADD, item.ship, ATTRIBUTE_POWER_LOAD, item, ATTRIBUTE_POWER);
    },
    stop: (location, item) => {
      location.removeItemModifier(OP_MOD_ADD, item.ship, ATTRIBUTE_CPU_LOAD, item, ATTRIBUTE_CPU);
      location.removeItemModifier(OP_MOD_ADD, item.ship, ATTRIBUTE_POWER_LOAD, item, ATTRIBUTE_POWER);
      location.setBaseValue(item, ATTRIBUTE_IS_ONLINE, 0);
    },
  }],
  [6731, propulsionEffect([[OP_MOD_ADD, ATTRIBUTE_MASS, 796]])],
  [6730, propulsionEffect([[OP_MOD_ADD, ATTRIBUTE_MASS, 796], [OP_POST_PERCENT, 552, 554]])],
  [48, { start: (location, item) => location.powerboost(item), stop: () => undefined }],
  [4928, changesEffect([[OP_PRE_MUL, 267, 267], [OP_PRE_MUL, 268, 268], [OP_PRE_MUL, 269, 269], [OP_PRE_MUL, 270, 270]])],
  [5788, {
    start: (location, item) => {
      for (const [op, skillID, toAttributeID, fromAttributeID] of BASTION_OWNER) location.addItemOwnerSkillModifier(op, item.pilot, skillID, toAttributeID, item, fromAttributeID);
      addChanges(location, item, BASTION_SHIP);
      for (const [op, skillID, toAttributeID, fromAttributeID] of BASTION_LOCATION) location.addItemLocationSkillModifier(op, item.ship, skillID, toAttributeID, item, fromAttributeID);
    },
    stop: (location, item) => {
      for (const [op, skillID, toAttributeID, fromAttributeID] of BASTION_OWNER) location.removeItemOwnerSkillModifier(op, item.pilot, skillID, toAttributeID, item, fromAttributeID);
      removeChanges(location, item, BASTION_SHIP);
      for (const [op, skillID, toAttributeID, fromAttributeID] of BASTION_LOCATION) location.removeItemLocationSkillModifier(op, item.ship, skillID, toAttributeID, item, fromAttributeID);
    },
  }],
  [6484, changesEffect([[OP_POST_MUL, 113, 974], [OP_POST_MUL, 110, 977], [OP_POST_MUL, 109, 976], [OP_POST_MUL, 111, 975]])],
  [6063, changesEffect([[OP_POST_PERCENT, 208, 1030], [OP_POST_PERCENT, 210, 1029], [OP_POST_PERCENT, 211, 1027], [OP_POST_PERCENT, 209, 1028]])],
  [4921, changesEffect(MJD_CHANGES)],
  [6421, changesEffect(MJD_CHANGES)],
  ...[6208, 12126].map((effectID): [number, PythonEffect] => [effectID, {
    start: (location, item) => {
      addChanges(location, item, MJPD_TETHER);
      addChanges(location, item, MJD_CHANGES);
    },
    stop: (location, item) => {
      removeChanges(location, item, MJD_CHANGES);
      removeChanges(location, item, MJPD_TETHER);
    },
  }]),
  [3380, {
    start: (location, item) => {
      for (const [op, groupID, toAttributeID, fromAttributeID] of WDS_GROUP) location.addItemLocationGroupModifier(op, item.ship, groupID, toAttributeID, item, fromAttributeID);
      addChanges(location, item, WDS_SHIP);
    },
    stop: (location, item) => {
      if (location.otherOfItem(item)) return;
      for (const [op, groupID, toAttributeID, fromAttributeID] of WDS_GROUP) location.removeItemLocationGroupModifier(op, item.ship, groupID, toAttributeID, item, fromAttributeID);
      removeChanges(location, item, WDS_SHIP);
    },
  }],
  ...[607, 980, 5945].map((effectID): [number, PythonEffect] => [effectID, {
    preStart: (location, item) => location.cloakChecks(item),
    start: (location, item) => location.startCloak(item, effectID),
    stop: (location, item) => location.removeItemModifier(OP_POST_MUL, item.ship, ATTRIBUTE_MAX_VELOCITY, item, ATTRIBUTE_MAX_VELOCITY_MODIFIER),
  }]),
  ...[10, 1199, 34, 1086, 17, 67, 2726, 47, 46, 6443, 55, 38, 81, 6995, 6422, 6423, 6424, 6425, 6426, 6427, 6428, 6682, 6683, 6684, 6686,
    6732, 6733, 6734, 6735, 6736, 6737, 6753, 6719].map((effectID): [number, PythonEffect] => [effectID, NEUTRAL_PYTHON]),
]);

function brainNumber(value: JsonValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const real = unwrapReal(value);
  if (real !== null) return real;
  const long = unwrapLong(value);
  return long !== null ? Number(long) : null;
}

function brainNumbers(value: JsonValue | undefined): number[] {
  const items = isListValue(value) ? value.items : Array.isArray(value) ? value : [];
  return (items as readonly JsonValue[]).map(brainNumber).filter((at): at is number => at !== null);
}

/** One BrainEffect as it comes over the wire: an objectex1 whose state dict holds its fields. */
function decodeBrainEffect(raw: JsonValue): BrainEffect | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const header = (raw as Record<string, JsonValue>).header;
  const state = Array.isArray(header) ? (header as readonly JsonValue[])[2] : undefined;
  const fields = new Map(readDictPairs(state).map(([key, value]) => [String(key), value]));
  const modifierType = fields.get("modifierType");
  const toAttribID = brainNumber(fields.get("toAttribID"));
  const operation = brainNumber(fields.get("operation"));
  const value = brainNumber(fields.get("value"));
  if (typeof modifierType !== "string" || toAttribID === null || operation === null || value === null) return null;
  return { modifierType, toAttribID, operation, value, skills: brainNumbers(fields.get("skills")), extras: brainNumbers(fields.get("extras")) };
}

function decodeBrainEffects(raw: JsonValue | undefined): BrainEffect[] {
  const items = isListValue(raw) ? raw.items : Array.isArray(raw) ? raw : [];
  return (items as readonly JsonValue[]).map(decodeBrainEffect).filter((effect): effect is BrainEffect => effect !== null);
}

/** The brain as GetAllInfo's charInfo carries it (its second part). */
export function decodeBrain(raw: JsonValue | null | undefined): Brain | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const parts = raw as readonly JsonValue[];
  return {
    version: brainNumber(parts[0]) ?? -1,
    charEffects: decodeBrainEffects(parts[1]),
    shipEffects: decodeBrainEffects(parts[2]),
    structureEffects: decodeBrainEffects(parts[3]),
  };
}

/** What a modifier comes from: another attribute, or a literal (the brain's). */
type ModifierSource =
  | { readonly kind: "attribute"; readonly key: string; readonly itemKey: string; readonly attributeID: number }
  | { readonly kind: "literal"; readonly key: string; readonly value: number; readonly forceUnnurfed: boolean; readonly skills?: readonly number[]; readonly itemKey?: string };

/** (operation, fromAttrib), as the location's and owner's modifier sets hold them. */
interface HeldModifier {
  readonly op: number;
  readonly source: ModifierSource;
}

function heldKey(held: HeldModifier): string {
  return `${held.op}|${held.source.key}`;
}

/** A dogma item (SlimDogmaItem and the classes on it, as far as the location needs). */
export class DogmaItem {
  readonly key: string;
  readonly typeID: number;
  readonly groupID: number | null;
  readonly categoryID: number | null;
  readonly reqSkills: ReadonlySet<number>;
  /** The attributes made so far, and the base value each was given (null: its type's value or default). */
  readonly attributes = new Map<number, number | null>();
  /** attributeID -> (operation|source) -> the modifier: the incoming modifiers, a set by operator. */
  readonly incoming = new Map<number, Map<string, HeldModifier>>();
  /** The item's location, where it is not its own. */
  location: DogmaItem | null = null;
  /** The pilot (GetPilot). */
  pilot: DogmaItem | null = null;
  /** The ship it is in or is (GetShip: the pilot's ship), where it has one. */
  ship: DogmaItem | null = null;
  /** The effects started on it (activeEffects). */
  readonly activeEffects = new Set<number>();
  /** The slot it is in, where it is fitted. */
  flagID: number | null = null;
  /** Whether the pilot's owner modifiers reach it (IsOwnerModifiable: a charge in the pilot's ship). */
  ownerModifiable = false;
  /** A location's: its sublocations (the charges) by flag. */
  readonly subLocations = new Map<number, DogmaItem>();
  /** A ship's: its drones (RegisterDrone), by key. */
  readonly drones = new Map<string, DogmaItem>();
  /** A ship's: its fighters, in its tubes or its fighter bay (GetShipItemForFighter), by key. */
  readonly fighters = new Map<string, DogmaItem>();
  /** How many the item is (the inventory row's stacksize: a stack of drones). */
  stacksize = 1;
  /** Its charged attributes (ChargedAttribute), by attribute. */
  readonly charged = new Map<number, ChargedState>();
  /** A running propulsion effect's literal on the ship's maxVelocity, and the mass and speed factor it was made of. */
  speedMultiplier: { readonly source: ModifierSource; readonly mass: number; readonly speedFactor: number } | null = null;
  /** A location's: the items fitted to it (itself among them, for a ship), and the modifiers it holds for them. */
  readonly fitted = new Map<string, DogmaItem>();
  readonly locationMods = new Map<number, Map<string, HeldModifier>>();
  readonly locationGroupMods = new Map<number, Map<number, Map<string, HeldModifier>>>();
  readonly locationReqSkillMods = new Map<number, Map<number, Map<string, HeldModifier>>>();
  /** An owner's: the modifiers it holds for what it owns. */
  readonly ownerReqSkillMods = new Map<number, Map<number, Map<string, HeldModifier>>>();

  constructor(key: string, typeID: number, facts: DogmaTypeFacts | null) {
    this.key = key;
    this.typeID = typeID;
    this.groupID = facts ? facts.groupID : null;
    this.categoryID = facts ? facts.categoryID : null;
    this.reqSkills = new Set(facts ? facts.requiredSkills : []);
  }
}

/** A charged attribute's (ChargedAttribute): what it is, the cap and recharge rate it was last brought up with, and when. */
interface ChargedState {
  current: number;
  prevCap: number;
  /** In milliseconds. */
  lastCalcTime: number;
  /** The recharge time over five. */
  rechargeRate: number;
}

function heldSet<K>(map: Map<K, Map<string, HeldModifier>>, key: K): Map<string, HeldModifier> {
  let set = map.get(key);
  if (!set) {
    set = new Map();
    map.set(key, set);
  }
  return set;
}

function heldSet2D(map: Map<number, Map<number, Map<string, HeldModifier>>>, first: number, second: number): Map<string, HeldModifier> {
  let inner = map.get(first);
  if (!inner) {
    inner = new Map();
    map.set(first, inner);
  }
  return heldSet(inner, second);
}

/**
 * A dogma location: its items and the modifiers between their attributes, each attribute's value reckoned as the
 * client's Attribute reckons it.
 */
export class DogmaLocation {
  readonly static: DogmaStatic;
  private readonly items = new Map<string, DogmaItem>();
  private readonly cache = new Map<string, number>();
  private readonly reckoning = new Set<string>();
  /** gametime.GetSimTime, in milliseconds: what the charged attributes run by. */
  private readonly clock: () => number;
  /** The charged attributes made. */
  private readonly chargedAttributes: [DogmaItem, number][] = [];
  private settling = false;
  /** The items a speed-changing effect runs on (SPEED_CHANGING_EFFECTS), and whether one is being refreshed. */
  private readonly speedItems = new Set<DogmaItem>();
  private refreshingSpeed = false;
  private literals = 0;

  constructor(staticData: DogmaStatic, clock: () => number = () => Date.now()) {
    this.static = staticData;
    this.clock = clock;
  }

  item(key: string): DogmaItem | null {
    return this.items.get(key) ?? null;
  }

  /**
   * LoadItem: an item of a type, linked to its location, pilot and ship as SlimDogmaItem's links are made before it is
   * loaded, then its attributes as its type has them (GetAttributesForItem, BaseDogmaItem.Load).
   */
  loadItem(
    key: string,
    typeID: number,
    links: {
      readonly location?: DogmaItem;
      /** The pilot, for an item with no location of its own (a drone: DroneDogmaItem.GetLocation is None). */
      readonly pilot?: DogmaItem;
      readonly flagID?: number;
      readonly ownerModifiable?: boolean;
      /** DBLessDogmaItem: its Load does nothing, so its attributes are made only as they are asked for. */
      readonly dbless?: boolean;
      /** Its instance row (GetInstance), by attribute (INSTANCE_ROW_ATTRIBUTES). */
      readonly instance?: ReadonlyMap<number, number>;
    } = {},
  ): DogmaItem {
    const facts = this.static.types[typeID] ?? null;
    const item = new DogmaItem(key, typeID, facts);
    this.items.set(key, item);
    if (links.location) {
      item.location = links.location;
      item.pilot = links.location.pilot;
      item.ship = links.location.categoryID === CATEGORY_SHIP ? links.location : links.location.ship;
    }
    if (!links.location && links.pilot) {
      item.pilot = links.pilot;
      item.ship = links.pilot.ship;
    }
    if (links.flagID !== undefined) item.flagID = links.flagID;
    item.ownerModifiable = links.ownerModifiable === true;
    if (links.dbless !== true) {
      for (const [attributeID, value] of facts ? facts.attributes : []) this.putBaseValue(item, attributeID, value);
      for (const [attributeID, value] of links.instance ?? []) if (value !== 0) this.putBaseValue(item, attributeID, value);
    }
    this.afterChange();
    return item;
  }

  /** After a change: each charged attribute whose cap or recharge time it changed brought up now (MarkDirty: Update). */
  private afterChange(): void {
    this.cache.clear();
    this.refreshSpeedEffects();
    if (this.chargedAttributes.length === 0 || this.settling) return;
    this.settling = true;
    try {
      const at = this.clock();
      for (const [item, attributeID] of this.chargedAttributes) {
        const state = item.charged.get(attributeID);
        const record = this.record(attributeID);
        if (!state || !record || !record.maxAttributeID || !record.chargeRechargeTimeID) continue;
        const changed =
          this.value(item, record.maxAttributeID) !== state.prevCap ||
          this.value(item, record.chargeRechargeTimeID) / 5.0 !== state.rechargeRate;
        if (changed) this.updateCharged(item, attributeID, state, at);
      }
    } finally {
      this.settling = false;
    }
  }

  /** ChargedAttribute.Update, at `at`. */
  private updateCharged(item: DogmaItem, attributeID: number, state: ChargedState, at: number): void {
    const record = this.record(attributeID);
    if (!record || !record.maxAttributeID || !record.chargeRechargeTimeID) return;
    const capVal = this.value(item, record.maxAttributeID);
    state.rechargeRate = this.value(item, record.chargeRechargeTimeID) / 5.0;
    const rechargeDelayFactor = state.rechargeRate;
    if (capVal === 0) {
      state.current = 0;
      state.prevCap = 0;
      return;
    }
    if (capVal !== state.prevCap) {
      if (state.prevCap > 0) state.current = (state.current / state.prevCap) * capVal;
      state.prevCap = capVal;
    }
    if (capVal <= state.current) {
      state.current = capVal;
      return;
    }
    if (rechargeDelayFactor === 0) {
      state.lastCalcTime = at;
      return;
    }
    const timeDiffMs = at - state.lastCalcTime;
    if (timeDiffMs < -0.0001) return;
    const root = Math.sqrt(state.current / capVal);
    const rootBlended = (root - 1.0) * Math.exp(-timeDiffMs / rechargeDelayFactor) + 1.0;
    state.current = rootBlended * rootBlended * capVal;
    state.lastCalcTime = at;
  }

  /** SetBaseValue, inside a change: a charged attribute is what it is set to from now on (MarkDirty: Update). */
  private putBaseValue(item: DogmaItem, attributeID: number, value: number | null): void {
    this.makeAttribute(item, attributeID);
    const state = item.charged.get(attributeID);
    if (!state) {
      item.attributes.set(attributeID, value);
      return;
    }
    if (value === null || state.current === value) return;
    state.current = value;
    state.lastCalcTime = this.clock();
    this.updateCharged(item, attributeID, state, state.lastCalcTime);
  }

  /** The attribute's static record. */
  private record(attributeID: number): DogmaAttributeRecord | null {
    return this.static.attributes[attributeID] ?? null;
  }

  /** dogma_data.get_type_attribute_or_default: the type's value, else the attribute's default. */
  private typeValue(item: DogmaItem, attributeID: number): number {
    const facts = this.static.types[item.typeID];
    const listed = facts ? facts.attributes.find(([id]) => id === attributeID) : undefined;
    if (listed && listed[1] !== null) return listed[1];
    const record = this.record(attributeID);
    return record && record.defaultValue !== null ? record.defaultValue : 0;
  }

  /**
   * item.attributes[attributeID]: made the first time it is asked for, with its cap and floor attributes, and the
   * modifiers its location and owner hold for it (Attribute.__init__, _PickUpInitialModifiers).
   */
  private makeAttribute(item: DogmaItem, attributeID: number): void {
    if (item.attributes.has(attributeID)) return;
    item.attributes.set(attributeID, null);
    const record = this.record(attributeID);
    if (record && record.maxAttributeID) this.makeAttribute(item, record.maxAttributeID);
    if (record && record.minAttributeID) this.makeAttribute(item, record.minAttributeID);
    if (record && record.maxAttributeID && record.chargeRechargeTimeID) {
      // ChargedAttribute: no modifier taken (AddIncomingModifier), its recharge time made, its type's value held to
      // its cap, from now.
      this.makeAttribute(item, record.chargeRechargeTimeID);
      const capVal = this.value(item, record.maxAttributeID);
      item.charged.set(attributeID, {
        current: Math.min(capVal, this.typeValue(item, attributeID)),
        prevCap: capVal,
        lastCalcTime: this.clock(),
        rechargeRate: this.value(item, record.chargeRechargeTimeID) / 5.0,
      });
      this.chargedAttributes.push([item, attributeID]);
      return;
    }
    const location = item.location;
    if (location) this.pickUpFromLocation(location, item, attributeID);
    if (item.pilot && item.ownerModifiable) this.pickUpFromOwner(item.pilot, item, attributeID);
  }

  /** _PickUpInitialModifiersFromOwnerTo */
  private pickUpFromOwner(owner: DogmaItem, item: DogmaItem, attributeID: number): void {
    for (const skillID of item.reqSkills) {
      for (const held of owner.ownerReqSkillMods.get(skillID)?.get(attributeID)?.values() ?? []) this.addIncoming(item, attributeID, held);
    }
  }

  /** _PickUpInitialModifiersFromLocationTo */
  private pickUpFromLocation(location: DogmaItem, item: DogmaItem, attributeID: number): void {
    const apply = (set: Map<string, HeldModifier> | undefined): void => {
      for (const held of set ? set.values() : []) this.addIncoming(item, attributeID, held);
    };
    apply(location.locationMods.get(attributeID));
    if (item.groupID !== null) apply(location.locationGroupMods.get(item.groupID)?.get(attributeID));
    for (const skillID of item.reqSkills) apply(location.locationReqSkillMods.get(skillID)?.get(attributeID));
  }

  private addIncoming(item: DogmaItem, attributeID: number, held: HeldModifier): void {
    // ChargedAttribute.AddIncomingModifier: "Cannot modify a charged attribute!"
    const record = this.record(attributeID);
    if (record && record.maxAttributeID && record.chargeRechargeTimeID) return;
    heldSet(item.incoming, attributeID).set(heldKey(held), held);
    this.afterChange();
  }

  /** dogmaItems[itemID].attributes[attribID], as a modifier's source. */
  private attributeSource(item: DogmaItem, attributeID: number): ModifierSource {
    this.makeAttribute(item, attributeID);
    return { kind: "attribute", key: `a|${item.key}|${attributeID}`, itemKey: item.key, attributeID };
  }

  /** brainLiterals[(skills, value)]: one BrainLiteralAttribute for each set of skills and value. */
  private brainLiteral(effect: BrainEffect): ModifierSource {
    return { kind: "literal", key: `b|${effect.skills.join(",")}|${effect.value}`, value: effect.value, forceUnnurfed: true, skills: effect.skills };
  }

  /**
   * AddModifier(operation, toItemID, toAttribID, fromItemID, fromAttribID): from one item's attribute; let go where the
   * target is not there.
   */
  addItemModifier(op: number, to: DogmaItem | null, toAttributeID: number, from: DogmaItem, fromAttributeID: number): void {
    const source = this.attributeSource(from, fromAttributeID);
    if (to) this.addModifier(op, to, toAttributeID, source);
  }

  /** AddModifierWithSource: the modifier on the target's attribute (made where it was not). */
  addModifier(op: number, to: DogmaItem, toAttributeID: number, source: ModifierSource): void {
    this.makeAttribute(to, toAttributeID);
    this.addIncoming(to, toAttributeID, { op, source });
  }

  /** AddLocationModifierWithSource */
  addLocationModifier(op: number, location: DogmaItem, toAttributeID: number, source: ModifierSource): void {
    const held = { op, source };
    heldSet(location.locationMods, toAttributeID).set(heldKey(held), held);
    for (const item of location.fitted.values()) if (item.attributes.has(toAttributeID)) this.addIncoming(item, toAttributeID, held);
  }

  /** AddLocationGroupModifierWithSource */
  addLocationGroupModifier(op: number, location: DogmaItem, groupID: number, toAttributeID: number, source: ModifierSource): void {
    const held = { op, source };
    heldSet2D(location.locationGroupMods, groupID, toAttributeID).set(heldKey(held), held);
    for (const item of location.fitted.values()) {
      if (item.groupID === groupID && item.attributes.has(toAttributeID)) this.addIncoming(item, toAttributeID, held);
    }
  }

  /** AddLocationRequiredSkillModifierWithSource */
  addLocationRequiredSkillModifier(op: number, location: DogmaItem, skillID: number, toAttributeID: number, source: ModifierSource): void {
    const held = { op, source };
    heldSet2D(location.locationReqSkillMods, skillID, toAttributeID).set(heldKey(held), held);
    for (const item of location.fitted.values()) {
      if (item.reqSkills.has(skillID) && item.attributes.has(toAttributeID)) this.addIncoming(item, toAttributeID, held);
    }
  }

  /** AddOwnerRequiredSkillModifierWithSource: held by the owner for what it owns (GetOwnedItemsToModify, later). */
  addOwnerRequiredSkillModifier(op: number, owner: DogmaItem, skillID: number, toAttributeID: number, source: ModifierSource): void {
    const held = { op, source };
    heldSet2D(owner.ownerReqSkillMods, skillID, toAttributeID).set(heldKey(held), held);
    // GetOwnedItemsToModify: the owner-modifiable items whose pilot it is, that require the skill and have the attribute.
    for (const item of this.items.values()) {
      if (item.ownerModifiable && item.pilot === owner && item.reqSkills.has(skillID) && item.attributes.has(toAttributeID)) {
        this.addIncoming(item, toAttributeID, held);
      }
    }
  }

  /** RemoveModifier(operation, toItemID, toAttribID, fromItemID, fromAttribID). */
  removeItemModifier(op: number, to: DogmaItem | null, toAttributeID: number, from: DogmaItem, fromAttributeID: number): void {
    if (to) this.removeModifier(op, to, toAttributeID, this.attributeSource(from, fromAttributeID));
  }

  /** RemoveModifierWithSource */
  removeModifier(op: number, to: DogmaItem, toAttributeID: number, source: ModifierSource): void {
    this.removeIncoming(to, toAttributeID, { op, source });
  }

  /** RemoveLocationModifierWithSource */
  removeLocationModifier(op: number, location: DogmaItem, toAttributeID: number, source: ModifierSource): void {
    const held = { op, source };
    location.locationMods.get(toAttributeID)?.delete(heldKey(held));
    for (const item of location.fitted.values()) this.removeIncoming(item, toAttributeID, held);
  }

  /** RemoveLocationGroupModifierWithSource */
  removeLocationGroupModifier(op: number, location: DogmaItem, groupID: number, toAttributeID: number, source: ModifierSource): void {
    const held = { op, source };
    location.locationGroupMods.get(groupID)?.get(toAttributeID)?.delete(heldKey(held));
    for (const item of location.fitted.values()) if (item.groupID === groupID) this.removeIncoming(item, toAttributeID, held);
  }

  /** RemoveLocationRequiredSkillModifierWithSource */
  removeLocationRequiredSkillModifier(op: number, location: DogmaItem, skillID: number, toAttributeID: number, source: ModifierSource): void {
    const held = { op, source };
    location.locationReqSkillMods.get(skillID)?.get(toAttributeID)?.delete(heldKey(held));
    for (const item of location.fitted.values()) if (item.reqSkills.has(skillID)) this.removeIncoming(item, toAttributeID, held);
  }

  /** RemoveOwnerRequiredSkillModifierWithSource */
  removeOwnerRequiredSkillModifier(op: number, owner: DogmaItem, skillID: number, toAttributeID: number, source: ModifierSource): void {
    const held = { op, source };
    owner.ownerReqSkillMods.get(skillID)?.get(toAttributeID)?.delete(heldKey(held));
    for (const item of this.items.values()) {
      if (item.ownerModifiable && item.pilot === owner && item.reqSkills.has(skillID)) this.removeIncoming(item, toAttributeID, held);
    }
  }

  /** AddLocationGroupModifier and its Remove, from an item's attribute (an Effect's LOCATION_AND_GROUP_MODIFIER_CHANGES). */
  addItemLocationGroupModifier(op: number, location: DogmaItem | null, groupID: number, toAttributeID: number, from: DogmaItem, fromAttributeID: number): void {
    if (location) this.addLocationGroupModifier(op, location, groupID, toAttributeID, this.attributeSource(from, fromAttributeID));
  }
  removeItemLocationGroupModifier(op: number, location: DogmaItem | null, groupID: number, toAttributeID: number, from: DogmaItem, fromAttributeID: number): void {
    if (location) this.removeLocationGroupModifier(op, location, groupID, toAttributeID, this.attributeSource(from, fromAttributeID));
  }

  /** AddLocationRequiredSkillModifier and its Remove, from an item's attribute (SKILL_MODIFIER_CHANGES_FOR_LOCATION). */
  addItemLocationSkillModifier(op: number, location: DogmaItem | null, skillID: number, toAttributeID: number, from: DogmaItem, fromAttributeID: number): void {
    if (location) this.addLocationRequiredSkillModifier(op, location, skillID, toAttributeID, this.attributeSource(from, fromAttributeID));
  }
  removeItemLocationSkillModifier(op: number, location: DogmaItem | null, skillID: number, toAttributeID: number, from: DogmaItem, fromAttributeID: number): void {
    if (location) this.removeLocationRequiredSkillModifier(op, location, skillID, toAttributeID, this.attributeSource(from, fromAttributeID));
  }

  /** AddOwnerRequiredSkillModifier and its Remove, from an item's attribute (SKILL_MODIFIER_CHANGES_FOR_OWNER). */
  addItemOwnerSkillModifier(op: number, owner: DogmaItem | null, skillID: number, toAttributeID: number, from: DogmaItem, fromAttributeID: number): void {
    if (owner) this.addOwnerRequiredSkillModifier(op, owner, skillID, toAttributeID, this.attributeSource(from, fromAttributeID));
  }
  removeItemOwnerSkillModifier(op: number, owner: DogmaItem | null, skillID: number, toAttributeID: number, from: DogmaItem, fromAttributeID: number): void {
    if (owner) this.removeOwnerRequiredSkillModifier(op, owner, skillID, toAttributeID, this.attributeSource(from, fromAttributeID));
  }

  private removeIncoming(item: DogmaItem, attributeID: number, held: HeldModifier): void {
    const set = item.incoming.get(attributeID);
    if (!set || !set.delete(heldKey(held))) return;
    this.afterChange();
  }

  /** An item's other (GetOtherID, GetSlotOther): a module's charge in its slot, a charge's module. */
  otherOfItem(item: DogmaItem): DogmaItem | null {
    return this.otherOf(item);
  }

  /** Afterburner._AddSpeedMultiplierModifier: the literal on the ship's maxVelocity, of the module and the ship as they are. */
  addSpeedMultiplier(item: DogmaItem): void {
    const ship = item.ship;
    if (!ship) return;
    const speedFactor = this.value(item, ATTRIBUTE_SPEED_FACTOR);
    const speedBoostFactor = this.value(item, ATTRIBUTE_SPEED_BOOST_FACTOR);
    const shipMass = this.value(ship, ATTRIBUTE_MASS);
    const speedMultiplier = 1 + SPEED_BOOST_FACTOR_CALC * speedFactor * speedBoostFactor / shipMass;
    this.literals += 1;
    const source: ModifierSource = { kind: "literal", key: `l|${this.literals}`, value: speedMultiplier, forceUnnurfed: false, itemKey: item.key };
    item.speedMultiplier = { source, mass: shipMass, speedFactor };
    this.addModifier(OP_POST_MUL, ship, ATTRIBUTE_MAX_VELOCITY, source);
  }

  /** Afterburner._RemoveSpeedMultiplierModifier */
  removeSpeedMultiplier(item: DogmaItem): void {
    const held = item.speedMultiplier;
    item.speedMultiplier = null;
    if (held && item.ship) this.removeModifier(OP_POST_MUL, item.ship, ATTRIBUTE_MAX_VELOCITY, held.source);
  }

  /**
   * RefreshEffectsOnShip and _TryRefreshOtherModuleEffectsOnChanges: a running speed-changing effect made again where
   * the ship's mass has changed (OnAttributeChanged of the ship's mass) or the module's speed factor has
   * (SPEED_ATTRIBUTES_REQUIRING_MODULE_UPDATE): Afterburner.RefreshEffect, where its literal is still on the ship.
   */
  private refreshSpeedEffects(): void {
    if (this.speedItems.size === 0 || this.refreshingSpeed) return;
    this.refreshingSpeed = true;
    try {
      for (const item of this.speedItems) {
        const held = item.speedMultiplier;
        const ship = item.ship;
        if (!held || !ship) continue;
        if (this.value(ship, ATTRIBUTE_MASS) === held.mass && this.value(item, ATTRIBUTE_SPEED_FACTOR) === held.speedFactor) continue;
        if (!ship.incoming.get(ATTRIBUTE_MAX_VELOCITY)?.has(heldKey({ op: OP_POST_MUL, source: held.source }))) continue;
        this.removeSpeedMultiplier(item);
        this.addSpeedMultiplier(item);
      }
    } finally {
      this.refreshingSpeed = false;
    }
  }

  /** Powerboost.Start: the charge in the module's slot, one at least, its capacitorBonus added to the ship's charge. */
  powerboost(item: DogmaItem): void {
    const ship = item.ship;
    const charge = ship && item.flagID !== null ? ship.subLocations.get(item.flagID) : undefined;
    if (!ship || !charge) return;
    if (this.value(charge, ATTRIBUTE_QUANTITY) < 1) return;
    const capacitorBonus = this.value(charge, ATTRIBUTE_CAPACITOR_BONUS);
    // FittingDogmaLocation.IncreaseItemAttributeEx: the attribute's base made what it is now and the bonus.
    if (capacitorBonus !== 0) this.setBaseValue(ship, ATTRIBUTE_CHARGE, this.value(ship, ATTRIBUTE_CHARGE) + capacitorBonus);
  }

  /** LocationDogmaItem.CheckCanOnlineItem: no more of a group online than the lowest maxGroupOnline of its modules. */
  checkCanOnline(item: DogmaItem): void {
    const ship = item.ship;
    if (!ship) return;
    let maxGroupOnline: number | null = null;
    for (const fitted of ship.fitted.values()) {
      if (fitted.groupID !== item.groupID || fitted === ship) continue;
      const listed = this.static.types[fitted.typeID]?.attributes.some(([id]) => id === ATTRIBUTE_MAX_GROUP_ONLINE);
      if (!listed) continue;
      const value = Math.trunc(this.value(fitted, ATTRIBUTE_MAX_GROUP_ONLINE));
      maxGroupOnline = maxGroupOnline === null ? value : Math.min(maxGroupOnline, value);
    }
    if (maxGroupOnline === null) return;
    let online = 0;
    for (const fitted of ship.fitted.values()) if (fitted !== item && fitted.groupID === item.groupID && this.isOnline(fitted)) online += 1;
    if (online >= maxGroupOnline) {
      throw new DogmaUserError("CannotOnlineReachedMaxGroupOnline", { type: item.typeID, group: item.groupID ?? 0, maxGroupOnline });
    }
  }

  /**
   * baseDogmaLocation.SlotExists (1786 to 1807): whether the ship has the slot of a high, medium, low, rig or service
   * flag (its number within the kind below the ship's count of them); any other flag, yes.
   */
  slotExists(ship: DogmaItem, flagID: number): boolean {
    const kinds: readonly (readonly [number, number, number])[] = [
      [27, 34, ATTRIBUTE_HI_SLOTS], [19, 26, ATTRIBUTE_MED_SLOTS], [11, 18, ATTRIBUTE_LOW_SLOTS], [92, 99, ATTRIBUTE_RIG_SLOTS], [164, 171, ATTRIBUTE_SERVICE_SLOTS],
    ];
    const kind = kinds.find(([first, last]) => flagID >= first && flagID <= last);
    return kind === undefined || flagID - kind[0] < this.value(ship, kind[2]);
  }

  /** ModuleDogmaItem.IsOnline: its online effect running. */
  isOnline(item: DogmaItem): boolean {
    return item.activeEffects.has(EFFECT_ONLINE);
  }

  /** FittableDogmaItem.IsActive: an activated or targeted effect running on it. */
  isActive(item: DogmaItem): boolean {
    for (const effectID of item.activeEffects) {
      if (effectID === EFFECT_ONLINE) continue;
      const category = this.static.effects[effectID]?.category;
      if (category === EFFECT_CATEGORY_ACTIVATION || category === EFFECT_CATEGORY_TARGET) return true;
    }
    return false;
  }

  /** FittingDogmaLocation.IsShipCloaked: a cloaking device of the ship's active. */
  isShipCloaked(ship: DogmaItem): boolean {
    for (const fitted of ship.fitted.values()) if (fitted.groupID === GROUP_CLOAKING_DEVICE && this.isActive(fitted)) return true;
    return false;
  }

  /** GetActivatedEffectsOnShip: each effect of an activated, targeted or area kind running on the ship's items, not online. */
  private activatedEffectsOnShip(ship: DogmaItem): [DogmaItem, number][] {
    const found: [DogmaItem, number][] = [];
    for (const fitted of ship.fitted.values()) {
      for (const effectID of fitted.activeEffects) {
        const category = this.static.effects[effectID]?.category;
        if (effectID !== EFFECT_ONLINE && (category === EFFECT_CATEGORY_ACTIVATION || category === EFFECT_CATEGORY_TARGET || category === EFFECT_CATEGORY_AREA)) {
          found.push([fitted, effectID]);
        }
      }
    }
    return found;
  }

  /** FakeCloaking.PreStartChecks */
  cloakChecks(item: DogmaItem): void {
    const ship = item.ship;
    if (!ship) return;
    if (this.isShipCloaked(ship)) throw new DogmaUserError("CantCloakTooManyDevices");
    if (!this.value(ship, ATTRIBUTE_CAN_CLOAK)) throw new DogmaUserError("CantCloakTooShipUnsuitable");
    for (const [fitted] of this.activatedEffectsOnShip(ship)) {
      const disallow = this.static.types[fitted.typeID]?.attributes.find(([id]) => id === ATTRIBUTE_DISALLOW_EARLY_DEACTIVATION)?.[1];
      if (disallow) throw new DogmaUserError("CantCloakModuleActive", { module: fitted.typeID });
    }
    if (this.value(ship, ATTRIBUTE_DISALLOW_CLOAKING)) throw new DogmaUserError("CantCloak");
  }

  /**
   * FakeCloaking.Start: every other activated effect of the ship stopped (EnforceActivationConditions), the ship's
   * maxVelocity multiplied by the module's maxVelocityModifier, then the checks again: failing them, the cloak stops.
   */
  startCloak(item: DogmaItem, effectID: number): void {
    const ship = item.ship;
    if (!ship) return;
    this.stopActivatedEffectsOfShip(ship, item, effectID);
    this.addItemModifier(OP_POST_MUL, ship, ATTRIBUTE_MAX_VELOCITY, item, ATTRIBUTE_MAX_VELOCITY_MODIFIER);
    try {
      this.cloakChecks(item);
    } catch (error) {
      if (!(error instanceof DogmaUserError)) throw error;
      this.stopEffect(item, effectID);
      return;
    }
    this.stopActivatedEffectsOfShip(ship, item, effectID);
  }

  /** DeactivateActivatedEffectsOfShip, but the one excluded: each stopped, forced. */
  private stopActivatedEffectsOfShip(ship: DogmaItem, excludeItem: DogmaItem, excludeEffectID: number): void {
    for (const [fitted, effectID] of this.activatedEffectsOnShip(ship)) {
      if (fitted === excludeItem && effectID === excludeEffectID) continue;
      this.stopEffect(fitted, effectID);
    }
  }

  /**
   * StartEffect(effectID, itemKey, environment), as the Fitting window starts an effect (ChangeModuleStatus): nothing
   * where the type has no such effect; a DogmaUserError where it is running already (EffectAlreadyActive2) or a check
   * fails; then its Python version, its modifiers or nothing; the online effect starts the type's online effects after
   * it (a failing one passed over); then it is running.
   */
  startEffect(item: DogmaItem, effectID: number): void {
    const facts = this.static.types[item.typeID];
    if (!facts || !facts.effects.includes(effectID)) return;
    if (item.activeEffects.has(effectID)) throw new DogmaUserError("EffectAlreadyActive2", { modulename: item.typeID });
    const effect = this.static.effects[effectID] ?? null;
    // BaseDogmaLocation.StartEffect_PreChecks
    if (effectID === EFFECT_ONLINE) {
      const moduleHp = this.value(item, ATTRIBUTE_HP);
      if (moduleHp && moduleHp <= this.value(item, ATTRIBUTE_DAMAGE)) throw new DogmaUserError("ModuleTooDamagedToBeOnlined");
    }
    // FittingDogmaLocation.StartEffect_PreChecks
    if (effect && (effect.category === EFFECT_CATEGORY_ACTIVATION || effect.category === EFFECT_CATEGORY_TARGET) && this.isOnline(item)) {
      this.checkGroupActive(item);
      if (this.value(item, ATTRIBUTE_ACTIVATION_BLOCKED) !== 0) throw new DogmaUserError("ModuleIsBlocked", { moduleName: item.typeID });
    }
    // _StartEffect: PreStartEffectChecks, of the online effects too where it is the online effect.
    const python = PYTHON_EFFECTS.get(effectID);
    python?.preStart?.(this, item);
    const onlineEffects = effectID === EFFECT_ONLINE
      ? facts.effects.filter((id) => this.static.effects[id]?.category === EFFECT_CATEGORY_ONLINE)
      : [];
    for (const onlineEffectID of onlineEffects) PYTHON_EFFECTS.get(onlineEffectID)?.preStart?.(this, item);
    if (python) python.start(this, item);
    else if (effect && effect.modifiers) this.startModifiers(item, effect.modifiers);
    for (const onlineEffectID of onlineEffects) {
      try {
        this.startEffect(item, onlineEffectID);
      } catch (error) {
        if (!(error instanceof DogmaUserError)) throw error;
      }
    }
    item.activeEffects.add(effectID);
    if (SPEED_CHANGING_EFFECTS.has(effectID)) this.speedItems.add(item);
  }

  /** _CheckIfTooManyModulesInGroupAreActive */
  private checkGroupActive(item: DogmaItem): void {
    const ship = item.ship;
    if (!ship || ship.categoryID !== CATEGORY_SHIP) return;
    let maxGroupActive = this.value(item, ATTRIBUTE_MAX_GROUP_ACTIVE);
    if (item.groupID === this.value(ship, ATTRIBUTE_MAX_SHIP_GROUP_ACTIVE_ID)) {
      maxGroupActive = Math.max(this.value(ship, ATTRIBUTE_MAX_SHIP_GROUP_ACTIVE), maxGroupActive);
    }
    if (maxGroupActive <= 0) return;
    let total = 0;
    for (const fitted of ship.fitted.values()) if (fitted.groupID === item.groupID && this.isActive(fitted)) total += 1;
    if (total >= maxGroupActive) throw new DogmaUserError("EffectCrowdedOut", { module: item.typeID, count: total });
  }

  /**
   * StopEffect: nothing where it is not running; the online effect stops each other running effect of the item that
   * has no duration and is not passive first (_StopEffect); then its Python version's Stop or its modifiers let go.
   */
  stopEffect(item: DogmaItem, effectID: number): void {
    if (!item.activeEffects.has(effectID)) return;
    if (effectID === EFFECT_ONLINE) {
      for (const otherEffectID of [...item.activeEffects]) {
        if (otherEffectID === effectID || !item.activeEffects.has(otherEffectID)) continue;
        const other = this.static.effects[otherEffectID];
        if (!other?.durationAttributeID && other?.category !== EFFECT_CATEGORY_PASSIVE) this.stopEffect(item, otherEffectID);
      }
    }
    const python = PYTHON_EFFECTS.get(effectID);
    const effect = this.static.effects[effectID] ?? null;
    if (python) python.stop(this, item);
    else if (effect && effect.modifiers) this.stopModifiers(item, effect.modifiers);
    item.activeEffects.delete(effectID);
    if (SPEED_CHANGING_EFFECTS.has(effectID)) this.speedItems.delete(item);
  }

  /** StopPassiveEffects: each passive or system effect running on the item, in its type's order. */
  stopPassiveEffects(item: DogmaItem): void {
    for (const effectID of this.static.types[item.typeID]?.effects ?? []) {
      if (!item.activeEffects.has(effectID)) continue;
      const category = this.static.effects[effectID]?.category;
      if (category === EFFECT_CATEGORY_PASSIVE || category === EFFECT_CATEGORY_SYSTEM) this.stopEffect(item, effectID);
    }
  }

  /**
   * fittingUtil.GetDefaultAndOverheatEffectForType: the type's default effect, whether it is one a module is activated
   * by (IsEffectActivatable: an activated or targeted one, not online), and its overload effect (the last of that kind).
   */
  typeEffectInfo(typeID: number): { readonly defaultEffectID: number | null; readonly overloadEffectID: number | null; readonly isActivatable: boolean } {
    const facts = this.static.types[typeID];
    const defaultEffectID = facts?.defaultEffectID ?? null;
    let overloadEffectID: number | null = null;
    for (const effectID of facts?.effects ?? []) if (this.static.effects[effectID]?.category === EFFECT_CATEGORY_OVERLOAD) overloadEffectID = effectID;
    const category = defaultEffectID === null ? null : this.static.effects[defaultEffectID]?.category;
    const isActivatable = defaultEffectID !== null && defaultEffectID !== EFFECT_ONLINE &&
      (category === EFFECT_CATEGORY_ACTIVATION || category === EFFECT_CATEGORY_TARGET);
    return { defaultEffectID, overloadEffectID, isActivatable };
  }

  /** FittingDogmaLocation.ActivateModule: its default effect started (not while the ship is cloaked), a rig's passive effects too. */
  activateModule(module: DogmaItem): void {
    const ship = module.ship;
    if (ship && this.isShipCloaked(ship) && !(module.flagID !== null && RIG_SLOT_FLAGS.has(module.flagID))) {
      throw new DogmaUserError("DeniedActivateCloaked");
    }
    const { defaultEffectID } = this.typeEffectInfo(module.typeID);
    if (defaultEffectID !== null) this.startEffect(module, defaultEffectID);
    if (module.flagID !== null && RIG_SLOT_FLAGS.has(module.flagID)) this.startPassiveEffects(module);
  }

  /** ChangeModuleOverheatStatus: its overload effect started or stopped, and its default effect started again. */
  overheatModule(module: DogmaItem, start: boolean): void {
    const { defaultEffectID, overloadEffectID } = this.typeEffectInfo(module.typeID);
    if (overloadEffectID === null) return;
    if (start) this.startEffect(module, overloadEffectID);
    else this.stopEffect(module, overloadEffectID);
    if (defaultEffectID !== null) {
      this.stopEffect(module, defaultEffectID);
      this.activateModule(module);
    }
  }

  /** OfflineSimulatedModule: its online effect stopped, a rig's passive effects, then its default and overload effects. */
  offlineModule(module: DogmaItem): void {
    this.stopEffect(module, EFFECT_ONLINE);
    if (module.flagID !== null && RIG_SLOT_FLAGS.has(module.flagID)) this.stopPassiveEffects(module);
    this.deactivateModule(module);
  }

  /** DeactivateSimulatedModule: its default and overload effects stopped. */
  deactivateModule(module: DogmaItem): void {
    const { defaultEffectID, overloadEffectID } = this.typeEffectInfo(module.typeID);
    if (defaultEffectID !== null) this.stopEffect(module, defaultEffectID);
    if (overloadEffectID !== null) this.stopEffect(module, overloadEffectID);
  }

  /** The item a modifier's domain names (BaseModifier._GetDomainID on the effect's environment). */
  private domainItem(item: DogmaItem, domain: string | null): DogmaItem | null {
    if (domain === null || domain === "itemID") return item;
    // A ship's own, an item fitted to one its ship's (GetShipID: its location), and a drone's itself
    // (BaseDogmaItem.GetShipID).
    if (domain === "shipID") return item.categoryID === CATEGORY_SHIP || item.categoryID === CATEGORY_DRONE ? item : item.ship;
    if (domain === "charID") return item.pilot;
    if (domain === "otherID") return this.otherOf(item);
    return null;
  }

  /** An item's other: a module's charge in its slot (GetOtherID), a charge's module (GetSlotOther). */
  private otherOf(item: DogmaItem): DogmaItem | null {
    const ship = item.location;
    if (!ship || item.flagID === null) return null;
    if (item.categoryID !== null && FITTING_MODULE_CATEGORIES.has(item.categoryID)) return ship.subLocations.get(item.flagID) ?? null;
    for (const fitted of ship.fitted.values()) {
      if (fitted.flagID === item.flagID && fitted.categoryID !== null && FITTING_MODULE_CATEGORIES.has(fitted.categoryID)) return fitted;
    }
    return null;
  }

  /** ModifierEffect.Start: each of the effect's modifiers put in place from the item. */
  private startModifiers(item: DogmaItem, modifiers: readonly DogmaModifierInfo[]): void {
    for (const info of modifiers) {
      if (info.operation === null || info.modifiedAttributeID === null || info.modifyingAttributeID === null) continue;
      const to = this.domainItem(item, info.domain);
      if (!to) continue;
      const source = this.attributeSource(item, info.modifyingAttributeID);
      switch (info.func) {
        case "ItemModifier":
          this.addModifier(info.operation, to, info.modifiedAttributeID, source);
          break;
        case "LocationModifier":
          this.addLocationModifier(info.operation, to, info.modifiedAttributeID, source);
          break;
        case "LocationGroupModifier":
          if (info.groupID !== null) this.addLocationGroupModifier(info.operation, to, info.groupID, info.modifiedAttributeID, source);
          break;
        case "LocationRequiredSkillModifier":
          if (info.skillTypeID !== null) this.addLocationRequiredSkillModifier(info.operation, to, info.skillTypeID, info.modifiedAttributeID, source);
          break;
        case "OwnerRequiredSkillModifier":
          if (info.skillTypeID !== null) this.addOwnerRequiredSkillModifier(info.operation, to, info.skillTypeID, info.modifiedAttributeID, source);
          break;
        default:
          break;
      }
    }
  }

  /** ModifierEffect.Stop: each of the effect's modifiers let go. */
  private stopModifiers(item: DogmaItem, modifiers: readonly DogmaModifierInfo[]): void {
    for (const info of modifiers) {
      if (info.operation === null || info.modifiedAttributeID === null || info.modifyingAttributeID === null) continue;
      const to = this.domainItem(item, info.domain);
      if (!to) continue;
      const source = this.attributeSource(item, info.modifyingAttributeID);
      switch (info.func) {
        case "ItemModifier":
          this.removeModifier(info.operation, to, info.modifiedAttributeID, source);
          break;
        case "LocationModifier":
          this.removeLocationModifier(info.operation, to, info.modifiedAttributeID, source);
          break;
        case "LocationGroupModifier":
          if (info.groupID !== null) this.removeLocationGroupModifier(info.operation, to, info.groupID, info.modifiedAttributeID, source);
          break;
        case "LocationRequiredSkillModifier":
          if (info.skillTypeID !== null) this.removeLocationRequiredSkillModifier(info.operation, to, info.skillTypeID, info.modifiedAttributeID, source);
          break;
        case "OwnerRequiredSkillModifier":
          if (info.skillTypeID !== null) this.removeOwnerRequiredSkillModifier(info.operation, to, info.skillTypeID, info.modifiedAttributeID, source);
          break;
        default:
          break;
      }
    }
  }

  /** StartPassiveEffects, as the Fitting window starts them. */
  startPassiveEffects(item: DogmaItem): void {
    const facts = this.static.types[item.typeID];
    for (const effectID of facts ? facts.effects : []) {
      if (UNWANTED_EFFECTS.has(effectID) || item.activeEffects.has(effectID)) continue;
      const effect = this.static.effects[effectID];
      if (!effect || effect.category !== EFFECT_CATEGORY_PASSIVE) continue;
      const python = PYTHON_EFFECTS.get(effectID);
      if (python) {
        python.start(this, item);
        item.activeEffects.add(effectID);
        continue;
      }
      const modifiers = effect.modifiers;
      if (!modifiers) continue;
      // __modifies_character__ and __modifies_ship__ (ModifierEffect): an OwnerRequiredSkillModifier is both.
      const modifiesCharacter = modifiers.some((info) => info.domain === "charID" || info.func === "OwnerRequiredSkillModifier");
      const modifiesShip = modifiers.some((info) => info.domain === "shipID" || info.func === "OwnerRequiredSkillModifier");
      if (item.pilot === null && modifiesCharacter) continue;
      if (item.ship === null && modifiesShip) continue;
      if (effect.chanceAttributeID && facts!.attributes.some(([id]) => id === effect.chanceAttributeID)) continue;
      if (modifiers.some((info) => info.domain === "otherID") && this.otherOf(item) === null) continue;
      this.startModifiers(item, modifiers);
      item.activeEffects.add(effectID);
    }
  }

  /**
   * FitModuleToShip (GetLoadedItem, _LoadItem): a module loaded in a slot of the ship, fitted to it (SetLocation,
   * RegisterFittedItem) and its passive effects started (FitItemToLocation: a fitting flag).
   */
  fitModule(ship: DogmaItem, key: string, typeID: number, flagID: number, instance?: ReadonlyMap<number, number>): DogmaItem {
    const module = this.loadItem(key, typeID, { location: ship, flagID, ...(instance ? { instance } : {}) });
    ship.fitted.set(module.key, module);
    if (isFittingFlag(flagID)) this.startPassiveEffects(module);
    return module;
  }

  /**
   * OnlineModule: StartEffect(effectOnline) where the type has it (the Fitting window's OnlineEffect: isOnline, then the
   * module's CPU and power added to the ship's loads), then each of its online effects (_StartEffect). A module online
   * already, or one that may not be, is left as it is (the Fitting window passes over those UserErrors).
   */
  onlineModule(module: DogmaItem): void {
    if (this.isOnline(module)) return;
    try {
      this.startEffect(module, EFFECT_ONLINE);
    } catch (error) {
      if (!(error instanceof DogmaUserError)) throw error;
    }
  }

  /**
   * FittingDogmaLocation.UnfitItemFromShip: a module's charge unfitted first; then the item unfitted from the ship
   * (UnfitItemFromLocation: its running effects that are not passive stopped, then its passive ones) and unloaded.
   */
  unfitItem(ship: DogmaItem, item: DogmaItem): void {
    const isCharge = item.flagID !== null && ship.subLocations.get(item.flagID) === item;
    if (!isCharge && item.flagID !== null) {
      const charge = ship.subLocations.get(item.flagID);
      if (charge) this.unfitItem(ship, charge);
    }
    for (const effectID of [...item.activeEffects]) {
      if (this.static.effects[effectID]?.category !== EFFECT_CATEGORY_PASSIVE) this.stopEffect(item, effectID);
    }
    this.stopPassiveEffects(item);
    ship.fitted.delete(item.key);
    ship.drones.delete(item.key);
    ship.fighters.delete(item.key);
    if (isCharge && item.flagID !== null) ship.subLocations.delete(item.flagID);
    this.items.delete(item.key);
    this.afterChange();
  }

  /**
   * A drone in the ship's drone bay (LoadItemsInLocation, FitItemToLocation: the ship's drone bay is a valid flag):
   * loaded with no location of its own (DroneDogmaItem.GetLocation), the pilot's (its owner), registered with the ship
   * (SetLocation: RegisterDrone), so owner-modifiable (IsOwnerModifiable: the pilot's ship holds it among its drones,
   * on the client), and its passive effects started.
   */
  /**
   * A squadron of fighters in one of the ship's tubes or in its fighter bay (LoadItem of a GhostFighterDogmaItem; a
   * FighterDogmaItem): the pilot's (its owner), held by the ship (GetShipItemForFighter), so owner-modifiable
   * (IsOwnerModifiable: AddFighterControllerOwnerModifiers, the owner's modifiers of its required skills), its passive
   * effects started; its squadron size its stacksize (squadronSize).
   */
  loadFighter(ship: DogmaItem, key: string, typeID: number, flagID: number, squadronSize: number): DogmaItem {
    const fighter = this.loadItem(key, typeID, { pilot: ship.pilot ?? undefined, flagID, ownerModifiable: true });
    fighter.stacksize = squadronSize;
    ship.fighters.set(fighter.key, fighter);
    this.startPassiveEffects(fighter);
    return fighter;
  }

  loadDrone(ship: DogmaItem, key: string, typeID: number, stacksize: number): DogmaItem {
    const drone = this.loadItem(key, typeID, { pilot: ship.pilot ?? undefined, flagID: FLAG_DRONE_BAY, ownerModifiable: true });
    drone.stacksize = stacksize;
    ship.drones.set(drone.key, drone);
    this.startPassiveEffects(drone);
    return drone;
  }

  /**
   * FitAmmoToLocation: a charge loaded in a module's slot, a sublocation of the ship (its key the ship, the flag and
   * its type: DBLessGhostFittingDataObject, a DBLessDogmaItem whose attributes are made as they are asked for),
   * owner-modifiable, fitted, and its passive effects started; then its quantity, which the Fitting window always
   * gives as 1 (DBLessDogmaItem.OnItemLoaded: GetQuantityFromCache). The charges a slot holds are kept off dogma
   * (the item's stacksize).
   */
  loadCharge(ship: DogmaItem, flagID: number, typeID: number): DogmaItem {
    const charge = this.loadItem(`${ship.key}|${flagID}|${typeID}`, typeID, { location: ship, flagID, ownerModifiable: true, dbless: true });
    ship.subLocations.set(flagID, charge);
    ship.fitted.set(charge.key, charge);
    if (isFittingFlag(flagID)) this.startPassiveEffects(charge);
    this.setBaseValue(charge, ATTRIBUTE_QUANTITY, 1);
    return charge;
  }

  /** ApplyBrainEffect: one of the brain's effects on the target (the ship, or the pilot). */
  private applyBrainEffect(target: DogmaItem, effect: BrainEffect): void {
    const literal = this.brainLiteral(effect);
    const extra = effect.extras[0];
    switch (effect.modifierType) {
      case "M":
        this.addModifier(effect.operation, target, effect.toAttribID, literal);
        break;
      case "L":
        this.addLocationModifier(effect.operation, target, effect.toAttribID, literal);
        break;
      case "LG":
        if (extra !== undefined) this.addLocationGroupModifier(effect.operation, target, extra, effect.toAttribID, literal);
        break;
      case "LRS":
        if (extra !== undefined) this.addLocationRequiredSkillModifier(effect.operation, target, extra, effect.toAttribID, literal);
        break;
      case "ORS":
        if (extra !== undefined) this.addOwnerRequiredSkillModifier(effect.operation, target, extra, effect.toAttribID, literal);
        break;
      default:
        break;
    }
  }

  /** ApplyBrainEffects: the ship effects on the ship (a modifier of one attribute where the hull has it), then the character effects on the pilot. */
  applyBrainEffects(ship: DogmaItem, pilot: DogmaItem, brain: Brain): void {
    const facts = this.static.types[ship.typeID];
    const valid = new Set<number>((facts ? facts.attributes : []).map(([id]) => id));
    valid.add(ATTRIBUTE_CAPACITY);
    for (const effect of brain.shipEffects) {
      if (effect.modifierType === "M" && !valid.has(effect.toAttribID)) continue;
      this.applyBrainEffect(ship, effect);
    }
    for (const effect of brain.charEffects) this.applyBrainEffect(pilot, effect);
  }

  /** SetAttributeValue: an attribute's base value. */
  setBaseValue(item: DogmaItem, attributeID: number, value: number): void {
    this.putBaseValue(item, attributeID, value);
    this.afterChange();
  }

  /**
   * Attribute.GetValue: the attribute's value as Update reckons it (its base, the modifiers reaching it); a charged
   * attribute's brought up to now (ChargedAttribute.GetValue: it is always dirty, so always updated).
   */
  value(item: DogmaItem, attributeID: number): number {
    const cacheKey = `${item.key}|${attributeID}`;
    const kept = this.cache.get(cacheKey);
    if (kept !== undefined) return kept;
    this.makeAttribute(item, attributeID);
    const charged = item.charged.get(attributeID);
    if (charged) {
      this.updateCharged(item, attributeID, charged, this.clock());
      return charged.current;
    }
    const record = this.record(attributeID);
    const base = item.attributes.get(attributeID) ?? this.typeValue(item, attributeID);
    if (this.reckoning.has(cacheKey)) return base;
    this.reckoning.add(cacheKey);
    try {
      const modifiers: IncomingModifier[] = [];
      for (const held of item.incoming.get(attributeID)?.values() ?? []) {
        const source = held.source;
        if (source.kind === "literal") {
          modifiers.push({ op: held.op, value: source.value, fromCategoryID: null, forceUnnurfed: source.forceUnnurfed });
          continue;
        }
        const from = this.items.get(source.itemKey);
        if (!from) continue;
        modifiers.push({ op: held.op, value: this.value(from, source.attributeID), fromCategoryID: from.categoryID });
      }
      const result = attributeValue(
        {
          attributeID,
          baseValue: base,
          stackable: record ? record.stackable : true,
          dataType: record ? record.dataType : null,
          cap: record && record.maxAttributeID ? this.value(item, record.maxAttributeID) : null,
          floor: record && record.minAttributeID ? this.value(item, record.minAttributeID) : null,
        },
        modifiers,
      );
      this.cache.set(cacheKey, result);
      return result;
    } finally {
      this.reckoning.delete(cacheKey);
    }
  }

  /** The values of the attributes an item has made: its type's, and those a modifier or a source made. */
  values(item: DogmaItem): Map<number, number> {
    const out = new Map<number, number>();
    for (const attributeID of [...item.attributes.keys()]) out.set(attributeID, this.value(item, attributeID));
    return out;
  }
}

/**
 * FittingDogmaLocation.LoadMyShip: the pilot loaded, then a ghost of the hull fitted to itself (the pilot its pilot:
 * GhostShipDogmaItem.GetPilot) and its passive effects started, though not yet those that modify a ship (it is no
 * pilot's ship yet: GetShip); the pilot seated in it (SetLocation, flagPilot: RegisterPilot, shipsByPilotID); then
 * MakeShipActive, which fits the ship to itself again (OnItemLoaded), starting the rest of its passive effects, and
 * applies the brain (ApplyBrainEffects); then the pilot's security status set on the ship.
 *
 * `loading`: the location's clock, and the pilot's and the ship's instance rows. A ghost's are nought (the Fitting
 * window's GetInstance of an item that has none); the client's own ship's are the server's (its ship's state).
 */
export function loadSimulatedShip(
  staticData: DogmaStatic,
  shipTypeID: number,
  pilot: { readonly characterID: number; readonly typeID: number; readonly securityStatus: number },
  brain: Brain | null,
  loading: SimulatedLoading = {},
): { readonly location: DogmaLocation; readonly ship: DogmaItem; readonly pilot: DogmaItem } {
  const location = new DogmaLocation(staticData, loading.clock);
  const pilotItem = location.loadItem(String(pilot.characterID), pilot.typeID, loading.pilotInstance ? { instance: loading.pilotInstance } : {});
  const ship = location.loadItem(`0_${shipTypeID}_ghost`, shipTypeID, loading.shipInstance ? { instance: loading.shipInstance } : {});
  ship.pilot = pilotItem;
  pilotItem.pilot = pilotItem;
  // LoadItem: ShipDogmaItem.OnItemLoaded, FitItemToLocation(ship, ship), then the passive effects.
  ship.fitted.set(ship.key, ship);
  location.startPassiveEffects(ship);
  // charDogmaItem.SetLocation(ship, flagPilot): RegisterPilot, and the ship the pilot's.
  ship.fitted.set(pilotItem.key, pilotItem);
  ship.ship = ship;
  pilotItem.ship = ship;
  // MakeShipActive: OnItemLoaded again, then ApplyBrainEffects.
  location.startPassiveEffects(ship);
  if (brain) location.applyBrainEffects(ship, pilotItem, brain);
  location.setBaseValue(ship, ATTRIBUTE_PILOT_SECURITY_STATUS, pilot.securityStatus);
  return { location, ship, pilot: pilotItem };
}

/** How a simulated ship is loaded: the location's clock (gametime.GetSimTime), and the instance rows it is loaded with. */
export interface SimulatedLoading {
  readonly clock?: () => number;
  readonly shipInstance?: ReadonlyMap<number, number>;
  readonly pilotInstance?: ReadonlyMap<number, number>;
}

/** A module to simulate: its key, type and slot, whether it is online, and its instance row where it has one. */
export interface SimulatedModule {
  readonly key: string;
  readonly typeID: number;
  readonly flagID: number;
  readonly online: boolean;
  readonly instance?: ReadonlyMap<number, number>;
}

/** A charge to simulate: the slot it is loaded in, and its type. */
export interface SimulatedCharge {
  readonly flagID: number;
  readonly typeID: number;
}

/**
 * _LoadSimulatedShipFromData, as far as modules and charges go: the hull (loadSimulatedShip), its modules fitted in
 * their slots (by flag, the highest first: fitData.sort), those online onlined, then the charges loaded (FitAmmoList).
 */
export function loadSimulatedFitting(
  staticData: DogmaStatic,
  shipTypeID: number,
  pilot: { readonly characterID: number; readonly typeID: number; readonly securityStatus: number },
  brain: Brain | null,
  modules: readonly SimulatedModule[],
  charges: readonly SimulatedCharge[],
  loading: SimulatedLoading = {},
): {
  readonly location: DogmaLocation;
  readonly ship: DogmaItem;
  readonly pilot: DogmaItem;
  readonly modules: ReadonlyMap<string, DogmaItem>;
  readonly charges: readonly DogmaItem[];
} {
  const loaded = loadSimulatedShip(staticData, shipTypeID, pilot, brain, loading);
  const fitted = new Map<string, DogmaItem>();
  const byFlag = [...modules].sort((left, right) => right.flagID - left.flagID);
  for (const module of byFlag) fitted.set(module.key, loaded.location.fitModule(loaded.ship, module.key, module.typeID, module.flagID, module.instance));
  for (const module of byFlag) {
    const item = fitted.get(module.key);
    if (module.online && item) loaded.location.onlineModule(item);
  }
  const loadedCharges = charges.map((charge) => loaded.location.loadCharge(loaded.ship, charge.flagID, charge.typeID));
  return { ...loaded, modules: fitted, charges: loadedCharges };
}
