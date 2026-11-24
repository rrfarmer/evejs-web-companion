// The module tooltip of the ship HUD's slots (eve/client/script/ui/inflight/shipModuleButton/moduleButtonTooltip.py,
// ModuleButtonTooltip, as hud/client/moduleTray/moduleSlot.py opens it through TooltipModuleWrapper): the module's type
// and icon with its slot's shortcut, its charge, its range, and what its group says of itself. UpdateToolTips builds the
// rows again every second while it is open; the panel is the caller's.

import { formatNumeric } from "../bridge/pyNumbers.ts";
import { fmtDist } from "../space/overview.ts";

/** One row: a 26 px type icon (the type and charge rows) or a 24 px attribute icon, its text (client markup), a shortcut. */
export interface ModuleTooltipRow {
  readonly icon: string | null;
  readonly iconSize: 24 | 26 | 34;
  /** AddTypeAndIcon's techIcon (uix.GetTechLevelIcon, 16 px at the type icon's top left): its picture and hint. */
  readonly tech?: { readonly src: string; readonly hint: string } | null;
  readonly text: string;
  readonly shortcut?: string | null;
  /** AddRowWithIconAndTextAndValue: a value at the row's right (the shortcut's place). */
  readonly value?: string | null;
  /** Fraction filled in a progress row, with its percentage in text. */
  readonly progress?: number;
  /** AddAttributeRow: a row of attribute values, each its icon and its text, under a header row. */
  readonly values?: readonly { readonly icon: string | null; readonly text: string }[];
  /** AddRowAndHeaderForManyAttributes' header: 24 px high, its text at the foot. */
  readonly header?: boolean;
}

/** What the tooltip reads of the module, its ship and its charge (the client's dogma location's values). */
export interface ModuleTooltipFacts {
  readonly typeID: number;
  readonly typeName: string;
  readonly groupID: number | null;
  /** The bank's size when the module is a bank's master (GetSlaveModules + 1), else 0. */
  readonly numInGroup: number;
  /** Its slot's activation shortcut (CmdActivate<Rack>PowerSlot<n>), null for a module with no default effect. */
  readonly shortcut: string | null;
  /** Its damage in percent (GetModuleGroupDamage), and whether a repair of it is under way. */
  readonly damagePercent: number;
  readonly repairing: boolean;
  readonly charge: { readonly typeID: number; readonly groupID: number | null; readonly quantity: number; readonly name: string } | null;
  /** The module's effective attribute (GetAccurateAttributeValue), null where it has none. */
  attr(attributeID: number): number | null;
  /** The ship's. */
  shipAttr(attributeID: number): number | null;
  /** The charge's. */
  chargeAttr(attributeID: number): number | null;
  /** The type has the launcherFitted (40) or turretFitted (42) effect; useMissiles (101). */
  readonly launcher: boolean;
  readonly turret: boolean;
  readonly usesMissiles?: boolean;
  /** The pilot's attribute (the ship-modified character's). */
  pilotAttr?(attributeID: number): number | null;
  /** Its default effect is running (godma's effect isActive). */
  readonly active: boolean;
  /**
   * The running cycle's time left as FormatTimeIntervalShort from the minute (_GetCountdownTime over
   * GetDurationTimeLeft), null when not running or its active ship is not the pilot's.
   */
  readonly countdownText?: string | null;
  readonly precursorSpool?: { readonly ratio: number; readonly countdown: string | null; readonly atMaximum: boolean } | null;
  /** An attribute's icon (dogma_data.get_attribute_icon_id) as a URL, and its display name. */
  attributeIcon(attributeID: number): string | null;
  attributeName(attributeID: number): string | null;
  typeIcon(typeID: number): string | null;
  /** The type's tech level badge (its meta group's icon) and hint, where it has one. */
  typeTech?(typeID: number): { readonly src: string; readonly hint: string } | null;
}

/** localization.GetByLabel: the label's text with its tags filled, null where the label is not to be had yet. */
export type TooltipWord = (label: string, args: Readonly<Record<string, unknown>>) => string | null;

// const.py
const ATTR = {
  mass: 4, capacitorBonus: 67, shieldBonus: 68, duration: 73, miningAmount: 77, structureDamageAmount: 83,
  armorDamageAmount: 84, powerTransferAmount: 90, energyNeutralizerAmount: 97, maxVelocity: 37, speedFactor: 20,
  maxRange: 54, falloff: 158, trackingSpeed: 160, speedBoostFactor: 567, massAddition: 796,
  chargedArmorDamageMultiplier: 1886, warpScrambleStrength: 105, dotDuration: 5735, dotMaxDamagePerTick: 5736,
  flightTime: 281, falloffEffectiveness: 2044, maxFofTargetRange: 2700,
} as const;
export const DOT_DURATION_ATTRIBUTE = ATTR.dotDuration;
const GROUP_SMART_BOMB = 72;
/** cfg.__chargecompatiblegroups__ (build 3698585). */
export const CHARGE_COMPATIBLE_GROUPS: ReadonlySet<number> = new Set([53, 55, 56, 74, 76, 208, 209, 212, 213, 290, 291, 317, 481,
  483, 501, 506, 507, 508, 509, 510, 511, 512, 524, 589, 646, 771, 862, 899, 1156, 1199, 1226, 1245, 1327, 1328, 1330, 1332,
  1396, 1442, 1549, 1562, 1673, 1674, 1697, 1698, 1699, 1700, 1770, 1974, 1986, 2013, 4060, 4807]);
/** cfg.GetCrystalGroups() (build 3698585): a crystal's count is not shown. */
export const CRYSTAL_GROUPS: ReadonlySet<number> = new Set([86, 374, 375, 482, 663, 907, 908, 909, 910, 911, 1153, 1400, 1550, 1551,
  1559, 1569, 1701, 1702]);

