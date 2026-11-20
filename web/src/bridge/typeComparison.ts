// The client's compare tool (eve/client/script/ui/comparison): what it compares a type by and how it writes it.
//
// THE TYPES (comparableType.py ComparableType): a type's estimated price first, then the attributes its dogma has
// (godma TypeWrapper.displayAttributes: dogma/data.py get_type_attributes, its typeDogma rows in their order and then
// its mass, capacity, volume and radius), those of a module's "can be fitted to" lists shown as one, each kept where
// it is visible (DogmaComparableAttribute.is_visible). A value is the type's own (dogma_data.get_type_attribute), but
// a base warp speed times the type's warp speed multiplier and an AU (get_attribute_value), and the price the cfg's
// average one (typeHelpers.GetAveragePrice).
//
// THE COMPARISON (typeComparer.py TypeComparer): the attributes any of the types shows, the best and the worst of
// each marked (_update_best_or_worst_flags), grouped as the client's attribute groups for the types' category order
// them (uiAttributeGroupUtil.get_attribute_ids_by_group), and filtered as the window's settings ask
// (comparisonWindow.get_attribute_ids_to_compare: only those that differ, none the pilot has hidden).
//
// THE WORDS (comparableAttribute.py get_value_text_formatted, dogma/attributes/format.py GetFormatAndValue and
// FormatValue): a value written by its unit, in the client's colour for best, worst, nought and the rest.
//
// What is not the page's yet: an alpha pilot's clone-grade row (attributeCloneGradeRestriction, added where
// clone_grade_svc.is_restricted), a dynamic item's own attributes (the menu never offers one), and the order of the
// Miscellaneous group (the remains of a Python set, in its hash order; ships have no such group): here by number.

import {
  ATTRIBUTE_IDS_BY_GROUP,
  CAN_FIT_SHIP_GROUP_ATTRIBUTE_IDS,
  CAN_FIT_SHIP_TYPE_ATTRIBUTE_IDS,
  COMPARE_CATEGORIES,
  GROUPS_BY_KIND,
  NON_LINEAR_UNITS,
  type AttributeGroupID,
} from "./dogmaAttributeGroups.ts";
import { fmtAmt, formatNumeric, pyRound, pyStr, type PyNumber } from "./pyNumbers.ts";

/** dogma_data.get_attribute: an attribute's own record, as the client's dogmaAttributes table has it. */
export interface DogmaAttributeRecord {
  readonly name: string | null;
  readonly displayNameID: number | null;
  readonly tooltipDescriptionID: number | null;
  readonly unitID: number | null;
  readonly iconID: number | null;
  readonly published: boolean;
  readonly displayWhenZero: boolean;
  readonly highIsGood: boolean;
  readonly dataType: number | null;
  readonly defaultValue: number | null;
}

/** A type as the compare tool reads it: get_type_attributes' rows, its group and category, and its flags. */
export interface ComparisonTypeData {
  readonly attributes: ReadonlyArray<readonly [number, number | null]>;
  readonly groupID: number | null;
  readonly categoryID: number | null;
  readonly published: boolean;
  readonly dynamic: boolean;
}

// dogma.const and appConst, as the client has them.
export const ATTRIBUTE_ESTIMATED_PRICE = 5617;
export const ATTRIBUTE_CLONE_GRADE_RESTRICTION = 5618;
export const ATTRIBUTE_REQUIRED_THERMODYNAMICS = 1212;
const ATTRIBUTE_BASE_WARP_SPEED = 1281;
const ATTRIBUTE_WARP_SPEED_MULTIPLIER = 600;
const ATTRIBUTE_VOLUME = 161;
const ATTRIBUTE_MAX_LOCKED_TARGETS = 192;
const ATTRIBUTE_CRYSTAL_VOLATILITY_CHANCE = 783;
export const TYPE_THERMODYNAMICS = 28164;
const AU = 149597870700.0;
const SEC = 10_000_000n;
const CATEGORY = { ship: 6, drone: 18, fighter: 87, module: 7, structureModule: 66, subSystem: 32, charge: 8 } as const;
const UNIT = {
  length: 1, mass: 2, time: 3, volume: 9, maxVelocity: 11, milliseconds: 101, modifierMultiplier: 104, percentage: 105,
  teraflops: 106, megaWatts: 107, inverseAbsolutePercent: 108, modifierPercent: 109, inversedModifierPercent: 111,
  hitpoints: 113, capacitorUnits: 114, groupID: 115, typeID: 116, sizeclass: 117, attributeID: 119, attributePoints: 120,
  modifierRelativePercent: 124, absolutePercent: 127, hour: 129, money: 133, slot: 136, boolean: 137, bonus: 139,
  level: 140, gender: 142, datetime: 143, warpSpeed: 144, modifierRealPercent: 205,
} as const;
const DATA_TYPE_TYPE_LIST_ID = 13;

