import { FILTER_FIELD as F, type InventoryFilterFacts } from "../bridge/inventoryFilters.ts";
import { requiredSkillsRecursiveAsDict } from "../bridge/skillPlanMilestones.ts";
import { readDictPairs, readKeyVal, unwrapLong, type JsonValue } from "../bridge/wire.ts";
import { bridgeAsk, fetchTypeDogma, getCloneGrade, getRequiredSkills, getTypeMeta, getTypePrices, loadIndustryDefinitions, loadTypeEffects, type ApiOptions } from "./api.ts";

const POWER_ATTRIBUTE = 30;
const CPU_ATTRIBUTE = 50;
export const ITEM_FITTING_FILTER_FIELDS: ReadonlySet<number> = new Set([F.power, F.cpu]);
const CATEGORY_SKILL = 16;
const blueprintCategory = (categoryID: number | null) => categoryID === 9 || categoryID === 34;
export const TYPE_FILTER_FIELDS: ReadonlySet<number> = new Set([F.slot, F.metaGroup, F.metaLevel, F.power, F.cpu, F.clone]);

const record = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : null;

/** A blueprint is Omega-only if every activity needs a skill past the Alpha ceiling. */
function blueprintNeedsOmega(definition: JsonValue | undefined, levels: ReadonlyMap<number, number>): boolean | undefined {
  const activities = record(record(definition)?.activities);
  if (activities === null) return undefined;
  return Object.values(activities).every(activity => {
    const skills = record(activity)?.skills;
    return Array.isArray(skills) && skills.some(requirement => {
      const skill = record(requirement);
      return typeof skill?.level === "number" && typeof skill.typeID === "number" && (levels.get(skill.typeID) ?? 0) < skill.level;
    });
  });
}

/** Inventory FilterSvc.GetValue reads static dogma and the type's meta records for ordinary items. */
export async function loadInventoryFilterFacts(
  typeIDs: readonly number[], fields: ReadonlySet<number>, options: ApiOptions, raceID: number | null = null,
): Promise<ReadonlyMap<number, InventoryFilterFacts>> {
  const result = new Map<number, InventoryFilterFacts>();
  const attributes = [...(fields.has(F.power) ? [POWER_ATTRIBUTE] : []), ...(fields.has(F.cpu) ? [CPU_ATTRIBUTE] : [])];
  const grade = fields.has(F.clone) && raceID !== null ? await getCloneGrade(raceID, options) : null;
  const levels = grade?.available ? grade.levels : null;
  const pageSize = levels === null ? 100 : 50;
  for (let start = 0; start < typeIDs.length; start += pageSize) {
    const ids = typeIDs.slice(start, start + pageSize);
    const [effects, meta, dogma, skillReads] = await Promise.all([
      fields.has(F.slot) ? loadTypeEffects(ids, options) : null,
      fields.has(F.metaGroup) || fields.has(F.metaLevel) || levels !== null ? getTypeMeta(ids, options) : null,
      attributes.length ? fetchTypeDogma(ids, attributes, options) : null,
      levels === null ? null : getRequiredSkills(ids, options),
    ]);
    const blueprints = skillReads?.available ? await loadIndustryDefinitions(ids.filter(id =>
      blueprintCategory(meta?.types.get(id)?.categoryID ?? null)), options) : {};
    for (const typeID of ids) {
      const type = meta?.types.get(typeID);
      const values = dogma?.[typeID];
      const typeEffects = effects?.[typeID];
      const facts: Record<number, InventoryFilterFacts[number]> = {};
      if (typeEffects) facts[F.slot] = typeEffects;
      if (type) {
        const tech = Math.trunc(type.techLevel || 1);
        facts[F.metaGroup] = Math.trunc(type.metaGroupID || (tech === 3 ? 14 : tech));
        facts[F.metaLevel] = Math.trunc(type.metaLevel || 0);
      }
      if (values) {
        if (fields.has(F.power)) facts[F.power] = Math.trunc(values[POWER_ATTRIBUTE] ?? 0);
        if (fields.has(F.cpu)) facts[F.cpu] = Math.trunc(values[CPU_ATTRIBUTE] ?? 0);
      }
      const categoryID = type?.categoryID ?? null;
      if (levels !== null && skillReads?.available && categoryID !== null) {
        const restrictedBySkill = requiredSkillsRecursiveAsDict(typeID, skillReads.order)
          .some(([skill, needed]) => (levels.get(skill) ?? 0) < needed);
        const omega = restrictedBySkill || (categoryID === CATEGORY_SKILL
          ? (levels.get(typeID) ?? 0) < 1
          : blueprintCategory(categoryID) ? blueprintNeedsOmega(blueprints[typeID], levels) : false);
        if (omega !== undefined) facts[F.clone] = omega ? 1 : 0;
      }
      result.set(typeID, facts);
    }
  }
  return result;
}

/** GetDynamicItemAttributes reads the attributes of the visible item instance, as the retail filter does. */
export async function loadInventoryItemFittingFacts(
  rows: readonly { itemID: number; typeID: number }[], fields: ReadonlySet<number>, options: ApiOptions,
): Promise<ReadonlyMap<number, InventoryFilterFacts>> {
  const readPower = fields.has(F.power);
  const readCpu = fields.has(F.cpu);
  const result = new Map<number, InventoryFilterFacts>();
  if (!readPower && !readCpu) return result;
  const ask = bridgeAsk(options);
  const typeIDs = [...new Set(rows.map(row => row.typeID))];
  const dynamic = new Set<number>();
  const unknown = new Set<number>();
  for (let start = 0; start < typeIDs.length; start += 50) {
    const ids = typeIDs.slice(start, start + 50);
    const types = await getTypePrices(ids, options).then(answer => answer.dynamic).catch(() => ({} as Readonly<Record<number, boolean | null>>));
    for (const id of ids) {
      if (types[id] === true) dynamic.add(id);
      else if (types[id] == null) unknown.add(id);
    }
  }
  for (const row of rows) if (unknown.has(row.typeID)) result.set(row.itemID, {});
  const candidates = rows.filter(row => dynamic.has(row.typeID));
  for (let start = 0; start < candidates.length; start += 4) {
    await Promise.all(candidates.slice(start, start + 4).map(async ({ itemID, typeID }) => {
      const item = await ask("dynamicItemService", "GetDynamicItemInfo", [itemID]).catch(() => null);
      const facts: Record<number, number> = {};
      const attributes = readKeyVal(item, "attributes");
      const dict = record(attributes);
      if (dict?.type === "dict" && Array.isArray(dict.entries) &&
          unwrapLong(readKeyVal(item, "itemID")) === BigInt(itemID) && unwrapLong(readKeyVal(item, "typeID")) === BigInt(typeID)) {
        const values = new Map(readDictPairs(attributes).map(([attribute, value]) => [Number(attribute), value] as const));
        const integer = (attribute: number) => {
          const value = values.get(attribute);
          return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
        };
        if (readPower) facts[F.power] = integer(POWER_ATTRIBUTE);
        if (readCpu) facts[F.cpu] = integer(CPU_ATTRIBUTE);
      }
      result.set(itemID, facts);
    }));
  }
  return result;
}