type InfoRow = (f: ModuleTooltipFacts, word: TooltipWord, out: ModuleTooltipRow[], seconds: (ms: number) => string) => void;

const perTime = (attributeID: number, label: string, multiplier: (f: ModuleTooltipFacts) => number = () => 1): InfoRow =>
  (f, word, out, seconds) => {
    const amount = (f.attr(attributeID) ?? 0) * multiplier(f);
    const text = word(label, { duration: seconds(f.attr(ATTR.duration) ?? 0), amount });
    if (text !== null) out.push({ icon: f.attributeIcon(attributeID), iconSize: 24, text });
  };

const miningLaser: InfoRow = (f, word, out, seconds) => {
  const durationMs = f.attr(ATTR.duration) ?? 0;
  const amount = f.attr(ATTR.miningAmount) ?? 0;
  const text = word("UI/Inflight/ModuleRacks/Tooltips/MiningAmountPerTime2", {
    duration: seconds(durationMs), amount, amountPerSec: durationMs > 0 ? amount / (durationMs / 1000) : 0,
  });
  if (text !== null) out.push({ icon: "/client-res/ui/texture/icons/23_64_5.png", iconSize: 24, text });
};

// _GetVelocityRatio
const velocityRatio = (boost: number, factor: number, mass: number): number => 1 + boost * factor * 0.01 / mass;

const propulsion: InfoRow = (f, word, out) => {
  const speedFactor = f.attr(ATTR.speedFactor) ?? 0;
  const boost = f.attr(ATTR.speedBoostFactor) ?? 0;
  const mass = f.shipAttr(ATTR.mass) ?? 0;
  const velocity = f.shipAttr(ATTR.maxVelocity) ?? 0;
  if (!(mass > 0)) return;
  let without: number;
  let withBonus: number;
  if (f.active) {
    withBonus = velocity;
    without = withBonus / velocityRatio(boost, speedFactor, mass);
  } else {
    // _GetMyMaxVelocityAndMassOnActivation: the mass on activation is the ship's and the module's mass addition.
    without = velocity;
    withBonus = without * velocityRatio(boost, speedFactor, mass + (f.attr(ATTR.massAddition) ?? 0));
  }
  const text = word("UI/Inflight/ModuleRacks/Tooltips/MaxVelocityWithAndWithoutPropulsion", { maxVelocity: without, maxVelocityWithBonus: withBonus });
  if (text !== null) out.push({ icon: f.attributeIcon(ATTR.maxVelocity), iconSize: 24, text });
};

const capacitorBooster: InfoRow = (f, word, out, seconds) => {
  if (!f.charge) return;
  const text = word("UI/Inflight/ModuleRacks/Tooltips/CapacitorBoostPerTime", { boostAmount: f.chargeAttr(ATTR.capacitorBonus) ?? 0, duration: seconds(f.attr(ATTR.duration) ?? 0) });
  if (text !== null) out.push({ icon: f.attributeIcon(ATTR.capacitorBonus), iconSize: 24, text });
};

const attributeInfo = (attributeID: number, label: string, keyword: string, value: (v: number) => number = (v) => v): InfoRow => (f, word, out) => {
  const text = word(label, { [keyword]: value(f.attr(attributeID) ?? 0) });
  if (text !== null) out.push({ icon: f.attributeIcon(attributeID), iconSize: 24, text });
};

// AddCompressorInfo (groupCompressors 4174): the SkillPlan info icon at 34 and CompressorModuleInfo with the module's
// maxRange as FmtDist ("Ships in your fleet have to be within 5,000 m to use compression.")
const compressor: InfoRow = (f, word, out) => {
  const text = word("UI/Inflight/ModuleRacks/Tooltips/CompressorModuleInfo", { range: fmtDist(f.attr(ATTR.maxRange) ?? 0) });
  if (text !== null) out.push({ icon: "/client-res/ui/texture/classes/skillplan/infoicon.png", iconSize: 34, text });
};

// AddTractorBeamInfo (groupTractorBeam 650): TractorBeamTractorVelocity with maxTractorVelocity (1045), its attribute's icon
// and display name ("1250 m/s Max Tractor Velocity")
const tractorBeam: InfoRow = (f, word, out) => {
  const text = word("UI/Inflight/ModuleRacks/Tooltips/TractorBeamTractorVelocity", { maxTractorVel: f.attr(1045) ?? 0, attributeName: f.attributeName(1045) ?? "" });
  if (text !== null) out.push({ icon: f.attributeIcon(1045), iconSize: 24, text });
};
// AddGangCoordinatorInfo (groupGangCoordinator 316, the command bursts): GangCoordinatorCommandBonus for a commandBonus
// (833) not 0, and GangCoordinatorMaxCommandRelays where the module has maxGangModules (435); no icon
const gangCoordinator: InfoRow = (f, word, out) => {
  const bonus = f.attr(833) ?? 0;
  if (bonus !== 0) {
    const text = word("UI/Inflight/ModuleRacks/Tooltips/GangCoordinatorCommandBonus", { commandBonus: bonus, attributeName: f.attributeName(833) ?? "" });
    if (text !== null) out.push({ icon: null, iconSize: 24, text });
  }
  const relays = f.attr(435);
  if (relays !== null) {
    const text = word("UI/Inflight/ModuleRacks/Tooltips/GangCoordinatorMaxCommandRelays", { maxGangModules: relays, attributeName: f.attributeName(435) ?? "" });
    if (text !== null) out.push({ icon: null, iconSize: 24, text });
  }
};

// AddSiegeInfo (groupSiegeModule 515, the industrial cores too): AddDurationCountdownTimes - the duration attribute's display
// name with the running cycle's time left at its right, no icon; nothing when not running
const siege: InfoRow = (f, _word, out) => {
  if (!(f.attr(ATTR.duration) ?? 0) || !f.countdownText) return;
  out.push({ icon: null, iconSize: 24, text: f.attributeName(ATTR.duration) ?? "", value: f.countdownText });
};