/** One of a type's compared attributes (DogmaComparableAttribute; CanBeFittedToShipComparableAttribute's unionIDs). */
export interface ComparableAttribute {
  readonly attributeID: number;
  readonly typeID: number;
  readonly record: DogmaAttributeRecord;
  /** get_attribute_value's: the value compared and written; null where there is none (Python's None). */
  readonly value: number | null;
  /** A "can be fitted to" list's attributes this one is shown for (its first), or null. */
  readonly unionIDs: readonly number[] | null;
}

/** One compared type (ComparableType): its attributes by number, in the order they were added. */
export interface ComparableType {
  readonly typeID: number;
  readonly categoryID: number | null;
  readonly groupID: number | null;
  readonly attributes: ReadonlyMap<number, ComparableAttribute>;
}

/** comparisonUtil.is_comparable accepts a static type with attributes in a supported category. */
export function isComparable(type: ComparisonTypeData | null): boolean {
  return type !== null && !type.dynamic && type.attributes.length > 0 && type.categoryID !== null && COMPARE_CATEGORIES.includes(type.categoryID);
}

/** get_type_attributes_by_id: the type's value of an attribute (the last row for it), undefined where it has none. */
function typeAttribute(type: ComparisonTypeData, attributeID: number): number | null | undefined {
  let found: number | null | undefined;
  for (const [id, value] of type.attributes) if (id === attributeID) found = value;
  return found;
}

/**
 * typeHelpers.GetAveragePrice: the cfg's average price of the type (79785 is 1000), null where the table has none.
 */
export function averagePriceOf(typeID: number, prices: ReadonlyMap<number, number | null> | null): number | null {
  if (typeID === 79785) return 1000;
  return prices?.get(typeID) ?? null;
}

/** DogmaComparableAttribute.is_visible. */
function isVisible(record: DogmaAttributeRecord, value: number | null): boolean {
  if (!value && !record.displayWhenZero) return false;
  if (record.unitID === UNIT.inverseAbsolutePercent && value === 1.0) return false;
  return record.published;
}

/**
 * ComparableType(type_id): the estimated price, then each of the type's dogma attributes (a "can be fitted to" list
 * once, check_union_attribute_ids), each kept where it is visible.
 */
export function comparableType(
  typeID: number,
  type: ComparisonTypeData,
  records: ReadonlyMap<number, DogmaAttributeRecord | null>,
  prices: ReadonlyMap<number, number | null> | null,
): ComparableType {
  const attributes = new Map<number, ComparableAttribute>();
  const unions = new Map<number, readonly number[]>();
  const valueOf = (attributeID: number): number | null => {
    const own = typeAttribute(type, attributeID) ?? null;
    if (attributeID === ATTRIBUTE_BASE_WARP_SPEED && own !== null) {
      const multiplier = typeAttribute(type, ATTRIBUTE_WARP_SPEED_MULTIPLIER) ?? 1;
      return own * multiplier * AU;
    }
    if (attributeID === ATTRIBUTE_ESTIMATED_PRICE) return averagePriceOf(typeID, prices);
    return own;
  };
  const add = (attributeID: number): void => {
    const record = records.get(attributeID);
    if (!record) return;
    // _construct_attribute asks of the "can be fitted to" hull list twice, and never of the group list: a group list's
    // attribute is an ordinary one (its others were taken out by check_union_attribute_ids all the same).
    const unionIDs = CAN_FIT_SHIP_TYPE_ATTRIBUTE_IDS.includes(attributeID) ? unions.get(attributeID) ?? null : null;
    const value = valueOf(attributeID);
    if (isVisible(record, value)) attributes.set(attributeID, { attributeID, typeID, record, value, unionIDs });
  };
  add(ATTRIBUTE_ESTIMATED_PRICE);
  const ids = type.attributes.map(([attributeID]) => attributeID);
  for (const filter of [CAN_FIT_SHIP_TYPE_ATTRIBUTE_IDS, CAN_FIT_SHIP_GROUP_ATTRIBUTE_IDS]) {
    const present = filter.filter((attributeID) => ids.includes(attributeID));
    if (present.length === 0) continue;
    unions.set(present[0]!, present);
    for (const attributeID of present.slice(1)) {
      const at = ids.indexOf(attributeID);
      if (at >= 0) ids.splice(at, 1);
    }
  }
  for (const attributeID of ids) add(attributeID);
  return { typeID, categoryID: type.categoryID, groupID: type.groupID, attributes };
}