// AddScanProbeLauncherInfo (groupScanProbeLauncher 481): with probes loaded, AddAttributeInfoWithAttributeName on the charge's
// baseSensorStrength (1371) - ScanProbeSensorStrength "Base Sensor Strength: 40 points", the attribute's icon
const scanProbeLauncher: InfoRow = (f, word, out) => {
  if (!f.charge) return;
  const text = word("UI/Inflight/ModuleRacks/Tooltips/ScanProbeSensorStrength", { activeValue: f.chargeAttr(1371) ?? 0, activeName: f.attributeName(1371) ?? "" });
  if (text !== null) out.push({ icon: f.attributeIcon(1371), iconSize: 24, text });
};

// AddDotWeaponInfo: the loaded pod's maximum damage per tick and its effect duration.
const breacherPod: InfoRow = (f, word, out, seconds) => {
  if (!f.charge) return;
  const damage = f.chargeAttr(ATTR.dotMaxDamagePerTick);
  if (damage !== null) {
    const text = word("UI/Inflight/ModuleRacks/DamagePerSecond", { dps: damage * (f.attr(ATTR_DAMAGE_MULTIPLIER) ?? 1) });
    if (text !== null) out.push({ icon: "/client-res/ui/texture/icons/modules/breacher_launcher_s_64.png", iconSize: 24, text });
  }
  const duration = f.chargeAttr(ATTR.dotDuration);
  const attributeName = f.attributeName(ATTR.dotDuration);
  if (duration !== null && attributeName !== null) {
    const text = word("UI/Inflight/ModuleRacks/Tooltips/DotEffectDuration", { attributeName, duration: seconds(duration) });
    if (text !== null) out.push({ icon: f.attributeIcon(ATTR.dotDuration), iconSize: 24, text });
  }
};

const precursorTurret: InfoRow = ({ active, precursorSpool }, word, out) => {
  if (!active || !precursorSpool) return;
  const { ratio, countdown, atMaximum } = precursorSpool;
  const status = atMaximum ? word("UI/Inflight/ModuleRacks/Tooltips/MaxDamage", {})
    : countdown !== null ? word("UI/Inflight/ModuleRacks/Tooltips/TimeUntilMaxDamage", { time: countdown }) : null;
  if (status !== null) out.push({ icon: null, iconSize: 24, text: status });
  const percentage = Math.round(100 * ratio);
  const integer = { type: "long", value: String(percentage) };
  out.push({ icon: null, iconSize: 24, text: word("UI/Common/Percentage", { percentage: integer }) ?? `${percentage}%`, progress: ratio });
};

// AddAttributeInfoWithAttributeName with ValuePercentageWithAttributeName ("-30% Signature Radius"): the attribute's icon,
// skipped at 0 where the client skips it
const VALUE_PERCENT = "UI/Inflight/ModuleRacks/Tooltips/ValuePercentageWithAttributeName";
// GetEffectiveAttributeValue: an attribute in unitInverseAbsolutePercent (108) or unitInversedModifierPercent (111) as
// (1 - v) * 100, in unitModifierPercent (109) as -(1 - v) * 100 (dogma_data.get_attribute_unit_id, read through gridcheck)
const INVERSE_PERCENT = new Set([267, 268, 269, 270, 271, 272, 273, 274, 974, 975, 976, 977, 3113]);
const MODIFIER_PERCENT = new Set([306]);
const effective = (f: ModuleTooltipFacts, attributeID: number): number | null => {
  const v = f.attr(attributeID);
  if (v === null) return null;
  return INVERSE_PERCENT.has(attributeID) ? (1 - v) * 100 : MODIFIER_PERCENT.has(attributeID) ? -(1 - v) * 100 : v;
};
const withName = (attributeID: number, skipZero = false): InfoRow => (f, word, out) => {
  const value = effective(f, attributeID) ?? 0;
  if (skipZero && value === 0) return;
  const text = word(VALUE_PERCENT, { activeValue: value, activeName: f.attributeName(attributeID) ?? "" });
  if (text !== null) out.push({ icon: f.attributeIcon(attributeID), iconSize: 24, text });
};
const rowsOf = (...rows: InfoRow[]): InfoRow => (f, word, out, seconds) => { for (const r of rows) r(f, word, out, seconds); };
// AddECCMInfo: each sensor strength percent (1027 to 1030) not 0 on a line of its own, under the 4_64_12 icon
const eccm: InfoRow = (f, word, out) => {
  const lines = [1027, 1028, 1029, 1030].flatMap((id) => {
    const v = f.attr(id);
    return v === null || v === 0 ? [] : [word(VALUE_PERCENT, { activeValue: v, activeName: f.attributeName(id) ?? "" }) ?? ""];
  });
  if (lines.length) out.push({ icon: "/client-res/ui/texture/icons/4_64_12.png", iconSize: 24, text: lines.join("<br>") });
};
// AddECMInfo: each jammer strength bonus (238 to 241) not 0 by ECMStrengthBonus, the 4_64_12 icon
const ecm: InfoRow = (f, word, out) => {
  const lines = [238, 239, 240, 241].flatMap((id) => {
    const v = f.attr(id);
    return v === null || v === 0 ? [] : [word("UI/Inflight/ModuleRacks/Tooltips/ECMStrengthBonus", { strength: v, attributeName: f.attributeName(id) ?? "" }) ?? ""];
  });
  out.push({ icon: "/client-res/ui/texture/icons/4_64_12.png", iconSize: 24, text: lines.join("<br>") });
};
// AddSensorDamperInfo (dampers, remote and local sensor boosters): scan resolution and targeting range bonuses not 0, then ECCM's
const sensorDamper: InfoRow = rowsOf(withName(566, true), withName(309, true), eccm);
// AddTrackingDisruptorInfo: falloff, optimal, tracking, missile velocity, flight time, explosion velocity and radius, each not 0
const trackingDisruptor: InfoRow = rowsOf(...[349, 351, 767, 547, 596, 847, 848].map((id) => withName(id, true)));

// AddRowAndHeaderForManyAttributes: the header (24 high, its label at the foot), then the values' row - each attribute's icon
// and ResistanceActiveBonusValues ("-25.0%"), the row's own icon (texturePath) at its left
const RES_TIPS = "UI/Inflight/ModuleRacks/Tooltips/";
const headerAndValues = (f: ModuleTooltipFacts, word: TooltipWord, out: ModuleTooltipRow[], values: readonly (readonly [number, number])[], headerLabel: string, icon: string | null): void => {
  const header = word(RES_TIPS + headerLabel, {});
  out.push({ icon: null, iconSize: 24, text: header ?? "", header: true });
  out.push({ icon, iconSize: 24, text: "", values: values.map(([id, v]) => ({ icon: f.attributeIcon(id), text: word(RES_TIPS + "ResistanceActiveBonusValues", { activeValue: v }) ?? "" })) });
};
const valuesOf = (f: ModuleTooltipFacts, ids: readonly number[], includeZeros: boolean): (readonly [number, number])[] =>
  ids.flatMap((id) => { const v = effective(f, id) ?? 0; return !v && !includeZeros ? [] : [[id, v] as const]; });
// AddArmorHardenerInfo (hardeners, coatings, shield hardeners and amplifiers, energized platings): the resistance bonuses
// (EM 984, thermal 987, kinetic 986, explosive 985) not 0 - one by ResistanceActiveBonusText with its icon, several under
// ResistanceActiveBonusesHeader
const hardener: InfoRow = (f, word, out) => {
  const values = valuesOf(f, [984, 987, 986, 985], false);
  if (values.length === 1) {
    const [id, v] = values[0]!;
    const text = word(RES_TIPS + "ResistanceActiveBonusText", { activeName: f.attributeName(id) ?? "", activeValue: v });
    if (text !== null) out.push({ icon: f.attributeIcon(id), iconSize: 24, text });
  } else if (values.length) headerAndValues(f, word, out, values, "ResistanceActiveBonusesHeader", null);
};
// AddDamageControlInfo: shield (1_64_13), armor (1_64_9) and hull (2_64_12) resonances, zeros too, each under its header
const damageControl: InfoRow = (f, word, out) => {
  for (const [ids, icon, header] of [
    [[271, 274, 273, 272], "/client-res/ui/texture/icons/1_64_13.png", "ShieldDamageResistanceHeader"],
    [[267, 270, 269, 268], "/client-res/ui/texture/icons/1_64_9.png", "ArmorDamageResistanceHeader"],
    [[974, 977, 976, 975], "/client-res/ui/texture/icons/2_64_12.png", "HullDamageResistanceHeader"],
  ] as const) headerAndValues(f, word, out, valuesOf(f, ids, true), header, icon);
};
// AddArmorResistanceShiftHardenerInfo: the armor resonances under ArmorDamageResistanceHeader, no row icon
const reactiveHardener: InfoRow = (f, word, out) => headerAndValues(f, word, out, valuesOf(f, [267, 270, 269, 268], true), "ArmorDamageResistanceHeader", null);

/** infoFunctionNames: a group's own rows. */
const INFO_BY_GROUP = new Map<number, InfoRow>();
for (const g of [54, 464, 483, 737, 4138]) INFO_BY_GROUP.set(g, miningLaser);
INFO_BY_GROUP.set(4174, compressor);
INFO_BY_GROUP.set(515, siege);
INFO_BY_GROUP.set(481, scanProbeLauncher);
INFO_BY_GROUP.set(4807, breacherPod);
INFO_BY_GROUP.set(1986, precursorTurret);
INFO_BY_GROUP.set(379, withName(554)); // AddTargetPainterInfo: signatureRadiusBonus
INFO_BY_GROUP.set(1154, withName(3113)); // AddTargetBreakerInfo
INFO_BY_GROUP.set(330, withName(306)); // AddCloakingDeviceInfo: maxVelocityModifier
INFO_BY_GROUP.set(291, trackingDisruptor);
for (const g of [208, 290, 212]) INFO_BY_GROUP.set(g, sensorDamper);
for (const g of [202, 289]) INFO_BY_GROUP.set(g, eccm);
for (const g of [80, 201]) INFO_BY_GROUP.set(g, ecm);
for (const g of [328, 98, 77, 295, 326]) INFO_BY_GROUP.set(g, hardener);
INFO_BY_GROUP.set(60, damageControl);
INFO_BY_GROUP.set(1150, reactiveHardener);
INFO_BY_GROUP.set(650, tractorBeam);
INFO_BY_GROUP.set(316, gangCoordinator);
for (const g of [62, 1199, 1698, 2018]) {
  INFO_BY_GROUP.set(g, perTime(ATTR.armorDamageAmount, "UI/Inflight/ModuleRacks/Tooltips/ArmorRepairedPerTime",
    (f) => (f.charge ? f.attr(ATTR.chargedArmorDamageMultiplier) ?? 1 : 1)));
}
INFO_BY_GROUP.set(63, perTime(ATTR.structureDamageAmount, "UI/Inflight/ModuleRacks/Tooltips/HullRepairedPerTime"));
for (const g of [40, 1156]) INFO_BY_GROUP.set(g, perTime(ATTR.shieldBonus, "UI/Inflight/ModuleRacks/Tooltips/ShieldBonusPerTime"));
INFO_BY_GROUP.set(68, perTime(ATTR.powerTransferAmount, "UI/Inflight/ModuleRacks/Tooltips/EnergyVampireAmountPerTime"));
for (const g of [71, 1329]) INFO_BY_GROUP.set(g, perTime(ATTR.energyNeutralizerAmount, "UI/Inflight/ModuleRacks/Tooltips/EnergDestabilizedPerTime"));
INFO_BY_GROUP.set(67, perTime(ATTR.powerTransferAmount, "UI/Inflight/ModuleRacks/Tooltips/EnergyTransferredPerTime"));
INFO_BY_GROUP.set(41, perTime(ATTR.shieldBonus, "UI/Inflight/ModuleRacks/Tooltips/ShieldTransportedPerTime"));
INFO_BY_GROUP.set(325, perTime(ATTR.armorDamageAmount, "UI/Inflight/ModuleRacks/Tooltips/ArmorTransferredPerTime"));
INFO_BY_GROUP.set(46, propulsion);
INFO_BY_GROUP.set(76, capacitorBooster);
// AddStasisWebInfo: the speed factor's size, a percentage.
for (const g of [65, 1441]) INFO_BY_GROUP.set(g, attributeInfo(ATTR.speedFactor, "UI/Inflight/ModuleRacks/Tooltips/VelocityReductionFromWeb", "percentage", Math.abs));
for (const g of [52, 1442]) INFO_BY_GROUP.set(g, attributeInfo(ATTR.warpScrambleStrength, "UI/Inflight/ModuleRacks/Tooltips/WarpScramblerStrength", "strength"));
// AddTrackingComputerInfo (groupTrackingComputer 213, groupTrackingLink 209; g404): falloffBonus 349, maxRangeBonus 351,
// trackingSpeedBonus 767, each an AddAttributeInfo row
for (const g of [213, 209]) INFO_BY_GROUP.set(g, rowsOf(
  attributeInfo(349, "UI/Inflight/ModuleRacks/Tooltips/TrackingComputerFalloffBonus", "falloffBonus"),
  attributeInfo(351, "UI/Inflight/ModuleRacks/Tooltips/TrackingComputerRangeBonus", "optimalRangeBonus"),
  attributeInfo(767, "UI/Inflight/ModuleRacks/Tooltips/TrackingComputerTrackingBonus", "trackingSpeedBonus")));