/** get_common_attributes_by_id: every attribute any of the types shows (the last type's where several do). */
export function commonAttributes(types: readonly ComparableType[]): Map<number, ComparableAttribute> {
  const out = new Map<number, ComparableAttribute>();
  for (const type of types) for (const [attributeID, attribute] of type.attributes) out.set(attributeID, attribute);
  return out;
}

/** get_common_attribute_that_diffrentiate_by_id: of those, the ones whose values are not all the same. */
export function differingAttributes(types: readonly ComparableType[]): Map<number, ComparableAttribute> {
  const out = new Map<number, ComparableAttribute>();
  for (const [attributeID, attribute] of commonAttributes(types)) {
    const values: Array<number | null> = [];
    for (const type of types) {
      const value = type.attributes.get(attributeID)?.value ?? null;
      if (values.length > 0 && !values.includes(value)) {
        out.set(attributeID, attribute);
        break;
      }
      values.push(value);
    }
  }
  return out;
}

/** Python 2's order of a value and None: None before any number. */
function pyCompare(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export type Standing = "best" | "worst";

/**
 * _update_best_or_worst_flags: for each attribute, the types' values sorted (the highest first where high is not
 * good); where they are not all one, those at the sorted first are the worst (only where there are more than two
 * values) and those at the last the best.
 */
export function standings(types: readonly ComparableType[]): Map<ComparableAttribute, Standing> {
  const out = new Map<ComparableAttribute, Standing>();
  for (const [attributeID, common] of commonAttributes(types)) {
    const reverse = !common.record.highIsGood;
    const held = types.flatMap((type) => {
      const attribute = type.attributes.get(attributeID);
      return attribute ? [attribute] : [];
    });
    const sorted = [...held].sort((a, b) => (reverse ? pyCompare(b.value, a.value) : pyCompare(a.value, b.value)));
    const values = sorted.map((attribute) => attribute.value);
    const different = new Set(values).size;
    if (different <= 1) continue;
    for (const attribute of sorted) {
      if (attribute.value === values[0] && different > 2) out.set(attribute, "worst");
      else if (attribute.value === values[values.length - 1]) out.set(attribute, "best");
    }
  }
  return out;
}

/** get_attribute_group_ids: the groups a category's types are shown in. */
function groupsFor(categoryID: number | null, attributeIDs: ReadonlySet<number>): readonly AttributeGroupID[] {
  switch (categoryID) {
    case CATEGORY.ship: return GROUPS_BY_KIND.ship;
    case CATEGORY.drone: return GROUPS_BY_KIND.drone;
    case CATEGORY.fighter: return GROUPS_BY_KIND.fighter;
    case CATEGORY.module:
    case CATEGORY.structureModule:
    case CATEGORY.subSystem: return GROUPS_BY_KIND.module;
    case CATEGORY.charge: return attributeIDs.has(ATTRIBUTE_CRYSTAL_VOLATILITY_CHANCE) ? GROUPS_BY_KIND.ammoCrystal : GROUPS_BY_KIND.charge;
    default: return ["misc"];
  }
}

/** get_common_category_id: the types' one category, or null where they have none or several. */
export function commonCategory(types: readonly ComparableType[]): number | null {
  const categories = new Set(types.map((type) => type.categoryID));
  return categories.size === 1 ? [...categories][0]! : null;
}

/**
 * get_attribute_ids_by_group: the attributes, each in the first of the category's groups that lists it, in that
 * group's order (its repeats too); the Miscellaneous group, where the category has one, gets those left.
 */
export function attributesByGroup(attributeIDs: Iterable<number>, categoryID: number | null): Array<readonly [AttributeGroupID, readonly number[]]> {
  const left = new Set(attributeIDs);
  const groups = groupsFor(categoryID, left);
  const out: Array<readonly [AttributeGroupID, readonly number[]]> = [];
  for (const group of groups) {
    const present = ATTRIBUTE_IDS_BY_GROUP[group].filter((attributeID) => left.has(attributeID));
    if (present.length === 0) continue;
    for (const attributeID of present) left.delete(attributeID);
    out.push([group, present]);
  }
  if (left.size > 0 && groups.includes("misc")) out.push(["misc", [...left].sort((a, b) => a - b)]);
  return out;
}

/**
 * get_attribute_ids_to_compare: the attributes shown, all the types show or (where only those that differ are
 * asked for, and there is more than one type) those that differ, less the ones hidden.
 */
export function attributesToCompare(types: readonly ComparableType[], onlyDifferent: boolean, hidden: ReadonlySet<number>): number[] {
  const shown = !onlyDifferent || types.length <= 1 ? commonAttributes(types) : differingAttributes(types);
  return [...shown.keys()].filter((attributeID) => !hidden.has(attributeID));
}

/** What the attribute writer needs of the client's words and names. */
export interface AttributeWords {
  /** GetByLabel, filled; "" where the words are not to hand. */
  label(path: string, args?: Readonly<Record<string, string>>): string;
  /** A message's text by its number; "" where it is not to hand. */
  message(messageID: number | null): string;
  /** units.get_display_name: a unit's name, "" where it has none. */
  unitName(unitID: number): string;
  typeName(typeID: number): string;
  groupName(groupID: number): string;
  /** The record of an attribute a value names (unitAttributeID). */
  attribute(attributeID: number): DogmaAttributeRecord | null;
  /** FormatTimeIntervalShortWritten(ticks, showTo='millisecond'), or null. */
  shortInterval(ticks: bigint): string | null;
}

/** What GetFormatAndValue answers: words, or a number Python writes as it is. */
type Written = string | PyNumber | null;

const writtenText = (value: Written): string => (typeof value === "string" ? value : pyStr(value));

/** FormatUnit: the unit's name, but none for time, length and an attribute. */
function formatUnit(unitID: number | null, words: AttributeWords): string {
  if (unitID === null || unitID === UNIT.time || unitID === UNIT.length || unitID === UNIT.attributeID) return "";
  return words.unitName(unitID);
}

/** eveFormat.FmtDist2(dist, maxDecimals=2). */
function fmtDist2(distance: number, words: AttributeWords): string {
  let dist = distance;
  let places: number | null = 2;
  if (dist < 0) {
    dist = Math.abs(dist);
    places = null;
  }
  let label: string;
  let value: PyNumber;
  if (dist < 10000) {
    value = { int: Math.trunc(dist) };
    places = null;
    label = "/Carbon/UI/Common/FormatDistance/fmtDistInMeters";
  } else if (dist < 10000000000) {
    value = dist / 1000;
    label = "/Carbon/UI/Common/FormatDistance/fmtDistInKiloMeters";
  } else {
    value = places === null ? dist / AU : pyRound(dist / AU, places);
    label = "/Carbon/UI/Common/FormatDistance/fmtDistInAU";
  }
  const text = formatNumeric(value, { useGrouping: false, decimalPlaces: places });
  return words.label(label, { distance: text });
}

/** format.RoundDistance(dist): whole metres, whole kilometres, or AU to two places; None under a metre. */
function roundDistance(distance: number): PyNumber | null {
  const dist = Math.abs(distance);
  if (dist < 10000) return dist === 0 || dist >= 1 ? { int: Math.trunc(pyRound(dist)) } : null;
  if (dist < 10000000000) return { int: Math.trunc(pyRound(dist / 1000)) };
  return pyRound(dist / AU, 2);
}

/** FormatSeconds(value): to a place where there is a fraction, as the client's "s" quantity. */
function formatSeconds(seconds: number, words: AttributeWords): string {
  const text = formatNumeric(seconds, { decimalPlaces: seconds % 1 ? 1 : 0 });
  return words.label("/Carbon/UI/Common/WrittenDateTimeQuantityShort/Second", { value: text });
}

/** FormatValue(value, unitID). */
function formatValue(given: number, unitID: number | null, words: AttributeWords): Written {
  let value = given;
  switch (unitID) {
    case UNIT.milliseconds: {
      const seconds = Math.abs(value) / 1000;
      const text = seconds > 60
        ? words.shortInterval(BigInt(Math.trunc(seconds)) * SEC) ?? ""
        : formatSeconds(seconds, words);
      return `${value < 0 ? "-" : ""}${text}`;
    }
    case UNIT.length: return fmtDist2(value, words);
    case UNIT.money: return fmtAmt(value);
    case UNIT.teraflops:
    case UNIT.capacitorUnits:
    case UNIT.megaWatts: return pyRound(value, 2);
    case UNIT.warpSpeed: return roundDistance(value);
    case UNIT.inverseAbsolutePercent:
    case UNIT.inversedModifierPercent:
      value = pyRound(1.0 - value, 6) * 100;
      break;
    case UNIT.modifierPercent:
      value = pyRound(Math.abs(value * 100 - 100) * (value < 1.0 ? -1 : 1), 3);
      break;
    case UNIT.absolutePercent:
      value *= 100;
      break;
    case UNIT.modifierRealPercent:
      return formatNumeric(value, { decimalPlaces: 1, useGrouping: true });
    default:
      break;
  }
  if (unitID === UNIT.mass) return formatNumeric(value, { decimalPlaces: 0, useGrouping: true });
  if (unitID === UNIT.modifierRelativePercent || unitID === UNIT.percentage || unitID === UNIT.absolutePercent) {
    let places = Math.abs(value) < 10 ? 2 : 1;
    value = pyRound(value, places);
    if (Math.abs(value - Math.trunc(value)) < 1e-10) places = 0;
    return formatNumeric(value, { decimalPlaces: places, useGrouping: true });
  }
  if (Math.abs(pyRound(value) - value) < 1e-10) return fmtAmt(pyRound(value));
  if (unitID === UNIT.attributePoints) return pyRound(value, 1);
  if (unitID === UNIT.maxVelocity) return formatNumeric(value, { decimalPlaces: 2, useGrouping: true });
  if (unitID === UNIT.hitpoints || unitID === UNIT.volume || unitID === UNIT.inverseAbsolutePercent || unitID === UNIT.inversedModifierPercent) {
    const places = value < 1 ? Math.trunc(-Math.ceil(Math.log10(Math.abs(value))) + (unitID === UNIT.hitpoints ? 2 : 3)) : 2;
    return formatNumeric(value, { decimalPlaces: places, useGrouping: true });
  }
  if (unitID === UNIT.modifierMultiplier) return pyRound(value, 3);
  // Time (FmtDate), hours and dates are not the page's yet: written as Python writes the number.
  return value;
}

/**
 * A value and its unit as dogma's FormatValue and FormatUnit write them into UI/InfoWindow/ValueAndUnit (the dbuff
 * hint's, dbuff/client/uiFormatters.py GetDisplayNameAndValue).
 */
export function valueAndUnitText(value: number, unitID: number | null, words: AttributeWords): string {
  return words.label("UI/InfoWindow/ValueAndUnit", { value: writtenText(formatValue(value, unitID, words)), unit: formatUnit(unitID, words) });
}

/** eveformat.volume(amount): to two places, one or none as its fraction asks, as the client's m3 quantity. */
function volumeText(amount: number, words: AttributeWords): string {
  const places = (10 * amount) % 1 ? 2 : amount % 1 ? 1 : 0;
  return words.label("UI/Util/VolumeWithUnit", { volume: formatNumeric(amount, { useGrouping: false, decimalPlaces: places }) });
}

const SIZE_LABELS: Readonly<Record<number, string>> = {
  1: "UI/InfoWindow/SmallSize",
  2: "UI/InfoWindow/MediumSize",
  3: "UI/InfoWindow/LargeSize",
  4: "UI/InfoWindow/XLargeSize",
};
const GENDER_LABELS: Readonly<Record<number, string>> = {
  1: "UI/Common/Gender/Male",
  2: "UI/Common/Gender/Unisex",
  3: "UI/Common/Gender/Female",
};

/** GetFormatAndValue(attributeType, value): a value written as its unit asks. */
export function formatAttributeValue(attributeID: number, record: DogmaAttributeRecord, value: number, words: AttributeWords): string {
  const unitID = record.unitID;
  const unitText = formatUnit(unitID, words);
  let written: Written;
  if (unitID === UNIT.groupID) written = words.groupName(Math.trunc(value));
  else if (unitID === UNIT.typeID) written = words.typeName(Math.trunc(value));
  else if (unitID === UNIT.sizeclass) written = words.label(SIZE_LABELS[Math.trunc(value)] ?? "");
  else if (unitID === UNIT.attributeID) {
    const named = words.attribute(Math.trunc(value));
    written = named === null ? "" : words.message(named.displayNameID) || named.name || "";
  } else if (attributeID === ATTRIBUTE_VOLUME) written = volumeText(value, words);
  else if (unitID === UNIT.modifierRealPercent) {
    const formatted = formatValue(value, null, words);
    written = `${value < 0 ? "-" : "+"}${writtenText(formatted)}${unitText}`;
  } else if (unitID === UNIT.level) written = words.label("UI/InfoWindow/TechLevelX", { numLevel: fmtAmt(value) });
  else if (unitID === UNIT.boolean) written = words.label(Math.trunc(value) === 1 ? "UI/Common/True" : "UI/Common/False");
  else if (unitID === UNIT.slot) written = words.label("UI/InfoWindow/SlotX", { slotNum: fmtAmt(value) });
  else if (unitID === UNIT.bonus) written = value >= 0 ? `${unitText}${pyStr(value)}` : value;
  else if (unitID === UNIT.gender) written = words.label(GENDER_LABELS[Math.trunc(value)] ?? "");
  else if (unitID === UNIT.datetime || unitID === UNIT.milliseconds) written = formatValue(value, unitID, words);
  else if (attributeID === ATTRIBUTE_MAX_LOCKED_TARGETS) written = { int: Math.ceil(value) };
  else if (record.dataType === DATA_TYPE_TYPE_LIST_ID) written = value;
  else if (!unitText) written = formatValue(value, unitID, words);
  else written = words.label("UI/InfoWindow/ValueAndUnit", { value: writtenText(formatValue(value, unitID, words)), unit: unitText });
  return writtenText(written);
}

/** The labels the writer may need, to ask for. */
export const ATTRIBUTE_VALUE_LABELS: readonly string[] = [
  "/Carbon/UI/Common/FormatDistance/fmtDistInMeters",
  "/Carbon/UI/Common/FormatDistance/fmtDistInKiloMeters",
  "/Carbon/UI/Common/FormatDistance/fmtDistInAU",
  "/Carbon/UI/Common/WrittenDateTimeQuantityShort/Second",
  "UI/Util/VolumeWithUnit",
  "UI/InfoWindow/ValueAndUnit",
  "UI/InfoWindow/TechLevelX",
  "UI/InfoWindow/SlotX",
  "UI/Common/True",
  "UI/Common/False",
  "UI/Generic/NotAvailableShort",
  ...Object.values(SIZE_LABELS),
  ...Object.values(GENDER_LABELS),
];

// get_color: eveColor.LIME_GREEN_HEX, WARNING_ORANGE_HEX, and TextColor.DISABLED and HIGHLIGHT as str() of a chroma
// Color writes them (hex_argb, its alpha a byte rounded a half away from nought).
const LIME_GREEN = "#FFB2F84D";
const WARNING_ORANGE = "#FFF39058";
const DISABLED = "#4dffffff";
const HIGHLIGHT = "#e6ffffff";

/** is_linear: a unit a best and a worst are shown for. */
export const isLinear = (attribute: ComparableAttribute): boolean => !NON_LINEAR_UNITS.includes(attribute.record.unitID ?? -1);

/** get_color. */
export function attributeColor(attribute: ComparableAttribute, standing: Standing | undefined): string {
  if (isLinear(attribute) && standing === "best") return LIME_GREEN;
  if (isLinear(attribute) && standing === "worst" && attribute.value) return WARNING_ORANGE;
  if (!attribute.value) return DISABLED;
  return HIGHLIGHT;
}

/**
 * get_value_text: N/A where there is no value; a "can be fitted to" list's values one to a line
 * (CanBeFittedToShipComparableAttribute); else GetFormatAndValue's.
 */
export function attributeValueText(
  attribute: ComparableAttribute,
  type: ComparisonTypeData,
  records: ReadonlyMap<number, DogmaAttributeRecord | null>,
  words: AttributeWords,
): string {
  if (attribute.unionIDs !== null) {
    return attribute.unionIDs.map((attributeID) => {
      const record = records.get(attributeID);
      const value = typeAttribute(type, attributeID) ?? null;
      return !record || value === null ? words.label("UI/Generic/NotAvailableShort") : formatAttributeValue(attributeID, record, value, words);
    }).join("\n");
  }
  if (attribute.value === null) return words.label("UI/Generic/NotAvailableShort");
  return formatAttributeValue(attribute.attributeID, attribute.record, attribute.value, words);
}

/** get_value_text_formatted: the text in its colour, as the client's label markup. */
export function attributeValueMarkup(text: string, color: string): string {
  return `<color=${color}>${text}</color>`;
}

/** The required level of a required skill's row (skill_level_by_required_skill), from the type's own attribute. */
export function requiredLevel(type: ComparisonTypeData, levelAttributeID: number): number | null {
  const value = typeAttribute(type, levelAttributeID);
  return value === undefined || value === null ? null : Math.trunc(value);
}