// AddRemoteHullRepairInfo (groupRemoteHullRepairer 585): structureDamageAmount per cycle
INFO_BY_GROUP.set(585, perTime(ATTR.structureDamageAmount, "UI/Inflight/ModuleRacks/Tooltips/HullRemoteRepairedPerTime"));

/** dogma.attributes.groups.damage_type_attribute_ids: EM, thermal, kinetic, explosive. */
const DAMAGE_TYPES = [114, 118, 117, 116] as const;
const ATTR_RATE_OF_FIRE = 51;
const ATTR_DAMAGE_MULTIPLIER = 64;
const ATTR_MISSILE_DAMAGE_MULTIPLIER = 212;
const GROUP_MISSILE_LAUNCHER_BOMB = 862;

/**
 * AddDpsAndDamgeTypeInfo (GetDpsDamageTypeInfo, fittingDogmaLocationUtil): a launcher's (or a bomb launcher's) with a
 * charge, its charge's damage times the pilot's missile damage multiplier over its rate of fire; a turret's, its
 * charge's damage (its own without one) times its damage multiplier over its rate of fire; a bank's times its size.
 * Then AddDamageTypes: the damage-causing item's damages times the multiplier, one by its name, several under a header.
 */
function dpsRows(f: ModuleTooltipFacts, word: TooltipWord, out: ModuleTooltipRow[]): void {
  const bomb = f.groupID === GROUP_MISSILE_LAUNCHER_BOMB;
  const launcher = f.launcher || !!f.usesMissiles;
  if (!launcher && !f.turret && !bomb) return;
  const damageOf = (read: (id: number) => number | null) => DAMAGE_TYPES.reduce((sum, id) => sum + (read(id) ?? 0), 0);
  let dps = 0;
  let multiplier = 1;
  let icon: string | null = null;
  const rof = f.attr(ATTR_RATE_OF_FIRE) ?? 0;
  if ((launcher || bomb) && f.charge) {
    multiplier = bomb ? 1 : f.pilotAttr?.(ATTR_MISSILE_DAMAGE_MULTIPLIER) ?? 1;
    dps = rof ? damageOf(f.chargeAttr) * multiplier / rof * 1000 : 0;
    icon = launcher ? "/client-res/ui/texture/icons/81_64_16.png" : f.typeIcon(f.typeID);
  } else if (f.turret) {
    multiplier = f.attr(ATTR_DAMAGE_MULTIPLIER) ?? 1;
    const damage = f.charge ? damageOf(f.chargeAttr) : damageOf(f.attr);
    dps = damage > 0 && rof ? damage * multiplier / rof * 1000 : 0;
    icon = "/client-res/ui/texture/icons/26_64_1.png";
  } else {
    return;
  }
  if (dps !== 0 && f.numInGroup) {
    dps *= f.numInGroup;
    multiplier *= f.numInGroup;
  }
  const text = word("UI/Inflight/ModuleRacks/DamagePerSecond", { dps });
  if (text !== null) out.push({ icon, iconSize: 24, text });
  damageTypeRows(f, word, out, multiplier);
}

/** AddDamageTypes: the damage-causing item's (the charge's, else the module's) damages times the multiplier, one by its name, several
 *  under a header. */
function damageTypeRows(f: ModuleTooltipFacts, word: TooltipWord, out: ModuleTooltipRow[], multiplier: number): void {
  const read = f.charge ? f.chargeAttr : f.attr;
  const values = DAMAGE_TYPES.map((id) => [id, (read(id) ?? 0) * multiplier] as const).filter(([, v]) => v);
  if (values.length === 1) {
    const [id, v] = values[0]!;
    const one = word("UI/Inflight/ModuleRacks/Tooltips/OneDamageTypeText", { activeName: f.attributeName(id) ?? "", activeValue: v });
    if (one !== null) out.push({ icon: f.attributeIcon(id), iconSize: 24, text: one });
  } else if (values.length > 1) {
    const header = word("UI/Inflight/ModuleRacks/Tooltips/DamageTypesHeader", {});
    if (header !== null) out.push({ icon: null, iconSize: 24, text: header, header: true });
    out.push({ icon: null, iconSize: 24, text: "", values: values.map(([id, v]) => ({ icon: f.attributeIcon(id), text: word("UI/Inflight/ModuleRacks/Tooltips/DamageHitpoints", { activeValue: v }) ?? "" })) });
  }
}

// AddCynoInfo (groupCynosuralField 658): AddDurationCountdownTimes, as siege (g405)
INFO_BY_GROUP.set(658, siege);
// AddSuperWeaponInfo (groupSuperWeapon 588, groupStructureDoomsdayWeapon 1333): each damage type not 0 as
// AddAttributeInfoWithAttributeName SuperWeaponDamage ("1,235 HP - EM damage"), then the countdown
const superWeapon: InfoRow = (f, word, out, seconds) => {
  for (const id of DAMAGE_TYPES) {
    const v = f.attr(id) ?? 0;
    if (!v) continue;
    const text = word("UI/Inflight/ModuleRacks/Tooltips/SuperWeaponDamage", { activeValue: v, activeName: f.attributeName(id) ?? "" });
    if (text !== null) out.push({ icon: f.attributeIcon(id), iconSize: 24, text });
  }
  siege(f, word, out, seconds);
};
for (const g of [588, 1333]) INFO_BY_GROUP.set(g, superWeapon);
// AddStructureDefenseBatteryInfo (groupStructureDefenseBattery 1330): AddDamageTypes at multiplier 1
INFO_BY_GROUP.set(1330, (f, word, out) => damageTypeRows(f, word, out, 1));

/** FormatSeconds (localization/formatters/timeIntervalFormatters.py): one place where the seconds have a fraction. */
export function formatSeconds(seconds: number, word: TooltipWord): string {
  const value = formatNumeric(seconds, { decimalPlaces: seconds % 1 ? 1 : 0 });
  return word("/Carbon/UI/Common/WrittenDateTimeQuantityShort/Second", { value }) ?? `${value}s`;
}

const EFFECTIVENESS_FALLOFF_GROUPS = new Set([71, 68, 67, 325, 41, 585, 208, 201, 290, 209, 1672, 379, 291, 1697]);

/** tactical.FindMaxRange: the range and falloff shared by the tooltip and tactical overlay. */
export function moduleRangeParts(f: Pick<ModuleTooltipFacts, "groupID" | "attr" | "charge" | "chargeAttr">): readonly [number, number] {
  const optimal = f.attr(ATTR.maxRange) ?? 0;
  if (optimal > 0) {
    const falloffAttribute = EFFECTIVENESS_FALLOFF_GROUPS.has(f.groupID ?? 0) ? ATTR.falloffEffectiveness : ATTR.falloff;
    return [optimal, f.attr(falloffAttribute) ?? 0];
  }
  // Scanner probes and survey probes use their own range controls.
  if (!f.charge?.quantity || f.charge.groupID === 479 || f.charge.groupID === 492) return [0, 0];
  const flightTime = f.chargeAttr(ATTR.flightTime) ?? 0;
  const speed = f.chargeAttr(ATTR.maxVelocity) ?? 0;
  if (flightTime <= 0 || speed <= 0) return [0, 0];
  const flightRange = flightTime * speed / 1000;
  const fofRange = f.chargeAttr(ATTR.maxFofTargetRange);
  return [fofRange === null ? flightRange : Math.min(flightRange, fofRange), 0];
}

/** GetOptimalRangeText: a launcher's flight range, a turret's optimal, or another module's range. */
function rangeText(f: ModuleTooltipFacts, word: TooltipWord, fmtDist: (m: number) => string): string | null {
  const [optimal, falloff] = moduleRangeParts(f);
  if (!(optimal > 0)) return null;
  const optimalRange = fmtDist(optimal);
  if (f.launcher) return word("UI/Inflight/ModuleRacks/MaxRange", { maxRange: optimalRange });
  if (f.turret) {
    return falloff > 1
      ? word("UI/Inflight/ModuleRacks/OptimalRangeAndFalloff", { optimalRange, falloffPlusOptimal: fmtDist(falloff + optimal) })
      : word("UI/Inflight/ModuleRacks/OptimalRange", { optimalRange });
  }
  if (f.groupID === GROUP_SMART_BOMB) return word("UI/Inflight/ModuleRacks/AreaOfEffect", { range: optimalRange });
  return falloff > 1
    ? word("UI/Inflight/ModuleRacks/RangeWithFalloff", { optimalRange, falloffPlusOptimal: fmtDist(falloff + optimal) })
    : word("UI/Inflight/ModuleRacks/Range", { optimalRange });
}

/** UpdateToolTips: the panel's rows, top to bottom. */
export function moduleTooltipRows(f: ModuleTooltipFacts, word: TooltipWord, fmtDist: (m: number) => string): ModuleTooltipRow[] {
  const out: ModuleTooltipRow[] = [];
  const seconds = (ms: number) => formatSeconds(ms / 1000, word);
  // GetTypeText and AddTypeAndIcon: the name in bold (with the bank's size), its damage under it.
  let label = `<b>${f.numInGroup ? word("UI/Inflight/ModuleRacks/TypeNameWithNumInGroup", { numInGroup: f.numInGroup, typeName: f.typeName }) ?? f.typeName : f.typeName}</b>`;
  if (f.damagePercent > 0) {
    const damaged = word("UI/Inflight/ModuleRacks/ModuleDamaged", { color: "<color=red>", percentageNum: f.damagePercent });
    const repairing = f.repairing ? word("UI/Inflight/ModuleRacks/Tooltips/ModuleRepairing", {}) ?? "" : "";
    if (damaged !== null) label += `<br>${damaged}${repairing}`;
  }
  out.push({ icon: f.typeIcon(f.typeID), iconSize: 26, tech: f.typeTech?.(f.typeID) ?? null, text: label, shortcut: f.shortcut });
  // UpdateChargesCont: a loaded charge, a crystal by its name alone.
  const compatible = f.groupID !== null && CHARGE_COMPATIBLE_GROUPS.has(f.groupID);
  if (compatible && f.charge && f.charge.quantity) {
    const crystal = f.charge.groupID !== null && CRYSTAL_GROUPS.has(f.charge.groupID);
    const text = crystal ? `<b>${f.charge.name}</b>` : word("UI/Inflight/ModuleRacks/AmmoNameWithQty", { qty: f.charge.quantity, ammoTypeID: f.charge.typeID });
    if (text !== null) out.push({ icon: f.typeIcon(f.charge.typeID), iconSize: 26, tech: f.typeTech?.(f.charge.typeID) ?? null, text });
  }
  const range = rangeText(f, word, fmtDist);
  if (range !== null) out.push({ icon: "/client-res/ui/texture/icons/22_32_15.png", iconSize: 24, text: range });
  // ShouldAddDps: a module that takes charges (GetChargeTypeAndQty answers a quantity, nought where none is loaded)
  if (compatible) dpsRows(f, word, out);
  if (f.groupID !== null) INFO_BY_GROUP.get(f.groupID)?.(f, word, out, seconds);
  // AddTrackingSpeed: a turret's tracking, by the attribute's name.
  const tracking = f.attr(ATTR.trackingSpeed) ?? 0;
  if (tracking !== 0) {
    const text = word("UI/Inflight/ModuleRacks/Tooltips/WeaponAccuracyScore", { activeName: f.attributeName(ATTR.trackingSpeed) ?? "", activeValue: tracking });
    if (text !== null) out.push({ icon: f.attributeIcon(ATTR.trackingSpeed), iconSize: 24, text });
  }
  return out;
}

/** What DroneTooltip reads of a drone (the client's dogma location's values for it, the pilot's skills applied). */
export interface DroneTooltipFacts {
  readonly groupID: number | null;
  /** The drone's effective attribute, null where the location has not reckoned it. */
  attr(attributeID: number): number | null;
  /** Its default effect's rangeAttributeID (tactical.FindMaxRange), null where it has none. */
  readonly rangeAttributeID: number | null;
  /** GetOptimalDroneDamage2 for the one drone, null where not reckoned. */
  readonly dps: number | null;
  attributeIcon(attributeID: number): string | null;
  attributeName(attributeID: number): string | null;
}

/**
 * DroneTooltip.UpdateToolTips past the type row, as ModuleButtonTooltip runs it for a drone: the range
 * (FindMaxRange: the default effect's range attribute and the falloff; a drone is no launcher or turret, so Range or
 * RangeWithFalloff), the damage a second (ShouldAddDps is always true: GetOptimalDroneDamage2, drones.png) and its
 * damage types (multiplier 1), the group's own rows (AddMiningDroneInfo for groupMiningDrone 101), the tracking
 * (skipped at 0). The bandwidth row (AddDroneBandwidthUsed) is the window's.
 */
export function droneTooltipRows(f: DroneTooltipFacts, word: TooltipWord, fmtDist: (m: number) => string): ModuleTooltipRow[] {
  const out: ModuleTooltipRow[] = [];
  const optimal = f.rangeAttributeID !== null ? f.attr(f.rangeAttributeID) ?? 0 : 0;
  const falloff = f.rangeAttributeID !== null ? f.attr(ATTR.falloff) ?? 0 : 0;
  if (optimal > 0) {
    const optimalRange = fmtDist(optimal);
    const range = falloff > 1
      ? word("UI/Inflight/ModuleRacks/RangeWithFalloff", { optimalRange, falloffPlusOptimal: fmtDist(falloff + optimal) })
      : word("UI/Inflight/ModuleRacks/Range", { optimalRange });
    if (range !== null) out.push({ icon: "/client-res/ui/texture/icons/22_32_15.png", iconSize: 24, text: range });
  }
  if (f.dps !== null) {
    // GetOptimalDroneDamage's total stays the int 0 where no drone adds to it (a mining drone): "0", not "0.0"
    const text = word("UI/Inflight/ModuleRacks/DamagePerSecond", { dps: f.dps === 0 ? { type: "long", value: "0" } : f.dps });
    if (text !== null) out.push({ icon: "/client-res/ui/texture/icons/drones.png", iconSize: 24, text });
    const values = DAMAGE_TYPES.map((id) => [id, f.attr(id) ?? 0] as const).filter(([, v]) => v);
    if (values.length === 1) {
      const [id, v] = values[0]!;
      const one = word("UI/Inflight/ModuleRacks/Tooltips/OneDamageTypeText", { activeName: f.attributeName(id) ?? "", activeValue: v });
      if (one !== null) out.push({ icon: f.attributeIcon(id), iconSize: 24, text: one });
    } else if (values.length > 1) {
      const header = word("UI/Inflight/ModuleRacks/Tooltips/DamageTypesHeader", {});
      if (header !== null) out.push({ icon: null, iconSize: 24, text: header, header: true });
      out.push({ icon: null, iconSize: 24, text: "", values: values.map(([id, v]) => ({ icon: f.attributeIcon(id), text: word("UI/Inflight/ModuleRacks/Tooltips/DamageHitpoints", { activeValue: v }) ?? "" })) });
    }
  }
  if (f.groupID === 101) {
    const durationMs = f.attr(ATTR.duration) ?? 0;
    const amount = f.attr(ATTR.miningAmount) ?? 0;
    if (durationMs > 0) {
      const text = word("UI/Inflight/ModuleRacks/Tooltips/MiningAmountPerTime2", { duration: formatSeconds(durationMs / 1000, word), amount, amountPerSec: amount / (durationMs / 1000) });
      if (text !== null) out.push({ icon: "/client-res/ui/texture/icons/23_64_5.png", iconSize: 24, text });
    }
  }
  const tracking = f.attr(ATTR.trackingSpeed) ?? 0;
  if (tracking !== 0) {
    const text = word("UI/Inflight/ModuleRacks/Tooltips/WeaponAccuracyScore", { activeName: f.attributeName(ATTR.trackingSpeed) ?? "", activeValue: tracking });
    if (text !== null) out.push({ icon: f.attributeIcon(ATTR.trackingSpeed), iconSize: 24, text });
  }
  return out;
}

/** The attributes droneTooltipRows names or draws the icons of. */
export const DRONE_TOOLTIP_ATTRIBUTES: readonly number[] = [114, 116, 117, 118, ATTR.trackingSpeed, 1272];

/** Every label the rows may use, to ask the words of before the first tooltip opens. */
export const MODULE_TOOLTIP_LABELS: readonly string[] = [
  // the siege countdown's FormatTimeIntervalShort (minute to second: two elements)
  "/Carbon/UI/Common/DateTimeQuantity/DateTimeShort2Elements",
  "UI/Inflight/ModuleRacks/TypeNameWithNumInGroup", "UI/Inflight/ModuleRacks/ModuleDamaged", "UI/Inflight/ModuleRacks/AmmoNameWithQty",
  "UI/Inflight/ModuleRacks/MaxRange", "UI/Inflight/ModuleRacks/OptimalRangeAndFalloff", "UI/Inflight/ModuleRacks/OptimalRange",
  "UI/Inflight/ModuleRacks/AreaOfEffect", "UI/Inflight/ModuleRacks/RangeWithFalloff", "UI/Inflight/ModuleRacks/Range",
  "UI/Inflight/ModuleRacks/Tooltips/MiningAmountPerTime2", "UI/Inflight/ModuleRacks/Tooltips/CompressorModuleInfo", "UI/Inflight/ModuleRacks/Tooltips/TrackingComputerFalloffBonus", "UI/Inflight/ModuleRacks/Tooltips/TrackingComputerRangeBonus", "UI/Inflight/ModuleRacks/Tooltips/TrackingComputerTrackingBonus", "UI/Inflight/ModuleRacks/Tooltips/HullRemoteRepairedPerTime", "UI/Inflight/ModuleRacks/Tooltips/SuperWeaponDamage", "UI/Inflight/ModuleRacks/Tooltips/ScanProbeSensorStrength", "UI/Inflight/ModuleRacks/Tooltips/TractorBeamTractorVelocity", "UI/Inflight/ModuleRacks/Tooltips/ValuePercentageWithAttributeName", "UI/Inflight/ModuleRacks/Tooltips/ECMStrengthBonus", "UI/Inflight/ModuleRacks/Tooltips/ResistanceActiveBonusText", "UI/Inflight/ModuleRacks/Tooltips/ResistanceActiveBonusValues", "UI/Inflight/ModuleRacks/Tooltips/ResistanceActiveBonusesHeader", "UI/Inflight/ModuleRacks/Tooltips/ShieldDamageResistanceHeader", "UI/Inflight/ModuleRacks/Tooltips/ArmorDamageResistanceHeader", "UI/Inflight/ModuleRacks/Tooltips/HullDamageResistanceHeader", "UI/Inflight/ModuleRacks/Tooltips/GangCoordinatorCommandBonus", "UI/Inflight/ModuleRacks/Tooltips/GangCoordinatorMaxCommandRelays", "UI/Inflight/ModuleRacks/Tooltips/ArmorRepairedPerTime",
  "UI/Inflight/ModuleRacks/Tooltips/HullRepairedPerTime", "UI/Inflight/ModuleRacks/Tooltips/ShieldBonusPerTime",
  "UI/Inflight/ModuleRacks/Tooltips/MaxVelocityWithAndWithoutPropulsion", "UI/Inflight/ModuleRacks/Tooltips/CapacitorBoostPerTime",
  "UI/Inflight/ModuleRacks/Tooltips/EnergyVampireAmountPerTime", "UI/Inflight/ModuleRacks/Tooltips/EnergDestabilizedPerTime",
  "UI/Inflight/ModuleRacks/Tooltips/EnergyTransferredPerTime", "UI/Inflight/ModuleRacks/Tooltips/ShieldTransportedPerTime",
  "UI/Inflight/ModuleRacks/Tooltips/ArmorTransferredPerTime", "UI/Inflight/ModuleRacks/Tooltips/ModuleRepairing",
  "UI/Inflight/ModuleRacks/Tooltips/WeaponAccuracyScore", "UI/Inflight/ModuleRacks/Tooltips/VelocityReductionFromWeb",
  "UI/Inflight/ModuleRacks/Tooltips/WarpScramblerStrength", "/Carbon/UI/Common/WrittenDateTimeQuantityShort/Second",
  "UI/Inflight/ModuleRacks/DamagePerSecond", "UI/Inflight/ModuleRacks/Tooltips/OneDamageTypeText",
  "UI/Inflight/ModuleRacks/Tooltips/DotEffectDuration",
  "UI/Inflight/ModuleRacks/Tooltips/MaxDamage", "UI/Inflight/ModuleRacks/Tooltips/TimeUntilMaxDamage", "UI/Common/Percentage",
  "UI/Inflight/ModuleRacks/Tooltips/DamageTypesHeader", "UI/Inflight/ModuleRacks/Tooltips/DamageHitpoints",
];
